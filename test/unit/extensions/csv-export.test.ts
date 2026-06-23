/**
 * Characterization tests for src/extensions/csv-export.ts
 *
 * Error semantics captured here:
 * - Batch fetch error inside getFilesWithHashesBatched: catchError → EMPTY (pipeline stops,
 *   partial CSV on disk, no error thrown to caller)
 * - Top-level error (e.g. file open fails): re-thrown via catchError → throw
 * - Empty DB: defaultIfEmpty(0) → CSV contains only the header, exportToCsv resolves to 0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { lastValueFrom } from 'rxjs';
import { exportToCsv } from '@extensions/csv-export.ts';
import { scanDirectory, generateRunId } from '@lib/scanner.ts';
import {
  createScanDatabase,
  closeScanDatabase,
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archifiltre-csv-'));
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

describe('exportToCsv', () => {
  let tmpTree: Awaited<ReturnType<typeof createTempTree>>;
  let dbCtx: Awaited<ReturnType<typeof createTestDb>>;
  let outDir: string;
  let runId: string;

  beforeEach(async () => {
    tmpTree = await createTempTree({
      'alpha.txt': 'alpha file content',
      'beta.txt': 'beta file content here',
      'gamma.txt': 'gamma file content third',
    });

    const name = `csvtest${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
    dbCtx = await createTestDb(name);
    runId = generateRunId();
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archifiltre-csv-out-'));

    await lastValueFrom(
      scanDirectory(dbCtx.db, {
        rootPath: tmpTree.dir,
        runId,
        enableArchiveProcessing: false,
      })
    );
  });

  afterEach(async () => {
    await tmpTree.cleanup();
    await dbCtx.cleanup();
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  });

  it('creates a CSV file with the correct base header', async () => {
    const outFile = path.join(outDir, 'scan.csv');

    await lastValueFrom(
      exportToCsv({ database: dbCtx.db, runId, rootPath: '' }, outFile, { populatedChecksums: [] })
    );

    const content = await fs.readFile(outFile, 'utf-8');
    const firstLine = content.split('\n')[0];

    expect(firstLine).toBe(
      'path,type,physical_size,content_size,modified,is_hidden,is_archive,archive_format,archive_parent,archive_depth'
    );
  });

  it('returns the total number of rows written (files + directories)', async () => {
    const outFile = path.join(outDir, 'scan.csv');

    const total = await lastValueFrom(
      exportToCsv({ database: dbCtx.db, runId, rootPath: '' }, outFile, { populatedChecksums: [] })
    );

    // 3 files scanned; total >= 3
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it('CSV row count matches header + data lines in the output file', async () => {
    const outFile = path.join(outDir, 'scan.csv');

    const total = await lastValueFrom(
      exportToCsv({ database: dbCtx.db, runId, rootPath: '' }, outFile, { populatedChecksums: [] })
    );

    const content = await fs.readFile(outFile, 'utf-8');
    // Split and filter blank trailing line from final newline
    const dataLines = content.split('\n').filter(l => l.length > 0).slice(1); // skip header

    expect(dataLines.length).toBe(total);
  });

  it('includes a checksum column in the header when populatedChecksums is provided', async () => {
    // When populatedChecksums is non-empty, the header always includes those columns.
    // Note: if file_checksums table does not exist, the batch JOIN silently returns EMPTY
    // (catchError → EMPTY in getFilesWithHashesBatched), so 0 data rows are written,
    // but the header is still correct and exportToCsv resolves with 0 (not throws).
    const outFile = path.join(outDir, 'with-checksums.csv');

    await lastValueFrom(
      exportToCsv({ database: dbCtx.db, runId, rootPath: '' }, outFile, {
        populatedChecksums: ['xxhash64'],
      })
    );

    const content = await fs.readFile(outFile, 'utf-8');
    const header = content.split('\n')[0];

    expect(header).toContain('xxhash64');
    // xxhash64 column appears between modified and is_hidden (BASE_COLUMNS ordering)
    expect(header).toMatch(/modified,xxhash64,is_hidden/);
  });

  it('includes a tagged_for_deletion column when hasDeleteTags is true', async () => {
    // exportToCsv queries delete_tags directly when hasDeleteTags=true, so the table must exist.
    // (hasDeleteTagsForRun handles the missing-table case in the CLI, but exportToCsv does not.)
    await dbCtx.db.pg.exec(`
      CREATE TABLE IF NOT EXISTS delete_tags (
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (run_id, path)
      )
    `);

    const outFile = path.join(outDir, 'with-delete-tags.csv');

    await lastValueFrom(
      exportToCsv({ database: dbCtx.db, runId, rootPath: '' }, outFile, {
        populatedChecksums: [],
        hasDeleteTags: true,
      })
    );

    const content = await fs.readFile(outFile, 'utf-8');
    const header = content.split('\n')[0];

    expect(header).toContain('tagged_for_deletion');
    expect(header.split(',').at(-1)).toBe('tagged_for_deletion');
  });

  it('calls context.onProgress with phase "export" as rows are written', async () => {
    const outFile = path.join(outDir, 'progress-test.csv');
    const calls: Array<{ phase: string; processed: number; total: number | null }> = [];

    await lastValueFrom(
      exportToCsv(
        {
          database: dbCtx.db,
          runId,
          rootPath: '',
          onProgress: (phase, processed, total) => calls.push({ phase, processed, total }),
        },
        outFile,
        { populatedChecksums: [] }
      )
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.phase === 'export')).toBe(true);
    expect(calls[calls.length - 1].processed).toBeGreaterThan(0);
  });

  it('appends newName, description and per-tag columns from enrichment', async () => {
    const outFile = path.join(outDir, 'enriched.csv');

    // Enrichment keyed by relative path (rootPath is ''). alpha has an alias, a
    // comma-containing comment and the "Keep" tag; beta only has "Review".
    const enrichment = {
      aliases: new Map([['alpha.txt', 'Alpha Alias']]),
      comments: new Map([['alpha.txt', 'note, with comma']]),
      tagNames: ['Keep', 'Review'],
      tagsByPath: new Map([
        ['alpha.txt', new Set(['Keep'])],
        ['beta.txt', new Set(['Review'])],
      ]),
    };

    await lastValueFrom(
      exportToCsv({ database: dbCtx.db, runId, rootPath: '' }, outFile, {
        populatedChecksums: [],
        enrichment,
      })
    );

    const content = await fs.readFile(outFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.length > 0);
    const cols = parseCsvLine(lines[0]);

    // Enrichment columns appended in order: newName, description, then tags.
    expect(cols.slice(-4)).toEqual(['newName', 'description', 'Keep', 'Review']);

    const at = (line: string, name: string) => parseCsvLine(line)[cols.indexOf(name)];

    const alpha = lines.find(l => l.startsWith('alpha.txt,'))!;
    expect(at(alpha, 'newName')).toBe('Alpha Alias');
    expect(at(alpha, 'description')).toBe('note, with comma'); // comma survived quoting
    expect(at(alpha, 'Keep')).toBe('true');
    expect(at(alpha, 'Review')).toBe('');

    const beta = lines.find(l => l.startsWith('beta.txt,'))!;
    expect(at(beta, 'newName')).toBe('');
    expect(at(beta, 'description')).toBe('');
    expect(at(beta, 'Keep')).toBe('');
    expect(at(beta, 'Review')).toBe('true');
  });
});

/** Minimal RFC-4180 line parser (handles quoted fields with commas/quotes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}
