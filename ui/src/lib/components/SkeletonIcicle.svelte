<script lang="ts">
	// Placeholder shown in the chart area while a scan runs, instead of a blocking
	// splash. Rows of shimmer blocks that subdivide downward, evoking the icicle
	// shape. Live phase/progress lives in the status bar. (Stage B replaces this
	// with the real shape streamed from the scan.)
	import { Skeleton } from '$lib/components/ui/skeleton';

	let { class: className = '' }: { class?: string } = $props();

	// Flex-grow weights per row — top wide, progressively subdivided, to read as a tree.
	const rows: number[][] = [
		[1],
		[0.42, 0.33, 0.25],
		[0.22, 0.18, 0.14, 0.26, 0.2],
		[0.12, 0.1, 0.08, 0.14, 0.1, 0.11, 0.15, 0.2]
	];
</script>

<div class="w-full px-4 pt-1 {className}">
	<div class="flex flex-col gap-1">
		{#each rows as row, i}
			<div class="flex gap-1" style="height: 28px;">
				{#each row as weight, j}
					<Skeleton
						class="h-full rounded-sm"
						style="flex: {weight}; animation-delay: {i * 120 + j * 50}ms;"
					/>
				{/each}
			</div>
		{/each}
	</div>
</div>
