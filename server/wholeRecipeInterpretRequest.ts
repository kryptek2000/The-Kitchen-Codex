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

import { deriveRecipeContextSourceBasis } from './recipeContextDerivation';
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

  // --- SERVER-SIDE DERIVATION (canonical owner, reused) --------------------
  // This module consumes the ONE server owner's canonical PRE-SELECTION basis:
  // every bounded ingredient row plus every bounded instruction line, read by
  // the SAME bounded read AI-4 uses. AI-4 then projects its historical 12-target
  // envelope from that same basis; 9B projects the whole recipe from it.
  //
  // The result is deliberately NOT AI-4's capped envelope: treating that
  // historical 12-row selection as the universe of understandable ingredients
  // made every 13-25 target 9B request fail `unknown_line_ref` (I-01).
  const derived = deriveRecipeContextSourceBasis({
    recipe: toAdaptableRecipeSource(request),
    instructions: request.instructions.map((instruction) => ({ text: instruction.text })),
  });
  if (derived.ok === false) return { ok: false, code: 'invalid_recipe' };

  const basis = derived.basis;
  const ingredientsByRef = new Map(basis.ingredients.map((row) => [row.line_ref, row]));

  // Server-adapted structured quantity/unit, keyed by the SAME canonical ref.
  // Sourced from the server adaptation (which validated the authored source),
  // never from client-supplied semantics.
  const authoredByRef = new Map(
    derived.adapted.adapted.map((row) => [
      row.line_ref,
      {
        amount: typeof row.ingredient.amount === 'number' && Number.isFinite(row.ingredient.amount)
          ? row.ingredient.amount
          : undefined,
        unit: typeof row.ingredient.unit === 'string' && row.ingredient.unit.trim().length > 0
          ? row.ingredient.unit.trim().slice(0, 60)
          : undefined,
      },
    ]),
  );

  const issueKindByRef = new Map<string, AiResolutionIssueKind>(
    request.targets.map((target) => [target.line_ref, target.issue_kind as AiResolutionIssueKind]),
  );

  // --- WHOLE RECIPE: every bounded ingredient row, in AUTHORED order --------
  // Deterministic evidence is attached where the canonical read found it, and is
  // simply absent otherwise. A missing phrase hit never suppresses a row.
  const ingredientRows: Array<{
    line_ref: string;
    source_text: string;
    authored_amount?: number;
    authored_unit?: string;
    food_semantics?: string;
    instruction_evidence: Array<{ instruction_line_ref: string; evidence: string }>;
  }> = [];

  for (const row of basis.ingredients) {
    const authored = authoredByRef.get(row.line_ref);
    ingredientRows.push({
      line_ref: row.line_ref,
      source_text: row.source_text,
      ...(authored?.amount !== undefined ? { authored_amount: authored.amount } : {}),
      ...(authored?.unit !== undefined ? { authored_unit: authored.unit } : {}),
      ...(row.food_semantics !== undefined ? { food_semantics: row.food_semantics } : {}),
      instruction_evidence: basis.evidence
        .filter((entry) => entry.subject_ref === row.line_ref)
        .map((entry) => ({
          instruction_line_ref: entry.instruction_line_ref,
          evidence: entry.evidence,
        })),
    });
  }

  // --- TARGET RECONCILIATION: opaque refs only ------------------------------
  const targetRows: Array<{ line_ref: string; issue_kind?: AiResolutionIssueKind }> = [];
  for (const target of request.targets) {
    // An unknown or stale ref fails the whole request: the client cannot invent
    // a row, and cannot silently resolve against something it does not own.
    if (!ingredientsByRef.has(target.line_ref)) return { ok: false, code: 'unknown_line_ref' };
    const issueKind = issueKindByRef.get(target.line_ref);
    targetRows.push({
      line_ref: target.line_ref,
      ...(issueKind !== undefined ? { issue_kind: issueKind } : {}),
    });
  }

  const requestId = derivedRequestId(request);
  const built = buildWholeRecipeDerivedContext({
    request,
    requestId,
    ingredients: ingredientRows,
    targets: targetRows,
    instructions: request.instructions.map((instruction) => ({ text: instruction.text })),
  });
  if (built.ok === false) return { ok: false, code: built.code };

  return { ok: true, request, context: built.context };
}

export { WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION };