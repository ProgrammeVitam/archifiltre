/**
 * Datadir meta sidecar — a tiny `<name>.meta.json` written beside each `dbdata-*`
 * directory, holding the durable facts about a scan (status, root path, counts,
 * timestamps) WITHOUT having to open its PGlite instance.
 *
 * This is the bridge between "the durable truth lives in the datadir" and "the UI's
 * scan list lives in localStorage". Startup reconciliation reads these sidecars to find
 * scans the UI forgot (crash before localStorage persisted, wiped webview profile, …)
 * and to detect datadirs that claim to be complete but no longer open (corruption).
 *
 * The owner rewrites it on every status transition; it is small and fsync'd, so it is at
 * least as durable as the datadir it describes.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getDatabasePath, getDatabasesDir } from '@lib/platform-paths.ts';
import { snapshotFileFor } from '@extensions/enrichment/snapshot.ts';
import { logger } from '@lib/logging.ts';

export type DatadirStatus = 'running' | 'paused' | 'complete' | 'cancelled';

export interface DatadirMeta {
  version: number;
  dbName: string;
  runId: string | null;
  rootPath: string | null;
  status: DatadirStatus;
  fileCount: number | null;
  updatedAt: number; // epoch seconds
}

const META_VERSION = 1;

/** Path of the meta sidecar for a datadir (sits next to the `dbdata-<name>` directory). */
export function datadirMetaPath(dbName: string): string {
  const dir = getDatabasePath(dbName); // …/dbdata-<safeName>
  return `${dir}.meta.json`;
}

/** Atomically write the meta sidecar (tmp → fsync → rename). Best-effort: a failure is
 *  logged, never thrown — losing a meta write only weakens reconciliation, it must never
 *  break a scan. */
export async function writeDatadirMeta(meta: Omit<DatadirMeta, 'version' | 'updatedAt'>): Promise<void> {
  const dest = datadirMetaPath(meta.dbName);
  const full: DatadirMeta = { version: META_VERSION, updatedAt: Math.floor(Date.now() / 1000), ...meta };
  const tmp = `${dest}.tmp`;
  const body = JSON.stringify(full, null, 2);
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, dest);
  } catch (error) {
    // The tmp→rename dance can fail on locked-down Windows boxes — e.g. antivirus briefly
    // locks or removes the freshly written .tmp, so the rename hits ENOENT (seen in the field).
    // Fall back to a direct, non-atomic write so the meta still lands for reconciliation.
    try {
      await fs.writeFile(dest, body);
      await fs.rm(tmp, { force: true }).catch(() => {});
    } catch (fallbackError) {
      // Truly can't write (e.g. the datadir was concurrently discarded) — best-effort, so we
      // only warn, never throw. Include the errno codes so it stays diagnosable.
      logger.warn('Datadir meta write failed', {
        dbName: meta.dbName,
        code: (error as NodeJS.ErrnoException).code,
        error: (error as Error).message,
        fallbackError: (fallbackError as Error).message,
      });
    }
  }
}

/** Read a meta sidecar; null if absent or unparseable. */
export async function readDatadirMeta(dbName: string): Promise<DatadirMeta | null> {
  try {
    const raw = await fs.readFile(datadirMetaPath(dbName), 'utf-8');
    return JSON.parse(raw) as DatadirMeta;
  } catch {
    return null;
  }
}

/** One datadir found on disk, with everything reconciliation needs to decide what to do. */
export interface DatadirEntry {
  dbName: string;
  meta: DatadirMeta | null; // null → legacy datadir with no sidecar yet
  hasSnapshot: boolean; // an annotations snapshot exists for this scan's root
}

/**
 * Enumerate every `dbdata-*` on disk with its meta sidecar — the durable truth the UI
 * reconciles against its localStorage scan list at startup. Pure filesystem read; opens
 * no PGlite (that's the whole point — it works even for a datadir that won't open).
 */
export async function listDatadirs(): Promise<DatadirEntry[]> {
  const dir = getDatabasesDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // databases dir doesn't exist yet → no scans
  }

  const entries: DatadirEntry[] = [];
  for (const name of names) {
    const m = /^dbdata-(.+)$/.exec(name);
    if (!m) continue;
    // Only directories are datadirs (skip the `.meta.json` sidecars themselves).
    let isDir = false;
    try {
      isDir = (await fs.stat(path.join(dir, name))).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const dbName = m[1];
    const meta = await readDatadirMeta(dbName);
    let hasSnapshot = false;
    if (meta?.rootPath) {
      try {
        await fs.access(snapshotFileFor(meta.rootPath));
        hasSnapshot = true;
      } catch {
        /* no snapshot for this root */
      }
    }
    entries.push({ dbName, meta, hasSnapshot });
  }
  return entries;
}
