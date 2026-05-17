<script lang="ts">
	import { onMount } from 'svelte';
	import * as d3 from 'd3';
	import type { StarPoint } from './umap.worker';
	import { CLUSTER_COLORS } from './demo';

	interface Props {
		stars: StarPoint[];
		username: string;
		onClose: () => void;
	}
	let { stars, username, onClose }: Props = $props();

	const LANG_COLORS: Record<string, string> = {
		TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Rust: '#dea584',
		Go: '#00ADD8', Ruby: '#701516', Java: '#b07219', 'C++': '#f34b7d', C: '#555555',
		Swift: '#F05138', Kotlin: '#A97BFF', Shell: '#89e051', Zig: '#ec915c',
	};

	// ── Data ─────────────────────────────────────────────────────────────────
	const currentYear = new Date().getFullYear();

	const starsThisYear = $derived(stars.filter(s => new Date(s.starred_at).getFullYear() === currentYear));
	const starsLastYear = $derived(stars.filter(s => new Date(s.starred_at).getFullYear() === currentYear - 1));

	const byYear = $derived(
		[...stars.reduce((m, s) => {
			const y = new Date(s.starred_at).getFullYear();
			if (!m.has(y)) m.set(y, [] as StarPoint[]);
			m.get(y)!.push(s);
			return m;
		}, new Map<number, StarPoint[]>()).entries()].sort((a, b) => a[0] - b[0])
	);

	const allTopics = $derived(() => {
		const m = new Map<string, number>();
		for (const s of stars) for (const t of s.topics) m.set(t, (m.get(t) ?? 0) + 1);
		return [...m.entries()].sort((a, b) => b[1] - a[1]);
	});

	const topLanguage = $derived(() => {
		const m = new Map<string, number>();
		for (const s of stars) if (s.language) m.set(s.language, (m.get(s.language) ?? 0) + 1);
		return [...m.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
	});

	const topCluster = $derived(() => {
		const m = new Map<number, { label: string; count: number }>();
		for (const s of stars) {
			if (!m.has(s.cluster)) m.set(s.cluster, { label: s.clusterLabel, count: 0 });
			m.get(s.cluster)!.count++;
		}
		return [...m.entries()].sort((a, b) => b[1].count - a[1].count)[0] ?? null;
	});

	const rarest = $derived(
		[...stars].sort((a, b) => a.stars_count - b.stars_count)[0] ?? null
	);

	const biggest = $derived(
		[...stars].sort((a, b) => b.stars_count - a.stars_count)[0] ?? null
	);

	const peakYear = $derived(
		byYear.reduce((best, curr) => curr[1].length > best[1].length ? curr : best, byYear[0] ?? [0, []])
	);

	const allLangs = $derived(() => {
		const m = new Map<string, number>();
		for (const s of stars) if (s.language) m.set(s.language, (m.get(s.language) ?? 0) + 1);
		return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
	});

	const allClusters = $derived(() => {
		const m = new Map<number, { label: string; count: number }>();
		for (const s of stars) {
			if (!m.has(s.cluster)) m.set(s.cluster, { label: s.clusterLabel, count: 0 });
			m.get(s.cluster)!.count++;
		}
		return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
	});

	// ── Slide navigation ──────────────────────────────────────────────────────
	let currentSlide = $state(0);
	const TOTAL_SLIDES = 7;

	function next() { if (currentSlide < TOTAL_SLIDES - 1) currentSlide++; }
	function prev() { if (currentSlide > 0) currentSlide--; }

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'ArrowRight' || e.key === ' ') next();
		if (e.key === 'ArrowLeft') prev();
		if (e.key === 'Escape') onClose();
	}

	// ── Charts ────────────────────────────────────────────────────────────────
	let timelineEl = $state<SVGSVGElement | undefined>();

	function drawTimeline() {
		if (!timelineEl || byYear.length === 0) return;
		const W = timelineEl.parentElement?.clientWidth ?? 500;
		const H = 180;
		const m = { top: 16, right: 16, bottom: 32, left: 32 };
		const w = W - m.left - m.right, h = H - m.top - m.bottom;

		d3.select(timelineEl).selectAll('*').remove();
		const svg = d3.select(timelineEl).attr('width', W).attr('height', H);
		const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

		const x = d3.scaleBand().domain(byYear.map(([y]) => String(y))).range([0, w]).padding(0.3);
		const y = d3.scaleLinear().domain([0, d3.max(byYear, ([, v]) => v.length) ?? 1]).nice().range([h, 0]);

		g.selectAll('.grid line').data(y.ticks(4)).join('line')
			.attr('x1', 0).attr('x2', w)
			.attr('y1', d => y(d)).attr('y2', d => y(d))
			.attr('stroke', '#ffffff08');

		g.selectAll('rect').data(byYear).join('rect')
			.attr('x', ([yr]) => x(String(yr)) ?? 0)
			.attr('y', h)
			.attr('width', x.bandwidth())
			.attr('height', 0)
			.attr('rx', 4)
			.attr('fill', ([yr]) => yr === currentYear ? '#a78bfa' : '#ffffff22')
			.transition().delay((_, i) => i * 60).duration(700).ease(d3.easeCubicOut)
			.attr('y', ([, v]) => y(v.length))
			.attr('height', ([, v]) => h - y(v.length));

		g.selectAll('.label').data(byYear).join('text')
			.attr('class', 'label')
			.attr('x', ([yr]) => (x(String(yr)) ?? 0) + x.bandwidth() / 2)
			.attr('y', ([, v]) => y(v.length) - 6)
			.attr('text-anchor', 'middle')
			.attr('font-size', '11px')
			.attr('fill', ([yr]) => yr === currentYear ? '#a78bfa' : '#ffffff55')
			.attr('opacity', 0)
			.text(([, v]) => v.length)
			.transition().delay((_, i) => i * 60 + 400).duration(400)
			.attr('opacity', 1);

		g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).tickSize(0))
			.call(g => g.select('.domain').remove())
			.selectAll('text').attr('fill', '#ffffff44').attr('font-size', '11px');
	}

	$effect(() => {
		if (currentSlide === 5 && byYear.length > 0) setTimeout(drawTimeline, 100);
	});

	function formatNum(n: number) {
		return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
	}

	// Animated counter
	let displayCount = $state(0);
	$effect(() => {
		if (currentSlide === 0) {
			displayCount = 0;
			let start = 0;
			const end = stars.length;
			const step = Math.max(1, Math.floor(end / 60));
			const timer = setInterval(() => {
				start = Math.min(start + step, end);
				displayCount = start;
				if (start >= end) clearInterval(timer);
			}, 16);
			return () => clearInterval(timer);
		}
	});

	onMount(() => {
		window.addEventListener('keydown', handleKey);
		return () => window.removeEventListener('keydown', handleKey);
	});
</script>

<div
	class="fixed inset-0 z-50 flex flex-col"
	style="background: #050810;"
	role="dialog"
	aria-modal="true"
>
	<!-- Close + progress dots -->
	<div class="flex items-center justify-between px-6 pt-5 pb-2 shrink-0">
		<div class="flex gap-1.5">
			{#each { length: TOTAL_SLIDES } as _, i}
				<div
					class="h-0.5 rounded-full transition-all duration-300"
					style="
						width: {i === currentSlide ? '24px' : '8px'};
						background: {i === currentSlide ? 'white' : '#ffffff30'};
					"
				></div>
			{/each}
		</div>
		<button onclick={onClose} class="text-sm px-3 py-1 rounded-full transition-all"
			style="color: #ffffff60; background: #ffffff10;">✕ close</button>
	</div>

	<!-- Slides -->
	<div class="flex-1 relative overflow-hidden">

		<!-- ── Slide 0: Hero ──────────────────────────────────────────────── -->
		{#if currentSlide === 0}
		<div class="absolute inset-0 flex flex-col items-center justify-center text-center px-8"
			style="background: radial-gradient(ellipse at 50% 60%, #2d1b69 0%, #050810 70%);">
			<p class="text-sm uppercase tracking-widest mb-6" style="color: #a78bfa;">your star atlas</p>
			<div class="text-9xl font-black mb-4 tabular-nums" style="color: white; line-height: 1;">{displayCount}</div>
			<p class="text-xl mb-2" style="color: #ffffff80;">repos starred all time</p>
			{#if starsThisYear.length > 0}
				<p class="text-sm mt-4 px-4 py-2 rounded-full" style="background: #a78bfa20; color: #a78bfa;">
					including {starsThisYear.length} starred in {currentYear}
				</p>
			{/if}
			<p class="text-xs mt-12" style="color: #ffffff30;">across {byYear.length} year{byYear.length !== 1 ? 's' : ''} of stargazing</p>
		</div>

		<!-- ── Slide 1: Top language ──────────────────────────────────────── -->
		{:else if currentSlide === 1}
		{@const lang = topLanguage()}
		<div class="absolute inset-0 flex flex-col items-center justify-center text-center px-8"
			style="background: radial-gradient(ellipse at 50% 40%, {lang ? (LANG_COLORS[lang[0]] + '40') : '#1a1040'} 0%, #050810 65%);">
			<p class="text-sm uppercase tracking-widest mb-8" style="color: #ffffff50;">your top language</p>
			{#if lang}
				<div class="w-20 h-20 rounded-2xl mb-6 flex items-center justify-center text-4xl"
					style="background: {LANG_COLORS[lang[0]] ?? '#8b949e'}20; border: 2px solid {LANG_COLORS[lang[0]] ?? '#8b949e'}40;">
					<span class="w-4 h-4 rounded-full inline-block" style="background: {LANG_COLORS[lang[0]] ?? '#8b949e'};"></span>
				</div>
				<h2 class="text-6xl font-black mb-3" style="color: white;">{lang[0]}</h2>
				<p class="text-xl" style="color: #ffffff60;">{lang[1]} repos all time</p>
			{:else}
				<p style="color: #ffffff40;">No language data</p>
			{/if}

			<div class="mt-12 flex flex-wrap justify-center gap-2 max-w-sm">
				{#each allTopics().slice(0, 6) as [topic]}
					<span class="text-xs px-3 py-1 rounded-full" style="background: #ffffff10; color: #ffffff60;">{topic}</span>
				{/each}
			</div>
		</div>

		<!-- ── Slide 2: Your identity ─────────────────────────────────────── -->
		{:else if currentSlide === 2}
		{@const cluster = topCluster()}
		<div class="absolute inset-0 flex flex-col items-center justify-center text-center px-8"
			style="background: radial-gradient(ellipse at 50% 40%, {cluster ? (CLUSTER_COLORS[cluster[0]] + '30') : '#1a1040'} 0%, #050810 65%);">
			<p class="text-sm uppercase tracking-widest mb-8" style="color: #ffffff50;">you are a</p>
			{#if cluster}
				<h2 class="text-5xl font-black mb-4 leading-tight" style="color: {CLUSTER_COLORS[cluster[0]]}">{cluster[1].label}</h2>
				<p class="text-lg mb-2" style="color: #ffffff60;">person</p>
				<p class="text-sm mt-4" style="color: #ffffff40;">{cluster[1].count} of your starred repos are in this constellation</p>
			{/if}

			<div class="mt-10 grid grid-cols-2 gap-3 w-full max-w-xs">
				{#each allClusters().slice(0, 4) as [cid, { label, count }]}
					{@const pct = Math.round((count / stars.length) * 100)}
					<div class="rounded-xl p-3 text-left" style="background: {CLUSTER_COLORS[cid]}15; border: 1px solid {CLUSTER_COLORS[cid]}30;">
						<p class="text-xs font-medium mb-1" style="color: {CLUSTER_COLORS[cid]};">{label}</p>
						<p class="text-xl font-bold" style="color: white;">{pct}%</p>
					</div>
				{/each}
			</div>
		</div>

		<!-- ── Slide 3: Hidden gem ────────────────────────────────────────── -->
		{:else if currentSlide === 3}
		<div class="absolute inset-0 flex flex-col items-center justify-center text-center px-8"
			style="background: radial-gradient(ellipse at 50% 40%, #14532d30 0%, #050810 65%);">
			<p class="text-sm uppercase tracking-widest mb-8" style="color: #4ade80;">your hidden gem</p>
			{#if rarest}
				<div class="rounded-2xl p-6 max-w-sm w-full text-left mb-6" style="background: #ffffff08; border: 1px solid #ffffff10;">
					<div class="flex items-center gap-3 mb-3">
						<img src={rarest.owner_avatar} alt="" class="w-8 h-8 rounded-full">
						<div>
							<p class="text-xs" style="color: #ffffff50;">{rarest.owner_login}</p>
							<p class="font-bold" style="color: white;">{rarest.name}</p>
						</div>
					</div>
					{#if rarest.description}
						<p class="text-sm leading-relaxed" style="color: #ffffff60;">{rarest.description}</p>
					{/if}
				</div>
				<div class="flex items-center gap-2">
					<span class="text-3xl font-black" style="color: #4ade80;">★ {formatNum(rarest.stars_count)}</span>
					<span class="text-sm" style="color: #ffffff40;">stars — you found it before everyone else</span>
				</div>
			{/if}
		</div>

		<!-- ── Slide 4: Biggest star ──────────────────────────────────────── -->
		{:else if currentSlide === 4}
		<div class="absolute inset-0 flex flex-col items-center justify-center text-center px-8"
			style="background: radial-gradient(ellipse at 50% 40%, #78350f30 0%, #050810 65%);">
			<p class="text-sm uppercase tracking-widest mb-8" style="color: #f59e0b;">your biggest star</p>
			{#if biggest}
				<div class="rounded-2xl p-6 max-w-sm w-full text-left mb-6" style="background: #ffffff08; border: 1px solid #ffffff10;">
					<div class="flex items-center gap-3 mb-3">
						<img src={biggest.owner_avatar} alt="" class="w-8 h-8 rounded-full">
						<div>
							<p class="text-xs" style="color: #ffffff50;">{biggest.owner_login}</p>
							<p class="font-bold" style="color: white;">{biggest.name}</p>
						</div>
					</div>
					{#if biggest.description}
						<p class="text-sm leading-relaxed" style="color: #ffffff60;">{biggest.description}</p>
					{/if}
				</div>
				<div class="flex items-center gap-2">
					<span class="text-3xl font-black" style="color: #f59e0b;">★ {formatNum(biggest.stars_count)}</span>
					<span class="text-sm" style="color: #ffffff40;">stars · you have good taste</span>
				</div>
			{/if}
		</div>

		<!-- ── Slide 5: Timeline ──────────────────────────────────────────── -->
		{:else if currentSlide === 5}
		<div class="absolute inset-0 flex flex-col justify-center px-8"
			style="background: radial-gradient(ellipse at 50% 80%, #1e1b4b30 0%, #050810 65%);">
			<p class="text-sm uppercase tracking-widest mb-2 text-center" style="color: #ffffff50;">stars over time</p>
			{#if peakYear[1].length > 0}
				<p class="text-center text-sm mb-8" style="color: #ffffff30;">
					your peak was <span style="color: #a78bfa;">{peakYear[0]}</span> with {peakYear[1].length} repos
				</p>
			{/if}
			<svg bind:this={timelineEl} class="w-full"></svg>

			<div class="mt-8 grid grid-cols-3 gap-4 text-center">
				{#each byYear.slice(-3) as [year, repos]}
					<div>
						<p class="text-2xl font-black" style="color: {year === currentYear ? '#a78bfa' : 'white'};">{repos.length}</p>
						<p class="text-xs" style="color: #ffffff40;">{year}</p>
					</div>
				{/each}
			</div>
		</div>

		<!-- ── Slide 6: Final wrap ────────────────────────────────────────── -->
		{:else if currentSlide === 6}
		<div class="absolute inset-0 flex flex-col items-center justify-center text-center px-8"
			style="background: radial-gradient(ellipse at 50% 50%, #2d1b6950 0%, #050810 65%);">
			<p class="text-sm uppercase tracking-widest mb-10" style="color: #a78bfa;">your star atlas · all time</p>

			<div class="grid grid-cols-2 gap-4 w-full max-w-sm mb-10">
				{#each [
					['⭐', stars.length, 'total stars'],
					['📅', byYear.length, 'years active'],
					['🌐', allLangs().length, 'languages'],
					['🔭', allClusters().length, 'constellations'],
				] as [icon, val, label]}
					<div class="rounded-2xl p-4" style="background: #ffffff08; border: 1px solid #ffffff10;">
						<div class="text-2xl mb-1">{icon}</div>
						<div class="text-3xl font-black" style="color: white;">{val}</div>
						<div class="text-xs mt-1" style="color: #ffffff40;">{label}</div>
					</div>
				{/each}
			</div>

			<div class="flex items-center gap-2 text-sm" style="color: #ffffff40;">
				<span>⭐ starg<span style="color: #a78bfa;">h</span>azer</span>
				<span>·</span>
				<span>@{username}</span>
			</div>
		</div>
		{/if}
	</div>

	<!-- Nav arrows -->
	<div class="flex items-center justify-between px-6 pb-6 pt-2 shrink-0">
		<button
			onclick={prev}
			disabled={currentSlide === 0}
			class="px-5 py-2.5 rounded-full text-sm font-medium transition-all disabled:opacity-20"
			style="background: #ffffff15; color: white;"
		>← prev</button>

		<span class="text-xs" style="color: #ffffff30;">{currentSlide + 1} / {TOTAL_SLIDES}</span>

		{#if currentSlide < TOTAL_SLIDES - 1}
			<button onclick={next} class="px-5 py-2.5 rounded-full text-sm font-medium"
				style="background: #a78bfa; color: white;">next →</button>
		{:else}
			<button onclick={onClose} class="px-5 py-2.5 rounded-full text-sm font-medium"
				style="background: #a78bfa; color: white;">back to galaxy</button>
		{/if}
	</div>
</div>
