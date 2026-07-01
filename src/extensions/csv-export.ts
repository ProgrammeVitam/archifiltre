/**
 * CSV Export Extension
 *
 * Exports scan results to CSV format using RxJS streaming pipeline.
 * Handles large datasets efficiently with batched queries and streaming file writes.
 * Joins with file_checksums table to include cryptographic checksums when available.
 * Only includes checksum columns that have at least one value (dynamic columns).
 */

import { Args, Flags, ux } from '@oclif/core';
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
import { logger } from '@lib/logging.ts';
import { generateExportFilename, ensureDirectory } from '@lib/helpers.ts';
import {
  createScanDatabase,
  getLatestRunId,
  getScanMetadata,
  files,
  type DatabaseConnection,
  type FileSelect,
} from '@lib/database.ts';
import { fileChecksums } from '@extensions/checksum/schema.ts';
import { ensureEnrichmentTables } from '@extensions/enrichment/index.ts';
import type { PipelineContext } from '@lib/pipeline-context.ts';
import { pausable } from '@lib/pausable.ts';
import { BaseCommand } from '@lib/base-command.ts';
import type { JobContext } from '@lib/job-context.ts';
import { exportToResip, exportToXlsx } from '@extensions/archival-export.ts';

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
function buildCsvColumns(
  populatedChecksums: ChecksumColumn[],
  hasDeleteTags: boolean = false,
  enrichment?: EnrichmentExportData
): string[] {
  const columns: string[] = [
    ...BASE_COLUMNS_BEFORE_CHECKSUMS,
    ...populatedChecksums,
    ...BASE_COLUMNS_AFTER_CHECKSUMS,
  ];
  if (hasDeleteTags) {
    columns.push('tagged_for_deletion');
  }
  const { includeAlias, includeComment, tagNames } = enrichmentColumnPlan(enrichment);
  if (includeAlias) columns.push('newName');
  if (includeComment) columns.push('description');
  columns.push(...tagNames);
  return columns;
}

/**
 * Get CSV header row
 */
function getCsvHeader(
  delimiter: string,
  populatedChecksums: ChecksumColumn[],
  hasDeleteTags: boolean = false,
  enrichment?: EnrichmentExportData
): string {
  return buildCsvColumns(populatedChecksums, hasDeleteTags, enrichment).join(delimiter);
}

/**
 * Escape a value for CSV format.
 * Wraps in quotes if contains delimiter, quotes, or newlines.
 */
export function escapeCsvValue(
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
  rootPath?: string,
  deleteTagPaths?: Set<string>,
  enrichment?: EnrichmentExportData
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

  if (deleteTagPaths) {
    values.push(deleteTagPaths.has(file.path) ? true : '');
  }

  // Enrichment columns (must match buildCsvColumns order: newName, description,
  // then one column per tag name).
  const { includeAlias, includeComment, tagNames } = enrichmentColumnPlan(enrichment);
  if (includeAlias) values.push(enrichment?.aliases.get(file.path) ?? '');
  if (includeComment) values.push(enrichment?.comments.get(file.path) ?? '');
  if (tagNames.length > 0) {
    const assigned = enrichment?.tagsByPath.get(file.path);
    for (const name of tagNames) {
      values.push(assigned?.has(name) ? true : '');
    }
  }

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

/**
 * Detect if any delete tags exist for this run.
 * Returns false if the delete_tags table doesn't exist (extension not used yet).
 */
async function hasDeleteTagsForRun(
  connection: DatabaseConnection,
  runId: string
): Promise<boolean> {
  try {
    const result = await connection.pg.query<{ has_data: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM delete_tags
        WHERE run_id = $1
        LIMIT 1
      ) as has_data`,
      [runId]
    );
    return result.rows[0]?.has_data ?? false;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('does not exist')) {
      logger.debug('delete_tags table does not exist, no tags to export', { runId });
      return false;
    }
    throw error;
  }
}

// === Enrichment Columns ===

/**
 * User-applied enrichment for a run, loaded once for an export.
 * Small, user-authored data, so loading it into maps for the duration of the
 * export is appropriate (PGlite remains the source of truth).
 */
export interface EnrichmentExportData {
  /** path -> alias (exported as the `newName` column) */
  aliases: Map<string, string>;
  /** path -> comment (exported as the `description` column) */
  comments: Map<string, string>;
  /** distinct tag names, sorted — one CSV column each */
  tagNames: string[];
  /** path -> set of tag names assigned to it */
  tagsByPath: Map<string, Set<string>>;
}

/**
 * Load all enrichment for a run. The enrichment tables are ensured to exist by
 * the export command's openDatabase, so no missing-table handling is needed.
 */
export async function loadEnrichmentForExport(
  connection: DatabaseConnection,
  runId: string
): Promise<EnrichmentExportData> {
  const [aliasRes, commentRes, tagRes, assignRes] = await Promise.all([
    connection.pg.query<{ path: string; alias: string }>(
      `SELECT path, alias FROM aliases WHERE run_id = $1`,
      [runId]
    ),
    connection.pg.query<{ path: string; comment: string }>(
      `SELECT path, comment FROM comments WHERE run_id = $1`,
      [runId]
    ),
    connection.pg.query<{ tag_id: string; name: string }>(
      `SELECT tag_id, name FROM tags WHERE run_id = $1`,
      [runId]
    ),
    connection.pg.query<{ tag_id: string; path: string }>(
      `SELECT tag_id, path FROM tag_assignments WHERE run_id = $1`,
      [runId]
    ),
  ]);

  const tagIdToName = new Map(tagRes.rows.map(r => [r.tag_id, r.name]));
  const tagNames = [...new Set(tagIdToName.values())].sort((a, b) => a.localeCompare(b));

  const tagsByPath = new Map<string, Set<string>>();
  for (const row of assignRes.rows) {
    const name = tagIdToName.get(row.tag_id);
    if (!name) continue;
    let set = tagsByPath.get(row.path);
    if (!set) {
      set = new Set<string>();
      tagsByPath.set(row.path, set);
    }
    set.add(name);
  }

  return {
    aliases: new Map(aliasRes.rows.map(r => [r.path, r.alias])),
    comments: new Map(commentRes.rows.map(r => [r.path, r.comment])),
    tagNames,
    tagsByPath,
  };
}

/**
 * Which enrichment columns to emit. Mirrors the "dynamic column only when
 * populated" rule used for checksums and the delete tag: alias/comment columns
 * appear only if any exist, and there is one column per existing tag.
 */
function enrichmentColumnPlan(enrichment?: EnrichmentExportData): {
  includeAlias: boolean;
  includeComment: boolean;
  tagNames: string[];
} {
  if (!enrichment) return { includeAlias: false, includeComment: false, tagNames: [] };
  return {
    includeAlias: enrichment.aliases.size > 0,
    includeComment: enrichment.comments.size > 0,
    tagNames: enrichment.tagNames,
  };
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

interface CsvExportOptions {
  delimiter?: string;
  batchSize?: number;
  populatedChecksums?: ChecksumColumn[]; // Which checksum columns have data
  hasDeleteTags?: boolean; // Whether delete tags exist for this run
  deletionOnly?: boolean; // Only emit rows tagged for deletion (no tagged_for_deletion column)
  enrichment?: EnrichmentExportData; // Aliases, comments and tags to append as columns
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
  context: PipelineContext,
  outputPath: string,
  options: CsvExportOptions = {}
): Observable<number> {
  const { database, runId, rootPath } = context;
  const {
    delimiter = ',',
    batchSize = 5000,
    populatedChecksums = [],
    hasDeleteTags = false,
    deletionOnly = false,
    enrichment,
  } = options;

  let fileHandle: FileHandle | null = null;

  return defer(() => {
    logger.info('CSV export started', {
      runId,
      outputPath,
      batchSize,
      checksumColumns: populatedChecksums.join(', '),
      hasDeleteTags,
      deletionOnly,
    });

    // Load delete tag paths when needed (full export with tag column, or deletion-only export)
    const shouldLoadDeleteTags = hasDeleteTags || deletionOnly;
    const includeDeleteTagColumn = hasDeleteTags && !deletionOnly;

    const deleteTagsPromise: Promise<Set<string>> = shouldLoadDeleteTags
      ? database.pg
          .query<{ path: string }>(`SELECT path FROM delete_tags WHERE run_id = $1`, [runId])
          .then(result => new Set(result.rows.map(r => r.path)))
      : Promise.resolve(new Set<string>());

    return from(deleteTagsPromise).pipe(
      concatMap(deleteTagPaths => {
        // Open file and write header
        return from(fsp.open(outputPath, 'w')).pipe(
          tap(handle => {
            fileHandle = handle;
          }),
          // Write header (no tagged_for_deletion column in deletion-only mode)
          concatMap(handle =>
            from(
              handle.write(
                `${getCsvHeader(delimiter, populatedChecksums, includeDeleteTagColumn, enrichment)}\n`
              )
            ).pipe(map(() => handle))
          ),
          // Start streaming batches with JOIN (only if checksums exist)
          concatMap(() =>
            getFilesWithHashesBatched(
              database,
              runId,
              batchSize,
              populatedChecksums.length > 0
            ).pipe(
              pausable(context),
              // In deletion-only mode, keep only rows whose path is tagged
              map(batch => deletionOnly ? batch.filter(f => deleteTagPaths.has(f.path)) : batch),
              // Format batch to CSV lines
              map(batch =>
                batch.map(file =>
                  formatCsvRow(
                    file,
                    delimiter,
                    populatedChecksums,
                    rootPath,
                    includeDeleteTagColumn ? deleteTagPaths : undefined,
                    enrichment
                  )
                )
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
              tap(total => context.onProgress?.('export', total, null)),
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
      })
    );
  });
}

// === Command Declaration ===

class ExportCommand extends BaseCommand {
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
    ...BaseCommand.baseFlags,
    'full-paths': Flags.boolean({
      description: 'Export full absolute paths instead of relative paths',
      default: false,
    }),
    'deletion-only': Flags.boolean({
      description: 'Export only items tagged for deletion (bordereau d\'élimination)',
      default: false,
    }),
    format: Flags.string({
      description: 'Export format: csv (default), resip (SEDA archival CSV), or xlsx (Excel)',
      options: ['csv', 'resip', 'xlsx'],
      default: 'csv',
    }),
    db: Flags.string({
      description: 'Database name to export from',
      default: 'main',
    }),
  };

  private _resolvedOutput = '';

  get jobType() { return 'export'; }
  get jobLabel() { return `Export${this._resolvedOutput ? ` → ${path.basename(this._resolvedOutput)}` : ''}`; }
  get phases() { return ['export']; }

  async openDatabase(): Promise<{ db: DatabaseConnection; runId: string; rootPath: string }> {
    const { args, flags } = await this.parse(ExportCommand);

    const config = this.config as typeof this.config & { originalCwd: string };
    const format = flags.format as 'csv' | 'resip' | 'xlsx';
    const extension = format === 'xlsx' ? 'xlsx' : 'csv';
    const fileType =
      format === 'resip'
        ? 'resip'
        : format === 'xlsx'
          ? 'archifiltre'
          : flags['deletion-only']
            ? 'bordereau-elimination'
            : 'export';
    const outputPath = args.output || generateExportFilename({ type: fileType, extension });
    const resolvedOutput = path.resolve(config.originalCwd, outputPath);
    await ensureDirectory(path.dirname(resolvedOutput));
    this._resolvedOutput = resolvedOutput;

    const db = await createScanDatabase(flags.db);

    // Ensure enrichment tables exist so enrichment loading/joins are safe even
    // for scans that were never opened in the UI.
    await ensureEnrichmentTables(db);

    const runId = await getLatestRunId(db).toPromise();
    if (!runId) {
      this.error(
        'No scans found in database. Run a scan first with: archifiltre scan <directory>',
        { exit: 1 }
      );
    }

    const metadata = await getScanMetadata(db, runId).toPromise();
    if (!metadata) {
      this.warn('Scan metadata not found. Full paths will not be available.');
    }

    return { db, runId, rootPath: metadata?.root_path ?? '' };
  }

  async runJob(context: JobContext): Promise<void> {
    const { flags } = await this.parse(ExportCommand);
    const fullPaths = flags['full-paths'];
    const deletionOnly = flags['deletion-only'];
    const format = flags.format as 'csv' | 'resip' | 'xlsx';

    // Archival formats (RESIP SEDA CSV, Excel workbook) walk the scan as a tree with
    // enrichment folded in; they share their own generator instead of the flat CSV path.
    if (format === 'resip' || format === 'xlsx') {
      ux.action.start(`Exporting (${format}) to ${this._resolvedOutput}`);
      const total =
        format === 'resip'
          ? await exportToResip(context, this._resolvedOutput)
          : await exportToXlsx(context, this._resolvedOutput);
      ux.action.stop(`${total.toLocaleString()} elements`);
      this.log('');
      this.log(`Export completed: ${this._resolvedOutput}`);
      logger.info('Archival export completed', {
        runId: context.runId,
        format,
        outputPath: this._resolvedOutput,
        total,
      });
      return;
    }

    ux.action.start('Detecting checksum columns');
    const populatedChecksums = await getPopulatedChecksumColumns(context.database, context.runId);
    ux.action.stop(populatedChecksums.length > 0 ? populatedChecksums.join(', ') : 'none');

    ux.action.start('Detecting delete tags');
    const hasDeleteTags = await hasDeleteTagsForRun(context.database, context.runId);
    ux.action.stop(hasDeleteTags ? 'yes' : 'none');

    ux.action.start('Loading enrichment');
    const enrichment = await loadEnrichmentForExport(context.database, context.runId);
    const tagColumnCount = enrichment.tagNames.length;
    ux.action.stop(
      enrichment.aliases.size > 0 || enrichment.comments.size > 0 || tagColumnCount > 0
        ? `${enrichment.aliases.size} aliases, ${enrichment.comments.size} comments, ${tagColumnCount} tags`
        : 'none'
    );

    ux.action.start(`Exporting to ${this._resolvedOutput}`);

    const exportContext = fullPaths ? context : { ...context, rootPath: '' };
    const totalFiles = await exportToCsv(exportContext, this._resolvedOutput, {
      populatedChecksums,
      hasDeleteTags,
      deletionOnly,
      enrichment,
    }).toPromise();

    ux.action.stop(`${totalFiles?.toLocaleString() ?? 0} files`);

    this.log('');
    this.log(`Export completed: ${this._resolvedOutput}`);

    logger.info('CSV export completed', {
      runId: context.runId,
      outputPath: this._resolvedOutput,
      totalFiles,
    });
  }
}

export const COMMAND = {
  name: 'export',
  command: ExportCommand,
};

export const MANIFEST = {
  id: 'csv-export',
  name: 'CSV Export',
  description: 'Exports scan results to CSV format',
  version: '1.0.0',
  command: ExportCommand,
};
