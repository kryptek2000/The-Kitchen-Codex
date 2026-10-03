/**
 * The Kitchen Codex — Advanced Nutrition AI-5E: SERVER PRODUCT-ACCESS AUTHORITY
 * ABSTRACTION.
 *
 * AI-5A defined the PURE product-access contract
 * (`src/core/nutritionV2/nutritionProductAccess.ts`). AI-5B made that contract
 * SERVER-AUTHORITATIVE by resolving a deployment environment value once inside
 * `createApp()` and closing every gate over the result. AI-5C gave the client
 * read-only awareness. AI-5D made operational readiness refreshable.
 *
 * AI-5E is an ABSTRACTION phase, not a product-policy change. It creates the ONE
 * server-owned socket that answers the question "where does authoritative product
 * access come from?", so that replacing the CURRENT deployment-scoped source with a
 * future authenticated ACCOUNT source later does NOT require redesigning the six
 * AI-5B gates or the AI-5C status route a second time.
 *
 * ---------------------------------------------------------------------------
 * WHY RAW TIER INJECTION WAS NOT SUFFICIENT LONG-TERM
 * ---------------------------------------------------------------------------
 * `CreateAppOptions.nutritionProductTier` answered a question about the PROCESS:
 * "what tier is this deployment?" Its only reachable implementation was an env
 * read. That shape cannot express a future per-PRINCIPAL answer, because it has
 * nowhere to put a principal and no way to become asynchronous. Adding a second
 * option later (`nutritionProductAccount`) beside it would have produced two live
 * entitlement seams with precedence rules — ambiguous authority, which is exactly
 * the failure mode AI-5A exists to prevent.
 *
 * So the seam is now a single AUTHORITY OBJECT with one method. The environment
 * value became merely the CURRENT IMPLEMENTATION of that object, chosen by server
 * composition, never by a request.
 *
 * ---------------------------------------------------------------------------
 * THE PERMANENT RULE — PRODUCT ACCESS AUTHORITY IS NOT ANY OF THESE
 * ---------------------------------------------------------------------------
 * NOT provider configuration. NOT BYOK. NOT API-key possession. NOT browser state.
 * NOT client headers, cookies, URL query or request body. NOT vault content. NOT
 * pricing or cost class. NOT a payment receipt. NOT an IP address. NOT
 * `AI_ENDPOINT_TOKEN`. A deployment with a perfect provider, a perfect key and a
 * perfect token is still whatever THIS authority says it is.
 *
 * ---------------------------------------------------------------------------
 * REQUEST-CAPABLE NOW, REQUEST-INDEPENDENT TODAY
 * ---------------------------------------------------------------------------
 * `resolve` accepts the Express request deliberately. A FUTURE authority must be
 * able to consume a SERVER-AUTHENTICATED identity established by trusted
 * middleware, and an interface that could only ever answer "what tier is this
 * process?" would force another gate redesign on the day that identity exists.
 *
 * The CURRENT deployment authority therefore IGNORES THE REQUEST COMPLETELY. No
 * code in this repository infers entitlement from a `Request` today, and the
 * deployment factory's implementation contains no header, cookie, query, body, IP
 * or authorization read.
 *
 * ---------------------------------------------------------------------------
 * FUTURE MANDATORY GATE — AUTHENTICATED PRINCIPAL ONLY
 * ---------------------------------------------------------------------------
 * A future account authority may use ONLY an identity established by trusted
 * SERVER authentication middleware. It must NEVER trust `x-user-id`,
 * `x-account-id`, `x-plan`, `x-entitlement`, arbitrary unverified Authorization
 * payload claims, a cookie merely because it exists, or query/body identity. A
 * synthetic principal (`userId = req.ip`, `account = AI_ENDPOINT_TOKEN`,
 * `account = cookie`, `account = vault`) is forbidden outright. AI-5E does not
 * create such an identity, and creating one is a separate, later phase.
 *
 * ---------------------------------------------------------------------------
 * RESOLVED IS NOT THE SAME AS UNAVAILABLE
 * ---------------------------------------------------------------------------
 * AI-5C established a distinction the server must also honour: a KNOWN Basic tier
 * is a genuine product fact, while "access could not be verified" is not. Every
 * authority failure — a thrown error, a rejected promise, a non-object result, an
 * unknown status, or a `resolved` decision carrying a non-canonical access value —
 * therefore becomes `unavailable`, NEVER a fabricated Basic and NEVER Advanced.
 *
 * Canonical identity is load-bearing here: `resolved.access` must be one of the two
 * frozen AI-5A instances, so a hand-authored structurally identical "AI Advanced"
 * object is refused rather than trusted.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT KNOW
 * ---------------------------------------------------------------------------
 * No providers, credentials, BYOK/session keys, pricing catalogs, rate limits,
 * accounts, plans, checkouts, billing vendors, license servers, customer records,
 * USDA/FDC data, AI-4 internals, or persistence. It holds one canonical access
 * value in server process memory and performs no I/O.
 */

import type { Request } from "express";

import {
  isNutritionProductAccess,
  resolveNutritionProductAccess,
  type NutritionProductAccess,
} from "../src/core/nutritionV2/nutritionProductAccess.js";

/**
 * The ONE non-secret, server-owned, deployment-scoped product-access input.
 *
 * It is the input to the CURRENT authority implementation only. `server.ts` performs
 * the single `process.env` read and hands the RAW value to the factory; nothing in
 * `createApp()`, in any route, or in any middleware reads environment state.
 */
export const NUTRITION_PRODUCT_TIER_ENV = "KITCHEN_CODEX_NUTRITION_PRODUCT_TIER";

/**
 * The closed authority decision.
 *
 * `resolved` means the authority DID determine product access and its `access` is
 * one of the canonical AI-5A frozen instances. `unavailable` means the authority
 * could NOT be consulted, failed, or returned something untrustworthy — a truthful
 * "unknown", never a disguised Basic.
 */
export type NutritionProductAccessAuthorityDecision =
  | {
      readonly status: "resolved";
      readonly access: NutritionProductAccess;
    }
  | {
      readonly status: "unavailable";
    };

/**
 * The ONE server-owned product-access authority boundary.
 *
 * Properties that make this the right seam for a future account-backed source:
 *
 *   - SERVER-OWNED: it is injected by `createApp()` at composition time and can
 *     never be selected by a browser.
 *   - REQUEST-CAPABLE: it receives the Express request so a future implementation
 *     can read a SERVER-AUTHENTICATED principal established by trusted middleware.
 *     Today's implementation ignores it completely.
 *   - ASYNCHRONOUS-CAPABLE: the decision is a promise, so a future remote or
 *     account-backed lookup needs no interface change.
 *   - RUNTIME VALIDATED: whatever it returns is re-validated by
 *     `invokeNutritionProductAccessAuthority`, so a broken or hostile
 *     implementation degrades to `unavailable` instead of to Advanced.
 *
 * It deliberately exposes no source, provenance, plan, account, provider or
 * diagnostic accessor: nothing about HOW access was determined may reach a client.
 */
export interface NutritionProductAccessAuthority {
  resolve(request: Request): Promise<NutritionProductAccessAuthorityDecision>;
}

/**
 * The single frozen fail-closed decision. Shared and frozen: it carries no data, so
 * there is nothing to leak and nothing to mutate.
 */
export const NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE: NutritionProductAccessAuthorityDecision =
  Object.freeze({ status: "unavailable" });

/**
 * Builds a `resolved` decision around a CANONICAL access value.
 *
 * The canonical check is deliberate: a caller that hands in a non-canonical access
 * value (a hand-authored look-alike, a spread copy, a structurally correct forgery)
 * receives `unavailable` rather than a decision that downstream gates would have to
 * re-check anyway.
 */
export function resolvedNutritionProductAccessDecision(
  access: unknown,
): NutritionProductAccessAuthorityDecision {
  if (!isNutritionProductAccess(access)) {
    return NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE;
  }
  return Object.freeze({ status: "resolved", access });
}

/**
 * Runtime validation of an authority's raw return value.
 *
 * Every rejection below is the SAME truthful outcome — access could not be verified:
 *
 *   - `null`, `undefined`, booleans, numbers, strings, arrays, functions
 *   - `{ status: 'resolved' }` with no access value
 *   - `{ status: 'resolved', access: <hand-authored Advanced mimic> }`
 *   - `{ status: 'unavailable', access: <canonical Advanced> }` (status wins)
 *   - any unknown / missing / non-string status
 *   - a canonical `resolved` decision carrying extra fields (the identity check on
 *     `access` still holds, and no extra field is ever read or forwarded)
 *
 * It never throws and never returns Advanced for an untrustworthy result.
 */
export function normalizeNutritionProductAccessAuthorityDecision(
  raw: unknown,
): NutritionProductAccessAuthorityDecision {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE;
  }
  const record = raw as { readonly status?: unknown; readonly access?: unknown };
  if (record.status === "unavailable") {
    return NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE;
  }
  if (record.status !== "resolved") {
    return NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE;
  }
  return resolvedNutritionProductAccessDecision(record.access);
}

/**
 * The ONE authority invocation boundary.
 *
 * Every product-access question — the six AI-5B gates and the AI-5C status route —
 * goes through this function, exactly once per request. It:
 *
 *   1. refuses an absent, non-object or `resolve`-less authority;
 *   2. calls `resolve` with the request, inside a `try`, so a synchronous throw, a
 *      rejected promise, and a returned non-promise all behave identically;
 *   3. runtime-validates the result through the normalizer.
 *
 * It never throws, so no authority problem can escape as an unhandled 500, and it
 * never inspects the request itself.
 */
export async function invokeNutritionProductAccessAuthority(
  authority: unknown,
  request: Request,
): Promise<NutritionProductAccessAuthorityDecision> {
  if (authority === null || typeof authority !== "object") {
    return NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE;
  }
  const resolve = (authority as { readonly resolve?: unknown }).resolve;
  if (typeof resolve !== "function") {
    return NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE;
  }
  let raw: unknown;
  try {
    raw = await (resolve as (r: Request) => unknown).call(authority, request);
  } catch {
    return NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE;
  }
  return normalizeNutritionProductAccessAuthorityDecision(raw);
}

/**
 * The CURRENT production authority: deployment-scoped, process-wide, request-
 * independent.
 *
 * Construction performs the ONE and ONLY raw-tier resolution, delegating to the
 * unchanged AI-5A resolver so the deployment source and the product contract can
 * never disagree. Afterwards the authority holds exactly one canonical frozen
 * access value and returns the SAME decision object for every request.
 *
 * Consequences that are load-bearing, not incidental:
 *
 *   - the raw env value is NEVER reparsed per request;
 *   - changing `process.env` after construction cannot change this authority;
 *   - the six gates and the status route cannot disagree, because they observe the
 *     identical immutable decision;
 *   - there is no I/O, no provider work, no credential work, no billing work and no
 *     persistence — the decision lives in server process memory only.
 *
 * Fail-closed resolution is unchanged from AI-5B: only the exact primitive
 * `ai_advanced` grants AI Advanced. Absent, empty, whitespace, wrong-case, padded,
 * aliased, boolean, numeric, array, object and feature-shaped inputs are all Basic.
 * There is no trimming, no case folding and no alias table.
 */
export function createDeploymentNutritionProductAccessAuthority(
  rawTier?: unknown,
): NutritionProductAccessAuthority {
  const decision = resolvedNutritionProductAccessDecision(
    resolveNutritionProductAccess(rawTier),
  );
  const authority: NutritionProductAccessAuthority = {
    // The parameter is deliberately unnamed-and-unused-by-contract: the CURRENT
    // deployment authority is request-INDEPENDENT, so no header, cookie, query,
    // body, IP, or Authorization content can branch this decision.
    resolve: (_request: Request) => Promise.resolve(decision),
  };
  return Object.freeze(authority);
}

/**
 * The safe default authority for an application instance that was not given one.
 *
 * `createApp()` without an explicitly composed authority MUST be canonical Basic,
 * so an absent authority is never silently Advanced. It is the same fail-closed
 * deployment authority with no tier input at all — not a bypass, not a dev-only
 * escape hatch, not a test-only switch.
 */
export function createBasicNutritionProductAccessAuthority(): NutritionProductAccessAuthority {
  return createDeploymentNutritionProductAccessAuthority(undefined);
}