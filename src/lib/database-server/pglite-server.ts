/**
 * PGLite Server - Database Connector for External Clients
 *
 * Development-only tool that exposes embedded PGLite database to external
 * PostgreSQL clients like Beekeeper Studio, pgAdmin, psql, etc.
 *
 * ⚠️  DEVELOPMENT ONLY - Not intended for production use!
 */

import { PGlite } from '@electric-sql/pglite';
import { createServer, LogLevel } from 'pglite-server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@lib/logging.ts';

export interface PGLiteServerOptions {
  port?: number;
  dbPath?: string;
  logLevel?: LogLevel;
  debug?: boolean;
}

export class PGLiteServer {
  private db: PGlite | null = null;
  private server: unknown = null;
  private options: Required<PGLiteServerOptions>;

  constructor(options: PGLiteServerOptions = {}) {
    this.options = {
      port: 5432,
      dbPath: './dbdata-main',
      logLevel: LogLevel.Info,
      debug: false,
      ...options,
    };
  }

  /**
   * Start the PGLite server for external database access
   */
  async start(): Promise<void> {
    try {
      // Ensure parent directories exist
      const dbPath = path.resolve(this.options.dbPath);
      const parentDir = path.dirname(dbPath);

      if (!fs.existsSync(parentDir)) {
        logger.debug('Creating parent directory for PGLite server', { parentDir });
        fs.mkdirSync(parentDir, { recursive: true });
      }

      logger.debug('Initializing PGLite database for external access', { dbPath });

      // Create PGLite instance
      this.db = new PGlite(dbPath);

      if (!this.db) {
        throw new Error('Failed to create PGLite instance');
      }

      // Wait for PGLite to be ready
      await this.db.waitReady;
      logger.debug('PGLite database ready for external access');

      // Create the server using pglite-server
      this.server = createServer(this.db, {
        logLevel: this.options.logLevel,
      });

      // Start listening
      await new Promise<void>((resolve, reject) => {
        this.server.listen(this.options.port, (err?: Error) => {
          if (err) {
            reject(err);
          } else {
            logger.debug('PGLite server listening', { port: this.options.port });
            resolve();
          }
        });
      });
    } catch (error) {
      logger.error('Failed to start PGLite server', error as Error);
      throw error;
    }
  }

  /**
   * Stop the PGLite server
   */
  async stop(): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.server) {
        this.server.close(() => {
          logger.debug('PGLite server stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get connection information for external clients
   */
  getConnectionInfo() {
    return {
      host: 'localhost',
      port: this.options.port,
      database: 'archifiltre',
      username: 'archifiltre',
      password: '',
      connectionString: `postgresql://archifiltre@localhost:${this.options.port}/archifiltre`,
    };
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get current database path
   */
  getDatabasePath(): string {
    return this.options.dbPath;
  }

  /**
   * Get server options
   */
  getOptions(): Required<PGLiteServerOptions> {
    return { ...this.options };
  }
}

export default PGLiteServer;
