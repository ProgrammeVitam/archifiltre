/**
 * Health Command
 *
 * Checks system health and requirements for Archifiltre operation.
 */

import { Command, Flags } from '@oclif/core';
import { api, formatters, type HealthReport, type PathDiagnostics } from '@lib/helpers.ts';

export default class Health extends Command {
  static override description = 'Check system health and requirements';

  static override summary = 'Check system health and requirements';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --verbose',
    '<%= config.bin %> <%= command.id %> --log-format json',
    '<%= config.bin %> <%= command.id %> --no-color',
  ];

  static override flags = {
    verbose: Flags.boolean({
      char: 'V',
      description: 'Enable verbose output including stack traces',
      default: false,
    }),
    'no-color': Flags.boolean({
      description: 'Disable colored output',
      default: false,
    }),
    'log-format': Flags.string({
      description: 'Output format for structured data',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  /**
   * Color formatting utilities
   */
  private colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
  } as const;

  /**
   * Apply color formatting if colors are enabled
   */
  private colorize(text: string, color: keyof typeof this.colors, noColor: boolean): string {
    if (noColor || process.env.CI === 'true' || process.env.NO_COLOR === '1') {
      return text;
    }
    return `${this.colors[color]}${text}${this.colors.reset}`;
  }

  /**
   * Format path diagnostics for display
   */
  private formatPathDiagnostics(diagnostics: PathDiagnostics, noColor: boolean): string {
    const lines: string[] = [];

    lines.push('');
    lines.push(this.colorize('═══ Path Diagnostics ═══', 'cyan', noColor));
    lines.push('');

    // Platform info
    lines.push(this.colorize('Platform:', 'yellow', noColor));
    lines.push(`  OS: ${diagnostics.platform}`);
    lines.push(`  Mode: ${diagnostics.isStandalone ? 'Standalone executable' : 'Development'}`);
    lines.push('');

    // Cast config to access custom originalCwd property from StandaloneConfig
    const config = this.config as typeof this.config & { originalCwd?: string };
    const originalCwd = config.originalCwd;

    // Directory paths
    lines.push(this.colorize('Directories:', 'yellow', noColor));
    if (originalCwd) {
      lines.push(`  Original CWD:    ${originalCwd}`);
    } else {
      lines.push(
        `  Original CWD:    ${this.colorize('(not set - using fallback)', 'red', noColor)}`
      );
    }
    lines.push(`  Current CWD:     ${diagnostics.currentWorkingDir}`);
    lines.push(`  App Data:        ${diagnostics.appDataDir}`);
    lines.push(`  Database:        ${diagnostics.databaseDir}`);
    lines.push('');

    // Directory status
    lines.push(this.colorize('Directory Status:', 'yellow', noColor));
    const appDataStatus = diagnostics.appDataDirExists
      ? diagnostics.appDataDirWritable
        ? this.colorize('✓ exists, writable', 'green', noColor)
        : this.colorize('✗ exists, NOT writable', 'red', noColor)
      : this.colorize('✗ does not exist', 'red', noColor);
    lines.push(`  App Data:        ${appDataStatus}`);

    const dbStatus = diagnostics.databaseDirExists
      ? diagnostics.databaseDirWritable
        ? this.colorize('✓ exists, writable', 'green', noColor)
        : this.colorize('✗ exists, NOT writable', 'red', noColor)
      : this.colorize('○ not created yet (normal on first run)', 'dim', noColor);
    lines.push(`  Database:        ${dbStatus}`);
    lines.push('');

    // Environment variables
    if (diagnostics.environmentVars) {
      lines.push(this.colorize('Environment Variables:', 'yellow', noColor));
      for (const [key, value] of Object.entries(diagnostics.environmentVars)) {
        const displayValue = value || this.colorize('(not set)', 'dim', noColor);
        lines.push(`  ${key}: ${displayValue}`);
      }
    }

    return lines.join('\n');
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Health);

    try {
      // Include path diagnostics when verbose mode is enabled
      const healthReport: HealthReport = await api.health(flags.verbose);

      if (flags['log-format'] === 'json') {
        this.log(JSON.stringify(healthReport, null, 2));
      } else {
        const formattedHealth = formatters.health(healthReport);
        const colorizedHealth = healthReport.ok
          ? this.colorize(formattedHealth, 'green', flags['no-color'])
          : this.colorize(formattedHealth, 'red', flags['no-color']);

        this.log(colorizedHealth);

        // Show path diagnostics in verbose mode
        if (flags.verbose && healthReport.pathDiagnostics) {
          this.log(this.formatPathDiagnostics(healthReport.pathDiagnostics, flags['no-color']));
        }
      }

      // Exit with error code if health check failed
      if (!healthReport.ok) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(`Failed to perform health check: ${message}`, { exit: 1 });
    }
  }
}
