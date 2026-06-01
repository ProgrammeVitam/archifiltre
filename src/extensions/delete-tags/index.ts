/**
 * Delete Tags Extension
 *
 * Stores user-applied "mark for deletion" tags in PGlite.
 * Each tagged file or directory is recorded with a run_id and path,
 * allowing bulk deletion workflows to be persisted across sessions.
 *
 * This extension has no CLI command — it exposes functions
 * intended to be called from query.ts or other orchestration code.
 */

import type { DatabaseConnection } from '@lib/database.ts';
import { deleteTags } from '@extensions/delete-tags/schema.ts';

// Re-export schema types for consumers
export type { DeleteTagRow, DeleteTagSelect } from '@extensions/delete-tags/schema.ts';

// === Result Interfaces ===

export interface SetDeleteTagResult {
  tagged: boolean;
}

export interface RemoveDeleteTagResult {
  removed: boolean;
}

export interface GetDeleteTagsResult {
  tags: Array<{ path: string; created_at: number }>;
}

// === Table Initialization ===

/**
 * Ensure the delete_tags table exists in the database.
 * Uses raw SQL via pg.exec(), same pattern as the checksum and file-thumbnails extensions.
 */
export async function ensureDeleteTagsTable(connection: DatabaseConnection): Promise<void> {
  await connection.pg.exec(`
    CREATE TABLE IF NOT EXISTS delete_tags (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (run_id, path)
    )
  `);
  await connection.pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_delete_tags_run_id ON delete_tags (run_id)
  `);
}

// === Tag Operations ===

/**
 * Mark a file or directory for deletion by upserting a tag.
 * If a tag already exists for the given run_id + path, the created_at timestamp is updated.
 */
export async function handleSetDeleteTag(
  db: DatabaseConnection,
  runId: string,
  path: string
): Promise<SetDeleteTagResult> {
  await ensureDeleteTagsTable(db);

  const now = Math.floor(Date.now() / 1000);
  await db.pg.query(
    `INSERT INTO delete_tags (run_id, path, created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_id, path) DO UPDATE
       SET created_at = EXCLUDED.created_at`,
    [runId, path, now]
  );

  return { tagged: true };
}

/**
 * Remove the deletion tag from a file or directory.
 * Returns { removed: true } if a tag was actually deleted, false otherwise.
 */
export async function handleRemoveDeleteTag(
  db: DatabaseConnection,
  runId: string,
  path: string
): Promise<RemoveDeleteTagResult> {
  await ensureDeleteTagsTable(db);

  const result = await db.pg.query(`DELETE FROM delete_tags WHERE run_id = $1 AND path = $2`, [
    runId,
    path,
  ]);

  return { removed: (result.affectedRows ?? 0) > 0 };
}

/**
 * Retrieve all deletion tags for a given scan run.
 * Returns an array of tagged paths with their creation timestamps.
 */
export async function handleGetDeleteTags(
  db: DatabaseConnection,
  runId: string
): Promise<GetDeleteTagsResult> {
  await ensureDeleteTagsTable(db);

  const result = await db.pg.query<{ path: string; created_at: number }>(
    `SELECT path, created_at FROM delete_tags WHERE run_id = $1 ORDER BY path`,
    [runId]
  );

  return {
    tags: result.rows.map(row => ({
      path: row.path,
      created_at: row.created_at,
    })),
  };
}

export const MANIFEST = {
  id: 'delete-tags',
  name: 'Delete Tags',
  description: 'Marks files and directories for deletion',
  version: '1.0.0',
  schema: [deleteTags],
};
