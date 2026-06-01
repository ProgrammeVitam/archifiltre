import * as readline from 'node:readline';
import { Subject } from 'rxjs';
import type { DatabaseConnection } from '@lib/database.ts';
import type { JobContext, JobEvent, ControlSignal } from '@lib/job-context.ts';

export class JobReporter {
  private readonly jobId: string;
  readonly pauseSignal = new Subject<void>();
  readonly resumeSignal = new Subject<void>();
  private readonly abortController = new AbortController();
  private readonly startTime = Date.now();
  private rl: readline.Interface | null = null;

  constructor(jobId: string) {
    this.jobId = jobId;
    this.listenStdin();
  }

  private listenStdin(): void {
    if (!process.stdin.readable) return;
    this.rl = readline.createInterface({ input: process.stdin, terminal: false });
    this.rl.on('line', line => {
      try {
        const ctrl = JSON.parse(line) as ControlSignal;
        if (ctrl.signal === 'pause') {
          this.pauseSignal.next();
          this.emit({ event: 'job:paused', jobId: this.jobId });
        } else if (ctrl.signal === 'resume') {
          this.resumeSignal.next();
        } else if (ctrl.signal === 'cancel') {
          this.abortController.abort();
        }
      } catch {
        // ignore non-JSON lines on stdin
      }
    });
  }

  emit(event: JobEvent): void {
    process.stdout.write(JSON.stringify(event) + '\n');
  }

  start(type: string, label: string, phases: string[]): void {
    this.emit({ event: 'job:start', jobId: this.jobId, type, label, phases });
  }

  complete(): void {
    this.emit({ event: 'job:complete', jobId: this.jobId, durationMs: Date.now() - this.startTime });
    this.close();
  }

  error(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.emit({ event: 'job:error', jobId: this.jobId, error: message });
    this.close();
  }

  createContext(database: DatabaseConnection, runId: string, rootPath: string): JobContext {
    const reporter = this;
    return {
      database,
      runId,
      rootPath,
      jobId: this.jobId,
      signal: this.abortController.signal,
      pauseSignal: this.pauseSignal,
      resumeSignal: this.resumeSignal,
      onProgress(phase, processed, total, detail) {
        reporter.emit({
          event: 'job:progress',
          jobId: reporter.jobId,
          phase,
          processed,
          total,
          detail: detail ?? '',
        });
      },
    };
  }

  private close(): void {
    this.pauseSignal.complete();
    this.resumeSignal.complete();
    this.rl?.close();
    this.rl = null;
  }
}
