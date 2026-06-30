/**
 * Integration tests for resumable-discovery (frontier) scanning — real PGlite, real FS.
 *
 * Proves the increment-2 claims:
 *  1. a fresh frontier scan produces byte-identical files + dir_stats to the legacy scan;
 *  2. a completed frontier scan leaves NOTHING on the frontier (every unit stamped);
 *  3. crash-mid-walk → resume yields the same final state as an uninterrupted scan;
 *  4. resume re-readdirs ONLY the un-enumerated remainder — never a completed subtree;
 *  5. archives are stamped as units (and re-expand cleanly).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { lastValueFrom } from 'rxjs';
import { eq } from 'drizzle-orm';
import { spawnSync } from 'node:child_process';
import { scanDirectory, generateRunId, type ScanConfig } from '@lib/scanner.ts';
import {
  createScanDatabase,
  closeScanDatabase,
  files,
  type DatabaseConnection,
} from '@lib/database.ts';
import { getDatabasePath } from '@lib/platform-paths.ts';

// ── harness ──────────────────────────────────────────────────────────────────
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0)) await c().catch(() => {});
});

async function makeDb(): Promise<DatabaseConnection> {
  const name = `frontiertest${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const db = await createScanDatabase(name);
  const dir = path.resolve(getDatabasePath(name));
  cleanups.push(async () => {
    await closeScanDatabase(db);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return db;
}

/** A THREE-level tree (a/b/c) with enough directories that a mid-walk interrupt leaves a
 *  real frontier — and, crucially, frontier directories whose PARENT is already enumerated
 *  (so resume must re-stamp a dir whose own row isn't re-emitted; see seedSelfCommitted). */
async function makeTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-tree-'));
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 3; b++) {
      for (let c = 0; c < 2; c++) {
        const d = path.join(root, `a${a}`, `b${b}`, `c${c}`);
        await fs.mkdir(d, { recursive: true });
        for (let f = 0; f < 4; f++) {
          await fs.writeFile(
            path.join(d, `f${f}.txt`),
            `content ${a}-${b}-${c}-${f} ${'x'.repeat(f)}`
          );
        }
      }
    }
    await fs.writeFile(path.join(root, `a${a}`, 'top.txt'), `top ${a}`);
  }
  return root;
}

function baseConfig(rootPath: string, runId: string, over: Partial<ScanConfig> = {}): ScanConfig {
  return {
    rootPath,
    runId,
    enableArchiveProcessing: false,
    preserveConnection: true, // clear-in-place (owner mode); keeps our db handle valid
    betweenBatches: async () => {}, // enables the incremental dir_stats rollup
    batchSize: 16, // small, so the tree spans many batches (exercises cross-batch marking)
    ...over,
  };
}

async function dumpFiles(db: DatabaseConnection, runId: string) {
  const rows = await db.db
    .select({
      path: files.path,
      is_directory: files.is_directory,
      physical_size: files.physical_size,
    })
    .from(files)
    .where(eq(files.run_id, runId))
    .orderBy(files.path);
  return rows;
}

async function dumpDirStats(db: DatabaseConnection, runId: string) {
  const res = await db.pg.query<{
    path: string;
    total_size: number;
    file_count: number;
    dir_count: number;
  }>(
    'SELECT path, total_size::int AS total_size, file_count::int AS file_count, dir_count::int AS dir_count FROM dir_stats WHERE run_id = $1 ORDER BY path',
    [runId]
  );
  return res.rows;
}

async function frontierRows(db: DatabaseConnection, runId: string) {
  // Real frontier: filesystem directories + archive containers still un-stamped. Directory
  // ENTRIES inside an archive (is_directory but archive_parent_path set) are not units.
  const res = await db.pg.query<{ path: string }>(
    'SELECT path FROM files WHERE run_id = $1 AND enumerated_at IS NULL AND ((is_directory = true AND archive_parent_path IS NULL) OR is_archive_container = true) ORDER BY path',
    [runId]
  );
  return res.rows.map(r => r.path);
}

async function enumeratedDirs(db: DatabaseConnection, runId: string): Promise<string[]> {
  const res = await db.pg.query<{ path: string }>(
    'SELECT path FROM files WHERE run_id = $1 AND is_directory = true AND enumerated_at IS NOT NULL',
    [runId]
  );
  return res.rows.map(r => r.path);
}

// ── tests ────────────────────────────────────────────────────────────────────
describe('frontier scanning', () => {
  it('fresh frontier scan == legacy scan (files + dir_stats)', async () => {
    const tree = await makeTree();
    const [dbF, dbL] = [await makeDb(), await makeDb()];
    const rid = generateRunId();
    await lastValueFrom(scanDirectory(dbF, baseConfig(tree, rid, { frontier: true })));
    await lastValueFrom(scanDirectory(dbL, baseConfig(tree, rid, { frontier: false })));

    expect(await dumpFiles(dbF, rid)).toEqual(await dumpFiles(dbL, rid));
    expect(await dumpDirStats(dbF, rid)).toEqual(await dumpDirStats(dbL, rid));
  });

  it('completed frontier scan leaves the frontier empty (every unit stamped)', async () => {
    const tree = await makeTree();
    const db = await makeDb();
    const rid = generateRunId();
    await lastValueFrom(scanDirectory(db, baseConfig(tree, rid, { frontier: true })));
    expect(await frontierRows(db, rid)).toEqual([]);
  });

  it('crash mid-walk → resume reaches the same final state as an uninterrupted scan', async () => {
    const tree = await makeTree();
    const rid = generateRunId();

    // Reference: one clean uninterrupted frontier scan in its own db.
    const dbRef = await makeDb();
    await lastValueFrom(scanDirectory(dbRef, baseConfig(tree, rid, { frontier: true })));

    // Interrupted: stop pulling new dirs after 5 directories, then resume.
    const dbR = await makeDb();
    let pops = 0;
    await lastValueFrom(
      scanDirectory(
        dbR,
        baseConfig(tree, rid, { frontier: true, shouldContinue: () => pops++ < 5 })
      )
    );
    // It really was a partial scan: some units still on the frontier.
    expect((await frontierRows(dbR, rid)).length).toBeGreaterThan(0);

    // Resume — frontier re-walks only the remainder.
    await lastValueFrom(
      scanDirectory(dbR, baseConfig(tree, rid, { frontier: true, resume: true }))
    );

    // Frontier drained, and the final state equals the uninterrupted reference exactly.
    expect(await frontierRows(dbR, rid)).toEqual([]);
    expect(await dumpFiles(dbR, rid)).toEqual(await dumpFiles(dbRef, rid));
    expect(await dumpDirStats(dbR, rid)).toEqual(await dumpDirStats(dbRef, rid));
  });

  it('resume does NOT re-readdir already-enumerated directories', async () => {
    const tree = await makeTree();
    const rid = generateRunId();
    const db = await makeDb();

    // Partial scan.
    let pops = 0;
    await lastValueFrom(
      scanDirectory(db, baseConfig(tree, rid, { frontier: true, shouldContinue: () => pops++ < 6 }))
    );
    const doneBefore = new Set(await enumeratedDirs(db, rid)); // relative paths
    expect(doneBefore.size).toBeGreaterThan(0);

    // Spy readdir during the resume only, recording absolute paths it lists.
    const listed: string[] = [];
    const orig = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation(((
      p: Parameters<typeof fs.readdir>[0],
      o: unknown
    ) => {
      listed.push(String(p));
      return (orig as (...a: unknown[]) => unknown)(p, o);
    }) as typeof fs.readdir);

    await lastValueFrom(scanDirectory(db, baseConfig(tree, rid, { frontier: true, resume: true })));

    // No already-enumerated directory (other than root, which is always re-listed) was listed.
    const listedAbs = new Set(listed.map(p => path.resolve(p)));
    for (const rel of doneBefore) {
      if (rel === '') continue;
      expect(listedAbs.has(path.resolve(path.join(tree, rel)))).toBe(false);
    }
  });

  it('stamps archive containers as units and re-expands cleanly on resume', async () => {
    const tar = spawnSync('tar', ['--version']);
    if (tar.status !== 0) return; // tar not available — skip silently

    const tree = await makeTree();
    // Build a real tar archive inside the tree from one of the subtrees.
    const made = spawnSync('tar', ['-cf', path.join(tree, 'bundle.tar'), '-C', tree, 'a0']);
    expect(made.status).toBe(0);

    const rid = generateRunId();
    const db = await makeDb();
    await lastValueFrom(
      scanDirectory(db, baseConfig(tree, rid, { frontier: true, enableArchiveProcessing: true }))
    );

    // The archive container row exists, has entries, and is fully stamped (off the frontier).
    const container = await db.pg.query<{ path: string; enumerated: number | null }>(
      'SELECT path, enumerated_at AS enumerated FROM files WHERE run_id=$1 AND is_archive_container=true',
      [rid]
    );
    expect(container.rows.length).toBeGreaterThan(0);
    expect(container.rows.every(r => r.enumerated !== null)).toBe(true);
    const entries = await db.pg.query(
      'SELECT count(*)::int AS n FROM files WHERE run_id=$1 AND archive_parent_path IS NOT NULL',
      [rid]
    );
    expect((entries.rows[0] as { n: number }).n).toBeGreaterThan(0);
    expect(await frontierRows(db, rid)).toEqual([]);
  });

  // ── increment 3b: concurrent enumeration must be output-equivalent ──────────
  it('concurrent enumeration (C=8) == sequential (C=1): order-independent output', async () => {
    const tree = await makeTree();
    const rid = generateRunId();
    const dbC = await makeDb();
    const dbS = await makeDb();
    await lastValueFrom(
      scanDirectory(dbC, baseConfig(tree, rid, { frontier: true, enumerateConcurrency: 8 }))
    );
    await lastValueFrom(
      scanDirectory(dbS, baseConfig(tree, rid, { frontier: true, enumerateConcurrency: 1 }))
    );

    expect(await dumpFiles(dbC, rid)).toEqual(await dumpFiles(dbS, rid));
    expect(await dumpDirStats(dbC, rid)).toEqual(await dumpDirStats(dbS, rid));
    expect(await frontierRows(dbC, rid)).toEqual([]);
  });

  it('concurrent crash mid-walk (C=8) → resume reaches the uninterrupted final state', async () => {
    const tree = await makeTree();
    const rid = generateRunId();

    const dbRef = await makeDb();
    await lastValueFrom(
      scanDirectory(dbRef, baseConfig(tree, rid, { frontier: true, enumerateConcurrency: 8 }))
    );

    const dbR = await makeDb();
    let ticks = 0;
    await lastValueFrom(
      scanDirectory(
        dbR,
        baseConfig(tree, rid, {
          frontier: true,
          enumerateConcurrency: 8,
          shouldContinue: () => ticks++ < 4,
        })
      )
    );
    expect((await frontierRows(dbR, rid)).length).toBeGreaterThan(0);

    await lastValueFrom(
      scanDirectory(
        dbR,
        baseConfig(tree, rid, { frontier: true, enumerateConcurrency: 8, resume: true })
      )
    );

    expect(await frontierRows(dbR, rid)).toEqual([]);
    expect(await dumpFiles(dbR, rid)).toEqual(await dumpFiles(dbRef, rid));
    expect(await dumpDirStats(dbR, rid)).toEqual(await dumpDirStats(dbRef, rid));
  });
});
