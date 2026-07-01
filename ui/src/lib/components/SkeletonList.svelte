<script lang="ts">
	// Placeholder for the Tree/Flat lenses while their files load, instead of a spinner —
	// a column of shimmer rows (icon · name · size) that reads as a file list taking shape.
	// Staggered so it ripples top-to-bottom rather than blinking as one block.
	import { Skeleton } from '$lib/components/ui/skeleton';

	let { rows = 9, class: className = '' }: { rows?: number; class?: string } = $props();

	// Varied name widths so it looks like content, not a progress bar.
	const widths = ['w-1/2', 'w-2/3', 'w-1/3', 'w-3/5', 'w-2/5', 'w-3/4', 'w-1/2', 'w-2/5', 'w-3/5'];
</script>

<div class="flex flex-1 flex-col gap-0.5 overflow-hidden p-2 {className}">
	{#each Array.from({ length: rows }, (_, i) => i) as i (i)}
		<div class="flex items-center gap-2 px-2 py-1.5">
			<Skeleton class="h-4 w-4 shrink-0 rounded-sm" style="animation-delay: {i * 70}ms;" />
			<Skeleton class="h-3.5 {widths[i % widths.length]} rounded" style="animation-delay: {i * 70}ms;" />
			<Skeleton class="ml-auto h-3.5 w-12 rounded" style="animation-delay: {i * 70}ms;" />
		</div>
	{/each}
</div>
