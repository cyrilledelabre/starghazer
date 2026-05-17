import { UMAP } from 'umap-js';
import { kmeans } from 'ml-kmeans';

export interface StarPoint {
	id: number;
	full_name: string;
	name: string;
	owner_login: string;
	owner_avatar: string;
	description: string | null;
	html_url: string;
	language: string | null;
	topics: string[];
	stars_count: number;
	forks_count: number;
	starred_at: string;
	x: number;
	y: number;
	cluster: number;
	clusterLabel: string;
}

function labelCluster(points: Array<{ language: string | null; topics: string[] }>): string {
	const topicCounts = new Map<string, number>();
	const langCounts = new Map<string, number>();

	for (const p of points) {
		if (p.language) langCounts.set(p.language, (langCounts.get(p.language) ?? 0) + 1);
		for (const t of p.topics) {
			topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
		}
	}

	const topTopics = [...topicCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2)
		.map(([t]) => t.replace(/-/g, ' '));

	const topLang = [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

	if (topTopics.length >= 2) return topTopics.join(' · ');
	if (topTopics.length === 1 && topLang) return `${topTopics[0]} · ${topLang}`;
	if (topTopics.length === 1) return topTopics[0];
	if (topLang) return topLang;
	return 'misc';
}

self.onmessage = async (e: MessageEvent) => {
	const { embeddings, meta } = e.data as {
		embeddings: number[][];
		meta: Array<{
			id: number;
			full_name: string;
			name: string;
			owner_login: string;
			owner_avatar: string;
			description: string | null;
			html_url: string;
			language: string | null;
			topics: string[];
			stars_count: number;
			forks_count: number;
			starred_at: string;
		}>;
	};

	const n = embeddings.length;

	// ── UMAP ────────────────────────────────────────────────────────────────
	self.postMessage({ type: 'status', message: 'Computing UMAP layout…', progress: 0 });

	const umap = new UMAP({
		nComponents: 2,
		nNeighbors: Math.min(15, Math.floor(n / 3)),
		minDist: 0.08,
		spread: 1.2,
	});

	umap.initializeFit(embeddings);
	const epochs = (umap as unknown as { getNEpochs(): number }).getNEpochs();

	for (let i = 0; i < epochs; i++) {
		umap.step();
		if (i % 10 === 0) {
			self.postMessage({
				type: 'status',
				message: `UMAP: epoch ${i}/${epochs}`,
				progress: (i / epochs) * 0.8,
			});
		}
	}

	const raw2d = umap.getEmbedding();

	// ── Normalize to [0, 1] ─────────────────────────────────────────────────
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const [x, y] of raw2d) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	const rangeX = maxX - minX || 1;
	const rangeY = maxY - minY || 1;
	const normalized = raw2d.map(([x, y]) => [(x - minX) / rangeX, (y - minY) / rangeY]);

	// ── K-means clustering ──────────────────────────────────────────────────
	self.postMessage({ type: 'status', message: 'Clustering…', progress: 0.85 });

	const k = Math.max(6, Math.min(14, Math.round(Math.sqrt(n / 4))));
	const kResult = kmeans(embeddings, k, { initialization: 'kmeans++', seed: 42 });

	// ── Auto-label clusters ─────────────────────────────────────────────────
	const clusterGroups = new Map<number, typeof meta>();
	for (let i = 0; i < n; i++) {
		const c = kResult.clusters[i];
		if (!clusterGroups.has(c)) clusterGroups.set(c, []);
		clusterGroups.get(c)!.push(meta[i]);
	}

	const clusterLabels = new Map<number, string>();
	for (const [c, pts] of clusterGroups) {
		clusterLabels.set(c, labelCluster(pts));
	}

	// ── Assemble result ──────────────────────────────────────────────────────
	const points: StarPoint[] = meta.map((m, i) => ({
		...m,
		x: normalized[i][0],
		y: normalized[i][1],
		cluster: kResult.clusters[i],
		clusterLabel: clusterLabels.get(kResult.clusters[i]) ?? 'misc',
	}));

	self.postMessage({ type: 'done', points });
};
