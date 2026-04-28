/**
 * Svelte stores for Archifiltre UI state management
 * Focused on folder selection and analysis workflow
 */

import { writable, derived } from 'svelte/store';

// ================================
// Types
// ================================

export type AppState = 'idle' | 'scanning' | 'complete' | 'error';

export type Platform = 'windows' | 'macos' | 'gnome';

export interface ScanOptions {
	path: string;
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

export interface ScanProgressEvent {
	type: 'scan-progress';
	phase: ScanPhase;
	filesDiscovered: number;
	filesIngested: number;
	filesHashed?: number;
	filesToHash?: number;
	hashErrors?: number;
	duplicateSizes?: number;
	duplicateGroups: number;
	status: string;
}

// ================================
// Default Values
// ================================

const defaultScanOptions: ScanOptions = {
	path: '',
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
// Core App State Stores
// ================================

/** Current application state */
export const appState = writable<AppState>('idle');

/** Error message if any */
export const errorMessage = writable<string | null>(null);

/** CLI version string */
export const cliVersion = writable<string | null>(null);

/** Health status of the CLI */
export const healthStatus = writable<'unknown' | 'healthy' | 'unhealthy'>('unknown');

/** Whether an operation is running */
export const isRunning = writable(false);

/** Detected platform for window controls */
export const platform = writable<Platform | undefined>(undefined);

// ================================
// Scan Stores
// ================================

/** Scan configuration options */
export const scanOptions = writable<ScanOptions>(defaultScanOptions);

/** Scan result summary */
export const scanResult = writable<ScanResult>(defaultScanResult);

/** Terminal output lines */
export const terminalOutput = writable<TerminalLine[]>([]);

/** Current scan progress message */
export const scanProgress = writable<string>('');

/** Current scan phase */
export const scanPhase = writable<ScanPhase>('discovery');

// ================================
// Derived Stores
// ================================

/** Check if app is in a loading/scanning state */
export const isLoading = derived(appState, ($state) => $state === 'scanning');

/** Check if analysis completed successfully */
export const isComplete = derived(appState, ($state) => $state === 'complete');

/** Check if there's an error */
export const hasError = derived(appState, ($state) => $state === 'error');

// ================================
// Terminal Actions
// ================================

let terminalLineId = 0;

export function addTerminalLine(text: string, stream: TerminalLine['stream'] = 'stdout'): void {
	terminalOutput.update((lines) => [
		...lines,
		{ id: terminalLineId++, text, stream, timestamp: new Date() }
	]);
}

export function clearTerminal(): void {
	terminalOutput.set([]);
}

// ================================
// Scan Progress Event Parsing
// ================================

/**
 * Try to parse a line as a JSON ScanProgressEvent.
 * Returns the parsed event if successful, null otherwise.
 */
export function tryParseScanProgressEvent(line: string): ScanProgressEvent | null {
	try {
		const parsed = JSON.parse(line);
		if (parsed && parsed.type === 'scan-progress') {
			return parsed as ScanProgressEvent;
		}
	} catch {
		// Not JSON, ignore
	}
	return null;
}

/**
 * Handle a structured ScanProgressEvent and update stores accordingly.
 */
export function handleScanProgressEvent(event: ScanProgressEvent): void {
	// Update current phase
	scanPhase.set(event.phase);

	// Update progress message
	scanProgress.set(event.status);

	// Update scan result with all available data
	scanResult.update((r) => ({
		...r,
		filesDiscovered: event.filesDiscovered,
		filesHashed: event.filesHashed ?? r.filesHashed,
		filesToHash: event.filesToHash ?? r.filesToHash,
		duplicateGroups: event.duplicateGroups
	}));

	// Update files ingested if in ingestion phase or later
	if (event.filesIngested > 0) {
		scanResult.update((r) => ({
			...r,
			filesDiscovered: Math.max(r.filesDiscovered, event.filesIngested)
		}));
	}
}

// ================================
// Scan Output Parsing (Legacy - for non-JSON output)
// ================================

export function parseScanOutput(line: string): void {
	// Files discovered: 3,414
	const filesMatch = line.match(/Files discovered:\s*([\d,]+)/i);
	if (filesMatch) {
		scanResult.update((r) => ({
			...r,
			filesDiscovered: parseInt(filesMatch[1].replace(/,/g, ''), 10)
		}));
	}

	// Duplicates: 780 files in 236 groups
	const dupMatch = line.match(/Duplicates:\s*([\d,]+)\s*files?\s*in\s*([\d,]+)\s*groups?/i);
	if (dupMatch) {
		scanResult.update((r) => ({
			...r,
			duplicateFiles: parseInt(dupMatch[1].replace(/,/g, ''), 10),
			duplicateGroups: parseInt(dupMatch[2].replace(/,/g, ''), 10)
		}));
	}

	// Folders: 463 (must not match "Empty folders")
	const foldersMatch = line.match(/^\s*Folders:\s*([\d,]+)/im);
	if (foldersMatch && !line.toLowerCase().includes('empty folders')) {
		scanResult.update((r) => ({
			...r,
			folders: parseInt(foldersMatch[1].replace(/,/g, ''), 10)
		}));
	}

	// Empty folders: 1
	const emptyFoldersMatch = line.match(/Empty folders:\s*([\d,]+)/i);
	if (emptyFoldersMatch) {
		scanResult.update((r) => ({
			...r,
			emptyFolders: parseInt(emptyFoldersMatch[1].replace(/,/g, ''), 10)
		}));
	}

	// Empty files: 197
	const emptyFilesMatch = line.match(/Empty files:\s*([\d,]+)/i);
	if (emptyFilesMatch) {
		scanResult.update((r) => ({
			...r,
			emptyFiles: parseInt(emptyFilesMatch[1].replace(/,/g, ''), 10)
		}));
	}

	// Hidden files: 440
	const hiddenMatch = line.match(/Hidden files:\s*([\d,]+)/i);
	if (hiddenMatch) {
		scanResult.update((r) => ({
			...r,
			hiddenFiles: parseInt(hiddenMatch[1].replace(/,/g, ''), 10)
		}));
	}

	// Archives: 11
	const archivesMatch = line.match(/^\s*Archives:\s*([\d,]+)/im);
	if (archivesMatch && !line.toLowerCase().includes('archive entries')) {
		scanResult.update((r) => ({
			...r,
			archives: parseInt(archivesMatch[1].replace(/,/g, ''), 10)
		}));
	}

	// Archive entries: 46
	const archiveEntriesMatch = line.match(/Archive entries:\s*([\d,]+)/i);
	if (archiveEntriesMatch) {
		scanResult.update((r) => ({
			...r,
			archiveEntries: parseInt(archiveEntriesMatch[1].replace(/,/g, ''), 10)
		}));
	}

	// Total size: X (if present)
	const sizeMatch = line.match(/Total size:\s*([\d,]+)/i);
	if (sizeMatch) {
		scanResult.update((r) => ({
			...r,
			totalSize: parseInt(sizeMatch[1].replace(/,/g, ''), 10)
		}));
	}
}

// ================================
// App State Actions
// ================================

export function setAppState(state: AppState): void {
	appState.set(state);
	if (state !== 'error') {
		errorMessage.set(null);
	}
}

export function setError(message: string): void {
	appState.set('error');
	errorMessage.set(message);
	isRunning.set(false);
}

export function startScanning(path: string): void {
	scanOptions.update((opts) => ({ ...opts, path }));
	scanResult.set(defaultScanResult);
	clearTerminal();
	setAppState('scanning');
	isRunning.set(true);
}

export function finishScanning(success: boolean): void {
	isRunning.set(false);
	if (success) {
		setAppState('complete');
	} else {
		setAppState('error');
		if (!errorMessage) {
			errorMessage.set('Analysis failed. Please check the folder and try again.');
		}
	}
}

export function resetApp(): void {
	// Reset all state to defaults
	appState.set('idle');
	errorMessage.set(null);
	isRunning.set(false);
	scanOptions.set(defaultScanOptions);
	scanResult.set(defaultScanResult);
	terminalOutput.set([]);
	scanProgress.set('');
	scanPhase.set('discovery');
}

// ================================
// Platform Detection
// ================================

/**
 * Detect the current platform for window controls.
 * This is a workaround for @tauri-controls/svelte not properly
 * awaiting the async OS detection from @tauri-apps/plugin-os.
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
