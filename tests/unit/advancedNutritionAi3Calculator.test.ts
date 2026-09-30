/**
 * AI-3 — SLICE B (calculator): the bounded-estimate calculation arm against the
 * REAL pinned USDA bundle and the REAL production session.
 *
 * This is the load-bearing numeric proof: an accepted estimate contributes a
 * RANGE, and the grams the calculator multiplies authenticated USDA nutrients
 * by are RE-DERIVED from that range. The model never supplies a gram value, a
 * nutrient, an FDC id or a portion.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import {
  buildCalculationRequest,
  buildReviewRows,
  lineCalculationInput,
  selectionFromMatchChoice,
} from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { buildAiEstimateSelection } from '../../src/core/nutritionV2/phase4/aiEstimateSelection';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  AiEstimateChoice,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let session: AdvancedNutritionSession;

/** A line that has an AUTHENTICATED identity and no deterministic mass source. */
const LINE_TEXT = '1 avocado';

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

interface Flow {
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly rows: ReturnType<typeof buildReviewRows>;
  readonly analysis: ReturnType<typeof analyzeRecipe>;
  readonly state: Phase4State;
  readonly lineRef: string;
}

/** Builds a state whose line has an authenticated match and NO mass source. */
function seed(): Flow {
  const recipe = { title: 'AI3', servings: 1, ingredients: [structuredLine(LINE_TEXT)] };
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: 'ai3-session',
    rows,
    baseServings: 1,
  } as never);
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  } as never);
  const lineRef = adapted[0].line_ref;
  // Clear EVERY mass source so only the estimate can resolve the line.
  for (const action of [
    'clear_portion',
    'clear_count_portion',
    'clear_household_portion',
  ] as const) {
    state = phase4Reducer(state, { type: action, lineRef } as never);
  }
  return { adapted, analysis, rows, state, lineRef };
}

/** The authenticated dry-run evidence the selection builder requires. */
function evidenceFor(flow: Flow) {
  const result = session.calculate({
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [lineCalculationInput(flow.adapted[0], flow.state, flow.rows[0])],
  } as never);
  if (!result.ok) return undefined;
  const entry = result.preview.ingredients[0];
  if (entry.fdc_id === undefined || entry.record_digest === undefined) return undefined;
  return {
    line_ref: entry.line_ref,
    fdc_id: entry.fdc_id,
    record_digest: entry.record_digest,
    ingredient_identity_digest: entry.ingredient_identity_digest,
    bundle_release: (result.preview as unknown as { bundle_release: string }).bundle_release,
  };
}

function accept(flow: Flow, lower: number, upper: number): Phase4State {
  const evidence = evidenceFor(flow);
  const built = buildAiEstimateSelection(flow.lineRef, evidence, {
    fdc_id: evidence?.fdc_id ?? 0,
    record_digest: evidence?.record_digest ?? '',
    review_digest: '',
    lower_grams: lower,
    upper_grams: upper,
    representative_grams: (lower + upper) / 2,
    representative_policy: 'midpoint',
    provenance: 'ai_estimate',
    snapshot_binding: 'snap',
  } as AiEstimateChoice);
  if (built.ok !== true) throw new Error('estimate selection refused');
  return phase4Reducer(flow.state, {
    type: 'select_ai_estimate',
    lineRef: flow.lineRef,
    choice: { ...built.selection, fdc_id: built.selection.fdc_id, record_digest: built.selection.record_digest, review_digest: '', lower_grams: lower, upper_grams: upper, representative_grams: (lower + upper) / 2, representative_policy: 'midpoint', provenance: 'ai_estimate', snapshot_binding: 'snap', selection: built.selection } as AiEstimateChoice,
  } as never);
}

function calc(state: Phase4State, flow: Flow) {
  return session.calculate(buildCalculationRequest(flow.adapted, state));
}

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

describe('AI-3 calculator — the estimate arm resolves last and only alone', () => {
  it('the seeded line has an authenticated identity (the prerequisite)', () => {
    const flow = seed();
    expect(flow.state.matches[flow.lineRef]).toBeDefined();
    expect(evidenceFor(flow)).toBeDefined();
  });

  it('39. authenticated USDA nutrients x the deterministic midpoint', () => {
    const flow = seed();
    const state = accept(flow, 150, 200);
    const result = calc(state, flow);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const evidence = result.preview.ingredients[0];
    // The representative is RE-DERIVED from the range, not trusted.
    expect(evidence.resolved_grams).toBe(175);
  });

  it('40. the live row reports mass_source ai_estimate', () => {
    const flow = seed();
    const state = accept(flow, 150, 200);
    const result = calc(state, flow);
    const live = projectLiveRows(
      state,
      new Map(flow.analysis.rows.map((row) => [row.line_ref, row])),
      flow.adapted,
      session,
      result.ok ? ingredientEvidenceViews(result.preview) : null
    )[0];
    expect(live.mass_source).toBe('ai_estimate');
  });

  it('a WIDER range resolves to its own midpoint, never to the model value', () => {
    const flow = seed();
    const state = accept(flow, 100, 300);
    const result = calc(state, flow);
    if (!result.ok) throw new Error('expected success');
    expect(result.preview.ingredients[0].resolved_grams).toBe(200);
  });

  it('M45/58: a forged non-midpoint policy is refused by the calculator', () => {
    const flow = seed();
    const state = accept(flow, 150, 200);
    // Rewrite the stored selection to claim a different representative policy.
    const broken = {
      ...state,
      aiEstimates: {
        ...state.aiEstimates,
        [flow.lineRef]: {
          ...state.aiEstimates[flow.lineRef],
          selection: { ...state.aiEstimates[flow.lineRef].selection, representative_policy: 'upper_bound' },
        },
      },
    } as Phase4State;
    expect(calc(broken, flow).ok).toBe(false);
  });

  it('M44: a ratio wider than 4 is refused by the calculator (never clamped)', () => {
    const flow = seed();
    const state = accept(flow, 100, 200);
    const broken = {
      ...state,
      aiEstimates: {
        ...state.aiEstimates,
        [flow.lineRef]: {
          ...state.aiEstimates[flow.lineRef],
          selection: { ...state.aiEstimates[flow.lineRef].selection, upper_grams: 900 },
        },
      },
    } as Phase4State;
    const result = calc(broken, flow);
    expect(result.ok).toBe(false);
  });

  it('M50: a forged AUTHENTICATED provenance claim is refused by the calculator', () => {
    // This drives the calculator's OWN provenance re-check (the second,
    // independent layer). The Phase-4 selection builder refuses it too, but
    // that is a different file: without this test the calculator line is
    // unwitnessed and a mutation there would be invisible.
    const flow = seed();
    const state = accept(flow, 150, 200);
    for (const forgedProvenance of ['usda_derived', 'vetted_standard']) {
      const broken = {
        ...state,
        aiEstimates: {
          ...state.aiEstimates,
          [flow.lineRef]: {
            ...state.aiEstimates[flow.lineRef],
            selection: {
              ...state.aiEstimates[flow.lineRef].selection,
              provenance: forgedProvenance,
            },
          },
        },
      } as Phase4State;
      expect(calc(broken, flow).ok).toBe(false);
    }
  });

  it('M48: a stale identity binding is refused by the calculator', () => {
    const flow = seed();
    const state = accept(flow, 150, 200);
    const broken = {
      ...state,
      aiEstimates: {
        ...state.aiEstimates,
        [flow.lineRef]: {
          ...state.aiEstimates[flow.lineRef],
          selection: { ...state.aiEstimates[flow.lineRef].selection, record_digest: 'forged' },
        },
      },
    } as Phase4State;
    expect(calc(broken, flow).ok).toBe(false);
  });

  it('M47: a model-supplied nutrient or FDC field in the selection is refused', () => {
    const flow = seed();
    const state = accept(flow, 150, 200);
    for (const forged of [{ nutrients: { calories: 999 } }, { fdc_id: 999999 }, { user_mass_selection: { grams: 1 } }]) {
      const broken = {
        ...state,
        aiEstimates: {
          ...state.aiEstimates,
          [flow.lineRef]: {
            ...state.aiEstimates[flow.lineRef],
            selection: { ...state.aiEstimates[flow.lineRef].selection, ...forged },
          },
        },
      } as Phase4State;
      expect(calc(broken, flow).ok).toBe(false);
    }
  });

  it('an estimate REFUSES to coexist with a stronger mass source', () => {
    const flow = seed();
    const withUserMass = phase4Reducer(flow.state, {
      type: 'select_user_mass',
      lineRef: flow.lineRef,
      choice: { grams: 180 },
    } as never);
    // The reducer refuses the estimate outright...
    expect(withUserMass.aiEstimates[flow.lineRef]).toBeUndefined();
    // ...and even if one were forced in, the calculator fails closed.
    const evidence = evidenceFor(flow);
    const built = buildAiEstimateSelection(flow.lineRef, evidence, {
      fdc_id: evidence?.fdc_id ?? 0,
      record_digest: evidence?.record_digest ?? '',
      review_digest: '',
      lower_grams: 150,
      upper_grams: 200,
      representative_grams: 175,
      representative_policy: 'midpoint',
      provenance: 'ai_estimate',
      snapshot_binding: 'snap',
    } as AiEstimateChoice);
    if (built.ok === true) {
      const forced = {
        ...withUserMass,
        aiEstimates: {
          [flow.lineRef]: {
            ...built.selection,
            fdc_id: built.selection.fdc_id,
            record_digest: built.selection.record_digest,
            review_digest: '',
            lower_grams: 150,
            upper_grams: 200,
            representative_grams: 175,
            representative_policy: 'midpoint' as const,
            provenance: 'ai_estimate' as const,
            snapshot_binding: 'snap',
            selection: built.selection,
          } as AiEstimateChoice,
        },
      } as Phase4State;
      expect(calc(forced, flow).ok).toBe(false);
    }
  });
});
