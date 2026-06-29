/**
 * Single-owner DB session (Phase 1 of the read-while-scanning design).
 *
 * One long-lived process owns ONE PGlite connection and multiplexes, over stdio
 * JSON-lines:
 *   - ingestion writes  (start_scan → the real scanner pipeline)
 *   - UI reads          (get_tree / get_files / enrichment / … via dispatchQuery)
 * on the same connection. Because PGlite blocks the single JS thread, the scan
 * runs with cooperativeYield so reads slip in between write batches instead of
 * being starved. This is the only opener of the datadir, so reads during a scan
 * are safe by construction (no second process, no corruption).
 *
 * Wire format (one JSON object per line):
 *   in : {id, action, …}            (query)  | {id, action:'start_scan', path, runId?, …}
 *   out: {id, ok, data|error}       (response, correlated by id)
 *        {event:'ready'|'progress'|'scan:tree'|'complete'|'scan_error', …}  (async)
 */
import { Command, Flags } from '@oclif/core';
import * as readline from 'node:readline';
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

  private send(o: unknown): void {
    process.stdout.write(`${JSON.stringify(o)}\n`);
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

      const data = await dispatchQuery(this.database, this.runId, req);
      this.send({ id, ok: true, data });
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

    const scanConfig: ScanConfig = {
      rootPath,
      runId,
      includeHidden: !!req.includeHidden,
      batchSize: (req.batchSize as number) || 1000,
      enableArchiveProcessing: req.enableArchives !== false,
      cooperativeYield: true, // ← serve reads between write batches
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
    }
  }
}
