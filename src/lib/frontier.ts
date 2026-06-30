/**
 * Resumable-discovery frontier accounting (Phase 7 increment 2).
 *
 * Pure, in-memory, dependency-free bookkeeping that decides WHEN an enumeration unit
 * (a directory, or an archive container) may be stamped `enumerated_at` in the DB. The
 * rule — the correctness invariant of the whole feature — is:
 *
 *   stamp a unit ONLY after ALL of its children are durably committed.
 *
 * That keeps the un-stamped set "closed": re-enumerating every un-stamped unit on resume
 * rediscovers exactly what was missing, because any child that didn't commit leaves its
 * parent un-stamped. So a crash at any instant ⇒ resume re-does only the open frontier
 * (a handful of dirs + at most the one archive mid-expansion), never the whole tree.
 *
 * Why this can't be "mark the dir when its rows are contiguous in a batch": archive
 * expansion runs downstream of the walker with concurrency (reordering the stream), and
 * the 1000-row flush splits a dir's children across batches. So the mark is driven by
 * PRODUCER completion (the walker / archive expander announce a unit's exact child count)
 * reconciled against COMMIT accounting (batches tally committed children per unit), keyed
 * on the unit identity every row already carries.
 */

/** The enumeration unit a row belongs to: its archive container if it's an archive
 *  entry, else its parent directory. '' denotes the scan root (which has no row in
 *  `files` and is always re-listed on resume), so it is never stamped. */
export function unitOf(row: { path: string; archive_parent_path?: string | null }): string {
  if (row.archive_parent_path) return row.archive_parent_path;
  const i = row.path.lastIndexOf('/');
  return i < 0 ? '' : row.path.slice(0, i);
}

export class Frontier {
  /** unit → exact number of children the producer emitted (set once the producer is done
   *  with the unit). Until known, the unit can never be marked. */
  private expected = new Map<string, number>();
  /** unit → number of its children durably committed so far (across successful batches). */
  private committed = new Map<string, number>();
  /** units whose OWN row (the directory / archive-container row) has durably committed.
   *  A unit can't be stamped before this — the stamp is an UPDATE on that row, and a
   *  0-child unit (empty dir, nested/errored archive) would otherwise be "ready" before
   *  its row exists, no-op the UPDATE, and re-list forever. For units with children this
   *  is already implied (the unit's row commits with its parent's batch, before its
   *  children), but gating all units is harmless and closes the 0-child hole. */
  private selfCommitted = new Set<string>();
  /** units already stamped — never stamp twice. */
  private marked = new Set<string>();
  /** units that have reached `committed >= expected` but haven't been drained for stamping
   *  yet. Both triggers (a commit, or a late producer-completion) feed this. */
  private ready = new Set<string>();

  private maybeReady(unit: string): void {
    if (this.marked.has(unit) || this.ready.has(unit)) return;
    if (!this.selfCommitted.has(unit)) return;
    const exp = this.expected.get(unit);
    if (exp === undefined) return;
    if ((this.committed.get(unit) ?? 0) >= exp) this.ready.add(unit);
  }

  /**
   * Resume seeding: these units' OWN rows committed in a PRIOR run and won't be re-emitted
   * this run (their parents are already enumerated, so not re-walked). Without this they'd
   * fail the selfCommitted gate forever and never re-stamp — staying on the frontier even
   * after their children are re-walked. The frontier query only returns rows that exist, so
   * their rows are by definition durable.
   */
  seedSelfCommitted(paths: string[]): void {
    for (const p of paths) if (p) this.selfCommitted.add(p);
  }

  /**
   * A producer (the walker for a directory, the archive expander for a container) has
   * finished a unit and knows its exact child count. May fire AFTER the unit's children
   * already committed (late completion) — `maybeReady` catches that. count=0 (empty dir,
   * nested-unprocessed archive) makes the unit immediately ready.
   */
  unitComplete(unit: string, count: number): void {
    if (unit === '') return; // root: no row to stamp, always re-listed on resume
    this.expected.set(unit, count);
    this.maybeReady(unit);
  }

  /**
   * Tally one SUCCESSFULLY-committed batch. Call ONLY after the insert transaction
   * committed (a failed/rolled-back batch must not be tallied — its units stay un-stamped
   * and replay). Increments per-unit committed counts and flags any unit that just reached
   * its expected total.
   */
  rowsCommitted(
    rows: Array<{
      path: string;
      archive_parent_path?: string | null;
      is_directory?: boolean;
      is_archive_container?: boolean | null;
    }>
  ): void {
    for (const row of rows) {
      // This row IS a unit's own row → its unit can now be stamped (once its children are
      // in too). Covers empty dirs and archive containers whose children land elsewhere.
      if (row.is_directory || row.is_archive_container) {
        this.selfCommitted.add(row.path);
        this.maybeReady(row.path);
      }
      const unit = unitOf(row);
      if (unit === '') continue; // root has no stampable row
      const c = (this.committed.get(unit) ?? 0) + 1;
      this.committed.set(unit, c);
      this.maybeReady(unit);
    }
  }

  /**
   * Drain the units now fully committed and not yet stamped, for the caller to stamp
   * (DB UPDATE) in a txn AFTER the commit that made them ready. They are NOT marked here:
   * the caller `confirm`s them once the stamp UPDATE commits, or `requeue`s them on failure
   * — so a transient stamp error retries on the next drain instead of silently dropping the
   * stamp (which would needlessly re-walk those dirs on the next resume).
   */
  takeReady(): string[] {
    if (this.ready.size === 0) return [];
    const out = [...this.ready];
    this.ready.clear();
    return out;
  }

  /** The stamp UPDATE for these units committed → never return or stamp them again. */
  confirm(units: string[]): void {
    for (const u of units) this.marked.add(u);
  }

  /** The stamp UPDATE failed → put them back so the next drain retries the stamp. */
  requeue(units: string[]): void {
    for (const u of units) if (!this.marked.has(u)) this.ready.add(u);
  }

  /** Diagnostics: units discovered-but-not-yet-stamped (the live frontier size). */
  pendingCount(): number {
    return this.expected.size - this.marked.size;
  }
}
