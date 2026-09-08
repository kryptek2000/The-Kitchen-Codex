/**
 * The Kitchen Codex — role-based AI candidate resolution (v0.7 Phase 1B).
 *
 * The single place that maps an AI operation to its ordered (provider, model)
 * candidates across every configured provider, so consumers no longer manually
 * pair providers to modelConfig roles. Capability filtering stays in the
 * selector (`selectCandidates`/`runWithAiFallback`); this helper only resolves
 * the ordered candidate list.
 *
 * OWNERSHIP:
 *   - `server/modelConfig.ts` remains authoritative for GEMINI role models.
 *   - This module layers per-provider OFFSET role models (e.g. OpenRouter) over
 *     the same operation shape, without duplicating consumer-side logic.
 *
 * Deterministic: provider order = registry order; model order = role-model order.
 * Server-side only. No platform enum. No UI config. No raw secrets.
 */

import type { AiOperation } from "./operations.js";
import { MODEL_CONFIG } from "../modelConfig.js";
import {
  getRegisteredProviders,
  type AiCandidate,
  type RegisteredProvider,
} from "./providerRegistry.js";
import { OPENROUTER_STRUCTURED_MODEL } from "./openRouterProvider.js";

/** Gemini role models per operation (unchanged v0.6 behavior). */
const GEMINI_ROLE_MODELS: Record<AiOperation, string[]> = {
  kitchenInterpret: [MODEL_CONFIG.kitchenPrimary, MODEL_CONFIG.kitchenFallback],
  kitchenRank: [MODEL_CONFIG.kitchenPrimary, MODEL_CONFIG.kitchenFallback],
  kitchenDiscover: [MODEL_CONFIG.kitchenDiscoveryPrimary, MODEL_CONFIG.kitchenDiscoveryFallback],
  nutrition: [MODEL_CONFIG.nutritionPrimary, MODEL_CONFIG.nutritionFallback],
  metadataRecovery: [MODEL_CONFIG.metadataRecoveryPrimary, MODEL_CONFIG.metadataRecoveryFallback],
  recipeGrabber: [MODEL_CONFIG.recipeGrabberPrimary, MODEL_CONFIG.recipeGrabberFallback, MODEL_CONFIG.recipeGrabberAlias],
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
};

function geminiModels(operation: AiOperation): string[] {
  return GEMINI_ROLE_MODELS[operation] ?? [];
}

function openRouterModels(operation: AiOperation): string[] {
  return OPENROUTER_ROLE_MODELS[operation] ?? [];
}

/** Resolves the model list for a provider + operation (empty for unknown provider). */
export function roleModelsForProvider(providerId: string, operation: AiOperation): string[] {
  if (providerId === "gemini") return geminiModels(operation);
  if (providerId === "openrouter") return openRouterModels(operation);
  return [];
}

/**
 * Resolves ordered (provider, model) candidates for an operation across all
 * enabled providers. Capability/availability filtering is the selector's job.
 */
export function resolveRoleCandidates(
  operation: AiOperation,
  regs: RegisteredProvider[] = getRegisteredProviders()
): AiCandidate[] {
  const out: AiCandidate[] = [];
  for (const registered of regs) {
    if (registered.enabled === false) continue;
    const models = roleModelsForProvider(registered.provider.id, operation);
    for (const model of models) {
      out.push({ provider: registered.provider, model });
    }
  }
  return out;
}
