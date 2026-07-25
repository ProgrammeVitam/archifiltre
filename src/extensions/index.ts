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
import { registerProvider, type AiProvider } from '@extensions/ai-describe/ai-api.ts';

// === Extension Types ===

/**
 * Manifest exported by every extension.
 * Command extensions also set `command`; schema-owning extensions set `schema`.
 */
export interface Extension {
  id: string;
  name: string;
  description: string;
  version: string;
  schema?: unknown[];
  command?: typeof Command;
}

// === Extension Imports ===
// Import all extensions here. Extensions with commands will be auto-discovered.

import * as summary from './summary.ts';
import * as csvExport from './csv-export.ts';
import * as checksum from './checksum/index.ts';
import * as aiDescribe from './ai-describe/index.ts';
import * as fileThumbnails from './file-thumbnails/index.ts';
import * as enrichment from './enrichment/index.ts';

// === Extension Registry ===

/**
 * List of all extension modules.
 * Add new extensions to this array - commands will be auto-discovered.
 */
const EXTENSIONS: Record<string, unknown>[] = [
  summary,
  csvExport,
  checksum,
  aiDescribe,
  fileThumbnails,
  enrichment,
  // Future extensions go here:
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

// === Manifest Discovery ===

function hasManifest(ext: Record<string, unknown>): ext is { MANIFEST: Extension } {
  return (
    'MANIFEST' in ext &&
    ext.MANIFEST !== null &&
    typeof ext.MANIFEST === 'object' &&
    'id' in (ext.MANIFEST as object)
  );
}

/**
 * All registered extension manifests, in registry order.
 */
export const EXTENSION_MANIFESTS: Extension[] = EXTENSIONS.filter(hasManifest).map(
  ext => ext.MANIFEST
);

// === AI Provider Discovery ===
// An extension provides AI agents (an on-device model, a remote endpoint, an OCR/whisper engine,
// ...) by exporting `AI_PROVIDERS: AiProvider[]`. Contract and per-kind concurrency:
// src/extensions/ai-describe/ai-api.ts.

function hasAiProviders(ext: Record<string, unknown>): ext is { AI_PROVIDERS: AiProvider[] } {
  return 'AI_PROVIDERS' in ext && Array.isArray((ext as { AI_PROVIDERS?: unknown }).AI_PROVIDERS);
}

/**
 * Register every extension-provided AI provider into the AI API. Call ONCE at sidecar startup, in
 * the process that runs callAI (the owner). The built-in internal/external providers self-register
 * in ai-api.ts at import; this adds the extension ones. Idempotent (re-registering overwrites).
 */
export function registerExtensionAiProviders(): void {
  for (const ext of EXTENSIONS) {
    if (hasAiProviders(ext)) {
      for (const p of ext.AI_PROVIDERS) registerProvider(p);
    }
  }
}

// === Re-export Extension Functions ===
// Export individual extensions for direct use by other commands

export { summary, csvExport, checksum, aiDescribe, fileThumbnails, enrichment };
