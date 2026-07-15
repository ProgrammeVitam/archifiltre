/**
 * llm-helper — the on-device inference process.
 *
 * Runs under **Bun** (this very sidecar binary, re-invoked as `archifiltre llm-helper`), loading
 * node-llama-cpp IN-PROCESS: NO server, NO listening port, and NO separate Node runtime. The
 * scan sidecar spawns it and talks over stdin/stdout JSON-lines; see {@link ../extensions/ai-describe/local-engine.ts}.
 *
 * node-llama-cpp is imported **dynamically inside run()** on purpose: it's an external dep resolved
 * from the bundled `node_modules` at runtime, so a `session`/`query` invocation (which never needs
 * it) must not touch it at startup. Discipline: the JSON protocol is on STDOUT, logs on STDERR
 * (llama.cpp is chatty on stdout, so its logging is disabled and the client tolerates stray lines).
 *
 * Protocol (one JSON object per line):
 *   in:  {id, type:'load', modelPath|model, gpu?}      out: {id, type:'loaded', backend}
 *   in:  {id, type:'generate', modelPath|model, gpu?, system, prompt, maxTokens?}
 *          out (stream): {id,type:'token',delta} … {id,type:'done',text,backend}
 *   in:  {type:'cancel', cancelId}                     out: {id, type:'cancelled'}
 *   in:  {id, type:'ping'}                             out: {id, type:'pong'}
 *   in:  {id, type:'model_status'}                     out: {id, type:'model_status', models, default}
 *   in:  {id, type:'download_model', model}
 *          out (stream): {id,type:'download',received,total,file} … {id,type:'download_done',path}
 *          on failure:   {id,type:'error',message,category}
 *
 * `model` is a registry id (e.g. "qwen2.5-1.5b") resolved to its on-disk GGUF here — the
 * caller (the app's Rust LLM host) never needs to know file layouts. `modelPath` (absolute)
 * is kept for tests/CLI. model_status/download live here too so the app can manage models
 * with NO scan session at all (Settings decoupled from scans).
 */
import { Command } from '@oclif/core';
import { createInterface } from 'node:readline';
import {
  DEFAULT_LOCAL_MODEL,
  DownloadError,
  LOCAL_MODELS,
  downloadModel,
  getLocalModel,
  isModelDownloaded,
  isCustomModel,
  importModel,
  removeModel,
  listCustomModels,
  modelPath as localModelPath,
  rememberBackend,
} from '@extensions/ai-describe/local-llm.ts';
// The helper's `err()` writes to stderr, which the Rust host spawns with Stdio::null() → discarded.
// Backend diagnostics must go to the winston FILE logger (console-off for this command, so it can't
// corrupt the JSON protocol on stdout) to actually land in the exportable logs.
import { logger as fileLog } from '@lib/logging.ts';

export default class LlmHelper extends Command {
  static override description = 'Internal: on-device inference worker (stdio JSON-lines). Not for direct use.';
  static override hidden = true;

  public async run(): Promise<void> {
    const err = (...a: unknown[]) => {
      try {
        process.stderr.write('[llm-helper] ' + a.join(' ') + '\n');
      } catch {
        /* ignore */
      }
    };
    process.stdout.on('error', (e: NodeJS.ErrnoException) => {
      if (e?.code === 'EPIPE') process.exit(0);
    });
    const send = (o: unknown) => {
      try {
        process.stdout.write(JSON.stringify(o) + '\n');
      } catch {
        /* broken pipe / parent gone */
      }
    };

    // Load node-llama-cpp at runtime. In the compiled sidecar a bare `import('node-llama-cpp')`
    // resolves against the virtual bunfs root (no node_modules there); resolve its ABSOLUTE path
    // from the real filesystem (cwd = the bundled node_modules dir, set by local-engine; or the
    // exe dir) via Bun.resolveSync, then import that.
    let nlc: typeof import('node-llama-cpp');
    try {
      const { dirname } = await import('node:path');
      // Resolve from the bundle dir the parent handed us (AF_LLM_DIR) FIRST: the sidecar chdir's to
      // its app-data dir at startup, so process.cwd() no longer points at the runtime bundle. Fall
      // back to cwd / the exe dir for dev.
      const bases = [process.env.AF_LLM_DIR, process.cwd(), dirname(process.execPath)].filter(
        Boolean
      ) as string[];
      let entry: string | undefined;
      for (const b of bases) {
        try {
          entry = Bun.resolveSync('node-llama-cpp', b);
          break;
        } catch {
          /* try next base */
        }
      }
      if (!entry) throw new Error('node-llama-cpp not resolvable from cwd or exe dir');
      nlc = (await import(entry)) as typeof import('node-llama-cpp');
    } catch (e) {
      err('failed to load node-llama-cpp: ' + String((e as Error)?.stack ?? e));
      send({ type: 'fatal', message: 'inference runtime unavailable: ' + String((e as Error)?.message ?? e) });
      process.exit(3);
      return;
    }
    const { getLlama, LlamaChatSession, LlamaLogLevel } = nlc;

    let llama: Awaited<ReturnType<typeof getLlama>> | undefined;
    let model: Awaited<ReturnType<NonNullable<typeof llama>['loadModel']>> | undefined;
    let context: Awaited<ReturnType<NonNullable<typeof model>['createContext']>> | undefined;
    let loadedPath: string | undefined;
    let backend: string | false = false;
    const inflight = new Map<number, AbortController>();
    // Cancels that arrive before their generate reaches the abortable phase (e.g. while the
    // model is still loading for it). Checked right before generation starts.
    const cancelledEarly = new Set<number>();

    async function ensureModel(modelPath: string, gpu: unknown) {
      const g = (gpu ?? 'auto') as 'auto' | 'vulkan' | 'metal' | 'cuda' | false;
      if (model && loadedPath === modelPath) return;
      if (model) {
        try {
          await model.dispose();
        } catch {
          /* ignore */
        }
        model = context = undefined;
      }
      const t = performance.now();
      // `build: 'never'` = only ever load a shipped prebuilt; never invoke cmake/a compiler
      // (gov/offline machines have no toolchain). GPU variants that lack a prebuilt are skipped,
      // gracefully falling through to the CPU prebuilt.
      // Forward node-llama-cpp's own warnings to the FILE log so the REASON a GPU backend was
      // refused (missing prebuilt, driver/init failure, no device…) is visible — previously
      // logLevel was `disabled`, so a Vulkan→CPU fallback was silent and the CPU regression it
      // causes was undiagnosable.
      llama =
        llama ||
        (await getLlama({
          gpu: g,
          build: 'never',
          logLevel: LlamaLogLevel.warn,
          logger: (level: unknown, message: string) =>
            fileLog.warn(`[node-llama-cpp:${String(level)}] ${message}`),
        }));
      backend = (llama.gpu ?? false) as string | false;
      // A GPU backend was requested but the runtime fell back to CPU → say so explicitly; the warnings above
      // carry the why. This is the line to grep when "everything is slow" = stuck on CPU.
      if (!backend && g !== false) {
        fileLog.warn(
          `GPU unavailable (requested gpu=${JSON.stringify(g)}) — running on CPU; see node-llama-cpp warnings above for the reason`
        );
      }
      // Persist the resolved backend so the owners' mid-scan gate (localBackendIsGpu) reads the
      // truth this host actually runs on. Fire-and-forget — never blocks a load.
      void rememberBackend(!backend ? 'cpu' : backend === 'metal' ? 'metal' : 'vulkan').catch(
        () => {}
      );
      model = await llama.loadModel({ modelPath });
      context = await model.createContext({ contextSize: 2048 });
      loadedPath = modelPath;
      const loadedMsg = `loaded ${modelPath} in ${((performance.now() - t) / 1000).toFixed(2)}s (backend=${JSON.stringify(backend)})`;
      err(loadedMsg);
      fileLog.info(`[llm-helper] ${loadedMsg}`); // to the FILE log so the resolved backend is diagnosable
    }

    /** Resolve a request's model to an on-disk GGUF path: absolute `modelPath` passes through
     *  (tests/CLI); a registry id (`model`) resolves via the catalogue and must be downloaded. */
    async function resolveModelPath(req: { modelPath?: string; model?: string }): Promise<string> {
      if (req.modelPath) return req.modelPath;
      const id = req.model?.trim() || DEFAULT_LOCAL_MODEL;
      if (isCustomModel(id)) {
        if (!(await isModelDownloaded(id))) throw new Error('The imported model is missing from the models folder.');
        return localModelPath(id);
      }
      const info = getLocalModel(id);
      if (!info) throw new Error(`Unknown local model: ${id}`);
      if (!(await isModelDownloaded(id))) {
        throw new Error(`Local model "${info.label}" is not downloaded yet.`);
      }
      return localModelPath(id);
    }

    const rl = createInterface({ input: process.stdin });
    rl.on('line', async (line: string) => {
      if (!line.trim()) return;
      let req: { id?: number; type?: string; modelPath?: string; model?: string; path?: string; gpu?: unknown; system?: string; prompt?: string; maxTokens?: number; cancelId?: number };
      try {
        req = JSON.parse(line);
      } catch {
        return;
      }
      const { id, type } = req;
      try {
        if (type === 'ping') {
          send({ id, type: 'pong' });
          return;
        }
        if (type === 'cancel') {
          if (req.cancelId != null) {
            const ac = inflight.get(req.cancelId);
            if (ac) ac.abort();
            else cancelledEarly.add(req.cancelId); // not generating yet — flag for pickup
          }
          return;
        }
        if (type === 'model_status') {
          const models = await Promise.all(
            LOCAL_MODELS.map(async (m) => ({
              id: m.id,
              label: m.label,
              family: m.family,
              tier: m.tier,
              note: m.note,
              size: m.size,
              license: m.license,
              downloaded: await isModelDownloaded(m.id),
            }))
          );
          const custom = await listCustomModels();
          send({ id, type: 'model_status', models: [...models, ...custom], default: DEFAULT_LOCAL_MODEL });
          return;
        }
        if (type === 'import_model') {
          const src = req.path?.trim();
          if (!src) {
            send({ id, type: 'error', message: 'No file path provided.' });
            return;
          }
          let lastEmit = 0;
          try {
            const r = await importModel(src, (p) => {
              const now = Date.now();
              if (now - lastEmit < 100 && p.received < p.total) return;
              lastEmit = now;
              send({ id, type: 'download', model: `custom:${p.file}`, received: p.received, total: p.total, file: p.file });
            });
            send({ id, type: 'download_done', model: r.id, path: r.path });
          } catch (e) {
            send({ id, type: 'error', model: 'import', message: String((e as Error)?.message ?? e) });
          }
          return;
        }
        if (type === 'remove_model') {
          const modelId = req.model?.trim();
          if (!modelId) {
            send({ id, type: 'error', message: 'No model id provided.' });
            return;
          }
          try {
            await removeModel(modelId);
            send({ id, type: 'removed', model: modelId });
          } catch (e) {
            send({ id, type: 'error', model: modelId, message: String((e as Error)?.message ?? e) });
          }
          return;
        }
        if (type === 'download_model') {
          const modelId = req.model?.trim() || DEFAULT_LOCAL_MODEL;
          if (!getLocalModel(modelId)) throw new Error(`Unknown local model: ${modelId}`);
          let lastEmit = 0;
          try {
            const path = await downloadModel(modelId, (p) => {
              // Throttle to ~10/s so we don't flood the protocol channel.
              const now = Date.now();
              if (now - lastEmit < 100 && p.received < p.total) return;
              lastEmit = now;
              send({ id, type: 'download', model: modelId, received: p.received, total: p.total, file: p.file });
            });
            send({ id, type: 'download_done', model: modelId, path });
          } catch (e) {
            const category = e instanceof DownloadError ? e.category : 'unknown';
            send({ id, type: 'error', model: modelId, message: String((e as Error)?.message ?? e), category });
          }
          return;
        }
        if (type === 'load') {
          await ensureModel(await resolveModelPath(req), req.gpu);
          send({ id, type: 'loaded', backend });
          return;
        }
        if (type === 'generate') {
          await ensureModel(await resolveModelPath(req), req.gpu);
          // Cancelled while the model was loading for us → don't generate at all.
          if (id != null && cancelledEarly.delete(id)) {
            send({ id, type: 'cancelled' });
            return;
          }
          const ac = new AbortController();
          if (id != null) inflight.set(id, ac);
          const seq = context!.getSequence();
          const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: req.system });
          let text = '';
          try {
            await session.prompt(req.prompt ?? '', {
              maxTokens: req.maxTokens ?? 256,
              // node-llama-cpp's default is greedy decoding (temperature 0), which sends small
              // models into degenerate repetition loops ("… de jardinage de jardinage de …").
              // Match the sampling the old llama-server shipped by default: mild temperature +
              // nucleus sampling + a repetition penalty.
              temperature: 0.7,
              topP: 0.9,
              repeatPenalty: { penalty: 1.15, lastTokens: 128 },
              signal: ac.signal,
              onTextChunk(chunk: string) {
                text += chunk;
                send({ id, type: 'token', delta: chunk });
              },
            });
            send({ id, type: 'done', text, backend });
          } catch (e) {
            if (ac.signal.aborted) send({ id, type: 'cancelled' });
            else send({ id, type: 'error', message: String((e as Error)?.message ?? e) });
          } finally {
            if (id != null) inflight.delete(id);
            try {
              seq.dispose();
            } catch {
              /* ignore */
            }
          }
        }
      } catch (e) {
        send({ id, type: 'error', message: String((e as Error)?.message ?? e) });
      }
    });

    err(`ready (bun ${process.versions?.bun ?? '?'})`);
    // Run until stdin closes (parent exits / kills us).
    await new Promise<void>((resolve) => rl.on('close', () => resolve()));
  }
}
