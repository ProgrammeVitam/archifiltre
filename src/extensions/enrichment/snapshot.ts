/**
 * Durable annotation snapshots — the "black box" for the user's irreplaceable work.
 *
 * Every enrichment mutation (alias / comment / tag / deletion mark) is mirrored to a
 * materialized JSON file OUTSIDE the scan's PGlite datadir. The scan itself is
 * reproducible (re-run it), but annotations are hand-made and cannot be regenerated —
 * so they get the strongest durability we can give a small file: atomic tmp→rename and
 * a real fsync (unlike PGlite's NODEFS, which never syncs). If a datadir is destroyed
 * by a power-cut, the annotations survive here and re-attach to a fresh re-scan by path.
 *
 * Keyed by the scanned ROOT PATH, not run_id: run ids are regenerated per scan, but the
 * root path is the stable identity of "the folder the user annotated". Volume is bounded
 * by human effort (KBs), so we rewrite the whole snapshot on every change — simplest
 * correct restore. Writes are debounced so a burst coalesces into one file write.
 */

import { promises as fs, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseConnection } from '@lib/database.ts';
import { getAnnotationsDir } from '@lib/platform-paths.ts';
import { logger } from '@lib/logging.ts';
import pkg from '../../../package.json' with { type: 'json' };

const SNAPSHOT_VERSION = 1;
const DEBOUNCE_MS = 500;

export interface AnnotationSnapshot {
  version: number;
  header: {
    rootPath: string;
    runId: string;
    savedAt: number; // epoch seconds
    appVersion: string;
  };
  aliases: Array<{ path: string; alias: string; created_at: number | null }>;
  comments: Array<{ path: string; comment: string; created_at: number | null }>;
  tags: Array<{ tag_id: string; name: string; created_at: number | null }>;
  tag_assignments: Array<{ tag_id: string; path: string }>;
  delete_tags: Array<{ path: string; created_at: number | null }>;
}

/** Stable filename for a scanned root — hash keeps it filesystem-safe and fixed-length,
 *  so re-scanning the same folder overwrites the same snapshot. */
export function snapshotFileFor(rootPath: string): string {
  const hash = createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  return path.join(getAnnotationsDir(), `${hash}.json`);
}

/** Count the annotation rows in a snapshot (for logging / UI "N annotations"). */
export function snapshotSize(s: AnnotationSnapshot): number {
  return (
    s.aliases.length + s.comments.length + s.tags.length + s.tag_assignments.length + s.delete_tags.length
  );
}

async function readRootPath(connection: DatabaseConnection, runId: string): Promise<string | null> {
  const r = await connection.pg.query<{ root_path: string }>(
    `SELECT root_path FROM scan_metadata WHERE run_id = $1`,
    [runId]
  );
  return r.rows[0]?.root_path ?? null;
}

/** Read the five enrichment tables into a serializable snapshot. */
export async function buildSnapshot(
  connection: DatabaseConnection,
  runId: string
): Promise<AnnotationSnapshot | null> {
  const rootPath = await readRootPath(connection, runId);
  if (!rootPath) return null; // no scan_metadata yet → nothing to anchor a snapshot to

  const [aliases, comments, tags, assignments, deleteTags] = await Promise.all([
    connection.pg.query<{ path: string; alias: string; created_at: number | null }>(
      `SELECT path, alias, created_at FROM aliases WHERE run_id = $1 ORDER BY path`,
      [runId]
    ),
    connection.pg.query<{ path: string; comment: string; created_at: number | null }>(
      `SELECT path, comment, created_at FROM comments WHERE run_id = $1 ORDER BY path`,
      [runId]
    ),
    connection.pg.query<{ tag_id: string; name: string; created_at: number | null }>(
      `SELECT tag_id, name, created_at FROM tags WHERE run_id = $1 ORDER BY tag_id`,
      [runId]
    ),
    connection.pg.query<{ tag_id: string; path: string }>(
      `SELECT tag_id, path FROM tag_assignments WHERE run_id = $1 ORDER BY tag_id, path`,
      [runId]
    ),
    connection.pg.query<{ path: string; created_at: number | null }>(
      `SELECT path, created_at FROM delete_tags WHERE run_id = $1 ORDER BY path`,
      [runId]
    ),
  ]);

  return {
    version: SNAPSHOT_VERSION,
    header: {
      rootPath,
      runId,
      savedAt: Math.floor(Date.now() / 1000),
      appVersion: (pkg as { version?: string }).version ?? 'unknown',
    },
    aliases: aliases.rows,
    comments: comments.rows,
    tags: tags.rows,
    tag_assignments: assignments.rows,
    delete_tags: deleteTags.rows,
  };
}

/** Atomically write a snapshot to disk (tmp → fsync → rename), or delete the file when
 *  the snapshot is empty (all annotations removed → no file rather than an empty one). */
export async function writeSnapshot(snapshot: AnnotationSnapshot): Promise<void> {
  const dest = snapshotFileFor(snapshot.header.rootPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  if (snapshotSize(snapshot) === 0) {
    await fs.rm(dest, { force: true });
    return;
  }

  const tmp = `${dest}.tmp`;
  const data = JSON.stringify(snapshot, null, 2);
  // Write + fsync the tmp file, then atomically rename over the destination. The rename
  // is atomic, so a reader never sees a torn file; the fsync makes the bytes durable
  // before the rename, so a power-cut can't leave a renamed-but-empty file.
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, dest);
}

// ── Debounced per-datadir scheduler ──────────────────────────────────────────
// One pending timer per connection; a burst of mutations coalesces into a single
// write of the final state. Fire-and-forget: a snapshot failure is logged, never
// propagated into the mutation that triggered it.

const timers = new WeakMap<DatabaseConnection, ReturnType<typeof setTimeout>>();
// Last snapshot built per connection — cached so shutdown can write it SYNCHRONOUSLY.
// PGlite reads cannot complete during a Bun signal-handler teardown (verified), so the
// exit path must not depend on building a fresh snapshot; it writes this cache instead.
const lastBuilt = new WeakMap<DatabaseConnection, AnnotationSnapshot>();

export function scheduleSnapshot(connection: DatabaseConnection, runId: string): void {
  const existing = timers.get(connection);
  if (existing) clearTimeout(existing);
  timers.set(
    connection,
    setTimeout(() => {
      timers.delete(connection);
      void flushSnapshot(connection, runId);
    }, DEBOUNCE_MS)
  );
}

/** Write the snapshot now (used on flush and by the debounced timer). Also refreshes the
 *  in-memory cache that shutdown writes synchronously. */
export async function flushSnapshot(connection: DatabaseConnection, runId: string): Promise<void> {
  try {
    const snapshot = await buildSnapshot(connection, runId);
    if (snapshot) {
      lastBuilt.set(connection, snapshot);
      await writeSnapshot(snapshot);
    }
  } catch (error) {
    logger.warn('Annotation snapshot write failed (annotations remain in the datadir)', {
      runId,
      error: (error as Error).message,
    });
  }
}

/**
 * Synchronous best-effort flush for process shutdown. Writes the last-built snapshot
 * from the in-memory cache with a synchronous atomic write — no PGlite read, so it works
 * inside a signal handler where async DB queries can't complete. Returns true if it
 * wrote (or cleared) a file, false if there was nothing cached.
 *
 * The residual gap — a mutation in the final debounce window whose async build hadn't
 * run yet — is sub-second and only matters if the app is killed microseconds after an
 * edit; the edit is still durable in the datadir itself, this only affects the mirror.
 */
export function flushSnapshotSync(connection: DatabaseConnection): boolean {
  const snapshot = lastBuilt.get(connection);
  if (!snapshot) return false;
  try {
    const dest = snapshotFileFor(snapshot.header.rootPath);
    if (snapshotSize(snapshot) === 0) {
      rmSync(dest, { force: true });
      return true;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

/** Cancel a pending debounced write (e.g. the datadir is being torn down). */
export function cancelSnapshot(connection: DatabaseConnection): void {
  const existing = timers.get(connection);
  if (existing) {
    clearTimeout(existing);
    timers.delete(connection);
  }
}

/** Delete a scanned root's snapshot file — the "discard this scan" path. */
export async function deleteSnapshot(rootPath: string): Promise<void> {
  await fs.rm(snapshotFileFor(rootPath), { force: true });
}
