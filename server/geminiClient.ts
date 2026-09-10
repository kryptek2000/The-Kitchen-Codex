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
import { getServerSecretSync } from "./platform/ServerEnvironmentSecretAdapter.js";

let aiClient: GoogleGenAI | null = null;
let lastApiKey: string | undefined = undefined;

let imageAiClient: GoogleGenAI | null = null;
let lastImageApiKey: string | undefined = undefined;

/** Allowlisted, provider-neutral server key resolution (placeholder treated as unset). */
function resolveGeminiKey(): string | undefined {
  const key = getServerSecretSync("gemini_api_key");
  return key && key !== "MY_GEMINI_API_KEY" ? key : undefined;
}

function buildClient(apiKey: string, timeoutMs: number): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
      timeout: timeoutMs,
    },
  });
}

/**
 * Returns a configured Gemini client for the current `GEMINI_API_KEY` (read ONLY
 * through the approved server-side secret accessor / allowlist seam — the same
 * seam OpenRouter and DeepSeek use), or `null` when the key is unset / still the
 * placeholder. The instance is cached and only rebuilt when the key value changes.
 *
 * Uses the shared TEXT request timeout (`MODEL_CONFIG.requestTimeoutMs`).
 *
 * BYOK-2: this is the direct-`process.env` outlier normalization. There is NO
 * broad/dynamic env access and no secret is ever returned to a caller.
 */
export function getGemini(): GoogleGenAI | null {
  const key = resolveGeminiKey();
  if (!key) return null;
  if (!aiClient || lastApiKey !== key) {
    lastApiKey = key;
    aiClient = buildClient(key, MODEL_CONFIG.requestTimeoutMs);
  }
  return aiClient;
}

/**
 * Returns a Gemini client for IMAGE GENERATION with the server-owned image
 * timeout (`MODEL_CONFIG.imageGenerationTimeoutMs`, 60s) instead of the 25s text
 * ceiling — image generation routinely takes 10-60s and must not false-time-out.
 * Same key allowlist + rotation-cache semantics as `getGemini()`.
 */
export function getGeminiImage(): GoogleGenAI | null {
  const key = resolveGeminiKey();
  if (!key) return null;
  if (!imageAiClient || lastImageApiKey !== key) {
    lastImageApiKey = key;
    imageAiClient = buildClient(key, MODEL_CONFIG.imageGenerationTimeoutMs);
  }
  return imageAiClient;
}
