/**
 * The Kitchen Codex — Minimal AI Provider Abstraction (v0.6.0 Phase 1).
 *
 * A SMALL, capability-based provider contract. Phase 1 implements ONLY Gemini;
 * OpenRouter / DeepSeek / BYOK are out of scope. The interface is intentionally
 * limited to what the current server-side AI features actually need today:
 * plain text generation and STRUCTURED (JSON-schema-constrained) generation,
 * plus an availability/connection signal. Provider-specific knobs (thinking
 * level, grounding search) are NOT on the base interface in Phase 1 so the
 * contract does not pretend all providers are identical.
 *
 * SECURITY: the abstraction never touches, returns, or exposes any API key.
 * Provider credentials stay server-side behind `server/geminiClient.ts`.
 */

/** Broad capability categories a provider may (or may not) support. */
export type AiCapability = "reasoning" | "structuredOutput" | "recipeGeneration" | "webSearch";

/** Declared capabilities. `webSearch` is only true when the provider can return
 * trustworthy provider-backed web results (e.g. Google Search grounding). */
export interface AiCapabilities {
  reasoning: boolean;
  structuredOutput: boolean;
  recipeGeneration: boolean;
  webSearch: boolean;
}

/** Optional provider-neutral hint shared by every schema node. */
export interface AiSchemaBase {
  /** Human-readable description carried through to the provider schema. */
  description?: string;
}

/**
 * A provider-agnostic, JSON-Schema-lite structure that maps onto a provider's
 * structured-output schema. Guarded recursion keeps it bounded and avoids
 * serializing arbitrary provider schema objects.
 */
export type AiJsonSchema =
  | (AiSchemaBase & { type: "string"; enum?: string[] })
  | (AiSchemaBase & { type: "number" })
  | (AiSchemaBase & { type: "integer" })
  | (AiSchemaBase & { type: "boolean" })
  | (AiSchemaBase & { type: "array"; items: AiJsonSchema })
  | (AiSchemaBase & { type: "object"; properties: Record<string, AiJsonSchema>; required?: string[] });

/** Options for a plain text generation call. */
export interface AiGenerateOptions {
  /** Provider model id. REQUIRED so an omitted model never silently routes to an
   * unrelated semantic role (e.g. nutrition). Role-model selection is explicit. */
  model: string;
  temperature?: number;
  /**
   * Provider-specific options, allowlisted by each adapter. Adapters must only
   * read a FIXED set of safe keys and must NEVER blindly spread this object into
   * a request config. No secret-bearing fields are allowed.
   */
  providerOptions?: Record<string, unknown>;
}

/** Options for a structured generation call. */
export interface AiStructuredOptions extends AiGenerateOptions {
  /** Request provider-backed web search grounding (Gemini Google-Search tool). */
  webSearch?: boolean;
}

/**
 * A provider-neutral, trusted web-source result. Only populated from provider
 * search evidence (e.g. Gemini grounding metadata) — NEVER from model prose.
 * `url` is the provider-backed source URL; `title`/`sourceName` are display.
 */
export interface AiSearchResult {
  title?: string;
  url: string;
  sourceName?: string;
}

/** Options for a provider-backed web search call. */
export interface AiSearchOptions {
  /** Provider model id. REQUIRED (no silent role-model default). */
  model: string;
  temperature?: number;
}

/**
 * The minimal provider contract. Implementations MUST be idempotent and safe to
 * call with no key (degrading to `isAvailable() === false` and throwing on
 * generate when unavailable) — never hanging or leaking credentials.
 */
export interface AiProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: AiCapabilities;

  /** True when the provider can be reached with the current configuration. */
  isAvailable(): boolean;

  /** Availability/connection probe. Phase 1 returns availability only. */
  testConnection(): Promise<boolean>;

  /** Plain text generation. Throws when unavailable. */
  generate(prompt: string, options?: AiGenerateOptions): Promise<string>;

  /**
   * Structured generation constrained by `schema`. Returns the parsed provider
   * JSON output. Throws when unavailable or the provider output is unparseable.
   */
  generateStructured<T = unknown>(
    prompt: string,
    schema: AiJsonSchema,
    options?: AiStructuredOptions
  ): Promise<T>;

  /**
   * Optional provider-backed web search. Only present when the provider
   * advertises the `webSearch` capability (e.g. Gemini Google-Search grounding).
   * Returns provider-trusted sources; NEVER model-prose URLs. A provider that
   * does not support web search omits this and discovery reports unavailable.
   */
  searchWeb?(prompt: string, options: AiSearchOptions): Promise<AiSearchResult[]>;
}
