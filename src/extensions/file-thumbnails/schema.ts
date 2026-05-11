/**
 * File Thumbnails Extension Schema
 *
 * Defines the file_thumbnails table for storing browser-generated thumbnails
 * of files. Thumbnails are cached across sessions in PGlite.
 *
 * This table is owned by the file-thumbnails extension and can be joined
 * with the core files table:
 *   SELECT f.*, t.thumbnail, t.width, t.height, t.format
 *   FROM files f
 *   LEFT JOIN file_thumbnails t ON f.run_id = t.run_id AND f.path = t.path
 */

import { pgTable, text, integer, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * File thumbnails table - stores browser-generated thumbnail images as base64 strings.
 * Each file in a scan run can have at most one cached thumbnail.
 */
export const fileThumbnails = pgTable(
  'file_thumbnails',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(), // file path relative to scan root
    thumbnail: text('thumbnail'), // base64-encoded image data
    width: integer('width'), // thumbnail width in pixels
    height: integer('height'), // thumbnail height in pixels
    format: text('format'), // MIME type, e.g. 'image/png', 'image/jpeg'
    created_at: integer('created_at'), // unix timestamp when generated
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_file_thumbnails_run_id').on(table.run_id),
  })
);

/**
 * Type for inserting into file_thumbnails
 */
export type FileThumbnailRow = typeof fileThumbnails.$inferInsert;

/**
 * Type for selecting from file_thumbnails
 */
export type FileThumbnailSelect = typeof fileThumbnails.$inferSelect;
