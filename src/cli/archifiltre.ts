#!/usr/bin/env bun
/**
 * Archifiltre CLI Entry Point
 *
 * This is the main entry point for the Archifiltre CLI application.
 * It gets compiled into a single binary using `bun build --compile`.
 */

import { executeCommand } from './commands-registry.js';

/**
 * Main CLI entry point
 */
async function main(): Promise<never> {
  try {
    // Get command line arguments (skip 'bun' and script name)
    const args = process.argv.slice(2);

    // Execute the command through our registry
    const result = await executeCommand(args);

    // Output results
    if (result.output) {
      console.log(result.output);
    }

    if (result.error) {
      console.error(result.error);
    }

    // Exit with the appropriate code
    process.exit(result.exitCode);
  } catch (error) {
    // Fallback error handling for unexpected errors
    console.error('Fatal error:', error instanceof Error ? error.message : 'Unknown error');

    // Always exit with system error code for unexpected errors
    process.exit(1);
  }
}

/**
 * Handle uncaught exceptions and unhandled promise rejections
 */
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught exception:', error.message);
  console.error('This is likely a bug. Please report it with --verbose output.');
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  console.error('Unhandled promise rejection:', reason);
  console.error('This is likely a bug. Please report it with --verbose output.');
  process.exit(1);
});

/**
 * Handle process termination signals gracefully
 */
process.on('SIGINT', () => {
  console.error('\nReceived SIGINT. Exiting gracefully...');
  process.exit(130); // Standard exit code for SIGINT
});

process.on('SIGTERM', () => {
  console.error('\nReceived SIGTERM. Exiting gracefully...');
  process.exit(143); // Standard exit code for SIGTERM
});

// Start the application
main();
