/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-1.
 * SERVER-SIDE whole-recipe semantic request materialization and derivation.
 *
 * SERVER OWNS DERIVATION.
 *   The browser sends AUTHORED RECIPE SOURCE DATA. It is untrusted request
 *   input. The server validates it, re-derives every ingredient row and every
 *   instruction reference from that source, reconciles the requested targets
 *   against what it derived, and computes the freshness binding. The client
 *   never supplies context, and never supplies a binding it could forge.
 *
 * REUSE, NOT CONFLATION.
 *   The deterministic DERIVATION MACHINERY is reused as-is:
 *       adaptRecipe -> AI-4B deterministic extraction
 *   The AI-4 MATERIALIZATION is deliberately NOT reused. AI-4's request wire,
 *   its `model_input_binding` payload, and its AI-4E origin receipt belong to a
 *   different contract, and pretending an AI-1 semantic wire is an AI-4
 *   recipe-context wire would mislabel the evidence. This module produces its
 *   own distinct, bounded semantic context and its own binding.
 *
 * PURE, OFFLINE, PROVIDER-FREE. No provider import, no network, no clock, no
 * randomness, no persistence, no UI, no state mutation. It derives a request
 * boundary only; it performs no provider call.
 *
 * AUTHORITY BOUNDARY
 *   - Grants no food identity, no FDC identity, no mass, no nutrients.
 *   - Grants no Apply, eligibility, persistence or selection authority.
 *   - `food_semantics` below is deterministic local phrase extraction, not a
 *     model output and not authority.
 *   - Issue kinds echo the existing application-owned closed vocabulary and are
 *     never identity authority.
 */

import { deriveRecipeContextExtractionOnly } from './recipeContextDerivation';
import type { AiResolutionIssueKind } from '../src/core/nutritionV2/aiResolution';
import {
  buildWholeRecipeDerivedContext,
  sanitizeWholeRecipeInterpretationRequest,
  WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
  type WholeRecipeDerivedInterpretationContext,
  type WholeRecipeDerivationFailure,
  type WholeRecipeInterpretationRequest,
  type WholeRecipeRequestFailure,
} from '../src/core/nutritionV2/aiWholeRecipeInterpretation';

export type WholeRecipeMaterializeFailure = WholeRecipeRequestFailure | WholeRecipeDerivationFailure;

export type WholeRecipeMaterializeResult =
  | {
      readonly ok: true;
      readonly request: WholeRecipeInterpretationRequest;
      readonly context: WholeRecipeDerivedInterpretationContext;
    }
  | { readonly ok: false; readonly code: WholeRecipeMaterializeFailure };

/** Deterministic fallback request id. Derived from the request only, never random. */
function derivedRequestId(request: WholeRecipeInterpretationRequest): string {
  if (request.request_id !== undefined) return request.request_id;
  const first = request.targets[0]?.line_ref ?? 'none';
  return `wr1:${request.targets.length}:${first}`;
}

/**
 * Materializes the authored source into the shape the derivation owners expect.
 *
 * This is the ONLY place authored source is converted for derivation. It maps
 * to the narrow `AdaptedRecipe` shape and deliberately carries NO title and NO
 * base servings (D3: withheld for this slice).
 */
function toAdaptableRecipeSource(request: WholeRecipeInterpretationRequest): unknown {
  return {
    ingredients: request.recipe.ingredients.map((ingredient) => ({
      name: ingredient.name,
      ...(ingredient.amount !== undefined ? { amount: ingredient.amount } : {}),
      ...(ingredient.unit !== undefined ? { unit: ingredient.unit } : {}),
    })),
  };
}

/**
 * Materializes a validated whole-recipe request into bounded, server-derived
 * model-visible context plus a freshness binding.
 *
 * Never throws. Every failure is a bounded code; no raw error text escapes.
 */
export function materializeWholeRecipeInterpretationContext(
  raw: unknown
): WholeRecipeMaterializeResult {
  const sanitized = sanitizeWholeRecipeInterpretationRequest(raw);
  if (sanitized.ok === false) return { ok: false, code: sanitized.code };
  const request = sanitized.request;

  // --- SERVER-SIDE DERIVATION (canonical owners, reused) --------------------
  // The ONE derivation owner runs adaptRecipe -> AI-4B extraction. This
  // module consumes its deterministic derivation and builds its OWN distinct
  // materialization and binding; it never touches AI-4's request wire,
  // model_input_binding, review proposal, or acceptance state.
  const extracted = deriveRecipeContextExtractionOnly({
    recipe: toAdaptableRecipeSource(request),
    instructions: request.instructions.map((instruction) => ({ text: instruction.text })),
  });
  if (extracted.ok === false) return { ok: false, code: 'invalid_recipe' };

  // --- TARGET RECONCILIATION: server-derived rows are the only source -------
  const derivedByRef = new Map(
    extracted.extraction.envelope.targets.map((target) => [target.line_ref, target]),
  );
  const issueKindByRef = new Map<string, AiResolutionIssueKind>(
    request.targets.map((target) => [target.line_ref, target.issue_kind as AiResolutionIssueKind]),
  );

  const derivedRows: Array<{
    line_ref: string;
    source_text: string;
    food_semantics?: string;
    instruction_evidence: Array<{ instruction_line_ref: string; evidence: string }>;
    issue_kind?: AiResolutionIssueKind;
  }> = [];

  for (const target of request.targets) {
    const derived = derivedByRef.get(target.line_ref);
    // An unknown or stale ref fails the whole request: the client cannot invent
    // a row, and cannot silently resolve against something it does not own.
    if (derived === undefined) return { ok: false, code: 'unknown_line_ref' };

    const issueKind = issueKindByRef.get(target.line_ref);
    derivedRows.push({
      line_ref: derived.line_ref,
      source_text: derived.source_text,
      ...(derived.food_semantics !== undefined ? { food_semantics: derived.food_semantics } : {}),
      instruction_evidence: extracted.extraction.signals
        .filter((signal) => signal.subjects.includes(derived.line_ref))
        .map((signal) => ({
          instruction_line_ref: signal.instruction_line_ref,
          evidence: signal.evidence,
        })),
      ...(issueKind !== undefined ? { issue_kind: issueKind } : {}),
    });
  }

  const requestId = derivedRequestId(request);
  const built = buildWholeRecipeDerivedContext({
    request,
    requestId,
    derivedRows,
    instructions: request.instructions.map((instruction) => ({ text: instruction.text })),
  });
  if (built.ok === false) return { ok: false, code: built.code };

  return { ok: true, request, context: built.context };
}

export { WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION };