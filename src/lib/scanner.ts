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
import type { OperatorFunction } from 'rxjs';
import { Observable, from, of, concat, firstValueFrom } from 'rxjs';
import {
  tap,
  map,
  bufferCount,
  bufferTime,
  finalize,
  switchMap,
  last,
  catchError,
  mergeMap,
} from 'rxjs/operators';
import {
  eq as _eq,
  and as _and,
  count as _count,
  gt as _gt,
  isNotNull as _isNotNull,
} from 'drizzle-orm';
import { logger } from '@lib/logging.ts';
import type { ProvisionalDir } from '@lib/job-context.ts';
import {
  cleanDatabase,
  insertFileBatch,
  rollupDirStatsBatch,
  populateDirStats,
  markEnumerated,
  getFrontierDirs,
  getEnumeratedDirs,
  getFrontierArchives,
  findDuplicateSizes,
  countRealDuplicateGroups,
  type DatabaseConnection,
  type FileRow,
  type FileSelect,
  files as _files,
} from '@lib/database.ts';
import { Frontier } from '@lib/frontier.ts';
import { listArchive } from 'streamarchive';
import { ensureStreamArchive } from '@lib/streamarchive-init.ts';
import { performHashing } from '@lib/hash-calculator.ts';
import { toLongPath, normalizePath } from '@lib/path-utils.ts';

// Archive Detection Constants
// prettier-ignore
const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.jar', '.war', '.ear',    // ZIP family
  '.7z',                             // 7-Zip
  '.rar',                            // RAR
  '.tar', '.tar.gz', '.tgz',         // TAR family
  '.tar.bz2', '.tbz2',               // TAR + bzip2
  '.tar.xz', '.txz',                 // TAR + xz
  '.tar.lz4', '.tar.lzma',           // TAR + LZ4/LZMA
  '.gz', '.bz2', '.xz', '.lz4', '.lzma', '.Z'  // Individual compression
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

    // Check magic numbers (extension filtering now done in isArchiveFile)
    const fd = await fsp.open(toLongPath(absolutePath), 'r');
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
 * Unified archive detection - single source of truth
 * Uses existing ARCHIVE_EXTENSIONS Set for consistent filtering
 */
async function detectArchive(
  filePath: string,
  allowMagicNumbers: boolean = true
): Promise<{ isArchive: boolean; format?: string }> {
  // STAGE 1: Use existing extension check - if NOT in our Set, skip entirely
  if (!isArchiveByExtension(filePath)) {
    return { isArchive: false };
  }

  // STAGE 2: Extension is in our allowed Set, get format
  const ext = path.extname(filePath).toLowerCase();
  const extWithoutDot = ext.slice(1);

  // Trust common extensions immediately
  const trustedExtensions = ['zip', 'jar', 'war', 'ear', '7z', 'rar', 'tar'];
  if (trustedExtensions.includes(extWithoutDot)) {
    return { isArchive: true, format: extWithoutDot };
  }

  // For compression formats, verify with magic number if allowed
  if (allowMagicNumbers) {
    const magicCheck = await isArchiveByMagicNumber(filePath);
    if (magicCheck.isArchive) {
      return magicCheck;
    }
  }

  // Extension is in our Set, trust it
  return { isArchive: true, format: extWithoutDot };
}

/**
 * Archive detection for top-level files (with magic number verification)
 */
export async function isArchiveFile(
  filePath: string
): Promise<{ isArchive: boolean; format?: string }> {
  return await detectArchive(filePath, true);
}

/**
 * Archive detection for nested files (extension-only, no file system access)
 */
function isArchiveByExtensionOnly(filePath: string): { isArchive: boolean; format?: string } {
  // Synchronous version - can't use await in this context
  const ext = path.extname(filePath).toLowerCase();

  // Use same logic - if NOT in Set, skip
  if (!ARCHIVE_EXTENSIONS.has(ext)) {
    return { isArchive: false };
  }

  const extWithoutDot = ext.slice(1);
  return { isArchive: true, format: extWithoutDot };
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
  // With streaming archive reading this cap is a TIME guard, not a memory one
  // (listing a seekable zip reads only its central directory; non-seekable formats
  // stream through a fixed buffer). The old 100MB default protected the
  // memory-based reader that loaded whole archives into RAM.
  maxArchiveSize: 10 * 1024 * 1024 * 1024, // 10 GiB
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

    // Streaming metadata listing: no data reads, constant memory. On a seekable zip
    // this is the central directory — fast and exact-sized even for multi-GB archives
    // (the previous memory-based port loaded the ENTIRE archive into RAM here).
    await ensureStreamArchive();
    const archiveEntries = await listArchive(toLongPath(absolutePath));

    let entryCount = 0;
    const maxEntries = 10000; // Bound the per-archive row count (DB pressure, not memory)

    for (const archiveEntry of archiveEntries) {
      if (entryCount >= maxEntries) {
        logger.warn('Archive has too many entries, stopping processing', {
          path: archivePath,
          processedEntries: entryCount,
          limit: maxEntries,
        });
        break;
      }

      // Stored names may carry a leading './' or backslashes depending on the
      // archiver; normalize to match the paths the rest of the pipeline uses.
      const entryPath = normalizePath(archiveEntry.path).replace(/^\.\//, '');
      const size = archiveEntry.size ?? 0;
      const isDirectory = archiveEntry.isDirectory || entryPath.endsWith('/');
      const modTime = archiveEntry.mtime || 0; // Unix seconds

      // Create relative path: archive.zip/path/to/file.txt
      const relativePath = `${entry.path}/${entryPath}`;

      const archiveFileEntry: FileEntry = {
        path: relativePath,
        physical_size: 0, // Files within archives have no physical footprint
        content_size: isDirectory ? null : size, // Decompressed size for files, null for directories
        mtime: modTime > 0 ? modTime : entry.mtime,
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

      // If this entry is also an archive and nesting is enabled, mark it (nested
      // archives are flagged as containers but their contents are not expanded).
      if (!isDirectory && config.enableNesting && entry.archiveDepth + 1 < config.maxDepth) {
        const archiveCheck = isArchiveByExtensionOnly(entryPath);
        if (archiveCheck.isArchive) {
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
  config: ArchiveProcessingConfig,
  // Frontier producer signal for archives: an archive container is an enumeration unit
  // whose children are its entries. Announce its exact child count once expanded, so the
  // Frontier can stamp it when those entries commit (and stamp nested-but-unexpanded
  // containers with 0 so they never sit on the frontier).
  onUnitComplete?: (unit: string, count: number) => void
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
        const results = await processArchiveEntries(entry.path, rootPath, archiveEntry, config);
        if (onUnitComplete) {
          // results[0] is the container itself (belongs to its parent dir); results[1..]
          // are its inner entries, all with archive_parent_path === entry.path.
          onUnitComplete(entry.path, results.length - 1);
          // Nested archive containers are detected but NOT expanded — stamp them done (0
          // children) so they don't linger on the frontier and trigger futile re-reads.
          for (const r of results) {
            if (r.isArchiveContainer && r.path !== entry.path) onUnitComplete(r.path, 0);
          }
        }
        return results;
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
  archiveConcurrency?: number;
  enableArchiveNesting?: boolean;
  /**
   * Read-priority hook called between write batches (ingestion + hashing). Set ONLY
   * by the single-owner session, which provides a function that yields to any
   * in-flight reads before the next batch — so concurrent reads aren't starved
   * (PGlite blocks the JS thread and its queue is FIFO, so without this a dense
   * write loop monopolises the connection). Its presence also drops ingestion to
   * concurrency 1 (sequential batches, clean yield points). Absent → standalone
   * scan runs at full write throughput.
   */
  betweenBatches?: () => Promise<void>;
  /**
   * The connection is owned by a long-lived session (shared with live readers), so
   * the scan must clear data in place rather than close + delete + recreate the
   * datadir. Set together with betweenBatches for the single-owner session.
   */
  preserveConnection?: boolean;
  /**
   * Resume an interrupted scan instead of starting fresh: KEEP the existing `files`
   * rows (so discovery's onConflictDoNothing skips them and hashing's `WHERE hash IS
   * NULL` picks up exactly where it stopped) and only clear `dir_stats` — the re-walk
   * emits every file once, so the incremental rollup rebuilds dir_stats correctly with
   * no double-count. Requires the SAME runId as the partial data. Owner mode only
   * (set with preserveConnection).
   */
  resume?: boolean;
  /**
   * Resumable DISCOVERY (Phase 7 increment 2). When set, every enumeration unit (a
   * directory, or an archive container) is stamped `enumerated_at` once all its children
   * commit, so a resume re-lists ONLY the un-stamped frontier instead of re-walking the
   * whole tree (decisive on slow NAS/cloud mounts). Flag-gated and PARALLEL to the legacy
   * walk: when unset, discovery behaves exactly as before. Pairs with `resume` to make
   * resume cheap; on a fresh scan it just maintains the marks (≈free per the bench).
   */
  frontier?: boolean;
  /**
   * Cooperative pause gate, polled by the walker before it pops each directory. Returns
   * true to keep going, false to stop pulling NEW work (in-flight readdir/stat drain).
   * Set by the owner session's pause/resume control channel. Absent → never pauses.
   */
  shouldContinue?: () => boolean;
  /**
   * Enumerate directories concurrently (increment 3b). >1 turns the sequential walk into a
   * bounded worker pool — the lever for high-latency NAS/cloud mounts, where enumeration is
   * round-trip-bound and concurrency divides the wall-clock. Default 1 (sequential, legacy
   * behaviour untouched); the owner session sets 16. Resumability/correctness are unaffected
   * (the frontier reconciler is order-independent); the only effect is a wider but still
   * cheap crash-replay set (~concurrency dirs).
   */
  enumerateConcurrency?: number;
}

export interface ScanResult {
  phase: 'complete';
  filesDiscovered: number;
  filesIngested: number;
  duplicateGroups: number;
}

/**
 * Structured progress event for real-time UI updates
 */
export type ScanPhase =
  | 'discovery'
  | 'ingestion'
  | 'prefilter'
  | 'hashing'
  | 'duplicate-detection'
  | 'complete';

export interface ScanProgressEvent {
  type: 'scan-progress';
  phase: ScanPhase;
  filesDiscovered: number;
  filesIngested: number;
  filesHashed?: number;
  filesToHash?: number;
  hashErrors?: number;
  duplicateSizes?: number;
  duplicateGroups: number;
  status: string;
}

// Scanner progress → canonical job:progress {processed, total}. Phase-aware:
// hashing counts checksums, every other phase counts discovered files.
export function scanProgressMetrics(e: ScanProgressEvent): {
  processed: number;
  total: number | null;
} {
  if (e.phase === 'hashing') {
    return { processed: e.filesHashed ?? 0, total: e.filesToHash ?? null };
  }
  return { processed: e.filesDiscovered, total: null };
}

/**
 * Main scanning function
 */
export function scanDirectory(
  connection: DatabaseConnection,
  config: ScanConfig,
  progressCallback?: (event: ScanProgressEvent) => void,
  treeCallback?: (directories: ProvisionalDir[]) => void
): Observable<ScanResult> {
  let filesDiscovered = 0;
  let filesIngested = 0;
  let duplicateGroups = 0;
  let duplicateSizesCount = 0;

  const emitProgress = (phase: ScanPhase, status: string, extra?: Partial<ScanProgressEvent>) => {
    progressCallback?.({
      type: 'scan-progress',
      phase,
      filesDiscovered,
      filesIngested,
      duplicateGroups,
      status,
      ...extra,
    });
  };

  // Shallow, depth-capped provisional directory aggregate, emitted (throttled)
  // during ingestion so the UI can grow a live icicle without reading the DB.
  const PROVISIONAL_DEPTH_CAP = 4;
  const PROVISIONAL_THROTTLE_MS = 750;
  const provisionalDirs = new Map<
    string,
    { total_size: number; file_count: number; dir_count: number }
  >();
  let lastTreeEmit = 0;

  const ensureDir = (p: string) => {
    let agg = provisionalDirs.get(p);
    if (!agg) {
      agg = { total_size: 0, file_count: 0, dir_count: 0 };
      provisionalDirs.set(p, agg);
    }
    return agg;
  };

  const accumulate = (row: FileRow) => {
    const parts = row.path.split('/').filter(Boolean);
    if (parts.length === 0) return;
    if (row.is_directory) {
      if (parts.length <= PROVISIONAL_DEPTH_CAP) ensureDir(parts.join('/'));
      if (parts.length >= 2 && parts.length - 1 <= PROVISIONAL_DEPTH_CAP) {
        ensureDir(parts.slice(0, parts.length - 1).join('/')).dir_count += 1;
      }
    } else {
      const size = row.physical_size ?? 0;
      const maxDepth = Math.min(parts.length - 1, PROVISIONAL_DEPTH_CAP);
      for (let d = 1; d <= maxDepth; d++) {
        const agg = ensureDir(parts.slice(0, d).join('/'));
        agg.total_size += size;
        agg.file_count += 1;
      }
    }
  };

  const emitTree = () => {
    if (!treeCallback) return;
    treeCallback(
      [...provisionalDirs.entries()].map(([path, a]) => ({
        path,
        total_size: a.total_size,
        file_count: a.file_count,
        dir_count: a.dir_count,
      }))
    );
  };
  const maybeEmitTree = () => {
    if (!treeCallback) return;
    const now = Date.now();
    if (now - lastTreeEmit >= PROVISIONAL_THROTTLE_MS) {
      lastTreeEmit = now;
      emitTree();
    }
  };

  // ── Resumable-discovery frontier (increment 2) ──────────────────────────────
  const FLUSH_T_MS = 500; // hybrid flush time cap — sim-derived, non-critical (see spec §4)
  const ROW_CAP = config.batchSize || 1000;
  const frontier = config.frontier ? new Frontier() : undefined;
  // Incremental dir_stats rollup gives the live tree during a FRESH owner scan. On a
  // FRONTIER RESUME we deliberately DON'T re-walk already-enumerated subtrees, so the
  // rollup can't observe them — instead dir_stats is recomputed once at the end from the
  // full `files` table (populateDirStats). Non-frontier resume still re-walks everything,
  // so it keeps the incremental rollup.
  const incrementalRollup = !!config.betweenBatches && !(config.frontier && config.resume);
  const finalPopulate = !!config.frontier && !!config.resume;
  // Hybrid flush (ROW_CAP rows OR FLUSH_T_MS) on the frontier path; the legacy fixed-count
  // batching on the default path, byte-for-byte unchanged.
  const bufferOp: OperatorFunction<FileRow, FileRow[]> = config.frontier
    ? bufferTime<FileRow>(FLUSH_T_MS, null, ROW_CAP)
    : bufferCount<FileRow>(ROW_CAP);
  // Concurrent enumeration (increment 3b). The backpressure gate keeps the
  // discovered-but-not-yet-ingested backlog bounded so a fast walker can't pile entries up
  // in memory ahead of PGlite ingestion.
  const enumerateConcurrency = Math.max(1, config.enumerateConcurrency ?? 1);
  const ENUMERATE_HIGH_WATER = 50_000;
  const canEnumerate = () => filesDiscovered - filesIngested < ENUMERATE_HIGH_WATER;

  // A DB archive-container row → a synthetic FileEntry that re-expands when fed through
  // processFileEntry (isArchiveContainer:false forces the archive path, not the skip).
  const archiveRowToEntry = (row: FileSelect): FileEntry => ({
    path: row.path,
    physical_size: row.physical_size,
    content_size: row.content_size,
    mtime: row.mtime,
    isDirectory: false,
    isHidden: row.is_hidden,
    isSystem: row.is_system,
    isArchiveContainer: false,
    archiveParentPath: row.archive_parent_path,
    archiveDepth: row.archive_depth ?? 0,
    archiveFormat: row.archive_format,
    extractionError: null,
  });

  // Resume seed (frontier only). Returns empty on fresh/non-frontier scans, so the walk
  // starts from root exactly as before.
  const loadFrontierSeed = async (): Promise<{
    seedDirs: string[];
    enumeratedDirs: Set<string>;
    archiveEntries: FileEntry[];
  }> => {
    if (!config.frontier || !config.resume) {
      return { seedDirs: [], enumeratedDirs: new Set(), archiveEntries: [] };
    }
    const [seedDirs, enumDirs, archiveRows] = await Promise.all([
      firstValueFrom(getFrontierDirs(connection, config.runId)),
      firstValueFrom(getEnumeratedDirs(connection, config.runId)),
      firstValueFrom(getFrontierArchives(connection, config.runId)),
    ]);
    // Re-expand only top-level archives; a nested archive can't be re-read standalone and
    // is already stamped (0 children) at creation, so it shouldn't appear here anyway.
    const archiveEntries = archiveRows.filter(r => !r.archive_parent_path).map(archiveRowToEntry);
    logger.debug('Frontier resume seed loaded', {
      runId: config.runId,
      frontierDirs: seedDirs.length,
      enumeratedDirs: enumDirs.length,
      frontierArchives: archiveEntries.length,
    });
    return { seedDirs, enumeratedDirs: new Set(enumDirs), archiveEntries };
  };

  // Phase 1: Clean database first (hot observable, no defer). On resume this keeps the
  // partial files and only clears dir_stats (frontier resume rebuilds it via populateDirStats).
  return cleanDatabase(connection, config.runId, config.preserveConnection, config.resume).pipe(
    tap(() =>
      logger.debug('Database cleaned', {
        runId: config.runId,
        resume: config.resume,
        frontier: config.frontier,
      })
    ),

    // Frontier resume: dir_stats was just cleared and the already-enumerated subtrees won't
    // be re-walked, so the live icicle would stay blank until the final populate at the end.
    // Populate ONCE from the partial `files` now so the chart shows the ~done tree right
    // away; the walk's remainder + the final populate fill in the rest. SEQUENCED before the
    // walk (awaited, not fire-and-forget) — a fire-and-forget populate can land AFTER the
    // final one and clobber it with stale partial aggregates.
    switchMap(v =>
      finalPopulate
        ? from(populateDirStats(connection, config.runId)).pipe(
            map(() => v),
            catchError((err: unknown) => {
              logger.warn('resume start populate failed', {
                runId: config.runId,
                error: (err as Error).message,
              });
              return of(v);
            })
          )
        : of(v)
    ),

    // Load the resume frontier seed (no-op on fresh scans), then stream discovery.
    switchMap(() => from(loadFrontierSeed())),

    // Phase 2-3: Streaming discovery + immediate ingestion (hot observable)
    switchMap(seed => {
      // Resume: the frontier dirs' own rows are durable from the prior run but won't be
      // re-emitted (their parents are done), so tell the Frontier they're self-committed.
      if (frontier && seed.seedDirs.length) frontier.seedSelfCommitted(seed.seedDirs);
      const walkOpts: WalkOptions = {
        shouldContinue: config.shouldContinue,
        ...(frontier
          ? {
              onDirComplete: (rel: string, n: number) => frontier.unitComplete(rel, n),
              seedDirs: seed.seedDirs,
              enumeratedDirs: seed.enumeratedDirs,
            }
          : {}),
      };
      // Concurrent worker pool for high-latency mounts (3b), else the legacy sequential
      // generator (default, byte-for-byte unchanged).
      const walkerEntries =
        enumerateConcurrency > 1
          ? walkFilesConcurrent(
              config.rootPath,
              config.includeHidden,
              walkOpts,
              enumerateConcurrency,
              canEnumerate
            )
          : from(walkFilesGenerator(config.rootPath, config.includeHidden, walkOpts));
      // On resume, re-expand un-enumerated archives by feeding synthetic container entries
      // AFTER the walk (they re-expand even when their parent dir is already enumerated).
      const discovery = seed.archiveEntries.length
        ? concat(walkerEntries, from(seed.archiveEntries))
        : walkerEntries;

      return discovery.pipe(
        tap(_entry => {
          filesDiscovered++;

          // Live progress updates every 100 files or first file
          if (filesDiscovered % 500 === 0 || filesDiscovered === 1) {
            logger.debug('Calling progress callback', {
              filesDiscovered,
              runId: config.runId,
            });
            emitProgress('discovery', `found ${filesDiscovered.toLocaleString()} files`);
          }
        }),

        // Archive preprocessing step (only if enabled) + flatten in one step
        mergeMap(entry => {
          if (config.enableArchiveProcessing !== false) {
            const archiveConfig = getArchiveConfig(config);
            return processFileEntry(
              config.rootPath,
              entry,
              archiveConfig,
              frontier ? (u, c) => frontier.unitComplete(u, c) : undefined
            ).pipe(mergeMap(entries => from(entries)));
          }
          return of(entry);
        }, config.archiveConcurrency ?? 7),

        // Update progress accounting for archive entries
        tap(entry => {
          // Only count entries that weren't counted in the initial discovery
          if (entry.archiveParentPath) {
            filesDiscovered++;

            // Update progress every 500 archive entries
            if (filesDiscovered % 500 === 0) {
              logger.debug('Archive entries discovered', {
                totalDiscovered: filesDiscovered,
                archiveEntry: entry.path,
                runId: config.runId,
              });
              emitProgress(
                'discovery',
                `found ${filesDiscovered.toLocaleString()} files (including archive contents)`
              );
            }
          }
        }),

        // Convert to database row format
        map(entry => toFileRow(config.runId, entry)),

        // Feed the provisional (live) directory aggregate, throttled emit
        tap(row => {
          if (treeCallback) {
            accumulate(row);
            maybeEmitTree();
          }
        }),

        // Batch for efficient database writes (hybrid flush on the frontier path)
        bufferOp,

        // Insert batches with limited concurrency (PGlite handles concurrent writes).
        // With betweenBatches set (single-owner session) we drop to concurrency 1 and
        // run the read-priority hook after each batch, so a concurrent reader in the
        // same process is served between batches instead of being starved.
        mergeMap(
          batch =>
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
                  emitProgress('ingestion', `ingested ${filesIngested.toLocaleString()} files`);
                }
              }),
              // Incremental, DB-central dir_stats maintenance (owner mode only): fold
              // this batch into the per-directory aggregates so the icicle can read the
              // tree LIVE from the DB and dir_stats is fully materialized by completion
              // (no one-shot populateDirStats spike). Own catchError so a rollup hiccup
              // never fails the batch. O(batch) — independent of table size.
              incrementalRollup
                ? mergeMap((inserted: number) =>
                    from(rollupDirStatsBatch(connection, config.runId, batch)).pipe(
                      map(() => inserted),
                      catchError(err => {
                        logger.warn('dir_stats rollup failed for batch', {
                          runId: config.runId,
                          error: (err as Error).message,
                        });
                        return of(inserted);
                      })
                    )
                  )
                : tap(),
              // Frontier: stamp every unit whose children are now ALL committed, in a txn
              // AFTER this (successful) insert. A failed batch emits 0 → we skip tallying
              // and stamping, so its units stay on the frontier and replay.
              //
              // Deliberately a SEPARATE txn from the insert, not folded in: `rowsCommitted`
              // tallies committed children, and it must run only AFTER the insert COMMITS —
              // folding the stamp into the insert txn would force tallying before commit
              // confirmation and leave the in-memory frontier inconsistent on a rollback.
              // Strictly-after is safe (children are durable before the stamp); the worst a
              // crash in the gap costs is re-walking a handful of dirs on resume.
              //
              // Marks are confirmed only once the stamp UPDATE itself commits; on failure
              // they're requeued so the next drain retries (no silent re-walk on next resume).
              frontier
                ? mergeMap((inserted: number) => {
                    if (inserted <= 0) return of(inserted);
                    frontier.rowsCommitted(batch);
                    const marks = frontier.takeReady();
                    if (!marks.length) return of(inserted);
                    return from(markEnumerated(connection, config.runId, marks)).pipe(
                      map(() => {
                        frontier.confirm(marks);
                        return inserted;
                      }),
                      catchError(err => {
                        frontier.requeue(marks);
                        logger.warn('markEnumerated failed for batch', {
                          runId: config.runId,
                          error: (err as Error).message,
                        });
                        return of(inserted);
                      })
                    );
                  })
                : tap(),
              catchError(error => {
                logger.error('Failed to insert batch', error as Error, {
                  runId: config.runId,
                  batchSize: batch.length,
                });
                return from([0]); // Continue processing
              }),
              config.betweenBatches
                ? mergeMap((n: number) => from(config.betweenBatches!()).pipe(map(() => n)))
                : tap()
            ),
          // Frontier mode REQUIRES concurrency 1: the reconciler's `rowsCommitted` tally is
          // mutated here per batch and is not safe under interleaving. Tie it to `frontier`
          // directly (not just `betweenBatches`) so the safety is explicit, not incidental.
          config.frontier || config.betweenBatches ? 1 : 2
        ),

        // Final ingestion update
        finalize(() => {
          logger.debug('File ingestion completed', {
            runId: config.runId,
            filesDiscovered,
            filesIngested,
          });
          emitProgress('ingestion', `ingested ${filesIngested.toLocaleString()} files`);
          emitTree(); // force a final provisional snapshot (full structure so far)
        })
      );
    }),

    // Phase 4: Prefilter after ingestion completes
    last(), // Wait for ingestion to complete

    // Frontier: drain any straggler marks (units whose producer-completion landed after
    // their last child committed, with no further batch to flush them). Confirm on success;
    // on failure leave them un-stamped → re-walked on the next resume (the safe fallback).
    switchMap(v => {
      if (!frontier) return of(v);
      const marks = frontier.takeReady();
      if (!marks.length) return of(v);
      return from(markEnumerated(connection, config.runId, marks)).pipe(
        map(() => {
          frontier.confirm(marks);
          return v;
        }),
        catchError(() => {
          frontier.requeue(marks);
          return of(v);
        })
      );
    }),

    // Frontier resume: dir_stats was cleared and NOT incrementally rolled up (we skipped
    // the done subtrees), so recompute it once now from the full files table.
    switchMap(v =>
      finalPopulate
        ? from(populateDirStats(connection, config.runId)).pipe(
            map(() => v),
            catchError(() => of(v))
          )
        : of(v)
    ),

    switchMap(() => findDuplicateSizes(connection, config.runId)),
    tap(duplicateSizes => {
      logger.debug('Prefilter found potential duplicate sizes', {
        duplicateSizeCount: duplicateSizes.length,
        runId: config.runId,
      });
      duplicateSizesCount = duplicateSizes.length;
      emitProgress('prefilter', `found ${duplicateSizes.length} sizes with potential duplicates`, {
        duplicateSizes: duplicateSizes.length,
      });
    }),

    // Phase 5: Hash calculation for files with duplicate content_size
    switchMap(() =>
      performHashing(
        {
          database: connection,
          runId: config.runId,
          rootPath: config.rootPath,
          betweenBatches: config.betweenBatches,
        },
        (processed, total, errors) => {
          if (processed % 100 === 0 || processed === total) {
            const percentage = total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0';
            const status = `hashed ${processed.toLocaleString()}/${total.toLocaleString()} files (${percentage}%)`;
            emitProgress('hashing', errors > 0 ? `${status}, ${errors} errors` : status, {
              filesHashed: processed,
              filesToHash: total,
              hashErrors: errors,
              duplicateSizes: duplicateSizesCount,
            });
          }
        }
      )
    ),

    // Phase 6: Real duplicate detection by hash
    switchMap(() => countRealDuplicateGroups(connection, config.runId)),
    tap(realDuplicateGroups => {
      duplicateGroups = realDuplicateGroups;
      logger.debug('Real duplicate detection completed', {
        duplicateGroups: realDuplicateGroups,
        runId: config.runId,
      });
      emitProgress('duplicate-detection', `found ${realDuplicateGroups} real duplicate groups`, {
        duplicateSizes: duplicateSizesCount,
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
  ) as Observable<ScanResult>;
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
 * Options that turn the plain walk into a resumable, pausable, frontier-aware one. All
 * optional — with none of them set the walker behaves byte-for-byte like the original
 * (fresh full DFS, no callbacks), so the legacy scan path is untouched.
 */
interface WalkOptions {
  /** Called after a directory's readdir loop completes, with its relative path and the
   *  exact number of child entries emitted — the producer signal the Frontier needs to
   *  know when the directory's children are all accounted for. */
  onDirComplete?: (relDir: string, childCount: number) => void;
  /** Resume: relative directory paths still on the frontier, seeded onto the stack in
   *  addition to root, so we re-list exactly the unfinished directories. */
  seedDirs?: string[];
  /** Resume: relative paths of already-enumerated directories. A subdirectory found while
   *  re-listing is re-pushed ONLY if it is not in here — so completed subtrees are never
   *  re-walked even though their (frontier) parent is being re-listed. */
  enumeratedDirs?: Set<string>;
  /** Cooperative pause: polled before popping each directory. false → stop pulling new
   *  work (the generator returns; in-flight ops have already drained). */
  shouldContinue?: () => boolean;
}

/**
 * Enumerate ONE directory: readdir + stat + classify its entries. The shared core of both
 * the sequential generator and the concurrent worker pool (so the classification rules
 * live in exactly one place). Pure of any emit mechanism — returns the entries to emit and
 * the absolute subdirectory paths to enqueue. Mutates `queued` (cross-call dedup) and
 * honours `enumeratedDirs` (resume skip-set). Never throws — an unreadable dir/file is
 * logged and contributes nothing (so a dir's child count stays exact).
 */
async function enumerateDir(
  rootPath: string,
  currentDir: string,
  enumeratedDirs: Set<string> | undefined,
  queued: Set<string>
): Promise<{ emitted: FileEntry[]; pushDirs: string[] }> {
  const emitted: FileEntry[] = [];
  const pushDirs: string[] = [];
  try {
    const entries = await fsp.readdir(toLongPath(currentDir), { withFileTypes: true });
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
        // Enqueue — but on resume, never re-walk an already-enumerated subtree, and never
        // queue the same dir twice. (Fresh scan: both sets empty/trivial, so every subdir
        // is enqueued exactly once, as before.)
        if (!(enumeratedDirs && enumeratedDirs.has(relativePath)) && !queued.has(relativePath)) {
          queued.add(relativePath);
          pushDirs.push(fullPath);
        }
        emitted.push({
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
        });
      } else if (entry.isFile()) {
        try {
          const stats = await fsp.stat(toLongPath(fullPath));
          emitted.push({
            path: relativePath,
            physical_size: stats.size,
            content_size: stats.size, // For regular files, content_size = physical_size (updated for archives)
            mtime: Math.floor(stats.mtimeMs / 1000),
            isDirectory: false,
            isHidden,
            isSystem,
            isArchiveContainer: false, // Will be updated during archive processing
            archiveParentPath: null,
            archiveDepth: 0,
            archiveFormat: null,
            extractionError: null,
          });
        } catch (error) {
          logger.warn('Cannot access file', { path: fullPath, error: (error as Error).message });
        }
      }
    }
  } catch (error) {
    logger.warn('Cannot access directory', {
      path: currentDir,
      error: (error as Error).message,
    });
  }
  return { emitted, pushDirs };
}

/** Seed the walk stack: root first, then (on resume) every still-un-enumerated frontier
 *  directory. Returns the `queued` dedup set pre-populated so re-finding a seeded dir while
 *  re-listing its parent doesn't double-walk it. */
function seedWalk(rootPath: string, seedDirs?: string[]): { stack: string[]; queued: Set<string> } {
  const stack: string[] = [rootPath];
  const queued = new Set<string>(['']); // '' = root rel
  if (seedDirs) {
    for (const rel of seedDirs) {
      if (rel && !queued.has(rel)) {
        queued.add(rel);
        stack.push(path.join(rootPath, rel));
      }
    }
  }
  return { stack, queued };
}

/**
 * Simple file walker like ArchiScan - stack-based approach (not recursive)
 * Yields files immediately as discovered for streaming processing
 * Catalogs ALL files with metadata flags for flexible filtering later
 *
 * Sequential (concurrency 1). The default/legacy path — behaviour is byte-for-byte as
 * before. For concurrent enumeration (increment 3b) see walkFilesConcurrent.
 */
async function* walkFilesGenerator(
  rootPath: string,
  _includeHidden = false,
  opts: WalkOptions = {}
): AsyncGenerator<FileEntry> {
  const { onDirComplete, seedDirs, enumeratedDirs, shouldContinue } = opts;
  const { stack, queued } = seedWalk(rootPath, seedDirs);

  while (stack.length > 0) {
    // Pause: stop pulling NEW directories. Any readdir/stat already issued has resolved
    // by the time we're back at the top of the loop, so this is the clean stop point.
    if (shouldContinue && !shouldContinue()) return;

    const currentDir = stack.pop()!;
    const currentRel = path.relative(rootPath, currentDir).replace(/\\/g, '/');
    const { emitted, pushDirs } = await enumerateDir(rootPath, currentDir, enumeratedDirs, queued);
    for (const d of pushDirs) stack.push(d);
    for (const e of emitted) yield e;

    // Producer completion signal: this directory's children are all emitted. The Frontier
    // stamps it enumerated once that many children have also COMMITTED.
    onDirComplete?.(currentRel, emitted.length);
  }
}

/**
 * Concurrent file walker (increment 3b) — a bounded worker pool over the SAME frontier
 * stack, so up to `concurrency` directories are readdir+stat'd at once. This is the lever
 * for high-latency backends: enumeration cost is round-trips × latency ÷ concurrency, so a
 * NAS/cloud scan that is minutes/hours sequential becomes seconds/minutes. Correctness is
 * unchanged because the Frontier reconciler is ORDER-INDEPENDENT (each row carries its unit
 * key) — concurrent, out-of-order emission still stamps every unit exactly when its
 * children commit.
 *
 * `canEnumerate` is the backpressure gate: discovery must not outrun ingestion and pile up
 * unbounded entries in memory (PGlite-is-the-centre). When it returns false the pool stops
 * launching new directories until ingestion drains. Pause (`shouldContinue` false) stops
 * launching and completes once in-flight directories drain; unsubscribe tears down at once.
 */
function walkFilesConcurrent(
  rootPath: string,
  _includeHidden: boolean | undefined,
  opts: WalkOptions,
  concurrency: number,
  canEnumerate?: () => boolean
): Observable<FileEntry> {
  return new Observable<FileEntry>(subscriber => {
    const { onDirComplete, seedDirs, enumeratedDirs, shouldContinue } = opts;
    const { stack, queued } = seedWalk(rootPath, seedDirs);
    let active = 0;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // Auto-ramp the launch concurrency on MEASURED per-FS-op latency (no mount-type
    // detection): stay near the floor on a fast local disk — there's no round-trip to hide,
    // so extra concurrency is just overhead — and climb toward the cap on a slow NAS/cloud
    // mount, where overlapping the latency is the whole game. The `concurrency` arg is the CAP.
    const FLOOR = 4;
    let ewmaOpMs = 0; // EWMA of per-op (readdir + per-file stat) wall-time, ms
    const target = (): number =>
      ewmaOpMs === 0
        ? Math.min(8, concurrency) // initial, until we have a latency measure
        : Math.max(FLOOR, Math.min(concurrency, Math.round(FLOOR + ewmaOpMs)));

    const launch = (currentDir: string): void => {
      active++;
      const currentRel = path.relative(rootPath, currentDir).replace(/\\/g, '/');
      const startedAt = performance.now();
      void enumerateDir(rootPath, currentDir, enumeratedDirs, queued)
        .then(({ emitted, pushDirs }) => {
          // per-op latency ≈ this dir's wall-time / (readdir + one stat per entry) → feed
          // the ramp so concurrency tracks the mount's actual round-trip cost.
          const perOp = (performance.now() - startedAt) / (emitted.length + 1);
          ewmaOpMs = ewmaOpMs === 0 ? perOp : ewmaOpMs * 0.8 + perOp * 0.2;
          if (closed) return;
          for (const d of pushDirs) stack.push(d);
          for (const e of emitted) subscriber.next(e);
          onDirComplete?.(currentRel, emitted.length);
        })
        .finally(() => {
          active--;
          if (!closed) pump();
        });
    };

    const pump = (): void => {
      if (closed) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      // Pause: stop launching new directories; complete once in-flight drains.
      const paused = shouldContinue ? !shouldContinue() : false;
      if (!paused) {
        while (active < target() && stack.length > 0 && (!canEnumerate || canEnumerate())) {
          launch(stack.pop()!);
        }
      }
      // Done when nothing is in flight and either the stack is empty or we're paused.
      if (active === 0 && (stack.length === 0 || paused)) {
        closed = true;
        subscriber.complete();
        return;
      }
      // Backpressure (or pause) with work still queued but nothing in flight to re-trigger
      // pump on completion → poll until the gate reopens.
      if (active === 0 && stack.length > 0) {
        retryTimer = setTimeout(pump, 10);
      }
    };

    pump();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  });
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
    const stats = await fsp.stat(toLongPath(resolvedPath));

    if (!stats.isDirectory()) {
      return { valid: false, error: 'Path is not a directory' };
    }

    await fsp.access(toLongPath(resolvedPath));

    return { valid: true, resolvedPath };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
