/**
 * The Kitchen Codex — Gemini AiProvider adapter (v0.6.0 Phase 1).
 *
 * Wraps the existing server-side Gemini client behind `AiProvider`. It preserves
 * the exact current behavior: key availability via `server/geminiClient.ts`
 * (returns null when GEMINI_API_KEY is absent/placeholder), the shared timeout,
 * model selection passed by the caller, structured-output via Gemini schema,
 * and Google-Search grounding when `webSearch` is requested. It does NOT change
 * any model ID, thinking level, or the grounding-only URL contract.
 */

import { ThinkingLevel, Type } from "@google/genai";
import { getGemini } from "../geminiClient.js";
import { extractWebResultsFromGrounding } from "../../src/utils/kitchenDiscovery.js";
import type {
  AiCapabilities,
  AiGenerateOptions,
  AiJsonSchema,
  AiProvider,
  AiSearchOptions,
  AiSearchResult,
  AiStructuredOptions,
} from "./types.js";

const UNAVAILABLE_MSG = "AI provider is not available.";

/** Safe, allowlisted Gemini provider-option keys (never a blind pass-through). */
const GEMINI_THINKING_LEVELS: Record<string, ThinkingLevel> = {
  MINIMAL: ThinkingLevel.MINIMAL,
  LOW: ThinkingLevel.LOW,
  MEDIUM: ThinkingLevel.MEDIUM,
  HIGH: ThinkingLevel.HIGH,
};

/** Extracts ONLY the allowlisted Gemini provider options into a request fragment. */
function geminiProviderOptions(options: { providerOptions?: Record<string, unknown> }): Record<string, unknown> {
  const po = options.providerOptions;
  if (!po || typeof po !== "object" || Array.isArray(po)) return {};
  const out: Record<string, unknown> = {};
  const thinkingConfig = (po as Record<string, unknown>)["thinkingConfig"];
  if (thinkingConfig && typeof thinkingConfig === "object" && !Array.isArray(thinkingConfig)) {
    const level = (thinkingConfig as Record<string, unknown>)["thinkingLevel"];
    if (typeof level === "string" && GEMINI_THINKING_LEVELS[level]) {
      out["thinkingConfig"] = { thinkingLevel: GEMINI_THINKING_LEVELS[level] };
    }
  }
  return out;
}

/** Maps a provider-agnostic JSON-Schema-lite node onto a Gemini schema node. */
function toGeminiSchema(schema: AiJsonSchema): Record<string, unknown> {
  const withDescription = (node: Record<string, unknown>): Record<string, unknown> =>
    typeof schema.description === "string" && schema.description.trim()
      ? { ...node, description: schema.description.trim() }
      : node;

  switch (schema.type) {
    case "string": {
      const node = schema.enum
        ? { type: Type.STRING, enum: schema.enum }
        : { type: Type.STRING };
      return withDescription(node);
    }
    case "boolean":
      return withDescription({ type: Type.BOOLEAN });
    case "number":
      return withDescription({ type: Type.NUMBER });
    case "array":
      return withDescription({ type: Type.ARRAY, items: toGeminiSchema(schema.items) });
    case "object": {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        properties[key] = toGeminiSchema(value);
      }
      const node: Record<string, unknown> = { type: Type.OBJECT, properties };
      if (Array.isArray(schema.required) && schema.required.length) {
        node["required"] = schema.required;
      }
      return withDescription(node);
    }
    default:
      return { type: Type.STRING };
  }
}

/** The one implemented provider: Google Gemini. */
export class GeminiProvider implements AiProvider {
  readonly id = "gemini";
  readonly name = "Google Gemini";
  readonly capabilities: AiCapabilities = {
    reasoning: true,
    structuredOutput: true,
    recipeGeneration: true,
    webSearch: true,
  };

  isAvailable(): boolean {
    return getGemini() !== null;
  }

  async testConnection(): Promise<boolean> {
    return this.isAvailable();
  }

  private client() {
    const gemini = getGemini();
    if (!gemini) throw new Error(UNAVAILABLE_MSG);
    return gemini;
  }

  async generate(prompt: string, options: AiGenerateOptions): Promise<string> {
    const gemini = this.client();
    const response = await gemini.models.generateContent({
      model: options.model,
      contents: prompt,
      config: {
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...geminiProviderOptions(options),
      },
    });
    const text = response.text?.trim();
    if (!text) throw new Error("Empty response returned from AI provider.");
    return text;
  }

  async generateStructured<T = unknown>(
    prompt: string,
    schema: AiJsonSchema,
    options: AiStructuredOptions
  ): Promise<T> {
    const gemini = this.client();
    const response = await gemini.models.generateContent({
      model: options.model,
      contents: prompt,
      config: {
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(schema),
        ...(options.webSearch === true ? { tools: [{ googleSearch: {} }] } : {}),
        ...geminiProviderOptions(options),
      },
    });
    const text = response.text?.trim();
    if (!text) throw new Error("Empty response returned from AI provider.");
    return JSON.parse(text) as T;
  }

  /**
   * Provider-backed web search. Returns ONLY sources from Google-Search grounding
   * metadata (never model prose). When the provider yields no grounding chunk, an
   * empty array is returned so the caller can try a fallback or report
   * unavailable. Trust is preserved: no URL is synthesized or parsed from text.
   */
  async searchWeb(prompt: string, options: AiSearchOptions): Promise<AiSearchResult[]> {
    const gemini = this.client();
    const response = await gemini.models.generateContent({
      model: options.model,
      contents: prompt,
      config: {
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        tools: [{ googleSearch: {} }],
      },
    });
    const candidates = extractWebResultsFromGrounding(response);
    return candidates.map((c) => {
      const url = typeof c["url"] === "string" ? c["url"] : "";
      if (!url) return null;
      const title = typeof c["title"] === "string" && c["title"] ? c["title"] : undefined;
      const sourceName = typeof c["sourceName"] === "string" && c["sourceName"] ? c["sourceName"] : undefined;
      return {
        url,
        ...(title ? { title } : {}),
        ...(sourceName ? { sourceName } : {}),
      };
    }).filter((s): s is AiSearchResult => s !== null);
  }
}
