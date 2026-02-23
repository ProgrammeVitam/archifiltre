/**
 * Logs Command
 *
 * View, monitor, and export application logs.
 * Provides easy access to log files regardless of platform.
 */

import { Command, Flags } from '@oclif/core';
import { getLogsDir } from '@lib/platform-paths.ts';
import { generateExportFilename, formatBytes } from '@lib/helpers.ts';
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

const execAsync = promisify(exec);

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
    scanFilter?: { startTime: Date; runId: string }
  ): Promise<void> {
    // Cast config to access custom originalCwd property from StandaloneConfig
    const config = this.config as typeof this.config & { originalCwd?: string };
    const originalCwd = config.originalCwd || process.cwd();

    // Determine output path
    let resolvedOutput: string;

    if (outputPath) {
      // User provided a path
      resolvedOutput = path.resolve(originalCwd, outputPath);

      // If it's a directory, generate filename
      if (fs.existsSync(resolvedOutput) && (await fsp.stat(resolvedOutput)).isDirectory()) {
        const filename = generateExportFilename({ type: 'logs', extension: 'tar.gz' });
        resolvedOutput = path.join(resolvedOutput, filename);
      } else if (!resolvedOutput.endsWith('.tar.gz') && !resolvedOutput.endsWith('.tgz')) {
        // Add extension if not present
        resolvedOutput += '.tar.gz';
      }
    } else {
      // Generate filename in current directory
      const filename = generateExportFilename({ type: 'logs', extension: 'tar.gz' });
      resolvedOutput = path.join(originalCwd, filename);
    }

    this.log(this.colorize('Exporting logs...', 'cyan', noColor));

    // Check if logs directory exists
    if (!fs.existsSync(logsDir)) {
      this.error('No logs directory found. Nothing to export.', { exit: 1 });
    }

    const logFiles = await this.getLogFiles(logsDir);

    if (logFiles.length === 0) {
      this.error('No log files found. Nothing to export.', { exit: 1 });
    }

    // Create a tar.gz archive (using built-in zlib for gzip)
    // We'll create a simple concatenated gzip of all log files
    const outputDir = path.dirname(resolvedOutput);
    await fsp.mkdir(outputDir, { recursive: true });

    // For simplicity, we'll create a .tar.gz using shell command if available,
    // otherwise fall back to copying files to a directory
    try {
      if (scanFilter) {
        // When filtering by scan, create a filtered log file first
        const filteredLogPath = path.join(logsDir, `filtered-${scanFilter.runId}.log`);
        const mostRecent = logFiles[0];
        const filteredLines = await this.readLinesAfterTime(mostRecent.path, scanFilter.startTime);

        if (filteredLines.length === 0) {
          this.error('No log entries found for this scan. Nothing to export.', { exit: 1 });
        }

        await fsp.writeFile(filteredLogPath, `${filteredLines.join('\n')}\n`);

        try {
          await execAsync(`tar -czf "${resolvedOutput}" "filtered-${scanFilter.runId}.log"`, {
            cwd: logsDir,
          });
        } finally {
          // Clean up temporary filtered file
          await fsp.unlink(filteredLogPath).catch(() => {});
        }

        this.log('');
        this.log(this.colorize('✓ Scan logs exported successfully!', 'green', noColor));
        this.log(`  ${this.colorize('Location:', 'bold', noColor)} ${resolvedOutput}`);
        this.log(`  ${this.colorize('Scan:', 'bold', noColor)} ${scanFilter.runId}`);
        this.log(`  ${this.colorize('Log entries:', 'bold', noColor)} ${filteredLines.length}`);

        const stats = await fsp.stat(resolvedOutput);
        this.log(`  ${this.colorize('Size:', 'bold', noColor)} ${formatBytes(stats.size)}`);
      } else {
        // Export all log files
        const fileList = logFiles.map(f => f.name).join(' ');

        await execAsync(`tar -czf "${resolvedOutput}" ${fileList}`, { cwd: logsDir });

        this.log('');
        this.log(this.colorize('✓ Logs exported successfully!', 'green', noColor));
        this.log(`  ${this.colorize('Location:', 'bold', noColor)} ${resolvedOutput}`);
        this.log(`  ${this.colorize('Files:', 'bold', noColor)} ${logFiles.length} log file(s)`);

        const stats = await fsp.stat(resolvedOutput);
        this.log(`  ${this.colorize('Size:', 'bold', noColor)} ${formatBytes(stats.size)}`);
      }
    } catch {
      // Fallback: create a gzipped copy of the most recent log
      const gzPath = resolvedOutput.replace('.zip', '.log.gz');
      const mostRecent = logFiles[0];

      const source = fs.createReadStream(mostRecent.path);
      const destination = fs.createWriteStream(gzPath);
      const gzip = createGzip();

      await pipeline(source, gzip, destination);

      this.log('');
      this.log(this.colorize('✓ Log exported successfully!', 'green', noColor));
      this.log(`  ${this.colorize('Location:', 'bold', noColor)} ${gzPath}`);
      this.log(
        this.colorize(
          '  (Note: Only most recent log file exported. Install tar for full export.)',
          'dim',
          noColor
        )
      );
    }
  }

  /**
   * Open log directory in system file explorer
   */
  private async openLogsDirectory(logsDir: string, noColor: boolean): Promise<void> {
    // Ensure directory exists
    if (!fs.existsSync(logsDir)) {
      await fsp.mkdir(logsDir, { recursive: true });
    }

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
        await this.exportLogs(logsDir, flags['export-path'], noColor, scanFilter);
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
