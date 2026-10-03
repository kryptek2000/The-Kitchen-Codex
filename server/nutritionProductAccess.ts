/**
 * The Kitchen Codex — Advanced Nutrition AI-5B: SERVER-AUTHORITATIVE ENTITLEMENT
 * BOUNDARY.
 *
 * AI-5A defined the PURE product-access contract
 * (`src/core/nutritionV2/nutritionProductAccess.ts`): the ONE vocabulary for "does this
 * user/deployment OWN the AI Advanced Nutrition layer?". AI-5A was deliberately inert —
 * it was imported by no production module and enforced by no route.
 *
 * This module is the first REAL enforcement boundary, and it owns exactly one thing:
 * asking the server-owned AI-5E product-access AUTHORITY for the canonical AI-5A
 * access value, and refusing a paid AI route when the resulting product decision
 * does not entitle the requested feature.
 *
 * ---------------------------------------------------------------------------
 * THE THREE QUESTIONS STAY SEPARATE
 * ---------------------------------------------------------------------------
 *   1. PRODUCT ACCESS      — "may this AI Advanced Nutrition feature be ATTEMPTED?"
 *                            THIS module (over the unchanged AI-5A contract).
 *   2. OPERATIONAL READINESS— "can the selected provider/model/credential execute?"
 *                            `nutritionCapabilities.ts` / provider selection / BYOK /
 *                            credential resolution. Unchanged, never consulted here.
 *   3. NUTRITION AUTHORITY  — "may the result affect food identity, FDC identity, grams,
 *                            nutrients, Apply, persistence?" AI-1 / AI-2 / AI-3 / AI-4.
 *                            Unchanged, never consulted here.
 *
 * The fundamental execution rule is therefore
 *
 *     PRODUCT ENTITLED  AND  OPERATIONALLY READY
 *
 * never OR. A Basic deployment with a perfectly working provider is still Basic, and the
 * denial must cost ZERO provider calls.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT KNOW
 * ---------------------------------------------------------------------------
 * It knows nothing about the provider registry, credential sources, session keys,
 * pricing catalogs, rate-limit buckets, billing, accounts, customer records, the USDA,
 * nutrition calculation, Apply, persistence, or AI-4 reconciliation internals. It emits
 * exactly ONE bounded denial class. It never inspects the request.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SOURCE IS AN AUTHORITY, AND WHY IT IS STILL DEPLOYMENT-SCOPED
 * ---------------------------------------------------------------------------
 * The current Kitchen Codex server has NO authenticated multi-user account identity, so
 * a truthful per-user entitlement cannot exist yet. The source in use today is
 * therefore a SERVER-OWNED, DEPLOYMENT-SCOPED, SINGLE-USER product-access authority
 * built from the non-secret environment variable `KITCHEN_CODEX_NUTRITION_PRODUCT_TIER`
 * (`server/nutritionProductAccessAuthority.ts`). AI-5E moved the seam from a raw
 * injected value to that authority object, so the day authenticated per-user
 * entitlement exists, the six gates and the status route below do not change.
 *
 * This is NOT presented as per-user hosted entitlement. Identity is NOT inferred from an
 * IP address, from `AI_ENDPOINT_TOKEN`, from browser state, from Provider Settings, from
 * an API key, from a vault, from headers, from cookies or from localStorage. A shared
 * environment tier is NOT per-user authorization, and a shared `AI_ENDPOINT_TOKEN` is
 * NOT an entitlement identity. Before hosted multi-user AI Advanced Nutrition can ship,
 * this source MUST be replaced by authenticated per-user/account entitlement whose only
 * identity comes from trusted server authentication middleware. That gate is mandatory,
 * not optional; see docs/Advanced-Nutrition-Architecture.md §56 and §59.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED
 * ---------------------------------------------------------------------------
 * Only the exact string `ai_advanced` grants AI Advanced. Missing, empty, malformed,
 * unknown, wrong-case, whitespace-padded, aliased, boolean, numeric, object and
 * feature-shaped input all resolve to BASIC. There is no trimming, no case folding, no
 * alias table and no coercion of `pro`/`premium`/`paid`/`free`/`subscription`/`true`/`1`.
 * Parsing is delegated to the AI-5A resolver rather than reimplemented, so the deployment
 * authority and the product contract can never disagree.
 *
 * An authority that cannot be consulted, throws, rejects, or returns a non-canonical
 * access value is a DIFFERENT truth from Basic and is reported as
 * `NUTRITION_PRODUCT_ACCESS_UNAVAILABLE` (HTTP 503), never as a fabricated Basic.
 *
 * ---------------------------------------------------------------------------
 * CLIENT INPUT HAS ZERO AUTHORITY
 * ---------------------------------------------------------------------------
 * The gate reads only the authority decision. No request field, header, cookie or
 * query value can reach it, so `{ tier: "ai_advanced" }`, `{ productTier: "ai_advanced" }`,
 * `{ entitled: true }`, `x-kitchen-nutrition-tier`, `x-product-tier` and `x-entitlement`
 * have no effect — they are never parsed. There is likewise NO request field that can
 * SELECT an authority implementation, its source, a raw tier, or a product access
 * value: the authority is chosen by server composition only.
 */

import type { RequestHandler } from "express";

import {
  isNutritionProductFeatureEntitled,
  NUTRITION_PRODUCT_ACCESS_VERSION,
  type NutritionProductAiFeature,
  type NutritionProductAccess,
} from "../src/core/nutritionV2/nutritionProductAccess.js";
import {
  invokeNutritionProductAccessAuthority,
  NUTRITION_PRODUCT_TIER_ENV,
  type NutritionProductAccessAuthority,
  type NutritionProductAccessAuthorityDecision,
} from "./nutritionProductAccessAuthority.js";

export { NUTRITION_PRODUCT_TIER_ENV };

/** The single bounded machine code for every non-entitled AI Advanced attempt. */
export const NUTRITION_AI_NOT_ENTITLED_CODE = "NUTRITION_AI_NOT_ENTITLED";

/**
 * AI-5C: the read-only product-access STATUS route.
 *
 * AI-5B deliberately shipped no such endpoint, because a client that could not see
 * product access could at least never mistake "Basic" for "provider problem". AI-5C
 * closes that gap so the UI can tell three genuinely different states apart — Basic,
 * AI Advanced with no usable provider, and unverifiable. This constant is the ONE
 * spelling of that route path.
 *
 * The route is INFORMATIONAL ONLY. It authorizes nothing, mints no receipt, and is
 * never consulted by any AI-5B gate: the six authoritative gates and this endpoint
 * each resolve the SAME server-owned authority exactly once per request, and only the
 * gates refuse work.
 */
export const NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT = "/api/nutrition/product-access";

/**
 * The EXACT key set of the status response. Three keys, no more.
 *
 * Feature booleans are deliberately absent: the client derives them from the
 * unchanged AI-5A closed contract, so duplicating them here would create a second
 * place where entitlement could disagree with the product contract.
 */
export const NUTRITION_PRODUCT_ACCESS_STATUS_KEYS = Object.freeze([
  "ok",
  "version",
  "tier",
] as const);

/**
 * The minimal read-only status body.
 *
 * It carries the closed contract version and the closed tier and NOTHING else: no
 * feature payload, no provider, model, credential, BYOK state, pricing, plan,
 * billing, subscription, account/user identity, customer id, secret, or raw
 * environment value.
 */
export interface NutritionProductAccessStatusBody {
  readonly ok: true;
  readonly version: string;
  readonly tier: string;
}

/**
 * Builds the status body from the SAME canonical access value the AI-5B gates are
 * resolving through the SAME authority.
 *
 * `aiAttempted` is not present and nothing here performs work: no provider
 * selection, no credential resolution, no BYOK lookup, no model lookup, no network
 * probe, and no AI route rate-limit bucket is consumed. It projects a canonical
 * access value into three fields.
 *
 * The `tier` is copied from the canonical access value rather than re-derived from any
 * configuration input, so this endpoint can never report a different tier than the gate
 * enforcing on the same application instance. It also never names the authority's
 * source, implementation, environment variable, account source or future billing
 * provider.
 */
export function buildNutritionProductAccessStatus(
  access: NutritionProductAccess,
): NutritionProductAccessStatusBody {
  return {
    ok: true,
    version: access.version,
    tier: access.tier,
  };
}

/** The single bounded denial message. Never parameterized by anything. */
export const NUTRITION_AI_NOT_ENTITLED_ERROR =
  "AI Advanced Nutrition is not available for this product access.";

/**
 * The bounded denial body — ONE shape for ONE denial class.
 *
 * It deliberately carries NO pricing, plan name, subscription state, billing data,
 * configured tier, account identity, API-key information, provider information, raw
 * configuration or environment value. `aiAttempted` is a hard `false` because this gate
 * runs BEFORE pricing resolution, provider selection, credential resolution, the BYOK
 * lease and model execution: no AI work was attempted and none can have been.
 */
export interface NutritionAiNotEntitledBody {
  readonly ok: false;
  readonly code: typeof NUTRITION_AI_NOT_ENTITLED_CODE;
  readonly error: typeof NUTRITION_AI_NOT_ENTITLED_ERROR;
  readonly aiAttempted: false;
}

/** Builds the bounded denial body. Exported so the wire contract is directly pinnable. */
export function buildNutritionAiNotEntitledBody(): NutritionAiNotEntitledBody {
  return {
    ok: false,
    code: NUTRITION_AI_NOT_ENTITLED_CODE,
    error: NUTRITION_AI_NOT_ENTITLED_ERROR,
    aiAttempted: false,
  };
}

/**
 * AI-5E: the ONE bounded machine class for "product access could not be verified".
 *
 * This is a genuinely different truth from `NUTRITION_AI_NOT_ENTITLED`: the server did
 * not determine that the caller is Basic, it failed to establish an answer at all.
 * Collapsing the two would force the UI to blame the product for an authority fault,
 * which is exactly the confusion AI-5C's `unavailable` state exists to prevent.
 *
 * It carries no raw exception, no authority implementation or source detail, no
 * account, plan, pricing or billing data, no provider or model, no credential, no
 * secret, and no environment value.
 */
export const NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE = "NUTRITION_PRODUCT_ACCESS_UNAVAILABLE";

/** The single bounded unavailability message. Never parameterized by anything. */
export const NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_ERROR =
  "AI Advanced Nutrition access could not be verified.";

/**
 * The bounded gated-route unavailability body (HTTP 503).
 *
 * `aiAttempted` is a hard `false`: the gate runs before pricing, rate limiting,
 * provider selection, credential resolution, the BYOK lease and model execution, so
 * no AI work was attempted and none can have been.
 */
export interface NutritionProductAccessUnavailableBody {
  readonly ok: false;
  readonly code: typeof NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE;
  readonly error: typeof NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_ERROR;
  readonly aiAttempted: false;
}

/** Builds the bounded gated-route unavailability body. */
export function buildNutritionProductAccessUnavailableBody(): NutritionProductAccessUnavailableBody {
  return {
    ok: false,
    code: NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE,
    error: NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_ERROR,
    aiAttempted: false,
  };
}

/**
 * The bounded STATUS-route unavailability body (HTTP 503).
 *
 * It deliberately carries NO `tier` and NO `version`, so the unchanged AI-5C client
 * reader rejects it on both counts and composes to `product_access_unverified` — not
 * to `product_not_enabled`. Reporting a tier here would be a fabricated product fact.
 *
 * `aiAttempted` is absent, exactly as it is on the successful status body: this route
 * performs no AI work.
 */
export interface NutritionProductAccessUnavailableStatusBody {
  readonly ok: false;
  readonly code: typeof NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE;
  readonly error: typeof NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_ERROR;
}

/** Builds the bounded STATUS-route unavailability body. */
export function buildNutritionProductAccessUnavailableStatusBody(): NutritionProductAccessUnavailableStatusBody {
  return {
    ok: false,
    code: NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE,
    error: NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_ERROR,
  };
}

/**
 * Resolves the server-owned authority for ONE request.
 *
 * This is the only product-access read on any route. It delegates to the single
 * AI-5E invocation boundary, which runtime-validates whatever the authority returned,
 * so a broken or hostile authority degrades to `unavailable` and never to a
 * fabricated Basic or an unearned Advanced.
 *
 * `authority` is typed `unknown` deliberately: the runtime validation must be reachable
 * with an adversarial injected value (absent, non-object, `resolve`-less, throwing,
 * rejecting, returning garbage) rather than only with a well-formed implementation.
 */
export async function resolveNutritionProductAccessDecision(
  authority: unknown,
  request: Parameters<NutritionProductAccessAuthority["resolve"]>[0],
): Promise<NutritionProductAccessAuthorityDecision> {
  return invokeNutritionProductAccessAuthority(authority, request);
}

/**
 * The closed feature gate for one AI Advanced Nutrition route.
 *
 * Registration order on a paid AI route is:
 *
 *     requireAiAccessToken
 *       -> requireNutritionProductFeature(authority, feature)  // AI-5B + AI-5E
 *         -> textPricingGuard
 *           -> route rate limiter
 *             -> route handler
 *
 * Endpoint authentication therefore stays FIRST: an unauthenticated caller learns
 * nothing about product-access state by probing a route, and the authority is never
 * invoked at all for an unauthenticated request. Product access then precedes pricing
 * resolution, provider selection, credential resolution and the rate-limit bucket, so a
 * Basic denial — or an unavailable authority — costs ZERO provider calls and does not
 * consume the paid route's rate-limit budget.
 *
 * The gate resolves the authority EXACTLY ONCE per request and never asks again in the
 * handler, so there is no duplicate entitlement lookup per request. The feature is
 * supplied by the server at registration time and never by the request. Entitlement is
 * read through AI-5A's `isNutritionProductFeatureEntitled`, which performs a
 * canonical-identity check on the access value and fails closed for a non-canonical or
 * hand-authored object — so neither a client nor a broken authority can mint an access
 * value this gate accepts.
 *
 * It reads NO request field. The request is only forwarded to the authority, which is
 * how a future authenticated-principal authority will work; today the deployment
 * authority ignores it entirely.
 */
export function requireNutritionProductFeature(
  authority: NutritionProductAccessAuthority,
  feature: NutritionProductAiFeature
): RequestHandler {
  return async (request, response, next) => {
    const decision = await invokeNutritionProductAccessAuthority(authority, request);
    if (decision.status === "unavailable") {
      // FAIL CLOSED, truthfully: access could NOT be verified. This is deliberately
      // NOT a 403 "not entitled" — claiming the caller is Basic would invent a product
      // fact the server never established — and it happens BEFORE pricing, rate
      // limiting, provider selection, credential resolution and model execution.
      response.status(503).json(buildNutritionProductAccessUnavailableBody());
      return;
    }
    if (isNutritionProductFeatureEntitled(decision.access, feature)) {
      next();
      return;
    }
    response.status(403).json(buildNutritionAiNotEntitledBody());
  };
}

/**
 * The AI-5A contract version the server boundary is bound to. Re-exported so an
 * audit can confirm the enforcement layer and the product contract are the same
 * closed version without importing the core module directly.
 */
export const NUTRITION_PRODUCT_ACCESS_BOUND_VERSION = NUTRITION_PRODUCT_ACCESS_VERSION;