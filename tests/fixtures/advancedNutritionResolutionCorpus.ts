/**
 * The Kitchen Codex — Advanced Nutrition resolution-coverage corpus.
 *
 * A deterministic, checked-in benchmark corpus of representative real-recipe
 * ingredient lines spanning the measurement/identity classes that matter to
 * resolution coverage. It reuses the existing real-ingredient identity corpus
 * (`IDENTITY_SAFETY_CORPUS`) and extends it with class-focused lines for mass
 * ranges, secondary/parenthetical mass, volume, count/household, semantic
 * adversarial pairs, alternatives, and qualitative amounts.
 *
 * It is a MEASUREMENT fixture, not an approval of any baseline: the benchmark
 * reports the terminal state and failure reason for every line so that systemic
 * changes can be compared before/after.
 */

import { IDENTITY_SAFETY_CORPUS } from './advancedNutritionIdentityCorpus';

export type ResolutionFocus =
  | 'mass'
  | 'range'
  | 'secondary_mass'
  | 'volume'
  | 'count_household'
  | 'semantic'
  | 'alternative'
  | 'qualitative'
  | 'nutrient_annotation'
  | 'identity_safety';

export interface ResolutionCorpusLine {
  readonly line: string;
  readonly category: string;
  readonly focus: ResolutionFocus;
}

const CLASS_LINES: ReadonlyArray<ResolutionCorpusLine> = [
  // --- Explicit mass -------------------------------------------------------
  { line: '1.5 lb ground beef', category: 'mass', focus: 'mass' },
  { line: '1 lb pork shoulder', category: 'mass', focus: 'mass' },
  { line: '8 oz spaghetti', category: 'mass', focus: 'mass' },
  { line: '100 g tomatoes', category: 'mass', focus: 'mass' },
  { line: '2 cups cooked long-grain rice (cooled)', category: 'volume', focus: 'volume' },

  // --- Mass ranges ---------------------------------------------------------
  { line: '3-4 lb beef chuck roast, cut into 2"-3" chunks', category: 'range', focus: 'range' },
  { line: '3 to 4 lb beef chuck roast', category: 'range', focus: 'range' },
  { line: '75-100 g tomatoes', category: 'range', focus: 'range' },
  { line: '75 to 100 grams tomatoes', category: 'range', focus: 'range' },
  { line: '1/2-1 lb ground beef', category: 'range', focus: 'range' },
  { line: '1-2 tbsp olive oil', category: 'range', focus: 'range' },
  { line: '1/4-1/2 tsp chili flakes (optional)', category: 'range', focus: 'range' },
  { line: '2-3 tomatoes', category: 'range', focus: 'range' },

  // --- Secondary / parenthetical explicit mass -----------------------------
  { line: '3 to 4 slices provolone (about 75 to 100 grams in total)', category: 'secondary-mass', focus: 'secondary_mass' },
  { line: '2 slices bacon (about 20 g)', category: 'secondary-mass', focus: 'secondary_mass' },
  { line: '1 can (400 g) diced tomatoes', category: 'secondary-mass', focus: 'secondary_mass' },
  { line: '1 (15 oz) can tomato sauce', category: 'secondary-mass', focus: 'secondary_mass' },

  // --- Volume --------------------------------------------------------------
  { line: '4 tbsp unsalted butter', category: 'volume', focus: 'volume' },
  { line: '2 tbsp unsalted butter', category: 'volume', focus: 'volume' },
  { line: '2 cup heavy cream', category: 'volume', focus: 'volume' },
  { line: '1/4 cup apple cider vinegar', category: 'volume', focus: 'volume' },
  { line: '2 tbsp paprika', category: 'volume', focus: 'volume' },
  { line: '1 cup milk', category: 'volume', focus: 'volume' },
  { line: '2 tbsp olive oil', category: 'volume', focus: 'volume' },
  { line: '1/2 cup water', category: 'volume', focus: 'volume' },
  { line: '1/2 cup chopped cilantro (optional)', category: 'volume', focus: 'volume' },
  { line: '1 tsp vanilla extract', category: 'volume', focus: 'volume' },
  { line: '1/4 cup honey', category: 'volume', focus: 'volume' },
  { line: '1 cup all-purpose flour', category: 'volume', focus: 'volume' },
  { line: '2 tbsp lemon juice', category: 'volume', focus: 'volume' },
  { line: '1 tbsp Worcestershire sauce', category: 'volume', focus: 'volume' },
  { line: '3 cans tomato sauce', category: 'volume', focus: 'volume' },
  { line: '1 can diced tomatoes', category: 'volume', focus: 'volume' },

  // --- Count / household ---------------------------------------------------
  { line: '3 cloves garlic, minced', category: 'count', focus: 'count_household' },
  { line: '2 garlic cloves, minced', category: 'count', focus: 'count_household' },
  { line: '1 head garlic', category: 'count', focus: 'count_household' },
  { line: '1 large white onion', category: 'count', focus: 'count_household' },
  { line: '1 medium onion', category: 'count', focus: 'count_household' },
  { line: '1 yellow onion, diced', category: 'count', focus: 'count_household' },
  { line: '2 shallots', category: 'count', focus: 'count_household' },
  { line: '24 pieces fresh shucked oysters', category: 'count', focus: 'count_household' },
  { line: '6 slices mortadella', category: 'count', focus: 'count_household' },
  { line: '4 pickles, sliced', category: 'count', focus: 'count_household' },
  { line: '4 slices bacon', category: 'count', focus: 'count_household' },
  { line: '8 slices bacon', category: 'count', focus: 'count_household' },
  { line: '4 slices bread', category: 'count', focus: 'count_household' },
  { line: '2 slices white bread', category: 'count', focus: 'count_household' },
  { line: '3 large eggs', category: 'count', focus: 'count_household' },
  { line: '1 egg', category: 'count', focus: 'count_household' },
  { line: '1 medium head green cabbage', category: 'count', focus: 'count_household' },
  { line: '1 stick unsalted butter', category: 'count', focus: 'count_household' },
  { line: '2 carrots, sliced', category: 'count', focus: 'count_household' },
  { line: '3 large carrots', category: 'count', focus: 'count_household' },
  { line: '2 celery stalks, chopped', category: 'count', focus: 'count_household' },
  { line: '2 stalks celery', category: 'count', focus: 'count_household' },
  { line: '1 bunch parsley', category: 'count', focus: 'count_household' },
  { line: '2 sprigs fresh thyme', category: 'count', focus: 'count_household' },
  { line: '1 lemon', category: 'count', focus: 'count_household' },
  { line: '2 medium tomatoes, sliced', category: 'count', focus: 'count_household' },
  { line: '2 chicken breasts', category: 'count', focus: 'count_household' },
  { line: '1 large russet potato', category: 'count', focus: 'count_household' },
  { line: '1 medium head cauliflower', category: 'count', focus: 'count_household' },

  // --- Semantic adversarial ------------------------------------------------
  { line: '1/4 teaspoon crushed red pepper flakes', category: 'semantic', focus: 'semantic' },
  { line: '1 red bell pepper', category: 'semantic', focus: 'semantic' },
  { line: '1 tsp dried thyme', category: 'semantic', focus: 'semantic' },
  { line: '2 tbsp fresh parsley, chopped', category: 'semantic', focus: 'semantic' },
  { line: '2 tsp garlic powder', category: 'semantic', focus: 'semantic' },
  { line: '1 can tuna', category: 'semantic', focus: 'semantic' },
  { line: '1 can black beans', category: 'semantic', focus: 'semantic' },
  { line: '1 jar marinara sauce', category: 'semantic', focus: 'semantic' },
  { line: '1 package cream cheese', category: 'semantic', focus: 'semantic' },
  { line: '1 (8 oz) package cream cheese', category: 'semantic', focus: 'semantic' },
  { line: 'sardines in tomato sauce', category: 'semantic', focus: 'semantic' },
  { line: 'bacon flavor', category: 'semantic', focus: 'semantic' },

  // --- Alternatives --------------------------------------------------------
  { line: '2 tsp whole cloves or 1/2 tbsp ground clove', category: 'alternative', focus: 'alternative' },
  { line: '1 cup all-purpose or bread flour', category: 'alternative', focus: 'alternative' },
  { line: '2 tbsp butter or margarine', category: 'alternative', focus: 'alternative' },

  // --- Qualitative / vague amounts -----------------------------------------
  { line: 'pinch dried basil', category: 'qualitative', focus: 'qualitative' },
  { line: 'pinch dried oregano', category: 'qualitative', focus: 'qualitative' },
  { line: 'salt to taste', category: 'qualitative', focus: 'qualitative' },
  { line: 'freshly ground black pepper', category: 'qualitative', focus: 'qualitative' },
  { line: 'fresh dill for garnish', category: 'qualitative', focus: 'qualitative' },
  { line: 'handful fresh spinach', category: 'qualitative', focus: 'qualitative' },
  { line: 'drizzle of olive oil', category: 'qualitative', focus: 'qualitative' },

  // --- Nutrient annotations (adversarial: must NEVER become ingredient mass) ---
  { line: '1 cup flour (20 g protein)', category: 'nutrient-annotation', focus: 'nutrient_annotation' },
  { line: '2 tbsp peanut butter (8 g protein per serving)', category: 'nutrient-annotation', focus: 'nutrient_annotation' },
  { line: '1 cup milk (about 30 g fat)', category: 'nutrient-annotation', focus: 'nutrient_annotation' },
  { line: '1 cup yogurt (12 g carbs)', category: 'nutrient-annotation', focus: 'nutrient_annotation' },
  { line: '1 serving cereal (5 g fiber)', category: 'nutrient-annotation', focus: 'nutrient_annotation' },
  { line: '1 bar (200 calories, 10 g protein)', category: 'nutrient-annotation', focus: 'nutrient_annotation' },
];

export const RESOLUTION_COVERAGE_CORPUS: ReadonlyArray<ResolutionCorpusLine> = Object.freeze([
  ...CLASS_LINES,
  ...IDENTITY_SAFETY_CORPUS.map((entry) => ({
    line: entry.line,
    category: `identity:${entry.category}`,
    focus: 'identity_safety' as const,
  })),
]);
