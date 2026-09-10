/**
 * The Kitchen Codex — DeepSeek AiProvider adapter (v0.7 Phase 1C).
 *
 * The THIRD real provider. It speaks the OpenAI-compatible chat-completions
 * protocol over DeepSeek's FIXED official API endpoint. SERVER-SIDE ONLY.
 *
 * SECURITY / SCOPE (must never be weakened):
 *   - The endpoint is FIXED to DeepSeek's official base URL
 *     (`https://api.deepseek.com`). No caller-controlled baseUrl/endpoint/host is
 *     accepted (no arbitrary endpoint capability).
 *   - The key comes ONLY from the server-side operator environment via
 *     `getServerSecretSync("deepseek_api_key")` (the allowlisted
 *     `DEEPSEEK_API_KEY`). It is never in VITE_*, browser, settings, Markdown,
 *     logs, diagnostics, or returned to the UI.
 *   - No SSRF surface: only the fixed DeepSeek host is reached.
 *   - The `NetworkAdapter` is NOT involved (this is an AI-provider transport, not
 *     the app-backend API transport).
 *
 * CAPABILITIES (conservative, truthful): DeepSeek's `response_format` supports
 * ONLY `{"type":"json_object"}` (JSON *mode*). It does NOT support
 * schema-constrained structured output (`json_schema`). Therefore we do NOT
 * advertise `structuredOutput` — a JSON-object mode that does not enforce the
 * caller's schema is NOT the `AiJsonSchema` contract. `webSearch` is always
 * false (no provider-backed grounded search), so `searchWeb` is omitted.
 * Plain `generate()` (text) and `reasoning` are supported by the curated models.
 *
 * THINKING / REASONING POLICY (v0.7 Phase 1D):
 *   - DeepSeek's `thinking` mode is ENABLED BY DEFAULT with a default effort of
 *     `high`, and is returned as `reasoning_content` alongside `content`.
 *   - `thinking` mode does NOT support `temperature`/`top_p`/`presence_penalty`/
 *     `frequency_penalty` (they silently have no effect).
 *   - A provider-neutral plain `generate()` call MUST NOT silently inherit that
 *     upstream default (extra latency/cost, ignored temperature). Therefore an
 *     ordinary `generate()` explicitly disables thinking with
 *     `{"thinking": {"type": "disabled"}}`, keeping the request deterministic and
 *     letting `temperature` map normally. No reasoning mode is executed until a
 *     future provider-neutral option/operation explicitly requests it.
 *   - `reasoning_content` is NEVER returned, serialized, logged, persisted, or
 *     surfaced; only final `message.content` is provider-neutral output.
 */

import { MODEL_CONFIG } from "../modelConfig.js";
import { getServerSecretSync } from "../platform/ServerEnvironmentSecretAdapter.js";
import { ProviderOperationError, classifyProviderError } from "./providerErrors.js";
import type {
  AiCapabilities,
  AiGenerateOptions,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from "./types.js";

/** DeepSeek's fixed, official chat-completions endpoint (never configurable). */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_CHAT_ENDPOINT = `${DEEPSEEK_BASE_URL}/chat/completions`;

/** Conservative provider baseline: unknown DeepSeek models claim nothing. */
const DEEPSEEK_BASELINE_CAPABILITIES: AiCapabilities = {
  reasoning: false,
  structuredOutput: false,
  recipeGeneration: false,
  webSearch: false,
};

export interface DeepSeekFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DeepSeekFetchLike = (url: string, init: RequestInit) => Promise<DeepSeekFetchResponse>;

export interface DeepSeekProviderOptions {
  /** Test-only seam; defaults to the global fetch. Never a config surface. */
  fetchFn?: DeepSeekFetchLike;
  /**
   * BYOK-5C: an EXPLICIT session credential. When present it is used INSTEAD of
   * the operator env key (never a fallback). The provider instance is
   * request-scoped; no global cache retains the credential.
   */
  credential?: string;
}

function defaultFetch(): DeepSeekFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

async function asJson<T>(res: DeepSeekFetchResponse): Promise<T | undefined> {
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

function extractContent(parsed: unknown): string {
  const body = (parsed ?? {}) as { choices?: unknown };
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = choice?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

/**
 * The one implemented provider: DeepSeek (OpenAI-compatible). Only plain text
 * generation is exposed; schema-constrained structured output is NOT claimed
 * (DeepSeek has no `json_schema` mode), so `generateStructured` refuses rather
 * than pretending to honor the `AiJsonSchema` contract.
 */
export class DeepSeekProvider implements AiProvider {
  readonly id = "deepseek";
  readonly name = "DeepSeek";
  readonly capabilities: AiCapabilities = { ...DEEPSEEK_BASELINE_CAPABILITIES };
  private readonly fetchFn: DeepSeekFetchLike;
  private readonly credential?: string;

  constructor(options: DeepSeekProviderOptions = {}) {
    this.fetchFn = options.fetchFn ?? defaultFetch();
    this.credential = options.credential;
  }

  isAvailable(): boolean {
    if (this.credential) return true;
    return Boolean(getServerSecretSync("deepseek_api_key"));
  }

  async testConnection(): Promise<boolean> {
    // Bounded: no network probe (matches Gemini/OpenRouter availability-only semantics).
    return this.isAvailable();
  }

  private requireKey(): string {
    // A session credential is used EXCLUSIVELY when supplied — never env fallback.
    const key = this.credential ?? getServerSecretSync("deepseek_api_key");
    if (!key) throw new ProviderOperationError("UNAVAILABLE", "DeepSeek is not available (no API key).", {});
    return key;
  }

  private buildRequest(prompt: string, options: AiGenerateOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [{ role: "user", content: prompt }],
    };
    // Explicitly disable DeepSeek's default-on thinking so an ordinary provider-
    // neutral generate() call is deterministic (no inherited high-effort CoT) and
    // temperature maps normally.
    body["thinking"] = { type: "disabled" };
    if (typeof options.temperature === "number") body["temperature"] = options.temperature;
    return body;
  }

  private async chat(prompt: string, options: AiGenerateOptions): Promise<string> {
    const key = this.requireKey();
    const body = this.buildRequest(prompt, options);

    let res: DeepSeekFetchResponse;
    try {
      res = await this.fetchFn(DEEPSEEK_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MODEL_CONFIG.requestTimeoutMs),
      });
    } catch (err) {
      // Transport-level failure / timeout. Connection failures map to UNAVAILABLE;
      // timeouts/aborts to TIMEOUT. Never leaks secrets.
      const code = classifyProviderError(err);
      throw new ProviderOperationError(
        code === "PROVIDER_ERROR" ? "UNAVAILABLE" : code,
        "DeepSeek request failed.",
        {},
        err
      );
    }

    if (!res.ok) {
      const parsed = await asJson<{ error?: { message?: string } }>(res);
      const rawMessage = parsed?.error?.message ?? `DeepSeek request failed (HTTP ${res.status}).`;
      const error = Object.assign(new Error(rawMessage), { status: res.status });
      const code = classifyProviderError(error);
      throw new ProviderOperationError(code, rawMessage, {}, error);
    }

    const parsed = await asJson<unknown>(res);
    const text = extractContent(parsed);
    if (!text) {
      throw new ProviderOperationError("INVALID_RESPONSE", "DeepSeek returned an empty response.", {});
    }
    return text;
  }

  async generate(prompt: string, options: AiGenerateOptions): Promise<string> {
    return this.chat(prompt, options);
  }

  async generateStructured<T = unknown>(
    _prompt: string,
    _schema: AiJsonSchema,
    _options: AiStructuredOptions
  ): Promise<T> {
    // DeepSeek only exposes `json_object` mode — it does NOT enforce a caller
    // schema. Honoring the `AiJsonSchema` contract faithfully is impossible, so
    // we refuse rather than weaken the meaning of `structuredOutput: true`.
    throw new ProviderOperationError(
      "UNSUPPORTED_CAPABILITY",
      "DeepSeek does not support schema-constrained structured output.",
      { providerId: this.id }
    );
  }
}

/** Curated DeepSeek model id — cost-conscious, current/stable, non-vision flash. */
export const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
/** Curated DeepSeek model id — strongest, current/stable, non-vision pro. */
export const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";

/**
 * Per-model capability truth for the curated DeepSeek set. UNKNOWN models fall
 * back to the conservative baseline (nothing claimed). Both curated models
 * support DeepSeek's thinking mode (`reasoning: true`); NEITHER is declared
 * `structuredOutput` because the API has no schema-constrained output, and
 * neither gains `webSearch`.
 */
export const DEEPSEEK_MODEL_CAPABILITIES: Record<string, Partial<AiCapabilities>> = {
  [DEEPSEEK_FLASH_MODEL]: { reasoning: true },
  [DEEPSEEK_PRO_MODEL]: { reasoning: true },
};
