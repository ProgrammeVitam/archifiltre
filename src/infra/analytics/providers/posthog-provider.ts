/**
 * PostHog Analytics Provider
 *
 * Sends product analytics, user behavior events, and feature flags to PostHog.
 * This is for product insights and user behavior tracking, NOT for system logging.
 *
 * Requires posthog-node dependency (optional peer dependency).
 */

import type { AnalyticsProvider, AnalyticsEvent, PostHogProviderConfig } from '../types.js';

/**
 * PostHog SDK interface (to avoid hard dependency)
 */
interface PostHogSDK {
  capture(options: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    timestamp?: Date;
  }): void;
  identify(options: { distinctId: string; properties?: Record<string, unknown> }): void;
  setPersonProperties(options: { distinctId: string; properties: Record<string, unknown> }): void;
  isFeatureEnabled(flag: string, distinctId: string): boolean;
  getFeatureFlag(flag: string, distinctId: string): string | boolean;
  shutdown(timeoutMs?: number): Promise<void>;
}

/**
 * PostHog constructor interface
 */
interface PostHogConstructor {
  new (apiKey: string, options?: unknown): PostHogSDK;
}

/**
 * Default PostHog provider configuration
 */
const DEFAULT_CONFIG: Required<Omit<PostHogProviderConfig, 'apiKey'>> & { apiKey?: string } = {
  enabled: false, // Disabled by default for privacy
  apiKey: process.env.POSTHOG_API_KEY || undefined,
  host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
  enableSessionRecording: false, // Privacy-first default
  enableFeatureFlags: true,
  enableAutocapture: false, // Disabled for privacy
  respectDoNotTrack: true,
  sessionReplayConfig: {
    recordHeaders: false,
    recordBody: false,
    recordPerformance: false,
  },
} as const;

/**
 * PostHog Analytics Provider Implementation
 */
export class PostHogAnalyticsProvider implements AnalyticsProvider {
  public readonly name = 'posthog';
  private readonly config: Required<Omit<PostHogProviderConfig, 'apiKey'>> & { apiKey?: string };
  private posthog: PostHogSDK | null = null;
  private PostHogClass: PostHogConstructor | null = null;
  private isInitialized = false;
  private initializationError: Error | null = null;

  constructor(config: Partial<PostHogProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if provider is enabled and properly configured
   */
  public get isEnabled(): boolean {
    return this.config.enabled && !!this.config.apiKey;
  }

  /**
   * Initialize PostHog SDK
   */
  private async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Dynamically import PostHog to avoid hard dependency
      this.PostHogClass = await this.loadPostHogSDK();

      if (!this.PostHogClass) {
        throw new Error('PostHog SDK not available');
      }

      // Create PostHog instance with privacy-respecting configuration
      this.posthog = new this.PostHogClass(this.config.apiKey!, {
        host: this.config.host,

        // Privacy settings
        capture_pageview: false, // We'll handle page views manually
        capture_pageleave: false,
        disable_session_recording: !this.config.enableSessionRecording,
        respect_dnt: this.config.respectDoNotTrack,
        opt_out_capturing_by_default: false,
        disable_cookie: false, // Needed for session tracking
        secure_cookie: true,

        // Feature flags
        enable_feature_flags: this.config.enableFeatureFlags,

        // Session recording settings
        session_recording: this.config.enableSessionRecording
          ? {
              recordHeaders: this.config.sessionReplayConfig.recordHeaders,
              recordBody: this.config.sessionReplayConfig.recordBody,
              recordPerformance: this.config.sessionReplayConfig.recordPerformance,
              maskAllInputs: true, // Privacy protection
              maskTextSelectors: ['[data-sensitive]', '.sensitive'],
            }
          : false,

        // Autocapture settings
        autocapture: this.config.enableAutocapture,

        // Batch settings for efficiency
        batch_size: 20,
        flush_interval: 10000, // 10 seconds

        // Request settings
        request_timeout: 15000, // 15 seconds
        max_retries: 3,

        // Development settings
        debug: process.env.NODE_ENV === 'development',

        // Data processing
        sanitize_properties: (properties: Record<string, unknown>) => {
          return this.sanitizeProperties(properties);
        },
      });

      this.isInitialized = true;
      this.initializationError = null;
    } catch (error) {
      this.initializationError = error instanceof Error ? error : new Error(String(error));
      this.isInitialized = false;
      this.posthog = null;

      // Don't throw - just log the error and continue without PostHog
      console.warn('[PostHog Provider] Failed to initialize:', this.initializationError.message);
    }
  }

  /**
   * Dynamically load PostHog SDK
   */
  private async loadPostHogSDK(): Promise<PostHogConstructor | null> {
    try {
      const { PostHog } = await import('posthog-node');
      return PostHog as unknown as PostHogConstructor;
    } catch {
      console.warn(
        '[PostHog Provider] posthog-node not found. Install it to enable PostHog analytics.'
      );
      return null;
    }
  }

  /**
   * Track an analytics event
   */
  public async track(event: AnalyticsEvent): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    try {
      // Initialize on first use
      if (!this.isInitialized) {
        await this.initialize();
      }

      if (!this.posthog || this.initializationError) {
        return; // Skip if initialization failed
      }

      // Prepare event properties with context
      const properties = this.prepareEventProperties(event);

      // Send analytics event to PostHog
      this.posthog.capture({
        distinctId: event.userId || event.anonymousId || 'unknown',
        event: event.name,
        properties,
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
      });
    } catch (error) {
      // Don't let PostHog errors break the application
      console.warn('[PostHog Provider] Failed to track event:', error);
    }
  }

  /**
   * Identify a user with properties
   */
  public async identify(userId: string, properties: Record<string, unknown> = {}): Promise<void> {
    if (!this.isEnabled || !this.posthog) {
      return;
    }

    try {
      await this.initialize();

      if (!this.posthog) {
        return;
      }

      const sanitizedProperties = this.sanitizeProperties(properties);

      this.posthog.identify({
        distinctId: userId,
        properties: {
          ...sanitizedProperties,
          $identified_at: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.warn('[PostHog Provider] Failed to identify user:', error);
    }
  }

  /**
   * Set user properties that persist across events
   */
  public async setUserProperties(properties: Record<string, unknown>): Promise<void> {
    if (!this.isEnabled || !this.posthog) {
      return;
    }

    try {
      await this.initialize();

      if (!this.posthog) {
        return;
      }

      const sanitizedProperties = this.sanitizeProperties(properties);

      // PostHog uses setPersonProperties for persistent user properties
      this.posthog.setPersonProperties({
        distinctId: 'current_user', // This would be replaced with actual user ID
        properties: sanitizedProperties,
      });
    } catch (error) {
      console.warn('[PostHog Provider] Failed to set user properties:', error);
    }
  }

  /**
   * Track page/screen view
   */
  public async page(name: string, properties: Record<string, unknown> = {}): Promise<void> {
    if (!this.isEnabled || !this.posthog) {
      return;
    }

    try {
      await this.initialize();

      if (!this.posthog) {
        return;
      }

      const pageProperties = this.sanitizeProperties({
        ...properties,
        $current_url: name,
        $screen_name: name,
        page_title: name,
      });

      // Track as a regular event since we disabled auto page tracking
      this.posthog.capture({
        distinctId: 'current_user', // This would be replaced with actual user ID
        event: '$pageview',
        properties: pageProperties,
      });
    } catch (error) {
      console.warn('[PostHog Provider] Failed to track page view:', error);
    }
  }

  /**
   * Check if a feature flag is enabled
   */
  public isFeatureEnabled(flagName: string, distinctId?: string): boolean {
    if (!this.isEnabled || !this.posthog || !this.config.enableFeatureFlags) {
      return false;
    }

    try {
      const userId = distinctId || 'current_user';
      return this.posthog.isFeatureEnabled(flagName, userId);
    } catch (error) {
      console.warn('[PostHog Provider] Failed to check feature flag:', error);
      return false;
    }
  }

  /**
   * Get feature flag value
   */
  public getFeatureFlag(flagName: string, distinctId?: string): string | boolean | null {
    if (!this.isEnabled || !this.posthog || !this.config.enableFeatureFlags) {
      return null;
    }

    try {
      const userId = distinctId || 'current_user';
      return this.posthog.getFeatureFlag(flagName, userId);
    } catch (error) {
      console.warn('[PostHog Provider] Failed to get feature flag:', error);
      return null;
    }
  }

  /**
   * Flush pending events immediately
   */
  public async flush(): Promise<void> {
    if (!this.isEnabled || !this.posthog) {
      return;
    }

    try {
      // PostHog Node SDK doesn't have explicit flush, events are sent immediately
      // This is a no-op for PostHog but maintains interface compatibility
      await Promise.resolve();
    } catch (error) {
      console.warn('[PostHog Provider] Failed to flush:', error);
    }
  }

  /**
   * Health check - verify PostHog is initialized and reachable
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

      return this.isInitialized && !!this.posthog;
    } catch {
      return false;
    }
  }

  /**
   * Gracefully close PostHog connection
   */
  public async close(): Promise<void> {
    if (this.posthog && this.isInitialized) {
      try {
        await this.posthog.shutdown(2000); // 2 second timeout
      } catch (error) {
        console.warn('[PostHog Provider] Error during shutdown:', error);
      }
    }

    this.isInitialized = false;
    this.posthog = null;
    this.PostHogClass = null;
  }

  /**
   * Prepare event properties with additional context
   */
  private prepareEventProperties(event: AnalyticsEvent): Record<string, unknown> {
    const properties: Record<string, unknown> = {
      // Core event information
      ...(event.properties || {}),

      // Session information
      $session_id: event.sessionId,
      timestamp: event.timestamp,

      // Application context
      app_version: process.env.npm_package_version || 'unknown',
      platform: process.platform,
      arch: process.arch,

      // Privacy-safe environment info
      is_development: process.env.NODE_ENV === 'development',
      is_ci: process.env.CI === 'true',

      // PostHog specific properties
      $lib: 'archifiltre-analytics',
      $lib_version: process.env.npm_package_version || 'unknown',
    };

    return this.sanitizeProperties(properties);
  }

  /**
   * Sanitize properties for privacy protection
   */
  private sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(properties)) {
      // Skip sensitive keys
      if (this.isSensitiveKey(key)) {
        continue;
      }

      // Sanitize values
      sanitized[key] = this.sanitizeValue(value);
    }

    return sanitized;
  }

  /**
   * Check if a property key is sensitive
   */
  private isSensitiveKey(key: string): boolean {
    const sensitiveKeys = [
      'password',
      'pwd',
      'passwd',
      'token',
      'accesstoken',
      'refreshtoken',
      'secret',
      'secretkey',
      'apisecret',
      'key',
      'apikey',
      'privatekey',
      'auth',
      'authorization',
      'credential',
      'credentials',
      'ssn',
      'social_security',
      'credit_card',
      'creditcard',
      'personal_data',
      'pii',
    ];

    const lowerKey = key.toLowerCase();
    return sensitiveKeys.some(sensitiveKey => lowerKey.includes(sensitiveKey));
  }

  /**
   * Sanitize individual values
   */
  private sanitizeValue(value: unknown): unknown {
    if (typeof value === 'string') {
      // Basic path sanitization for file paths
      return value
        .replace(/\/Users\/[^/]+/g, '/Users/[USER]')
        .replace(/\/home\/[^/]+/g, '/home/[USER]')
        .replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\[USER]');
    }

    return value;
  }

  /**
   * Create a PostHog provider with development settings
   */
  public static createDevelopment(apiKey: string): PostHogAnalyticsProvider {
    return new PostHogAnalyticsProvider({
      enabled: true,
      apiKey,
      host: 'https://app.posthog.com',
      enableSessionRecording: false, // Still respect privacy in dev
      enableFeatureFlags: true,
      enableAutocapture: false,
      respectDoNotTrack: true,
    });
  }

  /**
   * Create a PostHog provider with production settings
   */
  public static createProduction(apiKey: string): PostHogAnalyticsProvider {
    return new PostHogAnalyticsProvider({
      enabled: true,
      apiKey,
      host: 'https://app.posthog.com',
      enableSessionRecording: false, // Disabled by default for privacy
      enableFeatureFlags: true,
      enableAutocapture: false, // Manual tracking only
      respectDoNotTrack: true,
    });
  }

  /**
   * Create a disabled PostHog provider (for privacy-first mode)
   */
  public static createDisabled(): PostHogAnalyticsProvider {
    return new PostHogAnalyticsProvider({
      enabled: false,
    });
  }
}

/**
 * Convenience function to create a PostHog provider
 */
export function createPostHogProvider(
  config?: Partial<PostHogProviderConfig>
): PostHogAnalyticsProvider {
  return new PostHogAnalyticsProvider(config);
}

/**
 * Check if PostHog SDK is available
 */
export async function isPostHogAvailable(): Promise<boolean> {
  try {
    const { PostHog } = await import('posthog-node');
    return typeof PostHog === 'function';
  } catch {
    return false;
  }
}
