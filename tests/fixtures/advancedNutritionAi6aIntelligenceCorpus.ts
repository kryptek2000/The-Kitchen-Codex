/**
 * The Kitchen Codex — Advanced Nutrition AI-6A intelligence reconnaissance corpus.
 *
 * AI-6A is RECONNAISSANCE + MEASUREMENT ONLY. This fixture is the union of
 * three populations, kept deliberately separate so a denominator can never be
 * quietly redefined:
 *
 *   1. `historical`  the load-bearing 97-line canonical resolution benchmark
 *                    (`RESOLUTION_COVERAGE_CORPUS`, de-duplicated). Untouched.
 *   2. `semantic`    AI-1 semantic-acceptance lines not already in (1).
 *   3. `supplemental` new AI-6A real-recipe reconnaissance lines.
 *
 * It does NOT replace or bloat the historical benchmark. That benchmark stays
 * exactly as it is and keeps reporting the same terminal outcomes, because
 * AI-6A changes no behavior.
 *
 * Identity expectations are NOT re-authored here. They are joined from
 * `IDENTITY_SAFETY_CORPUS` so the recon can classify `verified_correct` /
 * `verified_unsafe` only from knowledge that is already checked in. New
 * supplemental lines therefore carry NO invented FDC truth: a supplemental
 * line with no expectation is honestly `unverified` unless the engine binds a
 * description the corpus explicitly forbids.
 *
 * No line is added to inflate the denominator, and no duplicate authored text
 * is admitted (the corpus test proves uniqueness).
 */

import {
  IDENTITY_SAFETY_CORPUS,
  IDENTITY_SAFETY_REGRESSION_LINES,
  type IdentityCorpusLine,
} from './advancedNutritionIdentityCorpus';
import { RESOLUTION_COVERAGE_CORPUS } from './advancedNutritionResolutionCorpus';
import { AI_ADVANCED_SEMANTIC_CORPUS } from './aiAdvancedSemanticCorpus';
import type { Ai6aCoverageFamily, Ai6aCorpusSource } from '../../scripts/nutritionIntelligence/taxonomy';
import { LEGACY_EXCLUDED_LINES } from '../../scripts/nutritionIntelligence/taxonomy';

/** A single recon corpus line: authored text plus its coverage declarations. */
export interface Ai6aCorpusLine {
  /** Verbatim authored ingredient text. Unique across the corpus. */
  readonly line: string;
  /** Which population this line came from. */
  readonly source: Ai6aCorpusSource;
  /** The originating corpus's own focus/category label, preserved for audit. */
  readonly focus: string;
  /** Coverage families this line materially exercises (>= 1). */
  readonly families: ReadonlyArray<Ai6aCoverageFamily>;
  /** Checked-in identity knowledge, joined from the identity-safety corpus. */
  readonly identity: IdentityCorpusLine | undefined;
}

// ---------------------------------------------------------------------------
// 1. HISTORICAL (97) — coverage-family declarations only
// ---------------------------------------------------------------------------

/**
 * Coverage families for the historical 97. Declared here rather than inferred
 * at runtime so the mapping is reviewable and a future corpus edit forces a
 * conscious decision instead of silently changing a family count.
 */
const HISTORICAL_FAMILIES: Readonly<Record<string, ReadonlyArray<Ai6aCoverageFamily>>> =
  Object.freeze({
    // --- Explicit mass -----------------------------------------------------
    '1.5 lb ground beef': ['explicit_mass', 'meat_poultry_seafood', 'chopped_minced_sliced_crushed_ground'],
    '1 lb pork shoulder': ['explicit_mass', 'meat_poultry_seafood'],
    '8 oz spaghetti': ['explicit_mass', 'grains_pasta'],
    '100 g tomatoes': ['explicit_mass', 'produce'],
    '2 cups cooked long-grain rice (cooled)': [
      'explicit_volume',
      'grains_pasta',
      'raw_vs_cooked',
      'state_wording',
    ],
    '1 lb ground beef (80/20)': ['explicit_mass', 'meat_poultry_seafood', 'lean_fat_percentage'],

    // --- Ranges -----------------------------------------------------------
    '3-4 lb beef chuck roast, cut into 2"-3" chunks': [
      'ranges',
      'explicit_mass',
      'meat_poultry_seafood',
      'preparation_wording',
    ],
    '3 to 4 lb beef chuck roast': ['ranges', 'explicit_mass', 'meat_poultry_seafood'],
    '75-100 g tomatoes': ['ranges', 'explicit_mass', 'produce'],
    '75 to 100 grams tomatoes': ['ranges', 'explicit_mass', 'produce'],
    '1/2-1 lb ground beef': [
      'ranges',
      'explicit_mass',
      'meat_poultry_seafood',
      'chopped_minced_sliced_crushed_ground',
    ],
    '1-2 tbsp olive oil': ['ranges', 'explicit_volume', 'sauces_condiments'],
    '1/4-1/2 tsp chili flakes (optional)': ['ranges', 'explicit_volume', 'spices_seasonings'],
    '2-3 tomatoes': ['ranges', 'count', 'produce', 'count_noun_specific'],

    // --- Secondary / parenthetical mass -----------------------------------
    '3 to 4 slices provolone (about 75 to 100 grams in total)': [
      'secondary_parenthetical_mass',
      'ranges',
      'count_noun_specific',
      'cheeses_dairy',
    ],
    '2 slices bacon (about 20 g)': [
      'secondary_parenthetical_mass',
      'count_noun_specific',
      'meat_poultry_seafood',
    ],
    '1 can (400 g) diced tomatoes': [
      'secondary_parenthetical_mass',
      'package_net_mass',
      'container_package',
      'produce',
      'food_form_wording',
    ],
    '1 (15 oz) can tomato sauce': [
      'secondary_parenthetical_mass',
      'package_net_mass',
      'container_package',
      'sauces_condiments',
    ],

    // --- Volume -----------------------------------------------------------
    '4 tbsp unsalted butter': ['explicit_volume', 'salted_vs_unsalted', 'cheeses_dairy'],
    '2 tbsp unsalted butter': ['explicit_volume', 'salted_vs_unsalted', 'cheeses_dairy'],
    '2 cup heavy cream': ['explicit_volume', 'cheeses_dairy'],
    '1/4 cup apple cider vinegar': ['explicit_volume', 'sauces_condiments'],
    '2 tbsp paprika': ['explicit_volume', 'spices_seasonings'],
    '1 cup milk': ['explicit_volume', 'cheeses_dairy'],
    '2 tbsp olive oil': ['explicit_volume', 'sauces_condiments'],
    '1/2 cup water': ['explicit_volume'],
    '1/2 cup chopped cilantro (optional)': [
      'explicit_volume',
      'preparation_wording',
      'chopped_minced_sliced_crushed_ground',
    ],
    '1 tsp vanilla extract': ['explicit_volume', 'spices_seasonings'],
    '1/4 cup honey': ['explicit_volume', 'sauces_condiments'],
    '1 cup all-purpose flour': ['explicit_volume', 'grains_pasta'],
    '2 tbsp lemon juice': ['explicit_volume', 'sauces_condiments'],
    '1 tbsp Worcestershire sauce': ['explicit_volume', 'sauces_condiments', 'branded_commercial'],
    '3 cans tomato sauce': ['explicit_volume', 'container_package', 'sauces_condiments'],
    '1 can diced tomatoes': [
      'explicit_volume',
      'container_package',
      'produce',
      'food_form_wording',
      'canned_drained_packed',
    ],

    // --- Count / household -------------------------------------------------
    '3 cloves garlic, minced': [
      'count',
      'count_noun_specific',
      'produce',
      'chopped_minced_sliced_crushed_ground',
    ],
    '2 garlic cloves, minced': [
      'count',
      'count_noun_specific',
      'produce',
      'chopped_minced_sliced_crushed_ground',
    ],
    '1 head garlic': ['count', 'count_noun_specific', 'produce', 'food_form_wording'],
    '1 large white onion': ['count', 'produce', 'preparation_wording', 'state_wording'],
    '1 medium onion': ['count', 'produce', 'preparation_wording', 'state_wording'],
    '1 yellow onion, diced': [
      'count',
      'produce',
      'food_form_wording',
      'chopped_minced_sliced_crushed_ground',
      'state_wording',
    ],
    '2 shallots': ['count', 'produce', 'count_noun_specific'],
    '24 pieces fresh shucked oysters': [
      'count',
      'count_noun_specific',
      'meat_poultry_seafood',
      'fresh_vs_dried',
    ],
    '6 slices mortadella': [
      'count',
      'count_noun_specific',
      'meat_poultry_seafood',
      'chopped_minced_sliced_crushed_ground',
    ],
    '4 pickles, sliced': [
      'count',
      'count_noun_specific',
      'produce',
      'chopped_minced_sliced_crushed_ground',
      'canned_drained_packed',
    ],
    '4 slices bacon': ['count', 'count_noun_specific', 'meat_poultry_seafood'],
    '8 slices bacon': ['count', 'count_noun_specific', 'meat_poultry_seafood'],
    '4 slices bread': ['count', 'count_noun_specific', 'grains_pasta'],
    '2 slices white bread': ['count', 'count_noun_specific', 'grains_pasta', 'state_wording'],
    '3 large eggs': ['count', 'count_noun_specific', 'meat_poultry_seafood', 'preparation_wording'],
    '1 egg': ['count', 'count_noun_specific', 'meat_poultry_seafood'],
    '1 medium head green cabbage': [
      'count',
      'count_noun_specific',
      'produce',
      'food_form_wording',
      'state_wording',
    ],
    '1 stick unsalted butter': [
      'count',
      'count_noun_specific',
      'salted_vs_unsalted',
      'cheeses_dairy',
    ],
    '2 carrots, sliced': [
      'count',
      'produce',
      'chopped_minced_sliced_crushed_ground',
      'preparation_wording',
    ],
    '3 large carrots': ['count', 'produce', 'preparation_wording'],
    '2 celery stalks, chopped': [
      'count',
      'count_noun_specific',
      'produce',
      'chopped_minced_sliced_crushed_ground',
    ],
    '2 stalks celery': ['count', 'count_noun_specific', 'produce'],
    '1 bunch parsley': [
      'count',
      'count_noun_specific',
      'produce',
      'fresh_vs_dried',
    ],
    '2 sprigs fresh thyme': [
      'count',
      'count_noun_specific',
      'spices_seasonings',
      'fresh_vs_dried',
    ],
    '1 lemon': ['count', 'produce', 'count_noun_specific'],
    '2 medium tomatoes, sliced': [
      'count',
      'produce',
      'chopped_minced_sliced_crushed_ground',
      'preparation_wording',
    ],
    '2 chicken breasts': ['count', 'meat_poultry_seafood', 'count_noun_specific'],
    '1 large russet potato': ['count', 'produce', 'preparation_wording'],
    '1 medium head cauliflower': [
      'count',
      'count_noun_specific',
      'produce',
      'food_form_wording',
    ],

    // --- Semantic adversarial ---------------------------------------------
    '1/4 teaspoon crushed red pepper flakes': [
      'explicit_volume',
      'spices_seasonings',
      'chopped_minced_sliced_crushed_ground',
    ],
    '1 red bell pepper': ['count', 'produce', 'state_wording'],
    '1 tsp dried thyme': ['explicit_volume', 'spices_seasonings', 'fresh_vs_dried'],
    '2 tbsp fresh parsley, chopped': [
      'explicit_volume',
      'produce',
      'fresh_vs_dried',
      'chopped_minced_sliced_crushed_ground',
    ],
    '2 tsp garlic powder': ['explicit_volume', 'spices_seasonings', 'food_form_wording'],
    '1 can tuna': [
      'container_package',
      'meat_poultry_seafood',
      'canned_drained_packed',
    ],
    '1 can black beans': ['container_package', 'produce', 'canned_drained_packed'],
    '1 jar marinara sauce': ['container_package', 'sauces_condiments'],
    '1 package cream cheese': ['container_package', 'cheeses_dairy'],
    '1 (8 oz) package cream cheese': [
      'container_package',
      'package_net_mass',
      'cheeses_dairy',
    ],
    'sardines in tomato sauce': [
      'composite_food_name_traps',
      'meat_poultry_seafood',
      'sauces_condiments',
    ],
    'bacon flavor': [
      'composite_food_name_traps',
      'meat_poultry_seafood',
      'qualitative_amounts',
    ],

    // --- Alternatives ------------------------------------------------------
    '2 tsp whole cloves or 1/2 tbsp ground clove': [
      'alternatives',
      'explicit_volume',
      'spices_seasonings',
      'chopped_minced_sliced_crushed_ground',
    ],
    '1 cup all-purpose or bread flour': ['alternatives', 'explicit_volume', 'grains_pasta'],
    '2 tbsp butter or margarine': ['alternatives', 'explicit_volume', 'cheeses_dairy'],

    // --- Qualitative -------------------------------------------------------
    'pinch dried basil': ['qualitative_amounts', 'spices_seasonings', 'fresh_vs_dried'],
    'pinch dried oregano': ['qualitative_amounts', 'spices_seasonings', 'fresh_vs_dried'],
    'salt to taste': ['qualitative_amounts', 'spices_seasonings'],
    'freshly ground black pepper': [
      'qualitative_amounts',
      'spices_seasonings',
      'chopped_minced_sliced_crushed_ground',
    ],
    'fresh dill for garnish': ['qualitative_amounts', 'produce', 'fresh_vs_dried'],
    'handful fresh spinach': ['qualitative_amounts', 'produce', 'fresh_vs_dried'],
    'drizzle of olive oil': ['qualitative_amounts', 'sauces_condiments'],

    // --- Nutrient annotations (adversarial) --------------------------------
    '1 cup flour (20 g protein)': ['nutrient_annotation', 'explicit_volume', 'grains_pasta'],
    '2 tbsp peanut butter (8 g protein per serving)': [
      'nutrient_annotation',
      'explicit_volume',
    ],
    '1 cup milk (about 30 g fat)': ['nutrient_annotation', 'explicit_volume', 'cheeses_dairy'],
    '1 cup yogurt (12 g carbs)': ['nutrient_annotation', 'explicit_volume', 'cheeses_dairy'],
    '1 serving cereal (5 g fiber)': ['nutrient_annotation', 'grains_pasta', 'composite_food_name_traps'],
    '1 bar (200 calories, 10 g protein)': [
      'nutrient_annotation',
      'count',
      'count_noun_specific',
      'composite_food_name_traps',
    ],

    // --- Remaining identity-safety lines ----------------------------------
    '1 cup dry white rice': ['explicit_volume', 'grains_pasta', 'fresh_vs_dried', 'state_wording'],
    '2 cups penne pasta': ['explicit_volume', 'grains_pasta', 'food_form_wording'],
    '2 green onions, sliced': [
      'count',
      'produce',
      'state_wording',
      'chopped_minced_sliced_crushed_ground',
    ],
    '2 medium potatoes': ['count', 'produce', 'preparation_wording'],
    '1 jalapeno': ['count', 'produce'],
    '1/4 cup chopped cilantro (optional)': [
      'explicit_volume',
      'preparation_wording',
      'chopped_minced_sliced_crushed_ground',
    ],
  });

/** Every checked-in identity expectation, keyed by authored line. */
const IDENTITY_BY_LINE: ReadonlyMap<string, IdentityCorpusLine> = new Map(
  [...IDENTITY_SAFETY_CORPUS, ...IDENTITY_SAFETY_REGRESSION_LINES].map((entry) => [
    entry.line,
    entry,
  ])
);

function historicalCorpus(): ReadonlyArray<Ai6aCorpusLine> {
  const seen = new Set<string>();
  const out: Ai6aCorpusLine[] = [];
  for (const entry of RESOLUTION_COVERAGE_CORPUS) {
    if (seen.has(entry.line)) continue;
    seen.add(entry.line);
    const families = HISTORICAL_FAMILIES[entry.line];
    if (families === undefined) {
      throw new Error(`ai6a_historical_family_unmapped:${entry.line}`);
    }
    out.push({
      line: entry.line,
      source: 'historical',
      focus: entry.focus,
      families,
      identity: IDENTITY_BY_LINE.get(entry.line),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. SEMANTIC (AI-1 lines not already historical)
// ---------------------------------------------------------------------------

function semanticCorpus(
  historicalLines: ReadonlySet<string>
): ReadonlyArray<Ai6aCorpusLine> {
  // The AI-1 corpus deliberately repeats one authored line under several
  // semantic families. Repeating it here would inflate the denominator, so the
  // families are MERGED onto a single line instead.
  const merged = new Map<string, { families: Ai6aCoverageFamily[]; focus: string }>();
  for (const entry of AI_ADVANCED_SEMANTIC_CORPUS) {
    if (historicalLines.has(entry.line)) continue;
    const existing = merged.get(entry.line);
    const families = semanticFamiliesFor(entry.line, entry.family);
    if (existing === undefined) {
      merged.set(entry.line, { families: [...families], focus: entry.family });
      continue;
    }
    for (const family of families) {
      if (!existing.families.includes(family)) existing.families.push(family);
    }
  }
  return [...merged.entries()].map(([line, value]) => ({
    line,
    source: 'semantic' as const,
    focus: value.focus,
    families: value.families,
    identity: IDENTITY_BY_LINE.get(line),
  }));
}

function semanticFamiliesFor(
  line: string,
  family: string
): ReadonlyArray<Ai6aCoverageFamily> {
  const families: Ai6aCoverageFamily[] = [];
  const add = (...values: ReadonlyArray<Ai6aCoverageFamily>): void => {
    for (const value of values) if (!families.includes(value)) families.push(value);
  };
  if (/clove|garlic/i.test(line)) add('count', 'count_noun_specific', 'produce');
  if (/stick|butter/i.test(line)) add('count', 'count_noun_specific', 'cheeses_dairy');
  if (/butter|oil|milk|cream|vinegar|water/i.test(line)) add('explicit_volume');
  if (/lb |g |grams|oz/i.test(line)) add('explicit_mass');
  if (/-\d|\d-\d| to \d/i.test(line)) add('ranges');
  if (/roast|provolone|oyster|mortadella/i.test(line)) add('meat_poultry_seafood', 'cheeses_dairy');
  if (/parsley|basil|dill|pickle|shallot|onion|thyme/i.test(line)) add('produce');
  if (/handful|pinch|to taste|as needed|garnish/i.test(line)) add('qualitative_amounts');
  if (/salted|unsalted/i.test(line)) add('salted_vs_unsalted');
  if (/skim|whole milk/i.test(line)) add('skim_lowfat_whole', 'cheeses_dairy');
  if (/jar|can|package|packet|bottle/i.test(line)) add('container_package');
  if (/chopped|sliced|minced|crushed|ground|diced|shucked/i.test(line))
    add('preparation_wording', 'chopped_minced_sliced_crushed_ground');
  if (/dried|fresh/i.test(line)) add('fresh_vs_dried');
  if (/canned|cooked|raw|drained/i.test(line)) add('raw_vs_cooked', 'state_wording');
  if (/ or /.test(line)) add('alternatives');
  if (/sauce|syrup|oil|butter|milk|mayonnaise|ketchup/i.test(line)) add('sauces_condiments');
  if (/pepper|thyme|basil|salt|dill/i.test(line)) add('spices_seasonings');
  if (/soup|sauce with|pasta with|flavor|cereal|bar\b/i.test(line))
    add('composite_food_name_traps');
  if (/brand|lipton|knorr|mcdonald|heinz|best foods/i.test(line)) add('branded_commercial');
  if (families.length === 0) add('composite_food_name_traps');
  void family;
  return families;
}

// ---------------------------------------------------------------------------
// 3. SUPPLEMENTAL (AI-6A real-recipe reconnaissance)
// ---------------------------------------------------------------------------

interface SupplementalSpec {
  readonly line: string;
  readonly focus: string;
  readonly families: ReadonlyArray<Ai6aCoverageFamily>;
}

/**
 * New AI-6A real-recipe probes. Each exists because it exercises a coverage
 * family or a product-realality failure we actually care about. Identity
 * expectations are deliberately ABSENT unless they are reused verbatim from the
 * checked-in identity corpus — a supplemental line is `unverified` unless the
 * engine violates knowledge that is already checked in.
 */
const SUPPLEMENTAL_SPECS: ReadonlyArray<SupplementalSpec> = Object.freeze([
  // --- Pickle slices / pickle count ---------------------------------------
  { line: '20 slices dill pickles', focus: 'pickle_slices', families: ['count', 'count_noun_specific', 'produce', 'canned_drained_packed'] },
  { line: '1/2 cup pickle slices', focus: 'pickle_slices', families: ['explicit_volume', 'produce', 'chopped_minced_sliced_crushed_ground', 'canned_drained_packed'] },
  { line: '1 cup sliced pickles', focus: 'pickle_slices', families: ['explicit_volume', 'produce', 'canned_drained_packed'] },
  { line: '4 dill pickle spears', focus: 'pickle_count', families: ['count', 'count_noun_specific', 'produce', 'canned_drained_packed'] },
  { line: '2 cups sliced dill pickles', focus: 'pickle_slices', families: ['explicit_volume', 'produce', 'canned_drained_packed'] },

  // --- Butter by tablespoon / stick / count-like household wording ---------
  { line: '2 tbsp butter', focus: 'butter_volume_unsalted_variant', families: ['explicit_volume', 'cheeses_dairy'] },
  { line: '3 tbsp butter', focus: 'butter_volume_unsalted_variant', families: ['explicit_volume', 'cheeses_dairy'] },
  { line: '1/4 cup butter', focus: 'butter_volume_unsalted_variant', families: ['explicit_volume', 'cheeses_dairy'] },
  { line: '1 stick butter', focus: 'butter_stick_unsalted_variant', families: ['count', 'count_noun_specific', 'cheeses_dairy'] },
  { line: '1/2 stick butter', focus: 'butter_stick_fractional', families: ['count', 'count_noun_specific', 'cheeses_dairy'] },
  { line: '4 tbsp (1/2 stick) butter', focus: 'butter_count_like_household', families: ['container_package', 'package_net_mass', 'secondary_parenthetical_mass', 'cheeses_dairy'] },
  { line: '1 stick salted butter', focus: 'butter_salted_variant', families: ['count', 'count_noun_specific', 'salted_vs_unsalted', 'cheeses_dairy'] },

  // --- Garlic cloves / cloves garlic ---------------------------------------
  { line: '4 cloves garlic', focus: 'garlic_count_word_order', families: ['count', 'count_noun_specific', 'produce'] },
  { line: '1 clove garlic', focus: 'garlic_count_word_order', families: ['count', 'count_noun_specific', 'produce'] },
  { line: '5 cloves of garlic', focus: 'garlic_count_word_order', families: ['count', 'count_noun_specific', 'produce'] },
  { line: '2-3 cloves garlic', focus: 'garlic_count_range', families: ['ranges', 'count', 'count_noun_specific', 'produce'] },

  // --- Onions with size descriptors ----------------------------------------
  { line: '2 large onions', focus: 'onion_size_descriptor', families: ['count', 'produce', 'preparation_wording'] },
  { line: '3 small onions', focus: 'onion_size_descriptor', families: ['count', 'produce', 'preparation_wording'] },
  { line: '1 sweet onion', focus: 'onion_variety', families: ['count', 'produce'] },
  { line: '1 red onion', focus: 'onion_variety', families: ['count', 'produce'] },
  { line: '1 cup finely chopped onion', focus: 'onion_prepared_volume', families: ['explicit_volume', 'produce', 'chopped_minced_sliced_crushed_ground'] },

  // --- Bacon slices --------------------------------------------------------
  { line: '6 slices bacon, chopped', focus: 'bacon_slice_preparation', families: ['count', 'count_noun_specific', 'meat_poultry_seafood', 'chopped_minced_sliced_crushed_ground'] },
  { line: '12 slices thick-cut bacon', focus: 'bacon_slice_preparation', families: ['count', 'count_noun_specific', 'meat_poultry_seafood', 'preparation_wording'] },
  { line: '1/2 cup chopped bacon', focus: 'bacon_prepared_volume', families: ['explicit_volume', 'meat_poultry_seafood', 'chopped_minced_sliced_crushed_ground'] },

  // --- Bread slices --------------------------------------------------------
  { line: '3 slices sourdough bread', focus: 'bread_slice_variety', families: ['count', 'count_noun_specific', 'grains_pasta'] },
  { line: '2 slices whole wheat bread', focus: 'bread_slice_variety', families: ['count', 'count_noun_specific', 'grains_pasta', 'state_wording'] },
  { line: '1 slice bread', focus: 'bread_slice_count', families: ['count', 'count_noun_specific', 'grains_pasta'] },

  // --- Tomato sauce / diced tomato cans ------------------------------------
  { line: '2 cans tomato sauce', focus: 'tomato_sauce_can_count', families: ['count', 'container_package', 'sauces_condiments', 'canned_drained_packed'] },
  { line: '1 28-oz can tomato sauce', focus: 'tomato_sauce_can_net_mass', families: ['container_package', 'package_net_mass', 'sauces_condiments'] },
  { line: '1 can marinara sauce', focus: 'jarred_sauce_can', families: ['container_package', 'sauces_condiments'] },
  { line: '2 jars pasta sauce', focus: 'jarred_sauce', families: ['count', 'container_package', 'sauces_condiments'] },
  { line: '2 jars salsa', focus: 'jarred_condiment', families: ['count', 'container_package', 'sauces_condiments'] },
  { line: '1 cup tomato sauce', focus: 'tomato_sauce_volume', families: ['explicit_volume', 'sauces_condiments'] },

  // --- Jars / packages / packets -------------------------------------------
  { line: '1 package breadcrumbs', focus: 'package_dry_good', families: ['container_package', 'grains_pasta'] },
  { line: '1 packet yeast', focus: 'packet_dry_good', families: ['container_package'] },
  { line: '2 packages cream cheese', focus: 'package_dairy', families: ['count', 'container_package', 'cheeses_dairy'] },
  { line: '1 (16 oz) package cream cheese', focus: 'package_net_mass_dairy', families: ['container_package', 'package_net_mass', 'cheeses_dairy'] },

  // --- Seasoning blends / commercial-branded seasoning ---------------------
  { line: '1 packet ranch seasoning mix', focus: 'seasoning_blend', families: ['container_package', 'spices_seasonings', 'composite_food_name_traps'] },
  { line: '2 tbsp Italian seasoning', focus: 'seasoning_blend', families: ['explicit_volume', 'spices_seasonings', 'composite_food_name_traps'] },
  { line: '1 tbsp Mrs. Dash', focus: 'branded_seasoning', families: ['explicit_volume', 'spices_seasonings', 'branded_commercial', 'composite_food_name_traps'] },
  { line: '2 packets taco seasoning', focus: 'seasoning_blend', families: ['count', 'container_package', 'spices_seasonings', 'composite_food_name_traps'] },
  { line: '1 packet Lipton onion soup mix', focus: 'branded_seasoning', families: ['container_package', 'spices_seasonings', 'branded_commercial', 'composite_food_name_traps'] },
  { line: '1 bottle ketchup', focus: 'commercial_condiment', families: ['container_package', 'sauces_condiments', 'branded_commercial'] },
  { line: '1 bottle soy sauce', focus: 'commercial_condiment', families: ['container_package', 'sauces_condiments', 'branded_commercial'] },

  // --- Cheeses / dairy -----------------------------------------------------
  { line: '1 cup shredded cheddar cheese', focus: 'cheese_prepared_volume', families: ['explicit_volume', 'cheeses_dairy', 'chopped_minced_sliced_crushed_ground'] },
  { line: '200 g mozzarella', focus: 'cheese_explicit_mass', families: ['explicit_mass', 'cheeses_dairy'] },
  { line: '1 cup sour cream', focus: 'dairy_volume', families: ['explicit_volume', 'cheeses_dairy'] },
  { line: '1/2 cup grated Parmesan', focus: 'cheese_prepared_volume', families: ['explicit_volume', 'cheeses_dairy', 'food_form_wording'] },
  { line: '1 cup whole milk', focus: 'dairy_volume', families: ['explicit_volume', 'cheeses_dairy', 'skim_lowfat_whole'] },
  { line: '1 cup low-fat milk', focus: 'dairy_volume', families: ['explicit_volume', 'cheeses_dairy', 'skim_lowfat_whole'] },
  { line: '2 cups frozen peas', focus: 'frozen_produce', families: ['explicit_volume', 'produce', 'state_wording'] },

  // --- Meat / poultry / seafood -------------------------------------------
  { line: '500 g chicken thighs', focus: 'poultry_explicit_mass', families: ['explicit_mass', 'meat_poultry_seafood'] },
  { line: '2 lb salmon fillet', focus: 'seafood_explicit_mass', families: ['explicit_mass', 'meat_poultry_seafood'] },
  { line: '1 lb ground turkey', focus: 'poultry_ground', families: ['explicit_mass', 'meat_poultry_seafood', 'chopped_minced_sliced_crushed_ground'] },
  { line: '8 oz shrimp', focus: 'seafood_explicit_mass', families: ['explicit_mass', 'meat_poultry_seafood'] },
  { line: '1 lb chicken thighs (about 450 g)', focus: 'poultry_secondary_mass', families: ['secondary_parenthetical_mass', 'explicit_mass', 'meat_poultry_seafood'] },
  { line: '1 lb ground beef (90/10)', focus: 'lean_percentage_variant', families: ['explicit_mass', 'meat_poultry_seafood', 'lean_fat_percentage'] },
  { line: '1 can drained tuna', focus: 'canned_drained_seafood', families: ['container_package', 'meat_poultry_seafood', 'canned_drained_packed'] },

  // --- Produce -------------------------------------------------------------
  { line: '1 lb baby spinach', focus: 'produce_explicit_mass', families: ['explicit_mass', 'produce'] },
  { line: '2 cups mushrooms', focus: 'produce_volume', families: ['explicit_volume', 'produce'] },
  { line: '1 bunch celery', focus: 'produce_household_bunch', families: ['count', 'count_noun_specific', 'produce'] },
  { line: '3 stalks celery', focus: 'produce_household_stalk', families: ['count', 'count_noun_specific', 'produce'] },
  { line: '2 sprigs rosemary', focus: 'herb_household_sprig', families: ['count', 'count_noun_specific', 'spices_seasonings'] },
  { line: '1 head cabbage', focus: 'produce_household_head', families: ['count', 'count_noun_specific', 'produce', 'food_form_wording'] },
  { line: '1 cup shredded coconut', focus: 'produce_prepared_volume', families: ['explicit_volume', 'produce', 'chopped_minced_sliced_crushed_ground'] },
  { line: '2 cups crushed pineapple', focus: 'canned_produce_volume', families: ['explicit_volume', 'produce', 'canned_drained_packed', 'chopped_minced_sliced_crushed_ground'] },

  // --- Grains / pasta ------------------------------------------------------
  { line: '1 lb rigatoni', focus: 'pasta_explicit_mass', families: ['explicit_mass', 'grains_pasta'] },
  { line: '2 cups breadcrumbs', focus: 'grain_volume', families: ['explicit_volume', 'grains_pasta'] },
  { line: '1 cup quinoa', focus: 'grain_volume', families: ['explicit_volume', 'grains_pasta'] },
  { line: '1 cup loosely packed brown rice', focus: 'household_packing_descriptor', families: ['explicit_volume', 'grains_pasta', 'household_measures'] },
  { line: '2 cups packed spinach', focus: 'household_packing_descriptor', families: ['explicit_volume', 'produce', 'household_measures'] },

  // --- Household / packing descriptors -------------------------------------
  { line: '2 cups firmly packed breadcrumbs', focus: 'household_packing_descriptor', families: ['explicit_volume', 'grains_pasta', 'household_measures'] },

  // --- Composite food-name traps ------------------------------------------
  { line: 'pasta with tomato sauce', focus: 'composite_food_name', families: ['composite_food_name_traps', 'grains_pasta', 'sauces_condiments'] },
  { line: 'tomato sauce with basil', focus: 'composite_food_name', families: ['composite_food_name_traps', 'sauces_condiments'] },
  { line: 'canned tomato sauce', focus: 'composite_food_name', families: ['composite_food_name_traps', 'sauces_condiments', 'canned_drained_packed'] },
  { line: 'chicken soup', focus: 'composite_food_name', families: ['composite_food_name_traps', 'meat_poultry_seafood'] },
  { line: 'bacon-flavored cereal', focus: 'composite_food_name', families: ['composite_food_name_traps', 'grains_pasta', 'meat_poultry_seafood'] },

  // --- Ranges / counts -----------------------------------------------------
  { line: '1-2 cups chicken stock', focus: 'volume_range', families: ['ranges', 'explicit_volume'] },
  { line: '2-3 tbsp soy sauce', focus: 'volume_range', families: ['ranges', 'explicit_volume', 'sauces_condiments'] },

  // --- Qualitative ---------------------------------------------------------
  { line: 'black pepper to taste', focus: 'qualitative_seasoning', families: ['qualitative_amounts', 'spices_seasonings'] },
  { line: 'to taste', focus: 'qualitative_bare', families: ['qualitative_amounts'] },
  { line: 'as needed', focus: 'qualitative_bare', families: ['qualitative_amounts'] },
  { line: 'for serving', focus: 'qualitative_bare', families: ['qualitative_amounts'] },
  // AI-6A-R1 adversarial pair: `a dash of ...` is a genuine quantity phrase and
  // MUST be qualitative, while the BRAND `Mrs. Dash` (which carries an explicit
  // `1 tbsp`) must NOT be. Both are checked in so the collision cannot return.
  { line: 'a dash of pepper', focus: 'qualitative_dash_quantity_phrase', families: ['qualitative_amounts', 'spices_seasonings'] },

  // --- Whole: food-state wording vs count-descriptor wording ---------------
  // AI-6A-R1: `1 whole chicken` / `2 whole lemons` use `whole` as a COUNT
  // DESCRIPTOR, while `whole milk` / `whole wheat bread` use it as a FOOD FORM.
  // Both halves are checked in so the disambiguation is measured, not asserted.
  { line: '1 whole chicken', focus: 'whole_count_descriptor', families: ['count', 'count_noun_specific', 'meat_poultry_seafood'] },
  { line: '2 whole lemons', focus: 'whole_count_descriptor', families: ['count', 'count_noun_specific', 'produce'] },

  // --- Preparation / state / form -----------------------------------------
  { line: '2 cloves garlic, crushed', focus: 'preparation_form', families: ['count', 'count_noun_specific', 'produce', 'chopped_minced_sliced_crushed_ground'] },
  { line: '1 tbsp grated ginger', focus: 'preparation_form', families: ['explicit_volume', 'produce', 'food_form_wording'] },
  { line: '1 cup canned chickpeas', focus: 'canned_state', families: ['explicit_volume', 'produce', 'canned_drained_packed', 'state_wording'] },
  { line: '1 can packed in oil', focus: 'canned_state', families: ['container_package', 'canned_drained_packed', 'state_wording'] },
  { line: '1 cup cooked rice', focus: 'cooked_state', families: ['explicit_volume', 'grains_pasta', 'raw_vs_cooked', 'state_wording'] },
  { line: '1 cup raw chicken breast', focus: 'raw_state', families: ['explicit_volume', 'meat_poultry_seafood', 'raw_vs_cooked', 'state_wording'] },
]);

function supplementalCorpus(
  taken: Set<string>
): ReadonlyArray<Ai6aCorpusLine> {
  const out: Ai6aCorpusLine[] = [];
  for (const spec of SUPPLEMENTAL_SPECS) {
    if (taken.has(spec.line)) continue;
    taken.add(spec.line);
    out.push({
      line: spec.line,
      source: 'supplemental',
      focus: spec.focus,
      families: spec.families,
      identity: IDENTITY_BY_LINE.get(spec.line),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The frozen union
// ---------------------------------------------------------------------------

function buildCorpus(): ReadonlyArray<Ai6aCorpusLine> {
  const historical = historicalCorpus();
  const taken = new Set(historical.map((entry) => entry.line));
  const semantic = semanticCorpus(taken);
  for (const entry of semantic) taken.add(entry.line);
  const supplemental = supplementalCorpus(taken);
  return Object.freeze([...historical, ...semantic, ...supplemental]);
}

/** Every AI-6A recon line, in deterministic order. */
export const AI6A_INTELLIGENCE_CORPUS: ReadonlyArray<Ai6aCorpusLine> = buildCorpus();

/** The historical 97, isolated so the load-bearing denominator stays auditable. */
export const AI6A_HISTORICAL_SUBSET: ReadonlyArray<Ai6aCorpusLine> = Object.freeze(
  AI6A_INTELLIGENCE_CORPUS.filter((entry) => entry.source === 'historical')
);

/**
 * The legacy 91: the historical 97 minus the six post-Phase-7 annotation lines
 * declared in `LEGACY_EXCLUDED_LINES` (the single authority for that split).
 */
export const AI6A_LEGACY_SUBSET: ReadonlyArray<Ai6aCorpusLine> = Object.freeze(
  AI6A_HISTORICAL_SUBSET.filter((entry) => !LEGACY_EXCLUDED_LINES.has(entry.line))
);