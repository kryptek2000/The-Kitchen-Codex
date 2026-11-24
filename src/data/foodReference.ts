/**
 * The Kitchen Codex — Curated Food Reference Layer (v0.3.0 Step 3)
 *
 * This module supplies EXPLICIT, deterministic food knowledge for future
 * nutrition estimation. It is REFERENCE INFRASTRUCTURE ONLY — it is NOT wired
 * into `estimateRecipeNutrition` (that is Step 4).
 *
 * DATA HONESTY (most important):
 *
 *   Every numeric reference value here is a REPRESENTATIVE / APPROXIMATE value,
 *   not a laboratory measurement. Nutrition-per-100g values are typical USDA
 *   FoodData Central reference values for the described food. Densities and
 *   count weights are culinary approximations, and each carries an explicit
 *   confidence + note.
 *
 *   We deliberately distinguish:
 *     - deterministic physical unit conversion   (handled by Step 2: oz -> g)
 *     - a reference/representative value          (nutrition per 100g)
 *     - a culinary approximation                  (density, count weight)
 *
 *   Where a value is too ambiguous to curate honestly (e.g. onion / chicken
 *   breast weight, salt density, brown-sugar density), it is OMITTED rather
 *   than fabricated. Returning unresolved is always better than inventing
 *   precision.
 */

import type {
  NormalizedMeasurement,
  MeasurementConfidence,
} from '../utils/measurements';

/**
 * Nutrition macro data per 100 grams (representative reference values).
 *
 * All fields are READONLY: this is canonical reference data and must not be
 * mutated by consumers. Runtime immutability is enforced by `deepFreeze`.
 */
export interface FoodNutritionPer100g {
  readonly calories: number;
  readonly protein: number;
  readonly carbohydrates: number;
  readonly fat: number;
  readonly fiber?: number;
  readonly sodium?: number; // milligrams
}

/** A density (grams per milliliter) is a CULINARY APPROXIMATION, not a constant. */
export interface FoodDensity {
  readonly gramsPerMl: number;
  readonly confidence: MeasurementConfidence;
  readonly note?: string;
}

/** A count-weight (grams per item) is a representative average, not exact. */
export interface FoodCountWeight {
  readonly gramsPerItem: number;
  readonly countUnit: string;
  readonly confidence: MeasurementConfidence;
  readonly note?: string;
}

/** A curated food reference entry (deeply readonly / runtime-frozen). */
export interface FoodReferenceEntry {
  /** Stable canonical identity (no spaces/plurals). */
  readonly id: string;
  /** Canonical display name. */
  readonly name: string;
  /** Explicitly curated aliases (incl. plurals / common descriptors). */
  readonly aliases: readonly string[];
  /** Representative per-100g nutrition (immutable). */
  readonly nutritionPer100g: FoodNutritionPer100g;
  /** Density when a defensible approximation exists; otherwise omitted. */
  readonly densityGPerMl?: number;
  readonly densityConfidence?: MeasurementConfidence;
  readonly densityNote?: string;
  /** Count weight keyed by the recipe-relevant count noun (one per food). */
  readonly countWeights?: Readonly<Record<string, number>>;
  readonly countWeightConfidence?: MeasurementConfidence;
  readonly countWeightNote?: string;
  /** Provenance authority — always 'curated_local' for this layer. */
  readonly source: 'curated_local';
  /** Specific basis for the nutrition values (which food, reference family). */
  readonly sourceNote?: string;
}

/**
 * Recursively freezes an object/array (and all nested objects/arrays) so the
 * curated reference data cannot be mutated at runtime. Scalars are returned
 * as-is. This is a small local helper — no external dependency.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Representative nutrition-per-100g values (typical USDA FoodData Central
 * reference family values) + culinary approximation densities/count weights.
 *
 * The whole dataset is DEEP-FROZEN at module load: consumers cannot mutate an
 * entry, its aliases, its nutrition, its density, or its count weights. This
 * guarantees that the canonical values returned by later lookups are always
 * unchanged.
 */
export const FOOD_REFERENCES: readonly FoodReferenceEntry[] = deepFreeze([
  {
    id: 'heavy_cream',
    name: 'Heavy Cream',
    aliases: ['heavy whipping cream', 'whipping cream', 'heavy cream, 36% fat'],
    nutritionPer100g: { calories: 340, protein: 2.8, carbohydrates: 2.8, fat: 36, fiber: 0, sodium: 40 },
    densityGPerMl: 0.99,
    densityConfidence: 'medium',
    densityNote: '≈0.99 g/mL; culinary approximation (36% fat whipping cream).',
    source: 'curated_local',
    sourceNote: 'Cream, heavy whipping, 36% fat (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'whole_milk',
    name: 'Whole Milk',
    aliases: ['milk', 'whole milk, 3.25% milkfat', 'whole dairy milk'],
    nutritionPer100g: { calories: 61, protein: 3.15, carbohydrates: 4.8, fat: 3.25, fiber: 0, sodium: 43 },
    densityGPerMl: 1.03,
    densityConfidence: 'medium',
    densityNote: '≈1.03 g/mL; culinary approximation (whole milk).',
    source: 'curated_local',
    sourceNote: 'Milk, whole, 3.25% milkfat (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'butter',
    name: 'Butter',
    aliases: ['salted butter', 'butter, salted'],
    nutritionPer100g: { calories: 717, protein: 0.85, carbohydrates: 0.06, fat: 81.1, fiber: 0, sodium: 643 },
    densityGPerMl: 0.959,
    densityConfidence: 'medium',
    densityNote: '≈0.96 g/mL; culinary approximation (salted butter).',
    source: 'curated_local',
    sourceNote: 'Butter, salted (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'butter_unsalted',
    name: 'Unsalted Butter',
    aliases: ['butter, unsalted', 'sweet butter', 'unsalted sweet cream butter'],
    // Deliberately separate from salted butter: the sodium profiles differ by
    // orders of magnitude (salted ≈ 643 mg/100 g vs unsalted ≈ 11 mg/100 g), so
    // one identity can never stand in for the other.
    nutritionPer100g: { calories: 717, protein: 0.85, carbohydrates: 0.06, fat: 81.1, fiber: 0, sodium: 11 },
    densityGPerMl: 0.959,
    densityConfidence: 'medium',
    densityNote: '≈0.96 g/mL; culinary approximation (unsalted butter).',
    source: 'curated_local',
    sourceNote: 'Butter, without salt (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'all_purpose_flour',
    name: 'All-Purpose Flour',
    aliases: ['all purpose flour', 'ap flour', 'all-purpose flour, enriched', 'white flour'],
    nutritionPer100g: { calories: 364, protein: 10.3, carbohydrates: 76.3, fat: 1.0, fiber: 2.7, sodium: 2 },
    densityGPerMl: 0.53,
    densityConfidence: 'low',
    densityNote: '≈0.53 g/mL (~125 g/cup); packing/technique sensitive — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Wheat flour, all-purpose, enriched (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'granulated_sugar',
    name: 'Granulated Sugar',
    aliases: ['sugar', 'white sugar', 'cane sugar'],
    nutritionPer100g: { calories: 387, protein: 0, carbohydrates: 100, fat: 0, fiber: 0, sodium: 1 },
    densityGPerMl: 0.845,
    densityConfidence: 'medium',
    densityNote: '≈0.845 g/mL (~200 g/cup).',
    source: 'curated_local',
    sourceNote: 'Sugars, granulated (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'brown_sugar',
    name: 'Brown Sugar',
    aliases: ['light brown sugar', 'dark brown sugar'],
    nutritionPer100g: { calories: 380, protein: 0.12, carbohydrates: 98, fat: 0.1, fiber: 0, sodium: 28 },
    densityGPerMl: 0.93,
    densityConfidence: 'low',
    densityNote: '≈220 g per packed cup (≈0.93 g/mL); packing strongly affects volume — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Sugars, brown (USDA FDC reference family); representative per-100g. Volume assumes packed brown sugar.',
  },
  {
    id: 'olive_oil',
    name: 'Olive Oil',
    aliases: ['extra virgin olive oil', 'extra-virgin olive oil', 'evoo'],
    nutritionPer100g: { calories: 884, protein: 0, carbohydrates: 0, fat: 100, fiber: 0, sodium: 0 },
    densityGPerMl: 0.915,
    densityConfidence: 'medium',
    densityNote: '≈0.915 g/mL; culinary approximation (olive oil).',
    source: 'curated_local',
    sourceNote: 'Oil, olive, salad or cooking (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'chicken_breast',
    name: 'Chicken Breast',
    aliases: [
      'boneless skinless chicken breast',
      'boneless, skinless chicken breast',
      'skinless chicken breast',
      'chicken breast, skinless',
    ],
    // No density (solid) and NO count weight (weight is highly variable).
    nutritionPer100g: { calories: 120, protein: 22.5, carbohydrates: 0, fat: 2.6, fiber: 0, sodium: 45 },
    source: 'curated_local',
    sourceNote: 'Chicken, broilers or fryers, breast, meat only, raw (USDA FDC reference family); representative per-100g. Count weight deliberately omitted (highly variable).',
  },
  {
    id: 'egg',
    name: 'Egg',
    aliases: ['eggs', 'large egg', 'large eggs', 'chicken egg'],
    nutritionPer100g: { calories: 143, protein: 12.56, carbohydrates: 0.72, fat: 9.51, fiber: 0, sodium: 142 },
    countWeights: { egg: 50 },
    countWeightConfidence: 'medium',
    countWeightNote: '1 large egg ≈ 50 g (representative; individual eggs vary).',
    source: 'curated_local',
    sourceNote: 'Egg, whole, raw (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'garlic',
    name: 'Garlic',
    aliases: ['garlic clove', 'garlic cloves', 'fresh garlic'],
    nutritionPer100g: { calories: 149, protein: 6.36, carbohydrates: 33.06, fat: 0.5, fiber: 2.1, sodium: 17 },
    countWeights: { clove: 3 },
    countWeightConfidence: 'low',
    countWeightNote: '≈3 g/clove (representative; varies widely) — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Garlic, raw (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'onion',
    name: 'Onion',
    aliases: ['onions', 'yellow onion', 'white onion', 'red onion', 'yellow onions'],
    nutritionPer100g: { calories: 40, protein: 1.1, carbohydrates: 9.34, fat: 0.1, fiber: 1.7, sodium: 4 },
    countWeights: { onion: 110 },
    countWeightConfidence: 'low',
    countWeightNote: '≈110 g per medium onion (representative; sizes vary widely).',
    source: 'curated_local',
    sourceNote: 'Onions, raw (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'parmesan_cheese',
    name: 'Parmesan Cheese',
    aliases: ['parmesan', 'parmigiano-reggiano', 'parmesan, grated', 'grated parmesan'],
    // Density omitted (grated vs whole varies substantially).
    nutritionPer100g: { calories: 431, protein: 38.5, carbohydrates: 4.1, fat: 28.6, fiber: 0, sodium: 1602 },
    source: 'curated_local',
    sourceNote: 'Cheese, parmesan, shredded (USDA FDC reference family); representative per-100g. Density omitted (grated/whole varies).',
  },
  {
    id: 'water',
    name: 'Water',
    aliases: ['filtered water', 'cold water'],
    nutritionPer100g: { calories: 0, protein: 0, carbohydrates: 0, fat: 0, fiber: 0, sodium: 0 },
    densityGPerMl: 1.0,
    densityConfidence: 'high',
    densityNote: '≈1.00 g/mL; effectively exact for liquid water at culinary temperatures.',
    source: 'curated_local',
    sourceNote: 'Water (plain); per-100g macros are zero by definition.',
  },
  {
    id: 'salt',
    name: 'Salt',
    aliases: ['table salt', 'kosher salt', 'fine salt', 'sea salt'],
    // Sodium per 100g NaCl ≈ 39300 mg. Density is a LOW-confidence culinary
    // convention: 1 tsp table salt ≈ 6 g (grain size varies).
    nutritionPer100g: { calories: 0, protein: 0, carbohydrates: 0, fat: 0, fiber: 0, sodium: 38758 },
    densityGPerMl: 1.2,
    densityConfidence: 'low',
    densityNote: '≈1 tsp table salt = 6 g; salinity-by-volume varies with grain/type — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Salt, table (NaCl); per-100g sodium ≈ 38,758 mg. Volume assumed table-salt convention (1 tsp ≈ 6 g).',
  },
  {
    id: 'cooked_chicken',
    name: 'Cooked Chicken',
    aliases: [
      'shredded chicken',
      'shredded chicken breast',
      'cooked chicken',
      'cooked chicken breast',
      'diced chicken',
      'rotisserie chicken',
    ],
    // Density is a culinary convention for shredded/diced cooked chicken
    // (~135 g per cup, i.e. cooked, diced).
    nutritionPer100g: { calories: 165, protein: 31, carbohydrates: 0, fat: 3.6, fiber: 0, sodium: 74 },
    densityGPerMl: 0.57,
    densityConfidence: 'low',
    densityNote: '≈135 g per cup of cooked, shredded/diced chicken — form and packing vary (LOW confidence).',
    source: 'curated_local',
    sourceNote: 'Chicken, breast, meat only, cooked (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'chicken_thigh',
    name: 'Chicken Thigh',
    aliases: ['chicken thighs', 'boneless skinless chicken thighs', 'boneless, skinless chicken thighs', 'chicken thigh meat'],
    nutritionPer100g: { calories: 119, protein: 19.7, carbohydrates: 0, fat: 3.9, fiber: 0, sodium: 86 },
    countWeights: { thigh: 110 },
    countWeightConfidence: 'low',
    countWeightNote: '≈110 g per boneless, skinless thigh (representative average; individual thighs vary).',
    source: 'curated_local',
    sourceNote: 'Chicken, broilers or fryers, thigh, meat only, raw (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'vegetable_oil',
    name: 'Vegetable Oil',
    aliases: ['canola oil', 'soybean oil', 'sunflower oil', 'corn oil'],
    nutritionPer100g: { calories: 884, protein: 0, carbohydrates: 0, fat: 100, fiber: 0, sodium: 0 },
    densityGPerMl: 0.92,
    densityConfidence: 'medium',
    densityNote: '≈0.92 g/mL; culinary approximation (vegetable/canola oil).',
    source: 'curated_local',
    sourceNote: 'Oil, vegetable, canola (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'monterey_jack',
    name: 'Monterey Jack Cheese',
    aliases: ['monterey jack', 'monterey jack cheese', 'shredded monterey jack cheese', 'monterey jack cheese, shredded'],
    nutritionPer100g: { calories: 373, protein: 24.5, carbohydrates: 0.7, fat: 30.3, fiber: 0, sodium: 600 },
    densityGPerMl: 0.48,
    densityConfidence: 'low',
    densityNote: '≈113 g per cup of shredded cheese (≈0.48 g/mL); shred/pack varies — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Cheese, monterey (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'cheddar_cheese',
    name: 'Cheddar Cheese',
    aliases: ['cheddar', 'cheddar cheese', 'shredded cheddar cheese', 'sharp cheddar cheese', 'mild cheddar cheese'],
    nutritionPer100g: { calories: 403, protein: 22.9, carbohydrates: 3.1, fat: 33.3, fiber: 0, sodium: 653 },
    densityGPerMl: 0.48,
    densityConfidence: 'low',
    densityNote: '≈113 g per cup of shredded cheese (≈0.48 g/mL); shred/pack varies — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Cheese, cheddar (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'salsa_verde',
    name: 'Salsa Verde',
    aliases: ['salsa verde, tomatillo', 'green salsa', 'tomatillo salsa', 'salsa verde (tomatillo)'],
    nutritionPer100g: { calories: 38, protein: 1.5, carbohydrates: 6.5, fat: 0.9, fiber: 1.5, sodium: 630 },
    densityGPerMl: 1.0,
    densityConfidence: 'low',
    densityNote: '≈1.0 g/mL; brand/recipe viscosity varies — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Sauce, salsa verde (tomatillo-based; USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'corn_tortilla',
    name: 'Corn Tortilla',
    aliases: ['corn tortillas', 'tortilla, corn', 'tortillas, corn', 'yellow corn tortillas', 'white corn tortillas'],
    nutritionPer100g: { calories: 218, protein: 5.7, carbohydrates: 44.6, fat: 2.9, fiber: 6.3, sodium: 45 },
    countWeights: { tortilla: 28 },
    countWeightConfidence: 'medium',
    countWeightNote: '≈28 g per 6-inch corn tortilla (representative; sizes vary).',
    source: 'curated_local',
    sourceNote: 'Tortilla, corn (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'chicken_broth',
    name: 'Chicken Broth',
    aliases: ['chicken stock', 'broth', 'stock', 'chicken broth, ready-to-serve'],
    nutritionPer100g: { calories: 4, protein: 0.5, carbohydrates: 0.4, fat: 0.2, fiber: 0, sodium: 350 },
    densityGPerMl: 1.0,
    densityConfidence: 'medium',
    densityNote: '≈1.0 g/mL; culinary approximation (broth).',
    source: 'curated_local',
    sourceNote: 'Soup, chicken broth, ready-to-serve (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'ground_cumin',
    name: 'Ground Cumin',
    aliases: ['cumin', 'cumin, ground', 'cumin powder', 'ground cumin seed'],
    nutritionPer100g: { calories: 375, protein: 17.8, carbohydrates: 44.2, fat: 22.3, fiber: 10.5, sodium: 168 },
    densityGPerMl: 0.45,
    densityConfidence: 'low',
    densityNote: '≈0.45 g/mL for ground spice (packing varies) — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Spices, cumin seed (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'cilantro',
    name: 'Cilantro',
    aliases: ['fresh cilantro', 'chopped fresh cilantro', 'cilantro leaves', 'coriander leaves', 'fresh coriander'],
    nutritionPer100g: { calories: 23, protein: 2.1, carbohydrates: 3.7, fat: 0.5, fiber: 2.8, sodium: 46 },
    densityGPerMl: 0.07,
    densityConfidence: 'low',
    densityNote: '≈0.07 g/mL for loosely packed chopped leaves (≈16 g per cup); packing varies — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Coriander (cilantro) leaves, raw (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'jalapeno',
    name: 'Jalapeño Pepper',
    aliases: ['jalapeños', 'jalapenos', 'jalapeno pepper', 'jalapeno peppers', 'jalapeños, seeded', 'fresh jalapeños'],
    nutritionPer100g: { calories: 29, protein: 0.9, carbohydrates: 6.5, fat: 0.4, fiber: 2.8, sodium: 3 },
    countWeights: { pepper: 14 },
    countWeightConfidence: 'medium',
    countWeightNote: '≈14 g per jalapeño pepper (representative; sizes vary).',
    source: 'curated_local',
    sourceNote: 'Peppers, jalapeno, raw (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'sour_cream',
    name: 'Sour Cream',
    aliases: ['sour cream, regular', 'regular sour cream'],
    nutritionPer100g: { calories: 198, protein: 2.4, carbohydrates: 4.6, fat: 19.4, fiber: 0, sodium: 31 },
    densityGPerMl: 1.0,
    densityConfidence: 'medium',
    densityNote: '≈1.0 g/mL; culinary approximation (cultured sour cream).',
    source: 'curated_local',
    sourceNote: 'Cream, sour, cultured (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'white_rice',
    name: 'White Rice',
    aliases: ['rice', 'long-grain white rice', 'long grain white rice', 'uncooked white rice', 'white rice, uncooked'],
    nutritionPer100g: { calories: 365, protein: 7.1, carbohydrates: 80, fat: 0.7, fiber: 1.3, sodium: 1 },
    densityGPerMl: 0.85,
    densityConfidence: 'medium',
    densityNote: '≈185 g per cup of uncooked long-grain rice (≈0.78 g/mL to the cup line); use one cup = 185 g.',
    source: 'curated_local',
    sourceNote: 'Rice, white, long-grain, regular, raw, unenriched (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'pasta',
    name: 'Pasta',
    aliases: ['spaghetti', 'penne', 'macaroni', 'dry pasta', 'uncooked pasta', 'elbow macaroni'],
    nutritionPer100g: { calories: 371, protein: 13, carbohydrates: 74.7, fat: 1.5, fiber: 3.2, sodium: 6 },
    densityGPerMl: 0.4,
    densityConfidence: 'low',
    densityNote: '≈0.40 g/mL for dry pasta shapes (≈95 g per cup); shape dependent — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Pasta, dry, unenriched (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'potato',
    name: 'Potato',
    aliases: ['potatoes', 'russet potatoes', 'yukon gold potatoes', 'white potatoes'],
    nutritionPer100g: { calories: 77, protein: 2, carbohydrates: 17.5, fat: 0.1, fiber: 2.2, sodium: 6 },
    countWeights: { potato: 173 },
    countWeightConfidence: 'low',
    countWeightNote: '≈173 g per medium potato (representative; sizes vary widely).',
    source: 'curated_local',
    sourceNote: 'Potatoes, flesh and skin, raw (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'tomato',
    name: 'Tomato',
    aliases: ['tomatoes', 'fresh tomatoes', 'roma tomatoes', 'plum tomatoes'],
    nutritionPer100g: { calories: 18, protein: 0.9, carbohydrates: 3.9, fat: 0.2, fiber: 1.2, sodium: 5 },
    countWeights: { tomato: 123 },
    countWeightConfidence: 'low',
    countWeightNote: '≈123 g per medium tomato (representative; sizes vary).',
    source: 'curated_local',
    sourceNote: 'Tomatoes, red, ripe, raw (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'black_pepper',
    name: 'Black Pepper',
    aliases: ['ground black pepper', 'black pepper, ground', 'freshly ground black pepper', 'peppercorns'],
    nutritionPer100g: { calories: 251, protein: 10.4, carbohydrates: 63.9, fat: 3.3, fiber: 26.5, sodium: 20 },
    densityGPerMl: 0.45,
    densityConfidence: 'low',
    densityNote: '≈0.45 g/mL for ground pepper (≈2.3 g per teaspoon); grind coarseness varies — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Spices, pepper, black (USDA FDC reference family); representative per-100g.',
  },
  {
    id: 'chili_powder',
    name: 'Chili Powder',
    aliases: ['chili powder, mild', 'mexican chili powder', 'chile powder'],
    nutritionPer100g: { calories: 282, protein: 13.5, carbohydrates: 51.5, fat: 14.3, fiber: 34.8, sodium: 1640 },
    densityGPerMl: 0.45,
    densityConfidence: 'low',
    densityNote: '≈0.45 g/mL for blended chili powder (packing varies) — LOW confidence.',
    source: 'curated_local',
    sourceNote: 'Spices, chili powder (USDA FDC reference family); representative per-100g.',
  },
]);

/**
 * Conservative normalization for food matching ONLY.
 *
 * Allowed: lowercase, trim, whitespace collapse, trailing-punctuation strip,
 * and a light Obsidian-wikilink strip ([[Target|Alias]] -> Alias, [[T]] -> T).
 * NO fuzzy matching, NO substring matching, NO stemming. Matching is exact
 * against a curated key index, so distinct foods cannot bleed into each other.
 */
export function normalizeFoodText(value: string): string {
  return String(value)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/g, '')
    .trim();
}

/** Builds an exact-match index from every curated key (id, name, aliases). */
const FOOD_INDEX: Map<string, FoodReferenceEntry> = (() => {
  const map = new Map<string, FoodReferenceEntry>();
  for (const entry of FOOD_REFERENCES) {
    const keys = new Set<string>([entry.id, entry.name, ...entry.aliases]);
    for (const key of keys) {
      const normalized = normalizeFoodText(key);
      if (normalized && !map.has(normalized)) {
        map.set(normalized, entry);
      }
    }
  }
  return map;
})();

/** Deterministically resolves a food reference by exact normalized match, or undefined. */
export function findFoodReference(
  ingredientName: string | null | undefined
): FoodReferenceEntry | undefined {
  if (!ingredientName) return undefined;
  const key = normalizeFoodText(ingredientName);
  if (!key) return undefined;
  return FOOD_INDEX.get(key);
}

/** Returns the food's curated density (approximation) or undefined. */
export function getFoodDensity(
  entry: FoodReferenceEntry | undefined | null
): FoodDensity | undefined {
  if (!entry || typeof entry.densityGPerMl !== 'number') return undefined;
  return {
    gramsPerMl: entry.densityGPerMl,
    confidence: entry.densityConfidence ?? 'unknown',
    note: entry.densityNote,
  };
}

/** Returns a food's representing count weight, or undefined. */
export function getFoodCountWeight(
  entry: FoodReferenceEntry | undefined | null,
  countUnit?: string | null
): FoodCountWeight | undefined {
  if (!entry?.countWeights) return undefined;
  let key: string | undefined;
  if (countUnit) {
    key = Object.keys(entry.countWeights).find((k) => k.toLowerCase() === countUnit.toLowerCase());
  }
  // Fall back to the single curated count unit per food (avoid ambiguity).
  if (!key) {
    const keys = Object.keys(entry.countWeights);
    key = keys.length === 1 ? keys[0] : undefined;
  }
  if (!key) return undefined;
  const gramsPerItem = entry.countWeights[key];
  if (typeof gramsPerItem !== 'number') return undefined;
  return {
    gramsPerItem,
    countUnit: key,
    confidence: entry.countWeightConfidence ?? 'unknown',
    note: entry.countWeightNote,
  };
}

/** Returns a food's curated per-100g nutrition, or undefined. */
export function getFoodNutritionPer100g(
  entry: FoodReferenceEntry | undefined | null
): FoodNutritionPer100g | undefined {
  return entry?.nutritionPer100g;
}

/** Why a gram value exists (distinguishes physical conversion from approximation). */
export type FoodMassResolutionReason = 'direct_mass' | 'density' | 'count_weight' | 'unknown';

/** Result of resolving a normalized measurement into grams. */
export interface FoodMassResolution {
  grams: number | undefined;
  reason: FoodMassResolutionReason;
  confidence: MeasurementConfidence;
  note?: string;
}

function unresolvedFoodMass(): FoodMassResolution {
  return { grams: undefined, reason: 'unknown', confidence: 'unknown' };
}

/**
 * Resolves a normalized measurement to grams for a specific food.
 *
 *   - mass   : uses Step 2's deterministic grams directly (physical conversion).
 *   - volume : ml × density, ONLY when the food entry curates a density.
 *   - count  : amount × count weight, ONLY when the food curates a count weight.
 *   - unknown: stays unresolved. Unknown amount never becomes 1. Unknown food
 *              never receives a generic density / count weight.
 *
 * Confidence differs by reason on purpose: an exact unit conversion (direct_mass)
 * is NOT conflated with an average chicken-breast weight (count_weight) — the
 * latter preserves its approximation confidence/note for Step 4.
 */
export function resolveFoodMass(
  measurement: NormalizedMeasurement | undefined | null,
  food: FoodReferenceEntry | undefined | null
): FoodMassResolution {
  if (!measurement || !food) return unresolvedFoodMass();

  const amount = measurement.amount;
  // Reject any non-finite OR negative amount. Zero is a legitimate degenerate
  // input and stays resolvable; negative quantities are invalid and must not
  // enter nutrition math (we do NOT clamp negatives to zero — that would hide
  // invalid input). Resolution returns the standard unresolved result.
  if (
    amount === null ||
    amount === undefined ||
    !Number.isFinite(amount) ||
    amount < 0
  ) {
    return unresolvedFoodMass();
  }

  switch (measurement.kind) {
    case 'mass': {
      if (measurement.grams !== undefined) {
        return { grams: measurement.grams, reason: 'direct_mass', confidence: 'high' };
      }
      return unresolvedFoodMass();
    }
    case 'volume': {
      const milliliters = measurement.milliliters;
      if (milliliters === undefined) return unresolvedFoodMass();
      const density = getFoodDensity(food);
      if (!density) {
        return { grams: undefined, reason: 'unknown', confidence: 'unknown', note: 'No curated density for this food.' };
      }
      return {
        grams: milliliters * density.gramsPerMl,
        reason: 'density',
        confidence: density.confidence,
        note: density.note,
      };
    }
    case 'count': {
      const countWeight = getFoodCountWeight(food, measurement.rawUnit);
      if (!countWeight) {
        return { grams: undefined, reason: 'unknown', confidence: 'unknown', note: 'No curated count weight for this food.' };
      }
      return {
        grams: amount * countWeight.gramsPerItem,
        reason: 'count_weight',
        confidence: countWeight.confidence,
        note: countWeight.note,
      };
    }
    default:
      return unresolvedFoodMass();
  }
}
