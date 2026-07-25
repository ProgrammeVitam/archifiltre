/**
 * The AI API — the CLI backend's single home for on-device + remote AI, with a provider
 * registry so built-in agents and (future) extension-provided agents are dispatched the same
 * way. Every consumer calls {@link callAI} and never knows which agent served it.
 *
 * Provider kinds and their concurrency:
 *   • `local`  — a scarce on-device resource. Runs on the app-global Rust executor via the
 *                owner→Rust upstream ({@link hostRequest}); ALL local work serializes there.
 *   • `remote` — a network agent that scales; bounded-parallel, honors backpressure.
 *
 * Token streaming reaches the UI as `describe:token` lines matched by `streamId`, regardless of
 * provider: the internal provider passes `streamId` to the Rust host (which emits them); the
 * external provider emits them from the owner via {@link emitDescribeToken}.
 */
import { bulkhead } from 'cockatiel';
import { hostRequest } from '@lib/host-bridge.ts';
import { callLLM, getLLMConfig, LLMBackpressureError, type LLMConfig } from '@extensions/ai-describe/llm-client.ts';
import { DEFAULT_LOCAL_MODEL } from '@extensions/ai-describe/local-llm.ts';

export type ProviderKind = 'local' | 'remote';

export interface AiGenerateRequest {
  system: string;
  prompt: string;
  model?: string;
  /** Stable per-target key (`${db}::${path}::${lang}`) — the cancel/dedupe identity. */
  clientId: string;
  /** Token routing id; when set, deltas stream to the UI as `describe:token`. */
  streamId?: string;
  /** External-only: explicit endpoint config (else the app's configured / env config). */
  config?: LLMConfig;
}

export interface AiResult {
  text: string;
  model: string;
}

/** A failure from a provider. `transient` = worth a bounded retry (process died, network blip);
 *  otherwise deterministic (not configured, refused) and surfaced as-is. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface AiProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  generate(req: AiGenerateRequest): Promise<AiResult>;
}

const providers = new Map<string, AiProvider>();

/** Register an AI provider (built-in at module load, or an extension at its load time). */
export function registerProvider(p: AiProvider): void {
  providers.set(p.id, p);
}

export function getProvider(id: string): AiProvider | undefined {
  return providers.get(id);
}

export function listProviders(): AiProvider[] {
  return [...providers.values()];
}

/**
 * Per-provider concurrency. `local` providers are one scarce on-device resource and already
 * serialize downstream on the Rust executor's single queue, so they bypass this pool. `remote`
 * providers scale, so they run bounded-parallel through a bulkhead (N concurrent + a wait queue),
 * capping fan-out without serializing remote work behind local.
 */
const REMOTE_MAX_CONCURRENT = 4;
const REMOTE_MAX_QUEUED = 64;
const remotePool = bulkhead(REMOTE_MAX_CONCURRENT, REMOTE_MAX_QUEUED);

/** Dispatch one AI generation to a registered provider, applying its concurrency policy. */
export async function callAI(providerId: string, req: AiGenerateRequest): Promise<AiResult> {
  const p = providers.get(providerId);
  if (!p) throw new AiError(`unknown AI provider "${providerId}"`);
  if (p.kind === 'remote') return remotePool.execute(() => p.generate(req));
  return p.generate(req); // local: serialized upstream by the Rust executor, not here
}

/** Emit a streamed token to the UI (owner event channel → Rust → job-update, matched by streamId). */
export function emitDescribeToken(streamId: string, delta: string): void {
  process.stdout.write(`${JSON.stringify({ event: 'describe:token', streamId, delta })}\n`);
}

// ── Built-in providers ───────────────────────────────────────────────────────

/** Internal (on-device): the app-global warm model on the Rust executor. Tokens are emitted by
 *  the Rust host itself (matched by streamId), so nothing is streamed from the owner here. */
const internalProvider: AiProvider = {
  id: 'internal',
  label: 'On-device model',
  kind: 'local',
  async generate(req) {
    const model = req.model?.trim() || DEFAULT_LOCAL_MODEL;
    const env = (await hostRequest({
      type: 'generate',
      model,
      system: req.system,
      prompt: req.prompt,
      maxTokens: 256,
      ...(req.streamId ? { streamId: req.streamId } : {}),
      clientId: req.clientId,
      kind: 'user-describe',
    })) as { ok?: boolean; error?: string; data?: { text?: string } };
    if (!env?.ok) {
      // Marked transient: a dead host is worth retrying, and the host already screens out business
      // errors (no model, etc.) before they reach here.
      throw new AiError(env?.error ?? 'AI runtime not available', true);
    }
    const text = (env.data?.text ?? '').trim();
    if (!text) throw new AiError('AI runtime returned no text', true);
    return { text, model };
  },
};

/** External (remote): any OpenAI-compatible endpoint. Streams from the owner via describe:token. */
const externalProvider: AiProvider = {
  id: 'external',
  label: 'External API',
  kind: 'remote',
  async generate(req) {
    const config = req.config ?? getLLMConfig();
    if (!config) {
      throw new AiError(
        'LLM service not configured. Set the base URL and API key in Settings > LLM (or the LLM_BASE_URL / LLM_API_KEY environment variables).',
      );
    }
    const onToken = req.streamId ? (delta: string) => emitDescribeToken(req.streamId!, delta) : undefined;
    // Honor remote backpressure (429/503 + Retry-After) as "wait, healthy": bounded retries with the
    // server-requested delay (capped), NOT a hard failure. Backpressure fires before any token
    // streams (the response.ok check precedes the SSE), so a retry never double-streams.
    const MAX_BACKPRESSURE_RETRIES = 3;
    const BACKPRESSURE_CAP_MS = 30_000;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await callLLM(config, req.system, req.prompt, {
          ...(req.model ? { model: req.model } : {}),
          ...(onToken ? { onToken } : {}),
        });
        return { text: r.description, model: r.model };
      } catch (e) {
        if (e instanceof LLMBackpressureError && attempt < MAX_BACKPRESSURE_RETRIES) {
          await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs, BACKPRESSURE_CAP_MS)));
          continue;
        }
        throw e;
      }
    }
  },
};

registerProvider(internalProvider);
registerProvider(externalProvider);

/** Map the UI's aiMode (`local`/`external`) to a built-in provider id. Extensions register their
 *  own ids and are selected explicitly. */
export function providerIdForMode(mode: string): string {
  return mode === 'external' ? 'external' : 'internal';
}
