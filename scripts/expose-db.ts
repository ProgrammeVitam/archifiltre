#!/usr/bin/env bun
/**
 * Database Expose Tool - Development-only database access
 *
 * Exposes embedded PGLite database to external PostgreSQL clients for
 * development, debugging, and data inspection purposes.
 *
 * ⚠️  DEVELOPMENT ONLY - Not intended for production use!
 *
 * Usage: bun run scripts/expose-db.ts [--port=5432] [--database=main] [--debug]
 */

import { PGLiteServer } from '../src/lib/database-server/pglite-server.ts';
import { LogLevel } from 'pglite-server';

// Parse command line arguments
const args = process.argv.slice(2);
const port = args.find(arg => arg.startsWith('--port='))?.split('=')[1] || '5432';
const databaseName = args.find(arg => arg.startsWith('--database='))?.split('=')[1] || 'main';
const database = `./dbdata-${databaseName}`;
const debug = args.includes('--debug');
const help = args.includes('--help') || args.includes('-h');

if (help) {
  console.log(`
Database Expose - Development Database Access Tool



USAGE:
  bun run scripts/expose-db.ts [OPTIONS]

OPTIONS:
  --port=<port>         Port to listen on (default: 5432)
  --database=<name>     Database to serve (default: main)
  --debug               Enable debug logging
  --help, -h            Show this help message

EXAMPLES:
  bun run scripts/expose-db.ts                      # Serve main database
  bun run scripts/expose-db.ts --port=5433          # Custom port
  bun run scripts/expose-db.ts --database=test      # Different database

CONNECTION:
  Host: localhost, Database: archifiltre, Username: archifiltre

  DBeaver: New Connection → PostgreSQL → Enter details above
  psql: psql -h localhost -p <port> -U archifiltre -d archifiltre
`);
  process.exit(0);
}

async function main() {
  const server = new PGLiteServer({
    port: parseInt(port),
    dbPath: database,
    logLevel: debug ? LogLevel.Debug : LogLevel.Info,
    debug,
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down Database Expose Server...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();

    const connectionInfo = server.getConnectionInfo();

    console.log(`[OK] Database server started on localhost:${  connectionInfo.port  }\n`);

    console.log('Connection Details:');
    console.log(`  Host: ${  connectionInfo.host}`);
    console.log(`  Port: ${  connectionInfo.port}`);
    console.log(`  Database: ${  connectionInfo.database}`);
    console.log(`  Username: ${  connectionInfo.username}`);
    console.log('  Password: (empty)\n');

    console.log('Connect with DBeaver:');
    console.log('  New Connection → PostgreSQL → Enter details above\n');

    console.log('Or via command line:');
    console.log(
      `  psql -h ${ 
        connectionInfo.host 
        } -p ${ 
        connectionInfo.port 
        } -U ${ 
        connectionInfo.username 
        } -d ${ 
        connectionInfo.database 
        }\n`
    );

    console.log('Sample queries:');
    console.log('  -- Find all archives:');
    console.log(
      '  SELECT path, archive_format, physical_size FROM files WHERE is_archive_container = true;\n'
    );
    console.log('  -- Find archive contents:');
    console.log(
      '  SELECT path, content_size, archive_parent_path FROM files WHERE archive_parent_path IS NOT NULL;\n'
    );
    console.log('  -- Find potential duplicates:');
    console.log(
      '  SELECT content_size, COUNT(*) as file_count FROM files WHERE content_size IS NOT NULL GROUP BY content_size HAVING COUNT(*) > 1;\n'
    );
    console.log('  -- Archive statistics:');
    console.log(
      '  SELECT archive_format, COUNT(*) as count FROM files WHERE is_archive_container = true GROUP BY archive_format;\n'
    );

    console.log('Press Ctrl+C to stop\n');

    // Keep the process alive
    await new Promise<void>(() => {}); // Infinite promise
  } catch (error) {
    console.error('❌ Failed to start Database Expose Server:', error);
    console.log('\nTroubleshooting:');
    console.log('• Ensure you have run a scan first to create the database');
    console.log('• Check that the database file exists at:', database);
    console.log('• Try a different port if 5432 is already in use');
    console.log('• Use --debug flag for more detailed error information');
    process.exit(1);
  }
}

// Run the server
main().catch(console.error);
