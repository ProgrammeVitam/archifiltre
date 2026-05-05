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
		resetScan
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
		exportCsv,
		selectExportPath,
		type TreeData,
		type ScanStats
	} from '$lib/tauri';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import DropZone from '$lib/components/DropZone.svelte';
	import ScanProgress from '$lib/components/ScanProgress.svelte';
	import IcicleChart from '$lib/components/IcicleChart.svelte';
	import FileTable from '$lib/components/FileTable.svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		LoaderCircle,
		CircleAlert,
		RefreshCw,
		Download,
		Plus,
		LayoutGrid,
		List
	} from '@lucide/svelte';
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

	// View toggle state
	let viewMode = $state<string>('chart');

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

	onMount(() => {
		// Set up subscription after initial mount
		unsubscribeActiveScan = activeScan.subscribe((scan) => {
			if (!scan) return;

			// If switching to a different scan
			if (loadedForScanId !== scan.id) {
				// Clear old visualization data
				treeData = null;
				statsData = null;
				visualizationError = null;
				isLoadingVisualization = false;

				// Load visualization for completed scans
				if (scan.state === 'complete') {
					loadVisualizationData(scan.dbName, scan.id);
				}
			}
		});
	});

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

	async function handleExport(): Promise<void> {
		const scan = $activeScan;
		if (!scan) return;

		try {
			// Open save dialog
			const outputPath = await selectExportPath();
			if (!outputPath) return; // User cancelled

			// Export to CSV
			const result = await exportCsv({
				outputPath,
				dbName: scan.dbName,
				fullPaths: true
			});

			if (result.success) {
				console.log('Export successful:', outputPath);
			} else {
				console.error('Export failed:', result.error);
			}
		} catch (error) {
			console.error('Export error:', error);
		}
	}
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
				<!-- Visualization -->
				<Tabs.Root bind:value={viewMode} class="flex min-h-0 flex-1 flex-col">
					<!-- View toggle tabs -->
					<div class="border-b px-4 py-2">
						<Tabs.List>
							<Tabs.Trigger value="chart">
								<LayoutGrid size={16} />
								<span>Chart</span>
							</Tabs.Trigger>
							<Tabs.Trigger value="table">
								<List size={16} />
								<span>Table</span>
							</Tabs.Trigger>
						</Tabs.List>
					</div>

					<!-- Content area -->
					<Tabs.Content value="chart" class="min-h-0 flex-1 overflow-auto p-4">
						<IcicleChart data={treeData} class="h-full w-full" />
					</Tabs.Content>
					<Tabs.Content value="table" class="min-h-0 flex-1 overflow-auto p-4">
						<FileTable data={treeData} class="h-full w-full" />
					</Tabs.Content>

					<!-- Stats bar at the bottom -->
					<div class="border-t bg-card px-4 py-3">
						<div class="flex items-center justify-between">
							<!-- Stats -->
							<div class="flex gap-6">
								<div class="flex items-center gap-2">
									<span class="text-2xl font-bold text-foreground">
										{statsData?.totalFiles?.toLocaleString() ??
											$activeScan?.scanResult.filesDiscovered.toLocaleString()}
									</span>
									<span class="text-sm text-muted-foreground">files</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="text-2xl font-bold text-foreground">
										{$activeScan?.scanResult.folders.toLocaleString()}
									</span>
									<span class="text-sm text-muted-foreground">folders</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="text-2xl font-bold text-foreground">
										{statsData?.duplicateFiles?.toLocaleString() ??
											$activeScan?.scanResult.duplicateFiles.toLocaleString()}
									</span>
									<span class="text-sm text-muted-foreground">duplicates</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="text-2xl font-bold text-foreground">
										{formatBytes(
											statsData?.totalPhysicalSize ?? $activeScan?.scanResult.totalSize ?? 0
										)}
									</span>
									<span class="text-sm text-muted-foreground">total size</span>
								</div>
							</div>

							<!-- Actions -->
							<div class="flex gap-2">
								<Button variant="outline" size="sm" onclick={handleReset}>
									<RefreshCw size={14} class="mr-2" />
									Lorem ipsum
								</Button>
								<Button size="sm" onclick={handleExport}>
									<Download size={14} class="mr-2" />
									Export
								</Button>
							</div>
						</div>

						<!-- Scanned path -->
						<div class="mt-2 text-xs text-muted-foreground">
							<span>Scanned: </span>
							<span class="font-mono">{$activeScan?.path}</span>
						</div>
					</div>
				</Tabs.Root>
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
