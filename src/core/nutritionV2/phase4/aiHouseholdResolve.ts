/**
 * The Kitchen Codex — Advanced Nutrition Phase 7: AI-assisted HOUSEHOLD
 * interpretation (local verification).
 *
 * PURE, offline, advisory-only. Turns a SANITIZED advisory household wording
 * interpretation (a bounded closed-vocabulary unit/size/state hint) into a
 * genuine, locally authenticated verified-household choice:
 *
 *   AI household hint -> session.calculate dry run (genuine session)
 *     -> resolveHouseholdPortion (authenticated Phase 5 registry, exact key)
 *     -> buildHouseholdPortionChoice (full-binding verification)
 *     -> a fully bound HouseholdPortionChoice the calculator independently
 *        re-derives and re-verifies on every preview/Apply.
 *
 * HARD RULES
 * ----------
 *  - The AI NEVER supplies a gram weight, mass, FDC id, registry record id,
 *    package/container mass, quantity, portion index, nutrient value,
 *    conversion math, digest, confidence, confirmation, or Apply authority. It
 *    only interprets household WORDING.
 *  - The recipe line's own quantity remains the only quantity source; a range
 *    is never turned into an exact amount and a container is never turned into a
 *    count or household mass.
 *  - A hint may only FILL a missing unit/size/state; explicit source wording
 *    always outranks it and is never erased. A hint that supplies a known
 *    household CONTAINER unit is discarded whole.
 *  - Resolution is accepted only through the genuine registry review/build/
 *    verification path; absent or ambiguous records leave the line unresolved.
 *  - Nothing is persisted; `user_confirmed` and `application_authorized` remain
 *    the user's explicit decisions.
 */

import {
  canonicalHouseholdCountUnit,
  canonicalHouseholdState,
  type HouseholdRequirementHint,
} from '../calculation/householdPortion';
import { canonicalHouseholdUnit } from '../../../utils/householdUnits';
import { canonicalSize } from '../calculation/countPortion';
import { buildHouseholdPortionChoice } from './householdPortion';
import { ingredientMeasurement, selectionFromMatchChoice } from './rows';
import type { AiResolutionSuggestion } from '../aiResolution';
import type { LiveRowState } from './liveRow';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  HouseholdPortionChoice,
  MatchChoice,
  Phase4Row,
  Phase4State,
} from './types';

/** One AI-assisted deterministic verified-household resolution. */
export interface AiHouseholdChoice {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly record_key: string;
  readonly authority_class: string;
  readonly resolved_grams: number;
  readonly choice: HouseholdPortionChoice;
}

export interface AiHouseholdResolveOutcome {
  /** AI-assisted deterministic household resolutions (never user-confirmed). */
  readonly resolved: ReadonlyArray<AiHouseholdChoice>;
  /** Lines with no compatible verified household record. */
  readonly unresolved: ReadonlyArray<string>;
  /** Lines whose AI quantity echo materially disagreed with the recipe amount. */
  readonly inconsistent: ReadonlyArray<string>;
  readonly auto_count: number;
}

export interface AiHouseholdResolveParams {
  readonly session: AdvancedNutritionSession;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly liveRows: ReadonlyArray<LiveRowState>;
  readonly state: Phase4State;
  readonly suggestions: ReadonlyArray<AiResolutionSuggestion>;
  /**
   * Lines already resolved (or already carrying a higher-authority mass choice)
   * that this pass must never touch. Deterministic and caller-supplied; it is
   * never derived from provider output.
   */
  readonly excludeLineRefs?: ReadonlySet<string> | ReadonlyArray<string>;
}

function asExcludedSet(
  value: ReadonlySet<string> | ReadonlyArray<string> | undefined
): ReadonlySet<string> {
  if (value === undefined) return new Set<string>();
  if (value instanceof Set) return value;
  return new Set(value);
}

/** Canonicalizes one raw household-unit hint field. */
function canonicalHintUnit(raw: unknown): { ok: boolean; unit: string | null } {
  if (raw === undefined || raw === null || typeof raw !== 'string') return { ok: true, unit: null };
  const cleaned = raw.trim();
  if (cleaned.length === 0) return { ok: true, unit: null };
  // A known household CONTAINER noun is a hard rejection: a provider hint may
  // never reinterpret a container as a household count conversion.
  const household = canonicalHouseholdUnit(cleaned);
  if (household === null) {
    // Unknown token: reduced to no hint (never passed through), and it must not
    // silently become a count noun through a partial match.
    return { ok: true, unit: null };
  }
  if (household.kind !== 'count') return { ok: false, unit: null };
  return { ok: true, unit: canonicalHouseholdCountUnit(household.noun) };
}

/** Printable ASCII only: confusables/invisible format characters never match. */
const ASCII_HINT_PATTERN = /^[ -~]+$/;

/** Canonicalizes one raw household-size hint field. */
function canonicalHintSize(raw: unknown): string | null {
  if (raw === undefined || raw === null || typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (cleaned.length === 0) return null;
  // The size canonicalizer strips punctuation/whitespace, so reject
  // non-ASCII/format/confusable input BEFORE canonicalization.
  if (!ASCII_HINT_PATTERN.test(cleaned)) return null;
  return canonicalSize(cleaned);
}

/** Canonicalizes one raw household-state hint field. */
function canonicalHintState(raw: unknown): string | null {
  if (raw === undefined || raw === null || typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (cleaned.length === 0) return null;
  return canonicalHouseholdState(cleaned);
}

/**
 * The bounded closed-vocabulary household hint carried by one advisory
 * suggestion, or undefined when the interpretation contains no accepted token.
 * Unknown tokens are reduced to "no hint"; a container unit rejects the hint.
 */
export function householdRequirementHintFromSuggestion(
  suggestion: AiResolutionSuggestion
): HouseholdRequirementHint | undefined {
  const unit = canonicalHintUnit(suggestion.household_unit_hint);
  if (!unit.ok) return undefined;
  const size = canonicalHintSize(suggestion.household_size_hint);
  const state = canonicalHintState(suggestion.household_state_hint);
  if (unit.unit === null && size === null && state === null) return undefined;
  return Object.freeze({ unit: unit.unit, size, state });
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && !Object.is(value, -0);
}

/** True when the AI's echoed quantity materially disagrees with the recipe. */
function quantityInconsistent(suggestion: AiResolutionSuggestion, recipeAmount: number): boolean {
  const quantity = suggestion.quantity_value;
  if (quantity === undefined || !finitePositive(quantity)) return false;
  const tolerance = Math.max(0.01, recipeAmount * 0.05);
  return Math.abs(quantity - recipeAmount) > tolerance;
}

function selectionForRow(
  row: Phase4Row,
  matchChoice: MatchChoice | undefined
): { selection?: unknown; automaticSelection: boolean } {
  if (matchChoice !== undefined) {
    return {
      selection: selectionFromMatchChoice(matchChoice, row.line_ref),
      automaticSelection: matchChoice.automatic === true,
    };
  }
  return { automaticSelection: false };
}

/**
 * Resolves sanitized advisory household interpretations against the genuine
 * verified registry. The genuine builder call is guarded: a structural fake /
 * adversarial session must never throw out of the resolver, and any malformed
 * or absent input leaves a line unresolved and nothing is ever invented.
 */
export function resolveHouseholdsFromAiSuggestions(
  params: AiHouseholdResolveParams
): AiHouseholdResolveOutcome {
  const { session, rows, adapted, liveRows, state, suggestions } = params;
  const excluded = asExcludedSet(params.excludeLineRefs);
  const rowByRef = new Map(rows.map((row) => [row.line_ref, row]));
  const entryByRef = new Map(adapted.map((entry) => [entry.line_ref, entry]));
  const liveByRef = new Map(liveRows.map((live) => [live.line_ref, live]));

  const resolved: AiHouseholdChoice[] = [];
  const unresolved: string[] = [];
  const inconsistent: string[] = [];

  for (const suggestion of suggestions) {
    const lineRef = suggestion.line_ref;
    if (excluded.has(lineRef)) {
      unresolved.push(lineRef);
      continue;
    }
    const row = rowByRef.get(lineRef);
    const entry = entryByRef.get(lineRef);
    const live = liveByRef.get(lineRef);
    if (!row || !entry || !live || live.status !== 'needs_amount') {
      unresolved.push(lineRef);
      continue;
    }
    if (live.selected_fdc_id === undefined) {
      // A verified household conversion needs an authenticated food identity.
      unresolved.push(lineRef);
      continue;
    }
    const measurement = ingredientMeasurement(entry);
    if (measurement.measurement_kind === 'mass' || measurement.measurement_kind === 'volume') {
      // A direct-mass line is exclusive and a volume line is resolved through
      // its own canonical portion path; neither is a household count.
      unresolved.push(lineRef);
      continue;
    }
    const amount = measurement.amount;
    if (amount === null || !finitePositive(amount)) {
      // The quantity always comes from the recipe (a range has no single
      // quantity); AI never supplies it.
      unresolved.push(lineRef);
      continue;
    }
    if (quantityInconsistent(suggestion, amount)) {
      inconsistent.push(lineRef);
      continue;
    }
    const hint = householdRequirementHintFromSuggestion(suggestion);
    if (!hint) {
      unresolved.push(lineRef);
      continue;
    }

    const matchChoice = state.matches[lineRef];
    const { selection, automaticSelection } = selectionForRow(row, matchChoice);
    let built: ReturnType<typeof buildHouseholdPortionChoice>;
    try {
      built = buildHouseholdPortionChoice(session, {
        lineRef,
        ingredient: entry.ingredient,
        review: row.outcome === 'review_required' ? row.review : undefined,
        selection,
        automaticSelection,
        fdcId: live.selected_fdc_id,
        householdRequirementHint: hint,
      });
    } catch {
      // A structural fake / adversarial session must never throw out of the
      // resolver; the line simply stays unresolved.
      unresolved.push(lineRef);
      continue;
    }
    if (!built.ok) {
      unresolved.push(lineRef);
      continue;
    }
    resolved.push(
      Object.freeze({
        line_ref: lineRef,
        fdc_id: live.selected_fdc_id,
        record_key: built.choice.record_key,
        authority_class: built.choice.authority_class,
        resolved_grams: built.choice.resolved_grams,
        choice: Object.freeze({
          ...built.choice,
          // `automatic` is NEVER forced by AI assistance: it is derived by the
          // genuine core builder from the authenticated food/match authority
          // (`automaticSelection`). An analyzer-automatic food yields
          // `automatic: true`; a user-confirmed/manual (or unique-exact) food
          // yields `automatic: false`. AI wording can only add the independent
          // `aiAssisted` display marker; it can never promote a bounded
          // estimate (or any household choice) into more automatic authority
          // than the ordinary Phase 6 household path permits.
          aiAssisted: true,
          householdRequirementHint: hint,
        }),
      })
    );
  }

  return Object.freeze({
    resolved: Object.freeze(resolved),
    unresolved: Object.freeze(unresolved),
    inconsistent: Object.freeze(inconsistent),
    auto_count: resolved.length,
  });
}
