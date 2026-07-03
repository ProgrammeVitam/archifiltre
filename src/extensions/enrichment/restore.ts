/**
 * Restore annotations from a durable snapshot onto a (freshly re-scanned) run.
 *
 * When a datadir is lost/corrupted, the user re-scans the same folder — a new run_id, but
 * the same paths. This re-applies the snapshot's aliases/comments/tags/marks to the new
 * run, keyed by path:
 *   - a path that exists in the new scan → its annotation is restored;
 *   - a path that no longer exists (file deleted/moved since) → reported as ORPHANED,
 *     never silently dropped, so the user can see what didn't come back.
 *
 * The whole restore is one transaction recorded as a single reversible undo op, so an
 * accidental restore onto the wrong folder is one Ctrl+Z away.
 */

import type { DatabaseConnection } from '@lib/database.ts';
import type { AnnotationSnapshot } from './snapshot.ts';
import { recordOp, type Change } from './undo.ts';
import { ensureEnrichmentTables } from './index.ts';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface RestoreResult {
  restored: number; // annotation rows re-applied
  orphaned: string[]; // distinct paths whose files no longer exist in the new scan
}

/**
 * Apply a snapshot to `runId`. Only paths present in the run's `files` table are
 * restored; tags (dictionary rows, path-independent) are always restored, but a tag
 * ASSIGNMENT to a missing path is skipped (and its path reported orphaned).
 */
export async function restoreSnapshot(
  db: DatabaseConnection,
  runId: string,
  snapshot: AnnotationSnapshot
): Promise<RestoreResult> {
  await ensureEnrichmentTables(db);

  return await db.pg.transaction(async tx => {
    // Which of the snapshot's paths still exist in this run?
    const allPaths = new Set<string>([
      ...snapshot.aliases.map(a => a.path),
      ...snapshot.comments.map(c => c.path),
      ...snapshot.delete_tags.map(d => d.path),
      ...snapshot.tag_assignments.map(t => t.path),
    ]);
    const existing = new Set<string>();
    if (allPaths.size > 0) {
      const rows = (
        await tx.query(
          `SELECT path FROM files WHERE run_id = $1 AND path = ANY($2::text[])`,
          [runId, [...allPaths]]
        )
      ).rows as Array<{ path: string }>;
      for (const r of rows) existing.add(r.path);
    }
    const orphaned = new Set<string>();
    const changes: Change[] = [];
    const now = nowSeconds();

    const upsert = async (
      table: string,
      key: Record<string, string>,
      row: Record<string, unknown>
    ) => {
      const before = ((
        await tx.query(
          `SELECT * FROM ${table} WHERE ${Object.keys(key)
            .map((k, i) => `${k} = $${i + 1}`)
            .join(' AND ')}`,
          Object.values(key)
        )
      ).rows[0] ?? null) as Record<string, unknown> | null;
      const cols = Object.keys(row);
      await tx.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT DO NOTHING`,
        cols.map(c => row[c])
      );
      const after = ((
        await tx.query(
          `SELECT * FROM ${table} WHERE ${Object.keys(key)
            .map((k, i) => `${k} = $${i + 1}`)
            .join(' AND ')}`,
          Object.values(key)
        )
      ).rows[0] ?? null) as Record<string, unknown> | null;
      // Only a genuine insert is a change (ON CONFLICT DO NOTHING → before===after).
      if (before === null && after !== null) {
        changes.push({ table, key, before: null, after });
      }
    };

    for (const a of snapshot.aliases) {
      if (!existing.has(a.path)) { orphaned.add(a.path); continue; }
      await upsert('aliases', { run_id: runId, path: a.path }, {
        run_id: runId, path: a.path, alias: a.alias, created_at: a.created_at ?? now,
      });
    }
    for (const c of snapshot.comments) {
      if (!existing.has(c.path)) { orphaned.add(c.path); continue; }
      await upsert('comments', { run_id: runId, path: c.path }, {
        run_id: runId, path: c.path, comment: c.comment, created_at: c.created_at ?? now,
      });
    }
    for (const d of snapshot.delete_tags) {
      if (!existing.has(d.path)) { orphaned.add(d.path); continue; }
      await upsert('delete_tags', { run_id: runId, path: d.path }, {
        run_id: runId, path: d.path, created_at: d.created_at ?? now,
      });
    }
    // Tag dictionary: path-independent, always restore.
    for (const t of snapshot.tags) {
      await upsert('tags', { run_id: runId, tag_id: t.tag_id }, {
        run_id: runId, tag_id: t.tag_id, name: t.name, created_at: t.created_at ?? now,
      });
    }
    for (const ta of snapshot.tag_assignments) {
      if (!existing.has(ta.path)) { orphaned.add(ta.path); continue; }
      await upsert('tag_assignments', { run_id: runId, tag_id: ta.tag_id, path: ta.path }, {
        run_id: runId, tag_id: ta.tag_id, path: ta.path,
      });
    }

    if (changes.length > 0) {
      await recordOp(
        tx,
        runId,
        'restore_annotations',
        `Restored ${changes.length} annotation${changes.length === 1 ? '' : 's'}`,
        changes
      );
    }

    return { restored: changes.length, orphaned: [...orphaned] };
  });
}
