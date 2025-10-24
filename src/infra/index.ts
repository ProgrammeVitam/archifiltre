/**
 * Archifiltre Infrastructure Layer
 *
 * This module provides infrastructure services and utilities for the application.
 * Infrastructure includes cross-cutting concerns like logging, configuration,
 * database connections, and external service integrations.
 *
 * Design principles:
 * - Privacy-first: All external integrations require explicit user consent
 * - Modular: Each service can be used independently
 * - Configurable: Services can be configured based on environment and user preferences
 * - Resilient: Failures in infrastructure don't crash the application
 */

// === Logging Infrastructure ===
export {
  // Types and interfaces
  type ILogger,
  type LogProvider,
  type LogLevel,
  type LogFormat,
  type LogContext,
  type LoggableError,
  type LoggingConfig,
  type PrivacyConfig,
  type ConsoleProviderConfig,
  type SentryProviderConfig,
  type LogEntry,

  // Constants and utilities
  LOG_LEVELS,
  DEFAULT_LOGGING_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
  isLoggableError,
  isValidLogLevel,
  isLogLevelEnabled,

  // Core logger
  Logger,
  createLogger,
  createPrivacyFirstLogger,
  createDevelopmentLogger,

  // Providers
  ConsoleLogProvider,
  createConsoleProvider,
  SentryLogProvider,
  createSentryProvider,
  isSentryAvailable,

  // Sanitization (TODO: Re-enable once implemented)
  // sanitizeData,
  // createSanitizer,
  // sanitizeForCLI,
  // sanitizeForExternal,
  // sanitizeMinimal,
  // containsSensitiveData,
  // getSanitizationSummary,

  // Global logger and factories
  logger,
  getGlobalLogger,
  setGlobalLogger,
  resetGlobalLogger,
  createCLILogger,
  createTelemetryLogger,
  createTestLogger,
  initializeLogging,
  shutdownLogging,
} from './logging/index.js';

// === Analytics Infrastructure ===
export {
  // Core analytics types and interfaces
  type IAnalytics,
  type AnalyticsProvider,
  type AnalyticsEvent,
  type AnalyticsUser,
  type AnalyticsConfig,
  type AnalyticsPrivacyConfig,
  type PostHogProviderConfig,
  type ScanStartedProperties,
  type ScanCompletedProperties,
  type ExportCompletedProperties,
  type FeatureUsedProperties,
  type PerformanceProperties,

  // Constants and utilities
  ANALYTICS_EVENTS,
  DEFAULT_ANALYTICS_CONFIG,
  DEFAULT_ANALYTICS_PRIVACY_CONFIG,
  isValidAnalyticsEvent,
  sanitizeEventProperties,

  // Core analytics
  Analytics,
  createAnalytics,
  createPrivacyFirstAnalytics,
  createDevelopmentAnalytics,

  // Providers
  PostHogAnalyticsProvider,
  createPostHogProvider,
  isPostHogAvailable,

  // Global analytics and factories
  analytics,
  getGlobalAnalytics,
  setGlobalAnalytics,
  resetGlobalAnalytics,
  createAnonymousAnalytics,
  createIdentifiedAnalytics,
  createTestAnalytics,
  initializeAnalytics,
  shutdownAnalytics,
  updateAnalyticsConsent,
  trackEvent,
} from './analytics/index.js';

// === Internal imports for implementation ===
import { getGlobalLogger, logger, initializeLogging, shutdownLogging } from './logging/index.js';
import { getGlobalAnalytics, initializeAnalytics, shutdownAnalytics } from './analytics/index.js';
import type { LogLevel } from './logging/types.js';

// === Future Infrastructure Components ===
// These will be implemented in future phases

// Database layer (PGlite integration)
// export * from './database/index.js';

// Configuration management
// export * from './config/index.js';

// Progress reporting and state management
// export * from './progress/index.js';

// Error recovery and resilience
// export * from './recovery/index.js';

// File system utilities
// export * from './filesystem/index.js';

// Cache management
// export * from './cache/index.js';

/**
 * Infrastructure health check
 * Verifies that all infrastructure components are working correctly
 */
export async function checkInfrastructureHealth(): Promise<{
  healthy: boolean;
  components: Record<string, boolean>;
  errors: string[];
}> {
  const results = {
    healthy: true,
    components: {} as Record<string, boolean>,
    errors: [] as string[],
  };

  try {
    // Check logging system
    const logger = getGlobalLogger();
    const loggingHealth = await logger.healthCheck();

    results.components.logging = Object.values(loggingHealth).some(healthy => healthy);

    if (!results.components.logging) {
      results.errors.push('Logging system has no healthy providers');
      results.healthy = false;
    }

    // Check analytics system
    const analyticsInstance = getGlobalAnalytics();
    const analyticsHealth = await analyticsInstance.healthCheck();

    results.components.analytics = Object.values(analyticsHealth).some(healthy => healthy);

    // Analytics is optional, so don't fail if it's not healthy
    if (!results.components.analytics) {
      results.errors.push('Analytics system has no healthy providers (optional)');
    }

    // Future: Add other infrastructure health checks here
    // results.components.database = await checkDatabaseHealth();
    // results.components.config = await checkConfigHealth();
    // results.components.cache = await checkCacheHealth();
  } catch (error) {
    results.healthy = false;
    results.errors.push(`Infrastructure health check failed: ${error}`);
  }

  return results;
}

/**
 * Initialize all infrastructure components
 * Should be called during application startup
 */
export async function initializeInfrastructure(
  config: {
    // Logging configuration
    logging?: {
      level?: LogLevel;
      enableTelemetry?: boolean;
      sentryDsn?: string;
      environment?: string;
    };

    // Analytics configuration
    analytics?: {
      enableAnalytics?: boolean;
      userConsent?: 'none' | 'anonymous' | 'identified';
      postHogApiKey?: string;
      enableSessionRecording?: boolean;
      environment?: string;
    };

    // Future: Database configuration
    // database?: {
    //   path?: string;
    //   enableWAL?: boolean;
    // };

    // Future: Other infrastructure config
  } = {}
): Promise<void> {
  const { logging, analytics } = config;

  // Initialize logging first (other components may depend on it)
  if (logging) {
    await initializeLogging(logging);
  } else {
    await initializeLogging(); // Use defaults
  }

  // Log infrastructure initialization
  logger.info('Infrastructure initialization started');

  // Initialize analytics (depends on logging for error handling)
  if (analytics) {
    await initializeAnalytics(analytics);
  } else {
    await initializeAnalytics(); // Use privacy-first defaults
  }

  // Future: Initialize other infrastructure components
  // await initializeDatabase(config.database);
  // await initializeConfig(config.config);
  // await initializeCache(config.cache);

  logger.info('Infrastructure initialization completed');
}

/**
 * Gracefully shutdown all infrastructure components
 * Should be called during application shutdown
 */
export async function shutdownInfrastructure(): Promise<void> {
  logger.info('Infrastructure shutdown started');

  // Shutdown in reverse order of initialization
  // Future: Shutdown other components first
  // await shutdownCache();
  // await shutdownDatabase();
  // await shutdownConfig();

  // Shutdown analytics before logging (analytics may log during shutdown)
  await shutdownAnalytics();

  // Shutdown logging last
  await shutdownLogging();

  // Final log to console (since logging is now shut down)
  console.log('[Infrastructure] Shutdown completed');
}
