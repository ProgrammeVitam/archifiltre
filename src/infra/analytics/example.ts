/**
 * Analytics System Usage Examples
 *
 * This file demonstrates how to use the Archifiltre analytics infrastructure
 * for tracking user behavior, product insights, and feature usage.
 *
 * NOTE: This is completely separate from logging - analytics is for product
 * insights while logging is for system errors and debugging.
 */

import {
  analytics,
  createAnalytics,
  createAnonymousAnalytics,
  createIdentifiedAnalytics,
  createTestAnalytics,
  PostHogAnalyticsProvider,
  initializeAnalytics,
  shutdownAnalytics,
  updateAnalyticsConsent,
  trackEvent,
  ANALYTICS_EVENTS,
} from '@infra/analytics';

// === Basic Usage Examples ===

/**
 * Example 1: Basic event tracking with the global analytics
 */
export function basicAnalyticsExample(): void {
  console.log('\n=== Basic Analytics Example ===');

  // Track user actions and behaviors
  analytics.track(ANALYTICS_EVENTS.APP_STARTED);

  analytics.track(ANALYTICS_EVENTS.SCAN_STARTED, {
    scanPath: '/home/user/documents',
    estimatedFileCount: 1250,
    scanType: 'full',
    includeHidden: false,
  });

  analytics.track(ANALYTICS_EVENTS.DUPLICATES_FOUND, {
    duplicateCount: 45,
    totalSpaceSaved: 2048000, // bytes
    duplicateTypes: ['exact', 'similar'],
  });

  analytics.track(ANALYTICS_EVENTS.EXPORT_COMPLETED, {
    format: 'csv',
    recordCount: 1250,
    duration: 5000, // milliseconds
    fileSize: 512000, // bytes
  });

  console.log('📊 Basic analytics events tracked (user behavior focus)');
}

/**
 * Example 2: Privacy-first analytics (default behavior)
 */
export function privacyFirstAnalyticsExample(): void {
  console.log('\n=== Privacy-First Analytics Example ===');

  // By default, analytics is disabled for maximum privacy
  const privacyAnalytics = createAnalytics(); // No providers, no tracking

  privacyAnalytics.track('user_action', { action: 'button_click' });

  console.log('🔒 Privacy-first: No events sent externally');
  console.log('Analytics enabled:', privacyAnalytics.isEnabled()); // false
}

/**
 * Example 3: Anonymous analytics (user consented to anonymous tracking)
 */
export function anonymousAnalyticsExample(): void {
  console.log('\n=== Anonymous Analytics Example ===');

  // User consented to anonymous usage analytics
  const anonymousAnalytics = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key', // Would be real API key
    enableFeatureFlags: true,
  });

  // Track anonymous user behavior
  anonymousAnalytics.track(ANALYTICS_EVENTS.FEATURE_USED, {
    featureName: 'duplicate_finder',
    context: 'main_scan',
    duration: 15000,
    success: true,
  });

  anonymousAnalytics.track(ANALYTICS_EVENTS.PERFORMANCE_MEASURED, {
    operation: 'hash_calculation',
    duration: 2500,
    memoryUsed: 64000000, // 64MB
    filesProcessed: 100,
  });

  console.log('👤 Anonymous analytics: User behavior tracked without identification');
}

/**
 * Example 4: Identified analytics (user consented to full tracking)
 */
export function identifiedAnalyticsExample(): void {
  console.log('\n=== Identified Analytics Example ===');

  // User explicitly consented to identified tracking
  const identifiedAnalytics = createIdentifiedAnalytics({
    postHogApiKey: 'phc_example_key', // Would be real API key
    enableSessionRecording: false, // Still respect privacy by default
    enableFeatureFlags: true,
  });

  // Identify the user (only after explicit consent)
  identifiedAnalytics.identify('user_123', {
    appVersion: '5.0.0',
    platform: 'linux',
    tier: 'free',
    locale: 'en-US',
  });

  // Track identified user behavior
  identifiedAnalytics.track(ANALYTICS_EVENTS.SCAN_COMPLETED, {
    duration: 45000, // 45 seconds
    filesScanned: 2500,
    directoriesScanned: 150,
    duplicatesFound: 75,
    totalSize: 1024000000, // 1GB
    errors: 2,
  });

  console.log('🎯 Identified analytics: Full user behavior tracking with consent');
}

/**
 * Example 5: Feature flags usage
 */
export function featureFlagsExample(): void {
  console.log('\n=== Feature Flags Example ===');

  const analyticsWithFlags = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key',
    enableFeatureFlags: true,
  });

  // Check feature flags for A/B testing or feature rollouts
  const newUIEnabled = analyticsWithFlags.isFeatureEnabled('new_ui_design');
  const betaFeaturesEnabled = analyticsWithFlags.isFeatureEnabled('beta_features');

  console.log('🚩 Feature flags:', { newUIEnabled, betaFeaturesEnabled });

  // Track feature flag usage
  if (newUIEnabled) {
    analyticsWithFlags.track(ANALYTICS_EVENTS.FEATURE_USED, {
      featureName: 'new_ui_design',
      variant: 'enabled',
    });
  }

  // Get feature flag values (not just boolean)
  const algorithmVariant = analyticsWithFlags.getFeatureFlag('hash_algorithm');
  console.log('🧪 Algorithm variant:', algorithmVariant);
}

/**
 * Example 6: Page/screen tracking for desktop app
 */
export function pageTrackingExample(): void {
  console.log('\n=== Page/Screen Tracking Example ===');

  const pageAnalytics = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key',
  });

  // Track different screens/views in the desktop app
  pageAnalytics.page('main_screen');
  pageAnalytics.page('settings_screen', {
    previousScreen: 'main_screen',
    settingsTab: 'privacy',
  });
  pageAnalytics.page('scan_results_screen', {
    scanId: 'scan_12345',
    resultCount: 1250,
  });

  console.log('📱 Screen navigation tracked for UX insights');
}

/**
 * Example 7: Performance analytics
 */
export function performanceAnalyticsExample(): void {
  console.log('\n=== Performance Analytics Example ===');

  const perfAnalytics = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key',
  });

  // Track application performance metrics
  perfAnalytics.track(ANALYTICS_EVENTS.PERFORMANCE_MEASURED, {
    operation: 'file_scan',
    duration: 30000, // 30 seconds
    memoryUsed: 128000000, // 128MB
    cpuUsage: 45, // 45%
    filesProcessed: 5000,
    throughput: 166, // files per second
  });

  perfAnalytics.track(ANALYTICS_EVENTS.MEMORY_WARNING, {
    memoryUsed: 512000000, // 512MB
    memoryLimit: 1024000000, // 1GB
    action: 'gc_triggered',
  });

  console.log('⚡ Performance metrics tracked for optimization insights');
}

/**
 * Example 8: Error analytics (non-sensitive error patterns)
 */
export function errorAnalyticsExample(): void {
  console.log('\n=== Error Analytics Example ===');

  const errorAnalytics = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key',
  });

  // Track error patterns for product improvement (not system debugging)
  errorAnalytics.track(ANALYTICS_EVENTS.USER_ERROR, {
    errorType: 'invalid_path',
    errorCategory: 'user_input',
    context: 'scan_setup',
    recoverable: true,
  });

  errorAnalytics.track(ANALYTICS_EVENTS.FEATURE_ERROR, {
    featureName: 'export_csv',
    errorType: 'permission_denied',
    attemptNumber: 2,
    context: 'export_dialog',
  });

  console.log('🐛 Error patterns tracked (for product improvement, not debugging)');
  console.log('Note: Detailed system errors go to logging/Sentry, not analytics');
}

/**
 * Example 9: Session and lifecycle tracking
 */
export function sessionTrackingExample(): void {
  console.log('\n=== Session Tracking Example ===');

  const sessionAnalytics = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key',
  });

  // Track application lifecycle
  sessionAnalytics.track(ANALYTICS_EVENTS.APP_STARTED, {
    coldStart: true,
    startupTime: 2500, // milliseconds
    previousVersion: '4.2.1',
  });

  // Simulate some activity
  sessionAnalytics.track(ANALYTICS_EVENTS.FEATURE_USED, {
    featureName: 'quick_scan',
    sessionTime: 120000, // 2 minutes into session
  });

  // Track session end
  sessionAnalytics.track(ANALYTICS_EVENTS.APP_CLOSED, {
    sessionDuration: 900000, // 15 minutes
    scansPerformed: 3,
    exportsCreated: 1,
    crashOccurred: false,
  });

  console.log('📅 Session lifecycle tracked for usage pattern insights');
}

/**
 * Example 10: Test analytics for unit testing
 */
export function testAnalyticsExample(): void {
  console.log('\n=== Test Analytics Example ===');

  const testAnalytics = createTestAnalytics();

  // Track events during tests
  testAnalytics.track('test_event_1', { value: 123 });
  testAnalytics.track('test_event_2', { category: 'testing' });
  testAnalytics.track('feature_used', { featureName: 'test_feature' });

  // Retrieve captured events for assertions
  const capturedEvents = testAnalytics.getEvents();
  console.log('🧪 Test events captured:', capturedEvents.length);

  capturedEvents.forEach((event, index) => {
    console.log(`  ${index + 1}. ${event.name} - ${JSON.stringify(event.properties)}`);
  });
}

/**
 * Example 11: Consent flow simulation
 */
export async function consentFlowExample(): Promise<void> {
  console.log('\n=== Consent Flow Example ===');

  // 1. Start with privacy-first (no tracking)
  console.log('Step 1: App starts with no tracking (privacy-first)');
  await initializeAnalytics({
    enableAnalytics: false,
    userConsent: 'none',
  });

  analytics.track('app_started'); // Won't be sent anywhere
  console.log('  Analytics enabled:', analytics.isEnabled()); // false

  // 2. User consents to anonymous tracking
  console.log('Step 2: User consents to anonymous analytics');
  await updateAnalyticsConsent('anonymous', {
    postHogApiKey: 'phc_example_key',
  });

  analytics.track('consent_given', { consentType: 'anonymous' });
  console.log('  Analytics enabled:', analytics.isEnabled()); // true

  // 3. User upgrades to identified tracking
  console.log('Step 3: User upgrades to identified tracking');
  await updateAnalyticsConsent('identified', {
    postHogApiKey: 'phc_example_key',
    enableSessionRecording: false, // User choice
  });

  analytics.identify('user_456', {
    plan: 'premium',
    source: 'upgrade_consent',
  });

  console.log('  Full tracking enabled with user identification');

  // 4. User revokes consent
  console.log('Step 4: User revokes all consent');
  await updateAnalyticsConsent('none');

  analytics.track('consent_revoked'); // Won't be sent
  console.log('  Analytics disabled, privacy restored');
}

/**
 * Example 12: Using convenience tracking helpers
 */
export function convenienceTrackingExample(): void {
  console.log('\n=== Convenience Tracking Example ===');

  // Initialize analytics for this example (not used directly, just for setup)
  const _convenienceAnalytics = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key',
  });

  // Use convenience helpers for common events
  trackEvent.appStarted();

  trackEvent.scanStarted({
    scanPath: '/Users/john/Documents',
    estimatedFileCount: 2500,
  });

  trackEvent.scanCompleted({
    duration: 45000,
    filesScanned: 2487,
    duplicatesFound: 156,
  });

  trackEvent.exportCompleted({
    format: 'json',
    recordCount: 156,
    duration: 2000,
  });

  trackEvent.featureUsed('advanced_filter', {
    filterType: 'size_range',
    minSize: 1000000, // 1MB
  });

  trackEvent.performanceMeasured({
    operation: 'duplicate_detection',
    duration: 12000,
    memoryUsed: 256000000, // 256MB
  });

  trackEvent.appClosed(1800000); // 30 minute session

  console.log('🎯 Common events tracked using convenience helpers');
}

/**
 * Example 13: Health monitoring for analytics
 */
export async function analyticsHealthExample(): Promise<void> {
  console.log('\n=== Analytics Health Monitoring Example ===');

  const healthAnalytics = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key',
  });

  // Add a PostHog provider
  const postHogProvider = new PostHogAnalyticsProvider({
    enabled: true,
    apiKey: 'phc_example_key',
  });
  healthAnalytics.addProvider(postHogProvider);

  // Check provider health
  const healthResults = await healthAnalytics.healthCheck();

  console.log('Analytics health check results:');
  Object.entries(healthResults).forEach(([providerName, healthy]) => {
    const status = healthy ? '✅ Healthy' : '❌ Unhealthy';
    console.log(`  ${providerName}: ${status}`);
  });

  // Get session information
  const session = healthAnalytics.getSession();
  console.log('Current session:', {
    sessionId: session.sessionId,
    duration: Math.round(session.duration / 1000) + 's',
  });
}

/**
 * Example 14: Analytics vs Logging clarity
 */
export function analyticsVsLoggingExample(): void {
  console.log('\n=== Analytics vs Logging Clarity Example ===');

  const userAnalytics = createAnonymousAnalytics({
    postHogApiKey: 'phc_example_key',
  });

  console.log('📊 ANALYTICS - Product insights & user behavior:');

  // ✅ Analytics: User behavior and product insights
  userAnalytics.track('scan_started', { scanType: 'quick' }); // Product usage
  userAnalytics.track('feature_discovered', { feature: 'export' }); // User journey
  userAnalytics.track('performance_measured', { operation: 'scan', duration: 5000 }); // Product performance
  userAnalytics.track('user_error', { errorType: 'invalid_input' }); // UX problems

  console.log('  ✅ User started a quick scan (product usage)');
  console.log('  ✅ User discovered export feature (user journey)');
  console.log('  ✅ Scan took 5 seconds (product performance)');
  console.log('  ✅ User made input error (UX insight)');

  console.log('\n🔍 LOGGING - System health & debugging:');

  // These would go to the logging system, NOT analytics:
  console.log('  ✅ Application started successfully (system event)');
  console.log('  ✅ Database connection established (infrastructure)');
  console.log('  ⚠️  File permission denied for scan.log (system warning)');
  console.log('  ❌ Hash calculation failed for file.pdf (system error)');

  console.log('\n🎯 Key Distinction:');
  console.log('  • Analytics: WHO did WHAT and HOW (product insights)');
  console.log('  • Logging: WHAT happened WHY it failed (system debugging)');
}

/**
 * Run all examples
 */
export async function runAllAnalyticsExamples(): Promise<void> {
  console.log('📊 Archifiltre Analytics System Examples\n');
  console.log('This demonstrates privacy-respecting product analytics and user behavior tracking.');
  console.log(
    'Analytics is separate from logging - it focuses on product insights, not system debugging.\n'
  );

  try {
    basicAnalyticsExample();
    privacyFirstAnalyticsExample();
    anonymousAnalyticsExample();
    identifiedAnalyticsExample();
    featureFlagsExample();
    pageTrackingExample();
    performanceAnalyticsExample();
    errorAnalyticsExample();
    sessionTrackingExample();
    testAnalyticsExample();
    await consentFlowExample();
    convenienceTrackingExample();
    await analyticsHealthExample();
    analyticsVsLoggingExample();

    console.log('\n✅ All analytics examples completed successfully!');
    console.log('\nKey features demonstrated:');
    console.log('  🔒 Privacy-first design with explicit user consent');
    console.log('  📊 Product analytics and user behavior tracking');
    console.log('  🎯 Feature flags for A/B testing and rollouts');
    console.log('  📱 Page/screen tracking for UX insights');
    console.log('  ⚡ Performance analytics for optimization');
    console.log('  👤 Anonymous vs identified tracking options');
    console.log('  🧪 Test-friendly design with event capture');
    console.log('  🎛️  Granular consent controls and updates');
    console.log('  🩺 Health monitoring and diagnostics');
    console.log('  🚫 Clear separation from logging system');

    console.log('\n📋 When to use Analytics vs Logging:');
    console.log('  📊 Analytics: User behavior, feature usage, product performance');
    console.log('  🔍 Logging: System errors, debugging info, infrastructure health');

    // Cleanup
    await shutdownAnalytics();
  } catch (error) {
    console.error('❌ Error running analytics examples:', error);
  }
}

// Functions are already exported inline above

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllAnalyticsExamples().catch(console.error);
}
