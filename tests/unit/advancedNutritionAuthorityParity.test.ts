/**
 * Advanced Nutrition Phase 0B — effective-mass authority + count-hint projection
 * parity (real pinned USDA bundle).
 *
 * Proves the north-star invariant for one recipe/line/working state:
 *   - calculator preview, live row, mass-source label/evidence, and Apply
 *     re-derivation all derive from the SAME effective mass authority;
 *   - the canonical count-requirement hint context is identical for candidate
 *     review, the calculation request, the calculator's independent
 *     re-derivation, the live projection, and AI-assisted deterministic
 *     resolution;
 *   - conflicts and stale/cross-bound/forged count state fail closed and never
 *     display a mass the calculator would not compute.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe, type RecipeAnalysis } from '../../src/core/nutritionV2/phase4/analyzer';
import {
  buildCalculationRequest,
  buildReviewRows,
  selectionFromMatchChoice,
} from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows, summarizeLiveRows, type LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import { buildPortionChoice } from '../../src/core/nutritionV2/phase4/portion';
import { buildCountPortionChoice } from '../../src/core/nutritionV2/phase4/countPortion';
import {
  canonicalCountRequirementHint,
  reviewCanonicalLineCountPortions,
} from '../../src/core/nutritionV2/phase4/countContext';
import { resolveAmountsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiAmountResolve';
import { computeCountPortionSelectionDigest } from '../../src/core/nutritionV2/calculation/countPortion';
import { computeUserMassSelectionDigest } from '../../src/core/nutritionV2/calculation/mass';
import { resolveEffectiveMassDecision } from '../../src/core/nutritionV2/calculation/effectiveMass';
import { recomputeReviewedNutrition } from '../../src/core/nutritionV2/phase4/session';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  CountPortionChoice,
  Phase4Row,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';
import type { AiResolutionSuggestion } from '../../src/core/nutritionV2/aiResolution';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) {
    throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  }
  session = result.session;
}, 180000);

function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

interface LineFlow {
  readonly recipe: { title: string; servings: number; ingredients: ReadonlyArray<Record<string, unknown>> };
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly analysis: RecipeAnalysis;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly state: Phase4State;
  readonly live: ReadonlyArray<LiveRowState>;
  readonly lineRef: string;
}

function setup(line: string): LineFlow {
  const recipe = { title: 'Parity', servings: 1, ingredients: [structuredLine(line)] };
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: 'parity-session',
    rows,
    baseServings: 1,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    preview: analysis.preview,
  });
  const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
  const live = projectLiveRows(
    state,
    analyzedByRef,
    adapted,
    session,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null
  );
  return { recipe, adapted, analysis, rows, state, live, lineRef: adapted[0].line_ref };
}

interface Calculated {
  readonly ok: boolean;
  readonly code?: string;
  readonly evidence?: {
    mass_source?: string;
    resolved_grams?: number;
    outcome: string;
    user_confirmed: boolean;
    count_unit?: string;
  };
  readonly applicationAuthorized?: boolean;
  readonly live: LiveRowState;
}

function calculateAndProject(flow: LineFlow, state: Phase4State): Calculated {
  const result = session.calculate(buildCalculationRequest(flow.adapted, state));
  const analyzedByRef = new Map(flow.analysis.rows.map((row) => [row.line_ref, row]));
  const live = projectLiveRows(
    state,
    analyzedByRef,
    flow.adapted,
    session,
    result.ok ? ingredientEvidenceViews(result.preview) : null
  )[0];
  if (!result.ok) {
    return {
      ok: false,
      code: (result as { failure: { code: string } }).failure.code,
      live,
    };
  }
  const evidence = result.preview.ingredients[0];
  return {
    ok: true,
    evidence: {
      ...(evidence.mass_source !== undefined ? { mass_source: evidence.mass_source } : {}),
      ...(evidence.resolved_grams !== undefined ? { resolved_grams: evidence.resolved_grams } : {}),
      outcome: evidence.outcome,
      user_confirmed: evidence.user_confirmed,
      ...(evidence.count_unit !== undefined ? { count_unit: evidence.count_unit } : {}),
    },
    applicationAuthorized: result.preview.application_authorized,
    live,
  };
}

function matchChoiceOf(flow: LineFlow): { fdc_id: number; automatic: boolean } {
  const choice = flow.state.matches[flow.lineRef];
  if (choice && choice.kind !== 'none') {
    return { fdc_id: choice.fdc_id, automatic: choice.automatic === true };
  }
  const selected = flow.analysis.rows[0].selected_fdc_id;
  if (selected === undefined) throw new Error('no selected food');
  return { fdc_id: selected, automatic: true };
}

/** A forged user-mass choice bound to `fdcId` (used to prove conflict fail-closed). */
function forgedUserMassChoice(lineRef: string, fdcId: number): unknown {
  return Object.freeze({
    fdc_id: fdcId,
    quantity: 100,
    unit: 'g' as const,
    selection: Object.freeze({
      calculation_version: 'usda_advisory_calc_v4',
      line_ref: lineRef,
      ingredient_identity_digest: 'forged',
      bundle_release: 'forged',
      fdc_id: fdcId,
      record_digest: 'forged',
      quantity: 100,
      unit: 'g',
      grams: 100,
      selection_digest: 'forged',
    }),
  });
}

function aiGarlicSuggestion(lineRef: string): AiResolutionSuggestion {
  return {
    line_ref: lineRef,
    interpreted_food_name: 'garlic',
    suggested_usda_queries: ['garlic'],
    quantity_value: 3,
    quantity_unit_hint: 'cloves',
    count_descriptor_hint: 'clove',
    portion_search_hint: 'clove',
  };
}

function aiResolveGarlic(flow: LineFlow): CountPortionChoice {
  const outcome = resolveAmountsFromAiSuggestions({
    session,
    rows: flow.rows,
    adapted: flow.adapted,
    liveRows: flow.live,
    state: flow.state,
    suggestions: [aiGarlicSuggestion(flow.lineRef)],
  });
  expect(outcome.resolved).toHaveLength(1);
  return outcome.resolved[0].choice;
}

// ---------------------------------------------------------------------------
// Effective-mass authority parity
// ---------------------------------------------------------------------------

describe('phase 0B — effective-mass authority parity (real bundle)', () => {
  it('direct mass only: calculator and live projection agree on the recipe mass', () => {
    const flow = setup('1.5 lb ground beef');
    const calculated = calculateAndProject(flow, flow.state);
    expect(calculated.ok).toBe(true);
    expect(calculated.evidence?.mass_source).toBe('direct_mass');
    expect(calculated.evidence?.resolved_grams).toBeCloseTo(680.388555, 3);
    expect(calculated.live.mass_source).toBe('direct_mass');
    expect(calculated.live.resolved_grams).toBeCloseTo(680.388555, 3);
    expect(calculated.live.status).toBe('matched');
  });

  it('user mass only: explicit total weight is authoritative on both surfaces with truthful provenance', () => {
    const flow = setup('8 slices bacon');
    const match = matchChoiceOf(flow);
    const choice = flow.state.matches[flow.lineRef];
    const built = buildUserMassChoice(session, {
      lineRef: flow.lineRef,
      ingredient: flow.adapted[0].ingredient,
      review: flow.rows[0].outcome === 'review_required' ? flow.rows[0].review : undefined,
      ...(choice !== undefined ? { selection: selectionFromMatchChoice(choice, flow.lineRef) } : {}),
      automaticSelection: match.automatic,
      fdcId: match.fdc_id,
      quantity: 4,
      unit: 'oz',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const state = phase4Reducer(flow.state, {
      type: 'select_user_mass',
      lineRef: flow.lineRef,
      choice: built.choice,
    });
    const calculated = calculateAndProject(flow, state);
    expect(calculated.ok).toBe(true);
    expect(calculated.evidence?.mass_source).toBe('user_mass');
    expect(calculated.evidence?.resolved_grams).toBeCloseTo(4 * 28.349523125, 6);
    expect(calculated.live.mass_source).toBe('user_mass');
    expect(calculated.live.resolved_grams).toBeCloseTo(4 * 28.349523125, 6);
    // A user-entered weight is never mislabeled as USDA portion evidence, and an
    // automatic food choice stays truthfully not user-confirmed.
    expect(calculated.evidence?.user_confirmed).toBe(false);
    expect(calculated.live.user_mass_quantity).toBe(4);
    expect(calculated.live.user_mass_unit).toBe('oz');
  });

  it('source portion only: authenticated USDA portion agrees across calculation and live', () => {
    const flow = setup('2 tbsp lemon juice');
    expect(flow.state.portions[flow.lineRef]).toBeDefined();
    const calculated = calculateAndProject(flow, flow.state);
    expect(calculated.ok).toBe(true);
    expect(calculated.evidence?.mass_source).toBe('source_portion');
    expect(calculated.live.mass_source).toBe('source_portion');
    expect(calculated.live.resolved_grams).toBeCloseTo(calculated.evidence?.resolved_grams as number, 9);
    expect(calculated.evidence?.resolved_grams).toBeCloseTo(30.5, 3);
  });

  it('count portion only: deterministic authenticated count agrees across calculation and live', () => {
    const flow = setup('3 large eggs');
    const calculated = calculateAndProject(flow, flow.state);
    expect(calculated.ok).toBe(true);
    expect(calculated.evidence?.mass_source).toBe('count_portion');
    expect(calculated.evidence?.resolved_grams).toBe(150);
    expect(calculated.live.mass_source).toBe('count_portion');
    expect(calculated.live.resolved_grams).toBe(150);
  });

  it('direct mass + user mass conflict fails closed everywhere and is never created', () => {
    const flow = setup('1 lb ground beef');
    const match = matchChoiceOf(flow);
    // The creation boundary refuses a manual total on a direct-mass line.
    const refused = buildUserMassChoice(session, {
      lineRef: flow.lineRef,
      ingredient: flow.adapted[0].ingredient,
      fdcId: match.fdc_id,
      quantity: 100,
      unit: 'g',
    });
    expect(refused.ok).toBe(false);

    // A forged/legacy conflicting state fails the calculation closed and the
    // live projection reports no mass and no source.
    const conflicted = phase4Reducer(flow.state, {
      type: 'select_user_mass',
      lineRef: flow.lineRef,
      choice: forgedUserMassChoice(flow.lineRef, match.fdc_id) as never,
    });
    const calculated = calculateAndProject(flow, conflicted);
    expect(calculated.ok).toBe(false);
    expect(calculated.code).toBe('invalid_portion_selection');
    expect(calculated.live.status).toBe('needs_amount');
    expect(calculated.live.resolved_grams).toBeUndefined();
    expect(calculated.live.mass_source).toBeUndefined();

    // The canonical decision itself is the single shared authority.
    expect(
      resolveEffectiveMassDecision({
        directMassGrams: 453.59237,
        hasUserMass: true,
        hasSourcePortion: false,
        hasCountPortion: false,
      })
    ).toEqual({ kind: 'conflict', reason: 'direct_mass_with_user_mass' });
  });

  it('multiple non-direct mass sources conflict fails closed; the reducer keeps them exclusive', () => {
    const flow = setup('2 tbsp lemon juice');
    const portionChoice = flow.state.portions[flow.lineRef];
    expect(portionChoice).toBeDefined();
    const forgedCount: CountPortionChoice = {
      fdc_id: 167747,
      portion_index: 0,
      selection: { candidates_digest: 'forged' },
      review: {},
    };
    // Reducer exclusivity: a count choice clears the source portion.
    const exclusive = phase4Reducer(flow.state, {
      type: 'select_count_portion',
      lineRef: flow.lineRef,
      choice: forgedCount,
    });
    expect(exclusive.portions[flow.lineRef]).toBeUndefined();
    expect(exclusive.countPortions[flow.lineRef]).toBeDefined();

    // A forged request carrying BOTH is a conflict, independent of either
    // selection's contents.
    const forgedState: Phase4State = {
      ...flow.state,
      portions: { ...flow.state.portions, [flow.lineRef]: portionChoice as never },
      countPortions: { ...flow.state.countPortions, [flow.lineRef]: forgedCount },
    };
    const request = buildCalculationRequest(flow.adapted, forgedState);
    const result = session.calculate(request);
    expect(result.ok).toBe(false);
    expect((result as { failure: { code: string } }).failure.code).toBe('invalid_portion_selection');
  });

  it('invalid or stale selections never display a resolved mass', () => {
    // Forged count selection: tamper the candidate digest AND recompute the
    // selection digest so the sanitizer passes and the STALE resolution path is
    // exercised (the calculator rejects it against its own candidate set).
    const garlic = setup('3 garlic cloves');
    const choice = aiResolveGarlic(garlic);
    const selection = { ...(choice.selection as Record<string, unknown>) };
    selection.candidates_digest = 'f'.repeat(64);
    const withoutDigest = { ...selection } as Record<string, unknown>;
    delete withoutDigest.selection_digest;
    selection.selection_digest = computeCountPortionSelectionDigest(
      withoutDigest as never
    );
    const forgedState = phase4Reducer(garlic.state, {
      type: 'select_count_portion',
      lineRef: garlic.lineRef,
      choice: { ...choice, selection },
    });
    const forged = calculateAndProject(garlic, forgedState);
    expect(forged.ok).toBe(true);
    expect(forged.evidence?.outcome).not.toBe('calculated');
    expect(forged.evidence?.resolved_grams).toBeUndefined();
    expect(forged.live.resolved_grams).toBeUndefined();
    expect(forged.live.mass_source).toBeUndefined();

    // Stale source portion: a tampered candidate digest is not displayed even
    // though the selection still carries usable gram fields.
    const lemon = setup('2 tbsp lemon juice');
    const portionChoice = lemon.state.portions[lemon.lineRef];
    expect(portionChoice).toBeDefined();
    if (!portionChoice) return;
    const staleSelection = {
      ...(portionChoice.selection as Record<string, unknown>),
      candidates_digest: 'f'.repeat(64),
    };
    const staleState = phase4Reducer(lemon.state, {
      type: 'select_portion',
      lineRef: lemon.lineRef,
      choice: { ...portionChoice, selection: staleSelection },
    });
    const stale = calculateAndProject(lemon, staleState);
    expect(stale.live.resolved_grams).toBeUndefined();
    expect(stale.live.mass_source).toBeUndefined();
  });

  it('re-analysis clears a stale lower-tier user mass and keeps direct authority identical', () => {
    const flow = setup('1 lb ground beef');
    const match = matchChoiceOf(flow);
    const conflicted = phase4Reducer(flow.state, {
      type: 'select_user_mass',
      lineRef: flow.lineRef,
      choice: forgedUserMassChoice(flow.lineRef, match.fdc_id) as never,
    });
    expect(conflicted.userMasses[flow.lineRef]).toBeDefined();
    const reanalyzed = phase4Reducer(conflicted, {
      type: 'apply_analysis',
      matches: flow.analysis.matches,
      portions: flow.analysis.portions,
      countPortions: flow.analysis.countPortions,
      preview: flow.analysis.preview,
    });
    expect(reanalyzed.userMasses).toEqual({});
    const calculated = calculateAndProject(flow, reanalyzed);
    expect(calculated.ok).toBe(true);
    expect(calculated.evidence?.mass_source).toBe('direct_mass');
    expect(calculated.live.mass_source).toBe('direct_mass');
    expect(calculated.live.resolved_grams).toBeCloseTo(calculated.evidence?.resolved_grams as number, 9);
  });

  it('Apply re-derivation fails closed for a conflicting displayed state', () => {
    const flow = setup('1 lb ground beef');
    const match = matchChoiceOf(flow);
    const conflicted = phase4Reducer(flow.state, {
      type: 'select_user_mass',
      lineRef: flow.lineRef,
      choice: forgedUserMassChoice(flow.lineRef, match.fdc_id) as never,
    });
    const applyState = {
      ...conflicted,
      status: 'preview_current',
      preview: {
        nutrient_scope: ['calories'],
        ...(flow.analysis.preview !== undefined ? { ingredient_digest: flow.analysis.preview.ingredient_digest } : {}),
      },
      previewKey: conflicted.recipeKey,
    } as unknown as Phase4State;
    const recomputed = recomputeReviewedNutrition(session, flow.recipe, applyState);
    expect(recomputed.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Canonical count-hint context parity
// ---------------------------------------------------------------------------

describe('phase 0B — canonical count-hint projection parity (real bundle)', () => {
  it('no-hint path: candidate set and digest are unchanged', () => {
    const flow = setup('3 garlic cloves');
    const fdcId = matchChoiceOf(flow).fdc_id;
    const review = session.reviewCountPortions(flow.adapted[0].ingredient, fdcId);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.review.applicable).toBe(false);
    expect(review.review.candidates).toHaveLength(0);
    expect(review.review.candidates_digest).toBe(
      '6c1cc2934dfe8a069bc84ef9fc1fd99fe6f7b4a733acca1490cf080b03c2dde8'
    );
  });

  it('valid hint path: review, canonical context, request, and calculator share one digest', () => {
    const flow = setup('3 garlic cloves');
    const choice = aiResolveGarlic(flow);
    expect(choice.countRequirementHint).toEqual({ unit: 'clove', size: null });
    const state = phase4Reducer(flow.state, {
      type: 'select_count_portion',
      lineRef: flow.lineRef,
      choice,
    });
    const hint = canonicalCountRequirementHint(state, flow.lineRef);
    expect(hint).toEqual({ unit: 'clove', size: null });
    const canonical = reviewCanonicalLineCountPortions(
      session,
      state,
      flow.lineRef,
      flow.adapted[0].ingredient,
      choice.fdc_id
    );
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.review.candidates).toHaveLength(2);
    expect((choice.selection as { candidates_digest: string }).candidates_digest).toBe(
      canonical.review.candidates_digest
    );
    // A successful calculation independently re-derives the same candidate set
    // and verifies the selection digest against it.
    const calculated = calculateAndProject(flow, state);
    expect(calculated.ok).toBe(true);
    expect(calculated.evidence?.mass_source).toBe('count_portion');
    expect(calculated.evidence?.resolved_grams).toBe(9);
    expect(calculated.live.mass_source).toBe('count_portion');
    expect(calculated.live.resolved_grams).toBe(9);
  });

  it('garlic regression: AI-assisted count resolves to MATCHED 9 g with explicit Apply and truthful provenance', () => {
    for (const line of ['3 garlic cloves', '3 cloves garlic']) {
      const flow = setup(line);
      const before = summarizeLiveRows(flow.live);
      expect(before.needs_amount).toBe(1);

      const choice = aiResolveGarlic(flow);
      expect(choice.fdc_id).toBe(169230);
      expect(choice.aiAssisted).toBe(true);
      expect(choice.automatic).toBe(true);
      const state = phase4Reducer(flow.state, {
        type: 'select_count_portion',
        lineRef: flow.lineRef,
        choice,
      });
      const calculated = calculateAndProject(flow, state);
      expect(calculated.ok, line).toBe(true);
      expect(calculated.evidence?.outcome).toBe('calculated');
      expect(calculated.evidence?.mass_source).toBe('count_portion');
      expect(calculated.evidence?.resolved_grams).toBe(9);
      expect(calculated.evidence?.count_unit).toBe('clove');
      expect(calculated.evidence?.user_confirmed).toBe(false);
      expect(calculated.applicationAuthorized).toBe(false);
      expect(calculated.live.status).toBe('matched');
      expect(calculated.live.mass_source).toBe('count_portion');
      expect(calculated.live.resolved_grams).toBe(9);
      expect(calculated.live.selected_fdc_id).toBe(169230);
      expect(summarizeLiveRows([calculated.live]).needs_amount).toBe(0);
    }
  });

  it('unsupported or forged hints fail closed and never bind mass', () => {
    const flow = setup('3 garlic cloves');
    const fdcId = matchChoiceOf(flow).fdc_id;
    // Closed-vocabulary rejection at the review boundary.
    expect(session.reviewCountPortions(flow.adapted[0].ingredient, fdcId, { unit: 'bogus' }).ok).toBe(false);
    expect(
      session.reviewCountPortions(flow.adapted[0].ingredient, fdcId, {
        unit: 'clove',
        size: null,
        grams: 100,
      } as never).ok
    ).toBe(false);
    // A malformed stored hint is ignored by the canonical context ...
    const choice = aiResolveGarlic(flow);
    const forgedState = phase4Reducer(flow.state, {
      type: 'select_count_portion',
      lineRef: flow.lineRef,
      choice: { ...choice, countRequirementHint: { unit: 'bogus', size: null } },
    });
    expect(canonicalCountRequirementHint(forgedState, flow.lineRef)).toBeUndefined();
    // ... so the real selection digest no longer matches the no-hint context and
    // no mass is ever bound.
    const calculated = calculateAndProject(flow, forgedState);
    expect(calculated.evidence?.resolved_grams).toBeUndefined();
    expect(calculated.live.resolved_grams).toBeUndefined();
    // A raw forged hint in a calculation request is rejected wholesale.
    const rawRequest = {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: flow.lineRef,
          ingredient: flow.adapted[0].ingredient,
          count_requirement_hint: { unit: 'bogus' },
        },
      ],
    };
    expect(session.calculate(rawRequest).ok).toBe(false);
  });

  it('a count context cannot bind to a changed food', () => {
    const garlic = setup('3 garlic cloves');
    const choice = aiResolveGarlic(garlic);
    const garlicState = phase4Reducer(garlic.state, {
      type: 'select_count_portion',
      lineRef: garlic.lineRef,
      choice,
    });
    // The reducer clears the count choice when the food changes.
    const changed = phase4Reducer(garlicState, {
      type: 'select_match',
      lineRef: garlic.lineRef,
      choice: { kind: 'manual', fdc_id: 11215, review_digest: 'd'.repeat(64), record_digest: 'r'.repeat(64), catalog_digest: 'c'.repeat(64) },
    });
    expect(changed.countPortions[garlic.lineRef]).toBeUndefined();

    // A cross-food selection fails the calculator's record binding.
    const onion = setup('1 medium onion');
    const onionMatch = matchChoiceOf(onion);
    const crossFood: Phase4State = {
      ...onion.state,
      countPortions: { ...onion.state.countPortions, [onion.lineRef]: choice },
    };
    const calculated = calculateAndProject(onion, crossFood);
    expect(calculated.evidence?.resolved_grams).toBeUndefined();
    expect(calculated.live.resolved_grams).toBeUndefined();
    expect(onionMatch.fdc_id).not.toBe(choice.fdc_id);
  });

  it('a quantity change invalidates the stale selection and never reuses its grams', () => {
    const three = setup('3 garlic cloves');
    const choice = aiResolveGarlic(three);
    const two = setup('2 garlic cloves');
    const staleState: Phase4State = {
      ...two.state,
      countPortions: { ...two.state.countPortions, [two.lineRef]: choice },
    };
    const calculated = calculateAndProject(two, staleState);
    expect(calculated.evidence?.resolved_grams).toBeUndefined();
    expect(calculated.live.resolved_grams).toBeUndefined();
    // The canonical context for the current quantity is a different digest.
    const canonical = reviewCanonicalLineCountPortions(
      session,
      staleState,
      two.lineRef,
      two.adapted[0].ingredient,
      choice.fdc_id
    );
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect((choice.selection as { candidates_digest: string }).candidates_digest).not.toBe(
      canonical.review.candidates_digest
    );
  });

  it('line cross-binding is rejected (selection belongs to another line)', () => {
    const flow = setup('3 garlic cloves');
    const choice = aiResolveGarlic(flow);
    const request = {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: 'some-other-line',
          ingredient: flow.adapted[0].ingredient,
          count_portion_selection: choice.selection,
          count_requirement_hint: choice.countRequirementHint,
        },
      ],
    };
    const result = session.calculate(request);
    if (result.ok) {
      expect(result.preview.ingredients[0].resolved_grams).toBeUndefined();
      expect(result.preview.ingredients[0].outcome).not.toBe('calculated');
    } else {
      expect((result as { failure: { code: string } }).failure.code).toBe('invalid_portion_selection');
    }
  });

  it('prototype-key, unknown-key, and oversized hint shapes fail closed without throwing', () => {
    const flow = setup('3 garlic cloves');
    const fdcId = matchChoiceOf(flow).fdc_id;
    const ingredient = flow.adapted[0].ingredient;
    const prototypeKeyed = JSON.parse('{"__proto__":{"unit":"clove"}}') as unknown;
    expect(session.reviewCountPortions(ingredient, fdcId, prototypeKeyed).ok).toBe(false);
    expect(
      session.reviewCountPortions(ingredient, fdcId, { unit: 'clove', size: null, fdc_id: 169230 } as never).ok
    ).toBe(false);
    const oversized = 'c'.repeat(100000);
    expect(() => session.reviewCountPortions(ingredient, fdcId, { unit: oversized })).not.toThrow();
    expect(session.reviewCountPortions(ingredient, fdcId, { unit: oversized }).ok).toBe(false);
  });

  it('a count selection with a stale catalog/record binding never binds mass or displays', () => {
    const flow = setup('3 garlic cloves');
    const choice = aiResolveGarlic(flow);
    const selection = { ...(choice.selection as Record<string, unknown>), bundle_release: 'forged' };
    const state = phase4Reducer(flow.state, {
      type: 'select_count_portion',
      lineRef: flow.lineRef,
      choice: { ...choice, selection },
    });
    const calculated = calculateAndProject(flow, state);
    expect(calculated.evidence?.resolved_grams).toBeUndefined();
    expect(calculated.live.resolved_grams).toBeUndefined();
    expect(calculated.live.mass_source).toBeUndefined();
  });

  it('non-finite/forged user-mass selection input fails closed at the calculation boundary', () => {
    const flow = setup('8 slices bacon');
    const match = matchChoiceOf(flow);
    const choice = flow.state.matches[flow.lineRef];
    const base = {
      calculation_version: 'usda_advisory_calc_v4',
      line_ref: flow.lineRef,
      ingredient_identity_digest: 'forged',
      bundle_release: 'forged',
      fdc_id: match.fdc_id,
      record_digest: 'forged',
      unit: 'g',
      selection_digest: 'forged',
    };
    for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
      const result = session.calculate({
        servings: 1,
        nutrient_scope: ['calories'],
        ingredients: [
          {
            line_ref: flow.lineRef,
            ingredient: flow.adapted[0].ingredient,
            ...(choice !== undefined
              ? { review: flow.rows[0].review, selection: selectionFromMatchChoice(choice, flow.lineRef) }
              : {}),
            ...(choice?.automatic === true ? { automatic_selection: true } : {}),
            user_mass_selection: { ...base, quantity, grams: 100 },
          },
        ],
      });
      expect(result.ok, `quantity ${quantity}`).toBe(false);
    }
  });

  it('candidate-set digest is identical across review, stored selection and manual selection', () => {
    const flow = setup('3 cloves garlic');
    const choice = aiResolveGarlic(flow);
    const state = phase4Reducer(flow.state, {
      type: 'select_count_portion',
      lineRef: flow.lineRef,
      choice,
    });
    // The stored AI selection digest equals the canonical review digest and the
    // candidate review the modal renders.
    const canonical = reviewCanonicalLineCountPortions(
      session,
      state,
      flow.lineRef,
      flow.adapted[0].ingredient,
      choice.fdc_id
    );
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const aiDigest = (choice.selection as { candidates_digest: string }).candidates_digest;
    expect(aiDigest).toBe(canonical.review.candidates_digest);

    // A manual selection through the same canonical context preserves the hint
    // and therefore the same digest.
    const manual = phase4Reducer(state, { type: 'clear_count_portion', lineRef: flow.lineRef });
    const rebuilt = phase4Reducer(manual, {
      type: 'select_count_portion',
      lineRef: flow.lineRef,
      choice: { ...choice, automatic: false, aiAssisted: false },
    });
    const rebuiltCanonical = reviewCanonicalLineCountPortions(
      session,
      rebuilt,
      flow.lineRef,
      flow.adapted[0].ingredient,
      choice.fdc_id
    );
    expect(rebuiltCanonical.ok).toBe(true);
    if (!rebuiltCanonical.ok) return;
    expect((choice.selection as { candidates_digest: string }).candidates_digest).toBe(
      rebuiltCanonical.review.candidates_digest
    );
    const calculated = calculateAndProject(flow, rebuilt);
    expect(calculated.evidence?.resolved_grams).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// I-1 — direct mass is EXCLUSIVE with every alternate mass choice
// ---------------------------------------------------------------------------

describe('phase 0B final parity — direct-mass exclusivity (I-1, real bundle)', () => {
  it('the ONE shared creation gate refuses every alternate mass choice on a direct-mass line', () => {
    const flow = setup('1 lb ground beef');
    const match = matchChoiceOf(flow);
    const choice = flow.state.matches[flow.lineRef];
    const base = {
      lineRef: flow.lineRef,
      ingredient: flow.adapted[0].ingredient,
      review: flow.rows[0].outcome === 'review_required' ? flow.rows[0].review : undefined,
      ...(choice !== undefined ? { selection: selectionFromMatchChoice(choice, flow.lineRef) } : {}),
      automaticSelection: match.automatic,
    };
    expect(buildUserMassChoice(session, { ...base, fdcId: match.fdc_id, quantity: 100, unit: 'g' }).ok).toBe(false);
    expect(
      buildPortionChoice(session, { ...base, fdcId: match.fdc_id, portionIndex: 0 }).ok
    ).toBe(false);
    expect(
      buildCountPortionChoice(session, { ...base, fdcId: match.fdc_id, portionIndex: 0 }).ok
    ).toBe(false);
  });

  it('the effective-mass decision makes direct mass exclusive with every alternate (truth table)', () => {
    const direct = 453.59237;
    expect(resolveEffectiveMassDecision({ directMassGrams: direct, hasUserMass: false, hasSourcePortion: false, hasCountPortion: false })).toEqual({ kind: 'direct_mass', grams: direct });
    expect(resolveEffectiveMassDecision({ directMassGrams: direct, hasUserMass: true, hasSourcePortion: false, hasCountPortion: false })).toEqual({ kind: 'conflict', reason: 'direct_mass_with_user_mass' });
    expect(resolveEffectiveMassDecision({ directMassGrams: direct, hasUserMass: false, hasSourcePortion: true, hasCountPortion: false })).toEqual({ kind: 'conflict', reason: 'direct_mass_with_source_portion' });
    expect(resolveEffectiveMassDecision({ directMassGrams: direct, hasUserMass: false, hasSourcePortion: false, hasCountPortion: true })).toEqual({ kind: 'conflict', reason: 'direct_mass_with_count_portion' });
    expect(resolveEffectiveMassDecision({ directMassGrams: direct, hasUserMass: true, hasSourcePortion: true, hasCountPortion: true })).toEqual({ kind: 'conflict', reason: 'direct_mass_with_multiple_alternates' });
  });

  it.each([
    ['user', 'direct_mass_with_user_mass'],
    ['source', 'direct_mass_with_source_portion'],
    ['count', 'direct_mass_with_count_portion'],
    ['all', 'direct_mass_with_multiple_alternates'],
  ] as const)('hand-built direct + %s fails the calculator and live projection identically', (alternate, reason) => {
    const flow = setup('1 lb ground beef');
    const match = matchChoiceOf(flow);
    const forgedCount: CountPortionChoice = {
      fdc_id: match.fdc_id,
      portion_index: 0,
      selection: { candidates_digest: 'forged' },
      review: {},
    };
    const conflicted: Phase4State = {
      ...flow.state,
      ...(alternate !== 'count'
        ? {}
        : { countPortions: { ...flow.state.countPortions, [flow.lineRef]: forgedCount } }),
      ...(alternate === 'user' || alternate === 'all'
        ? { userMasses: { ...flow.state.userMasses, [flow.lineRef]: forgedUserMassChoice(flow.lineRef, match.fdc_id) as never } }
        : {}),
      ...(alternate === 'source' || alternate === 'all'
        ? {
            portions: {
              ...flow.state.portions,
              [flow.lineRef]: {
                fdc_id: match.fdc_id,
                portion_index: 0,
                selection: { candidates_digest: 'forged' },
                review: {},
              },
            },
          }
        : {}),
    } as Phase4State;
    const calculated = calculateAndProject(flow, conflicted);
    // Fail closed on BOTH surfaces: no authoritative mass, no matched badge.
    expect(calculated.ok).toBe(false);
    expect(calculated.code).toBe('invalid_portion_selection');
    expect(calculated.live.status).not.toBe('matched');
    expect(calculated.live.resolved_grams).toBeUndefined();
    expect(calculated.live.mass_source).toBeUndefined();
    // The decision itself names the documented reason.
    expect(
      resolveEffectiveMassDecision({
        directMassGrams: 453.59237,
        hasUserMass: alternate === 'user' || alternate === 'all',
        hasSourcePortion: alternate === 'source' || alternate === 'all',
        hasCountPortion: alternate === 'count' || alternate === 'all',
      })
    ).toEqual({ kind: 'conflict', reason });
  });

  it('Apply refuses every direct+alternate conflict', () => {
    for (const alternate of ['user', 'source', 'count'] as const) {
      const flow = setup('1 lb ground beef');
      const match = matchChoiceOf(flow);
      const conflicted: Phase4State = {
        ...flow.state,
        ...(alternate === 'count'
          ? { countPortions: { ...flow.state.countPortions, [flow.lineRef]: { fdc_id: match.fdc_id, portion_index: 0, selection: { candidates_digest: 'x' }, review: {} } } }
          : {}),
        ...(alternate === 'user'
          ? { userMasses: { ...flow.state.userMasses, [flow.lineRef]: forgedUserMassChoice(flow.lineRef, match.fdc_id) as never } }
          : {}),
        ...(alternate === 'source'
          ? { portions: { ...flow.state.portions, [flow.lineRef]: { fdc_id: match.fdc_id, portion_index: 0, selection: { candidates_digest: 'x' }, review: {} } } }
          : {}),
      } as Phase4State;
      const applyState = {
        ...conflicted,
        status: 'preview_current',
        preview: { nutrient_scope: ['calories'] },
        previewKey: conflicted.recipeKey,
      } as unknown as Phase4State;
      const recomputed = recomputeReviewedNutrition(session, flow.recipe, applyState);
      expect(recomputed.ok, alternate).toBe(false);
    }
  });

  it('re-analysis clears stale invalid alternates and restores direct authority (portion variant)', () => {
    const flow = setup('1 lb ground beef');
    const match = matchChoiceOf(flow);
    const conflicted: Phase4State = {
      ...flow.state,
      portions: { ...flow.state.portions, [flow.lineRef]: { fdc_id: match.fdc_id, portion_index: 0, selection: { candidates_digest: 'x' }, review: {} } },
    };
    expect(conflicted.portions[flow.lineRef]).toBeDefined();
    const reanalyzed = phase4Reducer(conflicted, {
      type: 'apply_analysis',
      matches: flow.analysis.matches,
      portions: flow.analysis.portions,
      countPortions: flow.analysis.countPortions,
      preview: flow.analysis.preview,
    });
    expect(reanalyzed.portions).toEqual({});
    const calculated = calculateAndProject(flow, reanalyzed);
    expect(calculated.ok).toBe(true);
    expect(calculated.evidence?.mass_source).toBe('direct_mass');
    expect(calculated.live.mass_source).toBe('direct_mass');
    expect(calculated.live.resolved_grams).toBeCloseTo(calculated.evidence?.resolved_grams as number, 9);
  });
});

// ---------------------------------------------------------------------------
// F-1 — full-binding live display verification (calculator/live agreement)
// ---------------------------------------------------------------------------

describe('phase 0B final parity — full-binding display verification (F-1, real bundle)', () => {
  interface TamperCase {
    readonly name: string;
    readonly mutate?: (selection: Record<string, unknown>) => void;
    /** Whether the tampered selection digest must be recomputed to pass sanitization. */
    readonly recomputeCountDigest?: boolean;
  }

  it('count: a valid builder-created choice agrees, and every forged binding is withheld identically by calculator AND live', () => {
    const flow = setup('3 garlic cloves');
    const choice = aiResolveGarlic(flow);
    const validState = phase4Reducer(flow.state, { type: 'select_count_portion', lineRef: flow.lineRef, choice });
    const valid = calculateAndProject(flow, validState);
    expect(valid.evidence?.mass_source).toBe('count_portion');
    expect(valid.live.mass_source).toBe('count_portion');
    expect(valid.live.resolved_grams).toBe(9);

    const selection = () => ({ ...(choice.selection as Record<string, unknown>) });
    const cases: ReadonlyArray<TamperCase> = [
      { name: 'identity digest', mutate: (s) => { s.ingredient_identity_digest = 'f'.repeat(64); }, recomputeCountDigest: true },
      { name: 'line_ref', mutate: (s) => { s.line_ref = 'other-line'; }, recomputeCountDigest: true },
      { name: 'fdc_id', mutate: (s) => { s.fdc_id = 2027; }, recomputeCountDigest: true },
      { name: 'bundle_release', mutate: (s) => { s.bundle_release = 'forged'; }, recomputeCountDigest: true },
      { name: 'catalog_digest', mutate: (s) => { s.catalog_digest = 'f'.repeat(64); }, recomputeCountDigest: true },
      { name: 'record_digest', mutate: (s) => { s.record_digest = 'f'.repeat(64); }, recomputeCountDigest: true },
      { name: 'candidates_digest', mutate: (s) => { s.candidates_digest = 'f'.repeat(64); }, recomputeCountDigest: true },
      { name: 'portion_index', mutate: (s) => { s.portion_index = 999; }, recomputeCountDigest: true },
      { name: 'gram_weight', mutate: (s) => { s.gram_weight = 99; }, recomputeCountDigest: true },
      { name: 'portion_amount', mutate: (s) => { s.portion_amount = 99; }, recomputeCountDigest: true },
      { name: 'measure', mutate: (s) => { s.measure = 'forged'; }, recomputeCountDigest: true },
    ];
    for (const testCase of cases) {
      const s = selection();
      testCase.mutate(s);
      if (testCase.recomputeCountDigest) {
        const withoutDigest = { ...s };
        delete withoutDigest.selection_digest;
        s.selection_digest = computeCountPortionSelectionDigest(withoutDigest as never);
      }
      const state = phase4Reducer(flow.state, {
        type: 'select_count_portion',
        lineRef: flow.lineRef,
        choice: { ...choice, selection: s },
      });
      const calculated = calculateAndProject(flow, state);
      const calcWithheld = !calculated.ok || calculated.evidence?.resolved_grams === undefined;
      expect(calcWithheld, `count ${testCase.name}: calculator must withhold`).toBe(true);
      expect(calculated.live.resolved_grams, `count ${testCase.name}: live must withhold`).toBeUndefined();
      expect(calculated.live.mass_source, `count ${testCase.name}: live must withhold source`).toBeUndefined();
      expect(calculated.live.status, `count ${testCase.name}: no false matched badge`).not.toBe('matched');
    }
  });

  it('source: a valid auto portion agrees, and forged/stale bindings are rejected identically', () => {
    const flow = setup('2 tbsp lemon juice');
    const portionChoice = flow.state.portions[flow.lineRef];
    expect(portionChoice).toBeDefined();
    if (!portionChoice) return;
    const valid = calculateAndProject(flow, flow.state);
    expect(valid.evidence?.mass_source).toBe('source_portion');
    expect(valid.live.mass_source).toBe('source_portion');

    const selection = () => ({ ...(portionChoice.selection as Record<string, unknown>) });
    const cases: ReadonlyArray<TamperCase> = [
      { name: 'identity digest' },
      { name: 'line_ref' },
      { name: 'fdc_id' },
      { name: 'bundle_release' },
      { name: 'record_digest' },
      { name: 'candidates_digest' },
      { name: 'portion_index' },
      { name: 'portion_amount' },
      { name: 'measure' },
      { name: 'gram_weight' },
      { name: 'semantics_kind' },
      { name: 'semantics_amount' },
    ];
    for (const testCase of cases) {
      const s = selection();
      const original = (portionChoice.selection as Record<string, unknown>)[testCase.name];
      if (typeof original === 'number') (s as Record<string, unknown>)[testCase.name] = original + 1;
      else if (typeof original === 'string') (s as Record<string, unknown>)[testCase.name] = `${original}-forged`;
      else (s as Record<string, unknown>)[testCase.name] = 'f'.repeat(64);
      const state = phase4Reducer(flow.state, {
        type: 'select_portion',
        lineRef: flow.lineRef,
        choice: { ...(portionChoice as unknown as Record<string, unknown>), selection: s } as never,
      });
      const calculated = calculateAndProject(flow, state);
      const calcWithheld = !calculated.ok || calculated.evidence?.resolved_grams === undefined;
      expect(calcWithheld, `source ${testCase.name}: calculator must withhold`).toBe(true);
      expect(calculated.live.resolved_grams, `source ${testCase.name}: live must withhold`).toBeUndefined();
      expect(calculated.live.mass_source, `source ${testCase.name}: live must withhold source`).toBeUndefined();
      expect(calculated.live.status, `source ${testCase.name}: no false matched badge`).not.toBe('matched');
    }
  });

  it('user mass: forged bindings and non-finite/invalid quantities are withheld by calculator AND live', () => {
    const flow = setup('8 slices bacon');
    const match = matchChoiceOf(flow);
    const choice = flow.state.matches[flow.lineRef];
    const built = buildUserMassChoice(session, {
      lineRef: flow.lineRef,
      ingredient: flow.adapted[0].ingredient,
      review: flow.rows[0].outcome === 'review_required' ? flow.rows[0].review : undefined,
      ...(choice !== undefined ? { selection: selectionFromMatchChoice(choice, flow.lineRef) } : {}),
      automaticSelection: match.automatic,
      fdcId: match.fdc_id,
      quantity: 4,
      unit: 'oz',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validState = phase4Reducer(flow.state, { type: 'select_user_mass', lineRef: flow.lineRef, choice: built.choice });
    const valid = calculateAndProject(flow, validState);
    expect(valid.evidence?.mass_source).toBe('user_mass');
    expect(valid.live.mass_source).toBe('user_mass');
    expect(valid.live.resolved_grams).toBeCloseTo(4 * 28.349523125, 6);

    const base = built.choice.selection as Record<string, unknown>;
    const recomputed = (s: Record<string, unknown>) => {
      const withoutDigest = { ...s };
      delete withoutDigest.selection_digest;
      return computeUserMassSelectionDigest(withoutDigest as never);
    };
    const cases: ReadonlyArray<{ name: string; mutate: (s: Record<string, unknown>) => void; recompute?: boolean }> = [
      { name: 'identity digest', mutate: (s) => { s.ingredient_identity_digest = 'f'.repeat(64); }, recompute: true },
      { name: 'line_ref', mutate: (s) => { s.line_ref = 'other-line'; }, recompute: true },
      { name: 'fdc_id', mutate: (s) => { s.fdc_id = 2027; }, recompute: true },
      { name: 'bundle_release', mutate: (s) => { s.bundle_release = 'forged'; }, recompute: true },
      { name: 'record_digest', mutate: (s) => { s.record_digest = 'f'.repeat(64); }, recompute: true },
      { name: 'quantity', mutate: (s) => { s.quantity = 9; s.grams = 9; }, recompute: true },
    ];
    for (const testCase of cases) {
      const s = { ...(built.choice.selection as Record<string, unknown>) };
      testCase.mutate(s);
      if (testCase.recompute) s.selection_digest = recomputed(s);
      const state = phase4Reducer(flow.state, {
        type: 'select_user_mass',
        lineRef: flow.lineRef,
        choice: { ...built.choice, selection: s },
      });
      const calculated = calculateAndProject(flow, state);
      const calcWithheld = !calculated.ok || calculated.evidence?.resolved_grams === undefined;
      expect(calcWithheld, `user ${testCase.name}: calculator must withhold`).toBe(true);
      expect(calculated.live.resolved_grams, `user ${testCase.name}: live must withhold`).toBeUndefined();
      expect(calculated.live.mass_source, `user ${testCase.name}: live must withhold source`).toBeUndefined();
      expect(calculated.live.status, `user ${testCase.name}: no false matched badge`).not.toBe('matched');
    }

    // A fully forged hand-built user mass: no grams, no source, no badge, and
    // the whole calculation request fails closed.
    const forgedState = phase4Reducer(flow.state, {
      type: 'select_user_mass',
      lineRef: flow.lineRef,
      choice: forgedUserMassChoice(flow.lineRef, match.fdc_id) as never,
    });
    const forged = calculateAndProject(flow, forgedState);
    expect(forged.live.status).not.toBe('matched');
    expect(forged.live.resolved_grams).toBeUndefined();
    expect(forged.live.mass_source).toBeUndefined();
    // NaN/infinite/zero/negative never bind anywhere.
    for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
      const refused = buildUserMassChoice(session, {
        lineRef: flow.lineRef,
        ingredient: flow.adapted[0].ingredient,
        review: flow.rows[0].review,
        ...(choice !== undefined ? { selection: selectionFromMatchChoice(choice, flow.lineRef) } : {}),
        automaticSelection: match.automatic,
        fdcId: match.fdc_id,
        quantity,
        unit: 'g',
      });
      expect(refused.ok, `quantity ${quantity}`).toBe(false);
    }
  });

  it('changed quantity and changed food identity invalidate both surfaces identically', () => {
    const three = setup('3 garlic cloves');
    const choice = aiResolveGarlic(three);
    // Quantity change: the same selection against a different parsed amount.
    const two = setup('2 garlic cloves');
    const staleState: Phase4State = {
      ...two.state,
      countPortions: { ...two.state.countPortions, [two.lineRef]: choice },
    };
    const stale = calculateAndProject(two, staleState);
    expect(stale.evidence?.resolved_grams).toBeUndefined();
    expect(stale.live.resolved_grams).toBeUndefined();
    // Changed food identity: the same count choice bound to another food.
    const onion = setup('1 medium onion');
    const crossFood: Phase4State = {
      ...onion.state,
      countPortions: { ...onion.state.countPortions, [onion.lineRef]: choice },
    };
    const cross = calculateAndProject(onion, crossFood);
    expect(cross.evidence?.resolved_grams).toBeUndefined();
    expect(cross.live.resolved_grams).toBeUndefined();
    expect(cross.live.mass_source).toBeUndefined();
  });
});
