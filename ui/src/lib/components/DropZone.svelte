<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { selectFolder, validatePath } from '$lib/tauri';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { FolderDown, LoaderCircle } from '@lucide/svelte';
	import { _ } from '$lib/i18n';

	// ================================
	// Props
	// ================================

	interface Props {
		onStartAnalysis: (path: string) => void;
		disabled?: boolean;
		class?: string;
	}

	let { onStartAnalysis, disabled = false, class: className = '' }: Props = $props();

	// ================================
	// State
	// ================================

	let isDragOver = $state(false);
	let errorMessage = $state<string | null>(null);
	let isValidating = $state(false);
	let unlisteners: UnlistenFn[] = [];

	// ================================
	// Tauri Drag & Drop Events
	// ================================

	onMount(async () => {
		// Listen for Tauri's native drag-drop events
		unlisteners.push(
			await listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
				if (disabled || isValidating) return;

				const paths = event.payload.paths;
				if (paths && paths.length > 0) {
					isDragOver = false;

					if (paths.length > 1) {
						errorMessage = 'Please drop only one folder at a time.';
						return;
					}

					await validateAndStartAnalysis(paths[0]);
				}
			}),
			await listen('tauri://drag-enter', () => {
				if (!disabled && !isValidating) {
					isDragOver = true;
				}
			}),
			await listen('tauri://drag-leave', () => {
				isDragOver = false;
			})
		);
	});

	onDestroy(() => {
		for (const unlisten of unlisteners) {
			unlisten();
		}
	});

	// ================================
	// Path Validation & Auto-Start
	// ================================

	async function validateAndStartAnalysis(path: string): Promise<void> {
		errorMessage = null;
		isValidating = true;

		try {
			const result = await validatePath(path);

			if (!result.valid) {
				errorMessage = result.error || 'The selected path is not valid';
			} else if (!result.isDirectory) {
				errorMessage = 'Please select a folder, not a file';
			} else if (!result.readable) {
				errorMessage = 'Cannot read this folder. Please check permissions.';
			} else {
				// Path is valid - immediately start analysis
				onStartAnalysis(path);
			}
		} catch (error) {
			errorMessage = `Failed to validate path: ${error}`;
		} finally {
			isValidating = false;
		}
	}

	// ================================
	// Event Handlers
	// ================================

	async function handleChooseFolder(): Promise<void> {
		if (disabled || isValidating) return;
		errorMessage = null;

		try {
			const path = await selectFolder();
			if (path) {
				await validateAndStartAnalysis(path);
			}
		} catch (error) {
			errorMessage = `Failed to open folder dialog: ${error}`;
		}
	}
</script>

<div
	role="region"
	aria-label="Folder selection area"
	class="
		relative flex min-h-[450px] w-full flex-col items-center justify-center
		rounded-2xl border-2 border-dashed transition-all duration-300
		{isDragOver ? 'scale-[1.02] border-primary bg-primary/10' : 'border-muted-foreground/30 bg-card/50'}
		{disabled || isValidating ? 'cursor-not-allowed opacity-50' : ''}
		{className}
	"
>
	<div class="flex flex-col items-center justify-center p-8">
		<!-- Icon -->
		<div
			class="mb-6 flex h-24 w-24 items-center justify-center rounded-full transition-all duration-300
				{isDragOver ? 'scale-110 bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}"
		>
			{#if isValidating}
				<LoaderCircle size={48} strokeWidth={1.5} class="animate-spin text-primary" />
			{:else}
				<FolderDown size={48} strokeWidth={1.5} class="transition-transform duration-300" />
			{/if}
		</div>

		<!-- Text -->
		<div class="text-center">
			<h2 class="mb-2 text-2xl font-bold text-foreground">
				{#if isValidating}
					{$_('welcome.validating')}
				{:else if isDragOver}
					{$_('welcome.dropHere')}
				{:else}
					{$_('welcome.dropToAnalyze')}
				{/if}
			</h2>
			<p class="mb-6 max-w-md text-muted-foreground">
				{#if isValidating}
					{$_('welcome.checkingAccess')}
				{:else if isDragOver}
					{$_('welcome.releaseToStart')}
				{:else}
					{$_('welcome.dragHint')}
				{/if}
			</p>
		</div>

		<!-- Error message -->
		{#if errorMessage}
			<Alert variant="destructive" class="mb-6 max-w-md">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
		{/if}

		<!-- Browse button -->
		{#if !isDragOver && !isValidating}
			<div class="flex items-center gap-3">
				<span class="text-sm text-muted-foreground">{$_('welcome.or')}</span>
				<Button
					variant="outline"
					size="lg"
					class="hover:border-primary hover:text-primary"
					disabled={disabled || isValidating}
					onclick={handleChooseFolder}
				>
					{$_('welcome.chooseFolder')}
				</Button>
			</div>
		{/if}

		<!-- Hint -->
		<p class="mt-8 text-xs text-muted-foreground/60">
			{$_('welcome.privacyHint')}
		</p>
	</div>

	<!-- Animated border effect when dragging -->
	{#if isDragOver}
		<div class="absolute inset-0 rounded-2xl">
			<div
				class="absolute inset-0 animate-pulse rounded-2xl border-2 border-primary opacity-50"
			></div>
		</div>
	{/if}
</div>
