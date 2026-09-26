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
  AI_ADVANCED_CONTRACT_VERSION,
  adaptAiAdvancedInterpretationsForResolution,
  sanitizeAiAdvancedInterpretationResponse,
  type AiAdvancedAuthoritativeAmountObservation,
  type AiAdvancedIngredientInterpretation,
} from '../core/nutritionV2/aiAdvanced';
import {
  isAiInterpretationAvailable,
  type NutritionCapabilities,
} from '../core/nutritionV2/nutritionCapabilities';
import {
  aiResolutionEligibleRows,
  resolveFoodsFromAiSuggestions,
  resolveAmountsFromAiSuggestions,
  resolveHouseholdsFromAiSuggestions,
  ingredientMeasurement,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type AiAmountResolveOutcome,
  type AiHouseholdResolveOutcome,
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

const EMPTY_HOUSEHOLD_OUTCOME: AiHouseholdResolveOutcome = Object.freeze({
  resolved: Object.freeze([]),
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
  /** Verified-household verification outcome (needs_amount). */
  readonly households: AiHouseholdResolveOutcome;
}

export interface AiResolutionRunArgs extends AiResolutionRequestArgs {
  readonly session: AdvancedNutritionSession;
  /**
   * The SAME live projection that renders the ingredient list. Required for
   * needs_amount verification; optional for legacy food-identity-only callers.
   */
  readonly liveRows?: ReadonlyArray<LiveRowState>;
  readonly state?: Phase4State;
  /**
   * Centralized Basic vs AI Advanced capability boundary. When supplied, a
   * capability set without `aiInterpretation` fails CLOSED before any network
   * call (Basic Nutrition stays fully available). When omitted, legacy behavior
   * is preserved.
   */
  readonly capabilities?: NutritionCapabilities;
  /**
   * Pre-sanitized canonical AI-Advanced interpretations. When supplied, the
   * network request is skipped entirely and the interpretations are adapted
   * into the SAME bounded transport shape, then verified by the SAME
   * deterministic pipeline. This is the architecture proof path: no provider is
   * required to exercise the canonical contract.
   */
  readonly interpretations?: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  /** Deterministic parse observations used to reconcile echoed amounts. */
  readonly authoritativeByLineRef?: ReadonlyMap<string, AiAdvancedAuthoritativeAmountObservation>;
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
  // CAPABILITY GATE (centralized, billing-independent): no AI capability means
  // no AI attempt at all. Deterministic/manual Advanced Nutrition is untouched.
  if (args.capabilities !== undefined && !isAiInterpretationAvailable(args.capabilities)) {
    return {
      ok: false,
      message: AI_RESOLUTION_UNAVAILABLE_MESSAGE,
      aiAttempted: false,
      interpretedCount: 0,
      outcome: EMPTY_FOOD_OUTCOME,
      amounts: EMPTY_AMOUNT_OUTCOME,
      households: EMPTY_HOUSEHOLD_OUTCOME,
    };
  }

  let suggestions: ReadonlyArray<AiResolutionSuggestion>;
  let aiAttempted: boolean;
  if (args.interpretations !== undefined) {
    // CANONICAL PATH: bounded, request-scoped adaptation of already-sanitized
    // canonical interpretations. No provider is called here. Defense in depth:
    // the supplied interpretations are re-sanitized against the request rows so
    // an authority-shaped or malformed injection can never reach adaptation.
    const allowedLineRefs = requestableRows(args).map((row) => row.line_ref);
    const allowed = new Set(allowedLineRefs);
    const sanitized = sanitizeAiAdvancedInterpretationResponse(
      {
        contract_version: AI_ADVANCED_CONTRACT_VERSION,
        interpretations: args.interpretations.filter((entry) => allowed.has(entry.line_ref)),
      },
      { allowedLineRefs }
    );
    if (!sanitized.ok) {
      return {
        ok: false,
        message: AI_RESOLUTION_INVALID_MESSAGE,
        aiAttempted: false,
        interpretedCount: 0,
        outcome: EMPTY_FOOD_OUTCOME,
        amounts: EMPTY_AMOUNT_OUTCOME,
        households: EMPTY_HOUSEHOLD_OUTCOME,
      };
    }
    const adapted = adaptAiAdvancedInterpretationsForResolution({
      interpretations: sanitized.interpretations,
      ...(args.authoritativeByLineRef !== undefined
        ? { authoritativeByLineRef: args.authoritativeByLineRef }
        : {}),
    });
    suggestions = adapted.suggestions;
    aiAttempted = false;
  } else {
    const requested = await requestAiIngredientResolution(args);
    if (!requested.ok) {
      return {
        ok: false,
        message: requested.message ?? AI_RESOLUTION_UNAVAILABLE_MESSAGE,
        aiAttempted: requested.aiAttempted,
        interpretedCount: requested.suggestions.length,
        outcome: EMPTY_FOOD_OUTCOME,
        amounts: EMPTY_AMOUNT_OUTCOME,
        households: EMPTY_HOUSEHOLD_OUTCOME,
      };
    }
    suggestions = requested.suggestions;
    aiAttempted = true;
  }

  const issueKinds = args.issueKinds;
  const foodSuggestions = suggestions.filter(
    (suggestion) => issueKinds?.[suggestion.line_ref] !== 'needs_amount'
  );
  const amountSuggestions = suggestions.filter(
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

  // VERIFIED-HOUSEHOLD PASS (LOWEST mass authority). It runs ONLY for lines the
  // count/amount pass did not already resolve, and it is excluded for every
  // line that already carries a `needs_amount` stored mass choice or an
  // existing verified household choice, so the merged working state can never
  // hold two competing mass sources for one line.
  let households: AiHouseholdResolveOutcome = EMPTY_HOUSEHOLD_OUTCOME;
  if (amountSuggestions.length > 0 && args.liveRows !== undefined && args.state !== undefined) {
    const excluded = new Set<string>(amounts.resolved.map((entry) => entry.line_ref));
    for (const lineRef of Object.keys(args.state.portions ?? {})) excluded.add(lineRef);
    for (const lineRef of Object.keys(args.state.countPortions ?? {})) excluded.add(lineRef);
    for (const lineRef of Object.keys(args.state.userMasses ?? {})) excluded.add(lineRef);
    for (const lineRef of Object.keys(args.state.householdPortions ?? {})) excluded.add(lineRef);
    households = resolveHouseholdsFromAiSuggestions({
      session: args.session,
      rows: args.rows,
      adapted: args.adapted,
      liveRows: args.liveRows,
      state: args.state,
      suggestions: amountSuggestions,
      excludeLineRefs: excluded,
    });
  }

  return {
    ok: true,
    aiAttempted,
    interpretedCount: suggestions.length,
    outcome,
    amounts,
    households,
  };
}
