/**
 * Data Sanitization Utilities
 *
 * Privacy protection utilities for sanitizing log data before sending
 * to external providers or storing locally. Helps ensure user privacy
 * while maintaining useful debugging information.
 */

import type { PrivacyConfig } from './types.js';
import os from 'node:os';
import path from 'node:path';

/**
 * Sanitization configuration extracted from privacy config
 */
interface SanitizationConfig {
  sanitizeFilePaths: boolean;
  sanitizeUserData: boolean;
  sanitizeSystemInfo: boolean;
}

/**
 * Patterns for detecting sensitive data
 */
const SENSITIVE_PATTERNS = {
  // File paths
  absolutePaths: [
    /\/Users\/[^/\s]+/g, // macOS user directories
    /\/home\/[^/\s]+/g, // Linux user directories
    /C:\\Users\\[^\\:\s]+/g, // Windows user directories
    /\/tmp\/[^/\s]*/g, // Temp directories
    /\/var\/[^/\s]*/g, // System directories
  ],

  // User identifiable information
  userInfo: [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email addresses
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, // IP addresses
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, // UUIDs
  ],

  // System information
  systemInfo: [
    /hostname[:\s]+[^\s]+/gi, // Hostname references
    /computer[:\s]+[^\s]+/gi, // Computer name references
    /machine[:\s]+[^\s]+/gi, // Machine name references
  ],

  // Credentials (should never be in logs, but just in case)
  credentials: [
    /password[:\s]*[^\s]+/gi, // Password references
    /token[:\s]*[^\s]+/gi, // Token references
    /secret[:\s]*[^\s]+/gi, // Secret references
    /key[:\s]*[^\s]+/gi, // Key references (API keys, etc.)
  ],
};

/**
 * Replacement values for sanitized data
 */
const REPLACEMENTS = {
  filePath: '[SANITIZED_PATH]',
  userInfo: '[SANITIZED_USER]',
  systemInfo: '[SANITIZED_SYSTEM]',
  credentials: '[REDACTED]',
  unknown: '[SANITIZED]',
} as const;

/**
 * Main sanitization function
 */
export function sanitizeData(data: unknown, config: SanitizationConfig): unknown {
  return sanitizeValue(data, config, new Set());
}

/**
 * Recursively sanitize a value of any type
 */
function sanitizeValue(value: unknown, config: SanitizationConfig, visited: Set<object>): unknown {
  // Handle null/undefined
  if (value == null) {
    return value;
  }

  // Handle circular references
  if (typeof value === 'object' && visited.has(value as object)) {
    return '[Circular Reference]';
  }

  // Handle different types
  switch (typeof value) {
    case 'string':
      return sanitizeString(value, config);

    case 'object':
      if (value instanceof Date) {
        return value; // Dates are safe
      }
      if (value instanceof Error) {
        return sanitizeError(value, config);
      }
      if (Array.isArray(value)) {
        return sanitizeArray(value, config, visited);
      }
      return sanitizeObject(value as Record<string, unknown>, config, visited);

    case 'number':
    case 'boolean':
      return value; // Primitives are generally safe

    case 'function':
      return '[Function]'; // Don't log function implementations

    case 'symbol':
      return value.toString();

    default:
      return '[Unknown Type]';
  }
}

/**
 * Sanitize string values
 */
function sanitizeString(str: string, config: SanitizationConfig): string {
  let result = str;

  // Always sanitize credentials regardless of config
  for (const pattern of SENSITIVE_PATTERNS.credentials) {
    result = result.replace(pattern, REPLACEMENTS.credentials);
  }

  // Sanitize file paths if enabled
  if (config.sanitizeFilePaths) {
    for (const pattern of SENSITIVE_PATTERNS.absolutePaths) {
      result = result.replace(pattern, REPLACEMENTS.filePath);
    }

    // Additional file path sanitization
    result = sanitizeFilePath(result);
  }

  // Sanitize user data if enabled
  if (config.sanitizeUserData) {
    for (const pattern of SENSITIVE_PATTERNS.userInfo) {
      result = result.replace(pattern, REPLACEMENTS.userInfo);
    }

    // Sanitize current username
    const username = os.userInfo().username;
    if (username) {
      const userPattern = new RegExp(`\\b${escapeRegExp(username)}\\b`, 'gi');
      result = result.replace(userPattern, REPLACEMENTS.userInfo);
    }
  }

  // Sanitize system info if enabled
  if (config.sanitizeSystemInfo) {
    for (const pattern of SENSITIVE_PATTERNS.systemInfo) {
      result = result.replace(pattern, REPLACEMENTS.systemInfo);
    }

    // Sanitize hostname
    const hostname = os.hostname();
    if (hostname) {
      const hostnamePattern = new RegExp(`\\b${escapeRegExp(hostname)}\\b`, 'gi');
      result = result.replace(hostnamePattern, REPLACEMENTS.systemInfo);
    }
  }

  return result;
}

/**
 * Sanitize file paths specifically
 */
function sanitizeFilePath(filePath: string): string {
  try {
    // Convert absolute paths to relative when possible
    const cwd = process.cwd();
    if (filePath.startsWith(cwd)) {
      return path.relative(cwd, filePath);
    }

    // For other absolute paths, just show the filename
    if (path.isAbsolute(filePath)) {
      return path.basename(filePath);
    }

    return filePath;
  } catch {
    return REPLACEMENTS.filePath;
  }
}

/**
 * Sanitize Error objects
 */
function sanitizeError(error: Error, config: SanitizationConfig): object {
  return {
    name: error.name,
    message: sanitizeString(error.message, config),
    stack: error.stack ? sanitizeString(error.stack, config) : undefined,
  };
}

/**
 * Sanitize arrays
 */
function sanitizeArray(
  arr: unknown[],
  config: SanitizationConfig,
  visited: Set<object>
): unknown[] {
  visited.add(arr);
  const result = arr.map(item => sanitizeValue(item, config, visited));
  visited.delete(arr);
  return result;
}

/**
 * Sanitize objects
 */
function sanitizeObject(
  obj: Record<string, unknown>,
  config: SanitizationConfig,
  visited: Set<object>
): Record<string, unknown> {
  visited.add(obj);

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Sanitize the key itself
    const sanitizedKey = sanitizeString(key, config);

    // Skip certain sensitive keys entirely
    if (isSensitiveKey(key)) {
      result[sanitizedKey] = REPLACEMENTS.credentials;
    } else {
      result[sanitizedKey] = sanitizeValue(value, config, visited);
    }
  }

  visited.delete(obj);
  return result;
}

/**
 * Check if a key is potentially sensitive
 */
function isSensitiveKey(key: string): boolean {
  const sensitiveKeys = [
    'password',
    'pwd',
    'passwd',
    'token',
    'accesstoken',
    'refreshtoken',
    'secret',
    'secretkey',
    'apisecret',
    'key',
    'apikey',
    'privatekey',
    'auth',
    'authorization',
    'credential',
    'credentials',
  ];

  const lowerKey = key.toLowerCase();
  return sensitiveKeys.some(sensitiveKey => lowerKey.includes(sensitiveKey));
}

/**
 * Escape string for use in regular expressions
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create sanitizer with specific config from privacy settings
 */
export function createSanitizer(privacy: PrivacyConfig['sanitization']) {
  return (data: unknown) => sanitizeData(data, privacy);
}

/**
 * Sanitize file paths only (useful for CLI output)
 */
export function sanitizeForCLI(data: unknown): unknown {
  return sanitizeData(data, {
    sanitizeFilePaths: true,
    sanitizeUserData: false,
    sanitizeSystemInfo: false,
  });
}

/**
 * Full sanitization for external services
 */
export function sanitizeForExternal(data: unknown): unknown {
  return sanitizeData(data, {
    sanitizeFilePaths: true,
    sanitizeUserData: true,
    sanitizeSystemInfo: true,
  });
}

/**
 * Minimal sanitization (credentials only)
 */
export function sanitizeMinimal(data: unknown): unknown {
  return sanitizeData(data, {
    sanitizeFilePaths: false,
    sanitizeUserData: false,
    sanitizeSystemInfo: false,
  });
}

/**
 * Test if data contains sensitive information
 */
export function containsSensitiveData(data: unknown): boolean {
  const serialized = JSON.stringify(data);

  // Check for credentials
  for (const pattern of SENSITIVE_PATTERNS.credentials) {
    if (pattern.test(serialized)) {
      return true;
    }
  }

  return false;
}

/**
 * Get summary of what was sanitized
 */
export function getSanitizationSummary(
  original: unknown,
  sanitized: unknown
): {
  wasSanitized: boolean;
  pathsSanitized: number;
  userDataSanitized: number;
  systemInfoSanitized: number;
  credentialsSanitized: number;
} {
  const originalStr = JSON.stringify(original);
  const sanitizedStr = JSON.stringify(sanitized);

  if (originalStr === sanitizedStr) {
    return {
      wasSanitized: false,
      pathsSanitized: 0,
      userDataSanitized: 0,
      systemInfoSanitized: 0,
      credentialsSanitized: 0,
    };
  }

  return {
    wasSanitized: true,
    pathsSanitized: (sanitizedStr.match(/\[SANITIZED_PATH\]/g) || []).length,
    userDataSanitized: (sanitizedStr.match(/\[SANITIZED_USER\]/g) || []).length,
    systemInfoSanitized: (sanitizedStr.match(/\[SANITIZED_SYSTEM\]/g) || []).length,
    credentialsSanitized: (sanitizedStr.match(/\[REDACTED\]/g) || []).length,
  };
}
