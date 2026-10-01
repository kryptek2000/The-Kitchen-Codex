/**
 * The Kitchen Codex — application-layer AI-4D2 recipe-context REVIEW flow.
 *
 * This is the ONLY place that knows how a review is obtained, and it does so in
 * two EXPLICIT, ordered steps the user triggered with one click:
 *
 *   1. `POST /api/nutrition/recipe-context`      — ONE provider interpretation
 *   2. `POST /api/nutrition/recipe-context/reconcile` — deterministic, provider-free
 *
 * The result is a `RecipeContextReviewSession`: an inert CURRENT review plan plus
 * an EMPTY decision overlay. Nothing is accepted here. Acceptance is a later,
 * separate, user-initiated action that runs entirely inside the pure session
 * module and performs NO network call at all.
 *
 * ZERO NUTRITION AUTHORITY
 *   This module returns inert review data only. It never touches `Phase4State`,
 *   never dispatches an action, never writes, and never changes the preview, AI-3
 *   eligibility, mass, matching, nutrients, persistence or Apply.
 *
 * NO SILENT BEHAVIOUR
 *   Nothing runs on open, focus, render or resolve: `requestRecipeContextReview`
 *   is only called from the explicit control. Accept/Dismiss/Undo call nothing.
 *
 * ASYNC RACES FAIL TOWARD THE NEWEST RUN
 *   `createRecipeContextReviewRunner` owns a generation counter. Overlapping runs
 *   are possible (a slow interpretation followed by a new one, or a review that
 *   finishes after the user edited the recipe). An older completion can therefore
 *   never replace newer review state: the UI drops any result whose generation is
 *   no longer current, and any recipe/session change invalidates the in-flight run.
 *
 * BOUNDED MESSUES ONLY
 *   Failures map to fixed user-facing copy. No provider text, model name,
 *   credential, stack trace or filesystem path is ever surfaced.
 */

import type { NetworkAdapter } from './adapters/NetworkAdapter';
import {
  AI_RECIPE_CONTEXT_REQUEST_VERSION,
  MAX_AI_RECIPE_CONTEXT_REQUEST_ID_LENGTH,
} from '../core/nutritionV2/aiRecipeContextRequest';
import {
  AI_RECIPE_CONTEXT_RECONCILE_VERSION,
  type RecipeContextReconciliation,
} from '../core/nutritionV2/aiRecipeContextReconcile';
import {
  AI_RECIPE_CONTEXT_REVIEW_LABEL,
  AI_RECIPE_CONTEXT_SECTION_LABEL,
  createRecipeContextReviewSession,
  type RecipeContextReviewSession,
} from '../core/nutritionV2/aiRecipeContextSession';
import { isPlainObject } from '../core/nutritionV2/schema';

/** The AI-4C provider interpretation route (one provider call per review). */
export const NUTRITION_RECIPE_CONTEXT_ENDPOINT = '/api/nutrition/recipe-context';

/** The AI-4D1 reconciliation route (deterministic; no provider). */
export const NUTRITION_RECIPE_CONTEXT_RECONCILE_ENDPOINT =
  '/api/nutrition/recipe-context/reconcile';

/** Re-exported for the shell so the UI has ONE source for the control label. */
export { AI_RECIPE_CONTEXT_REVIEW_LABEL as RECIPE_CONTEXT_REVIEW_LABEL };
export { AI_RECIPE_CONTEXT_SECTION_LABEL as RECIPE_CONTEXT_SECTION_LABEL };

/** Fixed, bounded, user-facing messages (never raw provider or transport text). */
export const RECIPE_CONTEXT_UNAVAILABLE_MESSAGE =
  "Recipe context review isn't available right now.";
export const RECIPE_CONTEXT_INVALID_MESSAGE =
  'AI returned an unusable recipe interpretation. Run the review again.';
export const RECIPE_CONTEXT_STALE_MESSAGE =
  'The recipe changed while AI was reviewing it. Run the review again.';
export const RECIPE_CONTEXT_BUSY_MESSAGE =
  'The AI review is already running. Wait for it to finish, or try again.';

export type RecipeContextReviewFailureCode =
  /** The transport refused the request (shape, bounds, capability, auth). */
  | 'invalid_request'
  /** AI interpretation was unavailable, failed, or returned nothing usable. */
  | 'unavailable'
  /** The reconciliation answer is no longer about the current recipe context. */
  | 'stale'
  /** The model returned something that cannot be reconciled into a review. */
  | 'unusable'
  /** Too many requests for this surface. */
  | 'rate_limited'
  /** The two-step flow was superseded or aborted before it produced a review. */
  | 'superseded';

export type RecipeContextReviewResult =
  | { readonly ok: true; readonly session: RecipeContextReviewSession }
  | { readonly ok: false; readonly code: RecipeContextReviewFailureCode; readonly message: string };

/** The bounded message for a failure code. Never echoes transport detail. */
export function recipeContextReviewMessage(code: RecipeContextReviewFailureCode): string {
  switch (code) {
    case 'invalid_request':
      return RECIPE_CONTEXT_UNAVAILABLE_MESSAGE;
    case 'rate_limited':
      return 'Too many recipe-context reviews. Please wait a moment before trying again.';
    case 'unavailable':
      return RECIPE_CONTEXT_UNAVAILABLE_MESSAGE;
    case 'stale':
      return RECIPE_CONTEXT_STALE_MESSAGE;
    case 'unusable':
      return RECIPE_CONTEXT_INVALID_MESSAGE;
    case 'superseded':
      return RECIPE_CONTEXT_BUSY_MESSAGE;
    default:
      return RECIPE_CONTEXT_UNAVAILABLE_MESSAGE;
  }
}

/**
 * The authored source data the server re-derives its own context from.
 *
 * `recipeInstance` is an OPAQUE, memory-only identity token generated by the
 * caller for this review session. It is never a path, a URL, a file name or a
 * recipe id, and it is never persisted.
 */
export interface RecipeContextReviewSource {
  readonly recipe: unknown;
  readonly instructions: ReadonlyArray<unknown>;
  readonly recipeInstance: string;
}

/** Closed keys of an AI-4C success response. */
const CONTEXT_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  'ok',
  'request_id',
  'proposal',
  'context_binding',
  'aiAttempted',
]);
/** Closed keys of an AI-4D1 reconciliation success response. */
const RECONCILE_RESPONSE_KEYS: ReadonlySet<string> = new Set(['ok', 'reconciliation']);

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Reads the AI-4C response into the EXACT transport-local shape the reconcile
 * route expects. Nothing is inferred: the request id and context binding are the
 * server's own values, and the proposal is forwarded verbatim as untrusted input.
 */
export function buildRecipeContextReconcileRequest(args: {
  readonly response: unknown;
  readonly expectedRequestId: unknown;
  readonly source: RecipeContextReviewSource;
}): { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false } {
  const response = args.response;
  if (!isPlainObject(response)) return { ok: false };
  for (const key of Object.keys(response)) {
    if (!CONTEXT_RESPONSE_KEYS.has(key)) return { ok: false };
  }
  if (response['ok'] !== true) return { ok: false };
  const requestId = boundedString(response['request_id'], MAX_AI_RECIPE_CONTEXT_REQUEST_ID_LENGTH);
  const contextBinding = boundedString(response['context_binding'], 200);
  const proposal = response['proposal'];
  const expected = boundedString(args.expectedRequestId, MAX_AI_RECIPE_CONTEXT_REQUEST_ID_LENGTH);
  if (requestId === undefined || contextBinding === undefined || expected === undefined) {
    return { ok: false };
  }
  if (requestId !== expected) return { ok: false };
  if (!isPlainObject(proposal)) return { ok: false };
  return {
    ok: true,
    body: {
      expected_request_id: requestId,
      recipe_instance: args.source.recipeInstance,
      recipe: args.source.recipe,
      instructions: [...args.source.instructions],
      wire: {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: requestId,
        context_binding: contextBinding,
        proposal,
      },
    },
  };
}

/** Maps a reconciliation response body to a CURRENT plan, or a bounded refusal. */
function readReconciliation(
  response: unknown
): { readonly ok: true; readonly reconciliation: RecipeContextReconciliation } | { readonly ok: false } {
  if (!isPlainObject(response)) return { ok: false };
  for (const key of Object.keys(response)) {
    if (!RECONCILE_RESPONSE_KEYS.has(key)) return { ok: false };
  }
  if (response['ok'] !== true) return { ok: false };
  const reconciliation = response['reconciliation'];
  if (!isPlainObject(reconciliation)) return { ok: false };
  // The version is checked here as a cheap transport assertion; the session core
  // re-validates the whole plan before any decision can be read from it.
  if (reconciliation['reconciliation_version'] !== AI_RECIPE_CONTEXT_RECONCILE_VERSION) {
    return { ok: false };
  }
  return {
    ok: true,
    reconciliation: reconciliation as unknown as RecipeContextReconciliation,
  };
}

export interface RecipeContextReviewRequestArgs {
  readonly network: NetworkAdapter;
  readonly source: RecipeContextReviewSource;
  /** The bounded transport identity for THIS run. */
  readonly requestId: string;
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

/**
 * Runs the ONE explicit review flow: interpret, then reconcile.
 *
 * Performs exactly one provider-backed request and one provider-free
 * reconciliation. Never retries, never falls back, and never returns a partial
 * review: without a CURRENT reconciliation there is nothing to review.
 */
export async function requestRecipeContextReview(
  args: RecipeContextReviewRequestArgs
): Promise<RecipeContextReviewResult> {
  const requestId = boundedString(args.requestId, MAX_AI_RECIPE_CONTEXT_REQUEST_ID_LENGTH);
  const recipeInstance = boundedString(args.source.recipeInstance, 200);
  if (requestId === undefined || recipeInstance === undefined) {
    return { ok: false, code: 'invalid_request', message: recipeContextReviewMessage('invalid_request') };
  }

  let interpreted: { status: number; ok: boolean; data?: unknown };
  try {
    interpreted = await args.network.post<Record<string, unknown>>(
      NUTRITION_RECIPE_CONTEXT_ENDPOINT,
      {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: requestId,
        recipe_instance: recipeInstance,
        recipe: args.source.recipe,
        instructions: [...args.source.instructions],
      },
      {
        headers: args.headers,
        signal: args.signal,
      }
    );
  } catch {
    return { ok: false, code: 'unavailable', message: recipeContextReviewMessage('unavailable') };
  }

  if (interpreted.status === 429) {
    return { ok: false, code: 'rate_limited', message: recipeContextReviewMessage('rate_limited') };
  }
  if (!interpreted.ok) {
    // 400 (deterministic refusal, including an unavailable capability) and 503
    // (provider failure) are both "review is not available right now": the user is
    // never shown transport detail and never sees a fabricated review.
    return { ok: false, code: 'unavailable', message: recipeContextReviewMessage('unavailable') };
  }

  const reconcileRequest = buildRecipeContextReconcileRequest({
    response: interpreted.data,
    expectedRequestId: requestId,
    source: args.source,
  });
  if (!reconcileRequest.ok) {
    return { ok: false, code: 'unusable', message: recipeContextReviewMessage('unusable') };
  }

  let reconciled: { status: number; ok: boolean; data?: unknown };
  try {
    reconciled = await args.network.post<Record<string, unknown>>(
      NUTRITION_RECIPE_CONTEXT_RECONCILE_ENDPOINT,
      reconcileRequest.body,
      { headers: args.headers, signal: args.signal }
    );
  } catch {
    return { ok: false, code: 'unavailable', message: recipeContextReviewMessage('unavailable') };
  }

  if (reconciled.status === 409) {
    // The review answers a different request, or the recipe changed underneath it.
    return { ok: false, code: 'stale', message: recipeContextReviewMessage('stale') };
  }
  if (reconciled.status === 429) {
    return { ok: false, code: 'rate_limited', message: recipeContextReviewMessage('rate_limited') };
  }
  if (!reconciled.ok) {
    return { ok: false, code: 'unusable', message: recipeContextReviewMessage('unusable') };
  }

  const plan = readReconciliation(reconciled.data);
  if (!plan.ok) {
    return { ok: false, code: 'unusable', message: recipeContextReviewMessage('unusable') };
  }

  // The session is created ONLY from a CURRENT plan whose BOTH identities match
  // what the server just proved: the echoed request id and the current context
  // binding. There is no acceptance and no authority in the result.
  const created = createRecipeContextReviewSession({
    reconciliation: plan.reconciliation,
    expected: {
      requestId,
      contextBinding: (interpreted.data as Record<string, unknown>)['context_binding'],
    },
  });
  if (!created.ok) {
    return { ok: false, code: 'stale', message: recipeContextReviewMessage('stale') };
  }
  return { ok: true, session: created.session };
}

/**
 * Generation sequencing for overlapping runs.
 *
 * `begin` mints a new generation and returns it. `isCurrent` is false for any
 * older generation, so an older completion can be dropped instead of replacing
 * newer state. `invalidate` retires every in-flight run (used when the recipe,
 * the session, or the review is reset).
 */
export interface RecipeContextReviewRunner {
  begin(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
  readonly generation: number;
}

export function createRecipeContextReviewRunner(): RecipeContextReviewRunner {
  let generation = 0;
  return {
    begin(): number {
      generation += 1;
      return generation;
    },
    isCurrent(token: number): boolean {
      return token === generation;
    },
    invalidate(): void {
      generation += 1;
    },
    get generation(): number {
      return generation;
    },
  };
}

/**
 * An opaque, bounded, memory-only instance token for one review session.
 *
 * It is deliberately NOT a path, URL, file name or recipe id: it carries no
 * meaning a caller could forge into a location, and it is never persisted.
 */
export function createRecipeContextInstanceToken(random: () => number = Math.random): string {
  const sample = Math.floor(Math.abs(random()) * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `ai4d2-${sample}`;
}

/** A bounded request id for one run. Never derived from user or recipe content. */
export function createRecipeContextRequestId(
  random: () => number = Math.random,
  now: number = Date.now()
): string {
  const sample = Math.floor(Math.abs(random()) * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `ai4d2-req-${now.toString(36)}-${sample}`;
}