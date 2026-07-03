/**
 * Platform-specific application data paths
 *
 * Determines where to store databases, logs, and other application data
 * based on the operating system and execution mode (development vs standalone)
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

/**
 * Check if running as a standalone compiled executable
 */
export function isStandalone(): boolean {
  // Check environment variable first (can be set explicitly)
  if (process.env.ARCHIFILTRE_STANDALONE === '1') {
    return true;
  }

  // Check if we're running as a compiled binary
  // Compiled binaries will have "archifiltre" in the executable path
  const executablePath = process.execPath;
  const executableName = path.basename(executablePath);

  if (executableName.includes('archifiltre')) {
    return true;
  }

  // Fallback: check if we're running with bun in development
  if (process.argv[0]?.includes('bun')) {
    return false;
  }

  // Final fallback: assume standalone if we can't determine otherwise
  return true;
}

/**
 * Get base application data directory for the current platform
 */
export function getAppDataDir(): string {
  const standalone = isStandalone();

  if (!standalone) {
    // Development mode: use current directory
    return process.cwd();
  }

  // Standalone mode: use platform-specific directories
  const homeDir = os.homedir();

  if (process.platform === 'win32') {
    // Windows: %LOCALAPPDATA%\archifiltre or %APPDATA%\archifiltre
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || homeDir, 'archifiltre');
  } else if (process.platform === 'darwin') {
    // macOS: ~/Library/Application Support/archifiltre
    return path.join(homeDir, 'Library', 'Application Support', 'archifiltre');
  } else {
    // Linux/Unix: ~/.local/share/archifiltre (follows XDG Base Directory spec)
    const xdgData = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
    return path.join(xdgData, 'archifiltre');
  }
}

/**
 * Get database path for a specific database name
 */
export function getDatabasePath(dbName: string): string {
  // Sanitize database name
  const safeName = dbName.replace(/[^a-zA-Z0-9-_]/g, '_');

  const standalone = isStandalone();

  if (standalone) {
    // Standalone: put databases in a subdirectory
    const appDataDir = getAppDataDir();
    return path.join(appDataDir, 'databases', `dbdata-${safeName}`);
  } else {
    // Development: use current directory
    return path.join(process.cwd(), `dbdata-${safeName}`);
  }
}

/**
 * Get logs directory
 */
export function getLogsDir(): string {
  if (isStandalone()) {
    return path.join(getAppDataDir(), 'logs');
  } else {
    // Development: use current directory
    return path.join(process.cwd(), 'logs');
  }
}

/**
 * Directory holding all per-scan datadirs — the parent of every `dbdata-*`.
 * Startup reconciliation lists this to find datadirs (and their `.meta.json`
 * sidecars) the UI may not know about.
 */
export function getDatabasesDir(): string {
  return path.dirname(getDatabasePath('_'));
}

/**
 * Directory holding durable annotation snapshots — the user's irreplaceable
 * enrichment work (aliases/comments/tags/deletion marks), kept OUTSIDE the
 * per-scan datadirs so a corrupted datadir never takes the annotations with it.
 * One JSON file per scanned root (keyed by a hash of its path).
 */
export function getAnnotationsDir(): string {
  if (isStandalone()) {
    return path.join(getAppDataDir(), 'annotations');
  } else {
    return path.join(process.cwd(), 'annotations');
  }
}
