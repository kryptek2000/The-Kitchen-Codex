/**
 * The Kitchen Codex — Advanced Nutrition AI-4: the ONE deterministic
 * recipe-context derivation owner (server side).
 *
 * PURE, OFFLINE, PROVIDER-FREE. This module is the single implementation of the
 * whole-recipe context derivation:
 *
 *   adaptRecipe (real Phase 4 narrow adaptation; SERVER-computed line refs)
 *     -> extractRecipeContext (AI-4B deterministic evidence + envelope)
 *     -> buildAiRecipeContextRequest (AI-4C bounded request + model_input_binding)
 *
 * WHY THIS EXISTS
 *   AI-4C is the transport that must send context; AI-4D1 is the reconciler that
 *   must re-derive the CURRENT context to decide whether a returned proposal is
 *   still current. If each side implemented that chain itself, the two could
 *   drift — and a freshness check computed over a differently-derived context
 *   would be meaningless. So there is exactly ONE owner and both consume it.
 *
 *   The AI-4C repair already established the rule this module protects:
 *   DETERMINISTIC CODE CHOOSES THE CONTEXT THE MODEL SEES. Deriving the context
 *   is therefore not something any caller may influence, and it is not something
 *   two phases may each do differently.
 *
 * AUTHORITY BOUNDARY
 *   - No provider import, no network, no clock, no randomness, no persistence, no
 *     UI, no state mutation: this module only DERIVES.
 *   - It returns the AI-4B extraction AND the AI-4C request context (which owns
 *     the ONE `model_input_binding`), so no second binding or digest can appear.
 *   - It grants no authority. Its result is evidence plus a freshness binding.
 */

import { adaptRecipe } from '../src/core/nutritionV2/phase4/adapt.js';
import { extractRecipeContext } from '../src/core/nutritionV2/phase4/recipeContextExtraction.js';
import {
  buildAiRecipeContextRequest,
  type AiRecipeContextRequestContext,
} from '../src/core/nutritionV2/aiRecipeContextRequest.js';
import type { AdaptedRecipe } from '../src/core/nutritionV2/phase4/adapt.js';
import type { RecipeContextExtraction } from '../src/core/nutritionV2/phase4/recipeContextExtraction.js';

/**
 * Bounded derivation failure codes. `invalid_recipe` covers both the adaptation
 * and the deterministic extraction: in both cases the AUTHORED SOURCE DATA could
 * not be turned into a bounded context, and in neither case may a caller-supplied
 * value stand in for it.
 */
export type RecipeContextDerivationCode =
  | 'invalid_recipe'
  | 'unsupported_request_version'
  | 'invalid_request_id'
  | 'invalid_context'
  | 'no_targets'
  | 'too_many_targets'
  | 'request_too_large';

export type RecipeContextDerivationResult =
  | {
      readonly ok: true;
      /** The narrow adapted recipe (real production adaptation). */
      readonly adapted: AdaptedRecipe;
      /** The AI-4B deterministic extraction: envelope + evidence. */
      readonly extraction: RecipeContextExtraction;
      /** The AI-4C bounded request: provider payload, allowed refs, binding. */
      readonly request: AiRecipeContextRequestContext;
    }
  | { readonly ok: false; readonly code: RecipeContextDerivationCode };

/**
 * Derives the whole-recipe AI-4 context from AUTHORED RECIPE SOURCE DATA.
 *
 * Never throws. Every failure is a bounded code, and no failure path can produce
 * a partial context: if any step refuses, there is no context at all.
 */
export function deriveRecipeContextModelInput(input: {
  readonly recipe: unknown;
  readonly instructions?: unknown;
  readonly requestVersion: unknown;
  readonly requestId: unknown;
  readonly recipeInstance?: unknown;
}): RecipeContextDerivationResult {
  const adapted = adaptRecipe(input.recipe);
  if (!adapted.ok) return { ok: false, code: 'invalid_recipe' };

  const extracted = extractRecipeContext({
    recipe: adapted.recipe,
    instructions: input.instructions,
  });
  if (!extracted.ok) return { ok: false, code: 'invalid_recipe' };

  const built = buildAiRecipeContextRequest({
    requestVersion: input.requestVersion,
    requestId: input.requestId,
    recipeInstance: input.recipeInstance,
    context: extracted.extraction.envelope,
  });
  if (!built.ok) {
    return { ok: false, code: (built as { code: RecipeContextDerivationCode }).code };
  }

  return {
    ok: true,
    adapted: adapted.recipe,
    extraction: extracted.extraction,
    request: built.context,
  };
}
