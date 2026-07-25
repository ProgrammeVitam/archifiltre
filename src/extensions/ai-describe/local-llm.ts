/**
 * Local LLM — run Qwen folder-summaries entirely on this machine.
 *
 * The "External" LLM provider ({@link ./llm-client.ts}) posts to a remote
 * OpenAI-compatible endpoint. This module gives the same feature *local and
 * private*: the user downloads a Qwen2.5 GGUF to `~/.archifiltre/models/`, and
 * inference runs IN-PROCESS via a private stdio helper — NO server, NO port,
 * NO separate Node runtime (see {@link ./local-engine.ts} + the `llm-helper`
 * command). This file owns the model catalogue, the download, and the on-device
 * backend preference.
 *
 * Design notes:
 *   - The big model file is only ever fetched by an explicit user action
 *     ({@link downloadModel}); describing a folder never silently pulls GBs.
 *   - The inference runtime (node-llama-cpp) is bundled next to the sidecar at
 *     install (like the sidecar itself) and runs under Bun — nothing fetched.
 *   - Diagnostics log to the FILE logger (never stdout — the sidecar's stdout
 *     is the JSON-lines protocol; a stray line breaks the transport).
 */

import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rename, stat, readdir, chmod, rm, writeFile, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
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
  // Qwen2.5 7B ships as a 2-shard GGUF; the loader resolves the second shard from the first path,
  // so only that one is recorded here.
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

/** The model used when the user hasn't picked one. 0.5B is the GPU-safe default: the 1.5B
 *  model loaded onto a laptop GPU can exhaust VRAM and freeze the desktop (the frontend uses
 *  the same default + a migration; this keeps the sidecar fallback consistent). */
export const DEFAULT_LOCAL_MODEL = 'qwen2.5-0.5b';

export function getLocalModel(id: string): LocalModelInfo | undefined {
  return LOCAL_MODELS.find((m) => m.id === id);
}

// === Custom (user-imported) models ===
// A user can import their own GGUF; it's copied into the models dir and becomes a first-class
// model identified by `custom:<filename>`, so model_status lists it and resolveModelPath finds
// it with no special-casing in the describe flow.

const CUSTOM_PREFIX = 'custom:';

export function isCustomModel(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

/** The on-disk file name a custom id maps to (the part after `custom:`). */
function customFileName(id: string): string {
  return id.slice(CUSTOM_PREFIX.length);
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
  if (isCustomModel(id)) return join(modelsDir(), customFileName(id));
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

/** True only when every shard of the model is present at its expected size. A custom model is
 *  "downloaded" iff its file exists (no expected size to check against). */
export async function isModelDownloaded(id: string): Promise<boolean> {
  if (isCustomModel(id)) {
    try {
      return (await stat(modelPath(id))).isFile();
    } catch {
      return false;
    }
  }
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

// === Custom model import / removal ===

/** GGUF files start with the ASCII magic "GGUF" — a cheap validity check before importing. */
async function isGgufFile(path: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.toString('latin1') === 'GGUF';
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** A filesystem-safe basename for the imported file: strip the directory (both `/` and `\`),
 *  replace characters that are invalid on Windows, keep the extension. */
function sanitizeModelFileName(srcPath: string): string {
  const base = srcPath.replace(/^.*[\\/]/, ''); // basename, handling both separators
  // eslint-disable-next-line no-control-regex
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'model.gguf';
}

/** A custom model's metadata, matching the catalogue's `model_status` entry shape. */
export interface CustomModelEntry {
  id: string;
  label: string;
  family: string;
  tier: LocalModelInfo['tier'];
  note: string;
  size: number;
  license: string;
  downloaded: true;
  custom: true;
}

/** Import a local `.gguf` into the models dir and return its custom entry. Validates it's a real
 *  GGUF, copies with progress (atomic `.part`→rename), and refuses to clobber a built-in model. */
export async function importModel(
  srcPath: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<CustomModelEntry & { path: string }> {
  const st = await stat(srcPath).catch(() => null);
  if (!st || !st.isFile()) throw new Error('The selected file does not exist.');
  if (!srcPath.toLowerCase().endsWith('.gguf')) throw new Error('Please choose a .gguf model file.');
  if (!(await isGgufFile(srcPath))) throw new Error('That file is not a valid GGUF model.');

  const fileName = sanitizeModelFileName(srcPath);
  if (LOCAL_MODELS.some((m) => m.files.some((f) => f.name === fileName))) {
    throw new Error('A built-in model already uses that file name; rename the file and retry.');
  }

  await mkdir(modelsDir(), { recursive: true });
  const dest = join(modelsDir(), fileName);
  const tmp = `${dest}.part`;
  await rm(tmp, { force: true }).catch(() => {});

  const total = st.size;
  let received = 0;
  logger.info('custom model import started', { file: fileName, bytes: total });
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(srcPath);
    const ws = createWriteStream(tmp);
    rs.on('error', reject);
    ws.on('error', reject);
    rs.on('data', (chunk: Buffer) => {
      received += chunk.length;
      onProgress?.({ received, total, file: fileName });
    });
    ws.on('finish', () => resolve());
    rs.pipe(ws);
  });

  if (!(await fileHasSize(tmp, total))) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new Error('The copy did not complete — please try again.');
  }
  await rename(tmp, dest);
  const id = `${CUSTOM_PREFIX}${fileName}`;
  logger.info('custom model imported', { id, bytes: total });
  return {
    id,
    label: fileName.replace(/\.gguf$/i, ''),
    family: 'Custom',
    tier: 'balanced',
    note: 'Imported model',
    size: total,
    license: 'unknown',
    downloaded: true,
    custom: true,
    path: dest,
  };
}

/** Delete a model's file(s) from the models dir — a custom id OR a catalogue id (the latter
 *  fills the gap that there was no way to remove a downloaded model). */
export async function removeModel(id: string): Promise<{ removed: boolean }> {
  if (isCustomModel(id)) {
    await rm(join(modelsDir(), customFileName(id)), { force: true });
    logger.info('custom model removed', { id });
    return { removed: true };
  }
  const info = getLocalModel(id);
  if (!info) throw new Error(`Unknown local model: ${id}`);
  for (const f of info.files) {
    await rm(join(modelsDir(), f.name), { force: true }).catch(() => {});
  }
  logger.info('downloaded model removed', { id });
  return { removed: true };
}

/** Enumerate `.gguf` files in the models dir that aren't part of the catalogue — the user's
 *  imported models — as `model_status` entries. */
export async function listCustomModels(): Promise<CustomModelEntry[]> {
  let names: string[];
  try {
    names = await readdir(modelsDir());
  } catch {
    return [];
  }
  const catalogueFiles = new Set(LOCAL_MODELS.flatMap((m) => m.files.map((f) => f.name)));
  const out: CustomModelEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.gguf') || name.endsWith('.part') || catalogueFiles.has(name)) continue;
    let size = 0;
    try {
      size = (await stat(join(modelsDir(), name))).size;
    } catch {
      continue;
    }
    out.push({
      id: `${CUSTOM_PREFIX}${name}`,
      label: name.replace(/\.gguf$/i, ''),
      family: 'Custom',
      tier: 'balanced',
      note: 'Imported model',
      size,
      license: 'unknown',
      downloaded: true,
      custom: true,
    });
  }
  return out;
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
