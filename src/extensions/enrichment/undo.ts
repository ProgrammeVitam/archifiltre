/**
 * Undo/redo for enrichment, as an append-only operation log in PGlite (true to
 * "PGlite is the CENTER" — JS holds only a cursor, never the history).
 *
 * Every enrichment mutation records ONE operation whose `changes` are generic
 * row-diffs — `{table, key, before, after}` per affected row — captured IN THE SAME
 * transaction as the mutation, so the log can never diverge from the data. Undo replays
 * each change's `before`, redo its `after`; this one mechanism reverses any op (scalar
 * edit, set membership, or a multi-row cascade) uniformly.
 *
 * A single `undo_meta.cursor` is the seq up to which ops are applied: ops with seq ≤
 * cursor are live, seq > cursor are undone-but-redoable. A new mutation truncates the
 * redoable tail (standard linear undo). The cursor lives in the DB, so undo/redo survive
 * an app restart (cross-session) — paired later with a visible history panel.
 */
import type { DatabaseConnection } from '@lib/database.ts';

/** A reversible row-level change: the row identified by `key` goes from `before` to
 *  `after` (null = the row is absent). Forward (redo) sets `after`; reverse (undo) `before`. */
export interface Change {
  table: string;
  key: Record<string, string | number>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** A querier — either the live connection's pg, or a transaction handle. */
export interface Querier {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

// Only these tables may be targeted by a replayed change (the changes are our own, but
// they round-trip through the DB as JSON, so whitelist defensively).
const ALLOWED_TABLES = new Set(['aliases', 'comments', 'tags', 'tag_assignments', 'delete_tags']);

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function getCursor(q: Querier, runId: string): Promise<number> {
  const r = await q.query(`SELECT cursor FROM undo_meta WHERE run_id = $1`, [runId]);
  return r.rows.length ? Number(r.rows[0].cursor) : 0;
}

async function setCursor(q: Querier, runId: string, cursor: number): Promise<void> {
  await q.query(
    `INSERT INTO undo_meta (run_id, cursor) VALUES ($1, $2)
     ON CONFLICT (run_id) DO UPDATE SET cursor = EXCLUDED.cursor`,
    [runId, cursor]
  );
}

/** Set one row to `target` (upsert), or delete it when `target` is null. */
async function applyRow(q: Querier, c: Change, target: Record<string, unknown> | null): Promise<void> {
  if (!ALLOWED_TABLES.has(c.table)) throw new Error(`undo: refusing unknown table ${c.table}`);
  const keyCols = Object.keys(c.key);
  const where = keyCols.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
  const keyVals = keyCols.map(k => c.key[k]);
  // Delete the existing row first either way (idempotent upsert), then re-insert if present.
  await q.query(`DELETE FROM ${c.table} WHERE ${where}`, keyVals);
  if (target !== null) {
    const cols = Object.keys(target);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await q.query(
      `INSERT INTO ${c.table} (${cols.join(', ')}) VALUES (${placeholders})`,
      cols.map(col => target[col])
    );
  }
}

/** Replay a change set in a direction. Undo reverses row order (so cascades unwind cleanly). */
async function applyChanges(q: Querier, changes: Change[], dir: 'undo' | 'redo'): Promise<void> {
  const ordered = dir === 'undo' ? [...changes].reverse() : changes;
  for (const c of ordered) await applyRow(q, c, dir === 'redo' ? c.after : c.before);
}

async function counts(q: Querier, runId: string, cursor: number): Promise<{ canUndo: boolean; canRedo: boolean }> {
  const lo = await q.query(`SELECT COUNT(*)::int c FROM operations WHERE run_id = $1 AND seq <= $2`, [runId, cursor]);
  const hi = await q.query(`SELECT COUNT(*)::int c FROM operations WHERE run_id = $1 AND seq > $2`, [runId, cursor]);
  return { canUndo: Number(lo.rows[0].c) > 0, canRedo: Number(hi.rows[0].c) > 0 };
}

/** True if the change set is a no-op (every row's before equals its after) — skip recording. */
export function isNoOp(changes: Change[]): boolean {
  return changes.every(c => JSON.stringify(c.before) === JSON.stringify(c.after));
}

/** Read one row by its key columns (the before/after snapshot a mutation records). */
export async function captureRow(
  q: Querier,
  table: string,
  key: Record<string, string | number>
): Promise<Record<string, unknown> | null> {
  const cols = Object.keys(key);
  const where = cols.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
  const r = await q.query(`SELECT * FROM ${table} WHERE ${where}`, cols.map(k => key[k]));
  return (r.rows[0] ?? null) as Record<string, unknown> | null;
}

/**
 * Record one operation (called INSIDE the mutation's transaction, with the same querier).
 * Truncates the redoable tail, appends at cursor+1, advances the cursor. No-ops are dropped
 * by the caller via isNoOp before getting here.
 */
export async function recordOp(
  q: Querier,
  runId: string,
  opKind: string,
  summary: string,
  changes: Change[],
  sessionId?: string | null
): Promise<void> {
  const cur = await getCursor(q, runId);
  await q.query(`DELETE FROM operations WHERE run_id = $1 AND seq > $2`, [runId, cur]); // truncate redo branch
  const seq = cur + 1;
  await q.query(
    `INSERT INTO operations (run_id, seq, ts, session_id, op_kind, summary, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [runId, seq, nowSeconds(), sessionId ?? null, opKind, summary, JSON.stringify(changes)]
  );
  await setCursor(q, runId, seq);
}

export interface UndoRedoResult {
  ok: boolean; // whether an op was applied
  summary?: string;
  canUndo: boolean;
  canRedo: boolean;
}

/** Undo the op at the cursor (reverse its changes), step the cursor back. */
export async function handleUndo(db: DatabaseConnection, runId: string): Promise<UndoRedoResult> {
  return await db.pg.transaction(async tx => {
    const cur = await getCursor(tx, runId);
    if (cur === 0) return { ok: false, ...(await counts(tx, runId, cur)) };
    const op = (await tx.query(`SELECT summary, changes FROM operations WHERE run_id = $1 AND seq = $2`, [runId, cur]))
      .rows[0] as { summary: string; changes: string } | undefined;
    if (!op) return { ok: false, ...(await counts(tx, runId, cur)) };
    await applyChanges(tx, JSON.parse(op.changes), 'undo');
    const prevRow = (await tx.query(`SELECT MAX(seq)::int m FROM operations WHERE run_id = $1 AND seq < $2`, [runId, cur]))
      .rows[0] as { m: number | null };
    const prev = prevRow.m == null ? 0 : Number(prevRow.m);
    await setCursor(tx, runId, prev);
    return { ok: true, summary: op.summary, ...(await counts(tx, runId, prev)) };
  });
}

/** Redo the next op past the cursor (replay its changes), step the cursor forward. */
export async function handleRedo(db: DatabaseConnection, runId: string): Promise<UndoRedoResult> {
  return await db.pg.transaction(async tx => {
    const cur = await getCursor(tx, runId);
    const nextRow = (await tx.query(`SELECT MIN(seq)::int m FROM operations WHERE run_id = $1 AND seq > $2`, [runId, cur]))
      .rows[0] as { m: number | null };
    if (nextRow.m == null) return { ok: false, ...(await counts(tx, runId, cur)) };
    const next = Number(nextRow.m);
    const op = (await tx.query(`SELECT summary, changes FROM operations WHERE run_id = $1 AND seq = $2`, [runId, next]))
      .rows[0] as { summary: string; changes: string };
    await applyChanges(tx, JSON.parse(op.changes), 'redo');
    await setCursor(tx, runId, next);
    return { ok: true, summary: op.summary, ...(await counts(tx, runId, next)) };
  });
}

/** can-undo / can-redo for the UI (cheap; reads the cursor + counts). */
export async function handleUndoState(db: DatabaseConnection, runId: string): Promise<{ canUndo: boolean; canRedo: boolean }> {
  const cur = await getCursor(db.pg, runId);
  return counts(db.pg, runId, cur);
}
