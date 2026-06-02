/**
 * File Reader - Archive-Aware File Content Access
 *
 * Provides a unified interface for reading file content from both the filesystem
 * and archive entries. Returns streams wrapped in RxJS Observables for efficient
 * composition in streaming pipelines.
 *
 * Key features:
 * - Transparent handling of regular files and archive entries
 * - Stream-based API for memory efficiency with large files
 * - RxJS Observable integration for pipeline composition
 * - Cross-platform path normalization
 *
 * Usage:
 *   createFileContentStream(rootPath, entry).pipe(
 *     switchMap(stream => processStream(stream))
 *   )
 */

import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import type { Observable } from 'rxjs';
import { defer, from } from 'rxjs';
import { ArchiveReader } from 'libarchive-wasm';
import { initializeLibarchiveWasm } from '@lib/libarchive-init.ts';
import { logger } from '@lib/logging.ts';
import {
  normalizePath,
  toSystemPath,
  getArchiveRelativePath,
  pathEquals,
  toLongPath,
} from '@lib/path-utils.ts';

// === Types ===

/**
 * Represents a file entry that may be either a regular filesystem file
 * or an entry inside an archive.
 */
export interface FileEntry {
  /** Relative path from the scan root */
  path: string;
  /** If set, this file is inside an archive at this path */
  archiveParentPath?: string | null;
  /** Archive format (zip, tar, 7z, etc.) - only set for archive entries */
  archiveFormat?: string | null;
}

/**
 * Result of reading file content
 */
export interface FileContentResult {
  /** The readable stream containing file content */
  stream: Readable;
  /** Whether this content came from an archive */
  isFromArchive: boolean;
  /** The original file entry */
  entry: FileEntry;
}

// === Archive Extraction ===

/**
 * Extract file content from an archive as a Buffer.
 * Uses libarchive-wasm for cross-platform archive support.
 *
 * @param rootPath - Root path of the scan
 * @param archiveParentPath - Path to the archive file (relative to root)
 * @param relativePath - Path of the entry within the archive
 * @returns Buffer containing the file content
 */
export async function extractFromArchive(
  rootPath: string,
  archiveParentPath: string,
  relativePath: string
): Promise<Buffer> {
  const archivePath = path.join(rootPath, toSystemPath(archiveParentPath));

  logger.debug('Extracting file from archive', {
    archivePath,
    relativePath,
  });

  const archiveBuffer = await fs.readFile(toLongPath(archivePath));

  // Initialize libarchive WASM
  const mod = await initializeLibarchiveWasm();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new ArchiveReader(mod as any, new Int8Array(archiveBuffer));

  try {
    // Get the path within the archive using proper normalization
    const targetPath = getArchiveRelativePath(relativePath, archiveParentPath);

    for (const entry of reader.entries()) {
      if (entry && typeof entry.getPathname === 'function') {
        const entryPath = normalizePath(entry.getPathname());
        const normalizedTarget = normalizePath(targetPath);

        if (pathEquals(entryPath, normalizedTarget)) {
          const filetype = entry.getFiletype?.() || 'File';
          if (filetype !== 'Directory' && !entryPath.endsWith('/')) {
            // Hybrid approach: trust non-zero metadata, always verify 0-byte files
            const reportedSize = entry.getSize() || 0;

            if (reportedSize === 0) {
              // Don't trust 0-byte metadata - always extract to verify
              const content = entry.readData();
              return Buffer.from(content || []);
            } else {
              // Trust non-zero metadata, extract normally
              const content = entry.readData();
              if (content) {
                return Buffer.from(content);
              }
              throw new Error(`Could not extract content for ${targetPath}`);
            }
          }
          throw new Error(`Entry ${targetPath} is not a file`);
        }
      }
    }

    throw new Error(`File ${targetPath} not found in archive ${archiveParentPath}`);
  } finally {
    reader.free();
  }
}

// === Stream Creation ===

/**
 * Create a readable stream for a file entry.
 * Handles both regular filesystem files and archive entries transparently.
 *
 * For regular files: Returns a native file read stream (memory efficient)
 * For archive entries: Extracts content to buffer, then creates stream from it
 *
 * @param rootPath - Root path of the scan
 * @param entry - File entry (may be regular file or archive entry)
 * @returns Promise resolving to a Readable stream
 */
export async function createFileStream(rootPath: string, entry: FileEntry): Promise<Readable> {
  if (entry.archiveParentPath) {
    // Archive entry - extract and create stream from buffer
    logger.debug('Creating stream from archive entry', {
      path: entry.path,
      archive: entry.archiveParentPath,
      format: entry.archiveFormat,
    });

    const buffer = await extractFromArchive(rootPath, entry.archiveParentPath, entry.path);

    return Readable.from(buffer);
  } else {
    // Regular filesystem file - return native file stream
    const systemPath = toSystemPath(entry.path);
    const fullPath = path.join(rootPath, systemPath);

    logger.debug('Creating stream from filesystem', {
      path: entry.path,
      fullPath,
    });

    return createReadStream(toLongPath(fullPath));
  }
}

/**
 * Create a readable stream wrapped in an RxJS Observable.
 * This is the primary API for use in RxJS pipelines.
 *
 * @param rootPath - Root path of the scan
 * @param entry - File entry (may be regular file or archive entry)
 * @returns Observable that emits a Readable stream
 *
 * @example
 * createFileContentStream(rootPath, entry).pipe(
 *   switchMap(stream => new Observable(subscriber => {
 *     const hash = createHash('sha256');
 *     stream.on('data', chunk => hash.update(chunk));
 *     stream.on('end', () => {
 *       subscriber.next(hash.digest('hex'));
 *       subscriber.complete();
 *     });
 *     stream.on('error', err => subscriber.error(err));
 *   }))
 * )
 */
export function createFileContentStream(rootPath: string, entry: FileEntry): Observable<Readable> {
  return defer(() => from(createFileStream(rootPath, entry)));
}

/**
 * Create a detailed file content result wrapped in an RxJS Observable.
 * Includes metadata about the source (archive vs filesystem).
 *
 * @param rootPath - Root path of the scan
 * @param entry - File entry (may be regular file or archive entry)
 * @returns Observable that emits a FileContentResult
 */
export function createFileContentResult(
  rootPath: string,
  entry: FileEntry
): Observable<FileContentResult> {
  return defer(async () => {
    const stream = await createFileStream(rootPath, entry);
    return {
      stream,
      isFromArchive: !!entry.archiveParentPath,
      entry,
    };
  });
}

// === Buffer-based API (for small files or when buffering is acceptable) ===

/**
 * Read file content as a Buffer.
 * Use this when you need the entire file content at once.
 *
 * Note: For large files, prefer createFileContentStream() to avoid
 * loading everything into memory.
 *
 * @param rootPath - Root path of the scan
 * @param entry - File entry (may be regular file or archive entry)
 * @returns Promise resolving to file content as Buffer
 */
export async function readFileContent(rootPath: string, entry: FileEntry): Promise<Buffer> {
  if (entry.archiveParentPath) {
    // Archive entry - extract directly
    return extractFromArchive(rootPath, entry.archiveParentPath, entry.path);
  } else {
    // Regular filesystem file
    const systemPath = toSystemPath(entry.path);
    const fullPath = path.join(rootPath, systemPath);
    return fs.readFile(toLongPath(fullPath));
  }
}

/**
 * Read file content as a Buffer, wrapped in an RxJS Observable.
 *
 * @param rootPath - Root path of the scan
 * @param entry - File entry (may be regular file or archive entry)
 * @returns Observable that emits file content as Buffer
 */
export function readFileContentObservable(rootPath: string, entry: FileEntry): Observable<Buffer> {
  return defer(() => from(readFileContent(rootPath, entry)));
}

// === Utility Functions ===

/**
 * Check if a file entry is from an archive
 */
export function isArchiveEntry(entry: FileEntry): boolean {
  return !!entry.archiveParentPath;
}

/**
 * Get the full filesystem path for a regular (non-archive) file entry
 * Returns null for archive entries since they don't have a direct filesystem path
 */
export function getFilesystemPath(rootPath: string, entry: FileEntry): string | null {
  if (entry.archiveParentPath) {
    return null;
  }
  const systemPath = toSystemPath(entry.path);
  return path.join(rootPath, systemPath);
}

/**
 * Get the path to the containing archive for an archive entry
 * Returns null for regular files
 */
export function getArchivePath(rootPath: string, entry: FileEntry): string | null {
  if (!entry.archiveParentPath) {
    return null;
  }
  const systemPath = toSystemPath(entry.archiveParentPath);
  return path.join(rootPath, systemPath);
}
