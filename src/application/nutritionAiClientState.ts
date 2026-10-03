/**
 * The Kitchen Codex — Advanced Nutrition AI-5C: EFFECTIVE CAPABILITY COMPOSITION.
 *
 * This is the ONE client-side owner of "can Advanced Nutrition use AI right now, and
 * why not?". It composes exactly two already-trusted inputs and never invents a
 * third:
 *
 *     EFFECTIVE AVAILABILITY = PRODUCT ENTITLED  AND  OPERATIONALLY READY
 *
 * `and`, per feature, never `or`. There is no third source, no fallback, and no
 * "the provider looked busy" override. A configured provider does not grant the
 * product, and the product does not conjure a provider.
 *
 * ---------------------------------------------------------------------------
 * INPUT 1 — PRODUCT ACCESS (server-owned, read-only awareness)
 * ---------------------------------------------------------------------------
 * `NutritionProductAccessRead` from `./nutritionProductAccess`. This is a *report*
 * of what the AI-5B server gate decided, and nothing more. It authorizes nothing:
 * the browser could forge it and every AI-5B gate would still deny a Basic
 * deployment independently. The composition here exists to avoid pointless round
 * trips and to keep the user-facing message truthful — not to make a decision the
 * server has not already made.
 *
 * ---------------------------------------------------------------------------
 * INPUT 2 — OPERATIONAL READINESS (pre-existing provider architecture)
 * ---------------------------------------------------------------------------
 * `NutritionCapabilities` from `resolveNutritionAiCapabilities`, which reads the
 * read-only `/api/providers` surface. That function is deliberately UNCHANGED and
 * keeps its original responsibility. `/api/providers` is NOT reinterpreted as
 * entitlement, and provider configuration never grants product access.
 *
 * `src/core/nutritionV2/nutritionCapabilities.ts` is NOT redesigned by AI-5C. It
 * stays the pure OPERATIONAL readiness model; composition happens here, in the
 * application layer, which is the only layer that legitimately sees both questions.
 *
 * ---------------------------------------------------------------------------
 * PERMANENT PRODUCT INVARIANT: BASIC NUTRITION IS NEVER REDUCED
 * ---------------------------------------------------------------------------
 * Deterministic USDA analysis, deterministic matching, manual food correction,
 * manual total weight, source/count/household portions, deterministic calculation,
 * provenance, Review, Apply, and viewing/editing an already-saved Advanced result
 * are Basic products and are UNAFFECTED by anything below. `deterministicReview` and
 * `manualEditing` are carried through as literal `true` in every state, exactly as
 * `nutritionCapabilities.ts` defines them. Only the AI ASSISTANCE layer is
 * product-gated. AI-5C never disables the deterministic/manual surface.
 *
 * ---------------------------------------------------------------------------
 * WHY `unknown` IS ITS OWN STATE
 * ---------------------------------------------------------------------------
 * Three outcomes must be distinguishable to the user, and only two of them are
 * product facts:
 *
 *   - `basic`    — the server DEFINITIVELY said Basic. Truthful to say AI Advanced
 *                  is not enabled for this deployment.
 *   - `unready`  — the server said AI Advanced, and no provider is usable. Truthful
 *                  to say the feature IS enabled but no provider is available. Must
 *                  NOT imply the user lacks entitlement.
 *   - `unknown`  — the client could not verify product access at all (transport,
 *                  auth, malformed body, unsupported version). Truthful to say access
 *                  could NOT BE VERIFIED. Must NOT claim Basic, must NOT blame
 *                  billing, and must NOT blame the provider — the client knows none of
 *                  those things.
 *
 * All three fail SAFE to no AI availability. They differ ONLY in the bounded
 * user-facing reason.
 */

import {
  BASIC_NUTRITION_CAPABILITIES,
  isAiEstimationAvailable,
  isAiInterpretationAvailable,
  type NutritionCapabilities,
} from '../core/nutritionV2/nutritionCapabilities';
import {
  isAiAdvancedProductAccess,
  type NutritionProductAccess,
} from '../core/nutritionV2/nutritionProductAccess';
import type { NetworkAdapter } from './adapters/NetworkAdapter';
import { resolveNutritionAiCapabilities } from './nutritionAiResolve';
import {
  isResolvedNutritionProductAccess,
  readNutritionProductAccess,
  type NutritionProductAccessRead,
} from './nutritionProductAccess';

/**
 * WHY the AI assistance layer is unavailable, as a closed vocabulary.
 *
 * `available` is the only value that permits an AI action. Every other value means
 * the AI controls must not execute.
 */
export type NutritionAiAvailabilityReason =
  /** Product entitled AND operationally ready. */
  | 'available'
  /** The server definitively reported Basic product access for this deployment. */
  | 'product_not_enabled'
  /** Product entitled, but no compatible/reachable provider-model-credential. */
  | 'provider_unavailable'
  /** Product access could not be verified. Deliberately NOT reported as Basic. */
  | 'product_access_unverified';

/** True only when AI assistance may be offered at all. */
export function isNutritionAiAvailable(reason: NutritionAiAvailabilityReason): boolean {
  return reason === 'available';
}

/**
 * The per-feature EFFECTIVE availability.
 *
 * Every field is an AND of one product-access bit and one operational-readiness
 * bit. There is no OR path, and no feature can be turned on by the product alone.
 */
export interface NutritionAiEffectiveCapabilities {
  readonly aiInterpretation: boolean;
  readonly aiCandidateOrchestration: boolean;
  readonly aiBoundedMassEstimation: boolean;
  readonly aiRecipeContextReview: boolean;
}

/**
 * The ONE composed client state.
 *
 * `productAccess` is `null` when the tier is unknown — the UI must not be handed a
 * Basic value it did not receive.
 */
export interface NutritionAiClientState {
  /** The raw read, preserved so the UI can distinguish unknown from Basic. */
  readonly productAccessStatus: NutritionProductAccessRead;
  /** Canonical AI-5A access, or `null` when unverifiable. */
  readonly productAccess: NutritionProductAccess | null;
  /** The operational readiness set actually consulted (`null` when not queried). */
  readonly operationalCapabilities: NutritionCapabilities | null;
  /** AND of both questions, per feature. */
  readonly effectiveCapabilities: NutritionAiEffectiveCapabilities;
  /** The single bounded reason the AI layer is or is not usable. */
  readonly availability: NutritionAiAvailabilityReason;
  /** Convenience: the bounded reason for the AI assistance layer overall. */
  readonly available: boolean;
  /** AI-4 review specifically (the modal's recipe-context surface). */
  readonly recipeContextReviewAvailable: boolean;
  /** True only when the server definitively stated Basic. */
  readonly productAccessIsBasic: boolean;
  /** True only when the server definitively stated AI Advanced. */
  readonly productAccessIsAiAdvanced: boolean;
}

/** No AI availability under any circumstance. */
const UNAVAILABLE_EFFECTIVE: NutritionAiEffectiveCapabilities = Object.freeze({
  aiInterpretation: false,
  aiCandidateOrchestration: false,
  aiBoundedMassEstimation: false,
  aiRecipeContextReview: false,
});

/** AI-4 review needs compatible TEXT-AI readiness, the same signal AI-1 requires. */
function operationalTextAiReady(capabilities: NutritionCapabilities): boolean {
  return isAiInterpretationAvailable(capabilities);
}

/**
 * Composes effective availability for a KNOWN product tier.
 *
 * Split out so the AND logic exists exactly once and cannot drift between the
 * resolved-Basic and resolved-AI-Advanced branches.
 */
function composeEffective(
  access: NutritionProductAccess,
  operational: NutritionCapabilities
): NutritionAiEffectiveCapabilities {
  return Object.freeze({
    aiInterpretation: access.aiInterpretation && operationalTextAiReady(operational),
    aiCandidateOrchestration:
      access.aiCandidateOrchestration && isAiInterpretationAvailable(operational),
    // The operational side of bounded mass estimation is the AI-3 availability
    // signal, NOT the generic interpretation flag.
    aiBoundedMassEstimation:
      access.aiBoundedMassEstimation && isAiEstimationAvailable(operational),
    // AI-4 review requires compatible TEXT-AI readiness, which is the same
    // operational signal AI-1 uses; the product side is its own bit.
    aiRecipeContextReview:
      access.aiRecipeContextReview && operationalTextAiReady(operational),
  });
}

/**
 * Builds the composed state from a product read and the operational readiness set.
 *
 * `operational` may be `null`, which is the LAZY case: when the server has already
 * stated Basic there is no reason to ask about providers at all, so the caller may
 * pass `null` and skip that request entirely. A missing operational set composes to
 * no AI availability — it never reads as "ready".
 *
 * This function is pure: same inputs, same state, no network, no storage.
 */
export function composeNutritionAiClientState(input: {
  readonly productAccess: NutritionProductAccessRead;
  readonly operational: NutritionCapabilities | null;
}): NutritionAiClientState {
  const { productAccess: read, operational } = input;

  // UNKNOWN: the client could not verify product access. Fail safe to no AI, and
  // do not consult or imply operational readiness — an unknown product decision is
  // not evidence about providers.
  if (!isResolvedNutritionProductAccess(read)) {
    return Object.freeze({
      productAccessStatus: read,
      productAccess: null,
      operationalCapabilities: operational,
      effectiveCapabilities: UNAVAILABLE_EFFECTIVE,
      availability: 'product_access_unverified',
      available: false,
      recipeContextReviewAvailable: false,
      productAccessIsBasic: false,
      productAccessIsAiAdvanced: false,
    });
  }

  const access = read.access;

  // KNOWN BASIC: the server definitively said Basic. A perfectly working provider
  // still does not grant AI Advanced, so the AND fails regardless of readiness.
  if (!isAiAdvancedProductAccess(access)) {
    return Object.freeze({
      productAccessStatus: read,
      productAccess: access,
      operationalCapabilities: operational,
      effectiveCapabilities: UNAVAILABLE_EFFECTIVE,
      availability: 'product_not_enabled',
      available: false,
      recipeContextReviewAvailable: false,
      productAccessIsBasic: true,
      productAccessIsAiAdvanced: false,
    });
  }

  // KNOWN AI ADVANCED: entitlement passed, so operational readiness decides.
  // Absent readiness composes to no AI rather than to an optimistic assumption.
  if (operational === null) {
    return Object.freeze({
      productAccessStatus: read,
      productAccess: access,
      operationalCapabilities: null,
      effectiveCapabilities: UNAVAILABLE_EFFECTIVE,
      availability: 'provider_unavailable',
      available: false,
      recipeContextReviewAvailable: false,
      productAccessIsBasic: false,
      productAccessIsAiAdvanced: true,
    });
  }

  const effective = composeEffective(access, operational);
  // The overall reason is DERIVED FROM THE COMPOSED RESULT, never from the mere fact
  // that a readiness read happened. Reading readiness is not readiness: a configured
  // but unreachable provider composes to no AI, and that must be reported as
  // `provider_unavailable` rather than as `available`.
  //
  // AI-1 interpretation is the primary AI-assistance signal for the AI panel, so it
  // decides the overall reason; the per-feature bits below remain individually
  // truthful for the narrower surfaces.
  const available = effective.aiInterpretation;
  return Object.freeze({
    productAccessStatus: read,
    productAccess: access,
    operationalCapabilities: operational,
    effectiveCapabilities: effective,
    availability: available ? 'available' : 'provider_unavailable',
    available,
    recipeContextReviewAvailable: effective.aiRecipeContextReview,
    productAccessIsBasic: false,
    productAccessIsAiAdvanced: true,
  });
}

/**
 * The bounded, user-facing explanation for a non-available AI layer.
 *
 * Each message states ONLY what the client actually knows, and every one of them
 * preserves the Basic Nutrition fallback.
 *
 * There is deliberately NO billing, subscription, upgrade, paywall, trial,
 * purchase, premium or Pro language anywhere in this file: no billing or account
 * system exists, and product-access state must never be presented as something the
 * user could buy.
 */
export function nutritionAiUnavailableMessage(
  reason: NutritionAiAvailabilityReason
): string | null {
  switch (reason) {
    case 'available':
      return null;
    case 'product_not_enabled':
      return "AI Advanced Nutrition isn't enabled for this deployment. Basic manual review and correction are still available.";
    case 'provider_unavailable':
      return 'AI Advanced Nutrition is enabled, but no compatible AI provider is currently available. Basic manual review and correction are still available.';
    case 'product_access_unverified':
      return "AI Advanced Nutrition access couldn't be verified. Basic manual review and correction are still available.";
    default:
      // Unreachable for a closed vocabulary; fail safe rather than invent a claim.
      return "AI Advanced Nutrition access couldn't be verified. Basic manual review and correction are still available.";
  }
}

/**
 * The state used before anything has been read, and after any read failure.
 *
 * Deliberately `unknown`, not Basic: the client has not asked yet, so it must not
 * claim a product fact. Composes to no AI availability.
 */
export function unresolvedNutritionAiClientState(): NutritionAiClientState {
  return composeNutritionAiClientState({
    productAccess: { status: 'unavailable' },
    operational: null,
  });
}

/** Re-exported so the composition owner has a single import for the Basic fallback. */
export { BASIC_NUTRITION_CAPABILITIES };

/**
 * The LAZY composition entry point: reads product access, and only then decides
 * whether operational readiness is worth asking for.
 *
 * The short-circuit is the load-bearing part. Once the server has DEFINITIVELY said
 * Basic for this deployment, no provider configuration can make AI Advanced
 * available, so the provider-status request is skipped entirely — a Basic deployment
 * spends exactly one request instead of two. Conversely, an unverifiable product read
 * stops here too: the client will not turn "I could not check" into provider
 * readiness by asking a second question it cannot answer.
 *
 * Neither request happens implicitly. This function is called only when the user
 * actually enters the Advanced Nutrition experience, so an ordinary page load that
 * never opens it performs NO product-access request at all.
 *
 * Never throws: both reads fail safe, and the composed state is always returnable.
 */
export async function resolveNutritionAiClientState(
  network: NetworkAdapter,
  requestOperationalCapabilities: (
    network: NetworkAdapter
  ) => Promise<NutritionCapabilities> = resolveNutritionAiCapabilities
): Promise<NutritionAiClientState> {
  const productAccess = await readNutritionProductAccess(network);

  // Definitive Basic: no provider query. Unknown: no provider query either.
  const advanced =
    isResolvedNutritionProductAccess(productAccess) &&
    isAiAdvancedProductAccess(productAccess.access);
  if (!advanced) {
    return composeNutritionAiClientState({ productAccess, operational: null });
  }

  return composeNutritionAiClientState({
    productAccess,
    operational: await requestOperationalCapabilities(network),
  });
}