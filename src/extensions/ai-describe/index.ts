/**
 * AI Describe Extension
 *
 * Describes what a directory is about by sending its tree structure
 * to an LLM API (OpenAI-compatible). Results are cached in the database.
 *
 * This extension has no CLI command — it exposes functions
 * intended to be called from query.ts or other orchestration code.
 */

import type { DatabaseConnection } from '@lib/database.ts';
import { directoryDescriptions } from '@extensions/ai-describe/schema.ts';
import { getLLMConfig } from '@extensions/ai-describe/llm-client.ts';
import { callLLM } from '@extensions/ai-describe/llm-client.ts';
import {
  buildTreeString,
  buildStatsBlock,
  buildPrompt,
  SYSTEM_PROMPT,
} from '@extensions/ai-describe/prompt.ts';

// Re-export schema types for consumers
export type {
  DirectoryDescriptionRow,
  DirectoryDescriptionSelect,
} from '@extensions/ai-describe/schema.ts';

// === Table Initialization ===

/**
 * Ensure the directory_descriptions table exists in the database.
 * Uses raw SQL via pg.exec(), same pattern as the checksum extension.
 */
export async function ensureDescriptionTable(connection: DatabaseConnection): Promise<void> {
  await connection.pg.exec(`
    CREATE TABLE IF NOT EXISTS directory_descriptions (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      description TEXT,
      model TEXT,
      created_at INTEGER,
      PRIMARY KEY (run_id, path)
    )
  `);
  await connection.pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_directory_descriptions_run_id ON directory_descriptions (run_id)
  `);
}

// === Cache Operations ===

/**
 * Look up a cached description for a directory.
 * Returns the description and model, or null if not cached.
 */
export async function getCachedDescription(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<{ description: string; model: string } | null> {
  const result = await db.pg.query<{
    description: string | null;
    model: string | null;
  }>(
    `SELECT description, model FROM directory_descriptions WHERE run_id = $1 AND path = $2 LIMIT 1`,
    [runId, dirPath]
  );

  if (result.rows.length === 0 || result.rows[0].description == null) {
    return null;
  }

  return {
    description: result.rows[0].description,
    model: result.rows[0].model ?? 'unknown',
  };
}

/**
 * Save (upsert) a description for a directory.
 */
export async function saveDescription(
  db: DatabaseConnection,
  runId: string,
  dirPath: string,
  description: string,
  model: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.pg.query(
    `INSERT INTO directory_descriptions (run_id, path, description, model, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id, path) DO UPDATE
       SET description = EXCLUDED.description,
           model       = EXCLUDED.model,
           created_at  = EXCLUDED.created_at`,
    [runId, dirPath, description, model, now]
  );
}

// === Main Handler ===

export interface DescribeResult {
  description: string | null;
  model?: string;
  cached?: boolean;
  error?: string;
}

/**
 * Describe a directory using an LLM.
 *
 * 1. Ensures the cache table exists.
 * 2. Returns a cached result when available.
 * 3. Falls back to calling the LLM API.
 * 4. Persists the result for future cache hits.
 */
export async function handleDescribeDirectory(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<DescribeResult> {
  try {
    // 1. Ensure table exists
    await ensureDescriptionTable(db);

    // 2. Check cache
    const cached = await getCachedDescription(db, runId, dirPath);
    if (cached) {
      return { description: cached.description, model: cached.model, cached: true };
    }

    // 3. Get LLM config
    const config = getLLMConfig();
    if (!config) {
      return {
        description: null,
        error: 'AI service not configured. Set LLM_BASE_URL and LLM_API_KEY environment variables.',
      };
    }

    // 4. Build tree string
    const treeString = await buildTreeString(db, runId, dirPath);

    // 5. Build stats block
    const statsBlock = await buildStatsBlock(db, runId, dirPath);

    // 6. Build prompt
    const userPrompt = buildPrompt(treeString, statsBlock);

    // 7. Call LLM API
    const aiResult = await callLLM(config, SYSTEM_PROMPT, userPrompt);

    // 8. Save to database
    await saveDescription(db, runId, dirPath, aiResult.description, aiResult.model);

    // 9. Return result
    return { description: aiResult.description, model: aiResult.model, cached: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { description: null, error: message };
  }
}

export const MANIFEST = {
  id: 'ai-describe',
  name: 'AI Describe',
  description: 'Generates LLM-powered descriptions for directories',
  version: '1.0.0',
  schema: [directoryDescriptions],
};
