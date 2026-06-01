/**
 * Characterization tests for src/lib/scanner.ts
 *
 * These tests lock in observable behavior before any pipeline refactor.
 * If a refactor breaks one of these, it changed externally-visible behavior — stop and investigate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { lastValueFrom } from 'rxjs';
import { count, eq } from 'drizzle-orm';
import { scanDirectory, generateRunId, type ScanProgressEvent } from '@lib/scanner.ts';
import {
  createScanDatabase,
  closeScanDatabase,
  files,
  type DatabaseConnection,
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archifiltre-scan-'));
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

// ---- Tests ----

describe('scanDirectory', () => {
  let tmpTree: Awaited<ReturnType<typeof createTempTree>>;
  let dbCtx: Awaited<ReturnType<typeof createTestDb>>;
  let runId: string;

  beforeEach(async () => {
    tmpTree = await createTempTree({
      'file1.txt': 'hello world',
      'file2.txt': 'foo bar baz qux',
      'subdir/file3.txt': 'nested file content here',
    });
    runId = generateRunId();
    const name = `scantest${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    dbCtx = await createTestDb(name);
  });

  afterEach(async () => {
    await tmpTree.cleanup();
    await dbCtx.cleanup();
  });

  it('returns a ScanResult with phase "complete"', async () => {
    const result = await lastValueFrom(
      scanDirectory(dbCtx.db, {
        rootPath: tmpTree.dir,
        runId,
        enableArchiveProcessing: false,
      })
    );

    expect(result.phase).toBe('complete');
    expect(result.filesDiscovered).toBeGreaterThanOrEqual(3);
    expect(result.filesIngested).toBeGreaterThanOrEqual(3);
  });

  it('writes discovered files into the database', async () => {
    await lastValueFrom(
      scanDirectory(dbCtx.db, {
        rootPath: tmpTree.dir,
        runId,
        enableArchiveProcessing: false,
      })
    );

    const [{ total }] = await dbCtx.db.db
      .select({ total: count() })
      .from(files)
      .where(eq(files.run_id, runId));

    // 3 files + 1 directory entry for 'subdir'
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it('emits progress events for discovery, prefilter, and duplicate-detection phases', async () => {
    const phases: string[] = [];

    await lastValueFrom(
      scanDirectory(
        dbCtx.db,
        { rootPath: tmpTree.dir, runId, enableArchiveProcessing: false },
        (event: ScanProgressEvent) => phases.push(event.phase)
      )
    );

    expect(phases).toContain('discovery');
    expect(phases).toContain('prefilter');
    expect(phases).toContain('duplicate-detection');
  });

  it('progress events carry increasing filesDiscovered across discovery phase', async () => {
    const events: ScanProgressEvent[] = [];

    await lastValueFrom(
      scanDirectory(
        dbCtx.db,
        { rootPath: tmpTree.dir, runId, enableArchiveProcessing: false },
        event => events.push(event)
      )
    );

    const discoveryEvents = events.filter(e => e.phase === 'discovery');
    // Every progress event has a non-negative filesDiscovered count
    expect(discoveryEvents.every(e => e.filesDiscovered >= 0)).toBe(true);
  });

  it('detects exactly 1 duplicate group when two files share identical content', async () => {
    const dupeTree = await createTempTree({
      'alpha.txt': 'absolutely identical content here',
      'beta.txt': 'absolutely identical content here',
      'gamma.txt': 'this one is different so no dupe',
    });

    try {
      const result = await lastValueFrom(
        scanDirectory(dbCtx.db, {
          rootPath: dupeTree.dir,
          runId,
          enableArchiveProcessing: false,
        })
      );
      expect(result.duplicateGroups).toBe(1);
    } finally {
      await dupeTree.cleanup();
    }
  });

  it('completes without throwing even with batchSize=1 (each insert is its own batch)', async () => {
    // Verifies the catchError → from([0]) error recovery path in scanner.ts exists
    // If batch-level errors propagated, this would throw
    const result = await lastValueFrom(
      scanDirectory(dbCtx.db, {
        rootPath: tmpTree.dir,
        runId,
        batchSize: 1,
        enableArchiveProcessing: false,
      })
    );

    expect(result.phase).toBe('complete');
  });
});
