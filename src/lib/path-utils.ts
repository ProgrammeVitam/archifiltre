/**
 * Path Normalization Utilities
 *
 * Cross-platform path handling for Archifiltre. Follows industry standard patterns
 * used by Git, Docker, and other mature cross-platform tools.
 *
 * Architecture:
 * - Universal internal format: Always use '/' regardless of platform
 * - Database storage: Always '/' for platform-independent queries
 * - Archive paths: Always '/' (archives are platform-agnostic)
 * - Filesystem operations: Convert to platform-specific format only at boundaries
 */

/**
 * Normalize path to universal internal format (always use '/')
 * Converts backslashes to forward slashes for consistent internal representation
 *
 * @param filePath - Path to normalize (can be Windows or Unix style)
 * @returns Normalized path with forward slashes
 *
 * @example
 * // Windows input
 * normalizePath('C:\\Users\\file.txt') → 'C:/Users/file.txt'
 * // Unix input (no change needed)
 * normalizePath('/home/user/file.txt') → '/home/user/file.txt'
 * // Archive path
 * normalizePath('archive.zip\\internal\\file.txt') → 'archive.zip/internal/file.txt'
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Convert normalized path to system-specific format for filesystem operations
 * Converts forward slashes to backslashes on Windows, leaves unchanged on Unix
 *
 * @param filePath - Normalized path (with forward slashes)
 * @returns System-specific path for filesystem operations
 *
 * @example
 * // On Windows
 * toSystemPath('C:/Users/file.txt') → 'C:\\Users\\file.txt'
 * // On Unix/Linux/macOS
 * toSystemPath('/home/user/file.txt') → '/home/user/file.txt'
 */
export function toSystemPath(filePath: string): string {
  return process.platform === 'win32' ? filePath.replace(/\//g, '\\') : filePath;
}

/**
 * Join path segments using normalized separators
 * Always produces paths with forward slashes regardless of platform
 *
 * @param segments - Path segments to join
 * @returns Joined path with normalized separators
 *
 * @example
 * joinNormalized('archive.zip', 'internal', 'file.txt') → 'archive.zip/internal/file.txt'
 * joinNormalized('C:', 'Users', 'file.txt') → 'C:/Users/file.txt'
 */
export function joinNormalized(...segments: string[]): string {
  return segments
    .filter(segment => segment.length > 0)
    .map(segment => normalizePath(segment))
    .join('/')
    .replace(/\/+/g, '/'); // Remove duplicate slashes
}

/**
 * Extract archive-relative path from full archive entry path
 * Used for hash calculation to get the path within the archive
 *
 * @param fullPath - Full path including archive prefix (e.g., 'archive.zip/internal/file.txt')
 * @param archiveParentPath - Archive container path (e.g., 'archive.zip')
 * @returns Path relative to archive root (e.g., 'internal/file.txt')
 *
 * @example
 * getArchiveRelativePath('backup.tar.gz/documents/file.pdf', 'backup.tar.gz')
 * → 'documents/file.pdf'
 */
export function getArchiveRelativePath(fullPath: string, archiveParentPath: string): string {
  const normalizedFull = normalizePath(fullPath);
  const normalizedParent = normalizePath(archiveParentPath);

  if (!normalizedFull.startsWith(normalizedParent + '/')) {
    throw new Error(`Path ${fullPath} is not within archive ${archiveParentPath}`);
  }

  return normalizedFull.substring(normalizedParent.length + 1);
}

/**
 * Compare two paths for equality using normalized format
 * Handles cross-platform path comparison by normalizing both paths first
 *
 * @param path1 - First path to compare
 * @param path2 - Second path to compare
 * @returns True if paths are equivalent when normalized
 *
 * @example
 * pathEquals('folder\\file.txt', 'folder/file.txt') → true
 * pathEquals('C:\\Users\\file', 'C:/Users/file') → true
 */
export function pathEquals(path1: string, path2: string): boolean {
  return normalizePath(path1) === normalizePath(path2);
}

/**
 * Check if a path is within an archive based on normalized path comparison
 * Used to identify archive entries in database queries
 *
 * @param filePath - Path to check
 * @param archivePath - Archive container path
 * @returns True if filePath is within the archive
 *
 * @example
 * isWithinArchive('backup.zip/documents/file.pdf', 'backup.zip') → true
 * isWithinArchive('regular-file.txt', 'backup.zip') → false
 */
export function isWithinArchive(filePath: string, archivePath: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedArchive = normalizePath(archivePath);
  return normalizedFile.startsWith(normalizedArchive + '/');
}

/**
 * Validate that a path is properly normalized for internal use
 * Used for debugging and validation in development
 *
 * @param filePath - Path to validate
 * @returns True if path uses only forward slashes
 *
 * @example
 * isNormalizedPath('archive.zip/file.txt') → true
 * isNormalizedPath('archive.zip\\file.txt') → false
 */
export function isNormalizedPath(filePath: string): boolean {
  return !filePath.includes('\\');
}

/**
 * Convert a Windows-style drive path to normalized format
 * Handles Windows drive letters correctly in cross-platform contexts
 *
 * @param filePath - Windows path with drive letter
 * @returns Normalized path suitable for internal use
 *
 * @example
 * normalizeWindowsDrive('C:\\Users\\file.txt') → 'C:/Users/file.txt'
 * normalizeWindowsDrive('\\\\server\\share\\file.txt') → '//server/share/file.txt'
 */
export function normalizeWindowsDrive(filePath: string): string {
  return normalizePath(filePath);
}
