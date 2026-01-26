/**
 * Hash Extension
 *
 * Computes cryptographic hashes (MD5, SHA-256, SHA-512) for scanned files.
 * Stores hashes in a separate table that can be joined by other extensions.
 *
 * Uses RxJS streaming to handle large datasets efficiently.
 */

import { Command, Args, Flags, ux } from '@oclif/core';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Observable, defer, from, EMPTY, concat, of } from 'rxjs';
import { concatMap, map, tap, catchError, toArray, mergeMap, defaultIfEmpty } from 'rxjs/operators';
import { eq, and, gt, sql } from 'drizzle-orm';
import { setupOclifContext, logger } from '@lib/logging.ts';
import {
  createScanDatabase,
  closeScanDatabase,
  getLatestRunId,
  files,
  type DatabaseConnection,
  type FileSelect,
} from '@lib/database.ts';
import { SUPPORTED_ALGORITHMS, type HashAlgorithm } from './schema.ts';

// Re-export schema for other extensions to use
export { fileHashes, SUPPORTED_ALGORITHMS, type HashAlgorithm } from './schema.ts';
export type { FileHashRow } from './schema.ts';

// === Table Initialization ===

/**
 * Ensure file_hashes table exists
 */
async function ensureHashTable(connection: DatabaseConnection): Promise<void> {
  await connection.pg.exec(`
    CREATE TABLE IF NOT EXISTS file_hashes (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      md5 TEXT,
      sha256 TEXT,
      sha512 TEXT,
      PRIMARY KEY (run_id, path)
    )
  `);
  await connection.pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_file_hashes_run_id ON file_hashes (run_id)
  `);
}

// === Hash Computation ===

/**
 * Compute hash of a file using specified algorithm
 */
function computeFileHash(filePath: string, algorithm: HashAlgorithm): Observable<string> {
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
        logger.debug('Failed to read file for hashing', { filePath, error: err.message });
        subscriber.error(err);
      });
    });
  });
}

// === Batched File Retrieval ===

/**
 * Get files that need hashing (not directories, not archive entries)
 * Simple version - gets all eligible files, hash extension handles deduplication
 */
function getFilesForHashing(
  connection: DatabaseConnection,
  runId: string,
  batchSize: number = 5000
): Observable<FileSelect[]> {
  return defer(() => {
    logger.debug('Finding files for hashing', { runId, batchSize });

    const fetchBatch = (lastPath: string | null): Observable<FileSelect[]> => {
      logger.debug('fetchBatch called', { lastPath, runId, batchSize });

      // Simple query - just get files (not directories) for this run
      const queryPromise = lastPath
        ? connection.db
            .select()
            .from(files)
            .where(
              and(eq(files.run_id, runId), eq(files.is_directory, false), gt(files.path, lastPath))
            )
            .orderBy(files.path)
            .limit(batchSize)
        : connection.db
            .select()
            .from(files)
            .where(and(eq(files.run_id, runId), eq(files.is_directory, false)))
            .orderBy(files.path)
            .limit(batchSize);

      return from(queryPromise).pipe(
        tap(batch => {
          logger.debug('Query returned batch', { count: batch.length, runId });
        }),
        concatMap(batch => {
          // Filter out archive entries (those with archive_parent_path set)
          const realFiles = batch.filter(f => f.archive_parent_path === null);

          if (batch.length === 0) {
            logger.debug('No more files for hashing', { runId });
            return EMPTY;
          }

          const newLastPath = batch[batch.length - 1].path;
          logger.debug('Retrieved batch for hashing', {
            runId,
            batchSize: batch.length,
            realFiles: realFiles.length,
            lastPath: newLastPath,
          });

          if (realFiles.length > 0) {
            return concat(of(realFiles), fetchBatch(newLastPath));
          } else {
            // Continue to next batch if this one had no real files
            return fetchBatch(newLastPath);
          }
        }),
        catchError(error => {
          logger.error('Failed to fetch files for hashing', error as Error, { runId });
          return EMPTY;
        })
      );
    };

    return fetchBatch(null);
  });
}

// === Hash Storage ===

/**
 * Upsert a batch of hashes
 */
function upsertHashBatch(
  connection: DatabaseConnection,
  runId: string,
  algorithm: HashAlgorithm,
  hashes: Array<{ path: string; hash: string }>
): Observable<number> {
  if (hashes.length === 0) {
    return of(0);
  }

  return defer(() => {
    // Build batch upsert
    const values = hashes
      .map(h => `('${runId}', '${h.path.replace(/'/g, "''")}', '${h.hash}')`)
      .join(',\n');

    const query = `
      INSERT INTO file_hashes (run_id, path, ${algorithm})
      VALUES ${values}
      ON CONFLICT (run_id, path) DO UPDATE SET ${algorithm} = EXCLUDED.${algorithm}
    `;

    return from(connection.pg.exec(query)).pipe(
      map(() => hashes.length),
      catchError(error => {
        logger.error('Failed to upsert hash batch', error as Error, {
          runId,
          algorithm,
          count: hashes.length,
        });
        return of(0);
      })
    );
  });
}

// === Main Hash Pipeline ===

export interface HashOptions {
  algorithm: HashAlgorithm;
  batchSize?: number;
  concurrency?: number;
}

/**
 * Compute hashes for all files in a scan run.
 * Streams files in batches and computes hashes with controlled concurrency.
 *
 * @returns Observable that emits progress updates and completes with total count
 */
export function computeHashes(
  database: DatabaseConnection,
  runId: string,
  rootPath: string,
  options: HashOptions
): Observable<{ processed: number; total: number }> {
  const { algorithm, batchSize = 5000, concurrency = 4 } = options;

  return defer(() => {
    logger.debug('Starting hash computation', { runId, algorithm, batchSize, concurrency });

    let totalProcessed = 0;
    let totalFiles = 0;

    return getFilesForHashing(database, runId, batchSize).pipe(
      // Process each batch
      concatMap(batch => {
        totalFiles += batch.length;

        // Compute hashes for files in batch with concurrency limit
        return from(batch).pipe(
          // Resolve full path and compute hash
          mergeMap(file => {
            const fullPath = path.join(rootPath, file.path);

            return computeFileHash(fullPath, algorithm).pipe(
              map(hash => ({ path: file.path, hash })),
              catchError(error => {
                logger.debug('Skipping file due to error', {
                  path: file.path,
                  error: String(error),
                });
                return EMPTY; // Skip files that can't be read
              })
            );
          }, concurrency),
          // Collect batch results
          toArray(),
          // Upsert batch to database
          concatMap(hashes => upsertHashBatch(database, runId, algorithm, hashes)),
          // Track progress
          map(count => {
            totalProcessed += count;
            return { processed: totalProcessed, total: totalFiles };
          })
        );
      }),
      // Emit final count if no files processed
      defaultIfEmpty({ processed: 0, total: 0 })
    );
  });
}

// === Command Declaration ===

/**
 * Hash command - auto-registered via extension registry
 */
export const COMMAND = {
  name: 'hash',
  command: class Hash extends Command {
    static override description = 'Compute cryptographic hashes for scanned files';

    static override examples = [
      '<%= config.bin %> <%= command.id %> /path/to/scanned/directory',
      '<%= config.bin %> <%= command.id %> /path/to/scanned/directory --algorithm sha256',
      '<%= config.bin %> <%= command.id %> /path/to/scanned/directory --algorithm md5',
    ];

    static override args = {
      directory: Args.string({
        description: 'Root directory that was scanned (for resolving file paths)',
        required: true,
      }),
    };

    static override flags = {
      algorithm: Flags.string({
        char: 'a',
        description: 'Hash algorithm to use',
        options: SUPPORTED_ALGORITHMS,
        default: 'sha256',
      }),
    };

    async run(): Promise<void> {
      const { args, flags } = await this.parse(Hash);
      const algorithm = flags.algorithm as HashAlgorithm;
      const directory = args.directory as string;

      // Cast config to access custom originalCwd property
      const config = this.config as typeof this.config & { originalCwd: string };

      // Resolve root path relative to where user ran the command
      const rootPath = path.resolve(config.originalCwd, directory);
      const cleanupLogging = setupOclifContext(
        this as unknown as Parameters<typeof setupOclifContext>[0]
      );
      let database: DatabaseConnection | undefined;

      try {
        // Connect to database
        database = await createScanDatabase('main');

        // Ensure hash table exists
        await ensureHashTable(database);

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

        this.log(`Root directory: ${rootPath}`);

        // Count files to hash first
        const fileCountResult = await database.db
          .select({ count: sql`COUNT(*)` })
          .from(files)
          .where(and(eq(files.run_id, runId), eq(files.is_directory, false)));

        const totalToHash = Number(fileCountResult[0]?.count ?? 0);
        this.log(`Files to process: ${totalToHash}`);

        // Compute hashes
        this.log(`Computing ${algorithm.toUpperCase()} hashes...`);

        let lastProgress = { processed: 0, total: 0 };

        await new Promise<void>((resolve, reject) => {
          if (!database) {
            reject(new Error('Database connection not available'));
            return;
          }
          computeHashes(database, runId, rootPath, { algorithm }).subscribe({
            next: progress => {
              lastProgress = progress;
              ux.action.start(
                `Computing ${algorithm.toUpperCase()} hashes`,
                `${progress.processed.toLocaleString()} files`
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
          `Hash computation completed: ${lastProgress.processed.toLocaleString()} files processed`
        );

        logger.debug('Hash computation completed', {
          runId,
          algorithm,
          totalProcessed: lastProgress.processed,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error('Hash command failed', error instanceof Error ? error : undefined, {
          algorithm,
        });

        this.error(`Hash computation failed: ${errorMessage}`, { exit: 1 });
      } finally {
        if (database) {
          await closeScanDatabase(database);
        }
        cleanupLogging();
      }
    }
  },
};
