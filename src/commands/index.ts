/**
 * Oclif Commands Registry (Explicit Strategy)
 *
 * This file exports all commands explicitly to enable Oclif bundling compatibility.
 * Required for Bun compilation and other bundlers that can't rely on runtime file discovery.
 *
 * See: https://oclif.io/docs/command_discovery_strategies#explicit-strategy
 */

import Version from './version.ts';
import Health from './health.ts';
import Sbom from './sbom.ts';
import Scan from './scan.ts';

/**
 * Explicit command registry for bundling
 * Maps command names to their respective Command classes
 */
export const COMMANDS = {
  version: Version,
  health: Health,
  sbom: Sbom,
  scan: Scan,
} as const;

/**
 * Export individual commands for direct access if needed
 */
export { Version, Health, Sbom, Scan };
