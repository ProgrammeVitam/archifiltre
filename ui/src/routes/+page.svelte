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
		viewMode
	} from '$lib/stores';
	import {
		healthCheck,
		getVersion,
		scanDirectory,
		onScanProgress,
		onScanError,
		onScanComplete,
		generateId,
		startQuerySession,
		stopQuerySession,
		queryTree,
		queryStats,
		formatBytes,
		type TreeData,
		type ScanStats
	} from '$lib/tauri';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import DropZone from '$lib/components/DropZone.svelte';
	import ScanProgress from '$lib/components/ScanProgress.svelte';
	import IcicleChart from '$lib/components/IcicleChart.svelte';
	import FileTable from '$lib/components/FileTable.svelte';
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
			// Setup event listeners for scan progress
			// Events include scanId - route to the correct tab
			unlisteners.push(
				await onScanProgress((event) => {
					// Find the scan with this scanId
					const scan = scansStore.findScanByScanId(event.scanId);
					if (!scan) return;

					addTerminalLineToScan(scan.id, event.line, 'stdout');
					parseScanOutputForScan(scan.id, event.line);

					// Update progress message
					if (event.line.includes('ingested') || event.line.includes('found')) {
						scansStore.updateScan(scan.id, { scanProgress: event.line.trim() });
					}
				}),
				await onScanError((event) => {
					// Find the scan with this scanId
					const scan = scansStore.findScanByScanId(event.scanId);
					if (!scan) return;

					addTerminalLineToScan(scan.id, event.line, 'stderr');
				}),
				await onScanComplete((event) => {
					// Find the scan with this scanId
					const scan = scansStore.findScanByScanId(event.scanId);
					if (!scan) return;

					addTerminalLineToScan(
						scan.id,
						event.success ? '✓ Scan completed successfully' : '✗ Scan failed',
						event.success ? 'success' : 'error'
					);
					finishScanningScan(scan.id, event.success);

					// Load visualization data after scan completes (only for active scan)
					if (event.success && scan.id === $activeScan?.id) {
						loadVisualizationData(scan.dbName, scan.id);
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

		// Generate unique IDs for this scan
		const newScanId = generateId();

		// Start scanning - this updates the scan state
		startScanningScan(scan.id, path, newScanId);

		try {
			const result = await scanDirectory({
				scanId: newScanId,
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
		<!-- Drop Zone State  -->
		<div class="flex h-full items-center justify-center p-8">
			<DropZone onStartAnalysis={handleStartAnalysis} disabled={false} class="max-w-3xl" />
		</div>
	{:else if $activeScan?.state === 'scanning'}
		<!-- Scanning State  -->
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
				<div class="visualization-content">
					{#if $viewMode === 'chart'}
						<IcicleChart data={treeData} class="h-full w-full" />
					{:else}
						<FileTable data={treeData} class="h-full w-full" />
					{/if}
				</div>

				<!-- Minimal Status Bar -->
				<div class="status-bar">
					<span class="status-item">{fileCount.toLocaleString()} files</span>
					<span class="status-separator">•</span>
					<span class="status-item">{folderCount.toLocaleString()} folders</span>
					<span class="status-separator">•</span>
					<span class="status-item">{duplicateCount.toLocaleString()} duplicates</span>
					<span class="status-separator">•</span>
					<span class="status-item">{formatBytes(totalSize)}</span>
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
	.visualization-content {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 16px;
		display: flex;
		flex-direction: column;
	}

	.visualization-content :global(.h-full) {
		flex: 1;
		min-height: 0;
	}

	.status-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 12px;
		background-color: var(--muted);
		border-top: 1px solid var(--border);
		font-size: 11px;
		color: var(--muted-foreground);
		height: 22px;
		flex-shrink: 0;
	}

	.status-item {
		white-space: nowrap;
	}

	.status-separator {
		opacity: 0.4;
		font-size: 8px;
	}
</style>
