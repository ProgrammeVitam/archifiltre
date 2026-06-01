import { Observable, identity } from 'rxjs';
import type { Subject } from 'rxjs';
import type { MonoTypeOperatorFunction } from 'rxjs';

interface PauseSignals {
  pauseSignal?: Subject<void>;
  resumeSignal?: Subject<void>;
}

/**
 * Operator that buffers items when `pauseSignal` emits and flushes when `resumeSignal` emits.
 * Passes through unchanged when either signal is absent (no-op by default).
 */
export function pausable<T>(signals: PauseSignals): MonoTypeOperatorFunction<T> {
  const { pauseSignal, resumeSignal } = signals;
  if (!pauseSignal || !resumeSignal) {
    return identity as MonoTypeOperatorFunction<T>;
  }

  return (source: Observable<T>) =>
    new Observable<T>(subscriber => {
      let paused = false;
      let sourceCompleted = false;
      const buffer: T[] = [];

      function flush(): void {
        while (!paused && buffer.length > 0 && !subscriber.closed) {
          subscriber.next(buffer.shift()!);
        }
        if (!paused && sourceCompleted && buffer.length === 0 && !subscriber.closed) {
          subscriber.complete();
        }
      }

      const pauseSub = pauseSignal.subscribe(() => {
        paused = true;
      });

      const resumeSub = resumeSignal.subscribe(() => {
        paused = false;
        flush();
      });

      const sourceSub = source.subscribe({
        next(item) {
          if (paused) {
            buffer.push(item);
          } else {
            subscriber.next(item);
          }
        },
        error(err) {
          subscriber.error(err);
        },
        complete() {
          sourceCompleted = true;
          if (buffer.length === 0) {
            subscriber.complete();
          }
        },
      });

      return () => {
        pauseSub.unsubscribe();
        resumeSub.unsubscribe();
        sourceSub.unsubscribe();
      };
    });
}
