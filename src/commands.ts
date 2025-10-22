/**
 * Oclif Commands Registry (Explicit Strategy)
 *
 * This file exports all commands explicitly to enable Oclif bundling compatibility.
 * Required for Bun compilation and other bundlers that can't rely on runtime file discovery.
 *
 * See: https://oclif.io/docs/command_discovery_strategies#explicit-strategy
 */

import Version from './cli/commands/version.js';
import Health from './cli/commands/health.js';

/**
 * Explicit command registry for bundling
 * Maps command names to their respective Command classes
 */
export const COMMANDS = {
  version: Version,
  health: Health,
} as const;

/**
 * Export individual commands for direct access if needed
 */
export { Version, Health };
