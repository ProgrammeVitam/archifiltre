<script lang="ts">
	// Persistent bottom status bar: one glanceable line for what the system is
	// doing — scan phase/progress, scan failure, or the post-scan stats — with a
	// transient enrichment save status overlaid on top. Driven by real state/acks.
	import {
		activeScan,
		enrichmentSaveStatus,
		isDiscovering,
		resourceStats,
		resumeScanningScan,
		requestPauseScanningScan
	} from '$lib/stores';
	import { smoothFilesDiscovered, smoothFilesHashed } from '$lib/scan-counters';
	import { pauseScan, resumeScan, useOwnerDb } from '$lib/tauri';
	import { _ } from '$lib/i18n';
	import { fmtBytes, fmtNum } from '$lib/format';
	import {
		CheckIcon,
		LoaderCircleIcon,
		CircleAlertIcon,
		CpuIcon,
		PauseIcon,
		PlayIcon
	} from '@lucide/svelte';

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

	const PHASE_KEY: Record<string, string> = {
		discovery: 'status.phaseDiscovering',
		ingestion: 'status.phaseDiscovering',
		prefilter: 'status.phaseAnalyzing',
		hashing: 'status.phaseDuplicates',
		'duplicate-detection': 'status.phaseDuplicates',
		complete: 'status.phaseComplete'
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

	// Pause/Continue go through the owner session (frontier keeps all data, resume
	// re-walks only the remainder). Optimistic state flip for snappiness; job:paused /
	// job:progress reconcile. Only meaningful in owner mode.
	const canControl = $derived(useOwnerDb() && !!scan?.dbName);
	async function onPause() {
		if (!scan?.dbName || scan.pauseRequested) return;
		// Instant feedback via the transient pauseRequested flag ("Pausing…"), NOT an early
		// state flip: 'paused' is browseable, so flipping early fires loadVisualizationData
		// mid-scan and get_stats is refused → a spurious load error. job:paused reconciles
		// the real state (and clears the flag).
		requestPauseScanningScan(scan.id);
		try {
			await pauseScan(scan.dbName);
		} catch {
			requestPauseScanningScan(scan.id, false); // request failed → revert the button
		}
	}
	async function onContinue() {
		if (!scan?.dbName) return;
		resumeScanningScan(scan.id);
		try { await resumeScan(scan.dbName); } catch { /* progress will reconcile */ }
	}
</script>

<!-- Default status content, shared by the plain and the hover-morph (button) variants. -->
{#snippet scanningInfo()}
	<LoaderCircleIcon class="h-3 w-3 animate-spin" />
	<!-- Pulse the phase label (e.g. "Discovering files") while enumeration is live, so the
	     text itself reads as actively changing — only this word, not the counts beside it. -->
	<span class="whitespace-nowrap" class:animate-pulse={$isDiscovering}
		>{$_(PHASE_KEY[scan!.scanPhase] ?? 'status.scanning')}</span
	>
	<span class="text-[8px] opacity-40">{sep}</span>
	<!-- Smoothed odometer over the batched progress events (see scan-counters.ts) -->
	<span class="whitespace-nowrap tabular-nums">{$fmtNum($smoothFilesDiscovered)} {$_('status.files')}</span>
	{#if hashing}
		<span class="text-[8px] opacity-40">{sep}</span>
		<span class="whitespace-nowrap tabular-nums">
			{$fmtNum($smoothFilesHashed)}/{$fmtNum(scan!.scanResult.filesToHash)}
			{$_('status.checksums')} ({hashPct}%)
		</span>
	{/if}
{/snippet}

{#snippet pausedInfo()}
	<PauseIcon class="h-3 w-3 text-[var(--color-warning,#d97706)]" />
	<span class="whitespace-nowrap">{$_('status.paused')}</span>
	<span class="text-[8px] opacity-40">{sep}</span>
	<span class="whitespace-nowrap tabular-nums">{$fmtNum($smoothFilesDiscovered)} {$_('status.filesSoFar')}</span>
{/snippet}

<div
	class="flex h-5.5 shrink-0 items-center gap-1.5 border-t border-border bg-muted px-3 text-[11px] text-muted-foreground"
>
	{#if save.state !== 'idle'}
		<!-- Enrichment save status (transient, takes priority) -->
		{#if save.state === 'saving'}
			<LoaderCircleIcon class="h-3 w-3 animate-spin" />
			<span>{$_('status.saving')}</span>
		{:else if save.state === 'saved'}
			<CheckIcon class="h-3 w-3 text-[var(--color-success)]" />
			<span class="text-[var(--color-success)]">{$_('status.saved')}</span>
		{:else if save.state === 'error'}
			<CircleAlertIcon class="h-3 w-3 text-destructive" />
			<span class="text-destructive">{$_('status.saveError')} {save.field ?? ''}</span>
		{/if}
	{:else if scan?.state === 'scanning'}
		<!-- Scan in progress. Hovering the status morphs it into the Pause action in place
		     (owner mode); otherwise it's plain text. Once Pause is clicked, "Pausing…" shows
		     immediately (pauseRequested) until the session acks with job:paused. -->
		{#if scan.pauseRequested}
			<span class="flex items-center gap-1.5">
				<LoaderCircleIcon class="h-3 w-3 animate-spin text-[var(--color-warning,#d97706)]" />
				<span class="whitespace-nowrap">{$_('status.pausing')}</span>
			</span>
		{:else if canControl}
			<button
				type="button"
				onclick={onPause}
				title={$_('status.pause')}
				class="group relative flex items-center"
			>
				<span class="flex items-center gap-1.5 transition-opacity group-hover:opacity-0">
					{@render scanningInfo()}
				</span>
				<span
					class="absolute inset-0 flex items-center gap-1 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
				>
					<PauseIcon class="h-3 w-3" />
					<span>{$_('status.pause')}</span>
				</span>
			</button>
		{:else}
			<span class="flex items-center gap-1.5">{@render scanningInfo()}</span>
		{/if}
	{:else if scan?.state === 'paused'}
		<!-- Paused: the partial tree stays browseable. Hovering "Paused · N files so far"
		     morphs it into the Continue action in place. -->
		{#if canControl}
			<button
				type="button"
				onclick={onContinue}
				title={$_('status.continue')}
				class="group relative flex items-center"
			>
				<span class="flex items-center gap-1.5 transition-opacity group-hover:opacity-0">
					{@render pausedInfo()}
				</span>
				<span
					class="absolute inset-0 flex items-center gap-1 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
				>
					<PlayIcon class="h-3 w-3" />
					<span>{$_('status.continue')}</span>
				</span>
			</button>
		{:else}
			<span class="flex items-center gap-1.5">{@render pausedInfo()}</span>
		{/if}
	{:else if scan?.state === 'error'}
		<!-- Scan failed -->
		<CircleAlertIcon class="h-3 w-3 text-destructive" />
		<span class="whitespace-nowrap text-destructive">
			{$_('status.scanFailed')}{scan.errorMessage ? `: ${scan.errorMessage}` : ''}
		</span>
	{:else if scan?.state === 'complete'}
		<!-- Completed scan stats -->
		<span class="whitespace-nowrap">{$fmtNum(fileCount)} {$_('status.files')}</span>
		<span class="text-[8px] opacity-40">{sep}</span>
		<span class="whitespace-nowrap">{$fmtNum(folderCount)} {$_('status.folders')}</span>
		<span class="text-[8px] opacity-40">{sep}</span>
		<span class="whitespace-nowrap">{$fmtNum(duplicateCount)} {$_('status.duplicates')}</span>
		<span class="text-[8px] opacity-40">{sep}</span>
		<span class="whitespace-nowrap">{$fmtBytes(totalSize)}</span>
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
					>{$_('status.throttled')} {Math.round($resourceStats.budget * 100)}%</span
				>
			{/if}
		</span>
	{/if}
</div>
