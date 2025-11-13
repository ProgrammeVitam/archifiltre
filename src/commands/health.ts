/**
 * Health Command
 *
 * Checks system health and requirements for Archifiltre operation.
 */

import { Command, Flags } from '@oclif/core';
import { api, formatters, type HealthReport } from '@lib/helpers.ts';

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

  public async run(): Promise<void> {
    const { flags } = await this.parse(Health);

    try {
      if (flags.verbose && flags['log-format'] !== 'json') {
        this.log('[VERBOSE] Starting system health check...');
      }

      const healthReport: HealthReport = await api.health();

      if (flags['log-format'] === 'json') {
        this.log(JSON.stringify(healthReport, null, 2));
      } else {
        const formattedHealth = formatters.health(healthReport);
        const colorizedHealth = healthReport.ok
          ? this.colorize(formattedHealth, 'green', flags['no-color'])
          : this.colorize(formattedHealth, 'red', flags['no-color']);

        this.log(colorizedHealth);
      }

      if (flags.verbose && flags['log-format'] !== 'json') {
        this.log(
          `[VERBOSE] Health check completed: ${healthReport.ok ? 'HEALTHY' : 'ISSUES DETECTED'}`
        );
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
