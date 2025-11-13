#!/usr/bin/env bun
/**
 * Archifiltre Main Entry Point
 *
 * Main CLI application entry point with embedded configuration
 * for standalone execution and command orchestration.
 */

import { Config, run } from '@oclif/core';
import { initializeLogging, logger, shutdownLogging } from '@lib/logging.ts';

// Inline package.json configuration for bundled environment
const INLINE_PACKAGE_CONFIG = {
  name: 'archifiltre',
  version: '5.0.0-dev',
  description: 'Privacy-friendly, 100% offline desktop tool for inventorying large file trees',
  author: {
    name: 'République française – Ministère de la Culture (SNUM) / CIAF / DINUM',
    email: 'archifiltre@programmevitam.fr',
    url: 'https://archifiltre.fabrique.social.gouv.fr',
  },
  license: 'CECILL-2.1',
  homepage: 'https://archifiltre.fabrique.social.gouv.fr',
  bin: {
    archifiltre: './bin/run.js',
  },
  oclif: {
    bin: 'archifiltre',
    dirname: 'archifiltre',
    commands: {
      strategy: 'explicit' as const,
      target: './src/commands/index.js',
      identifier: 'COMMANDS',
    },
    helpClass: './src/lib/help.js',
    plugins: [],
    topicSeparator: ' ',
    additionalHelpFlags: ['-h'],
    additionalVersionFlags: ['-v'],
  },
};

/**
 * Create bundle-compatible Oclif configuration
 */
async function createBundleConfig() {
  try {
    const config = new Config({
      root: process.cwd(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pjson: INLINE_PACKAGE_CONFIG as any,
    });

    await config.load();
    return config;
  } catch (error) {
    throw new Error(
      `Failed to create bundle config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Main entry point for bundled CLI
 */
async function main() {
  try {
    // Initialize simple logging system for CLI
    await initializeLogging({
      level: process.argv.includes('--verbose') || process.argv.includes('-v') ? 'debug' : 'info',
      enableConsoleLogging: false, // CLI uses Oclif integration
      enableFileLogging: true,
    });

    // Create bundle-compatible config
    const config = await createBundleConfig();

    // Run Oclif with our custom config
    await run(process.argv.slice(2), config);
  } catch (error) {
    // Handle Oclif errors gracefully
    if (error && typeof error === 'object' && 'oclif' in error) {
      const oclifError = error as { oclif?: { exit?: number } };

      if (error instanceof Error && error.message) {
        logger.error('CLI command error', error, { context: 'oclif_error' });
      }

      process.exit(oclifError.oclif?.exit ?? 1);
    }

    // Handle other errors
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('CLI execution failed', error instanceof Error ? error : new Error(message), {
      context: 'main_entry',
      verbose: process.argv.includes('--verbose') || process.argv.includes('-V'),
    });

    process.exit(1);
  }
}

/**
 * Handle uncaught exceptions gracefully
 */
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception in CLI', error, { context: 'process_exception' });
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled promise rejection in CLI', error, { context: 'promise_rejection' });
  process.exit(1);
});

/**
 * Handle process termination signals gracefully
 */
process.on('SIGINT', async () => {
  logger.info('Received SIGINT - CLI shutting down gracefully', { signal: 'SIGINT' });
  await shutdownLogging();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM - CLI shutting down gracefully', { signal: 'SIGTERM' });
  await shutdownLogging();
  process.exit(143);
});

// Start the application
main();
