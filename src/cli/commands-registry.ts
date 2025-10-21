/**
 * CLI Commands Registry
 * Maps CLI commands and flags to internal API calls
 */

import {
  api,
  formatters,
  errors,
  type ArchifiltreError,
  type VersionInfo,
  type HealthReport,
} from '@api/index.js';

/**
 * Parsed command line arguments
 */
export interface ParsedArgs {
  command?: string;
  subcommand?: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  rawArgs: string[];
}

/**
 * Command execution context
 */
export interface CommandContext {
  args: ParsedArgs;
  verbose: boolean;
  noColor: boolean;
  logFormat: 'text' | 'json';
}

/**
 * Command execution result
 */
export interface CommandResult {
  exitCode: number;
  output?: string;
  error?: string;
}

/**
 * Color formatting utilities
 */
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

/**
 * Applies color formatting if colors are enabled
 */
function colorize(text: string, color: keyof typeof colors, noColor: boolean): string {
  if (noColor || process.env.CI === 'true' || process.env.NO_COLOR === '1') {
    return text;
  }
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Parses command line arguments into structured format
 */
export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    flags: {},
    positional: [],
    rawArgs: [...args],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      // Long flag
      const flagName = arg.substring(2);

      if (flagName.includes('=')) {
        // --flag=value format
        const [name, value] = flagName.split('=', 2);
        parsed.flags[name] = value;
      } else {
        // Check if next arg is a value
        const nextArg = args[i + 1];
        if (nextArg && !nextArg.startsWith('-')) {
          // Boolean flags that don't take values
          if (['help', 'version', 'verbose', 'no-color'].includes(flagName)) {
            parsed.flags[flagName] = true;
          } else {
            parsed.flags[flagName] = nextArg;
            i++; // Skip next arg since we consumed it
          }
        } else {
          parsed.flags[flagName] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      // Short flag(s) - handle combined flags like -Vv
      const shortFlags = arg.substring(1);

      // Process each character as a separate flag
      for (const shortFlag of shortFlags) {
        switch (shortFlag) {
          case 'h':
            parsed.flags['help'] = true;
            break;
          case 'v':
            parsed.flags['version'] = true;
            break;
          case 'V':
            parsed.flags['verbose'] = true;
            break;
          default:
            throw new errors.UserInputError(
              'INVALID_FLAG',
              `Unknown short flag '-${shortFlag}'`,
              'Use long flags only (--help, --version, etc.)'
            );
        }
      }
    } else {
      // Positional argument
      if (!parsed.command) {
        parsed.command = arg;
      } else if (!parsed.subcommand) {
        parsed.subcommand = arg;
      } else {
        parsed.positional.push(arg);
      }
    }
    i++;
  }

  return parsed;
}

/**
 * Creates command execution context from parsed arguments
 */
export function createContext(args: ParsedArgs): CommandContext {
  return {
    args,
    verbose: Boolean(args.flags.verbose),
    noColor: Boolean(args.flags['no-color']) || process.env.NO_COLOR === '1',
    logFormat: args.flags['log-format'] === 'json' ? 'json' : 'text',
  };
}

/**
 * Generates help text for the CLI
 */
function generateHelpText(ctx: CommandContext): string {
  const { noColor } = ctx;

  const title = colorize('Archifiltre v5', 'bold', noColor);
  const subtitle = colorize(
    'Privacy-friendly, 100% offline file tree inventory tool',
    'gray',
    noColor
  );

  return `${title}
${subtitle}

${colorize('USAGE:', 'bold', noColor)}
  archifiltre [OPTIONS] [COMMAND]

${colorize('COMMANDS:', 'bold', noColor)}
  health                    Check system health and requirements
  version                   Show version information
  help                      Show this help message

${colorize('OPTIONS:', 'bold', noColor)}
  --help, -h               Show help for command
  --version, -v            Show version information
  --verbose, -V            Enable verbose output
  --no-color               Disable colored output
  --log-format json        Output structured JSON logs

${colorize('EXAMPLES:', 'bold', noColor)}
  archifiltre --help                    Show this help
  archifiltre --version                 Show version info
  archifiltre health                    Check system health
  archifiltre --verbose health          Detailed health check
  archifiltre --log-format json health  Health check as JSON

${colorize('EXIT CODES:', 'bold', noColor)}
  0    Success
  1    System error (file I/O, permissions, etc.)
  2    Usage error (invalid flags, arguments, etc.)

For more information, visit: https://github.com/ProgrammeVitam/archifiltre`;
}

/**
 * Executes the version command
 */
async function executeVersion(ctx: CommandContext): Promise<CommandResult> {
  try {
    const versionInfo: VersionInfo = api.version();

    if (ctx.logFormat === 'json') {
      return {
        exitCode: 0,
        output: JSON.stringify(versionInfo, null, 2),
      };
    }

    const formattedVersion = formatters.versionString();
    return {
      exitCode: 0,
      output: formattedVersion,
    };
  } catch (error) {
    const archError =
      error instanceof Error ? errors.wrapUnknownError(error) : errors.wrapUnknownError(error);
    return {
      exitCode: errors.getExitCode(archError),
      error: errors.formatError(archError, ctx.verbose),
    };
  }
}

/**
 * Executes the health command
 */
async function executeHealth(ctx: CommandContext): Promise<CommandResult> {
  try {
    const healthReport: HealthReport = await api.health();

    if (ctx.logFormat === 'json') {
      return {
        exitCode: healthReport.ok ? 0 : 1,
        output: JSON.stringify(healthReport, null, 2),
      };
    }

    const formattedHealth = formatters.health(healthReport);
    const colorizedHealth = healthReport.ok
      ? colorize(formattedHealth, 'green', ctx.noColor)
      : colorize(formattedHealth, 'red', ctx.noColor);

    return {
      exitCode: healthReport.ok ? 0 : 1,
      output: colorizedHealth,
    };
  } catch (error) {
    const archError =
      error instanceof Error ? errors.wrapUnknownError(error) : errors.wrapUnknownError(error);
    return {
      exitCode: errors.getExitCode(archError),
      error: errors.formatError(archError, ctx.verbose),
    };
  }
}

/**
 * Executes the help command
 */
async function executeHelp(ctx: CommandContext): Promise<CommandResult> {
  return {
    exitCode: 0,
    output: generateHelpText(ctx),
  };
}

/**
 * Main command registry and executor
 */
export async function executeCommand(args: string[]): Promise<CommandResult> {
  try {
    const parsed = parseArgs(args);
    const ctx = createContext(parsed);

    // Handle global flags first
    if (parsed.flags.version) {
      return await executeVersion(ctx);
    }

    if (parsed.flags.help || parsed.command === 'help') {
      return await executeHelp(ctx);
    }

    // Handle commands
    switch (parsed.command) {
      case undefined:
        // No command provided - show help
        return await executeHelp(ctx);

      case 'version':
        return await executeVersion(ctx);

      case 'health':
        return await executeHealth(ctx);

      default:
        throw new errors.UserInputError(
          'INVALID_ARGUMENT',
          `Unknown command '${parsed.command}'`,
          'Run --help to see available commands'
        );
    }
  } catch (error) {
    // Handle parsing and execution errors
    if (
      error instanceof errors.UserInputError ||
      error instanceof errors.SystemError ||
      error instanceof errors.ConflictError
    ) {
      const archError = error as ArchifiltreError;
      return {
        exitCode: errors.getExitCode(archError),
        error: errors.formatError(archError, false), // Don't show verbose for parsing errors
      };
    }

    // Handle unexpected errors
    const wrappedError = errors.wrapUnknownError(error);
    return {
      exitCode: errors.getExitCode(wrappedError),
      error: errors.formatError(wrappedError, false),
    };
  }
}

/**
 * Validates that required arguments are present for a command
 */
export function validateCommand(command: string, _args: ParsedArgs): void {
  switch (command) {
    case 'health':
    case 'version':
    case 'help':
      // These commands don't require additional arguments
      break;

    default:
      // Future commands can add their validation here
      break;
  }
}
