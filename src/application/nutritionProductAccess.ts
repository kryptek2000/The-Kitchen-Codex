/**
 * The Kitchen Codex — Advanced Nutrition AI-5C: CLIENT PRODUCT-AWARENESS READER.
 *
 * AI-5A defined PRODUCT ACCESS. AI-5B made it server-authoritative and enforced it
 * before any provider work. AI-5C lets the CLIENT become AWARE of that one
 * server-owned decision, purely so the UI can tell three genuinely different
 * situations apart instead of collapsing them into one generic message:
 *
 *   1. Basic product access on this deployment;
 *   2. AI Advanced product access, but no usable provider/model/credential;
 *   3. product-access status that could not be verified at all.
 *
 * ---------------------------------------------------------------------------
 * THE PERMANENT SECURITY RULE: AWARENESS IS NOT AUTHORITY
 * ---------------------------------------------------------------------------
 * This module is a READER. It has no authority over anything. Even if a browser
 * forges, edits, replays or fabricates its cached value — including forcing
 * `tier: "ai_advanced"` in DevTools — every Advanced Nutrition POST still reaches
 * the AI-5B gate, which resolves product access from its OWN server-side
 * deployment configuration and independently denies a Basic deployment with
 * `403 NUTRITION_AI_NOT_ENTITLED`.
 *
 * The browser optimizes UX. The server authorizes execution.
 *
 * That is also why this module never sends anything back: there is deliberately NO
 * client entitlement header (`x-product-tier`, `x-entitlement`,
 * `x-kitchen-nutrition-tier`), no `?entitled=true`, no cookie, and no receipt. The
 * server already knows the authoritative tier and has no reason to ask the browser
 * for it.
 *
 * ---------------------------------------------------------------------------
 * THE THREE QUESTIONS STAY SEPARATE
 * ---------------------------------------------------------------------------
 *   1. PRODUCT ACCESS      — read HERE, from the AI-5B status endpoint. Owned by the
 *                            AI-5B server gate; the client is read-only awareness.
 *   2. OPERATIONAL READINESS— owned by the pre-existing provider/readiness
 *                            architecture (`resolveNutritionAiCapabilities`, which
 *                            reads `/api/providers`). Deliberately NOT redefined here
 *                            and never inferred from product access.
 *   3. NUTRITION AUTHORITY  — owned by the deterministic AI-1/AI-2/AI-3/AI-4 layers.
 *                            Untouched: product access never decides a match, an FDC
 *                            id, grams, a portion, a nutrient, Review, Apply or
 *                            persistence.
 *
 * Effective client availability is `PRODUCT ENTITLED AND OPERATIONALLY READY`,
 * composed per feature in `resolveNutritionAiClientState`. Never OR.
 *
 * ---------------------------------------------------------------------------
 * WHY `unavailable` IS NOT `basic`
 * ---------------------------------------------------------------------------
 * A transport failure, a 401, a malformed body or an unsupported contract version
 * means the client DOES NOT KNOW the tier. Reporting that as "you are Basic" would
 * invent a product fact the server never stated, and would blame the deployment for
 * a network problem. So the closed result distinguishes them:
 *
 *   - `resolved`   — the server definitively reported a tier;
 *   - `unavailable`— the tier could not be verified.
 *
 * Both fail SAFE to no AI availability. They differ only in what the UI is allowed
 * to SAY, which is precisely the point of AI-5C.
 *
 * ---------------------------------------------------------------------------
 * TRUST BOUNDARY: THE RESPONSE IS UNTRUSTED TRANSPORT DATA
 * ---------------------------------------------------------------------------
 * A response is accepted only as a plain object with the EXACT key set
 * `{ ok, version, tier }`, `ok === true`, `version` exactly equal to the AI-5A
 * contract version, and `tier` exactly `basic` or `ai_advanced`. Extra fields,
 * missing fields, wrong case, whitespace padding, aliases, booleans, numbers,
 * arrays, nested feature payloads, provider-shaped or billing-shaped data, and
 * hand-authored `NutritionProductAccess` objects are all REJECTED wholesale.
 *
 * The canonical access value is then produced by the EXISTING AI-5A resolver from
 * the validated tier scalar, so a client can never structurally mint an impossible
 * product state (such as Basic plus an enabled feature) even locally.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT KNOW
 * ---------------------------------------------------------------------------
 * No Express, no `process.env`, no provider registry, no credential resolver, no
 * BYOK or session-key storage, no pricing or billing, no accounts or identity, no
 * USDA or FDC catalog, no Apply, no persistence. It knows one URL, one minimal
 * response shape, and the closed AI-5A tier vocabulary.
 */

import type { NetworkAdapter } from './adapters/NetworkAdapter';
import {
  isAiAdvancedProductAccess,
  isNutritionProductTier,
  NUTRITION_PRODUCT_ACCESS_VERSION,
  resolveNutritionProductAccess,
  type NutritionProductAccess,
} from '../core/nutritionV2/nutritionProductAccess';

/**
 * The ONE server-owned product-access source, observed read-only.
 *
 * This spelling matches `server/nutritionProductAccess.ts`; the status route is
 * informational only, so the client learns the tier and nothing else.
 */
export const NUTRITION_PRODUCT_ACCESS_ENDPOINT = '/api/nutrition/product-access';

/**
 * The EXACT accepted key set. Anything else — extra or missing — is a rejection.
 */
const ACCEPTED_STATUS_KEYS: ReadonlyArray<string> = Object.freeze(['ok', 'version', 'tier']);

/**
 * The closed client-awareness result.
 *
 * `resolved` carries the canonical AI-5A access value so features can be read
 * through the existing contract helpers. `unavailable` carries nothing at all:
 * there is no partial, guessed, or inferred product state.
 */
export type NutritionProductAccessRead =
  | { readonly status: 'resolved'; readonly access: NutritionProductAccess }
  | { readonly status: 'unavailable' };

/** The fail-closed result. Frozen and shared: it holds no data. */
export const NUTRITION_PRODUCT_ACCESS_UNAVAILABLE: NutritionProductAccessRead = Object.freeze({
  status: 'unavailable',
});

/** True only for a server-DEFINITIVELY reported product-access read. */
export function isResolvedNutritionProductAccess(
  read: NutritionProductAccessRead
): read is { readonly status: 'resolved'; readonly access: NutritionProductAccess } {
  return read.status === 'resolved';
}

/**
 * The ONE place a transport payload is accepted or refused.
 *
 * Returns the validated tier scalar, or `undefined` for every rejection. It does
 * NOT coerce: a wrong version is never treated as the current one, a padded or
 * wrong-case tier is never trimmed or folded, and an alias is never mapped.
 */
export function parseNutritionProductAccessStatus(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  if (Array.isArray(payload)) return undefined;

  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ACCEPTED_STATUS_KEYS.length) return undefined;
  for (const key of keys) {
    if (!ACCEPTED_STATUS_KEYS.includes(key)) return undefined;
  }

  if (record.ok !== true) return undefined;
  // Exact identity: an unsupported or future contract version is unusable, never
  // coerced into current semantics.
  if (record.version !== NUTRITION_PRODUCT_ACCESS_VERSION) return undefined;

  const tier = record.tier;
  // STRICT closed-vocabulary check FIRST. This must come before resolution: the
  // AI-5A resolver is deliberately fail-CLOSED, so it maps an unknown, padded,
  // wrong-case or aliased value to `basic`. Passing such a value straight through
  // would let a malformed `tier: "pro"` be REPORTED AS A GENUINE SERVER-STATED
  // BASIC TIER — inventing a product fact the server never stated. Requiring an
  // exact tier first means a bad tier is REJECTED (unavailable), not coerced.
  if (!isNutritionProductTier(tier)) return undefined;

  // The canonical access value is then produced by the EXISTING AI-5A resolver from
  // that validated scalar, so a client can never structurally mint an impossible
  // product state (such as Basic plus an enabled feature) even locally.
  return resolveNutritionProductAccess(tier).tier;
}

/**
 * Reads the server-owned product-access decision.
 *
 * Fails SAFE and never throws: a transport error, a non-2xx, an auth failure, a
 * missing body, or any rejected shape all yield `unavailable` — which composes to
 * no AI availability and to an "access couldn't be verified" message rather than a
 * false product claim.
 *
 * This performs NO provider work of any kind; it is a single read-only GET behind
 * the same endpoint-auth boundary as every other AI surface.
 */
export async function readNutritionProductAccess(
  network: NetworkAdapter
): Promise<NutritionProductAccessRead> {
  let response;
  try {
    response = await network.get<unknown>(NUTRITION_PRODUCT_ACCESS_ENDPOINT);
  } catch {
    return NUTRITION_PRODUCT_ACCESS_UNAVAILABLE;
  }
  if (!response || response.ok !== true) return NUTRITION_PRODUCT_ACCESS_UNAVAILABLE;

  const tier = parseNutritionProductAccessStatus(response.data);
  if (tier === undefined) return NUTRITION_PRODUCT_ACCESS_UNAVAILABLE;

  return Object.freeze({
    status: 'resolved',
    access: resolveNutritionProductAccess(tier),
  });
}
/**
 * True only when the server DEFINITIVELY reported AI Advanced product access.
 *
 * This exists so the shell never has to reach into the AI-5A core contract itself.
 * `App.tsx` deciding "is this product state Advanced?" from the core module would
 * break the AI-5A consumer-graph isolation invariant (the shell is a composition
 * edge, not a product-contract consumer), so the question is answered here, in the
 * narrow application-layer reader that owns the product read.
 *
 * `unavailable` and a genuine Basic read are both false: only a RESOLVED AI Advanced
 * read makes AI Advanced product access true.
 */
export function isAiAdvancedProductAccessRead(read: NutritionProductAccessRead): boolean {
  return isResolvedNutritionProductAccess(read) && isAiAdvancedProductAccess(read.access);
}

/** True only when the server DEFINITIVELY reported Basic product access. */
export function isBasicProductAccessRead(read: NutritionProductAccessRead): boolean {
  return isResolvedNutritionProductAccess(read) && !isAiAdvancedProductAccess(read.access);
}
