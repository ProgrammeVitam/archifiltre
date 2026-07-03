/**
 * Enrichment Extension
 *
 * Single owner of all user-applied metadata on a scan: aliases, comments,
 * tags (+ assignments) and "marked for deletion" flags. Persists everything
 * in PGlite — the UI never holds this in long-lived JS objects (see project
 * memory "PGlite is the CENTER").
 *
 * Every write is a discrete, reversible action (set_alias, set_comment,
 * assign_tag, …) so the future undo/redo + action-log feature can wrap them as
 * deltas without rework.
 *
 * This extension has no CLI command — it exposes functions called from
 * query.ts (the sidecar query protocol).
 */

import type { DatabaseConnection } from '@lib/database.ts';
import {
  aliases,
  comments,
  tags,
  tagAssignments,
  deleteTags,
} from '@extensions/enrichment/schema.ts';
import { recordOp, isNoOp, captureRow, type Change } from '@extensions/enrichment/undo.ts';
export { handleUndo, handleRedo, handleUndoState } from '@extensions/enrichment/undo.ts';
import { promises as fs } from 'node:fs';
import {
  snapshotFileFor,
  snapshotSize,
  type AnnotationSnapshot,
} from '@extensions/enrichment/snapshot.ts';
import { restoreSnapshot, type RestoreResult } from '@extensions/enrichment/restore.ts';

// Re-export schema types for consumers
export type {
  AliasRow,
  CommentRow,
  TagRow,
  TagAssignmentRow,
  DeleteTagRow,
  DeleteTagSelect,
} from '@extensions/enrichment/schema.ts';

// === Result Interfaces ===

export interface SetAliasResult {
  /** The stored alias, or null if it was cleared (empty or equal to original name) */
  alias: string | null;
}

export interface SetCommentResult {
  comment: string | null;
}

export interface CreateTagResult {
  tag_id: string;
  name: string;
}

export interface RenameTagResult {
  renamed: boolean;
}

export interface DeleteTagDictResult {
  deleted: boolean;
}

export interface AssignTagResult {
  assigned: boolean;
}

export interface UnassignTagResult {
  unassigned: boolean;
}

export interface SetDeleteTagResult {
  tagged: boolean;
}

export interface RemoveDeleteTagResult {
  removed: boolean;
}

export interface GetDeleteTagsResult {
  tags: Array<{ path: string; created_at: number }>;
}

/**
 * Full enrichment snapshot for one run, used to hydrate the UI once on scan
 * load. Per-element reads during normal use come from joins in the tree/files
 * queries, not from this dump.
 */
export interface GetEnrichmentResult {
  aliases: Array<{ path: string; alias: string }>;
  comments: Array<{ path: string; comment: string }>;
  tags: Array<{ tag_id: string; name: string }>;
  assignments: Array<{ tag_id: string; path: string }>;
  deleteTags: Array<{ path: string; created_at: number }>;
}

/**
 * Enrichment for a single element, fetched on selection (query-on-select).
 * The UI does not cache this — it re-reads when the selection changes.
 */
export interface GetElementEnrichmentResult {
  alias: string | null;
  comment: string | null;
  tagIds: string[];
  /** This exact path is marked for deletion */
  directlyTaggedForDeletion: boolean;
  /** An ancestor directory is marked for deletion (cascades visually) */
  ancestorTaggedForDeletion: boolean;
  /**
   * Aliases for this element and any ancestor that has one, keyed by path, so
   * the breadcrumb can display the alias for every segment (matching the chart
   * labels and v4). Only paths that actually have an alias are present.
   */
  pathAliases: Record<string, string>;
}

// === Helpers ===

/**
 * Original display name of an element: the last "/"-separated segment of its
 * path. Mirrors how query.ts derives FileNode.name / DirectoryNode.name.
 */
function originalName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Ancestor directory paths of an element, nearest-root first, excluding the
 * element itself. e.g. "a/b/c.txt" -> ["a", "a/b"]. Used to test whether a
 * parent directory is marked for deletion (the membership test itself is done
 * in SQL — no enrichment data is held in JS).
 */
function ancestorPaths(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

// === Table Initialization ===

/**
 * Ensure all enrichment tables exist. Uses raw SQL via pg.exec(), same pattern
 * as the other extensions. Cheap and idempotent; each handler calls it first.
 */
export async function ensureEnrichmentTables(connection: DatabaseConnection): Promise<void> {
  await connection.pg.exec(`
    CREATE TABLE IF NOT EXISTS aliases (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      alias TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (run_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_run_id ON aliases (run_id);

    CREATE TABLE IF NOT EXISTS comments (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (run_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_comments_run_id ON comments (run_id);

    CREATE TABLE IF NOT EXISTS tags (
      run_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (run_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_run_id ON tags (run_id);

    CREATE TABLE IF NOT EXISTS tag_assignments (
      run_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (run_id, tag_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_tag_assignments_run_id_path ON tag_assignments (run_id, path);

    CREATE TABLE IF NOT EXISTS delete_tags (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (run_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_delete_tags_run_id ON delete_tags (run_id);

    -- Undo/redo: an append-only log of reversible enrichment operations + a cursor.
    -- See undo.ts. seq is monotonic per run; changes is a JSON row-diff array.
    CREATE TABLE IF NOT EXISTS operations (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      session_id TEXT,
      op_kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      changes TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_operations_run_id ON operations (run_id);

    CREATE TABLE IF NOT EXISTS undo_meta (
      run_id TEXT NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id)
    );
  `);
}

// === Alias Operations ===

/**
 * Set or clear an element's alias.
 * The row is deleted when the alias is empty/whitespace or equal to the
 * element's original name, so a stored row always represents a real override.
 */
export async function handleSetAlias(
  db: DatabaseConnection,
  runId: string,
  path: string,
  alias: string
): Promise<SetAliasResult> {
  await ensureEnrichmentTables(db);

  const trimmed = (alias ?? '').trim();
  const clear = trimmed === '' || trimmed === originalName(path);

  // Capture before → write → re-read after, all in one transaction, and record the
  // reversible row-diff alongside the mutation so undo/redo can replay it exactly.
  await db.pg.transaction(async tx => {
    const before = ((
      await tx.query(`SELECT run_id, path, alias, created_at FROM aliases WHERE run_id = $1 AND path = $2`, [runId, path])
    ).rows[0] ?? null) as Record<string, unknown> | null;
    if (clear) {
      await tx.query(`DELETE FROM aliases WHERE run_id = $1 AND path = $2`, [runId, path]);
    } else {
      await tx.query(
        `INSERT INTO aliases (run_id, path, alias, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (run_id, path) DO UPDATE SET alias = EXCLUDED.alias`,
        [runId, path, trimmed, nowSeconds()]
      );
    }
    const after = ((
      await tx.query(`SELECT run_id, path, alias, created_at FROM aliases WHERE run_id = $1 AND path = $2`, [runId, path])
    ).rows[0] ?? null) as Record<string, unknown> | null;
    const change: Change = { table: 'aliases', key: { run_id: runId, path }, before, after };
    if (!isNoOp([change])) {
      const summary = after ? `Aliased ${originalName(path)} → “${trimmed}”` : `Cleared alias on ${originalName(path)}`;
      await recordOp(tx, runId, 'alias', summary, [change]);
    }
  });

  return { alias: clear ? null : trimmed };
}

// === Comment Operations ===

/**
 * Set or clear an element's comment. Empty/whitespace deletes the row.
 */
export async function handleSetComment(
  db: DatabaseConnection,
  runId: string,
  path: string,
  comment: string
): Promise<SetCommentResult> {
  await ensureEnrichmentTables(db);

  // Preserve internal whitespace; only treat an all-whitespace comment as empty.
  const value = comment ?? '';
  const clear = value.trim() === '';

  await db.pg.transaction(async tx => {
    const key = { run_id: runId, path };
    const before = await captureRow(tx, 'comments', key);
    if (clear) {
      await tx.query(`DELETE FROM comments WHERE run_id = $1 AND path = $2`, [runId, path]);
    } else {
      await tx.query(
        `INSERT INTO comments (run_id, path, comment, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (run_id, path) DO UPDATE SET comment = EXCLUDED.comment`,
        [runId, path, value, nowSeconds()]
      );
    }
    const after = await captureRow(tx, 'comments', key);
    const change: Change = { table: 'comments', key, before, after };
    if (!isNoOp([change])) {
      const summary = after ? `Commented ${originalName(path)}` : `Cleared comment on ${originalName(path)}`;
      await recordOp(tx, runId, 'comment', summary, [change]);
    }
  });

  return { comment: clear ? null : value };
}

// === Tag Dictionary Operations ===

/**
 * Create a new tag in the run's dictionary. Returns the generated tag_id.
 */
export async function handleCreateTag(
  db: DatabaseConnection,
  runId: string,
  name: string
): Promise<CreateTagResult> {
  await ensureEnrichmentTables(db);

  const tagId = crypto.randomUUID();
  const trimmed = (name ?? '').trim();
  await db.pg.transaction(async tx => {
    await tx.query(`INSERT INTO tags (run_id, tag_id, name, created_at) VALUES ($1, $2, $3, $4)`, [
      runId,
      tagId,
      trimmed,
      nowSeconds(),
    ]);
    const after = await captureRow(tx, 'tags', { run_id: runId, tag_id: tagId });
    await recordOp(tx, runId, 'tag_create', `Created tag “${trimmed}”`, [
      { table: 'tags', key: { run_id: runId, tag_id: tagId }, before: null, after },
    ]);
  });
  return { tag_id: tagId, name: trimmed };
}

/**
 * Rename an existing tag. Assignments are keyed by tag_id, so they are unaffected.
 */
export async function handleRenameTag(
  db: DatabaseConnection,
  runId: string,
  tagId: string,
  name: string
): Promise<RenameTagResult> {
  await ensureEnrichmentTables(db);

  let renamed = false;
  await db.pg.transaction(async tx => {
    const key = { run_id: runId, tag_id: tagId };
    const before = await captureRow(tx, 'tags', key);
    const result = await tx.query(`UPDATE tags SET name = $3 WHERE run_id = $1 AND tag_id = $2`, [
      runId,
      tagId,
      (name ?? '').trim(),
    ]);
    renamed = (result.affectedRows ?? 0) > 0;
    const after = await captureRow(tx, 'tags', key);
    const change: Change = { table: 'tags', key, before, after };
    if (!isNoOp([change])) {
      await recordOp(tx, runId, 'tag_rename', `Renamed tag → “${(name ?? '').trim()}”`, [change]);
    }
  });
  return { renamed };
}

/**
 * Delete a tag from the dictionary and cascade-remove all its assignments.
 */
export async function handleDeleteTag(
  db: DatabaseConnection,
  runId: string,
  tagId: string
): Promise<DeleteTagDictResult> {
  await ensureEnrichmentTables(db);

  let deleted = false;
  await db.pg.transaction(async tx => {
    // Capture the tag row AND every assignment it cascade-removes, so undo restores all.
    const tagBefore = await captureRow(tx, 'tags', { run_id: runId, tag_id: tagId });
    const assignBefore = (
      await tx.query(`SELECT * FROM tag_assignments WHERE run_id = $1 AND tag_id = $2`, [runId, tagId])
    ).rows as Array<Record<string, unknown>>;

    await tx.query(`DELETE FROM tag_assignments WHERE run_id = $1 AND tag_id = $2`, [runId, tagId]);
    const result = await tx.query(`DELETE FROM tags WHERE run_id = $1 AND tag_id = $2`, [runId, tagId]);
    deleted = (result.affectedRows ?? 0) > 0;

    const changes: Change[] = [];
    if (tagBefore) changes.push({ table: 'tags', key: { run_id: runId, tag_id: tagId }, before: tagBefore, after: null });
    for (const a of assignBefore) {
      changes.push({
        table: 'tag_assignments',
        key: { run_id: runId, tag_id: a.tag_id as string, path: a.path as string },
        before: a,
        after: null,
      });
    }
    if (changes.length) {
      await recordOp(tx, runId, 'tag_delete', `Deleted tag “${(tagBefore?.name as string) ?? ''}”`, changes);
    }
  });
  return { deleted };
}

// === Tag Assignment Operations ===

/**
 * Assign an existing tag to an element. Idempotent.
 */
export async function handleAssignTag(
  db: DatabaseConnection,
  runId: string,
  tagId: string,
  path: string
): Promise<AssignTagResult> {
  await ensureEnrichmentTables(db);

  await db.pg.transaction(async tx => {
    const key = { run_id: runId, tag_id: tagId, path };
    const before = await captureRow(tx, 'tag_assignments', key);
    await tx.query(
      `INSERT INTO tag_assignments (run_id, tag_id, path) VALUES ($1, $2, $3)
       ON CONFLICT (run_id, tag_id, path) DO NOTHING`,
      [runId, tagId, path]
    );
    const after = await captureRow(tx, 'tag_assignments', key);
    const change: Change = { table: 'tag_assignments', key, before, after };
    if (!isNoOp([change])) await recordOp(tx, runId, 'tag_assign', `Tagged ${originalName(path)}`, [change]);
  });
  return { assigned: true };
}

/**
 * Remove a tag from an element.
 */
export async function handleUnassignTag(
  db: DatabaseConnection,
  runId: string,
  tagId: string,
  path: string
): Promise<UnassignTagResult> {
  await ensureEnrichmentTables(db);

  let unassigned = false;
  await db.pg.transaction(async tx => {
    const key = { run_id: runId, tag_id: tagId, path };
    const before = await captureRow(tx, 'tag_assignments', key);
    const result = await tx.query(
      `DELETE FROM tag_assignments WHERE run_id = $1 AND tag_id = $2 AND path = $3`,
      [runId, tagId, path]
    );
    unassigned = (result.affectedRows ?? 0) > 0;
    const after = await captureRow(tx, 'tag_assignments', key);
    const change: Change = { table: 'tag_assignments', key, before, after };
    if (!isNoOp([change])) await recordOp(tx, runId, 'tag_unassign', `Untagged ${originalName(path)}`, [change]);
  });
  return { unassigned };
}

// === Delete-Tag Operations (relocated from the former delete-tags extension) ===

/**
 * Mark a file or directory for deletion. Upserts the tag timestamp.
 */
export async function handleSetDeleteTag(
  db: DatabaseConnection,
  runId: string,
  path: string
): Promise<SetDeleteTagResult> {
  await ensureEnrichmentTables(db);

  await db.pg.transaction(async tx => {
    const key = { run_id: runId, path };
    const before = await captureRow(tx, 'delete_tags', key);
    // DO NOTHING (not UPDATE created_at): re-marking an already-marked node is a true
    // no-op, so it doesn't churn the timestamp or create an empty undo step.
    await tx.query(
      `INSERT INTO delete_tags (run_id, path, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (run_id, path) DO NOTHING`,
      [runId, path, nowSeconds()]
    );
    const after = await captureRow(tx, 'delete_tags', key);
    const change: Change = { table: 'delete_tags', key, before, after };
    if (!isNoOp([change])) await recordOp(tx, runId, 'mark_delete', `Marked ${originalName(path)} for deletion`, [change]);
  });
  return { tagged: true };
}

/**
 * Remove the deletion mark from a file or directory.
 */
export async function handleRemoveDeleteTag(
  db: DatabaseConnection,
  runId: string,
  path: string
): Promise<RemoveDeleteTagResult> {
  await ensureEnrichmentTables(db);

  let removed = false;
  await db.pg.transaction(async tx => {
    const key = { run_id: runId, path };
    const before = await captureRow(tx, 'delete_tags', key);
    const result = await tx.query(`DELETE FROM delete_tags WHERE run_id = $1 AND path = $2`, [runId, path]);
    removed = (result.affectedRows ?? 0) > 0;
    const after = await captureRow(tx, 'delete_tags', key);
    const change: Change = { table: 'delete_tags', key, before, after };
    if (!isNoOp([change])) await recordOp(tx, runId, 'unmark_delete', `Unmarked ${originalName(path)}`, [change]);
  });
  return { removed };
}

/**
 * Retrieve all deletion marks for a run.
 */
export async function handleGetDeleteTags(
  db: DatabaseConnection,
  runId: string
): Promise<GetDeleteTagsResult> {
  await ensureEnrichmentTables(db);

  const result = await db.pg.query<{ path: string; created_at: number }>(
    `SELECT path, created_at FROM delete_tags WHERE run_id = $1 ORDER BY path`,
    [runId]
  );
  return {
    tags: result.rows.map(row => ({ path: row.path, created_at: row.created_at })),
  };
}

// === Hydration ===

/**
 * Return the complete enrichment state for a run in a single round-trip,
 * used to hydrate the UI once when a scan is opened.
 */
export async function handleGetEnrichment(
  db: DatabaseConnection,
  runId: string
): Promise<GetEnrichmentResult> {
  await ensureEnrichmentTables(db);

  const [aliasRows, commentRows, tagRows, assignmentRows, deleteRows] = await Promise.all([
    db.pg.query<{ path: string; alias: string }>(
      `SELECT path, alias FROM aliases WHERE run_id = $1`,
      [runId]
    ),
    db.pg.query<{ path: string; comment: string }>(
      `SELECT path, comment FROM comments WHERE run_id = $1`,
      [runId]
    ),
    db.pg.query<{ tag_id: string; name: string }>(
      `SELECT tag_id, name FROM tags WHERE run_id = $1 ORDER BY name`,
      [runId]
    ),
    db.pg.query<{ tag_id: string; path: string }>(
      `SELECT tag_id, path FROM tag_assignments WHERE run_id = $1`,
      [runId]
    ),
    db.pg.query<{ path: string; created_at: number }>(
      `SELECT path, created_at FROM delete_tags WHERE run_id = $1`,
      [runId]
    ),
  ]);

  return {
    aliases: aliasRows.rows.map(r => ({ path: r.path, alias: r.alias })),
    comments: commentRows.rows.map(r => ({ path: r.path, comment: r.comment })),
    tags: tagRows.rows.map(r => ({ tag_id: r.tag_id, name: r.name })),
    assignments: assignmentRows.rows.map(r => ({ tag_id: r.tag_id, path: r.path })),
    deleteTags: deleteRows.rows.map(r => ({ path: r.path, created_at: r.created_at })),
  };
}

/**
 * Return enrichment for a single element, fetched when the selection changes.
 */
export async function handleGetElementEnrichment(
  db: DatabaseConnection,
  runId: string,
  path: string
): Promise<GetElementEnrichmentResult> {
  await ensureEnrichmentTables(db);

  const candidates = [path, ...ancestorPaths(path)];
  const placeholders = candidates.map((_, i) => `$${i + 2}`).join(', ');

  const [aliasRes, commentRes, tagRes, deleteRes] = await Promise.all([
    // Aliases for this path AND its ancestors, so the breadcrumb can alias every
    // segment (not just the selected one).
    db.pg.query<{ path: string; alias: string }>(
      `SELECT path, alias FROM aliases WHERE run_id = $1 AND path IN (${placeholders})`,
      [runId, ...candidates]
    ),
    db.pg.query<{ comment: string }>(
      `SELECT comment FROM comments WHERE run_id = $1 AND path = $2`,
      [runId, path]
    ),
    db.pg.query<{ tag_id: string }>(
      `SELECT tag_id FROM tag_assignments WHERE run_id = $1 AND path = $2`,
      [runId, path]
    ),
    db.pg.query<{ path: string }>(
      `SELECT path FROM delete_tags WHERE run_id = $1 AND path IN (${placeholders})`,
      [runId, ...candidates]
    ),
  ]);

  const directlyTaggedForDeletion = deleteRes.rows.some(r => r.path === path);
  const ancestorTaggedForDeletion = deleteRes.rows.some(r => r.path !== path);

  const pathAliases: Record<string, string> = {};
  for (const row of aliasRes.rows) pathAliases[row.path] = row.alias;

  return {
    alias: pathAliases[path] ?? null,
    comment: commentRes.rows[0]?.comment ?? null,
    tagIds: tagRes.rows.map(r => r.tag_id),
    directlyTaggedForDeletion,
    ancestorTaggedForDeletion,
    pathAliases,
  };
}

/**
 * Restore the durable annotation snapshot for this run's scanned root onto the run,
 * keyed by path (see restore.ts). Used after re-scanning a folder whose datadir was
 * lost/damaged. No snapshot for the root → { restored: 0, orphaned: [] }.
 */
export async function handleRestoreAnnotations(
  db: DatabaseConnection,
  runId: string
): Promise<RestoreResult> {
  await ensureEnrichmentTables(db);
  const root = (
    await db.pg.query<{ root_path: string }>(
      `SELECT root_path FROM scan_metadata WHERE run_id = $1`,
      [runId]
    )
  ).rows[0]?.root_path;
  if (!root) return { restored: 0, orphaned: [] };

  const file = snapshotFileFor(root);
  let snapshot: AnnotationSnapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(file, 'utf-8')) as AnnotationSnapshot;
  } catch {
    return { restored: 0, orphaned: [] }; // no snapshot / unreadable → nothing to restore
  }
  return await restoreSnapshot(db, runId, snapshot);
}

/**
 * Whether a durable annotation snapshot exists for this run's scanned root (so the UI can
 * offer "restore your annotations" after a re-scan). Cheap: reads scan_metadata + statfs.
 */
export async function handleHasAnnotationBackup(
  db: DatabaseConnection,
  runId: string
): Promise<{ hasBackup: boolean; count: number }> {
  const root = (
    await db.pg.query<{ root_path: string }>(
      `SELECT root_path FROM scan_metadata WHERE run_id = $1`,
      [runId]
    )
  ).rows[0]?.root_path;
  if (!root) return { hasBackup: false, count: 0 };
  try {
    const snapshot = JSON.parse(await fs.readFile(snapshotFileFor(root), 'utf-8')) as AnnotationSnapshot;
    return { hasBackup: true, count: snapshotSize(snapshot) };
  } catch {
    return { hasBackup: false, count: 0 };
  }
}

export const MANIFEST = {
  id: 'enrichment',
  name: 'Enrichment',
  description: 'Aliases, comments, tags and deletion marks for files and directories',
  version: '1.0.0',
  schema: [aliases, comments, tags, tagAssignments, deleteTags],
};
