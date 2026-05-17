<script lang="ts">
	import { onMount } from 'svelte';
	import Galaxy from '$lib/Galaxy.svelte';
	import Wrapped from '$lib/Wrapped.svelte';
	import { DEMO_STARS, CLUSTER_COLORS } from '$lib/demo';
	import { fetchUser, fetchAllStars } from '$lib/github';
	import {
		getDb, upsertRepos, saveEmbedding, persistEmbeddings,
		loadReposFromIdb, loadEmbeddingsIntoDb, loadGalaxyFromIdb,
		saveGalaxy, semanticSearch, setMeta, getRepoCount, getEmbeddedCount,
		getReposForUmap, parseVector, clearAll
	} from '$lib/db';
	import type { StarPoint } from '$lib/umap.worker';
	import type { Repo } from '$lib/github';

	// ── State ────────────────────────────────────────────────────────────────
	type Phase = 'landing' | 'validating' | 'syncing' | 'embedding' | 'umap' | 'ready';

	let phase = $state<Phase>('landing');
	let usernameInput = $state('');
	let user = $state<{ login: string; avatar_url: string } | null>(null);
	let error = $state('');

	let fetchDone = $state(0);
	let embedDone = $state(0);
	let embedTotal = $state(0);
	let embedModelLoading = $state(false);
	let umapMessage = $state('');
	let umapProgress = $state(0);

	let galaxyStars = $state<StarPoint[]>(DEMO_STARS);
	let isDemo = $state(true);
	let searchQuery = $state('');
	let totalStars = $state(0);
	let semanticResultIds = $state<Set<number> | null>(null);
	let showStats = $state(false);
	let username = $state('');
	let dbReady = $state(false); // embeddings loaded into PGlite for search
	let yearFilter = $state<number | null>(null);

	const availableYears = $derived(
		[...new Set(galaxyStars.map(s => new Date(s.starred_at).getFullYear()))]
			.sort((a, b) => b - a)
	);

	const filteredStars = $derived(
		yearFilter ? galaxyStars.filter(s => new Date(s.starred_at).getFullYear() === yearFilter) : galaxyStars
	);


	let embedWorker: Worker | null = null;
	let umapWorker: Worker | null = null;
	let pendingEmbedResolve: ((v: { embeddings: number[][], ids: number[] }) => void) | null = null;
	let pendingQueryResolve: ((v: number[]) => void) | null = null;

	// ── Boot ─────────────────────────────────────────────────────────────────
	onMount(async () => {
		initWorkers();
		const saved = localStorage.getItem('starghazer-username');
		if (saved) {
			usernameInput = saved;
			username = saved;
			await resumeFromIdb(saved);
		}
	});

	function initWorkers() {
		embedWorker = new Worker(new URL('$lib/embedder.worker.ts', import.meta.url), { type: 'module' });
		embedWorker.onmessage = (e) => {
			const msg = e.data;
			if (msg.type === 'model-loading') embedModelLoading = true;
			if (msg.type === 'model-ready') embedModelLoading = false;
			if (msg.type === 'progress') embedDone = msg.done;
			if (msg.type === 'done' && pendingEmbedResolve) {
				pendingEmbedResolve({ embeddings: msg.embeddings, ids: msg.ids });
				pendingEmbedResolve = null;
			}
			if (msg.type === 'query-done' && pendingQueryResolve) {
				pendingQueryResolve(msg.embedding);
				pendingQueryResolve = null;
			}
		};

		umapWorker = new Worker(new URL('$lib/umap.worker.ts', import.meta.url), { type: 'module' });
		umapWorker.onmessage = (e) => {
			const msg = e.data;
			if (msg.type === 'status') { umapMessage = msg.message; umapProgress = msg.progress; }
			if (msg.type === 'done') saveAndShowGalaxy(msg.points);
		};
	}

	// ── Resume from IDB (instant load on revisit) ─────────────────────────────
	async function resumeFromIdb(username: string) {
		try {
			// 1. Check if we have a fully computed galaxy
			const cachedGalaxy = await loadGalaxyFromIdb();
			if (cachedGalaxy && cachedGalaxy.length > 0) {
				galaxyStars = cachedGalaxy;
				totalStars = cachedGalaxy.length;
				isDemo = false;
				phase = 'ready';
				user = await fetchUser(username).catch(() => null);
				// Load repos + embeddings into PGlite memory for search (non-blocking)
				loadDbForSearch();
				return;
			}

			// 2. Have repos + embeddings but no UMAP yet
			const cachedRepos = await loadReposFromIdb();
			if (!cachedRepos || cachedRepos.length === 0) return;

			user = await fetchUser(username).catch(() => null);
			totalStars = cachedRepos.length;

			// Restore repos + embeddings into in-memory PGlite
			await getDb();
			await upsertRepos(cachedRepos);
			const restored = await loadEmbeddingsIntoDb();

			if (restored && (await getEmbeddedCount()) === cachedRepos.length) {
				await runUmap();
			} else {
				phase = 'embedding';
				await embedAll(cachedRepos.map(repoToEmbedItem));
				await runUmap();
			}
		} catch (e) {
			console.error('Resume failed:', e);
		}
	}

	async function loadDbForSearch() {
		try {
			const cachedRepos = await loadReposFromIdb();
			if (!cachedRepos) return;
			await getDb();
			await upsertRepos(cachedRepos);
			await loadEmbeddingsIntoDb();
			dbReady = true;
		} catch (e) {
			console.warn('Search index load failed:', e);
		}
	}

	// ── Connect ───────────────────────────────────────────────────────────────
	async function connect() {
		error = '';
		phase = 'validating';
		const u = usernameInput.trim().replace(/^@/, '');
		username = u;
		try {
			user = await fetchUser(u);
			localStorage.setItem('starghazer-username', u);
			await syncAndBuild(u);
		} catch (e) {
			error = e instanceof Error ? e.message : 'User not found';
			phase = 'landing';
		}
	}

	async function syncAndBuild(username: string) {
		// Fetch stars
		phase = 'syncing';
		fetchDone = 0;
		const repos = await fetchAllStars(username, (n) => (fetchDone = n));
		totalStars = repos.length;

		await getDb();
		await upsertRepos(repos); // also saves to IDB

		// Embed — skip repos already embedded (resume-safe)
		phase = 'embedding';
		const alreadyEmbedded = await loadEmbeddingsIntoDb();
		const embeddedCount = alreadyEmbedded ? await getEmbeddedCount() : 0;
		const toEmbed = repos.map(repoToEmbedItem).slice(embeddedCount);
		embedDone = embeddedCount;
		embedTotal = repos.length;
		await embedAll(toEmbed, embeddedCount);

		// UMAP
		await runUmap();
	}

	// ── Embedding ─────────────────────────────────────────────────────────────
	function repoToEmbedItem(r: Repo) {
		return {
			id: r.id,
			text: [r.full_name.replace('/', ' '), r.description ?? '', r.topics.join(' ')].join(' ')
		};
	}

	async function embedAll(items: { id: number; text: string }[], startOffset = 0) {
		if (!embedWorker) return;
		if (!items.length) return;
		embedTotal = embedTotal || items.length;

		const BATCH = 50;
		for (let i = 0; i < items.length; i += BATCH) {
			const batch = items.slice(i, i + BATCH);
			const { embeddings, ids } = await new Promise<{ embeddings: number[][], ids: number[] }>((res) => {
				pendingEmbedResolve = res;
				embedWorker!.postMessage({ type: 'embed', texts: batch.map((b) => b.text), ids: batch.map((b) => b.id) });
			});
			for (let j = 0; j < ids.length; j++) {
				await saveEmbedding(ids[j], embeddings[j]);
			}
			embedDone = startOffset + Math.min(i + BATCH, items.length);
			// Persist to IDB after every batch so a refresh can resume
			await persistEmbeddings();
		}
	}

	// ── UMAP ──────────────────────────────────────────────────────────────────
	async function runUmap() {
		phase = 'umap';
		umapProgress = 0;
		umapMessage = 'Preparing…';

		const d = await getDb();
		const rows = await getReposForUmap();

		const embResults = await d.query<{ id: number; embedding: string }>(
			`SELECT id, embedding::text FROM repos WHERE embedding IS NOT NULL ORDER BY id`
		);

		const embMap = new Map(embResults.rows.map((r) => [r.id, parseVector(r.embedding)]));
		const ordered = rows.filter((r) => embMap.has(r.id));
		const embeddings = ordered.map((r) => embMap.get(r.id)!);
		const meta = ordered.map((r) => ({ ...r, topics: JSON.parse(r.topics) as string[] }));

		umapWorker!.postMessage({ embeddings, meta });
	}

	async function saveAndShowGalaxy(points: StarPoint[]) {
		await saveGalaxy(points);
		await setMeta('last-sync', new Date().toISOString());
		galaxyStars = points;
		isDemo = false;
		dbReady = true;
		phase = 'ready';
	}

	// ── Search ────────────────────────────────────────────────────────────────
	let searchTimeout: ReturnType<typeof setTimeout>;
	let isSearching = $state(false);
	let searchResults = $state<StarPoint[]>([]);
	let showResults = $state(false);

	$effect(() => {
		if (phase !== 'ready' || isDemo || !dbReady) return;
		const q = searchQuery;
		clearTimeout(searchTimeout);
		if (!q) { semanticResultIds = null; searchResults = []; showResults = false; return; }
		semanticResultIds = null; // clear immediately so Galaxy falls back to keyword dimming
		searchTimeout = setTimeout(() => runSemanticSearch(q, false), 350);
	});

	async function runSemanticSearch(q: string, openPanel = true) {
		if (!embedWorker) return;
		isSearching = true;
		try {
			const embedding = await new Promise<number[]>((res) => {
				pendingQueryResolve = res;
				embedWorker!.postMessage({ type: 'embed-query', text: q });
			});
			const rows = await semanticSearch(embedding, 100);
			const idOrder = new Map(rows.map((r, i) => [r.id, i]));
			semanticResultIds = new Set(rows.map((r) => r.id));
			// Map to StarPoint[] in similarity order
			searchResults = [...galaxyStars]
				.filter((s) => idOrder.has(s.id))
				.sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999));
			if (openPanel) showResults = true;
		} finally {
			isSearching = false;
		}
	}

	function closeResults() {
		showResults = false;
	}

	function disconnect() {
		localStorage.removeItem('starghazer-username');
		showStats = false;
		clearAll();
		user = null;
		galaxyStars = DEMO_STARS;
		isDemo = true;
		phase = 'landing';
		searchQuery = '';
		totalStars = 0;
	}

	// ── Progress ──────────────────────────────────────────────────────────────
	const progressLabel = $derived(
		phase === 'syncing' ? `Fetching your stars… ${fetchDone} found`
		: phase === 'embedding'
			? (embedModelLoading
				? 'Downloading AI model (23 MB, cached after first run)…'
				: embedTotal > 0
					? `Indexing ${embedDone} / ${embedTotal} repos locally…`
					: 'Starting local AI…')
		: phase === 'umap' ? (umapMessage || 'Computing galaxy layout…')
		: ''
	);

	const progressPct = $derived(
		phase === 'syncing' ? Math.min((fetchDone / Math.max(totalStars, 100)) * 100, 90)
		: phase === 'embedding' ? (embedTotal > 0 ? (embedDone / embedTotal) * 100 : 5)
		: phase === 'umap' ? umapProgress * 100
		: 0
	);
</script>

<!-- Galaxy always fills the screen -->
<div class="fixed inset-0">
	<Galaxy stars={filteredStars} {searchQuery} {semanticResultIds} {isDemo} />
</div>

<!-- ─── Landing ─────────────────────────────────────────────────────────── -->
{#if phase === 'landing' || phase === 'validating'}
<div class="fixed inset-0 z-20 flex flex-col items-center justify-center pointer-events-none">
	<div
		class="pointer-events-auto rounded-2xl border p-8 w-full max-w-sm shadow-2xl"
		style="background: rgba(13,17,23,0.88); border-color: #21262d; backdrop-filter: blur(16px);"
	>
		<div class="text-center mb-6">
			<div class="inline-flex items-center gap-2 mb-3">
				<span class="text-2xl">⭐</span>
				<h1 class="text-2xl font-bold tracking-tight" style="color: #e6edf3;">
					starg<span style="color: #a78bfa;">h</span>azer
				</h1>
			</div>
			<p class="text-sm leading-relaxed" style="color: #7d8590;">
				Your GitHub stars as a galaxy.<br>
				Semantic search. Local AI. No API key.
			</p>
		</div>

		<div class="flex items-center gap-2 mb-5">
			<div class="flex-1 h-px" style="background: #21262d;"></div>
			<span class="text-xs px-2" style="color: #3d444d;">← demo galaxy behind</span>
			<div class="flex-1 h-px" style="background: #21262d;"></div>
		</div>

		<label for="username" class="block text-xs font-medium mb-1.5 uppercase tracking-wider" style="color: #7d8590;">
			GitHub Username
		</label>
		<div class="flex gap-2">
			<div class="relative flex-1">
				<span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style="color: #3d444d;">@</span>
				<input
					id="username"
					type="text"
					bind:value={usernameInput}
					placeholder="your-username"
					class="w-full rounded-lg pl-7 pr-3 py-2.5 text-sm border outline-none"
					style="background: #0d1117; color: #e6edf3; border-color: #30363d;"
					onkeydown={(e) => e.key === 'Enter' && usernameInput && connect()}
					disabled={phase === 'validating'}
					autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
				/>
			</div>
			<button
				onclick={connect}
				disabled={!usernameInput || phase === 'validating'}
				class="px-4 rounded-lg text-sm font-semibold transition-all disabled:opacity-40 shrink-0"
				style="background: #a78bfa; color: white;"
			>
				{phase === 'validating' ? '…' : '→'}
			</button>
		</div>

		{#if error}
			<div class="rounded-lg px-3 py-2 mt-3 text-xs" style="background: #3d0f0f; color: #f85149;">{error}</div>
		{/if}

		<p class="text-center text-xs mt-4" style="color: #3d444d;">
			No login · No token · Stars are public
		</p>
	</div>
</div>

<!-- ─── Processing ─────────────────────────────────────────────────────── -->
{:else if phase === 'syncing' || phase === 'embedding' || phase === 'umap'}
<div class="fixed inset-0 z-20 flex flex-col items-end justify-end p-6 pointer-events-none">
	<div
		class="pointer-events-auto rounded-xl border px-5 py-4 w-80 shadow-2xl"
		style="background: rgba(13,17,23,0.92); border-color: #21262d; backdrop-filter: blur(12px);"
	>
		<div class="flex items-center gap-2 mb-3">
			<div class="w-2 h-2 rounded-full animate-pulse" style="background: #a78bfa;"></div>
			<span class="text-xs font-medium uppercase tracking-wider" style="color: #a78bfa;">
				{phase === 'syncing' ? 'Fetching' : phase === 'embedding' ? 'Indexing' : 'Mapping'}
			</span>
		</div>

		<p class="text-sm mb-3 leading-relaxed" style="color: #e6edf3;">{progressLabel}</p>

		<div class="h-1 rounded-full overflow-hidden mb-1" style="background: #21262d;">
			<div
				class="h-full rounded-full transition-all duration-500"
				style="background: linear-gradient(90deg, #6366f1, #a78bfa); width: {progressPct}%;"
			></div>
		</div>

		{#if phase === 'embedding'}
			<p class="text-xs mt-2" style="color: #3d444d;">Running locally · No data sent anywhere</p>
		{:else if phase === 'umap'}
			<p class="text-xs mt-2" style="color: #3d444d;">Cached permanently after first run</p>
		{/if}
	</div>
</div>

<!-- ─── Ready ─────────────────────────────────────────────────────────── -->
{:else if phase === 'ready'}
<div class="fixed top-0 left-0 right-0 z-20 pointer-events-none">
	<div class="max-w-2xl mx-auto px-4 pt-4 flex flex-col gap-2">

		<!-- Main bar -->
		<div
			class="pointer-events-auto rounded-xl border px-3 py-2 flex items-center gap-3 shadow-2xl"
			style="background: rgba(13,17,23,0.88); border-color: #21262d; backdrop-filter: blur(16px);"
		>
			<span class="text-base shrink-0 font-bold" style="color: #e6edf3;">
				⭐ starg<span style="color: #a78bfa;">h</span>azer
			</span>

			<div class="w-px h-4 shrink-0" style="background: #21262d;"></div>

			<input
				type="text"
				bind:value={searchQuery}
				placeholder={dbReady ? 'Search by meaning… try "fast json parser"' : 'Search repos… (AI index loading)'}
				disabled={false}
				class="flex-1 bg-transparent text-sm outline-none min-w-0 disabled:opacity-40"
				style="color: #e6edf3;"
				onkeydown={(e) => {
					if (e.key === 'Enter' && searchQuery) {
						clearTimeout(searchTimeout);
						if (dbReady) {
							runSemanticSearch(searchQuery, true);
						} else {
							// Keyword fallback: show currently highlighted stars as results
							const q = searchQuery.toLowerCase();
							searchResults = galaxyStars.filter((s) =>
								s.full_name.toLowerCase().includes(q) ||
								(s.description ?? '').toLowerCase().includes(q) ||
								s.topics.some((t) => t.includes(q)) ||
								(s.language ?? '').toLowerCase().includes(q)
							);
							semanticResultIds = new Set(searchResults.map((s) => s.id));
							showResults = true;
						}
					}
					if (e.key === 'Escape') {
						if (showResults) { showResults = false; }
						else { searchQuery = ''; semanticResultIds = null; searchResults = []; }
					}
				}}
			/>

			{#if isSearching}
				<div class="w-3 h-3 rounded-full border-2 animate-spin shrink-0"
					style="border-color: #a78bfa; border-top-color: transparent;"></div>
			{:else if !dbReady && phase === 'ready'}
				<div class="w-3 h-3 rounded-full border-2 animate-spin shrink-0"
					style="border-color: #3d444d; border-top-color: transparent;" title="Loading search index…"></div>
			{/if}

			{#if semanticResultIds && searchResults.length > 0}
				<button
					onclick={() => showResults = true}
					class="text-xs shrink-0 px-2 py-0.5 rounded-full transition-all"
					style="background: #1a1040; border: 1px solid #a78bfa40; color: #a78bfa;"
				>{searchResults.length} results ↗</button>
			{:else}
				<span class="text-xs shrink-0 px-2 py-0.5 rounded-full" style="background: #21262d; color: #7d8590;">
					{yearFilter ? `${filteredStars.length} / ${totalStars}` : `${totalStars} stars`}
				</span>
			{/if}

			<button
				onclick={() => showStats = !showStats}
				class="shrink-0 text-xs px-2.5 py-1 rounded-lg border transition-all"
				style="
					background: {showStats ? '#1a1040' : 'transparent'};
					border-color: {showStats ? '#a78bfa' : '#21262d'};
					color: {showStats ? '#a78bfa' : '#7d8590'};
				"
				title="Star Stats"
			>📊 stats</button>

			{#if user}
				<button onclick={disconnect} title="Disconnect" class="shrink-0 opacity-60 hover:opacity-100 transition-opacity">
					<img src={user.avatar_url} alt={user.login} class="w-6 h-6 rounded-full" />
				</button>
			{/if}
		</div>

		<!-- Year filter chips -->
		{#if availableYears.length > 1}
		<div class="pointer-events-auto flex gap-1.5 flex-wrap">
			<button
				onclick={() => yearFilter = null}
				class="text-xs px-3 py-1 rounded-full border transition-all"
				style="
					background: {yearFilter === null ? '#a78bfa' : 'rgba(13,17,23,0.75)'};
					border-color: {yearFilter === null ? '#a78bfa' : '#21262d'};
					color: {yearFilter === null ? 'white' : '#7d8590'};
					backdrop-filter: blur(8px);
				"
			>All time</button>
			{#each availableYears as year}
				<button
					onclick={() => yearFilter = yearFilter === year ? null : year}
					class="text-xs px-3 py-1 rounded-full border transition-all"
					style="
						background: {yearFilter === year ? '#a78bfa' : 'rgba(13,17,23,0.75)'};
						border-color: {yearFilter === year ? '#a78bfa' : '#21262d'};
						color: {yearFilter === year ? 'white' : '#7d8590'};
						backdrop-filter: blur(8px);
					"
				>{year}</button>
			{/each}
		</div>
		{/if}

	</div>
</div>

<!-- Hint -->
<div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
	<div class="rounded-full px-4 py-2 text-xs border"
		style="background: rgba(13,17,23,0.6); border-color: #21262d; color: #3d444d; backdrop-filter: blur(8px);">
		Scroll to zoom · Drag to pan · Hover to preview · Click to open
	</div>
</div>

<!-- Search results panel -->
{#if showResults && searchResults.length > 0}
	{@const LANG_COLORS: Record<string, string> = {
		TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Rust: '#dea584',
		Go: '#00ADD8', Ruby: '#701516', Java: '#b07219', 'C++': '#f34b7d', C: '#555555',
		Swift: '#F05138', Kotlin: '#A97BFF', Shell: '#89e051', Zig: '#ec915c',
	}}
	<div
		class="fixed top-0 right-0 bottom-0 z-30 flex flex-col"
		style="width: min(420px, 100vw); background: rgba(7,11,20,0.97); border-left: 1px solid #21262d; backdrop-filter: blur(20px);"
	>
		<!-- Header -->
		<div class="flex items-center gap-3 px-4 py-3 border-b shrink-0" style="border-color: #21262d;">
			<div class="flex-1 min-w-0">
				<p class="text-sm font-semibold" style="color: #e6edf3;">"{searchQuery}"</p>
				<p class="text-xs" style="color: #7d8590;">{searchResults.length} repos · ranked by meaning</p>
			</div>
			<button
				onclick={closeResults}
				class="w-7 h-7 flex items-center justify-center rounded-lg transition-colors shrink-0"
				style="color: #7d8590; background: #21262d20;"
				title="Close (Esc)"
			>✕</button>
		</div>

		<!-- Results list -->
		<div class="flex-1 overflow-y-auto">
			{#each searchResults as repo, i}
				{@const clusterColor = CLUSTER_COLORS[repo.cluster] ?? '#8b949e'}
				<a
					href={repo.html_url}
					target="_blank"
					rel="noopener noreferrer"
					class="flex gap-3 px-4 py-3 border-b transition-colors"
					style="border-color: #21262d10; text-decoration: none;"
					onmouseenter={(e) => (e.currentTarget as HTMLElement).style.background = '#ffffff06'}
					onmouseleave={(e) => (e.currentTarget as HTMLElement).style.background = 'transparent'}
				>
					<!-- Rank -->
					<span class="text-xs w-5 shrink-0 mt-0.5 text-right" style="color: #3d444d;">{i + 1}</span>

					<!-- Avatar -->
					<img src={repo.owner_avatar} alt={repo.owner_login} class="w-8 h-8 rounded-full shrink-0 mt-0.5" />

					<!-- Content -->
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-1.5 mb-0.5">
							<span class="text-xs" style="color: #7d8590;">{repo.owner_login} /</span>
							<span class="text-sm font-semibold truncate" style="color: #e6edf3;">{repo.name}</span>
						</div>

						{#if repo.description}
							<p class="text-xs leading-relaxed line-clamp-2 mb-1.5" style="color: #7d8590;">{repo.description}</p>
						{/if}

						<div class="flex items-center gap-3 text-xs flex-wrap" style="color: #3d444d;">
							{#if repo.language}
								<span class="flex items-center gap-1">
									<span class="w-2 h-2 rounded-full shrink-0" style="background: {LANG_COLORS[repo.language] ?? '#8b949e'};"></span>
									{repo.language}
								</span>
							{/if}
							<span style="color: #f0b429;">★ {repo.stars_count >= 1000 ? (repo.stars_count / 1000).toFixed(1) + 'k' : repo.stars_count}</span>
							<span class="flex items-center gap-1">
								<span class="w-1.5 h-1.5 rounded-full shrink-0" style="background: {clusterColor};"></span>
								<span style="color: {clusterColor}; opacity: 0.8;">{repo.clusterLabel}</span>
							</span>
						</div>
					</div>
				</a>
			{/each}
		</div>
	</div>
{/if}

{/if}

{#if showStats}
	<Wrapped
		stars={galaxyStars}
		{username}
		onClose={() => showStats = false}
	/>
{/if}
