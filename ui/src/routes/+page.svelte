<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import {
		activeScan,
		scansStore,
		cliVersion,
		healthStatus,
		addTerminalLineToScan,
		parseScanOutputForScan,
		startScanningScan,
		finishScanningScan,
		pauseScanningScan,
		resumeScanningScan,
		setErrorForScan,
		resetScan,
		viewMode,
		selectedItem,
		hoveredItem,
		clearSelectedItem,
		selectDirectory,
		hydrateTagDictionary,
		enrichmentInvalidation,
		activeProvisionalTree,
		setProvisionalTree,
		clearProvisionalTree,
		resourceStats
	} from '$lib/stores';
	import {
		healthCheck,
		getVersion,
		scanDirectory,
		onJobUpdate,
		generateId,
		startQuerySession,
		stopQuerySession,
		queryTree,
		queryStats,
		getEnrichment,
		sendQuery,
		setActiveQueryDb,
		formatBytes,
		useOwnerDb,
		type TreeData,
		type ScanStats
	} from '$lib/tauri';
	import { jobsStore } from '$lib/jobs';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import DropZone from '$lib/components/DropZone.svelte';
	import SkeletonIcicle from '$lib/components/SkeletonIcicle.svelte';
	import StalactiteChart from '$lib/components/StalactiteChart.svelte';
	import FileTable from '$lib/components/FileTable.svelte';
	import TreeView from '$lib/components/TreeView.svelte';
	import FileDetailsPanel from '$lib/components/FileDetailsPanel.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { LoaderCircle, CircleAlert, RefreshCw, Plus } from '@lucide/svelte';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	// ================================
	// State
	// ================================

	let unlisteners: UnlistenFn[] = [];
	let isInitialized = $state(false);
	let initError = $state<string | null>(null);

	// Visualization state
	let treeData = $state<TreeData | null>(null);
	let statsData = $state<ScanStats | null>(null);
	// Scanned root's display name (basename), used as the leading panel breadcrumb.
	let rootDisplayName = $derived(
		treeData?.root ? (treeData.root.split(/[/\\]/).filter(Boolean).pop() ?? treeData.root) : ''
	);
	// During a scan there's no queried tree yet, so the root name comes from the
	// path being scanned.
	let scanRootName = $derived(
		$activeScan?.path
			? ($activeScan.path.split(/[/\\]/).filter(Boolean).pop() ?? $activeScan.path)
			: ''
	);
	let isLoadingVisualization = $state(false);
	let visualizationError = $state<string | null>(null);

	// ================================
	// Initialization
	// ================================

	onMount(async () => {
		try {
			// Single job-update listener handles scan, checksum, and export events
			unlisteners.push(
				await onJobUpdate((event) => {
					const { jobId, line } = event;

					// Forward to jobs store for all job types
					// For scan jobs, route to the owning scan tab
					const scan = scansStore.findScanByJobId(jobId);
					const scanTabId = scan?.id ?? jobId;
					jobsStore.upsertFromEvent(line, scanTabId);

					// Scan-specific handling
					if (scan) {
						// Parse progress into scan result fields
						parseScanOutputForScan(scan.id, line);

						// Handle terminal output for non-JSON lines (summary text)
						let parsed: Record<string, unknown> | null = null;
						try { parsed = JSON.parse(line); } catch { /* raw text */ }

						if (!parsed) {
							// Raw text from summary() — show in terminal
							addTerminalLineToScan(scan.id, line, 'stdout');
						}

						// Live directory tree → grow the provisional icicle during the scan
						if (parsed?.event === 'scan:tree' && Array.isArray(parsed.directories)) {
							setProvisionalTree(scan.id, parsed.directories as Parameters<typeof setProvisionalTree>[1]);
						} else if (parsed?.event === 'resource') {
							// Live CPU/mem telemetry from the single-owner session (owner mode).
							resourceStats.set(parsed as unknown as Parameters<typeof resourceStats.set>[0]);
						}

						// Handle scan completion via job:complete
						if (parsed?.event === 'job:complete') {
							addTerminalLineToScan(scan.id, '✓ Scan completed successfully', 'success');
							clearProvisionalTree(scan.id); // real DB-backed tree takes over
							finishScanningScan(scan.id, true);
							if (scan.id === $activeScan?.id) {
								loadVisualizationData(scan.dbName, scan.id);
							}
						}

						// Handle scan error via job:error
						if (parsed?.event === 'job:error') {
							const msg = (parsed.error as string) ?? 'Scan failed';
							addTerminalLineToScan(scan.id, `✗ ${msg}`, 'error');
							clearProvisionalTree(scan.id);
							finishScanningScan(scan.id, false);
						}

						// Scan paused (user pressed Pause, or cancel): keep the partial data and
						// the frozen tree so it stays browseable; the status bar offers Continue.
						if (parsed?.event === 'job:paused') {
							addTerminalLineToScan(scan.id, '⏸ Scan paused', 'stdout');
							pauseScanningScan(scan.id);
						}
					}
				})
			);

			// Check CLI health
			const health = await healthCheck();
			healthStatus.set(health.success ? 'healthy' : 'unhealthy');

			if (!health.success) {
				initError =
					'CLI binary not found or unhealthy. Please ensure archifiltre is properly installed.';
				return;
			}

			// Get version
			const version = await getVersion();
			if (version.success) {
				cliVersion.set(version.output.trim());
			}

			isInitialized = true;

			unsubscribeActiveScan = activeScan.subscribe((scan) => {
				if (!scan) return;

				// Reset transient view state once per scan id — NOT on every progress
				// update. activeScan changes on every streamed file count, so guarding
				// this on a viz-load flag (only set on completion) made it re-run — and
				// re-clear the selection — continuously during a scan, remounting the
				// details panel and making its content blink. Track the reset separately.
				//
				// Do NOT null treeData here: it's only rendered for a COMPLETED tab (the
				// scanning branch uses scanningTree), and it's restored below from the
				// settled cache. Nulling it left a completed tab blank when ANOTHER tab
				// was mid-scan — the old reload guard stayed pinned and skipped the reload.
				if (resetForScanId !== scan.id) {
					resetForScanId = scan.id;
					visualizationError = null;
					isLoadingVisualization = false;
					clearSelectedItem();
				}

				// A (re)scan invalidates this tab's settled tree — drop it so completion
				// reloads fresh instead of flashing the previous run from cache.
				if (scan.state === 'scanning' && shownScanId === scan.id) {
					shownScanId = null;
					settledTreeCache.delete(scan.dbName);
				}

				// Make the completed tab's OWN tree the one on screen. loadVisualizationData
				// paints from the settled cache instantly when present, so switching back is
				// instant and never blank; skipped when its tree is already shown (no storm).
				// 'paused' is browseable like 'complete' — load its partial tree from the DB.
				if ((scan.state === 'complete' || scan.state === 'paused') && shownScanId !== scan.id) {
					loadVisualizationData(scan.dbName, scan.id);
				}
			});
		} catch (error) {
			initError = `Failed to initialize: ${error}`;
			healthStatus.set('unhealthy');
		}
	});

	onDestroy(async () => {
		// Cleanup event listeners
		for (const unlisten of unlisteners) {
			unlisten();
		}
		// Stop any active query session
		try {
			await stopQuerySession();
		} catch {
			// Ignore errors on cleanup
		}
	});

	// Track which scan we've loaded visualization for (guards stale async within a load)
	let loadedForScanId: string | null = null;
	// Which scan's tree is CURRENTLY in treeData / on screen. Distinct from
	// loadedForScanId: set only once treeData is actually populated, and it's what the
	// switch handler checks to decide whether a completed tab needs (re)loading — so
	// switching away to a scanning tab and back restores the tree instead of going blank.
	// $state so deriveds/effects (status-bar stats, root auto-open) react to it.
	let shownScanId = $state<string | null>(null);
	// Track which scan we've already reset transient view state for (once per scan id)
	let resetForScanId: string | null = null;

	// Bounded cache of SETTLED scans' trees, keyed by db, so switching back to a
	// completed tab paints instantly (no "Loading visualization…" flash) instead of
	// re-fetching. Safe because a completed scan's tree doesn't change; invalidated when
	// a new scan starts on that db. Only the aggregate tree is held (a few MB for a huge
	// scan), capped to the few most-recently-viewed tabs — not the v4 all-in-JS problem.
	const SETTLED_CACHE_CAP = 5;
	const settledTreeCache = new Map<string, { tree: TreeData; stats: ScanStats | null }>();
	function cacheSettledTree(dbName: string, tree: TreeData, stats: ScanStats | null) {
		settledTreeCache.delete(dbName); // re-insert at the end (LRU ordering)
		settledTreeCache.set(dbName, { tree, stats });
		while (settledTreeCache.size > SETTLED_CACHE_CAP) {
			const oldest = settledTreeCache.keys().next().value;
			if (oldest === undefined) break;
			settledTreeCache.delete(oldest);
		}
	}

	// Subscribe to activeScan changes to handle sidebar clicks
	let unsubscribeActiveScan: (() => void) | null = null;

	onDestroy(() => {
		unsubscribeActiveScan?.();
	});

	// ================================
	// Visualization Loading
	// ================================

	async function loadVisualizationData(dbName: string, scanId: string) {
		// Mark this scan as the one we're loading for
		loadedForScanId = scanId;
		visualizationError = null;

		// Instant paint: if we've seen this settled scan before, show its cached tree
		// immediately and refresh in the background — no flash on tab switch. Otherwise
		// show the loading state and fetch fresh.
		const cached = settledTreeCache.get(dbName);
		if (cached) {
			treeData = cached.tree;
			statsData = cached.stats;
			shownScanId = scanId;
			isLoadingVisualization = false;
			selectRoot();
		} else {
			isLoadingVisualization = true;
			treeData = null;
			statsData = null;
		}

		try {
			// Start query session for this database
			await startQuerySession(dbName);

			// Fetch tree and stats in parallel. Pass dbName EXPLICITLY: while another tab
			// is scanning, the shared activeQueryDb pointer may be pointing elsewhere, and
			// an unqualified query would read the wrong owner (blank tree on the switched-to
			// completed tab). The db is fixed for this load regardless of the active pointer.
			const [tree, stats] = await Promise.all([queryTree(dbName), queryStats(dbName)]);

			// Hydrate the tag dictionary for this scan (the only enrichment state
			// kept client-side — see "PGlite is the CENTER"). Per-element enrichment
			// is read on demand via joins / query-on-select, not cached here.
			getEnrichment(dbName).then((data) => {
				if (data && loadedForScanId === scanId) {
					hydrateTagDictionary(data.tags);
				}
			});

			// Only update if we're still loading for this scan
			if (loadedForScanId === scanId) {
				if (tree) {
					treeData = tree;
					shownScanId = scanId;
					// Only cache a non-degenerate tree, so a transient empty read can never
					// poison the cache and keep a completed tab blank on later switches.
					if (tree.directories?.length) cacheSettledTree(dbName, tree, stats ?? null);
				} else if (!cached) {
					visualizationError = 'Failed to load file tree';
				}

				if (stats) {
					statsData = stats;
				}

				// Open the root folder in the details panel by default (skip if the cache
				// already selected it, to avoid clobbering a selection the user just made).
				if (!cached) selectRoot();
			}
		} catch (error) {
			if (loadedForScanId === scanId && !cached) {
				visualizationError = `Failed to load visualization: ${error}`;
				console.error('Visualization loading error:', error);
			}
		} finally {
			if (loadedForScanId === scanId) {
				isLoadingVisualization = false;
			}
		}
	}

	// Select the scanned root folder: the empty relative path (parent of every
	// top-level entry), with whole-scan totals from the stats. Used both as the
	// default selection on load and when the chart's root label is clicked.
	function selectRoot() {
		const tree = treeData;
		const stats = statsData;
		if (!tree || !stats) return;
		const rootName = (tree.root ?? '').split(/[/\\]/).filter(Boolean).pop() ?? 'Root';
		selectDirectory({
			path: '',
			name: rootName,
			total_size: stats.totalPhysicalSize,
			file_count: stats.totalFiles,
			dir_count: tree.directories.length
		});
	}

	// Select the scan root during a live scan: the whole-scan home, with counts
	// pulled from the live scan progress (the DB isn't readable yet). The panel
	// keeps these live and skeletons everything that needs a query.
	function selectScanningRoot() {
		const sr = $activeScan?.scanResult;
		selectDirectory({
			path: '',
			name: scanRootName,
			total_size: sr?.totalSize ?? 0,
			file_count: sr?.filesDiscovered ?? 0,
			dir_count: sr?.folders ?? 0
		});
	}

	// Owner mode runs one owner PROCESS per db (concurrent scans/tabs), so queries must
	// target the active scan's db. Keep that pointer synced as the active scan changes
	// (covers switching to a still-scanning tab, which doesn't go through loadViz).
	$effect(() => {
		if (useOwnerDb() && $activeScan?.dbName) setActiveQueryDb($activeScan.dbName);
	});

	// STABLE deriveds (NOT $activeScan directly — that's a new object every progress
	// tick): ownerScanning flips only on the scanning transition; activeScanDb changes
	// only on tab switch. Depending on these keeps the poll effect from re-running many
	// times/sec and tearing down each in-flight poll before it returns.
	let ownerScanning = $derived(useOwnerDb() && $activeScan?.state === 'scanning');
	let activeScanDb = $derived($activeScan?.dbName);

	// The live scan tree. Owner mode reads it straight from the DB (dir_stats is
	// maintained incrementally per batch) by polling get_tree — nothing is retained
	// in JS. Legacy mode (no safe live DB read) still uses the JS provisional stream.
	let liveTree = $state<Awaited<ReturnType<typeof queryTree>>>(null);
	// Which db `liveTree` was fetched for. The poll round-trip can take seconds during a
	// heavy scan, so on a tab switch we must NOT keep painting the previous tab's tree —
	// gate on this so a mismatched live tree falls back to a skeleton instead of showing
	// the wrong graph for 1–3 s.
	let liveTreeDb = $state<string | undefined>(undefined);
	let scanningTree = $derived(
		useOwnerDb() ? (liveTreeDb === activeScanDb ? liveTree : null) : $activeProvisionalTree
	);

	// Poll get_tree for the ACTIVE scanning tab. Guards against stale results: a poll
	// that was in flight for a tab we've since left (or that has finished) is DISCARDED,
	// so switching between two live scans never blinks the previous tab's graph in.
	async function pollLiveTree() {
		const before = get(activeScan);
		if (!useOwnerDb() || before?.state !== 'scanning' || !before?.dbName) return;
		const targetDb = before.dbName;
		try {
			// Target this db's owner EXPLICITLY — the shared pointer may be on another tab.
			const res = await sendQuery({ id: `live_tree_${Date.now()}`, action: 'get_tree' }, targetDb);
			const now = get(activeScan);
			// Apply only if we're STILL on this same scanning tab.
			if (res.ok && res.data && now?.dbName === targetDb && now?.state === 'scanning') {
				liveTree = res.data as TreeData;
				liveTreeDb = targetDb;
			}
		} catch {
			/* transient (session busy mid-batch) — next tick retries */
		}
	}

	// Run the poll: an IMMEDIATE fetch on scan-start AND on tab switch (so the chart
	// updates in ~one round-trip, not up to 750 ms), then a steady interval. Re-runs on
	// activeScanDb (switch) / ownerScanning (transition) — both stable, never per-tick.
	// scanningTree gates on liveTreeDb===activeScanDb, so until the first poll for the
	// switched-to tab lands the chart shows a skeleton, never the previous tab's graph.
	$effect(() => {
		const db = activeScanDb; // re-run on tab switch
		if (!ownerScanning || !db) {
			liveTree = null;
			liveTreeDb = undefined;
			return;
		}
		void pollLiveTree();
		const iv = setInterval(pollLiveTree, 750);
		return () => clearInterval(iv);
	});

	// Keep a panel open throughout a scan so there's never an empty void: as soon
	// as the scan tree exists and nothing is selected, open the root panel.
	// Once the user picks a folder this stands down; clearing the selection re-opens
	// root. (On completion the complete-state branch re-selects the real root.)
	$effect(() => {
		if ($activeScan?.state === 'scanning' && scanningTree && !$selectedItem) {
			selectScanningRoot();
		}
	});

	// Same for a completed tab: keep the root panel open by default whenever this tab's
	// own tree is on screen and nothing is selected. Covers the switch-back case where
	// the tree is restored without re-running loadVisualizationData (which would have
	// re-selected root) — without this the graph showed but the panel stayed empty. The
	// !$selectedItem guard means it stands down once the user picks a folder.
	$effect(() => {
		if (
			($activeScan?.state === 'complete' || $activeScan?.state === 'paused') &&
			shownScanId === $activeScan.id &&
			treeData &&
			statsData &&
			!$selectedItem
		) {
			selectRoot();
		}
	});

	// Re-query the tree when enrichment changes so directory bands and the
	// deletion cascade update live. The flat tree is one cheap query; the chart
	// refreshes its own (lazily loaded) file rows. Depends only on the signal.
	$effect(() => {
		if (!$enrichmentInvalidation) return;
		const scan = get(activeScan);
		const db = scan?.dbName;
		const id = scan?.id;
		queryTree(db).then((tree) => {
			// Apply only if we're still on the same tab (db queried explicitly so a
			// concurrent scan's pointer can't misroute this into the wrong tree).
			if (tree && get(activeScan)?.id === id) treeData = tree;
		});
	});

	// ================================
	// Actions
	// ================================

	async function handleStartAnalysis(path: string): Promise<void> {
		const scan = $activeScan;
		if (!scan) return;

		// Prevent starting another scan if already scanning
		if (scan.state === 'scanning') {
			setErrorForScan(scan.id, 'This scan is already running. Please wait or start a new scan.');
			return;
		}

		// Clear previous visualization data
		treeData = null;
		statsData = null;
		visualizationError = null;
		clearSelectedItem(); // drop a stale selection so the scan auto-opens root
		clearProvisionalTree(scan.id); // drop any stale live-scan tree

		// Generate job ID used for both event routing and job protocol
		const jobId = generateId();

		// Start scanning - this updates the scan state (scanId = jobId for routing)
		startScanningScan(scan.id, path, jobId);

		try {
			const result = await scanDirectory({
				scanId: jobId,
				jobId,
				dbName: scan.dbName,
				path,
				includeHidden: scan.scanOptions.includeHidden,
				batchSize: scan.scanOptions.batchSize,
				disableArchives: scan.scanOptions.disableArchives
			});

			if (!result.success) {
				setErrorForScan(
					scan.id,
					result.error ?? 'Analysis failed. Please check the folder and try again.'
				);
			}
		} catch (error) {
			setErrorForScan(scan.id, `Analysis error: ${error}`);
		}
	}

	async function handleReset(): Promise<void> {
		const scan = $activeScan;
		if (scan) {
			// Stop query session
			try {
				await stopQuerySession();
			} catch {
				// Ignore errors
			}
			// Clear visualization data
			treeData = null;
			statsData = null;
			visualizationError = null;
			// Clear selected item
			clearSelectedItem();
			// Reset the scan
			resetScan(scan.id);
		}
	}

	function handleNewScan(): void {
		scansStore.addScan();
	}

	// ================================
	// Computed values for status bar
	// ================================

	// treeData/statsData persist across tab switches (so a completed tab's graph isn't
	// nulled while another tab scans). Only treat statsData as the active tab's when it
	// actually belongs to it — otherwise the status bar would show a previously-viewed
	// completed tab's totals over a live scan. Scanning/other tabs fall back to scanResult.
	let activeStats = $derived(shownScanId === $activeScan?.id ? statsData : null);
	let fileCount = $derived(activeStats?.totalFiles ?? $activeScan?.scanResult.filesDiscovered ?? 0);
	let folderCount = $derived($activeScan?.scanResult.folders ?? 0);
	let duplicateCount = $derived(
		activeStats?.duplicateFiles ?? $activeScan?.scanResult.duplicateFiles ?? 0
	);
	let totalSize = $derived(activeStats?.totalPhysicalSize ?? $activeScan?.scanResult.totalSize ?? 0);
</script>

<!-- Main Container -->
<div class="flex h-full flex-col">
	<!-- Content area: fills the space above the persistent status bar -->
	<div class="flex min-h-0 flex-1 flex-col">
	{#if !isInitialized && !initError}
		<!-- Loading State -->
		<div class="flex h-full items-center justify-center">
			<div class="flex flex-col items-center gap-4">
				<LoaderCircle size={40} class="animate-spin text-primary" />
				<p class="text-muted-foreground">Initializing Archifiltre...</p>
			</div>
		</div>
	{:else if initError}
		<!-- Init Error State -->
		<div class="flex h-full items-center justify-center p-8">
			<Alert variant="destructive" class="max-w-lg">
				<AlertTitle>Initialization Failed</AlertTitle>
				<AlertDescription>{initError}</AlertDescription>
			</Alert>
		</div>
	{:else if $activeScan?.state === 'idle'}
		<!-- Drop Zone State (Selecting a Folder) -->
		<div class="flex h-full items-center justify-center p-8">
			<DropZone onStartAnalysis={handleStartAnalysis} disabled={false} class="max-w-3xl" />
		</div>
	{:else if $activeScan?.state === 'scanning'}
		<!-- Scanning: the icicle grows live from streamed directory aggregates and is
		     navigable as it builds; an always-present details panel (auto-opened on the
		     scan root) fills the bottom so there's never an empty void. The panel shows
		     the stream-known fields (size/counts, live) and skeletons everything that
		     needs the DB until completion. Until the first snapshot arrives, a chart-area
		     skeleton stands in (no blocking splash). Progress is in the status bar. -->
		{#if scanningTree}
			<div class="flex h-full flex-col">
				<div
					class="flex min-h-0 flex-col overflow-hidden p-4 pb-0"
					style:flex={$selectedItem || $hoveredItem ? '0 0 38.2%' : '1 1 0%'}
				>
					<StalactiteChart
						data={scanningTree}
						provisional={!useOwnerDb()}
						onGoHome={selectScanningRoot}
						class="h-full w-full"
					/>
				</div>
				{#if $selectedItem || $hoveredItem}
					<!-- Owner mode: the DB is live-readable during the scan, so the panel
					     queries real data instead of skeletons. -->
					<FileDetailsPanel loading={!useOwnerDb()} onGoHome={selectScanningRoot} rootName={scanRootName} />
				{/if}
			</div>
		{:else}
			<SkeletonIcicle class="h-full" />
		{/if}
	{:else if $activeScan?.state === 'complete' || $activeScan?.state === 'paused'}
		<!-- Complete OR paused: both show the (full / partial) visualization from the DB.
		     A paused scan's tree is the frozen partial — browseable, with Continue in the
		     status bar resuming the un-enumerated remainder. -->
		<!-- Analysis Complete State with Visualization -->
		<div class="flex h-full flex-col">
			{#if isLoadingVisualization}
				<!-- Same skeleton as the scanning chart — consistent loading affordance
				     everywhere, never a separate spinner. -->
				<SkeletonIcicle class="h-full" />
			{:else if visualizationError}
				<!-- Visualization error -->
				<div class="flex h-full flex-col items-center justify-center gap-6 p-8">
					<div
						class="flex h-24 w-24 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-500"
					>
						<CircleAlert size={48} />
					</div>
					<Alert variant="destructive" class="max-w-lg">
						<AlertTitle>Visualization Error</AlertTitle>
						<AlertDescription>{visualizationError}</AlertDescription>
					</Alert>
					<div class="flex gap-4">
						<Button
							variant="outline"
							onclick={() =>
								$activeScan && loadVisualizationData($activeScan.dbName, $activeScan.id)}
						>
							<RefreshCw size={16} class="mr-2" />
							Retry
						</Button>
						<Button onclick={handleNewScan}>
							<Plus size={16} class="mr-2" />
							New Scan
						</Button>
					</div>
				</div>
			{:else if treeData}
				<!-- Visualization + details, split top-to-bottom. The chart is the finder,
				     the panel the workspace, so when the panel is open the split follows the
				     golden ratio: chart ~38.2% (top), panel ~61.8% (bottom). With no selection
				     the chart fills the height. -->
				<div
					class="flex min-h-0 flex-col overflow-hidden p-4 pb-0"
					style:flex={$selectedItem || $hoveredItem ? '0 0 38.2%' : '1 1 0%'}
				>
					{#if $viewMode === 'stalactite'}
						<StalactiteChart data={treeData} onGoHome={selectRoot} class="h-full w-full" />
					{:else if $viewMode === 'tree'}
						<TreeView data={treeData} class="h-full w-full" />
					{:else}
						<FileTable data={treeData} class="h-full w-full" />
					{/if}
				</div>

				<!-- File/Folder Details Panel with Picker -->
				{#if $selectedItem || $hoveredItem}
					<FileDetailsPanel onGoHome={selectRoot} rootName={rootDisplayName} />
				{/if}
			{/if}
		</div>
	{:else if $activeScan?.state === 'error'}
		<!-- Error State -->
		<div class="flex h-full flex-col items-center justify-center gap-6 p-8">
			<div
				class="flex h-24 w-24 items-center justify-center rounded-full bg-destructive/20 text-destructive"
			>
				<CircleAlert size={48} />
			</div>
			<Alert variant="destructive" class="max-w-lg">
				<AlertTitle>Analysis Error</AlertTitle>
				<AlertDescription
					>{$activeScan?.errorMessage ??
						'An unknown error occurred during analysis'}</AlertDescription
				>
			</Alert>
			<Button variant="outline" size="lg" onclick={handleReset}>
				<RefreshCw size={20} class="mr-2" />
				Try again
			</Button>
		</div>
	{/if}
	</div>

	{#if isInitialized && !initError}
		<StatusBar {fileCount} {folderCount} {duplicateCount} {totalSize} />
	{/if}
</div>

<style>
	/* Allow visualization children to fill available space */
	:global(.flex-1.flex-col > .h-full) {
		flex: 1;
		min-height: 0;
	}
</style>
