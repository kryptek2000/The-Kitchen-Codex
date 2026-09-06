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

/**
 * A provider-agnostic, JSON-Schema-lite structure that maps onto a provider's
 * structured-output schema. Guarded recursion keeps it bounded and avoids
 * serializing arbitrary provider schema objects.
 */
export type AiJsonSchema =
  | { type: "string"; enum?: string[] }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "array"; items: AiJsonSchema }
  | { type: "object"; properties: Record<string, AiJsonSchema>; required?: string[] };

/** Options for a plain text generation call. */
export interface AiGenerateOptions {
  /** Provider model id (role-specific selection belongs to the caller). */
  model?: string;
  temperature?: number;
}

/** Options for a structured generation call. */
export interface AiStructuredOptions extends AiGenerateOptions {
  /** Request provider-backed web search grounding (Gemini Google-Search tool). */
  webSearch?: boolean;
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
}
