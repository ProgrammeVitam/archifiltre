/**
 * CSV Export Extension
 *
 * Exports scan results to CSV format using RxJS streaming pipeline.
 * Handles large datasets efficiently with batched queries and streaming file writes.
 * Joins with file_checksums table to include cryptographic checksums when available.
 * Only includes checksum columns that have at least one value (dynamic columns).
 */

import { Command, Args, Flags, ux } from '@oclif/core';
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Observable } from 'rxjs';
import { defer, from, EMPTY, concat, of } from 'rxjs';
import {
  concatMap,
  finalize,
  map,
  scan,
  tap,
  catchError,
  last,
  defaultIfEmpty,
} from 'rxjs/operators';
import { eq, and, gt } from 'drizzle-orm';
import { setupOclifContext, logger } from '@lib/logging.ts';
import { generateExportFilename, ensureDirectory } from '@lib/helpers.ts';
import {
  createScanDatabase,
  closeScanDatabase,
  getLatestRunId,
  getScanMetadata,
  files,
  type DatabaseConnection,
  type FileSelect,
} from '@lib/database.ts';
import { fileChecksums } from '@extensions/checksum/schema.ts';

// === Types ===

/**
 * File with optional hash data from JOIN
 */
interface FileWithHashes extends FileSelect {
  md5: string | null;
  sha256: string | null;
  sha512: string | null;
  xxhash64: string | null;
}

// === CSV Formatting ===

/**
 * Base CSV column definitions (without dynamic checksum columns)
 */
const BASE_COLUMNS_BEFORE_CHECKSUMS = [
  'path',
  'type',
  'physical_size',
  'content_size',
  'modified',
] as const;

const BASE_COLUMNS_AFTER_CHECKSUMS = [
  'is_hidden',
  'is_archive',
  'archive_format',
  'archive_parent',
  'archive_depth',
] as const;

/**
 * All possible checksum columns
 */
const CHECKSUM_COLUMNS = ['md5', 'sha256', 'sha512', 'xxhash64'] as const;
type ChecksumColumn = (typeof CHECKSUM_COLUMNS)[number];

/**
 * Build CSV columns array with only populated checksum columns
 */
function buildCsvColumns(populatedChecksums: ChecksumColumn[]): string[] {
  return [...BASE_COLUMNS_BEFORE_CHECKSUMS, ...populatedChecksums, ...BASE_COLUMNS_AFTER_CHECKSUMS];
}

/**
 * Get CSV header row
 */
function getCsvHeader(delimiter: string, populatedChecksums: ChecksumColumn[]): string {
  return buildCsvColumns(populatedChecksums).join(delimiter);
}

/**
 * Escape a value for CSV format.
 * Wraps in quotes if contains delimiter, quotes, or newlines.
 */
function escapeCsvValue(
  value: string | number | boolean | null | undefined,
  delimiter: string
): string {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  // Check if quoting is needed
  if (
    stringValue.includes(delimiter) ||
    stringValue.includes('"') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r')
  ) {
    // Escape quotes by doubling them and wrap in quotes
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * Format a file row as a CSV line
 * @param file File data
 * @param delimiter CSV delimiter
 * @param populatedChecksums Which checksum columns to include
 * @param rootPath Optional root path to prepend for full paths
 */
function formatCsvRow(
  file: FileWithHashes,
  delimiter: string,
  populatedChecksums: ChecksumColumn[],
  rootPath?: string
): string {
  const filePath = rootPath ? path.join(rootPath, file.path) : file.path;

  // Build values array with only populated checksum columns
  const baseValuesBefore = [
    filePath,
    file.is_directory ? 'directory' : 'file',
    file.physical_size,
    file.content_size,
    file.mtime ? new Date(file.mtime * 1000).toISOString() : '',
  ];

  const checksumValues = populatedChecksums.map(col => file[col]);

  const baseValuesAfter = [
    file.is_hidden,
    file.is_archive_container,
    file.archive_format,
    file.archive_parent_path,
    file.archive_depth,
  ];

  const values = [...baseValuesBefore, ...checksumValues, ...baseValuesAfter];

  return values.map(v => escapeCsvValue(v, delimiter)).join(delimiter);
}

// === Checksum Column Detection ===

/**
 * Detect which checksum columns have at least one non-null value for this run.
 * This allows us to only include relevant columns in the export.
 * Returns empty array if file_checksums table doesn't exist (no checksums computed yet).
 */
async function getPopulatedChecksumColumns(
  connection: DatabaseConnection,
  runId: string
): Promise<ChecksumColumn[]> {
  const populated: ChecksumColumn[] = [];

  try {
    // Check each checksum column for any non-null values
    for (const column of CHECKSUM_COLUMNS) {
      const result = await connection.pg.query<{ has_data: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM file_checksums
          WHERE run_id = $1 AND ${column} IS NOT NULL
          LIMIT 1
        ) as has_data`,
        [runId]
      );

      if (result.rows[0]?.has_data) {
        populated.push(column);
      }
    }
  } catch (error) {
    // Table doesn't exist yet (no checksum command has been run)
    // This is expected - just return empty array
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('does not exist')) {
      logger.debug('file_checksums table does not exist, no checksums to export', { runId });
      return [];
    }
    // Re-throw unexpected errors
    throw error;
  }

  logger.debug('Detected populated checksum columns', { runId, columns: populated.join(', ') });
  return populated;
}

// === Batched Query with JOIN ===

/**
 * Get files without checksums in batches using keyset pagination.
 */
function getFilesWithoutChecksums(
  connection: DatabaseConnection,
  runId: string,
  batchSize: number,
  lastPath: string | null
): Observable<FileWithHashes[]> {
  const conditions = [eq(files.run_id, runId)];
  if (lastPath) {
    conditions.push(gt(files.path, lastPath));
  }

  const query = connection.db
    .select({
      run_id: files.run_id,
      path: files.path,
      physical_size: files.physical_size,
      content_size: files.content_size,
      mtime: files.mtime,
      is_directory: files.is_directory,
      is_hidden: files.is_hidden,
      is_system: files.is_system,
      is_archive_container: files.is_archive_container,
      archive_parent_path: files.archive_parent_path,
      archive_depth: files.archive_depth,
      archive_format: files.archive_format,
      extraction_error: files.extraction_error,
    })
    .from(files)
    .where(and(...conditions))
    .orderBy(files.path)
    .limit(batchSize);

  return from(query).pipe(
    map(
      batch =>
        batch.map(row => ({
          ...row,
          md5: null,
          sha256: null,
          sha512: null,
          xxhash64: null,
        })) as FileWithHashes[]
    )
  );
}

/**
 * Get files with checksums in batches using keyset pagination.
 * LEFT JOINs file_checksums to include crypto hashes.
 */
function getFilesWithChecksums(
  connection: DatabaseConnection,
  runId: string,
  batchSize: number,
  lastPath: string | null
): Observable<FileWithHashes[]> {
  const conditions = [eq(files.run_id, runId)];
  if (lastPath) {
    conditions.push(gt(files.path, lastPath));
  }

  const query = connection.db
    .select({
      run_id: files.run_id,
      path: files.path,
      physical_size: files.physical_size,
      content_size: files.content_size,
      mtime: files.mtime,
      is_directory: files.is_directory,
      is_hidden: files.is_hidden,
      is_system: files.is_system,
      is_archive_container: files.is_archive_container,
      archive_parent_path: files.archive_parent_path,
      archive_depth: files.archive_depth,
      archive_format: files.archive_format,
      extraction_error: files.extraction_error,
      md5: fileChecksums.md5,
      sha256: fileChecksums.sha256,
      sha512: fileChecksums.sha512,
      xxhash64: fileChecksums.xxhash64,
    })
    .from(files)
    .leftJoin(
      fileChecksums,
      and(eq(files.run_id, fileChecksums.run_id), eq(files.path, fileChecksums.path))
    )
    .where(and(...conditions))
    .orderBy(files.path)
    .limit(batchSize);

  return from(query).pipe(map(batch => batch as unknown as FileWithHashes[]));
}

/**
 * Get files with hashes in batches using keyset pagination.
 * LEFT JOINs file_checksums to include crypto hashes when available.
 * If includeChecksums is false, skips the JOIN entirely (faster, avoids missing table errors).
 */
function getFilesWithHashesBatched(
  connection: DatabaseConnection,
  runId: string,
  batchSize: number = 5000,
  includeChecksums: boolean = true
): Observable<FileWithHashes[]> {
  return defer(() => {
    logger.debug('Starting batched file retrieval', { runId, batchSize, includeChecksums });

    const fetchBatch = (lastPath: string | null): Observable<FileWithHashes[]> => {
      const queryFn = includeChecksums ? getFilesWithChecksums : getFilesWithoutChecksums;

      return queryFn(connection, runId, batchSize, lastPath).pipe(
        concatMap(batch => {
          if (batch.length === 0) {
            logger.debug('Batched retrieval complete', { runId });
            return EMPTY;
          }

          const newLastPath = batch[batch.length - 1].path;
          logger.debug('Retrieved batch', {
            runId,
            batchSize: batch.length,
            lastPath: newLastPath,
          });

          return concat(of(batch), fetchBatch(newLastPath));
        }),
        catchError(error => {
          logger.error('Failed to fetch file batch with hashes', error as Error, {
            runId,
            lastPath,
          });
          return EMPTY;
        })
      );
    };

    return fetchBatch(null);
  });
}

// === File Writing ===

/**
 * Write lines to file handle
 */
function writeLines(fileHandle: FileHandle, lines: string[]): Observable<number> {
  return defer(() => {
    const content = `${lines.join('\n')}\n`;
    return from(fileHandle.write(content)).pipe(map(() => lines.length));
  });
}

// === Export Pipeline ===

export interface CsvExportOptions {
  delimiter?: string;
  batchSize?: number;
  rootPath?: string; // When provided, paths will be full paths
  populatedChecksums?: ChecksumColumn[]; // Which checksum columns have data
}

/**
 * Export scan results to CSV using streaming RxJS pipeline.
 * Includes cryptographic hashes from file_hashes table when available.
 *
 * @param database Database connection
 * @param runId Scan run to export
 * @param outputPath Output CSV file path
 * @param options Export options
 * @returns Observable that completes when export is done, emitting total count
 */
export function exportToCsv(
  database: DatabaseConnection,
  runId: string,
  outputPath: string,
  options: CsvExportOptions = {}
): Observable<number> {
  const { delimiter = ',', batchSize = 5000, rootPath, populatedChecksums = [] } = options;

  let fileHandle: FileHandle | null = null;

  return defer(() => {
    logger.info('CSV export started', {
      runId,
      outputPath,
      batchSize,
      checksumColumns: populatedChecksums.join(', '),
    });

    // Open file and write header
    return from(fsp.open(outputPath, 'w')).pipe(
      tap(handle => {
        fileHandle = handle;
      }),
      // Write header (with only populated checksum columns)
      concatMap(handle =>
        from(handle.write(`${getCsvHeader(delimiter, populatedChecksums)}\n`)).pipe(
          map(() => handle)
        )
      ),
      // Start streaming batches with JOIN (only if checksums exist)
      concatMap(() =>
        getFilesWithHashesBatched(database, runId, batchSize, populatedChecksums.length > 0).pipe(
          // Format batch to CSV lines (with only populated checksum columns)
          map(batch =>
            batch.map(file => formatCsvRow(file, delimiter, populatedChecksums, rootPath))
          ),
          // Write batch to file with backpressure
          concatMap(lines => {
            if (!fileHandle) {
              throw new Error('File handle not initialized');
            }
            return writeLines(fileHandle, lines);
          }),
          // Accumulate total count
          scan((total, batchCount) => total + batchCount, 0),
          // Emit 0 if no files found
          defaultIfEmpty(0)
        )
      ),
      // Get final count
      last(),
      // Cleanup: close file handle
      finalize(async () => {
        if (fileHandle) {
          await fileHandle.close();
          logger.debug('Closed CSV file handle', { outputPath });
        }
      }),
      catchError(error => {
        logger.error('CSV export failed', error as Error, { runId, outputPath });
        throw error;
      })
    );
  });
}

// === Command Declaration ===

/**
 * Export command - auto-registered via extension registry
 */
export const COMMAND = {
  name: 'export',
  command: class Export extends Command {
    static override description = 'Export scan results to CSV';

    static override examples = [
      '<%= config.bin %> <%= command.id %>',
      '<%= config.bin %> <%= command.id %> inventory.csv',
      '<%= config.bin %> <%= command.id %> ./output/scan-results.csv',
      '<%= config.bin %> <%= command.id %> --full-paths',
    ];

    static override args = {
      output: Args.string({
        description: 'Output CSV file path (auto-generated if not provided)',
        required: false,
      }),
    };

    static override flags = {
      'full-paths': Flags.boolean({
        description: 'Export full absolute paths instead of relative paths',
        default: false,
      }),
    };

    async run(): Promise<void> {
      const { args, flags } = await this.parse(Export);
      const fullPaths = flags['full-paths'];

      // Cast config to access custom originalCwd property from StandaloneConfig
      const config = this.config as typeof this.config & { originalCwd: string };
      const cleanupLogging = setupOclifContext(
        this as unknown as Parameters<typeof setupOclifContext>[0]
      );
      let database: DatabaseConnection | undefined;

      try {
        // Determine output path - use provided path or generate one
        const outputPath =
          args.output || generateExportFilename({ type: 'export', extension: 'csv' });

        // Resolve output path relative to where user ran the command
        const resolvedOutput = path.resolve(config.originalCwd, outputPath);

        // Ensure output directory exists
        const outputDir = path.dirname(resolvedOutput);
        await ensureDirectory(outputDir);

        // Connect to database
        database = await createScanDatabase('main');

        // Get latest run_id
        ux.action.start('Finding latest scan');
        const runId = await getLatestRunId(database).toPromise();

        if (!runId) {
          ux.action.stop('failed');
          this.error(
            'No scans found in database. Run a scan first with: archifiltre scan <directory>',
            {
              exit: 1,
            }
          );
        }

        ux.action.stop(runId);

        // Get root path if full paths requested
        let rootPath: string | undefined;
        if (fullPaths) {
          ux.action.start('Loading scan metadata');
          const metadata = await getScanMetadata(database, runId).toPromise();
          if (metadata) {
            rootPath = metadata.root_path;
            ux.action.stop(rootPath);
          } else {
            ux.action.stop('not found (using relative paths)');
            this.warn('Scan metadata not found. Falling back to relative paths.');
          }
        }

        // Detect which checksum columns have data
        ux.action.start('Detecting checksum columns');
        const populatedChecksums = await getPopulatedChecksumColumns(database, runId);
        if (populatedChecksums.length > 0) {
          ux.action.stop(populatedChecksums.join(', '));
        } else {
          ux.action.stop('none');
        }

        // Export to CSV
        ux.action.start(`Exporting to ${resolvedOutput}`);

        const totalFiles = await exportToCsv(database, runId, resolvedOutput, {
          rootPath,
          populatedChecksums,
        }).toPromise();

        ux.action.stop(`${totalFiles?.toLocaleString() ?? 0} files`);

        this.log('');
        this.log(`Export completed: ${resolvedOutput}`);

        logger.info('CSV export completed', {
          runId,
          outputPath: resolvedOutput,
          totalFiles,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error('Export command failed', error instanceof Error ? error : undefined, {
          outputPath: args.output || '(auto-generated)',
        });

        this.error(`Export failed: ${errorMessage}`, { exit: 1 });
      } finally {
        if (database) {
          await closeScanDatabase(database);
        }
        cleanupLogging();
      }
    }
  },
};
