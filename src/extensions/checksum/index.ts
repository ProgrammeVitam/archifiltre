/**
 * Checksum Extension
 *
 * Computes checksums (MD5, SHA-256, SHA-512, xxHash64) for scanned files.
 * Stores checksums in a separate table that can be joined by other extensions.
 *
 * Archive Support:
 * - Processes both regular filesystem files and files inside archives
 * - Uses shared file-reader abstraction for transparent archive content access
 * - Archive entries are extracted on-demand during checksum computation
 *
 * Optimized to leverage xxHash64 duplicate detection:
 * - For duplicate groups (same content_size + same xxHash64), calculates checksum once
 *   and propagates to all files in the group
 * - For unique files, calculates checksum individually
 * - Use --each-file flag to disable optimization and calculate every file independently
 *
 * Special xxHash64 optimization:
 * - Files that already have xxHash64 from duplicate detection get it copied directly
 * - Only files without existing xxHash64 need actual computation
 *
 * Uses RxJS streaming to handle large datasets efficiently.
 */

import { Command, Flags, ux } from '@oclif/core';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Observable, defer, from, EMPTY, of, concat } from 'rxjs';
import {
  concatMap,
  map,
  tap,
  catchError,
  toArray,
  mergeMap,
  defaultIfEmpty,
  switchMap,
} from 'rxjs/operators';
import { eq, and, gt, sql, isNull, isNotNull } from 'drizzle-orm';
import { setupOclifContext, logger } from '@lib/logging.ts';
import {
  createScanDatabase,
  closeScanDatabase,
  getLatestRunId,
  getScanMetadata,
  files,
  type DatabaseConnection,
} from '@lib/database.ts';
import { createFileContentStream, type FileEntry } from '@lib/file-reader.ts';
import { SUPPORTED_ALGORITHMS, type ChecksumAlgorithm } from './schema.ts';

// Re-export schema for other extensions to use
export { fileChecksums, SUPPORTED_ALGORITHMS, type ChecksumAlgorithm } from './schema.ts';
export type { FileChecksumRow } from './schema.ts';

// === Types ===

/**
 * Represents a file entry with archive metadata for checksum processing
 */
interface ChecksumFileEntry {
  path: string;
  archiveParentPath: string | null;
  archiveFormat: string | null;
}

/**
 * Represents a group of duplicate files (same content_size + same xxHash64)
 */
interface DuplicateGroup {
  contentSize: number;
  hash: string;
  paths: string[];
  representativePath: string; // The file we'll actually read and hash
  representativeArchiveParentPath: string | null;
  representativeArchiveFormat: string | null;
}

/**
 * Progress tracking for checksum computation
 */
interface ChecksumProgress {
  processed: number;
  total: number;
  duplicateGroups: number;
  uniqueFiles: number;
  filesSkipped: number;
}

// === Table Initialization ===

/**
 * Ensure file_checksums table exists
 */
async function ensureChecksumTable(connection: DatabaseConnection): Promise<void> {
  await connection.pg.exec(`
    CREATE TABLE IF NOT EXISTS file_checksums (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      md5 TEXT,
      sha256 TEXT,
      sha512 TEXT,
      xxhash64 TEXT,
      PRIMARY KEY (run_id, path)
    )
  `);
  await connection.pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_file_checksums_run_id ON file_checksums (run_id)
  `);
  // Add xxhash64 column if it doesn't exist (for existing databases)
  await connection.pg
    .exec(
      `
    ALTER TABLE file_checksums ADD COLUMN IF NOT EXISTS xxhash64 TEXT
  `
    )
    .catch(() => {
      // Column might already exist, ignore error
    });
}

// === Checksum Computation ===

/**
 * Compute checksum from a readable stream using specified algorithm
 */
function computeChecksumFromStream(
  stream: Readable,
  algorithm: ChecksumAlgorithm
): Observable<string> {
  return new Observable<string>(subscriber => {
    if (algorithm === 'xxhash64') {
      // For xxHash64, collect all chunks and hash at once using Bun's native implementation
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const hash = Bun.hash(buffer, 'xxhash64' as unknown as undefined);
        subscriber.next(hash.toString(16).padStart(16, '0'));
        subscriber.complete();
      });
      stream.on('error', err => subscriber.error(err));
    } else {
      // Cryptographic hashes use Node's crypto module with streaming
      const hash = createHash(algorithm);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => {
        subscriber.next(hash.digest('hex'));
        subscriber.complete();
      });
      stream.on('error', err => subscriber.error(err));
    }
  });
}

/**
 * Compute checksum of a file using specified algorithm.
 * Supports both regular filesystem files and archive entries.
 */
function computeFileChecksum(
  rootPath: string,
  entry: FileEntry,
  algorithm: ChecksumAlgorithm
): Observable<string> {
  return createFileContentStream(rootPath, entry).pipe(
    switchMap(stream => computeChecksumFromStream(stream, algorithm)),
    catchError(err => {
      logger.debug('Failed to read file for checksum', {
        path: entry.path,
        archiveParentPath: entry.archiveParentPath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    })
  );
}

// === Duplicate Group Retrieval ===

/**
 * Get duplicate groups - files grouped by (content_size, hash) where hash is xxHash64
 * These are true duplicates that can share the same checksum
 */
function getDuplicateGroups(
  connection: DatabaseConnection,
  runId: string
): Observable<DuplicateGroup[]> {
  return defer(() => {
    logger.debug('Finding duplicate groups for checksum optimization (including archive entries)', {
      runId,
    });

    // Get distinct (content_size, hash) pairs that have duplicates
    // Include archive entries by removing the archive_parent_path IS NULL filter
    // Use PostgreSQL json_agg and json_build_object to collect paths and archive metadata
    const queryStr = `
      SELECT
        content_size,
        hash,
        json_agg(json_build_object(
          'path', path,
          'archive_parent_path', archive_parent_path,
          'archive_format', archive_format
        )) as file_entries
      FROM files
      WHERE run_id = $1
        AND is_directory = false
        AND hash IS NOT NULL
        AND content_size IS NOT NULL
      GROUP BY content_size, hash
      HAVING COUNT(*) > 1
      ORDER BY content_size DESC
    `;

    // Define the entry type for type safety
    type FileEntryRecord = {
      path: string;
      archive_parent_path: string | null;
      archive_format: string | null;
    };

    return from(
      connection.pg.query<{
        content_size: number;
        hash: string;
        // PGLite may return json_agg as already-parsed array or as JSON string
        file_entries: string | FileEntryRecord[];
      }>(queryStr, [runId])
    ).pipe(
      map(result => {
        const groups: DuplicateGroup[] = result.rows.map(row => {
          // Handle both cases: PGLite returns json_agg as already-parsed array,
          // but some drivers return it as a JSON string
          const entries: FileEntryRecord[] =
            typeof row.file_entries === 'string' ? JSON.parse(row.file_entries) : row.file_entries;
          const paths = entries.map(e => e.path);

          // Pick first entry as representative (prefer non-archive entries if available)
          const representative = entries.find(e => !e.archive_parent_path) || entries[0];

          return {
            contentSize: row.content_size,
            hash: row.hash,
            paths,
            representativePath: representative.path,
            representativeArchiveParentPath: representative.archive_parent_path,
            representativeArchiveFormat: representative.archive_format,
          };
        });

        logger.debug('Found duplicate groups', {
          groupCount: groups.length,
          totalFiles: groups.reduce((sum, g) => sum + g.paths.length, 0),
        });

        return groups;
      }),
      catchError(error => {
        logger.error('Failed to get duplicate groups', error as Error, { runId });
        return of([]);
      })
    );
  });
}

/**
 * Get unique files - files without xxHash64 (unique content_size)
 * These need individual checksum calculation
 * Includes archive entries
 */
function getUniqueFiles(
  connection: DatabaseConnection,
  runId: string,
  batchSize: number = 5000
): Observable<ChecksumFileEntry[]> {
  return defer(() => {
    logger.debug('Finding unique files for checksum (including archive entries)', {
      runId,
      batchSize,
    });

    const fetchBatch = (lastPath: string | null): Observable<ChecksumFileEntry[]> => {
      // Get files that don't have xxHash64 (unique content_size)
      // Include archive entries by removing the archive_parent_path IS NULL filter
      const queryPromise = lastPath
        ? connection.db
            .select({
              path: files.path,
              archiveParentPath: files.archive_parent_path,
              archiveFormat: files.archive_format,
            })
            .from(files)
            .where(
              and(
                eq(files.run_id, runId),
                eq(files.is_directory, false),
                isNull(files.hash), // No xxHash64 means unique content_size
                gt(files.path, lastPath)
              )
            )
            .orderBy(files.path)
            .limit(batchSize)
        : connection.db
            .select({
              path: files.path,
              archiveParentPath: files.archive_parent_path,
              archiveFormat: files.archive_format,
            })
            .from(files)
            .where(and(eq(files.run_id, runId), eq(files.is_directory, false), isNull(files.hash)))
            .orderBy(files.path)
            .limit(batchSize);

      return from(queryPromise).pipe(
        concatMap(batch => {
          if (batch.length === 0) {
            return EMPTY;
          }

          const newLastPath = batch[batch.length - 1].path;
          logger.debug('Retrieved unique files batch', {
            runId,
            batchSize: batch.length,
            lastPath: newLastPath,
          });

          return concat(of(batch), fetchBatch(newLastPath));
        }),
        catchError(error => {
          logger.error('Failed to fetch unique files', error as Error, { runId });
          return EMPTY;
        })
      );
    };

    return fetchBatch(null);
  });
}

/**
 * Get ALL files (for --each-file mode, no optimization)
 * Includes archive entries
 */
function getAllFiles(
  connection: DatabaseConnection,
  runId: string,
  batchSize: number = 5000
): Observable<ChecksumFileEntry[]> {
  return defer(() => {
    logger.debug('Finding all files for checksum (--each-file mode, including archive entries)', {
      runId,
      batchSize,
    });

    const fetchBatch = (lastPath: string | null): Observable<ChecksumFileEntry[]> => {
      // Include archive entries by removing the archive_parent_path IS NULL filter
      const queryPromise = lastPath
        ? connection.db
            .select({
              path: files.path,
              archiveParentPath: files.archive_parent_path,
              archiveFormat: files.archive_format,
            })
            .from(files)
            .where(
              and(eq(files.run_id, runId), eq(files.is_directory, false), gt(files.path, lastPath))
            )
            .orderBy(files.path)
            .limit(batchSize)
        : connection.db
            .select({
              path: files.path,
              archiveParentPath: files.archive_parent_path,
              archiveFormat: files.archive_format,
            })
            .from(files)
            .where(and(eq(files.run_id, runId), eq(files.is_directory, false)))
            .orderBy(files.path)
            .limit(batchSize);

      return from(queryPromise).pipe(
        concatMap(batch => {
          if (batch.length === 0) {
            return EMPTY;
          }

          const newLastPath = batch[batch.length - 1].path;
          return concat(of(batch), fetchBatch(newLastPath));
        }),
        catchError(error => {
          logger.error('Failed to fetch files', error as Error, { runId });
          return EMPTY;
        })
      );
    };

    return fetchBatch(null);
  });
}

// === Checksum Storage ===

/**
 * Upsert a batch of checksums
 */
function upsertChecksumBatch(
  connection: DatabaseConnection,
  runId: string,
  algorithm: ChecksumAlgorithm,
  checksums: Array<{ path: string; checksum: string }>
): Observable<number> {
  if (checksums.length === 0) {
    return of(0);
  }

  return defer(() => {
    // Build batch upsert - escape single quotes properly
    const values = checksums
      .map(c => `('${runId}', '${c.path.replace(/'/g, "''")}', '${c.checksum}')`)
      .join(',\n');

    const query = `
      INSERT INTO file_checksums (run_id, path, ${algorithm})
      VALUES ${values}
      ON CONFLICT (run_id, path) DO UPDATE SET ${algorithm} = EXCLUDED.${algorithm}
    `;

    return from(connection.pg.exec(query)).pipe(
      map(() => checksums.length),
      catchError(error => {
        logger.error('Failed to upsert checksum batch', error as Error, {
          runId,
          algorithm,
          count: checksums.length,
        });
        return of(0);
      })
    );
  });
}

// === xxHash64 Special Processing ===

/**
 * Copy existing xxHash64 values from files.hash to file_checksums.xxhash64
 * This is much faster than recalculating since the hash already exists
 */
function copyExistingXxHash64(
  connection: DatabaseConnection,
  runId: string,
  onProgress: (processed: number) => void
): Observable<number> {
  return defer(() => {
    logger.debug('Copying existing xxHash64 values from files table', { runId });

    // Use a single INSERT...SELECT to copy all existing hashes
    // Includes archive entries (no archive_parent_path filter)
    const query = `
      INSERT INTO file_checksums (run_id, path, xxhash64)
      SELECT run_id, path, hash
      FROM files
      WHERE run_id = '${runId.replace(/'/g, "''")}'
        AND is_directory = false
        AND hash IS NOT NULL
      ON CONFLICT (run_id, path) DO UPDATE SET xxhash64 = EXCLUDED.xxhash64
    `;

    return from(connection.pg.exec(query)).pipe(
      switchMap(() => {
        // Count how many were copied (includes archive entries)
        return from(
          connection.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(files)
            .where(
              and(eq(files.run_id, runId), eq(files.is_directory, false), isNotNull(files.hash))
            )
        );
      }),
      map(result => {
        const count = Number(result[0]?.count ?? 0);
        onProgress(count);
        logger.debug('Copied existing xxHash64 values', { count });
        return count;
      }),
      catchError(error => {
        logger.error('Failed to copy existing xxHash64 values', error as Error, { runId });
        return of(0);
      })
    );
  });
}

/**
 * Calculate xxHash64 for files that don't have it (unique content_size files)
 * Supports both regular filesystem files and archive entries
 */
function calculateMissingXxHash64(
  database: DatabaseConnection,
  runId: string,
  rootPath: string,
  options: { batchSize: number; concurrency: number },
  onProgress: (processed: number, errors: number) => void
): Observable<{ processed: number; errors: number }> {
  const { batchSize, concurrency } = options;

  let totalProcessed = 0;
  let totalErrors = 0;

  // Get files without hash (unique content_size, includes archive entries)
  return getUniqueFiles(database, runId, batchSize).pipe(
    concatMap(batch => {
      return from(batch).pipe(
        mergeMap(file => {
          // Use shared file-reader for archive-aware access
          const entry: FileEntry = {
            path: file.path,
            archiveParentPath: file.archiveParentPath,
            archiveFormat: file.archiveFormat,
          };

          return computeFileChecksum(rootPath, entry, 'xxhash64').pipe(
            map(checksum => ({ path: file.path, checksum })),
            catchError(error => {
              logger.debug('Skipping file for xxHash64 due to error', {
                path: file.path,
                archiveParentPath: file.archiveParentPath,
                error: String(error),
              });
              totalErrors++;
              onProgress(totalProcessed, totalErrors);
              return EMPTY;
            })
          );
        }, concurrency),
        toArray(),
        concatMap(checksums => upsertChecksumBatch(database, runId, 'xxhash64', checksums)),
        tap(count => {
          totalProcessed += count;
          onProgress(totalProcessed, totalErrors);
        })
      );
    }),
    toArray(),
    map(() => ({ processed: totalProcessed, errors: totalErrors })),
    defaultIfEmpty({ processed: 0, errors: 0 })
  );
}

/**
 * Optimized xxHash64 processing:
 * 1. Copy existing xxHash64 from files.hash (files with duplicate content_size)
 * 2. Calculate xxHash64 only for files without it (unique content_size)
 */
function computeXxHash64Optimized(
  database: DatabaseConnection,
  runId: string,
  rootPath: string,
  options: { batchSize: number; concurrency: number },
  progress: ChecksumProgress
): Observable<ChecksumProgress> {
  return defer(() => {
    logger.debug('Using optimized xxHash64 processing');

    // First, copy existing hashes
    return copyExistingXxHash64(database, runId, copied => {
      progress.processed = copied;
    }).pipe(
      switchMap(copiedCount => {
        // Then calculate for files without hash
        return calculateMissingXxHash64(database, runId, rootPath, options, (processed, errors) => {
          progress.processed = copiedCount + processed;
          progress.filesSkipped = errors;
        });
      }),
      map(result => {
        progress.filesSkipped = result.errors;
        return progress;
      })
    );
  });
}

// === Main Checksum Pipeline ===

export interface ChecksumOptions {
  algorithm: ChecksumAlgorithm;
  batchSize?: number;
  concurrency?: number;
  eachFile?: boolean; // If true, calculate for every file individually (no optimization)
}

/**
 * Process duplicate groups - calculate checksum once per group, propagate to all files
 */
function processDuplicateGroups(
  database: DatabaseConnection,
  runId: string,
  rootPath: string,
  groups: DuplicateGroup[],
  algorithm: ChecksumAlgorithm,
  concurrency: number,
  onProgress: (processed: number, errors: number) => void
): Observable<{ processed: number; errors: number }> {
  if (groups.length === 0) {
    return of({ processed: 0, errors: 0 });
  }

  let totalProcessed = 0;
  let totalErrors = 0;

  return from(groups).pipe(
    // Process groups with concurrency limit
    mergeMap(group => {
      // Use shared file-reader for archive-aware access
      const entry: FileEntry = {
        path: group.representativePath,
        archiveParentPath: group.representativeArchiveParentPath,
        archiveFormat: group.representativeArchiveFormat,
      };

      return computeFileChecksum(rootPath, entry, algorithm).pipe(
        // On success, create checksum entries for ALL files in the group
        switchMap(checksum => {
          const checksumEntries = group.paths.map(p => ({ path: p, checksum }));
          return upsertChecksumBatch(database, runId, algorithm, checksumEntries).pipe(
            map(count => {
              totalProcessed += count;
              onProgress(totalProcessed, totalErrors);
              return { processed: count, errors: 0 };
            })
          );
        }),
        catchError(error => {
          logger.debug('Failed to checksum duplicate group', {
            representativePath: group.representativePath,
            archiveParentPath: group.representativeArchiveParentPath,
            groupSize: group.paths.length,
            error: String(error),
          });
          totalErrors += group.paths.length;
          onProgress(totalProcessed, totalErrors);
          return of({ processed: 0, errors: group.paths.length });
        })
      );
    }, concurrency),
    // Collect final results
    toArray(),
    map(results => ({
      processed: results.reduce((sum, r) => sum + r.processed, 0),
      errors: results.reduce((sum, r) => sum + r.errors, 0),
    }))
  );
}

/**
 * Process unique files - calculate checksum individually for each file
 * Supports both regular filesystem files and archive entries
 */
function processUniqueFiles(
  database: DatabaseConnection,
  runId: string,
  rootPath: string,
  options: { algorithm: ChecksumAlgorithm; batchSize: number; concurrency: number },
  onProgress: (processed: number, errors: number) => void
): Observable<{ processed: number; errors: number }> {
  const { algorithm, batchSize, concurrency } = options;

  let totalProcessed = 0;
  let totalErrors = 0;

  return getUniqueFiles(database, runId, batchSize).pipe(
    concatMap(batch => {
      return from(batch).pipe(
        mergeMap(file => {
          // Use shared file-reader for archive-aware access
          const entry: FileEntry = {
            path: file.path,
            archiveParentPath: file.archiveParentPath,
            archiveFormat: file.archiveFormat,
          };

          return computeFileChecksum(rootPath, entry, algorithm).pipe(
            map(checksum => ({ path: file.path, checksum })),
            catchError(error => {
              logger.debug('Skipping unique file due to error', {
                path: file.path,
                archiveParentPath: file.archiveParentPath,
                error: String(error),
              });
              totalErrors++;
              onProgress(totalProcessed, totalErrors);
              return EMPTY;
            })
          );
        }, concurrency),
        toArray(),
        concatMap(checksums => upsertChecksumBatch(database, runId, algorithm, checksums)),
        tap(count => {
          totalProcessed += count;
          onProgress(totalProcessed, totalErrors);
        })
      );
    }),
    toArray(),
    map(() => ({ processed: totalProcessed, errors: totalErrors })),
    defaultIfEmpty({ processed: 0, errors: 0 })
  );
}

/**
 * Process ALL files without optimization (--each-file mode)
 * Supports both regular filesystem files and archive entries
 */
function processAllFiles(
  database: DatabaseConnection,
  runId: string,
  rootPath: string,
  options: { algorithm: ChecksumAlgorithm; batchSize: number; concurrency: number },
  onProgress: (processed: number, errors: number) => void
): Observable<{ processed: number; errors: number }> {
  const { algorithm, batchSize, concurrency } = options;

  let totalProcessed = 0;
  let totalErrors = 0;

  return getAllFiles(database, runId, batchSize).pipe(
    concatMap(batch => {
      return from(batch).pipe(
        mergeMap(file => {
          // Use shared file-reader for archive-aware access
          const entry: FileEntry = {
            path: file.path,
            archiveParentPath: file.archiveParentPath,
            archiveFormat: file.archiveFormat,
          };

          return computeFileChecksum(rootPath, entry, algorithm).pipe(
            map(checksum => ({ path: file.path, checksum })),
            catchError(error => {
              logger.debug('Skipping file due to error', {
                path: file.path,
                archiveParentPath: file.archiveParentPath,
                error: String(error),
              });
              totalErrors++;
              onProgress(totalProcessed, totalErrors);
              return EMPTY;
            })
          );
        }, concurrency),
        toArray(),
        concatMap(checksums => upsertChecksumBatch(database, runId, algorithm, checksums)),
        tap(count => {
          totalProcessed += count;
          onProgress(totalProcessed, totalErrors);
        })
      );
    }),
    toArray(),
    map(() => ({ processed: totalProcessed, errors: totalErrors })),
    defaultIfEmpty({ processed: 0, errors: 0 })
  );
}

/**
 * Compute checksums for all files in a scan run.
 *
 * By default, optimizes using xxHash64 duplicate detection:
 * - For duplicate groups (same content_size + hash), computes checksum once and propagates
 * - For unique files, computes checksum individually
 *
 * With options.eachFile = true, computes checksum for every file independently.
 *
 * @returns Observable that emits progress updates and completes with total count
 */
export function computeChecksums(
  database: DatabaseConnection,
  runId: string,
  rootPath: string,
  options: ChecksumOptions
): Observable<ChecksumProgress> {
  const { algorithm, batchSize = 5000, concurrency = 4, eachFile = false } = options;

  return defer(() => {
    logger.info('Checksum computation started', {
      runId,
      algorithm,
      batchSize,
      concurrency,
      optimized: !eachFile,
    });

    const progress: ChecksumProgress = {
      processed: 0,
      total: 0,
      duplicateGroups: 0,
      uniqueFiles: 0,
      filesSkipped: 0,
    };

    // --each-file mode: process every file individually
    if (eachFile) {
      logger.debug('Using --each-file mode: processing every file individually');

      // Get total count first
      // Count includes archive entries (no archive_parent_path filter)
      return from(
        database.db
          .select({ count: sql<number>`COUNT(*)` })
          .from(files)
          .where(and(eq(files.run_id, runId), eq(files.is_directory, false)))
      ).pipe(
        switchMap(result => {
          progress.total = Number(result[0]?.count ?? 0);
          progress.uniqueFiles = progress.total;

          return processAllFiles(
            database,
            runId,
            rootPath,
            { algorithm, batchSize, concurrency },
            (processed, errors) => {
              progress.processed = processed;
              progress.filesSkipped = errors;
            }
          );
        }),
        map(() => progress)
      );
    }

    // Special optimized mode for xxHash64: copy existing + calculate missing
    if (algorithm === 'xxhash64') {
      logger.debug('Using xxHash64 optimized mode: copy existing + calculate missing');

      // Get counts for progress tracking
      // Count includes archive entries (no archive_parent_path filter)
      return from(
        Promise.all([
          // Files with existing hash
          database.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(files)
            .where(
              and(eq(files.run_id, runId), eq(files.is_directory, false), isNotNull(files.hash))
            ),
          // Files without hash
          database.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(files)
            .where(and(eq(files.run_id, runId), eq(files.is_directory, false), isNull(files.hash))),
        ])
      ).pipe(
        switchMap(([withHash, withoutHash]) => {
          const filesWithHash = Number(withHash[0]?.count ?? 0);
          const filesWithoutHash = Number(withoutHash[0]?.count ?? 0);

          progress.total = filesWithHash + filesWithoutHash;
          progress.duplicateGroups = 0; // Not applicable for xxhash64 mode
          progress.uniqueFiles = filesWithoutHash;

          logger.debug('xxHash64 processing stats', {
            total: progress.total,
            existingHashes: filesWithHash,
            needsCalculation: filesWithoutHash,
          });

          return computeXxHash64Optimized(
            database,
            runId,
            rootPath,
            { batchSize, concurrency },
            progress
          );
        }),
        catchError(error => {
          logger.error('xxHash64 computation failed', error as Error, { runId });
          throw error;
        })
      );
    }

    // Optimized mode for cryptographic hashes: leverage xxHash64 duplicate groups
    logger.debug('Using optimized mode: leveraging xxHash64 duplicate groups');

    return getDuplicateGroups(database, runId).pipe(
      switchMap(groups => {
        progress.duplicateGroups = groups.length;
        const filesInGroups = groups.reduce((sum, g) => sum + g.paths.length, 0);

        logger.debug('Duplicate groups analysis', {
          groups: groups.length,
          filesInGroups,
        });

        // Get count of unique files (includes archive entries)
        return from(
          database.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(files)
            .where(and(eq(files.run_id, runId), eq(files.is_directory, false), isNull(files.hash)))
        ).pipe(
          switchMap(result => {
            progress.uniqueFiles = Number(result[0]?.count ?? 0);
            progress.total = filesInGroups + progress.uniqueFiles;

            logger.debug('Total files to process', {
              total: progress.total,
              filesInDuplicateGroups: filesInGroups,
              uniqueFiles: progress.uniqueFiles,
              diskReadsRequired: groups.length + progress.uniqueFiles,
              diskReadsSaved: filesInGroups - groups.length,
            });

            // Process duplicate groups first
            return processDuplicateGroups(
              database,
              runId,
              rootPath,
              groups,
              algorithm,
              concurrency,
              (processed, errors) => {
                progress.processed = processed;
                progress.filesSkipped = errors;
              }
            ).pipe(
              // Then process unique files
              switchMap(groupResults => {
                const groupProcessed = groupResults.processed;

                return processUniqueFiles(
                  database,
                  runId,
                  rootPath,
                  { algorithm, batchSize, concurrency },
                  (processed, errors) => {
                    progress.processed = groupProcessed + processed;
                    progress.filesSkipped = groupResults.errors + errors;
                  }
                );
              })
            );
          })
        );
      }),
      map(() => progress),
      catchError(error => {
        logger.error('Checksum computation failed', error as Error, { runId });
        throw error;
      })
    );
  });
}

// === Statistics ===

/**
 * Get statistics about files for checksum calculation
 * Includes both regular filesystem files and archive entries
 */
async function getChecksumStats(
  connection: DatabaseConnection,
  runId: string
): Promise<{
  totalFiles: number;
  filesWithHash: number;
  filesWithoutHash: number;
  duplicateGroups: number;
  filesInDuplicateGroups: number;
}> {
  // Total files (includes archive entries)
  const totalResult = await connection.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(files)
    .where(and(eq(files.run_id, runId), eq(files.is_directory, false)));

  // Files with xxHash64 (part of duplicate groups, includes archive entries)
  const withHashResult = await connection.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(files)
    .where(and(eq(files.run_id, runId), eq(files.is_directory, false), isNotNull(files.hash)));

  // Count duplicate groups (includes archive entries)
  const groupsResult = await connection.pg.query<{ group_count: number }>(
    `SELECT COUNT(*) as group_count FROM (
      SELECT content_size, hash
      FROM files
      WHERE run_id = $1
        AND is_directory = false
        AND hash IS NOT NULL
      GROUP BY content_size, hash
      HAVING COUNT(*) > 1
    )`,
    [runId]
  );

  const totalFiles = Number(totalResult[0]?.count ?? 0);
  const filesWithHash = Number(withHashResult[0]?.count ?? 0);
  const duplicateGroups = Number(groupsResult.rows[0]?.group_count ?? 0);

  return {
    totalFiles,
    filesWithHash,
    filesWithoutHash: totalFiles - filesWithHash,
    duplicateGroups,
    filesInDuplicateGroups: filesWithHash,
  };
}

// === Command Declaration ===

/**
 * Checksum command - auto-registered via extension registry
 */
export const COMMAND = {
  name: 'checksum',
  command: class Checksum extends Command {
    static override description = 'Compute cryptographic checksums for scanned files';

    static override examples = [
      '<%= config.bin %> <%= command.id %>',
      '<%= config.bin %> <%= command.id %> --algorithm xxhash64',
      '<%= config.bin %> <%= command.id %> --algorithm md5',
      '<%= config.bin %> <%= command.id %> --algorithm sha256',
      '<%= config.bin %> <%= command.id %> --algorithm sha512',
      '<%= config.bin %> <%= command.id %> --each-file',
    ];

    static override flags = {
      algorithm: Flags.string({
        char: 'a',
        description: 'Checksum algorithm to use',
        options: SUPPORTED_ALGORITHMS,
        default: 'xxhash64',
      }),
      'each-file': Flags.boolean({
        description:
          'Calculate checksum for each file individually (disables duplicate optimization)',
        default: false,
      }),
    };

    async run(): Promise<void> {
      const { flags } = await this.parse(Checksum);
      const algorithm = flags.algorithm as ChecksumAlgorithm;
      const eachFile = flags['each-file'];

      const cleanupLogging = setupOclifContext(
        this as unknown as Parameters<typeof setupOclifContext>[0]
      );
      let database: DatabaseConnection | undefined;

      try {
        // Connect to database
        database = await createScanDatabase('main');

        // Ensure checksum table exists
        await ensureChecksumTable(database);

        // Get latest run_id
        ux.action.start('Finding latest scan');
        const runId = await getLatestRunId(database).toPromise();

        if (!runId) {
          ux.action.stop('failed');
          this.error(
            'No scans found in database. Run a scan first with: archifiltre scan <directory>',
            { exit: 1 }
          );
        }

        ux.action.stop(runId);

        // Get scan metadata to find root_path
        ux.action.start('Loading scan metadata');
        const metadata = await getScanMetadata(database, runId).toPromise();

        if (!metadata) {
          ux.action.stop('failed');
          this.error(
            'Scan metadata not found. This scan may have been created with an older version.',
            { exit: 1 }
          );
        }

        const rootPath = metadata.root_path;
        ux.action.stop(rootPath);

        // Get statistics
        const stats = await getChecksumStats(database, runId);

        this.log('');
        this.log(`Total files: ${stats.totalFiles.toLocaleString()}`);

        if (!eachFile) {
          if (algorithm === 'xxhash64') {
            // xxHash64 has special optimization - copies existing hashes
            this.log(
              `  - Files with existing xxHash64: ${stats.filesWithHash.toLocaleString()} (will be copied)`
            );
            this.log(`  - Files needing calculation: ${stats.filesWithoutHash.toLocaleString()}`);
            this.log('');
            this.log(
              `Disk reads required: ${stats.filesWithoutHash.toLocaleString()} ` +
                `(saving ${stats.filesWithHash.toLocaleString()} reads by copying existing hashes)`
            );
          } else {
            this.log(
              `  - Files in duplicate groups: ${stats.filesInDuplicateGroups.toLocaleString()}`
            );
            this.log(`  - Unique files: ${stats.filesWithoutHash.toLocaleString()}`);
            this.log(`  - Duplicate groups: ${stats.duplicateGroups.toLocaleString()}`);
            this.log('');
            this.log(
              `Disk reads required: ${(stats.duplicateGroups + stats.filesWithoutHash).toLocaleString()} ` +
                `(saving ${(stats.filesInDuplicateGroups - stats.duplicateGroups).toLocaleString()} reads)`
            );
          }
        }

        this.log('');
        this.log(
          `Computing ${algorithm.toUpperCase()} checksums${eachFile ? ' (--each-file mode)' : ' (optimized)'}...`
        );

        let lastProgress: ChecksumProgress = {
          processed: 0,
          total: stats.totalFiles,
          duplicateGroups: 0,
          uniqueFiles: 0,
          filesSkipped: 0,
        };

        await new Promise<void>((resolve, reject) => {
          if (!database) {
            reject(new Error('Database connection not available'));
            return;
          }

          computeChecksums(database, runId, rootPath, { algorithm, eachFile }).subscribe({
            next: progress => {
              lastProgress = progress;
              ux.action.start(
                `Computing ${algorithm.toUpperCase()} checksums`,
                `${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} files`
              );
            },
            complete: () => {
              ux.action.stop(`${lastProgress.processed.toLocaleString()} files`);
              resolve();
            },
            error: err => {
              ux.action.stop('failed');
              reject(err);
            },
          });
        });

        this.log('');
        this.log(
          `Checksum computation completed: ${lastProgress.processed.toLocaleString()} files processed`
        );

        if (lastProgress.filesSkipped > 0) {
          this.log(`  (${lastProgress.filesSkipped.toLocaleString()} files skipped due to errors)`);
        }

        logger.info('Checksum computation completed', {
          runId,
          algorithm,
          eachFile,
          totalProcessed: lastProgress.processed,
          filesSkipped: lastProgress.filesSkipped,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error('Checksum command failed', error instanceof Error ? error : undefined, {
          algorithm,
        });

        this.error(`Checksum computation failed: ${errorMessage}`, { exit: 1 });
      } finally {
        if (database) {
          await closeScanDatabase(database);
        }
        cleanupLogging();
      }
    }
  },
};
