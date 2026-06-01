/**
 * Scan Command
 *
 * Scans directory trees using the consolidated streaming pipeline.
 * Single-pass RxJS pipeline for discovery, ingestion, and duplicate detection.
 * Uses oclif UI patterns for clean, professional output.
 */

import { Args, Flags, ux } from '@oclif/core';
import path from 'node:path';
import { lastValueFrom } from 'rxjs';
import { logger } from '@lib/logging.ts';
import { formatDuration } from '@lib/helpers.ts';
import {
  createScanDatabase,
  insertScanMetadata,
  updateScanMetadata,
  type DatabaseConnection,
} from '@lib/database.ts';
import { BaseCommand } from '@lib/base-command.ts';
import type { JobContext } from '@lib/job-context.ts';
import { summary } from '@extensions/summary.ts';
import {
  scanDirectory,
  validateScanPath,
  generateRunId,
  type ScanConfig,
  type ScanResult,
  type ScanProgressEvent,
} from '@lib/scanner.ts';

export default class Scan extends BaseCommand {
  static override description = 'Scan directory tree and detect duplicates';

  static override examples = [
    '<%= config.bin %> <%= command.id %> /path/to/scan',
    '<%= config.bin %> <%= command.id %> ~/Documents --include-hidden',
    '<%= config.bin %> <%= command.id %> /data --batch-size 2000 --disable-archives',
    '<%= config.bin %> <%= command.id %> /files --db custom-scan --max-archive-depth 5',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
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
    'disable-archives': Flags.boolean({
      description: 'Disable archive processing (archives will be treated as regular files)',
      default: false,
    }),
    'max-archive-depth': Flags.integer({
      description: 'Maximum depth for nested archives',
      default: 3,
      min: 1,
      max: 10,
    }),
    'max-archive-size': Flags.integer({
      description: 'Maximum archive size in MB for processing',
      default: 100,
      min: 1,
      max: 1000,
    }),
    'archive-timeout': Flags.integer({
      description: 'Timeout for archive processing in seconds',
      default: 30,
      min: 5,
      max: 300,
    }),
    'disable-archive-nesting': Flags.boolean({
      description: 'Disable processing of archives within archives',
      default: false,
    }),
  };

  static override args = {
    directory: Args.string({
      description: 'Directory path to scan',
      required: true,
    }),
  };

  // Set by openDatabase() so jobLabel can reference it
  private _rootPath = '';

  get jobType() { return 'scan'; }
  get jobLabel() { return `Scan ${this._rootPath || '...'}`; }
  get phases() { return ['discovery', 'prefilter', 'hashing', 'duplicate-detection']; }

  async openDatabase(): Promise<{ db: DatabaseConnection; runId: string; rootPath: string }> {
    const { args, flags } = await this.parse(Scan);

    const config = this.config as typeof this.config & { originalCwd?: string };
    const originalCwd = config.originalCwd || process.cwd();
    const resolvedDirectory = path.resolve(originalCwd, args.directory as string);

    const pathValidation = await validateScanPath(resolvedDirectory);
    if (!pathValidation.valid) {
      this.error(`Invalid scan target: ${pathValidation.error}`, { exit: 1 });
    }

    const rootPath = pathValidation.resolvedPath!;
    const runId = flags['run-id'] || generateRunId();

    this._rootPath = rootPath;

    logger.info('Scan started', {
      runId,
      directory: rootPath,
      db: flags.db,
      includeHidden: flags['include-hidden'],
      archivesEnabled: !flags['disable-archives'],
    });

    const db = await createScanDatabase(flags.db);
    return { db, runId, rootPath };
  }

  async runJob(context: JobContext): Promise<void> {
    const { flags } = await this.parse(Scan);

    const scanConfig: ScanConfig = {
      rootPath: context.rootPath,
      runId: context.runId,
      includeHidden: flags['include-hidden'],
      batchSize: flags['batch-size'],
      enableArchiveProcessing: !flags['disable-archives'],
      maxArchiveDepth: flags['max-archive-depth'],
      maxArchiveSize: flags['max-archive-size'] * 1024 * 1024,
      archiveTimeoutMs: flags['archive-timeout'] * 1000,
      enableArchiveNesting: !flags['disable-archive-nesting'],
    };

    const startTime = Date.now();
    const startedAt = Math.floor(startTime / 1000);
    let lastProgress: ScanResult = {
      phase: 'complete',
      filesDiscovered: 0,
      filesIngested: 0,
      duplicateGroups: 0,
    };

    const isTTY = process.stdout.isTTY;

    if (isTTY) {
      ux.action.start(`Scanning ${context.rootPath}`);
    }

    lastProgress = await lastValueFrom(
      scanDirectory(context.database, scanConfig, (event: ScanProgressEvent) => {
        context.onProgress?.(event.phase, event.filesDiscovered, null, event.status);
        if (isTTY) {
          ux.action.status = event.status;
        } else if (!context.onProgress) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
      })
    );

    const duration = Date.now() - startTime;

    if (isTTY) {
      ux.action.stop(
        `${lastProgress.filesIngested.toLocaleString()} files, ${lastProgress.duplicateGroups.toLocaleString()} duplicate groups (${formatDuration(duration)})`
      );
    }

    await insertScanMetadata(context.database, context.runId, context.rootPath, startedAt).toPromise();
    await updateScanMetadata(context.database, context.runId, lastProgress.filesIngested).toPromise();

    await summary(context.database, context.runId, this);

    logger.info('Scan completed', {
      runId: context.runId,
      rootPath: context.rootPath,
      durationMs: duration,
      filesDiscovered: lastProgress.filesDiscovered,
      filesIngested: lastProgress.filesIngested,
      duplicateGroups: lastProgress.duplicateGroups,
    });
  }
}
