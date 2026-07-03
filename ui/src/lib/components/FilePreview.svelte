<script lang="ts" module>
	import { thumbnail, canEncode } from '@thumbnailjs/core';

	// ── In-memory LRU of object URLs, keyed by relative path ──
	// Module-level so it survives the component remounting (file → dir → file) — the whole
	// point is that re-hovering a recently seen file is instant, no IPC. Cleared + revoked
	// when the active scan changes (paths are scan-root-relative, so they'd otherwise
	// collide across scans).
	const LRU_MAX = 48;
	const lru = new Map<string, string>(); // insertion order = LRU order (oldest first)

	function lruGet(path: string): string | undefined {
		const url = lru.get(path);
		if (url) {
			lru.delete(path); // re-insert at the end → most-recently-used
			lru.set(path, url);
		}
		return url;
	}
	function lruPut(path: string, url: string): void {
		const prev = lru.get(path);
		if (prev && prev !== url) URL.revokeObjectURL(prev);
		lru.delete(path);
		lru.set(path, url);
		while (lru.size > LRU_MAX) {
			const oldest = lru.keys().next().value as string;
			URL.revokeObjectURL(lru.get(oldest)!);
			lru.delete(oldest);
		}
	}
	function lruClear(): void {
		for (const url of lru.values()) URL.revokeObjectURL(url);
		lru.clear();
	}

	// Encoding type + size are engine/display facts — compute once, lazily (needs the DOM).
	// WebP is smaller but WebKitGTK (Tauri/Linux) silently falls back to PNG, so gate it
	// behind canEncode(); JPEG is the universal fast fallback (paired with a white bg since
	// it has no alpha).
	let _thumbType: 'image/webp' | 'image/jpeg' | null = null;
	function thumbType(): 'image/webp' | 'image/jpeg' {
		if (_thumbType === null) _thumbType = canEncode('image/webp') ? 'image/webp' : 'image/jpeg';
		return _thumbType;
	}
	function thumbSize(): number {
		// The panel preview column renders well under 1024 CSS px; scale by DPR, cap at 1024.
		return Math.min(1024, Math.round(512 * (window.devicePixelRatio || 1)));
	}

	const DEBOUNCE_MS = 180;

	// Native base64 (no per-byte JS loops on the main thread).
	function blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = reader.result as string;
				resolve(dataUrl.slice(dataUrl.indexOf(',') + 1)); // strip "data:<mime>;base64,"
			};
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(blob);
		});
	}
	async function base64ToBlob(base64: string, mime: string): Promise<Blob> {
		const res = await fetch(`data:${mime};base64,${base64}`);
		return res.blob();
	}
</script>

<script lang="ts">
	import { convertFileSrc } from '@tauri-apps/api/core';
	import { activeScan } from '$lib/stores';
	import { getThumbnailFromCache, storeThumbnailInCache } from '$lib/tauri';

	interface Props {
		path: string;
		class?: string;
	}

	let { path, class: className = '' }: Props = $props();

	let thumbUrl = $state<string | null>(null);
	let isLoading = $state(false);
	let error = $state<string | null>(null);

	// Clear the LRU when the scan changes (its cached object URLs belong to the old root).
	let lastScanKey: string | null = null;
	$effect(() => {
		const key = $activeScan?.dbName ?? $activeScan?.id ?? null;
		if (lastScanKey !== null && key !== lastScanKey) {
			lruClear();
			thumbUrl = null;
		}
		lastScanKey = key;
	});

	async function runPipeline(filePath: string, controller: AbortController): Promise<void> {
		try {
			// PGlite cache (over IPC). Keep the previous preview visible during this lookup —
			// only a genuine miss (below) shows the spinner.
			const cached = await getThumbnailFromCache(filePath);
			if (controller.signal.aborted) return;
			if (cached?.thumbnail) {
				const blob = await base64ToBlob(cached.thumbnail, cached.format ?? 'image/png');
				if (controller.signal.aborted) return;
				show(filePath, blob);
				return;
			}

			// Confirmed miss → generation is the slow part; now show the spinner.
			isLoading = true;
			error = null;

			const root = $activeScan?.path;
			const absolutePath = root ? `${root}/${filePath}` : filePath;
			const fileUrl = convertFileSrc(absolutePath);
			const type = thumbType();
			const size = thumbSize();

			// The new library streams from the URL (Range head-sniff; video via <video src>,
			// pdf.js range transport) and honours the signal end-to-end, so aborting actually
			// stops the work.
			const blob = await thumbnail(fileUrl, {
				width: size,
				fit: 'contain',
				type,
				quality: 0.8,
				background: type === 'image/jpeg' ? '#ffffff' : 'transparent',
				signal: controller.signal
			});
			if (controller.signal.aborted) return;
			show(filePath, blob);

			// Persist to the PGlite cache (fire-and-forget). Use the blob's ACTUAL type for the
			// format column (WebKit may have fallen back to PNG despite the request).
			const format = blob.type || type;
			void blobToBase64(blob).then((b64) => {
				if (!controller.signal.aborted) {
					storeThumbnailInCache(filePath, b64, size, size, format);
				}
			});
		} catch (err) {
			if (controller.signal.aborted) return;
			if (err instanceof DOMException && err.name === 'AbortError') return;
			console.error('Thumbnail generation failed:', err);
			error = 'Preview not available';
			isLoading = false;
		}
	}

	/** Show a blob as the preview (via the LRU, so it's reused on re-hover). */
	function show(filePath: string, blob: Blob): void {
		let url = lruGet(filePath);
		if (!url) {
			url = URL.createObjectURL(blob);
			lruPut(filePath, url);
		}
		thumbUrl = url;
		isLoading = false;
		error = null;
	}

	$effect(() => {
		const filePath = path;
		if (!filePath) {
			thumbUrl = null;
			isLoading = false;
			return;
		}

		// In-memory hit → render immediately, no debounce, no flash, no spinner.
		const cachedUrl = lruGet(filePath);
		if (cachedUrl) {
			thumbUrl = cachedUrl;
			isLoading = false;
			error = null;
			return;
		}

		// Miss → keep the previous preview on screen and debounce: only sweep-stable paths
		// (stable ~180 ms) start the pipeline, so rapid boundary crossings do no work.
		const controller = new AbortController();
		const timer = setTimeout(() => void runPipeline(filePath, controller), DEBOUNCE_MS);

		return () => {
			clearTimeout(timer);
			controller.abort(); // with the new library this actually cancels in-flight work
		};
	});
</script>

<div
	class="relative flex h-full w-full items-center justify-center overflow-hidden bg-muted/30 object-contain p-6 {className}"
>
	<!-- Order matters for the no-flash behavior: during the debounce + cache lookup
	     isLoading stays false, so the PREVIOUS thumbUrl keeps showing; only a confirmed
	     miss sets isLoading and swaps in the spinner while the (slow) generation runs. -->
	{#if isLoading}
		<div class="flex flex-col items-center gap-2 text-muted-foreground">
			<div
				class="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary"
			></div>
			<span class="text-sm">Loading preview...</span>
		</div>
	{:else if thumbUrl}
		<img src={thumbUrl} alt="Preview" class="max-h-full shadow-lg" />
	{:else if error}
		<div class="flex flex-col items-center gap-2 p-4 text-center text-muted-foreground">
			<span class="text-3xl">⚠️</span>
			<span class="text-sm">{error}</span>
		</div>
	{/if}
</div>
