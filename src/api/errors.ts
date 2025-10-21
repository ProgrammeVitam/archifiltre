/**
 * Typed error system for Archifiltre API
 * Maps errors to appropriate CLI exit codes
 */

export type ErrorCode =
  // User Input Errors (exit code 2)
  | 'INVALID_ARGUMENT'
  | 'MISSING_ARGUMENT'
  | 'INVALID_FLAG'
  | 'INVALID_PATH'
  | 'INVALID_FORMAT'

  // System Errors (exit code 1)
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'DISK_FULL'
  | 'MEMORY_ERROR'
  | 'IO_ERROR'
  | 'UNKNOWN_ERROR'

  // Conflict Errors (exit code 1)
  | 'RESOURCE_BUSY'
  | 'OPERATION_IN_PROGRESS'
  | 'STATE_CONFLICT';

/**
 * Base error interface
 */
export interface BaseError {
  /** Error type/category */
  type: string;
  /** Specific error code */
  code: ErrorCode;
  /** Human-readable error message */
  message: string;
  /** Optional hint for resolution */
  hint?: string;
  /** Optional context data */
  context?: Record<string, unknown>;
}

/**
 * User input validation errors (exit code 2)
 */
export class UserInputError extends Error implements BaseError {
  readonly type = 'USER_INPUT_ERROR';

  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'UserInputError';
  }

  static invalidArgument(argument: string, value?: unknown, hint?: string): UserInputError {
    const message = value
      ? `Invalid argument '${argument}': ${value}`
      : `Invalid argument '${argument}'`;

    return new UserInputError(
      'INVALID_ARGUMENT',
      message,
      hint || `Run with --help to see valid options`,
      { argument, value }
    );
  }

  static missingArgument(argument: string, hint?: string): UserInputError {
    return new UserInputError(
      'MISSING_ARGUMENT',
      `Missing required argument '${argument}'`,
      hint || `Run with --help to see required arguments`,
      { argument }
    );
  }

  static invalidFlag(flag: string, hint?: string): UserInputError {
    return new UserInputError(
      'INVALID_FLAG',
      `Unknown flag '${flag}'`,
      hint || `Run with --help to see available flags`,
      { flag }
    );
  }

  static invalidPath(path: string, reason?: string): UserInputError {
    const message = reason ? `Invalid path '${path}': ${reason}` : `Invalid path '${path}'`;

    return new UserInputError('INVALID_PATH', message, 'Ensure the path exists and is accessible', {
      path,
      reason,
    });
  }
}

/**
 * System-level errors (exit code 1)
 */
export class SystemError extends Error implements BaseError {
  readonly type = 'SYSTEM_ERROR';

  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SystemError';
  }

  static fileNotFound(path: string): SystemError {
    return new SystemError(
      'FILE_NOT_FOUND',
      `File not found: ${path}`,
      'Verify the file exists and you have read permissions',
      { path }
    );
  }

  static permissionDenied(path: string, operation?: string): SystemError {
    const opText = operation ? ` for ${operation}` : '';
    return new SystemError(
      'PERMISSION_DENIED',
      `Permission denied${opText}: ${path}`,
      'Check file permissions or run with appropriate privileges',
      { path, operation }
    );
  }

  static diskFull(path?: string): SystemError {
    const pathText = path ? ` (${path})` : '';
    return new SystemError(
      'DISK_FULL',
      `Insufficient disk space${pathText}`,
      'Free up disk space and try again',
      { path }
    );
  }

  static memoryError(operation?: string): SystemError {
    const opText = operation ? ` during ${operation}` : '';
    return new SystemError(
      'MEMORY_ERROR',
      `Out of memory${opText}`,
      'Try processing smaller datasets or increase available memory',
      { operation }
    );
  }

  static ioError(message: string, path?: string): SystemError {
    return new SystemError(
      'IO_ERROR',
      `I/O error: ${message}`,
      'Check file system health and permissions',
      { path, originalMessage: message }
    );
  }

  static unknown(originalError: Error): SystemError {
    return new SystemError(
      'UNKNOWN_ERROR',
      `Unexpected error: ${originalError.message}`,
      'This may be a bug. Please report it with --verbose output',
      {
        originalName: originalError.name,
        originalStack: originalError.stack,
      }
    );
  }
}

/**
 * Resource conflict errors (exit code 1)
 */
export class ConflictError extends Error implements BaseError {
  readonly type = 'CONFLICT_ERROR';

  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ConflictError';
  }

  static resourceBusy(resource: string): ConflictError {
    return new ConflictError(
      'RESOURCE_BUSY',
      `Resource is busy: ${resource}`,
      'Wait for the current operation to complete or cancel it',
      { resource }
    );
  }

  static operationInProgress(operation: string): ConflictError {
    return new ConflictError(
      'OPERATION_IN_PROGRESS',
      `Operation already in progress: ${operation}`,
      'Wait for the current operation to complete or use --force to override',
      { operation }
    );
  }
}

/**
 * Union type for all possible errors
 */
export type ArchifiltreError = UserInputError | SystemError | ConflictError;

/**
 * Maps errors to CLI exit codes
 */
export function getExitCode(error: ArchifiltreError): number {
  if (error instanceof UserInputError) {
    return 2; // Usage error
  }
  if (error instanceof SystemError || error instanceof ConflictError) {
    return 1; // System error
  }
  return 1; // Default to system error for unknown types
}

/**
 * Maps error codes to exit codes
 */
export function getExitCodeFromErrorCode(code: ErrorCode): number {
  const userInputCodes: ErrorCode[] = [
    'INVALID_ARGUMENT',
    'MISSING_ARGUMENT',
    'INVALID_FLAG',
    'INVALID_PATH',
    'INVALID_FORMAT',
  ];

  return userInputCodes.includes(code) ? 2 : 1;
}

/**
 * Formats error for display
 */
export function formatError(error: ArchifiltreError, verbose = false): string {
  let output = error.message;

  if (error.hint) {
    output += `\nHint: ${error.hint}`;
  }

  if (verbose) {
    output += `\nError Type: ${error.type}`;
    output += `\nError Code: ${error.code}`;

    if (error.context && Object.keys(error.context).length > 0) {
      output += `\nContext: ${JSON.stringify(error.context, null, 2)}`;
    }

    if (error.stack) {
      output += `\nStack Trace:\n${error.stack}`;
    }
  }

  return output;
}

/**
 * Wraps unknown errors in SystemError
 */
export function wrapUnknownError(error: unknown): SystemError {
  if (error instanceof Error) {
    return SystemError.unknown(error);
  }

  const message = typeof error === 'string' ? error : 'Unknown error occurred';
  return new SystemError(
    'UNKNOWN_ERROR',
    message,
    'This may be a bug. Please report it with --verbose output'
  );
}
