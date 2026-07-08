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
import { DEFAULT_LOCAL_MODEL, localBackendIsGpu } from '@extensions/ai-describe/local-llm.ts';
import { generateLocal } from '@extensions/ai-describe/local-engine.ts';
import {
  buildTreeString,
  buildStatsBlock,
  buildTreeStringFromFs,
  buildStatsBlockFromFs,
  queryDirectChildren,
  buildPrompt,
  systemPromptForLang,
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
      lang TEXT,
      created_at INTEGER,
      PRIMARY KEY (run_id, path)
    )
  `);
  // Migrate older DBs that predate the language column.
  await connection.pg.exec(`
    ALTER TABLE directory_descriptions ADD COLUMN IF NOT EXISTS lang TEXT
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
  dirPath: string,
  lang?: string
): Promise<{ description: string; model: string } | null> {
  const result = await db.pg.query<{
    description: string | null;
    model: string | null;
    lang: string | null;
  }>(
    `SELECT description, model, lang FROM directory_descriptions WHERE run_id = $1 AND path = $2 LIMIT 1`,
    [runId, dirPath]
  );

  if (result.rows.length === 0 || result.rows[0].description == null) {
    return null;
  }

  // Only a cache hit when the stored summary is in the requested language. A legacy row with
  // no recorded language counts as English (that's what the old prompt produced), so existing
  // caches still hit for English users but regenerate for French/German.
  const want = (lang ?? 'en').slice(0, 2).toLowerCase();
  const have = (result.rows[0].lang ?? 'en').slice(0, 2).toLowerCase();
  if (want !== have) return null;

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
  model: string,
  lang?: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.pg.query(
    `INSERT INTO directory_descriptions (run_id, path, description, model, lang, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id, path) DO UPDATE
       SET description = EXCLUDED.description,
           model       = EXCLUDED.model,
           lang        = EXCLUDED.lang,
           created_at  = EXCLUDED.created_at`,
    [runId, dirPath, description, model, (lang ?? 'en').slice(0, 2).toLowerCase(), now]
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
  dirPath: string,
  override?: {
    provider?: 'local' | 'external';
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    lang?: string;
    /** When set, tokens are streamed to the UI as `describe:token` events tagged with it. */
    streamId?: string;
  },
  scanning = false
): Promise<DescribeResult> {
  try {
    // 1. Ensure table exists
    await ensureDescriptionTable(db);

    // 2. Check cache (per language — a summary cached in another language is a miss)
    const cached = await getCachedDescription(db, runId, dirPath, override?.lang);
    if (cached) {
      return { description: cached.description, model: cached.model, cached: true };
    }

    // 2b. Running the on-device model on the CPU during a scan starves the walk/hash (they
    //     fight for cores) — that once killed the scan. So mid-scan we only run local inference
    //     when a GPU backend is proven: GPU work doesn't touch the CPU the scan needs, so the
    //     summary streams in alongside the walk (via the filesystem-fallback prompt below).
    //     No GPU → defer to scan-complete; external is a cheap network call and always allowed.
    if (scanning && override?.provider === 'local' && !localBackendIsGpu()) {
      return { description: null, error: 'scan-in-progress' };
    }

    // 3. Build the prompt context. During a scan the walker may not have inserted this folder's
    //    children into the DB yet — the DB prompt would then say "empty" and cache that wrong
    //    answer. When that happens, read the immediate structure straight off disk (cheap
    //    readdir) so the summary is correct from the start of the scan.
    let treeString: string;
    let statsBlock: string;
    let fromFilesystem = false;
    if (scanning && (await queryDirectChildren(db, runId, dirPath)).length === 0) {
      const rootPath = await getScanRootPath(db, runId);
      if (rootPath) {
        treeString = await buildTreeStringFromFs(rootPath, dirPath);
        statsBlock = await buildStatsBlockFromFs(rootPath, dirPath);
        fromFilesystem = true;
      }
    }
    if (!fromFilesystem) {
      treeString = await buildTreeString(db, runId, dirPath);
      statsBlock = await buildStatsBlock(db, runId, dirPath);
    }

    // 4. Build prompt + system prompt (localized so small models answer in the UI language).
    const systemPrompt = systemPromptForLang(override?.lang);
    const userPrompt = buildPrompt(treeString!, statsBlock!, override?.lang);

    // 5. Stream tokens to the UI when a stream id is supplied. `describe:token` lines are
    //    forwarded to the UI's job-update channel by owner.rs.
    const streamId = override?.streamId;
    const onToken = streamId
      ? (delta: string) => {
          process.stdout.write(`${JSON.stringify({ event: 'describe:token', streamId, delta })}\n`);
        }
      : undefined;

    // 6. Generate.
    //    - Local (Qwen): run the model IN-PROCESS via a private stdio inference helper — no
    //      server, no listening port. The model must already be downloaded.
    //    - External: POST to the configured OpenAI-compatible endpoint (Settings win, else the
    //      LLM_BASE_URL / LLM_API_KEY env vars).
    let aiResult: { description: string; model: string };
    if (override?.provider === 'local') {
      try {
        aiResult = await generateLocal(override.model?.trim() || DEFAULT_LOCAL_MODEL, {
          systemPrompt,
          userPrompt,
          onToken,
        });
      } catch (err) {
        return { description: null, error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      const config =
        override?.baseUrl && override?.apiKey
          ? { baseUrl: override.baseUrl.trim().replace(/\/+$/, ''), apiKey: override.apiKey.trim() }
          : getLLMConfig();
      if (!config) {
        return {
          description: null,
          error:
            'LLM service not configured. Set the base URL and API key in Settings › LLM (or the LLM_BASE_URL / LLM_API_KEY environment variables).',
        };
      }
      aiResult = await callLLM(config, systemPrompt, userPrompt, {
        model: override?.model?.trim() || undefined,
        onToken,
      });
    }

    // 8. Persist for future cache hits — but NEVER a mid-scan summary (whether it came from the
    //    filesystem fallback or a still-partial DB tree): leave it uncached so the post-scan pass
    //    regenerates it from the full tree (real subtree sizes/dates) and caches that instead.
    if (!fromFilesystem && !scanning) {
      await saveDescription(db, runId, dirPath, aiResult.description, aiResult.model, override?.lang);
    }

    // 9. Return result
    return { description: aiResult.description, model: aiResult.model, cached: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { description: null, error: message };
  }
}

/** The scanned root's absolute path (files are stored relative to it), or null if the
 *  scan_metadata row isn't present yet. Used to resolve the on-disk path for the
 *  mid-scan filesystem fallback. */
async function getScanRootPath(db: DatabaseConnection, runId: string): Promise<string | null> {
  try {
    const result = await db.pg.query<{ root_path: string | null }>(
      `SELECT root_path FROM scan_metadata WHERE run_id = $1 LIMIT 1`,
      [runId]
    );
    return result.rows[0]?.root_path ?? null;
  } catch {
    return null;
  }
}

export const MANIFEST = {
  id: 'ai-describe',
  name: 'AI Describe',
  description: 'Generates LLM-powered descriptions for directories',
  version: '1.0.0',
  schema: [directoryDescriptions],
};
