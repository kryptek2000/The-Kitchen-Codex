/**
 * The Kitchen Codex — Nutrition capability / tier boundary (AI-0).
 *
 * PURE, offline, billing-independent. This is the ONE centralized place that
 * distinguishes Basic Nutrition from AI Advanced Nutrition. Components must ask
 * this module instead of scattering ad-hoc AI checks.
 *
 * PERMANENT PRODUCT INVARIANTS
 * ----------------------------
 *  - Basic Nutrition is always available: deterministic analysis, manual
 *    food-match correction, manual total weight, verified source/count/
 *    household portions, deterministic math, provenance, Review, and Apply.
 *  - `manualEditing` is ALWAYS true, for every tier and every AI availability
 *    state. AI Advanced Nutrition must never remove or hide manual correction.
 *  - Tier/capability is independent of billing. There is no pricing, checkout,
 *    subscription, account entitlement, or payment logic here.
 *  - `aiEstimation` is `'disabled'` in AI-0 and always `'future'`-gated; no
 *    capability state enables production AI mass estimation.
 */

export type NutritionExperienceTier = 'basic' | 'ai_advanced';

export const BASIC_NUTRITION_LABEL = 'Basic Nutrition';
export const AI_ADVANCED_NUTRITION_LABEL = 'AI Advanced Nutrition';

/**
 * Availability of future AI mass estimation. AI-0 defines the class but never
 * enables it; `'future'` means the capability may exist only behind a later,
 * explicitly reviewed activation.
 */
export type AiEstimationAvailability = 'disabled' | 'future';

export interface NutritionCapabilities {
  readonly tier: NutritionExperienceTier;
  /** Deterministic analysis + review is always available. */
  readonly deterministicReview: true;
  /** Manual deterministic editing is always available, regardless of AI. */
  readonly manualEditing: true;
  readonly aiInterpretation: boolean;
  readonly aiCandidateOrchestration: boolean;
  readonly aiEstimation: AiEstimationAvailability;
}

/** Basic Nutrition: everything deterministic, no AI capability at all. */
export const BASIC_NUTRITION_CAPABILITIES: NutritionCapabilities = Object.freeze({
  tier: 'basic' as const,
  deterministicReview: true as const,
  manualEditing: true as const,
  aiInterpretation: false,
  aiCandidateOrchestration: false,
  aiEstimation: 'disabled' as const,
});

export interface NutritionCapabilityInput {
  /** True only when an AI text provider is configured for this surface. */
  readonly aiConfigured?: boolean;
  /** True only when the configured provider is currently reachable. */
  readonly aiReachable?: boolean;
}

/**
 * Resolves the capability set for a surface. Fails safe: anything other than an
 * explicitly configured AND reachable AI provider yields Basic Nutrition.
 * AI estimation is never enabled in AI-0.
 */
export function resolveNutritionCapabilities(
  input: NutritionCapabilityInput = {}
): NutritionCapabilities {
  const aiAvailable = input.aiConfigured === true && input.aiReachable === true;
  if (!aiAvailable) return BASIC_NUTRITION_CAPABILITIES;
  return Object.freeze({
    tier: 'ai_advanced' as const,
    deterministicReview: true as const,
    manualEditing: true as const,
    aiInterpretation: true,
    aiCandidateOrchestration: true,
    aiEstimation: 'disabled' as const,
  });
}

/** Manual deterministic editing is a permanent invariant, in every tier. */
export function isManualEditingAvailable(capabilities: NutritionCapabilities): boolean {
  return capabilities.manualEditing === true;
}

/** True only when the AI interpretation path may be attempted at all. */
export function isAiInterpretationAvailable(capabilities: NutritionCapabilities): boolean {
  return capabilities.tier === 'ai_advanced' && capabilities.aiInterpretation === true;
}
