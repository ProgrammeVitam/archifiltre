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
import { rm } from 'node:fs/promises';
import { firstValueFrom, type Subscription } from 'rxjs';
import { initializeLogging, logger } from '@lib/logging.ts';
import {
  createScanDatabase,
  getLatestRunId,
  insertScanMetadata,
  updateScanMetadata,
  countRunRows,
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
import {
  scheduleSnapshot,
  cancelSnapshot,
  flushSnapshot,
  flushSnapshotSync,
  deleteSnapshot,
} from '@extensions/enrichment/snapshot.ts';
import {
  writeDatadirMeta,
  datadirMetaPath,
  writeDatadirTombstone,
  sweepTombstonedDatadirs,
  datadirExists,
  type DatadirStatus,
} from '@lib/datadir-meta.ts';
import { settleDatadir } from '@lib/settle-datadir.ts';

// Enrichment actions that change the user's annotations → trigger a durable snapshot.
// (undo/redo are included: they mutate the same tables.)
const ENRICHMENT_MUTATIONS = new Set([
  'set_alias',
  'set_comment',
  'set_delete_tag',
  'remove_delete_tag',
  'create_tag',
  'rename_tag',
  'delete_tag',
  'assign_tag',
  'unassign_tag',
  'undo',
  'redo',
  'restore_annotations',
]);
import { getDatabasePath } from '@lib/platform-paths.ts';
import { handleHostReply } from '@lib/host-bridge.ts';
import { registerExtensionAiProviders } from '@extensions/index.ts';
import { dispatchQuery, type QueryRequest } from './query.ts';

export default class Session extends Command {
  static override description =
    'Single-owner DB session: one PGlite connection serving scan writes + live reads over JSON-lines stdio';

  static override flags = {
    db: Flags.string({ char: 'd', description: 'Database name', default: 'main' }),
    'run-id': Flags.string({ description: 'Run ID for queries (defaults to latest)' }),
    // Serve an existing datadir only. `createScanDatabase` conflates two intents — opening a
    // session and creating a scan database — and after a delete the difference matters: a
    // query for a discarded scan would otherwise rebuild its datadir. The supervisor passes
    // this whenever it is re-establishing a session (see get_or_spawn_owner); a starting scan
    // is the only caller that omits it.
    'no-create': Flags.boolean({ description: 'Fail instead of creating a missing datadir', default: false }),
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
  /** Root path of the running scan — kept on the instance so stopScan (which runs outside
   *  runScan's scope) can write it into the datadir meta sidecar. */
  private scanRootPath: string | null = null;
  /** True while switch_db swaps the connection, so a second switch can't race it. */
  private switching = false;
  /** In-flight read queries. The scan's betweenBatches hook waits on this so reads
   *  are served before the next write batch (read priority → responsive UI). */
  private pendingReads = 0;

  /** Run-readiness latch (precondition #2). A query that needs a loaded run AWAITS this
   *  instead of failing with "No run loaded yet" — a not-yet-loaded run is a WAIT, not an
   *  error. That string was outside the frontend's transient set, so it surfaced immediately
   *  as a hard "Summary unavailable" (race R2). Resolved once, when runId is first set
   *  (reopen resolves it before the `ready` event, so a reopened scan never waits). */
  private runReady!: Promise<void>;
  private resolveRunReady: (() => void) | undefined;

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

  /** Sample CPU%, system memory and load every 500ms and emit as a `resource` event —
   *  feeds the UI's live resource display and (via effectiveBudget) the throttle. */
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
      // Memory is system-wide. The app spans several processes plus the webview, and on
      // Windows a session's working set (~450 MB) is far below what it actually costs the
      // machine (~4.4 GB of commit charge), so one process's resident set would mislead.
      this.send({
        event: 'resource',
        cpuPct,
        memUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
        memTotalMb: Math.round(os.totalmem() / 1048576),
        load1: +os.loadavg()[0].toFixed(2),
        cores: os.cpus().length,
        budget: +this.effectiveBudget().toFixed(2),
        scanning: this.scanning,
      });
    }, 500);
    timer.unref?.();
  }

  /** Arm a fresh (unresolved) run-readiness latch. Called once at startup. */
  private armRunReady(): void {
    this.runReady = new Promise<void>(res => {
      this.resolveRunReady = res;
    });
  }
  /** Resolve the latch once a run is loaded (idempotent — resolving twice is a no-op). */
  private markRunLoaded(): void {
    if (this.runId) this.resolveRunReady?.();
  }
  /** Await a loaded run, bounded so a genuinely run-less owner never hangs a query forever.
   *  20 s stays inside the frontend's 30 s describe timeout, which is the ultimate backstop. */
  private async awaitRunLoaded(timeoutMs = 20_000): Promise<void> {
    if (this.runId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(res => {
      timer = setTimeout(res, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([this.runReady, timeout]);
    if (timer) clearTimeout(timer);
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Session);
    this.armRunReady();

    // Console logging OFF — stdout is the JSON protocol.
    await initializeLogging({
      level: 'info',
      enableConsoleLogging: false,
      enableFileLogging: true,
    });

    // The owner must NEVER die from a stray async error — read-while-scanning depends on
    // it staying alive. Pausing/cancelling tears the scan pipeline down mid-flight, which
    // orphans in-flight ops (PGlite txns, the concurrent walker, hashing); if one rejects,
    // SURVIVE and log instead of exiting. An exit closes stdout → every in-flight UI query
    // fails with "session closed before responding" (the pause-time visualization error).
    process.on('unhandledRejection', reason => {
      logger.error(
        'Unhandled rejection in session (survived)',
        reason instanceof Error ? reason : new Error(String(reason))
      );
    });
    process.on('uncaughtException', err => {
      logger.error('Uncaught exception in session (survived)', err);
    });

    if (flags['no-create'] && !(await datadirExists(flags.db))) {
      // The caller asked to re-attach to a database that exists. Report the absence and stop.
      logger.info('Refusing to create a missing datadir (--no-create)', { dbName: flags.db });
      this.send({ event: 'db_absent', db: flags.db });
      process.exit(3);
    }
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

    this.markRunLoaded(); // reopen: runId is resolved BEFORE `ready`, so queries never wait
    this.send({ event: 'ready', run_id: this.runId ?? null, pid: process.pid });
    this.startMonitor();

    // The pre-warmed spare (db "_warm") will sit IDLE until claimed, so it's the safe
    // place to build the warm-start template — once it's ready, the first real scan
    // (claimed spare OR cold spawn) copies the template instead of running initdb.
    if (flags.db === '_warm') {
      void ensureTemplateInBackground();
    }

    // Finish any deletion that was interrupted, by a kill mid-removal or by the removal
    // outliving its session. Tombstoned datadirs are already invisible to reconciliation, so
    // this only reclaims their bytes; it runs in the background so it cannot delay `ready`.
    void sweepTombstonedDatadirs().catch(() => {
      /* best-effort: still tombstoned, retried next launch */
    });

    // Register any extension-provided AI agents into the AI API (built-ins self-register).
    registerExtensionAiProviders();

    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', line => {
      const trimmed = line.trim();
      if (trimmed) void this.handle(trimmed);
    });
    // Flush a pending annotation snapshot before exit: a mutation followed within the
    // debounce window (500ms) by app-close would otherwise lose that last edit. Covers
    // stdin-close (normal shutdown) and SIGTERM/SIGINT (supervisor kill / Ctrl-C).
    rl.on('close', () => void this.shutdown());
    process.on('SIGTERM', () => void this.shutdown());
    process.on('SIGINT', () => void this.shutdown());
  }

  private shuttingDown = false;

  /** Flush the pending annotation snapshot, then exit. Idempotent. */
  private shutdown(code = 0): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    // Synchronous write of the cached snapshot — a Bun signal handler can't complete an
    // async PGlite read, so we must not build a fresh one here. The cache is kept current
    // by the debounced writes; the datadir itself remains the source of truth regardless.
    if (this.database) {
      cancelSnapshot(this.database);
      flushSnapshotSync(this.database);
    }
    process.exit(code);
  }

  private async handle(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // ignore malformed line, owner survives
    }
    // A reply from the app-global LLM host (Rust -> owner), not a query — route it and stop.
    if (handleHostReply(parsed)) return;
    const req = parsed as QueryRequest;
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
      if (action === 'finish_scan') {
        this.finishWithCommitted();
        this.send({ id, ok: true });
        return;
      }
      if (action === 'resume_scan') {
        await this.handleResumeScan(req);
        return;
      }

      // Close = delete: stop the scan, close the connection (frees the datadir's file
      // handles), remove the datadir, ack, then exit so the supervisor reaps this owner.
      if (action === 'delete_db') {
        await this.handleDeleteDb(id);
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

      // Precondition #2 as a WAIT, not a failure: if the run isn't loaded yet, await the
      // readiness latch (bounded) before deciding it's genuinely absent (race R2).
      if (!this.runId) await this.awaitRunLoaded();
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
        // Mirror the user's irreplaceable work to the durable snapshot after any
        // enrichment mutation (debounced; fire-and-forget — never affects the response).
        if (ENRICHMENT_MUTATIONS.has(action)) scheduleSnapshot(this.database, this.runId);
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
      const oldRunId = this.runId;
      // Same intent split as the `--no-create` flag: re-targeting a spare at an existing scan
      // is routine, creating a datadir for one that was deleted is not.
      if (req.create === false && !(await datadirExists(db))) {
        logger.info('switch_db refused: datadir absent and create=false', { dbName: db });
        this.send({ id, ok: false, error: 'db_absent' });
        return;
      }
      // Opening an existing datadir that Postgres can't recover (power-cut corruption)
      // throws here. Surface it as a typed 'datadir_damaged' so the UI offers Re-scan /
      // Delete instead of a raw error. The old connection is never swapped, so this process
      // stays usable either way.
      let next: DatabaseConnection;
      try {
        next = await createScanDatabase(db);
      } catch (openErr) {
        logger.error('Datadir failed to open (likely corrupted by unclean shutdown)', openErr as Error, {
          db,
        });
        this.send({ id, ok: false, error: 'datadir_damaged' });
        return;
      }
      await ensureEnrichmentTables(next);
      const rid = await new Promise<string | null>((resolve, reject) => {
        getLatestRunId(next).subscribe({ next: resolve, error: reject });
      });
      this.database = next;
      this.runId = rid ?? undefined;
      this.markRunLoaded(); // warm-reuse swap: the new db's run is now loaded
      if (old) {
        // Flush any pending annotation snapshot for the datadir we're leaving before its
        // connection closes (the debounce timer would otherwise fire on a closed handle).
        cancelSnapshot(old);
        if (oldRunId) await flushSnapshot(old, oldRunId);
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

  /** Refresh the datadir meta sidecar so startup reconciliation sees this scan's durable
   *  status without opening its PGlite. Best-effort; never blocks the transition. */
  private writeMeta(status: DatadirStatus, rootPath: string | null, fileCount: number | null): void {
    const dbName = this.database?.name;
    if (!dbName) return;
    void writeDatadirMeta({
      dbName,
      runId: this.runId ?? null,
      rootPath,
      status,
      fileCount,
    });
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
    this.markRunLoaded(); // fresh scan: unblock any query that arrived before the run loaded
    this.currentJobId = jobId;
    this.scanRootPath = rootPath;
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
      // Concurrent enumeration: the lever for high-latency NAS/cloud mounts. This is the
      // CAP — the walker auto-ramps the live concurrency below it on measured per-op
      // latency (≈floor on SSD, climbs to the cap on a slow mount). 32 matches the
      // measured cloud sweet spot; overridable per scan.
      enumerateConcurrency:
        typeof req.enumerateConcurrency === 'number'
          ? Math.max(1, Math.min(64, req.enumerateConcurrency))
          : 32,
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
      this.writeMeta('running', rootPath, null);
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
          // Canonical committed-so-far counts — the numbers every UI surface shows.
          counts: event.counts,
          skipped: event.skipped,
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
          let finalCount: number | null = null;
          try {
            // dir_stats is fully materialized by the per-batch rollup (or, on a frontier
            // resume, by the end-of-ingestion populateDirStats) — no spike here.
            if (lastResult) {
              // file_count from the DB, not the session counter — on a resumed run the
              // in-memory counter only saw the remainder. -1 sentinel → fall back.
              const exact = await firstValueFrom(countRunRows(this.database!, runId));
              finalCount = exact >= 0 ? exact : lastResult.filesIngested;
              await firstValueFrom(updateScanMetadata(this.database!, runId, finalCount));
            }
          } catch {
            /* best effort — metadata update must not crash the owner */
          }
          this.scanning = false;
          this.resetGovernor();
          this.writeMeta('complete', rootPath, finalCount);
          // A settled scan must survive power loss: force the datadir's dirty pages to
          // disk now (PGlite's NODEFS never fsyncs on its own). Cheap at this boundary.
          void settleDatadir(this.database);
          this.send({ event: 'job:complete', jobId, durationMs: Date.now() - startMs });
          // Now idle: build the warm-start template (initdb once) so the NEXT new db is a
          // ~125 ms copy instead of a ~3 s initdb. Fire-and-forget; no-op if already built.
          void ensureTemplateInBackground();
        })();
      },
    });
  }

  /**
   * "Finish with what I have": stop the walker pulling NEW directories but leave the subscription
   * intact, so the pipeline completes naturally on committed data (walker returns → last() →
   * hashing/dedup → the `complete:` handler → job:complete). Reuses the pause flag WITHOUT
   * unsubscribing, so it can't reopen the pause=unsubscribe soft-crash race. The scan is marked
   * complete — it simply didn't walk the whole tree (the user chose to land it early).
   */
  private finishWithCommitted(): void {
    if (!this.scanning) return;
    this.scanPaused = true;
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
    // Tell the UI FIRST: during the hashing phase PGlite can be busy with batched
    // hash updates for seconds, and the status write below queues behind them — the
    // button must not wait on that. Crash-safe ordering: if the process died before
    // the write, the run stays 'running' in the DB, which the interrupted-scan path
    // already treats as resumable.
    this.send({ event: 'job:paused', jobId: this.currentJobId });
    if (this.runId) {
      try {
        await firstValueFrom(setScanStatus(this.database!, this.runId, status));
        this.writeMeta(status, this.scanRootPath, null);
        // A paused scan is a settled state the user can leave for days — make it survive
        // power loss too (the frontier already makes it resumable, but only if its bytes
        // reached disk).
        if (status === 'paused') void settleDatadir(this.database);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Delete this owner's database and exit — the "close the tab = discard the scan" path.
   *
   * Order matters. Removing the datadir means unlinking ~1000 files, which on Windows runs past
   * the caller's 15 s wire timeout, so the tombstone is written and acked first and the removal
   * follows. Everything after the ack is interruptible: the tombstone alone keeps the scan
   * deleted, and `sweepTombstonedDatadirs` finishes the removal on a later run.
   */
  private async handleDeleteDb(id: string): Promise<void> {
    const db = this.database?.name;
    logger.info('Delete requested', { dbName: db ?? null });

    // Stop the scan first so nothing is writing into the datadir being discarded.
    this.scanPaused = true;
    this.scanSubscription?.unsubscribe();
    this.scanSubscription = undefined;
    this.scanning = false;

    // Read the root path while the connection is still open; it identifies the annotations
    // snapshot to discard. Keeping a copy is the File-menu export, a separate path.
    let discardRoot: string | null = null;
    if (this.database && this.runId) {
      try {
        const r = await this.database.pg.query<{ root_path: string }>(
          `SELECT root_path FROM scan_metadata WHERE run_id = $1`,
          [this.runId]
        );
        discardRoot = r.rows[0]?.root_path ?? null;
      } catch {
        /* metadata unreadable → skip snapshot cleanup, leave the file */
      }
      cancelSnapshot(this.database);
    }

    // The step that decides success: one small file, written before pg.close() so that a close
    // hanging under memory pressure cannot strand the deletion.
    try {
      if (db) await writeDatadirTombstone(db);
      logger.info('Delete tombstoned; removal continues in background', { dbName: db ?? null });
      this.send({ id, ok: true });
    } catch (e) {
      // The datadir is still on disk and still served: report the failure and stay alive, so
      // the tab is not dropped for a scan that remains.
      logger.error(
        'Delete failed: could not write the tombstone',
        e instanceof Error ? e : new Error(String(e))
      );
      this.send({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    // Slow, interruptible, best-effort from here on.
    try {
      if (this.database) await this.database.pg.close();
      if (db) await rm(getDatabasePath(db), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (discardRoot) await deleteSnapshot(discardRoot);
      if (db) await rm(datadirMetaPath(db), { force: true });
      logger.info('Delete complete', { dbName: db ?? null });
    } catch (e) {
      logger.warn('Delete removal incomplete; tombstone stands, sweep will retry', {
        dbName: db ?? null,
        error: (e as Error).message,
      });
    }
    // Let the ack flush down the pipe, then exit: the datadir is gone or tombstoned, so there
    // is nothing left to serve. The supervisor's stdout-closed handler marks this owner dead.
    setTimeout(() => process.exit(0), 50);
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
