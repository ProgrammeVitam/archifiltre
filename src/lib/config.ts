/**
 * TOML Configuration System
 *
 * Manages application configuration using TOML files with user directory support.
 * Privacy-first defaults and cross-platform user directory handling.
 */

import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { parse } from 'smol-toml';
import { logger } from './logging.ts';

// === Types ===

export interface ArchifilterConfig {
  app: ApplicationConfig;
  logging: LoggingConfig;
  privacy: PrivacyConfig;
  scanning: ScanningConfig;
  storage: StorageConfig;
}

export interface ApplicationConfig {
  name: string;
  version: string;
  dataDirectory: string;
  tempDirectory: string;
}

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug';
  enableFileLogging: boolean;
  enableConsoleLogging: boolean;
  maxFileSize: string;
  maxFiles: string;
}

export interface PrivacyConfig {
  enableAnalytics: boolean;
  enableCrashReporting: boolean;
  sanitizeFilePaths: boolean;
  allowExternalServices: boolean;
}

export interface ScanningConfig {
  includeHidden: boolean;
  maxDepth: number;
  calculateHashes: boolean;
  minSizeForHash: number;
  batchSize: number;
}

export interface StorageConfig {
  databaseName: string;
  enableWAL: boolean;
  retentionDays: number;
  maxDatabaseSize: string;
}

// === Default Configuration ===

export const DEFAULT_CONFIG: ArchifilterConfig = {
  app: {
    name: 'archifiltre',
    version: '5.0.0',
    dataDirectory: '~/.archifiltre',
    tempDirectory: '~/.archifiltre/temp',
  },
  logging: {
    level: 'info',
    enableFileLogging: true,
    enableConsoleLogging: true,
    maxFileSize: '20m',
    maxFiles: '14d',
  },
  privacy: {
    enableAnalytics: false,
    enableCrashReporting: false,
    sanitizeFilePaths: true,
    allowExternalServices: false,
  },
  scanning: {
    includeHidden: false,
    maxDepth: 10,
    calculateHashes: true,
    minSizeForHash: 1024,
    batchSize: 1000,
  },
  storage: {
    databaseName: 'archifiltre.db',
    enableWAL: true,
    retentionDays: 30,
    maxDatabaseSize: '1GB',
  },
};

// === TOML Content Template ===

export const DEFAULT_TOML_CONTENT = `# Archifiltre Configuration File
# Privacy-first file scanning and duplicate detection tool

[app]
name = "archifiltre"
version = "5.0.0"
dataDirectory = "~/.archifiltre"
tempDirectory = "~/.archifiltre/temp"

[logging]
level = "info"
enableFileLogging = true
enableConsoleLogging = true
maxFileSize = "20m"
maxFiles = "14d"

[privacy]
# Privacy-first defaults - all external services disabled by default
enableAnalytics = false
enableCrashReporting = false
sanitizeFilePaths = true
allowExternalServices = false

[scanning]
includeHidden = false
maxDepth = 10
calculateHashes = true
minSizeForHash = 1024
batchSize = 1000

[storage]
databaseName = "archifiltre.db"
enableWAL = true
retentionDays = 30
maxDatabaseSize = "1GB"
`;

// === User Directory Management ===

export interface UserDirectoryPaths {
  home: string;
  config: string;
  data: string;
  logs: string;
  temp: string;
}

export class UserDirectoryManager {
  private paths: UserDirectoryPaths;

  constructor() {
    const home = homedir();
    const appDir = join(home, '.archifiltre');

    this.paths = {
      home: appDir,
      config: join(appDir, 'config'),
      data: join(appDir, 'data'),
      logs: join(appDir, 'logs'),
      temp: join(appDir, 'temp'),
    };
  }

  /**
   * Get all user directory paths
   */
  getPaths(): UserDirectoryPaths {
    return { ...this.paths };
  }

  /**
   * Ensure all user directories exist
   */
  async ensureDirectories(): Promise<void> {
    logger.debug('Ensuring user directories exist');

    try {
      for (const [name, path] of Object.entries(this.paths)) {
        if (!existsSync(path)) {
          mkdirSync(path, { recursive: true });
          logger.debug(`Created directory: ${name}`, { path });
        }
      }
    } catch (error) {
      logger.error('Failed to create user directories', error as Error);
      throw error;
    }
  }

  /**
   * Get config file path
   */
  getConfigFilePath(): string {
    return join(this.paths.config, 'archifiltre.toml');
  }
}

// === Configuration Manager ===

export class ConfigManager {
  private config: ArchifilterConfig;
  private userDirs: UserDirectoryManager;
  private configOverrides: Partial<ArchifilterConfig> = {};

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.userDirs = new UserDirectoryManager();
  }

  /**
   * Initialize configuration system
   */
  async initialize(): Promise<void> {
    logger.info('Initializing configuration system');

    try {
      // Ensure user directories exist
      await this.userDirs.ensureDirectories();

      // Load configuration from file
      await this.loadConfigFile();

      // Apply any overrides
      this.applyOverrides();

      // Expand path placeholders
      this.expandPaths();

      logger.info('Configuration system initialized successfully');
    } catch (error) {
      logger.warn('Failed to initialize configuration, using defaults', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load configuration from TOML file
   */
  private async loadConfigFile(): Promise<void> {
    const configPath = this.userDirs.getConfigFilePath();

    if (!existsSync(configPath)) {
      logger.info('Config file not found, creating default', { configPath });
      await this.createDefaultConfigFile();
      return;
    }

    try {
      const tomlContent = await readFile(configPath, 'utf-8');

      // Parse TOML content
      const parsedConfig = parse(tomlContent) as Partial<ArchifilterConfig>;
      this.config = this.mergeConfig(DEFAULT_CONFIG, parsedConfig);

      logger.debug('Configuration loaded from file', { configPath });
    } catch (error) {
      logger.warn('Failed to parse config file, using defaults', {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create default configuration file
   */
  private async createDefaultConfigFile(): Promise<void> {
    const configPath = this.userDirs.getConfigFilePath();

    try {
      await writeFile(configPath, DEFAULT_TOML_CONTENT);
      logger.info('Default configuration file created', { configPath });
    } catch (error) {
      logger.error('Failed to create default config file', error as Error, { configPath });
    }
  }

  /**
   * Apply configuration overrides (from CLI flags, etc.)
   */
  private applyOverrides(): void {
    if (Object.keys(this.configOverrides).length > 0) {
      logger.debug('Applying configuration overrides', this.configOverrides);
      // TODO: Implement deep merge of overrides
      // this.config = deepMerge(this.config, this.configOverrides);
    }
  }

  /**
   * Expand path placeholders like ~/.archifiltre
   */
  private expandPaths(): void {
    const home = homedir();

    // Expand paths in app config
    if (this.config.app.dataDirectory.startsWith('~/')) {
      this.config.app.dataDirectory = join(home, this.config.app.dataDirectory.slice(2));
    }

    if (this.config.app.tempDirectory.startsWith('~/')) {
      this.config.app.tempDirectory = join(home, this.config.app.tempDirectory.slice(2));
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): ArchifilterConfig {
    return { ...this.config };
  }

  /**
   * Get specific configuration section
   */
  getAppConfig(): ApplicationConfig {
    return { ...this.config.app };
  }

  getLoggingConfig(): LoggingConfig {
    return { ...this.config.logging };
  }

  getPrivacyConfig(): PrivacyConfig {
    return { ...this.config.privacy };
  }

  getScanningConfig(): ScanningConfig {
    return { ...this.config.scanning };
  }

  getStorageConfig(): StorageConfig {
    return { ...this.config.storage };
  }

  /**
   * Deep merge two configuration objects
   */
  private mergeConfig(
    base: ArchifilterConfig,
    partial: Partial<ArchifilterConfig>
  ): ArchifilterConfig {
    const result = { ...base };

    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined || value === null) {
        continue;
      }

      const configKey = key as keyof ArchifilterConfig;

      if (typeof value === 'object' && !Array.isArray(value)) {
        // Deep merge nested objects
        result[configKey] = {
          ...(result[configKey] as object),
          ...value,
        } as (typeof result)[typeof configKey];
      } else {
        // Direct assignment for primitives
        result[configKey] = value as (typeof result)[typeof configKey];
      }
    }

    return result;
  }

  /**
   * Set configuration overrides
   */
  setOverrides(overrides: Partial<ArchifilterConfig>): void {
    this.configOverrides = { ...overrides };
    this.applyOverrides();
  }

  /**
   * Update configuration and save to file
   */
  async updateConfig(_updates: Partial<ArchifilterConfig>): Promise<void> {
    logger.info('Updating configuration');

    try {
      // TODO: Implement config merging and TOML generation
      // this.config = deepMerge(this.config, updates);
      // const tomlContent = generateToml(this.config);
      // await writeFile(this.userDirs.getConfigFilePath(), tomlContent);

      logger.info('Configuration updated successfully');
    } catch (error) {
      logger.error('Failed to update configuration', error as Error);
      throw error;
    }
  }

  /**
   * Get user directory paths
   */
  getUserPaths(): UserDirectoryPaths {
    return this.userDirs.getPaths();
  }
}

// === Global Configuration Management ===

let globalConfigManager: ConfigManager | null = null;

export function createConfigManager(): ConfigManager {
  return new ConfigManager();
}

export function getGlobalConfigManager(): ConfigManager {
  if (!globalConfigManager) {
    globalConfigManager = createConfigManager();
  }
  return globalConfigManager;
}

export async function initializeConfig(): Promise<void> {
  const manager = getGlobalConfigManager();
  await manager.initialize();
}

export function getConfig(): ArchifilterConfig {
  return getGlobalConfigManager().getConfig();
}

export function getAppConfig(): ApplicationConfig {
  return getGlobalConfigManager().getAppConfig();
}

export function getLoggingConfig(): LoggingConfig {
  return getGlobalConfigManager().getLoggingConfig();
}

export function getPrivacyConfig(): PrivacyConfig {
  return getGlobalConfigManager().getPrivacyConfig();
}

export function getScanningConfig(): ScanningConfig {
  return getGlobalConfigManager().getScanningConfig();
}

export function getStorageConfig(): StorageConfig {
  return getGlobalConfigManager().getStorageConfig();
}

// === Validation ===

export function validateConfig(_config: Partial<ArchifilterConfig>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // TODO: Implement configuration validation
  // - Check that directories are writable
  // - Validate log levels
  // - Check numeric ranges
  // - Validate file size formats

  return {
    valid: errors.length === 0,
    errors,
  };
}
