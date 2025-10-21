/**
 * Unit tests for version format functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { version, formatVersionString, getFormattedVersion } from '@api/commands/version.js';
import type { VersionInfo } from '@api/dto.js';

describe('Version Format', () => {
  // Store original environment and process values
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    // Reset environment for each test
    process.env = { ...originalEnv };
    delete process.env.APP_VERSION;
    delete process.env.GIT_SHA;
    delete process.env.BUILD_DATE;
    delete process.env.GITHUB_SHA;
    delete process.env.npm_package_version;
  });

  afterEach(() => {
    // Restore original values
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  });

  describe('Version Info Generation', () => {
    it('should return valid version info with defaults', () => {
      const versionInfo = version();

      expect(versionInfo).toMatchObject({
        appVersion: expect.any(String),
        gitSha: expect.any(String),
        buildDateUtc: expect.any(String),
        os: expect.any(String),
        arch: expect.any(String),
      });

      // Version should be valid semver or dev version
      expect(versionInfo.appVersion).toMatch(/^\d+\.\d+\.\d+(-\w+)?$/);

      // Build date should be valid ISO string
      expect(versionInfo.buildDateUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(new Date(versionInfo.buildDateUtc).getTime()).not.toBeNaN();

      // OS should be normalized
      expect(['linux', 'darwin', 'win32', 'freebsd', 'openbsd']).toContain(versionInfo.os);

      // Arch should be normalized
      expect(['x64', 'arm64', 'arm', 'ia32']).toContain(versionInfo.arch);
    });

    it('should use environment variables when provided', () => {
      const testData = {
        APP_VERSION: '1.2.3',
        GIT_SHA: 'abcdef1234567890',
        BUILD_DATE: '2025-01-15T10:30:45.123Z',
      };

      Object.assign(process.env, testData);

      const versionInfo = version();

      expect(versionInfo.appVersion).toBe('1.2.3');
      expect(versionInfo.gitSha).toBe('abcdef1'); // Should be shortened to 7 chars
      expect(versionInfo.buildDateUtc).toBe('2025-01-15T10:30:45.123Z');
    });

    it('should use npm_package_version as fallback', () => {
      process.env.npm_package_version = '2.1.0';

      const versionInfo = version();

      expect(versionInfo.appVersion).toBe('2.1.0');
    });

    it('should use GITHUB_SHA as fallback for GIT_SHA', () => {
      process.env.GITHUB_SHA = 'github1234567890abcdef';

      const versionInfo = version();

      expect(versionInfo.gitSha).toBe('github1'); // Should be shortened
    });

    it('should handle invalid build date gracefully', () => {
      process.env.BUILD_DATE = 'invalid-date';

      const versionInfo = version();

      // Should fall back to current time
      expect(versionInfo.buildDateUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(new Date(versionInfo.buildDateUtc).getTime()).not.toBeNaN();
    });
  });

  describe('Version String Formatting', () => {
    it('should format version string correctly', () => {
      const versionInfo: VersionInfo = {
        appVersion: '1.2.3',
        gitSha: 'abc1234',
        buildDateUtc: '2025-01-15T10:30:45.123Z',
        os: 'linux',
        arch: 'x64',
      };

      const formatted = formatVersionString(versionInfo);

      expect(formatted).toBe('v1.2.3 (sha abc1234, 2025-01-15T10:30:45.123Z, os=linux, arch=x64)');
    });

    it('should add v prefix when missing', () => {
      const versionInfo: VersionInfo = {
        appVersion: '1.2.3', // No 'v' prefix
        gitSha: 'abc1234',
        buildDateUtc: '2025-01-15T10:30:45.123Z',
        os: 'linux',
        arch: 'x64',
      };

      const formatted = formatVersionString(versionInfo);

      expect(formatted).toMatch(/^v1\.2\.3 /);
    });

    it('should not double-add v prefix', () => {
      const versionInfo: VersionInfo = {
        appVersion: 'v1.2.3', // Already has 'v' prefix
        gitSha: 'abc1234',
        buildDateUtc: '2025-01-15T10:30:45.123Z',
        os: 'linux',
        arch: 'x64',
      };

      const formatted = formatVersionString(versionInfo);

      expect(formatted).toBe('v1.2.3 (sha abc1234, 2025-01-15T10:30:45.123Z, os=linux, arch=x64)');
      expect(formatted).not.toMatch(/^vv/);
    });

    it('should match the exact format specification', () => {
      const versionInfo: VersionInfo = {
        appVersion: '5.0.0',
        gitSha: 'abcdef7',
        buildDateUtc: '2025-01-01T12:34:56.000Z',
        os: 'linux',
        arch: 'x64',
      };

      const formatted = formatVersionString(versionInfo);

      // Should match the exact format from specification
      const expectedRegex =
        /^v\d+\.\d+\.\d+(-\w+)? \(sha [0-9a-f]{7,9}, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z, os=\w+, arch=\w+\)$/;
      expect(formatted).toMatch(expectedRegex);
    });
  });

  describe('Platform Detection', () => {
    it('should detect Linux platform', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const versionInfo = version();
      expect(versionInfo.os).toBe('linux');
    });

    it('should detect macOS platform', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const versionInfo = version();
      expect(versionInfo.os).toBe('darwin');
    });

    it('should detect Windows platform', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const versionInfo = version();
      expect(versionInfo.os).toBe('win32');
    });

    it('should handle unknown platform', () => {
      Object.defineProperty(process, 'platform', { value: 'unknown-os' });

      const versionInfo = version();
      expect(versionInfo.os).toBe('unknown-os');
    });
  });

  describe('Architecture Detection', () => {
    it('should detect x64 architecture', () => {
      Object.defineProperty(process, 'arch', { value: 'x64' });

      const versionInfo = version();
      expect(versionInfo.arch).toBe('x64');
    });

    it('should detect arm64 architecture', () => {
      Object.defineProperty(process, 'arch', { value: 'arm64' });

      const versionInfo = version();
      expect(versionInfo.arch).toBe('arm64');
    });

    it('should handle amd64 as x64', () => {
      Object.defineProperty(process, 'arch', { value: 'amd64' });

      const versionInfo = version();
      expect(versionInfo.arch).toBe('x64');
    });

    it('should handle unknown architecture', () => {
      Object.defineProperty(process, 'arch', { value: 'unknown-arch' });

      const versionInfo = version();
      expect(versionInfo.arch).toBe('unknown-arch');
    });
  });

  describe('Git SHA Handling', () => {
    it('should shorten long SHA to 7 characters', () => {
      process.env.GIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12';

      const versionInfo = version();
      expect(versionInfo.gitSha).toBe('abcdef1');
      expect(versionInfo.gitSha).toHaveLength(7);
    });

    it('should keep short SHA as-is', () => {
      process.env.GIT_SHA = 'abc123';

      const versionInfo = version();
      expect(versionInfo.gitSha).toBe('abc123');
    });

    it('should handle exactly 7 character SHA', () => {
      process.env.GIT_SHA = 'abcdef7';

      const versionInfo = version();
      expect(versionInfo.gitSha).toBe('abcdef7');
    });

    it('should handle unknown SHA', () => {
      // No GIT_SHA or GITHUB_SHA set
      const versionInfo = version();
      expect(versionInfo.gitSha).toBe('unknown');
    });

    it('should keep unknown SHA as-is', () => {
      process.env.GIT_SHA = 'unknown';

      const versionInfo = version();
      expect(versionInfo.gitSha).toBe('unknown');
    });
  });

  describe('Date Handling', () => {
    it('should use provided build date', () => {
      const testDate = '2025-01-15T10:30:45.123Z';
      process.env.BUILD_DATE = testDate;

      const versionInfo = version();
      expect(versionInfo.buildDateUtc).toBe(testDate);
    });

    it('should ensure date is in UTC format', () => {
      // Provide a date without milliseconds
      process.env.BUILD_DATE = '2025-01-15T10:30:45Z';

      const versionInfo = version();

      // Should be converted to full ISO format
      expect(versionInfo.buildDateUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });

    it('should handle malformed date', () => {
      process.env.BUILD_DATE = 'not-a-date';

      const versionInfo = version();

      // Should fall back to current time
      expect(versionInfo.buildDateUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(new Date(versionInfo.buildDateUtc).getTime()).not.toBeNaN();
    });

    it('should always end with Z (UTC)', () => {
      const versionInfo = version();
      expect(versionInfo.buildDateUtc).toMatch(/Z$/);
    });
  });

  describe('Integration', () => {
    it('should produce consistent format through getFormattedVersion', () => {
      const formatted = getFormattedVersion();

      // Should match the CLI format specification
      const formatRegex =
        /^v\d+\.\d+\.\d+(-\w+)? \(sha [0-9a-f]{7,9}|unknown, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z, os=\w+, arch=\w+\)$/;
      expect(formatted).toMatch(formatRegex);
    });

    it('should handle dev version format', () => {
      process.env.APP_VERSION = '5.0.0-dev';

      const formatted = getFormattedVersion();
      expect(formatted).toMatch(/^v5\.0\.0-dev /);
    });

    it('should handle alpha/beta versions', () => {
      process.env.APP_VERSION = '5.0.0-alpha.1';

      const formatted = getFormattedVersion();
      expect(formatted).toMatch(/^v5\.0\.0-alpha\.1 /);
    });
  });

  describe('Error Handling', () => {
    it('should handle errors gracefully', () => {
      // Mock a scenario that could cause errors
      const originalConsoleError = console.error;
      console.error = vi.fn();

      // This shouldn't throw
      expect(() => version()).not.toThrow();

      console.error = originalConsoleError;
    });

    it('should always return a valid VersionInfo object', () => {
      const versionInfo = version();

      // All required fields should be present and be strings
      expect(typeof versionInfo.appVersion).toBe('string');
      expect(typeof versionInfo.gitSha).toBe('string');
      expect(typeof versionInfo.buildDateUtc).toBe('string');
      expect(typeof versionInfo.os).toBe('string');
      expect(typeof versionInfo.arch).toBe('string');

      // No field should be empty
      expect(versionInfo.appVersion.length).toBeGreaterThan(0);
      expect(versionInfo.gitSha.length).toBeGreaterThan(0);
      expect(versionInfo.buildDateUtc.length).toBeGreaterThan(0);
      expect(versionInfo.os.length).toBeGreaterThan(0);
      expect(versionInfo.arch.length).toBeGreaterThan(0);
    });
  });
});
