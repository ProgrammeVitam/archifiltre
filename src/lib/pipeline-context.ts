import type { Subject } from 'rxjs';
import type { DatabaseConnection } from '@lib/database.ts';
import type { ProvisionalDir } from '@lib/job-context.ts';

export interface PipelineContext {
  readonly database: DatabaseConnection;
  readonly runId: string;
  readonly rootPath: string;
  onProgress?: (phase: string, processed: number, total: number | null, detail?: string) => void;
  /** Emit a provisional directory aggregate (for the live-growing icicle during a scan). */
  onTree?: (directories: ProvisionalDir[]) => void;
  pauseSignal?: Subject<void>;
  resumeSignal?: Subject<void>;
  /**
   * Read-priority hook: called by write pipelines (ingestion, hashing) BETWEEN
   * batches. The single-owner session provides one that yields the event loop and
   * then waits until any in-flight reads have drained — so a read arriving mid-scan
   * is served before the next write batch (the UI stays responsive). No-op cost when
   * nothing is waiting. Absent for the standalone scan (full write throughput).
   */
  betweenBatches?: () => Promise<void>;
}
