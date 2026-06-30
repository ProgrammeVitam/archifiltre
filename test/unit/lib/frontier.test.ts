/**
 * Unit tests for the resumable-discovery frontier accounting (src/lib/frontier.ts).
 *
 * The invariant under test: a unit is only ever returned for stamping once ALL its
 * children AND its own row have durably committed — never before. These are pure,
 * deterministic, no DB/FS.
 */
import { describe, it, expect } from 'vitest';
import { Frontier, unitOf } from '@lib/frontier.ts';

const dir = (path: string) => ({ path, is_directory: true });
const file = (path: string) => ({ path, is_directory: false });

describe('unitOf', () => {
  it('maps a file to its parent directory', () => {
    expect(unitOf({ path: 'a/b/c.txt' })).toBe('a/b');
  });
  it('maps a top-level entry to the root unit ""', () => {
    expect(unitOf({ path: 'a' })).toBe('');
  });
  it('maps an archive entry to its container, not its textual parent', () => {
    expect(unitOf({ path: 'x.zip/inner/f', archive_parent_path: 'x.zip' })).toBe('x.zip');
  });
});

describe('Frontier', () => {
  it('stamps a directory only after its children AND its own row commit', () => {
    const f = new Frontier();
    // children committed, but producer not done yet → not ready
    f.rowsCommitted([file('a/f1'), file('a/f2')]);
    expect(f.takeReady()).toEqual([]);
    // producer announces 2 children → still need a's OWN row committed
    f.unitComplete('a', 2);
    expect(f.takeReady()).toEqual([]);
    // a's own dir row commits (as a child of root) → now ready
    f.rowsCommitted([dir('a')]);
    expect(f.takeReady()).toEqual(['a']);
    // never twice
    expect(f.takeReady()).toEqual([]);
  });

  it('handles late producer-completion (children commit before unitComplete)', () => {
    const f = new Frontier();
    f.rowsCommitted([dir('a')]); // a's own row
    f.rowsCommitted([file('a/f1'), file('a/f2'), file('a/f3')]);
    expect(f.takeReady()).toEqual([]); // expected unknown
    f.unitComplete('a', 3);
    expect(f.takeReady()).toEqual(['a']);
  });

  it('waits for children spread across multiple batches', () => {
    const f = new Frontier();
    f.rowsCommitted([dir('a')]);
    f.unitComplete('a', 3);
    f.rowsCommitted([file('a/f1'), file('a/f2')]); // 2 of 3
    expect(f.takeReady()).toEqual([]);
    f.rowsCommitted([file('a/f3')]); // 3 of 3
    expect(f.takeReady()).toEqual(['a']);
  });

  it('stamps an empty directory only once its own row commits (0-child hole)', () => {
    const f = new Frontier();
    f.unitComplete('a/empty', 0); // producer done, 0 children
    expect(f.takeReady()).toEqual([]); // own row not committed yet → must NOT stamp
    f.rowsCommitted([dir('a/empty')]);
    expect(f.takeReady()).toEqual(['a/empty']);
  });

  it('keys archive entries by their container', () => {
    const f = new Frontier();
    f.rowsCommitted([{ path: 'x.zip', is_directory: false, is_archive_container: true }]);
    f.unitComplete('x.zip', 2);
    f.rowsCommitted([
      { path: 'x.zip/a', is_directory: false, archive_parent_path: 'x.zip' },
      { path: 'x.zip/b', is_directory: false, archive_parent_path: 'x.zip' },
    ]);
    expect(f.takeReady()).toEqual(['x.zip']);
  });

  it('never returns the root unit ""', () => {
    const f = new Frontier();
    f.unitComplete('', 5);
    f.rowsCommitted([file('top1'), file('top2')]); // unit '' for both
    expect(f.takeReady()).toEqual([]);
  });
});
