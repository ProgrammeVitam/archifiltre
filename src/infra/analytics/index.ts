/**
 * Archifiltre Analytics Infrastructure
 *
 * Privacy-respecting analytics system for tracking user behavior, feature usage,
 * and product insights. Completely separate from logging infrastructure.
 *
 * @example Basic usage:
 * ```typescript
 * import { analytics, createAnalytics } from '@infra/analytics';
 *
 * // Use default analytics
 * analytics.track('scan_started', { fileCount: 1250 });
 *
 * // Create custom analytics
 * const customAnalytics = createAnalytics({
 *   privacy: { enableAnalytics: true }
 * });
 * ```
 */

import type {
  AnalyticsEvent as AnalyticsEventType,
  AnalyticsUser as AnalyticsUserType,
} from './types.js';

// === Core Types and Interfaces ===
export type {
  IAnalytics,
  AnalyticsProvider,
  AnalyticsConfig,
  AnalyticsPrivacyConfig,
  PostHogProviderConfig,
  ScanStartedProperties,
  ScanCompletedProperties,
  ExportCompletedProperties,
  FeatureUsedProperties,
  PerformanceProperties,
} from './types.js';

export {
  ANALYTICS_EVENTS,
  DEFAULT_ANALYTICS_CONFIG,
  DEFAULT_ANALYTICS_PRIVACY_CONFIG,
  isValidAnalyticsEvent,
  sanitizeEventProperties,
} from './types.js';

// === Core Analytics Implementation ===
export {
  Analytics,
  createAnalytics,
  createPrivacyFirstAnalytics,
  createDevelopmentAnalytics,
} from './analytics.js';

// === Providers ===
export {
  PostHogAnalyticsProvider,
  createPostHogProvider,
  isPostHogAvailable,
} from './providers/posthog-provider.js';

// === Internal imports for singleton implementation ===
import { Analytics, createPrivacyFirstAnalytics } from './analytics.js';
import { PostHogAnalyticsProvider } from './providers/posthog-provider.js';
import { DEFAULT_ANALYTICS_PRIVACY_CONFIG as _DEFAULT_ANALYTICS_PRIVACY_CONFIG } from './types.js';
import type {
  AnalyticsConfig,
  AnalyticsPrivacyConfig as _AnalyticsPrivacyConfig,
} from './types.js';

// === Singleton Analytics Instance ===
let globalAnalytics: Analytics | null = null;

/**
 * Get the global analytics instance
 * Creates a privacy-first analytics instance on first access
 */
export function getGlobalAnalytics(): Analytics {
  if (!globalAnalytics) {
    globalAnalytics = createPrivacyFirstAnalytics();

    // Note: No providers added by default for privacy
    // Providers must be explicitly added after user consent
  }

  return globalAnalytics;
}

/**
 * Set the global analytics instance
 * Useful for dependency injection or testing
 */
export function setGlobalAnalytics(analytics: Analytics): void {
  // Close existing analytics if present
  if (globalAnalytics) {
    globalAnalytics.close().catch((error: unknown) => {
      console.error('[Analytics] Failed to close previous global analytics:', error);
    });
  }

  globalAnalytics = analytics;
}

/**
 * Reset the global analytics to default state
 */
export function resetGlobalAnalytics(): void {
  if (globalAnalytics) {
    globalAnalytics.close().catch((error: unknown) => {
      console.error('[Analytics] Failed to close global analytics during reset:', error);
    });
  }

  globalAnalytics = null;
}

/**
 * Convenience analytics instance for immediate use
 * This is a privacy-first analytics instance with no providers by default
 */
export const analytics = new Proxy({} as Analytics, {
  get(target, prop, receiver) {
    const globalAnalyticsInstance = getGlobalAnalytics();
    const value = Reflect.get(globalAnalyticsInstance, prop, receiver);

    // Bind methods to the analytics instance
    if (typeof value === 'function') {
      return value.bind(globalAnalyticsInstance);
    }

    return value;
  },
});

// === Factory Functions ===

/**
 * Create analytics with user consent for anonymous tracking
 */
export function createAnonymousAnalytics(
  options: {
    postHogApiKey?: string;
    enableFeatureFlags?: boolean;
  } = {}
): Analytics {
  const { postHogApiKey, enableFeatureFlags = true } = options;

  // Import createAnalytics to avoid circular dependency
  const { createAnalytics } = require('./analytics.js');

  const config: Partial<AnalyticsConfig> = {
    privacy: {
      enableAnalytics: true,
      userConsent: {
        anonymous: true, // User consented to anonymous tracking
        featureUsage: true,
        performance: false, // Still privacy-conscious
        errors: false,
      },
      dataCollection: {
        systemInfo: true, // Basic system info is OK for anonymous
        processingMetrics: true,
        featureFlags: enableFeatureFlags,
        sessionData: true,
      },
      retention: {
        userDataDays: 30,
        anonymousDataDays: 90,
      },
    },
  };

  const anonymousAnalytics = createAnalytics(config);

  // Add PostHog provider if API key provided
  if (postHogApiKey) {
    const postHogProvider = new PostHogAnalyticsProvider({
      enabled: true,
      apiKey: postHogApiKey,
      enableSessionRecording: false, // Respect privacy
      enableFeatureFlags,
      enableAutocapture: false, // Manual tracking only
      respectDoNotTrack: true,
    });
    anonymousAnalytics.addProvider(postHogProvider);
  }

  return anonymousAnalytics;
}

/**
 * Create analytics with full user consent for identified tracking
 */
export function createIdentifiedAnalytics(
  options: {
    postHogApiKey?: string;
    enableSessionRecording?: boolean;
    enableFeatureFlags?: boolean;
  } = {}
): Analytics {
  const { postHogApiKey, enableSessionRecording = false, enableFeatureFlags = true } = options;

  // Import createAnalytics to avoid circular dependency
  const { createAnalytics } = require('./analytics.js');

  const config: Partial<AnalyticsConfig> = {
    privacy: {
      enableAnalytics: true,
      userConsent: {
        anonymous: true,
        featureUsage: true,
        performance: true, // User consented to performance tracking
        errors: true, // User consented to error analytics
      },
      dataCollection: {
        systemInfo: true,
        processingMetrics: true,
        featureFlags: enableFeatureFlags,
        sessionData: true,
      },
      retention: {
        userDataDays: 90, // Longer retention with consent
        anonymousDataDays: 180,
      },
    },
  };

  const identifiedAnalytics = createAnalytics(config);

  // Add PostHog provider with more features if API key provided
  if (postHogApiKey) {
    const postHogProvider = new PostHogAnalyticsProvider({
      enabled: true,
      apiKey: postHogApiKey,
      enableSessionRecording,
      enableFeatureFlags,
      enableAutocapture: false, // Still manual tracking for control
      respectDoNotTrack: true,
      sessionReplayConfig: {
        recordHeaders: false, // Still privacy-conscious
        recordBody: false,
        recordPerformance: true,
      },
    });
    identifiedAnalytics.addProvider(postHogProvider);
  }

  return identifiedAnalytics;
}

/**
 * Create a test analytics that captures events without external side effects
 */
export function createTestAnalytics(): Analytics & { getEvents(): AnalyticsEventType[] } {
  const events: AnalyticsEventType[] = [];

  const testProvider = {
    name: 'test',
    isEnabled: true,
    async track(event: AnalyticsEventType): Promise<void> {
      events.push({ ...event }); // Store copy of event
    },
    async identify(): Promise<void> {
      // No-op for testing
    },
    async setUserProperties(): Promise<void> {
      // No-op for testing
    },
    async page(): Promise<void> {
      // No-op for testing
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };

  // Import createAnalytics to avoid circular dependency
  const { createAnalytics } = require('./analytics.js');

  const testAnalytics = createAnalytics({
    privacy: {
      enableAnalytics: true,
      userConsent: {
        anonymous: true,
        featureUsage: true,
        performance: true,
        errors: true,
      },
      dataCollection: {
        systemInfo: true,
        processingMetrics: true,
        featureFlags: true,
        sessionData: true,
      },
      retention: {
        userDataDays: 1,
        anonymousDataDays: 1,
      },
    },
  }) as Analytics & { getEvents(): AnalyticsEventType[] };

  testAnalytics.addProvider(testProvider);

  // Add method to retrieve captured events
  (testAnalytics as Analytics & { getEvents(): AnalyticsEventType[] }).getEvents = () => [
    ...events,
  ];

  return testAnalytics;
}

/**
 * Initialize analytics for the application
 * This should be called once during application startup
 */
export async function initializeAnalytics(
  config: {
    enableAnalytics?: boolean;
    userConsent?: 'none' | 'anonymous' | 'identified';
    postHogApiKey?: string;
    enableSessionRecording?: boolean;
    environment?: string;
  } = {}
): Promise<void> {
  const {
    enableAnalytics = false,
    userConsent = 'none',
    postHogApiKey,
    enableSessionRecording = false,
    environment = 'production',
  } = config;

  // Create appropriate analytics based on consent level
  let appAnalytics: Analytics;

  if (!enableAnalytics || userConsent === 'none') {
    appAnalytics = createPrivacyFirstAnalytics();
  } else if (userConsent === 'anonymous') {
    appAnalytics = createAnonymousAnalytics({ postHogApiKey });
  } else {
    appAnalytics = createIdentifiedAnalytics({
      postHogApiKey,
      enableSessionRecording,
    });
  }

  // Set as global analytics
  setGlobalAnalytics(appAnalytics);

  // Track initialization (only if analytics enabled)
  if (enableAnalytics && userConsent !== 'none') {
    analytics.track('analytics_initialized', {
      consentLevel: userConsent,
      hasPostHog: !!postHogApiKey,
      environment,
      enableSessionRecording,
    });
  }

  // Perform health check
  const healthResults = await appAnalytics.healthCheck();
  const healthyProviders = Object.entries(healthResults)
    .filter(([_, healthy]) => healthy)
    .map(([name]) => name);

  if (healthyProviders.length > 0) {
    console.log(
      `[Analytics] Initialized with ${healthyProviders.length} healthy providers:`,
      healthyProviders
    );
  }
}

/**
 * Gracefully shutdown analytics system
 * Should be called during application shutdown
 */
export async function shutdownAnalytics(): Promise<void> {
  if (globalAnalytics) {
    // Track shutdown event before closing
    try {
      analytics.track('analytics_shutdown');
      await analytics.flush(); // Ensure final events are sent
    } catch (error) {
      console.warn('[Analytics] Error tracking shutdown event:', error);
    }

    try {
      await globalAnalytics.close();
    } catch (error) {
      console.error('[Analytics] Error during shutdown:', error);
    }

    globalAnalytics = null;
  }
}

/**
 * Request user consent for analytics tracking
 * This should be called when user grants/revokes consent
 */
export async function updateAnalyticsConsent(
  consentLevel: 'none' | 'anonymous' | 'identified',
  options: {
    postHogApiKey?: string;
    enableSessionRecording?: boolean;
  } = {}
): Promise<void> {
  const { postHogApiKey, enableSessionRecording = false } = options;

  // Track consent change (if current analytics allows it)
  if (globalAnalytics && globalAnalytics.isEnabled()) {
    analytics.track('analytics_consent_changed', {
      previousConsent: 'unknown', // We don't track previous state
      newConsent: consentLevel,
    });

    await analytics.flush();
  }

  // Reinitialize analytics with new consent level
  await initializeAnalytics({
    enableAnalytics: consentLevel !== 'none',
    userConsent: consentLevel,
    postHogApiKey,
    enableSessionRecording,
  });
}

/**
 * Helper to track common application events with consistent properties
 */
export const trackEvent = {
  /**
   * Track application lifecycle events
   */
  appStarted: () =>
    analytics.track('app_started', {
      timestamp: new Date().toISOString(),
    }),

  appClosed: (duration: number) =>
    analytics.track('app_closed', {
      sessionDuration: duration,
      timestamp: new Date().toISOString(),
    }),

  /**
   * Track scan events
   */
  scanStarted: (properties: { scanPath: string; estimatedFileCount?: number }) =>
    analytics.track('scan_started', {
      ...properties,
      timestamp: new Date().toISOString(),
    }),

  scanCompleted: (properties: {
    duration: number;
    filesScanned: number;
    duplicatesFound: number;
  }) =>
    analytics.track('scan_completed', {
      ...properties,
      timestamp: new Date().toISOString(),
    }),

  /**
   * Track export events
   */
  exportCompleted: (properties: { format: string; recordCount: number; duration: number }) =>
    analytics.track('export_completed', {
      ...properties,
      timestamp: new Date().toISOString(),
    }),

  /**
   * Track feature usage
   */
  featureUsed: (featureName: string, properties?: Record<string, unknown>) =>
    analytics.track('feature_used', {
      featureName,
      ...properties,
      timestamp: new Date().toISOString(),
    }),

  /**
   * Track performance metrics
   */
  performanceMeasured: (properties: { operation: string; duration: number; memoryUsed?: number }) =>
    analytics.track('performance_measured', {
      ...properties,
      timestamp: new Date().toISOString(),
    }),
};

// === Re-export for convenience ===
export type { AnalyticsEventType as AnalyticsEvent, AnalyticsUserType as AnalyticsUser };
