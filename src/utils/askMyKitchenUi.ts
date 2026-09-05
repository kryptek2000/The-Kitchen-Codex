/**
 * The Kitchen Codex — Ask My Kitchen UI helper layer (Step 4).
 *
 * Tiny, pure, testable helpers for the Ask My Kitchen modal. They keep the
 * component lean and make the key contracts (identity resolution, trusted
 * similar-context, request privacy, response validation) unit-testable without
 * a browser DOM harness. They must NOT duplicate Step 1/2/3 retrieval logic —
 * they only wire it into the UI and validate untrusted server responses.
 */

import type { ObsidianRecipe } from '../types';
import { recipeIdentity } from './recipeRelationships';
import type { KitchenQuery } from './kitchenSearch';
import type { KitchenAnswerItem } from './kitchenAnswer';
import type { KitchenIntent } from './kitchenIntent';
import type { KitchenCandidateEvidence } from './kitchenRanking';
import type {
  KitchenIntentReadiness,
  ResolvedKitchenContext,
  PreparedKitchenExecution,
} from './kitchenIntentPolicy';

/** Resolves a recipe identity (id ?? filePath ?? fileName) to a loaded recipe. */
export function resolveAnswerRecipe(
  identity: string,
  recipes: ObsidianRecipe[]
): ObsidianRecipe | undefined {
  if (!identity) return undefined;
  return recipes.find((recipe) => recipeIdentity(recipe) === identity);
}

/**
 * A conservative, explicit set of phrases that clearly mean "similar to THIS
 * recipe". Deliberately narrow: standalone "like this" / "similar" / "such as
 * this" are NOT trusted because they false-positive on "I like this recipe". The
 * phrase must anchor recipe-similarity intent (e.g. it ends in/surrounds "this").
 */
const SIMILAR_PHRASES = [
  /similar to this/i, // "similar to this", "recipes similar to this", "what is similar to this recipe"
  /something similar to/i, // "something similar to this"
  /recipes? like this/i, // "recipes like this", "recipe like this"
];

function hasSimilarIntent(question: string): boolean {
  return SIMILAR_PHRASES.some((pattern) => pattern.test(question ?? ''));
}

/**
 * Applies TRUSTED similar-to context after Step 2 interpretation.
 *
 * Trusted context wins over anything the model/interpreter produced, and a
 * model-inferred `similarToRecipeId` is never trusted:
 *   - with a trusted current-recipe identity AND a clear similar cue: seed
 *     `query.similarToRecipeId` from the trusted identity;
 *   - otherwise (no similarity intent, or no trusted context): the interpreter's
 *     `similarToRecipeId` is cleared so an AI-invented id cannot drive retrieval.
 *
 * Returns a shallow-cloned query; the input is never mutated.
 */
export function applyTrustedSimilarContext(
  query: KitchenQuery,
  trustedCurrentRecipeIdentity: string | undefined,
  question: string
): KitchenQuery {
  const next: KitchenQuery = { ...query };
  delete next.similarToRecipeId;

  if (trustedCurrentRecipeIdentity && hasSimilarIntent(question)) {
    next.similarToRecipeId = trustedCurrentRecipeIdentity;
  }
  return next;
}

/** Builds the exact /api/kitchen/interpret request body (question only). */
export function buildInterpretRequest(question: string): { question: string } {
  return { question };
}

/** Builds the /api/kitchen/answer request body: question + query + compact evidence. */
export function buildAnswerRequest(
  question: string,
  query: KitchenQuery,
  evidence: unknown
): { question: string; query: KitchenQuery; results: unknown } {
  return { question, query, results: evidence };
}

/**
 * Builds the /api/kitchen/rank request body: question + sanitized intent + the
 * COMPACT bounded candidate evidence. No raw recipe/vault data is sent; only the
 * deterministic candidate evidence set leaves the client.
 */
export function buildRankRequest(
  question: string,
  intent: KitchenIntent,
  candidates: KitchenCandidateEvidence[],
  resultCount: number
): { question: string; intent: KitchenIntent; candidates: KitchenCandidateEvidence[]; resultCount: number } {
  return { question, intent, candidates, resultCount };
}

/**
 * Validates an untrusted /api/kitchen/rank response payload (top-level shape).
 * The `ranked` array is separately sanitized by `sanitizeAiRankedCandidates`.
 */
export function isRankResponse(
  payload: unknown
): payload is { ok: boolean; ranked?: unknown } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return typeof p['ok'] === 'boolean';
}

/** Validates an untrusted /api/kitchen/interpret response payload. */
export function isInterpretResponse(
  payload: unknown
): payload is { ok: true; source: string; intent: KitchenIntent } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const intent = p['intent'];
  return (
    p['ok'] === true &&
    typeof p['source'] === 'string' &&
    typeof intent === 'object' &&
    intent !== null &&
    !Array.isArray(intent) &&
    typeof (intent as Record<string, unknown>)['version'] === 'number' &&
    typeof (intent as Record<string, unknown>)['intent'] === 'string' &&
    typeof (intent as Record<string, unknown>)['source'] === 'string' &&
    typeof (intent as Record<string, unknown>)['requiresClarification'] === 'boolean'
  );
}

/** Validates an untrusted /api/kitchen/answer response payload. */
export function isAnswerResponse(
  payload: unknown
): payload is {
  ok: true;
  source: string;
  summary: string;
  noMatches: boolean;
  items: KitchenAnswerItem[];
} {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (
    p['ok'] !== true ||
    typeof p['source'] !== 'string' ||
    typeof p['summary'] !== 'string' ||
    typeof p['noMatches'] !== 'boolean' ||
    !Array.isArray(p['items'])
  ) {
    return false;
  }
  return (p['items'] as unknown[]).every((item) => {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    if (typeof rec['recipeIdentity'] !== 'string') return false;
    if (typeof rec['explanation'] !== 'string') return false;
    // A title is okay to be absent (the UI falls back to the identity), but if
    // present it MUST be a string so an object/array/number never reaches React.
    if (rec['title'] !== undefined && typeof rec['title'] !== 'string') return false;
    return true;
  });
}

/** Fixed, non-technical message for a known HTTP status from Ask My Kitchen maps. */
export function httpErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'That request was invalid. Please check your question and try again.';
    case 401:
      return 'This action is not available with the current vault setup.';
    case 422:
      return 'I could not understand that question. Please try a different wording.';
    case 429:
      return 'Too many requests. Please wait a moment and try again.';
    case 503:
      return "Ask My Kitchen's AI interpreter is temporarily unavailable. Please try again.";
    default:
      return 'Something went wrong on the server. Please try again.';
  }
}

/** Fixed message for a network/unreachable failure. */
export const NETWORK_ERROR_MESSAGE =
  'Could not reach the server. Please check your connection and try again.';

/** Fixed message for an invalid/malformed response shape. */
export const INVALID_RESPONSE_MESSAGE =
  'I received an unexpected response. Please try again.';

// ---------------------------------------------------------------------------
// v0.5.0 — Client-side intent consumption (Step 3)
// ---------------------------------------------------------------------------

/**
 * Intents the current v0.4.1 retrieval UI can actually execute. pairing /
 * compare / discover_online are NOT implemented yet in this phase and must fail
 * safely rather than be silently reinterpreted as a basic search.
 */
const RUNTIME_SUPPORTED_INTENTS = new Set<string>([
  'find_recipes',
  'ingredient_use',
  'browse_category',
  'similar_recipe',
  'meal_suggestion',
]);

export function isIntentRuntimeSupported(intent: KitchenIntent): boolean {
  return Boolean(intent) && RUNTIME_SUPPORTED_INTENTS.has(intent.intent);
}

/**
 * The single Step 3 client execution gate. Local vault retrieval may proceed
 * ONLY when: the intent sanitized (ok), is semantically executable, the source
 * policy is VAULT-only, and the runtime supports the intent. Anything web-scoped
 * (initialSource !== "vault") is withheld until a later step implements web
 * discovery — so an explicit-web request can NEVER fall back to a local vault
 * scan.
 */
export function canExecuteLocalRetrieval(prepared: PreparedKitchenExecution): boolean {
  if (!prepared.ok) return false;
  return (
    prepared.readiness.executable === true &&
    prepared.sourcePolicy.initialSource === 'vault' &&
    isIntentRuntimeSupported(prepared.intent)
  );
}

/**
 * Narrow compatibility bridge: converts an executable, runtime-supported
 * `KitchenIntent` (with its resolved trusted context) back into the existing
 * `KitchenQuery` used by `searchKitchenRecipes`. Trusted identities are only
 * ever attached here from the resolved trusted context, never the model.
 *
 * A `meal_suggestion` is always bounded so it can never fall through to a
 * whole-vault scan: it uses the sanitized `requestedResultCount` when present,
 * otherwise a small safe default, and never overwrites a stricter existing
 * `constraints.limit` with a larger number.
 */
export function intentToQuery(
  intent: KitchenIntent,
  resolved: ResolvedKitchenContext
): KitchenQuery {
  const query: KitchenQuery = { ...intent.constraints };
  if (intent.intent === 'similar_recipe' && resolved.currentRecipeId) {
    query.similarToRecipeId = resolved.currentRecipeId;
  }
  if (intent.intent === 'meal_suggestion') {
    query.limit = boundedResultLimit(query.limit, intent.requestedResultCount);
  }
  return query;
}

/** Safe default cap for an unbounded meal_suggestion query. */
const DEFAULT_MEAL_SUGGESTION_LIMIT = 6;

/** Choose the smaller safe result bound, defaulting to DEFAULT_MEAL_SUGGESTION_LIMIT. */
function boundedResultLimit(existing: number | undefined, requested: number | undefined): number {
  const candidates: number[] = [];
  if (typeof existing === 'number' && Number.isFinite(existing)) candidates.push(existing);
  if (typeof requested === 'number' && Number.isFinite(requested)) candidates.push(requested);
  if (candidates.length === 0) return DEFAULT_MEAL_SUGGESTION_LIMIT;
  return Math.min(...candidates);
}

/** A safe, fixed, non-technical message for a non-executable readiness verdict. */
export function intentBlockedMessage(readiness: KitchenIntentReadiness): string {
  if (readiness.executable === false) {
    switch (readiness.reason) {
      case 'requires_clarification':
        return 'I need a little more information to help with that.';
      case 'not_meaningful':
        return 'I could not understand that request. Please try a different wording.';
      case 'missing_current_recipe':
        return 'I need to know which recipe you are referring to.';
      case 'insufficient_comparison_context':
        return 'I need at least two recipes to compare.';
      case 'source_conflict':
        return 'That request needs a different source mode than is available.';
      default:
        return 'I could not process that request. Please try again.';
    }
  }
  return '';
}

/** A safe, fixed message for an intents that the current phase cannot run yet. */
export const RUNTIME_NOT_SUPPORTED_MESSAGE =
  'That kind of request is not available here yet. Try a different wording.';
