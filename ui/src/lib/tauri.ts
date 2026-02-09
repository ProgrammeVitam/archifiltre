/**
 * Tauri API Wrapper
 * Provides typed functions to interact with the Tauri backend commands.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';

// ================================
// Types
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

export interface ChecksumOptions {
	algorithm?: 'xxhash64' | 'md5' | 'sha256' | 'sha512';
	each_file?: boolean;
}

export interface ExportOptions {
	output_path: string;
	full_paths?: boolean;
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

export async function selectFolder(): Promise<string | null> {
	const result = await openDialog({
		directory: true,
		multiple: false,
		title: 'Select a folder to scan'
	});
	if (typeof result === 'string') {
		return result;
	}
	return null;
}

export async function selectExportPath(): Promise<string | null> {
	const result = await saveDialog({
		title: 'Save CSV Export',
		defaultPath: 'archifiltre-export.csv',
		filters: [{ name: 'CSV Files', extensions: ['csv'] }]
	});
	return result;
}

// ================================
// Command Functions
// ================================

export async function healthCheck(): Promise<CommandResult> {
	return await invoke<CommandResult>('health_check');
}

export async function getVersion(): Promise<CommandResult> {
	return await invoke<CommandResult>('get_version');
}

export async function getOperationState(): Promise<OperationState> {
	return await invoke<OperationState>('get_operation_state');
}

export async function scanDirectory(options: ScanOptions): Promise<CommandResult> {
	return await invoke<CommandResult>('scan_directory', { options });
}

export async function computeChecksums(options: ChecksumOptions = {}): Promise<CommandResult> {
	return await invoke<CommandResult>('compute_checksums', { options });
}

export async function exportCsv(options: ExportOptions): Promise<CommandResult> {
	return await invoke<CommandResult>('export_csv', { options });
}

// ================================
// Event Listeners
// ================================

export async function onScanProgress(callback: ProgressCallback): Promise<UnlistenFn> {
	return await listen<string>('scan-progress', (event) => callback(event.payload));
}

export async function onScanError(callback: ProgressCallback): Promise<UnlistenFn> {
	return await listen<string>('scan-error', (event) => callback(event.payload));
}

export async function onScanComplete(callback: CompleteCallback): Promise<UnlistenFn> {
	return await listen<boolean>('scan-complete', (event) => callback(event.payload));
}

export async function onChecksumProgress(callback: ProgressCallback): Promise<UnlistenFn> {
	return await listen<string>('checksum-progress', (event) => callback(event.payload));
}

export async function onChecksumError(callback: ProgressCallback): Promise<UnlistenFn> {
	return await listen<string>('checksum-error', (event) => callback(event.payload));
}

export async function onChecksumComplete(callback: CompleteCallback): Promise<UnlistenFn> {
	return await listen<boolean>('checksum-complete', (event) => callback(event.payload));
}

export async function onExportProgress(callback: ProgressCallback): Promise<UnlistenFn> {
	return await listen<string>('export-progress', (event) => callback(event.payload));
}

export async function onExportError(callback: ProgressCallback): Promise<UnlistenFn> {
	return await listen<string>('export-error', (event) => callback(event.payload));
}

export async function onExportComplete(callback: CompleteCallback): Promise<UnlistenFn> {
	return await listen<boolean>('export-complete', (event) => callback(event.payload));
}

// ================================
// Utility Functions
// ================================

export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const k = 1024;
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatNumber(num: number): string {
	return num.toLocaleString();
}
