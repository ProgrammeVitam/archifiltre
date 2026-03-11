/**
 * Tauri API Wrapper
 * Provides typed functions to interact with the Tauri backend commands.
 * Focused on folder selection and analysis workflow
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

// ================================
// Basic Types
// ================================

export interface CommandResult {
	success: boolean;
	output: string;
	error: string | null;
}

export interface ScanOptions {
	path: string;
	include_hidden?: boolean;
	batch_size?: number;
	disable_archives?: boolean;
}

export interface PathValidationResult {
	valid: boolean;
	isDirectory: boolean;
	readable: boolean;
	exists: boolean;
	error?: string;
}

export interface OperationState {
	running: boolean;
	operation: string | null;
	progress: string | null;
}

export type ProgressCallback = (line: string) => void;
export type CompleteCallback = (success: boolean) => void;

// ================================
// Dialog Functions
// ================================

/**
 * Open a folder selection dialog.
 * Returns the selected folder path or null if cancelled.
 */
export async function selectFolder(): Promise<string | null> {
	const result = await openDialog({
		directory: true,
		multiple: false,
		title: 'Select a folder to analyze'
	});
	if (typeof result === 'string') {
		return result;
	}
	return null;
}

// ================================
// Path Validation
// ================================

/**
 * Validate a file system path.
 * Checks if the path exists, is a directory, and is readable.
 */
export async function validatePath(path: string): Promise<PathValidationResult> {
	try {
		return await invoke<PathValidationResult>('validate_path', { path });
	} catch (error) {
		return {
			valid: false,
			isDirectory: false,
			readable: false,
			exists: false,
			error: `Validation failed: ${error}`
		};
	}
}

// ================================
// Command Functions - Health & Version
// ================================

/**
 * Check if the CLI binary is healthy and accessible.
 */
export async function healthCheck(): Promise<CommandResult> {
	return await invoke<CommandResult>('health_check');
}

/**
 * Get the CLI version string.
 */
export async function getVersion(): Promise<CommandResult> {
	return await invoke<CommandResult>('get_version');
}

/**
 * Get the current operation state.
 * Used to check if an analysis is already running.
 */
export async function getOperationState(): Promise<OperationState> {
	return await invoke<OperationState>('get_operation_state');
}

// ================================
// Command Functions - Scan
// ================================

/**
 * Start scanning a directory.
 * This is an async operation - progress is reported via events.
 */
export async function scanDirectory(options: ScanOptions): Promise<CommandResult> {
	return await invoke<CommandResult>('scan_directory', { options });
}

// ================================
// Event Listeners
// ================================

/**
 * Listen for scan progress updates (stdout from CLI).
 */
export async function onScanProgress(callback: ProgressCallback): Promise<UnlistenFn> {
	return await listen<string>('scan-progress', (event) => callback(event.payload));
}

/**
 * Listen for scan errors (stderr from CLI).
 */
export async function onScanError(callback: ProgressCallback): Promise<UnlistenFn> {
	return await listen<string>('scan-error', (event) => callback(event.payload));
}

/**
 * Listen for scan completion.
 * @param callback - Called with true if successful, false if failed.
 */
export async function onScanComplete(callback: CompleteCallback): Promise<UnlistenFn> {
	return await listen<boolean>('scan-complete', (event) => callback(event.payload));
}

// ================================
// Utility Functions
// ================================

/**
 * Format bytes into a human-readable string.
 */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const k = 1024;
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Format a number with locale-specific thousand separators.
 */
export function formatNumber(num: number): string {
	return num.toLocaleString();
}
