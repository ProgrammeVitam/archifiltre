/**
 * Enrichment Extension Schema
 *
 * Defines the tables that hold ALL user-applied metadata on a scan:
 *   - aliases          : display-name override per element
 *   - comments         : free-text annotation per element
 *   - tags             : the tag dictionary (id -> name) per run
 *   - tag_assignments  : many-to-many junction (tag <-> element path)
 *   - delete_tags      : "marked for deletion" flag per element
 *
 * These tables are owned by the enrichment extension. PGlite is the single
 * source of truth (see project memory "PGlite is the CENTER"): the UI never
 * mirrors this data in long-lived JS objects — it joins these tables into the
 * tree/files queries and queries per-path on selection.
 *
 * `delete_tags` was previously its own extension; it is folded in here so a
 * single extension owns every enrichment facet. The table name is unchanged,
 * so existing scans need no migration.
 */

import { pgTable, text, integer, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Display-name override. Absence of a row means "use the original name".
 * The set-alias handler deletes the row when the alias is empty or equal to
 * the original name, so a row always represents a meaningful override.
 */
export const aliases = pgTable(
  'aliases',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(),
    alias: text('alias').notNull(),
    created_at: integer('created_at'),
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_aliases_run_id').on(table.run_id),
  })
);

/**
 * Free-text comment. One per element; empty comment deletes the row.
 */
export const comments = pgTable(
  'comments',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(),
    comment: text('comment').notNull(),
    created_at: integer('created_at'),
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_comments_run_id').on(table.run_id),
  })
);

/**
 * Tag dictionary: the set of named tags that exist for a run.
 * tag_id is a generated UUID so tags can be renamed without breaking
 * assignments.
 */
export const tags = pgTable(
  'tags',
  {
    run_id: text('run_id').notNull(),
    tag_id: text('tag_id').notNull(),
    name: text('name').notNull(),
    created_at: integer('created_at'),
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.tag_id] }),
    runIdIdx: index('idx_tags_run_id').on(table.run_id),
  })
);

/**
 * Many-to-many junction between tags and element paths.
 * Normalized (unlike v4's denormalized ffIds[] array) so that filtering and
 * aggregation are plain SQL.
 */
export const tagAssignments = pgTable(
  'tag_assignments',
  {
    run_id: text('run_id').notNull(),
    tag_id: text('tag_id').notNull(),
    path: text('path').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.tag_id, table.path] }),
    runIdPathIdx: index('idx_tag_assignments_run_id_path').on(table.run_id, table.path),
  })
);

/**
 * "Marked for deletion" flag. Relocated from the former delete-tags extension;
 * table name and shape unchanged for backward compatibility.
 */
export const deleteTags = pgTable(
  'delete_tags',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(),
    created_at: integer('created_at'),
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_delete_tags_run_id').on(table.run_id),
  })
);

// Insert/select types
export type AliasRow = typeof aliases.$inferInsert;
export type CommentRow = typeof comments.$inferInsert;
export type TagRow = typeof tags.$inferInsert;
export type TagAssignmentRow = typeof tagAssignments.$inferInsert;
export type DeleteTagRow = typeof deleteTags.$inferInsert;
export type DeleteTagSelect = typeof deleteTags.$inferSelect;
