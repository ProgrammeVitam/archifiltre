/**
 * Hash Calculator - Streaming xxHash64 Implementation
 *
 * Calculates xxhash64 hashes for files with duplicate content_size using streaming processing.
 * Uses bounded memory regardless of dataset size - critical for 10M+ file scans.
 *
 * Key design principles:
 * - Never load all file paths into memory (unlike Archiscan)
 * - Uses content_size for prefiltering (not physical_size)
 * - Pure RxJS Observable pipeline for integration
 * - Batch processing with controlled concurrency
 * - Database as source of truth for all operations
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { Observable, from, of, EMPTY, defer, range } from 'rxjs';
import {
  switchMap,
  mergeMap,
  concatMap,
  tap,
  map,
  filter,
  catchError,
  finalize,
  take,
  expand,
  scan,
  last,
} from 'rxjs/operators';
import { xxh64 } from '@node-rs/xxhash';
import { logger } from '@lib/logging.ts';
import type { DatabaseConnection } from '@lib/database.ts';
import { findDuplicateSizes, getFilesNeedingHash, updateFileHash, files } from '@lib/database.ts';
import { eq, and, count, isNull, inArray, sql } from 'drizzle-orm';

// Hash calculation configuration
export interface HashConfig {
  concurrency?: number;
  batchSize?: number;
  onProgress?: (processed: number, total: number, errors: number) => void;
}

// Hash calculation statistics
export interface HashStats {
  totalFiles: number;
  processed: number;
  errors: number;
  startTime: number;
  endTime?: number;
}

// Hash update item
export interface HashUpdate {
  path: string;
  hash: string;
}

/**
 * Default hashing configuration
 */
export const DEFAULT_HASH_CONFIG: Required<Omit<HashConfig, 'onProgress'>> = {
  concurrency: Math.max(2, (os.cpus()?.length ?? 4) - 1),
  batchSize: 100, // Small batches to keep memory bounded
};

/**
 * Calculate xxhash64 for a single file
 * Uses @node-rs/xxhash for optimal performance with buffer-based hashing
 */
async function calculateFileHash(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const hash = xxh64(buffer);
  // Convert BigInt to hex string with consistent 16-character padding
  return hash.toString(16).padStart(16, '0');
}

/**
 * Hash a single file with error handling
 */
function hashSingleFile(rootPath: string, relativePath: string): Observable<HashUpdate | null> {
  return defer(async () => {
    try {
      // Convert relative path to OS-specific path
      const osPath = relativePath.replace(/\//g, path.sep);
      const fullPath = path.join(rootPath, osPath);

      const hash = await calculateFileHash(fullPath);

      return {
        path: relativePath,
        hash: hash,
      };
    } catch (error) {
      logger.warn('Hash calculation failed', {
        path: relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null; // Signal failure but continue processing
    }
  }).pipe(
    catchError(error => {
      logger.warn('Hash calculation error', {
        path: relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return of(null);
    })
  );
}

/**
 * Get a batch of files that need hashing using streaming SQL
 * This avoids loading all file paths into memory
 */
function getFilesBatch(
  connection: DatabaseConnection,
  runId: string,
  duplicateSizes: number[],
  offset: number,
  batchSize: number
): Observable<string[]> {
  if (!duplicateSizes.length) return of([]);

  return defer(() => {
    return from(
      connection.db
        .select({ path: files.path })
        .from(files)
        .where(
          and(
            eq(files.run_id, runId),
            isNull(files.hash), // Only files that don't have hash yet
            inArray(files.content_size, duplicateSizes) // Only files with duplicate content_size
          )
        )
        .limit(batchSize)
        .offset(offset)
    ).pipe(
      map(results => results.map(r => r.path)),
      catchError(error => {
        logger.error('Failed to get files batch', error as Error, {
          runId,
          offset,
          batchSize,
        });
        return of([]);
      })
    );
  });
}

/**
 * Get total count of files that need hashing
 */
function getTotalFilesNeedingHash(
  connection: DatabaseConnection,
  runId: string,
  duplicateSizes: number[]
): Observable<number> {
  if (!duplicateSizes.length) return of(0);

  return defer(() => {
    return from(
      connection.db
        .select({ total: count() })
        .from(files)
        .where(
          and(
            eq(files.run_id, runId),
            isNull(files.hash),
            inArray(files.content_size, duplicateSizes)
          )
        )
    ).pipe(
      map(results => results[0]?.total || 0),
      catchError(error => {
        logger.error('Failed to get total files count', error as Error, {
          runId,
        });
        return of(0);
      })
    );
  });
}

/**
 * Update hash batch in database
 */
function updateHashBatch(
  connection: DatabaseConnection,
  runId: string,
  updates: HashUpdate[]
): Observable<number> {
  if (!updates.length) return of(0);

  return defer(() => {
    return from(
      connection.db.transaction(async tx => {
        let updated = 0;
        for (const update of updates) {
          try {
            await tx
              .update(files)
              .set({ hash: update.hash })
              .where(and(eq(files.run_id, runId), eq(files.path, update.path)));
            updated++;
          } catch (error) {
            logger.warn('Failed to update hash for file', {
              path: update.path,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return updated;
      })
    ).pipe(
      catchError(error => {
        logger.error('Hash batch update failed', error as Error, {
          runId,
          batchSize: updates.length,
        });
        return of(0);
      })
    );
  });
}

/**
 * Process a single batch of files for hashing
 */
function processBatch(
  connection: DatabaseConnection,
  runId: string,
  rootPath: string,
  filePaths: string[],
  concurrency: number
): Observable<number> {
  if (!filePaths.length) return of(0);

  return from(filePaths).pipe(
    mergeMap(relativePath => hashSingleFile(rootPath, relativePath), concurrency),
    filter((result): result is HashUpdate => result !== null),
    // Collect all hashes from this batch
    tap(update => {
      logger.debug('File hashed', {
        path: update.path,
        hash: update.hash,
      });
    }),
    // Convert to array for batch update
    map(update => [update]),
    // Reduce to single array
    scan((acc: HashUpdate[], updates: HashUpdate[]) => [...acc, ...updates], []),
    // Take the final accumulated result
    last(),
    // Update database with batch
    switchMap(updates =>
      updateHashBatch(connection, runId, updates).pipe(
        tap(updated => {
          logger.debug('Hash batch updated', {
            runId,
            updated,
            attempted: updates.length,
          });
        })
      )
    ),
    catchError(error => {
      logger.error('Batch processing failed', error as Error, {
        runId,
        batchSize: filePaths.length,
      });
      return of(0);
    })
  );
}

/**
 * Streaming hash calculation pipeline
 * Processes files in batches to maintain bounded memory usage
 */
export function calculateHashes(
  connection: DatabaseConnection,
  runId: string,
  rootPath: string,
  config: HashConfig = {}
): Observable<void> {
  const finalConfig = { ...DEFAULT_HASH_CONFIG, ...config };

  let stats: HashStats = {
    totalFiles: 0,
    processed: 0,
    errors: 0,
    startTime: Date.now(),
  };

  logger.debug('Starting hash calculation', { runId, rootPath });

  return findDuplicateSizes(connection, runId).pipe(
    tap(duplicateSizes => {
      if (!duplicateSizes.length) {
        logger.debug('No files need hashing - no duplicate content sizes found', {
          runId,
        });
      } else {
        logger.debug('Found content sizes with potential duplicates', {
          runId,
          duplicateSizeCount: duplicateSizes.length,
        });
      }
    }),
    switchMap(duplicateSizes => {
      if (!duplicateSizes.length) {
        return of(void 0);
      }

      // Get total count for progress reporting
      return getTotalFilesNeedingHash(connection, runId, duplicateSizes).pipe(
        tap(total => {
          stats.totalFiles = total;
          logger.debug('Total files needing hash calculation', {
            runId,
            totalFiles: total,
          });
        }),
        switchMap(totalFiles => {
          if (totalFiles === 0) {
            logger.debug('All duplicate files already have hashes', { runId });
            return of(void 0);
          }

          // Process files in streaming batches
          let currentOffset = 0;

          return range(0, Math.ceil(totalFiles / finalConfig.batchSize)).pipe(
            concatMap(() => {
              const offset = currentOffset;
              currentOffset += finalConfig.batchSize;

              return getFilesBatch(
                connection,
                runId,
                duplicateSizes,
                offset,
                finalConfig.batchSize
              ).pipe(
                switchMap(filePaths => {
                  if (!filePaths.length) {
                    return of(0); // No more files to process
                  }

                  logger.debug('Processing hash batch', {
                    runId,
                    offset,
                    batchSize: filePaths.length,
                  });

                  return processBatch(
                    connection,
                    runId,
                    rootPath,
                    filePaths,
                    finalConfig.concurrency
                  ).pipe(
                    tap(processed => {
                      stats.processed += processed;

                      if (finalConfig.onProgress) {
                        finalConfig.onProgress(stats.processed, stats.totalFiles, stats.errors);
                      }
                    })
                  );
                })
              );
            }),
            finalize(() => {
              stats.endTime = Date.now();
              const duration = (stats.endTime - stats.startTime) / 1000;

              logger.debug('Hash calculation completed', {
                runId,
                processed: stats.processed,
                total: stats.totalFiles,
                errors: stats.errors,
                duration: `${duration.toFixed(1)}s`,
                rate:
                  stats.processed > 0
                    ? `${(stats.processed / duration).toFixed(0)} files/second`
                    : '0 files/second',
              });
            })
          );
        })
      );
    }),
    map(() => void 0),
    catchError(error => {
      logger.error('Hash calculation pipeline failed', error as Error, { runId });
      throw error;
    })
  );
}

/**
 * Convenience function for hash calculation with progress reporting
 */
export function performHashing(
  connection: DatabaseConnection,
  runId: string,
  rootPath: string,
  progressCallback?: (processed: number, total: number, errors: number) => void
): Observable<void> {
  return calculateHashes(connection, runId, rootPath, {
    onProgress: progressCallback,
  });
}

/**
 * Get hashing statistics and progress
 */
export function getHashingProgress(
  connection: DatabaseConnection,
  runId: string
): Observable<{ total: number; completed: number; remaining: number }> {
  return findDuplicateSizes(connection, runId).pipe(
    switchMap(duplicateSizes => {
      if (!duplicateSizes.length) {
        return of({ total: 0, completed: 0, remaining: 0 });
      }

      // Get total files with duplicate content_size
      const totalQuery = connection.db
        .select({ count: count() })
        .from(files)
        .where(and(eq(files.run_id, runId), inArray(files.content_size, duplicateSizes)));

      // Get completed (already hashed) files
      const completedQuery = connection.db
        .select({ count: count() })
        .from(files)
        .where(
          and(
            eq(files.run_id, runId),
            inArray(files.content_size, duplicateSizes),
            sql`hash IS NOT NULL`
          )
        );

      return from(Promise.all([totalQuery, completedQuery])).pipe(
        map(([totalResult, completedResult]) => {
          const total = totalResult[0]?.count || 0;
          const completed = completedResult[0]?.count || 0;
          const remaining = total - completed;

          return { total, completed, remaining };
        })
      );
    }),
    catchError(error => {
      logger.error('Failed to get hashing progress', error as Error, { runId });
      return of({ total: 0, completed: 0, remaining: 0 });
    })
  );
}
