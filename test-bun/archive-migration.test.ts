/**
 * Archive reading integration test (runs under `bun test test-bun` — the archive
 * pipeline imports PGlite/Bun-only modules that vitest's node runtime cannot load).
 *
 * Pins the OBSERVED end-to-end behavior of archive scanning + extraction against a
 * real zip fixture (bsdtar: nested dirs, a UTF-8 name, a 0-byte file, a binary blob):
 * the exact entry set a scan reports (paths, sizes, directory flags) and byte-identical
 * single-entry extraction. Written against the previous (memory-based libarchive WASM
 * port) implementation BEFORE the streamarchive migration, and must stay green across it.
 *
 * UTF8_NAMES_CORRECT documents one known divergence: the previous port's getPathname()
 * mangled non-ASCII names (`données.txt` came back as `donn�es.txt`, making that entry
 * unextractable — a real pre-existing bug). streamarchive decodes names correctly, so
 * the flag flipped to true with the migration; the mangled behavior was pinned while false.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createScanDatabase, closeDatabase, type DatabaseConnection } from '@lib/database.ts';
import { getDatabasePath } from '@lib/platform-paths.ts';
import { scanDirectory, type ScanConfig } from '@lib/scanner.ts';
import { readFileContent } from '@lib/file-reader.ts';

// Flip with the streamarchive migration (see header). While false, the test asserts the
// previous port's behavior: a mangled UTF-8 name and failing extraction for that entry.
const UTF8_NAMES_CORRECT = true;

const DB = 'archmigtest';
const RUN_ID = 'run-archmig';

let fixtureDir: string;
let rootDir: string; // the scanned root (contains test.zip)
let deepBytes: Buffer;
let utf8Bytes: Buffer;
let blobBytes: Buffer;
let db: DatabaseConnection;
let rows: Array<{
  path: string;
  physical_size: number;
  content_size: number | null;
  is_directory: boolean;
}>;

beforeAll(async () => {
  // ── Fixture: src tree → test.zip at the scan root ──
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'archmig-'));
  const srcDir = path.join(fixtureDir, 'src');
  rootDir = path.join(fixtureDir, 'root');
  mkdirSync(path.join(srcDir, 'nested', 'dir'), { recursive: true });
  mkdirSync(rootDir, { recursive: true });

  deepBytes = Buffer.from('deep content here\n', 'utf-8');
  utf8Bytes = Buffer.from('héllo données\n', 'utf-8');
  blobBytes = Buffer.alloc(4096);
  for (let i = 0; i < blobBytes.length; i++) blobBytes[i] = i % 251; // deterministic

  writeFileSync(path.join(srcDir, 'nested', 'dir', 'deep.txt'), deepBytes);
  writeFileSync(path.join(srcDir, 'données.txt'), utf8Bytes);
  writeFileSync(path.join(srcDir, 'empty.bin'), Buffer.alloc(0));
  writeFileSync(path.join(srcDir, 'blob.bin'), blobBytes);

  const tar = spawnSync(
    'bsdtar',
    ['-cf', path.join(rootDir, 'test.zip'), '--format', 'zip', 'nested', 'données.txt', 'empty.bin', 'blob.bin'],
    { cwd: srcDir }
  );
  if (tar.status !== 0) {
    throw new Error(`bsdtar failed: ${tar.stderr?.toString()}`);
  }

  // ── Scan it (archive processing on) into a throwaway db ──
  rmSync(getDatabasePath(DB), { recursive: true, force: true });
  db = await createScanDatabase(DB);
  const cfg = {
    rootPath: rootDir,
    runId: RUN_ID,
    enableArchiveProcessing: true,
  } as ScanConfig;
  await new Promise<void>((res, rej) =>
    scanDirectory(db, cfg, () => {}).subscribe({ error: rej, complete: () => res() })
  );

  const result = await db.pg.query(
    `SELECT path, physical_size, content_size, is_directory
     FROM files WHERE run_id=$1 AND archive_parent_path IS NOT NULL ORDER BY path`,
    [RUN_ID]
  );
  rows = result.rows as typeof rows;
}, 120000);

afterAll(async () => {
  if (db) await closeDatabase(db);
  rmSync(getDatabasePath(DB), { recursive: true, force: true });
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe('archive scan (entry metadata)', () => {
  it('reports exactly the fixture entries', () => {
    expect(rows.length).toBe(6);
    const paths = rows.map((r) => r.path);
    // The five ASCII paths are identical across implementations.
    expect(paths).toContain('test.zip/blob.bin');
    expect(paths).toContain('test.zip/empty.bin');
    expect(paths).toContain('test.zip/nested/');
    expect(paths).toContain('test.zip/nested/dir/');
    expect(paths).toContain('test.zip/nested/dir/deep.txt');
    // The UTF-8 entry is present either correctly decoded (streamarchive) or mangled
    // (previous port) — exactly one row, same size either way.
    const utf8Row = rows.find((r) => /^test\.zip\/donn.+es\.txt$/.test(r.path));
    expect(utf8Row).toBeDefined();
    if (UTF8_NAMES_CORRECT) {
      expect(utf8Row!.path).toBe('test.zip/données.txt');
    }
  });

  it('reports exact decompressed sizes (content_size), zero physical size', () => {
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get('test.zip/blob.bin')!.content_size).toBe(4096);
    expect(byPath.get('test.zip/nested/dir/deep.txt')!.content_size).toBe(deepBytes.length);
    expect(byPath.get('test.zip/empty.bin')!.content_size).toBe(0);
    const utf8Row = rows.find((r) => /^test\.zip\/donn.+es\.txt$/.test(r.path))!;
    expect(utf8Row.content_size).toBe(utf8Bytes.length);
    for (const r of rows) expect(r.physical_size).toBe(0);
  });

  it('reports directories with trailing slash, null content_size', () => {
    const dirs = rows.filter((r) => r.is_directory);
    expect(dirs.map((d) => d.path).sort()).toEqual(['test.zip/nested/', 'test.zip/nested/dir/']);
    for (const d of dirs) expect(d.content_size).toBeNull();
  });
});

describe('archive extraction (single entry)', () => {
  it('extracts a nested entry byte-identical to the source', async () => {
    const buf = await readFileContent(rootDir, {
      path: 'test.zip/nested/dir/deep.txt',
      archiveParentPath: 'test.zip',
    });
    expect(Buffer.compare(buf, deepBytes)).toBe(0);
  });

  it('extracts a 0-byte entry as empty', async () => {
    const buf = await readFileContent(rootDir, {
      path: 'test.zip/empty.bin',
      archiveParentPath: 'test.zip',
    });
    expect(buf.length).toBe(0);
  });

  it('extracts binary content byte-identical to the source', async () => {
    const buf = await readFileContent(rootDir, {
      path: 'test.zip/blob.bin',
      archiveParentPath: 'test.zip',
    });
    expect(Buffer.compare(buf, blobBytes)).toBe(0);
  });

  it('throws "not found" for a missing entry', async () => {
    await expect(
      readFileContent(rootDir, { path: 'test.zip/nope.txt', archiveParentPath: 'test.zip' })
    ).rejects.toThrow(/not found/);
  });

  it(
    UTF8_NAMES_CORRECT
      ? 'extracts the UTF-8-named entry byte-identical to the source'
      : 'FAILS to extract the UTF-8-named entry (pinned pre-migration bug)',
    async () => {
      const attempt = readFileContent(rootDir, {
        path: 'test.zip/données.txt',
        archiveParentPath: 'test.zip',
      });
      if (UTF8_NAMES_CORRECT) {
        const buf = await attempt;
        expect(Buffer.compare(buf, utf8Bytes)).toBe(0);
      } else {
        // The previous port mangled the stored name, so the lookup cannot match.
        await expect(attempt).rejects.toThrow(/not found/);
      }
    }
  );
});
