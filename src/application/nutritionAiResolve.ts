/**
 * The Kitchen Codex — application-layer AI-assisted USDA resolution.
 *
 * Orchestrates the optional AI resolver and feeds its ADVISORY output back
 * through the pinned local USDA catalog + the genuine deterministic confidence
 * contract. The AI never supplies nutrition authority: it only contributes
 * interpretation + candidate search phrases + a bounded count-identity hint.
 *
 * RESILIENCE: any provider failure degrades to the existing deterministic +
 * manual-search workflow with a bounded message. Nothing here writes.
 */

import type { NetworkAdapter } from './adapters/NetworkAdapter';
import { buildAiSelectionRequestOptions } from './aiSelection';
import {
  buildAiResolutionRequestRows,
  sanitizeAiResolutionResponse,
  type AiResolutionIssueKind,
  type AiResolutionSuggestion,
} from '../core/nutritionV2/aiResolution';
import {
  aiResolutionEligibleRows,
  resolveFoodsFromAiSuggestions,
  resolveAmountsFromAiSuggestions,
  ingredientMeasurement,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type AiAmountResolveOutcome,
  type AiResolveOutcome,
  type LiveRowState,
  type Phase4Row,
  type Phase4State,
} from '../core/nutritionV2/phase4';

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

export interface AiResolutionRequestArgs {
  readonly network: NetworkAdapter;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  /**
   * Trusted application issue classification by line ref. When present, ONLY
   * rows carrying a known actionable issue kind are sent, and the bounded kind
   * is passed to the resolver. When absent, the legacy unresolved-row filter is
   * used (back-compatible).
   */
  readonly issueKinds?: Readonly<Record<string, AiResolutionIssueKind>>;
}

/** Builds the bounded request rows from unresolved working rows. */
function buildRequestRows(
  rows: ReadonlyArray<Phase4Row>,
  adapted: ReadonlyArray<AdaptedIngredient>,
  issueKinds?: Readonly<Record<string, AiResolutionIssueKind>>
): ReturnType<typeof buildAiResolutionRequestRows> {
  const adaptedByRef = new Map(adapted.map((entry) => [entry.line_ref, entry]));
  const input = rows.map((row) => {
    const entry = adaptedByRef.get(row.line_ref);
    const measurement = entry ? ingredientMeasurement(entry) : undefined;
    const issueKind = issueKinds?.[row.line_ref];
    return {
      line_ref: row.line_ref,
      ingredient_text: row.original_text || row.query,
      normalized_text: row.query,
      amount: measurement?.amount ?? undefined,
      unit: measurement?.raw_unit,
      reason: row.outcome,
      ...(issueKind !== undefined ? { issue_kind: issueKind } : {}),
    };
  });
  return buildAiResolutionRequestRows(input);
}

/** Selects the rows the resolver is allowed to receive for this request. */
function requestableRows(
  args: AiResolutionRequestArgs
): ReadonlyArray<Phase4Row> {
  if (args.issueKinds === undefined) return aiResolutionEligibleRows(args.rows);
  return Object.freeze(args.rows.filter((row) => args.issueKinds?.[row.line_ref] !== undefined));
}

/**
 * Requests advisory AI interpretation for the given actionable rows. Never
 * throws; a provider failure returns a bounded unavailable message.
 */
export async function requestAiIngredientResolution(
  args: AiResolutionRequestArgs
): Promise<AiResolutionRequestResult> {
  const requestRows = buildRequestRows(
    requestableRows(args),
    args.adapted,
    args.issueKinds
  );
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

const EMPTY_FOOD_OUTCOME: AiResolveOutcome = Object.freeze({
  candidates: Object.freeze([]),
  unresolved: Object.freeze([]),
  auto_count: 0,
});

const EMPTY_AMOUNT_OUTCOME: AiAmountResolveOutcome = Object.freeze({
  resolved: Object.freeze([]),
  offers: Object.freeze([]),
  unresolved: Object.freeze([]),
  inconsistent: Object.freeze([]),
  auto_count: 0,
});

export interface AiResolutionRunResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly aiAttempted: boolean;
  /** Number of sanitized advisory suggestions accepted from the AI response. */
  readonly interpretedCount: number;
  /** Food-identity verification outcome (needs_match / review_suggested). */
  readonly outcome: AiResolveOutcome;
  /** Amount-interpretation verification outcome (needs_amount). */
  readonly amounts: AiAmountResolveOutcome;
}

export interface AiResolutionRunArgs extends AiResolutionRequestArgs {
  readonly session: AdvancedNutritionSession;
  /**
   * The SAME live projection that renders the ingredient list. Required for
   * needs_amount verification; optional for legacy food-identity-only callers.
   */
  readonly liveRows?: ReadonlyArray<LiveRowState>;
  readonly state?: Phase4State;
}

/**
 * Full AI-assisted resolution: request advisory suggestions, then verify them
 * against the genuine pinned catalog + deterministic contract. Food-identity
 * suggestions go through the confidence matcher; amount suggestions go through
 * the authenticated USDA count-portion contract. Neither grants authority.
 */
export async function resolveUnresolvedRowsWithAi(
  args: AiResolutionRunArgs
): Promise<AiResolutionRunResult> {
  const requested = await requestAiIngredientResolution(args);
  if (!requested.ok) {
    return {
      ok: false,
      message: requested.message ?? AI_RESOLUTION_UNAVAILABLE_MESSAGE,
      aiAttempted: requested.aiAttempted,
      interpretedCount: requested.suggestions.length,
      outcome: EMPTY_FOOD_OUTCOME,
      amounts: EMPTY_AMOUNT_OUTCOME,
    };
  }

  const issueKinds = args.issueKinds;
  const foodSuggestions = requested.suggestions.filter(
    (suggestion) => issueKinds?.[suggestion.line_ref] !== 'needs_amount'
  );
  const amountSuggestions = requested.suggestions.filter(
    (suggestion) => issueKinds?.[suggestion.line_ref] === 'needs_amount'
  );
  const foodRows =
    issueKinds === undefined
      ? args.rows
      : Object.freeze(args.rows.filter((row) => issueKinds[row.line_ref] !== 'needs_amount'));

  const outcome =
    foodSuggestions.length > 0
      ? resolveFoodsFromAiSuggestions({
          session: args.session,
          rows: foodRows,
          adapted: args.adapted,
          suggestions: foodSuggestions,
        })
      : EMPTY_FOOD_OUTCOME;
  const amounts =
    amountSuggestions.length > 0 && args.liveRows !== undefined && args.state !== undefined
      ? resolveAmountsFromAiSuggestions({
          session: args.session,
          rows: args.rows,
          adapted: args.adapted,
          liveRows: args.liveRows,
          state: args.state,
          suggestions: amountSuggestions,
        })
      : EMPTY_AMOUNT_OUTCOME;

  return {
    ok: true,
    aiAttempted: true,
    interpretedCount: requested.suggestions.length,
    outcome,
    amounts,
  };
}
