/**
 * The Kitchen Codex — curated role-model resolution (v0.7 Phase 1B).
 *
 * The SINGLE source for the curated role models a provider can execute for an
 * AI operation. It is used by:
 *   - `roleCandidates.ts` (builds the ordered candidate list),
 *   - `effectiveSelection.ts` (validates user selections against the CURATED
 *     model set — an uncurated model is never selectable),
 *   - `providerCatalog.ts` (observability of curated models),
 *   - `providerSelection.ts` (server-managed pin model validation),
 *
 * This module is deliberately LEAF-LEVEL (no dependency on roleCandidates or
 * effectiveSelection) to avoid a module cycle between the two selection-aware
 * layers.
 *
 * OWNERSHIP:
 *   - `server/modelConfig.ts` remains authoritative for GEMINI role models.
 *   - Per-provider OFFSET role models (OpenRouter / DeepSeek) layer over the
 *     same operation shape without duplicating consumer-side logic.
 */

import type { AiOperation } from "./operations.js";
import { AI_OPERATIONS } from "./operations.js";
import { MODEL_CONFIG } from "../modelConfig.js";
import { OPENROUTER_STRUCTURED_MODEL } from "./openRouterProvider.js";
import { DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL } from "./deepSeekProvider.js";

/** Gemini role models per operation (unchanged v0.6 behavior). */
const GEMINI_ROLE_MODELS: Record<AiOperation, string[]> = {
  kitchenInterpret: [MODEL_CONFIG.kitchenPrimary, MODEL_CONFIG.kitchenFallback],
  kitchenRank: [MODEL_CONFIG.kitchenPrimary, MODEL_CONFIG.kitchenFallback],
  kitchenDiscover: [MODEL_CONFIG.kitchenDiscoveryPrimary, MODEL_CONFIG.kitchenDiscoveryFallback],
  nutrition: [MODEL_CONFIG.nutritionPrimary, MODEL_CONFIG.nutritionFallback],
  metadataRecovery: [MODEL_CONFIG.metadataRecoveryPrimary, MODEL_CONFIG.metadataRecoveryFallback],
  recipeGrabber: [MODEL_CONFIG.recipeGrabberPrimary, MODEL_CONFIG.recipeGrabberFallback, MODEL_CONFIG.recipeGrabberAlias],
  // Create for Me is recipe generation: reuse the recipe-oriented Gemini models.
  createRecipe: [MODEL_CONFIG.recipeGrabberPrimary, MODEL_CONFIG.recipeGrabberFallback],
};

/** OpenRouter role models per operation (curated, cost-conscious structured-capable set). */
const OPENROUTER_ROLE_MODELS: Record<AiOperation, string[]> = {
  kitchenInterpret: [OPENROUTER_STRUCTURED_MODEL],
  kitchenRank: [OPENROUTER_STRUCTURED_MODEL],
  // Discovery candidates are resolved but capability-filtered out (webSearch:false).
  kitchenDiscover: [OPENROUTER_STRUCTURED_MODEL],
  nutrition: [OPENROUTER_STRUCTURED_MODEL],
  metadataRecovery: [OPENROUTER_STRUCTURED_MODEL],
  recipeGrabber: [OPENROUTER_STRUCTURED_MODEL],
  // Create for Me: only the curated structured+recipe-capable model is a candidate.
  createRecipe: [OPENROUTER_STRUCTURED_MODEL],
};

/**
 * DeepSeek role models per operation (curated, cost-conscious). DeepSeek has NO
 * schema-constrained structured output and NO webSearch, so these candidates are
 * resolved but capability-filtered OUT of every structured operation and out of
 * `kitchenDiscover`. The flash model is preferred (cheaper/faster); pro is the
 * stronger fallback. Mapping is provider-neutral (like OpenRouter) — the
 * selector owns the real capability gate.
 */
const DEEPSEEK_ROLE_MODELS: Record<AiOperation, string[]> = {
  kitchenInterpret: [DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL],
  kitchenRank: [DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL],
  // Discovery candidates are resolved but capability-filtered out (webSearch:false).
  kitchenDiscover: [DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL],
  nutrition: [DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL],
  metadataRecovery: [DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL],
  recipeGrabber: [DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL],
  // Create for Me: candidates are resolved but filtered out (no schema-constrained
  // structured output and no recipe-generation capability).
  createRecipe: [DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL],
};

function geminiModels(operation: AiOperation): string[] {
  return GEMINI_ROLE_MODELS[operation] ?? [];
}

function openRouterModels(operation: AiOperation): string[] {
  return OPENROUTER_ROLE_MODELS[operation] ?? [];
}

function deepSeekModels(operation: AiOperation): string[] {
  return DEEPSEEK_ROLE_MODELS[operation] ?? [];
}

/** Resolves the curated model list for a provider + operation (empty for unknown provider). */
export function roleModelsForProvider(providerId: string, operation: AiOperation): string[] {
  if (providerId === "gemini") return geminiModels(operation);
  if (providerId === "openrouter") return openRouterModels(operation);
  if (providerId === "deepseek") return deepSeekModels(operation);
  return [];
}

/**
 * The SINGLE server-owned "curated text model" truth: the union of every
 * operation's curated role models for a provider, structurally deduped in stable
 * operation/model order. This is the exact source used by:
 *
 *   - the provider catalog (observability of curated models),
 *   - the connection-test allowlist (`curatedConnectionTestModels`),
 *   - user-selection validation (`validateUserTextSelection`),
 *   - server-managed pin validation (`getTextSelection` / `textCuratedModels`).
 *
 * An uncurated model is NEVER a member, so all four consumers agree by
 * construction. Unknown providers return `[]`.
 */
export function curatedTextModels(providerId: string): string[] {
  const models: string[] = [];
  for (const operation of AI_OPERATIONS) {
    for (const model of roleModelsForProvider(providerId, operation)) {
      if (!models.includes(model)) models.push(model);
    }
  }
  return models;
}