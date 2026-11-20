/**
 * The Kitchen Codex — OpenRouter AiProvider adapter (v0.7 Phase 1B).
 *
 * The SECOND real provider. It speaks the OpenAI-compatible chat-completions
 * protocol over OpenRouter's fixed API endpoint. SERVER-SIDE ONLY.
 *
 * SECURITY / SCOPE (must never be weakened):
 *   - The endpoint is FIXED to OpenRouter's official base URL. No caller-controlled
 *     baseUrl/endpoint/host is accepted (no arbitrary endpoint capability).
 *   - The key comes ONLY from the server-side operator environment via
 *     `getServerSecretSync("openrouter_api_key")` (the allowlisted
 *     `OPENROUTER_API_KEY`). It is never in VITE_*, browser, settings, Markdown,
 *     logs, diagnostics, or returned to the UI.
 *   - No SSRF surface: only the fixed OpenRouter host is reached.
 *   - The `NetworkAdapter` is NOT involved (this is an AI-provider transport, not
 *     the app-backend API transport).
 *
 * CAPABILITIES (conservative): unknown models claim NOTHING; per-model capability
 * truth lives in the registered provider descriptor. `webSearch` is always false
 * (OpenRouter has no provider-backed grounded search, so `searchWeb` is omitted —
 * an ordinary text model can never satisfy the webSearch capability).
 */

import { MODEL_CONFIG } from "../modelConfig.js";
import { APPLICATION_VALIDATED_JSON_PROFILE, type OpenRouterProfile } from '../../src/core/ai/openRouterProfile.js';
import { structuredRequestFields, completionContent, readRuntimeCompletion, OPENROUTER_RUNTIME_TOKENS, type StreamResponse } from './openRouterOutput.js';
import { toStrictJsonSchema, validatesAiSchema } from '../../src/core/ai/strictJsonSchema.js';
import { getServerSecretSync } from "../platform/ServerEnvironmentSecretAdapter.js";
import { ProviderOperationError, callerCancellationError, classifyProviderError, throwIfCallerCancelled, throwIfProviderRequestAborted } from "./providerErrors.js";
import type {
  AiCapabilities,
  AiGenerateOptions,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from "./types.js";

/** OpenRouter's fixed, official chat-completions endpoint (never configurable). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_CHAT_ENDPOINT = `${OPENROUTER_BASE_URL}/chat/completions`;

/** Stable, safe json_schema name (OpenRouter/OpenAI structured output requires it). */
const STRUCTURED_SCHEMA_NAME = "structured_output";

/**
 * Back-compat export. The strict-schema conversion now lives in the shared
 * provider-neutral module so OpenAI and OpenRouter cannot drift.
 */
export const toOpenRouterJsonSchema = toStrictJsonSchema;

/** Conservative provider baseline: unknown OpenRouter models claim nothing. */
const OPENROUTER_BASELINE_CAPABILITIES: AiCapabilities = {
  reasoning: false,
  structuredOutput: false,
  recipeGeneration: false,
  webSearch: false,
};

export interface OpenRouterFetchResponse extends StreamResponse {
  ok: boolean;
  status: number;
  /** Baseline (pre-Astra) JSON reader. Real Responses always provide it. */
  json?(): Promise<unknown>;
}

export type OpenRouterFetchLike = (url: string, init: RequestInit) => Promise<OpenRouterFetchResponse>;

export interface OpenRouterProviderOptions {
  /** Test-only seam; defaults to the global fetch. Never a config surface. */
  fetchFn?: OpenRouterFetchLike;
  /**
   * BYOK-5C: an EXPLICIT session credential. When present it is used INSTEAD of
   * the operator env key (never a fallback). The provider instance is
   * request-scoped; no global cache retains the credential.
   */
  credential?: string;
}

function defaultFetch(): OpenRouterFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

/**
 * EXACT baseline (pre-Astra) curated/server-default response reading. It uses the
 * platform JSON reader with NO streamed byte ceiling, matching `f970ef8`. Applied
 * ONLY to `curated` execution; verified-dynamic execution keeps the bounded
 * 256 KiB streamed reader in `openRouterOutput.ts`.
 */
async function asJson<T>(res: OpenRouterFetchResponse, signal?: AbortSignal, timeoutSignal?: AbortSignal): Promise<T | undefined> {
  try {
    if (typeof res.json !== "function") return undefined;
    return (await res.json()) as T;
  } catch (error) {
    if (timeoutSignal) throwIfProviderRequestAborted(signal, timeoutSignal, { providerId: "openrouter" });
    throwIfCallerCancelled(signal, { providerId: "openrouter" });
    const code = classifyProviderError(error);
    if (code === "TIMEOUT" || code === "NETWORK") {
      throw new ProviderOperationError(code, "OpenRouter response reading failed.", { providerId: "openrouter" }, error);
    }
    return undefined;
  }
}

/** Baseline assistant-content extraction (curated path). */

/**
 * TRUSTED, server-derived execution context for an OpenRouter structured call.
 * It is NEVER derived from client input and NEVER from model-name guessing:
 *   - `verified_dynamic` requires a CURRENT server-side capability-verification
 *     record (pricing-fresh + fingerprint + TTL bound), and carries that
 *     server-recorded profile;
 *   - `curated` is membership in the server-owned strict-structured allowlist.
 * This signal is what distinguishes the bounded dynamic-free request behavior
 * from the EXACT baseline curated/server-default request behavior.
 */
export type OpenRouterExecutionContext =
  | { source: "curated" }
  | { source: "verified_dynamic"; profile: OpenRouterProfile }
  | { source: "ordinary_free_text" };

/** The one implemented provider: OpenRouter (OpenAI-compatible). */
export class OpenRouterProvider implements AiProvider {
  readonly id = "openrouter";
  readonly name = "OpenRouter";
  readonly capabilities: AiCapabilities = { ...OPENROUTER_BASELINE_CAPABILITIES };
  private readonly fetchFn: OpenRouterFetchLike;
  private readonly credential?: string;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.fetchFn = options.fetchFn ?? defaultFetch();
    this.credential = options.credential;
  }

  isAvailable(): boolean {
    if (this.credential) return true;
    return Boolean(getServerSecretSync("openrouter_api_key"));
  }

  async testConnection(): Promise<boolean> {
    // Bounded: no network probe (matches Gemini's availability-only semantics).
    return this.isAvailable();
  }

  private requireKey(): string {
    // A session credential is used EXCLUSIVELY when supplied — never env fallback.
    const key = this.credential ?? getServerSecretSync("openrouter_api_key");
    if (!key) throw new ProviderOperationError("UNAVAILABLE", "OpenRouter is not available (no API key).", {});
    return key;
  }

  private buildRequest(
    prompt: string,
    options: AiGenerateOptions,
    schema: AiJsonSchema | undefined,
    execution: OpenRouterExecutionContext
  ) {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [{ role: "user", content: prompt }],
    };
    if (typeof options.temperature === "number") body["temperature"] = options.temperature;
    if (schema) {
      const converted = toOpenRouterJsonSchema(schema);
      if (execution.source === "verified_dynamic") {
        // Explicitly verified dynamic-free execution keeps the bounded runtime
        // budget and the server-recorded profile (never the client's claim).
        Object.assign(
          body,
          structuredRequestFields(execution.profile, converted, STRUCTURED_SCHEMA_NAME, OPENROUTER_RUNTIME_TOKENS)
        );
        if (execution.profile === APPLICATION_VALIDATED_JSON_PROFILE) {
          body.messages = [{ role: 'user', content: `${prompt}\nReturn only a JSON value matching this schema. No prose or Markdown.\n${JSON.stringify(converted)}` }];
        }
      } else {
        // Curated/server-default execution preserves the EXACT baseline request:
        // json_schema (strict) + require_parameters, and NO max_tokens/reasoning.
        body["response_format"] = {
          type: "json_schema",
          json_schema: {
            name: "structured_output",
            strict: true,
            schema: converted,
          },
        };
        body["provider"] = { require_parameters: true };
      }
    }
    return body;
  }

  private async chat(
    prompt: string,
    options: AiGenerateOptions,
    schema?: AiJsonSchema
  ): Promise<string> {
    throwIfCallerCancelled(options.signal, { providerId: this.id, model: options.model });
    // Dynamic import avoids the catalog/provider construction cycle. No await
    // between the final authorization check and dispatch below.
    const catalog = await import('./openRouterCatalog.js');
    throwIfCallerCancelled(options.signal, { providerId: this.id, model: options.model });
    // TRUSTED server-side execution context. A verified-dynamic context requires a
    // CURRENT verification record; curated membership is a separate server-owned
    // signal. The model id is never compared to a hard-coded curated slug.
    const verifiedProfile = catalog.verifiedOpenRouterProfile(options.model);
    const execution: OpenRouterExecutionContext | undefined = verifiedProfile
      ? { source: "verified_dynamic", profile: verifiedProfile }
      : catalog.isVerifiedStrictStructuredModel(options.model)
      ? { source: "curated" }
      : !schema && catalog.openRouterConversationTextModelIds().includes(options.model)
      ? { source: "ordinary_free_text" }
      : undefined;
    if (!execution || (execution.source === "verified_dynamic" && !schema)) {
      throw new ProviderOperationError('UNSUPPORTED_CAPABILITY', 'The selected free model is not currently verified.', {});
    }
    const key = this.requireKey();
    const body = this.buildRequest(prompt, options, schema, execution);

    const timeoutMs =
      typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0 &&
      options.timeoutMs <= 120_000
        ? options.timeoutMs
        : MODEL_CONFIG.requestTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const providerSignal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
    let res: OpenRouterFetchResponse;
    try {
      res = await this.fetchFn(OPENROUTER_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: providerSignal,
      });
    } catch (err) {
      if (providerSignal.aborted) throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model: options.model });
      if (options.signal?.aborted) throw callerCancellationError({ providerId: this.id, model: options.model }, err);
      // Transport-level failure / timeout. Connection failures map to UNAVAILABLE;
      // timeouts/aborts to TIMEOUT. Never leaks secrets.
      const code = classifyProviderError(err);
      throw new ProviderOperationError(
        code === "PROVIDER_ERROR" ? "UNAVAILABLE" : code,
        "OpenRouter request failed.",
        {}
      );
    }

    if (!res.ok) {
      throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model: options.model });
      const error = Object.assign(new Error('OpenRouter request failed.'), { status: res.status });
      const code = classifyProviderError(error);
      throw new ProviderOperationError(code, 'OpenRouter request failed.', { status: res.status });
    }

    if (execution.source === "verified_dynamic") {
      // Verified-dynamic execution: bounded 256 KiB streamed reader, overflow
      // cancellation, and full structural validation. The body is read EXACTLY
      // once here.
      let parsed: unknown;
      try {
        parsed = await readRuntimeCompletion(res);
      } catch (error) {
        if (providerSignal.aborted) throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model: options.model });
        if (options.signal?.aborted) throw callerCancellationError({ providerId: this.id, model: options.model });
        const code = classifyProviderError(error);
        if (code === "TIMEOUT" || code === "NETWORK") {
          throw new ProviderOperationError(code, "OpenRouter response reading failed.", { providerId: this.id, model: options.model }, error);
        }
        throw new ProviderOperationError('INVALID_RESPONSE', 'OpenRouter returned an unreadable or oversized response.', {});
      }
      throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model: options.model });
      const extracted = completionContent(parsed);
      if (extracted.ok === false) throw new ProviderOperationError('INVALID_RESPONSE', 'OpenRouter did not return a complete supported answer.', { responseFailure: extracted.reason });
      return extracted.content;
    }

    // Curated/server-default execution: EXACT baseline (pre-Astra) reading with
    // NO streamed byte ceiling. The body is read EXACTLY once here.
    const parsed = await asJson<unknown>(res, options.signal, timeoutSignal);
    throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model: options.model });
    const extracted = completionContent(parsed);
    if (extracted.ok === false) {
      throw new ProviderOperationError('INVALID_RESPONSE', 'OpenRouter did not return a complete supported answer.', { responseFailure: extracted.reason });
    }
    return extracted.content;
  }

  async generate(prompt: string, options: AiGenerateOptions): Promise<string> {
    return this.chat(prompt, options);
  }

  async generateStructured<T = unknown>(
    prompt: string,
    schema: AiJsonSchema,
    options: AiStructuredOptions
  ): Promise<T> {
    const text = await this.chat(prompt, options, schema);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      throw new ProviderOperationError("INVALID_RESPONSE", "OpenRouter returned invalid JSON.", { responseFailure: "malformed_json" });
    }
    if (!validatesAiSchema(parsed, schema)) throw new ProviderOperationError("INVALID_RESPONSE", "OpenRouter returned invalid structured data.", { responseFailure: "schema_mismatch" });
    return parsed as T;
  }
}

/**
 * Curated OpenRouter model slug used by Kitchen Codex role mapping. This is the
 * ONLY model we declare `structuredOutput:true` for, and only because our adapter
 * can honor schema-constrained (json_schema strict) structured output for it.
 */
export const OPENROUTER_STRUCTURED_MODEL = "openai/gpt-4o-mini";

/**
 * Per-model capability truth for the curated OpenRouter set. UNKNOWN models fall
 * back to the conservative baseline (nothing claimed). Only models our adapter can
 * honor schema-constrained structured output for are declared `structuredOutput:
 * true`; no model is declared without that guarantee.
 */
export const OPENROUTER_MODEL_CAPABILITIES: Record<string, Partial<AiCapabilities>> = {
  [OPENROUTER_STRUCTURED_MODEL]: { structuredOutput: true, recipeGeneration: true },
};
