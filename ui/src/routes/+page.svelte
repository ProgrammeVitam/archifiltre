<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		activeTab,
		tabsStore,
		cliVersion,
		healthStatus,
		addTerminalLineToTab,
		parseScanOutputForTab,
		startScanningTab,
		finishScanningTab,
		setErrorForTab,
		resetTab
	} from '$lib/stores';
	import {
		healthCheck,
		getVersion,
		scanDirectory,
		onScanProgress,
		onScanError,
		onScanComplete,
		generateId
	} from '$lib/tauri';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import DropZone from '$lib/components/DropZone.svelte';
	import ScanProgress from '$lib/components/ScanProgress.svelte';
	import { LoaderCircle, CircleCheck, CircleAlert, RefreshCw } from '@lucide/svelte';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	// ================================
	// State
	// ================================

	let unlisteners: UnlistenFn[] = [];
	let isInitialized = $state(false);
	let initError = $state<string | null>(null);

	// ================================
	// Initialization
	// ================================

	onMount(async () => {
		try {
			// Setup event listeners for scan progress
			// Events include scanId - route to the correct tab
			unlisteners.push(
				await onScanProgress((event) => {
					// Find the tab with this scanId
					const tab = tabsStore.findTabByScanId(event.scanId);
					if (!tab) return;

					addTerminalLineToTab(tab.id, event.line, 'stdout');
					parseScanOutputForTab(tab.id, event.line);

					// Update progress message
					if (event.line.includes('ingested') || event.line.includes('found')) {
						tabsStore.updateTab(tab.id, { scanProgress: event.line.trim() });
					}
				}),
				await onScanError((event) => {
					// Find the tab with this scanId
					const tab = tabsStore.findTabByScanId(event.scanId);
					if (!tab) return;

					addTerminalLineToTab(tab.id, event.line, 'stderr');
				}),
				await onScanComplete((event) => {
					// Find the tab with this scanId
					const tab = tabsStore.findTabByScanId(event.scanId);
					if (!tab) return;

					addTerminalLineToTab(
						tab.id,
						event.success ? '✓ Scan completed successfully' : '✗ Scan failed',
						event.success ? 'success' : 'error'
					);
					finishScanningTab(tab.id, event.success);
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

	onDestroy(() => {
		// Cleanup event listeners
		for (const unlisten of unlisteners) {
			unlisten();
		}
	});

	// ================================
	// Actions
	// ================================

	async function handleStartAnalysis(path: string): Promise<void> {
		const tab = $activeTab;
		if (!tab) return;

		// Prevent starting another scan if this tab is already scanning
		if (tab.state === 'scanning') {
			setErrorForTab(tab.id, 'This scan is already running. Please wait or start a new scan.');
			return;
		}

		// Generate unique IDs for this scan
		const scanId = generateId();

		// Start scanning - this updates the tab state
		startScanningTab(tab.id, path, scanId);

		try {
			const result = await scanDirectory({
				scanId,
				dbName: tab.dbName,
				path,
				includeHidden: tab.scanOptions.includeHidden,
				batchSize: tab.scanOptions.batchSize,
				disableArchives: tab.scanOptions.disableArchives
			});

			if (!result.success) {
				setErrorForTab(
					tab.id,
					result.error ?? 'Analysis failed. Please check the folder and try again.'
				);
			}
		} catch (error) {
			setErrorForTab(tab.id, `Analysis error: ${error}`);
		}
	}

	function handleReset(): void {
		const tab = $activeTab;
		if (tab) {
			resetTab(tab.id);
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
	{:else if $activeTab?.state === 'idle'}
		<!-- Drop Zone State  -->
		<div class="flex h-full items-center justify-center p-8">
			<DropZone onStartAnalysis={handleStartAnalysis} disabled={false} class="max-w-3xl" />
		</div>
	{:else if $activeTab?.state === 'scanning'}
		<!-- Scanning State  -->
		<ScanProgress path={$activeTab?.path ?? ''} class="h-full" />
	{:else if $activeTab?.state === 'complete'}
		<!-- Analysis Complete State -->
		<div class="flex h-full flex-col items-center justify-center gap-6 p-8">
			<div
				class="flex h-24 w-24 items-center justify-center rounded-full bg-green-500/20 text-green-500"
			>
				<CircleCheck size={48} />
			</div>
			<div class="text-center">
				<h2 class="mb-2 text-2xl font-bold text-foreground">Analysis Complete</h2>
				<p class="text-muted-foreground">
					The analysis of your folder has been completed successfully.
				</p>
			</div>

			<!-- Results summary -->
			<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
				<div class="rounded-lg border bg-card p-4 text-center">
					<div class="text-3xl font-bold text-foreground">
						{$activeTab?.scanResult.filesDiscovered.toLocaleString()}
					</div>
					<div class="text-sm text-muted-foreground">Files</div>
				</div>
				<div class="rounded-lg border bg-card p-4 text-center">
					<div class="text-3xl font-bold text-foreground">
						{$activeTab?.scanResult.folders.toLocaleString()}
					</div>
					<div class="text-sm text-muted-foreground">Folders</div>
				</div>
				<div class="rounded-lg border bg-card p-4 text-center">
					<div class="text-3xl font-bold text-foreground">
						{$activeTab?.scanResult.duplicateFiles.toLocaleString()}
					</div>
					<div class="text-sm text-muted-foreground">Duplicates</div>
				</div>
				<div class="rounded-lg border bg-card p-4 text-center">
					<div class="text-3xl font-bold text-foreground">
						{$activeTab?.scanResult.archives.toLocaleString()}
					</div>
					<div class="text-sm text-muted-foreground">Archives</div>
				</div>
			</div>

			<!-- Scanned path -->
			<div class="rounded-lg bg-muted/50 px-4 py-2 text-center">
				<span class="text-sm text-muted-foreground">Scanned: </span>
				<span class="font-mono text-sm text-foreground">{$activeTab?.path}</span>
			</div>

			<Button size="lg" onclick={handleReset}>
				<RefreshCw size={20} class="mr-2" />
				Analyze another folder
			</Button>
		</div>
	{:else if $activeTab?.state === 'error'}
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
					>{$activeTab?.errorMessage ??
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
