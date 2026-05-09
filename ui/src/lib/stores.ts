/**
 * Svelte stores for Archifiltre UI state management
 *
 * Sidebar-based architecture with localStorage persistence.
 * Each scan has its own database and state.
 */

import { writable, derived, get } from 'svelte/store';

// ================================
// Types
// ================================

export type ScanState = 'idle' | 'scanning' | 'complete' | 'error';

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
}

export interface TerminalLine {
	id: number;
	text: string;
	stream: 'stdout' | 'stderr' | 'info' | 'success' | 'error';
	timestamp: Date;
}

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
	totalSize: 0
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
				// Reset scanning scans to idle (scan won't resume after restart)
				state: scan.state === 'scanning' ? 'idle' : scan.state,
				scanId: scan.state === 'scanning' ? null : scan.scanId
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

/** Terminal output (from active scan) - LEGACY */
export const terminalOutput = derived(activeScan, ($scan) => $scan?.terminalOutput ?? []);

/** Scan progress (from active scan) - LEGACY */
export const scanProgress = derived(activeScan, ($scan) => $scan?.scanProgress ?? '');

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

// View mode store for Chart/Table toggle (shared between layout and page)
export type ViewMode = 'chart' | 'table';
export const viewMode = writable<ViewMode>('chart');

/** Health status of the CLI */
export const healthStatus = writable<'unknown' | 'healthy' | 'unhealthy'>('unknown');

/** Detected platform for window controls */
export const platform = writable<Platform | undefined>(undefined);

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

/** Parse scan output and update results for a specific scan */
export function parseScanOutputForScan(scanId: string, line: string): void {
	const scan = scansStore.getScan(scanId);
	if (!scan) return;

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
