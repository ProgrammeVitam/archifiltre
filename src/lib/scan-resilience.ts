/**
 * scan-resilience.ts — bound every external await so the scan stream ALWAYS
 * completes (finalize rides on stream completion; a hung producer await is the
 * only way a scan can get "stuck"). A failure/timeout degrades to a VALUE, never
 * an `error()` that could storm the pipeline. Mirrors the describe$ resilience
 * shape (retry the transient / fail the deterministic in one operator).
 */
import { sep } from 'node:path';
import { Observable, throwError, timer } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { isStreamArchiveError } from 'streamarchive';
import { circuitBreaker, handleWhen, ConsecutiveBreaker, isBrokenCircuitError, type IPolicy } from 'cockatiel';

/** Bounded transient-retry backoffs — same shape/values as describe$ (spans owner churn). */
export const RETRY_BACKOFFS_MS = [500, 1500, 4000] as const;

/** A deadline elapsed. Always TRANSIENT — the underlying op may just be slow. */
export class DeadlineError extends Error {
  readonly transient = true;
  readonly code = 'ERR_DEADLINE';
  constructor(public readonly ms: number) {
    super(`operation exceeded ${ms}ms deadline`);
    this.name = 'DeadlineError';
  }
}

/**
 * Run a cancelable async op as an Observable that ALWAYS terminates within `eachMs`.
 * On deadline `timeout` unsubscribes the source → teardown fires `ac.abort()`, so the
 * underlying work (streamarchive honors the signal) actually stops — mirrors describe$
 * where teardown IS the real cancel. `settled` guards against a late resolve/abort race.
 */
export function runCancelable<T>(op: (signal: AbortSignal) => Promise<T>, eachMs: number): Observable<T> {
  return new Observable<T>((sub) => {
    const ac = new AbortController();
    let settled = false;
    op(ac.signal).then(
      (v) => {
        if (!settled) {
          settled = true;
          sub.next(v);
          sub.complete();
        }
      },
      (e) => {
        if (!settled) {
          settled = true;
          sub.error(e);
        }
      }
    );
    return () => {
      if (!settled) {
        settled = true;
        ac.abort();
      }
    };
  }).pipe(timeout({ each: eachMs, with: () => throwError(() => new DeadlineError(eachMs)) }));
}

/** Default per-directory readdir/stat deadline. fs takes no AbortSignal, so a timeout only stops
 *  the waiting, not the operation: the dangling fd lives until the OS or NAS gives up, bounded in
 *  aggregate by enumerateConcurrency. The archive path, by contrast, is truly cancelable. */
export const DIR_TIMEOUT_MS = 30_000;

/** Race a non-cancelable promise against a deadline: the caller stops waiting so the walker
 *  proceeds and the scan stream still completes. See DIR_TIMEOUT_MS for why the underlying op
 *  can't be cancelled. */
export function raceDeadline<T>(op: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DeadlineError(ms)), ms);
    op.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// ── Error classification: retry the transient, skip the deterministic ────────
// streamarchive error codes (ErrorCodes) split cleanly; fs errno covers NAS/permission.

const SA_DETERMINISTIC = new Set([
  'ERR_CORRUPTED_ARCHIVE',
  'ERR_UNSUPPORTED_FORMAT',
  'ERR_ENCRYPTED_ARCHIVE',
  'ERR_ARCHIVE_READ',
  'ERR_ARCHIVE_OPEN',
  'ERR_INVALID_STATE',
]);
const SA_TRANSIENT = new Set(['ERR_IO', 'ERR_TIMEOUT', 'ERR_ABORTED', 'ERR_WASM_LOAD', 'ERR_MEMORY', 'ERR_ARCHIVE_CLOSED']);
const ERRNO_TRANSIENT = new Set(['ETIMEDOUT', 'EIO', 'ESTALE', 'EBUSY', 'EAGAIN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ECONNREFUSED']);
const ERRNO_DETERMINISTIC = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ENAMETOOLONG', 'EINVAL', 'EMFILE']);

function codeOf(err: unknown): string | undefined {
  return (err as { code?: unknown } | null)?.code as string | undefined;
}

/** Retry only what might succeed next time; skip the rest immediately (don't waste the scan). */
export function classify(err: unknown): 'transient' | 'deterministic' {
  if (err instanceof DeadlineError) return 'transient';
  if (isBrokenCircuitError(err)) return 'deterministic'; // breaker open → fast-skip, never retry
  // An abort in this system is OUR deadline firing (runCancelable aborts the op) → transient, and
  // it must reach the breaker so repeated timeouts on a sick volume trip it.
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'transient';
  const code = codeOf(err);
  if (isStreamArchiveError(err) && code) {
    if (SA_DETERMINISTIC.has(code)) return 'deterministic';
    if (SA_TRANSIENT.has(code)) return 'transient';
  }
  if (code && ERRNO_TRANSIENT.has(code)) return 'transient';
  if (code && ERRNO_DETERMINISTIC.has(code)) return 'deterministic';
  // Unknown → deterministic: skip once rather than retry a case whose behaviour is unknown.
  return 'deterministic';
}

/** Stable, blame-free reason class for the skip ledger + UI grouping (never a raw message). */
export type SkipReason =
  | 'timeout'
  | 'unreadable'
  | 'unsupported'
  | 'encrypted'
  | 'permission'
  | 'missing'
  | 'location-unavailable'
  | 'truncated'
  | 'error';

export function skipReason(err: unknown): SkipReason {
  if (err instanceof DeadlineError) return 'timeout';
  if (isBrokenCircuitError(err)) return 'location-unavailable';
  const code = codeOf(err);
  if (isStreamArchiveError(err) && code) {
    if (code === 'ERR_CORRUPTED_ARCHIVE' || code === 'ERR_ARCHIVE_READ' || code === 'ERR_ARCHIVE_OPEN') return 'unreadable';
    if (code === 'ERR_UNSUPPORTED_FORMAT') return 'unsupported';
    if (code === 'ERR_ENCRYPTED_ARCHIVE') return 'encrypted';
    if (code === 'ERR_TIMEOUT') return 'timeout';
  }
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'ENOENT' || code === 'ESTALE') return 'missing';
  if (code && ERRNO_TRANSIENT.has(code)) return 'timeout';
  return 'error';
}

// ── Per-volume circuit breaker (the scale lever for a dark share) ────────────

/** Key a breaker per volume so one dark NAS share opens ONE breaker and the rest of
 *  that share fast-skips, instead of every file retrying with backoff. UNC share or
 *  drive on win32; the scan root on posix (one breaker per scan). */
export function volumeKey(absPath: string, rootPath: string): string {
  if (process.platform === 'win32') {
    const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(absPath);
    if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase();
    const drive = /^([a-zA-Z]):/.exec(absPath);
    if (drive) return `${drive[1].toLowerCase()}:`;
  }
  return rootPath.endsWith(sep) ? rootPath : rootPath + sep;
}

/** Per-scan breaker registry (the Map lives in the scanDirectory closure, so it dies with the
 *  scan). Same settings as llmHostBreaker; `isBrokenCircuitError` classifies as deterministic. */
export function createBreakerRegistry(): (key: string) => IPolicy {
  const breakers = new Map<string, IPolicy>();
  return (key: string): IPolicy => {
    let b = breakers.get(key);
    if (!b) {
      // Trip on transient failures only: a dead share should fast-skip, but a run of corrupt
      // zips shouldn't penalize an otherwise healthy volume.
      b = circuitBreaker(handleWhen(err => classify(err) === 'transient'), {
        halfOpenAfter: 30_000,
        breaker: new ConsecutiveBreaker(5),
      });
      breakers.set(key, b);
    }
    return b;
  };
}
