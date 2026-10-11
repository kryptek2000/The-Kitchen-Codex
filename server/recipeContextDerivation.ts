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
import {
  extractRecipeContext,
  readRecipeContextSourceBasis,
} from '../src/core/nutritionV2/phase4/recipeContextExtraction.js';
import {
  buildAiRecipeContextRequest,
  type AiRecipeContextRequestContext,
} from '../src/core/nutritionV2/aiRecipeContextRequest.js';
import type { AdaptedRecipe } from '../src/core/nutritionV2/phase4/adapt.js';
import type {
  RecipeContextExtraction,
  RecipeContextSourceBasis,
} from '../src/core/nutritionV2/phase4/recipeContextExtraction.js';

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
 * Derivation-ONLY entry point (Phase 9B-1).
 *
 * Runs the SAME canonical chain as `deriveRecipeContextModelInput`
 * (adaptRecipe -> extractRecipeContext) and returns the deterministic
 * derivation ONLY. It deliberately does NOT build an AI-4C request, does NOT
 * produce an AI-4 `model_input_binding`, and does NOT consume or emit any
 * AI-4 review/proposal/acceptance state.
 *
 * WHY THIS EXISTS: this module is the ONE server owner of the AI-4B extraction
 * (`tests/security/advancedNutritionAi4bIsolation.test.ts` enforces that only
 * this file may reach `extractRecipeContext`). A second semantic wire that needs
 * the same derivation must consume the owner rather than reimplement the chain
 * or reach past it. Phase 9B-1 is that second consumer: it reuses the
 * DETERMINISTIC DERIVATION and builds its own distinct materialization and its
 * own freshness binding, so the two contracts are never conflated.
 *
 * Never throws. Every failure is a bounded code, and no failure path can
 * produce a partial derivation.
 */
export function deriveRecipeContextExtractionOnly(input: {
  readonly recipe: unknown;
  readonly instructions?: unknown;
}): { readonly ok: true; readonly adapted: AdaptedRecipe; readonly extraction: RecipeContextExtraction } | { readonly ok: false; readonly code: 'invalid_recipe' } {
  const adapted = adaptRecipe(input.recipe);
  if (adapted.ok === false) return { ok: false, code: 'invalid_recipe' };

  const extracted = extractRecipeContext({
    recipe: adapted.recipe,
    instructions: input.instructions,
  });
  if (extracted.ok === false) return { ok: false, code: 'invalid_recipe' };

  return { ok: true, adapted: adapted.recipe, extraction: extracted.extraction };
}

/**
 * Derives the WHOLE-RECIPE canonical source basis for Phase 9B (Phase 9B-2B-R1).
 *
 * Runs `adaptRecipe` and then reads the canonical PRE-SELECTION basis through
 * `readRecipeContextSourceBasis` — the same bounded read `extractRecipeContext`
 * itself performs, before AI-4's historical `MAX_RECIPE_CONTEXT_TARGETS` (12)
 * budget is applied.
 *
 * WHY THIS EXISTS (I-01)
 *   The 9B whole-recipe request wire accepts up to `MAX_WHOLE_RECIPE_TARGETS`
 *   (25) targets, but the AI-4B extraction envelope exposes at most 12. Treating
 *   that AI-4 envelope selection as the universe of ingredients 9B may understand
 *   made every 13–25 target request fail with `unknown_line_ref`. That was a real
 *   contract/capability mismatch.
 *
 *   The repair does NOT raise AI-4's cap and does NOT reimplement the read. It
 *   projects the SAME canonical bounded basis a second way: AI-4 keeps its
 *   historical capped envelope, and 9B receives the whole bounded recipe.
 *
 *   This module remains the ONE server owner of that derivation. No server module
 *   reaches past it into the low-level extractor, and there is exactly one
 *   underlying normalization / line-ref / subject-detection implementation.
 *
 * Never throws. Every failure is a bounded code, and no failure path can produce
 * a partial basis.
 */
export function deriveRecipeContextSourceBasis(input: {
  readonly recipe: unknown;
  readonly instructions?: unknown;
}): { readonly ok: true; readonly adapted: AdaptedRecipe; readonly basis: RecipeContextSourceBasis } | { readonly ok: false; readonly code: 'invalid_recipe' } {
  const adapted = adaptRecipe(input.recipe);
  if (adapted.ok === false) return { ok: false, code: 'invalid_recipe' };

  const read = readRecipeContextSourceBasis({
    recipe: adapted.recipe,
    instructions: input.instructions,
  });
  if (read.ok === false) return { ok: false, code: 'invalid_recipe' };

  return { ok: true, adapted: adapted.recipe, basis: read.basis };
}

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
