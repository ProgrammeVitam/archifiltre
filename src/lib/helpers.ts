/**
 * Helper Functions
 *
 * Pure utility functions used across the application.
 * No side effects, framework-agnostic, and highly reusable.
 */

import { homedir, freemem } from 'os';

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
  let lastError: Error;

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

  throw lastError || new Error('All retry attempts failed');
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
export interface HealthReport {
  ok: boolean;
  checks: string[];
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
      appVersion: '5.0.0-dev',
      buildDate: new Date().toISOString(),
      commitHash: process.env.GIT_COMMIT || 'dev',
    };
  },

  /**
   * Get basic health check
   */
  async health(): Promise<HealthReport> {
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

    return {
      ok: nodeOk && memoryOk,
      checks,
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

© République française – Ministère de la Culture (SNUM) / CIAF / DINUM
Programme interministériel VITAM
Contact: archifiltre@programmevitam.fr
Website: https://archifiltre.fabrique.social.gouv.fr`;
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
