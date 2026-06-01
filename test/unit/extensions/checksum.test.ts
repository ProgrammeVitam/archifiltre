/**
 * Characterization tests for src/extensions/checksum/index.ts
 *
 * Error semantics captured here:
 * - processUniqueFiles: per-file error → catchError → EMPTY (file silently skipped)
 * - processDuplicateGroups: group error → catchError → of({ errors: group.paths.length })
 * - computeChecksums throws (no catchError) on top-level failure
 *
 * These tests run a real scan first to produce a realistic DB state,
 * then verify checksum pipeline behavior on top of it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { lastValueFrom } from 'rxjs';
import { eq } from 'drizzle-orm';
import { computeChecksums } from '@extensions/checksum/index.ts';
import { scanDirectory, generateRunId } from '@lib/scanner.ts';
import {
  createScanDatabase,
  closeScanDatabase,
  insertFileBatch,
  files,
  type DatabaseConnection,
  type FileRow,
} from '@lib/database.ts';
import { getDatabasePath } from '@lib/platform-paths.ts';

// ---- Helpers ----

async function createTestDb(name: string): Promise<{
  db: DatabaseConnection;
  cleanup: () => Promise<void>;
}> {
  const db = await createScanDatabase(name);
  const dbDir = path.resolve(getDatabasePath(name));
  return {
    db,
    async cleanup() {
      await closeScanDatabase(db);
      await fs.rm(dbDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function createTempTree(fileTree: Record<string, string>): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archifiltre-cksum-'));
  for (const [relPath, content] of Object.entries(fileTree)) {
    const full = path.join(dir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return {
    dir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// Mirror the DDL from ensureChecksumTable (not exported) to set up test state
async function ensureChecksumTable(db: DatabaseConnection): Promise<void> {
  await db.pg.exec(`
    CREATE TABLE IF NOT EXISTS file_checksums (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      md5 TEXT,
      sha256 TEXT,
      sha512 TEXT,
      xxhash64 TEXT,
      PRIMARY KEY (run_id, path)
    )
  `);
  await db.pg.exec(
    `CREATE INDEX IF NOT EXISTS idx_file_checksums_run_id ON file_checksums (run_id)`
  );
}

function makeFileRow(
  runId: string,
  filePath: string,
  contentSize: number,
  hash: string | null = null
): FileRow {
  return {
    run_id: runId,
    path: filePath,
    physical_size: contentSize,
    content_size: contentSize,
    mtime: 0,
    is_directory: false,
    is_hidden: false,
    is_system: false,
    hash,
    is_archive_container: false,
    archive_parent_path: null,
    archive_depth: 0,
    archive_format: null,
    extraction_error: null,
  };
}

// ---- Test suite ----

describe('computeChecksums', () => {
  let tmpTree: Awaited<ReturnType<typeof createTempTree>>;
  let dbCtx: Awaited<ReturnType<typeof createTestDb>>;
  let runId: string;

  // Tree: two files with identical content (become a duplicate group after scan),
  // one file with unique content (goes through processUniqueFiles).
  const DUP_CONTENT = 'duplicate file content for checksum test';
  const UNIQUE_CONTENT = 'uniquely distinct file content xyz987';

  beforeEach(async () => {
    tmpTree = await createTempTree({
      'dup1.txt': DUP_CONTENT,
      'dup2.txt': DUP_CONTENT,
      'unique.txt': UNIQUE_CONTENT,
    });

    const name = `cksumtest${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
    dbCtx = await createTestDb(name);
    runId = generateRunId();

    // Run a real scan to put the DB in a realistic state.
    // After the scan: dup1.txt and dup2.txt have the same xxHash64 in files.hash,
    // unique.txt has hash=null (unique content_size → never hashed by hash-calculator).
    await lastValueFrom(
      scanDirectory(dbCtx.db, {
        rootPath: tmpTree.dir,
        runId,
        enableArchiveProcessing: false,
      })
    );

    await ensureChecksumTable(dbCtx.db);
  });

  afterEach(async () => {
    await tmpTree.cleanup();
    await dbCtx.cleanup();
  });

  it('--each-file mode writes a checksum row for every non-directory file', async () => {
    const progress = await lastValueFrom(
      computeChecksums({ database: dbCtx.db, runId, rootPath: tmpTree.dir }, {
        algorithm: 'md5',
        eachFile: true,
      })
    );

    expect(progress.processed).toBeGreaterThanOrEqual(3);

    const result = await dbCtx.db.pg.query<{ c: number }>(
      `SELECT COUNT(*) as c FROM file_checksums WHERE run_id = $1 AND md5 IS NOT NULL`,
      [runId]
    );
    expect(Number(result.rows[0].c)).toBeGreaterThanOrEqual(3);
  });

  it('duplicate group optimization assigns the same checksum to all files in a group', async () => {
    // dup1 and dup2 share the same xxHash64 → processDuplicateGroups hashes dup1 once
    // and propagates the result to dup2 without a second disk read.
    await lastValueFrom(
      computeChecksums({ database: dbCtx.db, runId, rootPath: tmpTree.dir }, {
        algorithm: 'sha256',
        eachFile: false,
      })
    );

    const result = await dbCtx.db.pg.query<{ path: string; sha256: string }>(
      `SELECT path, sha256 FROM file_checksums WHERE run_id = $1 AND sha256 IS NOT NULL`,
      [runId]
    );

    const dup1 = result.rows.find(r => r.path.includes('dup1'));
    const dup2 = result.rows.find(r => r.path.includes('dup2'));

    expect(dup1?.sha256).toBeDefined();
    expect(dup2?.sha256).toBeDefined();
    expect(dup1?.sha256).toBe(dup2?.sha256);
  });

  it('xxhash64 optimization copies existing hashes from files.hash to file_checksums.xxhash64', async () => {
    // Files that already have an xxHash64 in files.hash (dup1, dup2) get copied via
    // INSERT...SELECT — no file reads required. unique.txt gets computed separately.
    await lastValueFrom(
      computeChecksums({ database: dbCtx.db, runId, rootPath: tmpTree.dir }, {
        algorithm: 'xxhash64',
        eachFile: false,
      })
    );

    // For files that had a hash in the files table, xxhash64 in checksums must match
    const result = await dbCtx.db.pg.query<{
      path: string;
      hash: string | null;
      xxhash64: string | null;
    }>(
      `SELECT f.path, f.hash, c.xxhash64
       FROM files f
       LEFT JOIN file_checksums c ON f.run_id = c.run_id AND f.path = c.path
       WHERE f.run_id = $1 AND f.is_directory = false AND f.hash IS NOT NULL`,
      [runId]
    );

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.xxhash64).toBe(row.hash);
    }
  });

  it('skips a file with a read error and continues (catchError → EMPTY in processUniqueFiles)', async () => {
    // Insert a fake file entry with a unique content_size so it goes through processUniqueFiles.
    // The file does not exist on disk, triggering computeFileChecksum to throw → EMPTY.
    await lastValueFrom(
      insertFileBatch(dbCtx.db, [
        makeFileRow(runId, 'ghost_nonexistent.dat', 99999, null),
      ])
    );

    // Must not throw
    await expect(
      lastValueFrom(
        computeChecksums({ database: dbCtx.db, runId, rootPath: tmpTree.dir }, {
          algorithm: 'md5',
          eachFile: false,
        })
      )
    ).resolves.toBeDefined();

    // The ghost file must have no checksum entry
    const result = await dbCtx.db.pg.query<{ path: string }>(
      `SELECT path FROM file_checksums WHERE run_id = $1 AND md5 IS NOT NULL`,
      [runId]
    );
    const paths = result.rows.map(r => r.path);
    expect(paths).not.toContain('ghost_nonexistent.dat');

    // The real files still got checksummed
    expect(paths.some(p => p.includes('dup1') || p.includes('dup2'))).toBe(true);
  });

  it('calls context.onProgress with phase "checksum" during computation', async () => {
    const calls: Array<{ phase: string; processed: number; total: number | null }> = [];

    await lastValueFrom(
      computeChecksums(
        {
          database: dbCtx.db,
          runId,
          rootPath: tmpTree.dir,
          onProgress: (phase, processed, total) => calls.push({ phase, processed, total }),
        },
        { algorithm: 'md5', eachFile: true }
      )
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.phase === 'checksum')).toBe(true);
    expect(calls[calls.length - 1].processed).toBeGreaterThan(0);
  });
});
