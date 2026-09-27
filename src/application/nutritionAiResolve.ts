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
  buildAiAdvancedInterpretationRequest,
  sanitizeAiAdvancedInterpretationResponse,
  withholdNonDeterministicAdaptations,
  type AiAdvancedAuthoritativeAmountObservation,
  type AiAdvancedIngredientInterpretation,
  type AiAdvancedWithheldInterpretation,
} from '../core/nutritionV2/aiAdvanced';
import { buildAuthoritativeAmountObservations } from '../core/nutritionV2/aiAdvancedSource';
import {
  BASIC_NUTRITION_CAPABILITIES,
  isAiInterpretationAvailable,
  resolveNutritionCapabilities,
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

/**
 * The LIVE canonical semantic-interpretation route (AI-1). Distinct from the v4
 * advisory resolution endpoint above: this one owns the canonical
 * `nutrition_ai_advanced_interpretation_v1` contract and never returns the
 * legacy suggestion shape. Two formats are never served from one route.
 */
export const NUTRITION_INTERPRET_ENDPOINT = '/api/nutrition/interpret-ingredients';

/** Read-only, secret-free provider availability surface (no network probe). */
export const NUTRITION_AI_STATUS_ENDPOINT = '/api/providers';

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

/**
 * Bounded canonical request rows for the AI-1 semantic path. This is the ONLY
 * ingredient payload that leaves the client: the opaque line ref, the ingredient
 * text, an optional normalized text, the deterministic authored amount/unit, and
 * the trusted application issue kind. No vault, no other recipes, no notes, no
 * saved nutrition block, no nutrient result, no credential, no user metadata.
 */
function buildCanonicalRequestRows(
  rows: ReadonlyArray<Phase4Row>,
  adapted: ReadonlyArray<AdaptedIngredient>,
  issueKinds?: Readonly<Record<string, AiResolutionIssueKind>>
) {
  const adaptedByRef = new Map(adapted.map((entry) => [entry.line_ref, entry]));
  return rows.map((row) => {
    const entry = adaptedByRef.get(row.line_ref);
    const measurement = entry ? ingredientMeasurement(entry) : undefined;
    return {
      line_ref: row.line_ref,
      ingredient_text: row.original_text || row.query,
      normalized_text: row.query,
      amount: measurement?.amount ?? null,
      unit: measurement?.raw_unit,
      issue_kind: issueKinds?.[row.line_ref],
    };
  });
}

/**
 * Resolves the Basic vs AI Advanced capability set from the server's READ-ONLY,
 * secret-free provider status surface (no network probe, no spend). Fails SAFE:
 * any error, non-2xx, unknown shape, or missing signal yields Basic Nutrition, so
 * the deterministic/manual workflow is never gated behind an AI probe.
 */
export async function resolveNutritionAiCapabilities(
  network: NetworkAdapter
): Promise<NutritionCapabilities> {
  try {
    const response = await network.get<{ providers?: unknown }>(NUTRITION_AI_STATUS_ENDPOINT);
    if (!response || response.ok !== true) return BASIC_NUTRITION_CAPABILITIES;
    const providers = Array.isArray(response.data?.providers)
      ? (response.data?.providers as ReadonlyArray<unknown>)
      : [];
    let aiConfigured = false;
    let aiReachable = false;
    for (const entry of providers) {
      if (entry === null || typeof entry !== 'object') continue;
      const status = entry as {
        readonly configured?: unknown;
        readonly available?: unknown;
        readonly enabled?: unknown;
        readonly capabilities?: unknown;
      };
      if (status.enabled === false) continue;
      const capabilities = status.capabilities;
      const structuredOutput =
        capabilities !== null &&
        typeof capabilities === 'object' &&
        (capabilities as Record<string, unknown>).structuredOutput === true;
      if (!structuredOutput) continue;
      if (status.configured === true) aiConfigured = true;
      if (status.available === true) aiReachable = true;
    }
    return resolveNutritionCapabilities({ aiConfigured, aiReachable });
  } catch {
    return BASIC_NUTRITION_CAPABILITIES;
  }
}

export interface AiAdvancedInterpretationRequestResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  /**
   * Deterministic parse observations built from SOURCE state before any call.
   * Never requested from, and never influenced by, the provider.
   */
  readonly authoritativeByLineRef: ReadonlyMap<string, AiAdvancedAuthoritativeAmountObservation>;
  readonly aiAttempted: boolean;
}

/**
 * LIVE canonical interpretation request (AI-1). Selects the actionable rows,
 * builds the bounded canonical request, calls the canonical
 * `POST /api/nutrition/interpret-ingredients` route, and then RE-SANITIZES the
 * response against the exact requested line refs. Server-originated canonical
 * JSON is never trusted merely because it came from our own server: a malformed,
 * version-mismatched, or authority-shaped payload rejects the WHOLE result.
 */
export async function requestAiAdvancedInterpretations(
  args: AiResolutionRequestArgs
): Promise<AiAdvancedInterpretationRequestResult> {
  const rows = canonicalRequestableRows(args);
  const authoritativeByLineRef = buildAuthoritativeAmountObservations({
    rows,
    adapted: args.adapted,
  });
  const request = buildAiAdvancedInterpretationRequest(
    buildCanonicalRequestRows(rows, args.adapted, args.issueKinds)
  );
  const allowedLineRefs = request.rows.map((row) => row.line_ref);
  if (allowedLineRefs.length === 0) {
    return {
      ok: false,
      message: 'Nothing unresolved to interpret.',
      interpretations: Object.freeze([]),
      authoritativeByLineRef,
      aiAttempted: false,
    };
  }

  let response;
  try {
    response = await args.network.post<{
      ok?: boolean;
      contract_version?: unknown;
      interpretations?: unknown;
    }>(
      NUTRITION_INTERPRET_ENDPOINT,
      { ingredients: request.rows },
      await buildAiSelectionRequestOptions()
    );
  } catch {
    return {
      ok: false,
      message: AI_RESOLUTION_UNAVAILABLE_MESSAGE,
      interpretations: Object.freeze([]),
      authoritativeByLineRef,
      aiAttempted: true,
    };
  }

  if (!response || response.ok !== true) {
    return {
      ok: false,
      message: AI_RESOLUTION_UNAVAILABLE_MESSAGE,
      interpretations: Object.freeze([]),
      authoritativeByLineRef,
      aiAttempted: true,
    };
  }

  // The server must answer in the canonical contract version this client asked
  // for; any other version is an unusable response (never coerced).
  if (response.data?.contract_version !== AI_ADVANCED_CONTRACT_VERSION) {
    return {
      ok: false,
      message: AI_RESOLUTION_INVALID_MESSAGE,
      interpretations: Object.freeze([]),
      authoritativeByLineRef,
      aiAttempted: true,
    };
  }

  const sanitized = sanitizeAiAdvancedInterpretationResponse(
    {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations: response.data?.interpretations,
    },
    { allowedLineRefs }
  );
  if (sanitized.ok !== true) {
    return {
      ok: false,
      message: AI_RESOLUTION_INVALID_MESSAGE,
      interpretations: Object.freeze([]),
      authoritativeByLineRef,
      aiAttempted: true,
    };
  }
  const accepted = sanitized as {
    readonly ok: true;
    readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  };
  return {
    ok: true,
    interpretations: accepted.interpretations,
    authoritativeByLineRef,
    aiAttempted: true,
  };
}

interface CanonicalApplicationResult {
  readonly ok: boolean;
  readonly suggestions: ReadonlyArray<AiResolutionSuggestion>;
  readonly withheld: ReadonlyArray<AiAdvancedWithheldInterpretation>;
  /** Canonical interpretations accepted for this request (post re-sanitization). */
  readonly acceptedCount: number;
}

/**
 * The ONE canonical interpretation -> deterministic transport application step,
 * shared by the AI-0 explicit path and the AI-1 live path:
 *
 *   re-sanitize (exact requested line refs, whole-payload rejection)
 *     -> deterministic source reconciliation (adaptation)
 *     -> AI-1 eligibility guard (ambiguity / authored alternatives withheld)
 *
 * No deterministic resolution logic is duplicated: the caller hands the result
 * to the SAME `resolveFoodsFromAiSuggestions` /
 * `resolveAmountsFromAiSuggestions` / `resolveHouseholdsFromAiSuggestions`
 * pipeline the legacy path uses.
 */
function applyCanonicalInterpretations(input: {
  readonly args: AiResolutionRequestArgs;
  readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  readonly authoritativeByLineRef?: ReadonlyMap<string, AiAdvancedAuthoritativeAmountObservation>;
}): CanonicalApplicationResult {
  const allowedLineRefs = canonicalRequestableRows(input.args).map((row) => row.line_ref);
  const allowed = new Set(allowedLineRefs);
  const sanitized = sanitizeAiAdvancedInterpretationResponse(
    {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations: input.interpretations.filter((entry) => allowed.has(entry.line_ref)),
    },
    { allowedLineRefs }
  );
  if (sanitized.ok !== true) {
    return {
      ok: false,
      suggestions: Object.freeze([]),
      withheld: Object.freeze([]),
      acceptedCount: 0,
    };
  }
  const accepted = sanitized as {
    readonly ok: true;
    readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  };
  const adapted = adaptAiAdvancedInterpretationsForResolution({
    interpretations: accepted.interpretations,
    ...(input.authoritativeByLineRef !== undefined
      ? { authoritativeByLineRef: input.authoritativeByLineRef }
      : {}),
  });
  const eligible = withholdNonDeterministicAdaptations({
    interpretations: accepted.interpretations,
    outcome: adapted,
  });
  return {
    ok: true,
    suggestions: eligible.suggestions,
    withheld: eligible.withheld,
    acceptedCount: accepted.interpretations.length,
  };
}

/**
 * Canonical SEMANTIC INTERPRETATION scope (AI-1 / architect decision).
 *
 * AI-1 sends every TRUSTED actionable issue kind to the canonical interpreter:
 *   - `needs_match`       — nothing matched deterministically;
 *   - `review_suggested`  — only a BELOW-THRESHOLD deterministic candidate exists;
 *   - `needs_amount`      — food matched, the amount is still unresolved.
 *
 * This is deliberately NOT a change to `aiResolutionEligibleRows()`: the legacy
 * v4 path keeps its own (unmatched/invalid) scope and behavior. The canonical
 * path is driven by the trusted application `issueKinds` classification taken
 * from the live projection, and it falls back to the legacy scope when that
 * classification is absent.
 */
export const AI_ADVANCED_SEMANTIC_ISSUE_KINDS: ReadonlyArray<AiResolutionIssueKind> = Object.freeze([
  'needs_match',
  'review_suggested',
  'needs_amount',
]);

function canonicalRequestableRows(
  args: AiResolutionRequestArgs
): ReadonlyArray<Phase4Row> {
  const kinds = args.issueKinds;
  if (kinds === undefined) return aiResolutionEligibleRows(args.rows);
  return Object.freeze(
    args.rows.filter((row) => {
      const kind = kinds[row.line_ref];
      return kind !== undefined && AI_ADVANCED_SEMANTIC_ISSUE_KINDS.includes(kind);
    })
  );
}

/**
 * AI-1 BELOW-THRESHOLD LAUNDERING GUARD (architect decision).
 *
 * A `review_suggested` row is one where the DETERMINISTIC matcher already found
 * a candidate it is NOT willing to accept automatically — the row is explicitly
 * waiting for a human decision. Sending such a row to the canonical semantic
 * interpreter must not upgrade it: if the provider's wording happens to re-hit
 * the best-effort threshold, the deterministic acceptance would be laundered
 * into an automatic one by AI agreement.
 *
 * This guard is purely SUBTRACTIVE and lives in the application canonical path
 * (never in the legacy matcher, and never in the transport contract): for rows
 * classified `review_suggested`, an automatic acceptance is downgraded to an
 * OFFER the user must confirm explicitly, exactly like a below-threshold
 * candidate. The deterministic candidate itself, its evidence, and every
 * matcher/ranking rule are untouched — the AI merely may not spend authority it
 * was never granted.
 */
export function withholdBelowThresholdAutoAcceptance(input: {
  readonly outcome: AiResolveOutcome;
  readonly issueKinds?: Readonly<Record<string, AiResolutionIssueKind>>;
}): AiResolveOutcome {
  const kinds = input.issueKinds;
  if (kinds === undefined) return input.outcome;
  let downgraded = false;
  const candidates = input.outcome.candidates.map((candidate) => {
    if (candidate.auto !== true || kinds[candidate.line_ref] !== 'review_suggested') return candidate;
    downgraded = true;
    const choice = candidate.choice as unknown as Record<string, unknown>;
    const { aiAccepted: _aiAccepted, ...restChoice } = choice;
    return Object.freeze({
      ...candidate,
      auto: false,
      // An offered candidate omits `aiAccepted`, so an explicit "Use this match"
      // remains a genuine USER confirmation.
      choice: Object.freeze(restChoice),
    });
  }) as ReadonlyArray<AiResolveOutcome['candidates'][number]>;
  if (!downgraded) return input.outcome;
  return Object.freeze({
    candidates: Object.freeze(candidates),
    unresolved: input.outcome.unresolved,
    auto_count: candidates.filter((candidate) => candidate.auto).length,
  });
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
  /**
   * Canonical SEMANTIC interpretations accepted on the AI-1 path. ADVISORY
   * METRIC ONLY: a semantic interpretation is never a nutrition resolution and
   * never inflates the deterministic coverage score.
   */
  readonly semanticInterpretedCount: number;
  /**
   * Interpretations that were understood but WITHHELD from deterministic
   * resolution (ambiguity, or authored alternatives). Audit/display only.
   */
  readonly withheld: ReadonlyArray<AiAdvancedWithheldInterpretation>;
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
  /**
   * AI-1 LIVE canonical semantic path. When true (and the capability set allows
   * AI interpretation), the orchestrator calls the canonical interpretation route
   * with the bounded rows, re-sanitizes the response, reconciles it against the
   * deterministic source observations, and runs the SAME deterministic
   * verification pipeline. The legacy v4 advisory path is used otherwise.
   */
  readonly liveCanonicalInterpretation?: boolean;
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
      semanticInterpretedCount: 0,
      withheld: Object.freeze([]),
      outcome: EMPTY_FOOD_OUTCOME,
      amounts: EMPTY_AMOUNT_OUTCOME,
      households: EMPTY_HOUSEHOLD_OUTCOME,
    };
  }

  const canonicalInterpretationPath =
    args.interpretations !== undefined || args.liveCanonicalInterpretation === true;
  let suggestions: ReadonlyArray<AiResolutionSuggestion>;
  let aiAttempted: boolean;
  let withheld: ReadonlyArray<AiAdvancedWithheldInterpretation> = Object.freeze([]);
  let semanticInterpretedCount = 0;
  if (canonicalInterpretationPath) {
    // CANONICAL PATH (AI-0 explicit interpretations, AI-1 live route). Both forms
    // converge on ONE application step: re-sanitize against the exact request
    // rows, reconcile against the deterministic source observations, then apply
    // the ambiguity/alternatives eligibility guard.
    let interpretations = args.interpretations;
    let authoritative = args.authoritativeByLineRef;
    if (interpretations === undefined) {
      // AI-1 LIVE: bounded canonical request -> canonical route -> client
      // re-sanitization. The deterministic source map was built before the call.
      const live = await requestAiAdvancedInterpretations(args);
      if (live.ok !== true) {
        return {
          ok: false,
          message: live.message ?? AI_RESOLUTION_UNAVAILABLE_MESSAGE,
          aiAttempted: live.aiAttempted,
          interpretedCount: 0,
          semanticInterpretedCount: 0,
          withheld: Object.freeze([]),
          outcome: EMPTY_FOOD_OUTCOME,
          amounts: EMPTY_AMOUNT_OUTCOME,
          households: EMPTY_HOUSEHOLD_OUTCOME,
        };
      }
      interpretations = live.interpretations;
      authoritative = live.authoritativeByLineRef;
      aiAttempted = true;
    } else {
      // No provider is called on the explicit-interpretations path.
      aiAttempted = false;
    }

    const applied = applyCanonicalInterpretations({
      args,
      interpretations,
      ...(authoritative !== undefined ? { authoritativeByLineRef: authoritative } : {}),
    });
    if (applied.ok !== true) {
      return {
        ok: false,
        message: AI_RESOLUTION_INVALID_MESSAGE,
        aiAttempted,
        interpretedCount: 0,
        semanticInterpretedCount: 0,
        withheld: Object.freeze([]),
        outcome: EMPTY_FOOD_OUTCOME,
        amounts: EMPTY_AMOUNT_OUTCOME,
        households: EMPTY_HOUSEHOLD_OUTCOME,
      };
    }
    suggestions = applied.suggestions;
    withheld = applied.withheld;
    semanticInterpretedCount = applied.acceptedCount;
  } else {
    const requested = await requestAiIngredientResolution(args);
    if (!requested.ok) {
      return {
        ok: false,
        message: requested.message ?? AI_RESOLUTION_UNAVAILABLE_MESSAGE,
        aiAttempted: requested.aiAttempted,
        interpretedCount: requested.suggestions.length,
        semanticInterpretedCount: 0,
        withheld: Object.freeze([]),
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

  const resolvedOutcome =
    foodSuggestions.length > 0
      ? resolveFoodsFromAiSuggestions({
          session: args.session,
          rows: foodRows,
          adapted: args.adapted,
          suggestions: foodSuggestions,
        })
      : EMPTY_FOOD_OUTCOME;
  // AI-1: on the canonical semantic path, an AI-driven automatic acceptance may
  // never upgrade a row the DETERMINISTIC matcher classified `review_suggested`.
  const outcome = canonicalInterpretationPath
    ? withholdBelowThresholdAutoAcceptance({ outcome: resolvedOutcome, issueKinds })
    : resolvedOutcome;
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
    semanticInterpretedCount,
    withheld,
    outcome,
    amounts,
    households,
  };
}
