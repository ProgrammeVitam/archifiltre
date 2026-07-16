/**
 * Helper Functions
 *
 * Pure utility functions used across the application.
 * No side effects, framework-agnostic, and highly reusable.
 */

import { homedir, freemem, platform } from 'os';
import { existsSync } from 'fs';
import { access, constants, mkdir } from 'fs/promises';
import { getAppDataDir, getDatabasePath, isStandalone } from './platform-paths.ts';

/**
 * Formats bytes as human-readable string
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Formats duration in milliseconds as human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Sleep/delay utility for rate limiting and testing
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensures a directory exists, creating it (and parent directories) if necessary.
 *
 * This function works around a Bun runtime bug on Windows where
 * `fs.promises.mkdir(path, { recursive: true })` incorrectly throws
 * `EEXIST` when the directory already exists. According to Node.js
 * documentation, `recursive: true` should silently succeed if the
 * directory exists.
 *
 * @param dirPath - The directory path to ensure exists
 *
 * @example
 * // Ensure output directory exists before writing a file
 * const outputDir = path.dirname(outputFilePath);
 * await ensureDirectory(outputDir);
 * await fs.writeFile(outputFilePath, content);
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

/**
 * Checks if a value is defined (not null or undefined)
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Ensures a value is an array
 */
export function ensureArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Safely parses JSON with fallback
 */
export function safeJsonParse<T = unknown>(json: string, fallback?: T): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback ?? null;
  }
}

/**
 * Creates a simple retry mechanism
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delay?: number;
    backoff?: boolean;
  } = {}
): Promise<T> {
  const { maxAttempts = 3, delay = 1000, backoff = false } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts) {
        const waitTime = backoff ? delay * Math.pow(2, attempt - 1) : delay;
        await sleep(waitTime);
      }
    }
  }

  throw lastError ?? new Error('All retry attempts failed');
}

/**
 * Sanitizes file paths for privacy (replaces home directory with ~)
 */
export function sanitizePath(path: string): string {
  const homedirPath = homedir();
  return path.replace(homedirPath, '~');
}

/**
 * Generates a simple run ID for operations
 */
export function generateRunId(prefix = 'run'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Options for generating export filenames
 */
export interface ExportFilenameOptions {
  /** Prefix for the filename (default: 'archifiltre') */
  prefix?: string;
  /** Type of export (e.g., 'logs', 'export', 'scan') */
  type: string;
  /** File extension without the dot (e.g., 'zip', 'csv') */
  extension: string;
  /** Date to use for the filename (default: current date) */
  date?: Date;
}

/**
 * Generates a consistent, cross-platform safe filename for exports
 *
 * Format: {prefix}-{type}-{YYYY-MM-DD}-{HHmmss}.{extension}
 *
 * @example
 * generateExportFilename({ type: 'logs', extension: 'zip' })
 * // → "archifiltre-logs-2026-02-23-143052.zip"
 *
 * @example
 * generateExportFilename({ type: 'export', extension: 'csv', prefix: 'scan' })
 * // → "scan-export-2026-02-23-143052.csv"
 */
export function generateExportFilename(options: ExportFilenameOptions): string {
  const { prefix = 'archifiltre', type, extension, date = new Date() } = options;

  // Format date as YYYY-MM-DD
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  // Format time as HHmmss (no separators for filename safety)
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const timeStr = `${hours}${minutes}${seconds}`;

  // Sanitize inputs to ensure cross-platform compatibility
  const safePrefix = prefix.replace(/[^a-zA-Z0-9-_]/g, '-');
  const safeType = type.replace(/[^a-zA-Z0-9-_]/g, '-');
  // Allow dots in extension for compound extensions like tar.gz
  const safeExtension = extension.replace(/[^a-zA-Z0-9.]/g, '');

  return `${safePrefix}-${safeType}-${dateStr}-${timeStr}.${safeExtension}`;
}

/**
 * Calculates processing rate (items per second)
 */
export function calculateRate(itemCount: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return (itemCount / durationMs) * 1000;
}

/**
 * Clamps a number between min and max values
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Generates a hash from a string (simple FNV-1a implementation)
 */
export function simpleHash(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Creates a debounced version of a function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      func(...args);
      timeout = null;
    }, wait);
  };
}

/**
 * Creates a throttled version of a function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * Formats a number with thousand separators
 */
export function formatNumber(num: number, separator = ','): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Gets file extension from path
 */
export function getFileExtension(filePath: string): string {
  const lastDotIndex = filePath.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === filePath.length - 1) {
    return '';
  }
  return filePath.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Truncates a string to specified length with ellipsis
 */
export function truncateString(str: string, maxLength: number, ellipsis = '...'): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Validates if a string is a valid UUID
 */
export function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

// === Simple API Functions for CLI Commands ===

/**
 * Basic version information
 */
export interface VersionInfo {
  appVersion: string;
  buildDate: string;
  commitHash?: string;
}

/**
 * Basic health report
 */
export interface PathDiagnostics {
  platform: string;
  isStandalone: boolean;
  currentWorkingDir: string;
  appDataDir: string;
  databaseDir: string;
  appDataDirExists: boolean;
  appDataDirWritable: boolean;
  databaseDirExists: boolean;
  databaseDirWritable: boolean;
  environmentVars?: Record<string, string | undefined>;
}

export interface HealthReport {
  ok: boolean;
  checks: string[];
  pathDiagnostics?: PathDiagnostics;
  timestamp?: string;
}

/**
 * Simple API functions that CLI commands use
 */
export const api = {
  /**
   * Get version information
   */
  version(): VersionInfo {
    return {
      appVersion: '5.0.0-alpha.5',
      buildDate: new Date().toISOString(),
      commitHash: process.env.GIT_COMMIT || 'dev',
    };
  },

  /**
   * Get basic health check
   */
  async health(includePathDiagnostics = false): Promise<HealthReport> {
    // Simple health checks
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.substring(1).split('.')[0], 10);
    const nodeOk = majorVersion >= 18;

    const memoryMB = Math.round(freemem() / (1024 * 1024));
    const memoryOk = memoryMB >= 100;

    const checks = [
      nodeOk
        ? `✓ Node.js: ${nodeVersion} (supported)`
        : `✗ Node.js: ${nodeVersion} (minimum v18 required)`,
      memoryOk
        ? `✓ Memory: ${memoryMB}MB available`
        : `✗ Memory: ${memoryMB}MB available (minimum 100MB required)`,
    ];

    // Path diagnostics (optional, for debugging)
    let pathDiagnostics: PathDiagnostics | undefined;
    if (includePathDiagnostics) {
      const appDataDir = getAppDataDir();
      const databaseDir = getDatabasePath('main');
      const currentPlatform = platform();

      // Check if directories exist
      const appDataDirExists = existsSync(appDataDir);
      const databaseDirExists = existsSync(databaseDir);

      // Check if directories are writable
      let appDataDirWritable = false;
      let databaseDirWritable = false;

      try {
        if (appDataDirExists) {
          await access(appDataDir, constants.W_OK);
          appDataDirWritable = true;
        }
      } catch {
        appDataDirWritable = false;
      }

      try {
        if (databaseDirExists) {
          await access(databaseDir, constants.W_OK);
          databaseDirWritable = true;
        }
      } catch {
        databaseDirWritable = false;
      }

      // Collect environment variables (especially useful on Windows)
      const environmentVars: Record<string, string | undefined> = {};
      if (currentPlatform === 'win32') {
        environmentVars.LOCALAPPDATA = process.env.LOCALAPPDATA;
        environmentVars.APPDATA = process.env.APPDATA;
        environmentVars.USERPROFILE = process.env.USERPROFILE;
      } else {
        environmentVars.HOME = process.env.HOME;
        environmentVars.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
      }

      pathDiagnostics = {
        platform: currentPlatform,
        isStandalone: isStandalone(),
        currentWorkingDir: process.cwd(),
        appDataDir,
        databaseDir,
        appDataDirExists,
        appDataDirWritable,
        databaseDirExists,
        databaseDirWritable,
        environmentVars,
      };

      // Add path-related checks
      checks.push(
        appDataDirExists
          ? `✓ App data directory: exists`
          : `✗ App data directory: missing (${appDataDir})`
      );

      if (appDataDirExists) {
        checks.push(
          appDataDirWritable
            ? `✓ App data directory: writable`
            : `✗ App data directory: not writable`
        );
      }
    }

    return {
      ok: nodeOk && memoryOk,
      checks,
      pathDiagnostics,
      timestamp: new Date().toISOString(),
    };
  },
} as const;

/**
 * Simple formatters for CLI output
 */
export const formatters = {
  /**
   * Format version string for display
   */
  versionString(): string {
    const info = api.version();
    return `archifiltre v${info.appVersion}`;
  },

  /**
   * Get formatted version with details
   */
  getFormattedVersion(): string {
    const info = api.version();
    return `archifiltre v${info.appVersion} (${info.commitHash}, ${info.buildDate})

© République française – Ministère de la Culture (SNUM/SIAF)
Programme interministériel Vitam
Contact: archifiltre@culture.gouv.fr
Website: https://www.archifiltre.org`;
  },

  /**
   * Format health report for display
   */
  health(report: HealthReport): string {
    const status = report.ok ? '✅ HEALTHY' : '❌ ISSUES DETECTED';
    const timestamp = report.timestamp ? ` (${report.timestamp})` : '';

    let output = `System Health: ${status}${timestamp}\n\n`;
    output += report.checks.join('\n');

    if (!report.ok) {
      output += '\n\nSome health checks failed. Use --verbose for more details.';
    }

    return output;
  },
} as const;
