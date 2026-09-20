/**
 * The Kitchen Codex — application-layer AI-assisted USDA resolution.
 *
 * Orchestrates the optional AI resolver and feeds its ADVISORY output back
 * through the pinned local USDA catalog + the genuine deterministic confidence
 * contract. The AI never supplies nutrition authority: it only contributes
 * interpretation + candidate search phrases.
 *
 * RESILIENCE: any provider failure degrades to the existing deterministic +
 * manual-search workflow with a bounded message. Nothing here writes.
 */

import type { NetworkAdapter } from './adapters/NetworkAdapter';
import { buildAiSelectionRequestOptions } from './aiSelection';
import {
  buildAiResolutionRequestRows,
  sanitizeAiResolutionResponse,
  type AiResolutionSuggestion,
} from '../core/nutritionV2/aiResolution';
import {
  aiResolutionEligibleRows,
  resolveFoodsFromAiSuggestions,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type AiResolveOutcome,
  type Phase4Row,
} from '../core/nutritionV2/phase4';
import { ingredientMeasurement } from '../core/nutritionV2/phase4';

export const NUTRITION_RESOLVE_ENDPOINT = '/api/nutrition/resolve-ingredients';

/** Fixed, bounded, user-facing messages (never raw provider/exception text). */
export const AI_RESOLUTION_UNAVAILABLE_MESSAGE =
  'AI assistance is unavailable. You can continue with USDA search manually.';
export const AI_RESOLUTION_INVALID_MESSAGE =
  'AI assistance returned an unusable response. You can continue with USDA search manually.';

export interface AiResolutionRequestResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly suggestions: ReadonlyArray<AiResolutionSuggestion>;
  readonly aiAttempted: boolean;
}

/** Builds the bounded request rows from unresolved working rows. */
function buildRequestRows(
  rows: ReadonlyArray<Phase4Row>,
  adapted: ReadonlyArray<AdaptedIngredient>
): ReturnType<typeof buildAiResolutionRequestRows> {
  const adaptedByRef = new Map(adapted.map((entry) => [entry.line_ref, entry]));
  const input = rows.map((row) => {
    const entry = adaptedByRef.get(row.line_ref);
    const measurement = entry ? ingredientMeasurement(entry) : undefined;
    return {
      line_ref: row.line_ref,
      ingredient_text: row.original_text || row.query,
      normalized_text: row.query,
      amount: measurement?.amount ?? undefined,
      unit: measurement?.raw_unit,
      reason: row.outcome,
    };
  });
  return buildAiResolutionRequestRows(input);
}

/**
 * Requests advisory AI interpretation for the given unresolved rows. Never
 * throws; a provider failure returns a bounded unavailable message.
 */
export async function requestAiIngredientResolution(args: {
  readonly network: NetworkAdapter;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
}): Promise<AiResolutionRequestResult> {
  const requestRows = buildRequestRows(aiResolutionEligibleRows(args.rows), args.adapted);
  if (requestRows.length === 0) {
    return { ok: false, message: 'Nothing unresolved to resolve.', suggestions: Object.freeze([]), aiAttempted: false };
  }

  let response;
  try {
    response = await args.network.post<{ ok?: boolean; suggestions?: unknown }>(
      NUTRITION_RESOLVE_ENDPOINT,
      { ingredients: requestRows },
      await buildAiSelectionRequestOptions()
    );
  } catch {
    return { ok: false, message: AI_RESOLUTION_UNAVAILABLE_MESSAGE, suggestions: Object.freeze([]), aiAttempted: true };
  }

  if (!response || response.ok !== true) {
    return { ok: false, message: AI_RESOLUTION_UNAVAILABLE_MESSAGE, suggestions: Object.freeze([]), aiAttempted: true };
  }

  // DEFENSE IN DEPTH: re-sanitize the server response against the exact requested
  // line_refs. A structurally invalid payload is rejected whole.
  const sanitized = sanitizeAiResolutionResponse(
    { version: 1, suggestions: response.data?.suggestions },
    { allowedLineRefs: requestRows.map((row) => row.line_ref) }
  );
  if (!sanitized.ok) {
    return { ok: false, message: AI_RESOLUTION_INVALID_MESSAGE, suggestions: Object.freeze([]), aiAttempted: true };
  }

  return { ok: true, suggestions: sanitized.suggestions, aiAttempted: true };
}

export interface AiResolutionRunResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly aiAttempted: boolean;
  readonly outcome: AiResolveOutcome;
}

/**
 * Full AI-assisted resolution: request advisory suggestions, then resolve them
 * against the genuine pinned catalog + deterministic confidence contract.
 */
export async function resolveUnresolvedRowsWithAi(args: {
  readonly network: NetworkAdapter;
  readonly session: AdvancedNutritionSession;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
}): Promise<AiResolutionRunResult> {
  const requested = await requestAiIngredientResolution(args);
  if (!requested.ok) {
    return {
      ok: false,
      message: requested.message ?? AI_RESOLUTION_UNAVAILABLE_MESSAGE,
      aiAttempted: requested.aiAttempted,
      outcome: Object.freeze({ candidates: Object.freeze([]), unresolved: Object.freeze([]), auto_count: 0 }),
    };
  }
  const outcome = resolveFoodsFromAiSuggestions({
    session: args.session,
    rows: args.rows,
    adapted: args.adapted,
    suggestions: requested.suggestions,
  });
  return { ok: true, aiAttempted: true, outcome };
}
