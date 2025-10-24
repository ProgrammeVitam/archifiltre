/**
 * Console Log Provider
 *
 * Outputs logs to stdout/stderr with color formatting and structured display.
 * Respects CI environments and color preferences.
 */

import type { LogEntry } from '@api/dto.js';
import type { LogProvider, ConsoleProviderConfig } from '../types.js';

/**
 * ANSI color codes for terminal output
 */
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',

  // Text colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',

  // Bright text colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
} as const;

/**
 * Log level styling configuration
 */
const LOG_LEVEL_STYLES = {
  debug: {
    color: COLORS.dim + COLORS.cyan,
    prefix: '🔍',
    label: 'DEBUG',
  },
  info: {
    color: COLORS.blue,
    prefix: 'ℹ️ ',
    label: 'INFO ',
  },
  warn: {
    color: COLORS.yellow,
    prefix: '⚠️ ',
    label: 'WARN ',
  },
  error: {
    color: COLORS.brightRed,
    prefix: '❌',
    label: 'ERROR',
  },
} as const;

/**
 * Default console provider configuration
 */
const DEFAULT_CONFIG: ConsoleProviderConfig = {
  enabled: true,
  colorize: true,
  includeStackTrace: false,
} as const;

/**
 * Console Log Provider Implementation
 */
export class ConsoleLogProvider implements LogProvider {
  public readonly name = 'console';
  private readonly config: ConsoleProviderConfig;
  private readonly supportsColor: boolean;

  constructor(config: Partial<ConsoleProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.supportsColor = this.detectColorSupport();
  }

  /**
   * Check if provider is enabled
   */
  public get isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Process a log entry and output to console
   */
  public async log(entry: LogEntry): Promise<void> {
    try {
      const formatted = this.formatLogEntry(entry);

      // Use stderr for warn/error, stdout for others
      if (entry.level === 'warn' || entry.level === 'error') {
        process.stderr.write(formatted + '\n');
      } else {
        process.stdout.write(formatted + '\n');
      }
    } catch (error) {
      // Fallback: output error to stderr without formatting
      process.stderr.write(`[Console Provider Error] ${error}\n`);
      process.stderr.write(`[Original Log] ${entry.level}: ${entry.message}\n`);
    }
  }

  /**
   * Health check - console is always available
   */
  public async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Format a log entry for console output
   */
  private formatLogEntry(entry: LogEntry): string {
    const shouldUseColors = this.config.colorize && this.supportsColor;
    const style = LOG_LEVEL_STYLES[entry.level];

    // Build the formatted message
    const parts: string[] = [];

    // Timestamp (if available)
    if (entry.timestamp) {
      const timestamp = this.formatTimestamp(entry.timestamp);
      if (shouldUseColors) {
        parts.push(COLORS.dim + timestamp + COLORS.reset);
      } else {
        parts.push(timestamp);
      }
    }

    // Log level with styling
    const levelLabel = shouldUseColors
      ? `${style.color}${style.prefix} ${style.label}${COLORS.reset}`
      : `[${style.label}]`;
    parts.push(levelLabel);

    // Main message
    const message = shouldUseColors && entry.level === 'error'
      ? `${COLORS.brightRed}${entry.message}${COLORS.reset}`
      : entry.message;
    parts.push(message);

    let result = parts.join(' ');

    // Add context if present
    if (entry.context && Object.keys(entry.context).length > 0) {
      const contextStr = this.formatContext(entry.context, shouldUseColors);
      result += '\n' + contextStr;
    }

    // Add error details if present
    if (entry.error) {
      const errorStr = this.formatError(entry.error, shouldUseColors);
      result += '\n' + errorStr;
    }

    return result;
  }

  /**
   * Format timestamp for display
   */
  private formatTimestamp(timestamp: string): string {
    try {
      const date = new Date(timestamp);
      return date.toISOString().slice(11, 23); // HH:mm:ss.sss format
    } catch {
      return timestamp;
    }
  }

  /**
   * Format context object for display
   */
  private formatContext(context: Record<string, unknown>, useColors: boolean): string {
    try {
      const contextJson = JSON.stringify(context, null, 2);
      const indented = contextJson.split('\n').map(line => '  ' + line).join('\n');

      if (useColors) {
        return `${COLORS.dim}Context:${COLORS.reset}\n${COLORS.cyan}${indented}${COLORS.reset}`;
      } else {
        return `Context:\n${indented}`;
      }
    } catch {
      return `Context: [Unable to serialize]`;
    }
  }

  /**
   * Format error information for display
   */
  private formatError(error: NonNullable<LogEntry['error']>, useColors: boolean): string {
    const parts: string[] = [];

    // Error name and message
    const errorHeader = `${error.name}: ${error.message}`;
    if (useColors) {
      parts.push(`${COLORS.brightRed}${errorHeader}${COLORS.reset}`);
    } else {
      parts.push(errorHeader);
    }

    // Stack trace (if configured and available)
    if (this.config.includeStackTrace && error.stack) {
      const stackLines = error.stack.split('\n').slice(1); // Skip the first line (already shown)
      const indentedStack = stackLines.map(line => '  ' + line.trim()).join('\n');

      if (useColors) {
        parts.push(`${COLORS.dim}Stack Trace:${COLORS.reset}\n${COLORS.dim}${indentedStack}${COLORS.reset}`);
      } else {
        parts.push(`Stack Trace:\n${indentedStack}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Detect if the current environment supports colors
   */
  private detectColorSupport(): boolean {
    // Disable colors in CI environments by default
    if (process.env.CI === 'true' || process.env.NO_COLOR === '1') {
      return false;
    }

    // Check for explicit color environment variables
    if (process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true') {
      return true;
    }

    // Check if stderr/stdout support colors
    const { stderr, stdout } = process;

    return (
      stderr.isTTY &&
      stdout.isTTY &&
      (process.platform !== 'win32' || !!process.env.WT_SESSION)
    );
  }

  /**
   * Create a simple console logger for immediate use
   */
  public static createSimple(colorize: boolean = true): ConsoleLogProvider {
    return new ConsoleLogProvider({
      enabled: true,
      colorize,
      includeStackTrace: false,
    });
  }

  /**
   * Create a verbose console logger with stack traces
   */
  public static createVerbose(colorize: boolean = true): ConsoleLogProvider {
    return new ConsoleLogProvider({
      enabled: true,
      colorize,
      includeStackTrace: true,
    });
  }

  /**
   * Create a plain console logger (no colors, no stack traces)
   */
  public static createPlain(): ConsoleLogProvider {
    return new ConsoleLogProvider({
      enabled: true,
      colorize: false,
      includeStackTrace: false,
    });
  }
}

/**
 * Convenience function to create a console provider
 */
export function createConsoleProvider(config?: Partial<ConsoleProviderConfig>): ConsoleLogProvider {
  return new ConsoleLogProvider(config);
}
