#!/usr/bin/env bun
/**
 * Bundle-Compatible Oclif Entry Point
 *
 * Creates inline package.json configuration and command mapping
 * for standalone CLI execution without filesystem dependencies.
 */

import { Config, run } from '@oclif/core';

// Inline package.json configuration for bundled environment
const INLINE_PACKAGE_CONFIG = {
  name: 'archifiltre',
  version: '5.0.0-dev',
  description: 'Privacy-friendly, 100% offline desktop tool for inventorying large file trees',
  bin: {
    archifiltre: './bin/run.js',
  },
  oclif: {
    bin: 'archifiltre',
    dirname: 'archifiltre',
    commands: {
      strategy: 'explicit' as const,
      target: './src/commands.js',
      identifier: 'COMMANDS',
    },
    helpClass: './src/cli/help.js',
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
    console.error('Failed to create bundle config:', error);
    process.exit(1);
  }
}

/**
 * Main entry point for bundled CLI
 */
async function main() {
  try {
    // Create bundle-compatible config
    const config = await createBundleConfig();

    // Run Oclif with our custom config
    await run(process.argv.slice(2), config);
  } catch (error) {
    // Handle Oclif errors gracefully
    if (error && typeof error === 'object' && 'oclif' in error) {
      const oclifError = error as { oclif?: { exit?: number } };

      if (error instanceof Error && error.message) {
        console.error(`›   Error: ${error.message}`);
      }

      process.exit(oclifError.oclif?.exit ?? 1);
    }

    // Handle other errors
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('CLI Error:', message);

    // Show stack trace in verbose mode
    if (process.argv.includes('--verbose') || process.argv.includes('-V')) {
      if (error instanceof Error && error.stack) {
        console.error('\nStack Trace:');
        console.error(error.stack);
      }
    }

    process.exit(1);
  }
}

/**
 * Handle uncaught exceptions gracefully
 */
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

/**
 * Handle process termination signals gracefully
 */
process.on('SIGINT', () => {
  process.stderr.write('\nReceived SIGINT. Exiting gracefully...\n');
  process.exit(130);
});

process.on('SIGTERM', () => {
  process.stderr.write('\nReceived SIGTERM. Exiting gracefully...\n');
  process.exit(143);
});

// Start the application
main();
