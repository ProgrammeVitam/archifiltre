/**
 * Version command implementation
 * Returns application version information including build details
 */

import type { VersionInfo } from '@api/dto.js';
import { SystemError } from '@api/errors.js';

/**
 * Build information injected at compile time
 * These can be set via environment variables during build
 */
interface BuildInfo {
  version?: string;
  gitSha?: string;
  buildDate?: string;
}

/**
 * Gets build information from environment or defaults
 */
function getBuildInfo(): BuildInfo {
  return {
    version: process.env.APP_VERSION || process.env.npm_package_version || '5.0.0-dev',
    gitSha: process.env.GIT_SHA || process.env.GITHUB_SHA || 'unknown',
    buildDate: process.env.BUILD_DATE || new Date().toISOString(),
  };
}

/**
 * Gets the short Git SHA (7-9 characters)
 */
function getShortSha(fullSha: string): string {
  if (fullSha === 'unknown') {
    return 'unknown';
  }

  // Handle both full SHA and already short SHA
  return fullSha.length > 9 ? fullSha.substring(0, 7) : fullSha;
}

/**
 * Gets the operating system name in a normalized format
 */
function getOsName(): string {
  const platform = process.platform;

  switch (platform) {
    case 'darwin':
      return 'darwin';
    case 'win32':
      return 'win32';
    case 'linux':
      return 'linux';
    case 'freebsd':
      return 'freebsd';
    case 'openbsd':
      return 'openbsd';
    default:
      return platform;
  }
}

/**
 * Gets the architecture name in a normalized format
 */
function getArchName(): string {
  const arch = process.arch as string;

  switch (arch) {
    case 'x64':
    case 'amd64':
      return 'x64';
    case 'arm64':
      return 'arm64';
    case 'arm':
      return 'arm';
    case 'ia32':
      return 'ia32';
    default:
      return arch;
  }
}

/**
 * Validates that the build date is a valid ISO string
 */
function validateBuildDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date');
    }

    // Ensure it's in UTC format
    return date.toISOString();
  } catch (_error) {
    // Fall back to current time if build date is invalid
    return new Date().toISOString();
  }
}

/**
 * Returns version information for the application
 */
export function version(): VersionInfo {
  try {
    const buildInfo = getBuildInfo();

    const versionInfo: VersionInfo = {
      appVersion: buildInfo.version || '5.0.0-dev',
      gitSha: getShortSha(buildInfo.gitSha || 'unknown'),
      buildDateUtc: validateBuildDate(buildInfo.buildDate || new Date().toISOString()),
      os: getOsName(),
      arch: getArchName(),
    };

    return versionInfo;
  } catch (error) {
    throw SystemError.unknown(error instanceof Error ? error : new Error('Version command failed'));
  }
}

/**
 * Formats version info for CLI display
 * Format: vX.Y.Z (sha abcdef7, 2025-01-01T12:34:56Z, os=linux, arch=x64)
 */
export function formatVersionString(versionInfo: VersionInfo): string {
  const { appVersion, gitSha, buildDateUtc, os, arch } = versionInfo;

  // Ensure version starts with 'v'
  const version = appVersion.startsWith('v') ? appVersion : `v${appVersion}`;

  return `${version} (sha ${gitSha}, ${buildDateUtc}, os=${os}, arch=${arch})`;
}

/**
 * Gets version information and formats it for CLI output
 */
export function getFormattedVersion(): string {
  const versionInfo = version();
  return formatVersionString(versionInfo);
}
