import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTOMATED_APPLICATION_DISABLED_REASON,
  canApplyNutritionEstimate,
} from '../../src/core/nutritionSanity';
import {
  ADVANCED_NUTRITION_APPLICATION_DISABLED_REASON,
  advancedNutritionApplicationAuthorization,
  evaluateAdvancedNutritionEligibility,
} from '../../src/core/nutritionV2';

/**
 * Phase 0 — machine application of advanced nutrition remains DISABLED.
 *
 * The production Apply authorization is still the centralized
 * `canApplyNutritionEstimate` hard-disable; Phase 0 adds no write authority to
 * any component, route, recovery flow, or Vault Intelligence path.
 */

const ROOT = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('centralized machine-application hard-disable is intact', () => {
  it('28. canApplyNutritionEstimate fails closed for machine estimates', () => {
    expect(canApplyNutritionEstimate({ calories: 100, protein: 5 }, undefined, 4).ok).toBe(false);
    expect(
      canApplyNutritionEstimate(
        { calories: 100 },
        { complete: false, trustedBasis: false, reasons: [] },
        4
      ).ok
    ).toBe(false);
    expect(canApplyNutritionEstimate({ calories: 100 }, { complete: true, trustedBasis: true } as never, 4).ok).toBe(
      false
    );
  });

  it('the Phase 0 authorization mirrors the existing disabled reason and never authorizes', () => {
    expect(ADVANCED_NUTRITION_APPLICATION_DISABLED_REASON).toBe(AUTOMATED_APPLICATION_DISABLED_REASON);
    expect(advancedNutritionApplicationAuthorization()).toEqual({
      ok: false,
      reasons: [AUTOMATED_APPLICATION_DISABLED_REASON],
    });
  });

  it('the advisory eligibility evaluator reports but never authorizes', () => {
    const advisory = evaluateAdvancedNutritionEligibility({ schema: 1, basis: 'per_serving' });
    expect(advisory.eligible).toBe(false);
    expect(advisory.reasons.length).toBeGreaterThan(0);
  });
});

describe('29. no other production surface gains advanced-nutrition authority', () => {
  it('the estimator, metadata recovery, Create for Me, and Vault Intelligence do not import Phase 0 authority', () => {
    const surfaces = [
      'server/nutritionEstimator.ts',
      'server/metadataRecovery.ts',
      'src/application/createForMe.ts',
      'src/utils/createForMe.ts',
      'src/utils/vaultIntelligence.ts',
      'src/components/VaultIntelligenceModal.tsx',
      'src/components/RecipeEditorModal.tsx',
      'src/components/RecipeNutritionCard.tsx',
    ];
    for (const rel of surfaces) {
      const src = read(rel);
      expect(src, `${rel} must not import nutritionV2 authority`).not.toMatch(
        /from ['"][^'"]*core\/nutritionV2/
      );
      expect(src, `${rel} must not call encodeCodexNutrition`).not.toContain('encodeCodexNutrition');
      expect(src, `${rel} must not call advancedNutritionApplicationAuthorization`).not.toContain(
        'advancedNutritionApplicationAuthorization'
      );
    }
  });

  it('the advanced-nutrition module is a pure contract with no route/network surface', () => {
    const files = [
      'src/core/nutritionV2/units.ts',
      'src/core/nutritionV2/nutrients.ts',
      'src/core/nutritionV2/dailyValues.ts',
      'src/core/nutritionV2/schema.ts',
      'src/core/nutritionV2/validate.ts',
      'src/core/nutritionV2/index.ts',
    ];
    for (const rel of files) {
      const src = read(rel);
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/\/api\//);
      expect(src).not.toMatch(/network\s*\.\s*(post|get|request)/);
      expect(src).not.toMatch(/nutritionEstimator|nutritionCache/);
    }
  });
});

describe('30. no provider/nutrition network call is added to parse/serialize', () => {
  it('markdownParser remains free of network/provider calls', () => {
    const src = read('src/utils/markdownParser.ts');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\/api\//);
    expect(src).not.toMatch(/network\s*\.\s*(post|get|request)/);
  });

  it('the parser/serializer never invokes an estimator', () => {
    const src = read('src/utils/markdownParser.ts');
    expect(src).not.toMatch(/estimateNutrition|estimateRecipeNutrition|estimateDeterministicNutrition/);
  });
});
