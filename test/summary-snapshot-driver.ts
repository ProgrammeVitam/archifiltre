/**
 * Driver: verify summaries survive a rebuild (new run_id) via the durable snapshot, and that a
 * changed folder is NOT adopted (content-signature gate). Run: bun run test/summary-snapshot-driver.ts
 */
import { rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { createDatabase, closeDatabase } from '@lib/database.ts';
import {
  saveDescription,
  handleDescribePrepare,
  ensureDescriptionTable,
} from '@extensions/ai-describe/index.ts';
import {
  summarySnapshotFileFor,
  writeSummarySnapshot,
} from '@extensions/ai-describe/summary-snapshot.ts';

const ROOT = '/tmp/summary-snapshot-driver-root';
let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const F = (runId: string, p: string, isDir: boolean) =>
  // physical_size / mtime / is_directory / is_hidden / is_system are NOT NULL in the real schema.
  [runId, p, isDir ? 0 : 100, 0, isDir, false, false] as const;

async function seedRun(db: Awaited<ReturnType<typeof createDatabase>>, runId: string, fileCount: number) {
  await db.pg.query(
    `INSERT INTO scan_metadata (run_id, root_path, started_at) VALUES ($1, $2, 0)`,
    [runId, ROOT]
  );
  const ins = `INSERT INTO files (run_id, path, physical_size, mtime, is_directory, is_hidden, is_system) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  await db.pg.query(ins, F(runId, 'Histoire', true) as unknown as unknown[]);
  for (let i = 0; i < fileCount; i++) {
    await db.pg.query(ins, F(runId, `Histoire/f${i}.pdf`, false) as unknown as unknown[]);
  }
}

async function main() {
  rmSync(summarySnapshotFileFor(ROOT), { force: true });
  const db = await createDatabase('summary-snapshot-driver');
  try {
    await ensureDescriptionTable(db);
    // Fresh start — the dataDir persists across runs.
    await db.pg.exec(`DELETE FROM directory_descriptions; DELETE FROM files; DELETE FROM scan_metadata;`);
    // ── Run 1: generate + save a summary for Histoire (writes the snapshot) ──
    await seedRun(db, 'run-1', 5);
    await saveDescription(db, 'run-1', 'Histoire', 'Course materials on history.', 'qwen2.5-1.5b', 'en');
    await writeSummarySnapshot(db, 'run-1'); // saveDescription fires this fire-and-forget; flush deterministically
    ok(existsSync(summarySnapshotFileFor(ROOT)), 'snapshot file written on saveDescription');

    // ── Rebuild: a fresh run (new run_id), SAME folder content ──
    await seedRun(db, 'run-2', 5);
    const adopted = await handleDescribePrepare(db, 'run-2', 'Histoire', { provider: 'local', lang: 'en' }, false);
    ok(!!adopted.cached, 'unchanged folder → summary ADOPTED under the new run (survived rebuild)');
    ok(adopted.cached?.description === 'Course materials on history.', 'adopted the exact stored summary');

    // Adopted row is now a normal cache hit in the new run.
    const c = await db.pg.query<{ n: string }>(
      `SELECT COUNT(*) n FROM directory_descriptions WHERE run_id = 'run-2' AND path = 'Histoire'`,
      []
    );
    ok(Number(c.rows[0]?.n) === 1, 're-stamped under the new run_id (later lookups hit the DB)');

    // ── Staleness gate: a fresh run whose folder CHANGED (6 files, not 5) → must NOT adopt ──
    await seedRun(db, 'run-3', 6);
    const changed = await handleDescribePrepare(db, 'run-3', 'Histoire', { provider: 'local', lang: 'en' }, true);
    ok(!changed.cached, 'changed folder → NOT adopted (content-signature gate)');
    ok(changed.error === 'scan-in-progress', 'changed folder falls through to normal describe path');

    // Different language → not adopted (lang gate).
    await seedRun(db, 'run-4', 5);
    const otherLang = await handleDescribePrepare(db, 'run-4', 'Histoire', { provider: 'local', lang: 'fr' }, true);
    ok(!otherLang.cached, 'different language → NOT adopted');
  } finally {
    await closeDatabase(db);
    rmSync(summarySnapshotFileFor(ROOT), { force: true });
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
