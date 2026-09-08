/**
 * The Kitchen Codex — OpenRouter AiProvider adapter (v0.7 Phase 1B).
 *
 * The SECOND real provider. It speaks the OpenAI-compatible chat-completions
 * protocol over OpenRouter's fixed API endpoint. SERVER-SIDE ONLY.
 *
 * SECURITY / SCOPE (must never be weakened):
 *   - The endpoint is FIXED to OpenRouter's official base URL. No caller-controlled
 *     baseUrl/endpoint/host is accepted (no arbitrary endpoint capability).
 *   - The key comes ONLY from `process.env.OPENROUTER_API_KEY` (server-side).
 *     It is never in VITE_*, browser, settings, Markdown, logs, diagnostics, or
 *     returned to the UI.
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
import { ProviderOperationError, classifyProviderError } from "./providerErrors.js";
import type {
  AiCapabilities,
  AiGenerateOptions,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from "./types.js";

/** OpenRouter's fixed, official chat-completions endpoint (never configurable). */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_CHAT_ENDPOINT = `${OPENROUTER_BASE_URL}/chat/completions`;

/** Stable, safe json_schema name (OpenRouter/OpenAI structured output requires it). */
const STRUCTURED_SCHEMA_NAME = "structured_output";

/**
 * Maps the provider-neutral `AiJsonSchema` onto standard JSON Schema for
 * OpenRouter's `json_schema` structured-output format. Object nodes are closed
 * (`additionalProperties: false`) so strict mode is honored; `required`,
 * `enum`, `items`, and `description` are preserved verbatim.
 */
function toOpenRouterJsonSchema(schema: AiJsonSchema): Record<string, unknown> {
  const node: Record<string, unknown> = { type: schema.type };
  if (typeof schema.description === "string" && schema.description.trim()) {
    node.description = schema.description.trim();
  }
  switch (schema.type) {
    case "string":
      if (Array.isArray(schema.enum) && schema.enum.length) node.enum = schema.enum;
      break;
    case "array":
      node.items = toOpenRouterJsonSchema(schema.items);
      break;
    case "object": {
      const properties: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties)) {
        properties[key] = toOpenRouterJsonSchema(child);
      }
      node.properties = properties;
      node.additionalProperties = false;
      if (Array.isArray(schema.required) && schema.required.length) node.required = schema.required;
      break;
    }
    // number / integer / boolean: no extra members.
  }
  return node;
}

/** Conservative provider baseline: unknown OpenRouter models claim nothing. */
const OPENROUTER_BASELINE_CAPABILITIES: AiCapabilities = {
  reasoning: false,
  structuredOutput: false,
  recipeGeneration: false,
  webSearch: false,
};

export interface OpenRouterFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type OpenRouterFetchLike = (url: string, init: RequestInit) => Promise<OpenRouterFetchResponse>;

export interface OpenRouterProviderOptions {
  /** Test-only seam; defaults to the global fetch. Never a config surface. */
  fetchFn?: OpenRouterFetchLike;
}

function defaultFetch(): OpenRouterFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

async function asJson<T>(res: OpenRouterFetchResponse): Promise<T | undefined> {
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

/** The one implemented provider: OpenRouter (OpenAI-compatible). */
export class OpenRouterProvider implements AiProvider {
  readonly id = "openrouter";
  readonly name = "OpenRouter";
  readonly capabilities: AiCapabilities = { ...OPENROUTER_BASELINE_CAPABILITIES };
  private readonly fetchFn: OpenRouterFetchLike;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.fetchFn = options.fetchFn ?? defaultFetch();
  }

  isAvailable(): boolean {
    const key = (process.env.OPENROUTER_API_KEY || "").trim();
    return key.length > 0;
  }

  async testConnection(): Promise<boolean> {
    // Bounded: no network probe (matches Gemini's availability-only semantics).
    return this.isAvailable();
  }

  private requireKey(): string {
    const key = (process.env.OPENROUTER_API_KEY || "").trim();
    if (!key) throw new ProviderOperationError("UNAVAILABLE", "OpenRouter is not available (no API key).", {});
    return key;
  }

  private buildRequest(prompt: string, options: AiGenerateOptions, schema?: AiJsonSchema) {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [{ role: "user", content: prompt }],
    };
    if (typeof options.temperature === "number") body["temperature"] = options.temperature;
    if (schema) {
      // Honor the supplied provider-neutral schema: json_schema (strict) mode is the
      // semantic contract, not plain json_object. require_parameters ensures the
      // upstream model must actually accept/use the structured-output parameters.
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: "structured_output",
          strict: true,
          schema: toOpenRouterJsonSchema(schema),
        },
      };
      body["provider"] = { require_parameters: true };
    }
    return body;
  }

  private async chat(
    prompt: string,
    options: AiGenerateOptions,
    schema?: AiJsonSchema
  ): Promise<string> {
    const key = this.requireKey();
    const body = this.buildRequest(prompt, options, schema);

    let res: OpenRouterFetchResponse;
    try {
      res = await this.fetchFn(OPENROUTER_CHAT_ENDPOINT, {
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
        "OpenRouter request failed.",
        {},
        err
      );
    }

    if (!res.ok) {
      const parsed = await asJson<{ error?: { message?: string } }>(res);
      const rawMessage = parsed?.error?.message ?? `OpenRouter request failed (HTTP ${res.status}).`;
      const error = Object.assign(new Error(rawMessage), { status: res.status });
      const code = classifyProviderError(error);
      throw new ProviderOperationError(code, rawMessage, {}, error);
    }

    const parsed = await asJson<unknown>(res);
    const text = extractContent(parsed);
    if (!text) {
      throw new ProviderOperationError("INVALID_RESPONSE", "OpenRouter returned an empty response.", {});
    }
    return text;
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
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ProviderOperationError("INVALID_RESPONSE", "OpenRouter returned unparseable JSON.", {}, err);
    }
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
