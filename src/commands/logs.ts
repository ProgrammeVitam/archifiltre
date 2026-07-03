/**
 * Logs Command
 *
 * View, monitor, and export application logs.
 * Provides easy access to log files regardless of platform.
 */

import { Command, Flags } from '@oclif/core';
import { getLogsDir } from '@lib/platform-paths.ts';
import { generateExportFilename, formatBytes, ensureDirectory } from '@lib/helpers.ts';
import {
  createScanDatabase,
  closeScanDatabase,
  getLatestRunId,
  getScanMetadata,
  type DatabaseConnection,
} from '@lib/database.ts';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';
import { zipSync } from 'fflate';
import * as os from 'node:os';
import pkg from '../../package.json' with { type: 'json' };

const execAsync = promisify(exec);

/** Frontend snapshot piped over stdin by the desktop app (--snapshot-stdin):
 *  the webview's in-memory error ring buffer + a UI-state summary. */
interface FrontendSnapshot {
  frontendLog?: string;
  uiState?: string;
}

export default class Logs extends Command {
  static override description = 'View, monitor, and export application logs';

  static override summary = 'View, monitor, and export application logs';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --follow',
    '<%= config.bin %> <%= command.id %> -f',
    '<%= config.bin %> <%= command.id %> --lines 50',
    '<%= config.bin %> <%= command.id %> --last-scan',
    '<%= config.bin %> <%= command.id %> --last-scan --db my-database',
    '<%= config.bin %> <%= command.id %> --export',
    '<%= config.bin %> <%= command.id %> --export --last-scan',
    '<%= config.bin %> <%= command.id %> --export --export-path ./my-logs.tar.gz',
    '<%= config.bin %> <%= command.id %> -e -p ./my-logs.tar.gz',
    '<%= config.bin %> <%= command.id %> --open',
  ];

  static override flags = {
    follow: Flags.boolean({
      char: 'f',
      description: 'Watch logs in real-time (like tail -f)',
      default: false,
    }),
    lines: Flags.integer({
      char: 'n',
      description: 'Number of lines to show',
      default: 20,
    }),
    export: Flags.boolean({
      char: 'e',
      description: 'Export logs to a zip file',
      default: false,
    }),
    'export-path': Flags.string({
      char: 'p',
      description: 'Output path for exported logs (used with --export)',
      required: false,
    }),
    'snapshot-stdin': Flags.boolean({
      description:
        'Read a frontend snapshot (JSON: {frontendLog, uiState}) from stdin and include it in the export — used by the desktop app',
      default: false,
    }),
    open: Flags.boolean({
      char: 'o',
      description: 'Open log directory in system file explorer',
      default: false,
    }),
    'no-color': Flags.boolean({
      description: 'Disable colored output',
      default: false,
    }),
    'last-scan': Flags.boolean({
      char: 's',
      description: 'Show only logs from the last scan',
      default: false,
    }),
    db: Flags.string({
      char: 'd',
      description: 'Database name to use (for --last-scan)',
      default: 'main',
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
    bold: '\x1b[1m',
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
   * Get all log files in the logs directory, sorted by modification time (newest first)
   */
  private async getLogFiles(
    logsDir: string
  ): Promise<{ name: string; path: string; size: number; mtime: Date }[]> {
    if (!fs.existsSync(logsDir)) {
      return [];
    }

    const entries = await fsp.readdir(logsDir, { withFileTypes: true });
    const logFiles: { name: string; path: string; size: number; mtime: Date }[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.log')) {
        const filePath = path.join(logsDir, entry.name);
        const stats = await fsp.stat(filePath);
        logFiles.push({
          name: entry.name,
          path: filePath,
          size: stats.size,
          mtime: stats.mtime,
        });
      }
    }

    // Sort by modification time, newest first
    return logFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  /**
   * Get the most recent log file
   */
  private async getMostRecentLogFile(logsDir: string): Promise<string | null> {
    const logFiles = await this.getLogFiles(logsDir);
    return logFiles.length > 0 ? logFiles[0].path : null;
  }

  /**
   * Get the last scan's start time from the database
   */
  private async getLastScanStartTime(
    dbName: string
  ): Promise<{ startTime: Date; runId: string } | null> {
    let database: DatabaseConnection | undefined;

    try {
      database = await createScanDatabase(dbName);
      const runId = await getLatestRunId(database).toPromise();

      if (!runId) {
        return null;
      }

      const metadata = await getScanMetadata(database, runId).toPromise();

      if (!metadata || !metadata.started_at) {
        return null;
      }

      // started_at is stored as Unix timestamp (seconds)
      return {
        startTime: new Date(metadata.started_at * 1000),
        runId,
      };
    } finally {
      if (database) {
        await closeScanDatabase(database);
      }
    }
  }

  /**
   * Parse timestamp from RFC5424 log line
   * Returns null if parsing fails
   */
  private parseLogTimestamp(line: string): Date | null {
    // RFC5424 format: <priority>version timestamp ...
    const match = line.match(/^<\d+>1 (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/);
    if (match) {
      return new Date(match[1]);
    }
    return null;
  }

  /**
   * Read log lines filtered by start time
   */
  private async readLinesAfterTime(
    filePath: string,
    startTime: Date,
    maxLines?: number
  ): Promise<string[]> {
    const lines: string[] = [];

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const timestamp = this.parseLogTimestamp(line);
      if (timestamp && timestamp >= startTime) {
        lines.push(line);
      }
    }

    // If maxLines specified, return only the last N lines
    if (maxLines && lines.length > maxLines) {
      return lines.slice(-maxLines);
    }

    return lines;
  }

  /**
   * Read the last N lines from a file
   */
  private async readLastLines(filePath: string, lineCount: number): Promise<string[]> {
    const lines: string[] = [];

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lines.push(line);
      if (lines.length > lineCount) {
        lines.shift();
      }
    }

    return lines;
  }

  /**
   * Format a log line for display (parse RFC5424 format)
   */
  private formatLogLine(line: string, noColor: boolean): string {
    // RFC5424 format: <priority>version timestamp hostname app-name procid msgid [structured-data] msg
    const rfc5424Match = line.match(/^<\d+>1 (\S+) \S+ \S+ \S+ \S+ (\[.*?\])? ?(.*)$/);

    if (rfc5424Match) {
      const [, timestamp, _structuredData, message] = rfc5424Match;
      const time = this.colorize(timestamp.substring(11, 19), 'dim', noColor); // Extract HH:MM:SS
      const date = this.colorize(timestamp.substring(0, 10), 'dim', noColor); // Extract YYYY-MM-DD

      // Color the message based on content
      let coloredMessage = message;
      if (message.toLowerCase().includes('error')) {
        coloredMessage = this.colorize(message, 'red', noColor);
      } else if (message.toLowerCase().includes('warn')) {
        coloredMessage = this.colorize(message, 'yellow', noColor);
      }

      return `${date} ${time} ${coloredMessage}`;
    }

    return line;
  }

  /**
   * Display log info and recent entries
   */
  private async showLogInfo(
    logsDir: string,
    lineCount: number,
    noColor: boolean,
    scanFilter?: { startTime: Date; runId: string }
  ): Promise<void> {
    if (scanFilter) {
      this.log(this.colorize('═══ Archifiltre Logs (Last Scan) ═══', 'cyan', noColor));
      this.log('');
      this.log(
        `${this.colorize('Scan:', 'bold', noColor)} ${scanFilter.runId} (started ${scanFilter.startTime.toISOString()})`
      );
    } else {
      this.log(this.colorize('═══ Archifiltre Logs ═══', 'cyan', noColor));
    }
    this.log('');

    // Show log directory location
    this.log(`${this.colorize('Log Directory:', 'bold', noColor)} ${logsDir}`);

    // Check if directory exists
    if (!fs.existsSync(logsDir)) {
      this.log('');
      this.log(
        this.colorize(
          'No logs directory found. Logs will be created when you run a command.',
          'dim',
          noColor
        )
      );
      return;
    }

    // List log files
    const logFiles = await this.getLogFiles(logsDir);

    if (logFiles.length === 0) {
      this.log('');
      this.log(this.colorize('No log files found.', 'dim', noColor));
      return;
    }

    this.log('');
    this.log(this.colorize('Log Files:', 'bold', noColor));

    for (const file of logFiles.slice(0, 5)) {
      const sizeStr = formatBytes(file.size);
      const dateStr = file.mtime.toISOString().substring(0, 10);
      this.log(`  ${this.colorize(file.name, 'cyan', noColor)} (${sizeStr}, ${dateStr})`);
    }

    if (logFiles.length > 5) {
      this.log(this.colorize(`  ... and ${logFiles.length - 5} more files`, 'dim', noColor));
    }

    // Show recent log entries
    const mostRecentFile = logFiles[0];
    if (mostRecentFile && mostRecentFile.size > 0) {
      this.log('');

      let lines: string[];
      if (scanFilter) {
        this.log(
          this.colorize(
            `Log entries since scan start from ${mostRecentFile.name}:`,
            'bold',
            noColor
          )
        );
        this.log(this.colorize('─'.repeat(60), 'dim', noColor));
        lines = await this.readLinesAfterTime(mostRecentFile.path, scanFilter.startTime, lineCount);

        if (lines.length === 0) {
          this.log(this.colorize('No log entries found for this scan.', 'dim', noColor));
        }
      } else {
        this.log(this.colorize(`Recent entries from ${mostRecentFile.name}:`, 'bold', noColor));
        this.log(this.colorize('─'.repeat(60), 'dim', noColor));
        lines = await this.readLastLines(mostRecentFile.path, lineCount);
      }

      for (const line of lines) {
        if (line.trim()) {
          this.log(this.formatLogLine(line, noColor));
        }
      }

      this.log(this.colorize('─'.repeat(60), 'dim', noColor));
    }

    this.log('');
    this.log(this.colorize('Tips:', 'bold', noColor));
    this.log(
      `  ${this.colorize('archifiltre logs --follow', 'cyan', noColor)}   Watch logs in real-time`
    );
    this.log(
      `  ${this.colorize('archifiltre logs --export', 'cyan', noColor)}   Export logs to a zip file`
    );
    this.log(
      `  ${this.colorize('archifiltre logs --open', 'cyan', noColor)}     Open log directory`
    );
  }

  /**
   * Watch logs in real-time (follow mode)
   */
  private async followLogs(logsDir: string, noColor: boolean): Promise<void> {
    const mostRecentFile = await this.getMostRecentLogFile(logsDir);

    if (!mostRecentFile) {
      this.log(this.colorize('No log files found to follow.', 'yellow', noColor));
      this.log('Run a command first to generate logs.');
      return;
    }

    this.log(this.colorize(`Following ${path.basename(mostRecentFile)}...`, 'cyan', noColor));
    this.log(this.colorize('Press Ctrl+C to stop', 'dim', noColor));
    this.log('');

    // Show last few lines first
    const initialLines = await this.readLastLines(mostRecentFile, 10);
    for (const line of initialLines) {
      if (line.trim()) {
        this.log(this.formatLogLine(line, noColor));
      }
    }

    // Watch for changes
    let lastSize = (await fsp.stat(mostRecentFile)).size;

    const watcher = fs.watch(mostRecentFile, async eventType => {
      if (eventType === 'change') {
        try {
          const stats = await fsp.stat(mostRecentFile);
          if (stats.size > lastSize) {
            // Read new content
            const stream = fs.createReadStream(mostRecentFile, {
              start: lastSize,
              encoding: 'utf-8',
            });

            const rl = readline.createInterface({
              input: stream,
              crlfDelay: Infinity,
            });

            for await (const line of rl) {
              if (line.trim()) {
                this.log(this.formatLogLine(line, noColor));
              }
            }

            lastSize = stats.size;
          }
        } catch {
          // File might have been rotated, find new file
          const newFile = await this.getMostRecentLogFile(logsDir);
          if (newFile && newFile !== mostRecentFile) {
            this.log(
              this.colorize(
                `\nLog rotated, now following ${path.basename(newFile)}...`,
                'cyan',
                noColor
              )
            );
            lastSize = 0;
          }
        }
      }
    });

    // Keep process alive until Ctrl+C
    await new Promise<void>(resolve => {
      process.on('SIGINT', () => {
        watcher.close();
        this.log('');
        this.log(this.colorize('Stopped following logs.', 'dim', noColor));
        resolve();
      });
    });
  }

  /**
   * Export logs to a zip file
   */
  private async exportLogs(
    logsDir: string,
    outputPath: string | undefined,
    noColor: boolean,
    scanFilter?: { startTime: Date; runId: string },
    snapshot?: FrontendSnapshot
  ): Promise<void> {
    // Cast config to access custom originalCwd property from StandaloneConfig
    const config = this.config as typeof this.config & { originalCwd?: string };
    const originalCwd = config.originalCwd || process.cwd();

    // Determine output path. Format follows the extension: .zip (what the desktop app
    // requests — friendlier to open/mail on Windows) or .tar.gz/.tgz (CLI default).
    let resolvedOutput: string;

    if (outputPath) {
      // User provided a path
      resolvedOutput = path.resolve(originalCwd, outputPath);

      // If it's a directory, generate filename
      if (fs.existsSync(resolvedOutput) && (await fsp.stat(resolvedOutput)).isDirectory()) {
        const filename = generateExportFilename({ type: 'logs', extension: 'tar.gz' });
        resolvedOutput = path.join(resolvedOutput, filename);
      } else if (
        !resolvedOutput.endsWith('.tar.gz') &&
        !resolvedOutput.endsWith('.tgz') &&
        !resolvedOutput.endsWith('.zip')
      ) {
        // Add extension if not present
        resolvedOutput += '.tar.gz';
      }
    } else {
      // Generate filename in current directory
      const filename = generateExportFilename({ type: 'logs', extension: 'tar.gz' });
      resolvedOutput = path.join(originalCwd, filename);
    }
    const asZip = resolvedOutput.endsWith('.zip');

    this.log(this.colorize('Exporting logs...', 'cyan', noColor));

    // Check if logs directory exists
    if (!fs.existsSync(logsDir)) {
      this.error('No logs directory found. Nothing to export.', { exit: 1 });
    }

    const logFiles = await this.getLogFiles(logsDir);

    if (logFiles.length === 0) {
      this.error('No log files found. Nothing to export.', { exit: 1 });
    }

    // Collect the bundle entries first, then write them in the chosen container.
    const entries: { name: string; content: Buffer; mtime?: Date }[] = [];
    let filteredCount = 0;

    if (scanFilter) {
      // When filtering by scan, create a filtered log entry
      const mostRecent = logFiles[0];
      const filteredLines = await this.readLinesAfterTime(mostRecent.path, scanFilter.startTime);

      if (filteredLines.length === 0) {
        this.error('No log entries found for this scan. Nothing to export.', { exit: 1 });
      }
      filteredCount = filteredLines.length;
      entries.push({
        name: `filtered-${scanFilter.runId}.log`,
        content: Buffer.from(`${filteredLines.join('\n')}\n`, 'utf-8'),
      });
    } else {
      for (const logFile of logFiles) {
        entries.push({
          name: logFile.name,
          content: await fsp.readFile(logFile.path),
          mtime: logFile.mtime,
        });
      }
    }

    // Frontend snapshot (desktop app): the webview's error ring buffer + UI-state summary.
    if (snapshot?.frontendLog) {
      entries.push({ name: 'frontend.log', content: Buffer.from(snapshot.frontendLog, 'utf-8') });
    }
    if (snapshot?.uiState) {
      entries.push({ name: 'ui-state.json', content: Buffer.from(snapshot.uiState, 'utf-8') });
    }

    // system-info.txt — enough environment context to read the bundle on its own.
    const sysInfo = [
      'Archifiltre log bundle',
      `Generated:      ${new Date().toISOString()}`,
      `App version:    ${(pkg as { version?: string }).version ?? 'unknown'}`,
      `Runtime:        Bun ${process.versions?.bun ?? '?'} (${os.platform()} ${os.release()}, ${os.arch()})`,
      `Hostname:       ${os.hostname()}`,
      `Logs directory: ${logsDir}`,
      `Log files:      ${scanFilter ? `1 (filtered, ${filteredCount} entries)` : logFiles.length}`,
      `Frontend snapshot: ${snapshot?.frontendLog || snapshot?.uiState ? 'included' : 'not included'}`,
      '',
    ].join('\n');
    entries.push({ name: 'system-info.txt', content: Buffer.from(sysInfo, 'utf-8') });

    const outputDir = path.dirname(resolvedOutput);
    await ensureDirectory(outputDir);

    if (asZip) {
      // .zip via fflate (pure JS, bundles cleanly into the compiled sidecar).
      const zipInput: Record<string, Uint8Array> = {};
      for (const e of entries) zipInput[e.name] = new Uint8Array(e.content);
      const zipped = zipSync(zipInput, { level: 6 });
      await fsp.writeFile(resolvedOutput, zipped);
    } else {
      // .tar.gz via tar-stream (the historical CLI format).
      const pack = tar.pack();
      const gzip = createGzip();
      const output = fs.createWriteStream(resolvedOutput);
      const pipelinePromise = pipeline(pack, gzip, output);
      for (const e of entries) {
        pack.entry({ name: e.name, size: e.content.length, mtime: e.mtime }, e.content);
      }
      pack.finalize();
      await pipelinePromise;
    }

    this.log('');
    this.log(
      this.colorize(
        scanFilter ? '✓ Scan logs exported successfully!' : '✓ Logs exported successfully!',
        'green',
        noColor
      )
    );
    this.log(`  ${this.colorize('Location:', 'bold', noColor)} ${resolvedOutput}`);
    if (scanFilter) {
      this.log(`  ${this.colorize('Scan:', 'bold', noColor)} ${scanFilter.runId}`);
      this.log(`  ${this.colorize('Log entries:', 'bold', noColor)} ${filteredCount}`);
    } else {
      this.log(`  ${this.colorize('Files:', 'bold', noColor)} ${entries.length} file(s)`);
    }

    const stats = await fsp.stat(resolvedOutput);
    this.log(`  ${this.colorize('Size:', 'bold', noColor)} ${formatBytes(stats.size)}`);
  }

  /** Read the full frontend snapshot JSON from stdin (--snapshot-stdin). Tolerant:
   *  a malformed/empty payload degrades to "no snapshot", never a failed export. */
  private async readSnapshotFromStdin(): Promise<FrontendSnapshot | undefined> {
    try {
      let data = '';
      // Bun's stdin primitive is the reliable path (the compiled sidecar always runs on
      // Bun); the node-stream loop covers other runtimes.
      const bunStdin = (globalThis as { Bun?: { stdin: { text(): Promise<string> } } }).Bun?.stdin;
      if (bunStdin) {
        data = await bunStdin.text();
      } else {
        for await (const chunk of process.stdin) {
          data += chunk;
          if (data.length > 50 * 1024 * 1024) break; // hard cap — snapshots are ring-buffered anyway
        }
      }
      if (!data.trim()) return undefined;
      const parsed = JSON.parse(data) as FrontendSnapshot;
      return {
        frontendLog: typeof parsed.frontendLog === 'string' ? parsed.frontendLog : undefined,
        uiState: typeof parsed.uiState === 'string' ? parsed.uiState : undefined,
      };
    } catch {
      this.warn('Could not read frontend snapshot from stdin — exporting sidecar logs only.');
      return undefined;
    }
  }

  /**
   * Open log directory in system file explorer
   */
  private async openLogsDirectory(logsDir: string, noColor: boolean): Promise<void> {
    // Ensure directory exists
    await ensureDirectory(logsDir);

    this.log(this.colorize('Opening log directory...', 'cyan', noColor));

    try {
      const platform = process.platform;
      let command: string;

      if (platform === 'darwin') {
        command = `open "${logsDir}"`;
      } else if (platform === 'win32') {
        command = `explorer "${logsDir}"`;
      } else {
        // Linux - try various file managers
        command = `xdg-open "${logsDir}" || gio open "${logsDir}" || gnome-open "${logsDir}" || kde-open "${logsDir}"`;
      }

      await execAsync(command);
      this.log(this.colorize(`✓ Opened: ${logsDir}`, 'green', noColor));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(
        this.colorize(`Could not open directory automatically: ${message}`, 'yellow', noColor)
      );
      this.log(`Log directory: ${logsDir}`);
    }
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Logs);
    const noColor = flags['no-color'];
    const logsDir = getLogsDir();

    try {
      // Handle --open flag
      if (flags.open) {
        await this.openLogsDirectory(logsDir, noColor);
        return;
      }

      // Get scan filter if --last-scan is specified
      let scanFilter: { startTime: Date; runId: string } | undefined;
      if (flags['last-scan']) {
        this.log(this.colorize('Loading last scan info...', 'dim', noColor));
        const scanInfo = await this.getLastScanStartTime(flags.db);

        if (!scanInfo) {
          this.error(
            `No scans found in database '${flags.db}'. Run a scan first with: archifiltre scan <directory>`,
            { exit: 1 }
          );
        }

        scanFilter = scanInfo;
      }

      // Handle --export flag
      if (flags.export) {
        const snapshot = flags['snapshot-stdin'] ? await this.readSnapshotFromStdin() : undefined;
        await this.exportLogs(logsDir, flags['export-path'], noColor, scanFilter, snapshot);
        return;
      }

      // Handle --follow flag
      if (flags.follow) {
        if (scanFilter) {
          this.warn('Note: --follow mode shows all new logs, not just from the last scan.');
        }
        await this.followLogs(logsDir, noColor);
        return;
      }

      // Default: show log info
      await this.showLogInfo(logsDir, flags.lines, noColor, scanFilter);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(`Failed to access logs: ${message}`, { exit: 1 });
    }
  }
}
