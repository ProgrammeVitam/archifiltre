/**
 * Unit tests for API health functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { health, formatHealthReport } from '@api/commands/health.js';
import type { HealthReport } from '@api/dto.js';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';

describe('API Health', () => {
  // Store original environment and process values
  const originalEnv = { ...process.env };
  const originalGetuid = process.getuid;
  const originalGetgid = process.getgid;

  beforeEach(() => {
    // Reset environment for each test
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original values
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
    if (originalGetuid) {
      process.getuid = originalGetuid;
    }
    if (originalGetgid) {
      process.getgid = originalGetgid;
    }
  });

  describe('Health Check Execution', () => {
    it('should return a valid health report', async () => {
      const report = await health();

      expect(report).toMatchObject({
        ok: expect.any(Boolean),
        checks: expect.any(Array),
        timestamp: expect.any(String),
      });

      // Timestamp should be a valid ISO string
      expect(new Date(report.timestamp!).getTime()).not.toBeNaN();

      // Checks array should not be empty
      expect(report.checks.length).toBeGreaterThan(0);
    });

    it('should include all expected health checks', async () => {
      const report = await health();

      const checkNames = report.checks.map(check => check.split(':')[0].replace(/^[✓✗]\s*/, ''));

      const expectedChecks = [
        'Node.js Version',
        'Memory',
        'Temp Directory',
        'Working Directory',
        'Network Isolation',
        'Process Permissions',
      ];

      for (const expectedCheck of expectedChecks) {
        expect(checkNames).toContain(expectedCheck);
      }
    });

    it('should format check results with status indicators', async () => {
      const report = await health();

      report.checks.forEach(check => {
        // Each check should start with either ✓ or ✗
        expect(check).toMatch(/^[✓✗]\s/);
      });
    });

    it('should set ok=false when any check fails', async () => {
      // Mock fs.writeFile to simulate temp directory access failure
      const originalWriteFile = fs.writeFile;
      vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('Permission denied'));
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce('test');
      vi.spyOn(fs, 'unlink').mockResolvedValueOnce(undefined);

      const report = await health();

      // Should detect the failure
      expect(report.ok).toBe(false);
      expect(report.checks.some(check => check.includes('✗'))).toBe(true);

      // Restore original function
      fs.writeFile = originalWriteFile;
    });
  });

  describe('Node.js Version Check', () => {
    it('should pass with supported Node.js version', async () => {
      // Current Node.js version should be >= 18
      const report = await health();

      const versionCheck = report.checks.find(check => check.includes('Node.js Version'));

      expect(versionCheck).toBeDefined();

      // Should pass since we're running on a supported version
      if (parseInt(process.version.substring(1).split('.')[0]) >= 18) {
        expect(versionCheck).toMatch(/^✓/);
        expect(versionCheck).toContain('supported');
      }
    });

    it('should handle version check errors gracefully', async () => {
      // Mock process.version to simulate error condition
      const originalVersion = process.version;
      Object.defineProperty(process, 'version', {
        value: 'invalid',
        configurable: true,
      });

      const report = await health();

      const versionCheck = report.checks.find(check => check.includes('Node.js Version'));

      expect(versionCheck).toBeDefined();

      // Restore original version
      Object.defineProperty(process, 'version', {
        value: originalVersion,
        configurable: true,
      });
    });
  });

  describe('Memory Check', () => {
    it('should check available memory', async () => {
      const report = await health();

      const memoryCheck = report.checks.find(check => check.includes('Memory'));

      expect(memoryCheck).toBeDefined();
      expect(memoryCheck).toMatch(/\d+MB/);
    });

    it('should handle memory check errors', async () => {
      // Mock process.memoryUsage to throw error
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = vi.fn().mockImplementation(() => {
        throw new Error('Memory check failed');
      }) as any;

      const report = await health();

      const memoryCheck = report.checks.find(check => check.includes('Memory'));

      expect(memoryCheck).toBeDefined();
      expect(memoryCheck).toMatch(/^✗/);

      // Restore original function
      process.memoryUsage = originalMemoryUsage;
    });
  });

  describe('Temp Directory Check', () => {
    it('should test temp directory access', async () => {
      const report = await health();

      const tempCheck = report.checks.find(check => check.includes('Temp Directory'));

      expect(tempCheck).toBeDefined();
      expect(tempCheck).toContain(tmpdir());
    });

    it('should fail when temp directory is not writable', async () => {
      // Mock fs operations to simulate write failure
      vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const report = await health();

      const tempCheck = report.checks.find(check => check.includes('Temp Directory'));

      expect(tempCheck).toBeDefined();
      expect(tempCheck).toMatch(/^✗/);
      expect(tempCheck).toContain('not accessible');
    });

    it('should handle partial temp directory operations', async () => {
      // Mock scenario where write succeeds but read fails
      vi.spyOn(fs, 'writeFile').mockResolvedValueOnce(undefined);
      vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('Read failed'));
      vi.spyOn(fs, 'unlink').mockResolvedValueOnce(undefined);

      const report = await health();

      const tempCheck = report.checks.find(check => check.includes('Temp Directory'));

      expect(tempCheck).toBeDefined();
      expect(tempCheck).toMatch(/^✗/);
    });
  });

  describe('Working Directory Check', () => {
    it('should test working directory access', async () => {
      const report = await health();

      const workingDirCheck = report.checks.find(check => check.includes('Working Directory'));

      expect(workingDirCheck).toBeDefined();
      expect(workingDirCheck).toMatch(/^✓/);
      expect(workingDirCheck).toContain('accessible');
    });

    it('should fail when working directory is not readable', async () => {
      // Mock fs.readdir to simulate access failure
      vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const report = await health();

      const workingDirCheck = report.checks.find(check => check.includes('Working Directory'));

      expect(workingDirCheck).toBeDefined();
      expect(workingDirCheck).toMatch(/^✗/);
      expect(workingDirCheck).toContain('not accessible');
    });
  });

  describe('Network Isolation Check', () => {
    it('should check for network proxy variables', async () => {
      const report = await health();

      const networkCheck = report.checks.find(check => check.includes('Network Isolation'));

      expect(networkCheck).toBeDefined();
      expect(networkCheck).toMatch(/^✓/);
    });

    it('should detect proxy environment variables', async () => {
      process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
      process.env.HTTPS_PROXY = 'https://proxy.example.com:8080';

      const report = await health();

      const networkCheck = report.checks.find(check => check.includes('Network Isolation'));

      expect(networkCheck).toBeDefined();
      expect(networkCheck).toMatch(/^✓/);
      expect(networkCheck).toContain('HTTP_PROXY, HTTPS_PROXY');
    });

    it('should handle network check errors', async () => {
      // Mock process.env access to simulate error
      const originalEnv = process.env;
      Object.defineProperty(process, 'env', {
        get: () => {
          throw new Error('Env access failed');
        },
        configurable: true,
      });

      const report = await health();

      const networkCheck = report.checks.find(check => check.includes('Network Isolation'));

      expect(networkCheck).toBeDefined();
      expect(networkCheck).toMatch(/^✗/);

      // Restore original env
      Object.defineProperty(process, 'env', {
        value: originalEnv,
        configurable: true,
      });
    });
  });

  describe('Process Permissions Check', () => {
    it('should check process permissions on Unix systems', async () => {
      if (process.platform !== 'win32') {
        const report = await health();

        const permCheck = report.checks.find(check => check.includes('Process Permissions'));

        expect(permCheck).toBeDefined();
        expect(permCheck).toMatch(/^✓/);
        expect(permCheck).toMatch(/UID: \d+, GID: \d+/);
      }
    });

    it('should skip permission check on Windows', async () => {
      // Mock Windows platform
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      // Mock getuid/getgid to return null (Windows behavior)
      process.getuid = undefined;
      process.getgid = undefined;

      const report = await health();

      const permCheck = report.checks.find(check => check.includes('Process Permissions'));

      expect(permCheck).toBeDefined();
      expect(permCheck).toMatch(/^✓/);
      expect(permCheck).toContain('Windows');

      // Restore original platform
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should warn when running as root', async () => {
      if (process.platform !== 'win32') {
        // Mock root user
        process.getuid = vi.fn().mockReturnValue(0);
        process.getgid = vi.fn().mockReturnValue(0);

        const report = await health();

        const permCheck = report.checks.find(check => check.includes('Process Permissions'));

        expect(permCheck).toBeDefined();
        expect(permCheck).toMatch(/^✓/);
        expect(permCheck).toContain('running as root');
      }
    });

    it('should handle permission check errors', async () => {
      if (process.platform !== 'win32') {
        // Mock getuid to throw error
        process.getuid = vi.fn().mockImplementation(() => {
          throw new Error('Permission check failed');
        });

        const report = await health();

        const permCheck = report.checks.find(check => check.includes('Process Permissions'));

        expect(permCheck).toBeDefined();
        expect(permCheck).toMatch(/^✗/);
      }
    });
  });

  describe('Health Report Formatting', () => {
    it('should format healthy report correctly', () => {
      const healthyReport: HealthReport = {
        ok: true,
        checks: [
          '✓ Node.js Version: Node.js v18.0.0 (supported)',
          '✓ Memory: 512MB available (sufficient)',
          '✓ Temp Directory: Temp directory accessible (/tmp)',
        ],
        timestamp: '2025-01-15T10:30:45.123Z',
      };

      const formatted = formatHealthReport(healthyReport);

      expect(formatted).toContain('System Health: ✓ HEALTHY');
      expect(formatted).toContain('(2025-01-15T10:30:45.123Z)');
      expect(formatted).toContain('✓ Node.js Version');
      expect(formatted).toContain('✓ Memory');
      expect(formatted).toContain('✓ Temp Directory');
      expect(formatted).not.toContain('Some health checks failed');
    });

    it('should format unhealthy report correctly', () => {
      const unhealthyReport: HealthReport = {
        ok: false,
        checks: [
          '✓ Node.js Version: Node.js v18.0.0 (supported)',
          '✗ Memory: 50MB available (minimum 100MB required)',
          '✗ Temp Directory: Temp directory not accessible',
        ],
        timestamp: '2025-01-15T10:30:45.123Z',
      };

      const formatted = formatHealthReport(unhealthyReport);

      expect(formatted).toContain('System Health: ✗ ISSUES DETECTED');
      expect(formatted).toContain('Some health checks failed');
      expect(formatted).toContain('✗ Memory');
      expect(formatted).toContain('✗ Temp Directory');
    });

    it('should handle report without timestamp', () => {
      const report: HealthReport = {
        ok: true,
        checks: ['✓ Test: All good'],
      };

      const formatted = formatHealthReport(report);

      expect(formatted).toContain('System Health: ✓ HEALTHY');
      expect(formatted).not.toContain('(');
      expect(formatted).not.toContain(')');
    });

    it('should preserve check formatting', () => {
      const report: HealthReport = {
        ok: true,
        checks: [
          '✓ Check 1: Success message',
          '✗ Check 2: Failure message with details',
          '✓ Check 3: Another success',
        ],
      };

      const formatted = formatHealthReport(report);
      const lines = formatted.split('\n');

      expect(lines).toContain('✓ Check 1: Success message');
      expect(lines).toContain('✗ Check 2: Failure message with details');
      expect(lines).toContain('✓ Check 3: Another success');
    });
  });

  describe('Error Handling', () => {
    it('should handle overall health check errors', async () => {
      // This test ensures that if the health function throws an error,
      // it should be a SystemError

      // Mock all fs operations to throw errors
      vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('Critical error'));
      vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('Critical error'));
      vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('Critical error'));
      vi.spyOn(fs, 'unlink').mockRejectedValue(new Error('Critical error'));

      // Health check should still complete, even if individual checks fail
      const report = await health();

      expect(report).toBeDefined();
      expect(typeof report.ok).toBe('boolean');
      expect(Array.isArray(report.checks)).toBe(true);
    });

    it('should provide meaningful error messages', async () => {
      // Mock temp directory check to fail with specific error
      vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      const report = await health();

      const tempCheck = report.checks.find(check => check.includes('Temp Directory'));

      expect(tempCheck).toBeDefined();
      expect(tempCheck).toMatch(/^✗/);
      expect(tempCheck).toContain('ENOSPC');
    });
  });

  describe('Integration', () => {
    it('should work with current system environment', async () => {
      // This is an integration test that runs against the actual system
      const report = await health();

      // Basic sanity checks
      expect(report).toBeDefined();
      expect(typeof report.ok).toBe('boolean');
      expect(Array.isArray(report.checks)).toBe(true);
      expect(report.checks.length).toBeGreaterThanOrEqual(6);
      expect(typeof report.timestamp).toBe('string');

      // At least the Node.js version check should pass
      const nodeCheck = report.checks.find(check => check.includes('Node.js Version'));
      expect(nodeCheck).toBeDefined();

      // Most basic checks should pass in a normal environment
      const successfulChecks = report.checks.filter(check => check.startsWith('✓'));
      expect(successfulChecks.length).toBeGreaterThan(0);
    });

    it('should have consistent check format across all checks', async () => {
      const report = await health();

      report.checks.forEach((check, index) => {
        // Each check should follow the format: [✓/✗] CheckName: Message
        expect(check, `Check ${index} doesn't match expected format: ${check}`).toMatch(
          /^[✓✗]\s\w+.*:\s.+/
        );
      });
    });
  });
});
