/**
 * Startup reconciliation — make the on-disk truth and the UI's scan list agree.
 *
 * The durable status of every scan lives in its datadir meta sidecar (written by the
 * owner on each status transition); the UI's tab list lives in localStorage. These can
 * diverge: a crash before localStorage persisted, a wiped webview profile, or a datadir
 * deleted out from under a tab. On launch we read both and:
 *
 *  - datadir with no matching tab, status running/paused → adopt as an interrupted scan
 *    (offers Continue via the frontier);
 *  - datadir with no matching tab, status complete → adopt as a normal (recovered) tab —
 *    it's the user's data and their annotations;
 *  - datadir with no matching tab, status cancelled → ignore (deliberately discarded);
 *  - known tab whose datadir is gone → flag datadirState:'missing' so the UI offers
 *    Re-scan (+ annotation restore when a snapshot survives).
 *
 * Legacy datadirs with no meta sidecar are skipped (we can't know their root/status
 * safely) — they get a sidecar on next open and reconcile from then on.
 */

import { get } from 'svelte/store';
import { scansStore, createScan, getFolderName, type Scan, type ScanState } from '$lib/stores';
import { listDatadirs, type DatadirEntry } from '$lib/tauri';

/** Sanitize a dbName the same way the sidecar does for its datadir folder, so a UI
 *  dbName can be matched against an on-disk `dbdata-<safeName>`. */
function safeDbName(dbName: string): string {
	return dbName.replace(/[^a-zA-Z0-9-_]/g, '_');
}

/** Map a durable datadir status to the UI scan state we adopt it as. */
function stateForStatus(status: string): ScanState | null {
	switch (status) {
		case 'running':
		case 'paused':
			return 'paused'; // interrupted → Continue (never auto-resumes)
		case 'complete':
			return 'complete';
		default:
			return null; // cancelled / unknown → don't resurrect
	}
}

/** Build an adopted Scan from a discovered datadir entry. */
function scanFromEntry(entry: DatadirEntry): Scan | null {
	const meta = entry.meta;
	if (!meta || !meta.rootPath) return null;
	const state = stateForStatus(meta.status);
	if (!state) return null;

	const scan = createScan();
	scan.dbName = meta.dbName;
	scan.scanId = meta.runId;
	scan.path = meta.rootPath;
	scan.name = getFolderName(meta.rootPath);
	scan.state = state;
	scan.recovered = true;
	scan.hasAnnotationBackup = entry.hasSnapshot;
	if (meta.fileCount != null) scan.scanResult = { ...scan.scanResult, filesDiscovered: meta.fileCount };
	return scan;
}

export interface ReconcileResult {
	adopted: number; // orphan datadirs surfaced as tabs
	missing: number; // known tabs whose datadir vanished
}

/**
 * Run reconciliation once at startup. Best-effort: any failure resolves to a no-op
 * (reconciliation must never block launch). Returns a small summary for logging/UI.
 */
export async function reconcileScans(): Promise<ReconcileResult> {
	const entries = await listDatadirs();
	if (entries.length === 0) return { adopted: 0, missing: 0 };

	const onDisk = new Map(entries.map((e) => [safeDbName(e.dbName), e]));
	const known = get(scansStore).scans;
	const knownSafe = new Set(known.map((s) => safeDbName(s.dbName)));

	// 1. Adopt orphan datadirs the UI doesn't know about.
	const adopted: Scan[] = [];
	for (const [safe, entry] of onDisk) {
		if (knownSafe.has(safe)) continue;
		const scan = scanFromEntry(entry);
		if (scan) adopted.push(scan);
	}
	if (adopted.length > 0) scansStore.adoptScans(adopted);

	// 2. Flag known tabs whose datadir has vanished (idle placeholders excluded — they
	//    never had a datadir). Present but unopenable datadirs are handled at open time
	//    (Phase 3 damaged path); here we only catch fully-missing ones.
	let missing = 0;
	for (const scan of known) {
		if (scan.state === 'idle' || !scan.path) continue;
		if (!onDisk.has(safeDbName(scan.dbName)) && scan.datadirState !== 'missing') {
			scansStore.updateScan(scan.id, { datadirState: 'missing' });
			missing++;
		}
	}

	return { adopted: adopted.length, missing };
}
