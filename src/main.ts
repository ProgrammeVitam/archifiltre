#!/usr/bin/env bun
/**
 * Standalone Archifiltre CLI
 *
 * Self-contained entry point that bypasses oclif's file-based command discovery
 * while maintaining compatibility with oclif Command classes.
 *
 * Commands are registered from two sources:
 * 1. Core commands - always available (version, health, scan, etc.)
 * 2. Extension commands - auto-discovered from extensions that declare COMMAND
 */

import { Command, Config, Interfaces } from '@oclif/core';
import { initializeLogging, logger, shutdownLogging } from '@lib/logging.ts';
import path from 'node:path';
import fs from 'node:fs';

// Import core commands directly
import Version from './commands/version.ts';
import Health from './commands/health.ts';
import Sbom from './commands/sbom.ts';
import Scan from './commands/scan.ts';
import ExposeDb from './commands/expose-db.ts';
import Logs from './commands/logs.ts';
import Query from './commands/query.ts';
import { getAppDataDir } from '@lib/platform-paths.ts';

// Import extension-declared commands
import { EXTENSION_COMMANDS } from '@extensions/index.ts';

// Core commands - always available
const CORE_COMMANDS: Record<string, typeof Command> = {
  version: Version,
  health: Health,
  sbom: Sbom,
  scan: Scan,
  'expose-db': ExposeDb,
  logs: Logs,
  query: Query,
};

// Merged command registry: core + extension-declared commands
const COMMANDS: Record<string, typeof Command> = {
  ...CORE_COMMANDS,
  ...EXTENSION_COMMANDS,
};

/**
 * Standalone Config for Compiled Executables
 *
 * IMPORTANT: This class solves a critical problem for bundled executables:
 * - PGlite (our database) extracts WebAssembly files to the current working directory
 * - When users run the binary from anywhere, those files would go to random locations
 * - We change the working directory to a platform-specific app data folder
 * - This ensures consistent, clean file organization across all platforms
 *
 * Side effect: User-provided relative paths need special handling (see commands)
 */
class StandaloneConfig extends Config {
  /**
   * Original working directory where the user ran the binary.
   * Commands use this to resolve user-provided relative paths correctly.
   */
  public readonly originalCwd: string;

  constructor() {
    // STEP 1: Capture where the user actually ran the binary
    // (before we change directories for internal file management)
    const originalCwd = process.cwd();

    // STEP 2: Determine platform-specific app data directory
    // Linux: ~/.local/share/archifiltre/
    // macOS: ~/Library/Application Support/archifiltre/
    // Windows: %LOCALAPPDATA%\archifiltre\
    const appDataDir = getAppDataDir();

    // STEP 3: Ensure the app data directory exists
    if (!fs.existsSync(appDataDir)) {
      fs.mkdirSync(appDataDir, { recursive: true });
    }

    // STEP 4: Change working directory to app data directory
    // This is the KEY SOLUTION: All runtime files now go to the right place:
    // - PGlite WebAssembly files → ~/.local/share/archifiltre/pglite/
    // - Temp files → ~/.local/share/archifiltre/temp/
    // - Log files → ~/.local/share/archifiltre/logs/
    // - Database files → ~/.local/share/archifiltre/databases/
    process.chdir(appDataDir);

    // STEP 5: Initialize parent class with app data directory as root
    super({ root: appDataDir });

    // STEP 6: Store original directory for commands to use
    // (TypeScript requires this assignment AFTER super() call)
    this.originalCwd = originalCwd;

    const dataPath = path.join(appDataDir, '.archifiltre');

    // Configure oclif paths to use our app data directory structure
    Object.defineProperty(this, 'name', { value: 'archifiltre', writable: false });
    Object.defineProperty(this, 'version', { value: '5.0.0-dev', writable: false });
    Object.defineProperty(this, 'bin', { value: 'archifiltre', writable: false });
    Object.defineProperty(this, 'root', { value: appDataDir, writable: false });
    Object.defineProperty(this, 'dataDir', { value: dataPath, writable: false });
    Object.defineProperty(this, 'configDir', { value: dataPath, writable: false });
    Object.defineProperty(this, 'cacheDir', {
      value: path.join(dataPath, 'cache'),
      writable: false,
    });
    Object.defineProperty(this, 'errlog', {
      value: path.join(dataPath, 'error.log'),
      writable: false,
    });

    // Set package.json data without reading from disk
    Object.defineProperty(this, 'pjson', {
      value: {
        name: 'archifiltre',
        version: '5.0.0-dev',
        description:
          'Privacy-friendly, 100% offline desktop tool for inventorying large file trees',
        oclif: {
          bin: 'archifiltre',
          topicSeparator: ' ',
        },
      },
      writable: false,
    });

    Object.defineProperty(this, 'plugins', { value: new Map(), writable: false });
    Object.defineProperty(this, 'commands', { value: [], writable: false });
    Object.defineProperty(this, 'topics', { value: [], writable: false });
    Object.defineProperty(this, 'commandIDs', { value: Object.keys(COMMANDS), writable: false });
  }

  async load(): Promise<void> {
    return;
  }

  async runHook<T extends keyof Interfaces.Hooks>(
    event: T,
    opts: Interfaces.Hooks[T]['options']
  ): Promise<Interfaces.Hooks[T]['return']> {
    return {} as Interfaces.Hooks[T]['return'];
  }

  findCommand(id: string, opts: { must: true }): Command.Loadable;
  findCommand(id: string, opts?: { must: boolean }): Command.Loadable | undefined;
  findCommand(id: string, opts?: { must: boolean }): Command.Loadable | undefined {
    const CommandClass = COMMANDS[id];
    if (!CommandClass) {
      if (opts?.must) throw new Error(`Command ${id} not found`);
      return undefined;
    }

    return {
      id,
      load: async () => CommandClass as unknown as Command,
      description: CommandClass.description || '',
      aliases: [],
      hidden: false,
      usage: CommandClass.usage,
      examples: CommandClass.examples || [],
    } as unknown as Command.Loadable;
  }
}

/**
 * Display help information
 */
function showHelp(commandName?: string) {
  if (commandName) {
    const CommandClass = COMMANDS[commandName];
    if (!CommandClass) {
      console.error(`Command '${commandName}' not found\n`);
      showHelp();
      return;
    }

    console.log(`${CommandClass.description || commandName}\n`);
    console.log(`USAGE`);
    console.log(`  $ archifiltre ${commandName} ${CommandClass.usage || '[OPTIONS]'}\n`);

    if (CommandClass.args && Object.keys(CommandClass.args).length > 0) {
      console.log('ARGUMENTS');
      for (const [name, arg] of Object.entries(CommandClass.args)) {
        const argDef = arg as any;
        const required = argDef.required ? ' (required)' : '';
        console.log(`  ${name}${required}  ${argDef.description || ''}`);
      }
      console.log();
    }

    if (CommandClass.flags && Object.keys(CommandClass.flags).length > 0) {
      console.log('FLAGS');
      for (const [name, flag] of Object.entries(CommandClass.flags)) {
        const flagDef = flag as any;
        const char = flagDef.char ? `-${flagDef.char}, ` : '    ';
        const defaultVal = flagDef.default !== undefined ? ` [default: ${flagDef.default}]` : '';
        console.log(`  ${char}--${name}  ${flagDef.description || ''}${defaultVal}`);
      }
      console.log();
    }

    const examples = (CommandClass as unknown as typeof Command).examples;
    if (examples && examples.length > 0) {
      console.log('EXAMPLES');
      for (const example of examples) {
        const raw = typeof example === 'string' ? example : example.command;
        const formatted = raw
          .replace(/<%= config.bin %>/g, 'archifiltre')
          .replace(/<%= command.id %>/g, commandName);
        console.log(`  $ ${formatted}`);
      }
    }
  } else {
    console.log(`Archifiltre v5.0.0-dev
Privacy-friendly, 100% offline file tree inventory tool

USAGE
  $ archifiltre COMMAND [OPTIONS]

COMMANDS`);

    const maxLength = Math.max(...Object.keys(COMMANDS).map(cmd => cmd.length));
    for (const [name, CommandClass] of Object.entries(COMMANDS)) {
      const padding = ' '.repeat(maxLength - name.length + 4);
      console.log(`  ${name}${padding}${CommandClass.description || ''}`);
    }

    console.log(`
GLOBAL FLAGS
  --help, -h        Show help
  --version, -v     Show version
  --verbose, -V     Enable verbose output
  --no-color        Disable colored output

For more information, visit: https://github.com/ProgrammeVitam/archifiltre`);
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(argv: string[]) {
  const globalFlags: Record<string, any> = {};
  const args: string[] = [];
  let command: string | undefined;
  let isHelp = false;
  let isVersion = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      isHelp = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      isVersion = true;
      continue;
    }

    if (arg === '--verbose' || arg === '-V') {
      globalFlags.verbose = true;
      args.push(arg);
      continue;
    }

    if (arg === '--no-color') {
      globalFlags.noColor = true;
      process.env.NO_COLOR = '1';
      args.push(arg);
      continue;
    }

    if (!arg.startsWith('-') && !command) {
      command = arg;
    } else {
      args.push(arg);
    }
  }

  return { command, args, globalFlags, isHelp, isVersion };
}

/**
 * Main entry point
 */
async function main() {
  try {
    const { command, args, globalFlags, isHelp, isVersion } = parseArgs(process.argv.slice(2));

    // Initialize logging
    await initializeLogging(
      {
        level: globalFlags.verbose ? 'debug' : 'info',
        enableConsoleLogging: false,
        enableFileLogging: true,
      },
      command
    );

    const config = new StandaloneConfig();

    // Handle version flag
    if (isVersion && !command) {
      const versionCmd = new (Version as unknown as new (argv: string[], config: Config) => Command)([], config);
      await versionCmd.run();
      return;
    }

    // Handle help
    if (isHelp || !command) {
      showHelp(command);
      return;
    }

    // Find and run command
    const CommandClass = COMMANDS[command];

    if (!CommandClass) {
      console.error(`Error: Command '${command}' not found\n`);
      showHelp();
      process.exit(1);
    }

    // Run the command
    const commandInstance = new (CommandClass as unknown as new (argv: string[], config: Config) => Command)(args, config);
    await commandInstance.run();
  } catch (error) {
    if (error && typeof error === 'object' && 'oclif' in error) {
      const oclifError = error as { oclif?: { exit?: number } };
      if (error instanceof Error && error.message) {
        logger.error('Command error', error);
        console.error(error.message);
      }
      process.exit(oclifError.oclif?.exit ?? 1);
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('CLI execution failed', error instanceof Error ? error : new Error(message));
    console.error(`Error: ${message}`);
    process.exit(1);
  } finally {
    await shutdownLogging();
  }
}

// Handle process termination signals
process.on('SIGINT', async () => {
  await shutdownLogging();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  await shutdownLogging();
  process.exit(143);
});

// Run the CLI
main();
