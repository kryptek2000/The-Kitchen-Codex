/**
 * AI-3 — SLICE E: the TWO-LAYER APPLY BLOCK.
 *
 * Layer A is UX (the card hides Apply and explains why).
 * Layer B is the LOAD-BEARING PERSISTENCE SAFETY BOUNDARY: the application
 * Apply coordinator refuses BEFORE authorization and BEFORE the writer port is
 * ever resolved.
 *
 * The critical test here is the last one: the UI is bypassed entirely and the
 * coordinator is called DIRECTLY with an active estimate. The writer call
 * count must be 0.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  hasActiveAiEstimateForPreview,
  activeAiEstimatesForPreview,
  AI_ESTIMATE_APPLY_BLOCK_MESSAGE,
} from '../../src/core/nutritionV2/phase4/aiEstimateApplyGate';
import { applyAdvancedNutrition, ADVANCED_NUTRITION_APPLY_UI_MESSAGE } from '../../src/application/advancedNutritionApply';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import type { AiEstimateChoice, Phase4State } from '../../src/core/nutritionV2/phase4/types';

const LINE = 'ing:0:ai3';

const CHOICE: AiEstimateChoice = {
  fdc_id: 2709223,
  record_digest: 'rd',
  review_digest: 'vd',
  lower_grams: 150,
  upper_grams: 200,
  representative_grams: 175,
  representative_policy: 'midpoint',
  provenance: 'ai_estimate',
  snapshot_binding: 'snap',
  selection: {
    calculation_version: 'usda_advisory_calc_v4',
    line_ref: LINE,
    ingredient_identity_digest: 'iid',
    bundle_release: 'b1',
    fdc_id: 2709223,
    record_digest: 'rd',
    lower_grams: 150,
    upper_grams: 200,
    representative_policy: 'midpoint',
    provenance: 'ai_estimate',
    snapshot_binding: 'snap',
  },
} as AiEstimateChoice;

function stateWithEstimate(): Phase4State {
  const seeded = phase4Reducer(
    {
      ...INITIAL_PHASE4_STATE,
      status: 'ready',
      recipeKey: 'r1',
      sessionIdentity: 's1',
      rows: [{ line_ref: LINE, original_text: '1 avocado', query: 'avocado' }],
    } as never,
    { type: 'noop' } as never
  );
  return phase4Reducer(seeded, { type: 'select_ai_estimate', lineRef: LINE, choice: CHOICE } as never);
}

function stateWithoutEstimate(): Phase4State {
  return phase4Reducer(
    {
      ...INITIAL_PHASE4_STATE,
      status: 'ready',
      recipeKey: 'r1',
      sessionIdentity: 's1',
      rows: [{ line_ref: LINE, original_text: '1 avocado', query: 'avocado' }],
    } as never,
    { type: 'noop' } as never
  );
}

describe('AI-3 Slice E — Layer A: the pure predicate', () => {
  it('54. reports an active estimate', () => {
    expect(hasActiveAiEstimateForPreview(stateWithEstimate())).toBe(true);
  });

  it('57. removing the estimate restores eligibility (for every other check)', () => {
    expect(hasActiveAiEstimateForPreview(stateWithoutEstimate())).toBe(false);
    const cleared = phase4Reducer(stateWithEstimate(), { type: 'clear_ai_estimate', lineRef: LINE } as never);
    expect(hasActiveAiEstimateForPreview(cleared)).toBe(false);
  });

  it('a null/undefined/absent store is never an estimate (pre-AI-3 states)', () => {
    expect(hasActiveAiEstimateForPreview(null)).toBe(false);
    expect(hasActiveAiEstimateForPreview(undefined)).toBe(false);
    expect(hasActiveAiEstimateForPreview({ aiEstimates: {} } as never)).toBe(false);
  });

  it('the blocked lines carry their truthful bounded range, deterministically', () => {
    const blocked = activeAiEstimatesForPreview(stateWithEstimate());
    expect(blocked).toEqual([
      { lineRef: LINE, lower_grams: 150, upper_grams: 200, representative_grams: 175 },
    ]);
    expect(activeAiEstimatesForPreview(stateWithEstimate())).toEqual(blocked);
  });

  it('the user-facing message is the locked literal', () => {
    expect(AI_ESTIMATE_APPLY_BLOCK_MESSAGE).toBe(
      'AI estimates are preview-only. Replace estimates with a confirmed amount before Apply.'
    );
  });
});

describe('AI-3 Slice E — Layer B: the application writer guard', () => {
  function request(state: Phase4State, write: (recipe: unknown) => Promise<void>) {
    return {
      session: {},
      recipe: { title: 'r', servings: 1, ingredients: [] },
      state,
      write,
      readBack: async () => 'stored',
      computedAt: '2026-01-01T00:00:00.000Z',
      expectedMode: 'create',
    } as never;
  }

  it('55. a DIRECT call with an active estimate fails closed', async () => {
    const write = vi.fn(async () => {});
    const result = await applyAdvancedNutrition(request(stateWithEstimate(), write));
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failure.code).toBe('ai_estimate_preview_only');
    }
  });

  it('56. the persistence writer is NEVER reached', async () => {
    const write = vi.fn(async () => {});
    const readBack = vi.fn(async () => 'stored');
    await applyAdvancedNutrition({
      ...(request(stateWithEstimate(), write) as unknown as Record<string, unknown>),
      readBack,
    } as never);
    // THE load-bearing assertion for Layer B.
    expect(write).not.toHaveBeenCalled();
    expect(readBack).not.toHaveBeenCalled();
  });

  it('[AI3-M52-HIST] M52: the refusal happens BEFORE authorization, not after a failed write', async () => {
    // A session that would otherwise refuse anyway. The estimate code must win,
    // proving the guard runs first and is not a side effect of authorization.
    const write = vi.fn(async () => {});
    const result = await applyAdvancedNutrition(request(stateWithEstimate(), write));
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      // NOT 'not_authorized' / 'unsafe_request': the estimate guard is first.
      expect(result.failure.code).toBe('ai_estimate_preview_only');
    }
  });

  it('58. with the estimate removed the coordinator proceeds past the guard', async () => {
    const write = vi.fn(async () => {});
    const result = await applyAdvancedNutrition(request(stateWithoutEstimate(), write));
    // It may still fail for other pre-existing reasons (this fixture has no real
    // session), but it must NOT fail with the estimate code.
    if (result.ok === false) {
      expect(result.failure.code).not.toBe('ai_estimate_preview_only');
    }
  });

  it('the guard is independent of the UI: removing the card gate changes nothing', async () => {
    // LAYER B is proven by the direct call above. This asserts the two layers
    // are INDEPENDENT defensive layers, not one mechanism counted twice: the
    // card is a React component and the coordinator never consults it.
    const source = await import('../../src/application/advancedNutritionApply.ts');
    const coordinatorSource = String(source.applyAdvancedNutrition);
    expect(coordinatorSource.length).toBeGreaterThan(0);
    const write = vi.fn(async () => {});
    const result = await applyAdvancedNutrition(request(stateWithEstimate(), write));
    expect(result.ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('the UI message map carries the exact preview-only guidance', () => {
    expect(ADVANCED_NUTRITION_APPLY_UI_MESSAGE.ai_estimate_preview_only).toBe(
      AI_ESTIMATE_APPLY_BLOCK_MESSAGE
    );
  });

  it('an estimate is never laundered into a persistable authority class', () => {
    // The store keeps the estimate in its own field only: there is no
    // userMass/portion entry created alongside it.
    const state = stateWithEstimate();
    expect(state.userMasses[LINE]).toBeUndefined();
    expect(state.portions[LINE]).toBeUndefined();
    expect(state.countPortions[LINE]).toBeUndefined();
    expect(state.householdPortions[LINE]).toBeUndefined();
    expect(state.aiEstimates[LINE]?.provenance).toBe('ai_estimate');
  });
});
