import { describe, it, expect } from 'vitest';
import {
  FOOD_REFERENCES,
  findFoodReference,
  getFoodDensity,
  getFoodCountWeight,
  getFoodNutritionPer100g,
  resolveFoodMass,
  normalizeFoodText,
  FoodReferenceEntry,
} from '../../src/data/foodReference';
import {
  normalizeMeasurement,
  normalizeIngredientMeasurement,
  ML_PER_CUP,
  NormalizedMeasurement,
} from '../../src/utils/measurements';

function food(id: string): FoodReferenceEntry {
  const entry = FOOD_REFERENCES.find((f) => f.id === id);
  if (!entry) throw new Error(`missing test food: ${id}`);
  return entry;
}

describe('structural invariants (reference data coherence)', () => {
  it('every entry has a unique id, a name, per-100g nutrition, and curated_local source', () => {
    const ids = new Set<string>();
    for (const entry of FOOD_REFERENCES) {
      expect(entry.id).toBeTruthy();
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.name).toBeTruthy();
      expect(entry.nutritionPer100g).toBeTruthy();
      expect(entry.source).toBe('curated_local');
      expect(entry.nutritionPer100g).toHaveProperty('calories');
      expect(entry.nutritionPer100g).toHaveProperty('protein');
      expect(entry.nutritionPer100g).toHaveProperty('carbohydrates');
      expect(entry.nutritionPer100g).toHaveProperty('fat');
    }
  });

  it('every curated key (id, name, alias) resolves back to its OWN entry (no cross-food collisions)', () => {
    for (const entry of FOOD_REFERENCES) {
      const keys = [entry.id, entry.name, ...entry.aliases];
      for (const key of keys) {
        expect(findFoodReference(key)?.id).toBe(entry.id);
      }
    }
  });
});

describe('food matching: canonical, aliases, case, punctuation, plurals', () => {
  const cases: Array<[string, string]> = [
    ['All-Purpose Flour', 'all_purpose_flour'],
    ['Heavy Cream', 'heavy_cream'],
    ['Chicken Breast', 'chicken_breast'],
    ['Egg', 'egg'],
    ['Parmesan Cheese', 'parmesan_cheese'],
    ['Water', 'water'],
    ['Salt', 'salt'],
    ['Whole Milk', 'whole_milk'],
    ['Granulated Sugar', 'granulated_sugar'],
    ['Brown Sugar', 'brown_sugar'],
    ['Olive Oil', 'olive_oil'],
    ['Garlic', 'garlic'],
    ['Onion', 'onion'],
    ['Butter', 'butter'],
  ];
  it.each(cases)('canonical name %s -> %s', (input, id) => {
    expect(findFoodReference(input)?.id).toBe(id);
  });

  it('matches explicit aliases', () => {
    expect(findFoodReference('heavy whipping cream')?.id).toBe('heavy_cream');
    expect(findFoodReference('whipping cream')?.id).toBe('heavy_cream');
    expect(findFoodReference('all purpose flour')?.id).toBe('all_purpose_flour');
    expect(findFoodReference('ap flour')?.id).toBe('all_purpose_flour');
    expect(findFoodReference('boneless skinless chicken breast')?.id).toBe('chicken_breast');
    expect(findFoodReference('evoo')?.id).toBe('olive_oil');
    expect(findFoodReference('extra-virgin olive oil')?.id).toBe('olive_oil');
  });

  it('normalizes case and whitespace', () => {
    expect(findFoodReference('HEAVY CREAM')?.id).toBe('heavy_cream');
    expect(findFoodReference('All-Purpose  FLOUR')?.id).toBe('all_purpose_flour');
  });

  it('strips trailing punctuation conservatively (no identity change)', () => {
    expect(findFoodReference('Heavy Cream,')?.id).toBe('heavy_cream');
    expect(findFoodReference('salt.')?.id).toBe('salt');
  });

  it('matches explicit plural aliases', () => {
    expect(findFoodReference('eggs')?.id).toBe('egg');
    expect(findFoodReference('onions')?.id).toBe('onion');
    expect(findFoodReference('garlic cloves')?.id).toBe('garlic');
    expect(findFoodReference('large eggs')?.id).toBe('egg');
  });

  it('resolves raw wikilink text through normalization without mutation', () => {
    expect(findFoodReference('[[Chicken Breast]]')?.id).toBe('chicken_breast');
    expect(findFoodReference('[[Heavy Cream|heavy cream]]')?.id).toBe('heavy_cream');
  });

  it('resolves unknown to undefined', () => {
    expect(findFoodReference('zzz-not-a-food')).toBeUndefined();
    expect(findFoodReference(undefined)).toBeUndefined();
    expect(findFoodReference('')).toBeUndefined();
  });
});

describe('adversarial false positives (must resolve to undefined)', () => {
  it.each([
    'eggplant',
    'buttermilk',
    'peanut butter',
    'almond butter',
    'clarified butter',
    'coconut milk',
    'almond milk',
    'cream cheese',
    'sour cream',
    'chicken broth',
    'chicken thigh',
    'garlic powder',
    'onion powder',
    'garlic salt',
    'almond flour',
    'bread flour',
    'powdered sugar',
    'sugar substitute',
    'olives',
  ])('%s -> no food', (input) => {
    expect(findFoodReference(input)).toBeUndefined();
  });
});

describe('butter identity (salted vs unsalted)', () => {
  it('salted butter resolves to the salted butter entry', () => {
    expect(findFoodReference('salted butter')?.id).toBe('butter');
  });

  it('canonical butter resolves to the curated butter entry', () => {
    expect(findFoodReference('butter')?.id).toBe('butter');
  });

  it('butter, salted (comma alias) resolves to the butter entry', () => {
    expect(findFoodReference('butter, salted')?.id).toBe('butter');
  });

  it('unsalted butter is NOT aliased to salted butter (resolves undefined)', () => {
    expect(findFoodReference('unsalted butter')).toBeUndefined();
  });

  it('distinct butter-like foods remain undefined', () => {
    expect(findFoodReference('peanut butter')).toBeUndefined();
    expect(findFoodReference('almond butter')).toBeUndefined();
    expect(findFoodReference('clarified butter')).toBeUndefined();
  });

  it('butter entry still represents SALTED butter (high sodium)', () => {
    const butter = food('butter');
    expect(butter.nutritionPer100g.sodium).toBeGreaterThan(500);
  });
});

describe('density semantics', () => {
  it('flour and sugar both have curated densities and they DIFFER', () => {
    const flour = getFoodDensity(food('all_purpose_flour'));
    const sugar = getFoodDensity(food('granulated_sugar'));
    expect(flour).toBeDefined();
    expect(sugar).toBeDefined();
    if (!flour || !sugar) return;
    expect(flour.gramsPerMl).not.toBe(sugar.gramsPerMl);
  });

  it('flour density is LOW confidence (packing-sensitive); sugar is MEDIUM', () => {
    expect(getFoodDensity(food('all_purpose_flour'))?.confidence).toBe('low');
    expect(getFoodDensity(food('granulated_sugar'))?.confidence).toBe('medium');
  });

  it('density is intentionally omitted where ambiguous', () => {
    expect(getFoodDensity(food('onion'))).toBeUndefined();
    expect(getFoodDensity(food('salt'))).toBeUndefined();
    expect(getFoodDensity(food('brown_sugar'))).toBeUndefined();
    expect(getFoodDensity(food('chicken_breast'))).toBeUndefined();
    expect(getFoodDensity(food('parmesan_cheese'))).toBeUndefined();
  });

  it('unknown food / absence -> no density', () => {
    expect(getFoodDensity(undefined)).toBeUndefined();
    expect(getFoodDensity(food('water'))?.gramsPerMl).toBe(1.0);
  });
});

describe('count-weight semantics', () => {
  it('egg has a representative count weight (medium confidence, ~50g)', () => {
    const w = getFoodCountWeight(food('egg'));
    expect(w?.gramsPerItem).toBe(50);
    expect(w?.countUnit).toBe('egg');
    expect(w?.confidence).toBe('medium');
  });

  it('garlic clove has a representative count weight (low confidence)', () => {
    const w = getFoodCountWeight(food('garlic'));
    expect(w?.gramsPerItem).toBe(3);
    expect(w?.countUnit).toBe('clove');
    expect(w?.confidence).toBe('low');
  });

  it('count weight omitted where size-dependent', () => {
    expect(getFoodCountWeight(food('onion'))).toBeUndefined();
    expect(getFoodCountWeight(food('chicken_breast'))).toBeUndefined();
  });

  it('unknown / absence -> no count weight', () => {
    expect(getFoodCountWeight(undefined)).toBeUndefined();
  });
});

describe('nutrition per 100g', () => {
  it('returns curated nutrition for a known food and undefined for unknown', () => {
    expect(getFoodNutritionPer100g(food('egg'))?.protein).toBeGreaterThan(10);
    expect(getFoodNutritionPer100g(food('water'))?.calories).toBe(0);
    expect(getFoodNutritionPer100g(food('chicken_breast'))?.protein).toBeGreaterThan(20);
    expect(getFoodNutritionPer100g(food('chicken_breast'))?.fat).toBeLessThan(5);
    expect(getFoodNutritionPer100g(undefined)).toBeUndefined();
  });
});

describe('mass resolution', () => {
  it('direct mass: uses deterministic grams (physical conversion), high confidence', () => {
    const m = normalizeMeasurement(8, 'oz');
    const resolved = resolveFoodMass(m, food('chicken_breast'));
    expect(resolved.grams).toBe(m.grams); // pass-through of deterministic mass
    expect(resolved.reason).toBe('direct_mass');
    expect(resolved.confidence).toBe('high');
    expect(resolved.grams).toBeGreaterThan(200);
    expect(resolved.grams).toBeLessThan(260);
  });

  it('volume + explicit density resolves grams (flour 1 cup ~125g)', () => {
    const m = normalizeMeasurement(1, 'cup', 'flour');
    const resolved = resolveFoodMass(m, food('all_purpose_flour'));
    expect(resolved.reason).toBe('density');
    expect(resolved.grams).toBeGreaterThan(100);
    expect(resolved.grams).toBeLessThan(150);
  });

  it('volume WITHOUT density stays unresolved', () => {
    const m = normalizeMeasurement(1, 'cup', 'onions');
    const resolved = resolveFoodMass(m, food('onion'));
    expect(resolved.grams).toBeUndefined();
    expect(resolved.reason).toBe('unknown');
  });

  it('count + explicit count weight resolves (2 eggs ~100g), medium confidence', () => {
    const m = normalizeMeasurement(2, undefined, 'eggs');
    const resolved = resolveFoodMass(m, food('egg'));
    expect(resolved.reason).toBe('count_weight');
    expect(resolved.grams).toBe(100);
    expect(resolved.confidence).toBe('medium');
  });

  it('count WITHOUT count weight stays unresolved', () => {
    const m = normalizeMeasurement(2, 'eggs');
    const resolved = resolveFoodMass(m, food('chicken_breast')); // no count weight
    expect(resolved.grams).toBeUndefined();
    expect(resolved.reason).toBe('unknown');
  });

  it('unknown amount stays unresolved (never becomes 1)', () => {
    const m = normalizeMeasurement(undefined, undefined, 'salt');
    expect(m.amount).toBeNull();
    const resolved = resolveFoodMass(m, food('salt'));
    expect(resolved.grams).toBeUndefined();
    expect(resolved.reason).toBe('unknown');
  });

  it('unknown food does not receive generic density/count weight', () => {
    const m = normalizeMeasurement(1, 'cup', 'zebra');
    const resolved = resolveFoodMass(m, undefined);
    expect(resolved.grams).toBeUndefined();
    expect(resolved.reason).toBe('unknown');
  });

  it('mass resolution requires both a measurement and a food', () => {
    expect(resolveFoodMass(undefined, food('salt')).grams).toBeUndefined();
    expect(resolveFoodMass(normalizeMeasurement(1, 'cup'), undefined).grams).toBeUndefined();
  });
});

describe('amount semantics: negatives rejected, zero preserved', () => {
  it('negative mass amount stays unresolved (direct mass)', () => {
    const m = normalizeMeasurement(-1, 'oz');
    expect(m.amount).toBe(-1);
    const resolved = resolveFoodMass(m, food('chicken_breast'));
    expect(resolved.grams).toBeUndefined();
    expect(resolved.reason).toBe('unknown');
  });

  it('negative volume amount stays unresolved (density)', () => {
    const m = normalizeMeasurement(-1, 'cup', 'flour');
    expect(m.kind).toBe('volume');
    const resolved = resolveFoodMass(m, food('all_purpose_flour'));
    expect(resolved.grams).toBeUndefined();
    expect(resolved.reason).toBe('unknown');
  });

  it('negative count amount stays unresolved (count weight)', () => {
    const m = normalizeMeasurement(-2, undefined, 'eggs');
    expect(m.kind).toBe('count');
    const resolved = resolveFoodMass(m, food('egg'));
    expect(resolved.grams).toBeUndefined();
    expect(resolved.reason).toBe('unknown');
  });

  it('negative amounts never produce negative grams via any reason', () => {
    const probes: Array<[NormalizedMeasurement, FoodReferenceEntry]> = [
      [normalizeMeasurement(-1, 'oz'), food('chicken_breast')],
      [normalizeMeasurement(-1, 'cup', 'flour'), food('all_purpose_flour')],
      [normalizeMeasurement(-2, undefined, 'eggs'), food('egg')],
    ];
    for (const [m, f] of probes) {
      const resolved = resolveFoodMass(m, f);
      expect(resolved.grams).toBeUndefined();
    }
  });

  it('zero is a valid degenerate input: 0 g direct mass', () => {
    const m = normalizeMeasurement(0, 'g');
    const resolved = resolveFoodMass(m, food('chicken_breast'));
    expect(resolved.grams).toBe(0);
    expect(resolved.reason).toBe('direct_mass');
  });

  it('zero is a valid degenerate input: 0 cup flour density', () => {
    const m = normalizeMeasurement(0, 'cup', 'flour');
    const resolved = resolveFoodMass(m, food('all_purpose_flour'));
    expect(resolved.grams).toBe(0);
    expect(resolved.reason).toBe('density');
  });

  it('zero is a valid degenerate input: 0 eggs count weight', () => {
    const m = normalizeMeasurement(0, undefined, 'eggs');
    expect(m.kind).toBe('count');
    const resolved = resolveFoodMass(m, food('egg'));
    expect(resolved.grams).toBe(0);
    expect(resolved.reason).toBe('count_weight');
  });

  it('zero stays distinguishable from invalid negative input', () => {
    expect(resolveFoodMass(normalizeMeasurement(-1, 'oz'), food('chicken_breast')).grams).toBeUndefined();
    expect(resolveFoodMass(normalizeMeasurement(0, 'oz'), food('chicken_breast')).grams).toBe(0);
  });

  it('NaN / non-finite amounts stay unresolved', () => {
    const NaNMeas: NormalizedMeasurement = { ...normalizeMeasurement(1, 'g'), amount: Number.NaN };
    const InfMeas: NormalizedMeasurement = { ...normalizeMeasurement(1, 'g'), amount: Number.POSITIVE_INFINITY };
    expect(resolveFoodMass(NaNMeas, food('chicken_breast')).grams).toBeUndefined();
    expect(resolveFoodMass(InfMeas, food('chicken_breast')).grams).toBeUndefined();
  });
});

describe('critical comparisons', () => {
  it('1 cup flour vs 1 cup sugar: SAME volume, DIFFERENT mass', () => {
    const flourMeas = normalizeMeasurement(1, 'cup', 'flour');
    const sugarMeas = normalizeMeasurement(1, 'cup', 'sugar');
    expect(flourMeas.milliliters).toBe(sugarMeas.milliliters);
    expect(flourMeas.milliliters).toBeCloseTo(ML_PER_CUP, 10);

    const flour = resolveFoodMass(flourMeas, food('all_purpose_flour'));
    const sugar = resolveFoodMass(sugarMeas, food('granulated_sugar'));
    expect(flour.grams).not.toBe(sugar.grams);
    expect(flour.grams).toBeLessThan(sugar.grams!); // flour lighter than sugar
  });

  it('240 ml heavy cream produces a plausible mass (~237g)', () => {
    const m = normalizeMeasurement(240, 'ml', 'heavy cream');
    const resolved = resolveFoodMass(m, food('heavy_cream'));
    expect(resolved.reason).toBe('density');
    expect(resolved.grams).toBeGreaterThan(220);
    expect(resolved.grams).toBeLessThan(260);
  });

  it('2 eggs produce count-derived mass when the count weight is curated', () => {
    const m = normalizeIngredientMeasurement({ amount: 2, name: 'eggs' });
    expect(m.kind).toBe('count');
    const resolved = resolveFoodMass(m, food('egg'));
    expect(resolved.reason).toBe('count_weight');
    expect(resolved.grams).toBe(100);
  });

  it('salt to taste remains unresolved even though salt is recognized', () => {
    const m = normalizeIngredientMeasurement({ name: 'salt to taste' });
    const resolved = resolveFoodMass(m, food('salt'));
    expect(resolved.grams).toBeUndefined();
    expect(resolved.reason).toBe('unknown');
  });
});

describe('safety: no mutation of inputs', () => {
  it('does not mutate a NormalizedMeasurement object', () => {
    const m = normalizeMeasurement(2, 'eggs');
    const before = JSON.stringify(m);
    resolveFoodMass(m, food('egg'));
    expect(JSON.stringify(m)).toBe(before);
  });

  it('does not mutate the food reference entry', () => {
    const entry = food('egg');
    const aliasesBefore = [...entry.aliases];
    const countBefore = JSON.stringify(entry.countWeights);
    findFoodReference('eggs');
    getFoodCountWeight(entry);
    resolveFoodMass(normalizeMeasurement(2, undefined, 'eggs'), entry);
    expect(JSON.stringify(entry.aliases)).toBe(JSON.stringify(aliasesBefore));
    expect(JSON.stringify(entry.countWeights)).toBe(countBefore);
  });

  it('normalizeFoodText is pure (does not mutate its input string)', () => {
    const raw = '[[Heavy Cream|heavy cream]]';
    normalizeFoodText(raw);
    expect(raw).toBe('[[Heavy Cream|heavy cream]]');
  });
});

describe('immutability: canonical reference data cannot be corrupted', () => {
  it('FOOD_REFERENCES is frozen (array cannot be extended or reordered)', () => {
    expect(Object.isFrozen(FOOD_REFERENCES)).toBe(true);
    expect(() => {
      (FOOD_REFERENCES as unknown as FoodReferenceEntry[]).push(food('egg'));
    }).toThrow();
    expect(() => {
      (FOOD_REFERENCES as unknown as FoodReferenceEntry[])[0] = food('egg');
    }).toThrow();
  });

  it('every canonical entry is frozen', () => {
    for (const entry of FOOD_REFERENCES) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it('aliases arrays are frozen', () => {
    for (const entry of FOOD_REFERENCES) {
      expect(Object.isFrozen(entry.aliases)).toBe(true);
    }
    const butter = food('butter');
    expect(() => {
      (butter.aliases as unknown as string[]).push('margarine');
    }).toThrow();
  });

  it('nutritionPer100g is frozen and cannot be mutated', () => {
    const butter = food('butter');
    expect(Object.isFrozen(butter.nutritionPer100g)).toBe(true);
    expect(() => {
      (butter.nutritionPer100g as unknown as { calories: number }).calories = 1;
    }).toThrow();
  });

  it('density fields cannot be mutated', () => {
    const flour = food('all_purpose_flour');
    expect(() => {
      (flour as unknown as { densityGPerMl: number }).densityGPerMl = 999;
    }).toThrow();
  });

  it('countWeights is frozen and cannot be mutated', () => {
    const egg = food('egg');
    expect(Object.isFrozen(egg.countWeights)).toBe(true);
    expect(() => {
      (egg.countWeights as unknown as Record<string, number>).egg = 999;
    }).toThrow();
  });

  it('attempted mutations cannot corrupt later lookups', () => {
    const butter = food('butter');
    const egg = food('egg');

    expect(() => {
      (butter as unknown as { name: string }).name = 'EVIL';
    }).toThrow();
    expect(() => {
      (butter.aliases as unknown as string[]).push('x');
    }).toThrow();
    expect(() => {
      (butter.nutritionPer100g as unknown as { calories: number }).calories = 1;
    }).toThrow();
    expect(() => {
      (egg.countWeights as unknown as Record<string, number>).egg = 1;
    }).toThrow();

    const freshButter = food('butter');
    expect(freshButter.name).toBe('Butter');
    expect(freshButter.nutritionPer100g.calories).toBe(717);
    expect(freshButter.nutritionPer100g.sodium).toBe(643);
    expect(freshButter.aliases).toContain('salted butter');
    expect(freshButter.aliases).not.toContain('unsalted butter');

    const freshEgg = food('egg');
    expect(freshEgg.countWeights?.egg).toBe(50);
    expect(findFoodReference('salted butter')?.id).toBe('butter');
    expect(findFoodReference('unsalted butter')).toBeUndefined();
  });
});
