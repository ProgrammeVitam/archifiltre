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
import { initializeLogging, drainRingLog, logger } from '@lib/logging.ts';
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
import {
  handleDescribeDirectory,
  handleDescribePrepare,
  handleStoreDescription,
} from '@extensions/ai-describe/index.ts';
import { warmLocal } from '@extensions/ai-describe/local-engine.ts';
import {
  LOCAL_MODELS,
  DEFAULT_LOCAL_MODEL,
  isModelDownloaded,
  downloadModel,
  getLocalModel,
  DownloadError,
} from '@extensions/ai-describe/local-llm.ts';
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
  handleUndo,
  handleRedo,
  handleUndoState,
  handleRestoreAnnotations,
  handleHasAnnotationBackup,
  handleExportAnnotations,
  handleImportAnnotations,
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
  /** This directory node is really an archive container (foo.zip): drills in like a
   *  folder, but should render like a compressed file. */
  is_archive?: boolean;
  archive_format?: string | null;
  /** Descendant mtime range + representative median (epoch seconds), folded in for a
   *  settled tree only. Absent during a live scan. */
  min_mtime?: number;
  max_mtime?: number;
  median_mtime?: number;
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
      -- An archive container (foo.zip) is a directory node in the tree (its entries are
      -- path-prefixed by it) but a plain file row in the files table; surface that so the
      -- icicle can render it dark like a compressed file while it still drills in as a folder.
      (fa.path IS NOT NULL) as is_archive,
      fa.archive_format as archive_format,
      EXISTS (SELECT 1 FROM comments cm WHERE cm.run_id = ${runId} AND cm.path = ds.path) as has_comment,
      EXISTS (SELECT 1 FROM tag_assignments tg WHERE tg.run_id = ${runId} AND tg.path = ds.path) as has_tag,
      EXISTS (
        SELECT 1 FROM delete_tags dt
        WHERE dt.run_id = ${runId}
          AND (dt.path = ds.path OR starts_with(ds.path, dt.path || '/'))
      ) as tagged_for_deletion
    FROM dir_stats ds
    LEFT JOIN aliases al ON al.run_id = ${runId} AND al.path = ds.path
    LEFT JOIN files fa ON fa.run_id = ${runId} AND fa.path = ds.path AND fa.is_archive_container = true
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
      is_archive: boolean;
      archive_format: string | null;
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
      is_archive: Boolean(row.is_archive),
      archive_format: row.archive_format ?? null,
      has_comment: Boolean(row.has_comment),
      has_tag: Boolean(row.has_tag),
      tagged_for_deletion: Boolean(row.tagged_for_deletion),
    };
  });

  // For a settled tree (not the live-scan poll), fold in each folder's date range and
  // a representative median, computed in ONE pass: explode every file into its ancestor
  // folder paths, then aggregate. This is what lets folders colour by date and sort by
  // date. Skipped while scanning — dates aren't needed live and this would re-run every
  // poll. `percentile_cont` (a real median) is nearly free here since folder groups are
  // small; min/max give the range.
  if (!scanning && directories.length > 0) {
    const dateRows = await db.db.execute(sql`
      SELECT array_to_string((string_to_array(f.path, '/'))[1:g.i], '/') AS dir,
             min(f.mtime) AS min_mtime,
             max(f.mtime) AS max_mtime,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY f.mtime)::bigint AS median_mtime
      FROM files f,
           generate_series(1, cardinality(string_to_array(f.path, '/')) - 1) AS g(i)
      WHERE f.run_id = ${runId} AND NOT f.is_directory AND f.mtime > 0
      GROUP BY dir
    `);
    const byDir = new Map(
      (
        dateRows.rows as Array<{
          dir: string;
          min_mtime: number | string;
          max_mtime: number | string;
          median_mtime: number | string;
        }>
      ).map(r => [r.dir, r])
    );
    for (const d of directories) {
      const dd = byDir.get(d.path);
      if (dd) {
        d.min_mtime = Number(dd.min_mtime);
        d.max_mtime = Number(dd.max_mtime);
        d.median_mtime = Number(dd.median_mtime);
      }
    }
  }

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

/**
 * Get ALL files in the scan (recursively, not per-directory), server-sorted and
 * paginated. This backs the Flat list view: one windowed query instead of walking
 * every directory in JS, so it scales to huge trees and paints the first page fast.
 */
async function handleGetAllFiles(
  db: DatabaseConnection,
  runId: string,
  sortBy: 'name' | 'size' | 'mtime' = 'size',
  sortDir: 'asc' | 'desc' = 'desc',
  limit: number = 500,
  offset: number = 0,
  duplicatesOnly: boolean = false
): Promise<{ files: FileNode[]; total: number; has_more: boolean }> {
  const notDir = sql`is_directory = false`;

  // "Group by duplicates" mode: restrict to files whose content hash is shared by
  // at least one other file (i.e. real duplicates), so the list shows ONLY duplicates.
  const dupFilter = duplicatesOnly
    ? sql`hash IS NOT NULL AND hash IN (
        SELECT hash FROM files
        WHERE run_id = ${runId} AND is_directory = false AND hash IS NOT NULL
        GROUP BY hash HAVING count(*) > 1
      )`
    : sql`true`;

  const countResult = await db.db
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(and(eq(files.run_id, runId), notDir, dupFilter));
  const total = Number(countResult[0]?.count) || 0;

  const sortCol =
    sortBy === 'size' ? files.physical_size : sortBy === 'mtime' ? files.mtime : files.path;
  const primary = sortDir === 'asc' ? asc(sortCol) : desc(sortCol);

  // In duplicates mode, keep each duplicate group contiguous: order by size desc
  // (biggest wasted space first — dupes of a hash all share one size), then hash to
  // cluster the group, then path. Otherwise use the user's chosen sort.
  const ordering = duplicatesOnly
    ? [desc(files.physical_size), asc(files.hash), asc(files.path)]
    : [primary, asc(files.path)];

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
      alias: sql<
        string | null
      >`(SELECT a.alias FROM aliases a WHERE a.run_id = ${runId} AND a.path = "files"."path")`,
      has_comment: sql<boolean>`EXISTS (SELECT 1 FROM comments c WHERE c.run_id = ${runId} AND c.path = "files"."path")`,
      has_tag: sql<boolean>`EXISTS (SELECT 1 FROM tag_assignments tg WHERE tg.run_id = ${runId} AND tg.path = "files"."path")`,
      tagged_for_deletion: sql<boolean>`EXISTS (SELECT 1 FROM delete_tags dt WHERE dt.run_id = ${runId} AND (dt.path = "files"."path" OR starts_with("files"."path", dt.path || '/')))`,
      // True group size: how many copies share this hash across the WHOLE result (window
      // function → computed before LIMIT/OFFSET). Lets the UI show the real "N×" even when a
      // page boundary splits a group across pages. Only meaningful (and only computed) in
      // duplicates mode; a constant 0 otherwise avoids a needless per-row window scan.
      dup_count: duplicatesOnly
        ? sql<number>`count(*) OVER (PARTITION BY hash)`
        : sql<number>`0`,
    })
    .from(files)
    .where(and(eq(files.run_id, runId), notDir, dupFilter))
    // Tiebreak on path so the order is stable across pages (offset pagination).
    .orderBy(...ordering)
    .limit(limit)
    .offset(offset);

  const fileNodes: FileNode[] = results.map(row => {
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
      dup_count: duplicatesOnly ? Number(row.dup_count) : undefined,
    };
  });

  return { files: fileNodes, total, has_more: offset + fileNodes.length < total };
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
): Promise<{
  min: number | null;
  max: number | null;
  median: number | null;
  count: number;
  buckets: { cold: number; warm: number; active: number };
  // Subtree aggregates (bytes on disk, file + directory counts). Sourced from the files
  // table so they're available AS SOON AS ingestion completes — i.e. the whole time the
  // hashing (duplicates) phase runs — not only once the scan fully finishes. total physical
  // size matches dir_stats.total_size (both SUM(physical_size) over descendant files).
  size: number;
  fileCount: number;
  dirCount: number;
}> {
  // Root ('') aggregates the whole scan; any other directory matches its subtree.
  const pattern = dirPath === '' ? '%' : dirPath + '/%';

  // Subtree size + file/dir counts — one pass, independent of the date scan below so it
  // still returns real figures for a directory that holds only dirs or mtime-0 files.
  const aggResult = await db.db.execute(sql`
    SELECT
      COALESCE(SUM(physical_size) FILTER (WHERE is_directory = false), 0)::bigint AS size,
      COUNT(*) FILTER (WHERE is_directory = false)::int AS file_count,
      COUNT(*) FILTER (WHERE is_directory = true)::int AS dir_count
    FROM files
    WHERE run_id = ${runId} AND path LIKE ${pattern}
  `);
  const aggRow = aggResult.rows[0] as
    | { size: number | string; file_count: number | string; dir_count: number | string }
    | undefined;
  const size = Number(aggRow?.size ?? 0);
  const fileCount = Number(aggRow?.file_count ?? 0);
  const dirCount = Number(aggRow?.dir_count ?? 0);

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

  const empty = { cold: 0, warm: 0, active: 0 };
  if (mtimes.length === 0)
    return { min: null, max: null, median: null, count: 0, buckets: empty, size, fileCount, dirCount };

  const min = mtimes[0];
  const max = mtimes[mtimes.length - 1];
  const mid = Math.floor(mtimes.length / 2);
  const median =
    mtimes.length % 2 === 0
      ? Math.round((mtimes[mid - 1] + mtimes[mid]) / 2)
      : mtimes[mid];

  // Age buckets relative to now (mtime is unix seconds): cold > 5 yrs, warm 1–5 yrs,
  // active < 1 yr. Feeds the "Répartition par âge" of the root summary.
  const now = Date.now() / 1000;
  const oneYear = 365 * 24 * 3600;
  const y1 = now - oneYear;
  const y5 = now - 5 * oneYear;
  const buckets = { cold: 0, warm: 0, active: 0 };
  for (const m of mtimes) {
    if (m < y5) buckets.cold++;
    else if (m < y1) buckets.warm++;
    else buckets.active++;
  }

  return { min, max, median, count: mtimes.length, buckets, size, fileCount, dirCount };
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
/** Report which local (Qwen) models exist on disk, for the Settings picker. */
async function handleModelStatus(): Promise<unknown> {
  const models = await Promise.all(
    LOCAL_MODELS.map(async (m) => ({
      id: m.id,
      label: m.label,
      family: m.family,
      tier: m.tier,
      note: m.note,
      size: m.size,
      license: m.license,
      downloaded: await isModelDownloaded(m.id),
    }))
  );
  return { models, default: DEFAULT_LOCAL_MODEL };
}

/**
 * Download a local model to `~/.archifiltre/models/`, streaming progress to the
 * UI as `model:download` event lines (forwarded via the job-update channel).
 * Resolves with the on-disk path when complete.
 */
async function handleDownloadModel(id: string): Promise<unknown> {
  if (!getLocalModel(id)) throw new Error(`Unknown local model: ${id}`);
  let lastEmit = 0;
  try {
    const path = await downloadModel(id, (p) => {
      // Throttle to ~10/s so we don't flood the protocol channel.
      const now = Date.now();
      if (now - lastEmit < 100 && p.received < p.total) return;
      lastEmit = now;
      process.stdout.write(
        `${JSON.stringify({ event: 'model:download', model: id, received: p.received, total: p.total, file: p.file })}\n`
      );
    });
    process.stdout.write(
      `${JSON.stringify({ event: 'model:download', model: id, received: 1, total: 1, file: 'done', done: true })}\n`
    );
    return { id, path, downloaded: true };
  } catch (err) {
    // Emit a final error event so the UI can show *why* (cert / dns / firewall / proxy / disk)
    // instead of a bar silently stuck at 0. The categorized detail is already in the file log.
    const category = err instanceof DownloadError ? err.category : 'unknown';
    process.stdout.write(
      `${JSON.stringify({ event: 'model:download', model: id, error: { category, message: (err as Error).message } })}\n`
    );
    throw err;
  }
}

/**
 * Pre-load the local model so the first describe is warm (~0.7 s) not cold (~9 s). Fired by the UI
 * when local-AI mode is active (e.g. on scan start) — cheap and idempotent; loads in the background.
 */
async function handleWarmModel(id: string): Promise<unknown> {
  return warmLocal(id || DEFAULT_LOCAL_MODEL);
}

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
    case 'get_all_files':
      return await handleGetAllFiles(
        database,
        runId,
        (request.sort_by as 'name' | 'size' | 'mtime') || 'size',
        (request.sort_dir as 'asc' | 'desc') || 'desc',
        (request.limit as number) || 500,
        (request.offset as number) || 0,
        Boolean(request.duplicates_only)
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
    case 'get_ring_log':
      // Drain this owner process's in-memory log ring (RFC5424 lines) for the export bundle.
      // Decoupled from the open log file, so a Windows file lock can't empty the diagnostics.
      // DB-free: the ring lives in process memory, so this works even when the DB is broken.
      return { ring: drainRingLog() };
    case 'describe_directory':
      return await handleDescribeDirectory(
        database,
        runId,
        (request.path as string) ?? '',
        request.llm as
          | {
              provider?: 'local' | 'external';
              baseUrl?: string;
              apiKey?: string;
              model?: string;
              lang?: string;
              streamId?: string;
            }
          | undefined,
        scanning
      );
    // Split describe for the app-global LLM host: the owner does the DB halves (cache +
    // gate + prompt, then the cache write); generation runs on the host (Rust-owned).
    case 'describe_prepare': {
      const prepared = await handleDescribePrepare(
        database,
        runId,
        (request.path as string) ?? '',
        request.llm as { provider?: 'local' | 'external'; lang?: string } | undefined,
        scanning
      );
      // AI-trace leg 1 (grep 'llm.describe.prepare'), correlated by describeId. `gateBlocked=scan`
      // means the describe was deferred because a scan is in progress; the ABSENCE of this line for
      // a describe means leg 1 never ran (session/run not ready — the run-readiness latch upstream).
      const p = prepared as { error?: string; cached?: unknown; cacheable?: boolean };
      logger.info('llm.describe.prepare', {
        describeId: request.describeId as string | undefined,
        gateBlocked: p.error === 'scan-in-progress' ? 'scan' : undefined,
        cached: !!p.cached,
        cacheable: p.cacheable,
      });
      return prepared;
    }
    case 'store_description': {
      const stored = await handleStoreDescription(database, runId, (request.path as string) ?? '', {
        description: (request.description as string) ?? '',
        model: (request.model as string) ?? 'unknown',
        lang: request.lang as string | undefined,
      });
      logger.info('llm.describe.store', {
        describeId: request.describeId as string | undefined,
      });
      return stored;
    }
    case 'model_status':
      return await handleModelStatus();
    case 'warm_model':
      return await handleWarmModel((request.model as string) ?? '');
    case 'download_model':
      return await handleDownloadModel((request.model as string) ?? '');
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
    case 'undo':
      return await handleUndo(database, runId);
    case 'redo':
      return await handleRedo(database, runId);
    case 'undo_state':
      return await handleUndoState(database, runId);
    case 'restore_annotations':
      return await handleRestoreAnnotations(database, runId);
    case 'has_annotation_backup':
      return await handleHasAnnotationBackup(database, runId);
    case 'export_annotations':
      return await handleExportAnnotations(database, runId, (request.outputPath as string) ?? '');
    case 'import_annotations':
      return await handleImportAnnotations(database, runId, (request.inputPath as string) ?? '');
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
