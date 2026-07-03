/**
 * Svelte stores for Archifiltre UI state management
 *
 * Sidebar-based architecture with localStorage persistence.
 * Each scan has its own database and state.
 */

import { writable, derived, get } from 'svelte/store';
import type { Tag, TreeData, DirectoryNode } from '$lib/tauri';

// ================================
// Types
// ================================

export type ScanState = 'idle' | 'scanning' | 'paused' | 'complete' | 'error';

export type Platform = 'windows' | 'macos' | 'gnome';

export interface ScanOptions {
	includeHidden: boolean;
	batchSize: number;
	disableArchives: boolean;
}

export interface ScanResult {
	filesDiscovered: number;
	duplicateFiles: number;
	duplicateGroups: number;
	folders: number;
	emptyFolders: number;
	emptyFiles: number;
	hiddenFiles: number;
	archives: number;
	archiveEntries: number;
	totalSize: number;
	filesHashed: number;
	filesToHash: number;
}

export interface TerminalLine {
	id: number;
	text: string;
	stream: 'stdout' | 'stderr' | 'info' | 'success' | 'error';
	timestamp: Date;
}

export type ScanPhase =
	| 'discovery'
	| 'ingestion'
	| 'prefilter'
	| 'hashing'
	| 'duplicate-detection'
	| 'complete';

/**
 * Scan represents a single analysis session.
 * Each scan has its own database and state.
 */
export interface Scan {
	/** Unique identifier for this scan */
	id: string;
	/** Scan ID for event routing (set when scan starts) */
	scanId: string | null;
	/** Database name for CLI --db flag */
	dbName: string;
	/** Display name (folder name or "New Scan") */
	name: string;
	/** Full path being scanned */
	path: string | null;
	/** Current state of this scan */
	state: ScanState;
	/** Scan configuration options */
	scanOptions: ScanOptions;
	/** Scan results */
	scanResult: ScanResult;
	/** Terminal output history */
	terminalOutput: TerminalLine[];
	/** Current progress message */
	scanProgress: string;
	/** Current scan phase */
	scanPhase: ScanPhase;
	/** Pause clicked, session ack (job:paused) not yet arrived — renders "Pausing…".
	 *  Transient UI state: cleared on pause/resume and on restore. */
	pauseRequested?: boolean;
	/** Set when this scan's datadir can't be opened. 'missing' = no datadir on disk;
	 *  'damaged' = present but PGlite couldn't open it. Both auto-trigger a rebuild (the
	 *  scan is deterministic) when the folder is reachable; 'unavailable' means the folder
	 *  itself isn't reachable, so the UI offers Retry / Remove instead. */
	datadirState?: 'missing' | 'damaged' | 'unavailable';
	/** True while a damaged/missing scan is being rebuilt (auto re-scan) — the scanning UI
	 *  shows a "Rebuilding…" note. Cleared on completion/cancel. Transient. */
	rebuilding?: boolean;
	/** True when a durable annotation snapshot exists for this scan's root, so the
	 *  re-scan flow can offer to restore the user's work. Set during reconciliation. */
	hasAnnotationBackup?: boolean;
	/** Marks a scan adopted from disk by reconciliation (not from localStorage), so the
	 *  UI can note "recovered" briefly. Transient. */
	recovered?: boolean;
	/** Error message if state is 'error' */
	errorMessage: string | null;
	/** Timestamp when scan was created */
	createdAt: number;
}

export interface ScansState {
	scans: Scan[];
	activeScanId: string | null;
}

// ================================
// Default Values
// ================================

const defaultScanOptions: ScanOptions = {
	includeHidden: false,
	batchSize: 1000,
	disableArchives: false
};

const defaultScanResult: ScanResult = {
	filesDiscovered: 0,
	duplicateFiles: 0,
	duplicateGroups: 0,
	folders: 0,
	emptyFolders: 0,
	emptyFiles: 0,
	hiddenFiles: 0,
	archives: 0,
	archiveEntries: 0,
	totalSize: 0,
	filesHashed: 0,
	filesToHash: 0
};

// ================================
// Helper Functions
// ================================

/** Generate a unique ID using crypto.randomUUID() */
function generateId(): string {
	return crypto.randomUUID();
}

/** Extract folder name from a path */
export function getFolderName(path: string | null): string {
	if (!path) return 'New Scan';
	// Handle both Windows and Unix paths
	const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
	return parts[parts.length - 1] || path;
}

/** Create a new scan with default values */
export function createScan(): Scan {
	const id = generateId();
	return {
		id,
		scanId: null,
		dbName: `archifiltre-scan-${id}`,
		name: 'New Scan',
		path: null,
		state: 'idle',
		scanOptions: { ...defaultScanOptions },
		scanResult: { ...defaultScanResult },
		terminalOutput: [],
		scanProgress: '',
		scanPhase: 'discovery',
		errorMessage: null,
		createdAt: Date.now()
	};
}

// ================================
// localStorage Persistence
// ================================

const STORAGE_KEY = 'archifiltre-scans';

/** Save scans state to localStorage */
function saveToStorage(state: ScansState): void {
	try {
		// Don't persist terminal output (too large) - it will be empty on reload
		const persistableState: ScansState = {
			...state,
			scans: state.scans.map((scan) => ({
				...scan,
				terminalOutput: [], // Clear terminal output for storage
				// An interrupted scan (still 'scanning' when the app closes) persists as
				// 'paused', KEEPING scanId/dbName, so on relaunch the tab offers Continue
				// (resume the frontier remainder) instead of dropping to the Drop-zone.
				state: scan.state === 'scanning' ? 'paused' : scan.state,
				pauseRequested: false,
				scanId: scan.scanId
			}))
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(persistableState));
	} catch (error) {
		console.warn('Failed to save scans to localStorage:', error);
	}
}

/** Load scans state from localStorage */
function loadFromStorage(): ScansState | null {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return null;

		const state = JSON.parse(stored) as ScansState;

		// Validate loaded state
		if (!state.scans || !Array.isArray(state.scans)) {
			return null;
		}

		// Ensure all scans have required fields (migration safety)
		state.scans = state.scans.map((scan) => ({
			...createScan(),
			...scan,
			terminalOutput: [], // Always start with empty terminal
			// Migration: rename "New Tab" to "New Scan"
			name: scan.name === 'New Tab' ? 'New Scan' : scan.name,
			// Migration: update old dbName format
			dbName: scan.dbName?.startsWith('archifiltre-') ? scan.dbName : `archifiltre-scan-${scan.id}`
		}));

		return state;
	} catch (error) {
		console.warn('Failed to load scans from localStorage:', error);
		return null;
	}
}

// ================================
// Scans Store
// ================================

function createScansStore() {
	// Load initial state from localStorage or create default
	const initial = loadFromStorage() || {
		scans: [createScan()],
		activeScanId: null
	};

	// Ensure there's always at least one scan
	if (initial.scans.length === 0) {
		initial.scans = [createScan()];
	}

	// Ensure activeScanId is valid
	if (!initial.activeScanId || !initial.scans.find((s) => s.id === initial.activeScanId)) {
		initial.activeScanId = initial.scans[0].id;
	}

	const { subscribe, set, update } = writable<ScansState>(initial);

	// Auto-save to localStorage on changes
	let saveTimeout: ReturnType<typeof setTimeout> | null = null;
	subscribe((state) => {
		// Debounce saves to avoid excessive writes
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => saveToStorage(state), 100);
	});

	return {
		subscribe,
		set,
		update,

		/** Add a new scan and make it active */
		addScan: () => {
			const newScan = createScan();
			update((state) => ({
				scans: [...state.scans, newScan],
				activeScanId: newScan.id
			}));
			return newScan;
		},

		/** Adopt scans discovered on disk that the UI didn't know about (startup
		 *  reconciliation). Skips any whose dbName already matches a known scan; drops a
		 *  leading empty "New Scan" placeholder if real scans are being adopted. Does NOT
		 *  change the active scan (the user's current tab stays put). */
		adoptScans: (incoming: Scan[]) => {
			if (incoming.length === 0) return;
			update((state) => {
				const known = new Set(state.scans.map((s) => s.dbName));
				const fresh = incoming.filter((s) => !known.has(s.dbName));
				if (fresh.length === 0) return state;
				// Drop a lone idle placeholder so recovered scans don't sit behind an empty tab.
				const base =
					state.scans.length === 1 && state.scans[0].state === 'idle' && !state.scans[0].path
						? []
						: state.scans;
				const scans = [...base, ...fresh];
				const activeScanId = state.activeScanId ?? scans[0]?.id ?? null;
				return { scans, activeScanId };
			});
		},

		/** Close/delete a scan by ID */
		closeScan: (scanId: string) => {
			update((state) => {
				const scanIndex = state.scans.findIndex((s) => s.id === scanId);
				if (scanIndex === -1) return state;

				const newScans = state.scans.filter((s) => s.id !== scanId);

				// Ensure at least one scan remains
				if (newScans.length === 0) {
					newScans.push(createScan());
				}

				// Update active scan if we closed the active one
				let newActiveId = state.activeScanId;
				if (state.activeScanId === scanId) {
					// Try to activate the scan to the left, or the first scan
					const newIndex = Math.max(0, scanIndex - 1);
					newActiveId = newScans[newIndex]?.id ?? newScans[0].id;
				}

				return {
					scans: newScans,
					activeScanId: newActiveId
				};
			});
		},

		/** Set the active scan */
		setActiveScan: (scanId: string) => {
			update((state) => ({
				...state,
				activeScanId: scanId
			}));
		},

		/** Update a specific scan */
		updateScan: (scanId: string, updates: Partial<Scan>) => {
			update((state) => ({
				...state,
				scans: state.scans.map((scan) => (scan.id === scanId ? { ...scan, ...updates } : scan))
			}));
		},

		/** Get a scan by ID */
		getScan: (scanId: string): Scan | undefined => {
			return get({ subscribe }).scans.find((s) => s.id === scanId);
		},

		/** Find scan by scanId (for event routing) */
		findScanByScanId: (scanId: string): Scan | undefined => {
			return get({ subscribe }).scans.find((s) => s.scanId === scanId);
		},

		/** Find scan by jobId — jobId equals scanId for scan jobs */
		findScanByJobId: (jobId: string): Scan | undefined => {
			return get({ subscribe }).scans.find((s) => s.scanId === jobId);
		},

		// Legacy aliases for backwards compatibility
		addTab: function () {
			return this.addScan();
		},
		closeTab: function (id: string) {
			return this.closeScan(id);
		},
		setActiveTab: function (id: string) {
			return this.setActiveScan(id);
		},
		updateTab: function (id: string, updates: Partial<Scan>) {
			return this.updateScan(id, updates);
		},
		getTab: function (id: string) {
			return this.getScan(id);
		},
		findTabByScanId: function (scanId: string) {
			return this.findScanByScanId(scanId);
		}
	};
}

export const scansStore = createScansStore();

// ================================
// Derived Stores
// ================================

/** The currently active scan */
export const activeScan = derived(scansStore, ($store) => {
	return $store.scans.find((s) => s.id === $store.activeScanId) ?? $store.scans[0];
});

/** All scans */
export const scans = derived(scansStore, ($store) => $store.scans);

/** Active scan ID */
export const activeScanId = derived(scansStore, ($store) => $store.activeScanId);

/** Check if the active scan is scanning */
export const isScanning = derived(activeScan, ($scan) => $scan?.state === 'scanning');

/** Check if any scan is scanning */
export const hasActiveScans = derived(scansStore, ($store) =>
	$store.scans.some((s) => s.state === 'scanning')
);

// ================================
// Legacy Compatibility Stores
// These maintain backwards compatibility during migration
// ================================

/** Current application state (from active scan) - LEGACY */
export const appState = derived(activeScan, ($scan) => $scan?.state ?? 'idle');

/** Error message (from active scan) - LEGACY */
export const errorMessage = derived(activeScan, ($scan) => $scan?.errorMessage ?? null);

/** Scan options (from active scan) - LEGACY */
export const scanOptions = derived(activeScan, ($scan) => ({
	path: $scan?.path ?? '',
	...$scan?.scanOptions
}));

/** Scan result (from active scan) - LEGACY */
export const scanResult = derived(activeScan, ($scan) => $scan?.scanResult ?? defaultScanResult);

/** Live resource telemetry from the single-owner session (owner mode). The session
 *  emits a `resource` event every ~500ms; the status bar shows it and the scan can
 *  be throttled against it. Null when idle / not in owner mode. */
export interface ResourceStats {
	cpuPct: number;
	rssMB: number;
	load1: number;
	cores: number;
	budget: number;
	scanning: boolean;
}
export const resourceStats = writable<ResourceStats | null>(null);

/** Terminal output (from active scan) - LEGACY */
export const terminalOutput = derived(activeScan, ($scan) => $scan?.terminalOutput ?? []);

/** Scan progress (from active scan) - LEGACY */
export const scanProgress = derived(activeScan, ($scan) => $scan?.scanProgress ?? '');

/** Scan phase (from active scan) - LEGACY */
export const scanPhase = derived(activeScan, ($scan): ScanPhase => $scan?.scanPhase ?? 'discovery');

/**
 * True while a scan is actively enumerating the filesystem — file/folder counts and the
 * tree are still growing. Drives the "still discovering" pulse on the live graph, the
 * status-bar label, and the root panel's live counts. Once enumeration is done (prefilter
 * onward) the tree is stable, so the pulse stops even though the scan keeps running.
 */
export const isDiscovering = derived(
	activeScan,
	($scan): boolean =>
		$scan?.state === 'scanning' &&
		($scan.scanPhase === 'discovery' || $scan.scanPhase === 'ingestion')
);

/** Whether an operation is running (from active scan) - LEGACY */
export const isRunning = derived(activeScan, ($scan) => $scan?.state === 'scanning');

// Legacy aliases for backwards compatibility
export const tabs = scans;
export const activeTab = activeScan;
export const activeTabId = activeScanId;
export const tabsStore = scansStore;
export type Tab = Scan;
export type TabState = ScanState;

// ================================
// Global Stores (not per-scan)
// ================================

/** CLI version string */
export const cliVersion = writable<string | null>(null);

// View mode store for Stalactite/Tree/Flat toggle (shared between layout and page)
export type ViewMode = 'stalactite' | 'tree' | 'flat';
export const viewMode = writable<ViewMode>('stalactite');

/** Icicle colour mode — by file type or by date. Shared so the header can drive
 *  the toggle while the chart renders from it. */
export const colorMode = writable<'type' | 'date'>('type');

/** Which tab the details panel's right column shows — the item's own metadata
 *  ('details') or the user-authored enrichment ('enrichment'). Kept here (not per
 *  panel instance) so it PERSISTS across selections: pick "Enrichment" once and
 *  enrich file after file without the tab snapping back on every new selection. */
export type PanelTab = 'details' | 'enrichment';
export const panelTab = writable<PanelTab>('details');

/** Icicle sibling ordering — folders always come first; this picks the order WITHIN
 *  each group: biggest→smallest, A→Z, or oldest→newest (by a folder's median descendant
 *  date / a file's mtime). */
export type SortMode = 'size' | 'name' | 'date';
export const sortMode = writable<SortMode>('size');

/** List-view controls, lifted out of ListView so the shared header toolbar can drive
 *  them (arrangement, quick filters, search). */
export type ListMode = 'flat' | 'folders' | 'dupes';
export const listMode = writable<ListMode>('flat');
export const listFilters = writable({ marked: false, tagged: false, big: false });
export const listSearch = writable('');

// Selected item store for details panel (shared across all views)
export interface SelectedItem {
	type: 'file' | 'directory';
	path: string;
	name: string;
	size: number;
	// Directory-specific fields
	fileCount?: number;
	dirCount?: number;
	totalSize?: number;
	/** Levels the deepest descendant sits below this directory. */
	maxDepth?: number;
	/** Path of that deepest descendant. */
	deepestPath?: string | null;
	// File-specific fields
	contentSize?: number | null;
	mtime?: number;
	isHidden?: boolean;
	hash?: string | null;
	isArchive?: boolean;
	archiveFormat?: string | null;
}

export const selectedItem = writable<SelectedItem | null>(null);

/**
 * On-screen horizontal span [left, right] of the selected block, in the chart's
 * CSS-pixel space (which the details panel shares). The panel draws its conduit
 * connector from this span down to the full panel width. `null` = no chart
 * position (e.g. the root folder) → the connector spans the full width.
 */
export interface ItemSpan {
	left: number;
	right: number;
	/** The block's fill colour, so the conduit can tint toward it (a gradient
	 *  "pour" of the block's identity into the detail view). Absent for the root. */
	color?: string;
	/** Distance (CSS px) from the block's on-screen bottom edge up to the chart's
	 *  bottom (the seam). The conduit's stem extends up by this much so it touches
	 *  the item. Updated live as the view zooms/pans. Absent for the root. */
	gap?: number;
}

/** Span of the selected item (for drawing the conduit connector) */
export const selectedItemSpan = writable<ItemSpan | null>(null);

/** Hovered item for preview in drawer */
export const hoveredItem = writable<SelectedItem | null>(null);

/** Span of the hovered item */
export const hoveredItemSpan = writable<ItemSpan | null>(null);

/** Clear the selected item */
export function clearSelectedItem(): void {
	selectedItem.set(null);
	selectedItemSpan.set(null);
}

/** Clear the hovered item */
export function clearHoveredItem(): void {
	hoveredItem.set(null);
	hoveredItemSpan.set(null);
}

/** Set the hovered item from a directory node */
export function hoverDirectory(
	node: {
		path: string;
		name: string;
		total_size: number;
		file_count: number;
		dir_count: number;
		max_depth?: number;
		deepest_path?: string | null;
	},
	span?: ItemSpan
): void {
	hoveredItem.set({
		type: 'directory',
		path: node.path,
		name: node.name,
		size: node.total_size,
		totalSize: node.total_size,
		fileCount: node.file_count,
		dirCount: node.dir_count,
		maxDepth: node.max_depth,
		deepestPath: node.deepest_path ?? null
	});
	if (span) {
		hoveredItemSpan.set(span);
	}
}

/** Set the hovered item from a file node */
export function hoverFile(
	file: {
		path: string;
		name: string;
		size: number;
		content_size?: number | null;
		mtime?: number;
		is_hidden?: boolean;
		hash?: string | null;
		is_archive?: boolean;
		archive_format?: string | null;
	},
	span?: ItemSpan
): void {
	hoveredItem.set({
		type: 'file',
		path: file.path,
		name: file.name,
		size: file.size,
		contentSize: file.content_size,
		mtime: file.mtime,
		isHidden: file.is_hidden,
		hash: file.hash,
		isArchive: file.is_archive,
		archiveFormat: file.archive_format
	});
	if (span) {
		hoveredItemSpan.set(span);
	}
}

/** Set the selected item from a directory node */
export function selectDirectory(
	node: {
		path: string;
		name: string;
		total_size: number;
		file_count: number;
		dir_count: number;
		max_depth?: number;
		deepest_path?: string | null;
	},
	span?: ItemSpan
): void {
	selectedItem.set({
		type: 'directory',
		path: node.path,
		name: node.name,
		size: node.total_size,
		totalSize: node.total_size,
		fileCount: node.file_count,
		dirCount: node.dir_count,
		maxDepth: node.max_depth,
		deepestPath: node.deepest_path ?? null
	});
	if (span) {
		selectedItemSpan.set(span);
	}
}

/** Set the selected item from a file node */
export function selectFile(
	file: {
		path: string;
		name: string;
		size: number;
		content_size?: number | null;
		mtime?: number;
		is_hidden?: boolean;
		hash?: string | null;
		is_archive?: boolean;
		archive_format?: string | null;
	},
	span?: ItemSpan
): void {
	selectedItem.set({
		type: 'file',
		path: file.path,
		name: file.name,
		size: file.size,
		contentSize: file.content_size,
		mtime: file.mtime,
		isHidden: file.is_hidden,
		hash: file.hash,
		isArchive: file.is_archive,
		archiveFormat: file.archive_format
	});
	if (span) {
		selectedItemSpan.set(span);
	}
}

/** Health status of the CLI */
export const healthStatus = writable<'unknown' | 'healthy' | 'unhealthy'>('unknown');

/** Detected platform for window controls */
export const platform = writable<Platform | undefined>(undefined);

/** Open-state for the Settings / About dialogs, shared so both the sidebar gear and
 *  the "Archifiltre" app menu can drive them. */
export const settingsOpen = writable(false);
export const aboutOpen = writable(false);

/** A boolean writable persisted to localStorage. */
function persistedBool(key: string, def: boolean) {
	let initial = def;
	try {
		const v = localStorage.getItem(key);
		if (v !== null) initial = v === '1';
	} catch {
		/* no localStorage (prerender) */
	}
	const store = writable(initial);
	store.subscribe((v) => {
		try {
			localStorage.setItem(key, v ? '1' : '0');
		} catch {
			/* ignore */
		}
	});
	return store;
}

/** Window effect (macOS vibrancy / Windows acrylic / Linux translucency) vs. a solid
 *  surface. On by default; turning it off shows a light-gray (dark: near-black) frame. */
export const windowEffect = persistedBool('archifiltre-window-effect', true);

/** A JSON-serialisable value persisted to localStorage (merged over `def` so new fields
 *  added later still get defaults). */
function persistedJson<T extends object>(key: string, def: T) {
	let initial = def;
	try {
		const v = localStorage.getItem(key);
		if (v !== null) initial = { ...def, ...JSON.parse(v) };
	} catch {
		/* no localStorage / bad JSON → defaults */
	}
	const store = writable<T>(initial);
	store.subscribe((v) => {
		try {
			localStorage.setItem(key, JSON.stringify(v));
		} catch {
			/* ignore */
		}
	});
	return store;
}

/** Credentials + model for the AI directory-summary LLM, set from Settings › AI.
 *  Persisted locally and sent with each describe request; empty fields fall back to the
 *  sidecar's LLM_BASE_URL / LLM_API_KEY / LLM_MODEL environment variables. The API key
 *  never leaves this machine (it travels only over the local sidecar stdio pipe). */
export interface LlmConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}
export const llmConfig = persistedJson<LlmConfig>('archifiltre-llm-config', {
	baseUrl: '',
	apiKey: '',
	model: ''
});

/** How AI (directory summaries) is provided. `off` disables it entirely; `external` uses
 *  the credentials in {@link llmConfig} (or the LLM_* env fallback); `webllm` (in-browser,
 *  no server) is planned but disabled for now. Defaults to `external` to preserve the
 *  existing env-configured behaviour. */
export type AiMode = 'off' | 'webllm' | 'external';
function persistedStr<T extends string>(key: string, def: T) {
	let initial = def;
	try {
		const v = localStorage.getItem(key);
		if (v !== null) initial = v as T;
	} catch {
		/* no localStorage */
	}
	const store = writable<T>(initial);
	store.subscribe((v) => {
		try {
			localStorage.setItem(key, v);
		} catch {
			/* ignore */
		}
	});
	return store;
}
export const aiMode = persistedStr<AiMode>('archifiltre-ai-mode', 'external');

// ================================
// Scan Actions
// ================================

let terminalLineIdCounter = 0;

/** Add a terminal line to a specific scan */
export function addTerminalLineToScan(
	scanId: string,
	text: string,
	stream: TerminalLine['stream'] = 'stdout'
): void {
	scansStore.updateScan(scanId, {
		terminalOutput: [
			...(scansStore.getScan(scanId)?.terminalOutput ?? []),
			{ id: terminalLineIdCounter++, text, stream, timestamp: new Date() }
		]
	});
}

/** Add a terminal line to the active scan (legacy compatibility) */
export function addTerminalLine(text: string, stream: TerminalLine['stream'] = 'stdout'): void {
	const scan = get(activeScan);
	if (scan) {
		addTerminalLineToScan(scan.id, text, stream);
	}
}

// Legacy alias
export const addTerminalLineToTab = addTerminalLineToScan;

/** Clear terminal for a specific scan */
export function clearTerminalForScan(scanId: string): void {
	scansStore.updateScan(scanId, { terminalOutput: [] });
}

/** Clear terminal for active scan (legacy compatibility) */
export function clearTerminal(): void {
	const scan = get(activeScan);
	if (scan) {
		clearTerminalForScan(scan.id);
	}
}

interface JobProgressEvent {
	event: 'job:progress';
	jobId: string;
	phase: string;
	processed: number;
	total: number | null;
	detail: string;
}

function tryParseJsonProgressEvent(line: string): JobProgressEvent | null {
	try {
		const parsed = JSON.parse(line);
		if (parsed?.event === 'job:progress') return parsed as JobProgressEvent;
	} catch {
		/* not JSON */
	}
	return null;
}

/** Parse scan output and update results for a specific scan */
export function parseScanOutputForScan(scanId: string, line: string): void {
	const scan = scansStore.getScan(scanId);
	if (!scan) return;

	const event = tryParseJsonProgressEvent(line);
	if (event) {
		const validPhases: ScanPhase[] = [
			'discovery',
			'ingestion',
			'prefilter',
			'hashing',
			'duplicate-detection',
			'complete'
		];
		const phase = validPhases.includes(event.phase as ScanPhase)
			? (event.phase as ScanPhase)
			: scan.scanPhase;
		// processed/total are phase-aware (see scanProgressMetrics): hashing counts
		// checksums, every other phase counts discovered files.
		const metrics =
			event.phase === 'hashing'
				? { filesHashed: event.processed, filesToHash: event.total ?? 0 }
				: { filesDiscovered: event.processed };
		scansStore.updateScan(scanId, {
			scanPhase: phase,
			scanProgress: event.detail,
			scanResult: { ...scan.scanResult, ...metrics }
		});
		return;
	}

	const updates: Partial<ScanResult> = {};

	// Files discovered: 3,414
	const filesMatch = line.match(/Files discovered:\s*([\d,]+)/i);
	if (filesMatch) {
		updates.filesDiscovered = parseInt(filesMatch[1].replace(/,/g, ''), 10);
	}

	// Duplicates: 780 files in 236 groups
	const dupMatch = line.match(/Duplicates:\s*([\d,]+)\s*files?\s*in\s*([\d,]+)\s*groups?/i);
	if (dupMatch) {
		updates.duplicateFiles = parseInt(dupMatch[1].replace(/,/g, ''), 10);
		updates.duplicateGroups = parseInt(dupMatch[2].replace(/,/g, ''), 10);
	}

	// Folders: 463 (must not match "Empty folders")
	const foldersMatch = line.match(/^\s*Folders:\s*([\d,]+)/im);
	if (foldersMatch && !line.toLowerCase().includes('empty folders')) {
		updates.folders = parseInt(foldersMatch[1].replace(/,/g, ''), 10);
	}

	// Empty folders: 1
	const emptyFoldersMatch = line.match(/Empty folders:\s*([\d,]+)/i);
	if (emptyFoldersMatch) {
		updates.emptyFolders = parseInt(emptyFoldersMatch[1].replace(/,/g, ''), 10);
	}

	// Empty files: 197
	const emptyFilesMatch = line.match(/Empty files:\s*([\d,]+)/i);
	if (emptyFilesMatch) {
		updates.emptyFiles = parseInt(emptyFilesMatch[1].replace(/,/g, ''), 10);
	}

	// Hidden files: 440
	const hiddenMatch = line.match(/Hidden files:\s*([\d,]+)/i);
	if (hiddenMatch) {
		updates.hiddenFiles = parseInt(hiddenMatch[1].replace(/,/g, ''), 10);
	}

	// Archives: 11
	const archivesMatch = line.match(/^\s*Archives:\s*([\d,]+)/im);
	if (archivesMatch && !line.toLowerCase().includes('archive entries')) {
		updates.archives = parseInt(archivesMatch[1].replace(/,/g, ''), 10);
	}

	// Archive entries: 46
	const archiveEntriesMatch = line.match(/Archive entries:\s*([\d,]+)/i);
	if (archiveEntriesMatch) {
		updates.archiveEntries = parseInt(archiveEntriesMatch[1].replace(/,/g, ''), 10);
	}

	// Total size: X (if present)
	const sizeMatch = line.match(/Total size:\s*([\d,]+)/i);
	if (sizeMatch) {
		updates.totalSize = parseInt(sizeMatch[1].replace(/,/g, ''), 10);
	}

	// Apply updates if any
	if (Object.keys(updates).length > 0) {
		scansStore.updateScan(scanId, {
			scanResult: { ...scan.scanResult, ...updates }
		});
	}
}

/** Parse scan output for active scan (legacy compatibility) */
export function parseScanOutput(line: string): void {
	const scan = get(activeScan);
	if (scan) {
		parseScanOutputForScan(scan.id, line);
	}
}

// Legacy alias
export const parseScanOutputForTab = parseScanOutputForScan;

/** Start scanning for a specific scan */
export function startScanningScan(scanId: string, path: string, eventScanId: string): void {
	const folderName = getFolderName(path);
	scansStore.updateScan(scanId, {
		state: 'scanning',
		path,
		name: folderName,
		scanId: eventScanId,
		scanResult: { ...defaultScanResult },
		terminalOutput: [],
		scanProgress: '',
		scanPhase: 'discovery',
		errorMessage: null
	});
}

/** Start scanning (legacy compatibility - uses active scan) */
export function startScanning(path: string): void {
	const scan = get(activeScan);
	if (scan) {
		// Note: scanId should be set separately before calling this
		startScanningScan(scan.id, path, scan.scanId ?? '');
	}
}

// Legacy alias
export const startScanningTab = startScanningScan;

/** Finish scanning for a specific scan */
export function finishScanningScan(scanId: string, success: boolean): void {
	scansStore.updateScan(scanId, {
		state: success ? 'complete' : 'error',
		scanId: null, // Clear scanId after completion
		errorMessage: success ? null : 'Analysis failed. Please check the folder and try again.'
	});
}

/** Finish scanning (legacy compatibility) */
export function finishScanning(success: boolean): void {
	const scan = get(activeScan);
	if (scan) {
		finishScanningScan(scan.id, success);
	}
}

/** Mark a scan paused (keeps scanId/dbName + the partial data so the frozen tree shows
 *  and Continue can resume). State only — the caller issues the owner pause_scan. */
export function pauseScanningScan(scanId: string): void {
	scansStore.updateScan(scanId, { state: 'paused', pauseRequested: false });
}

/** Mark a paused scan scanning again (the caller issues the owner resume_scan). */
export function resumeScanningScan(scanId: string): void {
	scansStore.updateScan(scanId, { state: 'scanning', pauseRequested: false, errorMessage: null });
}

/** Pause clicked: flip the button to "Pausing…" instantly; the session's job:paused
 *  reconciles to 'paused'. `on=false` reverts (the pause request failed). */
export function requestPauseScanningScan(scanId: string, on = true): void {
	scansStore.updateScan(scanId, { pauseRequested: on });
}

// Legacy alias
export const finishScanningTab = finishScanningScan;

/** Set error for a specific scan */
export function setErrorForScan(scanId: string, message: string): void {
	scansStore.updateScan(scanId, {
		state: 'error',
		errorMessage: message,
		scanId: null
	});
}

/** Set error (legacy compatibility) */
export function setError(message: string): void {
	const scan = get(activeScan);
	if (scan) {
		setErrorForScan(scan.id, message);
	}
}

// Legacy alias
export const setErrorForTab = setErrorForScan;

/** Reset a specific scan to idle state */
export function resetScan(scanId: string): void {
	scansStore.updateScan(scanId, {
		state: 'idle',
		path: null,
		name: 'New Scan',
		scanId: null,
		scanResult: { ...defaultScanResult },
		terminalOutput: [],
		scanProgress: '',
		scanPhase: 'discovery',
		errorMessage: null
	});
}

/** Reset active scan (legacy compatibility) */
export function resetApp(): void {
	const scan = get(activeScan);
	if (scan) {
		resetScan(scan.id);
	}
}

// Legacy alias
export const resetTab = resetScan;

/** Set app state for legacy compatibility */
export function setAppState(state: ScanState): void {
	const scan = get(activeScan);
	if (scan) {
		scansStore.updateScan(scan.id, { state });
	}
}

// ================================
// Enrichment — tag dictionary
// ================================
//
// PGlite is the single source of truth for enrichment (see project memory
// "PGlite is the CENTER"). The ONLY enrichment state kept in a long-lived
// store is the tag dictionary: a small per-run lookup of tag_id -> name that
// the tag picker and chip labels need. Per-element aliases/comments/tag
// assignments are NOT stored here — they are read via query-on-select and, for
// the visualization, via joins in the tree/files queries.

/** Tag dictionary for the active scan: tag_id -> name */
export const tagDictionary = writable<Map<string, string>>(new Map());

/** Replace the dictionary from a hydration snapshot (called on scan load). */
export function hydrateTagDictionary(tags: Tag[]): void {
	tagDictionary.set(new Map(tags.map((t) => [t.tag_id, t.name])));
}

/** Reflect a newly created tag in the dictionary. */
export function addTagToDictionary(tagId: string, name: string): void {
	tagDictionary.update((d) => new Map(d).set(tagId, name));
}

/** Reflect a tag rename in the dictionary. */
export function renameTagInDictionary(tagId: string, name: string): void {
	tagDictionary.update((d) => {
		if (!d.has(tagId)) return d;
		return new Map(d).set(tagId, name);
	});
}

/** Reflect a tag deletion in the dictionary. */
export function removeTagFromDictionary(tagId: string): void {
	tagDictionary.update((d) => {
		if (!d.has(tagId)) return d;
		const next = new Map(d);
		next.delete(tagId);
		return next;
	});
}

/** Tags sorted by name, for display in pickers. */
export const sortedTags = derived(tagDictionary, ($d) =>
	[...$d.entries()]
		.map(([tag_id, name]) => ({ tag_id, name }))
		.sort((a, b) => a.name.localeCompare(b.name))
);

// ================================
// Provisional scan tree (live icicle during a scan)
// ================================
//
// Coarse, depth-capped directory aggregates streamed by the scanner (scan:tree
// events) while a scan runs, so the icicle grows live without reading the
// being-written DB. Keyed by scan id; cleared on completion when the real
// DB-backed tree takes over.

export const provisionalTrees = writable<Map<string, TreeData>>(new Map());

interface ProvisionalDirInput {
	path: string;
	total_size: number;
	file_count: number;
	dir_count: number;
}

/** Build/replace the provisional tree for a scan from a scan:tree snapshot. */
export function setProvisionalTree(scanId: string, directories: ProvisionalDirInput[]): void {
	const treeData: TreeData = {
		root: null,
		directories: directories.map((d) => {
			const parts = d.path.split('/').filter(Boolean);
			return {
				path: d.path,
				name: parts[parts.length - 1] ?? d.path,
				depth: parts.length, // top-level = 1 → min-depth roots; consistent with buildTreeHierarchy
				total_size: d.total_size,
				file_count: d.file_count,
				dir_count: d.dir_count,
				// no enrichment during a fresh scan
				alias: null,
				has_comment: false,
				has_tag: false,
				tagged_for_deletion: false
			} satisfies DirectoryNode;
		})
	};
	provisionalTrees.update((m) => new Map(m).set(scanId, treeData));
}

/** Drop a scan's provisional tree (on completion/error/restart). */
export function clearProvisionalTree(scanId: string): void {
	provisionalTrees.update((m) => {
		if (!m.has(scanId)) return m;
		const next = new Map(m);
		next.delete(scanId);
		return next;
	});
}

/** The active scan's provisional tree, or null. */
export const activeProvisionalTree = derived(
	[provisionalTrees, activeScan],
	([$trees, $scan]) => ($scan ? ($trees.get($scan.id) ?? null) : null)
);

// ================================
// Enrichment — save status (feedback)
// ================================
//
// Ephemeral UI feedback for enrichment writes, driven by the actual DB ack (never
// optimistic, so it can't lie). The details panel reports each write; the status
// bar reflects the latest. 'saved' auto-clears after a moment; 'error' persists
// until the next write.

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface EnrichmentSaveStatus {
	state: SaveState;
	/** Which field the status refers to: 'alias' | 'comment' | 'tag' | 'deletion'. */
	field: string | null;
	at: number;
}

export const enrichmentSaveStatus = writable<EnrichmentSaveStatus>({
	state: 'idle',
	field: null,
	at: 0
});

let saveStatusResetTimer: ReturnType<typeof setTimeout> | null = null;

/** Report the outcome of an enrichment write. Drives the status bar + per-field UI. */
export function reportSaveStatus(state: SaveState, field: string | null = null): void {
	enrichmentSaveStatus.set({ state, field, at: Date.now() });
	if (saveStatusResetTimer) {
		clearTimeout(saveStatusResetTimer);
		saveStatusResetTimer = null;
	}
	// 'saved' is transient; 'saving' resolves to saved/error; 'error' persists.
	if (state === 'saved') {
		saveStatusResetTimer = setTimeout(() => {
			enrichmentSaveStatus.set({ state: 'idle', field: null, at: Date.now() });
		}, 2000);
	}
}

// ================================
// Enrichment — live invalidation
// ================================
//
// After an enrichment write, the visualization must re-read the affected rows
// from PGlite (the source of truth) so bands and alias labels update live. We
// signal *what* changed rather than caching enrichment on nodes: the chart and
// page re-query the DB. `cascade` is true for deletion toggles, whose effect
// propagates to descendants (see v4 semantics); alias/comment/tag changes
// affect only the exact element.

export interface EnrichmentInvalidation {
	path: string;
	cascade: boolean;
	/** Strictly increasing, so repeated edits to the same path still fire. */
	nonce: number;
}

export const enrichmentInvalidation = writable<EnrichmentInvalidation | null>(null);

let invalidationNonce = 0;

/** Signal that the given path's enrichment changed and consumers should re-read. */
export function invalidateEnrichment(path: string, cascade: boolean): void {
	enrichmentInvalidation.set({ path, cascade, nonce: ++invalidationNonce });
}

// ================================
// Platform Detection
// ================================

/**
 * Detect the current platform for window controls.
 */
export async function detectPlatform(): Promise<Platform> {
	try {
		const { type } = await import('@tauri-apps/plugin-os');
		const osType = await type();

		let detectedPlatform: Platform;
		switch (osType) {
			case 'macos':
				detectedPlatform = 'macos';
				break;
			case 'linux':
				detectedPlatform = 'gnome';
				break;
			default:
				detectedPlatform = 'windows';
		}

		platform.set(detectedPlatform);
		return detectedPlatform;
	} catch {
		// Fallback to windows if detection fails (e.g., running in browser)
		platform.set('windows');
		return 'windows';
	}
}
