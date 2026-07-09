/**
 * Durable, run-independent snapshot of directory summaries — so folder summaries survive a
 * rescan or a crash-recovery REBUILD (both mint a fresh db + run_id, which would otherwise
 * orphan every row in directory_descriptions, keyed by run_id).
 *
 * Mirrors the annotations "black box" pattern ([[project-*]] enrichment/snapshot.ts) but kept
 * SEPARATE from it — summaries are regenerable derived data, so a failure here must never touch
 * the user's irreplaceable annotations. Path-keyed file (per scanned root), rewritten whole on
 * each save (summaries are tiny). Re-adoption is LAZY and content-GATED: a summary is only
 * re-used under a new run when the folder's content signature still matches, so a folder whose
 * contents changed regenerates instead of showing a stale summary.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseConnection } from '@lib/database.ts';
import { getAppDataDir } from '@lib/platform-paths.ts';
import { ensureDirectory } from '@lib/helpers.ts';

interface SummaryRow {
  path: string;
  description: string;
  model: string;
  lang: string | null;
  content_sig: string | null;
}
interface SummarySnapshot {
  version: 1;
  rootPath: string;
  savedAt: number;
  descriptions: SummaryRow[];
}

function summariesDir(): string {
  return path.join(getAppDataDir(), 'ai-summaries');
}

/** Stable per-root filename (hash → fs-safe, fixed length), so re-scanning the same folder reuses
 *  the same snapshot regardless of db name or run_id. */
export function summarySnapshotFileFor(rootPath: string): string {
  const hash = createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  return path.join(summariesDir(), `${hash}.json`);
}

async function rootPathFor(db: DatabaseConnection, runId: string): Promise<string | null> {
  const r = await db.pg.query<{ root_path: string }>(
    `SELECT root_path FROM scan_metadata WHERE run_id = $1`,
    [runId]
  );
  return r.rows[0]?.root_path ?? null;
}

/** Dump this run's directory_descriptions to the durable, path-keyed snapshot (atomic tmp→rename). */
export async function writeSummarySnapshot(db: DatabaseConnection, runId: string): Promise<void> {
  const rootPath = await rootPathFor(db, runId);
  if (!rootPath) return;
  const r = await db.pg.query<SummaryRow>(
    `SELECT path, description, model, lang, content_sig
       FROM directory_descriptions
      WHERE run_id = $1 AND description IS NOT NULL
      ORDER BY path`,
    [runId]
  );
  if (r.rows.length === 0) return;
  const snap: SummarySnapshot = {
    version: 1,
    rootPath,
    savedAt: Math.floor(Date.now() / 1000),
    descriptions: r.rows,
  };
  await ensureDirectory(summariesDir());
  const dest = summarySnapshotFileFor(rootPath);
  // Unique tmp per write: concurrent describes each save the snapshot, and a shared tmp name
  // would collide (one rename wins, the other hits ENOENT). pid+time+rand keeps them disjoint.
  const tmp = `${dest}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(snap));
  await fsp.rename(tmp, dest);
}

/**
 * Try to re-adopt a summary for (dirPath, lang) from a previous run's snapshot, but ONLY when the
 * folder's content signature still matches `currentSig` (else it would serve a stale summary). On
 * a match it re-stamps the row under the CURRENT run (so later lookups hit the DB directly) and
 * returns it — a cache hit that survived the rebuild. Returns null on any miss / read failure.
 */
export async function adoptSummaryFromSnapshot(
  db: DatabaseConnection,
  runId: string,
  rootPath: string,
  dirPath: string,
  lang: string | undefined,
  currentSig: string
): Promise<{ description: string; model: string } | null> {
  let snap: SummarySnapshot;
  try {
    snap = JSON.parse(await fsp.readFile(summarySnapshotFileFor(rootPath), 'utf-8'));
  } catch {
    return null; // no snapshot for this root, or unreadable → nothing to adopt
  }
  if (!snap || snap.version !== 1 || !Array.isArray(snap.descriptions)) return null;

  const want = (lang ?? 'en').slice(0, 2).toLowerCase();
  const hit = snap.descriptions.find(
    (d) =>
      d.path === dirPath &&
      (d.lang ?? 'en').slice(0, 2).toLowerCase() === want &&
      d.content_sig === currentSig // the gate: only adopt when the folder is unchanged
  );
  if (!hit) return null;

  await db.pg.query(
    `INSERT INTO directory_descriptions (run_id, path, description, model, lang, created_at, content_sig)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (run_id, path) DO UPDATE
       SET description = EXCLUDED.description,
           model       = EXCLUDED.model,
           lang        = EXCLUDED.lang,
           created_at  = EXCLUDED.created_at,
           content_sig = EXCLUDED.content_sig`,
    [runId, dirPath, hit.description, hit.model, want, Math.floor(Date.now() / 1000), currentSig]
  );
  return { description: hit.description, model: hit.model };
}
