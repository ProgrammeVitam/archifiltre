/**
 * Delete Tags Extension Schema
 *
 * Defines the delete_tags table for storing user-tagged files and directories
 * marked for deletion. Tags are persisted across sessions in PGlite.
 *
 * This table is owned by the delete-tags extension and can be joined
 * with the core files table:
 *   SELECT f.*, dt.created_at AS tagged_at
 *   FROM files f
 *   LEFT JOIN delete_tags dt ON f.run_id = dt.run_id AND f.path = dt.path
 */

import { pgTable, text, integer, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Delete tags table - stores paths that the user has marked for deletion.
 * Each file or directory in a scan run can have at most one delete tag.
 */
export const deleteTags = pgTable(
  'delete_tags',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(), // tagged file or directory path relative to scan root
    created_at: integer('created_at'), // unix timestamp when tagged
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_delete_tags_run_id').on(table.run_id),
  })
);

/**
 * Type for inserting into delete_tags
 */
export type DeleteTagRow = typeof deleteTags.$inferInsert;

/**
 * Type for selecting from delete_tags
 */
export type DeleteTagSelect = typeof deleteTags.$inferSelect;
