/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: explicit UI state machine.
 */

import { describe, it, expect } from 'vitest';
import {
  INITIAL_PHASE4_STATE,
  isPreviewCurrent,
  phase4Reducer,
} from '../../src/core/nutritionV2/phase4/state';
import type { AdvisoryNutritionPreview } from '../../src/core/nutritionV2/calculation/types';
import type { NutrientId } from '../../src/core/nutritionV2/nutrients';
import {
  PHASE4_SESSION_VERSION,
  phase4SessionIdentity,
} from '../../src/core/nutritionV2/phase4/types';
import type {
  Phase4Row,
  Phase4SessionMetadata,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';

function row(lineRef: string, outcome: Phase4Row['outcome'] = 'review_required'): Phase4Row {
  return Object.freeze({
    line_ref: lineRef,
    original_text: lineRef,
    outcome,
    query: lineRef,
    candidates: Object.freeze([]),
    review_digest: 'd'.repeat(64),
    selected_fdc_id: undefined,
    review: Object.freeze({}),
    note: undefined,
  });
}

function preview(): AdvisoryNutritionPreview {
  return Object.freeze({
    calculation_schema: 1,
    calculation_version: 'usda_advisory_calc_v1',
    bundle_release: 'bundle',
    catalog_digest: 'c'.repeat(64),
    nutrient_map_version: 'usda_fdc_nutrient_map_v2',
    servings: 4,
    ingredient_digest: 'sha256:' + 'a'.repeat(64),
    nutrient_scope: Object.freeze<NutrientId[]>(['calories']),
    basis: 'total',
    status: 'complete',
    totals: Object.freeze({
      calories: Object.freeze({
        amount: 400,
        unit: 'kcal',
        coverage: 1,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 1,
        status: 'complete',
      }),
    }),
    ingredients: Object.freeze([]),
    unresolved: Object.freeze([]),
    advisory_only: true,
    application_authorized: false,
  });
}

const SESSION_ID = 'session-authority-A';

function readyState(): Phase4State {
  return phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: 'recipe-A#1',
    sessionIdentity: SESSION_ID,
    rows: [row('a'), row('b', 'matched_exact')],
    baseServings: 4,
  });
}

function withPreview(state: Phase4State): Phase4State {
  return phase4Reducer(state, {
    type: 'preview_succeeded',
    seq: state.operationSeq,
    recipeKey: state.recipeKey as string,
    preview: preview(),
  });
}

describe('phase 4 state — workflow integrity', () => {
  it('starts unavailable and becomes ready only after initialization', () => {
    expect(INITIAL_PHASE4_STATE.status).toBe('unavailable');
    const state = readyState();
    expect(state.status).toBe('ready');
    expect(state.recipeKey).toBe('recipe-A#1');
    expect(state.selectedServings).toBe(4);
  });

  it('re-opening/initializing the SAME recipe does not reset user choices', () => {
    let state = readyState();
    state = phase4Reducer(state, {
      type: 'select_match',
      lineRef: 'a',
      choice: { kind: 'candidate', fdc_id: 3002, review_digest: 'd'.repeat(64) },
    });
    const again = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-A#1',
      sessionIdentity: SESSION_ID,
      rows: state.rows,
      baseServings: 4,
    });
    expect(again).toBe(state);
  });

  it('a recipe change clears stale match/portion/preview state', () => {
    let state = withPreview(readyState());
    state = phase4Reducer(state, {
      type: 'select_match',
      lineRef: 'a',
      choice: { kind: 'candidate', fdc_id: 3002, review_digest: 'd'.repeat(64) },
    });
    const changed = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-B#2',
      sessionIdentity: SESSION_ID,
      rows: [row('x')],
      baseServings: 2,
    });
    expect(changed.recipeKey).toBe('recipe-B#2');
    expect(changed.preview).toBeNull();
    expect(changed.matches).toEqual({});
    expect(changed.portions).toEqual({});
    expect(changed.status).toBe('ready');
  });

  it('an ingredient change (new recipe key) invalidates a stale preview', () => {
    const state = withPreview(readyState());
    expect(isPreviewCurrent(state)).toBe(true);
    const changed = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-A#2',
      sessionIdentity: SESSION_ID,
      rows: [row('a'), row('b', 'matched_exact'), row('c')],
      baseServings: 4,
    });
    expect(changed.preview).toBeNull();
    expect(isPreviewCurrent(changed)).toBe(false);
  });

  it('changing a match invalidates its portion and the preview', () => {
    let state = withPreview(readyState());
    state = phase4Reducer(state, {
      type: 'select_portion',
      lineRef: 'a',
      choice: { fdc_id: 3001, portion_index: 0, selection: {}, review: {} },
    });
    expect(state.portions.a).toBeDefined();
    const changed = phase4Reducer(state, {
      type: 'select_match',
      lineRef: 'a',
      choice: { kind: 'candidate', fdc_id: 3002, review_digest: 'd'.repeat(64) },
    });
    expect(changed.portions.a).toBeUndefined();
    expect(changed.status).toBe('preview_stale');
    expect(changed.preview).not.toBeNull();
    expect(isPreviewCurrent(changed)).toBe(false);
  });

  it('changing a portion invalidates the preview', () => {
    const state = withPreview(readyState());
    const changed = phase4Reducer(state, {
      type: 'select_portion',
      lineRef: 'a',
      choice: { fdc_id: 3001, portion_index: 0, selection: {}, review: {} },
    });
    expect(changed.status).toBe('preview_stale');
  });

  it('basis and serving changes are display-only: no recalculation, no baseline mutation', () => {
    const state = withPreview(readyState());
    const basisChanged = phase4Reducer(state, { type: 'set_basis', basis: 'per_serving' });
    expect(basisChanged.basis).toBe('per_serving');
    expect(basisChanged.operationSeq).toBe(state.operationSeq);
    expect(basisChanged.preview).toBe(state.preview);
    expect(basisChanged.status).toBe('preview_current');

    const servingsChanged = phase4Reducer(basisChanged, { type: 'set_servings', value: 6 });
    expect(servingsChanged.selectedServings).toBe(6);
    expect(servingsChanged.operationSeq).toBe(state.operationSeq);
    expect(servingsChanged.preview).toBe(state.preview);
  });

  it('rejects invalid servings while keeping the last valid view', () => {
    const state = withPreview(readyState());
    for (const invalid of ['4', NaN, Infinity, -0, 0, -3, 1001, 1.1234567]) {
      const next = phase4Reducer(state, { type: 'set_servings', value: invalid });
      expect(next.selectedServings, String(invalid)).toBe(4);
      expect(next.failure?.code).toBe('invalid_servings');
    }
  });

  it('a stale operation result can never overwrite newer state', () => {
    let state = readyState();
    const staleSeq = state.operationSeq;
    state = phase4Reducer(state, {
      type: 'select_match',
      lineRef: 'a',
      choice: { kind: 'candidate', fdc_id: 3002, review_digest: 'd'.repeat(64) },
    });
    const newer = state.operationSeq;
    expect(newer).not.toBe(staleSeq);
    const staleResult = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq: staleSeq,
      recipeKey: state.recipeKey as string,
      preview: preview(),
    });
    expect(staleResult).toBe(state);
    expect(staleResult.preview).toBeNull();

    const wrongRecipe = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq: newer,
      recipeKey: 'other',
      preview: preview(),
    });
    expect(wrongRecipe).toBe(state);
  });

  it('StrictMode double initialization does not duplicate or reset state', () => {
    let state = readyState();
    state = phase4Reducer(state, {
      type: 'select_match',
      lineRef: 'a',
      choice: { kind: 'candidate', fdc_id: 3002, review_digest: 'd'.repeat(64) },
    });
    const first = phase4Reducer(state, { type: 'initialize', recipeKey: 'recipe-A#1', sessionIdentity: SESSION_ID, rows: state.rows, baseServings: 4 });
    const second = phase4Reducer(first, { type: 'initialize', recipeKey: 'recipe-A#1', sessionIdentity: SESSION_ID, rows: state.rows, baseServings: 4 });
    expect(first).toBe(state);
    expect(second).toBe(state);
  });

  it('reset clears everything and never persists or applies', () => {
    const state = withPreview(readyState());
    const reset = phase4Reducer(state, { type: 'reset' });
    expect(reset.status).toBe('unavailable');
    expect(reset.preview).toBeNull();
    expect(reset.matches).toEqual({});
    expect(reset.rows).toEqual([]);
  });
});

describe('phase 4 state — explicit total-weight fallback (user_mass)', () => {
  const portionChoice = { fdc_id: 3001, portion_index: 0, selection: {}, review: {} };
  const userMassChoice = { fdc_id: 3001, quantity: 4.3, unit: 'oz' as const, selection: {} };

  it('a user-mass selection clears any portion, invalidates the preview, and is mutually exclusive', () => {
    let state = withPreview(readyState());
    state = phase4Reducer(state, { type: 'select_portion', lineRef: 'a', choice: portionChoice });
    expect(state.portions.a).toBeDefined();

    const withUserMass = phase4Reducer(state, { type: 'select_user_mass', lineRef: 'a', choice: userMassChoice });
    expect(withUserMass.userMasses.a).toBeDefined();
    expect(withUserMass.userMasses.a?.quantity).toBe(4.3);
    expect(withUserMass.portions.a).toBeUndefined();
    expect(withUserMass.status).toBe('preview_stale');
  });

  it('a source-portion selection clears any user weight', () => {
    let state = readyState();
    state = phase4Reducer(state, { type: 'select_user_mass', lineRef: 'a', choice: userMassChoice });
    expect(state.userMasses.a).toBeDefined();
    const withPortion = phase4Reducer(state, { type: 'select_portion', lineRef: 'a', choice: portionChoice });
    expect(withPortion.portions.a).toBeDefined();
    expect(withPortion.userMasses.a).toBeUndefined();
  });

  it('replacing a user weight and clearing it behave deterministically', () => {
    let state = withPreview(readyState());
    state = phase4Reducer(state, { type: 'select_user_mass', lineRef: 'a', choice: userMassChoice });
    state = phase4Reducer(state, {
      type: 'select_user_mass',
      lineRef: 'a',
      choice: { ...userMassChoice, quantity: 100, unit: 'g' },
    });
    expect(state.userMasses.a?.quantity).toBe(100);
    const cleared = phase4Reducer(state, { type: 'clear_user_mass', lineRef: 'a' });
    expect(cleared.userMasses.a).toBeUndefined();
    expect(cleared.status).toBe('preview_stale');
  });

  it('changing the food clears the user weight and the preview', () => {
    let state = withPreview(readyState());
    state = phase4Reducer(state, { type: 'select_user_mass', lineRef: 'a', choice: userMassChoice });
    const changed = phase4Reducer(state, {
      type: 'select_match',
      lineRef: 'a',
      choice: { kind: 'candidate', fdc_id: 3002, review_digest: 'd'.repeat(64) },
    });
    expect(changed.userMasses.a).toBeUndefined();
    expect(changed.status).toBe('preview_stale');
  });

  it('a recipe change and reset clear all user weights', () => {
    let state = readyState();
    state = phase4Reducer(state, { type: 'select_user_mass', lineRef: 'a', choice: userMassChoice });
    const changed = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-B#2',
      sessionIdentity: SESSION_ID,
      rows: [row('x')],
      baseServings: 2,
    });
    expect(changed.userMasses).toEqual({});
    const reset = phase4Reducer(state, { type: 'reset' });
    expect(reset.userMasses).toEqual({});
  });
});

describe('phase 4.5E — same-recipe session identity invalidation', () => {
  const baseMetadata: Phase4SessionMetadata = {
    session_version: PHASE4_SESSION_VERSION,
    context_version: 'usda_calc_context_v3',
    calculation_version: 'usda_advisory_calc_v4',
    bundle_release: 'usda_fdc_bundle_a',
    catalog_digest: 'a'.repeat(64),
    nutrient_map_version: 'usda_fdc_nutrient_map_v2',
    record_count: 10,
    source_record_count: 12,
    excluded_record_count: 2,
    data_types: ['foundation', 'sr_legacy', 'fndds'],
  };
  const identityA = phase4SessionIdentity(baseMetadata);

  function initialized(sessionIdentity: string, recipeKey = 'recipe-A#1'): Phase4State {
    return phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey,
      sessionIdentity,
      rows: [row('a')],
      baseServings: 4,
    });
  }

  const countChoice = { fdc_id: 5001, portion_index: 0, selection: {}, review: {} };
  const portionChoice = { fdc_id: 5002, portion_index: 0, selection: {}, review: {} };
  const userMassChoice = { fdc_id: 5001, quantity: 100, unit: 'g' as const, selection: {} };

  function withSelections(): Phase4State {
    let state = withPreview(initialized(identityA));
    state = phase4Reducer(state, { type: 'select_count_portion', lineRef: 'a', choice: countChoice });
    return state;
  }

  it('derives a stable value-based identity from the authoritative metadata', () => {
    expect(phase4SessionIdentity(baseMetadata)).toBe(identityA);
    expect(phase4SessionIdentity({ ...baseMetadata })).toBe(identityA);
    expect(phase4SessionIdentity({ ...baseMetadata, bundle_release: 'usda_fdc_bundle_b' })).not.toBe(identityA);
    expect(phase4SessionIdentity({ ...baseMetadata, catalog_digest: 'b'.repeat(64) })).not.toBe(identityA);
    expect(phase4SessionIdentity({ ...baseMetadata, session_version: 'usda_phase4_session_v4' })).not.toBe(identityA);
  });

  it('same recipe key + same session identity preserves expected state', () => {
    const state = withSelections();
    const again = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-A#1',
      sessionIdentity: identityA,
      rows: state.rows,
      baseServings: 4,
    });
    expect(again).toBe(state);
    expect(again.countPortions.a).toEqual(countChoice);
    expect(again.status).toBe('preview_stale');
  });

  it('same recipe key + changed bundle release invalidates selections and current preview', () => {
    const state = withSelections();
    const changedIdentity = phase4SessionIdentity({ ...baseMetadata, bundle_release: 'usda_fdc_bundle_b' });
    const changed = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-A#1',
      sessionIdentity: changedIdentity,
      rows: [row('a')],
      baseServings: 4,
    });
    expect(changed.recipeKey).toBe('recipe-A#1');
    expect(changed.sessionIdentity).toBe(changedIdentity);
    expect(changed.countPortions).toEqual({});
    expect(changed.portions).toEqual({});
    expect(changed.userMasses).toEqual({});
    expect(changed.preview).toBeNull();
    expect(changed.status).toBe('ready');
  });

  it('same recipe key + changed catalog identity invalidates selections and current preview', () => {
    const state = withSelections();
    const changedIdentity = phase4SessionIdentity({ ...baseMetadata, catalog_digest: 'b'.repeat(64) });
    const changed = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-A#1',
      sessionIdentity: changedIdentity,
      rows: [row('a')],
      baseServings: 4,
    });
    expect(changed.countPortions).toEqual({});
    expect(changed.portions).toEqual({});
    expect(changed.userMasses).toEqual({});
    expect(changed.preview).toBeNull();
    expect(changed.status).toBe('ready');
  });

  it('same recipe key + changed session version invalidates selections and current preview', () => {
    const state = withSelections();
    const changedIdentity = phase4SessionIdentity({
      ...baseMetadata,
      session_version: 'usda_phase4_session_v4',
    });
    const changed = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-A#1',
      sessionIdentity: changedIdentity,
      rows: [row('a')],
      baseServings: 4,
    });
    expect(changed.countPortions).toEqual({});
    expect(changed.preview).toBeNull();
    expect(changed.status).toBe('ready');
  });

  it('old count-portion authority cannot resurrect after switching away and back', () => {
    const state = withSelections();
    const otherIdentity = phase4SessionIdentity({ ...baseMetadata, catalog_digest: 'b'.repeat(64) });
    const away = phase4Reducer(state, {
      type: 'initialize',
      recipeKey: 'recipe-A#1',
      sessionIdentity: otherIdentity,
      rows: [row('a')],
      baseServings: 4,
    });
    expect(away.countPortions).toEqual({});
    const back = phase4Reducer(away, {
      type: 'initialize',
      recipeKey: 'recipe-A#1',
      sessionIdentity: identityA,
      rows: [row('a')],
      baseServings: 4,
    });
    expect(back.countPortions).toEqual({});
    expect(back.preview).toBeNull();
    expect(back.status).toBe('ready');
  });

  it('does not mutate the recipe/adaptation input and introduces no persistence', () => {
    const adapted = Object.freeze([
      Object.freeze({
        line_ref: 'a',
        ingredient: Object.freeze({ original: '8 slices bacon', line_ref: 'a' }),
      }),
    ]);
    const snapshot = JSON.stringify(adapted);
    let state = initialized(identityA);
    state = phase4Reducer(state, { type: 'select_portion', lineRef: 'a', choice: portionChoice });
    state = phase4Reducer(state, { type: 'select_user_mass', lineRef: 'a', choice: userMassChoice });
    state = phase4Reducer(state, { type: 'select_count_portion', lineRef: 'a', choice: countChoice });
    expect(JSON.stringify(adapted)).toBe(snapshot);
    expect(Object.isFrozen(adapted[0])).toBe(true);
    expect(INITIAL_PHASE4_STATE.status).toBe('unavailable');
    expect(INITIAL_PHASE4_STATE.countPortions).toEqual({});
    expect(INITIAL_PHASE4_STATE.sessionIdentity).toBeNull();
  });
});
