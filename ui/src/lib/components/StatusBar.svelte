<script lang="ts">
	// Persistent bottom status bar: one glanceable line for what the system is
	// doing — scan phase/progress, scan failure, or the post-scan stats — with a
	// transient enrichment save status overlaid on top. Driven by real state/acks.
	import {
		activeScan,
		enrichmentSaveStatus,
		isDiscovering,
		resumeScanningScan,
		requestPauseScanningScan,
		aiMode,
		localModel
	} from '$lib/stores';
	// AI status view-models (see $lib/llm-describe): `aiCellState` is the status-cell glyph,
	// `aiMeter` the backend-aware meter model.
	import { aiCellState, aiMeter, llmBackend, llmEngineInfo } from '$lib/llm-describe';
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
		PlayIcon,
		ShieldCheckIcon,
		GlobeIcon,
		GlobeXIcon,
		LoaderPinwheelIcon,
		ServerCrashIcon,
		GpuIcon
	} from '@lucide/svelte';
	import SkippedLink from './SkippedLink.svelte';

	// Privacy provenance for the whole session. The scan + all analysis is on-device; the LLM
	// summary is the one thing that leaves the machine — and only when the provider is External.
	// So the chip is mode-aware: it never claims "nothing leaves" while External is selected.
	let external = $derived($aiMode === 'external');

	// On-device cell tooltip (Tier-1 engine info): model + resolved backend once known, or the
	// unavailable reason. Falls back to the plain privacy line before the backend has resolved so
	// it never claims a guessed engine.
	let engineWord = $derived($llmBackend === 'gpu' ? 'GPU' : $llmBackend === 'cpu' ? 'CPU' : null);
	// Tier-2 device detail appended to the tooltip once node-llama-cpp reports it: the real GPU
	// name + total VRAM on a GPU backend, or the CPU core count on CPU. Empty until known.
	let engineDetail = $derived.by(() => {
		const e = $llmEngineInfo;
		if ($llmBackend === 'gpu' && e.gpuName) {
			return e.vramTotalMb
				? ` (${e.gpuName}, ${(e.vramTotalMb / 1024).toFixed(1)} GB)`
				: ` (${e.gpuName})`;
		}
		if ($llmBackend === 'cpu' && e.cpuCount) return ` (${e.cpuCount} cores)`;
		return '';
	});
	let aiCellTitle = $derived(
		$aiCellState === 'crash'
			? $_('status.aiUnavailableHint')
			: engineWord
				? $_('status.aiOnDeviceHint', { values: { model: $localModel, engine: engineWord } }) +
					engineDetail
				: $_('status.privacyOnDeviceHint')
	);
	// Stable locals so the template can narrow the discriminated unions (each bare `$store` is a
	// fresh get() TS can't narrow across; a $derived binding is one stable reference).
	let cell = $derived($aiCellState);
	let meter = $derived($aiMeter);

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

	// The broken-units ledger. Severity escalates the segment's tone (grey→amber) when a whole
	// location failed or a large fraction was skipped.
	let skipped = $derived(scan?.scanResult?.skipped);
	let severeSkips = $derived(
		!!skipped &&
			skipped.total > 0 &&
			((skipped.byReason['location-unavailable'] ?? 0) > 0 ||
				skipped.total > Math.max(20, fileCount * 0.05))
	);

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
		{#if skipped && skipped.total > 0}
			<span class="text-[8px] opacity-40">{sep}</span>
			<SkippedLink {skipped} severe={severeSkips} />
		{/if}
	{/if}

	<!-- Right side: live scan telemetry (owner mode, while scanning) + the persistent privacy
	     chip. Grouped so the privacy chip stays pinned right in every state. -->
	<div class="ml-auto flex items-center gap-2">
		<!-- `scan` is the scan governor's draw; `gpu`/`cpu` is a generating model's own. The scan and
		     cpu branches render identically, so the kind is the only thing telling them apart. -->
		{#if meter.kind === 'scan'}
			<span class="flex items-center gap-1.5 whitespace-nowrap tabular-nums">
				<CpuIcon class="h-3 w-3" />
				<span>{meter.cpuPct}%</span>
				<span class="text-[8px] opacity-40">{sep}</span>
				<span>{(meter.memUsedMb / 1024).toFixed(1)} GB</span>
				{#if meter.budget < 1}
					<span class="text-[8px] opacity-40">{sep}</span>
					<span class="text-[var(--color-warning,#d97706)]"
						>{$_('status.throttled')} {Math.round(meter.budget * 100)}%</span
					>
				{/if}
			</span>
			<span class="text-[8px] opacity-40">{sep}</span>
		{:else if meter.kind === 'gpu'}
			<!-- VRAM occupancy, not a compute %: node-llama-cpp exposes no GPU-utilisation figure. -->
			<span class="flex items-center gap-1.5 whitespace-nowrap tabular-nums">
				<GpuIcon class="h-3 w-3" />
				<span>{(meter.usedMb / 1024).toFixed(1)}/{(meter.totalMb / 1024).toFixed(1)} GB</span>
			</span>
			<span class="text-[8px] opacity-40">{sep}</span>
		{:else if meter.kind === 'cpu'}
			<span class="flex items-center gap-1.5 whitespace-nowrap tabular-nums">
				<CpuIcon class="h-3 w-3" />
				<span>{meter.cpuPct}%</span>
				<span class="text-[8px] opacity-40">{sep}</span>
				<span>{(meter.memUsedMb / 1024).toFixed(1)} GB</span>
			</span>
			<span class="text-[8px] opacity-40">{sep}</span>
		{/if}
		<!-- One cell carries provider identity + live engine status. On the on-device cell the
		     tooltip adds the model and backend; the external one only states where data goes. -->
		{#if external}
			<span
				class="flex items-center gap-1.5 whitespace-nowrap {cell === 'globe-x'
					? 'text-destructive'
					: ''}"
				title={$_(cell === 'globe-x' ? 'status.aiExternalDownHint' : 'status.privacyExternalHint')}
			>
				{#if cell === 'globe-x'}
					<GlobeXIcon class="h-3 w-3" />
				{:else}
					<GlobeIcon class="h-3 w-3 {cell === 'globe-pulse' ? 'animate-pulse' : ''}" />
				{/if}
				<span>{$_('status.privacyExternal')}</span>
			</span>
		{:else}
			<span
				class="flex items-center gap-1.5 whitespace-nowrap {cell === 'crash' ? 'text-destructive' : ''}"
				title={aiCellTitle}
			>
				{#if cell === 'crash'}
					<ServerCrashIcon class="h-3 w-3" />
				{:else if cell === 'pinwheel'}
					<LoaderPinwheelIcon class="h-3 w-3 animate-spin" />
				{:else}
					<ShieldCheckIcon class="h-3 w-3" />
				{/if}
				<span>{$_('status.privacyOnDevice')}</span>
			</span>
		{/if}
	</div>
</div>
