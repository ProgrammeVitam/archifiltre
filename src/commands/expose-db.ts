/**
 * Expose Database Command
 *
 * Development-only command that exposes embedded PGLite database to external
 * PostgreSQL clients for debugging, query testing, and data inspection.
 *
 * ⚠️  DEVELOPMENT ONLY - Not intended for production use!
 */

import { Command, Flags, ux } from '@oclif/core';
import { setupOclifContext, logger } from '@lib/logging.ts';
import { PGLiteServer } from '@lib/database-server/pglite-server.ts';
import { LogLevel } from 'pglite-server';

export default class ExposeDb extends Command {
  static override description = 'Expose embedded database for external SQL clients';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --port 5433',
    '<%= config.bin %> <%= command.id %> --database test --debug',
    '<%= config.bin %> <%= command.id %> --port 5434 --database scan-results',
  ];

  static override flags = {
    port: Flags.integer({
      char: 'p',
      description: 'Port to listen on',
      default: 5432,
      min: 1024,
      max: 65535,
    }),
    database: Flags.string({
      char: 'd',
      description: 'Database name to serve',
      default: 'main',
    }),
    debug: Flags.boolean({
      description: 'Enable debug logging',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Enable verbose output',
      default: false,
    }),
  };

  private server: PGLiteServer | undefined;

  async run(): Promise<void> {
    const { flags } = await this.parse(ExposeDb);

    const cleanupLogging = setupOclifContext(this);

    try {
      const databasePath = `./dbdata-${flags.database}`;

      // Check if database exists
      const fs = await import('node:fs');
      if (!fs.existsSync(databasePath)) {
        this.warn(`Database not found at: ${databasePath}`);
        this.log('💡 Make sure you have run a scan first to create the database.');
        this.log(`   Example: archifiltre scan /path/to/directory --db ${flags.database}`);
        return;
      }

      // Create server instance
      this.server = new PGLiteServer({
        port: flags.port,
        dbPath: databasePath,
        logLevel: flags.debug ? LogLevel.Debug : LogLevel.Info,
        debug: flags.debug,
      });

      // Setup graceful shutdown
      const shutdown = async () => {
        this.log('\n🛑 Shutting down Database Expose Server...');
        if (this.server) {
          await this.server.stop();
        }
        cleanupLogging();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Start server with action indicator
      ux.action.start('Starting database expose server');

      await this.server.start();

      ux.action.stop('ready!');

      const connectionInfo = this.server.getConnectionInfo();

      this.log(`\n[OK] Database server started on localhost:${connectionInfo.port}\n`);

      this.log('Connection Details:');
      this.log(`  Host: ${connectionInfo.host}`);
      this.log(`  Port: ${connectionInfo.port}`);
      this.log(`  Database: ${connectionInfo.database}`);
      this.log(`  Username: ${connectionInfo.username}`);
      this.log('  Password: (empty)\n');

      this.log('Connect with DBeaver:');
      this.log('  New Connection → PostgreSQL → Enter details above\n');

      this.log('Or via command line:');
      this.log(
        `  psql -h ${connectionInfo.host} -p ${connectionInfo.port} -U ${connectionInfo.username} -d ${connectionInfo.database}\n`
      );

      this.log('Sample queries:');
      this.log('  -- Find all archives:');
      this.log(
        '  SELECT path, archive_format, physical_size FROM files WHERE is_archive_container = true;\n'
      );
      this.log('  -- Find archive contents:');
      this.log(
        '  SELECT path, content_size, archive_parent_path FROM files WHERE archive_parent_path IS NOT NULL;\n'
      );
      this.log('  -- Find potential duplicates:');
      this.log(
        '  SELECT content_size, COUNT(*) as file_count FROM files WHERE content_size IS NOT NULL GROUP BY content_size HAVING COUNT(*) > 1;\n'
      );
      this.log('  -- Archive statistics:');
      this.log(
        '  SELECT archive_format, COUNT(*) as count FROM files WHERE is_archive_container = true GROUP BY archive_format;\n'
      );

      this.log('Press Ctrl+C to stop\n');

      logger.info('Database expose server started', {
        port: flags.port,
        database: flags.database,
        dbPath: databasePath,
      });

      // Keep the process alive
      await new Promise<void>(() => {});
    } catch (error) {
      ux.action.stop('failed');

      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(
        'Database expose server failed to start',
        error instanceof Error ? error : undefined,
        {
          port: flags.port,
          database: flags.database,
        }
      );

      this.error(`Failed to start database expose server: ${errorMessage}`, { exit: 1 });
    } finally {
      cleanupLogging();
    }
  }
}
