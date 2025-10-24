/**
 * Archifiltre Internal API
 *
 * This is the public API surface for Archifiltre's internal (in-process) API.
 * All CLI commands and future UI components should interact through this API.
 *
 * Design principles:
 * - In-process only (no HTTP, no network)
 * - JSON-safe DTOs (dates as ISO strings)
 * - Typed errors with CLI exit code mapping
 * - Modular commands and queries
 */

// === Data Transfer Objects ===
export type {
  VersionInfo,
  HealthReport,
  CommandResult,
  StatusInfo,
  SystemInfo,
  LogEntry,
} from './dto.js';

// === Error System ===
export {
  UserInputError,
  SystemError,
  ConflictError,
  getExitCode,
  getExitCodeFromErrorCode,
  formatError,
  wrapUnknownError,
} from './errors.js';

export type { ArchifiltreError, BaseError, ErrorCode } from './errors.js';

// === Commands ===
export { version, formatVersionString, getFormattedVersion } from './commands/version.js';

export { health, formatHealthReport } from './commands/health.js';

// === Queries ===
export {
  getStatus,
  updateStatus,
  resetStatus,
  formatStatusInfo,
  isOperationActive,
  getStatusSummary,
} from './queries/get-status.js';

// Import functions for re-export
import { version } from './commands/version.js';
import { health } from './commands/health.js';
import {
  getStatus,
  updateStatus,
  resetStatus,
  isOperationActive,
  getStatusSummary,
} from './queries/get-status.js';

// Import formatters
import { formatVersionString, getFormattedVersion } from './commands/version.js';
import { formatHealthReport } from './commands/health.js';
import { formatStatusInfo } from './queries/get-status.js';
import { formatError } from './errors.js';

// Import error classes
import {
  UserInputError,
  SystemError,
  ConflictError,
  getExitCode,
  wrapUnknownError,
} from './errors.js';

// === Logging Infrastructure ===
export {
  // Core logging types and interfaces
  type ILogger,
  type LogLevel,
  type LogFormat,
  type LogContext,
  type LoggingConfig,
  type PrivacyConfig,

  // Logger instances and factories
  logger,
  createLogger,
  createPrivacyFirstLogger,
  createCLILogger,
  createTelemetryLogger,

  // Provider management
  type LogProvider,
  ConsoleLogProvider,
  SentryLogProvider,

  // Sanitization utilities (TODO: Re-enable once implemented)
  // sanitizeForCLI,
  // sanitizeForExternal,
  // containsSensitiveData,

  // System management
  initializeLogging,
  shutdownLogging,
} from '@infra/logging';

// === API Contract ===
/**
 * Core API functions that CLI commands should use
 */
export const api = {
  // Version information
  version,

  // Health checks
  health,

  // Status queries
  getStatus,
  getStatusSummary,

  // Status management (for future long-running operations)
  updateStatus,
  resetStatus,
  isOperationActive,
} as const;

/**
 * Formatting utilities for CLI output
 */
export const formatters = {
  version: formatVersionString,
  versionString: getFormattedVersion,
  health: formatHealthReport,
  status: formatStatusInfo,
  error: formatError,
} as const;

/**
 * Error factory utilities
 */
export const errors = {
  UserInputError,
  SystemError,
  ConflictError,
  getExitCode,
  formatError,
  wrapUnknownError,
} as const;
