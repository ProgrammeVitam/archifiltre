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
import { selectExportPath, sendQuery, fetchHelperRing, type CommandResult } from '$lib/tauri';
import { getFrontendLog } from '$lib/log-buffer';
import { scansStore, cliVersion, platform, reportSaveStatus } from '$lib/stores';
import { locale } from '$lib/i18n';

/**
 * Best-effort: drain the active scan owner's in-memory log ring (RFC5424 lines). This is the
 * copy of the sidecar's recent logs that is NOT held in the open file, so it lands in the bundle
 * even when a Windows file lock makes the active .log unreadable. Never blocks or fails the export:
 * no active scan, no session, or any error → we simply omit it and export the on-disk files.
 */
async function fetchSidecarRing(): Promise<string | undefined> {
	try {
		const s = get(scansStore);
		const dbName = s.scans.find((x) => x.id === s.activeScanId)?.dbName;
		if (!dbName) return undefined; // no live owner → nothing in memory to drain
		const res = await sendQuery({ id: `ringlog_${Date.now()}`, action: 'get_ring_log' }, dbName, 4000);
		const ring = res.ok ? (res.data as { ring?: unknown })?.ring : undefined;
		return typeof ring === 'string' && ring.length > 0 ? ring : undefined;
	} catch {
		return undefined; // export must never break because the ring couldn't be fetched
	}
}

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
		// The two in-memory rings are drained from the (possibly pinned) owner/host — race each
		// against a short deadline so a wedged app can NEVER block or fail the export. Whatever
		// isn't back in time is dropped, never awaited or retried. The frontend snapshot
		// (getFrontendLog/buildUiState) is pure in-memory and always instant.
		const [sidecarRing, helperRing] = await Promise.all([
			bounded(fetchSidecarRing()),
			bounded(fetchHelperRing())
		]);
		const snapshot = JSON.stringify({
			frontendLog: getFrontendLog(),
			uiState: buildUiState(),
			...(sidecarRing ? { sidecarRing } : {}),
			...(helperRing ? { helperRing } : {})
		});
		const result = await invoke<CommandResult>('export_logs', { outputPath, snapshot });
		if (result.success) {
			reportSaveStatus('saved', 'logs');
			return true;
		}
		console.error('Log export failed, falling back to raw copy:', result.error ?? result.output);
	} catch (error) {
		console.error('Log export threw, falling back to raw copy:', error);
	}
	// FAIL-SAFE: the rich export failed (app wedged, locked destination, sidecar unspawnable). Fall
	// back to the Rust-native raw copy — it needs NOTHING from the sidecar/owner/host, so the user
	// always gets their logs. This is the "never blind" guarantee.
	return await fallbackRawCopy();
}

/** Race a promise against a short deadline; resolves undefined if it doesn't beat it (never rejects,
 *  never retries). Used to bound the best-effort ring fetches so they can't block the export. */
function bounded<T>(p: Promise<T>, ms = 1500): Promise<T | undefined> {
	return Promise.race([
		p.catch(() => undefined),
		new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))
	]);
}

/** The crash-only fallback: ask the Rust shell to zip the .log files into ONE dated .zip in
 *  Downloads with zero dependency on the (possibly wedged) Bun sidecar / owner / host. A single
 *  dated .zip is mail-client-friendly and removes the "grab the wrong dated .log" trap. Always
 *  gives the user something. The webview builds the name (Rust has no easy date formatting). */
async function fallbackRawCopy(): Promise<boolean> {
	try {
		const d = new Date();
		const p = (n: number) => String(n).padStart(2, '0');
		const filename = `archifiltre-logs-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.zip`;
		const res = await invoke<CommandResult>('copy_logs_raw', { filename });
		if (res.success) {
			console.warn('Fail-safe log zip written to:', res.output);
			reportSaveStatus('saved', 'logs');
			return true;
		}
		console.error('Fail-safe log zip failed:', res.error ?? res.output);
	} catch (e) {
		console.error('Fail-safe log zip threw:', e);
	}
	reportSaveStatus('error', 'logs');
	return false;
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
