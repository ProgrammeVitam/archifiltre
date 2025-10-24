/**
 * Logging System Usage Examples
 *
 * This file demonstrates how to use the Archifiltre logging infrastructure
 * in various scenarios, from basic logging to advanced provider configuration.
 */

import {
  logger,
  createLogger,
  createCLILogger,
  createTelemetryLogger,
  createTestLogger,
  ConsoleLogProvider,
  initializeLogging,
  shutdownLogging,
} from '@infra/logging';

// === Basic Usage Examples ===

/**
 * Example 1: Basic logging with the global logger
 */
export function basicLoggingExample(): void {
  console.log('\n=== Basic Logging Example ===');

  // Simple log messages
  logger.debug('Debug message - only shown with verbose logging');
  logger.info('Application started successfully');
  logger.warn('This is a warning message');
  logger.error('Something went wrong!');

  // Logging with context
  logger.info('Processing file', {
    filename: 'document.pdf',
    size: 1024000,
    timestamp: new Date().toISOString(),
  });

  // Error logging with Error object
  try {
    throw new Error('Simulated error for demonstration');
  } catch (error) {
    logger.error('Failed to process file', error as Error, {
      operation: 'file_processing',
      attemptNumber: 1,
    });
  }
}

/**
 * Example 2: Creating a CLI logger with different configurations
 */
export function cliLoggingExample(): void {
  console.log('\n=== CLI Logging Example ===');

  // Create a simple CLI logger
  const cliLogger = createCLILogger({
    verbose: false,
    colorize: true,
    format: 'text',
  });

  cliLogger.info('CLI operation started');
  cliLogger.warn('Non-critical warning in CLI');

  // Create a verbose CLI logger
  const verboseCLILogger = createCLILogger({
    verbose: true,
    colorize: true,
    format: 'text',
  });

  verboseCLILogger.debug('Debug information visible in verbose mode');
  verboseCLILogger.info('Verbose CLI logger active');
}

/**
 * Example 3: Child loggers with additional context
 */
export function childLoggerExample(): void {
  console.log('\n=== Child Logger Example ===');

  // Create a child logger with component context
  const fileScanner = logger.child({
    component: 'FileScanner',
    scanId: 'scan_12345',
  });

  fileScanner.info('Starting file scan');
  fileScanner.debug('Scanning directory', { path: '/home/user/documents' });
  fileScanner.warn('Skipping unreadable file', { file: 'corrupted.pdf' });

  // Create another child logger with different context
  const hashCalculator = logger.child({
    component: 'HashCalculator',
    algorithm: 'SHA256',
  });

  hashCalculator.info('Calculating file hashes');
  hashCalculator.debug('Hash calculated', {
    file: 'document.pdf',
    hash: 'abc123...',
    duration: 150,
  });
}

/**
 * Example 4: Custom logger with specific providers
 */
export function customLoggerExample(): void {
  console.log('\n=== Custom Logger Example ===');

  // Create a custom logger with specific configuration
  const customLogger = createLogger({
    level: 'debug',
    format: 'text',
    enableColors: true,
    includeTimestamps: true,
    includeContext: true,
    privacy: {
      enableTelemetry: false, // Privacy-first
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

  // Add a console provider
  const consoleProvider = new ConsoleLogProvider({
    enabled: true,
    colorize: true,
    includeStackTrace: true,
  });
  customLogger.addProvider(consoleProvider);

  customLogger.info('Custom logger initialized');
  customLogger.debug('Debug mode enabled with full context');
}

/**
 * Example 5: Error tracking logger with Sentry (when user consents)
 */
export function errorTrackingLoggerExample(): void {
  console.log('\n=== Error Tracking Logger Example (Simulated) ===');

  // Note: This would only be used when user explicitly consents to error tracking
  const errorTrackingLogger = createTelemetryLogger({
    level: 'info',
    sentryDsn: 'https://example@sentry.io/project-id', // Would be real DSN
    environment: 'production',
  });

  errorTrackingLogger.info('User consented to error tracking - Sentry logging enabled');
  errorTrackingLogger.warn('This warning will be sent to Sentry for error tracking');
  errorTrackingLogger.error('This error will be tracked in Sentry', new Error('Example error'));

  // Note: In real usage, you'd only create this logger after getting explicit user consent
  console.log('  (Sentry provider would be configured here with user consent)');
  console.log('  (PostHog analytics are handled separately in the analytics system)');
}

/**
 * Example 6: Test logger for unit testing
 */
export function testLoggerExample(): void {
  console.log('\n=== Test Logger Example ===');

  const testLogger = createTestLogger();

  // Log some messages
  testLogger.info('Test message 1');
  testLogger.warn('Test warning');
  testLogger.error('Test error', new Error('Test error object'));

  // Retrieve captured logs
  const capturedLogs = testLogger.getLogs();
  console.log('Captured logs:', capturedLogs.length);

  capturedLogs.forEach((log, index) => {
    console.log(`  ${index + 1}. [${log.level.toUpperCase()}] ${log.message}`);
  });
}

/**
 * Example 7: Logger health checking
 */
export async function healthCheckExample(): Promise<void> {
  console.log('\n=== Health Check Example ===');

  const customLogger = createLogger();
  const consoleProvider = new ConsoleLogProvider({ enabled: true });
  customLogger.addProvider(consoleProvider);

  // Check provider health
  const healthResults = await customLogger.healthCheck();

  console.log('Logger health check results:');
  Object.entries(healthResults).forEach(([providerName, healthy]) => {
    const status = healthy ? '✅ Healthy' : '❌ Unhealthy';
    console.log(`  ${providerName}: ${status}`);
  });
}

/**
 * Example 8: Application initialization and shutdown
 */
export async function applicationLifecycleExample(): Promise<void> {
  console.log('\n=== Application Lifecycle Example ===');

  // Initialize logging system during app startup
  await initializeLogging({
    level: 'info',
    enableTelemetry: false, // Privacy-first by default
    environment: 'development',
  });

  logger.info('Application logging initialized');

  // Simulate some application work
  logger.info('Application is running...');
  logger.debug('Some debug information');

  // Graceful shutdown
  logger.info('Application shutting down...');
  await shutdownLogging();

  console.log('Logging system shutdown complete');
}

/**
 * Example 9: Error handling and resilience
 */
export function errorHandlingExample(): void {
  console.log('\n=== Error Handling Example ===');

  // Even if providers fail, logging shouldn't crash the app
  const resilientLogger = createLogger();

  // Add a provider that might fail
  const flakyProvider = {
    name: 'flaky',
    isEnabled: true,
    async log(): Promise<void> {
      // Simulate provider failure
      throw new Error('Provider temporarily unavailable');
    },
    async healthCheck(): Promise<boolean> {
      return false;
    },
  };

  resilientLogger.addProvider(flakyProvider);

  // This should still work despite the provider failure
  resilientLogger.info('This message should still be logged to fallback console');
  resilientLogger.error('Error logging should be resilient', new Error('Sample error'));
}

/**
 * Example 10: Privacy-safe file path logging
 */
export function privacyExample(): void {
  console.log('\n=== Privacy-Safe Logging Example ===');

  const privacyLogger = createLogger({
    privacy: {
      enableTelemetry: false,
      consent: { sentry: false, analytics: false },
      sanitization: {
        sanitizeFilePaths: true,
        sanitizeUserData: true,
        sanitizeSystemInfo: true,
      },
    },
  });

  const consoleProvider = new ConsoleLogProvider({ enabled: true });
  privacyLogger.addProvider(consoleProvider);

  // These would be sanitized when sent to external providers
  privacyLogger.info('Processing file', {
    filePath: '/home/john/sensitive-documents/secret.pdf',
    userEmail: 'john@example.com',
    hostname: 'johns-macbook',
  });

  privacyLogger.warn('Failed to access directory', {
    path: '/Users/john/Desktop/private-stuff',
    reason: 'Permission denied',
  });
}

/**
 * Run all examples
 */
export async function runAllExamples(): Promise<void> {
  console.log('🚀 Archifiltre Logging System Examples\n');
  console.log('This demonstrates the privacy-respecting, provider-based logging system.\n');

  try {
    basicLoggingExample();
    cliLoggingExample();
    childLoggerExample();
    customLoggerExample();
    errorTrackingLoggerExample();
    testLoggerExample();
    await healthCheckExample();
    errorHandlingExample();
    privacyExample();
    await applicationLifecycleExample();

    console.log('\n✅ All logging examples completed successfully!');
    console.log('\nKey features demonstrated:');
    console.log('  • Privacy-first design with user consent requirements');
    console.log('  • Multiple log levels and structured logging');
    console.log('  • Provider-based architecture for flexible output');
    console.log('  • Child loggers with contextual information');
    console.log('  • Error resilience and graceful degradation');
    console.log('  • Data sanitization for external services');
    console.log('  • Test-friendly design with log capture');
    console.log('  • Health monitoring and diagnostics');
    console.log('  • Sentry integration for error tracking (with consent)');
    console.log('  • Separate analytics system for PostHog/user behavior');
  } catch (error) {
    console.error('❌ Error running examples:', error);
  }
}

// Functions are already exported inline above

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples().catch(console.error);
}
