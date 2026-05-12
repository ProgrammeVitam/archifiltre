/**
 * AI Describe Extension Schema
 *
 * Defines the directory_descriptions table for storing LLM-generated descriptions
 * of directories. This table is owned by the ai-describe extension.
 */

import { pgTable, text, integer, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Directory descriptions table - stores AI-generated descriptions of directories.
 * Each directory in a scan run can have at most one description.
 *
 * This table can be LEFT JOINed with the core files table:
 *   SELECT f.*, d.description, d.model
 *   FROM files f
 *   LEFT JOIN directory_descriptions d ON f.run_id = d.run_id AND f.path = d.path
 *   WHERE f.is_directory = true
 */
export const directoryDescriptions = pgTable(
  'directory_descriptions',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(), // directory path, empty string for root
    description: text('description'),
    model: text('model'), // e.g. 'llama-3.1-8b-instruct'
    created_at: integer('created_at'), // unix timestamp when generated
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_directory_descriptions_run_id').on(table.run_id),
  })
);

/**
 * Type for inserting into directory_descriptions
 */
export type DirectoryDescriptionRow = typeof directoryDescriptions.$inferInsert;

/**
 * Type for selecting from directory_descriptions
 */
export type DirectoryDescriptionSelect = typeof directoryDescriptions.$inferSelect;
