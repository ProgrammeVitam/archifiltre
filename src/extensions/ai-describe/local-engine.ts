/**
 * Local inference engine — the sidecar's client for the on-device model.
 *
 * Replaces the old `llama-server`-on-127.0.0.1:8791 approach: we spawn a private **inference
 * helper** (bundled Node + node-llama-cpp, see {@link ./inference-helper.mjs}) and talk to it over
 * **stdin/stdout JSON-lines — NO server, NO listening port**. One helper per sidecar process,
 * lazily spawned, model kept warm, unloaded after idle to free the ~1 GB of RAM.
 *
 * The helper needs a real Node runtime (Bun segfaults on node-llama-cpp's N-API addon), so it
 * ships as a self-contained `af-infer` bundle (portable `node` + `node_modules` + the script),
 * fetched to `~/.archifiltre/bin/` like the model. `AF_INFER_DIR` overrides the location (dev).
 */
import { logger } from '@lib/logging.ts';
import {
  getLocalModel,
  isModelDownloaded,
  modelPath,
  rememberBackend,
  ensureInferenceHelper,
} from '@extensions/ai-describe/local-llm.ts';

/** Kill the helper (freeing the model's RAM) after this long with no requests. */
const IDLE_UNLOAD_MS = 5 * 60_000;

interface GenerateOpts {
  systemPrompt: string;
  userPrompt: string;
  onToken?: (delta: string) => void;
  maxTokens?: number;
}

// ── the running helper ──
type Pending = {
  onToken?: (d: string) => void;
  text: string;
  resolve: (text: string) => void;
  reject: (e: Error) => void;
};

let proc: import('bun').Subprocess | null = null;
let pendingSpawn: Promise<void> | null = null;
const handlers = new Map<number, Pending>();
let reqId = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Serialize generations onto one helper (summaries are one-at-a-time anyway). */
let queue: Promise<unknown> = Promise.resolve();

// Persist the backend node-llama-cpp actually used, so `localBackendIsGpu()` (the mid-scan GPU
// decision) reflects reality. Map the helper's report to the app's Backend enum; persist once.
let backendPersisted = false;
function persistBackend(reported: string | false) {
  if (backendPersisted) return;
  backendPersisted = true;
  const backend = !reported ? 'cpu' : reported === 'metal' ? 'metal' : 'vulkan';
  void rememberBackend(backend).catch(() => {});
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => shutdown(), IDLE_UNLOAD_MS);
}

function shutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const p = proc;
  proc = null;
  if (p) { try { p.kill(); } catch {} }
  for (const h of handlers.values()) h.reject(new Error('inference helper stopped'));
  handlers.clear();
}

async function readLoop(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: { id?: number; type?: string; delta?: string; text?: string; message?: string; backend?: string | false };
        try { msg = JSON.parse(line); } catch { continue; } // tolerate engine chatter on stdout
        if (msg.backend !== undefined) persistBackend(msg.backend); // node-llama-cpp's resolved GPU
        const h = msg.id != null ? handlers.get(msg.id) : undefined;
        if (!h) continue;
        if (msg.type === 'token') { h.text += msg.delta ?? ''; h.onToken?.(msg.delta ?? ''); }
        else if (msg.type === 'done') { handlers.delete(msg.id!); h.resolve(msg.text ?? h.text); }
        else if (msg.type === 'cancelled') { handlers.delete(msg.id!); h.resolve(h.text); }
        else if (msg.type === 'error') { handlers.delete(msg.id!); h.reject(new Error(msg.message || 'inference error')); }
      }
    }
  } catch {
    /* stream closed */
  }
  // Helper exited/stream ended — fail anything still pending so callers don't hang.
  for (const h of handlers.values()) h.reject(new Error('inference helper exited'));
  handlers.clear();
  if (proc) proc = null;
}

async function ensureRunning(): Promise<void> {
  if (proc) return;
  if (pendingSpawn) return pendingSpawn;
  pendingSpawn = (async () => {
    const { node, script, dir } = await ensureInferenceHelper();
    logger.info('inference helper: starting', { dir });
    proc = Bun.spawn([node, script], {
      cwd: dir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      // Windows: a console-subsystem node.exe would flash a window without this (same rule as
      // the app's sidecar_command CREATE_NO_WINDOW).
      windowsHide: true,
      onExit: () => { proc = null; },
    });
    void readLoop(proc.stdout as ReadableStream<Uint8Array>);
  })();
  try {
    await pendingSpawn;
  } finally {
    pendingSpawn = null;
  }
}

function writeReq(obj: unknown) {
  if (!proc) throw new Error('inference helper not running');
  const sink = proc.stdin as { write: (s: string) => void; flush: () => void };
  sink.write(JSON.stringify(obj) + '\n');
  sink.flush();
}

/**
 * Generate a folder summary on the on-device model, streaming tokens via `onToken`. Runs entirely
 * in the helper process — no port. The model must already be downloaded.
 * @throws if the model isn't downloaded or the helper fails.
 */
export async function generateLocal(
  modelId: string,
  opts: GenerateOpts
): Promise<{ description: string; model: string }> {
  const info = getLocalModel(modelId);
  if (!info) throw new Error(`Unknown local model: ${modelId}`);
  if (!(await isModelDownloaded(modelId))) {
    throw new Error(`Local model "${info.label}" is not downloaded yet.`);
  }

  // Serialize so two summaries never share one context sequence mid-flight.
  const run = queue.then(async () => {
    await ensureRunning();
    if (idleTimer) clearTimeout(idleTimer);
    const id = ++reqId;
    const text = await new Promise<string>((resolve, reject) => {
      handlers.set(id, { onToken: opts.onToken, text: '', resolve, reject });
      try {
        writeReq({
          id,
          type: 'generate',
          modelPath: modelPath(modelId),
          gpu: 'auto', // node-llama-cpp auto-detects GPU; the helper reports what it resolved

          system: opts.systemPrompt,
          prompt: opts.userPrompt,
          maxTokens: opts.maxTokens ?? 256,
        });
      } catch (e) {
        handlers.delete(id);
        reject(e as Error);
      }
    });
    armIdle();
    return { description: text, model: modelId };
  });
  // Keep the queue chain alive even if this run rejects.
  queue = run.catch(() => {});
  return run;
}

/** Stop the helper (frees the model RAM). Safe to call anytime. */
export function stopLocalEngine(): void {
  shutdown();
}
