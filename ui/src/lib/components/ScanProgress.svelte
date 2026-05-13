<script lang="ts">
	import { scanResult } from '$lib/stores';
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

<div class="flex h-full w-full flex-col items-center justify-center {className}">
	<!-- Main content - centered -->
	<div class="flex flex-col items-center justify-center space-y-8">
		<!-- Spinner -->
		<div class="relative">
			<div
				class="absolute inset-0 animate-pulse rounded-full bg-primary/20 blur-xl"
				style="transform: scale(1.5);"
			></div>
			<LoaderCircle size={48} class="relative animate-spin text-primary" strokeWidth={1.5} />
		</div>

		<!-- File count - large and prominent -->
		<div class="text-center">
			<div
				class="text-8xl font-bold tracking-tight text-foreground tabular-nums transition-all duration-150"
			>
				{$scanResult.filesDiscovered.toLocaleString()}
			</div>
			<div class="mt-2 text-xl text-muted-foreground">
				{$scanResult.filesDiscovered === 1 ? 'file' : 'files'} discovered
			</div>
		</div>

		<!-- Phase indicator -->
		<div class="flex flex-col items-center space-y-3">
			<div class="flex items-center gap-2 text-sm text-muted-foreground">
				<span class="inline-block h-2 w-2 animate-pulse rounded-full bg-primary"></span>
				<span>Scanning...</span>
			</div>

		</div>
	</div>

	<!-- Folder path - bottom -->
	<div class="absolute right-0 bottom-8 left-0 text-center">
		<p class="text-xs text-muted-foreground/60">Scanning</p>
		<p class="mx-auto max-w-md truncate px-4 font-mono text-sm text-muted-foreground" title={path}>
			{folderName}
		</p>
	</div>
</div>
