// On-device inference helper — runs under a bundled Node (node-llama-cpp needs N-API; Bun
// segfaults on it). Loads llama.cpp IN-PROCESS: NO server, NO listening port. The archifiltre
// sidecar (Bun) spawns this and talks to it over stdin/stdout JSON-lines.
//
// This file is NOT compiled into the Bun sidecar — it ships in the `af-infer` bundle
// (portable node + node_modules + this script) and is launched as a child process.
//
// Protocol (one JSON object per line):
//   in:  {id, type:'load', modelPath, gpu?}              out: {id, type:'loaded'}
//   in:  {id, type:'generate', modelPath, gpu?, system, prompt, maxTokens?}
//          out (stream): {id,type:'token',delta} … {id,type:'done',text}
//   in:  {type:'cancel', cancelId}                       out: {id, type:'cancelled'}
//   in:  {id, type:'ping'}                               out: {id, type:'pong'}
//
// Discipline: llama.cpp writes to STDOUT, which would corrupt the protocol — so its logging is
// disabled and the client tolerates stray non-JSON lines. Never crash on a broken pipe.
import { getLlama, LlamaChatSession, LlamaLogLevel } from 'node-llama-cpp';
import { createInterface } from 'node:readline';

const log = (...a) => { try { process.stderr.write('[af-infer] ' + a.join(' ') + '\n'); } catch {} };
process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0); });
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch {} };

let llama, model, context, loadedPath;
/** The backend node-llama-cpp actually resolved: 'vulkan' | 'metal' | 'cuda' | false. Reported
 *  back so the sidecar can persist it (drives the mid-scan GPU decision). */
let backend = false;
const inflight = new Map(); // id -> AbortController

async function ensureModel(modelPath, gpu) {
  gpu = gpu ?? 'auto'; // let node-llama-cpp auto-detect the GPU (Vulkan/Metal/CUDA) or fall to CPU
  if (model && loadedPath === modelPath) return;
  if (model) { try { await model.dispose(); } catch {} model = context = undefined; }
  const t = performance.now();
  llama = llama || (await getLlama({ gpu, logLevel: LlamaLogLevel.disabled }));
  backend = llama.gpu ?? false;
  model = await llama.loadModel({ modelPath });
  context = await model.createContext({ contextSize: 2048 });
  loadedPath = modelPath;
  log(`loaded ${modelPath} in ${((performance.now() - t) / 1000).toFixed(2)}s (backend=${JSON.stringify(backend)})`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, type } = req;
  try {
    if (type === 'ping') { send({ id, type: 'pong' }); return; }
    if (type === 'cancel') { inflight.get(req.cancelId)?.abort(); return; }
    if (type === 'load') { await ensureModel(req.modelPath, req.gpu); send({ id, type: 'loaded', backend }); return; }
    if (type === 'generate') {
      await ensureModel(req.modelPath, req.gpu);
      const ac = new AbortController();
      inflight.set(id, ac);
      const seq = context.getSequence();
      const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: req.system });
      let text = '';
      try {
        await session.prompt(req.prompt, {
          maxTokens: req.maxTokens ?? 256,
          signal: ac.signal,
          onTextChunk(chunk) { text += chunk; send({ id, type: 'token', delta: chunk }); },
        });
        send({ id, type: 'done', text, backend });
      } catch (e) {
        if (ac.signal.aborted) send({ id, type: 'cancelled' });
        else send({ id, type: 'error', message: String(e?.message ?? e) });
      } finally {
        inflight.delete(id);
        try { seq.dispose(); } catch {}
      }
    }
  } catch (e) {
    send({ id, type: 'error', message: String(e?.message ?? e) });
  }
});

log(`ready (node ${process.version})`);
