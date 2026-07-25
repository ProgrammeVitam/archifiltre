/**
 * Concurrency + backpressure policy of `callAI()`.
 * Run: bun test src/extensions/ai-describe/ai-api.test.ts
 */
import { test, expect } from 'bun:test';
import { registerProvider, callAI, type AiProvider } from '@extensions/ai-describe/ai-api.ts';

function tracker(id: string, kind: 'local' | 'remote') {
  const state = { concurrent: 0, peak: 0, calls: 0 };
  const p: AiProvider = {
    id,
    label: id,
    kind,
    async generate() {
      state.concurrent++;
      state.calls++;
      state.peak = Math.max(state.peak, state.concurrent);
      await new Promise((r) => setTimeout(r, 25));
      state.concurrent--;
      return { text: 'x', model: 'm' };
    },
  };
  registerProvider(p);
  return state;
}

const fire = (id: string, n: number) =>
  Promise.all(Array.from({ length: n }, () => callAI(id, { system: '', prompt: '', clientId: 'c' })));

test('remote providers are bounded-parallel (bulkhead caps concurrency at 4)', async () => {
  const s = tracker('test-remote', 'remote');
  await fire('test-remote', 12);
  expect(s.calls).toBe(12); // all complete (queued, not dropped)
  expect(s.peak).toBeLessThanOrEqual(4); // REMOTE_MAX_CONCURRENT
  expect(s.peak).toBeGreaterThan(1); // genuinely parallel, not serialized
});

test('local providers are NOT bounded by the remote pool', async () => {
  const s = tracker('test-local', 'local');
  await fire('test-local', 12);
  expect(s.calls).toBe(12);
  expect(s.peak).toBeGreaterThan(4); // bypasses the pool; real serialization is downstream (Rust queue)
});

test('external provider honors 429 Retry-After as backpressure (wait, not fail)', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response('busy', { status: 429, headers: { 'retry-after': '0' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'a summary' } }], model: 'm' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const r = await callAI('external', {
      system: 's',
      prompt: 'p',
      clientId: 'c',
      config: { baseUrl: 'http://mock', apiKey: 'k' },
    });
    expect(r.text).toContain('a summary');
    expect(calls).toBe(2); // retried once after the 429, then succeeded — no hard failure
  } finally {
    globalThis.fetch = orig;
  }
});
