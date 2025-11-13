/**
 * Version Command
 *
 * Shows version information for Archifiltre including build details.
 */

import { Command, Flags } from '@oclif/core';
import { api, formatters, type VersionInfo } from '@lib/helpers.ts';

export default class Version extends Command {
  static override description = 'Show version information';

  static override summary = 'Show version information';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --verbose',
    '<%= config.bin %> <%= command.id %> --log-format json',
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

  public async run(): Promise<void> {
    const { flags } = await this.parse(Version);

    try {
      if (flags.verbose && flags['log-format'] !== 'json') {
        this.log('[VERBOSE] Retrieving version information...');
      }

      const versionInfo: VersionInfo = api.version();

      if (flags['log-format'] === 'json') {
        this.log(JSON.stringify(versionInfo, null, 2));
      } else {
        const formattedVersion = formatters.getFormattedVersion();
        this.log(formattedVersion);
      }

      if (flags.verbose && flags['log-format'] !== 'json') {
        this.log(`[VERBOSE] Version info retrieved: ${versionInfo.appVersion}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(`Failed to retrieve version information: ${message}`, { exit: 1 });
    }
  }
}
