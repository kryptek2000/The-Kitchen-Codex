/**
 * The Kitchen Codex — OpenAI AiProvider adapter (P1).
 *
 * Native OpenAI text provider for the Responses API. SERVER-SIDE ONLY.
 *
 * SECURITY / SCOPE:
 *   - The endpoint is FIXED to https://api.openai.com/v1/responses. No caller-
 *     controlled baseUrl/endpoint/host is accepted (no arbitrary endpoint).
 *   - The key comes ONLY from the server-side operator environment via
 *     `getServerSecretSync("openai_api_key")` (the allowlisted
 *     OPENAI_API_KEY), or an EXPLICIT request-scoped session credential.
 *     A session credential is used EXCLUSIVELY when supplied; there is no
 *     environment fallback. The key is never returned, logged, persisted, or
 *     placed in diagnostics.
 *   - No hosted tools, web search, image generation, or file APIs in P1.
 *   - No automatic retries. `runWithAiFallback` owns the one-attempt policy.
 *
 * REQUEST TRUTH:
 *   - `store: false` on every request (no response application state).
 *   - `service_tier: "default"` (never a project-level Fast/Ultrafast surprise).
 *   - explicit bounded `max_output_tokens`.
 *   - conservative reasoning effort: low for plain text, medium for structured.
 *   - strict JSON Schema for structured output, using the shared converter.
 *
 * RESPONSE TRUTH:
 *   - only assistant `output_text` becomes the answer;
 *   - refusal content is BLOCKED;
 *   - incomplete output is INVALID_RESPONSE (or BLOCKED for content_filter);
 *   - failed/error responses normalize through the shared provider taxonomy;
 *   - caller cancellation is terminal and never becomes a timeout/fallback.
 */

import { getServerSecretSync } from "../platform/ServerEnvironmentSecretAdapter.js";
import { toStrictJsonSchema, validatesAiSchema } from "../../src/core/ai/strictJsonSchema.js";
import {
  ProviderOperationError,
  callerCancellationError,
  classifyProviderError,
  throwIfCallerCancelled,
  throwIfProviderRequestAborted,
  type ProviderErrorCode,
} from "./providerErrors.js";
import type {
  AiCapabilities,
  AiGenerateOptions,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from "./types.js";

/** OpenAI's fixed, official Responses endpoint (never configurable). */
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_RESPONSES_ENDPOINT = `${OPENAI_API_BASE_URL}/responses`;

/** Curated P1 text models. Terra is primary; Luna is the lower-cost alternative. */
export const OPENAI_DEFAULT_MODEL = "gpt-6.1-terra";
export const OPENAI_FALLBACK_MODEL = "gpt-6-luna";
export const OPENAI_MODELS = [OPENAI_DEFAULT_MODEL, OPENAI_FALLBACK_MODEL] as const;

/** Server-owned text timeout (reasoning models can exceed the 25s Gemini ceiling). */
export const OPENAI_TEXT_TIMEOUT_MS = 60_000;

/** Bounded output budget for ordinary calls. Recipe drafts can use the upper bound. */
export const OPENAI_DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const OPENAI_MIN_OUTPUT_TOKENS = 16;
export const OPENAI_MAX_OUTPUT_TOKENS = 32_768;

/** Hard ceiling for a text response body before JSON allocation. */
export const OPENAI_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Bounded ceiling for an upstream error body used only for classification. */
const OPENAI_MAX_ERROR_BYTES = 4 * 1024;

const STRUCTURED_SCHEMA_NAME = "structured_output";

/** Conservative provider baseline: unknown models claim NOTHING. */
const OPENAI_BASELINE_CAPABILITIES: AiCapabilities = {
  reasoning: false,
  structuredOutput: false,
  recipeGeneration: false,
  webSearch: false,
};

/**
 * Per-model TKC capability truth. Both curated models support Responses,
 * Structured Outputs, image input, reasoning, and web-search tools per the
 * current model pages; TKC does NOT advertise webSearch because it has not
 * implemented a trusted OpenAI search adapter in P1.
 */
export const OPENAI_MODEL_CAPABILITIES: Record<string, Partial<AiCapabilities>> = {
  [OPENAI_DEFAULT_MODEL]: {
    reasoning: true,
    structuredOutput: true,
    recipeGeneration: true,
  },
  [OPENAI_FALLBACK_MODEL]: {
    reasoning: true,
    structuredOutput: true,
    recipeGeneration: true,
  },
};

/** Fetch seam: production uses global fetch; tests inject a Response factory. */
export type OpenAIFetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAIProviderOptions {
  /** Test-only seam; never a config surface. */
  fetchFn?: OpenAIFetchLike;
  /**
   * P1 credential source: an explicit session credential. When present it is
   * used INSTEAD of the operator environment key (never a fallback). The
   * provider instance is request-scoped; no global cache retains it.
   */
  credential?: string;
}

function defaultFetch(): OpenAIFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Reads at most maxBytes of a Response body without fully buffering it. */
async function readBoundedText(
  res: Response,
  maxBytes: number,
  ctx: { providerId: string; model?: string }
): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    throw new ProviderOperationError(
      "INVALID_RESPONSE",
      "OpenAI returned an unreadable response.",
      ctx
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
        throw new ProviderOperationError(
          "INVALID_RESPONSE",
          "OpenAI response exceeded the size limit.",
          ctx
        );
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readBoundedJson(
  res: Response,
  maxBytes: number,
  ctx: { providerId: string; model?: string }
): Promise<unknown> {
  const text = await readBoundedText(res, maxBytes, ctx);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderOperationError(
      "INVALID_RESPONSE",
      "OpenAI returned invalid JSON.",
      { ...ctx, responseFailure: "malformed_json" }
    );
  }
}

/** Reads a bounded error prefix; never throws and never retains it. */
async function readErrorText(res: Response): Promise<string> {
  try {
    return await readBoundedText(res, OPENAI_MAX_ERROR_BYTES, { providerId: "openai" });
  } catch {
    return "";
  }
}

function readErrorCode(parsed: unknown): { code?: string; type?: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return {};
  const row = error as Record<string, unknown>;
  return {
    ...(typeof row.code === "string" ? { code: row.code.slice(0, 120) } : {}),
    ...(typeof row.type === "string" ? { type: row.type.slice(0, 120) } : {}),
  };
}

function mapErrorCode(code: string | undefined, type: string | undefined): ProviderErrorCode | undefined {
  const value = `${code ?? ""} ${type ?? ""}`.toLowerCase();
  if (!value.trim()) return undefined;
  if (
    value.includes("credit_balance") ||
    value.includes("spend_limit") ||
    value.includes("usage_limit") ||
    value.includes("insufficient_quota")
  ) {
    return "QUOTA";
  }
  if (value.includes("rate_limit") || value.includes("slow_down")) return "RATE_LIMIT";
  if (value.includes("content_filter") || value.includes("moderation")) return "BLOCKED";
  if (value.includes("server_error") || value.includes("overloaded") || value.includes("unavailable")) {
    return "UNAVAILABLE";
  }
  if (value.includes("model_not_found") || value.includes("model_not_available")) {
    return "UNSUPPORTED_CAPABILITY";
  }
  return undefined;
}

function classifyHttpError(status: number, errorCode?: string, errorType?: string): ProviderErrorCode {
  const byCode = mapErrorCode(errorCode, errorType);
  if (byCode) return byCode;
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402 || status === 429) return "RATE_LIMIT";
  if (status === 404) return "UNSUPPORTED_CAPABILITY";
  if (status === 408) return "TIMEOUT";
  if (status === 413) return "INVALID_RESPONSE";
  if (status >= 500) return "UNAVAILABLE";
  return "PROVIDER_ERROR";
}

function providerResponseError(
  parsed: unknown,
  ctx: { providerId: string; model?: string }
): ProviderOperationError {
  const error = readErrorCode(parsed);
  const code = mapErrorCode(error.code, error.type) ?? "PROVIDER_ERROR";
  return new ProviderOperationError(code, "OpenAI response failed.", ctx);
}

/**
 * Extracts the final assistant text from a Responses API body.
 *
 * SUCCESS INVARIANT: a response may be processed as successful ONLY when its
 * status is exactly `completed`. `queued`, `in_progress`, `incomplete`, `failed`,
 * `cancelled`, a missing/null status, and any unknown future status fail closed
 * BEFORE output extraction. The mere presence of valid-looking `output_text` is
 * never proof of completion.
 */
function extractOpenAIText(
  parsed: unknown,
  ctx: { providerId: string; model?: string }
): string {
  const body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const status = typeof body.status === "string" ? body.status : undefined;

  // Strict success gate. Preserve meaningful distinctions before the generic
  // non-completed rejection.
  if (status === "cancelled") {
    throw new ProviderOperationError("CANCELLED", "OpenAI cancelled the response.", ctx);
  }
  if (status === "incomplete") {
    const details = body.incomplete_details;
    const reason =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>).reason
        : undefined;
    if (reason === "content_filter") {
      throw new ProviderOperationError("BLOCKED", "OpenAI blocked the response.", ctx);
    }
    throw new ProviderOperationError(
      "INVALID_RESPONSE",
      "OpenAI returned an incomplete response.",
      { ...ctx, responseFailure: "output_truncated" }
    );
  }
  if (status === "failed") throw providerResponseError(parsed, ctx);
  if (status !== "completed") {
    // queued / in_progress / missing / null / unknown future status.
    throw new ProviderOperationError(
      "INVALID_RESPONSE",
      "OpenAI response was not completed.",
      ctx
    );
  }

  // A completed body carrying an error object is still a failure.
  if (body.error) throw providerResponseError(parsed, ctx);

  const output = Array.isArray(body.output) ? body.output : [];
  const texts: string[] = [];
  let sawRefusal = false;
  let sawToolCall = false;

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type === "function_call" || row.type === "custom_tool_call" || row.type === "tool_call") {
      sawToolCall = true;
      continue;
    }
    if (row.type !== "message") continue;
    const content = Array.isArray(row.content) ? row.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "refusal") {
        sawRefusal = true;
        continue;
      }
      if (p.type === "output_text" && typeof p.text === "string") {
        const text = p.text.trim();
        if (text) texts.push(text);
      }
    }
  }

  if (sawRefusal) {
    throw new ProviderOperationError("BLOCKED", "OpenAI refused the request.", {
      ...ctx,
      responseFailure: "refusal",
    });
  }
  const text = texts.join("\n").trim();
  if (!text) {
    throw new ProviderOperationError(
      "INVALID_RESPONSE",
      sawToolCall ? "OpenAI returned only a tool call." : "OpenAI returned no text.",
      { ...ctx, responseFailure: sawToolCall ? "tool_call_only" : "empty_response" }
    );
  }
  return text;
}

function resolveMaxOutputTokens(providerOptions: Record<string, unknown> | undefined): number {
  const raw = providerOptions?.["maxOutputTokens"];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(
      OPENAI_MIN_OUTPUT_TOKENS,
      Math.min(OPENAI_MAX_OUTPUT_TOKENS, Math.trunc(raw))
    );
  }
  return OPENAI_DEFAULT_MAX_OUTPUT_TOKENS;
}

function resolveReasoningEffort(
  providerOptions: Record<string, unknown> | undefined,
  fallback: "low" | "medium"
): string {
  const raw = providerOptions?.["reasoningEffort"];
  return typeof raw === "string" && REASONING_EFFORTS.has(raw) ? raw : fallback;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The one implemented provider: OpenAI (Responses API). */
export class OpenAIProvider implements AiProvider {
  readonly id = "openai";
  readonly name = "OpenAI";
  readonly capabilities: AiCapabilities = { ...OPENAI_BASELINE_CAPABILITIES };

  private readonly fetchFn: OpenAIFetchLike;
  private readonly credential?: string;

  constructor(options: OpenAIProviderOptions = {}) {
    this.fetchFn = options.fetchFn ?? defaultFetch();
    // Defense-in-depth: the provider object is never serialized to a client, but
    // keep the credential non-enumerable so accidental object inspection/spread
    // cannot surface it.
    Object.defineProperty(this, "credential", {
      value: options.credential,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  isAvailable(): boolean {
    if (this.credential) return true;
    return Boolean(getServerSecretSync("openai_api_key"));
  }

  async testConnection(): Promise<boolean> {
    // Bounded: no network probe (matches Gemini/OpenRouter/DeepSeek semantics).
    return this.isAvailable();
  }

  private requireKey(): string {
    const key = this.credential ?? getServerSecretSync("openai_api_key");
    if (!key) {
      throw new ProviderOperationError("UNAVAILABLE", "OpenAI is not available (no API key).", {});
    }
    return key;
  }

  private buildBody(
    prompt: string,
    options: AiGenerateOptions,
    schema: AiJsonSchema | undefined
  ): Record<string, unknown> {
    const providerOptions = isPlainRecord(options.providerOptions)
      ? options.providerOptions
      : undefined;
    const reasoningEffort = resolveReasoningEffort(providerOptions, schema ? "medium" : "low");
    const body: Record<string, unknown> = {
      model: options.model,
      input: prompt,
      store: false,
      service_tier: "default",
      max_output_tokens: resolveMaxOutputTokens(providerOptions),
      reasoning: { effort: reasoningEffort },
    };
    // GPT-6 reasoning rejects temperature/top_p above effort "none" (official
    // GPT-6 guidance). TKC's defaults are low/medium, so sampling parameters are
    // omitted unless the caller explicitly selects the supported "none" mode.
    if (
      reasoningEffort === "none" &&
      typeof options.temperature === "number" &&
      Number.isFinite(options.temperature) &&
      options.temperature >= 0 &&
      options.temperature <= 2
    ) {
      body.temperature = options.temperature;
    }
    if (schema) {
      body.text = {
        format: {
          type: "json_schema",
          name: STRUCTURED_SCHEMA_NAME,
          schema: toStrictJsonSchema(schema),
          strict: true,
        },
      };
    }
    return body;
  }

  private async request(
    prompt: string,
    options: AiGenerateOptions,
    schema?: AiJsonSchema
  ): Promise<string> {
    throwIfCallerCancelled(options.signal, { providerId: this.id, model: options.model });
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new ProviderOperationError("INVALID_RESPONSE", "OpenAI prompt was empty.", {
        providerId: this.id,
        model: options.model,
      });
    }
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new ProviderOperationError("INVALID_RESPONSE", "OpenAI model is required.", {
        providerId: this.id,
      });
    }

    const key = this.requireKey();
    const body = this.buildBody(prompt, options, schema);
    const timeoutSignal = AbortSignal.timeout(OPENAI_TEXT_TIMEOUT_MS);
    const providerSignal = options.signal
      ? AbortSignal.any([timeoutSignal, options.signal])
      : timeoutSignal;

    let res: Response;
    try {
      res = await this.fetchFn(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: providerSignal,
      });
    } catch (err) {
      if (providerSignal.aborted) {
        throwIfProviderRequestAborted(options.signal, timeoutSignal, {
          providerId: this.id,
          model: options.model,
        });
      }
      if (options.signal?.aborted) {
        throw callerCancellationError({ providerId: this.id, model: options.model }, err);
      }
      const code = classifyProviderError(err);
      throw new ProviderOperationError(
        code === "PROVIDER_ERROR" ? "UNAVAILABLE" : code,
        "OpenAI request failed.",
        { providerId: this.id, model: options.model }
      );
    }

    if (!res.ok) {
      const errorText = await readErrorText(res);
      let parsed: unknown = undefined;
      try {
        parsed = errorText ? JSON.parse(errorText) : undefined;
      } catch {
        parsed = undefined;
      }
      throwIfProviderRequestAborted(options.signal, timeoutSignal, {
        providerId: this.id,
        model: options.model,
      });
      const error = readErrorCode(parsed);
      const code = classifyHttpError(res.status, error.code, error.type);
      const normalized = new ProviderOperationError(
        code,
        `OpenAI request failed (HTTP ${res.status}).`,
        { providerId: this.id, model: options.model, status: res.status }
      );
      const retryAfter = res.headers?.get("Retry-After");
      if (retryAfter) {
        Object.defineProperty(normalized, "retryAfter", {
          value: retryAfter,
          enumerable: false,
          writable: false,
        });
      }
      throw normalized;
    }

    const parsed = await (async () => {
      try {
        return await readBoundedJson(res, OPENAI_MAX_RESPONSE_BYTES, {
          providerId: this.id,
          model: options.model,
        });
      } catch (err) {
        if (providerSignal.aborted) {
          throwIfProviderRequestAborted(options.signal, timeoutSignal, {
            providerId: this.id,
            model: options.model,
          });
        }
        if (options.signal?.aborted) {
          throw callerCancellationError({ providerId: this.id, model: options.model }, err);
        }
        if (err instanceof ProviderOperationError) throw err;
        const code = classifyProviderError(err);
        throw new ProviderOperationError(
          code === "PROVIDER_ERROR" ? "INVALID_RESPONSE" : code,
          "OpenAI response reading failed.",
          { providerId: this.id, model: options.model }
        );
      }
    })();
    throwIfProviderRequestAborted(options.signal, timeoutSignal, {
      providerId: this.id,
      model: options.model,
    });
    return extractOpenAIText(parsed, { providerId: this.id, model: options.model });
  }

  async generate(prompt: string, options: AiGenerateOptions): Promise<string> {
    return this.request(prompt, options);
  }

  async generateStructured<T = unknown>(
    prompt: string,
    schema: AiJsonSchema,
    options: AiStructuredOptions
  ): Promise<T> {
    const text = await this.request(prompt, options, schema);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderOperationError(
        "INVALID_RESPONSE",
        "OpenAI returned invalid JSON.",
        { providerId: this.id, model: options.model, responseFailure: "malformed_json" }
      );
    }
    if (!validatesAiSchema(parsed, schema)) {
      throw new ProviderOperationError(
        "INVALID_RESPONSE",
        "OpenAI returned invalid structured data.",
        { providerId: this.id, model: options.model, responseFailure: "schema_mismatch" }
      );
    }
    return parsed as T;
  }
}
