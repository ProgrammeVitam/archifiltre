/**
 * Winston Logging System
 *
 * Consolidated logging infrastructure using Winston with RFC5424 compliance.
 * Environment-aware directories, Oclif integration, and privacy-first design.
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { getLogsDir } from './platform-paths.ts';

// === Types ===

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogContext {
  [key: string]: string | number | boolean | Date | null | undefined;
}

export interface OclifCommandContext {
  log(message?: string): void;
  warn(input: string | Error): string | Error;
  error(input: string | Error, options?: { exit?: number | false }): never;
  debug?(...args: unknown[]): void;
}

export interface LoggingConfig {
  level: LogLevel;
  enableFileLogging: boolean;
  enableConsoleLogging: boolean;
  logDirectory: string;
  appName: string;
  privacy: {
    enableExternalServices: boolean;
    sanitizeFilePaths: boolean;
  };
}

// === Environment Detection ===

function getEnvironmentLogDirectory(): string {
  return getLogsDir();
}

// === Oclif Integration Registry ===

class OclifCommandRegistry {
  private static currentCommand: OclifCommandContext | null = null;

  static setCommand(command: OclifCommandContext): void {
    this.currentCommand = command;
  }

  static clearCommand(): void {
    this.currentCommand = null;
  }

  static getCommand(): OclifCommandContext | null {
    return this.currentCommand;
  }
}

// === RFC5424 Winston Format ===

function createRFC5424Format(appName: string): winston.Logform.Format {
  return winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(info => {
      // RFC5424 format: <priority>version timestamp hostname app-name procid msgid [structured-data] msg
      const priority = getSyslogPriority(info.level);
      const timestamp = info.timestamp;
      const hostnameVal = hostname();
      const procId = process.pid;
      const msgId = '-';

      // Format structured data from metadata
      let structuredData = '-';
      const metadata = Object.entries(info).filter(
        ([key, value]) =>
          key !== 'level' &&
          key !== 'message' &&
          key !== 'timestamp' &&
          key !== 'service' &&
          value !== undefined
      );

      if (metadata.length > 0) {
        const sdElements = metadata
          .map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`)
          .join(' ');
        structuredData = `[context ${sdElements}]`;
      }

      return `<${priority}>1 ${timestamp} ${hostnameVal} ${appName} ${procId} ${msgId} ${structuredData} ${info.message}`;
    })
  );
}

function getSyslogPriority(level: string): number {
  // RFC5424 priority calculation: facility * 8 + severity
  // Using facility 16 (local0) for application logs
  const facility = 16;
  const severityMap: Record<string, number> = {
    error: 3, // Error conditions
    warn: 4, // Warning conditions
    info: 6, // Informational messages
    debug: 7, // Debug-level messages
  };
  const severity = severityMap[level] || 6;
  return facility * 8 + severity;
}

// === Main Logger Class ===

class ArchifiltrLogger {
  private winston: winston.Logger;
  private config: LoggingConfig;

  constructor(config?: Partial<LoggingConfig>) {
    this.config = {
      level: config?.level || 'info',
      enableFileLogging: config?.enableFileLogging ?? true,
      enableConsoleLogging: config?.enableConsoleLogging ?? true,
      logDirectory: config?.logDirectory || getEnvironmentLogDirectory(),
      appName: config?.appName || 'archifiltre',
      privacy: {
        enableExternalServices: config?.privacy?.enableExternalServices ?? false,
        sanitizeFilePaths: config?.privacy?.sanitizeFilePaths ?? true,
      },
    };

    this.winston = this.createWinstonLogger();
  }

  private createWinstonLogger(): winston.Logger {
    const transports: winston.transport[] = [];

    // Console transport for development
    if (this.config.enableConsoleLogging) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
        })
      );
    }

    // File transport with daily rotation
    if (this.config.enableFileLogging) {
      this.ensureLogDirectory();

      transports.push(
        new DailyRotateFile({
          filename: join(this.config.logDirectory, `${this.config.appName}-%DATE%.log`),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '14d',
          format: createRFC5424Format(this.config.appName),
        })
      );
    }

    return winston.createLogger({
      level: this.config.level,
      transports,
      defaultMeta: { service: this.config.appName },
    });
  }

  private ensureLogDirectory(): void {
    try {
      if (!existsSync(this.config.logDirectory)) {
        mkdirSync(this.config.logDirectory, { recursive: true });
      }
    } catch {
      // If we can't create log directory, disable file logging
      this.config.enableFileLogging = false;
    }
  }

  private sanitizeContext(context?: LogContext): LogContext | undefined {
    if (!context || !this.config.privacy.sanitizeFilePaths) {
      return context;
    }

    const sanitized: LogContext = {};
    const home = homedir();

    for (const [key, value] of Object.entries(context)) {
      if (typeof value === 'string' && key.toLowerCase().includes('path')) {
        sanitized[key] = value.replace(home, '~');
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private logMessage(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    const sanitizedContext = this.sanitizeContext(context);
    const oclifCommand = OclifCommandRegistry.getCommand();

    // Send to Oclif command if available
    if (oclifCommand) {
      const contextStr = sanitizedContext ? ` ${JSON.stringify(sanitizedContext)}` : '';
      const fullMessage = `${message}${contextStr}`;

      switch (level) {
        case 'error':
          oclifCommand.warn(`ERROR: ${fullMessage}`);
          if (error && error.stack) {
            oclifCommand.warn(error.stack);
          }
          break;
        case 'warn':
          oclifCommand.warn(`WARN: ${fullMessage}`);
          break;
        case 'info':
          oclifCommand.log(fullMessage);
          break;
        case 'debug':
          if (oclifCommand.debug) {
            oclifCommand.debug(`DEBUG: ${fullMessage}`);
          }
          break;
      }
    }

    // Always send to Winston for file logging
    const logData = {
      ...sanitizedContext,
      ...(error && {
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
      }),
    };

    this.winston[level](message, logData);
  }

  // === Public API ===

  debug(message: string, context?: LogContext): void {
    this.logMessage('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.logMessage('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.logMessage('warn', message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.logMessage('error', message, context, error);
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    const health: Record<string, boolean> = {};

    // Check console logging
    health.console = this.config.enableConsoleLogging;

    // Check file logging
    health.file = this.config.enableFileLogging && existsSync(this.config.logDirectory);

    // Check oclif integration
    health.oclif = OclifCommandRegistry.getCommand() !== null;

    return health;
  }

  async close(): Promise<void> {
    return new Promise(resolve => {
      this.winston.close();
      resolve();
    });
  }
}

// === Global Logger Management ===

let globalLogger: ArchifiltrLogger | null = null;

export function createLogger(config?: Partial<LoggingConfig>): ArchifiltrLogger {
  return new ArchifiltrLogger(config);
}

export function getGlobalLogger(): ArchifiltrLogger {
  if (!globalLogger) {
    globalLogger = createLogger();
  }
  return globalLogger;
}

export function setGlobalLogger(logger: ArchifiltrLogger): void {
  globalLogger = logger;
}

// === Oclif Integration ===

export function setupOclifContext(command: OclifCommandContext): () => void {
  OclifCommandRegistry.setCommand(command);
  return () => {
    OclifCommandRegistry.clearCommand();
  };
}

// === Initialization Functions ===

export async function initializeLogging(config?: Partial<LoggingConfig>): Promise<void> {
  const logger = createLogger(config);
  setGlobalLogger(logger);

  logger.info('Logging system initialized', {
    logDirectory: logger['config'].logDirectory,
    level: logger['config'].level,
    fileLogging: logger['config'].enableFileLogging,
    consoleLogging: logger['config'].enableConsoleLogging,
  });
}

export async function shutdownLogging(): Promise<void> {
  if (globalLogger) {
    await globalLogger.close();
    globalLogger = null;
  }
  OclifCommandRegistry.clearCommand();
}

// === Default Logger Instance ===

export const logger = {
  debug: (message: string, context?: LogContext) => getGlobalLogger().debug(message, context),
  info: (message: string, context?: LogContext) => getGlobalLogger().info(message, context),
  warn: (message: string, context?: LogContext) => getGlobalLogger().warn(message, context),
  error: (message: string, error?: Error, context?: LogContext) =>
    getGlobalLogger().error(message, error, context),
};

// === Environment Info ===

export function getLoggingEnvironmentInfo() {
  return {
    logDirectory: getEnvironmentLogDirectory(),
    environment: process.env.NODE_ENV || 'development',
    isDevelopment: !process.env.NODE_ENV || process.env.NODE_ENV === 'development',
  };
}
