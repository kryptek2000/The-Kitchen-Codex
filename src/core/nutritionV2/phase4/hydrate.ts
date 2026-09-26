/**
 * The Kitchen Codex — Advanced Nutrition: working-review hydration.
 *
 * PURE, offline, advisory-only. When a recipe is unchanged relative to its saved
 * `codex_nutrition` block, this module reconstructs the previously reviewed
 * working state (food choice + mass binding) so the user does not have to repeat
 * prior review work.
 *
 * HONEST EVIDENCE CONTRACT
 * ------------------------
 * The canonical schema-v1 block stores, per resolved line: the USDA FDC id, the
 * bundle release, the resolved grams, `match_status: 'confirmed'`,
 * `user_confirmed: true`, and an optional `conversion_basis`
 * (`direct_mass` | `source_portion`; `user_mass` is deliberately omitted and a
 * count portion is reported as `source_portion`). It does NOT persist the record
 * digest, catalog digest, review digest, portion index, or the manual mass
 * unit — those are RE-DERIVED here from the genuine current session/bundle.
 *
 * A hydrated choice is therefore never authority by itself: every mass binding
 * is built through the genuine session (`buildPortionChoice`,
 * `buildCountPortionChoice`, `buildUserMassChoice`), which independently
 * re-authenticates the manual food selection against the pinned bundle. If any
 * piece cannot be re-authenticated, that row is left unresolved — no authority
 * is invented. In particular, a saved line whose basis declares a USDA portion
 * basis (`source_portion`) that cannot be re-authenticated NEVER hydrates as a
 * user-entered mass: the reviewed food identity is restored and the mass stays
 * unresolved (truthful fail-closed degradation; schema v1 cannot preserve
 * hint-dependent count provenance).
 *
 * HYDRATION IS PER-LINE_BOUND: only a saved evidence line whose `line_ref`
 * exactly equals the CURRENT adapted line reference hydrates. The line reference
 * is derived from the ingredient index AND a content digest, so a changed recipe
 * line never reuses stale evidence.
 */

import type {
  CodexNutritionV1,
  CodexNutritionV2,
  CodexNutritionV3,
  HouseholdPortionEvidence,
  IngredientEvidence,
  IngredientEvidenceV2,
} from '../schema';
import { derivedCountPortionGrams } from './liveRow';
import { derivedSourcePortionGrams, ingredientMeasurement } from './rows';
import { buildPortionChoice } from './portion';
import { buildCountPortionChoice } from './countPortion';
import { buildUserMassChoice } from './userMass';
import { buildHouseholdPortionChoice } from './householdPortion';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  CountPortionChoice,
  HouseholdPortionChoice,
  MatchChoice,
  Phase4Row,
  PortionChoice,
  UserMassChoice,
} from './types';

/** ABSOLUTE tolerance (grams) for re-matching a persisted gram amount to a portion. */
const GRAMS_EPSILON = 0.02;

export interface HydratedWorkingReview {
  readonly matches: Readonly<Record<string, MatchChoice>>;
  readonly portions: Readonly<Record<string, PortionChoice>>;
  readonly countPortions: Readonly<Record<string, CountPortionChoice>>;
  readonly userMasses: Readonly<Record<string, UserMassChoice>>;
  readonly householdPortions: Readonly<Record<string, HouseholdPortionChoice>>;
  /** Number of ingredient lines whose reviewed state was reconstructed. */
  readonly hydrated_count: number;
}

export interface HydrateWorkingReviewParams {
  readonly session: AdvancedNutritionSession;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly savedBlock: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3;
}

function parseFdcId(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function closeEnough(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= GRAMS_EPSILON;
}

/**
 * Version-neutral household evidence access. Only a schema-v2 evidence entry
 * can carry the household object (a v1 block with the key fails schema
 * validation and never reaches hydration), so the cast is safe behind the
 * `conversion_basis === 'household_portion'` guard.
 */
function householdEvidenceOf(
  evidence: IngredientEvidence | IngredientEvidenceV2
): HouseholdPortionEvidence | undefined {
  return (evidence as IngredientEvidenceV2).household_portion;
}

function manualSelectionObject(lineRef: string, match: MatchChoice): unknown {
  return {
    kind: 'manual',
    fdc_id: match.fdc_id,
    record_digest: match.record_digest,
    catalog_digest: match.catalog_digest,
    line_ref: lineRef,
    review_digest: match.review_digest,
  };
}

/**
 * Reconstructs the reviewed working state from a saved block for every
 * line-bound, re-authenticatable line. Returns `undefined` when the session is
 * not genuine or the block has no usable evidence.
 */
export function hydrateWorkingReview(
  params: HydrateWorkingReviewParams
): HydratedWorkingReview | undefined {
  const { session, adapted, rows, savedBlock } = params;
  if (!session || !savedBlock || !Array.isArray(adapted) || adapted.length === 0) return undefined;
  // A genuine session always exposes the bounded discovery operations; a partial
  // structural fake does not, and hydration simply does nothing for it.
  if (
    typeof (session as { searchFoods?: unknown }).searchFoods !== 'function' ||
    typeof session.reviewPortions !== 'function' ||
    typeof session.reviewCountPortions !== 'function' ||
    typeof session.calculate !== 'function'
  ) {
    return undefined;
  }

  const adaptedByRef = new Map(adapted.map((entry) => [entry.line_ref, entry]));
  const rowByRef = new Map(rows.map((row) => [row.line_ref, row]));
  const catalogDigest = session.metadata().catalog_digest;

  const matches: Record<string, MatchChoice> = {};
  const portions: Record<string, PortionChoice> = {};
  const countPortions: Record<string, CountPortionChoice> = {};
  const userMasses: Record<string, UserMassChoice> = {};
  const householdPortions: Record<string, HouseholdPortionChoice> = {};
  let hydrated = 0;

  /** Re-derives a reviewed manual match for one line from the pinned catalog. */
  const reviewedMatchFor = (lineRef: string, fdcId: number): MatchChoice | undefined => {
    const row = rowByRef.get(lineRef);
    if (!row) return undefined;
    const search = session.searchFoods(String(fdcId), 1);
    if (!search.ok) return undefined;
    const hit = search.results.find((result) => result.fdc_id === fdcId && result.exact_fdc_id);
    if (!hit) return undefined;
    return Object.freeze({
      kind: 'manual' as const,
      fdc_id: fdcId,
      review_digest: row.review_digest ?? '',
      record_digest: hit.record_digest,
      catalog_digest: catalogDigest,
      description: hit.description,
    });
  };

  // 1. FOOD IDENTITY + MASS from resolved reviewed evidence.
  for (const evidence of savedBlock.ingredients) {
    if (evidence.source !== 'usda_fdc' || evidence.resolved !== true) continue;
    const lineRef = evidence.line_ref;
    const entry = adaptedByRef.get(lineRef);
    if (!entry) continue;
    const fdcId = parseFdcId(evidence.source_food_id);
    if (fdcId === undefined) continue;

    const match = reviewedMatchFor(lineRef, fdcId);
    if (!match) continue;
    matches[lineRef] = match;
    hydrated += 1;

    const grams = evidence.amount?.value;
    if (typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) continue;
    // A direct recipe mass resolves from the recipe itself; no working choice.
    if (evidence.conversion_basis === 'direct_mass') continue;

    const selection = manualSelectionObject(lineRef, match);
    const measurement = ingredientMeasurement(entry);
    const row = rowByRef.get(lineRef);
    const review = row && row.outcome === 'review_required' ? row.review : undefined;
    let bound = false;

    if (evidence.conversion_basis === 'source_portion' && measurement.measurement_kind === 'count') {
      const countReview = session.reviewCountPortions(entry.ingredient, fdcId);
      if (countReview.ok) {
        for (const candidate of countReview.review.candidates) {
          const choice = buildCountPortionChoice(session, {
            lineRef,
            ingredient: entry.ingredient,
            review,
            selection,
            fdcId,
            portionIndex: candidate.index,
          });
          if (!choice.ok) continue;
          const derived = derivedCountPortionGrams(
            choice.choice.selection,
            measurement.amount ?? null
          );
          if (derived !== undefined && closeEnough(derived, grams)) {
            countPortions[lineRef] = choice.choice;
            bound = true;
            break;
          }
        }
      }
    }

    if (
      !bound &&
      evidence.conversion_basis === 'source_portion' &&
      (measurement.measurement_kind === 'volume' || measurement.measurement_kind === 'mass')
    ) {
      const portionReview = session.reviewPortions(fdcId);
      if (portionReview.ok) {
        for (const candidate of portionReview.review.candidates) {
          if (candidate.gram_weight <= 0 || candidate.effective_amount === null) continue;
          const choice = buildPortionChoice(session, {
            lineRef,
            ingredient: entry.ingredient,
            review,
            selection,
            fdcId,
            portionIndex: candidate.index,
          });
          if (!choice.ok) continue;
          const derived = derivedSourcePortionGrams(choice.choice.selection, measurement);
          if (derived !== undefined && closeEnough(derived, grams)) {
            portions[lineRef] = choice.choice;
            bound = true;
            break;
          }
        }
      }
    }

    if (!bound && evidence.conversion_basis === 'household_portion') {
      // PHASE 6 HOUSEHOLD PROVENANCE. Reopen independently re-authenticates the
      // registry and reproduces the SAME verified household result. When the
      // registry release, record, digest, USDA binding, quantity, unit, size, or
      // state no longer matches, the row is left NEEDS AMOUNT — it is NEVER
      // degraded into `user_mass` and never silently re-resolved with a
      // different record.
      const saved = householdEvidenceOf(evidence);
      if (!saved) continue;
      if (typeof saved.registry_release !== 'string' || typeof saved.record_key !== 'string') continue;
      if (typeof saved.record_digest !== 'string') continue;
      if (typeof saved.quantity !== 'number' || !Number.isFinite(saved.quantity)) continue;
      const built = buildHouseholdPortionChoice(session, {
        lineRef,
        ingredient: entry.ingredient,
        review,
        selection,
        fdcId,
      });
      if (!built.ok) continue;
      const selectionBinding = built.choice.selection as {
        readonly registry_release?: unknown;
        readonly household_record_key?: unknown;
        readonly household_record_digest?: unknown;
        readonly household_unit?: unknown;
        readonly size_class?: unknown;
        readonly requires_state?: unknown;
        readonly quantity?: unknown;
        readonly resolved_grams?: unknown;
        readonly selection_digest?: unknown;
      } | null;
      if (!selectionBinding || typeof selectionBinding !== 'object') continue;
      const reauthenticated =
        selectionBinding.registry_release === saved.registry_release &&
        selectionBinding.household_record_key === saved.record_key &&
        selectionBinding.household_record_digest === saved.record_digest &&
        selectionBinding.household_unit === saved.household_unit &&
        (selectionBinding.size_class ?? null) === (saved.size_class ?? null) &&
        (selectionBinding.requires_state ?? null) === (saved.requires_state ?? null) &&
        selectionBinding.quantity === saved.quantity &&
        typeof selectionBinding.resolved_grams === 'number' &&
        closeEnough(selectionBinding.resolved_grams, grams);
      if (reauthenticated) {
        householdPortions[lineRef] = built.choice;
        bound = true;
      }
      // A household basis that cannot be re-authenticated stays unresolved.
    }

    if (!bound && evidence.conversion_basis === undefined) {
      // ONLY a saved line whose basis is OMITTED — the existing schema-v1
      // user-mass contract — may hydrate as a user-entered total weight. The
      // builder re-authenticates the manual food selection through the genuine
      // session; if it fails, the row stays unresolved rather than inventing
      // mass. A saved line whose basis declares a USDA portion basis
      // (`source_portion`) is NEVER converted into user mass when its portion
      // cannot be re-authenticated: the saved grams never become a
      // "user-entered" mass the user never entered (truthful fail-closed
      // degradation until the later persistence phase can preserve
      // hint-dependent count provenance).
      const userMass = buildUserMassChoice(session, {
        lineRef,
        ingredient: entry.ingredient,
        review,
        selection,
        fdcId,
        quantity: grams,
        unit: 'g',
      });
      if (userMass.ok) userMasses[lineRef] = userMass.choice;
    }
    // A `source_portion` basis that could not be re-authenticated stays
    // unresolved for mass (the reviewed food identity above is still restored):
    // no user mass, no `user-entered` label, no invented authority.
  }

  // 2. FOOD IDENTITY ONLY from reviewed evidence whose mass is still unresolved
  //    (`source_food_id` on an unresolved ref). The food restores as a
  //    user-confirmed manual choice; the row stays NEEDS AMOUNT (no mass is
  //    invented, and the line contributes zero nutrients).
  for (const ref of savedBlock.unresolved) {
    if (typeof ref.source_food_id !== 'string' || ref.source_food_id.length === 0) continue;
    const lineRef = ref.line_ref;
    if (matches[lineRef] !== undefined) continue;
    if (!adaptedByRef.has(lineRef)) continue;
    const fdcId = parseFdcId(ref.source_food_id);
    if (fdcId === undefined) continue;
    const match = reviewedMatchFor(lineRef, fdcId);
    if (!match) continue;
    matches[lineRef] = match;
    hydrated += 1;
  }

  if (hydrated === 0) return undefined;
  return Object.freeze({
    matches: Object.freeze(matches),
    portions: Object.freeze(portions),
    countPortions: Object.freeze(countPortions),
    userMasses: Object.freeze(userMasses),
    householdPortions: Object.freeze(householdPortions),
    hydrated_count: hydrated,
  });
}
