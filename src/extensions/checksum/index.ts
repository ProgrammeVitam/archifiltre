/**
 * Checksum Extension
 *
 * Computes cryptographic checksums (MD5, SHA-256, SHA-512) for scanned files.
 * Stores checksums in a separate table that can be joined by other extensions.
 *
 * Optimized to leverage xxHash64 duplicate detection:
 * - For duplicate groups (same content_size + same xxHash64), calculates checksum once
 *   and propagates to all files in the group
 * - For unique files, calculates checksum individually
 * - Use --all flag to disable optimization and calculate every file independently
 *
 * Uses RxJS streaming to handle large datasets efficiently.
 */

import { Command, Flags, ux } from '@oclif/core';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
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
  type FileSelect,
} from '@lib/database.ts';
import { SUPPORTED_ALGORITHMS, type ChecksumAlgorithm } from './schema.ts';

// Re-export schema for other extensions to use
export { fileChecksums, SUPPORTED_ALGORITHMS, type ChecksumAlgorithm } from './schema.ts';
export type { FileChecksumRow } from './schema.ts';

// === Types ===

/**
 * Represents a group of duplicate files (same content_size + same xxHash64)
 */
interface DuplicateGroup {
  contentSize: number;
  hash: string;
  paths: string[];
  representativePath: string; // The file we'll actually read and hash
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
      PRIMARY KEY (run_id, path)
    )
  `);
  await connection.pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_file_checksums_run_id ON file_checksums (run_id)
  `);
}

// === Checksum Computation ===

/**
 * Compute checksum of a file using specified algorithm
 */
function computeFileChecksum(filePath: string, algorithm: ChecksumAlgorithm): Observable<string> {
  return defer(() => {
    return new Observable<string>(subscriber => {
      const hash = createHash(algorithm);
      const stream = createReadStream(filePath);

      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => {
        subscriber.next(hash.digest('hex'));
        subscriber.complete();
      });
      stream.on('error', err => {
        logger.debug('Failed to read file for checksum', { filePath, error: err.message });
        subscriber.error(err);
      });
    });
  });
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
    logger.debug('Finding duplicate groups for checksum optimization', { runId });

    // Get distinct (content_size, hash) pairs that have duplicates
    const queryStr = `
      SELECT
        content_size,
        hash,
        json_group_array(path) as paths
      FROM files
      WHERE run_id = $1
        AND is_directory = false
        AND archive_parent_path IS NULL
        AND hash IS NOT NULL
        AND content_size IS NOT NULL
      GROUP BY content_size, hash
      HAVING COUNT(*) > 1
      ORDER BY content_size DESC
    `;

    return from(
      connection.pg.query<{
        content_size: number;
        hash: string;
        paths: string;
      }>(queryStr, [runId])
    ).pipe(
      map(result => {
        const groups: DuplicateGroup[] = result.rows.map(row => {
          const paths = JSON.parse(row.paths) as string[];
          return {
            contentSize: row.content_size,
            hash: row.hash,
            paths,
            representativePath: paths[0], // Pick first file as representative
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
 */
function getUniqueFiles(
  connection: DatabaseConnection,
  runId: string,
  batchSize: number = 5000
): Observable<FileSelect[]> {
  return defer(() => {
    logger.debug('Finding unique files for checksum', { runId, batchSize });

    const fetchBatch = (lastPath: string | null): Observable<FileSelect[]> => {
      // Get files that don't have xxHash64 (unique content_size)
      const queryPromise = lastPath
        ? connection.db
            .select()
            .from(files)
            .where(
              and(
                eq(files.run_id, runId),
                eq(files.is_directory, false),
                isNull(files.archive_parent_path),
                isNull(files.hash), // No xxHash64 means unique content_size
                gt(files.path, lastPath)
              )
            )
            .orderBy(files.path)
            .limit(batchSize)
        : connection.db
            .select()
            .from(files)
            .where(
              and(
                eq(files.run_id, runId),
                eq(files.is_directory, false),
                isNull(files.archive_parent_path),
                isNull(files.hash)
              )
            )
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
 * Get ALL files (for --all mode, no optimization)
 */
function getAllFiles(
  connection: DatabaseConnection,
  runId: string,
  batchSize: number = 5000
): Observable<FileSelect[]> {
  return defer(() => {
    logger.debug('Finding all files for checksum (--all mode)', { runId, batchSize });

    const fetchBatch = (lastPath: string | null): Observable<FileSelect[]> => {
      const queryPromise = lastPath
        ? connection.db
            .select()
            .from(files)
            .where(
              and(
                eq(files.run_id, runId),
                eq(files.is_directory, false),
                isNull(files.archive_parent_path),
                gt(files.path, lastPath)
              )
            )
            .orderBy(files.path)
            .limit(batchSize)
        : connection.db
            .select()
            .from(files)
            .where(
              and(
                eq(files.run_id, runId),
                eq(files.is_directory, false),
                isNull(files.archive_parent_path)
              )
            )
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

// === Main Checksum Pipeline ===

export interface ChecksumOptions {
  algorithm: ChecksumAlgorithm;
  batchSize?: number;
  concurrency?: number;
  all?: boolean; // If true, calculate for every file individually (no optimization)
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
      const fullPath = path.join(rootPath, group.representativePath);

      return computeFileChecksum(fullPath, algorithm).pipe(
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
          const fullPath = path.join(rootPath, file.path);

          return computeFileChecksum(fullPath, algorithm).pipe(
            map(checksum => ({ path: file.path, checksum })),
            catchError(error => {
              logger.debug('Skipping unique file due to error', {
                path: file.path,
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
 * Process ALL files without optimization (--all mode)
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
          const fullPath = path.join(rootPath, file.path);

          return computeFileChecksum(fullPath, algorithm).pipe(
            map(checksum => ({ path: file.path, checksum })),
            catchError(error => {
              logger.debug('Skipping file due to error', {
                path: file.path,
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
 * With options.all = true, computes checksum for every file independently.
 *
 * @returns Observable that emits progress updates and completes with total count
 */
export function computeChecksums(
  database: DatabaseConnection,
  runId: string,
  rootPath: string,
  options: ChecksumOptions
): Observable<ChecksumProgress> {
  const { algorithm, batchSize = 5000, concurrency = 4, all = false } = options;

  return defer(() => {
    logger.debug('Starting checksum computation', {
      runId,
      algorithm,
      batchSize,
      concurrency,
      optimized: !all,
    });

    const progress: ChecksumProgress = {
      processed: 0,
      total: 0,
      duplicateGroups: 0,
      uniqueFiles: 0,
      filesSkipped: 0,
    };

    // --all mode: process every file individually
    if (all) {
      logger.debug('Using --all mode: processing every file individually');

      // Get total count first
      return from(
        database.db
          .select({ count: sql<number>`COUNT(*)` })
          .from(files)
          .where(
            and(
              eq(files.run_id, runId),
              eq(files.is_directory, false),
              isNull(files.archive_parent_path)
            )
          )
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

    // Optimized mode: leverage xxHash64 duplicate groups
    logger.debug('Using optimized mode: leveraging xxHash64 duplicate groups');

    return getDuplicateGroups(database, runId).pipe(
      switchMap(groups => {
        progress.duplicateGroups = groups.length;
        const filesInGroups = groups.reduce((sum, g) => sum + g.paths.length, 0);

        logger.debug('Duplicate groups analysis', {
          groups: groups.length,
          filesInGroups,
        });

        // Get count of unique files
        return from(
          database.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(files)
            .where(
              and(
                eq(files.run_id, runId),
                eq(files.is_directory, false),
                isNull(files.archive_parent_path),
                isNull(files.hash)
              )
            )
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
  // Total real files (not directories, not archive entries)
  const totalResult = await connection.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(files)
    .where(
      and(eq(files.run_id, runId), eq(files.is_directory, false), isNull(files.archive_parent_path))
    );

  // Files with xxHash64 (part of duplicate groups)
  const withHashResult = await connection.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(files)
    .where(
      and(
        eq(files.run_id, runId),
        eq(files.is_directory, false),
        isNull(files.archive_parent_path),
        isNotNull(files.hash)
      )
    );

  // Count duplicate groups
  const groupsResult = await connection.pg.query<{ group_count: number }>(
    `SELECT COUNT(*) as group_count FROM (
      SELECT content_size, hash
      FROM files
      WHERE run_id = $1
        AND is_directory = false
        AND archive_parent_path IS NULL
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
      '<%= config.bin %> <%= command.id %> --algorithm sha256',
      '<%= config.bin %> <%= command.id %> --algorithm md5',
      '<%= config.bin %> <%= command.id %> --all',
    ];

    static override flags = {
      algorithm: Flags.string({
        char: 'a',
        description: 'Checksum algorithm to use',
        options: SUPPORTED_ALGORITHMS,
        default: 'sha256',
      }),
      all: Flags.boolean({
        description:
          'Calculate checksum for every file individually (disables duplicate optimization)',
        default: false,
      }),
    };

    async run(): Promise<void> {
      const { flags } = await this.parse(Checksum);
      const algorithm = flags.algorithm as ChecksumAlgorithm;
      const all = flags.all;

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

        if (!all) {
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

        this.log('');
        this.log(
          `Computing ${algorithm.toUpperCase()} checksums${all ? ' (--all mode)' : ' (optimized)'}...`
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

          computeChecksums(database, runId, rootPath, { algorithm, all }).subscribe({
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

        logger.debug('Checksum computation completed', {
          runId,
          algorithm,
          all,
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
