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

import { Type } from "@google/genai";
import { getGemini } from "../geminiClient.js";
import { MODEL_CONFIG } from "../modelConfig.js";
import type {
  AiCapabilities,
  AiGenerateOptions,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from "./types.js";

const UNAVAILABLE_MSG = "AI provider is not available.";

/** Maps a provider-agnostic JSON-Schema-lite node onto a Gemini schema node. */
function toGeminiSchema(schema: AiJsonSchema): Record<string, unknown> {
  switch (schema.type) {
    case "string":
      return schema.enum ? { type: Type.STRING, enum: schema.enum } : { type: Type.STRING };
    case "boolean":
      return { type: Type.BOOLEAN };
    case "number":
      return { type: Type.NUMBER };
    case "array":
      return { type: Type.ARRAY, items: toGeminiSchema(schema.items) };
    case "object": {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        properties[key] = toGeminiSchema(value);
      }
      const node: Record<string, unknown> = { type: Type.OBJECT, properties };
      if (Array.isArray(schema.required) && schema.required.length) {
        node["required"] = schema.required;
      }
      return node;
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

  /** Provider-wide default used when a caller does not pick a role model. */
  readonly defaultModel: string;

  constructor(options: { defaultModel?: string } = {}) {
    this.defaultModel = options.defaultModel ?? MODEL_CONFIG.nutritionPrimary;
  }

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

  async generate(prompt: string, options: AiGenerateOptions = {}): Promise<string> {
    const gemini = this.client();
    const response = await gemini.models.generateContent({
      model: options.model ?? this.defaultModel,
      contents: prompt,
      config: {
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      },
    });
    const text = response.text?.trim();
    if (!text) throw new Error("Empty response returned from AI provider.");
    return text;
  }

  async generateStructured<T = unknown>(
    prompt: string,
    schema: AiJsonSchema,
    options: AiStructuredOptions = {}
  ): Promise<T> {
    const gemini = this.client();
    const response = await gemini.models.generateContent({
      model: options.model ?? this.defaultModel,
      contents: prompt,
      config: {
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(schema),
        ...(options.webSearch === true ? { tools: [{ googleSearch: {} }] } : {}),
      },
    });
    const text = response.text?.trim();
    if (!text) throw new Error("Empty response returned from AI provider.");
    return JSON.parse(text) as T;
  }
}
