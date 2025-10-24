/**
 * Logging Infrastructure Types and Interfaces
 *
 * Core types for the privacy-respecting, provider-based logging system.
 * Supports multiple output formats while maintaining user control over data sharing.
 */

import type { LogEntry } from '@api/dto.js';

/**
 * Available log levels in order of severity
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log output formats
 */
export type LogFormat = 'text' | 'json';

/**
 * Core logger interface
 * All logging should go through this interface for consistency
 */
export interface ILogger {
  /**
   * Log a debug message (lowest severity)
   * Only shown with verbose logging enabled
   */
  debug(message: string, context?: Record<string, unknown>): void;

  /**
   * Log an informational message
   */
  info(message: string, context?: Record<string, unknown>): void;

  /**
   * Log a warning message
   */
  warn(message: string, context?: Record<string, unknown>): void;

  /**
   * Log an error message (highest severity)
   */
  error(message: string, error?: Error, context?: Record<string, unknown>): void;

  /**
   * Log with explicit level control
   */
  log(level: LogLevel, message: string, context?: Record<string, unknown>, error?: Error): void;

  /**
   * Check if a log level is enabled
   */
  isLevelEnabled(level: LogLevel): boolean;

  /**
   * Create a child logger with additional context
   */
  child(context: Record<string, unknown>): ILogger;
}

/**
 * Log provider interface
 * Each provider handles output to a specific destination (console, file, external service)
 */
export interface LogProvider {
  /**
   * Provider name for identification
   */
  readonly name: string;

  /**
   * Check if this provider is enabled and ready
   */
  readonly isEnabled: boolean;

  /**
   * Process a log entry
   * Should handle errors gracefully and not throw
   */
  log(entry: LogEntry): Promise<void>;

  /**
   * Gracefully close/cleanup the provider
   */
  close?(): Promise<void>;

  /**
   * Health check for the provider
   */
  healthCheck?(): Promise<boolean>;
}

/**
 * Privacy configuration for external providers
 * User must explicitly opt-in to any external data sharing
 */
export interface PrivacyConfig {
  /**
   * Master switch for any external telemetry
   * When false, no data leaves the machine
   */
  enableTelemetry: boolean;

  /**
   * User consent for specific external providers
   */
  consent: {
    sentry: boolean;
    analytics: boolean;
  };

  /**
   * Data sanitization settings
   */
  sanitization: {
    /**
     * Remove potentially sensitive file paths from logs
     */
    sanitizeFilePaths: boolean;

    /**
     * Remove user-specific information
     */
    sanitizeUserData: boolean;

    /**
     * Remove system information that could identify the machine
     */
    sanitizeSystemInfo: boolean;
  };
}

/**
 * Core logging configuration
 */
export interface LoggingConfig {
  /**
   * Minimum log level to process
   */
  level: LogLevel;

  /**
   * Output format preference
   */
  format: LogFormat;

  /**
   * Enable colored output (when format is 'text')
   */
  enableColors: boolean;

  /**
   * Include timestamps in log output
   */
  includeTimestamps: boolean;

  /**
   * Include context data in log output
   */
  includeContext: boolean;

  /**
   * Privacy and external service configuration
   */
  privacy: PrivacyConfig;

  /**
   * Provider-specific configurations
   */
  providers: {
    console: ConsoleProviderConfig;
    sentry?: SentryProviderConfig;
  };
}

/**
 * Console provider configuration
 */
export interface ConsoleProviderConfig {
  enabled: boolean;
  colorize: boolean;
  includeStackTrace: boolean;
}

/**
 * Sentry provider configuration
 */
export interface SentryProviderConfig {
  enabled: boolean;
  dsn?: string;
  environment?: string;
  sampleRate?: number;
  beforeSend?: (event: unknown) => unknown | null;
}

/**
 * Log context that gets attached to every log entry
 */
export interface LogContext {
  /**
   * Component or module name
   */
  component?: string;

  /**
   * Operation or command being executed
   */
  operation?: string;

  /**
   * User ID (if applicable and consented)
   */
  userId?: string;

  /**
   * Session ID for tracking related operations
   */
  sessionId?: string;

  /**
   * Request/operation ID for distributed tracing
   */
  requestId?: string;

  /**
   * Any additional context data
   */
  [key: string]: unknown;
}

/**
 * Error with additional context for logging
 */
export interface LoggableError extends Error {
  /**
   * Error code for categorization
   */
  code?: string;

  /**
   * Additional context about the error
   */
  context?: Record<string, unknown>;

  /**
   * Whether this error should be reported to external services
   */
  reportable?: boolean;

  /**
   * Severity level override
   */
  severity?: LogLevel;
}

/**
 * Log level hierarchy for filtering
 */
export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

/**
 * Default privacy configuration (most restrictive)
 */
export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  enableTelemetry: false,
  consent: {
    sentry: false,
    analytics: false,
  },
  sanitization: {
    sanitizeFilePaths: true,
    sanitizeUserData: true,
    sanitizeSystemInfo: true,
  },
} as const;

/**
 * Default logging configuration
 */
export const DEFAULT_LOGGING_CONFIG: LoggingConfig = {
  level: 'info',
  format: 'text',
  enableColors: true,
  includeTimestamps: true,
  includeContext: false,
  privacy: DEFAULT_PRIVACY_CONFIG,
  providers: {
    console: {
      enabled: true,
      colorize: true,
      includeStackTrace: false,
    },
  },
} as const;

/**
 * Type guard to check if an error is loggable
 */
export function isLoggableError(error: unknown): error is LoggableError {
  return error instanceof Error;
}

/**
 * Type guard to check if a log level is valid
 */
export function isValidLogLevel(level: string): level is LogLevel {
  return level in LOG_LEVELS;
}

/**
 * Compare log levels for filtering
 */
export function isLogLevelEnabled(currentLevel: LogLevel, targetLevel: LogLevel): boolean {
  return LOG_LEVELS[targetLevel] >= LOG_LEVELS[currentLevel];
}
