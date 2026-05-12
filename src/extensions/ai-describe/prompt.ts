/**
 * AI Describe Extension - Prompt Builder
 *
 * Functions to build LLM prompts from directory tree structure and file statistics.
 * Queries the database to construct a human-readable tree representation and
 * statistical summary that helps the LLM understand what a directory contains.
 */

import { type DatabaseConnection } from '@lib/database.ts';

// === Constants ===

/**
 * System prompt instructing the LLM on how to describe directories.
 */
export const SYSTEM_PROMPT =
  'You are a file system analyst. Given a directory tree, describe in 1-2 sentences what this directory is about. Be concise and specific. Answer in the language of the filenames if they are not in English.';

// === Tree Building ===

interface TreeBuildOptions {
  maxDepth?: number;
  maxFilesPerDir?: number;
  maxTotalLines?: number;
}

interface TreeBuildState {
  totalLines: number;
  maxTotalLines: number;
}

/**
 * Format a byte count into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const index = Math.min(i, units.length - 1);
  const value = bytes / Math.pow(k, index);
  // Use integers for bytes, one decimal for everything else
  if (index === 0) return `${bytes} B`;
  return `${value.toFixed(1)} ${units[index]}`;
}

/**
 * Query direct children of a directory from the files table.
 * Returns rows with path, is_directory, and physical_size.
 */
async function queryDirectChildren(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<Array<{ path: string; is_directory: boolean; physical_size: number }>> {
  let query: string;
  let params: unknown[];

  if (dirPath === '') {
    // Root: direct children have no '/' in their path
    query = `
      SELECT path, is_directory, physical_size
      FROM files
      WHERE run_id = $1 AND path NOT LIKE '%/%'
      ORDER BY is_directory DESC, path ASC
    `;
    params = [runId];
  } else {
    // Subdirectory: children start with dirPath/ but have no further /
    query = `
      SELECT path, is_directory, physical_size
      FROM files
      WHERE run_id = $1 AND path LIKE $2 AND path NOT LIKE $3
      ORDER BY is_directory DESC, path ASC
    `;
    params = [runId, `${dirPath}/%`, `${dirPath}/%/%`];
  }

  const result = await db.pg.query(query, params);
  return result.rows as Array<{ path: string; is_directory: boolean; physical_size: number }>;
}

/**
 * Count total files and subdirectories under a given directory path.
 */
async function countDescendants(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<{ fileCount: number; dirCount: number }> {
  let query: string;
  let params: unknown[];

  if (dirPath === '') {
    query = `
      SELECT
        COUNT(*) FILTER (WHERE is_directory = false) AS file_count,
        COUNT(*) FILTER (WHERE is_directory = true) AS dir_count
      FROM files
      WHERE run_id = $1
    `;
    params = [runId];
  } else {
    query = `
      SELECT
        COUNT(*) FILTER (WHERE is_directory = false) AS file_count,
        COUNT(*) FILTER (WHERE is_directory = true) AS dir_count
      FROM files
      WHERE run_id = $1 AND (path = $2 OR path LIKE $3)
    `;
    params = [runId, dirPath, `${dirPath}/%`];
  }

  const result = await db.pg.query(query, params);
  const row = result.rows[0] as { file_count: string; dir_count: string } | undefined;
  return {
    fileCount: Number(row?.file_count ?? 0),
    dirCount: Number(row?.dir_count ?? 0),
  };
}

/**
 * Count total physical_size under a given directory path (files only).
 */
async function countTotalSize(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<number> {
  let query: string;
  let params: unknown[];

  if (dirPath === '') {
    query = `
      SELECT COALESCE(SUM(physical_size), 0) AS total_size
      FROM files
      WHERE run_id = $1 AND is_directory = false
    `;
    params = [runId];
  } else {
    query = `
      SELECT COALESCE(SUM(physical_size), 0) AS total_size
      FROM files
      WHERE run_id = $1 AND is_directory = false AND path LIKE $2
    `;
    params = [runId, `${dirPath}/%`];
  }

  const result = await db.pg.query(query, params);
  const row = result.rows[0] as { total_size: string } | undefined;
  return Number(row?.total_size ?? 0);
}

/**
 * Get the basename (last path component) from a path string.
 */
function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Count direct child files and subdirectories (not recursive).
 */
async function countDirectChildren(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<{ fileCount: number; subdirCount: number }> {
  const children = await queryDirectChildren(db, runId, dirPath);
  let fileCount = 0;
  let subdirCount = 0;
  for (const child of children) {
    if (child.is_directory) {
      subdirCount++;
    } else {
      fileCount++;
    }
  }
  return { fileCount, subdirCount };
}

/**
 * Build a directory annotation like "(X files)" or "(X files, Y subdirs)".
 */
function buildDirAnnotation(fileCount: number, subdirCount: number): string {
  const parts: string[] = [];
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
  }
  if (subdirCount > 0) {
    parts.push(`${subdirCount} subdir${subdirCount !== 1 ? 's' : ''}`);
  }
  if (parts.length === 0) {
    return '(empty)';
  }
  return `(${parts.join(', ')})`;
}

/**
 * Recursively build tree lines for a directory's children.
 */
async function buildTreeLines(
  db: DatabaseConnection,
  runId: string,
  dirPath: string,
  prefix: string,
  currentDepth: number,
  maxDepth: number,
  maxFilesPerDir: number,
  state: TreeBuildState
): Promise<string[]> {
  if (state.totalLines >= state.maxTotalLines) return [];
  if (currentDepth > maxDepth) return [];

  const children = await queryDirectChildren(db, runId, dirPath);

  // Separate directories and files
  const dirs = children.filter(c => c.is_directory);
  const filesOnly = children.filter(c => !c.is_directory);

  const lines: string[] = [];
  const allItems = [...dirs, ...filesOnly];
  const totalItems = allItems.length;
  let displayedFiles = 0;

  for (let i = 0; i < totalItems; i++) {
    if (state.totalLines >= state.maxTotalLines) break;

    const item = allItems[i];
    const isLast = i === totalItems - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? `${prefix}    ` : `${prefix}│   `;
    const name = basename(item.path);

    if (item.is_directory) {
      // Get child counts for annotation
      const { fileCount, subdirCount } = await countDirectChildren(db, runId, item.path);
      const annotation = buildDirAnnotation(fileCount, subdirCount);
      lines.push(`${prefix}${connector}${name}/ ${annotation}`);
      state.totalLines++;

      // Recurse into subdirectory
      if (currentDepth < maxDepth) {
        const subLines = await buildTreeLines(
          db,
          runId,
          item.path,
          childPrefix,
          currentDepth + 1,
          maxDepth,
          maxFilesPerDir,
          state
        );
        lines.push(...subLines);
      }
    } else {
      // File
      displayedFiles++;
      if (displayedFiles <= maxFilesPerDir) {
        lines.push(`${prefix}${connector}${name}`);
        state.totalLines++;
      } else if (displayedFiles === maxFilesPerDir + 1) {
        // Show truncation message
        const remaining = filesOnly.length - maxFilesPerDir;
        const truncConnector = isLast ? '└── ' : '├── ';
        lines.push(
          `${prefix}${truncConnector}... (${remaining} more file${remaining !== 1 ? 's' : ''})`
        );
        state.totalLines++;
        // Skip remaining files
        break;
      }
    }
  }

  return lines;
}

/**
 * Build a tree string representation of a directory from the database.
 *
 * @param db - Database connection
 * @param runId - The scan run ID
 * @param dirPath - Directory path (empty string for root)
 * @param options - Tree rendering options
 * @returns A formatted tree string
 */
export async function buildTreeString(
  db: DatabaseConnection,
  runId: string,
  dirPath: string,
  options?: TreeBuildOptions
): Promise<string> {
  const maxDepth = options?.maxDepth ?? 3;
  const maxFilesPerDir = options?.maxFilesPerDir ?? 15;
  const maxTotalLines = options?.maxTotalLines ?? 80;

  const state: TreeBuildState = { totalLines: 0, maxTotalLines };

  // Build root line
  const { fileCount, dirCount } = await countDescendants(db, runId, dirPath);
  const totalSize = await countTotalSize(db, runId, dirPath);
  const dirName = dirPath === '' ? '.' : basename(dirPath);

  const rootLine = `${dirName} (${dirCount} director${dirCount !== 1 ? 'ies' : 'y'}, ${fileCount} file${fileCount !== 1 ? 's' : ''}, ${formatBytes(totalSize)} total)`;
  state.totalLines++;

  // Build child lines
  const childLines = await buildTreeLines(
    db,
    runId,
    dirPath,
    '',
    1,
    maxDepth,
    maxFilesPerDir,
    state
  );

  return [rootLine, ...childLines].join('\n');
}

// === Stats Block ===

/**
 * Build a statistics block summarizing file types, sizes, and dates for a directory.
 *
 * @param db - Database connection
 * @param runId - The scan run ID
 * @param dirPath - Directory path (empty string for root)
 * @returns A formatted statistics string
 */
export async function buildStatsBlock(
  db: DatabaseConnection,
  runId: string,
  dirPath: string
): Promise<string> {
  // Query all descendant files (not directories)
  let whereClause: string;
  let params: unknown[];

  if (dirPath === '') {
    whereClause = 'WHERE run_id = $1 AND is_directory = false';
    params = [runId];
  } else {
    whereClause = 'WHERE run_id = $1 AND is_directory = false AND path LIKE $2';
    params = [runId, `${dirPath}/%`];
  }

  // File type breakdown
  const typeQuery = `
    SELECT
      CASE
        WHEN path LIKE '%.%' THEN '.' || LOWER(SPLIT_PART(REVERSE(SPLIT_PART(REVERSE(path), '/', 1)), '.', 1))
        ELSE '(no extension)'
      END AS ext,
      COUNT(*) AS cnt
    FROM files
    ${whereClause}
    GROUP BY ext
    ORDER BY cnt DESC
  `;
  const typeResult = await db.pg.query(typeQuery, params);
  const typeRows = typeResult.rows as Array<{ ext: string; cnt: string }>;

  // Size range
  const sizeQuery = `
    SELECT
      MIN(physical_size) AS min_size,
      MAX(physical_size) AS max_size
    FROM files
    ${whereClause}
  `;
  const sizeResult = await db.pg.query(sizeQuery, params);
  const sizeRow = sizeResult.rows[0] as
    | { min_size: string | null; max_size: string | null }
    | undefined;

  // Date range
  const dateQuery = `
    SELECT
      MIN(mtime) AS min_mtime,
      MAX(mtime) AS max_mtime
    FROM files
    ${whereClause}
  `;
  const dateResult = await db.pg.query(dateQuery, params);
  const dateRow = dateResult.rows[0] as
    | { min_mtime: string | null; max_mtime: string | null }
    | undefined;

  const lines: string[] = [];

  // File types line
  if (typeRows.length > 0) {
    const totalFiles = typeRows.reduce((sum, r) => sum + Number(r.cnt), 0);
    const topTypes = typeRows.slice(0, 6).map(r => {
      const pct = Math.round((Number(r.cnt) / totalFiles) * 100);
      return `${pct}% ${r.ext}`;
    });
    lines.push(`File types: ${topTypes.join(', ')}`);
  } else {
    lines.push('File types: (no files)');
  }

  // Size range line
  if (sizeRow?.min_size != null && sizeRow?.max_size != null) {
    const minSize = Number(sizeRow.min_size);
    const maxSize = Number(sizeRow.max_size);
    lines.push(`Size range: ${formatBytes(minSize)} – ${formatBytes(maxSize)}`);
  } else {
    lines.push('Size range: (no files)');
  }

  // Date range line
  if (dateRow?.min_mtime != null && dateRow?.max_mtime != null) {
    const minDate = formatDate(Number(dateRow.min_mtime));
    const maxDate = formatDate(Number(dateRow.max_mtime));
    lines.push(`Date range: ${minDate} – ${maxDate}`);
  } else {
    lines.push('Date range: (no files)');
  }

  return lines.join('\n');
}

/**
 * Format a Unix timestamp (seconds) as YYYY-MM-DD.
 */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// === Prompt Assembly ===

/**
 * Build the full user prompt by combining the tree string and stats block.
 *
 * @param treeString - The formatted directory tree
 * @param statsBlock - The formatted statistics block
 * @returns The complete user prompt
 */
export function buildPrompt(treeString: string, statsBlock: string): string {
  return `What is this directory about?\n\n${treeString}\n\n${statsBlock}`;
}
