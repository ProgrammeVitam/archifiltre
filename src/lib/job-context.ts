import type { PipelineContext } from '@lib/pipeline-context.ts';

/**
 * A coarse, depth-capped directory aggregate streamed during a scan so the UI
 * can render a provisional icicle that grows in real time (paths relative to
 * the scan root, like the DB).
 */
export interface ProvisionalDir {
  path: string;
  total_size: number;
  file_count: number;
  dir_count: number;
}

export type JobEvent =
  | { event: 'job:start';    jobId: string; type: string; label: string; phases: string[] }
  | { event: 'job:progress'; jobId: string; phase: string; processed: number; total: number | null; detail: string }
  | { event: 'job:paused';   jobId: string }
  | { event: 'job:complete'; jobId: string; durationMs: number }
  | { event: 'job:error';    jobId: string; error: string }
  | { event: 'scan:tree';    jobId: string; directories: ProvisionalDir[] }

export type ControlSignal = { signal: 'pause' | 'resume' | 'cancel' }

export interface JobContext extends PipelineContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
}
