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

/** Validates an untrusted /api/kitchen/interpret response payload. */
export function isInterpretResponse(
  payload: unknown
): payload is { ok: true; source: string; query: KitchenQuery } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const query = p['query'];
  return (
    p['ok'] === true &&
    typeof p['source'] === 'string' &&
    typeof query === 'object' &&
    query !== null &&
    !Array.isArray(query)
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
