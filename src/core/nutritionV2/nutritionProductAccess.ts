/**
 * The Kitchen Codex — Advanced Nutrition AI-5A: PRODUCT ACCESS / ENTITLEMENT
 * CONTRACT.
 *
 * PURE, offline, provider-neutral, billing-vendor-neutral. This module is the ONE
 * definition of the *product* question the nutrition engine asks:
 *
 *     "Is this user ENTITLED to AI Advanced Nutrition?"
 *
 * ---------------------------------------------------------------------------
 * WHY AI-5A EXISTS — THREE INDEPENDENT QUESTIONS
 * ---------------------------------------------------------------------------
 * AI-0 established an OPERATIONAL capability boundary
 * (`nutritionCapabilities.ts`). That resolver answers question #2 — "is an allowed
 * AI provider/model/credential actually available right now?" — and it derives the
 * `basic` / `ai_advanced` split from PROVIDER CONFIGURATION AND AVAILABILITY.
 *
 * That was sufficient during engine construction. It is NOT a paid-product
 * entitlement boundary, because provider readiness says nothing about ownership:
 *
 *   Basic user + Gemini configured            -> STILL Basic.
 *                                               Provider existence does not grant
 *                                               paid product access.
 *   Basic user + a valid BYOK session key     -> STILL Basic.
 *                                               Possessing an API key does not
 *                                               grant the AI Advanced product.
 *   AI Advanced user + no configured provider -> STILL product-entitled, and the AI
 *                                               feature is operationally UNAVAILABLE.
 *   AI Advanced user + expired BYOK key       -> STILL product-entitled; that
 *                                               credential cannot execute.
 *   AI Advanced user + a valid provider       -> Entitled AND operationally ready.
 *
 * The three questions AI-5A separates:
 *
 *   1. PRODUCT ACCESS  (this module)       — does the user OWN the AI layer?
 *   2. OPERATIONAL READINESS (AI-0 module) — may an allowed provider run right now?
 *   3. NUTRITION AUTHORITY (AI-1..AI-4)    — may an AI result affect nutrition truth?
 *
 * Future effective capability is therefore
 *
 *     PRODUCT ENTITLED  AND  OPERATIONALLY READY
 *
 * never OR. Readiness may decide whether an owned feature may EXECUTE. It must
 * NEVER decide whether the feature is OWNED.
 *
 * ---------------------------------------------------------------------------
 * BYOK IS NOT ENTITLEMENT
 * ---------------------------------------------------------------------------
 * The repository already owns the historical BYOK-5 architecture (session-only
 * keys, `credentialSource`, `server_environment`, `session_only`, provider
 * selection, connection testing, Provider Settings, request-scoped credential
 * resolution). That work is NOT redone or renamed here. A BYOK credential answers
 * "whose credential may authorize this provider request?". It does NOT answer "is
 * this user entitled to AI Advanced Nutrition?". Uploading or configuring an API
 * key MUST NOT grant product access, and this module therefore carries no
 * credential concept of any kind.
 *
 * ---------------------------------------------------------------------------
 * PRODUCT ACCESS IS NOT PROOF
 * ---------------------------------------------------------------------------
 * `NutritionProductAccess` is a PRODUCT DOMAIN VALUE. It is NOT a signed
 * entitlement, an authenticated server receipt, an account token, a license
 * token, a billing receipt, a JWT, a provider credential, or authenticated
 * nutrition provenance. There is deliberately NO CRYPTOGRAPHY here.
 *
 * A client must NEVER be able to unlock a paid AI endpoint by sending
 * `{ tier: "ai_advanced" }`. A future phase (AI-5B) must define the
 * SERVER-AUTHORITATIVE source allowed to produce or use this decision, and every
 * paid AI route must eventually enforce entitlement SERVER-SIDE BEFORE any
 * provider work, so that a Basic denial costs ZERO provider calls. Nothing in
 * this module is, or may become, that gate.
 *
 * ---------------------------------------------------------------------------
 * PRODUCT ACCESS IS NOT NUTRITION AUTHORITY
 * ---------------------------------------------------------------------------
 * Even a genuine AI Advanced entitlement grants permission only to ATTEMPT an
 * allowed AI operation. It grants ZERO authority over USDA identity, matching
 * truth, FDC identity, grams, mass, portions, household conversions, nutrients,
 * calculations, Apply, persistence or provenance. Every existing AI-1 / AI-2 /
 * AI-3 / AI-4 authority restriction remains intact and is unchanged by this
 * phase.
 *
 * ---------------------------------------------------------------------------
 * AI-5A IS INERT
 * ---------------------------------------------------------------------------
 * This is a contract/foundation phase, analogous to AI-0. It is NOT wired into
 * production behaviour: not `App.tsx`, not any server route, not any provider
 * route, not `AdvancedNutritionCard`/`AdvancedNutritionModal`, not Provider
 * Settings, not AI-1 / AI-2 / AI-3 / AI-4, not Apply, not persistence. Existing
 * nutrition capability behaviour is byte-behaviourally unchanged. AI-5B owns
 * authoritative integration.
 */

/**
 * The ONE closed contract version. A change to the access shape requires a new
 * version, so an old decision can never be silently reinterpreted as a new one.
 */
export const NUTRITION_PRODUCT_ACCESS_VERSION = 'nutrition_product_access_v1';

/**
 * The CLOSED nutrition product tier. The nutrition engine knows only whether the
 * nutrition entitlement is Basic or AI Advanced.
 *
 * There are deliberately NO pricing-plan tiers here — no `monthly`, `annual`,
 * `lifetime`, `community`, `premium`, `pro` or `enterprise`. Those belong to later
 * commercial/account layers, and a pricing plan must never become a nutrition
 * entitlement input.
 */
export type NutritionProductTier = 'basic' | 'ai_advanced';

export const BASIC_NUTRITION_PRODUCT_TIER: NutritionProductTier = 'basic';
export const AI_ADVANCED_NUTRITION_PRODUCT_TIER: NutritionProductTier = 'ai_advanced';

/** The complete, frozen, ordered tier vocabulary. */
export const NUTRITION_PRODUCT_TIERS: ReadonlyArray<NutritionProductTier> = Object.freeze([
  BASIC_NUTRITION_PRODUCT_TIER,
  AI_ADVANCED_NUTRITION_PRODUCT_TIER,
]);

/**
 * The CLOSED AI product-feature vocabulary.
 *
 * Every entry names a capability that ALREADY EXISTS in the AI-1 / AI-2 / AI-3 /
 * AI-4 architecture. No entitlement may be created for functionality that does not
 * exist yet.
 *
 * There is deliberately NO `ai_recipe_context_application` feature: accepted AI-4
 * context still has ZERO downstream consumers, so it grants no authority and is
 * not an entitled product capability. Its absence is the closed-vocabulary
 * statement of the AI-4 trust boundary.
 */
export type NutritionProductAiFeature =
  /** AI-1 semantic ingredient interpretation. */
  | 'ai_interpretation'
  /** AI-2 candidate planning / orchestration over the deterministic candidate set. */
  | 'ai_candidate_orchestration'
  /** AI-3 bounded AI mass estimation (request permission only, never mass authority). */
  | 'ai_bounded_mass_estimation'
  /** AI-4 explicit recipe-context review (review only, never application authority). */
  | 'ai_recipe_context_review';

/** The complete, frozen, ordered AI product-feature vocabulary. */
export const NUTRITION_PRODUCT_AI_FEATURES: ReadonlyArray<NutritionProductAiFeature> =
  Object.freeze([
    'ai_interpretation',
    'ai_candidate_orchestration',
    'ai_bounded_mass_estimation',
    'ai_recipe_context_review',
  ]);

/**
 * The immutable product-access value.
 *
 * EXACTLY TWO canonical instances exist in the whole system: the Basic access
 * value and the AI Advanced access value. Every AI feature boolean is DERIVED from
 * the closed `tier` — there is no independent feature input, so impossible
 * product states such as `basic` + `aiInterpretation: true` cannot be expressed.
 */
export interface NutritionProductAccess {
  /** The closed contract version. Participates in the value's identity. */
  readonly version: typeof NUTRITION_PRODUCT_ACCESS_VERSION;
  /** The closed product tier this access was resolved from. */
  readonly tier: NutritionProductTier;
  readonly aiInterpretation: boolean;
  readonly aiCandidateOrchestration: boolean;
  readonly aiBoundedMassEstimation: boolean;
  readonly aiRecipeContextReview: boolean;
}

/**
 * BASIC NUTRITION: free/basic product access with ZERO AI entitlement.
 *
 * Note what is intentionally ABSENT: deterministic USDA analysis, deterministic
 * matching, manual food correction, manual total-weight entry, authenticated
 * source/count/household portions, deterministic calculation, provenance, Review
 * and Apply are all Basic products and are NOT modelled as paid capabilities. They
 * are not fields of this value, because this value describes only AI entitlement.
 * Their availability is a permanent product invariant, not an entitlement.
 */
export const BASIC_NUTRITION_PRODUCT_ACCESS: NutritionProductAccess = Object.freeze({
  version: NUTRITION_PRODUCT_ACCESS_VERSION,
  tier: BASIC_NUTRITION_PRODUCT_TIER,
  aiInterpretation: false,
  aiCandidateOrchestration: false,
  aiBoundedMassEstimation: false,
  aiRecipeContextReview: false,
});

/**
 * AI ADVANCED NUTRITION: the paid/product-entitled AI interpretation layer over
 * the deterministic foundation.
 *
 * It does NOT replace deterministic USDA authority, does NOT remove manual
 * editing, and does NOT itself grant nutrition authority.
 */
export const AI_ADVANCED_NUTRITION_PRODUCT_ACCESS: NutritionProductAccess = Object.freeze({
  version: NUTRITION_PRODUCT_ACCESS_VERSION,
  tier: AI_ADVANCED_NUTRITION_PRODUCT_TIER,
  aiInterpretation: true,
  aiCandidateOrchestration: true,
  aiBoundedMassEstimation: true,
  aiRecipeContextReview: true,
});

/**
 * Strict closed-vocabulary test for an already-known tier value.
 *
 * EXACT MATCH ONLY. It does not coerce: `true`, `1`, `'pro'`, `'AI_Advanced'`,
 * `'ai_advanced '`, `' ai_advanced'` and `new String('ai_advanced')` are all not a
 * tier.
 */
export function isNutritionProductTier(value: unknown): value is NutritionProductTier {
  return value === BASIC_NUTRITION_PRODUCT_TIER || value === AI_ADVANCED_NUTRITION_PRODUCT_TIER;
}

/**
 * FAIL-CLOSED tier resolution for arbitrary runtime input.
 *
 * ONLY the exact supported `'ai_advanced'` value resolves to AI Advanced. Missing,
 * `null`, malformed, unknown, wrong-case, aliased, object, array, number and
 * boolean input all resolve to Basic. There is no loose coercion of any kind, and
 * no caller-supplied feature list is accepted.
 */
export function resolveNutritionProductTier(value?: unknown): NutritionProductTier {
  return value === AI_ADVANCED_NUTRITION_PRODUCT_TIER
    ? AI_ADVANCED_NUTRITION_PRODUCT_TIER
    : BASIC_NUTRITION_PRODUCT_TIER;
}

/**
 * FAIL-CLOSED access resolution. The ONLY public way to obtain a product-access
 * value; it takes a tier-shaped scalar and returns one of the two canonical frozen
 * instances. Because it never accepts features, a caller cannot manufacture an
 * impossible product state through this API.
 */
export function resolveNutritionProductAccess(value?: unknown): NutritionProductAccess {
  return resolveNutritionProductTier(value) === AI_ADVANCED_NUTRITION_PRODUCT_TIER
    ? AI_ADVANCED_NUTRITION_PRODUCT_ACCESS
    : BASIC_NUTRITION_PRODUCT_ACCESS;
}

/**
 * Strict identity check for a genuine product-access value.
 *
 * This is deliberately an identity check against the two canonical frozen
 * instances, NOT a structural shape check: a hand-authored object literal that
 * mimics the fields — including an impossible `basic` + AI-feature combination —
 * is refused, so a non-canonical value can never be mistaken for a resolved
 * decision.
 */
export function isNutritionProductAccess(value: unknown): value is NutritionProductAccess {
  return (
    value === BASIC_NUTRITION_PRODUCT_ACCESS || value === AI_ADVANCED_NUTRITION_PRODUCT_ACCESS
  );
}

/** True only for the canonical AI Advanced product-access value. */
export function isAiAdvancedProductAccess(access: unknown): boolean {
  return access === AI_ADVANCED_NUTRITION_PRODUCT_ACCESS;
}

/** True only for the canonical Basic product-access value. */
export function isBasicProductAccess(access: unknown): boolean {
  return access === BASIC_NUTRITION_PRODUCT_ACCESS;
}

/**
 * True when the CURRENT AI product feature is entitled by the resolved product
 * access.
 *
 * The boolean is read from the access value's own derived field, so it is
 * determined entirely by the closed tier and can never be overridden by a caller.
 * A non-canonical access value (including a hand-authored object literal that
 * mimics the shape) and an unknown feature name both fail closed.
 *
 * This is a PRODUCT question only: it says the user OWNS the feature, not that it
 * may execute. Operational readiness is a separate, independent AND-ed condition,
 * and nutrition authority is a third, separate condition.
 */
export function isNutritionProductFeatureEntitled(
  access: unknown,
  feature: NutritionProductAiFeature
): boolean {
  if (!isNutritionProductAccess(access)) return false;
  switch (feature) {
    case 'ai_interpretation':
      return access.aiInterpretation;
    case 'ai_candidate_orchestration':
      return access.aiCandidateOrchestration;
    case 'ai_bounded_mass_estimation':
      return access.aiBoundedMassEstimation;
    case 'ai_recipe_context_review':
      return access.aiRecipeContextReview;
    default:
      // An unknown feature name can never be entitled.
      return false;
  }
}