<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import {
		formatBytes,
		buildTreeHierarchy,
		getChildren,
		getRootDirectories,
		queryFiles,
		type DirectoryNode,
		type TreeData,
		type FileNode
	} from '$lib/tauri';
	import {
		selectDirectory,
		selectFile,
		hoverDirectory,
		hoverFile,
		clearHoveredItem,
		enrichmentInvalidation
	} from '$lib/stores';
	import { getFileType } from '$lib/file-types';

	// ================================
	// Types
	// ================================

	interface LayoutRect {
		node: DirectoryNode | null;
		file: FileNode | null;
		x: number;
		y: number;
		width: number;
		height: number;
		color: string;
		opacity: number;
		depth: number;
	}

	interface ColorPalette {
		folder: string;
		document: string;
		image: string;
		video: string;
		spreadsheet: string;
		presentation: string;
		publication: string;
		email: string;
		audio: string;
		compressed: string;
		other: string;
		dateOldest: string;
		dateNewest: string;
		enrichDelete: string;
		enrichAlias: string;
		enrichComment: string;
		enrichTag: string;
	}

	// ================================
	// Props
	// ================================

	interface Props {
		data: TreeData | null;
		class?: string;
	}

	let { data, class: className = '' }: Props = $props();

	// ================================
	// State
	// ================================

	let canvas: HTMLCanvasElement | undefined = $state();
	let container: HTMLDivElement | undefined = $state();
	let ctx: CanvasRenderingContext2D | null = $state(null);

	// Canvas dimensions
	let canvasWidth = $state(800);
	let canvasHeight = $state(600);

	// Computed height based on content
	let contentHeight = $state(0);
	let maxDepth = $state(0);

	// Color mode
	let colorMode: 'type' | 'date' = $state('type');

	// Hover state
	let hoveredRect: LayoutRect | null = $state(null);
	let mouseX = $state(0);
	let mouseY = $state(0);

	// Layout cache
	let layoutRects: LayoutRect[] = $state([]);
	let childrenMap: Map<string, DirectoryNode[]> = $state(new Map());

	// Files cache - stores files for each directory path
	let filesCache: SvelteMap<string, FileNode[]> = new SvelteMap();
	let loadingFiles: SvelteSet<string> = new SvelteSet();

	// Constants
	const ROW_HEIGHT = 28;
	const MIN_VISIBLE_WIDTH = 2;
	const PADDING = 1;

	// ================================
	// Lifecycle
	// ================================

	let resizeObserver: ResizeObserver | null = null;

	onMount(() => {
		if (canvas && container) {
			ctx = canvas.getContext('2d');
			// Initialize canvas size immediately
			const rect = container.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			canvasWidth = rect.width * dpr;
			canvasHeight = rect.height * dpr;
			canvas.width = canvasWidth;
			canvas.height = canvasHeight;
			canvas.style.width = `${rect.width}px`;
			canvas.style.height = `${rect.height}px`;
			setupResizeObserver();
			// Initial render
			if (data) {
				childrenMap = buildTreeHierarchy(data.directories);
				computeLayout();
				render();
			}
		}
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
	});

	function setupResizeObserver() {
		if (!container) return;

		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width } = entry.contentRect;
				const dpr = window.devicePixelRatio || 1;
				if (canvas) {
					canvas.width = width * dpr;
					canvasWidth = canvas.width;
					canvas.style.width = `${width}px`;
					// Height will be set based on content
					updateCanvasHeight();
				}
				computeLayout();
				render();
			}
		});

		resizeObserver.observe(container);
	}

	// ================================
	// Color Utilities
	// ================================

	function resolveColors(): ColorPalette {
		const s = getComputedStyle(document.documentElement);
		const v = (name: string) => s.getPropertyValue(name).trim();
		return {
			folder: v('--color-type-folder'),
			document: v('--color-type-document'),
			image: v('--color-type-image'),
			video: v('--color-type-video'),
			spreadsheet: v('--color-type-spreadsheet'),
			presentation: v('--color-type-presentation'),
			publication: v('--color-type-publication'),
			email: v('--color-type-email'),
			audio: v('--color-type-audio'),
			compressed: v('--color-type-compressed'),
			other: v('--color-type-other'),
			dateOldest: v('--color-date-oldest'),
			dateNewest: v('--color-date-newest'),
			enrichDelete: v('--color-enrich-delete'),
			enrichAlias: v('--color-enrich-alias'),
			enrichComment: v('--color-enrich-comment'),
			enrichTag: v('--color-enrich-tag')
		};
	}

	// Ordered enrichment bands present on a node, following v4's order:
	// to-delete, alias, comment, tag. `tagged_for_deletion` already accounts for
	// the ancestor cascade (computed in SQL); alias/comment/tag are per-element.
	function getNodeBands(rect: LayoutRect, palette: ColorPalette): string[] {
		const enr = rect.node ?? rect.file;
		if (!enr) return [];
		const bands: string[] = [];
		if (enr.tagged_for_deletion) bands.push(palette.enrichDelete);
		if (enr.alias) bands.push(palette.enrichAlias);
		if (enr.has_comment) bands.push(palette.enrichComment);
		if (enr.has_tag) bands.push(palette.enrichTag);
		return bands;
	}

	function computeMtimeRange(): [number, number] {
		let min = Infinity;
		let max = -Infinity;
		for (const files of filesCache.values()) {
			for (const f of files) {
				if (f.mtime < min) min = f.mtime;
				if (f.mtime > max) max = f.mtime;
			}
		}
		return [min === Infinity ? 0 : min, max === -Infinity ? 0 : max];
	}

	function hexToRgb(hex: string): [number, number, number] {
		const n = parseInt(hex.replace('#', ''), 16);
		return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
	}

	/** Parse '#rrggbb' or 'rgb(r,g,b)' into [r,g,b]. */
	function parseRgb(color: string): [number, number, number] {
		if (color.startsWith('#')) return hexToRgb(color);
		const m = color.match(/\d+/g);
		return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [128, 128, 128];
	}

	/**
	 * A 1px separator color that contrasts with the given fill, so enrichment
	 * bands stay legible even when a band's hue matches the fill — e.g. the red
	 * deletion band on a red .pdf block. White on dark fills, dark on light fills.
	 */
	function bandSeparatorColor(fill: string): string {
		const [r, g, b] = parseRgb(fill);
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		return luminance < 140 ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.55)';
	}

	function interpolateHex(t: number, from: string, to: string): string {
		const [r1, g1, b1] = hexToRgb(from);
		const [r2, g2, b2] = hexToRgb(to);
		return `rgb(${Math.round(r1 + (r2 - r1) * t)}, ${Math.round(g1 + (g2 - g1) * t)}, ${Math.round(b1 + (b2 - b1) * t)})`;
	}

	type PaletteTypeKey = keyof Omit<ColorPalette, 'dateOldest' | 'dateNewest'>;

	function getTypeColorFor(filename: string, palette: ColorPalette): string {
		const type = getFileType(filename) as PaletteTypeKey;
		return palette[type];
	}

	function getDateColor(mtime: number, min: number, max: number, palette: ColorPalette): string {
		if (min === max) return palette.other;
		const t = Math.max(0, Math.min(1, (mtime - min) / (max - min)));
		return interpolateHex(t, palette.dateOldest, palette.dateNewest);
	}

	function getNodeColor(
		file: FileNode | null,
		dir: DirectoryNode | null,
		palette: ColorPalette,
		minMtime: number,
		maxMtime: number
	): string {
		if (dir !== null) return palette.folder;
		if (file === null) return palette.other;
		if (colorMode === 'date') return getDateColor(file.mtime, minMtime, maxMtime, palette);
		return getTypeColorFor(file.name, palette);
	}

	function lightenColor(color: string, amount: number): string {
		if (color.startsWith('#')) {
			const num = parseInt(color.slice(1), 16);
			const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amount));
			const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amount));
			const b = Math.min(255, (num & 0xff) + Math.round(255 * amount));
			return `rgb(${r}, ${g}, ${b})`;
		}
		if (color.startsWith('rgb')) {
			const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
			if (m) {
				const r = Math.min(255, parseInt(m[1]) + Math.round(255 * amount));
				const g = Math.min(255, parseInt(m[2]) + Math.round(255 * amount));
				const b = Math.min(255, parseInt(m[3]) + Math.round(255 * amount));
				return `rgb(${r}, ${g}, ${b})`;
			}
		}
		return color;
	}

	// ================================
	// Layout Computation
	// ================================

	// Derive childrenMap from data (no effect needed)
	let childrenMapDerived = $derived(data ? buildTreeHierarchy(data.directories) : new Map());

	// Track data changes manually to reset view
	let lastDataId: string | null = null;

	function updateForNewData() {
		if (!data) return;

		const dataId = data.root ?? 'unknown';
		if (dataId !== lastDataId) {
			lastDataId = dataId;
			childrenMap = childrenMapDerived;
			filesCache = new SvelteMap();
			loadingFiles = new SvelteSet();
		} else {
			childrenMap = childrenMapDerived;
		}

		if (ctx && canvasWidth > 0) {
			computeLayout();
			updateCanvasHeight();
			render();
			// Load files for all directories
			loadFilesForAllDirectories();
		}
	}

	// Call updateForNewData when component renders with new data
	$effect.pre(() => {
		// Only read data, don't write reactive state here
		// Schedule update outside of effect
		if (data) {
			requestAnimationFrame(updateForNewData);
		}
	});

	async function loadFilesForDirectory(dirPath: string) {
		// Skip if already loading or cached
		if (loadingFiles.has(dirPath) || filesCache.has(dirPath)) {
			return;
		}

		loadingFiles.add(dirPath);

		try {
			const filesData = await queryFiles(dirPath, 1000);
			if (filesData && filesData.files.length > 0) {
				const files = filesData.files.filter((f) => !f.is_directory);
				filesCache.set(dirPath, files);
				computeLayout();
				render();
			} else {
				filesCache.set(dirPath, []);
			}
		} catch (e) {
			console.error('Failed to load files for', dirPath, e);
			filesCache.set(dirPath, []);
		} finally {
			loadingFiles.delete(dirPath);
		}
	}

	function loadFilesForAllDirectories() {
		if (!data) return;

		// Load root files
		loadFilesForDirectory('');

		// Load files for ALL directories to show complete structure
		for (const dir of data.directories) {
			loadFilesForDirectory(dir.path);
		}
	}

	/**
	 * Re-fetch a directory's files in place (bypassing the cache guard) so their
	 * enrichment flags refresh after an edit. Only refreshes directories already
	 * loaded, so nothing visible flickers out.
	 */
	async function refreshFilesForDirectory(dirPath: string): Promise<void> {
		if (!filesCache.has(dirPath)) return;
		try {
			const filesData = await queryFiles(dirPath, 1000);
			const files = (filesData?.files ?? []).filter((f) => !f.is_directory);
			filesCache.set(dirPath, files);
		} catch (e) {
			console.error('Failed to refresh files for', dirPath, e);
		}
	}

	// React to enrichment edits: re-read the affected file rows from PGlite and
	// redraw. Directory nodes are refreshed separately by the page re-querying the
	// tree. Depends only on the invalidation signal (DB reads are untracked to
	// avoid re-running when filesCache mutates).
	$effect(() => {
		const inv = $enrichmentInvalidation;
		if (!inv) return;
		untrack(() => {
			const lastSlash = inv.path.lastIndexOf('/');
			const parent = lastSlash >= 0 ? inv.path.slice(0, lastSlash) : '';
			const toRefresh = new Set<string>([parent]);
			if (inv.cascade) {
				// Deletion cascades to descendants: refresh every loaded page under it.
				const prefix = inv.path + '/';
				for (const key of filesCache.keys()) {
					if (key === inv.path || key.startsWith(prefix)) toRefresh.add(key);
				}
			}
			void Promise.all([...toRefresh].map(refreshFilesForDirectory)).then(() => {
				if (ctx) {
					computeLayout();
					render();
				}
			});
		});
	});

	function updateCanvasHeight() {
		if (!canvas || !container) return;

		const dpr = window.devicePixelRatio || 1;
		// Calculate height based on max depth, minimum 1 row
		const rows = Math.max(1, maxDepth + 1);
		contentHeight = rows * ROW_HEIGHT;

		const newHeight = contentHeight * dpr;
		if (canvas.height !== newHeight) {
			canvas.height = newHeight;
			canvasHeight = newHeight;
		}
	}

	function computeLayout() {
		if (!data) {
			layoutRects = [];
			maxDepth = 0;
			return;
		}

		const palette = resolveColors();
		const [minMtime, maxMtime] = computeMtimeRange();

		// If no directories, layout root files instead
		if (data.directories.length === 0) {
			const rootFilesList = filesCache.get('') || [];
			if (rootFilesList.length > 0) {
				computeFilesOnlyLayout(rootFilesList, palette, minMtime, maxMtime);
			} else {
				layoutRects = [];
				maxDepth = 0;
			}
			return;
		}

		const dpr = window.devicePixelRatio || 1;
		const viewWidth = canvasWidth / dpr;

		if (viewWidth === 0) {
			layoutRects = [];
			return;
		}

		let currentMaxDepth = 0;

		const rects: LayoutRect[] = [];

		// Determine starting directories based on focus
		let startDirs: DirectoryNode[];
		let startDepth: number;

		// Always start from root to show complete structure
		startDirs = getRootDirectories(data.directories);
		startDepth = startDirs.length > 0 ? startDirs[0].depth : 0;

		const totalSize = startDirs.reduce((sum, d) => sum + d.total_size, 0);
		if (totalSize === 0) {
			layoutRects = rects;
			return;
		}

		// Initial layout of root level directories and files
		function layoutRootLevel(dirs: DirectoryNode[], x: number, width: number, depth: number) {
			const rootFiles = filesCache.get('') || [];
			layoutChildrenAndFiles(dirs, rootFiles, x, width, depth);
		}

		// Layout both subdirectories and files together at the same level
		function layoutChildrenAndFiles(
			dirs: DirectoryNode[],
			files: FileNode[],
			x: number,
			width: number,
			depth: number
		) {
			const levelIndex = depth - startDepth;
			const y = levelIndex * ROW_HEIGHT;

			// Track max depth
			if (levelIndex > currentMaxDepth) {
				currentMaxDepth = levelIndex;
			}

			// Calculate total size including both dirs and files
			const dirsSize = dirs.reduce((sum, d) => sum + d.total_size, 0);
			const filesSize = files.reduce((sum, f) => sum + f.size, 0);
			const totalSize = dirsSize + filesSize;

			if (totalSize === 0) return;

			let currentX = x;

			// Layout directories first
			for (const dir of dirs) {
				const nodeWidth = (dir.total_size / totalSize) * width;

				if (nodeWidth >= MIN_VISIBLE_WIDTH) {
					rects.push({
						node: dir,
						file: null,
						x: currentX,
						y,
						width: nodeWidth - PADDING,
						height: ROW_HEIGHT - PADDING,
						color: getNodeColor(null, dir, palette, minMtime, maxMtime),
						opacity: 1,
						depth: levelIndex
					});

					// Recursively layout this directory's children
					const subChildren = getChildren(dir.path, childrenMap);
					const subFiles = filesCache.get(dir.path) || [];
					if (subChildren.length > 0 || subFiles.length > 0) {
						layoutChildrenAndFiles(subChildren, subFiles, currentX, nodeWidth, depth + 1);
					}
				}

				currentX += nodeWidth;
			}

			// Then layout files
			for (const file of files) {
				const fileWidth = (file.size / totalSize) * width;

				if (fileWidth >= MIN_VISIBLE_WIDTH) {
					rects.push({
						node: null,
						file: file,
						x: currentX,
						y,
						width: fileWidth - PADDING,
						height: ROW_HEIGHT - PADDING,
						color: getNodeColor(file, null, palette, minMtime, maxMtime),
						opacity: 1,
						depth: levelIndex
					});
				}

				currentX += fileWidth;
			}
		}

		layoutRootLevel(startDirs, 0, viewWidth, startDepth);
		layoutRects = rects;
		maxDepth = currentMaxDepth;
	}

	function computeFilesOnlyLayout(
		files: FileNode[],
		palette: ColorPalette,
		minMtime: number,
		maxMtime: number
	) {
		const dpr = window.devicePixelRatio || 1;
		const viewWidth = canvasWidth / dpr;
		const viewHeight = canvasHeight / dpr;

		if (viewWidth === 0 || viewHeight === 0 || files.length === 0) {
			layoutRects = [];
			return;
		}

		const rects: LayoutRect[] = [];
		const totalSize = files.reduce((sum, f) => sum + f.size, 0);

		if (totalSize === 0) {
			layoutRects = [];
			maxDepth = 0;
			return;
		}

		maxDepth = 0; // Files only = single row

		let currentX = 0;
		for (const file of files) {
			const fileWidth = (file.size / totalSize) * viewWidth;

			if (fileWidth >= MIN_VISIBLE_WIDTH) {
				rects.push({
					node: null,
					file: file,
					x: currentX,
					y: 0,
					width: fileWidth - PADDING,
					height: ROW_HEIGHT - PADDING,
					color: getNodeColor(file, null, palette, minMtime, maxMtime),
					opacity: 1,
					depth: 0
				});
			}

			currentX += fileWidth;
		}

		layoutRects = rects;
	}

	function setColorMode(mode: 'type' | 'date') {
		colorMode = mode;
		computeLayout();
		updateCanvasHeight();
		render();
	}

	// ================================
	// Rendering
	// ================================

	function render() {
		if (!ctx || !canvas || canvasWidth === 0 || canvasHeight === 0) return;

		const dpr = window.devicePixelRatio || 1;
		const viewWidth = canvasWidth / dpr;
		const viewHeight = canvasHeight / dpr;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Clear canvas with transparent background
		ctx.clearRect(0, 0, viewWidth, viewHeight);

		if (layoutRects.length === 0) {
			// Show empty state
			ctx.fillStyle = '#64748b';
			ctx.font = '14px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';

			let msg: string;
			if (!data) {
				msg = 'No data to display';
			} else if (data.directories.length === 0 && !filesCache.has('')) {
				msg = 'Loading files...';
			} else if (data.directories.length === 0 && (filesCache.get('') || []).length === 0) {
				msg = 'No files to visualize';
			} else {
				msg = 'Loading...';
			}

			ctx.fillText(msg, viewWidth / 2, viewHeight / 2);
			return;
		}

		// Draw rectangles
		ctx.save();

		// Enrichment band colors (resolved once per render).
		const bandPalette = resolveColors();

		// Draw each rectangle
		for (const rect of layoutRects) {
			const rectPath = rect.node?.path ?? rect.file?.path ?? '';
			const isHovered =
				hoveredRect && (hoveredRect.node?.path ?? hoveredRect.file?.path) === rectPath;

			// Draw background
			ctx.fillStyle = isHovered ? lightenColor(rect.color, 0.15) : rect.color;
			ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

			// Draw border
			ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
			ctx.lineWidth = 1;
			ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

			// Draw enrichment bands (v4 layout): stacked strips from the top edge,
			// each occupying dy/heightDivider so they never cover more than half the
			// block and the underlying type/date fill stays visible.
			if (rect.width > 4 && rect.height > 6) {
				const bands = getNodeBands(rect, bandPalette);
				if (bands.length > 0) {
					const heightDivider = Math.max(bands.length * 2, 3);
					const bandHeight = rect.height / heightDivider;
					const bandWidth = rect.width - 2;
					for (let i = 0; i < bands.length; i++) {
						ctx.fillStyle = bands[i];
						ctx.fillRect(rect.x + 1, rect.y + 1 + i * bandHeight, bandWidth, bandHeight);
					}
					// Contrast-aware hairlines between bands and below the band stack, so each
					// band reads as a distinct strip even when its hue matches the fill (the red
					// deletion band on a red .pdf block was invisible without this).
					ctx.strokeStyle = bandSeparatorColor(
						isHovered ? lightenColor(rect.color, 0.15) : rect.color
					);
					ctx.lineWidth = 1;
					ctx.beginPath();
					for (let i = 1; i <= bands.length; i++) {
						const y = Math.round(rect.y + 1 + i * bandHeight) + 0.5;
						ctx.moveTo(rect.x + 1, y);
						ctx.lineTo(rect.x + 1 + bandWidth, y);
					}
					ctx.stroke();
				}
			}

			// Draw text if there's enough space
			const scaledWidth = rect.width;
			const scaledHeight = rect.height;

			if (scaledWidth > 40 && scaledHeight > 14) {
				ctx.fillStyle = '#ffffff';
				const fontSize = Math.min(12, rect.height - 4);
				ctx.font = `${fontSize}px system-ui, sans-serif`;
				ctx.textAlign = 'left';
				ctx.textBaseline = 'middle';

				// Prefer the alias over the real name for display (alias renames the
				// display without changing the real file name).
				const enr = rect.node ?? rect.file;
				const text = enr?.alias ?? enr?.name ?? '';
				const maxWidth = rect.width - 8;
				const textWidth = ctx.measureText(text).width;

				let displayText = text;
				if (textWidth > maxWidth) {
					// Truncate with ellipsis
					let truncated = text;
					while (truncated.length > 0 && ctx.measureText(truncated + '…').width > maxWidth) {
						truncated = truncated.slice(0, -1);
					}
					displayText = truncated + '…';
				}

				if (displayText.length > 1) {
					ctx.fillText(displayText, rect.x + 4, rect.y + rect.height / 2);
				}
			}
		}

		ctx.restore();
	}

	// ================================
	// Hit Testing
	// ================================

	function findRectAt(screenX: number, screenY: number): LayoutRect | null {
		// Use screen coordinates directly (no pan/zoom)
		const x = screenX;
		const y = screenY;

		// Check rectangles in reverse order (top-most first)
		// Search in reverse (topmost first)
		for (let i = layoutRects.length - 1; i >= 0; i--) {
			const rect = layoutRects[i];
			if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
				return rect;
			}
		}
		return null;
	}

	// ================================
	// Event Handlers
	// ================================

	function handleMouseMove(e: MouseEvent) {
		if (!canvas) return;

		const rect = canvas.getBoundingClientRect();
		mouseX = e.clientX - rect.left;
		mouseY = e.clientY - rect.top;

		// Hit test for hover
		const hit = findRectAt(mouseX, mouseY);
		if (hit !== hoveredRect) {
			hoveredRect = hit;
			render();

			// Update hover stores for drawer preview
			if (hit) {
				const centerX = hit.x + hit.width / 2;
				if (hit.node) {
					hoverDirectory(hit.node, centerX);
				} else if (hit.file) {
					hoverFile(hit.file, centerX);
				}
			} else {
				clearHoveredItem();
			}
		}
	}

	function handleMouseLeave() {
		hoveredRect = null;
		clearHoveredItem();
		render();
	}

	function handleClick(e: MouseEvent) {
		if (!canvas) return;

		const rect = canvas.getBoundingClientRect();
		const clickX = e.clientX - rect.left;
		const clickY = e.clientY - rect.top;

		const hit = findRectAt(clickX, clickY);
		if (hit) {
			// Calculate center X of the selected item (in screen coordinates)
			const centerX = hit.x + hit.width / 2;
			if (hit.node) {
				selectDirectory(hit.node, centerX);
			} else if (hit.file) {
				selectFile(hit.file, centerX);
			}
		}
	}
</script>

<div class="w-full {className}">
	<!-- Color mode toggle -->
	<div class="flex justify-end px-2 pb-1">
		<div class="flex items-center gap-0.5 rounded-lg bg-muted p-[3px]">
			<button
				class="cursor-pointer rounded-md border-none px-2.5 py-[5px] text-xs font-medium transition-all {colorMode === 'type' ? 'bg-background text-foreground shadow-sm' : 'bg-transparent text-muted-foreground'}"
				onclick={() => setColorMode('type')}
			>Type</button>
			<button
				class="cursor-pointer rounded-md border-none px-2.5 py-[5px] text-xs font-medium transition-all {colorMode === 'date' ? 'bg-background text-foreground shadow-sm' : 'bg-transparent text-muted-foreground'}"
				onclick={() => setColorMode('date')}
			>Date</button>
		</div>
	</div>

	<!-- Chart container -->
	<div bind:this={container} class="w-full">
		<div class="relative w-full">
			<canvas
				bind:this={canvas}
				onmousemove={handleMouseMove}
				onmouseleave={handleMouseLeave}
				onclick={handleClick}
				class="block w-full cursor-pointer"
				style="height: {contentHeight}px;"
			></canvas>
		</div>
	</div>
</div>
