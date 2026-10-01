/**
 * The Kitchen Codex — Advanced Nutrition AI-4D1: internal server-side
 * reconciliation adapter.
 *
 * PURE, OFFLINE, PROVIDER-FREE, INTERNAL. There is deliberately NO HTTP route and
 * NO rate limiter for AI-4D1: no UI consumes a reconciliation yet, so an endpoint
 * would be attack surface with no consumer. This adapter exists so the
 * reconciliation is exercised against the SAME server-derived context the
 * transport used, and so nothing else in the repository re-implements that
 * derivation.
 *
 * FLOW
 *   untrusted reconciliation input
 *     -> closed-key validation
 *     -> the ONE deterministic derivation owner
 *        (adaptRecipe -> AI-4B extraction -> AI-4C request + model_input_binding)
 *     -> the pure reconciliation core (strict wire read, request correlation,
 *        whole-proposal freshness, inert review classification)
 *
 * AUTHORITY BOUNDARY
 *   - The caller supplies AUTHORED RECIPE SOURCE DATA plus the untrusted wire and
 *     the request id this reconciliation is answering. It cannot supply a context,
 *     an envelope, a binding, or the current line refs: all of those are derived
 *     here.
 *   - The request version is the RELEASED constant, never a caller field, so no
 *     accepted-and-ignored protocol field is introduced.
 *   - No provider call, no clock, no randomness, no persistence, no Apply, no
 *     state mutation, no suppression, no AI-3 gating.
 */
import { isPlainObject } from '../src/core/nutritionV2/schema.js';
import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from '../src/core/nutritionV2/aiRecipeContextRequest.js';
import { reconcileRecipeContext } from '../src/core/nutritionV2/aiRecipeContextReconcile.js';
import { deriveRecipeContextModelInput } from './recipeContextDerivation.js';

/**
 * Closed reconciliation-request keys. A `context`/`envelope`/`binding`/`line_refs`
 * key is therefore refused, exactly as in the AI-4C transport.
 */
const RECONCILE_REQUEST_KEYS: ReadonlySet<string> = new Set([
  'wire',
  'expected_request_id',
  'recipe',
  'instructions',
  'recipe_instance',
]);

export type RecipeContextReconcileServerFailureCode =
  | 'invalid_input'
  | 'invalid_context'
  | 'invalid_wire'
  | 'request_mismatch'
  | 'stale_context';

export type RecipeContextReconcileServerResult =
  | ReturnType<typeof reconcileRecipeContext>
  | { readonly ok: false; readonly code: RecipeContextReconcileServerFailureCode };

/**
 * Reconciles an untrusted AI-4C wire against the CURRENT server-derived context.
 *
 * Never throws. A failure is always one of the five bounded codes, so no provider
 * text, stack trace, hidden prompt, credential or filesystem path can reach a
 * caller — there is no provider involved in this path at all.
 */
export function reconcileRecipeContextOnServer(rawBody: unknown): RecipeContextReconcileServerResult {
  if (!isPlainObject(rawBody)) return { ok: false, code: 'invalid_input' };
  for (const key of Object.keys(rawBody)) {
    if (!RECONCILE_REQUEST_KEYS.has(key)) return { ok: false, code: 'invalid_input' };
  }
  if (!('wire' in rawBody) || !('recipe' in rawBody)) {
    return { ok: false, code: 'invalid_input' };
  }

  const expectedRequestId = rawBody['expected_request_id'];
  if (typeof expectedRequestId !== 'string' || expectedRequestId.trim().length === 0) {
    return { ok: false, code: 'invalid_input' };
  }

  // The request id used for the CURRENT derivation is a bounded transport
  // identity, NOT the expected id: the binding must be computed from the current
  // context alone, and correlation is then proven by equality in the core.
  const derived = deriveRecipeContextModelInput({
    recipe: rawBody['recipe'],
    instructions: rawBody['instructions'],
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: 'ai4d1-current',
    recipeInstance: rawBody['recipe_instance'],
  });
  if (!derived.ok) {
    // The CURRENT context could not be derived. `invalid_recipe` (authored source
    // data) and the request-contract codes are mapped honestly onto the two
    // caller-visible outcomes: an unusable current context, or an unusable input.
    // (Non-strict narrowing: the boolean discriminant does not narrow, so the
    // bounded code is read through an explicit accessor.)
    const code = (derived as { code: string }).code;
    if (
      code === 'unsupported_request_version' ||
      code === 'invalid_request_id' ||
      code === 'invalid_context'
    ) {
      return { ok: false, code: 'invalid_input' };
    }
    return { ok: false, code: 'invalid_context' };
  }

  return reconcileRecipeContext({
    wire: rawBody['wire'],
    expectedRequestId,
    current: {
      context_binding: derived.request.model_input_binding,
      targets: derived.request.provider_request.targets.map((target) => ({
        line_ref: target.line_ref,
        source_text: target.source_text,
      })),
    },
  });
}
