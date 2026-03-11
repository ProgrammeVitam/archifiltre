<script lang="ts">
	import { scanResult, terminalOutput, scanProgress } from '$lib/stores';
	import { formatBytes } from '$lib/tauri';
	import { Progress } from '$lib/components/ui/progress';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { LoaderCircle } from '@lucide/svelte';

	// ================================
	// Props
	// ================================

	interface Props {
		path: string;
		class?: string;
	}

	let { path, class: className = '' }: Props = $props();

	// ================================
	// Derived State
	// ================================

	let folderName = $derived(path.split('/').pop() || path.split('\\').pop() || path);
</script>

<div class="flex h-full w-full flex-col items-center justify-center p-8 {className}">
	<Card class="w-full max-w-2xl">
		<CardHeader class="space-y-1">
			<div class="flex items-center gap-3">
				<div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
					<LoaderCircle size={24} class="animate-spin text-primary" />
				</div>
				<div>
					<CardTitle class="text-xl">Scanning in progress</CardTitle>
					<p class="text-sm text-muted-foreground">Analyzing {folderName}</p>
				</div>
			</div>
		</CardHeader>

		<CardContent class="space-y-6">
			<!-- Progress bar -->
			<div class="space-y-2">
				<Progress value={100} class="h-2 animate-pulse" />
				<p class="text-center text-xs text-muted-foreground">
					{$scanProgress || 'Discovering files...'}
				</p>
			</div>

			<!-- Stats grid -->
			<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
				<div class="rounded-lg border bg-card p-3 text-center">
					<div class="text-2xl font-bold text-foreground">
						{$scanResult.filesDiscovered.toLocaleString()}
					</div>
					<div class="text-xs text-muted-foreground">Files</div>
				</div>
				<div class="rounded-lg border bg-card p-3 text-center">
					<div class="text-2xl font-bold text-foreground">
						{$scanResult.folders.toLocaleString()}
					</div>
					<div class="text-xs text-muted-foreground">Folders</div>
				</div>
				<div class="rounded-lg border bg-card p-3 text-center">
					<div class="text-2xl font-bold text-foreground">
						{$scanResult.duplicateGroups.toLocaleString()}
					</div>
					<div class="text-xs text-muted-foreground">Duplicates</div>
				</div>
				<div class="rounded-lg border bg-card p-3 text-center">
					<div class="text-2xl font-bold text-foreground">
						{formatBytes($scanResult.totalSize)}
					</div>
					<div class="text-xs text-muted-foreground">Size</div>
				</div>
			</div>

			<!-- Terminal output -->
			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<p class="text-sm font-medium text-foreground">Output</p>
					<span class="text-xs text-muted-foreground">
						{$terminalOutput.length} lines
					</span>
				</div>
				<ScrollArea class="h-48 rounded-md border bg-zinc-950 p-4">
					<div class="font-mono text-xs">
						{#each $terminalOutput as line (line.id)}
							<div
								class="py-0.5 break-all whitespace-pre-wrap
									{line.stream === 'success' ? 'text-green-400' : ''}
									{line.stream === 'error' ? 'text-red-400' : ''}
									{line.stream === 'info' ? 'text-blue-400' : 'text-zinc-300'}"
							>
								{line.text}
							</div>
						{/each}
						<!-- Blinking cursor -->
						<span class="inline-block h-4 w-2 animate-pulse bg-zinc-400"></span>
					</div>
				</ScrollArea>
			</div>

			<!-- Path info -->
			<div class="rounded-lg bg-muted/50 p-3">
				<p class="text-xs text-muted-foreground">Scanning path</p>
				<p class="truncate font-mono text-sm text-foreground" title={path}>
					{path}
				</p>
			</div>

			<!-- Hint -->
			<p class="text-center text-xs text-muted-foreground">
				This may take a while for large directories. The scan runs entirely on your machine.
			</p>
		</CardContent>
	</Card>
</div>
