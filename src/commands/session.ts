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
 *   in : {id, action, …}            (query)  | {id, action:'start_scan', path, runId?, …}
 *   out: {id, ok, data|error}       (response, correlated by id)
 *        {event:'ready'|'progress'|'scan:tree'|'complete'|'scan_error', …}  (async)
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
  populateDirStats,
  type DatabaseConnection,
} from '@lib/database.ts';
import {
  scanDirectory,
  generateRunId,
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

      if (!this.runId) {
        this.send({ id, ok: false, error: 'No run loaded yet (start a scan first)' });
        return;
      }

      // get_tree / get_stats lazily materialize dir_stats, which must NOT run while
      // the files table is still growing (a partial dir_stats would be cached stale
      // for the whole run). The live graph uses get_files during a scan; the tree is
      // for the settled DB. (Phase 3 will serve a live tree another way.)
      if (this.scanning && (action === 'get_tree' || action === 'get_stats')) {
        this.send({ id, ok: false, error: 'unavailable_during_scan' });
        return;
      }

      // Count as an in-flight read so the scan yields to it (read priority).
      this.pendingReads++;
      try {
        const data = await dispatchQuery(this.database, this.runId, req);
        this.send({ id, ok: true, data });
      } finally {
        this.pendingReads--;
      }
    } catch (e) {
      // Per-request isolation: one failed query never takes the owner down.
      this.send({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async runScan(req: QueryRequest): Promise<void> {
    if (this.scanning) {
      this.send({ event: 'scan_error', error: 'already scanning' });
      return;
    }
    const rootPath = req.path as string;
    const runId = (req.runId as string) || generateRunId();
    this.runId = runId; // queries during the scan target this run
    this.scanning = true;
    const startedAt = Math.floor(Date.now() / 1000);

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
      const result = await lastValueFrom(
        scanDirectory(
          this.database!,
          scanConfig,
          (event: ScanProgressEvent) => this.send({ event: 'progress', ...event }),
          (directories) => this.send({ event: 'scan:tree', directories })
        )
      );
      await insertScanMetadata(this.database!, runId, rootPath, startedAt).toPromise();
      await updateScanMetadata(this.database!, runId, result.filesIngested).toPromise();
      // Materialize dir_stats now that the table is final → the first get_tree is instant.
      await populateDirStats(this.database!, runId);
      this.scanning = false;
      this.send({
        event: 'complete',
        run_id: runId,
        filesIngested: result.filesIngested,
        duplicateGroups: result.duplicateGroups,
      });
    } catch (e) {
      this.scanning = false;
      this.send({ event: 'scan_error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      // Back to full speed when idle (the governor only governs an active scan).
      this.cpuBudget = 1;
      this.autoThrottle = false;
    }
  }
}
