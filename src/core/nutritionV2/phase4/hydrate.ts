import { buildAiEstimateSelection } from './aiEstimateSelection';
import { aiEstimateSnapshotBinding } from './aiEstimateValidation';
import { parseIngredient } from '../matching/parse';
import { phase4SessionIdentity } from './types';
import { validateAiNutrientContributions, type AiNutrientContribution } from '../aiContribution';
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
  CodexNutritionV4,
  CodexNutritionV5,
  HouseholdPortionEvidence,
  IngredientEvidence,
  IngredientEvidenceV2,
  IngredientEvidenceV4,
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
  AiEstimateChoice,
} from './types';

/** ABSOLUTE tolerance (grams) for re-matching a persisted gram amount to a portion. */
const GRAMS_EPSILON = 0.02;

export interface HydratedWorkingReview {
  readonly aiNutrition?: { readonly recipe_key: string; readonly servings: number; readonly contributions: ReadonlyArray<AiNutrientContribution> };
  readonly aiEstimates: Readonly<Record<string, AiEstimateChoice>>;
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
  readonly recipeKey?: string;
  readonly baseServings?: number;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly instructions?: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly savedBlock: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3 | CodexNutritionV4 | CodexNutritionV5;
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
  evidence: IngredientEvidence | IngredientEvidenceV2 | IngredientEvidenceV4
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
  const { session, recipeKey, baseServings, adapted, rows, savedBlock } = params;
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

  const aiEstimates: Record<string, AiEstimateChoice> = {};
  const matches: Record<string, MatchChoice> = {};
  const portions: Record<string, PortionChoice> = {};
  const countPortions: Record<string, CountPortionChoice> = {};
  const userMasses: Record<string, UserMassChoice> = {};
  const householdPortions: Record<string, HouseholdPortionChoice> = {};
  let aiNutrition: HydratedWorkingReview['aiNutrition'];
  if (savedBlock.schema === 5 && Array.isArray(savedBlock.ai_contributions) && recipeKey && savedBlock.servings === baseServings) {
    const lineRefs = adapted.map((entry) => entry.line_ref);
    const validated = validateAiNutrientContributions(savedBlock.ai_contributions, {
      recipe_digest: savedBlock.ingredient_digest,
      line_refs: lineRefs,
      line_text_by_ref: Object.fromEntries(adapted.map((entry) => [entry.line_ref, entry.ingredient.original])),
      instructions: params.instructions,
      requireExclusionContext: true,
    });
    if (validated.ok && validated.contributions.every((entry) => lineRefs.includes(entry.line_ref))) {
      aiNutrition = { recipe_key: recipeKey, servings: savedBlock.servings, contributions: validated.contributions };
    }
  }
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
    if (!match || evidence.source_release !== session.metadata().bundle_release) continue;
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
    if (evidence.conversion_basis === 'estimated_quantity') {
      const q = (evidence as IngredientEvidenceV4).quantity_estimate;
      // The schema validates the range/basis/amount coupling. Reopening still
      // requires the same authored line and the current authenticated USDA food.
      if (!q || !closeEnough(q.representative_grams, grams)) continue;
      const dry = session.calculate({ servings: 1, nutrient_scope: ['calories'], ingredients: [{ line_ref: lineRef, ingredient: entry.ingredient, selection }] });
      if (!dry.ok) continue;
      const e = dry.preview.ingredients[0];
      if (!e || e.fdc_id !== fdcId || !e.record_digest || e.resolved_grams !== undefined) continue;
      const parsed = parseIngredient(entry.ingredient);
      if (!parsed.ok) continue;
      const snapshot = aiEstimateSnapshotBinding({
        lineRef, sourceText: parsed.parsed.original_text, amount: parsed.parsed.amount,
        unit: parsed.parsed.raw_unit ?? null, countNoun: parsed.parsed.count_noun ?? null,
        fdcId, recordDigest: e.record_digest, reviewDigest: row?.review_digest ?? '',
        bundleRelease: dry.preview.bundle_release, catalogDigest,
        recipeKey: null, sessionIdentity: phase4SessionIdentity(session.metadata()),
      });
      const choice = { ...q, fdc_id: fdcId, record_digest: e.record_digest, review_digest: row?.review_digest ?? '', snapshot_binding: snapshot };
      const built = buildAiEstimateSelection(lineRef, { line_ref: lineRef, fdc_id: fdcId, record_digest: e.record_digest, ingredient_identity_digest: e.ingredient_identity_digest, bundle_release: dry.preview.bundle_release }, choice as AiEstimateChoice);
      if (built.ok) aiEstimates[lineRef] = { ...choice, selection: built.selection };
      continue;
    }
    let bound = false;

    if (evidence.conversion_basis === 'source_portion' &&
      (measurement.measurement_kind === 'count' || (evidence as IngredientEvidenceV4).count_portion !== undefined)) {
      const savedCount = (evidence as IngredientEvidenceV4).count_portion;
      const countHint = savedCount ? { unit: savedCount.unit, size: savedCount.size } : undefined;
      const countReview = session.reviewCountPortions(entry.ingredient, fdcId, countHint);
      if (countReview.ok) {
        for (const candidate of countReview.review.candidates) {
          const choice = buildCountPortionChoice(session, {
            lineRef,
            ingredient: entry.ingredient,
            review,
            selection,
            fdcId,
            portionIndex: candidate.index,
            ...(countHint ? { countRequirementHint: countHint } : {}),
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

  if (hydrated === 0 && !aiNutrition) return undefined;
  return Object.freeze({
    ...(aiNutrition ? { aiNutrition: Object.freeze(aiNutrition) } : {}),
    aiEstimates: Object.freeze(aiEstimates),
    matches: Object.freeze(matches),
    portions: Object.freeze(portions),
    countPortions: Object.freeze(countPortions),
    userMasses: Object.freeze(userMasses),
    householdPortions: Object.freeze(householdPortions),
    hydrated_count: hydrated,
  });
}
