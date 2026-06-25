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
  message: ChatMessage;
  finish_reason: string;
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
  }
): Promise<LLMResult> {
  const model = resolveModel(options?.model);
  const maxTokens = options?.maxTokens ?? 150;
  const temperature = options?.temperature ?? 0.3;

  const url = `${config.baseUrl}/chat/completions`;

  const requestBody: ChatCompletionRequest = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature,
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
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(`LLM API error (${response.status} ${response.statusText}): ${errorText}`);
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
