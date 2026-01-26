/**
 * Hash Extension Schema
 *
 * Defines the file_hashes table for storing cryptographic hashes.
 * This table is owned by the hash extension and can be joined by other extensions.
 */

import { pgTable, text, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * File hashes table - stores cryptographic hashes computed by the hash extension.
 * One column per algorithm allows storing multiple hash types per file.
 *
 * This table is designed to be LEFT JOINed with the core files table:
 *   SELECT f.*, h.md5, h.sha256, h.sha512
 *   FROM files f
 *   LEFT JOIN file_hashes h ON f.run_id = h.run_id AND f.path = h.path
 */
export const fileHashes = pgTable(
  'file_hashes',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(),
    md5: text('md5'),
    sha256: text('sha256'),
    sha512: text('sha512'),
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_file_hashes_run_id').on(table.run_id),
  })
);

/**
 * Type for inserting into file_hashes
 */
export type FileHashRow = typeof fileHashes.$inferInsert;

/**
 * Type for selecting from file_hashes
 */
export type FileHashSelect = typeof fileHashes.$inferSelect;

/**
 * Supported hash algorithms
 */
export type HashAlgorithm = 'md5' | 'sha256' | 'sha512';

/**
 * List of supported algorithms (for CLI flag validation)
 */
export const SUPPORTED_ALGORITHMS: HashAlgorithm[] = ['md5', 'sha256', 'sha512'];
