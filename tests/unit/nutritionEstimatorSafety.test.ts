import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  estimateAlgorithmicNutrition,
  estimateRecipeNutrition,
} from '../../server/nutritionEstimator';
import * as estimatorModule from '../../server/nutritionEstimator';
import {
  estimateDeterministicNutrition,
  normalizeRawIngredientLine,
} from '../../server/deterministicNutrition';
import { getGemini } from '../../server/geminiClient';
import { clearDeterministicNutritionCache } from '../../server/nutritionCache';
import {
  validateNutritionNumbers,
  evaluateMachineNutritionApplicability,
  canApplyNutritionEstimate,
  AUTOMATED_APPLICATION_DISABLED_REASON,
  type NutritionAssessment,
} from '../../src/core/nutritionSanity';
import {
  buildNutritionApplyPayload,
  nutritionEstimateHeading,
  nutritionForRequestedServings,
  NUTRITION_INCOMPLETE_MESSAGE,
  NUTRITION_AUTOSAVE_DISABLED_MESSAGE,
} from '../../src/utils/nutrition';
import { mergeRecoveredMetadata } from '../../src/utils/vaultIntelligence';
import {
  deriveNutritionProvenance,
  planRecoveredMetadataApplication,
} from '../../src/components/RecipeEditorModal';
import { recoverMetadataAlgorithmically } from '../../server/metadataRecovery';
import { serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import type { ObsidianRecipe, RecoveredRecipeMetadata } from '../../src/types';

vi.mock('../../server/geminiClient.js', () => ({ getGemini: vi.fn() }));
const mockGetGemini = getGemini as unknown as ReturnType<typeof vi.fn>;

/**
 * Fail-closed nutrition safety regression suite.
 *
 * The previous repair replaced a units bug with a fabricated keyword/category
 * nutrient database. This suite proves the corrective fail-closed behavior:
 * the algorithmic profile layer is gone, only the curated source-backed food
 * reference resolves an ingredient, and every machine-generated estimate is
 * non-applicable in this repair.
 */

const BLUE_CHEESE = [
  '454 g ground beef (80/20), kept cold and divided into four loose 4-ounce balls',
  '1.25 tsp fine sea salt',
  '0.5 tsp coarse black pepper, freshly ground',
  '2 tsp neutral oil',
  '57 g unsalted butter, softened',
  '4 brioche or potato burger buns, halved',
  '113 g blue cheese, crumbled',
];

const AI_LIKE_RESULT = {
  calories: 100,
  protein: 1,
  carbohydrates: 1,
  fat: 1,
  fiber: 0,
  sodium: 1,
};

function baseRecipe(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '---\ntitle: X\n---\n# X',
    title: 'X',
    tags: [],
    category: 'Main Course',
    cuisine: '',
    prepTime: '',
    cookTime: '',
    servings: 4,
    difficulty: 'Medium',
    rating: 5,
    ingredients: [{ original: '1 cup mystery', name: 'mystery' }],
    instructions: [{ stepNumber: 1, text: 'Mix.' }],
    callouts: [],
    wikilinks: [],
    dataviewFields: {},
    frontmatter: {},
    ...overrides,
  } as ObsidianRecipe;
}

beforeEach(() => {
  mockGetGemini.mockReturnValue(null);
  clearDeterministicNutritionCache();
});

afterEach(() => {
  mockGetGemini.mockReturnValue(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fail closed — Blue Cheese Smashburgers fixture', () => {
  it('1. the fixture is incomplete and not applicable', () => {
    const r = estimateAlgorithmicNutrition('Blue Cheese Smashburgers', 4, BLUE_CHEESE);
    expect(r.assessment).toBeDefined();
    expect(r.assessment!.complete).toBe(false);
    // Zero ingredients matched => trustedBasis must be false.
    expect(r.assessment!.trustedBasis).toBe(false);
    expect(r.assessment!.provenance).toBeDefined();
    // No curated food record matches any fixture line.
    expect(r.assessment!.provenance!.resolvedIngredients).toBe(0);
    expect(r.assessment!.provenance!.unresolvedIngredients.length).toBe(7);
    expect(canApplyNutritionEstimate(r, r.assessment, 4).ok).toBe(false);
    expect(evaluateMachineNutritionApplicability(r, r.assessment, 4).ok).toBe(false);
  });

  it('2. no Save/Apply payload is produced for the fixture', () => {
    const r = estimateAlgorithmicNutrition('Blue Cheese Smashburgers', 4, BLUE_CHEESE);
    expect(buildNutritionApplyPayload(r, r.assessment, 4)).toBeNull();
  });

  it('3. no guessed replacement total is presented as trustworthy', () => {
    const r = estimateAlgorithmicNutrition('Blue Cheese Smashburgers', 4, BLUE_CHEESE);
    // Nothing resolves from the curated reference, so nothing is fabricated.
    expect(r.calories).toBe(0);
    expect(r.fat).toBe(0);
    expect(r.carbohydrates).toBe(0);
    expect(r.sodium).toBe(0);
    // The old fabricated 4,329 kcal / 369 g fat result can never return.
    expect(r.fat).toBeLessThan(1);
    expect(r.assessment!.complete).toBe(false);
  });

  it('4/5. 80/20 and 93/7 ground beef are not mapped to any generic meat profile', () => {
    for (const line of ['454 g ground beef (80/20)', '454 g ground beef (93/7)']) {
      const det = estimateDeterministicNutrition([line]);
      const c = det.contributions[0];
      expect(c.matchedFoodId, line).toBeUndefined();
      expect(c.resolved, line).toBe(false);
      expect(det.totals.fat, line).toBe(0);
    }
  });

  it('6. unsalted butter cannot receive a salted-butter profile', () => {
    const det = estimateDeterministicNutrition(['57 g unsalted butter']);
    const c = det.contributions[0];
    expect(c.matchedFoodId).toBeUndefined();
    expect(c.resolved).toBe(false);
    expect(det.totals.sodium).toBe(0);
  });

  it('7. 1 cup bread flour is not resolved as bread or a bun', () => {
    const det = estimateDeterministicNutrition(['1 cup bread flour']);
    expect(det.contributions[0].resolved).toBe(false);
    expect(det.totals.carbohydrates).toBe(0);
  });

  it('8. 1 large egg white is not resolved as a whole egg', () => {
    const det = estimateDeterministicNutrition(['1 large egg white']);
    expect(det.contributions[0].matchedFoodId).toBeUndefined();
    expect(det.contributions[0].resolved).toBe(false);
  });

  it('9. 100 g cream cheese is not resolved as heavy cream', () => {
    const det = estimateDeterministicNutrition(['100 g cream cheese']);
    expect(det.contributions[0].matchedFoodId).toBeUndefined();
    expect(det.contributions[0].resolved).toBe(false);
  });

  it('10. 100 g sugar-free chocolate is not resolved as sugar/syrup', () => {
    const det = estimateDeterministicNutrition(['100 g sugar-free chocolate']);
    expect(det.contributions[0].resolved).toBe(false);
    expect(det.totals.carbohydrates).toBe(0);
  });

  it('11. ambiguous bun alternatives remain unresolved', () => {
    const det = estimateDeterministicNutrition(['4 brioche or potato burger buns, halved']);
    expect(det.contributions[0].resolved).toBe(false);
    expect(det.contributions[0].matchedFoodId).toBeUndefined();
  });
});

describe('fail closed — applicability contract', () => {
  it('12. an AI result without assessment/provenance cannot be applied', () => {
    expect(evaluateMachineNutritionApplicability(AI_LIKE_RESULT, undefined, 4).ok).toBe(false);
    expect(evaluateMachineNutritionApplicability(AI_LIKE_RESULT, undefined, 4).reasons).toContain(
      'missing_assessment'
    );
    expect(canApplyNutritionEstimate(AI_LIKE_RESULT, undefined, 4).ok).toBe(false);
  });

  it('13. forging complete:true (or trustedBasis/provenance) without evidence cannot authorize', () => {
    // complete:true alone
    const forgedComplete: NutritionAssessment = { complete: true, trustedBasis: false, reasons: [] };
    expect(evaluateMachineNutritionApplicability(AI_LIKE_RESULT, forgedComplete, 4).reasons).toContain(
      'untrusted_basis'
    );

    // complete + trustedBasis but no provenance
    const forgedTrusted: NutritionAssessment = { complete: true, trustedBasis: true, reasons: [] };
    expect(evaluateMachineNutritionApplicability(AI_LIKE_RESULT, forgedTrusted, 4).reasons).toContain(
      'missing_provenance'
    );

    // complete + trustedBasis + a fabricated food id
    const forgedProvenance: NutritionAssessment = {
      complete: true,
      trustedBasis: true,
      reasons: [],
      provenance: {
        calculationId: 'x',
        calculationVersion: '1',
        resolved: [{ ingredient: 'x', foodId: 'not_a_real_food_record', basis: 'direct_mass', source: 'curated_local' }],
        unresolvedIngredients: [],
        totalIngredients: 1,
        resolvedIngredients: 1,
        resolvedMassGrams: 100,
        limitations: [],
      },
    };
    expect(
      evaluateMachineNutritionApplicability(AI_LIKE_RESULT, forgedProvenance, 4).reasons
    ).toContain('unknown_food_record');

    // The deployed gate always fails closed in this repair.
    expect(canApplyNutritionEstimate(AI_LIKE_RESULT, forgedProvenance, 4).ok).toBe(false);
  });

  it('validates numbers, servings and macro-mass coherence', () => {
    expect(validateNutritionNumbers({ calories: NaN }).ok).toBe(false);
    expect(validateNutritionNumbers({ calories: Infinity }).ok).toBe(false);
    expect(validateNutritionNumbers({ fat: -1 }).ok).toBe(false);
    expect(validateNutritionNumbers({ calories: 100 }, { baseServings: 0 }).ok).toBe(false);
    expect(
      validateNutritionNumbers({ protein: 10, carbohydrates: 10, fat: 1000 }, { resolvedMassGrams: 500 }).ok
    ).toBe(false);
  });
});

describe('fail closed — automated write paths', () => {
  it('14. RecipeNutritionCard rejects unsafe application (apply-payload contract)', () => {
    const r = estimateAlgorithmicNutrition('Blue Cheese Smashburgers', 4, BLUE_CHEESE);
    expect(buildNutritionApplyPayload(r, r.assessment, 4)).toBeNull();
    // Even a fully curated (source-backed) result is not auto-applicable yet.
    const curated = estimateAlgorithmicNutrition('Flour', 4, ['1 cup All-Purpose Flour']);
    expect(curated.assessment!.complete).toBe(true);
    expect(buildNutritionApplyPayload(curated, curated.assessment, 4)).toBeNull();
    expect(canApplyNutritionEstimate(curated, curated.assessment, 4).reasons).toContain(
      AUTOMATED_APPLICATION_DISABLED_REASON
    );
  });

  it('15. RecipeEditorModal cannot accept unsafe estimate fields (contract gate)', () => {
    // The editor gates the API response through the same contract before it
    // populates any field. An AI-like result is rejected.
    expect(canApplyNutritionEstimate(AI_LIKE_RESULT, undefined, 4).ok).toBe(false);
    expect(
      evaluateMachineNutritionApplicability(
        AI_LIKE_RESULT,
        { complete: false, trustedBasis: false, reasons: ['ai_estimate_without_source_backed_provenance'] },
        4
      ).ok
    ).toBe(false);
  });

  it('16. vaultIntelligence cannot persist unsafe generated nutrition', () => {
    const recovered: RecoveredRecipeMetadata = {
      nutrition: {
        value: { calories: 999, protein: 1, carbohydrates: 1, fat: 1, fiber: 0, sodium: 1 },
        confidence: 'medium',
        source: 'culinary_inference',
        explanation: 'estimated',
      },
      calories: { value: 999, confidence: 'medium', source: 'culinary_inference', explanation: 'estimated' },
    };
    const merged = mergeRecoveredMetadata(baseRecipe(), recovered, ['nutrition', 'calories']);
    expect(merged.nutrition).toBeUndefined();
    expect(merged.calories).toBeUndefined();
  });

  it('17. existing nutrition remains unchanged after a rejected estimate', () => {
    const existing = baseRecipe({
      calories: 500,
      nutrition: { calories: 500, protein: 20, source: 'user_defined' },
    });
    const recovered: RecoveredRecipeMetadata = {
      nutrition: {
        value: { calories: 999, protein: 1, carbohydrates: 1, fat: 1, fiber: 0, sodium: 1 },
        confidence: 'medium',
        source: 'culinary_inference',
        explanation: 'estimated',
      },
    };
    const merged = mergeRecoveredMetadata(existing, recovered, ['nutrition']);
    expect(merged.nutrition?.calories).toBe(500);
    expect(merged.nutrition?.protein).toBe(20);
    expect(merged.calories).toBe(500);
  });

  it('18. manual user-entered nutrition remains supported', () => {
    const prov = deriveNutritionProvenance(true, { source: 'ai_estimate', confidence: 'medium', confidenceNote: 'old' });
    expect(prov).toEqual({ source: 'user_defined', confidence: 'medium', confidenceNote: undefined });
    // Manual nutrition is not machine-generated and is not gated by the
    // machine-estimate contract.
    const manual = { calories: 250, protein: 10, source: 'user_defined' as const };
    expect(manual.calories).toBe(250);
  });
});

describe('mechanical parsing retained (no fabricated basis)', () => {
  it('19. leading quantity remains authoritative over later preparation prose', () => {
    const parts = normalizeRawIngredientLine(BLUE_CHEESE[0]);
    expect(parts.amount).toBe(454);
    expect(parts.unit).toBe('g');
    const det = estimateDeterministicNutrition([BLUE_CHEESE[0]]);
    expect(det.contributions[0].amount).toBe(454);
    expect(det.contributions[0].rawUnit).toBe('g');
  });

  it('20. gram/ounce/pound mechanical conversions remain correct', () => {
    const g = estimateDeterministicNutrition(['454 g Chicken Breast']).contributions[0];
    const oz = estimateDeterministicNutrition(['16 oz Chicken Breast']).contributions[0];
    const lb = estimateDeterministicNutrition(['1 lb Chicken Breast']).contributions[0];
    expect(g.resolved).toBe(true);
    expect(g.resolvedGrams).toBeCloseTo(454, 5);
    expect(oz.resolvedGrams).toBeCloseTo(453.59237, 3);
    expect(lb.resolvedGrams).toBeCloseTo(453.59237, 3);
  });

  it('21. no new nutrient/density/count-weight database is introduced', () => {
    // The fabricated profile layer and its per-ingredient resolver are gone.
    expect((estimatorModule as Record<string, unknown>).ALGORITHMIC_PROFILES).toBeUndefined();
    expect((estimatorModule as Record<string, unknown>).resolveAlgorithmicIngredient).toBeUndefined();
    expect((estimatorModule as Record<string, unknown>).MAX_ALGORITHMIC_INGREDIENT_GRAMS).toBeUndefined();

    // Unknown foods resolve to nothing rather than to an invented category.
    const unknown = estimateAlgorithmicNutrition('X', 4, ['100 g mystery meat']);
    expect(unknown.calories).toBe(0);
    expect(unknown.fat).toBe(0);
    expect(unknown.assessment!.complete).toBe(false);

    // The offline result delegates to the curated engine (same rounded totals).
    const det = estimateDeterministicNutrition(['1 cup All-Purpose Flour']);
    const offline = estimateAlgorithmicNutrition('X', 4, ['1 cup All-Purpose Flour']);
    expect(offline.calories).toBe(Math.round(det.totals.calories));
    expect(offline.fat).toBe(Math.round(det.totals.fat * 10) / 10);
  });

  it('the entry point falls back offline (no provider call) and stays non-applicable', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await estimateRecipeNutrition({
      title: 'Blue Cheese Smashburgers',
      servings: 4,
      ingredients: BLUE_CHEESE,
    });
    expect(r.source).toBe('offline_heuristic');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.assessment!.complete).toBe(false);
    expect(canApplyNutritionEstimate(r, r.assessment, 4).ok).toBe(false);
  });

  it('offline is never labelled as AI and the bounded messages are exact', () => {
    expect(nutritionEstimateHeading('offline_heuristic')).toContain('Offline');
    expect(nutritionEstimateHeading('offline_heuristic')).not.toContain('AI');
    expect(NUTRITION_INCOMPLETE_MESSAGE).toBe(
      'Nutrition could not be safely calculated. Review unresolved ingredients.'
    );
    expect(NUTRITION_AUTOSAVE_DISABLED_MESSAGE).toContain('curated local reference');
    expect(NUTRITION_AUTOSAVE_DISABLED_MESSAGE).toContain('automatic saving is disabled');
    expect(NUTRITION_AUTOSAVE_DISABLED_MESSAGE).not.toContain('source-backed');
    expect(NUTRITION_AUTOSAVE_DISABLED_MESSAGE).not.toContain('USDA-backed');
    expect(NUTRITION_AUTOSAVE_DISABLED_MESSAGE).not.toContain('culinary database heuristics');
  });
});

describe('Auto Recover Metadata — generated nutrition omitted, safe metadata continues', () => {
  const recoveredWithNutrition = (): RecoveredRecipeMetadata => ({
    prepTime: { value: '15 mins', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
    cookTime: { value: '25 mins', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
    servings: { value: 4, confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
    calories: { value: 850, confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
    nutrition: {
      value: { calories: 850, protein: 28, carbohydrates: 110, fat: 32, fiber: 3, sodium: 450 },
      confidence: 'medium',
      source: 'culinary_inference',
      explanation: 'x',
    },
    category: { value: 'Pasta', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
    cuisine: { value: 'Italian', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
    difficulty: { value: 'Medium', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
  });

  it('1/2. applies safe non-nutrition metadata and omits generated nutrition on an empty recipe', () => {
    const plan = planRecoveredMetadataApplication(recoveredWithNutrition(), { difficulty: 'Easy' }, 4);
    expect(plan.updates.prepTime).toBe('15 mins');
    expect(plan.updates.cookTime).toBe('25 mins');
    expect(plan.updates.servings).toBe(4);
    expect(plan.updates.category).toBe('Pasta');
    expect(plan.updates.cuisine).toBe('Italian');
    expect(plan.updates.difficulty).toBe('Medium');
    expect(plan.recoveredCount).toBe(6);
    expect(plan.hasRecoveredNutrition).toBe(true);
    expect(plan.nutritionApplicable).toBe(false);
    expect(plan.nutrition).toBeNull();
    expect(plan.nutritionOmitted).toBe(true);
    expect(Object.keys(plan.updates)).not.toContain('calories');
    expect(Object.keys(plan.updates)).not.toContain('nutrition');
  });

  it('3/4. does not overwrite existing fields and never writes partial nutrition', () => {
    const plan = planRecoveredMetadataApplication(
      recoveredWithNutrition(),
      {
        prepTime: '10 mins',
        cookTime: '20 mins',
        servings: 6,
        calories: '500',
        category: 'Main Course',
        cuisine: 'French',
        difficulty: 'Hard',
      },
      4
    );
    expect(plan.updates.prepTime).toBeUndefined();
    expect(plan.updates.cookTime).toBeUndefined();
    expect(plan.updates.servings).toBeUndefined();
    expect(plan.updates.category).toBeUndefined();
    expect(plan.updates.cuisine).toBeUndefined();
    expect(plan.updates.difficulty).toBeUndefined();
    expect(plan.nutrition).toBeNull();
    expect(plan.nutritionApplicable).toBe(false);
  });

  it('7/8. recovery nutrition without assessment (or forged complete:true) fails closed', () => {
    const noAssessment: RecoveredRecipeMetadata = {
      nutrition: {
        value: { calories: 850, protein: 28 },
        confidence: 'medium',
        source: 'culinary_inference',
        explanation: 'x',
      },
    };
    const plan1 = planRecoveredMetadataApplication(noAssessment, {}, 4);
    expect(plan1.nutritionOmitted).toBe(true);
    expect(plan1.nutrition).toBeNull();

    const forged: RecoveredRecipeMetadata = {
      nutrition: {
        value: {
          calories: 850,
          protein: 28,
          assessment: { complete: true, trustedBasis: false, reasons: [] },
        } as any,
        confidence: 'medium',
        source: 'culinary_inference',
        explanation: 'x',
      },
    };
    const plan2 = planRecoveredMetadataApplication(forged, {}, 4);
    expect(plan2.nutrition).toBeNull();
    expect(plan2.nutritionApplicable).toBe(false);

    const forgedTrusted: RecoveredRecipeMetadata = {
      nutrition: {
        value: {
          calories: 850,
          protein: 28,
          assessment: { complete: true, trustedBasis: true, reasons: [] },
        } as any,
        confidence: 'medium',
        source: 'culinary_inference',
        explanation: 'x',
      },
    };
    const plan3 = planRecoveredMetadataApplication(forgedTrusted, {}, 4);
    expect(plan3.nutrition).toBeNull();
  });

  it('5. saving after recovery cannot persist rejected generated nutrition', () => {
    const plan = planRecoveredMetadataApplication(recoveredWithNutrition(), {}, 4);
    expect(plan.nutrition).toBeNull();
    const md = serializeRecipeToObsidianMarkdown(baseRecipe());
    expect(md).not.toContain('calories: 850');
    expect(md).not.toContain('protein: 28');
  });

  it('6. manual nutrition entry still works after recovered nutrition is omitted', () => {
    const plan = planRecoveredMetadataApplication(recoveredWithNutrition(), {}, 4);
    expect(plan.nutrition).toBeNull();
    expect(deriveNutritionProvenance(true, undefined)).toEqual({
      source: 'user_defined',
      confidence: 'medium',
      confidenceNote: undefined,
    });
  });
});

describe('canonical evidence binding (ingredient ↔ food record)', () => {
  const numbers = { calories: 100, protein: 1, carbohydrates: 1, fat: 1, fiber: 0, sodium: 1 };
  const assessmentWith = (record: Record<string, unknown>, resolvedMassGrams = 100): NutritionAssessment => ({
    complete: true,
    trustedBasis: true,
    reasons: [],
    provenance: {
      calculationId: 'curated_food_reference',
      calculationVersion: 'curated_local_v1',
      resolved: [record as never],
      unresolvedIngredients: [],
      totalIngredients: 1,
      resolvedIngredients: 1,
      resolvedMassGrams,
      limitations: [],
    },
  });

  it('9. a real food ID paired with the wrong ingredient fails canonical evidence validation', () => {
    const assessment = assessmentWith({
      ingredient: '454 g ground beef (80/20)',
      foodId: 'butter',
      basis: 'direct_mass',
      source: 'curated_local',
    });
    const result = evaluateMachineNutritionApplicability(numbers, assessment, 4);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('evidence_not_resolvable');
  });

  it('10. a correct food ID with the wrong measurement basis fails', () => {
    const assessment = assessmentWith({
      ingredient: '1 cup Butter',
      foodId: 'butter',
      basis: 'direct_mass',
      source: 'curated_local',
    });
    const result = evaluateMachineNutritionApplicability(numbers, assessment, 4);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('evidence_basis_mismatch');
  });

  it('a correct ingredient/food/basis pairing passes rule evaluation but the deployed gate stays disabled', () => {
    const assessment = assessmentWith({
      ingredient: '100 g Butter',
      foodId: 'butter',
      basis: 'direct_mass',
      source: 'curated_local',
    });
    const coherent = { calories: 717, protein: 0.85, carbohydrates: 0.06, fat: 81.1, fiber: 0, sodium: 643 };
    expect(evaluateMachineNutritionApplicability(coherent, assessment, 4).ok).toBe(true);
    // The global automated-application disable remains authoritative.
    expect(canApplyNutritionEstimate(coherent, assessment, 4).ok).toBe(false);
    expect(canApplyNutritionEstimate(coherent, assessment, 4).reasons).toContain(
      AUTOMATED_APPLICATION_DISABLED_REASON
    );
  });
});

describe('metadata recovery — empty ingredients, trustedBasis, copy, legacy', () => {
  it('11. trustedBasis is false when zero ingredients resolve', () => {
    const r = estimateAlgorithmicNutrition('X', 4, ['100 g mystery meat']);
    expect(r.assessment!.provenance!.resolvedIngredients).toBe(0);
    expect(r.assessment!.trustedBasis).toBe(false);
  });

  it('13/14. empty ingredient lists skip nutrition estimation (no sentinel)', () => {
    const result = recoverMetadataAlgorithmically({ title: 'Empty', ingredients: [], instructions: [] });
    expect(result.nutrition).toBeUndefined();
    expect(result.calories).toBeUndefined();
    expect(result.category?.value).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('1 portion ingredients');
  });

  it('15. recovery copy describes the curated local reference (no stale/unsupported claims)', () => {
    const result = recoverMetadataAlgorithmically({
      title: 'X',
      ingredients: ['1 cup All-Purpose Flour'],
      instructions: ['Mix.'],
    });
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toContain('culinary database heuristics');
    expect(text).not.toContain('usda-backed');
    expect(result.nutrition?.explanation.toLowerCase()).toContain('curated local food reference');
  });

  it('17. existing stored/legacy nutrition remains readable and unchanged', () => {
    const legacy = { calories: 500, protein: 20 }; // no servings => legacy per-serving
    expect(nutritionForRequestedServings(legacy, 4).calories).toBe(2000);
  });
});
