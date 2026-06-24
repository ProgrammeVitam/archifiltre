/**
 * Tests for src/extensions/enrichment/index.ts
 *
 * Focus on the business logic that is not obvious from the SQL:
 * - alias auto-clears when empty or equal to the element's original name
 * - comment clears when empty/whitespace
 * - deleting a tag cascades to its assignments
 * - get_enrichment returns a complete, consistent snapshot
 * - delete-tag operations (relocated from the former delete-tags extension)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  ensureEnrichmentTables,
  handleSetAlias,
  handleSetComment,
  handleCreateTag,
  handleRenameTag,
  handleDeleteTag,
  handleAssignTag,
  handleUnassignTag,
  handleSetDeleteTag,
  handleRemoveDeleteTag,
  handleGetDeleteTags,
  handleGetEnrichment,
  handleGetElementEnrichment,
} from '@extensions/enrichment/index.ts';
import {
  createScanDatabase,
  closeScanDatabase,
  type DatabaseConnection,
} from '@lib/database.ts';
import { getDatabasePath } from '@lib/platform-paths.ts';

const RUN_ID = 'test-run';

async function createTestDb(name: string): Promise<{
  db: DatabaseConnection;
  cleanup: () => Promise<void>;
}> {
  const db = await createScanDatabase(name);
  const dbDir = path.resolve(getDatabasePath(name));
  await ensureEnrichmentTables(db);
  return {
    db,
    async cleanup() {
      await closeScanDatabase(db);
      await fs.rm(dbDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

describe('enrichment extension', () => {
  let db: DatabaseConnection;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb(`enrichment-${crypto.randomUUID()}`));
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('aliases', () => {
    it('stores a meaningful alias', async () => {
      const result = await handleSetAlias(db, RUN_ID, 'docs/report.pdf', 'Final report');
      expect(result.alias).toBe('Final report');

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.aliases).toEqual([{ path: 'docs/report.pdf', alias: 'Final report' }]);
    });

    it('trims surrounding whitespace', async () => {
      const result = await handleSetAlias(db, RUN_ID, 'a/b.txt', '  spaced  ');
      expect(result.alias).toBe('spaced');
    });

    it('clears the alias when empty', async () => {
      await handleSetAlias(db, RUN_ID, 'a/b.txt', 'something');
      const result = await handleSetAlias(db, RUN_ID, 'a/b.txt', '   ');
      expect(result.alias).toBeNull();

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.aliases).toHaveLength(0);
    });

    it('clears the alias when equal to the original (basename) name', async () => {
      const result = await handleSetAlias(db, RUN_ID, 'docs/report.pdf', 'report.pdf');
      expect(result.alias).toBeNull();

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.aliases).toHaveLength(0);
    });

    it('overwrites an existing alias', async () => {
      await handleSetAlias(db, RUN_ID, 'a/b.txt', 'first');
      await handleSetAlias(db, RUN_ID, 'a/b.txt', 'second');
      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.aliases).toEqual([{ path: 'a/b.txt', alias: 'second' }]);
    });
  });

  describe('comments', () => {
    it('stores a comment preserving internal whitespace', async () => {
      const result = await handleSetComment(db, RUN_ID, 'a/b.txt', 'line one\n  line two');
      expect(result.comment).toBe('line one\n  line two');
    });

    it('clears a comment when whitespace-only', async () => {
      await handleSetComment(db, RUN_ID, 'a/b.txt', 'note');
      const result = await handleSetComment(db, RUN_ID, 'a/b.txt', '   \n ');
      expect(result.comment).toBeNull();

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.comments).toHaveLength(0);
    });
  });

  describe('tags', () => {
    it('creates a tag with a generated id', async () => {
      const tag = await handleCreateTag(db, RUN_ID, 'Important');
      expect(tag.tag_id).toBeTruthy();
      expect(tag.name).toBe('Important');

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.tags).toEqual([{ tag_id: tag.tag_id, name: 'Important' }]);
    });

    it('renames a tag without dropping assignments', async () => {
      const tag = await handleCreateTag(db, RUN_ID, 'Old');
      await handleAssignTag(db, RUN_ID, tag.tag_id, 'a/b.txt');

      const renamed = await handleRenameTag(db, RUN_ID, tag.tag_id, 'New');
      expect(renamed.renamed).toBe(true);

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.tags).toEqual([{ tag_id: tag.tag_id, name: 'New' }]);
      expect(enrichment.assignments).toEqual([{ tag_id: tag.tag_id, path: 'a/b.txt' }]);
    });

    it('assigns the same tag to multiple paths and is idempotent', async () => {
      const tag = await handleCreateTag(db, RUN_ID, 'Shared');
      await handleAssignTag(db, RUN_ID, tag.tag_id, 'a.txt');
      await handleAssignTag(db, RUN_ID, tag.tag_id, 'b.txt');
      await handleAssignTag(db, RUN_ID, tag.tag_id, 'a.txt'); // duplicate

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.assignments).toHaveLength(2);
    });

    it('unassigns a tag from a path', async () => {
      const tag = await handleCreateTag(db, RUN_ID, 'T');
      await handleAssignTag(db, RUN_ID, tag.tag_id, 'a.txt');
      const res = await handleUnassignTag(db, RUN_ID, tag.tag_id, 'a.txt');
      expect(res.unassigned).toBe(true);

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.assignments).toHaveLength(0);
    });

    it('cascades assignment removal when a tag is deleted', async () => {
      const tag = await handleCreateTag(db, RUN_ID, 'Doomed');
      await handleAssignTag(db, RUN_ID, tag.tag_id, 'a.txt');
      await handleAssignTag(db, RUN_ID, tag.tag_id, 'b.txt');

      const res = await handleDeleteTag(db, RUN_ID, tag.tag_id);
      expect(res.deleted).toBe(true);

      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.tags).toHaveLength(0);
      expect(enrichment.assignments).toHaveLength(0);
    });
  });

  describe('delete tags (relocated)', () => {
    it('marks, lists and removes a deletion tag', async () => {
      await handleSetDeleteTag(db, RUN_ID, 'a/b.txt');
      let tags = await handleGetDeleteTags(db, RUN_ID);
      expect(tags.tags.map(t => t.path)).toEqual(['a/b.txt']);

      const removed = await handleRemoveDeleteTag(db, RUN_ID, 'a/b.txt');
      expect(removed.removed).toBe(true);

      tags = await handleGetDeleteTags(db, RUN_ID);
      expect(tags.tags).toHaveLength(0);
    });

    it('surfaces delete tags in the enrichment snapshot', async () => {
      await handleSetDeleteTag(db, RUN_ID, 'trash/old.txt');
      const enrichment = await handleGetEnrichment(db, RUN_ID);
      expect(enrichment.deleteTags.map(t => t.path)).toEqual(['trash/old.txt']);
    });

    // Guards the exact cascade predicate used by the tree/files visualization
    // joins (query.ts). Confirms PGlite supports starts_with() and that a
    // sibling sharing a name prefix is NOT treated as a descendant.
    it('cascades a directory deletion to descendants only (starts_with predicate)', async () => {
      await handleSetDeleteTag(db, RUN_ID, 'a/b');
      const res = await db.pg.query<{ path: string; tagged: boolean }>(
        `SELECT t.path,
           EXISTS (
             SELECT 1 FROM delete_tags dt
             WHERE dt.run_id = $1
               AND (dt.path = t.path OR starts_with(t.path, dt.path || '/'))
           ) AS tagged
         FROM (VALUES ('a/b'), ('a/b/c.txt'), ('a/bc.txt'), ('a/x.txt')) AS t(path)`,
        [RUN_ID]
      );
      const tagged = Object.fromEntries(res.rows.map(r => [r.path, r.tagged]));
      expect(tagged['a/b']).toBe(true); // directly tagged
      expect(tagged['a/b/c.txt']).toBe(true); // descendant — cascades
      expect(tagged['a/bc.txt']).toBe(false); // sibling prefix — must NOT match
      expect(tagged['a/x.txt']).toBe(false); // unrelated
    });
  });

  describe('per-element enrichment (query-on-select)', () => {
    it('returns alias, comment and assigned tags for a path', async () => {
      await handleSetAlias(db, RUN_ID, 'docs/report.pdf', 'Final report');
      await handleSetComment(db, RUN_ID, 'docs/report.pdf', 'reviewed');
      const tag = await handleCreateTag(db, RUN_ID, 'Important');
      await handleAssignTag(db, RUN_ID, tag.tag_id, 'docs/report.pdf');

      const el = await handleGetElementEnrichment(db, RUN_ID, 'docs/report.pdf');
      expect(el.alias).toBe('Final report');
      expect(el.comment).toBe('reviewed');
      expect(el.tagIds).toEqual([tag.tag_id]);
      expect(el.directlyTaggedForDeletion).toBe(false);
      expect(el.ancestorTaggedForDeletion).toBe(false);
    });

    it('reports an empty element with all defaults', async () => {
      const el = await handleGetElementEnrichment(db, RUN_ID, 'untouched.txt');
      expect(el).toEqual({
        alias: null,
        comment: null,
        tagIds: [],
        directlyTaggedForDeletion: false,
        ancestorTaggedForDeletion: false,
        pathAliases: {},
      });
    });

    it('returns aliases for the element and its ancestors (for the breadcrumb)', async () => {
      await handleSetAlias(db, RUN_ID, 'docs', 'Documents'); // ancestor alias
      await handleSetAlias(db, RUN_ID, 'docs/report.pdf', 'Final report'); // self alias
      // docs/sub has no alias → absent from the map

      const el = await handleGetElementEnrichment(db, RUN_ID, 'docs/report.pdf');
      expect(el.alias).toBe('Final report');
      expect(el.pathAliases).toEqual({
        docs: 'Documents',
        'docs/report.pdf': 'Final report',
      });
    });

    it('detects a directly applied deletion mark', async () => {
      await handleSetDeleteTag(db, RUN_ID, 'a/b.txt');
      const el = await handleGetElementEnrichment(db, RUN_ID, 'a/b.txt');
      expect(el.directlyTaggedForDeletion).toBe(true);
      expect(el.ancestorTaggedForDeletion).toBe(false);
    });

    it('detects an ancestor directory deletion mark (cascade)', async () => {
      await handleSetDeleteTag(db, RUN_ID, 'a/b');
      const el = await handleGetElementEnrichment(db, RUN_ID, 'a/b/c/file.txt');
      expect(el.directlyTaggedForDeletion).toBe(false);
      expect(el.ancestorTaggedForDeletion).toBe(true);
    });
  });

  describe('run isolation', () => {
    it('scopes enrichment to its run_id', async () => {
      await handleSetAlias(db, 'run-A', 'a.txt', 'alias-A');
      await handleSetAlias(db, 'run-B', 'a.txt', 'alias-B');

      const a = await handleGetEnrichment(db, 'run-A');
      const b = await handleGetEnrichment(db, 'run-B');
      expect(a.aliases).toEqual([{ path: 'a.txt', alias: 'alias-A' }]);
      expect(b.aliases).toEqual([{ path: 'a.txt', alias: 'alias-B' }]);
    });
  });
});
