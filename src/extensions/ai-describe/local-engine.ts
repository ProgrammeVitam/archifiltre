/**
 * Local inference engine — the sidecar's client for the on-device model.
 *
 * Replaces the old `llama-server`-on-127.0.0.1:8791 approach: we re-invoke THIS sidecar binary in
 * `llm-helper` mode (a Bun subprocess — {@link ../../commands/llm-helper.ts}) and talk to it over
 * **stdin/stdout JSON-lines — NO server, NO listening port, NO separate Node runtime**.
 * node-llama-cpp runs under Bun; it's an external dep resolved from the `node_modules` bundled next
 * to the binary at install time (like the sidecar). One helper per sidecar process, lazily spawned,
 * model kept warm, unloaded after idle to free the ~1 GB of RAM.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '@lib/logging.ts';
import {
  getLocalModel,
  isModelDownloaded,
  modelPath,
  rememberBackend,
} from '@extensions/ai-describe/local-llm.ts';

/** Kill the helper (freeing the model's ~1 GB) after this long with no requests. Generous so the
 *  model stays warm across a working session — a warm describe is ~0.7 s vs ~9 s cold (model
 *  reload). Pre-warming (see {@link warmLocal}) loads it before the first describe. */
const IDLE_UNLOAD_MS = 20 * 60_000;

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
/** The helper's last `fatal` reason (engine couldn't start), surfaced when it exits. */
let lastFatal: string | null = null;
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
        // The helper couldn't start the engine at all (runtime not bundled, bad prebuilt, …). It has
        // no request id — remember the reason so the exit below reports it, not a generic "exited".
        if (msg.type === 'fatal') { lastFatal = msg.message || 'AI runtime not available'; continue; }
        const h = msg.id != null ? handlers.get(msg.id) : undefined;
        if (!h) continue;
        if (msg.type === 'token') { h.text += msg.delta ?? ''; h.onToken?.(msg.delta ?? ''); }
        else if (msg.type === 'loaded') { handlers.delete(msg.id!); h.resolve(h.text); } // warm-up reply
        else if (msg.type === 'done') { handlers.delete(msg.id!); h.resolve(msg.text ?? h.text); }
        else if (msg.type === 'cancelled') { handlers.delete(msg.id!); h.resolve(h.text); }
        else if (msg.type === 'error') { handlers.delete(msg.id!); h.reject(new Error(msg.message || 'inference error')); }
      }
    }
  } catch {
    /* stream closed */
  }
  // Helper exited/stream ended — fail anything still pending so callers don't hang. Prefer the
  // helper's own fatal reason ("AI runtime not available…") over a generic "exited".
  const reason = lastFatal || 'AI runtime not available';
  for (const h of handlers.values()) h.reject(new Error(reason));
  handlers.clear();
  if (proc) proc = null;
}

/** Re-invoke THIS binary in `llm-helper` mode. Compiled sidecar: `<exe> llm-helper`. Dev
 *  (`bun run src/main.ts`): `<bun> <main.ts> llm-helper`. */
function helperArgv(): string[] {
  const exe = process.execPath;
  const isBunDev = /[/\\]bun(\.exe)?$/i.test(exe);
  return isBunDev ? [exe, process.argv[1], 'llm-helper'] : [exe, 'llm-helper'];
}

/** Find the dir whose `node_modules/node-llama-cpp` we can resolve — set as the helper's cwd so
 *  node-llama-cpp (an external dep) loads from the bundle shipped next to the binary. Candidates
 *  cover dev (project cwd) and the packaged layouts (next to the exe / a resources subdir).
 *  `AF_LLM_DIR` overrides (tests / unusual layouts). */
function resolveLlmCwd(): string {
  const exeDir = dirname(process.execPath);
  const candidates = [
    process.env.AF_LLM_DIR,
    process.cwd(),
    exeDir,
    join(exeDir, 'resources'),
    join(exeDir, 'llm-runtime'),
    join(exeDir, 'resources', 'llm-runtime'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, 'node_modules', 'node-llama-cpp'))) return c;
  }
  return process.cwd();
}

async function ensureRunning(): Promise<void> {
  if (proc) return;
  if (pendingSpawn) return pendingSpawn;
  pendingSpawn = (async () => {
    const argv = helperArgv();
    const cwd = resolveLlmCwd();
    lastFatal = null; // fresh start — forget any prior fatal
    logger.info('llm-helper: starting', { cwd });
    proc = Bun.spawn(argv, {
      cwd,
      // The helper chdir's to its app-data dir at startup, so cwd alone can't point it at the
      // runtime bundle — pass the bundle dir explicitly. AF_LLM_DIR wins in the helper's resolver.
      env: { ...process.env, AF_LLM_DIR: cwd },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      // Windows: a console-subsystem child would flash a window without this (same rule as the
      // app's sidecar_command CREATE_NO_WINDOW).
      windowsHide: true,
      onExit: () => {
        proc = null;
      },
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

/**
 * Pre-load the model into (GPU) memory WITHOUT generating, so the first real describe is warm
 * (~0.7 s) instead of cold (~9 s model reload). Idempotent — a `load` when the model is already
 * resident returns immediately. Fire it early (e.g. when a scan starts in local-AI mode): the load
 * runs in the background while the walk proceeds. Never throws; resolves `{ok:false}` if the model
 * isn't downloaded or the engine is unavailable.
 */
export async function warmLocal(modelId: string): Promise<{ ok: boolean }> {
  const info = getLocalModel(modelId);
  if (!info || !(await isModelDownloaded(modelId))) return { ok: false };
  const run = queue.then(async () => {
    await ensureRunning();
    if (idleTimer) clearTimeout(idleTimer);
    const id = ++reqId;
    await new Promise<void>((resolve, reject) => {
      handlers.set(id, { onToken: undefined, text: '', resolve: () => resolve(), reject });
      try {
        writeReq({ id, type: 'load', modelPath: modelPath(modelId), gpu: 'auto' });
      } catch (e) {
        handlers.delete(id);
        reject(e as Error);
      }
    });
    armIdle();
    return { ok: true };
  });
  queue = run.catch(() => {});
  return run.catch(() => ({ ok: false }));
}

/** Stop the helper (frees the model RAM). Safe to call anytime. */
export function stopLocalEngine(): void {
  shutdown();
}
