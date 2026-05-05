/**
 * Oclif Commands Registry (Explicit Strategy)
 *
 * This file exports all commands explicitly to enable Oclif bundling compatibility.
 * Required for Bun compilation and other bundlers that can't rely on runtime file discovery.
 *
 * Commands are registered from two sources:
 * 1. Core commands - always available (version, health, scan, etc.)
 * 2. Extension commands - auto-discovered from extensions that declare COMMAND
 *
 * See: https://oclif.io/docs/command_discovery_strategies#explicit-strategy
 */

import Version from './version.ts';
import Health from './health.ts';
import Sbom from './sbom.ts';
import Scan from './scan.ts';
import ExposeDb from './expose-db.ts';
import Logs from './logs.ts';
import Query from './query.ts';

// Import extension-declared commands
import { EXTENSION_COMMANDS } from '@extensions/index.ts';

/**
 * Core commands - always available
 */
const CORE_COMMANDS = {
  version: Version,
  health: Health,
  sbom: Sbom,
  scan: Scan,
  'expose-db': ExposeDb,
  logs: Logs,
  query: Query,
} as const;

/**
 * Merged command registry: core + extension-declared commands
 * Maps command names to their respective Command classes
 */
export const COMMANDS = {
  ...CORE_COMMANDS,
  ...EXTENSION_COMMANDS,
} as const;

/**
 * Export individual commands for direct access if needed
 */
export { Version, Health, Sbom, Scan, ExposeDb, Logs, Query };
