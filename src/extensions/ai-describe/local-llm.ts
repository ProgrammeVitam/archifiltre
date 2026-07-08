/**
 * Local LLM — run Qwen folder-summaries entirely on this machine.
 *
 * The "External" LLM provider ({@link ./llm-client.ts}) posts to a remote
 * OpenAI-compatible endpoint. This module gives the same feature *local and
 * private*: the user downloads a Qwen2.5 GGUF to `~/.archifiltre/models/`, and
 * inference runs IN-PROCESS via a private stdio helper — NO server, NO port
 * (see {@link ./local-engine.ts}). This file owns the model catalogue, the
 * download, the on-device backend preference, and fetching the `af-infer`
 * inference-helper bundle.
 *
 * Design notes:
 *   - The big model file is only ever fetched by an explicit user action
 *     ({@link downloadModel}); describing a folder never silently pulls GBs.
 *   - The `af-infer` helper bundle (portable node + node-llama-cpp) is fetched
 *     lazily on first use ({@link ensureInferenceHelper}) and extracted with
 *     fflate — no system `unzip`/`tar`.
 *   - Diagnostics log to the FILE logger (never stdout — the sidecar's stdout
 *     is the JSON-lines protocol; a stray line breaks the transport).
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, readdir, chmod, rm, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { platform, arch } from 'node:os';
import { unzipSync } from 'fflate';
import { getGlobalConfigManager } from '@lib/config.ts';
import { logger } from '@lib/logging.ts';

// === Model registry ===

export interface LocalModelFile {
  /** File name as stored on disk and on Hugging Face. */
  name: string;
  /** Direct download URL (HF `resolve/main`). */
  url: string;
  /** Expected size in bytes (for progress + a cheap "already downloaded" check). */
  size: number;
}

export interface LocalModelInfo {
  /** Stable identifier used across the wire and in Settings. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Model family, for grouping in the picker. */
  family: string;
  /** Speed/quality tier — the UI renders a localized note from this. */
  tier: 'fast' | 'balanced' | 'best';
  /** English speed/quality hint (fallback when the UI can't localize the tier). */
  note: string;
  /** Total download size in bytes. */
  size: number;
  /** GGUF files that make up the model (>1 for sharded models). */
  files: LocalModelFile[];
  /** SPDX-ish license tag, shown for transparency. */
  license: string;
}

const HF = 'https://huggingface.co';

/** One-file Q4_K_M model helper. */
function m(
  id: string,
  label: string,
  family: string,
  tier: LocalModelInfo['tier'],
  note: string,
  license: string,
  repo: string,
  file: string,
  size: number
): LocalModelInfo {
  return {
    id,
    label,
    family,
    tier,
    note,
    license,
    size,
    files: [{ name: file, url: `${HF}/${repo}/resolve/main/${file}`, size }],
  };
}

/**
 * The curated local-model catalogue — several open GGUF families the user can pick from,
 * Q4_K_M throughout (the quality/size sweet spot). Multilingual instruct models good at the
 * short French/English folder-summary task. License is shown for transparency; only openly
 * redistributable weights are listed (Qwen2.5 3B/72B are omitted — restrictive Qwen license).
 */
export const LOCAL_MODELS: LocalModelInfo[] = [
  m('qwen2.5-0.5b', 'Qwen2.5 0.5B', 'Qwen', 'fast', 'Fast & light', 'Apache-2.0',
    'Qwen/Qwen2.5-0.5B-Instruct-GGUF', 'qwen2.5-0.5b-instruct-q4_k_m.gguf', 491_400_032),
  m('qwen2.5-1.5b', 'Qwen2.5 1.5B', 'Qwen', 'balanced', 'Balanced quality and speed', 'Apache-2.0',
    'Qwen/Qwen2.5-1.5B-Instruct-GGUF', 'qwen2.5-1.5b-instruct-q4_k_m.gguf', 1_117_320_736),
  // Qwen2.5 7B is a 2-shard GGUF — llama-server auto-loads both from the first path.
  {
    id: 'qwen2.5-7b',
    label: 'Qwen2.5 7B',
    family: 'Qwen',
    tier: 'best',
    note: 'Best quality — heavier',
    license: 'Apache-2.0',
    size: 4_683_073_472 + 1_089_994_752,
    files: [
      {
        name: 'qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf',
        url: `${HF}/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf`,
        size: 4_683_073_472,
      },
      {
        name: 'qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf',
        url: `${HF}/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf`,
        size: 1_089_994_752,
      },
    ],
  },
  m('llama3.2-1b', 'Llama 3.2 1B', 'Llama', 'fast', 'Fast & light', 'Llama 3.2',
    'bartowski/Llama-3.2-1B-Instruct-GGUF', 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', 807_694_464),
  m('llama3.2-3b', 'Llama 3.2 3B', 'Llama', 'balanced', 'Balanced quality and speed', 'Llama 3.2',
    'bartowski/Llama-3.2-3B-Instruct-GGUF', 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', 2_019_377_696),
  m('gemma2-2b', 'Gemma 2 2B', 'Gemma', 'balanced', 'Balanced quality and speed', 'Gemma',
    'bartowski/gemma-2-2b-it-GGUF', 'gemma-2-2b-it-Q4_K_M.gguf', 1_708_582_752),
  m('phi3.5-mini', 'Phi-3.5 mini', 'Phi', 'balanced', 'Balanced quality and speed', 'MIT',
    'bartowski/Phi-3.5-mini-instruct-GGUF', 'Phi-3.5-mini-instruct-Q4_K_M.gguf', 2_393_232_672),
  m('mistral-7b', 'Mistral 7B v0.3', 'Mistral', 'best', 'Best quality — heavier', 'Apache-2.0',
    'bartowski/Mistral-7B-Instruct-v0.3-GGUF', 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf', 4_372_812_000),
];

/** The model used when the user hasn't picked one. */
export const DEFAULT_LOCAL_MODEL = 'qwen2.5-1.5b';

export function getLocalModel(id: string): LocalModelInfo | undefined {
  return LOCAL_MODELS.find((m) => m.id === id);
}

// === Paths ===

/** `~/.archifiltre` (the app home), from the shared config. */
function appHome(): string {
  return getGlobalConfigManager().getUserPaths().home;
}

function modelsDir(): string {
  return join(appHome(), 'models');
}

function binDir(): string {
  return join(appHome(), 'bin');
}

/** On-disk path of a model's first (or only) GGUF shard — what the server loads. */
export function modelPath(id: string): string {
  const info = getLocalModel(id);
  if (!info) throw new Error(`Unknown local model: ${id}`);
  return join(modelsDir(), info.files[0].name);
}

async function fileHasSize(path: string, expected: number): Promise<boolean> {
  try {
    const s = await stat(path);
    // Accept a small tolerance — HF sizes are exact, but never require byte-perfection.
    return s.isFile() && Math.abs(s.size - expected) < 1024;
  } catch {
    return false;
  }
}

/** True only when every shard of the model is present at its expected size. */
export async function isModelDownloaded(id: string): Promise<boolean> {
  const info = getLocalModel(id);
  if (!info) return false;
  for (const f of info.files) {
    if (!(await fileHasSize(join(modelsDir(), f.name), f.size))) return false;
  }
  return true;
}

// === Model download ===

export type DownloadProgress = {
  /** Bytes downloaded so far across all shards. */
  received: number;
  /** Total bytes to download. */
  total: number;
  /** File currently downloading. */
  file: string;
};

// === Download diagnostics ===
// A model/binary download that silently sits at 0% is a black box on a user's machine,
// especially on locked-down corporate networks (proxy, TLS interception, firewall). These
// helpers make every fetch loggable (to the FILE logger — never stdout, which is the JSON
// protocol) and categorize the failure so cert-reject vs DNS vs timeout vs proxy is legible.

/** No data for this long ⇒ treat the connection as dead. A firewall blackhole fails here in
 *  ~30 s instead of hanging for minutes; a slow-but-live transfer keeps resetting the timer. */
const DOWNLOAD_STALL_MS = 30_000;

export type DownloadErrorCategory =
  | 'tls-cert' // TLS/cert rejected — classic corporate MITM inspection with an untrusted root
  | 'dns' // name resolution failed — DNS blocked or offline
  | 'connect-timeout' // no connection / no first byte / stalled mid-stream — firewall or dead link
  | 'proxy-auth' // HTTP 407 — a proxy demands authentication
  | 'http-status' // reachable but the server refused (404/403/5xx)
  | 'disk' // local write failed — no space / permissions
  | 'unknown';

/** A download failure with a machine-legible category the UI can turn into a real message. */
export class DownloadError extends Error {
  category: DownloadErrorCategory;
  httpStatus?: number;
  constructor(message: string, category: DownloadErrorCategory, httpStatus?: number) {
    super(message);
    this.name = 'DownloadError';
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

/** Classify a thrown fetch/stream error. Bun/undici wrap the real reason in `.cause`, so we
 *  inspect both the error and its cause (code + message) — that's what tells cert from DNS
 *  from timeout from proxy apart. */
function categorizeError(err: unknown): DownloadErrorCategory {
  const e = err as { code?: unknown; message?: unknown; name?: unknown; cause?: { code?: unknown; message?: unknown } };
  const codes = [e?.code, e?.cause?.code, e?.name].filter(Boolean).map(String);
  const text = `${String(e?.message ?? '')} ${String(e?.cause?.message ?? '')}`;
  const hit = (re: RegExp) => codes.some((c) => re.test(c)) || re.test(text);
  if (hit(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|SSL|certificate|handshake/i)) return 'tls-cert';
  if (hit(/ENOTFOUND|EAI_AGAIN|getaddrinfo|failed to resolve|dns/i)) return 'dns';
  if (hit(/ENOSPC|EACCES|EPERM|EROFS|EDQUOT|no space|disk/i)) return 'disk';
  // Connection failures — covers libuv errnos AND Bun/undici's plain-English phrasings
  // ("Unable to connect", "ConnectionRefused", "was not able to access the url", …).
  if (
    hit(
      /ABORT|TIMEOUT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EPIPE|UND_ERR_CONNECT|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|SocketNotConnected|unable to connect|failed to connect|able to access|connection (refused|closed|reset|timed out)|stalled/i
    )
  )
    return 'connect-timeout';
  return 'unknown';
}

/** Log a download failure with the detail that makes it diagnosable (category + errno + cause),
 *  then return a categorized DownloadError to throw. */
function failDownload(what: string, ctx: Record<string, unknown>, err: unknown): DownloadError {
  if (err instanceof DownloadError) {
    logger.error(`${what} failed`, err, { ...ctx, category: err.category, httpStatus: err.httpStatus });
    return err;
  }
  const category = categorizeError(err);
  const e = err as { code?: unknown; cause?: { code?: unknown; message?: unknown } };
  logger.error(`${what} failed`, err instanceof Error ? err : new Error(String(err)), {
    ...ctx,
    category,
    code: e?.code != null ? String(e.code) : undefined,
    causeCode: e?.cause?.code != null ? String(e.cause.code) : undefined,
    causeMessage: e?.cause?.message != null ? String(e.cause.message) : undefined,
  });
  return new DownloadError((err as Error)?.message ?? String(err), category);
}

/** An AbortController that aborts if `arm()` isn't called again within DOWNLOAD_STALL_MS. Arm it
 *  before the fetch (connect deadline) and again on every chunk (stall deadline). */
function stallGuard() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`stalled: no data for ${DOWNLOAD_STALL_MS}ms`)), DOWNLOAD_STALL_MS);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
  };
  return { signal: controller.signal, arm, clear };
}

/**
 * Download every shard of a model to `~/.archifiltre/models/`, streaming to a
 * `.part` file and atomically renaming on success. Shards already present at
 * the right size are skipped, so this is safe to call repeatedly / to resume
 * an interrupted set (per-file; a half-written shard restarts).
 *
 * @throws {DownloadError} if a download fails, stalls, or a shard ends up the wrong size.
 */
export async function downloadModel(
  id: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  const info = getLocalModel(id);
  if (!info) throw new Error(`Unknown local model: ${id}`);
  await mkdir(modelsDir(), { recursive: true });

  const total = info.files.reduce((n, f) => n + f.size, 0);
  let received = 0;
  logger.info('model download started', { model: id, shards: info.files.length, totalBytes: total });

  for (const f of info.files) {
    const dest = join(modelsDir(), f.name);
    if (await fileHasSize(dest, f.size)) {
      received += f.size;
      onProgress?.({ received, total, file: f.name });
      continue;
    }

    const tmp = `${dest}.part`;
    await rm(tmp, { force: true }).catch(() => {});
    logger.info('model download: fetching shard', { model: id, file: f.name, url: f.url, expectedBytes: f.size });

    const guard = stallGuard();
    guard.arm(); // connect deadline
    let res: Response;
    try {
      res = await fetch(f.url, { signal: guard.signal });
    } catch (err) {
      guard.clear();
      throw failDownload('model download', { model: id, file: f.name, url: f.url }, err);
    }
    if (!res.ok || !res.body) {
      guard.clear();
      const category: DownloadErrorCategory = res.status === 407 ? 'proxy-auth' : 'http-status';
      throw failDownload(
        'model download',
        { model: id, file: f.name, url: f.url, status: res.status },
        new DownloadError(`HTTP ${res.status} for ${f.name}`, category, res.status)
      );
    }
    logger.info('model download: shard response', {
      model: id,
      file: f.name,
      status: res.status,
      contentLength: res.headers.get('content-length') ?? undefined,
    });

    const out = createWriteStream(tmp);
    const base = received;
    let sawFirstByte = false;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!sawFirstByte) {
          logger.info('model download: first bytes received', { model: id, file: f.name });
          sawFirstByte = true;
        }
        out.write(chunk);
        received += chunk.byteLength;
        guard.arm(); // reset the stall deadline on every chunk
        onProgress?.({ received, total, file: f.name });
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      guard.clear();
      out.destroy();
      await rm(tmp, { force: true }).catch(() => {});
      throw failDownload('model download', { model: id, file: f.name, url: f.url }, err);
    }
    guard.clear();

    if (!(await fileHasSize(tmp, f.size))) {
      const got = await stat(tmp).then((s) => s.size).catch(() => 0);
      await rm(tmp, { force: true }).catch(() => {});
      logger.error('model download: shard size mismatch', undefined, { model: id, file: f.name, got, expected: f.size });
      throw new DownloadError(`Downloaded ${f.name} has wrong size (${got} vs ${f.size})`, 'connect-timeout');
    }
    await rename(tmp, dest);
    // Re-anchor the running tally on the shard's real size (chunk sums can drift).
    received = base + f.size;
    onProgress?.({ received, total, file: f.name });
    logger.info('model download: shard complete', { model: id, file: f.name, bytes: f.size });
  }

  logger.info('model download complete', { model: id, path: modelPath(id) });
  return modelPath(id);
}

// === Inference backend preference ===

/** Inference backend for the spawned server. `metal` = the default macOS build (GPU built in). */
type Backend = 'vulkan' | 'metal' | 'cpu';

const backendPrefPath = () => join(binDir(), 'backend');

function readBackendPref(): Backend | null {
  try {
    const v = readFileSync(backendPrefPath(), 'utf8').trim();
    return v === 'vulkan' || v === 'metal' || v === 'cpu' ? v : null;
  } catch {
    return null;
  }
}

export async function rememberBackend(backend: Backend): Promise<void> {
  try {
    await mkdir(binDir(), { recursive: true });
    await writeFile(backendPrefPath(), backend, 'utf8');
  } catch {
    /* best-effort — worst case we re-probe next launch */
  }
}

/**
 * True when a GPU backend (Vulkan/Metal) is known to work on this machine. Used to decide
 * whether it's safe to summarize DURING a scan: GPU inference doesn't touch the CPU cores the
 * file walk + hashing need, so it runs concurrently without starving the scan. Conservative —
 * only reports GPU once a GPU server has actually come up (persisted), so the very first scan
 * on a fresh install still defers until the backend is proven.
 */
export function localBackendIsGpu(): boolean {
  const b = readBackendPref();
  return b === 'vulkan' || b === 'metal';
}

// === Local inference helper bundle ===
// The on-device model no longer runs as a `llama-server` on a TCP port. Inference now happens
// IN-PROCESS via a private stdio helper — see `local-engine.ts` (`generateLocal`). No server, no
// listening socket. The helper needs a real Node runtime (Bun segfaults on node-llama-cpp's N-API
// addon), so it ships as a self-contained `af-infer` bundle (portable node + node_modules + the
// helper script), JIT-fetched to `~/.archifiltre/bin/` and extracted with fflate — NO system
// `unzip`/`tar` (which aren't guaranteed on Windows).

/** Bump deliberately (a reviewed change), like the llama.cpp tag — the asset below must exist. */
const INFER_HELPER_VERSION = 'v1';
const INFER_HELPER_HOST = 'https://REDACTED';

function inferAssetName(): string {
  const os = platform() === 'win32' ? 'win' : platform() === 'darwin' ? 'macos' : 'linux';
  return `af-infer-${os}-${arch()}-${INFER_HELPER_VERSION}`;
}

/** Where the extracted `af-infer` bundle lives. `AF_INFER_DIR` overrides it (dev / a pre-placed bundle). */
export function inferenceHelperDir(): string {
  return process.env.AF_INFER_DIR || join(binDir(), inferAssetName());
}

/**
 * Ensure the `af-infer` bundle (portable node + node_modules + `helper.mjs`) is on disk, fetching
 * + extracting it on first use. Returns the node binary + helper script paths.
 * @throws {DownloadError} on a network failure (categorized, like model downloads).
 */
export async function ensureInferenceHelper(): Promise<{ node: string; script: string; dir: string }> {
  const dir = inferenceHelperDir();
  const nodeBin = join(dir, platform() === 'win32' ? 'node.exe' : 'node');
  const script = join(dir, 'helper.mjs');
  if (existsSync(nodeBin) && existsSync(script)) return { node: nodeBin, script, dir };
  if (process.env.AF_INFER_DIR) {
    throw new Error(`Inference helper bundle incomplete at AF_INFER_DIR=${dir} (need node + helper.mjs).`);
  }

  const url = `${INFER_HELPER_HOST}/${inferAssetName()}.zip`;
  logger.info('inference helper: fetching', { url });
  await mkdir(dir, { recursive: true });

  // Fetch with the stall watchdog + categorized errors (same plumbing as model downloads).
  const guard = stallGuard();
  guard.arm();
  let res: Response;
  try {
    res = await fetch(url, { signal: guard.signal });
  } catch (err) {
    guard.clear();
    throw failDownload('inference helper download', { url }, err);
  }
  if (!res.ok || !res.body) {
    guard.clear();
    const category: DownloadErrorCategory = res.status === 407 ? 'proxy-auth' : 'http-status';
    throw failDownload('inference helper download', { url, status: res.status }, new DownloadError(`HTTP ${res.status}`, category, res.status));
  }
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      guard.arm();
    }
  } catch (err) {
    guard.clear();
    throw failDownload('inference helper download', { url }, err);
  }
  guard.clear();

  // Extract with fflate — pure JS, bundles into the compiled sidecar, no system unzip/tar.
  const zipBytes = Buffer.concat(chunks);
  logger.info('inference helper: extracting', { bytes: zipBytes.length });
  const files = unzipSync(new Uint8Array(zipBytes));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const dest = join(dir, name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }
  if (platform() !== 'win32') await chmod(nodeBin, 0o755).catch(() => {});

  if (!existsSync(nodeBin) || !existsSync(script)) {
    throw new Error('inference helper bundle incomplete after extraction.');
  }
  logger.info('inference helper: ready', { dir });
  return { node: nodeBin, script, dir };
}
