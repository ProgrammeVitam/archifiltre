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
import { Observable, from, of } from 'rxjs';
import {
  tap,
  map,
  bufferCount,
  concatMap,
  finalize,
  switchMap,
  last,
  catchError,
  mergeMap,
} from 'rxjs/operators';
import { eq, and, count, gt, isNotNull } from 'drizzle-orm';
import { logger } from '@lib/logging.ts';
import {
  cleanDatabase,
  insertFileBatch,
  type DatabaseConnection,
  type FileRow,
  files,
} from '@lib/database.ts';
import { ArchiveReader, libarchiveWasm } from 'libarchive-wasm';

// Archive Detection Constants
const ARCHIVE_EXTENSIONS = new Set([
  '.zip',
  '.jar',
  '.war',
  '.ear',
  '.apk',
  '.7z',
  '.rar',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.tar.bz2',
  '.tbz2',
  '.tar.xz',
  '.txz',
  '.gz',
  '.bz2',
  '.xz',
  '.lz4',
  '.lzma',
  '.cab',
  '.iso',
  '.dmg',
]);

const ARCHIVE_MAGIC_NUMBERS = new Map([
  // ZIP family
  [new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'zip'], // Standard ZIP
  [new Uint8Array([0x50, 0x4b, 0x05, 0x06]), 'zip'], // Empty ZIP
  [new Uint8Array([0x50, 0x4b, 0x07, 0x08]), 'zip'], // Spanned ZIP
  // 7-Zip
  [new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), '7z'],
  // RAR
  [new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), 'rar'], // RAR 4.x
  [new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]), 'rar'], // RAR 5.x
  // TAR (POSIX)
  [new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x30, 0x30]), 'tar'],
  [new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0x00]), 'tar'],
  // GZIP
  [new Uint8Array([0x1f, 0x8b]), 'gz'],
  // BZIP2
  [new Uint8Array([0x42, 0x5a, 0x68]), 'bz2'],
  // XZ
  [new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), 'xz'],
]);

// Archive Detection Functions
/**
 * Check if a file is an archive based on extension
 */
function isArchiveByExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ARCHIVE_EXTENSIONS.has(ext);
}

/**
 * Check if file content matches archive magic numbers
 * Reads only the first 16 bytes for efficiency
 */
async function isArchiveByMagicNumber(
  filePath: string
): Promise<{ isArchive: boolean; format?: string }> {
  try {
    const absolutePath = path.resolve(filePath);
    const fd = await fsp.open(absolutePath, 'r');
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await fd.read(buffer, 0, 16, 0);
    await fd.close();

    if (bytesRead === 0) {
      return { isArchive: false };
    }

    const fileHeader = new Uint8Array(buffer.subarray(0, bytesRead));

    // Check each magic number pattern
    for (const [magicBytes, format] of ARCHIVE_MAGIC_NUMBERS.entries()) {
      if (fileHeader.length >= magicBytes.length) {
        const matches = magicBytes.every((byte, index) => fileHeader[index] === byte);
        if (matches) {
          return { isArchive: true, format };
        }
      }
    }

    return { isArchive: false };
  } catch (error) {
    logger.debug('Failed to read magic number', { filePath, error: (error as Error).message });
    return { isArchive: false };
  }
}

/**
 * Comprehensive archive detection combining extension and magic number checks
 */
export async function isArchiveFile(
  filePath: string
): Promise<{ isArchive: boolean; format?: string }> {
  // Quick check by extension first
  if (isArchiveByExtension(filePath)) {
    const ext = path.extname(filePath).toLowerCase().slice(1); // Remove dot

    // For common extensions, trust the extension
    if (['zip', 'jar', 'war', 'ear', 'apk', '7z', 'rar', 'tar'].includes(ext)) {
      return { isArchive: true, format: ext };
    }

    // For compressed files, verify with magic number
    const magicCheck = await isArchiveByMagicNumber(filePath);
    if (magicCheck.isArchive) {
      return magicCheck;
    }

    // Extension suggests archive but magic number doesn't confirm - trust extension
    return { isArchive: true, format: ext };
  }

  // Extension doesn't suggest archive, but check magic number for misnamed files
  return await isArchiveByMagicNumber(filePath);
}

// Archive Processing Configuration
interface ArchiveProcessingConfig {
  maxDepth: number;
  maxArchiveSize: number; // in bytes
  timeoutMs: number;
  enableNesting: boolean;
}

const DEFAULT_ARCHIVE_CONFIG: ArchiveProcessingConfig = {
  maxDepth: 3,
  maxArchiveSize: 100 * 1024 * 1024, // 100MB
  timeoutMs: 30000, // 30 seconds
  enableNesting: true,
};

/**
 * Get archive processing configuration from scan config
 */
function getArchiveConfig(scanConfig: ScanConfig): ArchiveProcessingConfig {
  return {
    maxDepth: scanConfig.maxArchiveDepth ?? DEFAULT_ARCHIVE_CONFIG.maxDepth,
    maxArchiveSize: scanConfig.maxArchiveSize ?? DEFAULT_ARCHIVE_CONFIG.maxArchiveSize,
    timeoutMs: scanConfig.archiveTimeoutMs ?? DEFAULT_ARCHIVE_CONFIG.timeoutMs,
    enableNesting: scanConfig.enableArchiveNesting ?? DEFAULT_ARCHIVE_CONFIG.enableNesting,
  };
}

/**
 * Process archive file and extract metadata for all entries
 */
async function processArchiveEntries(
  archivePath: string,
  rootPath: string,
  entry: FileEntry,
  config: ArchiveProcessingConfig = DEFAULT_ARCHIVE_CONFIG
): Promise<FileEntry[]> {
  const results: FileEntry[] = [];

  // Add the archive container itself (with content_size = null as per spec)
  const archiveContainer: FileEntry = {
    ...entry,
    isArchiveContainer: true,
    content_size: null, // Archive containers have no content_size per spec
    archiveFormat: entry.archiveFormat,
    extractionError: null,
  };
  results.push(archiveContainer);

  // Check size limits
  if (entry.physical_size > config.maxArchiveSize) {
    logger.debug('Archive exceeds size limit, skipping processing', {
      path: archivePath,
      size: entry.physical_size,
      limit: config.maxArchiveSize,
    });

    archiveContainer.extractionError = `Archive too large (${entry.physical_size} bytes > ${config.maxArchiveSize} bytes)`;
    return results;
  }

  // Check depth limits
  if (entry.archiveDepth >= config.maxDepth) {
    logger.debug('Archive exceeds depth limit, skipping processing', {
      path: archivePath,
      depth: entry.archiveDepth,
      limit: config.maxDepth,
    });

    archiveContainer.extractionError = `Archive nesting too deep (depth ${entry.archiveDepth} >= ${config.maxDepth})`;
    return results;
  }

  try {
    const absolutePath = path.resolve(rootPath, archivePath);
    const archiveBuffer = await fsp.readFile(absolutePath);

    // Initialize libarchive WASM
    const mod = await libarchiveWasm();
    const reader = new ArchiveReader(mod, new Int8Array(archiveBuffer));

    let entryCount = 0;
    const maxEntries = 10000; // Prevent memory exhaustion

    try {
      for (const archiveEntry of reader.entries()) {
        if (entryCount >= maxEntries) {
          logger.warn('Archive has too many entries, stopping processing', {
            path: archivePath,
            processedEntries: entryCount,
            limit: maxEntries,
          });
          break;
        }

        if (archiveEntry && typeof archiveEntry.getPathname === 'function') {
          const entryPath = archiveEntry.getPathname();
          const size = archiveEntry.getSize() || 0;
          const filetype = archiveEntry.getFiletype?.() || 'File';
          const isDirectory = filetype === 'Directory' || entryPath.endsWith('/');
          const modTime = archiveEntry.getModificationTime?.() || 0;

          // Create relative path: archive.zip/path/to/file.txt
          const relativePath = `${entry.path}/${entryPath}`;

          const archiveFileEntry: FileEntry = {
            path: relativePath,
            physical_size: 0, // Files within archives have no physical footprint
            content_size: isDirectory ? null : size, // Decompressed size for files, null for directories
            mtime: modTime > 0 ? Math.floor(modTime / 1000) : entry.mtime,
            isDirectory,
            isHidden: false, // Archive entries are not considered hidden
            isSystem: false, // Archive entries are not considered system files
            isArchiveContainer: false,
            archiveParentPath: entry.path,
            archiveDepth: entry.archiveDepth + 1,
            archiveFormat: entry.archiveFormat,
            extractionError: null,
          };

          results.push(archiveFileEntry);
          entryCount++;

          // If this entry is also an archive and nesting is enabled, process it recursively
          if (!isDirectory && config.enableNesting && entry.archiveDepth + 1 < config.maxDepth) {
            const archiveCheck = await isArchiveFile(entryPath);
            if (archiveCheck.isArchive) {
              // Note: We can't process nested archives from memory easily with libarchive-wasm
              // So we'll just mark them as archive containers but not process their contents
              archiveFileEntry.isArchiveContainer = true;
              archiveFileEntry.content_size = null;
              archiveFileEntry.archiveFormat = archiveCheck.format || 'unknown';

              logger.debug('Found nested archive (marked but not processed)', {
                path: relativePath,
                format: archiveCheck.format,
                depth: entry.archiveDepth + 1,
              });
            }
          }
        }
      }
    } finally {
      reader.free();
    }

    logger.debug('Archive processing completed', {
      path: archivePath,
      entriesFound: entryCount,
      format: entry.archiveFormat,
    });
  } catch (error) {
    logger.error('Failed to process archive', error as Error, {
      path: archivePath,
      format: entry.archiveFormat,
    });

    archiveContainer.extractionError = `Processing failed: ${(error as Error).message}`;
  }

  return results;
}

/**
 * Process a file entry and determine if it's an archive that needs processing
 */
function processFileEntry(
  rootPath: string,
  entry: FileEntry,
  config: ArchiveProcessingConfig
): Observable<FileEntry[]> {
  return from(
    (async () => {
      // Skip directories and files that are already marked as archive containers
      if (entry.isDirectory || entry.isArchiveContainer) {
        return [entry];
      }

      // Check if this is an archive file
      const absolutePath = path.resolve(rootPath, entry.path);
      const archiveCheck = await isArchiveFile(absolutePath);

      if (archiveCheck.isArchive) {
        logger.debug('Processing archive file', {
          path: entry.path,
          format: archiveCheck.format,
          size: entry.physical_size,
        });

        // Update entry with archive information
        const archiveEntry: FileEntry = {
          ...entry,
          archiveFormat: archiveCheck.format || 'unknown',
        };

        // Process the archive and return all entries (container + contents)
        return await processArchiveEntries(entry.path, rootPath, archiveEntry, config);
      }

      // Regular file, return as-is
      return [entry];
    })()
  ).pipe(
    catchError(error => {
      logger.error('Failed to process file entry', error as Error, {
        path: entry.path,
      });

      // Return the original entry with error information
      const errorEntry: FileEntry = {
        ...entry,
        extractionError: `File processing failed: ${(error as Error).message}`,
      };
      return of([errorEntry]);
    })
  );
}

// Types
export interface FileEntry {
  path: string;
  physical_size: number;
  content_size: number | null;
  mtime: number;
  isDirectory: boolean;
  isHidden: boolean;
  isSystem: boolean;
  // Archive preprocessing fields
  isArchiveContainer: boolean;
  archiveParentPath: string | null;
  archiveDepth: number;
  archiveFormat: string | null;
  extractionError: string | null;
}

export interface ScanConfig {
  rootPath: string;
  runId: string;
  includeHidden?: boolean; // Legacy parameter - all files are now cataloged with metadata flags
  batchSize?: number;
  // Archive preprocessing options
  enableArchiveProcessing?: boolean;
  maxArchiveDepth?: number;
  maxArchiveSize?: number; // in bytes
  archiveTimeoutMs?: number;
  enableArchiveNesting?: boolean;
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

        // NEW: Archive preprocessing step (only if enabled)
        mergeMap(entry => {
          if (config.enableArchiveProcessing !== false) {
            // Default to enabled
            const archiveConfig = getArchiveConfig(config);
            return processFileEntry(config.rootPath, entry, archiveConfig);
          }
          return of([entry]);
        }, 3), // Process up to 3 archives concurrently

        // Flatten the array of entries (each file might become multiple entries if it's an archive)
        mergeMap(entries => from(entries)),

        // Update progress accounting for archive entries
        tap(entry => {
          // Only count entries that weren't counted in the initial discovery
          if (entry.archiveParentPath) {
            filesDiscovered++;

            // Update progress every 100 archive entries
            if (filesDiscovered % 100 === 0) {
              logger.debug('Archive entries discovered', {
                totalDiscovered: filesDiscovered,
                archiveEntry: entry.path,
                runId: config.runId,
              });
              progressCallback?.(
                `found ${filesDiscovered.toLocaleString()} files (including archive contents)`
              );
            }
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
            physical_size: 0,
            content_size: null, // Directories don't have content_size
            mtime: 0,
            isDirectory: true,
            isHidden,
            isSystem,
            isArchiveContainer: false,
            archiveParentPath: null,
            archiveDepth: 0,
            archiveFormat: null,
            extractionError: null,
          };
        } else if (entry.isFile()) {
          try {
            const stats = await fsp.stat(fullPath);

            // Yield file immediately with metadata for flexible filtering
            yield {
              path: relativePath,
              physical_size: stats.size,
              content_size: stats.size, // For regular files, content_size = physical_size (will be updated for archives)
              mtime: Math.floor(stats.mtimeMs / 1000),
              isDirectory: false,
              isHidden,
              isSystem,
              isArchiveContainer: false, // Will be updated during archive processing
              archiveParentPath: null,
              archiveDepth: 0,
              archiveFormat: null,
              extractionError: null,
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
    physical_size: entry.physical_size,
    content_size: entry.content_size,
    mtime: entry.mtime,
    is_directory: entry.isDirectory,
    is_hidden: entry.isHidden,
    is_system: entry.isSystem,
    hash: null, // Hash calculated later if needed
    is_archive_container: entry.isArchiveContainer,
    archive_parent_path: entry.archiveParentPath,
    archive_depth: entry.archiveDepth,
    archive_format: entry.archiveFormat,
    extraction_error: entry.extractionError,
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
        size: files.content_size,
        fileCount: count(),
      })
      .from(files)
      .where(
        and(
          eq(files.run_id, runId),
          eq(files.is_directory, false), // Only files, exclude directories
          isNotNull(files.content_size) // Only files with content_size
        )
      )
      .groupBy(files.content_size)
      .having(gt(count(), 1)) // Only sizes with more than 1 file
  ).pipe(
    map(
      results =>
        results
          .map(r => r.size)
          .filter((s): s is number => s !== null)
          .sort((a, b) => b - a) // Sort by size descending (largest files first)
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
