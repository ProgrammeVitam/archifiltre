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
}
