<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		currentStep,
		completedSteps,
		isRunning,
		scanOptions,
		scanResult,
		checksumOptions,
		exportOptions,
		terminalOutput,
		cliVersion,
		healthStatus,
		setStep,
		nextStep,
		previousStep,
		startOperation,
		endOperation,
		addTerminalLine,
		clearTerminal,
		parseScanOutput,
		resetAll
	} from '$lib/stores';
	import {
		selectFolder,
		selectExportPath,
		healthCheck,
		getVersion,
		scanDirectory,
		computeChecksums,
		exportCsv,
		onScanProgress,
		onScanError,
		onScanComplete,
		onChecksumProgress,
		onChecksumError,
		onChecksumComplete,
		onExportProgress,
		onExportError,
		onExportComplete,
		formatNumber
	} from '$lib/tauri';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Progress } from '$lib/components/ui/progress';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	let unlisteners: UnlistenFn[] = [];
	let isInitialized = $state(false);
	let initError = $state<string | null>(null);

	onMount(async () => {
		try {
			// Setup event listeners
			unlisteners.push(
				await onScanProgress((line) => {
					addTerminalLine(line, 'stdout');
					parseScanOutput(line);
				}),
				await onScanError((line) => addTerminalLine(line, 'stderr')),
				await onScanComplete((success) => {
					addTerminalLine(success ? '✓ Scan completed successfully' : '✗ Scan failed', success ? 'success' : 'error');
					endOperation();
					if (success) nextStep();
				}),
				await onChecksumProgress((line) => addTerminalLine(line, 'stdout')),
				await onChecksumError((line) => addTerminalLine(line, 'stderr')),
				await onChecksumComplete((success) => {
					addTerminalLine(success ? '✓ Checksums computed' : '✗ Checksum failed', success ? 'success' : 'error');
					endOperation();
					if (success) nextStep();
				}),
				await onExportProgress((line) => addTerminalLine(line, 'stdout')),
				await onExportError((line) => addTerminalLine(line, 'stderr')),
				await onExportComplete((success) => {
					addTerminalLine(success ? '✓ Export completed' : '✗ Export failed', success ? 'success' : 'error');
					endOperation();
					if (success) nextStep();
				})
			);

			const health = await healthCheck();
			healthStatus.set(health.success ? 'healthy' : 'unhealthy');

			const version = await getVersion();
			if (version.success) cliVersion.set(version.output.trim());

			isInitialized = true;
		} catch (error) {
			initError = `Failed to initialize: ${error}`;
			healthStatus.set('unhealthy');
		}
	});

	onDestroy(() => unlisteners.forEach((u) => u()));

	async function handleSelectFolder() {
		const path = await selectFolder();
		if (path) scanOptions.update((o) => ({ ...o, path }));
	}

	async function handleStartScan() {
		clearTerminal();
		startOperation('scanning');
		addTerminalLine(`Starting scan of: ${$scanOptions.path}`, 'info');
		try {
			await scanDirectory({
				path: $scanOptions.path,
				include_hidden: $scanOptions.includeHidden,
				batch_size: $scanOptions.batchSize,
				disable_archives: $scanOptions.disableArchives
			});
		} catch (error) {
			addTerminalLine(`Error: ${error}`, 'error');
			endOperation();
		}
	}

	async function handleStartChecksum() {
		clearTerminal();
		startOperation('checksum');
		addTerminalLine(`Computing checksums with: ${$checksumOptions.algorithm}`, 'info');
		try {
			await computeChecksums({
				algorithm: $checksumOptions.algorithm,
				each_file: $checksumOptions.eachFile
			});
		} catch (error) {
			addTerminalLine(`Error: ${error}`, 'error');
			endOperation();
		}
	}

	async function handleSelectExportPath() {
		const path = await selectExportPath();
		if (path) exportOptions.update((o) => ({ ...o, outputPath: path }));
	}

	async function handleStartExport() {
		clearTerminal();
		startOperation('exporting');
		addTerminalLine(`Exporting to: ${$exportOptions.outputPath}`, 'info');
		try {
			await exportCsv({
				output_path: $exportOptions.outputPath,
				full_paths: $exportOptions.fullPaths
			});
		} catch (error) {
			addTerminalLine(`Error: ${error}`, 'error');
			endOperation();
		}
	}
</script>

<div class="space-y-6">
	{#if !isInitialized && !initError}
		<!-- Loading State -->
		<Card>
			<CardContent class="flex flex-col items-center justify-center gap-4 py-12">
				<div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
				<p class="text-muted-foreground">Initializing Archifiltre...</p>
			</CardContent>
		</Card>
	{:else if initError}
		<!-- Error State -->
		<Alert variant="destructive">
			<AlertTitle>Initialization Error</AlertTitle>
			<AlertDescription>{initError}</AlertDescription>
		</Alert>
	{:else if $currentStep === 'select'}
		<!-- Step 1: Select Folder -->
		<div class="space-y-2">
			<h1 class="text-3xl font-bold">Select a Folder to Scan</h1>
			<p class="text-muted-foreground">Choose a directory to analyze for files and potential duplicates.</p>
		</div>

		<Card>
			<CardContent class="space-y-6 pt-6">
				<div class="space-y-2">
					<label for="folder-path" class="text-sm font-medium">Folder Path</label>
					<div class="flex gap-2">
						<input
							type="text"
							id="folder-path"
							class="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
							placeholder="Click 'Browse' to select a folder..."
							value={$scanOptions.path}
							readonly
						/>
						<Button onclick={handleSelectFolder}>📁 Browse</Button>
					</div>
				</div>

				<Separator />

				<div class="space-y-4">
					<h4 class="text-sm font-medium">Scan Options</h4>
					<div class="space-y-3">
						<label class="flex items-center gap-2">
							<input
								type="checkbox"
								class="h-4 w-4 rounded border-input"
								checked={$scanOptions.includeHidden}
								onchange={(e) => scanOptions.update((o) => ({ ...o, includeHidden: e.currentTarget.checked }))}
							/>
							<span class="text-sm">Include hidden files</span>
						</label>
						<label class="flex items-center gap-2">
							<input
								type="checkbox"
								class="h-4 w-4 rounded border-input"
								checked={$scanOptions.disableArchives}
								onchange={(e) => scanOptions.update((o) => ({ ...o, disableArchives: e.currentTarget.checked }))}
							/>
							<span class="text-sm">Skip archive contents</span>
						</label>
					</div>
				</div>
			</CardContent>
			<CardFooter class="justify-end">
				<Button size="lg" disabled={!$scanOptions.path} onclick={() => nextStep()}>
					Continue →
				</Button>
			</CardFooter>
		</Card>

	{:else if $currentStep === 'scan'}
		<!-- Step 2: Scan -->
		<div class="space-y-2">
			<h1 class="text-3xl font-bold">Scan Directory</h1>
			<p class="text-muted-foreground">Analyzing <code class="rounded bg-muted px-1.5 py-0.5 text-sm">{$scanOptions.path}</code></p>
		</div>

		{#if !$isRunning && $scanResult.filesDiscovered === 0}
			<!-- Ready to scan -->
			<Card>
				<CardHeader>
					<CardTitle>Ready to Scan</CardTitle>
					<CardDescription>Click the button below to start scanning the selected directory.</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="rounded-lg bg-muted p-4 space-y-2 text-sm">
						<div class="flex gap-2"><span class="font-medium w-32">Target:</span><code>{$scanOptions.path}</code></div>
						<div class="flex gap-2"><span class="font-medium w-32">Hidden files:</span><span>{$scanOptions.includeHidden ? 'Yes' : 'No'}</span></div>
						<div class="flex gap-2"><span class="font-medium w-32">Process archives:</span><span>{$scanOptions.disableArchives ? 'No' : 'Yes'}</span></div>
					</div>
				</CardContent>
				<CardFooter class="justify-between">
					<Button variant="ghost" onclick={() => previousStep()}>← Back</Button>
					<Button size="lg" onclick={handleStartScan}>🔍 Start Scan</Button>
				</CardFooter>
			</Card>
		{:else if $isRunning}
			<!-- Scanning -->
			<Card>
				<CardContent class="space-y-4 pt-6">
					<div class="flex items-center gap-3">
						<div class="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
						<span class="font-medium">Scanning in progress...</span>
					</div>
					<Progress value={100} class="animate-pulse" />
					<ScrollArea class="h-64 rounded-md border bg-zinc-950 p-4">
						<div class="font-mono text-sm">
							{#each $terminalOutput as line (line.id)}
								<div class="{line.stream === 'stderr' ? 'text-red-400' : line.stream === 'success' ? 'text-green-400' : line.stream === 'info' ? 'text-blue-400' : 'text-zinc-300'}">
									{line.text}
								</div>
							{/each}
						</div>
					</ScrollArea>
				</CardContent>
			</Card>
		{:else}
			<!-- Scan complete -->
			<Card>
				<CardHeader>
					<div class="flex items-center gap-2">
						<span class="text-2xl text-green-500">✓</span>
						<CardTitle>Scan Complete</CardTitle>
					</div>
				</CardHeader>
				<CardContent class="space-y-4">
					<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
						<div class="rounded-lg border p-4">
							<div class="text-sm text-muted-foreground">Files Found</div>
							<div class="text-2xl font-bold">{formatNumber($scanResult.filesDiscovered)}</div>
						</div>
						<div class="rounded-lg border p-4">
							<div class="text-sm text-muted-foreground">Duplicate Groups</div>
							<div class="text-2xl font-bold">{formatNumber($scanResult.duplicateGroups)}</div>
						</div>
						<div class="rounded-lg border p-4">
							<div class="text-sm text-muted-foreground">Folders</div>
							<div class="text-2xl font-bold">{formatNumber($scanResult.folders)}</div>
						</div>
						<div class="rounded-lg border p-4">
							<div class="text-sm text-muted-foreground">Empty Folders</div>
							<div class="text-2xl font-bold">{formatNumber($scanResult.emptyFolders)}</div>
						</div>
					</div>
					<details class="text-sm">
						<summary class="cursor-pointer text-muted-foreground hover:text-foreground">View scan output</summary>
						<ScrollArea class="mt-2 h-48 rounded-md border bg-zinc-950 p-4">
							<div class="font-mono text-xs">
								{#each $terminalOutput as line (line.id)}
									<div class="{line.stream === 'stderr' ? 'text-red-400' : line.stream === 'success' ? 'text-green-400' : 'text-zinc-300'}">{line.text}</div>
								{/each}
							</div>
						</ScrollArea>
					</details>
				</CardContent>
				<CardFooter class="justify-between">
					<Button variant="ghost" onclick={() => previousStep()}>← Back</Button>
					<Button size="lg" onclick={() => nextStep()}>Continue to Checksum →</Button>
				</CardFooter>
			</Card>
		{/if}

	{:else if $currentStep === 'checksum'}
		<!-- Step 3: Checksum -->
		<div class="space-y-2">
			<h1 class="text-3xl font-bold">Compute Checksums</h1>
			<p class="text-muted-foreground">Calculate cryptographic hashes to verify duplicates.</p>
		</div>

		{#if !$isRunning}
			<Card>
				<CardContent class="space-y-6 pt-6">
					<Alert>
						<AlertTitle>💡 Optimization</AlertTitle>
						<AlertDescription>
							Archifiltre only reads one file per duplicate group, significantly reducing disk I/O.
						</AlertDescription>
					</Alert>

					<div class="space-y-2">
						<label for="algorithm" class="text-sm font-medium">Hash Algorithm</label>
						<select
							id="algorithm"
							class="w-full rounded-md border bg-background px-3 py-2 text-sm"
							value={$checksumOptions.algorithm}
							onchange={(e) => checksumOptions.update((o) => ({ ...o, algorithm: e.currentTarget.value as any }))}
						>
							<option value="xxhash64">XXHash64 (Fast, recommended)</option>
							<option value="md5">MD5</option>
							<option value="sha256">SHA-256</option>
							<option value="sha512">SHA-512</option>
						</select>
					</div>

					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							class="h-4 w-4 rounded border-input"
							checked={$checksumOptions.eachFile}
							onchange={(e) => checksumOptions.update((o) => ({ ...o, eachFile: e.currentTarget.checked }))}
						/>
						<span class="text-sm">Calculate for each file (slower)</span>
					</label>
				</CardContent>
				<CardFooter class="justify-between">
					<Button variant="ghost" onclick={() => previousStep()}>← Back</Button>
					<div class="flex gap-2">
						<Button variant="outline" onclick={() => nextStep()}>Skip</Button>
						<Button size="lg" onclick={handleStartChecksum}>🔐 Compute Checksums</Button>
					</div>
				</CardFooter>
			</Card>
		{:else}
			<Card>
				<CardContent class="space-y-4 pt-6">
					<div class="flex items-center gap-3">
						<div class="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
						<span class="font-medium">Computing checksums...</span>
					</div>
					<Progress value={100} class="animate-pulse" />
					<ScrollArea class="h-64 rounded-md border bg-zinc-950 p-4">
						<div class="font-mono text-sm">
							{#each $terminalOutput as line (line.id)}
								<div class="{line.stream === 'stderr' ? 'text-red-400' : line.stream === 'success' ? 'text-green-400' : 'text-zinc-300'}">{line.text}</div>
							{/each}
						</div>
					</ScrollArea>
				</CardContent>
			</Card>
		{/if}

	{:else if $currentStep === 'export'}
		<!-- Step 4: Export -->
		<div class="space-y-2">
			<h1 class="text-3xl font-bold">Export Results</h1>
			<p class="text-muted-foreground">Save your scan results to a CSV file.</p>
		</div>

		{#if !$isRunning}
			<Card>
				<CardContent class="space-y-6 pt-6">
					<div class="space-y-2">
						<label for="export-path" class="text-sm font-medium">Export File</label>
						<div class="flex gap-2">
							<input
								type="text"
								id="export-path"
								class="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
								placeholder="Click 'Browse' to select output location..."
								value={$exportOptions.outputPath}
								readonly
							/>
							<Button onclick={handleSelectExportPath}>📁 Browse</Button>
						</div>
					</div>

					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							class="h-4 w-4 rounded border-input"
							checked={$exportOptions.fullPaths}
							onchange={(e) => exportOptions.update((o) => ({ ...o, fullPaths: e.currentTarget.checked }))}
						/>
						<span class="text-sm">Export full absolute paths</span>
					</label>
				</CardContent>
				<CardFooter class="justify-between">
					<Button variant="ghost" onclick={() => previousStep()}>← Back</Button>
					<Button size="lg" disabled={!$exportOptions.outputPath} onclick={handleStartExport}>
						📤 Export CSV
					</Button>
				</CardFooter>
			</Card>
		{:else}
			<Card>
				<CardContent class="space-y-4 pt-6">
					<div class="flex items-center gap-3">
						<div class="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
						<span class="font-medium">Exporting...</span>
					</div>
					<Progress value={100} class="animate-pulse" />
					<ScrollArea class="h-64 rounded-md border bg-zinc-950 p-4">
						<div class="font-mono text-sm">
							{#each $terminalOutput as line (line.id)}
								<div class="{line.stream === 'stderr' ? 'text-red-400' : line.stream === 'success' ? 'text-green-400' : 'text-zinc-300'}">{line.text}</div>
							{/each}
						</div>
					</ScrollArea>
				</CardContent>
			</Card>
		{/if}

	{:else if $currentStep === 'complete'}
		<!-- Step 5: Complete -->
		<div class="text-center space-y-6 py-8">
			<div class="text-6xl">🎉</div>
			<h1 class="text-3xl font-bold">All Done!</h1>
			<p class="text-muted-foreground">Your directory has been scanned and exported successfully.</p>

			<Card class="mx-auto max-w-md text-left">
				<CardHeader>
					<CardTitle>Summary</CardTitle>
				</CardHeader>
				<CardContent class="space-y-2 text-sm">
					<div class="flex justify-between"><span class="text-muted-foreground">Scanned:</span><code>{$scanOptions.path}</code></div>
					<div class="flex justify-between"><span class="text-muted-foreground">Files:</span><span>{formatNumber($scanResult.filesDiscovered)}</span></div>
					<div class="flex justify-between"><span class="text-muted-foreground">Duplicates:</span><span>{formatNumber($scanResult.duplicateGroups)} groups</span></div>
					{#if $exportOptions.outputPath}
						<div class="flex justify-between"><span class="text-muted-foreground">Exported to:</span><code class="truncate max-w-48">{$exportOptions.outputPath}</code></div>
					{/if}
				</CardContent>
			</Card>

			<Button size="lg" onclick={() => resetAll()}>🔄 Start New Scan</Button>
		</div>
	{/if}
</div>
