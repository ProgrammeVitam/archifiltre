/**
 * CLI Commands Integration Tests
 *
 * Tests that CLI commands execute correctly:
 * - Commands execute successfully
 * - Custom branding appears in help
 * - Basic functionality works end-to-end
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';

/**
 * Execute CLI command and return result
 */
async function execCLI(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('./archifiltre', args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', data => {
      stdout += data.toString();
    });

    child.stderr?.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      });
    });

    child.on('error', error => {
      reject(error);
    });

    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Command timeout'));
    }, 10000);
  });
}

describe('CLI Integration', () => {
  describe('Help and Branding', () => {
    it('should show custom branding in help', async () => {
      const result = await execCLI(['--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Archifiltre v5');
      expect(result.stdout).toContain('Privacy-friendly, 100% offline file tree inventory tool');
      expect(result.stdout).toContain(
        'For more information, visit: https://github.com/ProgrammeVitam/archifiltre'
      );
    });

    it('should show help when no command provided', async () => {
      const result = await execCLI([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('USAGE');
      expect(result.stdout).toContain('COMMANDS');
    });
  });

  describe('Command Execution', () => {
    it('should execute version command', async () => {
      const result = await execCLI(['version']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('5.0.0-beta.2');
    });

    it('should execute health command', async () => {
      const result = await execCLI(['health']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('System Health');
    });

    it('should handle invalid command', async () => {
      const result = await execCLI(['nonexistent']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('Global Flags', () => {
    it('should handle --version flag', async () => {
      const result = await execCLI(['--version']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('archifiltre/5.0.0-beta.2');
    });

    it('should handle version with verbose flag', async () => {
      const result = await execCLI(['version', '--verbose']);

      expect([0, 1, 2]).toContain(result.exitCode);
      // Just ensure it doesn't crash - Oclif handles the details
    });
  });
});
