/**
 * "Export logs" support-bundle flow: native save dialog → sidecar `logs --export`
 * (spawned by the Rust `export_logs` command) with the frontend snapshot piped over
 * stdin. The bundle (.zip) contains the sidecar's rotated log files, `frontend.log`
 * (the webview error ring buffer — see log-buffer.ts), `ui-state.json` (a summary of
 * the session: scans, states, recent terminal lines) and `system-info.txt`.
 *
 * Deliberately DB-free and session-free: exporting logs must work precisely when
 * scans or the database are broken.
 */

import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { selectExportPath, type CommandResult } from '$lib/tauri';
import { getFrontendLog } from '$lib/log-buffer';
import { scansStore, cliVersion, platform, reportSaveStatus } from '$lib/stores';
import { locale } from '$lib/i18n';

/** Serialise a compact, path-light summary of the UI session for ui-state.json. */
function buildUiState(): string {
	let scans: unknown = [];
	let activeScanId: string | null = null;
	try {
		const s = get(scansStore);
		activeScanId = s.activeScanId;
		scans = s.scans.map((scan) => ({
			id: scan.id,
			name: scan.name,
			dbName: scan.dbName,
			state: scan.state,
			phase: scan.scanPhase,
			error: scan.errorMessage ?? null,
			files: scan.scanResult?.filesDiscovered ?? null,
			folders: scan.scanResult?.folders ?? null,
			// The tail of the per-scan terminal (job progress / summary / errors).
			terminal: (scan.terminalOutput ?? []).slice(-100)
		}));
	} catch {
		/* a broken store must not block the export */
	}
	return JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			appVersion: get(cliVersion) || 'unknown',
			platform: get(platform),
			locale: get(locale),
			userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
			activeScanId,
			scans
		},
		null,
		2
	);
}

/** Run the full export flow. Returns true when a bundle was written. */
export async function exportLogsFlow(): Promise<boolean> {
	// Anchor the log bundle's Save-As dialog at the user's Downloads folder — one predictable,
	// always-writable place, never the last-browsed data folder or a read-only network share.
	// (Scoped to logs only; other exports keep their current default.)
	let downloadsDir: string | undefined;
	try {
		const { downloadDir } = await import('@tauri-apps/api/path');
		downloadsDir = await downloadDir();
	} catch {
		/* Downloads not resolvable → fall back to the OS default location */
	}
	const outputPath = await selectExportPath('logs', 'zip', 'ZIP', downloadsDir);
	if (!outputPath) return false; // user cancelled the dialog

	reportSaveStatus('saving', 'logs');
	try {
		const snapshot = JSON.stringify({ frontendLog: getFrontendLog(), uiState: buildUiState() });
		const result = await invoke<CommandResult>('export_logs', { outputPath, snapshot });
		if (!result.success) {
			console.error('Log export failed:', result.error ?? result.output);
			reportSaveStatus('error', 'logs');
			return false;
		}
		reportSaveStatus('saved', 'logs');
		return true;
	} catch (error) {
		console.error('Log export failed:', error);
		reportSaveStatus('error', 'logs');
		return false;
	}
}

/**
 * Fallback for the log export: open the logs folder in the OS file manager. The sidecar resolves
 * the path AND opens it (`logs --open`), so it always points at exactly where the logs live — no
 * recomputation, no dialog, no zip. Bulletproof when the bundle export can't produce a file.
 * Returns true on success. Technical fallback only (Settings) — Export logs stays the primary way.
 */
export async function openLogsFolder(): Promise<boolean> {
	try {
		const result = await invoke<CommandResult>('open_logs_dir');
		if (!result.success) {
			console.error('Open logs folder failed:', result.error ?? result.output);
			return false;
		}
		return true;
	} catch (error) {
		console.error('Open logs folder failed:', error);
		return false;
	}
}
