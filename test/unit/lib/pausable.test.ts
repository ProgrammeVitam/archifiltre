/**
 * Unit tests for src/lib/pausable.ts
 *
 * Verifies the operator's pause/buffer/resume/complete semantics without any database.
 */

import { describe, it, expect } from 'vitest';
import { Subject, from, toArray, lastValueFrom } from 'rxjs';
import { pausable } from '@lib/pausable.ts';

describe('pausable', () => {
  it('is a transparent pass-through when no signals are configured', async () => {
    const result = await lastValueFrom(
      from([1, 2, 3]).pipe(pausable({}), toArray())
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it('passes items through while not paused', async () => {
    const pause$ = new Subject<void>();
    const resume$ = new Subject<void>();

    const result = await lastValueFrom(
      from([1, 2, 3]).pipe(
        pausable({ pauseSignal: pause$, resumeSignal: resume$ }),
        toArray()
      )
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it('buffers items when paused and flushes them on resume', async () => {
    const pause$ = new Subject<void>();
    const resume$ = new Subject<void>();
    const source$ = new Subject<number>();
    const emitted: number[] = [];

    const done = new Promise<void>(resolve => {
      source$
        .pipe(pausable({ pauseSignal: pause$, resumeSignal: resume$ }))
        .subscribe({
          next: v => emitted.push(v),
          complete: resolve,
        });
    });

    source$.next(1);                    // flows through immediately
    expect(emitted).toEqual([1]);

    pause$.next();                      // now paused

    source$.next(2);                    // buffered
    source$.next(3);                    // buffered
    expect(emitted).toEqual([1]);       // 2 and 3 held

    resume$.next();                     // flush
    expect(emitted).toEqual([1, 2, 3]);

    source$.complete();
    await done;
    expect(emitted).toEqual([1, 2, 3]);
  });

  it('defers complete until buffer is flushed when source completes while paused', async () => {
    const pause$ = new Subject<void>();
    const resume$ = new Subject<void>();
    const source$ = new Subject<number>();
    const emitted: number[] = [];

    const done = new Promise<void>(resolve => {
      source$
        .pipe(pausable({ pauseSignal: pause$, resumeSignal: resume$ }))
        .subscribe({ next: v => emitted.push(v), complete: resolve });
    });

    pause$.next();
    source$.next(1);
    source$.next(2);
    source$.complete();                 // completes while paused — deferred

    expect(emitted).toEqual([]);        // nothing forwarded yet

    resume$.next();                     // flush + complete fires
    await done;
    expect(emitted).toEqual([1, 2]);
  });

  it('pause mid-flight buffers remaining items; resume completes the observable', async () => {
    const pause$ = new Subject<void>();
    const resume$ = new Subject<void>();

    const promise = lastValueFrom(
      from([1, 2, 3, 4, 5]).pipe(
        pausable({ pauseSignal: pause$, resumeSignal: resume$ }),
        toArray()
      )
    );

    // Pause before the synchronous from() emissions are consumed
    pause$.next();
    await Promise.resolve(); // yield to let the observable advance

    resume$.next();

    const result = await promise;
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });
});
