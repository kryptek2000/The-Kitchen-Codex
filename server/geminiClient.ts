/**
 * The Kitchen Codex — shared Gemini AI client.
 *
 * A single bootstrap point for the GenAI SDK that is used by the nutrition
 * estimator, the metadata recovery engine, and the recipe grabber. It owns the
 * SDK client lifecycle so every caller gets identical behaviour:
 *
 *   - The API key stays server-side only (whatever is in `GEMINI_API_KEY`).
 *   - The client is recreated only when the key changes (dynamic key rotation);
 *     it is reused while the key is unchanged.
 *   - The key is never logged or echoed.
 *   - The request timeout comes from the central `MODEL_CONFIG`.
 *
 * Callers still control model selection and prompt content; this module only
 * returns a ready-to-use `GoogleGenAI` instance (or `null` when no key is set,
 * so callers fall through to their offline estimation path).
 */
import { GoogleGenAI } from "@google/genai";
import { MODEL_CONFIG } from "./modelConfig.js";

let aiClient: GoogleGenAI | null = null;
let lastApiKey: string | undefined = undefined;

/**
 * Returns a configured Gemini client for the current `GEMINI_API_KEY`, or `null`
 * when the key is unset / still the placeholder. The instance is cached and only
 * rebuilt when the key value changes.
 */
export function getGemini(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === "MY_GEMINI_API_KEY") {
    return null;
  }
  if (!aiClient || lastApiKey !== key) {
    lastApiKey = key;
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
        timeout: MODEL_CONFIG.requestTimeoutMs,
      },
    });
  }
  return aiClient;
}
