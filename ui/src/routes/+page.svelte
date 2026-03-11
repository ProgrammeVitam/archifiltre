<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		appState,
		errorMessage,
		scanOptions,
		scanResult,
		cliVersion,
		healthStatus,
		scanProgress,
		isRunning,
		setError,
		startScanning,
		finishScanning,
		resetApp,
		addTerminalLine,
		parseScanOutput
	} from '$lib/stores';
	import {
		healthCheck,
		getVersion,
		scanDirectory,
		getOperationState,
		onScanProgress,
		onScanError,
		onScanComplete,
		formatBytes
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
			unlisteners.push(
				await onScanProgress((line) => {
					addTerminalLine(line, 'stdout');
					parseScanOutput(line);

					// Update progress message
					if (line.includes('ingested')) {
						scanProgress.set(line.trim());
					} else if (line.includes('found')) {
						scanProgress.set(line.trim());
					}
				}),
				await onScanError((line) => {
					addTerminalLine(line, 'stderr');
				}),
				await onScanComplete(async (success) => {
					addTerminalLine(
						success ? '✓ Scan completed successfully' : '✗ Scan failed',
						success ? 'success' : 'error'
					);
					finishScanning(success);
				})
			);

			// Check if there's already an operation running
			try {
				const opState = await getOperationState();
				if (opState.running) {
					initError = 'An analysis is already in progress. Please wait for it to complete.';
					return;
				}
			} catch {
				// Ignore - operation state check is optional
			}

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
	});

	// ================================
	// Actions
	// ================================

	async function handleStartAnalysis(path: string): Promise<void> {
		// Prevent concurrent analyses
		if ($isRunning) {
			setError('An analysis is already in progress. Please wait for it to complete.');
			return;
		}

		startScanning(path);

		try {
			const result = await scanDirectory({
				path,
				include_hidden: $scanOptions.includeHidden,
				batch_size: $scanOptions.batchSize,
				disable_archives: $scanOptions.disableArchives
			});

			if (!result.success) {
				setError(result.error ?? 'Analysis failed. Please check the folder and try again.');
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes('Another operation')) {
				setError('An analysis is already in progress. Please wait for it to complete.');
			} else {
				setError(`Analysis error: ${error}`);
			}
		}
	}

	function handleReset(): void {
		resetApp();
	}
</script>

<!-- Main Container -->
<div class="flex h-[calc(100vh-140px)] flex-col">
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
	{:else if $appState === 'idle'}
		<!-- Drop Zone State  -->
		<div class="flex h-full items-center justify-center p-8">
			<DropZone onStartAnalysis={handleStartAnalysis} disabled={$isRunning} class="max-w-3xl" />
		</div>
	{:else if $appState === 'scanning'}
		<!-- Scanning State  -->
		<ScanProgress path={$scanOptions.path} class="h-full" />
	{:else if $appState === 'complete'}
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
						{$scanResult.filesDiscovered.toLocaleString()}
					</div>
					<div class="text-sm text-muted-foreground">Files</div>
				</div>
				<div class="rounded-lg border bg-card p-4 text-center">
					<div class="text-3xl font-bold text-foreground">
						{$scanResult.folders.toLocaleString()}
					</div>
					<div class="text-sm text-muted-foreground">Folders</div>
				</div>
				<div class="rounded-lg border bg-card p-4 text-center">
					<div class="text-3xl font-bold text-foreground">
						{$scanResult.duplicateFiles.toLocaleString()}
					</div>
					<div class="text-sm text-muted-foreground">Duplicates</div>
				</div>
				<div class="rounded-lg border bg-card p-4 text-center">
					<div class="text-3xl font-bold text-foreground">
						{$scanResult.archives.toLocaleString()}
					</div>
					<div class="text-sm text-muted-foreground">Archives</div>
				</div>
			</div>

			<!-- Scanned path -->
			<div class="rounded-lg bg-muted/50 px-4 py-2 text-center">
				<span class="text-sm text-muted-foreground">Scanned: </span>
				<span class="font-mono text-sm text-foreground">{$scanOptions.path}</span>
			</div>

			<Button size="lg" onclick={handleReset}>
				<RefreshCw size={20} class="mr-2" />
				Analyze another folder
			</Button>
		</div>
	{:else if $appState === 'error'}
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
					>{$errorMessage ?? 'An unknown error occurred during analysis'}</AlertDescription
				>
			</Alert>
			<Button variant="outline" size="lg" onclick={handleReset}>
				<RefreshCw size={20} class="mr-2" />
				Try again
			</Button>
		</div>
	{/if}
</div>
