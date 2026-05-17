import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { get, set, del } from 'idb-keyval';
import type { Repo } from './github';
import type { StarPoint } from './umap.worker';

// ── PGlite in-memory (fast queries, no OPFS headaches) ──────────────────────
let db: PGlite | null = null;

export async function getDb(): Promise<PGlite> {
	if (db) return db;
	db = new PGlite({ extensions: { vector } });
	await db.exec(`
		CREATE EXTENSION IF NOT EXISTS vector;

		CREATE TABLE IF NOT EXISTS repos (
			id           BIGINT PRIMARY KEY,
			full_name    TEXT NOT NULL,
			name         TEXT NOT NULL,
			owner_login  TEXT NOT NULL,
			owner_avatar TEXT NOT NULL,
			description  TEXT,
			html_url     TEXT NOT NULL,
			language     TEXT,
			topics       TEXT,
			stars_count  INTEGER DEFAULT 0,
			forks_count  INTEGER DEFAULT 0,
			starred_at   TEXT,
			embedding    vector(384),
			umap_x       REAL,
			umap_y       REAL,
			cluster_id   INTEGER,
			cluster_label TEXT
		);
	`);
	return db;
}

// ── IDB persistence keys ─────────────────────────────────────────────────────
const IDB_REPOS = 'sg-repos';
const IDB_EMBEDDINGS = 'sg-embeddings'; // Map<id, number[]>
const IDB_UMAP = 'sg-umap';             // StarPoint[]
const IDB_META = 'sg-meta';             // Record<string, string>

// ── Repo CRUD ────────────────────────────────────────────────────────────────
export async function upsertRepos(repos: Repo[]): Promise<void> {
	const d = await getDb();
	for (const r of repos) {
		await d.query(
			`INSERT INTO repos
				(id, full_name, name, owner_login, owner_avatar, description,
				 html_url, language, topics, stars_count, forks_count, starred_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			 ON CONFLICT (id) DO UPDATE SET
				description  = EXCLUDED.description,
				stars_count  = EXCLUDED.stars_count,
				topics       = EXCLUDED.topics,
				starred_at   = EXCLUDED.starred_at`,
			[
				r.id, r.full_name, r.name, r.owner.login, r.owner.avatar_url,
				r.description, r.html_url, r.language,
				JSON.stringify(r.topics), r.stargazers_count, r.forks_count, r.starred_at
			]
		);
	}
	// Persist raw repos to IDB
	await set(IDB_REPOS, repos);
}

export async function loadReposFromIdb(): Promise<Repo[] | undefined> {
	return get<Repo[]>(IDB_REPOS);
}

// ── Embeddings ───────────────────────────────────────────────────────────────
export async function saveEmbedding(id: number, embedding: number[]): Promise<void> {
	const d = await getDb();
	await d.query(`UPDATE repos SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
}

export async function persistEmbeddings(): Promise<void> {
	const d = await getDb();
	const rows = await d.query<{ id: number; embedding: string }>(
		`SELECT id, embedding::text FROM repos WHERE embedding IS NOT NULL`
	);
	const map: Record<number, number[]> = {};
	for (const r of rows.rows) {
		map[r.id] = parseVector(r.embedding);
	}
	await set(IDB_EMBEDDINGS, map);
}

export async function loadEmbeddingsIntoDb(): Promise<boolean> {
	const map = await get<Record<number, number[]>>(IDB_EMBEDDINGS);
	if (!map) return false;
	const d = await getDb();
	for (const [id, emb] of Object.entries(map)) {
		await d.query(`UPDATE repos SET embedding = $1 WHERE id = $2`, [JSON.stringify(emb), Number(id)]);
	}
	return true;
}

// ── UMAP / Galaxy ────────────────────────────────────────────────────────────
export async function saveGalaxy(points: StarPoint[]): Promise<void> {
	const d = await getDb();
	for (const p of points) {
		await d.query(
			`UPDATE repos SET umap_x=$1, umap_y=$2, cluster_id=$3, cluster_label=$4 WHERE id=$5`,
			[p.x, p.y, p.cluster, p.clusterLabel, p.id]
		);
	}
	await set(IDB_UMAP, points);
}

export async function loadGalaxyFromIdb(): Promise<StarPoint[] | undefined> {
	return get<StarPoint[]>(IDB_UMAP);
}

// ── Search ───────────────────────────────────────────────────────────────────
export async function semanticSearch(queryEmbedding: number[], limit = 60): Promise<RepoRow[]> {
	const d = await getDb();
	const result = await d.query<RepoRow>(
		`SELECT *, 1 - (embedding <=> $1::vector) AS similarity
		 FROM repos WHERE embedding IS NOT NULL
		 ORDER BY embedding <=> $1::vector
		 LIMIT $2`,
		[JSON.stringify(queryEmbedding), limit]
	);
	return result.rows;
}

// ── Counts ───────────────────────────────────────────────────────────────────
export async function getRepoCount(): Promise<number> {
	const d = await getDb();
	const r = await d.query<{ count: string }>(`SELECT COUNT(*) as count FROM repos`);
	return parseInt(r.rows[0]?.count ?? '0');
}

export async function getEmbeddedCount(): Promise<number> {
	const d = await getDb();
	const r = await d.query<{ count: string }>(
		`SELECT COUNT(*) as count FROM repos WHERE embedding IS NOT NULL`
	);
	return parseInt(r.rows[0]?.count ?? '0');
}

// ── Meta ─────────────────────────────────────────────────────────────────────
export async function getMeta(key: string): Promise<string | null> {
	const map = await get<Record<string, string>>(IDB_META) ?? {};
	return map[key] ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
	const map = await get<Record<string, string>>(IDB_META) ?? {};
	map[key] = value;
	await set(IDB_META, map);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function parseVector(raw: string): number[] {
	return JSON.parse(raw.replace('[', '[').replace(']', ']'));
}

export async function clearAll(): Promise<void> {
	await Promise.all([del(IDB_REPOS), del(IDB_EMBEDDINGS), del(IDB_UMAP), del(IDB_META)]);
	db = null;
}

export async function getReposForUmap(): Promise<Array<{
	id: number; full_name: string; name: string;
	owner_login: string; owner_avatar: string;
	description: string | null; html_url: string;
	language: string | null; topics: string;
	stars_count: number; forks_count: number; starred_at: string;
}>> {
	const d = await getDb();
	const r = await d.query<{
		id: number; full_name: string; name: string;
		owner_login: string; owner_avatar: string;
		description: string | null; html_url: string;
		language: string | null; topics: string;
		stars_count: number; forks_count: number; starred_at: string;
	}>(`SELECT id, full_name, name, owner_login, owner_avatar, description, html_url,
		language, topics, stars_count, forks_count, starred_at
		FROM repos WHERE embedding IS NOT NULL ORDER BY id`);
	return r.rows;
}

export interface RepoRow {
	id: number;
	full_name: string;
	name: string;
	owner_login: string;
	owner_avatar: string;
	description: string | null;
	html_url: string;
	language: string | null;
	topics: string;
	stars_count: number;
	forks_count: number;
	starred_at: string;
	umap_x: number | null;
	umap_y: number | null;
	cluster_id: number | null;
	cluster_label: string | null;
	similarity?: number;
}
