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
 * turning a SERVER-OWNED deployment configuration value into that canonical AI-5A
 * access value ONCE per application instance, and refusing a paid AI route when the
 * resulting product decision does not entitle the requested feature.
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
 * WHY THE SOURCE IS DEPLOYMENT-SCOPED, NOT PER-USER
 * ---------------------------------------------------------------------------
 * The current Kitchen Codex server has NO authenticated multi-user account identity, so
 * a truthful per-user entitlement cannot exist yet. This phase therefore uses a
 * SERVER-OWNED, DEPLOYMENT-SCOPED, SINGLE-USER product-access source: the non-secret
 * environment variable `KITCHEN_CODEX_NUTRITION_PRODUCT_TIER`.
 *
 * This is NOT presented as per-user hosted entitlement. Identity is NOT inferred from an
 * IP address, from `AI_ENDPOINT_TOKEN`, from browser state, from Provider Settings, from
 * an API key, from a vault, from headers, from cookies or from localStorage. A shared
 * environment tier is NOT per-user authorization, and a shared `AI_ENDPOINT_TOKEN` is
 * NOT an entitlement identity. Before hosted multi-user AI Advanced Nutrition can ship,
 * this source MUST be replaced by authenticated per-user/account entitlement. That gate
 * is mandatory, not optional; see docs/Advanced-Nutrition-Architecture.md §56.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED
 * ---------------------------------------------------------------------------
 * Only the exact string `ai_advanced` grants AI Advanced. Missing, empty, malformed,
 * unknown, wrong-case, whitespace-padded, aliased, boolean, numeric, object and
 * feature-shaped input all resolve to BASIC. There is no trimming, no case folding, no
 * alias table and no coercion of `pro`/`premium`/`paid`/`free`/`subscription`/`true`/`1`.
 * Parsing is delegated to the AI-5A resolver rather than reimplemented, so this server
 * boundary and the product contract can never disagree.
 *
 * ---------------------------------------------------------------------------
 * CLIENT INPUT HAS ZERO AUTHORITY
 * ---------------------------------------------------------------------------
 * The gate reads only the closure-captured server-owned access value. No request field,
 * header, cookie or query value can reach it, so `{ tier: "ai_advanced" }`,
 * `{ productTier: "ai_advanced" }`, `{ entitled: true }`, `x-kitchen-nutrition-tier`,
 * `x-product-tier` and `x-entitlement` have no effect — they are never parsed.
 */

import type { RequestHandler } from "express";

import {
  resolveNutritionProductAccess,
  isNutritionProductFeatureEntitled,
  NUTRITION_PRODUCT_ACCESS_VERSION,
  type NutritionProductAiFeature,
  type NutritionProductAccess,
} from "../src/core/nutritionV2/nutritionProductAccess.js";

/**
 * The ONE non-secret, server-owned, deployment-scoped product-access input.
 *
 * Allowed exact values are exactly the AI-5A tier vocabulary: `basic` and
 * `ai_advanced`. Anything else — including an absent value — is Basic.
 *
 * This name is exported so `server.ts` performs the single `process.env` read; no
 * nutrition route reads environment state, and nothing ever mutates `process.env`.
 */
export const NUTRITION_PRODUCT_TIER_ENV = "KITCHEN_CODEX_NUTRITION_PRODUCT_TIER";

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
 * observe the SAME already-resolved app-instance access value, and only the gates
 * refuse work.
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
 * Builds the status body from the SAME canonical access value the AI-5B gates close
 * over.
 *
 * `aiAttempted` is not present and nothing here performs work: no provider
 * selection, no credential resolution, no BYOK lookup, no model lookup, no network
 * probe, and no AI route rate-limit bucket is consumed. It reads a resolved closure
 * and returns three fields.
 *
 * The `tier` is copied from the canonical access value rather than re-read from the
 * environment, so this endpoint can never report a different tier than the gate
 * enforcing on the same app instance.
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
 * Resolves the RAW server-owned tier value through the AI-5A contract into the one
 * canonical `NutritionProductAccess` value.
 *
 * This is the ONLY place a product-access decision is constructed, so `createApp()`
 * resolves it exactly once per application instance and every gate closes over that
 * same immutable value. `unknown` is deliberate: the fail-closed resolver must be
 * reachable with arbitrary injected input (booleans, numbers, objects) rather than
 * only with a pre-narrowed type.
 */
export function resolveServerNutritionProductAccess(rawTier?: unknown): NutritionProductAccess {
  return resolveNutritionProductAccess(rawTier);
}

/**
 * The closed feature gate for one AI Advanced Nutrition route.
 *
 * Registration order on a paid AI route is:
 *
 *     requireAiAccessToken
 *       -> requireNutritionProductFeature(access, feature)   // AI-5B
 *         -> textPricingGuard
 *           -> route rate limiter
 *             -> route handler
 *
 * Endpoint authentication therefore stays FIRST: an unauthenticated caller learns
 * nothing about product-access state by probing a route. Entitlement then precedes
 * pricing resolution, provider selection, credential resolution and the rate-limit
 * bucket, so a Basic denial costs ZERO provider calls and does not consume the paid
 * route's rate-limit budget.
 *
 * The feature is supplied by the server at registration time and never by the
 * request. Entitlement is read through AI-5A's `isNutritionProductFeatureEntitled`,
 * which performs a canonical-identity check on the access value and fails closed for a
 * non-canonical or hand-authored object — so a caller cannot mint an access value that
 * this gate accepts.
 */
export function requireNutritionProductFeature(
  access: NutritionProductAccess,
  feature: NutritionProductAiFeature
): RequestHandler {
  return (_req, res, next) => {
    if (isNutritionProductFeatureEntitled(access, feature)) {
      next();
      return;
    }
    res.status(403).json(buildNutritionAiNotEntitledBody());
  };
}

/**
 * The AI-5A contract version the server boundary is bound to. Re-exported so an
 * audit can confirm the enforcement layer and the product contract are the same
 * closed version without importing the core module directly.
 */
export const NUTRITION_PRODUCT_ACCESS_BOUND_VERSION = NUTRITION_PRODUCT_ACCESS_VERSION;