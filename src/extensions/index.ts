/**
 * Extension Registry
 *
 * Central registry for all extensions. Extensions can optionally declare commands
 * by exporting a COMMAND constant. This enables a plugin-like architecture where
 * adding a new feature only requires creating a single extension file.
 *
 * Extensions that declare commands:
 * - Export a COMMAND object with { name: string, command: typeof Command }
 * - The command will be auto-registered in the CLI
 *
 * Extensions without commands:
 * - Just export their functions for use by other commands
 * - Example: summary.ts is used by the scan command
 */

import type { Command } from '@oclif/core';

// === Extension Imports ===
// Import all extensions here. Extensions with commands will be auto-discovered.

import * as summary from './summary.ts';

// === Extension Registry ===

/**
 * List of all extension modules.
 * Add new extensions to this array - commands will be auto-discovered.
 */
const EXTENSIONS: Record<string, unknown>[] = [
  summary,
  // Future extensions go here:
  // csvExport,
  // jsonExport,
  // etc.
];

// === Command Discovery ===

/**
 * Expected shape of an extension's COMMAND export
 */
export interface ExtensionCommand {
  /** Command name as it appears in the CLI (e.g., 'export', 'analyze') */
  name: string;
  /** The oclif Command class */
  command: typeof Command;
}

/**
 * Type guard to check if an extension declares a command
 */
function hasCommand(ext: Record<string, unknown>): ext is { COMMAND: ExtensionCommand } {
  return (
    'COMMAND' in ext &&
    ext.COMMAND !== null &&
    typeof ext.COMMAND === 'object' &&
    'name' in (ext.COMMAND as object) &&
    'command' in (ext.COMMAND as object)
  );
}

/**
 * Auto-discovered commands from extensions.
 * Maps command name to Command class.
 *
 * @example
 * // In main.ts:
 * import { EXTENSION_COMMANDS } from '@extensions/index.ts';
 * const COMMANDS = { ...CORE_COMMANDS, ...EXTENSION_COMMANDS };
 */
export const EXTENSION_COMMANDS: Record<string, typeof Command> = Object.fromEntries(
  EXTENSIONS.filter(hasCommand).map(ext => [ext.COMMAND.name, ext.COMMAND.command])
);

/**
 * List of registered extension command names (for debugging/help)
 */
export const EXTENSION_COMMAND_NAMES: string[] = Object.keys(EXTENSION_COMMANDS);

// === Re-export Extension Functions ===
// Export individual extensions for direct use by other commands

export { summary };
