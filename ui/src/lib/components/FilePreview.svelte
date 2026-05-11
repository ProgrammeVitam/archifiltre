<script lang="ts">
	import { convertFileSrc } from '@tauri-apps/api/core';
	import { thumbnail } from '@thumbnailjs/core';
	import { activeScan } from '$lib/stores';
	import { getThumbnailFromCache, storeThumbnailInCache } from '$lib/tauri';

	interface Props {
		path: string;
		class?: string;
	}

	let { path, class: className = '' }: Props = $props();

	const THUMB_SIZE = 1024;

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

	function showBlob(blob: Blob) {
		revoke();
		const url = URL.createObjectURL(blob);
		currentObjectUrl = url;
		thumbUrl = url;
		isLoading = false;
	}

	function base64ToBlob(base64: string, mime: string): Blob {
		const bytes = atob(base64);
		const buf = new Uint8Array(bytes.length);
		for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
		return new Blob([buf], { type: mime });
	}

	async function blobToBase64(blob: Blob): Promise<string> {
		const buf = await blob.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let binary = '';
		for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}

	$effect(() => {
		const filePath = path;
		if (!filePath) return;

		isLoading = true;
		error = null;
		thumbUrl = null;

		const controller = new AbortController();

		(async () => {
			try {
				// 1. Check PGlite cache
				const cached = await getThumbnailFromCache(filePath);
				if (controller.signal.aborted) return;

				if (cached?.thumbnail) {
					const blob = base64ToBlob(cached.thumbnail, cached.format ?? 'image/png');
					showBlob(blob);
					return;
				}

				// 2. Cache miss — generate via thumbnailjs
				const root = $activeScan?.path;
				const absolutePath = root ? `${root}/${filePath}` : filePath;
				const fileUrl = convertFileSrc(absolutePath);

				const blob = await thumbnail(fileUrl, {
					width: THUMB_SIZE,
					fit: 'contain',
					signal: controller.signal
				});
				if (controller.signal.aborted) return;

				showBlob(blob);

				// 3. Store in PGlite cache (fire-and-forget)
				const format = blob.type || 'image/png';
				blobToBase64(blob).then((b64) => {
					if (!controller.signal.aborted) {
						storeThumbnailInCache(filePath, b64, THUMB_SIZE, THUMB_SIZE, format);
					}
				});
			} catch (err) {
				if (controller.signal.aborted) return;
				if (err instanceof DOMException && err.name === 'AbortError') return;
				console.error('Thumbnail generation failed:', err);
				error = 'Preview not available';
				isLoading = false;
			}
		})();

		return () => {
			controller.abort();
			revoke();
		};
	});
</script>

<div
	class="relative flex h-full w-full items-center justify-center overflow-hidden bg-muted/30 object-contain p-6 {className}"
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
		<img src={thumbUrl} alt="Preview" class="max-h-full shadow-lg" />
	{/if}
</div>
