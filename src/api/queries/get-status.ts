/**
 * Status query implementation
 * Returns current operation status for long-running tasks
 */

import type { StatusInfo } from '@api/dto.js';
import { SystemError } from '@api/errors.js';

/**
 * Global status state (placeholder for future state management)
 * In a full implementation, this would be managed by a proper state store
 */
let currentStatus: StatusInfo = {
  status: 'idle',
};

/**
 * Gets the current status of operations
 * TODO: Implement proper status tracking for:
 * - File tree scanning
 * - Hash computation
 * - Duplicate detection
 * - Export generation
 */
export function getStatus(): StatusInfo {
  try {
    // For now, return a simple idle status
    // Future implementation will track actual operation states
    return {
      ...currentStatus,
      // Always include current timestamp for status queries
      // (not in the interface but useful for debugging)
    };
  } catch (error) {
    throw SystemError.unknown(error instanceof Error ? error : new Error('Status query failed'));
  }
}

/**
 * Updates the current status (placeholder for future use)
 * TODO: Implement proper status updates with:
 * - Operation lifecycle management
 * - Progress tracking
 * - Error state handling
 * - Pause/resume functionality
 */
export function updateStatus(newStatus: Partial<StatusInfo>): void {
  try {
    currentStatus = {
      ...currentStatus,
      ...newStatus,
    };

    // TODO: Add status persistence for crash recovery
    // TODO: Add status broadcasting for UI updates
    // TODO: Add validation for status transitions
  } catch (error) {
    throw SystemError.unknown(error instanceof Error ? error : new Error('Status update failed'));
  }
}

/**
 * Resets status to idle state
 */
export function resetStatus(): void {
  try {
    currentStatus = {
      status: 'idle',
    };
  } catch (error) {
    throw SystemError.unknown(error instanceof Error ? error : new Error('Status reset failed'));
  }
}

/**
 * Formats status info for CLI display
 */
export function formatStatusInfo(status: StatusInfo): string {
  let output = `Status: ${status.status.toUpperCase()}`;

  if (status.currentOperation) {
    output += `\nOperation: ${status.currentOperation}`;
  }

  if (status.progress !== undefined) {
    output += `\nProgress: ${status.progress}%`;
  }

  if (status.startedAt) {
    output += `\nStarted: ${status.startedAt}`;
  }

  if (status.completedAt) {
    output += `\nCompleted: ${status.completedAt}`;
  }

  return output;
}

/**
 * Checks if an operation is currently active
 */
export function isOperationActive(): boolean {
  return currentStatus.status === 'running' || currentStatus.status === 'paused';
}

/**
 * Gets a simple status summary for quick checks
 */
export function getStatusSummary(): string {
  const status = getStatus();

  switch (status.status) {
    case 'idle':
      return 'Ready';
    case 'running':
      return status.progress !== undefined ? `Running (${status.progress}%)` : 'Running';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
}
