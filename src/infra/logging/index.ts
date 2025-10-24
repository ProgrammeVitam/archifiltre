/**
 * Archifiltre Logging Infrastructure
 *
 * Privacy-respecting, provider-based logging system with support for
 * multiple output destinations while maintaining user control over data sharing.
 *
 * @example Basic usage:
 * ```typescript
 * import { logger, createLogger } from '@infra/logging';
 *
 * // Use default logger
 * logger.info('Application started');
 *
 * // Create custom logger
 * const customLogger = createLogger({
 *   level: 'debug',
 *   privacy: { enableTelemetry: true }
 * });
 * ```
 */

import type { LogEntry } from '@api/dto.js';

// === Core Types and Interfaces ===
export type {
  ILogger,
  LogProvider,
  LogLevel,
  LogFormat,
  LogContext,
  LoggableError,
  LoggingConfig,
  PrivacyConfig,
  ConsoleProviderConfig,
  SentryProviderConfig,
} from './types.js';

export {
  LOG_LEVELS,
  DEFAULT_LOGGING_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
  isLoggableError,
  isValidLogLevel,
  isLogLevelEnabled,
} from './types.js';

// === Core Logger Implementation ===
export {
  Logger,
  createLogger,
  createPrivacyFirstLogger,
  createDevelopmentLogger,
} from './logger.js';

// === Providers ===
export { ConsoleLogProvider, createConsoleProvider } from './providers/console-provider.js';

export {
  SentryLogProvider,
  createSentryProvider,
  isSentryAvailable,
} from './providers/sentry-provider.js';

// === Sanitization Utilities ===
// TODO: Re-enable once import issues are resolved
// export {
//   sanitizeData,
//   createSanitizer,
//   sanitizeForCLI,
//   sanitizeForExternal,
//   sanitizeMinimal,
//   containsSensitiveData,
//   getSanitizationSummary,
// } from './sanitizer.js';

// === Internal imports for singleton implementation ===
import { Logger, createPrivacyFirstLogger } from './logger.js';
import { ConsoleLogProvider } from './providers/console-provider.js';
import { DEFAULT_PRIVACY_CONFIG } from './types.js';
import type { LogLevel, LogFormat, LoggingConfig } from './types.js';

// === Singleton Logger Instance ===
let globalLogger: Logger | null = null;

/**
 * Get the global logger instance
 * Creates a privacy-first logger on first access
 */
export function getGlobalLogger(): Logger {
  if (!globalLogger) {
    globalLogger = createPrivacyFirstLogger();

    // Add console provider by default
    const consoleProvider = new ConsoleLogProvider({
      enabled: true,
      colorize: true,
      includeStackTrace: false,
    });
    globalLogger.addProvider(consoleProvider);
  }

  return globalLogger;
}

/**
 * Set the global logger instance
 * Useful for dependency injection or testing
 */
export function setGlobalLogger(logger: Logger): void {
  // Close existing logger if present
  if (globalLogger) {
    globalLogger.close().catch((error: unknown) => {
      console.error('[Logging] Failed to close previous global logger:', error);
    });
  }

  globalLogger = logger;
}

/**
 * Reset the global logger to default state
 */
export function resetGlobalLogger(): void {
  if (globalLogger) {
    globalLogger.close().catch((error: unknown) => {
      console.error('[Logging] Failed to close global logger during reset:', error);
    });
  }

  globalLogger = null;
}

/**
 * Convenience logger instance for immediate use
 * This is a privacy-first logger that only logs to console
 */
export const logger = new Proxy({} as Logger, {
  get(target, prop, receiver) {
    const globalLoggerInstance = getGlobalLogger();
    const value = Reflect.get(globalLoggerInstance, prop, receiver);

    // Bind methods to the logger instance
    if (typeof value === 'function') {
      return value.bind(globalLoggerInstance);
    }

    return value;
  },
});

/**
 * Create a logger configured for CLI applications
 */
export function createCLILogger(
  options: {
    verbose?: boolean;
    colorize?: boolean;
    format?: LogFormat;
  } = {}
): Logger {
  const { verbose = false, colorize = true, format = 'text' } = options;

  // Import createLogger here to avoid circular dependency
  const { createLogger } = require('./logger.js');

  const config: Partial<LoggingConfig> = {
    level: verbose ? 'debug' : 'info',
    format,
    enableColors: colorize,
    includeTimestamps: false, // CLI usually doesn't need timestamps
    includeContext: verbose,
    privacy: DEFAULT_PRIVACY_CONFIG, // CLI is privacy-first
  };

  const cliLogger = createLogger(config);

  // Add console provider
  const consoleProvider = new ConsoleLogProvider({
    enabled: true,
    colorize,
    includeStackTrace: verbose,
  });
  cliLogger.addProvider(consoleProvider);

  return cliLogger;
}

/**
 * Create a logger with external providers enabled (requires user consent)
 */
export function createTelemetryLogger(
  options: {
    level?: LogLevel;
    sentryDsn?: string;
    environment?: string;
  } = {}
): Logger {
  const { level = 'info', sentryDsn, environment = 'production' } = options;

  // Import components to avoid circular dependency
  const { createLogger } = require('./logger.js');
  const { SentryLogProvider } = require('./providers/sentry-provider.js');

  const config: Partial<LoggingConfig> = {
    level,
    format: 'text',
    enableColors: true,
    includeTimestamps: true,
    includeContext: true,
    privacy: {
      enableTelemetry: true, // User has consented
      consent: {
        sentry: !!sentryDsn,
        analytics: false, // Analytics handled separately
      },
      sanitization: {
        sanitizeFilePaths: true,
        sanitizeUserData: true,
        sanitizeSystemInfo: true,
      },
    },
  };

  const telemetryLogger = createLogger(config);

  // Add console provider
  const consoleProvider = new ConsoleLogProvider({
    enabled: true,
    colorize: true,
    includeStackTrace: level === 'debug',
  });
  telemetryLogger.addProvider(consoleProvider);

  // Add Sentry provider if configured
  if (sentryDsn) {
    const sentryProvider = new SentryLogProvider({
      enabled: true,
      dsn: sentryDsn,
      environment,
    });
    telemetryLogger.addProvider(sentryProvider);
  }

  // Note: PostHog analytics are handled by separate analytics system

  return telemetryLogger;
}

/**
 * Create a test logger that captures logs without external side effects
 */
export function createTestLogger(): Logger & { getLogs(): LogEntry[] } {
  const logs: LogEntry[] = [];

  const testProvider = {
    name: 'test',
    isEnabled: true,
    async log(entry: LogEntry): Promise<void> {
      logs.push({ ...entry }); // Store copy of log entry
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };

  // Import createLogger to avoid circular dependency
  const { createLogger } = require('./logger.js');

  const testLogger = createLogger({
    level: 'debug',
    format: 'json',
    privacy: DEFAULT_PRIVACY_CONFIG,
  }) as Logger & { getLogs(): LogEntry[] };

  testLogger.addProvider(testProvider);

  // Add method to retrieve captured logs
  (testLogger as Logger & { getLogs(): LogEntry[] }).getLogs = () => [...logs];

  return testLogger;
}

/**
 * Initialize logging for the application
 * This should be called once during application startup
 */
export async function initializeLogging(
  config: {
    level?: LogLevel;
    enableTelemetry?: boolean;
    sentryDsn?: string;
    environment?: string;
  } = {}
): Promise<void> {
  const { level = 'info', enableTelemetry = false, sentryDsn, environment = 'production' } = config;

  // Create appropriate logger based on telemetry settings
  const appLogger = enableTelemetry
    ? createTelemetryLogger({ level, sentryDsn, environment })
    : createCLILogger({ verbose: level === 'debug' });

  // Set as global logger
  setGlobalLogger(appLogger);

  // Log initialization
  logger.info('Logging system initialized', {
    level,
    enableTelemetry,
    hasSentry: !!sentryDsn,
    environment,
  });

  // Perform health check
  const healthResults = await appLogger.healthCheck();
  const healthyProviders = Object.entries(healthResults)
    .filter(([_, healthy]) => healthy)
    .map(([name]) => name);

  if (healthyProviders.length > 0) {
    logger.debug('Logging providers health check', {
      healthy: healthyProviders,
      total: Object.keys(healthResults).length,
    });
  }
}

/**
 * Gracefully shutdown logging system
 * Should be called during application shutdown
 */
export async function shutdownLogging(): Promise<void> {
  if (globalLogger) {
    logger.info('Shutting down logging system');

    try {
      await globalLogger.close();
    } catch (error) {
      console.error('[Logging] Error during shutdown:', error);
    }

    globalLogger = null;
  }
}

// === Re-export LogEntry for convenience ===
export type { LogEntry };
