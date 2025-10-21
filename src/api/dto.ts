/**
 * Data Transfer Objects (DTOs) for the Archifiltre API
 * All DTOs are JSON-safe with dates as ISO strings
 */

/**
 * Version information for the application
 */
export interface VersionInfo {
  /** Application version (e.g., "5.0.0") */
  appVersion: string;
  /** Git commit SHA (short form, e.g., "abc1234") */
  gitSha: string;
  /** Build timestamp in UTC ISO format */
  buildDateUtc: string;
  /** Operating system (e.g., "linux", "darwin", "win32") */
  os: string;
  /** Architecture (e.g., "x64", "arm64") */
  arch: string;
}

/**
 * Health check report
 */
export interface HealthReport {
  /** Overall health status */
  ok: boolean;
  /** List of health check descriptions/results */
  checks: string[];
  /** Optional timestamp of when the health check was performed */
  timestamp?: string;
}

/**
 * Generic command result wrapper
 */
export interface CommandResult<T = unknown> {
  /** Whether the command succeeded */
  success: boolean;
  /** Result data (if successful) */
  data?: T;
  /** Error message (if failed) */
  error?: string;
  /** Command execution timestamp */
  timestamp: string;
}

/**
 * Status information for long-running operations
 */
export interface StatusInfo {
  /** Current status */
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  /** Progress percentage (0-100) */
  progress?: number;
  /** Current operation description */
  currentOperation?: string;
  /** Start time in ISO format */
  startedAt?: string;
  /** Completion time in ISO format */
  completedAt?: string;
}

/**
 * System resource information
 */
export interface SystemInfo {
  /** Available memory in bytes */
  availableMemory: number;
  /** Total memory in bytes */
  totalMemory: number;
  /** CPU usage percentage (0-100) */
  cpuUsage?: number;
  /** Available disk space in bytes */
  availableDiskSpace?: number;
}

/**
 * Log entry structure for structured logging
 */
export interface LogEntry {
  /** Log level */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Log message */
  message: string;
  /** Timestamp in ISO format */
  timestamp: string;
  /** Optional context data */
  context?: Record<string, unknown>;
  /** Optional error details */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}
