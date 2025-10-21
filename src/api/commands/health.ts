/**
 * Health command implementation
 * Performs system health checks to ensure Archifiltre can operate properly
 */

import type { HealthReport } from '@api/dto.js';
import { SystemError } from '@api/errors.js';
import { promises as fs } from 'fs';
import { tmpdir, freemem, homedir } from 'os';
import { join } from 'path';

/**
 * Individual health check result
 */
interface HealthCheck {
  name: string;
  ok: boolean;
  message: string;
}

/**
 * Checks if the current Node.js version is supported
 */
async function checkNodeVersion(): Promise<HealthCheck> {
  try {
    const version = process.version;
    const majorVersion = parseInt(version.substring(1).split('.')[0], 10);

    const minVersion = 18;
    const ok = majorVersion >= minVersion;

    return {
      name: 'Node.js Version',
      ok,
      message: ok
        ? `Node.js ${version} (supported)`
        : `Node.js ${version} (minimum v${minVersion} required)`,
    };
  } catch (_error) {
    return {
      name: 'Node.js Version',
      ok: false,
      message: 'Failed to check Node.js version',
    };
  }
}

/**
 * Checks available system memory
 */
async function checkMemory(): Promise<HealthCheck> {
  try {
    const freeMemory = freemem();
    const availableMemory = freeMemory;

    // Require at least 100MB of available memory
    const minMemoryMB = 100;
    const availableMB = Math.round(availableMemory / (1024 * 1024));
    const ok = availableMB >= minMemoryMB;

    return {
      name: 'Memory',
      ok,
      message: ok
        ? `${availableMB}MB available (sufficient)`
        : `${availableMB}MB available (minimum ${minMemoryMB}MB required)`,
    };
  } catch (_error) {
    return {
      name: 'Memory',
      ok: false,
      message: 'Failed to check memory usage',
    };
  }
}

/**
 * Checks temporary directory access
 */
async function checkTempDirAccess(): Promise<HealthCheck> {
  const testFileName = `archifiltre-health-${Date.now()}.tmp`;
  const testFilePath = join(tmpdir(), testFileName);

  try {
    // Test write access
    await fs.writeFile(testFilePath, 'health check test');

    // Test read access
    const content = await fs.readFile(testFilePath, 'utf-8');

    // Test delete access
    await fs.unlink(testFilePath);

    const ok = content === 'health check test';

    return {
      name: 'Temp Directory',
      ok,
      message: ok
        ? `Temp directory accessible (${tmpdir()})`
        : 'Temp directory read/write test failed',
    };
  } catch (error) {
    // Clean up test file if it exists
    try {
      await fs.unlink(testFilePath);
    } catch {
      // Ignore cleanup errors
    }

    return {
      name: 'Temp Directory',
      ok: false,
      message: `Temp directory not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Checks configuration directory access
 */
async function checkConfigDirAccess(): Promise<HealthCheck> {
  try {
    // Determine platform-specific config directory
    const platform = process.platform;
    let configDir: string;

    switch (platform) {
      case 'win32':
        configDir = join(process.env.APPDATA || homedir(), 'archifiltre');
        break;
      case 'darwin':
        configDir = join(homedir(), 'Library', 'Application Support', 'archifiltre');
        break;
      default:
        // Linux and other Unix-like systems
        configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'archifiltre');
        break;
    }

    // Test creating the config directory if it doesn't exist
    try {
      await fs.access(configDir);
    } catch {
      // Directory doesn't exist, try to create it
      await fs.mkdir(configDir, { recursive: true });
    }

    // Test write access by creating a test file
    const testFilePath = join(configDir, 'health-check.tmp');
    await fs.writeFile(testFilePath, 'health check test');

    // Test read access
    const content = await fs.readFile(testFilePath, 'utf-8');

    // Clean up test file
    await fs.unlink(testFilePath);

    const ok = content === 'health check test';

    return {
      name: 'Configuration',
      ok,
      message: ok
        ? `${configDir} accessible (needed for settings)`
        : 'Configuration directory read/write test failed',
    };
  } catch (error) {
    return {
      name: 'Configuration',
      ok: false,
      message: `Configuration directory not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Runs all health checks and returns a comprehensive report
 */
export async function health(): Promise<HealthReport> {
  try {
    const checks: HealthCheck[] = await Promise.all([
      checkNodeVersion(),
      checkMemory(),
      checkTempDirAccess(),
      checkConfigDirAccess(),
    ]);

    const allOk = checks.every(check => check.ok);
    const checkMessages = checks.map(
      check => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.message}`
    );

    return {
      ok: allOk,
      checks: checkMessages,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    throw SystemError.unknown(error instanceof Error ? error : new Error('Health check failed'));
  }
}

/**
 * Formats health report for CLI display
 */
export function formatHealthReport(report: HealthReport): string {
  const status = report.ok ? '✓ HEALTHY' : '✗ ISSUES DETECTED';
  const timestamp = report.timestamp ? ` (${report.timestamp})` : '';

  let output = `System Health: ${status}${timestamp}\n\n`;
  output += report.checks.join('\n');

  if (!report.ok) {
    output += '\n\nSome health checks failed. Use --verbose for more details.';
  }

  return output;
}
