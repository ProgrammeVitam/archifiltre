/**
 * Main Analytics Implementation
 *
 * Privacy-respecting analytics system for tracking user behavior, feature usage,
 * and product insights. Completely separate from logging infrastructure.
 */

import type {
  IAnalytics,
  AnalyticsProvider,
  AnalyticsConfig,
  AnalyticsEvent,
  AnalyticsUser,
} from './types.js';
import {
  DEFAULT_ANALYTICS_CONFIG,
  isValidAnalyticsEvent,
  sanitizeEventProperties,
} from './types.js';

/**
 * Main Analytics class that implements the IAnalytics interface
 */
export class Analytics implements IAnalytics {
  private readonly providers: Map<string, AnalyticsProvider> = new Map();
  private readonly config: AnalyticsConfig;
  private readonly eventQueue: AnalyticsEvent[] = [];
  private currentUser: AnalyticsUser;
  private sessionId: string;
  private sessionStartTime: number;
  private batchFlushTimer?: ReturnType<typeof setInterval>;
  private isShuttingDown = false;

  constructor(config: Partial<AnalyticsConfig> = {}) {
    this.config = { ...DEFAULT_ANALYTICS_CONFIG, ...config };
    this.currentUser = this.createAnonymousUser();
    this.sessionId = this.generateSessionId();
    this.sessionStartTime = Date.now();

    // Start batch processing if analytics is enabled
    if (this.config.privacy.enableAnalytics) {
      this.startBatchTimer();
    }
  }

  /**
   * Add a provider to the analytics system
   */
  public addProvider(provider: AnalyticsProvider): void {
    if (provider.isEnabled && this.config.privacy.enableAnalytics) {
      this.providers.set(provider.name, provider);
    }
  }

  /**
   * Remove a provider from the analytics system
   */
  public removeProvider(providerName: string): void {
    this.providers.delete(providerName);
  }

  /**
   * Get all active providers
   */
  public getProviders(): AnalyticsProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Track a user action or behavior event
   */
  public track(eventName: string, properties: Record<string, unknown> = {}): void {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const event = this.createAnalyticsEvent(eventName, properties);
      this.queueEvent(event);
    } catch (error) {
      // Don't let analytics errors crash the application
      console.warn('[Analytics] Failed to track event:', error);
    }
  }

  /**
   * Identify a user with properties (respects privacy settings)
   */
  public identify(userId?: string, properties: Record<string, unknown> = {}): void {
    if (!this.isEnabled()) {
      return;
    }

    try {
      // Only set userId if user has consented to identified tracking
      if (userId && this.canIdentifyUser()) {
        this.currentUser.userId = userId;
        this.currentUser.properties = {
          ...this.currentUser.properties,
          consentLevel: 'identified',
        };
      }

      // Update user properties
      this.setUserProperties(properties);

      // Send identify event to providers
      this.sendIdentifyToProviders(this.currentUser.userId || this.currentUser.anonymousId, {
        ...this.currentUser.properties,
        ...properties,
      }).catch(error => {
        console.warn('[Analytics] Failed to send identify event:', error);
      });
    } catch (error) {
      console.warn('[Analytics] Failed to identify user:', error);
    }
  }

  /**
   * Set user properties that persist across events
   */
  public setUserProperties(properties: Record<string, unknown>): void {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const sanitizedProperties = this.sanitizeProperties(properties);
      this.currentUser.properties = {
        ...this.currentUser.properties,
        ...sanitizedProperties,
      };

      // Send to providers
      this.sendUserPropertiesToProviders(sanitizedProperties).catch(error => {
        console.warn('[Analytics] Failed to set user properties:', error);
      });
    } catch (error) {
      console.warn('[Analytics] Failed to set user properties:', error);
    }
  }

  /**
   * Track a page/screen view
   */
  public page(name: string, properties: Record<string, unknown> = {}): void {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const pageProperties = {
        ...properties,
        pageName: name,
        timestamp: new Date().toISOString(),
      };

      // Send page view to providers
      this.sendPageToProviders(name, pageProperties).catch(error => {
        console.warn('[Analytics] Failed to track page view:', error);
      });

      // Also track as a regular event
      this.track('page_viewed', pageProperties);
    } catch (error) {
      console.warn('[Analytics] Failed to track page view:', error);
    }
  }

  /**
   * Check if a feature flag is enabled
   */
  public isFeatureEnabled(flagName: string): boolean {
    if (!this.isEnabled() || !this.config.privacy.dataCollection.featureFlags) {
      return false;
    }

    try {
      // Check with providers that support feature flags
      for (const provider of this.providers.values()) {
        if (provider.isFeatureEnabled) {
          const isEnabled = provider.isFeatureEnabled(flagName);

          // Track feature flag evaluation if enabled
          if (this.config.privacy.dataCollection.featureFlags) {
            this.track('feature_flag_evaluated', {
              flagName,
              result: isEnabled,
              provider: provider.name,
            });
          }

          return isEnabled;
        }
      }

      return false;
    } catch (error) {
      console.warn('[Analytics] Failed to check feature flag:', error);
      return false;
    }
  }

  /**
   * Get feature flag value
   */
  public getFeatureFlag(flagName: string): string | boolean | null {
    if (!this.isEnabled() || !this.config.privacy.dataCollection.featureFlags) {
      return null;
    }

    try {
      // Check with providers that support feature flags
      for (const provider of this.providers.values()) {
        if (provider.getFeatureFlag) {
          const value = provider.getFeatureFlag(flagName);

          // Track feature flag evaluation if enabled
          if (this.config.privacy.dataCollection.featureFlags) {
            this.track('feature_flag_evaluated', {
              flagName,
              value,
              provider: provider.name,
            });
          }

          return value;
        }
      }

      return null;
    } catch (error) {
      console.warn('[Analytics] Failed to get feature flag:', error);
      return null;
    }
  }

  /**
   * Flush pending events immediately
   */
  public async flush(): Promise<void> {
    if (!this.isEnabled() || this.eventQueue.length === 0) {
      return;
    }

    try {
      await this.processBatch();
    } catch (error) {
      console.warn('[Analytics] Failed to flush events:', error);
    }
  }

  /**
   * Check if analytics is enabled and healthy
   */
  public isEnabled(): boolean {
    return this.config.privacy.enableAnalytics && !this.isShuttingDown && this.providers.size > 0;
  }

  /**
   * Gracefully close all providers and flush remaining events
   */
  public async close(): Promise<void> {
    this.isShuttingDown = true;

    // Clear batch timer
    if (this.batchFlushTimer) {
      clearInterval(this.batchFlushTimer);
      this.batchFlushTimer = undefined;
    }

    // Flush remaining events
    try {
      await this.flush();
    } catch (error) {
      console.warn('[Analytics] Error flushing events during close:', error);
    }

    // Close all providers
    const closePromises = Array.from(this.providers.values())
      .filter(provider => provider.close)
      .map(provider =>
        provider.close!().catch(error => {
          console.warn(`[Analytics] Error closing provider ${provider.name}:`, error);
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
        console.warn(`[Analytics] Health check failed for provider ${name}:`, error);
        results[name] = false;
      }
    }

    return results;
  }

  /**
   * Get current session information
   */
  public getSession(): {
    sessionId: string;
    startTime: number;
    duration: number;
  } {
    return {
      sessionId: this.sessionId,
      startTime: this.sessionStartTime,
      duration: Date.now() - this.sessionStartTime,
    };
  }

  /**
   * Update configuration at runtime
   */
  public updateConfig(newConfig: Partial<AnalyticsConfig>): void {
    Object.assign(this.config, newConfig);

    // Re-evaluate provider states based on new config
    if (!this.config.privacy.enableAnalytics) {
      this.providers.clear();
      if (this.batchFlushTimer) {
        clearInterval(this.batchFlushTimer);
        this.batchFlushTimer = undefined;
      }
    } else if (!this.batchFlushTimer) {
      this.startBatchTimer();
    }
  }

  /**
   * Get current configuration (read-only)
   */
  public getConfig(): Readonly<AnalyticsConfig> {
    return { ...this.config };
  }

  /**
   * Create an analytics event from basic parameters
   */
  private createAnalyticsEvent(
    eventName: string,
    properties: Record<string, unknown>
  ): AnalyticsEvent {
    const sanitizedProperties = this.sanitizeProperties(properties);

    const event: AnalyticsEvent = {
      name: eventName,
      properties: sanitizedProperties,
      userId: this.currentUser.userId,
      anonymousId: this.currentUser.anonymousId,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
    };

    return event;
  }

  /**
   * Add event to queue for batch processing
   */
  private queueEvent(event: AnalyticsEvent): void {
    if (!isValidAnalyticsEvent(event)) {
      console.warn('[Analytics] Invalid event, skipping:', event);
      return;
    }

    this.eventQueue.push(event);

    // Flush immediately if queue is full
    if (this.eventQueue.length >= this.config.batching.maxBatchSize) {
      this.processBatch().catch(error => {
        console.warn('[Analytics] Failed to process batch:', error);
      });
    }
  }

  /**
   * Process queued events in batches
   */
  private async processBatch(): Promise<void> {
    if (this.eventQueue.length === 0) {
      return;
    }

    const batch = this.eventQueue.splice(0, this.config.batching.maxBatchSize);

    // Send to all providers in parallel
    const providerPromises = Array.from(this.providers.values()).map(async provider => {
      try {
        for (const event of batch) {
          await provider.track(event);
        }
      } catch (error) {
        console.warn(`[Analytics] Provider ${provider.name} failed to process batch:`, error);
      }
    });

    await Promise.all(providerPromises);
  }

  /**
   * Start the batch processing timer
   */
  private startBatchTimer(): void {
    if (this.batchFlushTimer) {
      return;
    }

    this.batchFlushTimer = setInterval(() => {
      this.processBatch().catch(error => {
        console.warn('[Analytics] Batch timer processing failed:', error);
      });
    }, this.config.batching.flushIntervalMs);
  }

  /**
   * Send identify event to all providers
   */
  private async sendIdentifyToProviders(
    userId: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    const promises = Array.from(this.providers.values()).map(provider =>
      provider.identify(userId, properties).catch(error => {
        console.warn(`[Analytics] Provider ${provider.name} identify failed:`, error);
      })
    );

    await Promise.all(promises);
  }

  /**
   * Send user properties to all providers
   */
  private async sendUserPropertiesToProviders(properties: Record<string, unknown>): Promise<void> {
    const promises = Array.from(this.providers.values()).map(provider =>
      provider.setUserProperties(properties).catch(error => {
        console.warn(`[Analytics] Provider ${provider.name} setUserProperties failed:`, error);
      })
    );

    await Promise.all(promises);
  }

  /**
   * Send page view to all providers
   */
  private async sendPageToProviders(
    name: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    const promises = Array.from(this.providers.values()).map(provider =>
      provider.page(name, properties).catch(error => {
        console.warn(`[Analytics] Provider ${provider.name} page failed:`, error);
      })
    );

    await Promise.all(promises);
  }

  /**
   * Create an anonymous user for privacy-respecting tracking
   */
  private createAnonymousUser(): AnalyticsUser {
    return {
      anonymousId: this.generateAnonymousId(),
      properties: {
        appVersion: process.env.npm_package_version || 'unknown',
        platform: process.platform,
        consentLevel: 'anonymous',
        isNewUser: true, // Will be updated based on actual usage
      },
    };
  }

  /**
   * Generate anonymous user ID
   */
  private generateAnonymousId(): string {
    return 'anon_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return 'sess_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
  }

  /**
   * Check if user can be identified (based on consent)
   */
  private canIdentifyUser(): boolean {
    return this.config.privacy.userConsent.anonymous === true;
  }

  /**
   * Sanitize properties according to privacy settings
   */
  private sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
    return sanitizeEventProperties(properties, this.config.privacy);
  }
}

/**
 * Convenience function to create an analytics instance with defaults
 */
export function createAnalytics(config: Partial<AnalyticsConfig> = {}): Analytics {
  return new Analytics(config);
}

/**
 * Convenience function to create a privacy-first analytics instance
 */
export function createPrivacyFirstAnalytics(): Analytics {
  return new Analytics({
    privacy: {
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
    },
  });
}

/**
 * Convenience function to create a development analytics instance
 */
export function createDevelopmentAnalytics(): Analytics {
  return new Analytics({
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
        userDataDays: 7, // Short retention in development
        anonymousDataDays: 30,
      },
    },
    batching: {
      maxBatchSize: 10, // Smaller batches for development
      flushIntervalMs: 5000, // More frequent flushes
    },
  });
}
