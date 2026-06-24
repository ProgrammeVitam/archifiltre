<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		activeScan,
		scansStore,
		cliVersion,
		healthStatus,
		addTerminalLineToScan,
		parseScanOutputForScan,
		startScanningScan,
		finishScanningScan,
		setErrorForScan,
		resetScan,
		viewMode,
		selectedItem,
		hoveredItem,
		clearSelectedItem,
		hydrateTagDictionary,
		enrichmentInvalidation
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
		formatBytes,
		type TreeData,
		type ScanStats
	} from '$lib/tauri';
	import { jobsStore } from '$lib/jobs';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import DropZone from '$lib/components/DropZone.svelte';
	import ScanProgress from '$lib/components/ScanProgress.svelte';
	import StalactiteChart from '$lib/components/StalactiteChart.svelte';
	import FileTable from '$lib/components/FileTable.svelte';
	import TreeView from '$lib/components/TreeView.svelte';
	import FileDetailsPanel from '$lib/components/FileDetailsPanel.svelte';
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

						// Handle scan completion via job:complete
						if (parsed?.event === 'job:complete') {
							addTerminalLineToScan(scan.id, '✓ Scan completed successfully', 'success');
							finishScanningScan(scan.id, true);
							if (scan.id === $activeScan?.id) {
								loadVisualizationData(scan.dbName, scan.id);
							}
						}

						// Handle scan error via job:error
						if (parsed?.event === 'job:error') {
							const msg = (parsed.error as string) ?? 'Scan failed';
							addTerminalLineToScan(scan.id, `✗ ${msg}`, 'error');
							finishScanningScan(scan.id, false);
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

				if (loadedForScanId !== scan.id) {
					treeData = null;
					statsData = null;
					visualizationError = null;
					isLoadingVisualization = false;
					clearSelectedItem();

					if (scan.state === 'complete') {
						loadVisualizationData(scan.dbName, scan.id);
					}
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

	// Track which scan we've loaded visualization for
	let loadedForScanId: string | null = null;

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
		isLoadingVisualization = true;
		visualizationError = null;
		treeData = null;
		statsData = null;

		try {
			// Start query session for this database
			await startQuerySession(dbName);

			// Fetch tree and stats in parallel
			const [tree, stats] = await Promise.all([queryTree(), queryStats()]);

			// Hydrate the tag dictionary for this scan (the only enrichment state
			// kept client-side — see "PGlite is the CENTER"). Per-element enrichment
			// is read on demand via joins / query-on-select, not cached here.
			getEnrichment().then((data) => {
				if (data && loadedForScanId === scanId) {
					hydrateTagDictionary(data.tags);
				}
			});

			// Only update if we're still loading for this scan
			if (loadedForScanId === scanId) {
				if (tree) {
					treeData = tree;
				} else {
					visualizationError = 'Failed to load file tree';
				}

				if (stats) {
					statsData = stats;
				}
			}
		} catch (error) {
			if (loadedForScanId === scanId) {
				visualizationError = `Failed to load visualization: ${error}`;
				console.error('Visualization loading error:', error);
			}
		} finally {
			if (loadedForScanId === scanId) {
				isLoadingVisualization = false;
			}
		}
	}

	// Re-query the tree when enrichment changes so directory bands and the
	// deletion cascade update live. The flat tree is one cheap query; the chart
	// refreshes its own (lazily loaded) file rows. Depends only on the signal.
	$effect(() => {
		if (!$enrichmentInvalidation) return;
		queryTree().then((tree) => {
			if (tree) treeData = tree;
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

	let fileCount = $derived(statsData?.totalFiles ?? $activeScan?.scanResult.filesDiscovered ?? 0);
	let folderCount = $derived($activeScan?.scanResult.folders ?? 0);
	let duplicateCount = $derived(
		statsData?.duplicateFiles ?? $activeScan?.scanResult.duplicateFiles ?? 0
	);
	let totalSize = $derived(statsData?.totalPhysicalSize ?? $activeScan?.scanResult.totalSize ?? 0);
</script>

<!-- Main Container -->
<div class="flex h-full flex-col">
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
		<!-- Scanning State (Analysis in Progress) -->
		<ScanProgress path={$activeScan?.path ?? ''} class="h-full" />
	{:else if $activeScan?.state === 'complete'}
		<!-- Analysis Complete State with Visualization -->
		<div class="flex h-full flex-col">
			{#if isLoadingVisualization}
				<!-- Loading visualization -->
				<div class="flex h-full items-center justify-center">
					<div class="flex flex-col items-center gap-4">
						<LoaderCircle size={40} class="animate-spin text-primary" />
						<p class="text-muted-foreground">Loading visualization...</p>
					</div>
				</div>
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
				<!-- Visualization Content -->
				<div
					class="flex flex-col overflow-auto p-4 pb-0"
					class:flex-1={!$selectedItem && !$hoveredItem}
					class:shrink-0={$selectedItem || $hoveredItem}
				>
					{#if $viewMode === 'stalactite'}
						<StalactiteChart data={treeData} class="h-full w-full" />
					{:else if $viewMode === 'tree'}
						<TreeView data={treeData} class="h-full w-full" />
					{:else}
						<FileTable data={treeData} class="h-full w-full" />
					{/if}
				</div>

				<!-- File/Folder Details Panel with Picker -->
				{#if $selectedItem || $hoveredItem}
					<FileDetailsPanel />
				{/if}

				<!-- Minimal Status Bar -->
				<div
					class="flex h-5.5 shrink-0 items-center gap-1.5 border-t border-border bg-muted px-3 text-[11px] text-muted-foreground"
				>
					<span class="whitespace-nowrap">{fileCount.toLocaleString()} files</span>
					<span class="text-[8px] opacity-40">•</span>
					<span class="whitespace-nowrap">{folderCount.toLocaleString()} folders</span>
					<span class="text-[8px] opacity-40">•</span>
					<span class="whitespace-nowrap">{duplicateCount.toLocaleString()} duplicates</span>
					<span class="text-[8px] opacity-40">•</span>
					<span class="whitespace-nowrap">{formatBytes(totalSize)}</span>
				</div>
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

<style>
	/* Allow visualization children to fill available space */
	:global(.flex-1.flex-col > .h-full) {
		flex: 1;
		min-height: 0;
	}
</style>
