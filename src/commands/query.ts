/**
 * Query Command
 *
 * Interactive JSON-based query interface for the Archifiltre database.
 * Reads JSON queries from stdin, responds with JSON on stdout.
 * Designed for communication with the Tauri UI via sidecar.
 *
 * Protocol: JSON Lines (one JSON object per line)
 *
 * Supported actions:
 * - get_tree: Get all directories with aggregate stats
 * - get_files: Get files in a specific directory (paginated)
 * - get_duplicates: Get duplicate file groups
 * - search: Search files by pattern
 * - get_stats: Get overall scan statistics
 */

import { Command, Flags } from '@oclif/core';
import * as readline from 'node:readline';
import { initializeLogging } from '@lib/logging.ts';
// NOTE: Do NOT use setupOclifContext or enableConsoleLogging - any stdout output corrupts the JSON protocol
import {
  createScanDatabase,
  closeScanDatabase,
  getLatestRunId,
  getScanStats,
  files,
  scanMetadata,
  type DatabaseConnection,
  type ScanStats,
} from '@lib/database.ts';
import { eq, and, like, isNotNull, sql, desc, gt, asc } from 'drizzle-orm';
import { handleDescribeDirectory } from '@extensions/ai-describe/index.ts';
import { handleGetThumbnail, handleStoreThumbnail } from '@extensions/file-thumbnails/index.ts';
import {
  handleSetDeleteTag,
  handleRemoveDeleteTag,
  handleGetDeleteTags,
  handleSetAlias,
  handleSetComment,
  handleCreateTag,
  handleRenameTag,
  handleDeleteTag,
  handleAssignTag,
  handleUnassignTag,
  handleGetEnrichment,
  handleGetElementEnrichment,
  ensureEnrichmentTables,
} from '@extensions/enrichment/index.ts';

// === Types ===

interface QueryRequest {
  id: string;
  action: string;
  [key: string]: unknown;
}

interface QueryResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Enrichment flags joined onto every node for the visualization. */
interface NodeEnrichment {
  /** Display-name override, or null. */
  alias: string | null;
  has_comment: boolean;
  has_tag: boolean;
  /** This element or any ancestor directory is marked for deletion (cascade). */
  tagged_for_deletion: boolean;
}

interface DirectoryNode extends NodeEnrichment {
  path: string;
  name: string;
  depth: number;
  total_size: number;
  file_count: number;
  dir_count: number;
}

interface FileNode extends NodeEnrichment {
  path: string;
  name: string;
  size: number;
  content_size: number | null;
  mtime: number;
  is_directory: boolean;
  is_hidden: boolean;
  hash: string | null;
  is_archive: boolean;
  archive_format: string | null;
}

interface DuplicateGroup {
  hash: string;
  size: number;
  count: number;
  files: string[];
}

// === Query Handlers ===

async function handleGetTree(
  db: DatabaseConnection,
  runId: string
): Promise<{ root: string | null; directories: DirectoryNode[] }> {
  // Get the root path from scan metadata
  const metadataResult = await db.db
    .select({ root_path: scanMetadata.root_path })
    .from(scanMetadata)
    .where(eq(scanMetadata.run_id, runId))
    .limit(1);

  const rootPath = metadataResult[0]?.root_path || null;

  // Get all directories with aggregated stats using a CTE
  // This computes total_size, file_count, and dir_count for each directory
  const directoriesQuery = await db.db.execute(sql`
    WITH RECURSIVE dir_tree AS (
      -- Base: all directories
      SELECT
        path,
        physical_size,
        is_directory
      FROM files
      WHERE run_id = ${runId}
    ),
    dir_stats AS (
      -- For each directory, compute stats from all descendants
      SELECT
        d.path as dir_path,
        COALESCE(SUM(CASE WHEN NOT f.is_directory THEN f.physical_size ELSE 0 END), 0) as total_size,
        COUNT(CASE WHEN NOT f.is_directory THEN 1 END) as file_count,
        COUNT(CASE WHEN f.is_directory AND f.path != d.path THEN 1 END) as dir_count
      FROM files d
      LEFT JOIN files f ON f.path LIKE d.path || '/%' AND f.run_id = ${runId}
      WHERE d.run_id = ${runId} AND d.is_directory = true
      GROUP BY d.path
    )
    SELECT
      ds.dir_path as path,
      ds.total_size,
      ds.file_count,
      ds.dir_count,
      al.alias as alias,
      EXISTS (SELECT 1 FROM comments cm WHERE cm.run_id = ${runId} AND cm.path = ds.dir_path) as has_comment,
      EXISTS (SELECT 1 FROM tag_assignments tg WHERE tg.run_id = ${runId} AND tg.path = ds.dir_path) as has_tag,
      EXISTS (
        SELECT 1 FROM delete_tags dt
        WHERE dt.run_id = ${runId}
          AND (dt.path = ds.dir_path OR starts_with(ds.dir_path, dt.path || '/'))
      ) as tagged_for_deletion
    FROM dir_stats ds
    LEFT JOIN aliases al ON al.run_id = ${runId} AND al.path = ds.dir_path
    ORDER BY ds.dir_path
  `);

  const directories: DirectoryNode[] = (
    directoriesQuery.rows as Array<{
      path: string;
      total_size: string | number;
      file_count: string | number;
      dir_count: string | number;
      alias: string | null;
      has_comment: boolean;
      has_tag: boolean;
      tagged_for_deletion: boolean;
    }>
  ).map(row => {
    const path = row.path;
    const parts = path.split('/');
    const name = parts[parts.length - 1] || path;

    // Calculate depth relative to root
    const rootParts = rootPath ? rootPath.split('/').length : 0;
    const depth = parts.length - rootParts;

    return {
      path,
      name,
      depth: Math.max(0, depth),
      total_size: Number(row.total_size) || 0,
      file_count: Number(row.file_count) || 0,
      dir_count: Number(row.dir_count) || 0,
      alias: row.alias ?? null,
      has_comment: Boolean(row.has_comment),
      has_tag: Boolean(row.has_tag),
      tagged_for_deletion: Boolean(row.tagged_for_deletion),
    };
  });

  return { root: rootPath, directories };
}

async function handleGetFiles(
  db: DatabaseConnection,
  runId: string,
  dirPath: string,
  limit: number = 1000,
  cursor?: string
): Promise<{ files: FileNode[]; total: number; has_more: boolean; cursor: string | null }> {
  // Count total files in directory
  // Build path filter - handle root (empty path) vs subdirectory
  const pathFilter =
    dirPath === ''
      ? sql`path NOT LIKE '%/%' AND is_directory = false` // Root: direct children only (no slashes)
      : sql`path LIKE ${`${dirPath}/%`} AND path NOT LIKE ${`${dirPath}/%/%`}`;

  const countResult = await db.db
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(and(eq(files.run_id, runId), pathFilter));

  const total = Number(countResult[0]?.count) || 0;

  // Build query with optional cursor
  const query = db.db
    .select({
      path: files.path,
      physical_size: files.physical_size,
      content_size: files.content_size,
      mtime: files.mtime,
      is_directory: files.is_directory,
      is_hidden: files.is_hidden,
      hash: files.hash,
      is_archive_container: files.is_archive_container,
      archive_format: files.archive_format,
      // Enrichment, joined per row. NOTE: the outer column is written literally
      // as "files"."path" — drizzle renders an embedded ${files.path} as the
      // UNqualified "path", which inside these subqueries binds to the inner
      // table's own column (always-true) instead of correlating. Keep it literal.
      alias: sql<
        string | null
      >`(SELECT a.alias FROM aliases a WHERE a.run_id = ${runId} AND a.path = "files"."path")`,
      has_comment: sql<boolean>`EXISTS (SELECT 1 FROM comments c WHERE c.run_id = ${runId} AND c.path = "files"."path")`,
      has_tag: sql<boolean>`EXISTS (SELECT 1 FROM tag_assignments tg WHERE tg.run_id = ${runId} AND tg.path = "files"."path")`,
      tagged_for_deletion: sql<boolean>`EXISTS (SELECT 1 FROM delete_tags dt WHERE dt.run_id = ${runId} AND (dt.path = "files"."path" OR starts_with("files"."path", dt.path || '/')))`,
    })
    .from(files)
    .where(
      cursor
        ? and(eq(files.run_id, runId), pathFilter, gt(files.path, cursor))
        : and(eq(files.run_id, runId), pathFilter)
    )
    .orderBy(asc(files.path))
    .limit(limit + 1); // Fetch one extra to check if there's more

  const results = await query;

  const hasMore = results.length > limit;
  const fileResults = hasMore ? results.slice(0, limit) : results;
  const newCursor =
    hasMore && fileResults.length > 0 ? fileResults[fileResults.length - 1].path : null;

  const fileNodes: FileNode[] = fileResults.map(row => {
    const parts = row.path.split('/');
    const name = parts[parts.length - 1] || row.path;

    return {
      path: row.path,
      name,
      size: row.physical_size,
      content_size: row.content_size,
      mtime: row.mtime,
      is_directory: row.is_directory,
      is_hidden: row.is_hidden,
      hash: row.hash,
      is_archive: row.is_archive_container || false,
      archive_format: row.archive_format,
      alias: row.alias ?? null,
      has_comment: Boolean(row.has_comment),
      has_tag: Boolean(row.has_tag),
      tagged_for_deletion: Boolean(row.tagged_for_deletion),
    };
  });

  return {
    files: fileNodes,
    total,
    has_more: hasMore,
    cursor: newCursor,
  };
}

async function handleGetDuplicates(
  db: DatabaseConnection,
  runId: string,
  minSize: number = 0,
  limit: number = 100
): Promise<{ groups: DuplicateGroup[]; total_groups: number; total_wasted_bytes: number }> {
  // Find all hashes with duplicates
  const duplicateHashesQuery = await db.db
    .select({
      hash: files.hash,
      count: sql<number>`count(*)`,
      size: files.physical_size,
    })
    .from(files)
    .where(and(eq(files.run_id, runId), isNotNull(files.hash), sql`physical_size >= ${minSize}`))
    .groupBy(files.hash, files.physical_size)
    .having(sql`count(*) > 1`)
    .orderBy(desc(sql`physical_size * count(*)`))
    .limit(limit);

  const totalGroupsQuery = await db.db.select({ count: sql<number>`count(*)` }).from(
    db.db
      .select({ hash: files.hash })
      .from(files)
      .where(and(eq(files.run_id, runId), isNotNull(files.hash), sql`physical_size >= ${minSize}`))
      .groupBy(files.hash)
      .having(sql`count(*) > 1`)
      .as('dup_hashes')
  );

  const totalGroups = Number(totalGroupsQuery[0]?.count) || 0;

  // Get file paths for each duplicate group
  const groups: DuplicateGroup[] = [];
  let totalWastedBytes = 0;

  for (const dupHash of duplicateHashesQuery) {
    if (!dupHash.hash) continue;

    const filesInGroup = await db.db
      .select({ path: files.path })
      .from(files)
      .where(and(eq(files.run_id, runId), eq(files.hash, dupHash.hash)))
      .orderBy(asc(files.path));

    const count = Number(dupHash.count) || 0;
    const size = dupHash.size;
    const wastedBytes = size * (count - 1); // All copies except one are "wasted"
    totalWastedBytes += wastedBytes;

    groups.push({
      hash: dupHash.hash,
      size,
      count,
      files: filesInGroup.map(f => f.path),
    });
  }

  return {
    groups,
    total_groups: totalGroups,
    total_wasted_bytes: totalWastedBytes,
  };
}

async function handleSearch(
  db: DatabaseConnection,
  runId: string,
  pattern: string,
  limit: number = 500,
  cursor?: string
): Promise<{ matches: FileNode[]; total: number; has_more: boolean; cursor: string | null }> {
  // Convert glob-like pattern to SQL LIKE pattern
  // User can use * for wildcards, we convert to %
  const sqlPattern = pattern.replace(/\*/g, '%');

  // Count total matches
  const countResult = await db.db
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(and(eq(files.run_id, runId), like(files.path, `%${sqlPattern}%`)));

  const total = Number(countResult[0]?.count) || 0;

  // Build query with optional cursor
  const results = await db.db
    .select({
      path: files.path,
      physical_size: files.physical_size,
      content_size: files.content_size,
      mtime: files.mtime,
      is_directory: files.is_directory,
      is_hidden: files.is_hidden,
      hash: files.hash,
      is_archive_container: files.is_archive_container,
      archive_format: files.archive_format,
      // Enrichment, joined per row. NOTE: the outer column is written literally
      // as "files"."path" — drizzle renders an embedded ${files.path} as the
      // UNqualified "path", which inside these subqueries binds to the inner
      // table's own column (always-true) instead of correlating. Keep it literal.
      alias: sql<
        string | null
      >`(SELECT a.alias FROM aliases a WHERE a.run_id = ${runId} AND a.path = "files"."path")`,
      has_comment: sql<boolean>`EXISTS (SELECT 1 FROM comments c WHERE c.run_id = ${runId} AND c.path = "files"."path")`,
      has_tag: sql<boolean>`EXISTS (SELECT 1 FROM tag_assignments tg WHERE tg.run_id = ${runId} AND tg.path = "files"."path")`,
      tagged_for_deletion: sql<boolean>`EXISTS (SELECT 1 FROM delete_tags dt WHERE dt.run_id = ${runId} AND (dt.path = "files"."path" OR starts_with("files"."path", dt.path || '/')))`,
    })
    .from(files)
    .where(
      cursor
        ? and(eq(files.run_id, runId), like(files.path, `%${sqlPattern}%`), gt(files.path, cursor))
        : and(eq(files.run_id, runId), like(files.path, `%${sqlPattern}%`))
    )
    .orderBy(asc(files.path))
    .limit(limit + 1);

  const hasMore = results.length > limit;
  const matchResults = hasMore ? results.slice(0, limit) : results;
  const newCursor =
    hasMore && matchResults.length > 0 ? matchResults[matchResults.length - 1].path : null;

  const matches: FileNode[] = matchResults.map(row => {
    const parts = row.path.split('/');
    const name = parts[parts.length - 1] || row.path;

    return {
      path: row.path,
      name,
      size: row.physical_size,
      content_size: row.content_size,
      mtime: row.mtime,
      is_directory: row.is_directory,
      is_hidden: row.is_hidden,
      hash: row.hash,
      is_archive: row.is_archive_container || false,
      archive_format: row.archive_format,
      alias: row.alias ?? null,
      has_comment: Boolean(row.has_comment),
      has_tag: Boolean(row.has_tag),
      tagged_for_deletion: Boolean(row.tagged_for_deletion),
    };
  });

  return {
    matches,
    total,
    has_more: hasMore,
    cursor: newCursor,
  };
}

async function handleGetStats(db: DatabaseConnection, runId: string): Promise<ScanStats> {
  return new Promise((resolve, reject) => {
    getScanStats(db, runId).subscribe({
      next: stats => resolve(stats),
      error: err => reject(err),
    });
  });
}

async function handleGetDirDateStats(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<{ min: number | null; max: number | null; median: number | null; count: number }> {
  // Root ('') aggregates the whole scan; any other directory matches its subtree.
  const pattern = dirPath === '' ? '%' : dirPath + '/%';
  const result = await db.db.execute(sql`
    SELECT mtime FROM files
    WHERE run_id = ${runId}
      AND path LIKE ${pattern}
      AND is_directory = false
      AND mtime > 0
    ORDER BY mtime ASC
  `);

  const mtimes = (result.rows as Array<{ mtime: number | string }>)
    .map(r => Number(r.mtime))
    .filter(m => m > 0);

  if (mtimes.length === 0) return { min: null, max: null, median: null, count: 0 };

  const min = mtimes[0];
  const max = mtimes[mtimes.length - 1];
  const mid = Math.floor(mtimes.length / 2);
  const median =
    mtimes.length % 2 === 0
      ? Math.round((mtimes[mid - 1] + mtimes[mid]) / 2)
      : mtimes[mid];

  return { min, max, median, count: mtimes.length };
}

/**
 * File-type composition of a subtree: bytes + count grouped by extension. The UI
 * maps extensions to types for the audit's "what is this made of" breakdown.
 * Root ('') covers the whole scan; any other directory covers its subtree.
 */
async function handleGetComposition(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<Array<{ ext: string | null; count: number; size: number }>> {
  const pattern = dirPath === '' ? '%' : dirPath + '/%';
  const result = await db.db.execute(sql`
    SELECT
      lower(substring(path from '\\.([^./]+)$')) as ext,
      COUNT(*)::int as count,
      COALESCE(SUM(physical_size), 0)::bigint as size
    FROM files
    WHERE run_id = ${runId}
      AND is_directory = false
      AND path LIKE ${pattern}
    GROUP BY ext
    ORDER BY size DESC
  `);

  return (result.rows as Array<{ ext: string | null; count: number | string; size: number | string }>).map(
    r => ({ ext: r.ext ?? null, count: Number(r.count), size: Number(r.size) })
  );
}

// === Main Command ===

export default class Query extends Command {
  static override description = 'Interactive JSON query interface for the database';

  static override summary = 'Start an interactive query session for UI communication';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --db custom-scan',
    'echo \'{"id":"1","action":"get_stats"}\' | <%= config.bin %> <%= command.id %>',
  ];

  static override flags = {
    db: Flags.string({
      char: 'd',
      description: 'Database name to query',
      default: 'main',
    }),
    'run-id': Flags.string({
      description: 'Specific run ID to query (defaults to latest)',
    }),
  };

  private database: DatabaseConnection | undefined;
  private runId: string | undefined;

  private sendResponse(response: QueryResponse): void {
    // Write JSON response to stdout, one line
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  private async processQuery(request: QueryRequest): Promise<void> {
    if (!this.database || !this.runId) {
      this.sendResponse({
        id: request.id,
        ok: false,
        error: 'Database not initialized',
      });
      return;
    }

    try {
      let data: unknown;

      switch (request.action) {
        case 'get_tree':
          data = await handleGetTree(this.database, this.runId);
          break;

        case 'get_files':
          data = await handleGetFiles(
            this.database,
            this.runId,
            request.path as string,
            (request.limit as number) || 1000,
            request.cursor as string | undefined
          );
          break;

        case 'get_duplicates':
          data = await handleGetDuplicates(
            this.database,
            this.runId,
            (request.min_size as number) || 0,
            (request.limit as number) || 100
          );
          break;

        case 'search':
          data = await handleSearch(
            this.database,
            this.runId,
            request.pattern as string,
            (request.limit as number) || 500,
            request.cursor as string | undefined
          );
          break;

        case 'get_stats':
          data = await handleGetStats(this.database, this.runId);
          break;

        case 'get_dir_date_stats':
          data = await handleGetDirDateStats(
            this.database,
            this.runId,
            (request.path as string) ?? ''
          );
          break;

        case 'get_composition':
          data = await handleGetComposition(
            this.database,
            this.runId,
            (request.path as string) ?? ''
          );
          break;

        case 'ping':
          data = { pong: true, timestamp: Date.now() };
          break;

        case 'describe_directory':
          data = await handleDescribeDirectory(
            this.database,
            this.runId,
            (request.path as string) ?? ''
          );
          break;

        case 'get_thumbnail':
          data = await handleGetThumbnail(
            this.database,
            this.runId,
            (request.path as string) ?? ''
          );
          break;

        case 'store_thumbnail':
          data = await handleStoreThumbnail(
            this.database,
            this.runId,
            (request.path as string) ?? '',
            request.thumbnail as string,
            (request.width as number) ?? 0,
            (request.height as number) ?? 0,
            (request.format as string) ?? 'image/png'
          );
          break;

        case 'set_delete_tag':
          data = await handleSetDeleteTag(
            this.database!,
            this.runId!,
            (request.path as string) ?? ''
          );
          break;

        case 'remove_delete_tag':
          data = await handleRemoveDeleteTag(
            this.database!,
            this.runId!,
            (request.path as string) ?? ''
          );
          break;

        case 'get_delete_tags':
          data = await handleGetDeleteTags(this.database!, this.runId!);
          break;

        case 'set_alias':
          data = await handleSetAlias(
            this.database!,
            this.runId!,
            (request.path as string) ?? '',
            (request.alias as string) ?? ''
          );
          break;

        case 'set_comment':
          data = await handleSetComment(
            this.database!,
            this.runId!,
            (request.path as string) ?? '',
            (request.comment as string) ?? ''
          );
          break;

        case 'create_tag':
          data = await handleCreateTag(
            this.database!,
            this.runId!,
            (request.name as string) ?? ''
          );
          break;

        case 'rename_tag':
          data = await handleRenameTag(
            this.database!,
            this.runId!,
            (request.tag_id as string) ?? '',
            (request.name as string) ?? ''
          );
          break;

        case 'delete_tag':
          data = await handleDeleteTag(
            this.database!,
            this.runId!,
            (request.tag_id as string) ?? ''
          );
          break;

        case 'assign_tag':
          data = await handleAssignTag(
            this.database!,
            this.runId!,
            (request.tag_id as string) ?? '',
            (request.path as string) ?? ''
          );
          break;

        case 'unassign_tag':
          data = await handleUnassignTag(
            this.database!,
            this.runId!,
            (request.tag_id as string) ?? '',
            (request.path as string) ?? ''
          );
          break;

        case 'get_enrichment':
          data = await handleGetEnrichment(this.database!, this.runId!);
          break;

        case 'get_element_enrichment':
          data = await handleGetElementEnrichment(
            this.database!,
            this.runId!,
            (request.path as string) ?? ''
          );
          break;

        default:
          this.sendResponse({
            id: request.id,
            ok: false,
            error: `Unknown action: ${request.action}`,
          });
          return;
      }

      this.sendResponse({
        id: request.id,
        ok: true,
        data,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Logging disabled to preserve JSON protocol

      this.sendResponse({
        id: request.id,
        ok: false,
        error: errorMessage,
      });
    }
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Query);

    // Initialize logging with console DISABLED to preserve JSON protocol
    await initializeLogging({
      level: 'info',
      enableConsoleLogging: false,
      enableFileLogging: true,
    });

    try {
      // Open database
      this.database = await createScanDatabase(flags.db);

      // Ensure enrichment tables exist so the tree/files queries can LEFT JOIN
      // them even on a fresh scan that has no enrichment yet.
      await ensureEnrichmentTables(this.database);

      // Determine run ID
      if (flags['run-id']) {
        this.runId = flags['run-id'];
      } else {
        // Get latest run ID
        const latestRunId = await new Promise<string | null>((resolve, reject) => {
          if (!this.database) {
            reject(new Error('Database not initialized'));
            return;
          }
          getLatestRunId(this.database).subscribe({
            next: id => resolve(id),
            error: err => reject(err),
          });
        });

        if (!latestRunId) {
          this.error('No scan data found in database. Run a scan first.', { exit: 1 });
        }

        this.runId = latestRunId;
      }

      // Query session started - logging disabled to preserve JSON protocol

      // Signal ready to the UI
      this.sendResponse({
        id: '__ready__',
        ok: true,
        data: { run_id: this.runId, status: 'ready' },
      });

      // Set up readline for stdin
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      // Process each line as a JSON query
      rl.on('line', async (line: string) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        try {
          const request = JSON.parse(trimmedLine) as QueryRequest;

          if (!request.id) {
            this.sendResponse({
              id: '__error__',
              ok: false,
              error: 'Missing required field: id',
            });
            return;
          }

          if (!request.action) {
            this.sendResponse({
              id: request.id,
              ok: false,
              error: 'Missing required field: action',
            });
            return;
          }

          await this.processQuery(request);
        } catch (parseError) {
          this.sendResponse({
            id: '__error__',
            ok: false,
            error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          });
        }
      });

      // Handle stdin close (UI disconnected)
      rl.on('close', () => {
        // Query session ended (stdin closed)
        process.exit(0);
      });

      // Keep process alive
      await new Promise<void>(() => {
        // This promise never resolves - process exits on stdin close or signal
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Logging disabled to preserve JSON protocol
      this.error(`Query failed: ${errorMessage}`, { exit: 1 });
    } finally {
      if (this.database) {
        await closeScanDatabase(this.database);
      }
    }
  }
}
