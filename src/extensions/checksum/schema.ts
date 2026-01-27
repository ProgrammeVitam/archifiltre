/**
 * Checksum Extension Schema
 *
 * Defines the file_checksums table for storing cryptographic checksums.
 * This table is owned by the checksum extension and can be joined by other extensions.
 */

import { pgTable, text, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * File checksums table - stores cryptographic checksums computed by the checksum extension.
 * One column per algorithm allows storing multiple checksum types per file.
 *
 * This table is designed to be LEFT JOINed with the core files table:
 *   SELECT f.*, c.md5, c.sha256, c.sha512, c.xxhash64
 *   FROM files f
 *   LEFT JOIN file_checksums c ON f.run_id = c.run_id AND f.path = c.path
 */
export const fileChecksums = pgTable(
  'file_checksums',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(),
    md5: text('md5'),
    sha256: text('sha256'),
    sha512: text('sha512'),
    xxhash64: text('xxhash64'),
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_file_checksums_run_id').on(table.run_id),
  })
);

/**
 * Type for inserting into file_checksums
 */
export type FileChecksumRow = typeof fileChecksums.$inferInsert;

/**
 * Type for selecting from file_checksums
 */
export type FileChecksumSelect = typeof fileChecksums.$inferSelect;

/**
 * Supported checksum algorithms
 * - md5, sha256, sha512: Cryptographic hashes (computed on demand)
 * - xxhash64: Fast non-cryptographic hash (may already exist from duplicate detection)
 */
export type ChecksumAlgorithm = 'md5' | 'sha256' | 'sha512' | 'xxhash64';

/**
 * List of supported algorithms (for CLI flag validation)
 */
export const SUPPORTED_ALGORITHMS: ChecksumAlgorithm[] = ['md5', 'sha256', 'sha512', 'xxhash64'];
