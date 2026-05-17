<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import * as d3 from 'd3';
	import type { StarPoint } from './umap.worker';
	import { CLUSTER_COLORS } from './demo';

	interface Props {
		stars: StarPoint[];
		searchQuery?: string;
		semanticResultIds?: Set<number> | null;
		isDemo?: boolean;
		onStarClick?: (star: StarPoint) => void;
	}

	let { stars, searchQuery = '', semanticResultIds = null, isDemo = false, onStarClick }: Props = $props();

	let container: HTMLDivElement;
	let svgEl: SVGSVGElement;
	let width = $state(800);
	let height = $state(600);
	let hoveredStar = $state<StarPoint | null>(null);
	let tooltipX = $state(0);
	let tooltipY = $state(0);
	let tooltipAbove = $state(false);

	// D3 selections
	let svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
	let g: d3.Selection<SVGGElement, unknown, null, undefined>;
	let simulation: d3.Simulation<SimNode, undefined>;
	let animationFrame: number;

	interface SimNode extends StarPoint {
		cx: number; // pixel coords after layout
		cy: number;
		vx?: number;
		vy?: number;
		fx?: number | null;
		fy?: number | null;
	}

	let nodes: SimNode[] = [];
	let clusterCentroids: Map<number, { x: number; y: number; label: string }> = new Map();

	// Semantic results take priority; fall back to keyword highlight
	let highlightedIds = $derived(
		semanticResultIds
			? semanticResultIds
			: searchQuery
				? new Set(
						stars
							.filter(
								(s) =>
									s.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
									(s.description ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
									s.topics.some((t) => t.includes(searchQuery.toLowerCase())) ||
									(s.language ?? '').toLowerCase().includes(searchQuery.toLowerCase())
							)
							.map((s) => s.id)
					)
				: null
	);

	function starRadius(s: StarPoint): number {
		return Math.max(3, Math.min(11, Math.log(s.stars_count + 10) * 1.4));
	}

	function toPixel(v: number, dimension: number, padding: number): number {
		return padding + v * (dimension - padding * 2);
	}

	function buildNodes(): SimNode[] {
		const pad = Math.min(width, height) * 0.08;
		return stars.map((s) => ({
			...s,
			cx: toPixel(s.x, width, pad),
			cy: toPixel(s.y, height, pad),
		}));
	}

	function computeCentroids(ns: SimNode[]) {
		const groups = new Map<number, SimNode[]>();
		for (const n of ns) {
			if (!groups.has(n.cluster)) groups.set(n.cluster, []);
			groups.get(n.cluster)!.push(n);
		}
		const result = new Map<number, { x: number; y: number; label: string }>();
		for (const [c, pts] of groups) {
			result.set(c, {
				x: pts.reduce((s, p) => s + p.cx, 0) / pts.length,
				y: pts.reduce((s, p) => s + p.cy, 0) / pts.length,
				label: pts[0].clusterLabel,
			});
		}
		clusterCentroids = result;
	}

	function render() {
		if (!svgEl || nodes.length === 0) return;

		svg = d3.select(svgEl);
		svg.selectAll('*').remove();

		// Defs: glow filters
		const defs = svg.append('defs');

		// Per-cluster glow filters
		for (const [c, color] of Object.entries(CLUSTER_COLORS)) {
			const filter = defs
				.append('filter')
				.attr('id', `glow-${c}`)
				.attr('x', '-50%')
				.attr('y', '-50%')
				.attr('width', '200%')
				.attr('height', '200%');
			filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
			const merge = filter.append('feMerge');
			merge.append('feMergeNode').attr('in', 'blur');
			merge.append('feMergeNode').attr('in', 'SourceGraphic');
		}

		// Root group for zoom/pan
		g = svg.append('g').attr('class', 'galaxy-root');

		// ── Nebulae (cluster halos) ───────────────────────────────────────
		const nebulaG = g.append('g').attr('class', 'nebulae');
		for (const [c, centroid] of clusterCentroids) {
			const color = CLUSTER_COLORS[c] ?? '#ffffff';
			const clusterNodes = nodes.filter((n) => n.cluster === c);
			// Compute spread
			const maxDist = Math.max(
				60,
				...clusterNodes.map((n) =>
					Math.sqrt(Math.pow(n.cx - centroid.x, 2) + Math.pow(n.cy - centroid.y, 2))
				)
			);

			const gradId = `nebula-${c}`;
			const grad = defs
				.append('radialGradient')
				.attr('id', gradId)
				.attr('cx', '50%')
				.attr('cy', '50%')
				.attr('r', '50%');
			grad.append('stop').attr('offset', '0%').attr('stop-color', color).attr('stop-opacity', 0.09);
			grad.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', 0);

			nebulaG
				.append('ellipse')
				.attr('cx', centroid.x)
				.attr('cy', centroid.y)
				.attr('rx', maxDist * 1.4)
				.attr('ry', maxDist * 1.2)
				.attr('fill', `url(#${gradId})`)
				.attr('class', 'nebula');
		}

		// ── Stars ─────────────────────────────────────────────────────────
		const starsG = g.append('g').attr('class', 'stars');

		const starNodes = starsG
			.selectAll<SVGCircleElement, SimNode>('circle')
			.data(nodes, (d) => String(d.id))
			.join('circle')
			.attr('r', (d) => starRadius(d))
			.attr('cx', (d) => d.cx)
			.attr('cy', (d) => d.cy)
			.attr('fill', (d) => CLUSTER_COLORS[d.cluster] ?? '#ffffff')
			.attr('filter', (d) => `url(#glow-${d.cluster})`)
			.attr('opacity', 0)
			.attr('cursor', 'pointer')
			.style('transition', 'opacity 0.2s, r 0.2s');

		// ── Cluster labels ────────────────────────────────────────────────
		const labelsG = g.append('g').attr('class', 'cluster-labels');
		for (const [c, centroid] of clusterCentroids) {
			const color = CLUSTER_COLORS[c] ?? '#ffffff';
			const labelText = centroid.label.toUpperCase();
			const labelG = labelsG.append('g')
				.attr('pointer-events', 'none')
				.attr('opacity', 0);

			// Text first so we can measure it
			const textEl = labelG.append('text')
				.attr('x', centroid.x)
				.attr('y', centroid.y - 32)
				.attr('text-anchor', 'middle')
				.attr('dominant-baseline', 'middle')
				.attr('font-size', '9px')
				.attr('font-family', 'system-ui, sans-serif')
				.attr('letter-spacing', '0.1em')
				.attr('fill', 'white')
				.attr('font-weight', '600')
				.text(labelText);

			// Measure and draw pill behind
			const bbox = (textEl.node() as SVGTextElement).getBBox();
			const pad = { x: 8, y: 4 };
			labelG.insert('rect', 'text')
				.attr('x', bbox.x - pad.x)
				.attr('y', bbox.y - pad.y)
				.attr('width', bbox.width + pad.x * 2)
				.attr('height', bbox.height + pad.y * 2)
				.attr('rx', (bbox.height + pad.y * 2) / 2)
				.attr('fill', '#0a0e1a')
				.attr('fill-opacity', 0.85)
				.attr('stroke', color)
				.attr('stroke-width', 1)
				.attr('stroke-opacity', 0.7);

			labelG.transition().delay(1500).duration(500).attr('opacity', 1);
		}

		// ── Events ────────────────────────────────────────────────────────
		starNodes
			.on('mouseenter', function (event, d) {
				d3.select(this).raise().attr('r', starRadius(d) * 2.2);
				hoveredStar = d;
				updateTooltipPos(event);
			})
			.on('mousemove', (event) => updateTooltipPos(event))
			.on('mouseleave', function (_, d) {
				d3.select(this).attr('r', starRadius(d));
				hoveredStar = null;
			})
			.on('click', (_, d) => {
				onStarClick?.(d);
				window.open(d.html_url, '_blank', 'noopener,noreferrer');
			});

		// ── Big bang entrance animation ───────────────────────────────────
		const cx = width / 2;
		const cy = height / 2;

		starNodes
			.attr('cx', cx)
			.attr('cy', cy)
			.transition()
			.delay((_, i) => i * 2)
			.duration(1200)
			.ease(d3.easeCubicOut)
			.attr('cx', (d) => d.cx)
			.attr('cy', (d) => d.cy)
			.attr('opacity', 1);

		labelsG
			.selectAll('text')
			.attr('opacity', 0)
			.transition()
			.delay(1400)
			.duration(600)
			.attr('opacity', 0.5);

		// ── Zoom / pan ────────────────────────────────────────────────────
		const zoom = d3
			.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.3, 8])
			.on('zoom', (event) => {
				g.attr('transform', event.transform);
			});

		svg.call(zoom).on('dblclick.zoom', null);
	}

	function updateTooltipPos(event: MouseEvent) {
		const rect = svgEl.getBoundingClientRect();
		tooltipX = event.clientX - rect.left;
		tooltipY = event.clientY - rect.top;
		tooltipAbove = tooltipY > height * 0.6;
	}

	$effect(() => {
		// Read highlightedIds BEFORE any early return so Svelte tracks it as a dependency
		// even on the first run when g hasn't been set yet.
		const ids = highlightedIds;
		if (!g) return;
		g.selectAll<SVGCircleElement, SimNode>('.stars circle').attr('opacity', (d) => {
			if (!ids) return 1;
			return ids.has(d.id) ? 1 : 0.08;
		});
	});

	$effect(() => {
		// Re-render when stars or dimensions change
		const s = stars;
		const w = width;
		const h = height;
		if (s.length > 0 && w > 0 && h > 0) {
			nodes = buildNodes();
			computeCentroids(nodes);
			render();
		}
	});

	onMount(() => {
		const ro = new ResizeObserver((entries) => {
			const entry = entries[0];
			width = entry.contentRect.width;
			height = entry.contentRect.height;
		});
		ro.observe(container);
		width = container.clientWidth;
		height = container.clientHeight;

		return () => ro.disconnect();
	});

	function formatNum(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
		return String(n);
	}

	const LANG_COLORS: Record<string, string> = {
		TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Rust: '#dea584',
		Go: '#00ADD8', Ruby: '#701516', Java: '#b07219', 'C++': '#f34b7d', C: '#555555',
		Swift: '#F05138', Kotlin: '#A97BFF', Shell: '#89e051', Zig: '#ec915c',
	};
</script>

<div bind:this={container} class="relative w-full h-full select-none">
	<!-- Background: deep space with subtle grid -->
	<div class="absolute inset-0" style="background: radial-gradient(ellipse at 40% 50%, #0d1530 0%, #050810 70%);"></div>

	<!-- Tiny background stars (CSS) -->
	<div class="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
		{#each { length: 120 } as _, i}
			<div
				class="absolute rounded-full bg-white"
				style="
					width: {Math.random() * 1.5 + 0.5}px;
					height: {Math.random() * 1.5 + 0.5}px;
					left: {Math.random() * 100}%;
					top: {Math.random() * 100}%;
					opacity: {Math.random() * 0.35 + 0.05};
				"
			></div>
		{/each}
	</div>

	<!-- D3 SVG -->
	<svg
		bind:this={svgEl}
		{width}
		{height}
		class="absolute inset-0"
		style="cursor: grab;"
	></svg>

	<!-- Tooltip -->
	{#if hoveredStar}
		{@const clusterColor = CLUSTER_COLORS[hoveredStar.cluster] ?? '#8b949e'}
		<div
			class="absolute z-30 pointer-events-none"
			style="
				left: {Math.min(tooltipX + 14, width - 280)}px;
				{tooltipAbove ? `bottom: ${height - tooltipY + 14}px` : `top: ${tooltipY + 14}px`};
			"
		>
			<div
				class="rounded-xl border p-3 shadow-2xl w-64"
				style="background: rgba(7,11,20,0.97); border-color: {clusterColor}40; backdrop-filter: blur(12px);"
			>
				<!-- Cluster badge -->
				<div class="mb-2">
					<span class="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full"
						style="background: {clusterColor}20; border: 1px solid {clusterColor}50; color: {clusterColor};">
						<span class="w-1.5 h-1.5 rounded-full" style="background: {clusterColor}; box-shadow: 0 0 4px {clusterColor};"></span>
						{hoveredStar.clusterLabel}
					</span>
				</div>

				<div class="flex items-start gap-2 mb-1.5">
					<img src={hoveredStar.owner_avatar} alt={hoveredStar.owner_login} class="w-5 h-5 rounded-full mt-0.5 shrink-0" />
					<div class="min-w-0">
						<p class="text-xs truncate" style="color: #7d8590;">{hoveredStar.owner_login}</p>
						<p class="text-sm font-semibold truncate" style="color: #e6edf3;">{hoveredStar.name}</p>
					</div>
				</div>

				{#if hoveredStar.description}
					<p class="text-xs leading-relaxed mb-2 line-clamp-2" style="color: #7d8590;">{hoveredStar.description}</p>
				{/if}

				<div class="flex items-center gap-3 text-xs" style="color: #7d8590;">
					{#if hoveredStar.language}
						<span class="flex items-center gap-1">
							<span class="w-2 h-2 rounded-full" style="background: {LANG_COLORS[hoveredStar.language] ?? '#8b949e'};"></span>
							{hoveredStar.language}
						</span>
					{/if}
					<span style="color: #f0b429;">★ {formatNum(hoveredStar.stars_count)}</span>
					{#if hoveredStar.forks_count > 0}
						<span>⑂ {formatNum(hoveredStar.forks_count)}</span>
					{/if}
				</div>

				{#if hoveredStar.topics.length > 0}
					<div class="flex flex-wrap gap-1 mt-2">
						{#each hoveredStar.topics.slice(0, 4) as t}
							<span class="text-xs px-1.5 py-0.5 rounded-full" style="background: #ffffff08; color: #7d8590;">{t}</span>
						{/each}
					</div>
				{/if}

				<p class="text-xs mt-2 pt-2 border-t" style="color: #3d444d; border-color: #21262d;">Click to open ↗</p>
			</div>
		</div>
	{/if}

	<!-- Demo overlay -->
	{#if isDemo}
		<div
			class="absolute inset-0 flex items-center justify-center pointer-events-none"
			style="background: radial-gradient(ellipse at center, transparent 40%, #050810 100%);"
		></div>
	{/if}
</div>
