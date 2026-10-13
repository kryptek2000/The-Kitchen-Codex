/**
 * The Kitchen Codex — Phase 9B-3B.
 * AUTHENTICATED SEMANTIC-TO-USDA ADVISORY BRIDGE.
 *
 * WHAT THIS IS. The narrow link between "SHISO understood the recipe" and "The
 * Kitchen Codex searches its authenticated USDA catalog". It takes an already
 * ISSUED whole-recipe semantic result, proves it with the real Phase 9B-3A
 * consumer, and converts the authenticated canonical semantics into the EXISTING
 * bounded `AiResolutionSuggestion[]` advisory transport.
 *
 * IT REUSES; IT DOES NOT REINVENT. Every step below is a released contract:
 *   - Phase 9B-3A `consumeAuthenticatedWholeRecipeSemantics` — the MAC gate
 *   - `sanitizeAiAdvancedInterpretationResponse` — the strict read
 *   - `adaptAiAdvancedInterpretationsForResolution` — the adapter
 *   - `withholdNonDeterministicAdaptations` — ambiguity/alternatives withholding
 * There is no second sanitizer, matcher, catalog, threshold, or confidence rule.
 *
 * WHY IT DOES NOT RUN THE USDA MATCHER. The USDA catalog, the Phase 4 session
 * and the deterministic matchers are BROWSER-side (the bundle is fetched and
 * authenticated in the browser; no server module imports them). This module is
 * server-side because the receipt key is process-scoped. The two CANNOT meet in
 * one module, and importing server signing authority into browser code is
 * forbidden. So the bridge produces the advisory TRANSPORT, and the existing
 * browser-side pipeline consumes it through the existing resolver. The offline
 * integration proof wires the two together against a real catalog.
 *
 * WHAT IT CANNOT DO. It never selects an FDC id, catalog record, record digest,
 * gram weight, portion weight, nutrient, calorie, matching threshold, automatic
 * acceptance, Apply, or persistence. Those remain with the existing
 * deterministic matching, portion, review and calculation systems.
 */

import { consumeAuthenticatedWholeRecipeSemantics } from './wholeRecipeSemanticConsumption.js';
import { materializeWholeRecipeInterpretationContext } from './wholeRecipeInterpretRequest.js';
import {
  AI_ADVANCED_CONTRACT_VERSION,
  adaptAiAdvancedInterpretationsForResolution,
  sanitizeAiAdvancedInterpretationResponse,
  withholdNonDeterministicAdaptations,
  type AiAdvancedAuthoritativeAmountObservation,
  type AiAdvancedIngredientInterpretation,
  type AiAdvancedWithheldInterpretation,
} from '../src/core/nutritionV2/aiAdvanced.js';
import type {
  AiResolutionIssueKind,
  AiResolutionSuggestion,
} from '../src/core/nutritionV2/aiResolution.js';

// ---------------------------------------------------------------------------
// Result contracts
// ---------------------------------------------------------------------------

export type SemanticUsdaBridgeFailureCode =
  | 'invalid_request'
  | 'stale_context'
  | 'target_mismatch'
  | 'unauthenticated'
  | 'adaptation_failed';

/**
 * The closed, bounded transport contract that crosses the server -> browser
 * boundary in a future 3C.
 *
 * It carries ADVISORY SEARCH WORDING ONLY. There is deliberately no field for an
 * FDC id, catalog record, record digest, gram value, portion index, nutrient,
 * confidence threshold, Apply token, or persistence permission, and the strict
 * resolver sanitizer (`sanitizeAiResolutionResponse`) rejects any such key.
 */
export interface AuthenticatedAdvisoryTransport {
  readonly ok: true;
  readonly authority: 'authenticated_advisory_search_suggestions';
  /** Server-verified execution identity. Advisory provenance only. */
  readonly provider_id: string;
  readonly model_id: string;
  readonly operation_id: string;
  readonly context_binding: string;
  readonly request_id: string;
  readonly suggestions: ReadonlyArray<AiResolutionSuggestion>;
  /** Withheld by the released ambiguity/alternatives rules. */
  readonly withheld: ReadonlyArray<AiAdvancedWithheldInterpretation>;
  /** Lines whose AI quantity interpretation contradicted the authored source. */
  readonly contradicted: ReadonlyArray<string>;
  /** Lines with no usable primary food identity or search wording. */
  readonly inadaptable: ReadonlyArray<string>;
}

export type SemanticUsdaBridgeResult =
  | AuthenticatedAdvisoryTransport
  | { readonly ok: false; readonly code: SemanticUsdaBridgeFailureCode; readonly suggestions: readonly [] };

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/**
 * Bridges an AUTHENTICATED whole-recipe semantic result into bounded advisory
 * USDA search suggestions.
 *
 * The caller supplies the ORIGINAL whole-recipe request (so the server re-derives
 * the context itself) and the issued envelope (treated as fully HOSTILE).
 *
 * NEVER THROWS. Every failure is a bounded code and yields an EMPTY suggestion
 * list. A caller-supplied object that merely *looks* like a verified result can
 * never reach the adapter: the real Phase 9B-3A consumer performs the genuine
 * MAC verification first, and nothing happens on any other path.
 *
 * `authoritativeByLineRef` is the caller's DETERMINISTIC amount observations. It
 * is optional and is never derived from provider output; when supplied, the
 * released `reconcileAiAdvancedAmount` compares the AI quantity echo against it
 * and drops contradicting lines.
 */
export function bridgeAuthenticatedSemanticsToAdvisorySuggestions(input: {
  readonly rawRequest: unknown;
  readonly issuedEnvelope: unknown;
  readonly authoritativeByLineRef?: ReadonlyMap<string, AiAdvancedAuthoritativeAmountObservation>;
}): SemanticUsdaBridgeResult {
  const failure = (code: SemanticUsdaBridgeFailureCode): SemanticUsdaBridgeResult => ({
    ok: false,
    code,
    suggestions: Object.freeze([]) as readonly [],
  });

  // --- 1. AUTHENTICATION. The real 3A consumer, the real process authority. ---
  // Nothing below this line runs unless a genuine wsem1 MAC verified.
  const consumption = consumeAuthenticatedWholeRecipeSemantics(
    input.rawRequest,
    input.issuedEnvelope
  );
  if (consumption.ok !== true) return failure(consumption.code);

  // --- 2. recover the AUTHENTICATED canonical rows -------------------------
  // The receipt authenticates the whole submitted subject atomically, so the
  // submitted rows ARE the authenticated material. They are re-read here through
  // the RELEASED strict sanitizer (not a new validator) against the SERVER'S own
  // re-derived line refs, so only canonical rows can reach the adapter.
  //
  // Hostile shapes are handled structurally, never trusted by TypeScript type:
  // the envelope and its rows are re-checked for own, plain, array shape before
  // anything is indexed.
  const materialized = materializeWholeRecipeInterpretationContext(input.rawRequest);
  if (materialized.ok === false) return failure('invalid_request');
  const lineRefs = materialized.context.provider_context.targets.map((target) => target.line_ref);

  const envelope = input.issuedEnvelope as Record<string, unknown> | null;
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return failure('invalid_request');
  }
  const rowsRaw = readOwnArray(envelope, 'semantic_response');
  if (rowsRaw === undefined) return failure('invalid_request');

  const sanitized = sanitizeAiAdvancedInterpretationResponse(
    { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: rowsRaw },
    { allowedLineRefs: lineRefs }
  );
  if (sanitized.ok !== true) return failure('adaptation_failed');
  const interpretations = sanitized.interpretations as ReadonlyArray<AiAdvancedIngredientInterpretation>;

  // --- 3. the RELEASED adapter (amount reconciliation + suggestion mapping) ---
  const adapted = adaptAiAdvancedInterpretationsForResolution({
    interpretations,
    ...(input.authoritativeByLineRef !== undefined
      ? { authoritativeByLineRef: input.authoritativeByLineRef }
      : {}),
  });

  // --- 4. the RELEASED ambiguity / alternatives withholding ------------------
  // Purely subtractive: an ambiguous or alternative-reading line never silently
  // selects one reading.
  const eligible = withholdNonDeterministicAdaptations({ interpretations, outcome: adapted });

  // --- 5. emit the bounded advisory transport ------------------------------
  return Object.freeze({
    ok: true as const,
    authority: 'authenticated_advisory_search_suggestions' as const,
    provider_id: consumption.provider_id,
    model_id: consumption.model_id,
    operation_id: consumption.operation_id,
    context_binding: consumption.context_binding,
    request_id: consumption.request_id,
    suggestions: Object.freeze([...eligible.suggestions]),
    withheld: Object.freeze([...eligible.withheld]),
    contradicted: Object.freeze([...adapted.contradicted]),
    inadaptable: Object.freeze([...adapted.inadaptable]),
  });
}

/** Own, non-inherited, non-accessor array read. Mirrors the 3A discipline. */
function readOwnArray(target: Record<string, unknown>, key: string): unknown[] | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return undefined;
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) return undefined;
  const value = descriptor.value;
  return Array.isArray(value) ? value : undefined;
}

/**
 * Filters advisory suggestions down to the rows the caller's trusted issue kinds
 * actually permit the DETERMINISTIC food resolver to act on.
 *
 * Purely subtractive and kind-scoped. `needs_amount` rows are excluded from FOOD
 * identity resolution because their amount authority belongs to the existing
 * amount resolver, and vice versa. This is a projection over already-authenticated
 * suggestions; it can only REMOVE entries, never add or rewrite one.
 */
export function selectFoodIdentitySuggestions(
  suggestions: ReadonlyArray<AiResolutionSuggestion>,
  issueKinds?: Readonly<Record<string, AiResolutionIssueKind>>
): ReadonlyArray<AiResolutionSuggestion> {
  if (issueKinds === undefined) return suggestions;
  return Object.freeze(suggestions.filter((s) => issueKinds[s.line_ref] !== 'needs_amount'));
}
