import type { PipelineContext } from '@lib/pipeline-context.ts';

export type JobEvent =
  | { event: 'job:start';    jobId: string; type: string; label: string; phases: string[] }
  | { event: 'job:progress'; jobId: string; phase: string; processed: number; total: number | null; detail: string }
  | { event: 'job:paused';   jobId: string }
  | { event: 'job:complete'; jobId: string; durationMs: number }
  | { event: 'job:error';    jobId: string; error: string }

export type ControlSignal = { signal: 'pause' | 'resume' | 'cancel' }

export interface JobContext extends PipelineContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
}
