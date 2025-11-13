/**
 * Scan Command
 *
 * Scans directory trees using the consolidated streaming pipeline.
 * Single-pass RxJS pipeline for discovery, ingestion, and duplicate detection.
 * Uses oclif UI patterns for clean, professional output.
 */

import { Command, Args, Flags, ux } from '@oclif/core';
import { setupOclifContext, logger } from '@lib/logging.ts';
import { formatDuration } from '@lib/helpers.ts';
import { createScanDatabase, closeScanDatabase, type DatabaseConnection } from '@lib/database.ts';
import { summary } from '@extensions/summary.ts';
import {
  scanDirectory,
  validateScanPath,
  generateRunId,
  type ScanConfig,
  type ScanResult,
} from '@lib/scanner.ts';

export default class Scan extends Command {
  static override description = 'Scan directory tree and detect duplicates';

  static override examples = [
    '<%= config.bin %> <%= command.id %> /path/to/scan',
    '<%= config.bin %> <%= command.id %> ~/Documents --include-hidden',
    '<%= config.bin %> <%= command.id %> /data --batch-size 2000',
    '<%= config.bin %> <%= command.id %> /files --db custom-scan',
  ];

  static override flags = {
    'include-hidden': Flags.boolean({
      description: 'Include hidden files and directories',
      default: false,
    }),
    'batch-size': Flags.integer({
      description: 'Batch size for database operations',
      default: 1000,
      min: 100,
      max: 10000,
    }),
    'min-size': Flags.integer({
      description: 'Minimum file size in bytes for hash calculation',
      default: 0,
      min: 0,
    }),
    db: Flags.string({
      description: 'Database name for storing scan results',
      default: 'main',
    }),
    'run-id': Flags.string({
      description: 'Custom run identifier (auto-generated if not provided)',
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Enable verbose output with detailed progress',
      default: false,
    }),
    'no-color': Flags.boolean({
      description: 'Disable colored output',
      default: false,
    }),
  };

  static override args = {
    directory: Args.string({
      description: 'Directory path to scan',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Scan);
    const directory = args.directory as string;

    const cleanupLogging = setupOclifContext(this);
    let database: DatabaseConnection | undefined;

    try {
      // Validate scan target
      const pathValidation = await validateScanPath(directory);
      if (!pathValidation.valid) {
        this.error(`Invalid scan target: ${pathValidation.error}`, { exit: 1 });
      }

      const rootPath = pathValidation.resolvedPath!;
      const runId = flags['run-id'] || generateRunId();

      this.log(`Scanning ${rootPath}`);

      // Create database connection
      database = await createScanDatabase(flags.db);

      // Configure scanner
      const scanConfig: ScanConfig = {
        rootPath,
        runId,
        includeHidden: flags['include-hidden'],
        batchSize: flags['batch-size'],
      };

      // Start scanning with clean oclif action
      const startTime = Date.now();
      let lastProgress: ScanResult = {
        phase: 'complete',
        filesDiscovered: 0,
        filesIngested: 0,
        duplicateGroups: 0,
      };

      ux.action.start(`Scanning ${rootPath}`);

      await new Promise<void>((resolve, reject) => {
        const result$ = scanDirectory(database!, scanConfig, (status: string) => {
          logger.debug('Progress callback received', { status });
          // Direct assignment - oclif should handle the refresh
          ux.action.status = status;
        });

        result$.subscribe({
          next: (result: ScanResult) => {
            lastProgress = result;
          },
          complete: () => {
            const duration = Date.now() - startTime;
            const durationStr = formatDuration(duration);

            ux.action.stop(
              `${lastProgress.filesIngested.toLocaleString()} files, ${lastProgress.duplicateGroups.toLocaleString()} duplicate groups (${durationStr})`
            );
            resolve();
          },
          error: error => {
            ux.action.stop('failed');
            reject(error);
          },
        });
      });

      // Display summary results
      await summary(database!, runId, this);

      const finalDuration = Date.now() - startTime;
      logger.debug('Scan completed successfully', {
        runId,
        rootPath,
        duration: finalDuration,
        filesDiscovered: lastProgress.filesDiscovered,
        duplicateGroups: lastProgress.duplicateGroups,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Scan command failed', error instanceof Error ? error : undefined, {
        directory,
        runId: flags['run-id'],
        db: flags.db,
      });

      this.error(`Scan failed: ${errorMessage}`, { exit: 1 });
    } finally {
      // Cleanup
      if (database) {
        await closeScanDatabase(database);
      }
      cleanupLogging();
    }
  }
}
