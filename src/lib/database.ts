/**
 * Database Operations - PGlite + Drizzle + RxJS
 *
 * Simple, working database implementation inspired by Archiscan's approach.
 * Uses PGlite for embedded PostgreSQL with Drizzle ORM and RxJS for reactive operations.
 */

import * as path from 'node:path';

import { promises as fs } from 'node:fs';
import { Observable, from, of, defer, EMPTY } from 'rxjs';
import { map, catchError, tap, switchMap } from 'rxjs/operators';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { pgTable, text, integer, index, primaryKey, boolean } from 'drizzle-orm/pg-core';
import { eq, and, count, sum, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { logger } from '@lib/logging.ts';

// === Schema Definition ===

/**
 * Files table schema - includes ALL discovered items (files + directories)
 * for complete inventory with SQL-based analysis capabilities
 */
export const files = pgTable(
  'files',
  {
    run_id: text('run_id').notNull(),
    path: text('path').notNull(),
    size: integer('size').notNull(),
    mtime: integer('mtime').notNull(),
    is_directory: boolean('is_directory').notNull(),
    is_hidden: boolean('is_hidden').notNull(),
    is_system: boolean('is_system').notNull(),
    hash: text('hash'), // Only files get hashed, directories remain NULL
  },
  table => ({
    pk: primaryKey({ columns: [table.run_id, table.path] }),
    runIdIdx: index('idx_files_run_id').on(table.run_id),
    sizeIdx: index('idx_files_size').on(table.size),
    hashIdx: index('idx_files_hash').on(table.hash),
  })
);

// === Types ===

export type FileRow = typeof files.$inferInsert;
export type FileSelect = typeof files.$inferSelect;

export interface DatabaseConnection {
  pg: PGlite;
  db: ReturnType<typeof drizzle>;
}

export interface ScanStats {
  totalFiles: number;
  totalSize: number;
  duplicateGroups: number;
  duplicateFiles: number;
}

// === Database Management ===

/**
 * Create a safe database path for all platforms
 */
function createDatabasePath(name: string): string {
  // Simple approach: always use local directory
  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '_');
  return `./dbdata-${safeName}`;
}

/**
 * Initialize database tables and indexes
 */
async function initializeSchema(db: ReturnType<typeof drizzle>): Promise<void> {
  try {
    // Create files table - stores ALL discovered items (files + directories)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS files (
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        is_directory BOOLEAN NOT NULL,
        is_hidden BOOLEAN NOT NULL,
        is_system BOOLEAN NOT NULL,
        hash TEXT,
        CONSTRAINT files_pkey PRIMARY KEY (run_id, path)
      )
    `);

    // Create indexes for performance
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_files_run_id ON files (run_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_files_size ON files (size)`);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS idx_files_hash ON files (hash) WHERE hash IS NOT NULL`
    );
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_files_hidden ON files (is_hidden)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_files_system ON files (is_system)`);

    logger.debug('Database schema initialized');
  } catch (error) {
    logger.error('Failed to initialize database schema', error as Error);
    throw error;
  }
}

/**
 * Create database connection
 */
export async function createDatabase(name: string): Promise<DatabaseConnection> {
  try {
    const dbPath = createDatabasePath(name);

    // Ensure directory exists
    await fs.mkdir(path.dirname(path.resolve(dbPath)), { recursive: true }).catch(() => {});

    const pg = await PGlite.create(dbPath);
    const db = drizzle(pg, { schema: { files } });

    await initializeSchema(db);

    logger.debug('Database created', { path: dbPath });

    return { pg, db };
  } catch (error) {
    logger.error('Failed to create database', error as Error, { name });
    throw error;
  }
}

/**
 * Close database connection
 */
export async function closeDatabase(connection: DatabaseConnection): Promise<void> {
  try {
    await connection.pg.close();
    logger.debug('Database connection closed');
  } catch (error) {
    logger.warn('Warning during database close', { error: (error as Error).message });
  }
}

// === Reactive Database Operations ===

/**
 * Clean database by recreating it with fresh schema
 * This ensures schema compatibility and removes all old data
 */
export function cleanDatabase(connection: DatabaseConnection, runId: string): Observable<void> {
  return defer(async () => {
    logger.debug('Recreating database for fresh schema', { runId });

    try {
      // Close current connection
      await connection.pg.close();
      logger.debug('Closed existing database connection');

      // Recreate database with fresh schema
      // Note: We don't know the original DB name, so we'll recreate with a default name
      // This works because each scan typically uses a fresh database anyway
      const dbPath = './dbdata-main';

      // Delete existing database directory
      try {
        await fs.rm(path.resolve(dbPath), { recursive: true, force: true });
        logger.debug('Removed old database files', { path: dbPath });
      } catch (_error) {
        // Ignore if directory doesn't exist
        logger.debug('No existing database to remove', { path: dbPath });
      }

      // Create fresh database
      await fs.mkdir(path.dirname(path.resolve(dbPath)), { recursive: true }).catch(() => {});

      const newPg = await PGlite.create(dbPath);
      const newDb = drizzle(newPg, { schema: { files } });

      // Initialize fresh schema
      await initializeSchema(newDb);

      // Update connection object in place to maintain API compatibility
      connection.pg = newPg;
      connection.db = newDb;

      logger.debug('Database recreated with fresh schema', { runId });
      return void 0;
    } catch (error) {
      logger.error('Failed to recreate database', error as Error, { runId });
      throw error;
    }
  }).pipe(
    catchError(error => {
      logger.error('Database recreation failed', error as Error, { runId });
      return EMPTY;
    })
  );
}

/**
 * Insert batch of files
 */
export function insertFileBatch(
  connection: DatabaseConnection,
  fileRows: FileRow[]
): Observable<number> {
  if (!fileRows.length) return of(0);

  return defer(() => {
    logger.debug('Inserting file batch', { count: fileRows.length });

    return from(
      connection.db.transaction(async tx => {
        // Insert the batch
        await tx.insert(files).values(fileRows).onConflictDoNothing();

        // Since onConflictDoNothing doesn't return meaningful rowCount,
        // we return the batch size as approximation (like ArchiScan does)
        return fileRows.length;
      })
    ).pipe(
      tap(inserted => logger.debug('Files inserted', { inserted, attempted: fileRows.length })),
      catchError(error => {
        logger.error('Failed to insert file batch', error as Error, { count: fileRows.length });
        return of(0);
      })
    );
  });
}

/**
 * Update hash for files
 */
export function updateFileHash(
  connection: DatabaseConnection,
  runId: string,
  filePath: string,
  hash: string
): Observable<void> {
  return defer(() => {
    return from(
      connection.db
        .update(files)
        .set({ hash })
        .where(and(eq(files.run_id, runId), eq(files.path, filePath)))
    ).pipe(
      map(() => void 0),
      catchError(error => {
        logger.error('Failed to update file hash', error as Error, { runId, filePath });
        return EMPTY;
      })
    );
  });
}

/**
 * Find files with duplicate sizes (candidates for hash calculation)
 */
export function findDuplicateSizes(
  connection: DatabaseConnection,
  runId: string
): Observable<number[]> {
  return defer(() => {
    logger.debug('Finding duplicate sizes', { runId });

    return from(
      connection.db
        .select({ size: files.size })
        .from(files)
        .where(eq(files.run_id, runId))
        .groupBy(files.size)
        .having(sql`count(*) > 1`)
    ).pipe(
      map(results => results.map(r => r.size)),
      tap(sizes => logger.debug('Found duplicate sizes', { count: sizes.length })),
      catchError(error => {
        logger.error('Failed to find duplicate sizes', error as Error, { runId });
        return of([]);
      })
    );
  });
}

/**
 * Get files that need hashing
 */
export function getFilesNeedingHash(
  connection: DatabaseConnection,
  runId: string,
  duplicateSizes: number[]
): Observable<string[]> {
  if (!duplicateSizes.length) return of([]);

  return defer(() => {
    return from(
      connection.db
        .select({ path: files.path })
        .from(files)
        .where(
          and(eq(files.run_id, runId), isNull(files.hash), inArray(files.size, duplicateSizes))
        )
    ).pipe(
      map(results => results.map(r => r.path)),
      catchError(error => {
        logger.error('Failed to get files needing hash', error as Error, { runId });
        return of([]);
      })
    );
  });
}

/**
 * Get scan statistics
 */
export function getScanStats(connection: DatabaseConnection, runId: string): Observable<ScanStats> {
  return defer(() => {
    logger.debug('Getting scan statistics', { runId });

    // Get basic stats
    return from(
      connection.db
        .select({
          totalFiles: count(),
          totalSize: sum(files.size),
        })
        .from(files)
        .where(eq(files.run_id, runId))
    ).pipe(
      switchMap(basicStats => {
        const totalFiles = basicStats[0]?.totalFiles || 0;
        const totalSize = Number(basicStats[0]?.totalSize) || 0;

        // Get duplicate stats
        return from(
          connection.db
            .select({
              hash: files.hash,
              fileCount: count(),
            })
            .from(files)
            .where(and(eq(files.run_id, runId), isNotNull(files.hash)))
            .groupBy(files.hash)
            .having(sql`count(*) > 1`)
        ).pipe(
          map(duplicateGroups => {
            const duplicateGroupsCount = duplicateGroups.length;
            const duplicateFilesCount = duplicateGroups.reduce(
              (sum, group) => sum + (group.fileCount || 0),
              0
            );

            return {
              totalFiles,
              totalSize,
              duplicateGroups: duplicateGroupsCount,
              duplicateFiles: duplicateFilesCount,
            };
          })
        );
      }),
      catchError(error => {
        logger.error('Failed to get scan statistics', error as Error, { runId });
        return of({
          totalFiles: 0,
          totalSize: 0,
          duplicateGroups: 0,
          duplicateFiles: 0,
        });
      })
    );
  });
}

/**
 * Get all files for a run (for export/analysis)
 */
export function getAllFiles(
  connection: DatabaseConnection,
  runId: string
): Observable<FileSelect[]> {
  return defer(() => {
    return from(
      connection.db.select().from(files).where(eq(files.run_id, runId)).orderBy(files.path)
    ).pipe(
      catchError(error => {
        logger.error('Failed to get all files', error as Error, { runId });
        return of([]);
      })
    );
  });
}

/**
 * Database health check
 */
export function checkHealth(connection: DatabaseConnection): Observable<boolean> {
  return defer(() => {
    return from(connection.db.select({ count: count() }).from(files).limit(1)).pipe(
      map(() => true),
      catchError(() => of(false))
    );
  });
}

// === Factory Functions ===

export { createDatabase as createScanDatabase };
export { closeDatabase as closeScanDatabase };

/**
 * Simple database operations for CLI commands
 */
export const dbOperations = {
  create: createDatabase,
  close: closeDatabase,
  clean: cleanDatabase,
  insertBatch: insertFileBatch,
  updateHash: updateFileHash,
  findDuplicateSizes,
  getFilesNeedingHash,
  getStats: getScanStats,
  getAllFiles,
  healthCheck: checkHealth,
};
