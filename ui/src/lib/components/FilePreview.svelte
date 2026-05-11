<script lang="ts">
	import { convertFileSrc } from '@tauri-apps/api/core';
	import { thumbnail } from 'thumbnailjs';
	import { activeScan } from '$lib/stores';

	interface Props {
		path: string;
		class?: string;
	}

	let { path, class: className = '' }: Props = $props();

	let thumbUrl: string | null = $state(null);
	let isLoading = $state(true);
	let error = $state<string | null>(null);

	// Track the current object URL so we can revoke it on change / destroy
	let currentObjectUrl: string | null = null;

	function revoke() {
		if (currentObjectUrl) {
			URL.revokeObjectURL(currentObjectUrl);
			currentObjectUrl = null;
		}
	}

	$effect(() => {
		// Re-run whenever `path` changes
		const filePath = path;
		if (!filePath) return;

		isLoading = true;
		error = null;
		thumbUrl = null;

		const controller = new AbortController();

		const root = $activeScan?.path;
		const absolutePath = root ? `${root}/${filePath}` : filePath;
		const fileUrl = convertFileSrc(absolutePath);

		thumbnail(fileUrl, {
			width: 512,
			height: 512,
			fit: 'contain',
			signal: controller.signal
		})
			.then((blob) => {
				if (controller.signal.aborted) return;
				revoke();
				const url = URL.createObjectURL(blob);
				currentObjectUrl = url;
				thumbUrl = url;
				isLoading = false;
			})
			.catch((err) => {
				if (controller.signal.aborted) return;
				if (err instanceof DOMException && err.name === 'AbortError') return;
				console.error('Thumbnail generation failed:', err);
				error = 'Preview not available';
				isLoading = false;
			});

		return () => {
			controller.abort();
			revoke();
		};
	});
</script>

<div
	class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-muted/30 {className}"
>
	{#if isLoading}
		<div class="flex flex-col items-center gap-2 text-muted-foreground">
			<div
				class="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary"
			></div>
			<span class="text-sm">Loading preview...</span>
		</div>
	{:else if error}
		<div class="flex flex-col items-center gap-2 p-4 text-center text-muted-foreground">
			<span class="text-3xl">⚠️</span>
			<span class="text-sm">{error}</span>
		</div>
	{:else if thumbUrl}
		<img src={thumbUrl} alt="Preview" class="max-h-full max-w-full object-contain" />
	{/if}
</div>
