<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import {
		formatBytes,
		buildTreeHierarchy,
		getChildren,
		queryFiles,
		setDeleteTag,
		removeDeleteTag,
		getElementEnrichment,
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
		invalidateEnrichment,
		enrichmentInvalidation,
		selectedItem
	} from '$lib/stores';
	import { getFileType } from '$lib/file-types';
	import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
	import { LogicalPosition } from '@tauri-apps/api/dpi';

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
		/** Provisional (live-scan) mode: render the streamed directory tree only;
		 *  do NOT query files (the DB is being written and can't be read). */
		provisional?: boolean;
	}

	let { data, class: className = '', provisional = false }: Props = $props();

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

	// Fixed-viewport zoom/pan. The canvas is a window onto content-space; the
	// wheel zooms toward the cursor and dragging pans. zoom = 1 fits the current
	// root to the viewport width (the floor — you can't dezoom past "see the whole
	// root"). Zoom applies to the BREADTH axis only: screenX = contentX * zoom +
	// panX, while rows keep a constant height (screenY = contentY + panY) so the
	// depth levels stay legible at any zoom; vertical pan scrolls through levels.
	let canvasWrapper: HTMLDivElement | undefined = $state();
	let viewportHeight = $state(0);
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	const MIN_ZOOM = 1;
	const MAX_ZOOM = 40;
	// Panning is possible only when zoomed in or the tree overflows the viewport
	// vertically; otherwise the whole tree fits and there's nothing to drag, so
	// the grab cursor would be lying.
	let canPan = $derived(zoom > MIN_ZOOM + 1e-3 || contentHeight > viewportHeight);
	// Pointer state: pan on drag, select on a click that didn't drag.
	let pointerDown = $state(false);
	let dragged = false;
	let pointerStartX = 0;
	let pointerStartY = 0;
	let panStartX = 0;
	let panStartY = 0;

	// Color mode
	let colorMode: 'type' | 'date' = $state('type');

	// Path of the current selection. Non-empty → spotlight that subtree (the node
	// and its descendants stay vivid, the rest of the chart dims into context).
	// '' (root) or null (nothing selected) → no dimming, the whole chart is lit.
	let selectedPath = $derived($selectedItem?.path ?? null);
	$effect(() => {
		selectedPath; // re-render when the selection changes
		render();
	});

	// Returning to the home state (root selected, e.g. via the panel's × ) eases
	// the finder back out to the whole tree.
	$effect(() => {
		if (($selectedItem?.path ?? null) === '') snapToRoot();
	});

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
		if (canvas && canvasWrapper) {
			ctx = canvas.getContext('2d');
			// Initialise canvas to the viewport (the wrapper), not the content.
			const rect = canvasWrapper.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			canvasWidth = rect.width * dpr;
			canvasHeight = rect.height * dpr;
			viewportHeight = rect.height;
			canvas.width = canvasWidth;
			canvas.height = canvasHeight;
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
		if (snapTimer) clearTimeout(snapTimer);
		if (animFrame) cancelAnimationFrame(animFrame);
	});

	function setupResizeObserver() {
		if (!canvasWrapper) return;

		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				const dpr = window.devicePixelRatio || 1;
				if (canvas && width > 0 && height > 0) {
					canvas.width = Math.round(width * dpr);
					canvas.height = Math.round(height * dpr);
					canvasWidth = canvas.width;
					canvasHeight = canvas.height;
					viewportHeight = height;
				}
				computeLayout();
				clampView();
				render();
			}
		});

		resizeObserver.observe(canvasWrapper);
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
			// Fresh tree → reset the view to fully zoomed out (root fills the width).
			zoom = 1;
			panX = 0;
			panY = 0;
		} else {
			childrenMap = childrenMapDerived;
		}

		if (ctx && canvasWidth > 0) {
			computeLayout();
			updateCanvasHeight();
			clampView();
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
				// Async file loading can deepen the tree (new rows); refresh the content
				// metric and re-clamp the pan so deeper rows stay reachable.
				updateCanvasHeight();
				clampView();
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
		if (!data || provisional) return; // provisional: dirs-only, the DB isn't readable mid-scan

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
		if (!inv || provisional) return; // no DB queries while a scan is writing
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
					updateCanvasHeight();
					clampView();
					render();
				}
			});
		});
	});

	// Content metric only (CSS px). The canvas itself is the viewport (sized by
	// the resize observer); this is the full height of the laid-out content,
	// used to clamp panning so you can't drag the tree off-screen.
	function updateCanvasHeight() {
		const rows = Math.max(1, maxDepth + 1);
		contentHeight = rows * ROW_HEIGHT;
	}

	// ================================
	// Zoom / pan (fixed viewport)
	// ================================

	function viewportCss(): { w: number; h: number } {
		const dpr = window.devicePixelRatio || 1;
		return { w: canvasWidth / dpr, h: canvasHeight / dpr };
	}

	// Keep the content anchored to the viewport: no zooming below MIN_ZOOM, and
	// no panning that pulls a content edge inside the viewport (centre if smaller).
	function clampView() {
		zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
		const { w: vw, h: vh } = viewportCss();
		const scaledW = vw * zoom; // content width == viewport width at zoom 1
		const scaledH = contentHeight; // rows are fixed-height; Y is not zoomed
		panX = scaledW <= vw ? (vw - scaledW) / 2 : Math.min(0, Math.max(vw - scaledW, panX));
		panY = scaledH <= vh ? 0 : Math.min(0, Math.max(vh - scaledH, panY));
	}

	// The selection conduit is the elastic joint: as the view zooms/pans, re-read
	// the selected block's on-screen span so the panel ribbon tracks it live.
	// ── Magnetic snap ────────────────────────────────────────────────────────
	// On release (wheel idle / drag end) the view eases into the nearest clean
	// frame — a directory filling the width with its row at the top. The target
	// is the directory under the viewport centre whose "fill" zoom is closest
	// (in log space) to the current zoom, so you snap in or out to whichever
	// folder you're nearest; the root frame (zoom 1) is always a candidate.
	const SNAP_DELAY = 180;
	let snapTimer: ReturnType<typeof setTimeout> | null = null;
	let animFrame: number | null = null;

	function computeSnapTarget(): { zoom: number; panX: number; panY: number } {
		const vw = viewportCss().w;
		if (vw <= 0 || layoutRects.length === 0) return { zoom: MIN_ZOOM, panX: 0, panY: 0 };
		const centerXContent = (vw / 2 - panX) / zoom;
		const logZoom = Math.log(zoom);
		// Root frame (whole tree) is always in the running.
		let best = { zoom: MIN_ZOOM, panX: 0, panY: 0 };
		let bestDist = Math.abs(Math.log(MIN_ZOOM) - logZoom);
		for (const rect of layoutRects) {
			if (!rect.node) continue; // directories are the frames
			if (centerXContent < rect.x || centerXContent > rect.x + rect.width) continue;
			const fz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vw / rect.width));
			const dist = Math.abs(Math.log(fz) - logZoom);
			if (dist < bestDist) {
				bestDist = dist;
				best = { zoom: fz, panX: -rect.x * fz, panY: -rect.y };
			}
		}
		return best;
	}

	function cancelAnim() {
		if (animFrame) {
			cancelAnimationFrame(animFrame);
			animFrame = null;
		}
	}

	function animateTo(target: { zoom: number; panX: number; panY: number }) {
		cancelAnim();
		const start = { zoom, panX, panY };
		const t0 = performance.now();
		const DUR = 260;
		const ease = (t: number) => 1 - Math.pow(1 - t, 3); // ease-out cubic
		const lz0 = Math.log(start.zoom);
		const lz1 = Math.log(target.zoom);
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / DUR);
			const e = ease(t);
			zoom = Math.exp(lz0 + (lz1 - lz0) * e); // zoom interpolates in log space
			panX = start.panX + (target.panX - start.panX) * e;
			panY = start.panY + (target.panY - start.panY) * e;
			clampView();
			render();
			animFrame = t < 1 ? requestAnimationFrame(step) : null;
		};
		animFrame = requestAnimationFrame(step);
	}

	function scheduleSnap() {
		if (snapTimer) clearTimeout(snapTimer);
		snapTimer = setTimeout(() => {
			snapTimer = null;
			animateTo(computeSnapTarget());
		}, SNAP_DELAY);
	}

	// Ease the finder back out to the whole tree (the home view).
	function snapToRoot() {
		if (snapTimer) {
			clearTimeout(snapTimer);
			snapTimer = null;
		}
		animateTo({ zoom: MIN_ZOOM, panX: 0, panY: 0 });
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		if (!canvas) return;
		cancelAnim(); // user took over mid-snap
		const r = canvas.getBoundingClientRect();
		const px = e.clientX - r.left;
		const factor = Math.exp(-e.deltaY * 0.0015);
		const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
		const k = newZoom / zoom;
		// Keep the point under the cursor fixed while scaling the breadth axis.
		// Y isn't zoomed (fixed-height rows), so panY stays put — only panX shifts.
		panX = px - (px - panX) * k;
		zoom = newZoom;
		clampView();
		render();
		scheduleSnap(); // settle into the nearest frame once scrolling stops
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

		// Start from the TRUE top-level directories (those whose parent is the
		// scanned root) using the path-based hierarchy. The backend's `depth` field
		// is unreliable (currently 0 for every dir), so getRootDirectories would
		// treat nested dirs as roots and lay each one out twice — once nested, once
		// flattened at the top. childrenMap[''] holds exactly the real top level.
		const startDirs: DirectoryNode[] = getChildren('', childrenMap);
		const startDepth = 0;

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
		clampView();
		render();
	}

	// ================================
	// Rendering
	// ================================

	// The connector ribbon, drawn on the canvas BEHIND the blocks so it never
	// covers a selected folder's children — it shows in the gaps and the seam and
	// grows out of the item. Colour comes from the item (strongest at the item,
	// fading into the panel below). A leaf curves straight out of the item; a
	// directory holds its width as a column behind its subtree, then flares.
	function drawConnector(dpr: number, vw: number, vh: number) {
		if (!ctx) return;
		const path = selectedPath;
		if (!path) return; // root / nothing selected → no connector
		const rect = layoutRects.find((r) => (r.node?.path ?? r.file?.path) === path);
		if (!rect) return;

		const itemLeft = rect.x * zoom + panX;
		const itemRight = (rect.x + rect.width) * zoom + panX;
		const itemBottom = rect.y + rect.height + panY; // rows are fixed-height (no zoom on Y)

		// The column extends only while there's a subtree to thread behind.
		let subBottom = itemBottom;
		if (rect.node) {
			for (const r of layoutRects) {
				const p = r.node?.path ?? r.file?.path ?? '';
				if (p === path || p.startsWith(path + '/')) {
					subBottom = Math.max(subBottom, r.y + r.height + panY);
				}
			}
		}
		const stemBottom = Math.max(itemBottom, Math.min(subBottom, vh));
		const flareH = Math.max(0, vh - stemBottom);
		const k = flareH * 0.5; // vertical tangents for the flare

		const [cr, cg, cb] = parseRgb(rect.color);
		const grad = ctx.createLinearGradient(0, Math.max(0, itemBottom), 0, vh);
		grad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.5)`); // from the item
		grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0.04)`); // into the panel

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = grad;
		ctx.beginPath();
		ctx.moveTo(itemLeft, itemBottom);
		ctx.lineTo(itemLeft, stemBottom);
		ctx.bezierCurveTo(itemLeft, stemBottom + k, 0, vh - k, 0, vh);
		ctx.lineTo(vw, vh);
		ctx.bezierCurveTo(vw, vh - k, itemRight, stemBottom + k, itemRight, stemBottom);
		ctx.lineTo(itemRight, itemBottom);
		ctx.closePath();
		ctx.fill();
	}

	function render() {
		if (!ctx || !canvas || canvasWidth === 0 || canvasHeight === 0) return;

		const dpr = window.devicePixelRatio || 1;
		const viewWidth = canvasWidth / dpr;
		const viewHeight = canvasHeight / dpr;

		// Clear the whole viewport (device space), then apply the zoom/pan view
		// transform so all content-space drawing below lands in the right place.
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvasWidth, canvasHeight);
		// Blocks are drawn in screen space (CSS px) under a uniform device transform;
		// zoom is baked into X coordinates per block, Y stays fixed-height.
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		if (layoutRects.length === 0) {
			// Show empty state (in untransformed viewport space, centred)
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

		// Connector first, so the blocks paint over it (it stays in the background).
		drawConnector(dpr, viewWidth, viewHeight);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Draw rectangles
		ctx.save();

		// Enrichment band colors (resolved once per render).
		const bandPalette = resolveColors();

		// Draw each rectangle. Coordinates are computed in screen space (CSS px):
		// X carries the zoom (breadth), Y is a fixed-height row (depth), so strokes
		// and labels stay crisp at any zoom.
		for (const rect of layoutRects) {
			const sx = rect.x * zoom + panX;
			const sw = rect.width * zoom;
			const sy = rect.y + panY; // rows keep a constant height regardless of zoom
			const sh = rect.height;

			// Cull blocks entirely off the left/right of the viewport.
			if (sx + sw < 0 || sx > viewWidth) continue;

			const rectPath = rect.node?.path ?? rect.file?.path ?? '';
			const isHovered =
				hoveredRect && (hoveredRect.node?.path ?? hoveredRect.file?.path) === rectPath;

			// Spotlight the selected subtree: when a non-root node is selected, dim
			// everything outside it (the node itself and its descendants stay vivid).
			const inSelection =
				!selectedPath ||
				rectPath === selectedPath ||
				rectPath.startsWith(selectedPath + '/');
			ctx.globalAlpha = inSelection ? 1 : 0.35;

			// Draw background
			ctx.fillStyle = isHovered ? lightenColor(rect.color, 0.15) : rect.color;
			ctx.fillRect(sx, sy, sw, sh);

			// Draw border (uniform 1px — the view transform no longer scales it)
			ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
			ctx.lineWidth = 1;
			ctx.strokeRect(sx, sy, sw, sh);

			// Draw enrichment bands (v4 layout): stacked strips from the top edge,
			// each occupying dy/heightDivider so they never cover more than half the
			// block and the underlying type/date fill stays visible.
			if (sw > 4 && sh > 6) {
				const bands = getNodeBands(rect, bandPalette);
				if (bands.length > 0) {
					const heightDivider = Math.max(bands.length * 2, 3);
					const bandHeight = sh / heightDivider;
					const bandWidth = sw - 2;
					for (let i = 0; i < bands.length; i++) {
						ctx.fillStyle = bands[i];
						ctx.fillRect(sx + 1, sy + 1 + i * bandHeight, bandWidth, bandHeight);
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
						const y = Math.round(sy + 1 + i * bandHeight) + 0.5;
						ctx.moveTo(sx + 1, y);
						ctx.lineTo(sx + 1 + bandWidth, y);
					}
					ctx.stroke();
				}
			}

			// Draw text if there's enough space ON SCREEN — labels reveal as you
			// zoom in (progressive disclosure), so a block too narrow for its name
			// at one zoom shows it once magnified.
			if (sw > 40 && sh > 14) {
				ctx.fillStyle = '#ffffff';
				const fontSize = Math.min(12, sh - 4);
				ctx.font = `${fontSize}px system-ui, sans-serif`;
				ctx.textAlign = 'left';
				ctx.textBaseline = 'middle';

				// Prefer the alias over the real name for display (alias renames the
				// display without changing the real file name).
				const enr = rect.node ?? rect.file;
				const text = enr?.alias ?? enr?.name ?? '';
				const maxWidth = sw - 8;
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
					ctx.fillText(displayText, sx + 4, sy + sh / 2);
				}
			}
		}

		ctx.restore();
	}

	// ================================
	// Hit Testing
	// ================================

	function findRectAt(contentX: number, contentY: number): LayoutRect | null {
		// Coordinates are in content space (the caller inverts the view transform).
		// Search in reverse (topmost first).
		for (let i = layoutRects.length - 1; i >= 0; i--) {
			const rect = layoutRects[i];
			if (
				contentX >= rect.x &&
				contentX <= rect.x + rect.width &&
				contentY >= rect.y &&
				contentY <= rect.y + rect.height
			) {
				return rect;
			}
		}
		return null;
	}

	// Screen (canvas CSS px) → content space, inverting the zoom/pan transform.
	function toContent(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const r = canvas!.getBoundingClientRect();
		return {
			x: (e.clientX - r.left - panX) / zoom,
			y: e.clientY - r.top - panY // Y isn't zoomed (fixed-height rows)
		};
	}

	// ================================
	// Event Handlers
	// ================================

	const DRAG_THRESHOLD = 4; // px before a press becomes a pan rather than a click

	function handlePointerDown(e: PointerEvent) {
		if (!canvas) return;
		if (e.button !== 0) return; // primary button only; right-click opens the menu
		cancelAnim(); // grabbing interrupts a snap in progress
		if (snapTimer) {
			clearTimeout(snapTimer);
			snapTimer = null;
		}
		pointerDown = true;
		dragged = false;
		pointerStartX = e.clientX;
		pointerStartY = e.clientY;
		panStartX = panX;
		panStartY = panY;
		canvas.setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!canvas) return;

		if (pointerDown) {
			const dx = e.clientX - pointerStartX;
			const dy = e.clientY - pointerStartY;
			if (!dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD) dragged = true;
			if (dragged) {
				panX = panStartX + dx;
				panY = panStartY + dy;
				clampView();
				render();
				return;
			}
		}

		// Hover hit-test (content space)
		const { x, y } = toContent(e);
		const hit = findRectAt(x, y);
		if (hit !== hoveredRect) {
			hoveredRect = hit;
			render();
			if (hit) {
				if (hit.node) hoverDirectory(hit.node);
				else if (hit.file) hoverFile(hit.file);
			} else {
				clearHoveredItem();
			}
		}
	}

	function handlePointerUp(e: PointerEvent) {
		// Ignore stray ups (e.g. the right-click that opened the native menu, whose
		// up the menu swallowed) — only finish a gesture we actually started.
		if (!canvas || !pointerDown) return;
		canvas.releasePointerCapture(e.pointerId);
		const wasDrag = dragged;
		pointerDown = false;
		dragged = false;
		if (wasDrag) {
			scheduleSnap(); // settle the pan into the nearest frame
			return; // a pan, not a selection
		}

		// Click → select the block under the pointer.
		const { x, y } = toContent(e);
		const hit = findRectAt(x, y);
		if (hit) {
			if (hit.node) selectDirectory(hit.node);
			else if (hit.file) selectFile(hit.file);
		}
	}

	function handlePointerLeave() {
		hoveredRect = null;
		clearHoveredItem();
		render();
	}

	// ── Double-click: drill into the block under the cursor (fill it to the
	// viewport width), or zoom back out to the whole tree on empty space. Reuses
	// the snap/focus target and the eased animation.
	function zoomToRect(rect: LayoutRect) {
		const vw = viewportCss().w;
		if (vw <= 0) return;
		const fz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vw / rect.width));
		animateTo({ zoom: fz, panX: -rect.x * fz, panY: -rect.y });
	}

	// Zoom out to the parent directory of a path; top-level items (no parent in
	// the tree) fall back to the whole-tree home view.
	function zoomToParent(path: string) {
		const lastSlash = path.lastIndexOf('/');
		if (lastSlash < 0) {
			snapToRoot();
			return;
		}
		const parentPath = path.slice(0, lastSlash);
		const parent = layoutRects.find((r) => r.node?.path === parentPath);
		if (parent) zoomToRect(parent);
		else snapToRoot();
	}

	// True when the view is already the whole-tree home (nothing to reset to).
	function isHomeView(): boolean {
		return zoom <= MIN_ZOOM + 1e-3 && Math.abs(panX) < 0.5 && Math.abs(panY) < 0.5;
	}

	function handleDoubleClick(e: MouseEvent) {
		if (snapTimer) {
			clearTimeout(snapTimer);
			snapTimer = null;
		}
		const { x, y } = toContent(e);
		const hit = findRectAt(x, y);
		if (hit) zoomToRect(hit);
		else snapToRoot();
	}

	// ── Right-click menu: a native OS menu (Tauri v2) shown at the cursor, acting
	// on the block under the pointer. The native popup handles its own
	// positioning, keyboard navigation and dismissal; we only suppress the
	// default webview menu and build the items for the target block.
	async function handleContextMenu(e: MouseEvent) {
		e.preventDefault();
		const { x, y } = toContent(e);
		const hit = findRectAt(x, y);
		if (!hit) return;
		const path = hit.node?.path ?? hit.file?.path ?? '';
		// Right-click also selects, so the details panel mirrors the target.
		if (hit.node) selectDirectory(hit.node);
		else if (hit.file) selectFile(hit.file);

		const isDeleted = (await getElementEnrichment(path))?.directlyTaggedForDeletion ?? false;
		const lastSlash = path.lastIndexOf('/');
		const parentInTree =
			lastSlash >= 0 && layoutRects.some((r) => r.node?.path === path.slice(0, lastSlash));
		// Zoom-to-parent is meaningful when there's a parent folder to zoom into,
		// or — for a top-level item, whose parent is the root — when we're zoomed
		// in and can fall back to the whole-tree home view.
		const canZoomToParent = parentInTree || !isHomeView();

		const items = await Promise.all([
			MenuItem.new({ text: 'Zoom in', action: () => zoomToRect(hit) }),
			MenuItem.new({
				text: 'Zoom to parent',
				enabled: canZoomToParent,
				action: () => zoomToParent(path)
			}),
			MenuItem.new({ text: 'Reset zoom', enabled: !isHomeView(), action: () => snapToRoot() }),
			PredefinedMenuItem.new({ item: 'Separator' }),
			MenuItem.new({
				text: isDeleted ? 'Remove deletion mark' : 'Mark for deletion',
				action: async () => {
					const ok = isDeleted ? await removeDeleteTag(path) : await setDeleteTag(path);
					if (ok) invalidateEnrichment(path, true); // cascade: a dir marks its subtree
				}
			}),
			PredefinedMenuItem.new({ item: 'Separator' }),
			MenuItem.new({
				text: 'Copy path',
				action: async () => {
					try {
						await navigator.clipboard.writeText(path);
					} catch (err) {
						console.error('Failed to copy path', err);
					}
				}
			})
		]);

		const menu = await Menu.new({ items });
		// Position at the click. popup() with no args is meant to use the cursor,
		// but on Linux/GTK that falls back to window-centre, so pass it explicitly
		// (client coords are relative to the webview = the window with decorations off).
		await menu.popup(new LogicalPosition(e.clientX, e.clientY));
	}
</script>

<div class="flex w-full flex-col {className}">
	<!-- Top bar: color mode toggle -->
	<div class="flex items-center justify-end gap-2 px-2 pb-1">
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

	<!-- Chart container: fills the pane; the canvas below is a fixed viewport -->
	<div bind:this={container} class="relative flex min-h-0 w-full flex-1 flex-col">
		<div bind:this={canvasWrapper} class="relative min-h-0 w-full flex-1 overflow-hidden">
			<canvas
				bind:this={canvas}
				onwheel={handleWheel}
				onpointerdown={handlePointerDown}
				onpointermove={handlePointerMove}
				onpointerup={handlePointerUp}
				onpointerleave={handlePointerLeave}
				ondblclick={handleDoubleClick}
				oncontextmenu={handleContextMenu}
				class="absolute inset-0 block h-full w-full {canPan
					? pointerDown
						? 'cursor-grabbing'
						: 'cursor-grab'
					: 'cursor-default'}"
			></canvas>
		</div>
	</div>
</div>
