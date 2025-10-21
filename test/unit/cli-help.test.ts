/**
 * Unit tests for CLI help functionality
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeCommand, parseArgs, createContext } from '@cli/commands-registry.js';

describe('CLI Help', () => {
  // Store original environment variables
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset environment for each test
    delete process.env.NO_COLOR;
    delete process.env.CI;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('Help Command Execution', () => {
    it('should execute help command successfully', async () => {
      const result = await executeCommand(['help']);

      expect(result.exitCode).toBe(0);
      expect(result.output).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('should show help when no command is provided', async () => {
      const result = await executeCommand([]);

      expect(result.exitCode).toBe(0);
      expect(result.output).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('should show help with --help flag', async () => {
      const result = await executeCommand(['--help']);

      expect(result.exitCode).toBe(0);
      expect(result.output).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('should show help with -h flag', async () => {
      const result = await executeCommand(['-h']);

      expect(result.exitCode).toBe(0);
      expect(result.output).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('should show help for specific commands with --help', async () => {
      const result = await executeCommand(['health', '--help']);

      expect(result.exitCode).toBe(0);
      expect(result.output).toBeDefined();
      expect(result.error).toBeUndefined();
    });
  });

  describe('Help Content Validation', () => {
    let helpOutput: string;

    beforeEach(async () => {
      const result = await executeCommand(['--help']);
      helpOutput = result.output || '';
    });

    it('should contain application title and description', () => {
      expect(helpOutput).toContain('Archifiltre v5');
      expect(helpOutput).toContain('Privacy-friendly, 100% offline');
    });

    it('should contain USAGE section', () => {
      expect(helpOutput).toMatch(/USAGE:/i);
      expect(helpOutput).toContain('archifiltre [OPTIONS] [COMMAND]');
    });

    it('should contain COMMANDS section', () => {
      expect(helpOutput).toMatch(/COMMANDS:/i);
      expect(helpOutput).toContain('health');
      expect(helpOutput).toContain('version');
      expect(helpOutput).toContain('help');
    });

    it('should contain OPTIONS section', () => {
      expect(helpOutput).toMatch(/OPTIONS:/i);
    });

    it('should contain EXAMPLES section', () => {
      expect(helpOutput).toMatch(/EXAMPLES:/i);
      expect(helpOutput).toContain('archifiltre --help');
      expect(helpOutput).toContain('archifiltre --version');
    });

    it('should contain EXIT CODES section', () => {
      expect(helpOutput).toMatch(/EXIT CODES:/i);
      expect(helpOutput).toContain('0    Success');
      expect(helpOutput).toContain('1    System error');
      expect(helpOutput).toContain('2    Usage error');
    });

    it('should contain required flags', () => {
      const requiredFlags = ['--help', '--version', '--verbose', '--no-color', '--log-format'];

      for (const flag of requiredFlags) {
        expect(helpOutput).toContain(flag);
      }
    });

    it('should contain short flag alternatives', () => {
      expect(helpOutput).toContain('-h');
      expect(helpOutput).toContain('-v');
      expect(helpOutput).toContain('-V');
    });

    it('should contain project URL', () => {
      expect(helpOutput).toContain('github.com/ProgrammeVitam/archifiltre');
    });
  });

  describe('Color Formatting', () => {
    it('should contain ANSI color codes by default', async () => {
      const result = await executeCommand(['--help']);
      const output = result.output || '';

      // Check for ANSI escape sequences (color codes)
      expect(output).toMatch(/\x1b\[\d+m/);
    });

    it('should not contain colors when NO_COLOR is set', async () => {
      process.env.NO_COLOR = '1';

      const result = await executeCommand(['--help']);
      const output = result.output || '';

      // Should not contain ANSI escape sequences
      expect(output).not.toMatch(/\x1b\[\d+m/);
    });

    it('should not contain colors when CI environment is detected', async () => {
      process.env.CI = 'true';

      const result = await executeCommand(['--help']);
      const output = result.output || '';

      // Should not contain ANSI escape sequences
      expect(output).not.toMatch(/\x1b\[\d+m/);
    });

    it('should not contain colors with --no-color flag', async () => {
      const result = await executeCommand(['--help', '--no-color']);
      const output = result.output || '';

      // Should not contain ANSI escape sequences
      expect(output).not.toMatch(/\x1b\[\d+m/);
    });
  });

  describe('Argument Parsing', () => {
    it('should parse help flag correctly', () => {
      const parsed = parseArgs(['--help']);

      expect(parsed.flags.help).toBe(true);
      expect(parsed.command).toBeUndefined();
    });

    it('should parse short help flag correctly', () => {
      const parsed = parseArgs(['-h']);

      expect(parsed.flags.help).toBe(true);
      expect(parsed.command).toBeUndefined();
    });

    it('should parse help command correctly', () => {
      const parsed = parseArgs(['help']);

      expect(parsed.command).toBe('help');
      expect(parsed.flags.help).toBeUndefined();
    });

    it('should parse help with other flags', () => {
      const parsed = parseArgs(['--help', '--verbose', '--no-color']);

      expect(parsed.flags.help).toBe(true);
      expect(parsed.flags.verbose).toBe(true);
      expect(parsed.flags['no-color']).toBe(true);
    });
  });

  describe('Context Creation', () => {
    it('should create correct context for help', () => {
      const parsed = parseArgs(['--help', '--verbose', '--no-color']);
      const context = createContext(parsed);

      expect(context.verbose).toBe(true);
      expect(context.noColor).toBe(true);
      expect(context.logFormat).toBe('text');
    });

    it('should handle JSON log format', () => {
      const parsed = parseArgs(['--help', '--log-format', 'json']);
      const context = createContext(parsed);

      expect(context.logFormat).toBe('json');
    });

    it('should default to text log format', () => {
      const parsed = parseArgs(['--help']);
      const context = createContext(parsed);

      expect(context.logFormat).toBe('text');
    });
  });

  describe('Help Content Structure', () => {
    let helpLines: string[];

    beforeEach(async () => {
      const result = await executeCommand(['--help']);
      helpLines = (result.output || '').split('\n');
    });

    it('should have proper section ordering', () => {
      const sectionIndices = {
        usage: helpLines.findIndex(line => line.includes('USAGE:')),
        commands: helpLines.findIndex(line => line.includes('COMMANDS:')),
        options: helpLines.findIndex(line => line.includes('OPTIONS:')),
        examples: helpLines.findIndex(line => line.includes('EXAMPLES:')),
        exitCodes: helpLines.findIndex(line => line.includes('EXIT CODES:')),
      };

      // All sections should be present
      Object.values(sectionIndices).forEach(index => {
        expect(index).toBeGreaterThan(-1);
      });

      // Sections should be in logical order
      expect(sectionIndices.usage).toBeLessThan(sectionIndices.commands);
      expect(sectionIndices.commands).toBeLessThan(sectionIndices.options);
      expect(sectionIndices.options).toBeLessThan(sectionIndices.examples);
      expect(sectionIndices.examples).toBeLessThan(sectionIndices.exitCodes);
    });

    it('should have proper indentation', () => {
      const commandLines = helpLines.filter(
        line => line.includes('health') || line.includes('version') || line.includes('help')
      );

      // Command descriptions should be indented
      commandLines.forEach(line => {
        if (line.trim().length > 0) {
          expect(line.startsWith('  ')).toBe(true);
        }
      });
    });

    it('should have consistent formatting', () => {
      // Check that flag descriptions are properly aligned
      const flagLines = helpLines.filter(line => line.includes('--'));

      flagLines.forEach(line => {
        if (line.includes('--') && line.trim().length > 0) {
          // Should start with proper indentation
          expect(line.startsWith('  ')).toBe(true);
        }
      });
    });
  });
});
