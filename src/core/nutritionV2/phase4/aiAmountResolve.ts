/**
 * The Kitchen Codex — Advanced Nutrition: AI-assisted AMOUNT interpretation
 * (local verification).
 *
 * PURE, offline, advisory-only. Phase-4 boundary helper that turns a SANITIZED
 * advisory amount interpretation (a bounded count-identity hint such as
 * `clove`) into a genuine, locally authenticated count-portion choice:
 *
 *   AI count-identity hint -> session.reviewCountPortions(ingredient, food, hint)
 *     -> the SAME authenticated USDA portions the calculator uses
 *     -> a fully bound CountPortionChoice (buildCountPortionChoice)
 *     -> the genuine Phase 3 calculator independently re-derives the mass.
 *
 * HARD RULES
 * ----------
 *  - The AI NEVER supplies a gram weight, mass, FDC id, portion index, nutrient,
 *    or Apply authority. It only interprets count/portion LANGUAGE.
 *  - The count AMOUNT always comes from the recipe's own parsed ingredient.
 *  - A hint may only FILL a missing unit/size; it never overrides an explicit
 *    recipe identity and it is restricted to the closed count vocabulary.
 *  - When several materially different authenticated portions remain compatible,
 *    nothing is auto-chosen: the authenticated candidates are OFFERED to the
 *    user as explicit choices (accuracy beats completion theater).
 *  - Every produced choice still flows through the deterministic calculator,
 *    which re-verifies the record, catalog, line, candidate set, and digest.
 */

import {
  canonicalCountUnit,
  canonicalSize,
  type CountRequirementHint,
} from '../calculation/countPortion';
import { buildCountPortionChoice } from './countPortion';
import { ingredientMeasurement, selectionFromMatchChoice } from './rows';
import type { AiResolutionSuggestion } from '../aiResolution';
import type { LiveRowState } from './liveRow';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  CountPortionChoice,
  MatchChoice,
  Phase4Row,
  Phase4State,
} from './types';

/** One AI-assisted deterministic count resolution (category B provenance). */
export interface AiAmountChoice {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly portion_index: number;
  readonly display_label: string;
  readonly resolved_grams: number;
  readonly choice: CountPortionChoice;
}

/** One authenticated count portion the user must choose explicitly (category C). */
export interface AiAmountOffer {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly portion_index: number;
  readonly display_label: string;
  readonly resolved_grams: number;
  readonly hint: CountRequirementHint;
}

export interface AiAmountResolveOutcome {
  /** AI-assisted deterministic resolutions (never user-confirmed). */
  readonly resolved: ReadonlyArray<AiAmountChoice>;
  /** Authenticated candidates that remain the user's explicit choice. */
  readonly offers: ReadonlyArray<AiAmountOffer>;
  /** Lines with no authenticated compatible count portion. */
  readonly unresolved: ReadonlyArray<string>;
  /** Lines whose AI quantity hint materially disagreed with the recipe amount. */
  readonly inconsistent: ReadonlyArray<string>;
  readonly auto_count: number;
}

export interface AiAmountResolveParams {
  readonly session: AdvancedNutritionSession;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly liveRows: ReadonlyArray<LiveRowState>;
  readonly state: Phase4State;
  readonly suggestions: ReadonlyArray<AiResolutionSuggestion>;
}

/** Canonicalizes a raw hint value to a closed count unit, trying each token. */
function canonicalUnitHint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (cleaned.length === 0) return null;
  const direct = canonicalCountUnit(cleaned);
  if (direct !== null) return direct;
  const tokens = cleaned.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const unit = canonicalCountUnit(tokens[i]);
    if (unit !== null) return unit;
  }
  return null;
}

/** Canonicalizes a raw hint value to a closed count size, trying each token. */
function canonicalSizeHint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (cleaned.length === 0) return null;
  const direct = canonicalSize(cleaned);
  if (direct !== null) return direct;
  const tokens = cleaned.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const size = canonicalSize(tokens[i]);
    if (size !== null) return size;
  }
  return null;
}

/**
 * The bounded count-identity hint carried by one advisory suggestion, or
 * undefined when the interpretation contains no closed-vocabulary identity.
 */
export function countRequirementHintFromSuggestion(
  suggestion: AiResolutionSuggestion
): CountRequirementHint | undefined {
  const unit =
    canonicalUnitHint(suggestion.count_descriptor_hint) ??
    canonicalUnitHint(suggestion.portion_search_hint) ??
    canonicalUnitHint(suggestion.quantity_unit_hint);
  const size =
    canonicalSizeHint(suggestion.count_descriptor_hint) ??
    canonicalSizeHint(suggestion.portion_search_hint);
  if (unit === null && size === null) return undefined;
  return Object.freeze({ unit, size });
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && !Object.is(value, -0);
}

function gramsFor(amount: number, candidate: { amount: number; gram_weight: number }): number | undefined {
  if (!finitePositive(candidate.amount) || !finitePositive(candidate.gram_weight)) return undefined;
  const grams = (amount / candidate.amount) * candidate.gram_weight;
  if (!Number.isFinite(grams) || grams <= 0 || Object.is(grams, -0)) return undefined;
  return grams;
}

function allEquivalent(values: ReadonlyArray<number>): boolean {
  const first = values[0];
  return values.every((value) => Math.abs(value - first) <= 1e-9 * Math.max(1, Math.abs(first)));
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
 * Resolves sanitized advisory amount interpretations against the genuine pinned
 * catalog. Never throws; malformed/absent inputs leave a line unresolved.
 */
export function resolveAmountsFromAiSuggestions(
  params: AiAmountResolveParams
): AiAmountResolveOutcome {
  const { session, rows, adapted, liveRows, state, suggestions } = params;
  const rowByRef = new Map(rows.map((row) => [row.line_ref, row]));
  const entryByRef = new Map(adapted.map((entry) => [entry.line_ref, entry]));
  const liveByRef = new Map(liveRows.map((live) => [live.line_ref, live]));

  const resolved: AiAmountChoice[] = [];
  const offers: AiAmountOffer[] = [];
  const unresolved: string[] = [];
  const inconsistent: string[] = [];

  for (const suggestion of suggestions) {
    const lineRef = suggestion.line_ref;
    const row = rowByRef.get(lineRef);
    const entry = entryByRef.get(lineRef);
    const live = liveByRef.get(lineRef);
    if (!row || !entry || !live || live.status !== 'needs_amount') {
      unresolved.push(lineRef);
      continue;
    }
    if (live.selected_fdc_id === undefined) {
      // A needs_amount row always has a resolved/suggested food; if it does not,
      // nothing can be bound without inventing authority.
      unresolved.push(lineRef);
      continue;
    }
    const measurement = ingredientMeasurement(entry);
    if (measurement.measurement_kind === 'mass' || measurement.measurement_kind === 'volume') {
      // Count-portion binding is only meaningful for count/unknown lines; a
      // volume/mass line is resolved through its own canonical portion path.
      unresolved.push(lineRef);
      continue;
    }
    const amount = measurement.amount;
    if (amount === null || !finitePositive(amount)) {
      // The count amount must come from the recipe itself. AI never supplies it.
      unresolved.push(lineRef);
      continue;
    }
    if (quantityInconsistent(suggestion, amount)) {
      inconsistent.push(lineRef);
      continue;
    }
    const hint = countRequirementHintFromSuggestion(suggestion);
    if (!hint) {
      unresolved.push(lineRef);
      continue;
    }

    const review = session.reviewCountPortions(entry.ingredient, live.selected_fdc_id, hint);
    if (!review.ok || review.review.candidates.length === 0) {
      unresolved.push(lineRef);
      continue;
    }
    const candidates = review.review.candidates;
    const grams = candidates.map((candidate) => gramsFor(amount, candidate));
    if (grams.some((value) => value === undefined)) {
      unresolved.push(lineRef);
      continue;
    }
    const resolvedGrams = grams as number[];

    if (!allEquivalent(resolvedGrams)) {
      // Materially different authenticated weights: the user chooses. No
      // silent size/portion decision is ever made for them.
      candidates.forEach((candidate, index) => {
        offers.push(
          Object.freeze({
            line_ref: lineRef,
            fdc_id: live.selected_fdc_id as number,
            portion_index: candidate.index,
            display_label: candidate.display_label,
            resolved_grams: resolvedGrams[index],
            hint,
          })
        );
      });
      continue;
    }

    const matchChoice = state.matches[lineRef];
    const { selection, automaticSelection } = selectionForRow(row, matchChoice);
    const built = buildCountPortionChoice(session, {
      lineRef,
      ingredient: entry.ingredient,
      review: row.outcome === 'review_required' ? row.review : undefined,
      selection,
      automaticSelection,
      fdcId: live.selected_fdc_id,
      portionIndex: candidates[0].index,
      countRequirementHint: hint,
    });
    if (!built.ok) {
      unresolved.push(lineRef);
      continue;
    }
    resolved.push(
      Object.freeze({
        line_ref: lineRef,
        fdc_id: live.selected_fdc_id,
        portion_index: candidates[0].index,
        display_label: candidates[0].display_label,
        resolved_grams: resolvedGrams[0],
        choice: Object.freeze({
          ...built.choice,
          automatic: true,
          aiAssisted: true,
          countRequirementHint: hint,
        }),
      })
    );
  }

  return Object.freeze({
    resolved: Object.freeze(resolved),
    offers: Object.freeze(offers),
    unresolved: Object.freeze(unresolved),
    inconsistent: Object.freeze(inconsistent),
    auto_count: resolved.length,
  });
}

/**
 * Builds an EXPLICIT user count-portion choice for one AI-offered authenticated
 * candidate. The user's click is category C provenance (user-selected mass); the
 * deterministic calculator still re-verifies every binding.
 */
export function buildUserChoiceFromAiAmountOffer(params: {
  readonly session: AdvancedNutritionSession;
  readonly offer: AiAmountOffer;
  readonly row: Phase4Row;
  readonly entry: AdaptedIngredient;
  readonly matchChoice: MatchChoice | undefined;
}): CountPortionChoice | undefined {
  const { session, offer, row, entry, matchChoice } = params;
  const { selection, automaticSelection } = selectionForRow(row, matchChoice);
  const built = buildCountPortionChoice(session, {
    lineRef: offer.line_ref,
    ingredient: entry.ingredient,
    review: row.outcome === 'review_required' ? row.review : undefined,
    selection,
    automaticSelection,
    fdcId: offer.fdc_id,
    portionIndex: offer.portion_index,
    countRequirementHint: offer.hint,
  });
  if (!built.ok) return undefined;
  return Object.freeze({ ...built.choice });
}
