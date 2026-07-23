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

/**
 * Canonical count vocabulary — the ONE definition every surface (status bar, panel,
 * tree, completion) shows, in every state, always equal to the database:
 *   files   = non-directory rows (real files + archive entries — a file in a zip IS a file)
 *   folders = directory rows     (real dirs + directories inside archives)
 *   archiveEntries = files whose parent is an archive (a sub-count of `files`)
 *   bytes   = physical (on-disk) size sum
 * During a scan these are COMMITTED-so-far counts (DB-true, always ≤ final), never the
 * walker's pre-expansion "discovered" guess.
 */
export interface ScanCounts {
  files: number;
  folders: number;
  archiveEntries: number;
  bytes: number;
}

export type JobEvent =
  | { event: 'job:start';    jobId: string; type: string; label: string; phases: string[] }
  | { event: 'job:progress'; jobId: string; phase: string; processed: number; total: number | null; detail: string; counts?: ScanCounts; skipped?: { total: number; byReason: Record<string, number> } }
  | { event: 'job:paused';   jobId: string }
  | { event: 'job:complete'; jobId: string; durationMs: number }
  | { event: 'job:error';    jobId: string; error: string }
  | { event: 'scan:tree';    jobId: string; directories: ProvisionalDir[] }

export type ControlSignal = { signal: 'pause' | 'resume' | 'cancel' }

export interface JobContext extends PipelineContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
}
