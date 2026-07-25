/**
 * LLM API Client
 *
 * OpenAI-compatible HTTP client for LLM chat completion APIs.
 * Used by the ai-describe extension to generate directory descriptions.
 * Works with any OpenAI-compatible endpoint.
 */

// === Types ===

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
}

interface ChatCompletionChoice {
  index: number;
  /** Present on non-streaming responses. */
  message?: ChatMessage;
  /** Present on streaming (SSE) chunks — a partial content delta. */
  delta?: { content?: string };
  finish_reason: string | null;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
}

export interface LLMResult {
  description: string;
  model: string;
}

/** A remote agent applying backpressure (429/503 + optional Retry-After) — its own queue is full
 *  or it's rate-limiting. This is "wait, healthy", NOT a failure: honor the delay and retry. */
export class LLMBackpressureError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly status: number,
  ) {
    super(`LLM API backpressure (${status}); retry after ${retryAfterMs}ms`);
    this.name = 'LLMBackpressureError';
  }
}

/** Parse a Retry-After header (delta-seconds or an HTTP-date) to milliseconds; 0 if absent/bad. */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return 0;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

// === Constants ===

const DEFAULT_MODEL = 'llama-3.1-8b-instruct';

// === Configuration ===

/**
 * Read LLM API configuration from environment variables.
 * Returns null if the required variables are not set.
 *
 * Required env vars:
 *   - LLM_BASE_URL — Base URL of the OpenAI-compatible API (e.g. https://api.example.com/v1)
 *   - LLM_API_KEY  — Bearer token for authentication
 *
 * Optional:
 *   - LLM_MODEL — Model identifier (defaults to llama-3.1-8b-instruct)
 */
export function getLLMConfig(): LLMConfig | null {
  const baseUrl = process.env['LLM_BASE_URL'];
  const apiKey = process.env['LLM_API_KEY'];

  if (!baseUrl || !apiKey) {
    return null;
  }

  return { baseUrl, apiKey };
}

/**
 * Resolve the model to use: explicit env var, explicit option, or default.
 * Logs once when falling back to the default.
 */
let defaultModelLogged = false;

function resolveModel(optionModel?: string): string {
  const envModel = process.env['LLM_MODEL'];

  if (optionModel) return optionModel;
  if (envModel) return envModel;

  if (!defaultModelLogged) {
    // MUST go to stderr, never stdout: the query sidecar's stdout is the
    // JSON-lines protocol, and any stray line there is read as a (malformed)
    // response by the Tauri host, breaking the query (this showed up as
    // "No description available" for the first uncached folder).
    console.error(`[ai-describe] LLM_MODEL not set, using default model: ${DEFAULT_MODEL}`);
    defaultModelLogged = true;
  }
  return DEFAULT_MODEL;
}

// === API Client ===

/**
 * Call an OpenAI-compatible chat completion endpoint.
 *
 * @param config - LLM API configuration (base URL and API key)
 * @param systemPrompt - The system prompt to set the assistant's behavior
 * @param userPrompt - The user prompt containing the directory tree and stats
 * @param options - Optional overrides for model, maxTokens, and temperature
 * @returns The generated description and the model used
 * @throws Error if the API call fails or returns an unexpected response
 */
export async function callLLM(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
  options?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    /** When provided, the response is streamed (OpenAI SSE) and each token delta is passed
     *  here as it arrives. Works for any OpenAI-compatible endpoint (local llama-server or
     *  external), so there's no provider-specific path. */
    onToken?: (delta: string) => void;
  }
): Promise<LLMResult> {
  const model = resolveModel(options?.model);
  const maxTokens = options?.maxTokens ?? 150;
  const temperature = options?.temperature ?? 0.3;
  const stream = typeof options?.onToken === 'function';

  const url = `${config.baseUrl}/chat/completions`;

  const requestBody: ChatCompletionRequest & { stream?: boolean } = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature,
    ...(stream ? { stream: true } : {}),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    // 429/503 = the remote's own queue is full / rate-limited. Surface it as backpressure (wait,
    // healthy), honoring Retry-After when present, so the caller waits instead of hard-failing.
    if (response.status === 429 || response.status === 503) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after')) || 2000;
      throw new LLMBackpressureError(retryAfterMs, response.status);
    }
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(`LLM API error (${response.status} ${response.statusText}): ${errorText}`);
  }

  if (stream) {
    const content = await consumeSSE(response, options!.onToken!);
    if (!content) throw new Error('LLM API returned an empty message content');
    return { description: content.trim(), model };
  }

  const data = (await response.json()) as ChatCompletionResponse;

  if (!data.choices || data.choices.length === 0) {
    throw new Error('LLM API returned no choices in the response');
  }

  const content = data.choices[0].message?.content;

  if (!content) {
    throw new Error('LLM API returned an empty message content');
  }

  return {
    description: content.trim(),
    model,
  };
}

/**
 * Read an OpenAI-style `text/event-stream` chat completion, invoking `onToken` for each
 * content delta and returning the full accumulated text. Tolerant of chunk boundaries that
 * split SSE lines.
 */
async function consumeSSE(
  response: Response,
  onToken: (delta: string) => void
): Promise<string> {
  if (!response.body) throw new Error('LLM API returned no response body to stream');
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const json = JSON.parse(payload) as ChatCompletionResponse;
        const delta = json.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          full += delta;
          onToken(delta);
        }
      } catch {
        /* keep-alive / partial line — ignore */
      }
    }
  }
  return full;
}
