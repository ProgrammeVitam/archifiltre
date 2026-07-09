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
		clearSelectedItem,
		invalidateEnrichment,
		enrichmentInvalidation,
		selectedItem,
		colorMode,
		sortMode,
		lensMode,
		icicleHeight
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
		// Aggregate ("rest") block: stands in for a run of siblings too small to draw
		// individually at the current zoom. Has no node/file; double-click to reveal.
		isAggregate?: boolean;
		aggChildCount?: number;
		// Deepest subtree (in levels) hidden beneath this aggregate — drives the
		// "goes deep" signal so folded structure is legible without zooming in.
		aggMaxDepth?: number;
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
		aggregate: string;
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
		/** Select the scanned root (the whole-scan overview) — the home state, same
		 *  as the panel's × . Falls back to clearing the selection if not provided. */
		onGoHome?: () => void;
	}

	let { data, class: className = '', provisional = false, onGoHome }: Props = $props();

	// Return to the home/overview state: the scanned root selected (panel stays
	// open on the whole-scan summary), rather than an empty selection.
	function goHome() {
		if (onGoHome) onGoHome();
		else clearSelectedItem();
	}

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
	// When zoomed into a folder we frame it with a uniform side margin so its
	// neighbours peek in at the edges — the zoom reads as a focused view.
	const FOCUS_INSET_FRAC = 0.08; // share of viewport width left as margin per side
	const FOCUS_TOP_PX = 48; // px the focused folder sits below the top, clearing the vignette
	let isZoomed = $derived(zoom > MIN_ZOOM + 1e-3);
	// Pointer state: pan on drag; single-click backs out, double-click drills in.
	let pointerDown = $state(false);
	let dragged = false;
	let pointerStartX = 0;
	let pointerStartY = 0;
	let panStartX = 0;
	let panStartY = 0;
	// A single click is deferred briefly so a following double-click can cancel it.
	let clickTimer: ReturnType<typeof setTimeout> | null = null;
	const DOUBLE_CLICK_MS = 250;
	// Last cursor position over the canvas, so after a zoom settles we can promote
	// whatever the cursor now hovers to the selection.
	let lastPointerX = 0;
	let lastPointerY = 0;
	let pointerInside = false;
	// The folder the view is currently zoomed-focused on ('' = root). The item
	// focus (selection) orbits it: navigating syncs it to this folder, and an
	// empty-click resets the selection back to it (or clears it at the root).
	let focusPath = '';

	// Colour and sort modes live in shared stores (the header/menu drive them);
	// re-colour on a colour flip, and re-lay-out on a sort flip (order changes positions).
	$effect(() => {
		$colorMode;
		$sortMode;
		$lensMode; // switching lens mode re-folds to/from the plain layout
		$icicleHeight; // fit ↔ fixed re-sizes the rows
		untrack(() => {
			// leaving 'aggregate' (or turning the lens off) drops any engaged lens
			if ($lensMode !== 'aggregate') lensEngaged = false;
			if (lensFocusX !== null) ensureLensRaf(); // ease out if the lens just stopped being live
			if (!ctx || canvasWidth === 0 || !data) return;
			computeLayout();
			updateCanvasHeight();
			clampView();
			render();
		});
	});

	// Re-layout when the zoom BAND changes: visibility is on-screen-width based, so
	// zooming in reveals smaller blocks and re-folds the aggregates. Quantised
	// (~3 bands/octave) so it recomputes per band, not on every wheel tick.
	let zoomBand = $derived(Math.round(Math.log2(zoom) * 3));
	$effect(() => {
		zoomBand;
		untrack(() => {
			if (!ctx || canvasWidth === 0 || !data) return;
			computeLayout();
			updateCanvasHeight();
			clampView();
			render();
		});
	});

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
	// Base per-level height: the recursion lays rows out at this pitch, then applyRowHeight
	// (below) rescales each rect to the sizing mode's `rowHeight`. Also the 'small' cap.
	const ROW_HEIGHT = 28;
	// Floor for every sizing mode: rows never get shorter than this (below it the chart
	// overflows and pans instead of collapsing into un-hittable slivers). Only pathologically
	// deep trees ever hit it.
	const MIN_ROW_PX = 6;
	// Per-mode caps: rows fill by sharing the height across the levels but never grow past the
	// cap, so shallow trees stay tidy. 'small' shrinks sooner (many folders → thinner rows),
	// 'comfortable' is roomier, 'fill' is uncapped (v4). All floor at MIN_ROW_PX.
	const SMALL_CAP = 28;
	const COMFORTABLE_CAP = 38;
	// Effective per-level height used by the layout (baked into each rect's y/height): the
	// viewport height shared across the levels, clamped to the mode's [floor, cap]. Recomputed
	// each settled layout, but FROZEN while the lens is active so hovering (which can unfold
	// deeper levels) never rescales the chart vertically.
	let rowHeight = ROW_HEIGHT;
	function applyRowHeight(rects: LayoutRect[]) {
		if (lensFocusX === null) {
			if (viewportHeight <= 0) {
				rowHeight = ROW_HEIGHT; // pre-measure fallback
			} else {
				// Share the viewport height across the levels, clamped to [floor, cap]. The cap
				// is the only thing that differs between modes, so rows shrink toward the floor
				// as the tree deepens (more folders) and past the floor the chart overflows + pans.
				const share = viewportHeight / (maxDepth + 1);
				const cap =
					$icicleHeight === 'small'
						? SMALL_CAP
						: $icicleHeight === 'comfortable'
							? COMFORTABLE_CAP
							: Infinity;
				rowHeight = Math.max(MIN_ROW_PX, Math.min(cap, share));
			}
		}
		if (rowHeight !== ROW_HEIGHT) {
			for (const r of rects) {
				r.y = r.depth * rowHeight;
				r.height = rowHeight - PADDING;
			}
		}
	}
	// v4 look: cells sit flush (no gap) and are separated purely by a 1px white stroke
	// (see icicle-rect.tsx `stroke="#fff"`). PADDING stays 0 so neighbours share an edge
	// and the white hairlines read as thin gridlines between blocks.
	const PADDING = 0;
	// A block is drawn individually once its ON-SCREEN width (content width × zoom)
	// clears this floor; smaller siblings fold into one aggregate "rest" block that
	// fills their slice exactly (so gaps never form, and zooming reveals more).
	const MIN_REVEAL_PX = 3;

	// ── Magnification lens ──────────────────────────────────────────────────────
	// A horizontal Gaussian fisheye centred on the cursor that expands the region you point at
	// (compressing the rest) so a dense folder's long tail of tiny items becomes
	// readable/clickable — and, because the fold decision below uses the LENS-magnified
	// on-screen width, aggregates unfold live as you sweep across them. It's a display-space
	// transform (screen px → screen px), independent of zoom/pan, so it composes with both.
	// Toggleable in Settings → Appearance.
	//
	// `lensFocusX` is the cursor's x in canvas CSS px, or null when the lens is
	// inactive (pointer outside, dragging a pan, or the setting is off) — in which
	// case the map is the identity and nothing about the existing layout changes.
	let lensFocusX: number | null = $state(null);
	// In 'aggregate' mode the lens is dormant until you click a folded "+N" group; this
	// flag is that engaged state (irrelevant in 'always'/'off'). Released on Esc / picking
	// an item / clicking empty space / leaving the chart.
	let lensEngaged = $state(false);
	// True when the lens should currently distort: 'always' whenever the cursor is on the
	// chart, 'aggregate' only while engaged, never when 'off'.
	let lensLive = $derived($lensMode === 'always' || ($lensMode === 'aggregate' && lensEngaged));
	// Whenever the lens stops being live (mode change, Esc, a zoom dropping the engaged group),
	// kick the tick so `lensT` eases back to 0 and the magnification melts out — no matter which
	// site flipped it off.
	$effect(() => {
		lensLive;
		untrack(() => {
			if (!lensLive && lensFocusX !== null) ensureLensRaf();
		});
	});
	// Canvas cursor: grabbing while panning; a magnifier over a folded "+N" in 'aggregate'
	// mode (so it reads as "click to open"); otherwise grab/default per pannability.
	let canvasCursor = $derived.by(() => {
		if (pointerDown && canPan) return 'cursor-grabbing';
		if ($lensMode === 'aggregate' && !lensEngaged && hoveredRect?.isAggregate === true)
			return 'cursor-zoom-in';
		return canPan ? 'cursor-grab' : 'cursor-default';
	});
	// Peak magnification. The map normalises to preserve total width, so the effective
	// peak is (1+amp)/(1 + amp·σ√(2π)/vw) — sub-linear in amp. A high amp + a tight σ
	// (below) give a strong, localised bump that can push sub-pixel items past the
	// MIN_REVEAL floor so a hovered aggregate actually unfolds under the cursor.
	const LENS_AMPLITUDE = 12;
	// Engagement 0→1, eased every frame so the lens melts in on enter and
	// smoothly relaxes back to the true proportional row on leave (see lensTick). Blended
	// into the map so `t·kernel + (1-t)·identity`; a plain `let` (not $state) because the tick
	// loop drives computeLayout/render manually.
	let lensT = 0;
	// Cache the built map: rebuilding the Gaussian integral every mousemove is cheap,
	// but the map only changes when the focus, viewport width, style or engagement changes.
	let _lensKey = '';
	let _lensMap: (x: number) => number = (x) => x;
	let _lensInv: (x: number) => number = (x) => x;

	/** On-screen [left, right] the lens is allowed to distort. When zoomed into a folder
	 *  it's that folder's own span (clamped to the viewport), so the folder's frame stays
	 *  put and only its contents redistribute; otherwise the whole viewport. */
	function lensDomain(vw: number): [number, number] {
		if (focusPath && isZoomed) {
			const rect = layoutRects.find((r) => r.node?.path === focusPath);
			if (rect) {
				const l = Math.max(0, rect.x * zoom + panX);
				const r = Math.min(vw, (rect.x + rect.width) * zoom + panX);
				if (r - l > 24) return [l, r]; // ignore a degenerate sliver
			}
		}
		return [0, vw];
	}

	/** Rebuild (if needed) and return the current lens as {map, inv}. The fisheye acts only
	 *  within [lo, hi] (the focused folder's span) and is the identity outside it — so the
	 *  zoomed folder's borders are fixed points and just its interior magnifies. The built map
	 *  is blended with the identity by the eased engagement `lensT`, so it melts in/out. */
	function getLens(): { map: (x: number) => number; inv: (x: number) => number } {
		const dpr = window.devicePixelRatio || 1;
		const vw = canvasWidth / dpr;
		// Stay active while easing out (lensT > 0) even after the pointer left, so the relaxation
		// animates rather than snapping.
		const active = lensFocusX !== null && lensT > 0.001 && !dragged && vw > 0;
		const [lo, hi] = active ? lensDomain(vw) : [0, vw];
		const e = active ? lensT * lensT * (3 - 2 * lensT) : 0; // smoothstep ease
		const key = active
			? `${Math.round(lensFocusX!)}|${Math.round(lo)}|${Math.round(hi)}|${Math.round(e * 60)}`
			: 'off';
		if (key === _lensKey) return { map: _lensMap, inv: _lensInv };
		_lensKey = key;
		if (!active) {
			_lensMap = (x) => x;
			_lensInv = (x) => x;
			return { map: _lensMap, inv: _lensInv };
		}
		const span = hi - lo;

		// Width-preserving Gaussian fisheye centred on the cursor (direct, single-pass).
		const S = 512;
		const dx = span / S;
		const xs = new Float64Array(S + 1);
		const M = new Float64Array(S + 1);
		for (let i = 0; i <= S; i++) xs[i] = lo + i * dx;
		const focus = Math.max(lo, Math.min(hi, lensFocusX!));
		const sigma = Math.min(120, Math.max(38, span * 0.05));
		const g = (x: number) => 1 + LENS_AMPLITUDE * Math.exp(-((x - focus) ** 2) / (2 * sigma * sigma));
		let acc = 0;
		let prev = g(lo);
		M[0] = 0;
		for (let i = 1; i <= S; i++) {
			const gx = g(xs[i]);
			acc += ((gx + prev) * 0.5) * dx;
			prev = gx;
			M[i] = acc;
		}
		const total = acc || 1;
		for (let i = 0; i <= S; i++) M[i] = lo + (M[i] / total) * span;
		// blend toward identity by the eased engagement, so it melts in and out
		if (e < 1) for (let i = 0; i <= S; i++) M[i] = xs[i] + (M[i] - xs[i]) * e;

		_lensMap = (x: number) => {
			if (x <= lo || x >= hi) return x;
			const t = (x - lo) / dx;
			const i = Math.min(S - 1, Math.floor(t));
			return M[i] + (M[i + 1] - M[i]) * (t - i);
		};
		_lensInv = (y: number) => {
			if (y <= lo || y >= hi) return y;
			let a = 0;
			let b = S;
			while (b - a > 1) {
				const mid = (a + b) >> 1;
				if (M[mid] < y) a = mid;
				else b = mid;
			}
			const d = M[b] - M[a] || 1;
			return xs[a] + (xs[b] - xs[a]) * ((y - M[a]) / d);
		};
		return { map: _lensMap, inv: _lensInv };
	}

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
			// Initial render. Route through updateForNewData (not a bare computeLayout)
			// so it records lastDataId here — otherwise the $effect.pre rAF below would
			// treat this same data as new, reset the file-load guard sets, and re-fetch
			// every visible directory's files a second time.
			if (data) {
				updateForNewData();
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
				updateCanvasHeight(); // filled rows depend on viewport height — refresh on resize
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
			aggregate: v('--color-aggregate'),
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

	/**
	 * Readable label colour for text drawn on a block: near-white on dark fills,
	 * near-black on light fills — so white-on-yellow (the folder/other hue) is no
	 * longer illegible. Same luminance test as bandSeparatorColor, stronger opacity
	 * for text. "Opposite colour" in the readable sense, not a literal RGB inverse.
	 */
	function labelTextColor(fill: string): string {
		const [r, g, b] = parseRgb(fill);
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		return luminance < 140 ? 'rgba(255, 255, 255, 0.95)' : 'rgba(0, 0, 0, 0.82)';
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
		if (dir !== null) {
			// In date mode a folder takes the gradient at its representative (median
			// descendant) date, so folders read on the same timeline as files instead of
			// a flat yellow. Falls back to the folder hue when no date is known (live scan).
			if ($colorMode === 'date' && dir.median_mtime != null)
				return getDateColor(dir.median_mtime, minMtime, maxMtime, palette);
			// An archive container (foo.zip) drills in like a folder but should LOOK like a
			// compressed file (v4 tinted zips dark grey). In date mode it stays on the
			// timeline like any other folder (handled above).
			if (dir.is_archive) return palette.compressed;
			return palette.folder;
		}
		if (file === null) return palette.other;
		if ($colorMode === 'date') return getDateColor(file.mtime, minMtime, maxMtime, palette);
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
			focusPath = '';
		} else {
			childrenMap = childrenMapDerived;
		}

		if (ctx && canvasWidth > 0) {
			computeLayout();
			updateCanvasHeight();
			clampView();
			render();
			// Files load lazily from inside computeLayout (only on-screen folders).
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
			// null = the query FAILED (e.g. timed out under live-scan write contention).
			// Do NOT cache that as "empty" — leave it uncached so the next layout/poll
			// retries it once the connection frees up; otherwise a single mid-scan
			// timeout would hide a folder's files for the rest of the scan.
			if (filesData) {
				const files = filesData.files.filter((f) => !f.is_directory);
				filesCache.set(dirPath, files); // valid response (possibly genuinely empty)
				if (files.length > 0) {
					computeLayout();
					// Async file loading can deepen the tree (new rows); refresh the content
					// metric and re-clamp the pan so deeper rows stay reachable.
					updateCanvasHeight();
					clampView();
					render();
				}
			}
		} catch (e) {
			console.error('Failed to load files for', dirPath, e); // transient — retry next layout
		} finally {
			loadingFiles.delete(dirPath);
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
		// rowHeight reflects the sizing mode's clamp, so contentHeight ≈ viewport when the rows
		// fill it (centres, no whitespace), is shorter when capped (shallow trees), and overflows
		// to pan only for pathologically deep trees past the MIN_ROW_PX floor.
		contentHeight = rows * rowHeight;
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
		if (scaledW <= vw) {
			// Fits (the root) → centred, content fills the width, no side margin.
			panX = (vw - scaledW) / 2;
		} else if (isZoomed) {
			// Allow a side margin even at the tree's outer edges, so the leftmost /
			// rightmost folder still lifts clear of the vignette (the horizontal twin
			// of the FOCUS_TOP_PX margin). Only when zoomed.
			const insetX = vw * FOCUS_INSET_FRAC;
			panX = Math.min(insetX, Math.max(vw - scaledW - insetX, panX));
		} else {
			panX = Math.min(0, Math.max(vw - scaledW, panX));
		}
		if (scaledH <= vh) {
			// Centre the content vertically whenever it fits — at the root AND when
			// zoomed — so the focused folder sits clear of all edges and, crucially,
			// the root↔zoom transition interpolates smoothly (no vertical hop).
			panY = Math.round((vh - scaledH) / 2);
		} else if (isZoomed) {
			// Overflowing + zoomed: top-align with a margin, drag to reveal more.
			panY = Math.min(FOCUS_TOP_PX, Math.max(vh - scaledH - FOCUS_TOP_PX, panY));
		} else {
			panY = Math.min(0, Math.max(vh - scaledH, panY));
		}
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

	function computeSnapTarget(): { zoom: number; panX: number; panY: number; path: string } {
		const vw = viewportCss().w;
		if (vw <= 0 || layoutRects.length === 0)
			return { zoom: MIN_ZOOM, panX: 0, panY: 0, path: '' };
		const centerXContent = (vw / 2 - panX) / zoom;
		const logZoom = Math.log(zoom);
		// Root frame (whole tree) is always in the running.
		let best = { zoom: MIN_ZOOM, panX: 0, panY: 0, path: '' };
		let bestDist = Math.abs(Math.log(MIN_ZOOM) - logZoom);
		for (const rect of layoutRects) {
			if (!rect.node) continue; // directories are the frames
			if (centerXContent < rect.x || centerXContent > rect.x + rect.width) continue;
			const t = frameTarget(rect);
			const dist = Math.abs(Math.log(t.zoom) - logZoom);
			if (dist < bestDist) {
				bestDist = dist;
				best = { ...t, path: rect.node.path };
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

	function animateTo(
		target: { zoom: number; panX: number; panY: number },
		activateAfter = false
	) {
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
			if (t >= 1 && activateAfter) activateHoveredAfterZoom();
		};
		animFrame = requestAnimationFrame(step);
	}

	function scheduleSnap() {
		if (snapTimer) clearTimeout(snapTimer);
		snapTimer = setTimeout(() => {
			snapTimer = null;
			const target = computeSnapTarget();
			// Rule 1: the snapped folder becomes the focus + selection (root → clear).
			focusPath = target.path;
			if (target.path) selectFolderByPath(target.path);
			else goHome();
			animateTo(target);
		}, SNAP_DELAY);
	}

	// Ease the finder back out to the whole tree (the home view).
	function snapToRoot() {
		if (snapTimer) {
			clearTimeout(snapTimer);
			snapTimer = null;
		}
		focusPath = '';
		animateTo({ zoom: MIN_ZOOM, panX: 0, panY: 0 });
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		if (!canvas) return;
		lensEngaged = false; // zooming changes the frame — drop any engaged lens
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
			if (!filesCache.has('') && !provisional) loadFilesForDirectory('');
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
		// LOD lazy-load queue: directories this layout actually draws but whose files
		// aren't materialized yet. Filled during layout, drained after — so only the
		// folders on-screen at the current zoom fetch their files from PGlite, never
		// the whole tree up front (the v4 all-in-memory trap).
		const dirsToLoad: string[] = [];

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
			if (!filesCache.has('') && !provisional) dirsToLoad.push('');
			const rootFiles = filesCache.get('') || [];
			layoutChildrenAndFiles(dirs, rootFiles, x, width, depth);
		}

		// Layout subdirectories and files at one level, folding runs of siblings too
		// small to draw individually (at the current zoom) into one aggregate block
		// that fills their slice — so no gaps, and zooming in reveals more.
		function layoutChildrenAndFiles(
			dirs: DirectoryNode[],
			files: FileNode[],
			x: number,
			width: number,
			depth: number
		) {
			const levelIndex = depth - startDepth;
			const y = levelIndex * ROW_HEIGHT;
			if (levelIndex > currentMaxDepth) currentMaxDepth = levelIndex;

			const dirsSize = dirs.reduce((sum, d) => sum + d.total_size, 0);
			const filesSize = files.reduce((sum, f) => sum + f.size, 0);
			const totalSize = dirsSize + filesSize;
			if (totalSize === 0) return;

			// Visible iff on-screen width clears the floor. The width is measured AFTER the
			// magnification lens (identity when the lens is off), so a block the cursor is
			// hovering can clear the floor and unfold even when it'd be sub-pixel at rest.
			const lens = getLens();
			const onScreenWidth = (cx: number, w: number) =>
				lens.map((cx + w) * zoom + panX) - lens.map(cx * zoom + panX);

			let currentX = x;
			let aggStart = 0;
			let aggWidth = 0;
			let aggCount = 0;
			let aggMaxDepth = 0;
			const flushAgg = () => {
				if (aggCount === 0) return;
				rects.push({
					node: null,
					file: null,
					isAggregate: true,
					aggChildCount: aggCount,
					aggMaxDepth,
					x: aggStart,
					y,
					width: Math.max(1, aggWidth - PADDING),
					height: ROW_HEIGHT - PADDING,
					color: palette.aggregate,
					opacity: 1,
					depth: levelIndex
				});
				aggCount = 0;
				aggWidth = 0;
				aggMaxDepth = 0;
			};
			// hiddenDepth = levels of subtree this folded item hides below the row
			// (a directory's max_depth; files hide nothing).
			const fold = (w: number, hiddenDepth = 0) => {
				if (aggCount === 0) aggStart = currentX;
				aggWidth += w;
				aggCount++;
				if (hiddenDepth > aggMaxDepth) aggMaxDepth = hiddenDepth;
			};

			// Folders first, then files; the sort mode picks the order WITHIN each group.
			// (v4 mixes files+folders purely by size; folders stay grouped, which improves
			// legibility for an icicle whose folders recurse downward.) Sorted copies leave the
			// cached child arrays untouched.
			const byName = (a: { name: string }, b: { name: string }) =>
				a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
			if ($sortMode === 'name') {
				dirs = [...dirs].sort(byName);
				files = [...files].sort(byName);
			} else if ($sortMode === 'date') {
				// Oldest → newest: folders by their median descendant date, files by mtime.
				// Folders with no date yet (mid-scan) sort as 0, keeping a stable order.
				dirs = [...dirs].sort((a, b) => (a.median_mtime ?? 0) - (b.median_mtime ?? 0));
				files = [...files].sort((a, b) => a.mtime - b.mtime);
			} else {
				dirs = [...dirs].sort((a, b) => b.total_size - a.total_size);
				files = [...files].sort((a, b) => b.size - a.size);
			}
			for (const dir of dirs) {
				const nodeWidth = (dir.total_size / totalSize) * width;
				if (onScreenWidth(currentX, nodeWidth) >= MIN_REVEAL_PX) {
					flushAgg();
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
					const subChildren = getChildren(dir.path, childrenMap);
					// Wide enough to draw, so this folder's file children may be visible
					// too — request them lazily if they aren't loaded yet (undefined =
					// never loaded; [] = loaded-but-empty, so don't re-fetch).
					const cachedFiles = filesCache.get(dir.path);
					if (cachedFiles === undefined && !provisional) dirsToLoad.push(dir.path);
					const subFiles = cachedFiles || [];
					if (subChildren.length > 0 || subFiles.length > 0) {
						layoutChildrenAndFiles(subChildren, subFiles, currentX, nodeWidth, depth + 1);
					}
				} else {
					fold(nodeWidth, dir.max_depth ?? 0);
				}
				currentX += nodeWidth;
			}
			for (const file of files) {
				const fileWidth = (file.size / totalSize) * width;
				if (onScreenWidth(currentX, fileWidth) >= MIN_REVEAL_PX) {
					flushAgg();
					rects.push({
						node: null,
						file,
						x: currentX,
						y,
						width: fileWidth - PADDING,
						height: ROW_HEIGHT - PADDING,
						color: getNodeColor(file, null, palette, minMtime, maxMtime),
						opacity: 1,
						depth: levelIndex
					});
				} else {
					fold(fileWidth);
				}
				currentX += fileWidth;
			}
			flushAgg();
		}

		layoutRootLevel(startDirs, 0, viewWidth, startDepth);
		layoutRects = rects;
		maxDepth = currentMaxDepth;
		applyRowHeight(rects); // rescale rows to the sizing mode (fill/clamp the height)

		// Drain the lazy-load queue: fetch files only for the folders this layout
		// actually drew. loadFilesForDirectory is guarded (cache + in-flight set), so
		// re-running layout on every pan/zoom frame never double-fetches.
		// Bound the concurrent in-flight loads: during a LIVE scan the connection is
		// also serving writes, so firing 20+ get_files at once floods the queue and the
		// tail times out. Cap it; the rest are re-queued by the next layout/poll (and a
		// failed load stays uncached, so it retries) → bounded read pressure, no flood.
		const MAX_INFLIGHT_FILE_LOADS = 6;
		for (const path of dirsToLoad) {
			if (loadingFiles.size >= MAX_INFLIGHT_FILE_LOADS) break;
			loadFilesForDirectory(path);
		}
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

		const lens = getLens();
		const onScreenWidth = (cx: number, w: number) =>
			lens.map((cx + w) * zoom + panX) - lens.map(cx * zoom + panX);
		let currentX = 0;
		let aggStart = 0;
		let aggWidth = 0;
		let aggCount = 0;
		const flushAgg = () => {
			if (aggCount === 0) return;
			rects.push({
				node: null,
				file: null,
				isAggregate: true,
				aggChildCount: aggCount,
				x: aggStart,
				y: 0,
				width: Math.max(1, aggWidth - PADDING),
				height: ROW_HEIGHT - PADDING,
				color: palette.aggregate,
				opacity: 1,
				depth: 0
			});
			aggCount = 0;
			aggWidth = 0;
		};
		for (const file of files) {
			const fileWidth = (file.size / totalSize) * viewWidth;
			if (onScreenWidth(currentX, fileWidth) >= MIN_REVEAL_PX) {
				flushAgg();
				rects.push({
					node: null,
					file,
					x: currentX,
					y: 0,
					width: fileWidth - PADDING,
					height: ROW_HEIGHT - PADDING,
					color: getNodeColor(file, null, palette, minMtime, maxMtime),
					opacity: 1,
					depth: 0
				});
			} else {
				if (aggCount === 0) aggStart = currentX;
				aggWidth += fileWidth;
				aggCount++;
			}
			currentX += fileWidth;
		}
		flushAgg();

		layoutRects = rects;
		applyRowHeight(rects); // files-only root: size the single row per the mode
	}

	// ================================
	// Rendering
	// ================================

	// The connector ribbon, drawn on the canvas BEHIND the blocks so it never
	// covers a selected folder's children — it shows in the gaps and the seam and
	// grows out of the item. Colour comes from the item (strongest at the item,
	// fading into the panel below). A leaf curves straight out of the item; a
	// directory holds its width as a column behind its subtree, then flares.
	function drawConnector(dpr: number, vw: number, vh: number, path: string | null, strength = 1) {
		if (!ctx) return;
		if (!path) return; // root / nothing selected → no connector
		const rect = layoutRects.find((r) => (r.node?.path ?? r.file?.path) === path);
		if (!rect) return;

		const lens = getLens();
		const itemLeft = lens.map(rect.x * zoom + panX);
		const itemRight = lens.map((rect.x + rect.width) * zoom + panX);
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
		grad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${0.5 * strength})`); // from the item
		grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, ${0.04 * strength})`); // into the panel

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

		// The magnification lens (identity when off/inactive); the same map the layout
		// used, so drawn positions match the fold/unfold decisions exactly.
		const lens = getLens();

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

		// The block the panel is currently previewing while hovering a real element:
		// its lineage lights (cascade hover) and its conduit ties it to the panel.
		// Suppressed mid-drag so a pan doesn't strobe the chart.
		const hoverPath =
			!dragged && hoveredRect && !hoveredRect.isAggregate
				? (hoveredRect.node?.path ?? hoveredRect.file?.path ?? null)
				: null;

		// Conduits (drawn first, behind the blocks). While a hover previews a
		// different item, the committed selection stays as a faint anchor and the
		// hovered item gets the full-strength ribbon — so the conduit always ties the
		// panel to whichever block it's showing.
		if (hoverPath && selectedPath && selectedPath !== hoverPath) {
			drawConnector(dpr, viewWidth, viewHeight, selectedPath, 0.3);
		}
		drawConnector(dpr, viewWidth, viewHeight, hoverPath ?? selectedPath, 1);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Draw rectangles
		ctx.save();

		// Enrichment band colors (resolved once per render).
		const bandPalette = resolveColors();

		// Draw each rectangle. Coordinates are computed in screen space (CSS px):
		// X carries the zoom (breadth), Y is a fixed-height row (depth), so strokes
		// and labels stay crisp at any zoom.
		for (const rect of layoutRects) {
			// Screen X, then the magnification lens (identity when off) — the same map the
			// layout used for its fold decision, so positions and unfolding stay in sync.
			const lx = lens.map(rect.x * zoom + panX);
			const sx = lx;
			const sw = lens.map((rect.x + rect.width) * zoom + panX) - lx;
			const sy = rect.y + panY; // rows keep a constant height regardless of zoom
			const sh = rect.height;

			// Cull blocks entirely off the left/right of the viewport.
			if (sx + sw < 0 || sx > viewWidth) continue;

			const rectPath = rect.node?.path ?? rect.file?.path ?? '';
			const isHovered =
				hoveredRect && (hoveredRect.node?.path ?? hoveredRect.file?.path) === rectPath;

			// Cascade hover (v4): while hovering a real block, its ancestry spine
			// (root → item) stays lit and everything off it dims — so its lineage, the
			// chain of folders that contains it, reads at a glance. With no hover, fall
			// back to the selection spotlight (the selected subtree stays vivid).
			let inFocus: boolean;
			if (hoverPath !== null) {
				inFocus = rectPath === hoverPath || hoverPath.startsWith(rectPath + '/');
			} else {
				inFocus =
					!selectedPath || rectPath === selectedPath || rectPath.startsWith(selectedPath + '/');
			}
			ctx.globalAlpha = inFocus ? 1 : hoverPath !== null ? 0.3 : 0.35;

			// Draw background
			ctx.fillStyle = isHovered ? lightenColor(rect.color, 0.15) : rect.color;
			ctx.fillRect(sx, sy, sw, sh);

			// Separator: a 1px WHITE stroke like v4 (icicle-rect.tsx `stroke="#fff"`).
			// Flush cells share edges, so these hairlines read as thin white gridlines.
			ctx.strokeStyle = '#ffffff';
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
				ctx.fillStyle = labelTextColor(isHovered ? lightenColor(rect.color, 0.15) : rect.color);
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

			// Honest aggregate: a folded "rest" block stands for a run of items too small
			// to draw. Mark it as such — a diagonal hatch (so it never reads as a single
			// real block) and a "+N" count once there's room — so it's clearly "N items
			// folded here, double-click to zoom", not an unknown-type file.
			if (rect.isAggregate) {
				const prevAlpha = ctx.globalAlpha;
				ctx.save();
				ctx.beginPath();
				ctx.rect(sx, sy, sw, sh);
				ctx.clip();
				ctx.globalAlpha = prevAlpha * 0.4;
				ctx.strokeStyle = 'rgba(226, 232, 240, 0.6)';
				ctx.lineWidth = 1;
				ctx.beginPath();
				for (let hx = sx - sh; hx < sx + sw; hx += 6) {
					ctx.moveTo(hx, sy + sh);
					ctx.lineTo(hx + sh, sy);
				}
				ctx.stroke();
				ctx.restore();
				ctx.globalAlpha = prevAlpha;

				const count = rect.aggChildCount ?? 0;
				if (count > 0 && sw > 26 && sh > 12) {
					const label = `+${count}`;
					ctx.fillStyle = '#e2e8f0';
					ctx.font = '600 11px system-ui, sans-serif';
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					if (ctx.measureText(label).width < sw - 6)
						ctx.fillText(label, sx + sw / 2, sy + sh / 2);
					ctx.textAlign = 'left';
				}
			}

			// "Goes deep" signal. A folded aggregate hides whole subtrees; mark how
			// deep with a small "layers" glyph in its bottom-left corner — a stack of
			// ticks, one per hidden level (capped). Kept to a fixed small width and
			// contained inside the block, so a wide aggregate never paints full-width
			// bands (which read as banding, not a cue). Inherits the rect's globalAlpha
			// so it dims with the spotlight.
			if (rect.isAggregate && (rect.aggMaxDepth ?? 0) > 0 && sw > 8 && sh > 10) {
				const ticks = Math.min(rect.aggMaxDepth ?? 0, 5);
				const glyphW = Math.min(sw - 6, 14);
				ctx.strokeStyle = 'rgba(30, 41, 59, 0.55)';
				ctx.lineWidth = 1;
				ctx.beginPath();
				for (let i = 0; i < ticks; i++) {
					const ly = Math.round(sy + sh - 3 - i * 2.5) + 0.5;
					if (ly < sy + 4) break;
					ctx.moveTo(sx + 3, ly);
					ctx.lineTo(sx + 3 + glyphW, ly);
				}
				ctx.stroke();
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

	// Screen (canvas CSS px) → content space, inverting the lens then the zoom/pan
	// transform (the lens inverse is identity when the lens is off), so hover/click
	// land on the block actually under the cursor even while it's magnified.
	function toContent(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const r = canvas!.getBoundingClientRect();
		const screenX = e.clientX - r.left;
		return {
			x: (getLens().inv(screenX) - panX) / zoom,
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
		lastPointerX = e.clientX;
		lastPointerY = e.clientY;
		pointerInside = true;

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

		// With the lens on, the cursor magnifies the region it's over — and, because the
		// fold decision reads the magnified width, a hovered aggregate unfolds. Both need a
		// relayout as the cursor moves, coalesced into one rAF frame so a fast sweep does at
		// most one relayout per frame (and re-hovering re-uses the lens map cache).
		if (lensLive && !dragged) {
			const r = canvas.getBoundingClientRect();
			lensFocusX = e.clientX - r.left;
			pendingHover = e;
			ensureLensRaf();
			return;
		}

		// Lens not live (off, or 'aggregate' mode not yet engaged): the original, cheap hover
		// path (no relayout). Hovering a folded "+N" in 'aggregate' mode shows a magnifier
		// cursor (see canvasCursor) so it's discoverable that clicking it engages the lens.
		const { x, y } = toContent(e);
		const hit = findRectAt(x, y);
		if (hit !== hoveredRect) {
			hoveredRect = hit;
			render();
			emitHover(hit);
		}
	}

	// Distinguish hovered items by identity, not object reference: a lens relayout builds
	// a fresh rects array every frame, so reference equality would report a new hover each
	// frame and thrash the details panel. Aggregates fold to one bucket ('§agg').
	function hoverKey(r: LayoutRect | null): string | null {
		if (!r) return null;
		return r.node?.path ?? r.file?.path ?? (r.isAggregate ? '§agg' : '');
	}
	function emitHover(hit: LayoutRect | null) {
		if (hit?.node) hoverDirectory(hit.node);
		else if (hit?.file) hoverFile(hit.file);
		else clearHoveredItem();
	}

	let lensRaf: number | null = null;
	let pendingHover: PointerEvent | null = null;
	function ensureLensRaf() {
		if (lensRaf === null) lensRaf = requestAnimationFrame(lensTick);
	}
	// One coalesced frame: ease the engagement `lensT` toward its target, apply any pending
	// cursor move, re-fold under the (blended) lens and hit-test the fresh layout. Self-
	// reschedules until the engagement settles — so entering melts the lens in and leaving
	// smoothly relaxes it back to the true proportional row, rather than snapping.
	function lensTick() {
		lensRaf = null;
		if (!canvas) {
			lensT = 0;
			return;
		}
		const target = lensLive && lensFocusX !== null && pointerInside && !dragged ? 1 : 0;
		lensT += (target - lensT) * (target > lensT ? 0.28 : 0.16); // in a touch faster than out
		const settled = Math.abs(lensT - target) < 0.004;
		if (settled) lensT = target;

		const e = pendingHover;
		pendingHover = null;
		computeLayout();
		if (e) {
			// Re-fold under the lens, then hit-test the fresh layout so hover lands on the block
			// actually under the cursor (which may have just unfolded).
			const { x, y } = toContent(e);
			const hit = findRectAt(x, y);
			const changed = hoverKey(hit) !== hoverKey(hoveredRect);
			hoveredRect = hit;
			render();
			if (changed) emitHover(hit);
		} else {
			render();
		}

		if (!settled) ensureLensRaf();
		else if (target === 0) {
			lensFocusX = null; // fully relaxed → drop the focus so the map is a clean identity
			computeLayout();
			render();
		}
	}

	// ── 'aggregate' lens mode: click a folded "+N" to engage the (folder-scoped) lens
	// centred on it, then it follows the cursor until released. ──────────────────────
	function engageLens(rect: LayoutRect) {
		lensFocusX = (rect.x + rect.width / 2) * zoom + panX; // centre the bump on the group
		lensEngaged = true;
		ensureLensRaf(); // ease the lens in and unfold under it
	}
	function releaseLens() {
		if (!lensEngaged) return;
		lensEngaged = false;
		ensureLensRaf(); // ease smoothly back to the plain layout
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

		if (clickTimer) {
			clearTimeout(clickTimer);
			clickTimer = null;
		}
		const { x, y } = toContent(e);
		const hit = findRectAt(x, y);
		if (!hit) {
			releaseLens(); // clicking empty space closes an engaged lens
			// Empty-click resets the item focus back to the zoomed folder — or, at
			// the root, clears it entirely. Deferred so a double-click can go home.
			clickTimer = setTimeout(() => {
				clickTimer = null;
				if (focusPath) selectFolderByPath(focusPath);
				else goHome();
			}, DOUBLE_CLICK_MS);
			return;
		}

		if (hit.isAggregate) {
			// In 'aggregate' mode a click opens the lens onto this group; otherwise a folded
			// "rest" block is inert to a single click (double-click still zooms into it).
			if ($lensMode === 'aggregate') engageLens(hit);
			return;
		}

		// Click selects. If the clicked item is OUTSIDE the current view (the zoomed
		// folder's subtree), also zoom out to the folder that holds both — so you see
		// where it sits. Selection is immediate; the zoom-out is deferred so a
		// double-click (navigate) can cancel it.
		releaseLens(); // picking a real item closes an engaged lens
		const hitPath = hit.node?.path ?? hit.file?.path ?? '';
		if (hit.node) selectDirectory(hit.node);
		else if (hit.file) selectFile(hit.file);

		const insideView = !focusPath || hitPath === focusPath || hitPath.startsWith(focusPath + '/');
		if (isZoomed && !insideView) {
			clickTimer = setTimeout(() => {
				clickTimer = null;
				zoomToCommonAncestor(focusPath, hitPath);
			}, DOUBLE_CLICK_MS);
		}
	}

	function handlePointerLeave() {
		pointerInside = false;
		hoveredRect = null;
		clearHoveredItem();
		// Relax the magnification: release any engaged lens and let the tick ease `lensT` back
		// to 0 (which then drops the focus), so the row melts back to true proportions rather
		// than snapping.
		lensEngaged = false;
		if (lensFocusX !== null) ensureLensRaf();
		render();
	}

	// Esc closes an engaged 'aggregate' lens (no preventDefault — Esc stays free elsewhere).
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && lensEngaged) releaseLens();
	}

	// After a zoom settles, promote the item now under the cursor to the
	// selection, so the panel follows where the mouse actually ended up.
	function activateHoveredAfterZoom() {
		if (!pointerInside || !canvas) return;
		const { x, y } = toContent({ clientX: lastPointerX, clientY: lastPointerY });
		const hit = findRectAt(x, y);
		if (!hit) return;
		// Only promote the hovered item if it's inside the folder we just drilled
		// into; if the cursor ended up over a peek outside it (e.g. an edge sibling),
		// keep the drilled-into folder selected.
		const hitPath = hit.node?.path ?? hit.file?.path ?? '';
		const focus = focusPath;
		if (focus && hitPath !== focus && !hitPath.startsWith(focus + '/')) return;
		hoveredRect = hit;
		if (hit.node) selectDirectory(hit.node);
		else if (hit.file) selectFile(hit.file);
	}

	// ── Double-click: drill into the block under the cursor (fill it to the
	// viewport width), or zoom back out to the whole tree on empty space. Reuses
	// the snap/focus target and the eased animation.
	// The framing target for a block: fill the viewport minus a uniform side
	// margin (so neighbours peek), with the block's row at the top of the frame.
	function frameTarget(rect: LayoutRect): { zoom: number; panX: number; panY: number } {
		const vw = viewportCss().w;
		const inset = vw * FOCUS_INSET_FRAC;
		const fz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (vw - 2 * inset) / rect.width));
		return { zoom: fz, panX: inset - rect.x * fz, panY: FOCUS_TOP_PX - rect.y };
	}

	// Select the directory at a path (or clear the selection if it isn't a folder
	// in the current layout). Keeps the item focus in sync with the zoom focus.
	function selectFolderByPath(path: string) {
		const rect = layoutRects.find((r) => r.node?.path === path);
		if (rect?.node) selectDirectory(rect.node);
		else goHome();
	}

	function zoomToRect(rect: LayoutRect, activateAfter = false) {
		if (viewportCss().w <= 0) return;
		lensEngaged = false; // a zoom changes the focused folder — drop any engaged lens
		if (rect.node) focusPath = rect.node.path; // this folder is now the zoom focus
		animateTo(frameTarget(rect), activateAfter);
	}

	// Immediate parent path of a node path ('' = the scanned root).
	function parentPathOf(p: string): string {
		const i = p.lastIndexOf('/');
		return i < 0 ? '' : p.slice(0, i);
	}

	// Direct children (files + folders) a directory has in the current layout.
	function childCountOf(p: string): number {
		let n = 0;
		for (const r of layoutRects) {
			const rp = r.node?.path ?? r.file?.path;
			if (rp && parentPathOf(rp) === p) n++;
		}
		return n;
	}

	// Climb to the nearest ancestor that actually branches — skip linear chains
	// where the path is its parent's sole child (path compression). '' = root.
	function nearestBranchingParent(path: string): string {
		let p = parentPathOf(path);
		while (p !== '' && childCountOf(p) <= 1) {
			p = parentPathOf(p);
		}
		return p;
	}

	// Longest shared folder prefix of two paths ('' = the scanned root).
	function commonAncestorPath(a: string, b: string): string {
		const A = a ? a.split('/') : [];
		const B = b ? b.split('/') : [];
		const out: string[] = [];
		for (let i = 0; i < Math.min(A.length, B.length); i++) {
			if (A[i] === B[i]) out.push(A[i]);
			else break;
		}
		return out.join('/');
	}

	// Frame the folder that contains both paths, so they're both on screen.
	function zoomToCommonAncestor(a: string, b: string) {
		const common = commonAncestorPath(a, b);
		if (common === '') {
			snapToRoot();
			return;
		}
		const rect = layoutRects.find((r) => r.node?.path === common);
		if (rect) zoomToRect(rect);
		else snapToRoot();
	}

	// Zoom out from a path to its nearest branching ancestor, falling back to the
	// whole-tree home view at the root.
	function zoomToParent(path: string) {
		const target = nearestBranchingParent(path);
		if (target === '') {
			snapToRoot();
			return;
		}
		const rect = layoutRects.find((r) => r.node?.path === target);
		if (rect && rect.node) {
			selectDirectory(rect.node);
			zoomToRect(rect);
		} else snapToRoot();
	}

	// True when the view is already the whole-tree home (nothing to reset to).
	function isHomeView(): boolean {
		return zoom <= MIN_ZOOM + 1e-3 && Math.abs(panX) < 0.5 && Math.abs(panY) < 0.5;
	}

	// Double-click any element → navigate to it: select it and frame it (a folder
	// fills the view; a file frames its parent so you see it among siblings).
	// Empty space → home.
	function handleDoubleClick(e: MouseEvent) {
		if (clickTimer) {
			clearTimeout(clickTimer);
			clickTimer = null;
		}
		if (snapTimer) {
			clearTimeout(snapTimer);
			snapTimer = null;
		}
		const { x, y } = toContent(e);
		const hit = findRectAt(x, y);
		if (!hit) {
			goHome();
			snapToRoot();
			return;
		}
		if (hit.isAggregate) {
			zoomToRect(hit); // zoom into the aggregate's span to reveal its contents
			return;
		}
		if (hit.node) {
			selectDirectory(hit.node);
			zoomToRect(hit, true);
		} else if (hit.file) {
			selectFile(hit.file);
			const pp = parentPathOf(hit.file.path);
			const prect = pp ? layoutRects.find((r) => r.node?.path === pp) : null;
			if (prect) zoomToRect(prect, true);
			else snapToRoot();
		}
	}

	// ── Right-click menu: a native OS menu (Tauri v2) shown at the cursor, acting
	// on the block under the pointer. The native popup handles its own
	// positioning, keyboard navigation and dismissal; we only suppress the
	// default webview menu and build the items for the target block.
	async function handleContextMenu(e: MouseEvent) {
		e.preventDefault();
		const { x, y } = toContent(e);
		const hit = findRectAt(x, y);
		if (!hit || hit.isAggregate) return;
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

<svelte:window onkeydown={handleKeydown} />

<div class="flex w-full flex-col {className}">
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
				class="absolute inset-0 block h-full w-full {canvasCursor}"
			></canvas>

			<!-- Focus vignette: when zoomed in, fade all four edges to the background
			     so the peeking neighbours dissolve evenly and the view reads as a
			     focused frame. Non-interactive so the peeks stay clickable. -->
			<div
				class="pointer-events-none absolute inset-0 z-10 transition-opacity duration-300"
				style="box-shadow: inset 0 0 52px 6px var(--background); opacity: {isZoomed ? 0.9 : 0};"
			></div>
		</div>
	</div>
</div>
