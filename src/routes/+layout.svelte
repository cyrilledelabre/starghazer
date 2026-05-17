<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<svelte:head>
	<title>stargħazer</title>
	<meta name="description" content="Semantic search for your GitHub stars. Runs entirely in your browser." />
</svelte:head>

{@render children()}
