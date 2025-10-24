/**
 * Analytics Infrastructure Types and Interfaces
 *
 * Core types for privacy-respecting analytics system focused on product insights,
 * user behavior tracking, and feature usage analytics. Completely separate from
 * logging infrastructure.
 */

/**
 * Analytics event tracking interface
 */
export interface IAnalytics {
  /**
   * Track a user action or behavior event
   */
  track(event: string, properties?: Record<string, unknown>): void;

  /**
   * Identify a user with properties (respects privacy settings)
   */
  identify(userId?: string, properties?: Record<string, unknown>): void;

  /**
   * Set user properties that persist across events
   */
  setUserProperties(properties: Record<string, unknown>): void;

  /**
   * Track a page/screen view
   */
  page(name: string, properties?: Record<string, unknown>): void;

  /**
   * Check if a feature flag is enabled
   */
  isFeatureEnabled(flagName: string): boolean;

  /**
   * Get feature flag value
   */
  getFeatureFlag(flagName: string): string | boolean | null;

  /**
   * Flush pending events immediately
   */
  flush(): Promise<void>;

  /**
   * Check if analytics is enabled and healthy
   */
  isEnabled(): boolean;
}

/**
 * Analytics provider interface
 * Each provider handles sending events to a specific analytics service
 */
export interface AnalyticsProvider {
  /**
   * Provider name for identification
   */
  readonly name: string;

  /**
   * Check if this provider is enabled and ready
   */
  readonly isEnabled: boolean;

  /**
   * Track an analytics event
   */
  track(event: AnalyticsEvent): Promise<void>;

  /**
   * Identify a user
   */
  identify(userId: string, properties?: Record<string, unknown>): Promise<void>;

  /**
   * Set user properties
   */
  setUserProperties(properties: Record<string, unknown>): Promise<void>;

  /**
   * Track page/screen view
   */
  page(name: string, properties?: Record<string, unknown>): Promise<void>;

  /**
   * Check feature flag status
   */
  isFeatureEnabled?(flagName: string): boolean;

  /**
   * Get feature flag value
   */
  getFeatureFlag?(flagName: string): string | boolean | null;

  /**
   * Flush pending events
   */
  flush?(): Promise<void>;

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
 * Analytics event structure
 */
export interface AnalyticsEvent {
  /**
   * Event name (e.g., 'scan_started', 'duplicate_found')
   */
  name: string;

  /**
   * Event properties/context
   */
  properties?: Record<string, unknown>;

  /**
   * User ID (if applicable and consented)
   */
  userId?: string;

  /**
   * Anonymous user ID
   */
  anonymousId?: string;

  /**
   * Event timestamp
   */
  timestamp?: string;

  /**
   * Session ID for grouping related events
   */
  sessionId?: string;
}

/**
 * User identification data
 */
export interface AnalyticsUser {
  /**
   * User ID (only if explicitly consented)
   */
  userId?: string;

  /**
   * Anonymous ID for privacy-respecting tracking
   */
  anonymousId: string;

  /**
   * User properties
   */
  properties?: {
    /**
     * Application version user is running
     */
    appVersion?: string;

    /**
     * User's platform (linux, darwin, win32)
     */
    platform?: string;

    /**
     * User's locale/language
     */
    locale?: string;

    /**
     * User consent level
     */
    consentLevel?: 'none' | 'anonymous' | 'identified';

    /**
     * First time user?
     */
    isNewUser?: boolean;

    /**
     * User tier (free, premium, etc.)
     */
    tier?: string;

    /**
     * Custom properties
     */
    [key: string]: unknown;
  };
}

/**
 * Privacy configuration for analytics
 */
export interface AnalyticsPrivacyConfig {
  /**
   * Master switch for analytics tracking
   * When false, no analytics events are sent
   */
  enableAnalytics: boolean;

  /**
   * User consent for analytics tracking
   */
  userConsent: {
    /**
     * Anonymous usage analytics (no personal data)
     */
    anonymous: boolean;

    /**
     * Feature usage tracking
     */
    featureUsage: boolean;

    /**
     * Performance metrics
     */
    performance: boolean;

    /**
     * Error analytics (non-sensitive)
     */
    errors: boolean;
  };

  /**
   * Data collection settings
   */
  dataCollection: {
    /**
     * Collect system information (OS, version, etc.)
     */
    systemInfo: boolean;

    /**
     * Collect file processing metrics (counts, sizes, etc.)
     */
    processingMetrics: boolean;

    /**
     * Collect feature flag evaluations
     */
    featureFlags: boolean;

    /**
     * Collect session duration and usage patterns
     */
    sessionData: boolean;
  };

  /**
   * Data retention preferences
   */
  retention: {
    /**
     * How long to keep user data (in days)
     */
    userDataDays: number;

    /**
     * How long to keep anonymous data (in days)
     */
    anonymousDataDays: number;
  };
}

/**
 * PostHog provider configuration
 */
export interface PostHogProviderConfig {
  enabled: boolean;
  apiKey?: string;
  host?: string;
  enableSessionRecording: boolean;
  enableFeatureFlags: boolean;
  enableAutocapture: boolean;
  respectDoNotTrack: boolean;
  sessionReplayConfig?: {
    recordHeaders: boolean;
    recordBody: boolean;
    recordPerformance: boolean;
  };
}

/**
 * Analytics configuration
 */
export interface AnalyticsConfig {
  /**
   * Privacy and consent configuration
   */
  privacy: AnalyticsPrivacyConfig;

  /**
   * Provider configurations
   */
  providers: {
    posthog?: PostHogProviderConfig;
    // Future: Google Analytics, Mixpanel, etc.
  };

  /**
   * Session configuration
   */
  session: {
    /**
     * Session timeout in milliseconds
     */
    timeoutMs: number;

    /**
     * Track session duration
     */
    trackDuration: boolean;
  };

  /**
   * Event batching configuration
   */
  batching: {
    /**
     * Maximum events per batch
     */
    maxBatchSize: number;

    /**
     * Maximum time to wait before sending batch (ms)
     */
    flushIntervalMs: number;
  };
}

/**
 * Pre-defined event names for consistency
 */
export const ANALYTICS_EVENTS = {
  // Application lifecycle
  APP_STARTED: 'app_started',
  APP_CLOSED: 'app_closed',
  APP_CRASHED: 'app_crashed',

  // File scanning
  SCAN_STARTED: 'scan_started',
  SCAN_COMPLETED: 'scan_completed',
  SCAN_CANCELLED: 'scan_cancelled',
  SCAN_PAUSED: 'scan_paused',
  SCAN_RESUMED: 'scan_resumed',

  // File processing
  FILES_ANALYZED: 'files_analyzed',
  DUPLICATES_FOUND: 'duplicates_found',
  HASHES_CALCULATED: 'hashes_calculated',

  // Export/Output
  EXPORT_STARTED: 'export_started',
  EXPORT_COMPLETED: 'export_completed',
  EXPORT_FAILED: 'export_failed',

  // User actions
  SETTINGS_CHANGED: 'settings_changed',
  FEATURE_USED: 'feature_used',
  HELP_VIEWED: 'help_viewed',

  // Performance
  PERFORMANCE_MEASURED: 'performance_measured',
  MEMORY_WARNING: 'memory_warning',

  // Errors (non-sensitive)
  USER_ERROR: 'user_error',
  FEATURE_ERROR: 'feature_error',
} as const;

/**
 * Event property types for common events
 */
export interface ScanStartedProperties {
  scanPath: string; // Sanitized path
  estimatedFileCount?: number;
  scanType: 'full' | 'incremental' | 'resume';
  includeHidden: boolean;
}

export interface ScanCompletedProperties {
  duration: number; // milliseconds
  filesScanned: number;
  directoriesScanned: number;
  duplicatesFound: number;
  totalSize: number; // bytes
  errors: number;
}

export interface ExportCompletedProperties {
  format: 'json' | 'csv' | 'xml';
  recordCount: number;
  duration: number;
  fileSize: number;
}

export interface FeatureUsedProperties {
  featureName: string;
  context?: string;
  duration?: number;
  success: boolean;
}

export interface PerformanceProperties {
  operation: string;
  duration: number; // milliseconds
  memoryUsed: number; // bytes
  cpuUsage?: number; // percentage
  filesProcessed?: number;
}

/**
 * Default privacy configuration (most restrictive)
 */
export const DEFAULT_ANALYTICS_PRIVACY_CONFIG: AnalyticsPrivacyConfig = {
  enableAnalytics: false,
  userConsent: {
    anonymous: false,
    featureUsage: false,
    performance: false,
    errors: false,
  },
  dataCollection: {
    systemInfo: false,
    processingMetrics: false,
    featureFlags: false,
    sessionData: false,
  },
  retention: {
    userDataDays: 30,
    anonymousDataDays: 90,
  },
} as const;

/**
 * Default analytics configuration
 */
export const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  privacy: DEFAULT_ANALYTICS_PRIVACY_CONFIG,
  providers: {},
  session: {
    timeoutMs: 30 * 60 * 1000, // 30 minutes
    trackDuration: false,
  },
  batching: {
    maxBatchSize: 50,
    flushIntervalMs: 10000, // 10 seconds
  },
} as const;

/**
 * Type guard to check if a value is a valid analytics event
 */
export function isValidAnalyticsEvent(event: unknown): event is AnalyticsEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'name' in event &&
    typeof (event as AnalyticsEvent).name === 'string' &&
    (event as AnalyticsEvent).name.length > 0
  );
}

/**
 * Helper to sanitize event properties for privacy
 */
export function sanitizeEventProperties(
  properties: Record<string, unknown>,
  _privacyConfig: AnalyticsPrivacyConfig
): Record<string, unknown> {
  // This would be implemented to remove sensitive data based on privacy settings
  // For now, return as-is since sanitization is complex
  return properties;
}
