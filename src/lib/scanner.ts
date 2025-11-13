/**
 * Scanner Library - Core File Scanning Functionality
 *
 * Streaming file scanner inspired by ArchiScan's proven architecture.
 * Single-pass RxJS pipeline that discovers, ingests, and analyzes files in real-time.
 *
 * Flow: Clean → Stream(Discover+Ingest) → Duplicate Detection
 */

import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Observable, from } from 'rxjs';
import {
  tap,
  map,
  bufferCount,
  concatMap,
  finalize,
  switchMap,
  last,
  catchError,
} from 'rxjs/operators';
import { eq, and, count, gt } from 'drizzle-orm';
import { logger } from '@lib/logging.ts';
import {
  cleanDatabase,
  insertFileBatch,
  type DatabaseConnection,
  type FileRow,
  files,
} from '@lib/database.ts';

// Types
export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  isDirectory: boolean;
  isHidden: boolean;
  isSystem: boolean;
}

export interface ScanConfig {
  rootPath: string;
  runId: string;
  includeHidden?: boolean; // Legacy parameter - all files are now cataloged with metadata flags
  batchSize?: number;
}

export interface ScanResult {
  phase: 'complete';
  filesDiscovered: number;
  filesIngested: number;
  duplicateGroups: number;
}

/**
 * Main scanning function - consolidated streaming approach like ArchiScan
 */
export function scanDirectory(
  connection: DatabaseConnection,
  config: ScanConfig,
  progressCallback?: (status: string) => void
): Observable<ScanResult> {
  let filesDiscovered = 0;
  let filesIngested = 0;
  let duplicateGroups = 0;

  // Phase 1: Clean database first (hot observable, no defer)
  return cleanDatabase(connection, config.runId).pipe(
    tap(() => logger.debug('Database cleaned', { runId: config.runId })),

    // Phase 2-3: Streaming discovery + immediate ingestion (hot observable)
    switchMap(() =>
      from(walkFilesGenerator(config.rootPath, config.includeHidden)).pipe(
        tap(entry => {
          filesDiscovered++;
          logger.debug('File discovered', {
            count: filesDiscovered,
            path: entry.path,
            runId: config.runId,
          });

          // Live progress updates every 100 files or first file
          if (filesDiscovered % 100 === 0 || filesDiscovered === 1) {
            logger.debug('Calling progress callback', {
              filesDiscovered,
              runId: config.runId,
            });
            progressCallback?.(`found ${filesDiscovered.toLocaleString()} files`);
          }
        }),

        // Convert to database row format
        map(entry => toFileRow(config.runId, entry)),

        // Batch for efficient database writes
        bufferCount(config.batchSize || 1000),

        // Insert batches immediately - no phase waiting
        concatMap(batch =>
          insertFileBatch(connection, batch).pipe(
            tap(inserted => {
              filesIngested += inserted;
              logger.debug('Batch insertion completed', {
                inserted,
                totalIngested: filesIngested,
                runId: config.runId,
              });
              if (filesIngested % 1000 === 0) {
                logger.debug('Calling ingestion progress callback', {
                  filesIngested,
                  runId: config.runId,
                });
                progressCallback?.(`ingested ${filesIngested.toLocaleString()} files`);
              }
            }),
            catchError(error => {
              logger.error('Failed to insert batch', error as Error, {
                runId: config.runId,
                batchSize: batch.length,
              });
              return from([0]); // Continue processing
            })
          )
        ),

        // Final ingestion update
        finalize(() => {
          logger.debug('File ingestion completed', {
            runId: config.runId,
            filesDiscovered,
            filesIngested,
          });
          progressCallback?.(`ingested ${filesIngested.toLocaleString()} files`);
        })
      )
    ),

    // Phase 4: Prefilter after ingestion completes
    last(), // Wait for ingestion to complete
    switchMap(() => findDuplicateSizes(connection, config.runId)),
    tap(duplicateSizeGroups => {
      duplicateGroups = duplicateSizeGroups.length;
      logger.debug('Prefilter found duplicate groups', {
        duplicateGroups,
        runId: config.runId,
      });
      progressCallback?.(`found ${duplicateGroups} potential duplicate groups`);
      logger.debug('Prefilter completed', {
        runId: config.runId,
        duplicateGroups,
      });
    }),
    map(() => ({
      phase: 'complete' as const,
      filesDiscovered,
      filesIngested,
      duplicateGroups,
    })),

    catchError(error => {
      logger.error('Scan pipeline failed', error as Error, { runId: config.runId });
      throw error;
    })
  );
}

/**
 * Check if a file/directory is hidden (starts with dot)
 */
function isHiddenFile(name: string): boolean {
  return name.startsWith('.');
}

/**
 * Check if a file is a system file (platform-specific)
 */
function isSystemFile(fullPath: string, name: string): boolean {
  // Platform-specific system file detection
  if (process.platform === 'win32') {
    return (
      /^(desktop\.ini|thumbs\.db|ntuser\.dat|pagefile\.sys|hiberfil\.sys)$/i.test(name) ||
      /\\(System Volume Information|\\$Recycle\.Bin|Recovery)\\/.test(fullPath)
    );
  }

  // Unix-like systems (Linux, macOS)
  return (
    /\/(proc|sys|dev)\//.test(fullPath) ||
    /\.(DS_Store|localized|Spotlight-V100|fseventsd|Trashes)$/.test(name) ||
    fullPath.includes('/.Trash/') ||
    fullPath.includes('/lost+found/')
  );
}

/**
 * Check if a path should be completely skipped for safety/performance
 */
function isDangerousPath(fullPath: string): boolean {
  // Only skip virtual filesystems that could hang or cause issues
  if (process.platform !== 'win32') {
    return /^\/proc\/|^\/sys\/|^\/dev\//.test(fullPath);
  }
  return false;
}

/**
 * Simple file walker like ArchiScan - stack-based approach (not recursive)
 * Yields files immediately as discovered for streaming processing
 * Catalogs ALL files with metadata flags for flexible filtering later
 */
async function* walkFilesGenerator(
  rootPath: string,
  _includeHidden = false
): AsyncGenerator<FileEntry> {
  const stack: string[] = [rootPath];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;

    try {
      const entries = await fsp.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        // Only skip truly dangerous paths (virtual filesystems, etc.)
        if (isDangerousPath(fullPath)) {
          logger.debug('Skipping dangerous path', { path: fullPath });
          continue;
        }

        const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
        const isHidden = isHiddenFile(entry.name);
        const isSystem = isSystemFile(fullPath, entry.name);

        if (entry.isDirectory()) {
          // Add directory to stack for processing
          stack.push(fullPath);

          // Yield directory for complete inventory with metadata
          yield {
            path: relativePath,
            size: 0,
            mtime: 0,
            isDirectory: true,
            isHidden,
            isSystem,
          };
        } else if (entry.isFile()) {
          try {
            const stats = await fsp.stat(fullPath);

            // Yield file immediately with metadata for flexible filtering
            yield {
              path: relativePath,
              size: stats.size,
              mtime: Math.floor(stats.mtimeMs / 1000),
              isDirectory: false,
              isHidden,
              isSystem,
            };
          } catch (error) {
            logger.warn('Cannot access file', {
              path: fullPath,
              error: (error as Error).message,
            });
          }
        }
      }
    } catch (error) {
      logger.warn('Cannot access directory', {
        path: currentDir,
        error: (error as Error).message,
      });
    }
  }
}

/**
 * Convert FileEntry to database row format
 */
function toFileRow(runId: string, entry: FileEntry): FileRow {
  return {
    run_id: runId,
    path: entry.path,
    size: entry.size,
    mtime: entry.mtime,
    is_directory: entry.isDirectory,
    is_hidden: entry.isHidden,
    is_system: entry.isSystem,
    hash: null, // Hash calculated later if needed
  };
}

/**
 * Find file sizes that have multiple files (potential duplicates)
 * Only considers actual FILES, not directories
 */
function findDuplicateSizes(connection: DatabaseConnection, runId: string): Observable<number[]> {
  return from(
    connection.db
      .select({
        size: files.size,
        fileCount: count(),
      })
      .from(files)
      .where(
        and(
          eq(files.run_id, runId),
          eq(files.is_directory, false) // Only files, exclude directories
        )
      )
      .groupBy(files.size)
      .having(gt(count(), 1)) // Only sizes with more than 1 file
  ).pipe(
    map(
      results => results.map(r => r.size).sort((a, b) => b - a) // Sort by size descending (largest files first)
    ),
    catchError(error => {
      logger.error('Failed to find duplicate sizes', error as Error, { runId });
      return from([[]]);
    })
  );
}

/**
 * Generate unique run ID
 */
export function generateRunId(): string {
  return `scan-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Validate scan path exists and is accessible
 */
export async function validateScanPath(targetPath: string): Promise<{
  valid: boolean;
  error?: string;
  resolvedPath?: string;
}> {
  try {
    const resolvedPath = path.resolve(targetPath);
    const stats = await fsp.stat(resolvedPath);

    if (!stats.isDirectory()) {
      return { valid: false, error: 'Path is not a directory' };
    }

    await fsp.access(resolvedPath);

    return { valid: true, resolvedPath };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
