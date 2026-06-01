<script lang="ts">
	import { derived } from 'svelte/store';
	import { activeScan } from '$lib/stores';
	import { jobsStore } from '$lib/jobs';
	import JobItem from './JobItem.svelte';
	import { ChevronDownIcon, ChevronUpIcon } from '@lucide/svelte';

	let collapsed = $state(false);

	let scanTabId = $derived($activeScan?.id ?? '');
	let showPanel = $derived($activeScan?.state === 'complete');

	let jobs = $derived.by(() => {
		const tabId = scanTabId;
		return derived(jobsStore, ($jobs) =>
			Object.values($jobs).filter((j) => j.scanTabId === tabId && !j.dismissed && j.type !== 'scan')
		);
	});

	let hasJobs = $derived($jobs.length > 0);
	let activeCount = $derived(
		$jobs.filter((j) => j.status === 'running' || j.status === 'paused').length
	);
</script>

{#if showPanel && hasJobs}
	<div
		class="fixed bottom-4 right-4 z-[100] overflow-hidden rounded-[10px] border border-white/[0.12] bg-card/95 shadow-2xl backdrop-blur-xl transition-[width] {collapsed
			? 'w-[220px]'
			: 'w-[280px]'}"
	>
		<button
			class="flex w-full cursor-pointer items-center justify-between border-none bg-transparent px-3 py-2.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/5"
			onclick={() => (collapsed = !collapsed)}
		>
			<span class="flex items-center gap-1.5">
				Background Jobs
				{#if activeCount > 0}
					<span
						class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-500/80 px-[5px] text-[10px] font-bold text-white"
					>
						{activeCount}
					</span>
				{/if}
			</span>
			{#if collapsed}
				<ChevronUpIcon size={14} />
			{:else}
				<ChevronDownIcon size={14} />
			{/if}
		</button>

		{#if !collapsed}
			<div class="flex max-h-80 flex-col gap-1 overflow-y-auto px-2 pb-2 pt-1">
				{#each $jobs as job (job.id)}
					<JobItem {job} />
				{/each}
			</div>
		{/if}
	</div>
{/if}
