/**
 * The Kitchen Codex — Ask My Kitchen Trusted Context + Source Policy (v0.5.0 Step 2)
 *
 * A pure, deterministic policy layer that sits on top of the Step 1
 * `KitchenIntent` foundation. It resolves TRUSTED recipe context (which the
 * model must never invent), evaluates EXECUTION READINESS, and maps the intent
 * source to a WEB-DISCOVERY POLICY — semantics only, never side effects.
 *
 * TRUST BOUNDARY:
 *   - Model-owned `KitchenIntent` is assumed to have ALREADY passed through
 *     `sanitizeKitchenIntent()`. This layer never trusts raw model output: it
 *     sanitizes user/UI-provided `TrustedKitchenContext` defensively.
 *   - Concrete recipe identities come ONLY from `TrustedKitchenContext`. They
 *     are NEVER derived from `comparisonTargets`, model-generated ids, or
 *     `similarToRecipeId`, and they are never reintroduced into model intent.
 *   - No recipe/vault lookup, no network, no web discovery execution. This layer
 *     only returns policy/readiness metadata. Runtime Ask My Kitchen wiring is
 *     intentionally untouched (Step 2 is foundation/policy code only).
 *
 * SCOPE: trusted-context sanitizer + resolver, execution readiness, source
 * policy, a composed pure `prepareKitchenIntentForExecution`, and tests.
 */

import type { KitchenIntent, TrustedKitchenContext } from './kitchenIntent';
import { sanitizeKitchenIntent, isMeaningfulKitchenIntent } from './kitchenIntent';

/** Cap for the trusted selected-recipe id list. */
export const MAX_TRUSTED_SELECTED_IDS = 20;
/** Cap for a single trusted recipe identity string. */
export const MAX_TRUSTED_ID_LEN = 200;
/** Minimum unique trusted ids required to execute a comparison. */
export const MIN_COMPARISON_SELECTED_IDS = 2;

/** The resolved, trusted recipe references (identities only from trusted context). */
export interface ResolvedKitchenContext {
  currentRecipeId?: string;
  comparisonRecipeIds?: string[];
}

/** A sanitized `KitchenIntent` paired with its resolved trusted context. */
export interface ResolvedKitchenIntent {
  intent: KitchenIntent;
  trustedContext: ResolvedKitchenContext;
}

/** Why a kitchen intent cannot be executed. */
export type KitchenIntentReadinessReason =
  | 'requires_clarification'
  | 'missing_current_recipe'
  | 'insufficient_comparison_context'
  | 'not_meaningful'
  | 'source_conflict';

/** Deterministic execution-readiness verdict. */
export type KitchenIntentReadiness =
  | { executable: true }
  | { executable: false; reason: KitchenIntentReadinessReason };

/** Whether the source permits calling out to web discovery. */
export type WebDiscoveryPermission =
  | 'forbidden'
  | 'offer_if_weak'
  | 'explicitly_requested';

/** Pure source policy metadata — NEVER causes a web call. */
export interface KitchenSourcePolicy {
  initialSource: 'vault' | 'web';
  webDiscoveryPermission: WebDiscoveryPermission;
  mayExecuteWebDiscoveryNow: boolean;
}

/** Result of the composed `prepareKitchenIntentForExecution` helper. */
export type PreparedKitchenExecution =
  | {
      ok: false;
      reason: 'invalid_intent';
    }
  | {
      ok: true;
      intent: KitchenIntent;
      trustedContext: ResolvedKitchenContext;
      readiness: KitchenIntentReadiness;
      sourcePolicy: KitchenSourcePolicy;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exact-dedupe, trim, drop-empty, bounded string list for trusted identities. */
function sanitizeTrustedIdList(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, MAX_TRUSTED_ID_LEN);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : undefined;
}

/**
 * Deterministically sanitizes user/UI-provided trusted context. String-only,
 * trimmed, empties dropped, `selectedRecipeIds` exact-deduped and bounded. IDs
 * are never invented, never transformed into model-derived values, and are
 * taken only from the trusted input.
 */
export function sanitizeTrustedKitchenContext(input: unknown): TrustedKitchenContext {
  const ctx: TrustedKitchenContext = {};
  if (!isPlainObject(input)) return ctx;

  if (typeof input['currentRecipeId'] === 'string') {
    const id = input['currentRecipeId'].trim().slice(0, MAX_TRUSTED_ID_LEN);
    if (id) ctx.currentRecipeId = id;
  }

  const selected = sanitizeTrustedIdList(input['selectedRecipeIds'], MAX_TRUSTED_SELECTED_IDS);
  if (selected && selected.length) ctx.selectedRecipeIds = selected;

  return ctx;
}

/**
 * Resolves trusted recipe context onto a sanitized `KitchenIntent`.
 *
 * The model never supplies identities. Resolution only reflects semantic intent:
 *   - similar_recipe / pairing + references.currentRecipe === true
 *       -> may adopt trusted.currentRecipeId (never fabricated when absent)
 *   - compare
 *       -> adopts trusted.selectedRecipeIds (deduped); comparisonTargets is a
 *          semantic COUNT only and never produces identities
 *   - any other intent -> nothing is attached (e.g. meal_suggestion does NOT
 *     inherit currentRecipeId just because one exists in UI state)
 *
 * `trustedInput` is sanitized defensively; raw model intent is not trusted.
 */
export function resolveTrustedKitchenContext(
  intent: KitchenIntent,
  trustedInput: unknown
): ResolvedKitchenIntent {
  const trusted = sanitizeTrustedKitchenContext(trustedInput);
  const resolved: ResolvedKitchenContext = {};

  const refs = intent.references;
  const needsCurrentRecipe =
    refs?.currentRecipe === true &&
    (intent.intent === 'similar_recipe' || intent.intent === 'pairing');

  if (needsCurrentRecipe && trusted.currentRecipeId) {
    resolved.currentRecipeId = trusted.currentRecipeId;
  }

  if (intent.intent === 'compare' && trusted.selectedRecipeIds) {
    resolved.comparisonRecipeIds = trusted.selectedRecipeIds;
  }

  return { intent, trustedContext: resolved };
}

/**
 * Deterministically decides whether a SANITIZED intent (with resolved trusted
 * context) is executable. Returns a richer verdict than a bare boolean.
 *
 * Order of checks:
 *   1. not_meaningful            — the sanitized intent has no usable anchor
 *   2. requires_clarification    — the intent explicitly asks to clarify first
 *   3. source_conflict           — e.g. discover_online with a non-web source
 *   4. missing_current_recipe    — similar_recipe/pairing need a trusted target
 *   5. insufficient_comparison_context — compare needs >= 2 trusted ids
 *   6. executable
 *
 * NOTE: a structurally meaningful intent may still be non-executable (e.g.
 * requiresClarification stays meaningful at Step 1, but execution is blocked).
 */
export function evaluateKitchenIntentReadiness(
  intent: KitchenIntent,
  resolved: ResolvedKitchenContext
): KitchenIntentReadiness {
  if (!isMeaningfulKitchenIntent(intent)) return { executable: false, reason: 'not_meaningful' };

  if (intent.requiresClarification === true) {
    return { executable: false, reason: 'requires_clarification' };
  }

  // discover_online means "go to the web NOW"; a non-web initial source cannot
  // express that, so it is a semantic contradiction rather than a rewrite.
  if (intent.intent === 'discover_online' && intent.source !== 'web') {
    return { executable: false, reason: 'source_conflict' };
  }

  const wantsCurrentRecipe =
    intent.references?.currentRecipe === true &&
    (intent.intent === 'similar_recipe' || intent.intent === 'pairing');
  if (wantsCurrentRecipe && !resolved.currentRecipeId) {
    return { executable: false, reason: 'missing_current_recipe' };
  }

  if (intent.intent === 'compare') {
    const ids = resolved.comparisonRecipeIds ?? [];
    if (ids.length < MIN_COMPARISON_SELECTED_IDS) {
      return { executable: false, reason: 'insufficient_comparison_context' };
    }
  }

  return { executable: true };
}

/**
 * Maps an intent's source to a pure WEB-DISCOVERY POLICY. This is metadata only:
 * it never fetches, never calls web, and never creates a discovery request.
 *
 *   vault         -> forbidden, no immediate web execution
 *   vault_then_web-> offer_if_weak, initial vault, NO immediate web execution
 *   web           -> explicitly_requested, initial web, immediate web allowed
 */
export function resolveKitchenSourcePolicy(intent: KitchenIntent): KitchenSourcePolicy {
  switch (intent.source) {
    case 'web':
      return {
        initialSource: 'web',
        webDiscoveryPermission: 'explicitly_requested',
        mayExecuteWebDiscoveryNow: true,
      };
    case 'vault_then_web':
      return {
        initialSource: 'vault',
        webDiscoveryPermission: 'offer_if_weak',
        mayExecuteWebDiscoveryNow: false,
      };
    case 'vault':
    default:
      return {
        initialSource: 'vault',
        webDiscoveryPermission: 'forbidden',
        mayExecuteWebDiscoveryNow: false,
      };
  }
}

/**
 * Composes the full Step 2 pipeline, all pure, for a single (possibly raw)
 * input:
 *
 *   raw intent -> sanitizeKitchenIntent -> meaningfulness (readiness)
 *              -> resolveTrustedKitchenContext -> evaluateKitchenIntentReadiness
 *              -> resolveKitchenSourcePolicy
 *
 * The result is a `PreparedKitchenExecution`. `ok` reflects whether the raw
 * input sanitized into a valid intent; the caller inspects `readiness` for the
 * executable verdict (which may still be blocked by clarification, a missing
 * trusted target, insufficient comparison context, or a source conflict).
 */
export function prepareKitchenIntentForExecution(
  rawIntent: unknown,
  trustedContext: unknown
): PreparedKitchenExecution {
  const intent = sanitizeKitchenIntent(rawIntent);
  if (!intent) return { ok: false, reason: 'invalid_intent' };

  const { trustedContext: resolved } = resolveTrustedKitchenContext(intent, trustedContext);
  const readiness = evaluateKitchenIntentReadiness(intent, resolved);
  const sourcePolicy = resolveKitchenSourcePolicy(intent);

  return { ok: true, intent, trustedContext: resolved, readiness, sourcePolicy };
}
