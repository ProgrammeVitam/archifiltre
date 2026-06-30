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
import { firstValueFrom, type Subscription } from 'rxjs';
import { initializeLogging } from '@lib/logging.ts';
import {
  createScanDatabase,
  getLatestRunId,
  insertScanMetadata,
  updateScanMetadata,
  setScanStatus,
  getScanMetadata,
  ensureTemplateInBackground,
  type DatabaseConnection,
} from '@lib/database.ts';
import {
  scanDirectory,
  generateRunId,
  scanProgressMetrics,
  type ScanConfig,
  type ScanProgressEvent,
  type ScanResult,
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
  /** The live scan's subscription, so pause/cancel can stop it (an intentional "soft
   *  crash"): unsubscribe tears the pipeline down mid-flight; the frontier means resume
   *  re-walks only the un-enumerated remainder. undefined when no scan is running. */
  private scanSubscription: Subscription | undefined;
  /** Set true on pause/cancel — the walker polls it (shouldContinue) and stops pulling new
   *  directories. Belt-and-suspenders with unsubscribe. */
  private scanPaused = false;
  /** jobId of the running scan, so a pause triggered out-of-band can address job:paused. */
  private currentJobId = '';
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
    await new Promise<void>(r => setImmediate(r));
    while (this.pendingReads > 0) {
      await new Promise<void>(r => setImmediate(r));
    }
    // (2) duty-cycle backoff: to run at `budget` duty, idle workMs*(1/budget - 1).
    const budget = this.effectiveBudget();
    if (budget < 1 && workMs > 0) {
      const sleepMs = Math.min(250, Math.round(workMs * (1 / budget - 1)));
      if (sleepMs > 0) await new Promise<void>(r => setTimeout(r, sleepMs));
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
      const cpuPct = elapsed > 0 ? Math.round(((d.user + d.system) / 1000 / elapsed) * 100) : 0;
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
    await initializeLogging({
      level: 'info',
      enableConsoleLogging: false,
      enableFileLogging: true,
    });

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
    rl.on('line', line => {
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

      // ── Pause / cancel / resume control channel (Phase 7 increment 3) ──────────
      // pause and cancel are the same mechanism (stop the scan, keep all data, stay
      // resumable); they differ only in the persisted status. resume re-runs the scan
      // with resume:true — the frontier makes that cheap (re-walk only the remainder).
      if (action === 'pause_scan' || action === 'cancel_scan') {
        await this.stopScan(action === 'pause_scan' ? 'paused' : 'cancelled');
        this.send({ id, ok: true });
        return;
      }
      if (action === 'resume_scan') {
        await this.handleResumeScan(req);
        return;
      }

      if (action === 'ping') {
        this.send({
          id,
          ok: true,
          data: { pong: true, scanning: this.scanning, run_id: this.runId ?? null },
        });
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
      await new Promise<void>(r => setImmediate(r));
      while (this.pendingReads > 0) await new Promise<void>(r => setImmediate(r));
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

  /** Back to full speed + no throttle when idle (the governor only governs an active scan). */
  private resetGovernor(): void {
    this.cpuBudget = 1;
    this.autoThrottle = false;
  }

  private async runScan(req: QueryRequest): Promise<void> {
    const jobId = (req.jobId as string) || (req.runId as string) || '';
    if (this.scanning) {
      this.send({ event: 'job:error', jobId, error: 'already scanning' });
      return;
    }
    const rootPath = req.path as string;
    // Resume an interrupted scan: continue the SAME run (keep its partial files, re-walk
    // only the un-enumerated frontier, hash from where it stopped) instead of a fresh one.
    // Use the explicit runId if given, else the run this session loaded on startup.
    const resume = req.resume === true;
    const runId = (req.runId as string) || (resume && this.runId ? this.runId : generateRunId());
    this.runId = runId; // queries during the scan target this run
    this.currentJobId = jobId;
    this.scanning = true;
    this.scanPaused = false;
    const startMs = Date.now();
    const startedAt = Math.floor(Date.now() / 1000);

    // Resource governor settings for this scan (default: full speed, no throttle).
    this.cpuBudget =
      typeof req.cpuBudget === 'number' ? Math.max(0.1, Math.min(1, req.cpuBudget)) : 1;
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
      resume, // ← keep partial files + continue hashing from hash IS NULL
      frontier: true, // ← owner mode: discovery is always resumable (re-walk only remainder)
      shouldContinue: () => !this.scanPaused, // ← pause/cancel stops pulling new directories
      // Concurrent enumeration (3b): the lever for high-latency NAS/cloud mounts. Default 16;
      // overridable per scan. (A measured-latency auto-ramp is a planned follow-on.)
      enumerateConcurrency:
        typeof req.enumerateConcurrency === 'number'
          ? Math.max(1, Math.min(64, req.enumerateConcurrency))
          : 16,
    };

    try {
      // Write scan_metadata at the START (not completion). It carries the root path, so
      // get_tree returns a non-null root DURING the scan — giving each in-progress scan's
      // live tree a distinct identity (the chart keys on it, so concurrent tabs switch
      // correctly) AND making an interrupted scan recoverable on restart. cleanDatabase
      // (inside scanDirectory) preserves this row (it clears only other run_ids). On resume
      // the row already exists, so set status back to 'running' explicitly.
      await firstValueFrom(insertScanMetadata(this.database!, runId, rootPath, startedAt));
      await firstValueFrom(setScanStatus(this.database!, runId, 'running'));
    } catch (e) {
      this.scanning = false;
      this.resetGovernor();
      this.send({ event: 'job:error', jobId, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    // Subscribe (don't await) so pause/cancel can unsubscribe mid-flight. The scan runs to
    // completion via the callbacks below; the DB is the single source of truth so owner
    // mode streams no JS-accumulated provisional tree (the UI reads get_tree live).
    let lastResult: ScanResult | undefined;
    this.scanSubscription = scanDirectory(
      this.database!,
      scanConfig,
      (event: ScanProgressEvent) => {
        const { processed, total } = scanProgressMetrics(event);
        this.send({
          event: 'job:progress',
          jobId,
          phase: event.phase,
          processed,
          total,
          detail: event.status,
        });
      }
    ).subscribe({
      next: result => {
        lastResult = result;
      },
      error: e => {
        this.scanSubscription = undefined;
        this.scanning = false;
        this.resetGovernor();
        this.send({ event: 'job:error', jobId, error: e instanceof Error ? e.message : String(e) });
      },
      complete: () => {
        this.scanSubscription = undefined;
        void (async () => {
          try {
            // dir_stats is fully materialized by the per-batch rollup (or, on a frontier
            // resume, by the end-of-ingestion populateDirStats) — no spike here.
            if (lastResult) {
              await firstValueFrom(
                updateScanMetadata(this.database!, runId, lastResult.filesIngested)
              );
            }
          } catch {
            /* best effort — metadata update must not crash the owner */
          }
          this.scanning = false;
          this.resetGovernor();
          this.send({ event: 'job:complete', jobId, durationMs: Date.now() - startMs });
          // Now idle: build the warm-start template (initdb once) so the NEXT new db is a
          // ~125 ms copy instead of a ~3 s initdb. Fire-and-forget; no-op if already built.
          void ensureTemplateInBackground();
        })();
      },
    });
  }

  /**
   * Stop the running scan (pause or cancel). Both are the same mechanism: unsubscribe is
   * an intentional "soft crash" — the pipeline tears down mid-flight, in-flight batches
   * drain harmlessly, and all committed data stays. They differ only in persisted status,
   * and BOTH remain resumable (never discard, always resumable). job:paused
   * tells the UI it stopped cleanly.
   */
  private async stopScan(status: 'paused' | 'cancelled'): Promise<void> {
    if (!this.scanning) return; // nothing to stop; pause is idempotent
    this.scanPaused = true; // walker stops popping new dirs
    this.scanSubscription?.unsubscribe(); // tear the pipeline down now
    this.scanSubscription = undefined;
    this.scanning = false;
    this.resetGovernor();
    if (this.runId) {
      try {
        await firstValueFrom(setScanStatus(this.database!, this.runId, status));
      } catch {
        /* best effort */
      }
    }
    this.send({ event: 'job:paused', jobId: this.currentJobId });
  }

  /**
   * Resume the paused/interrupted scan for this session's run: look up its root path and
   * re-run with resume:true. The frontier makes that cheap — only the un-enumerated
   * remainder is re-walked, and hashing continues from `hash IS NULL`.
   */
  private async handleResumeScan(req: QueryRequest): Promise<void> {
    const { id } = req;
    if (this.scanning) {
      this.send({ id, ok: false, error: 'already scanning' });
      return;
    }
    if (!this.runId) {
      this.send({ id, ok: false, error: 'no run to resume' });
      return;
    }
    const meta = await firstValueFrom(getScanMetadata(this.database!, this.runId));
    if (!meta) {
      this.send({ id, ok: false, error: 'no scan metadata for run' });
      return;
    }
    this.send({ id, ok: true }); // ack; progress streams as events
    void this.runScan({
      ...req,
      action: 'start_scan',
      path: meta.root_path,
      runId: this.runId,
      resume: true,
      jobId: (req.jobId as string) || this.currentJobId,
    } as QueryRequest);
  }
}
