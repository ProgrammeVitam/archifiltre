/**
 * File Thumbnails Extension
 *
 * Stores browser-generated thumbnails in PGlite for caching across sessions.
 * Thumbnails are stored as base64-encoded strings alongside dimensional metadata.
 *
 * This extension has no CLI command — it exposes functions
 * intended to be called from query.ts or other orchestration code.
 */

import type { DatabaseConnection } from '@lib/database.ts';

// Re-export schema types for consumers
export type { FileThumbnailRow, FileThumbnailSelect } from '@extensions/file-thumbnails/schema.ts';

// === Result Interfaces ===

export interface GetThumbnailResult {
  thumbnail: string | null; // base64-encoded image data
  width?: number;
  height?: number;
  format?: string;
  cached: boolean;
}

export interface StoreThumbnailResult {
  stored: boolean;
}

// === Table Initialization ===

/**
 * Ensure the file_thumbnails table exists in the database.
 * Uses raw SQL via pg.exec(), same pattern as the checksum and ai-describe extensions.
 */
export async function ensureThumbnailTable(connection: DatabaseConnection): Promise<void> {
  await connection.pg.exec(`
    CREATE TABLE IF NOT EXISTS file_thumbnails (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thumbnail TEXT,
      width INTEGER,
      height INTEGER,
      format TEXT,
      created_at INTEGER,
      PRIMARY KEY (run_id, path)
    )
  `);
  await connection.pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_file_thumbnails_run_id ON file_thumbnails (run_id)
  `);
}

// === Cache Operations ===

/**
 * Look up a cached thumbnail for a file.
 * Returns the thumbnail data and metadata if cached, or null thumbnail if not found.
 */
export async function handleGetThumbnail(
  db: DatabaseConnection,
  runId: string,
  filePath: string,
): Promise<GetThumbnailResult> {
  await ensureThumbnailTable(db);

  const result = await db.pg.query<{
    thumbnail: string | null;
    width: number | null;
    height: number | null;
    format: string | null;
  }>(
    `SELECT thumbnail, width, height, format FROM file_thumbnails WHERE run_id = $1 AND path = $2 LIMIT 1`,
    [runId, filePath],
  );

  if (result.rows.length === 0 || result.rows[0].thumbnail == null) {
    return { thumbnail: null, cached: false };
  }

  const row = result.rows[0];
  return {
    thumbnail: row.thumbnail,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    format: row.format ?? undefined,
    cached: true,
  };
}

/**
 * Store (upsert) a thumbnail for a file.
 * If a thumbnail already exists for the given run_id + path, it will be replaced.
 */
export async function handleStoreThumbnail(
  db: DatabaseConnection,
  runId: string,
  filePath: string,
  thumbnail: string,
  width: number,
  height: number,
  format: string,
): Promise<StoreThumbnailResult> {
  await ensureThumbnailTable(db);

  const now = Math.floor(Date.now() / 1000);
  await db.pg.query(
    `INSERT INTO file_thumbnails (run_id, path, thumbnail, width, height, format, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (run_id, path) DO UPDATE
       SET thumbnail  = EXCLUDED.thumbnail,
           width      = EXCLUDED.width,
           height     = EXCLUDED.height,
           format     = EXCLUDED.format,
           created_at = EXCLUDED.created_at`,
    [runId, filePath, thumbnail, width, height, format, now],
  );

  return { stored: true };
}
