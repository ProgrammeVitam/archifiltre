import type { Subject } from 'rxjs';
import type { DatabaseConnection } from '@lib/database.ts';

export interface PipelineContext {
  readonly database: DatabaseConnection;
  readonly runId: string;
  readonly rootPath: string;
  onProgress?: (phase: string, processed: number, total: number | null, detail?: string) => void;
  pauseSignal?: Subject<void>;
  resumeSignal?: Subject<void>;
}
