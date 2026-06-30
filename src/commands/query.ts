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
  populateDirStats,
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

export interface QueryRequest {
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
  /** Levels the deepest descendant sits below this directory (0 = leaf folder). */
  max_depth: number;
  /** Path of that deepest descendant, or null if the folder is empty. */
  deepest_path: string | null;
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
  runId: string,
  scanning = false
): Promise<{ root: string | null; directories: DirectoryNode[] }> {
  // Get the root path from scan metadata
  const metadataResult = await db.db
    .select({ root_path: scanMetadata.root_path })
    .from(scanMetadata)
    .where(eq(scanMetadata.run_id, runId))
    .limit(1);

  const rootPath = metadataResult[0]?.root_path || null;

  // Ensure the per-directory aggregates are materialized for this run. During an
  // owner-mode scan, dir_stats is maintained incrementally (rollupDirStatsBatch) and
  // this read just returns the partial-but-growing tree — so we must NOT lazily
  // recompute here (that would double-count against the rollup). When NOT scanning,
  // lazily materialize once for scans made before incremental maintenance existed
  // (a new scan = a new run_id, so it never goes stale).
  if (!scanning) {
    const populated = await db.db.execute(
      sql`SELECT 1 FROM dir_stats WHERE run_id = ${runId} LIMIT 1`
    );
    if (populated.rows.length === 0) {
      await populateDirStats(db, runId);
    }
  }

  // Read the materialized aggregates and join the (cheap) enrichment flags.
  const directoriesQuery = await db.db.execute(sql`
    SELECT
      ds.path as path,
      ds.total_size,
      ds.file_count,
      ds.dir_count,
      ds.max_depth,
      ds.deepest_path,
      al.alias as alias,
      EXISTS (SELECT 1 FROM comments cm WHERE cm.run_id = ${runId} AND cm.path = ds.path) as has_comment,
      EXISTS (SELECT 1 FROM tag_assignments tg WHERE tg.run_id = ${runId} AND tg.path = ds.path) as has_tag,
      EXISTS (
        SELECT 1 FROM delete_tags dt
        WHERE dt.run_id = ${runId}
          AND (dt.path = ds.path OR starts_with(ds.path, dt.path || '/'))
      ) as tagged_for_deletion
    FROM dir_stats ds
    LEFT JOIN aliases al ON al.run_id = ${runId} AND al.path = ds.path
    WHERE ds.run_id = ${runId}
    ORDER BY ds.path
  `);

  const directories: DirectoryNode[] = (
    directoriesQuery.rows as Array<{
      path: string;
      total_size: string | number;
      file_count: string | number;
      dir_count: string | number;
      max_depth: string | number;
      deepest_path: string | null;
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
      max_depth: Number(row.max_depth) || 0,
      deepest_path: row.deepest_path ?? null,
      alias: row.alias ?? null,
      has_comment: Boolean(row.has_comment),
      has_tag: Boolean(row.has_tag),
      tagged_for_deletion: Boolean(row.tagged_for_deletion),
    };
  });

  return { root: rootPath, directories };
}

/**
 * Phase 5 SPIKE — live, DB-backed icicle tree, cheap enough to read DURING a scan
 * (no dir_stats materialization). Depth-capped ancestor attribution scoped to a
 * focus subtree: every file/dir adds to each ancestor from depth 1 down to depthCap,
 * so directories at depth ≤ cap carry their FULL subtree rollup — identical to the
 * provisional stream's accumulate(), but computed in SQL. Prefix-LIKE on path uses
 * idx_files_path_pattern. `focusPath=''` = whole tree (root LOD, the worst case).
 */
async function handleGetLiveTree(
  db: DatabaseConnection,
  runId: string,
  focusPath: string,
  depthCap: number
): Promise<{ directories: Array<{ path: string; total_size: number; file_count: number; dir_count: number }> }> {
  const scope = focusPath
    ? sql`AND (path = ${focusPath} OR path LIKE ${`${focusPath}/%`})`
    : sql``;
  const rows = (
    await db.db.execute(sql`
      SELECT
        anc_path AS path,
        COALESCE(SUM(CASE WHEN kind = 'file' THEN sz ELSE 0 END), 0) AS total_size,
        COALESCE(SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END), 0) AS file_count,
        COALESCE(SUM(CASE WHEN kind = 'dir'  THEN 1 ELSE 0 END), 0) AS dir_count
      FROM (
        SELECT
          array_to_string((string_to_array(f.path, '/'))[1:i.i], '/') AS anc_path,
          CASE WHEN f.is_directory THEN 'dir' ELSE 'file' END AS kind,
          f.physical_size AS sz
        FROM (
          SELECT path, physical_size, is_directory,
            (length(path) - length(replace(path, '/', '')) + 1) AS segs
          FROM files
          WHERE run_id = ${runId} ${scope}
        ) f
        CROSS JOIN LATERAL generate_series(1, LEAST(f.segs - 1, ${depthCap})) AS i(i)
      ) anc
      GROUP BY anc_path
    `)
  ).rows as Array<{ path: string; total_size: string | number; file_count: string | number; dir_count: string | number }>;
  return {
    directories: rows.map(r => ({
      path: r.path,
      total_size: Number(r.total_size) || 0,
      file_count: Number(r.file_count) || 0,
      dir_count: Number(r.dir_count) || 0,
    })),
  };
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

/**
 * Route a query request to its handler against a given connection + run. Pure
 * dispatch (no I/O): returns the data or throws. Shared by the `query` command and
 * the single-owner `session` sidecar so both expose exactly the same read/enrich
 * surface over one connection.
 */
export async function dispatchQuery(
  database: DatabaseConnection,
  runId: string,
  request: QueryRequest,
  scanning = false
): Promise<unknown> {
  switch (request.action) {
    case 'get_tree':
      return await handleGetTree(database, runId, scanning);
    case 'get_live_tree':
      return await handleGetLiveTree(
        database,
        runId,
        (request.path as string) ?? '',
        (request.depthCap as number) ?? 4
      );
    case 'get_files':
      return await handleGetFiles(
        database,
        runId,
        request.path as string,
        (request.limit as number) || 1000,
        request.cursor as string | undefined
      );
    case 'get_duplicates':
      return await handleGetDuplicates(
        database,
        runId,
        (request.min_size as number) || 0,
        (request.limit as number) || 100
      );
    case 'search':
      return await handleSearch(
        database,
        runId,
        request.pattern as string,
        (request.limit as number) || 500,
        request.cursor as string | undefined
      );
    case 'get_stats':
      return await handleGetStats(database, runId);
    case 'get_dir_date_stats':
      return await handleGetDirDateStats(database, runId, (request.path as string) ?? '');
    case 'get_composition':
      return await handleGetComposition(database, runId, (request.path as string) ?? '');
    case 'ping':
      return { pong: true, timestamp: Date.now() };
    case 'describe_directory':
      return await handleDescribeDirectory(database, runId, (request.path as string) ?? '');
    case 'get_thumbnail':
      return await handleGetThumbnail(database, runId, (request.path as string) ?? '');
    case 'store_thumbnail':
      return await handleStoreThumbnail(
        database,
        runId,
        (request.path as string) ?? '',
        request.thumbnail as string,
        (request.width as number) ?? 0,
        (request.height as number) ?? 0,
        (request.format as string) ?? 'image/png'
      );
    case 'set_delete_tag':
      return await handleSetDeleteTag(database, runId, (request.path as string) ?? '');
    case 'remove_delete_tag':
      return await handleRemoveDeleteTag(database, runId, (request.path as string) ?? '');
    case 'get_delete_tags':
      return await handleGetDeleteTags(database, runId);
    case 'set_alias':
      return await handleSetAlias(
        database,
        runId,
        (request.path as string) ?? '',
        (request.alias as string) ?? ''
      );
    case 'set_comment':
      return await handleSetComment(
        database,
        runId,
        (request.path as string) ?? '',
        (request.comment as string) ?? ''
      );
    case 'create_tag':
      return await handleCreateTag(database, runId, (request.name as string) ?? '');
    case 'rename_tag':
      return await handleRenameTag(
        database,
        runId,
        (request.tag_id as string) ?? '',
        (request.name as string) ?? ''
      );
    case 'delete_tag':
      return await handleDeleteTag(database, runId, (request.tag_id as string) ?? '');
    case 'assign_tag':
      return await handleAssignTag(
        database,
        runId,
        (request.tag_id as string) ?? '',
        (request.path as string) ?? ''
      );
    case 'unassign_tag':
      return await handleUnassignTag(
        database,
        runId,
        (request.tag_id as string) ?? '',
        (request.path as string) ?? ''
      );
    case 'get_enrichment':
      return await handleGetEnrichment(database, runId);
    case 'get_element_enrichment':
      return await handleGetElementEnrichment(database, runId, (request.path as string) ?? '');
    default:
      throw new Error(`Unknown action: ${request.action}`);
  }
}

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
      this.sendResponse({ id: request.id, ok: false, error: 'Database not initialized' });
      return;
    }

    try {
      const data = await dispatchQuery(this.database, this.runId, request);
      this.sendResponse({ id: request.id, ok: true, data });
    } catch (error) {
      this.sendResponse({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
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
