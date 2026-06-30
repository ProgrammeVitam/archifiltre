/**
 * Single-owner DB session (Phase 1 of the read-while-scanning design).
 *
 * One long-lived process owns ONE PGlite connection and multiplexes, over stdio
 * JSON-lines:
 *   - ingestion writes  (start_scan → the real scanner pipeline)
 *   - UI reads          (get_tree / get_files / enrichment / … via dispatchQuery)
 * on the same connection. Because PGlite blocks the single JS thread, the scan
 * yields to in-flight reads between write batches (read priority) so reads slip in
 * instead of being starved. This is the only opener of the datadir, so reads during a scan
 * are safe by construction (no second process, no corruption).
 *
 * Wire format (one JSON object per line):
 *   in : {id, action, …}            (query)  | {id, action:'start_scan', path, jobId?, …}
 *   out: {id, ok, data|error}       (response, correlated by id)
 *        {event:'job:progress'|'job:complete'|'job:error'|'scan:tree'|'ready'|'resource', …}  (async)
 */
import { Command, Flags } from '@oclif/core';
import * as readline from 'node:readline';
import * as os from 'node:os';
import { lastValueFrom } from 'rxjs';
import { initializeLogging } from '@lib/logging.ts';
import {
  createScanDatabase,
  getLatestRunId,
  insertScanMetadata,
  updateScanMetadata,
  ensureTemplateInBackground,
  type DatabaseConnection,
} from '@lib/database.ts';
import {
  scanDirectory,
  generateRunId,
  scanProgressMetrics,
  type ScanConfig,
  type ScanProgressEvent,
} from '@lib/scanner.ts';
import { ensureEnrichmentTables } from '@extensions/enrichment/index.ts';
import { dispatchQuery, type QueryRequest } from './query.ts';

export default class Session extends Command {
  static override description =
    'Single-owner DB session: one PGlite connection serving scan writes + live reads over JSON-lines stdio';

  static override flags = {
    db: Flags.string({ char: 'd', description: 'Database name', default: 'main' }),
    'run-id': Flags.string({ description: 'Run ID for queries (defaults to latest)' }),
  };

  private database: DatabaseConnection | undefined;
  private runId: string | undefined;
  private scanning = false;
  /** True while switch_db swaps the connection, so a second switch can't race it. */
  private switching = false;
  /** In-flight read queries. The scan's betweenBatches hook waits on this so reads
   *  are served before the next write batch (read priority → responsive UI). */
  private pendingReads = 0;

  // ── Resource governor ────────────────────────────────────────────────────
  /** Target CPU duty cycle for the scan (1 = full speed). The betweenBatches hook
   *  sleeps to keep the scan under this, leaving headroom for the UI (a separate
   *  process). 1 = off. */
  private cpuBudget = 1;
  /** Derive the budget from system load each batch instead of a fixed value. */
  private autoThrottle = false;
  /** Wall-clock start of the current write batch, for the duty-cycle measurement. */
  private batchStart = 0;

  private send(o: unknown): void {
    process.stdout.write(`${JSON.stringify(o)}\n`);
  }

  /** Effective CPU budget: a fixed value, or — under autoThrottle — ramped down as
   *  system load climbs past ~0.7×cores (no throttle) toward ~1.3×cores (heavy). */
  private effectiveBudget(): number {
    if (!this.autoThrottle) return this.cpuBudget;
    const cores = os.cpus().length || 1;
    const ratio = os.loadavg()[0] / cores;
    if (ratio <= 0.7) return 1;
    if (ratio >= 1.3) return 0.4;
    return 1 - ((ratio - 0.7) / 0.6) * 0.6; // linear 1.0 → 0.4
  }

  /** Hook handed to the scan, run BETWEEN write batches. Two jobs:
   *  (1) read priority — yield the loop so queued reads get issued, then wait until
   *      in-flight reads drain before the next batch;
   *  (2) resource governor — sleep to hold the scan under its CPU budget, so the OS
   *      hands that CPU to the UI process and the app stays smooth.
   *  Near-zero cost when nothing is waiting and the budget is 1. */
  private async betweenBatches(): Promise<void> {
    const workMs = this.batchStart ? Date.now() - this.batchStart : 0;
    // (1) read priority
    await new Promise<void>((r) => setImmediate(r));
    while (this.pendingReads > 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    // (2) duty-cycle backoff: to run at `budget` duty, idle workMs*(1/budget - 1).
    const budget = this.effectiveBudget();
    if (budget < 1 && workMs > 0) {
      const sleepMs = Math.min(250, Math.round(workMs * (1 / budget - 1)));
      if (sleepMs > 0) await new Promise<void>((r) => setTimeout(r, sleepMs));
    }
    this.batchStart = Date.now();
  }

  /** Sample CPU%, RSS and system load every 500ms and emit as a `resource` event —
   *  feeds the UI's live resource display AND (via effectiveBudget) the throttle. */
  private startMonitor(): void {
    let lastCpu = process.cpuUsage();
    let lastT = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const d = process.cpuUsage(lastCpu); // delta since last sample, microseconds
      const elapsed = now - lastT;
      const cpuPct = elapsed > 0 ? Math.round((d.user + d.system) / 1000 / elapsed * 100) : 0;
      lastCpu = process.cpuUsage();
      lastT = now;
      this.send({
        event: 'resource',
        cpuPct,
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
        load1: +os.loadavg()[0].toFixed(2),
        cores: os.cpus().length,
        budget: +this.effectiveBudget().toFixed(2),
        scanning: this.scanning,
      });
    }, 500);
    timer.unref?.();
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Session);

    // Console logging OFF — stdout is the JSON protocol.
    await initializeLogging({ level: 'info', enableConsoleLogging: false, enableFileLogging: true });

    this.database = await createScanDatabase(flags.db);
    await ensureEnrichmentTables(this.database);

    if (flags['run-id']) {
      this.runId = flags['run-id'];
    } else {
      this.runId =
        (await new Promise<string | null>((resolve, reject) => {
          getLatestRunId(this.database!).subscribe({ next: resolve, error: reject });
        })) ?? undefined;
    }

    this.send({ event: 'ready', run_id: this.runId ?? null, pid: process.pid });
    this.startMonitor();

    // The pre-warmed spare (db "_warm") will sit IDLE until claimed, so it's the safe
    // place to build the warm-start template — once it's ready, the first real scan
    // (claimed spare OR cold spawn) copies the template instead of running initdb.
    if (flags.db === '_warm') {
      void ensureTemplateInBackground();
    }

    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed) void this.handle(trimmed);
    });
    rl.on('close', () => process.exit(0));
  }

  private async handle(line: string): Promise<void> {
    let req: QueryRequest;
    try {
      req = JSON.parse(line) as QueryRequest;
    } catch {
      return; // ignore malformed line, owner survives
    }
    const { id, action } = req;

    try {
      if (action === 'start_scan') {
        this.send({ id, ok: true }); // ack; progress streams as events
        void this.runScan(req);
        return;
      }

      if (!this.database) {
        this.send({ id, ok: false, error: 'Database not initialized' });
        return;
      }

      if (action === 'ping') {
        this.send({ id, ok: true, data: { pong: true, scanning: this.scanning, run_id: this.runId ?? null } });
        return;
      }

      // Warm reuse: re-target this (already-running, WASM-compiled) process at a
      // different datadir in-process, instead of cold-spawning a fresh one.
      if (action === 'switch_db') {
        await this.handleSwitchDb(req);
        return;
      }

      if (!this.runId) {
        this.send({ id, ok: false, error: 'No run loaded yet (start a scan first)' });
        return;
      }

      // get_tree is served LIVE during a scan now: dir_stats is maintained
      // incrementally as batches ingest (rollupDirStatsBatch), so the icicle reads
      // the growing tree straight from the DB. get_stats stays settled-only — it's a
      // whole-table aggregate the live UI doesn't use (it reads $scanResult instead).
      if (this.scanning && action === 'get_stats') {
        this.send({ id, ok: false, error: 'unavailable_during_scan' });
        return;
      }

      // Count as an in-flight read so the scan yields to it (read priority). Pass the
      // scanning flag so handleGetTree does NOT lazily recompute dir_stats mid-scan
      // (that would double-count against the incremental rollup); it just reads the
      // partial aggregates.
      this.pendingReads++;
      try {
        const data = await dispatchQuery(this.database, this.runId, req, this.scanning);
        this.send({ id, ok: true, data });
      } finally {
        this.pendingReads--;
      }
    } catch (e) {
      // Per-request isolation: one failed query never takes the owner down.
      this.send({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Re-point this warm process at a different db in-process (no respawn → no WASM
   *  recompile). Combined with the warm-start template-copy, claiming + switching a
   *  spare process is ~0.5 s vs a ~4 s cold spawn. Refuses while scanning (closing
   *  PGlite mid-scan would kill it); a concurrent scan must use a different process. */
  private async handleSwitchDb(req: QueryRequest): Promise<void> {
    const { id } = req;
    const db = req.db as string;
    if (!db) {
      this.send({ id, ok: false, error: 'switch_db requires db' });
      return;
    }
    if (this.scanning) {
      this.send({ id, ok: false, error: 'cannot switch_db while scanning' });
      return;
    }
    // Already on this datadir → no-op. (Re-opening it while it's still open would be
    // two openers of one datadir = corruption.)
    if (this.database?.name === db) {
      this.send({ id, ok: true, data: { run_id: this.runId ?? null, db } });
      return;
    }
    if (this.switching) {
      this.send({ id, ok: false, error: 'switch already in progress' });
      return;
    }
    this.switching = true;
    try {
      // Drain in-flight reads on the current connection before swapping it out.
      await new Promise<void>((r) => setImmediate(r));
      while (this.pendingReads > 0) await new Promise<void>((r) => setImmediate(r));
      // Open the NEW connection before closing the old, so this.database is never a
      // closed handle (a concurrent read keeps using the old, still-open one until the
      // atomic swap). Different datadir → no two-openers-of-one-datadir.
      const old = this.database;
      const next = await createScanDatabase(db);
      await ensureEnrichmentTables(next);
      const rid = await new Promise<string | null>((resolve, reject) => {
        getLatestRunId(next).subscribe({ next: resolve, error: reject });
      });
      this.database = next;
      this.runId = rid ?? undefined;
      if (old) {
        try {
          await old.pg.close();
        } catch {
          /* best effort — datadir lock is released for the next opener */
        }
      }
      this.send({ id, ok: true, data: { run_id: this.runId ?? null, db } });
    } catch (e) {
      this.send({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.switching = false;
    }
  }

  private async runScan(req: QueryRequest): Promise<void> {
    const jobId = (req.jobId as string) || (req.runId as string) || '';
    if (this.scanning) {
      this.send({ event: 'job:error', jobId, error: 'already scanning' });
      return;
    }
    const rootPath = req.path as string;
    const runId = (req.runId as string) || generateRunId();
    this.runId = runId; // queries during the scan target this run
    this.scanning = true;
    const startedAt = Math.floor(Date.now() / 1000);
    const startMs = Date.now();

    // Resource governor settings for this scan (default: full speed, no throttle).
    this.cpuBudget = typeof req.cpuBudget === 'number' ? Math.max(0.1, Math.min(1, req.cpuBudget)) : 1;
    this.autoThrottle = req.autoThrottle === true;
    this.batchStart = Date.now();

    const scanConfig: ScanConfig = {
      rootPath,
      runId,
      includeHidden: !!req.includeHidden,
      batchSize: (req.batchSize as number) || 1000,
      enableArchiveProcessing: req.enableArchives !== false,
      betweenBatches: () => this.betweenBatches(), // ← read priority + resource governor
      preserveConnection: true, // ← never close/delete the owned connection mid-scan
    };

    try {
      // Write scan_metadata at the START (not completion). It carries the root path, so
      // get_tree returns a non-null root DURING the scan — giving each in-progress scan's
      // live tree a distinct identity (the chart keys on it, so concurrent tabs switch
      // correctly) AND making an interrupted scan recoverable on restart. cleanDatabase
      // (inside scanDirectory) preserves this row (it clears only other run_ids).
      await insertScanMetadata(this.database!, runId, rootPath, startedAt).toPromise();
      const result = await lastValueFrom(
        scanDirectory(
          this.database!,
          scanConfig,
          (event: ScanProgressEvent) => {
            const { processed, total } = scanProgressMetrics(event);
            this.send({ event: 'job:progress', jobId, phase: event.phase, processed, total, detail: event.status });
          }
          // No tree callback: owner mode doesn't stream a JS-accumulated provisional
          // tree. dir_stats is maintained in the DB per batch, so the UI reads the
          // live tree straight from get_tree — the DB is the single source of truth.
        )
      );
      await updateScanMetadata(this.database!, runId, result.filesIngested).toPromise();
      // dir_stats is already fully materialized by the incremental rollup that ran on
      // every ingestion batch (rollupDirStatsBatch) — no one-shot populate spike here.
      this.scanning = false;
      this.send({ event: 'job:complete', jobId, durationMs: Date.now() - startMs });
      // Now idle: build the warm-start template (initdb once) so the NEXT new db is a
      // ~125 ms copy instead of a ~3 s initdb. Fire-and-forget; no-op if already built.
      void ensureTemplateInBackground();
    } catch (e) {
      this.scanning = false;
      this.send({ event: 'job:error', jobId, error: e instanceof Error ? e.message : String(e) });
    } finally {
      // Back to full speed when idle (the governor only governs an active scan).
      this.cpuBudget = 1;
      this.autoThrottle = false;
    }
  }
}
