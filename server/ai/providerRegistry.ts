/**
 * The Kitchen Codex — minimal provider registry (v0.6.0 Phase 1).
 *
 * Resolves the current/default provider. Phase 1 registers only Gemini; unknown
 * ids resolve safely to `undefined`. No user/provider selection, no client
 * exposure, no OpenRouter/DeepSeek env reading yet.
 */

import { GeminiProvider } from "./geminiProvider.js";
import type { AiProvider } from "./types.js";

let defaultProvider: AiProvider | null = null;

function ensureDefault(): AiProvider {
  if (!defaultProvider) defaultProvider = new GeminiProvider();
  return defaultProvider;
}

/** The single active/default provider (Gemini). Lazily constructed once. */
export function getDefaultAiProvider(): AiProvider {
  return ensureDefault();
}

/**
 * Resolves a known provider by id. Unknown ids return undefined safely. Phase 1
 * only knows "gemini".
 */
export function getAiProvider(id: string): AiProvider | undefined {
  if (!id) return undefined;
  const known = getIdToProvider();
  return known[id];
}

function getIdToProvider(): Record<string, AiProvider> {
  const gemini = ensureDefault();
  return { [gemini.id]: gemini };
}
