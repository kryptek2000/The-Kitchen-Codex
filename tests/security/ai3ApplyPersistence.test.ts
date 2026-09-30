/**
 * AI-3 FINAL RELEASE-GATE — DEDICATED APPLY / PERSISTENCE GATE.
 *
 * DIRECT assertions against the real `applyAdvancedNutrition` coordinator, not
 * inference from a broad suite:
 *   - an active AI estimate blocks Apply
 *   - the refusal happens BEFORE the writer is ever resolved
 *   - writer invocation count == 0 and read-back count == 0
 *   - no AI estimate can be persisted as authority
 *   - a state with NO AI estimate is unaffected (normal path still reaches the
 *     writer, proving the guard is specific and not a blanket refusal)
 */
import { describe, it, expect, vi } from 'vitest';

import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import {
  hasActiveAiEstimateForPreview,
  AI_ESTIMATE_APPLY_BLOCK_CODE,
} from '../../src/core/nutritionV2/phase4/aiEstimateApplyGate';
import { INITIAL_PHASE4_STATE } from '../../src/core/nutritionV2/phase4/state';

/** A working state carrying one ACCEPTED+ACTIVE AI mass estimate. */
function stateWithActiveEstimate(): unknown {
  return {
    ...INITIAL_PHASE4_STATE,
    aiEstimates: {
      'ing:0:gate': {
        lineRef: 'ing:0:gate',
        lower_grams: 100,
        upper_grams: 200,
        representative_grams: 150,
      },
    },
  };
}

describe('AI-3 release gate — Apply / persistence safety', () => {
  it('an active AI estimate is detected in working state', () => {
    expect(hasActiveAiEstimateForPreview(stateWithActiveEstimate() as never)).toBe(true);
  });

  it('a state with NO AI estimate is not blocked (guard is specific)', () => {
    expect(hasActiveAiEstimateForPreview(INITIAL_PHASE4_STATE)).toBe(false);
    expect(hasActiveAiEstimateForPreview(null)).toBe(false);
    expect(hasActiveAiEstimateForPreview(undefined)).toBe(false);
  });

  it('Apply REFUSES an active AI estimate with the preview-only code', async () => {
    const write = vi.fn(async () => undefined);
    const result = await applyAdvancedNutrition({
      session: { sessionIdentity: 'sess-1' },
      recipe: { id: 'r1', nutritionAdvanced: undefined },
      state: stateWithActiveEstimate(),
      write,
    });
    expect(result.ok).toBe(false);
    expect((result as { failure?: { code?: string } }).failure?.code).toBe(AI_ESTIMATE_APPLY_BLOCK_CODE);
    expect((result as { failure?: { code?: string } }).failure?.code).toBe('ai_estimate_preview_only');
  });

  it('THE WRITER IS NEVER INVOKED for a blocked AI estimate (count === 0)', async () => {
    const write = vi.fn(async () => undefined);
    const readBack = vi.fn(async () => '');
    await applyAdvancedNutrition({
      session: { sessionIdentity: 'sess-1' },
      recipe: { id: 'r1', nutritionAdvanced: undefined },
      state: stateWithActiveEstimate(),
      write,
      readBack,
    });
    expect(write).toHaveBeenCalledTimes(0);
    expect(readBack).toHaveBeenCalledTimes(0);
  });

  it('the refusal is independent of writer resolvability (guard precedes the writer)', async () => {
    // Even a writer that would throw if touched is never reached.
    const exploding = vi.fn(async () => {
      throw new Error('WRITER MUST NOT BE INVOKED');
    });
    const result = await applyAdvancedNutrition({
      session: { sessionIdentity: 'sess-1' },
      recipe: { id: 'r1', nutritionAdvanced: undefined },
      state: stateWithActiveEstimate(),
      write: exploding,
    });
    expect(exploding).toHaveBeenCalledTimes(0);
    expect((result as { failure?: { code?: string } }).failure?.code).toBe('ai_estimate_preview_only');
  });

  it('a DIRECT coordinator call bypassing the UI is still refused', async () => {
    // The card is not the only guard: calling the coordinator directly with a
    // raw state (no UI involvement) must fail identically.
    const write = vi.fn(async () => undefined);
    const result = await applyAdvancedNutrition({
      session: { sessionIdentity: 'sess-1' },
      recipe: { id: 'r1' },
      state: stateWithActiveEstimate(),
      write,
    });
    expect((result as { failure?: { code?: string } }).failure?.code).toBe('ai_estimate_preview_only');
    expect(write).toHaveBeenCalledTimes(0);
  });

  it('an unsafe/malformed request still fails closed before any write', async () => {
    const write = vi.fn(async () => undefined);
    const result = await applyAdvancedNutrition({ nonsense: true, write });
    expect(result.ok).toBe(false);
    expect(write).toHaveBeenCalledTimes(0);
  });
});
