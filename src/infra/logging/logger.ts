/**
 * Main Logger Implementation
 *
 * Privacy-respecting logger that coordinates multiple providers while
 * ensuring user control over data sharing and external service usage.
 */

import type { LogEntry } from '@api/dto.js';
import type { ILogger, LogProvider, LoggingConfig, LogLevel, LogContext } from './types.js';
import { DEFAULT_LOGGING_CONFIG, isLogLevelEnabled } from './types.js';
// import { sanitizeData } from './sanitizer.js';

/**
 * Main Logger class that implements the ILogger interface
 */
export class Logger implements ILogger {
  private readonly providers: Map<string, LogProvider> = new Map();
  private readonly baseContext: LogContext;
  private readonly config: LoggingConfig;

  constructor(config: Partial<LoggingConfig> = {}, baseContext: LogContext = {}) {
    this.config = { ...DEFAULT_LOGGING_CONFIG, ...config };
    this.baseContext = baseContext;
  }

  /**
   * Add a provider to the logger
   */
  public addProvider(provider: LogProvider): void {
    if (provider.isEnabled) {
      this.providers.set(provider.name, provider);
    }
  }

  /**
   * Remove a provider from the logger
   */
  public removeProvider(providerName: string): void {
    this.providers.delete(providerName);
  }

  /**
   * Get all active providers
   */
  public getProviders(): LogProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Debug level logging
   */
  public debug(message: string, context: Record<string, unknown> = {}): void {
    this.log('debug', message, context);
  }

  /**
   * Info level logging
   */
  public info(message: string, context: Record<string, unknown> = {}): void {
    this.log('info', message, context);
  }

  /**
   * Warning level logging
   */
  public warn(message: string, context: Record<string, unknown> = {}): void {
    this.log('warn', message, context);
  }

  /**
   * Error level logging
   */
  public error(message: string, error?: Error, context: Record<string, unknown> = {}): void {
    this.log('error', message, context, error);
  }

  /**
   * Log with explicit level control
   */
  public log(
    level: LogLevel,
    message: string,
    context: Record<string, unknown> = {},
    error?: Error
  ): void {
    // Check if this log level should be processed
    if (!this.isLevelEnabled(level)) {
      return;
    }

    try {
      // Create the log entry
      const logEntry = this.createLogEntry(level, message, context, error);

      // Send to all providers asynchronously
      this.sendToProviders(logEntry).catch(providerError => {
        // Log provider errors to console as fallback, but don't let them crash the app
        console.error('[Logger] Provider error:', providerError);
      });
    } catch (createError) {
      // Even log entry creation shouldn't crash the app
      console.error('[Logger] Failed to create log entry:', createError);
    }
  }

  /**
   * Check if a log level is enabled
   */
  public isLevelEnabled(level: LogLevel): boolean {
    return isLogLevelEnabled(this.config.level, level);
  }

  /**
   * Create a child logger with additional context
   */
  public child(context: Record<string, unknown>): ILogger {
    const mergedContext = { ...this.baseContext, ...context };
    return new Logger(this.config, mergedContext);
  }

  /**
   * Gracefully close all providers
   */
  public async close(): Promise<void> {
    const closePromises = Array.from(this.providers.values())
      .filter(provider => provider.close)
      .map(provider =>
        provider.close!().catch(error => {
          console.error(`[Logger] Error closing provider ${provider.name}:`, error);
        })
      );

    await Promise.all(closePromises);
    this.providers.clear();
  }

  /**
   * Health check for all providers
   */
  public async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [name, provider] of this.providers) {
      try {
        if (provider.healthCheck) {
          results[name] = await provider.healthCheck();
        } else {
          results[name] = provider.isEnabled;
        }
      } catch (error) {
        console.error(`[Logger] Health check failed for provider ${name}:`, error);
        results[name] = false;
      }
    }

    return results;
  }

  /**
   * Create a structured log entry
   */
  private createLogEntry(
    level: LogLevel,
    message: string,
    context: Record<string, unknown>,
    error?: Error
  ): LogEntry {
    const mergedContext = { ...this.baseContext, ...context };

    // Sanitize data according to privacy settings
    // TODO: Implement sanitization once sanitizer is fixed
    const sanitizedContext = mergedContext;

    const logEntry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: Object.keys(sanitizedContext).length > 0 ? sanitizedContext : undefined,
    };

    // Add error information if provided
    if (error) {
      const sanitizedError = this.sanitizeError(error);
      logEntry.error = {
        name: sanitizedError.name,
        message: sanitizedError.message,
        stack: sanitizedError.stack,
      };
    }

    return logEntry;
  }

  /**
   * Send log entry to all active providers
   */
  private async sendToProviders(logEntry: LogEntry): Promise<void> {
    if (this.providers.size === 0) {
      // Fallback to console if no providers are configured
      console.log(`[${logEntry.level.toUpperCase()}] ${logEntry.message}`);
      return;
    }

    // Send to all providers in parallel
    const providerPromises = Array.from(this.providers.values()).map(async provider => {
      try {
        // Check privacy settings for external providers
        if (this.isExternalProvider(provider) && !this.config.privacy.enableTelemetry) {
          return; // Skip external providers if telemetry is disabled
        }

        await provider.log(logEntry);
      } catch (error) {
        // Individual provider errors shouldn't stop other providers
        console.error(`[Logger] Provider ${provider.name} failed:`, error);
      }
    });

    await Promise.all(providerPromises);
  }

  /**
   * Check if a provider sends data externally
   */
  private isExternalProvider(provider: LogProvider): boolean {
    // External providers are those that send data outside the local machine
    const externalProviderNames = ['sentry', 'posthog', 'analytics'];
    return externalProviderNames.includes(provider.name.toLowerCase());
  }

  /**
   * Sanitize error objects for privacy
   */
  private sanitizeError(error: Error): Error {
    if (!this.config.privacy.sanitization.sanitizeFilePaths) {
      return error;
    }

    // Create a copy to avoid mutating the original error
    const sanitizedError = new Error(error.message);
    sanitizedError.name = error.name;

    if (error.stack) {
      // Basic path sanitization - replace file paths with relative paths
      sanitizedError.stack = error.stack
        .replace(/\/[^:\s]+\//g, '.../') // Replace absolute paths
        .replace(/C:\\[^:\s]+\\/g, '...\\'); // Replace Windows paths
    }

    return sanitizedError;
  }

  /**
   * Update configuration at runtime
   */
  public updateConfig(newConfig: Partial<LoggingConfig>): void {
    Object.assign(this.config, newConfig);

    // Re-evaluate provider states based on new config
    for (const [name, provider] of this.providers) {
      if (!provider.isEnabled) {
        this.providers.delete(name);
      }
    }
  }

  /**
   * Get current configuration (read-only)
   */
  public getConfig(): Readonly<LoggingConfig> {
    return { ...this.config };
  }
}

/**
 * Convenience function to create a logger with common defaults
 */
export function createLogger(config: Partial<LoggingConfig> = {}): Logger {
  return new Logger(config);
}

/**
 * Convenience function to create a logger with privacy-first defaults
 */
export function createPrivacyFirstLogger(): Logger {
  return new Logger({
    privacy: {
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
    },
  });
}

/**
 * Convenience function to create a development logger with all features enabled
 */
export function createDevelopmentLogger(): Logger {
  return new Logger({
    level: 'debug',
    format: 'text',
    enableColors: true,
    includeTimestamps: true,
    includeContext: true,
    privacy: {
      enableTelemetry: true, // Dev mode allows telemetry
      consent: {
        sentry: true,
        analytics: true,
      },
      sanitization: {
        sanitizeFilePaths: false,
        sanitizeUserData: false,
        sanitizeSystemInfo: false,
      },
    },
  });
}
