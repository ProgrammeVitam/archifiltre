/**
 * Sentry Log Provider
 *
 * Sends error logs and events to Sentry for error tracking and monitoring.
 * Only operates when user has explicitly consented to external telemetry.
 *
 * Requires @sentry/node dependency (optional peer dependency).
 */

import type { LogEntry } from '@api/dto.js';
import type { LogProvider, SentryProviderConfig } from '../types.js';
import { sanitizeForExternal } from '../sanitizer.js';

/**
 * Sentry SDK interface (to avoid hard dependency)
 */
interface SentrySDK {
  init(options: unknown): void;
  captureException(exception: Error, context?: unknown): string;
  captureMessage(message: string, level?: string, context?: unknown): string;
  addBreadcrumb(breadcrumb: unknown): void;
  setContext(key: string, context: unknown): void;
  setTag(key: string, value: string): void;
  setUser(user: unknown): void;
  close(timeout?: number): Promise<boolean>;
  getCurrentScope(): unknown;
}

/**
 * Default Sentry provider configuration
 */
const DEFAULT_CONFIG: Required<Omit<SentryProviderConfig, 'dsn' | 'beforeSend'>> & {
  dsn?: string;
  beforeSend?: (event: unknown) => unknown | null;
} = {
  enabled: false, // Disabled by default for privacy
  dsn: process.env.SENTRY_DSN || undefined,
  environment: process.env.SENTRY_ENVIRONMENT || 'production',
  sampleRate: parseFloat(process.env.SENTRY_SAMPLE_RATE || '1.0'),
  beforeSend: undefined,
} as const;

/**
 * Log level mapping to Sentry severity levels
 */
const SENTRY_LEVEL_MAP = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
} as const;

/**
 * Sentry Log Provider Implementation
 */
export class SentryLogProvider implements LogProvider {
  public readonly name = 'sentry';
  private readonly config: Required<Omit<SentryProviderConfig, 'dsn' | 'beforeSend'>> & {
    dsn?: string;
    beforeSend?: (event: unknown) => unknown | null;
  };
  private sentry: SentrySDK | null = null;
  private isInitialized = false;
  private initializationError: Error | null = null;

  constructor(config: Partial<SentryProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if provider is enabled and properly configured
   */
  public get isEnabled(): boolean {
    return this.config.enabled && !!this.config.dsn;
  }

  /**
   * Initialize Sentry SDK
   */
  private async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Dynamically import Sentry to avoid hard dependency
      this.sentry = await this.loadSentrySDK();

      if (!this.sentry) {
        throw new Error('Sentry SDK not available');
      }

      // Initialize Sentry with privacy-respecting configuration
      this.sentry.init({
        dsn: this.config.dsn,
        environment: this.config.environment,
        sampleRate: this.config.sampleRate,
        beforeSend: this.createBeforeSendHook(),

        // Privacy settings
        sendDefaultPii: false, // Don't send personally identifiable info
        attachStacktrace: true,
        maxValueLength: 2048, // Limit value lengths
        normalizeDepth: 3, // Limit object depth

        // Performance monitoring disabled by default for privacy
        tracesSampleRate: 0,

        // Integration settings
        integrations: [
          // Only include safe integrations
        ],

        // Error filtering
        ignoreErrors: [
          // Common browser errors we don't care about
          'Non-Error promise rejection captured',
          'Non-Error exception captured',
        ],

        // Release information (if available)
        release: process.env.npm_package_version || 'unknown',
      });

      this.isInitialized = true;
      this.initializationError = null;
    } catch (error) {
      this.initializationError = error instanceof Error ? error : new Error(String(error));
      this.isInitialized = false;

      // Don't throw - just log the error and continue without Sentry
      console.warn('[Sentry Provider] Failed to initialize:', this.initializationError.message);
    }
  }

  /**
   * Dynamically load Sentry SDK
   */
  private async loadSentrySDK(): Promise<SentrySDK | null> {
    try {
      const sentry = await import('@sentry/node');
      return sentry as unknown as SentrySDK;
    } catch {
      console.warn(
        '[Sentry Provider] @sentry/node not found. Install it to enable Sentry logging.'
      );
      return null;
    }
  }

  /**
   * Create beforeSend hook for additional privacy protection
   */
  private createBeforeSendHook() {
    return (event: unknown, _hint: unknown) => {
      // Apply configured beforeSend hook if provided
      if (this.config.beforeSend) {
        event = this.config.beforeSend(event);
        if (!event) {
          return null; // User hook filtered out the event
        }
      }

      // Additional sanitization for external transmission
      return sanitizeForExternal(event);
    };
  }

  /**
   * Process a log entry and send to Sentry
   */
  public async log(entry: LogEntry): Promise<void> {
    // Skip if not enabled or not an error/warning
    if (!this.isEnabled) {
      return;
    }

    // Only send warnings and errors to Sentry to reduce noise
    if (entry.level !== 'warn' && entry.level !== 'error') {
      return;
    }

    try {
      // Initialize on first use
      if (!this.isInitialized) {
        await this.initialize();
      }

      if (!this.sentry || this.initializationError) {
        return; // Skip if initialization failed
      }

      // Add context information
      if (entry.context) {
        const sanitizedContext = sanitizeForExternal(entry.context);
        this.sentry.setContext('logContext', sanitizedContext);
      }

      // Set timestamp as tag
      if (entry.timestamp) {
        this.sentry.setTag('logTimestamp', entry.timestamp);
      }

      // Handle error entries
      if (entry.error) {
        const error = this.reconstructError(entry.error);
        const _eventId = this.sentry.captureException(error, {
          level: SENTRY_LEVEL_MAP[entry.level],
          extra: {
            originalMessage: entry.message,
            logLevel: entry.level,
          },
        });

        // Add breadcrumb for the log entry
        this.sentry.addBreadcrumb({
          message: entry.message,
          level: SENTRY_LEVEL_MAP[entry.level],
          timestamp: entry.timestamp,
          data: entry.context,
        });

        return;
      }

      // Handle message-only entries
      this.sentry.captureMessage(entry.message, SENTRY_LEVEL_MAP[entry.level], {
        extra: entry.context,
      });
    } catch (error) {
      // Don't let Sentry errors break the application
      console.warn('[Sentry Provider] Failed to send log entry:', error);
    }
  }

  /**
   * Reconstruct Error object from log entry error data
   */
  private reconstructError(errorData: NonNullable<LogEntry['error']>): Error {
    const error = new Error(errorData.message);
    error.name = errorData.name;

    if (errorData.stack) {
      error.stack = errorData.stack;
    }

    return error;
  }

  /**
   * Health check - verify Sentry is initialized and reachable
   */
  public async healthCheck(): Promise<boolean> {
    if (!this.isEnabled) {
      return false;
    }

    if (this.initializationError) {
      return false;
    }

    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      return this.isInitialized && !!this.sentry;
    } catch {
      return false;
    }
  }

  /**
   * Gracefully close Sentry connection
   */
  public async close(): Promise<void> {
    if (this.sentry && this.isInitialized) {
      try {
        await this.sentry.close(2000); // 2 second timeout
      } catch (error) {
        console.warn('[Sentry Provider] Error during close:', error);
      }
    }

    this.isInitialized = false;
    this.sentry = null;
  }

  /**
   * Set user information for Sentry context (respects privacy settings)
   */
  public setUser(user: { id?: string; email?: string; username?: string }): void {
    if (!this.isEnabled || !this.sentry) {
      return;
    }

    // Only set user info if we have explicit consent
    const sanitizedUser = sanitizeForExternal(user);
    this.sentry.setUser(sanitizedUser);
  }

  /**
   * Add custom tag to Sentry context
   */
  public setTag(key: string, value: string): void {
    if (!this.isEnabled || !this.sentry) {
      return;
    }

    this.sentry.setTag(key, value);
  }

  /**
   * Add custom context to Sentry
   */
  public setContext(key: string, context: Record<string, unknown>): void {
    if (!this.isEnabled || !this.sentry) {
      return;
    }

    const sanitizedContext = sanitizeForExternal(context);
    this.sentry.setContext(key, sanitizedContext);
  }

  /**
   * Create a Sentry provider with development settings
   */
  public static createDevelopment(dsn: string): SentryLogProvider {
    return new SentryLogProvider({
      enabled: true,
      dsn,
      environment: 'development',
      sampleRate: 1.0, // Capture all events in development
    });
  }

  /**
   * Create a Sentry provider with production settings
   */
  public static createProduction(dsn: string): SentryLogProvider {
    return new SentryLogProvider({
      enabled: true,
      dsn,
      environment: 'production',
      sampleRate: 0.1, // Sample 10% of events in production
    });
  }

  /**
   * Create a disabled Sentry provider (for privacy-first mode)
   */
  public static createDisabled(): SentryLogProvider {
    return new SentryLogProvider({
      enabled: false,
    });
  }
}

/**
 * Convenience function to create a Sentry provider
 */
export function createSentryProvider(config?: Partial<SentryProviderConfig>): SentryLogProvider {
  return new SentryLogProvider(config);
}

/**
 * Check if Sentry SDK is available
 */
export async function isSentryAvailable(): Promise<boolean> {
  try {
    const sentry = await import('@sentry/node');
    return typeof sentry.init === 'function';
  } catch {
    return false;
  }
}
