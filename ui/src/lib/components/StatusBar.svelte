<script lang="ts">
	// Persistent bottom status bar: one glanceable line for what the system is
	// doing — scan phase/progress, scan failure, or the post-scan stats — with a
	// transient enrichment save status overlaid on top. Driven by real state/acks.
	import { activeScan, enrichmentSaveStatus, resourceStats } from '$lib/stores';
	import { formatBytes } from '$lib/tauri';
	import { CheckIcon, LoaderCircleIcon, CircleAlertIcon, CpuIcon } from '@lucide/svelte';

	// Completed-scan stats are computed in +page.svelte (it has the query stats),
	// so they're passed in; everything else comes from the stores.
	let {
		fileCount = 0,
		folderCount = 0,
		duplicateCount = 0,
		totalSize = 0
	}: {
		fileCount?: number;
		folderCount?: number;
		duplicateCount?: number;
		totalSize?: number;
	} = $props();

	let scan = $derived($activeScan);
	let save = $derived($enrichmentSaveStatus);

	const PHASE_LABEL: Record<string, string> = {
		discovery: 'Discovering files',
		ingestion: 'Discovering files',
		prefilter: 'Analyzing sizes',
		hashing: 'Finding duplicates',
		'duplicate-detection': 'Finding duplicates',
		complete: 'Complete'
	};

	let hashing = $derived(
		!!scan &&
			(scan.scanPhase === 'hashing' || scan.scanPhase === 'duplicate-detection') &&
			scan.scanResult.filesToHash > 0
	);
	let hashPct = $derived(
		hashing ? Math.round((scan!.scanResult.filesHashed / scan!.scanResult.filesToHash) * 100) : 0
	);

	const sep = '•';
</script>

<div
	class="flex h-5.5 shrink-0 items-center gap-1.5 border-t border-border bg-muted px-3 text-[11px] text-muted-foreground"
>
	{#if save.state !== 'idle'}
		<!-- Enrichment save status (transient, takes priority) -->
		{#if save.state === 'saving'}
			<LoaderCircleIcon class="h-3 w-3 animate-spin" />
			<span>Saving…</span>
		{:else if save.state === 'saved'}
			<CheckIcon class="h-3 w-3 text-[var(--color-success)]" />
			<span class="text-[var(--color-success)]">Saved</span>
		{:else if save.state === 'error'}
			<CircleAlertIcon class="h-3 w-3 text-destructive" />
			<span class="text-destructive">Couldn't save {save.field ?? ''}</span>
		{/if}
	{:else if scan?.state === 'scanning'}
		<!-- Scan in progress -->
		<LoaderCircleIcon class="h-3 w-3 animate-spin" />
		<span class="whitespace-nowrap">{PHASE_LABEL[scan.scanPhase] ?? 'Scanning'}</span>
		<span class="text-[8px] opacity-40">{sep}</span>
		<span class="whitespace-nowrap">{scan.scanResult.filesDiscovered.toLocaleString()} files</span>
		{#if hashing}
			<span class="text-[8px] opacity-40">{sep}</span>
			<span class="whitespace-nowrap">
				{scan.scanResult.filesHashed.toLocaleString()}/{scan.scanResult.filesToHash.toLocaleString()}
				checksums ({hashPct}%)
			</span>
		{/if}
	{:else if scan?.state === 'error'}
		<!-- Scan failed -->
		<CircleAlertIcon class="h-3 w-3 text-destructive" />
		<span class="whitespace-nowrap text-destructive">
			Scan failed{scan.errorMessage ? `: ${scan.errorMessage}` : ''}
		</span>
	{:else if scan?.state === 'complete'}
		<!-- Completed scan stats -->
		<span class="whitespace-nowrap">{fileCount.toLocaleString()} files</span>
		<span class="text-[8px] opacity-40">{sep}</span>
		<span class="whitespace-nowrap">{folderCount.toLocaleString()} folders</span>
		<span class="text-[8px] opacity-40">{sep}</span>
		<span class="whitespace-nowrap">{duplicateCount.toLocaleString()} duplicates</span>
		<span class="text-[8px] opacity-40">{sep}</span>
		<span class="whitespace-nowrap">{formatBytes(totalSize)}</span>
	{/if}

	<!-- Live resource telemetry from the single-owner session (owner mode), right-
	     aligned. Shows the scan's CPU/mem and whether the governor is throttling. -->
	{#if $resourceStats && $resourceStats.scanning}
		<span class="ml-auto flex items-center gap-1.5 whitespace-nowrap tabular-nums">
			<CpuIcon class="h-3 w-3" />
			<span>{$resourceStats.cpuPct}%</span>
			<span class="text-[8px] opacity-40">{sep}</span>
			<span>{$resourceStats.rssMB} MB</span>
			{#if $resourceStats.budget < 1}
				<span class="text-[8px] opacity-40">{sep}</span>
				<span class="text-[var(--color-warning,#d97706)]"
					>throttled {Math.round($resourceStats.budget * 100)}%</span
				>
			{/if}
		</span>
	{/if}
</div>
