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

/** A conservative cue for "similar to this recipe". Not broad NLP. */
const SIMILAR_CUE = /\b(?:similar|like this|such as this)\b/i;

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

  if (trustedCurrentRecipeIdentity && SIMILAR_CUE.test(question ?? '')) {
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
  return (p['items'] as unknown[]).every(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>)['recipeIdentity'] === 'string' &&
      typeof (item as Record<string, unknown>)['explanation'] === 'string'
  );
}
