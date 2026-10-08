/**
 * The Kitchen Codex — Phase 8B production-browser acceptance fixture contract.
 *
 * TEST-ONLY. Describes the deterministic acceptance vault used by
 * `scripts/verify_advanced_nutrition_browser_prod.ts` and pinned by
 * `tests/unit/advancedNutritionPhase8bBrowserProofContract.test.ts`.
 *
 * The expected measurements below were MEASURED offline against the pinned
 * USDA bundle (`usda_fdc_87c5408a3e98838944a87be74824761e`, 13559 canonical
 * records) through the real Phase 4 pipeline (parse -> review -> analyze ->
 * calculate -> live projection). They are not tuned: the fixture was chosen for
 * determinism and coverage, and the expectations follow from it.
 *
 * What the fixture is designed to prove at RECIPE level (Phase 8A found zero
 * full-recipe fixtures with expected nutrient totals):
 *   - four DISTINCT deterministic mass-source classes all resolve:
 *     direct_mass, source_portion, count_portion, household_portion;
 *   - a calculation becomes available and nutrient totals exist;
 *   - partial coverage is reported TRUTHFULLY (`status: partial`, an explicit
 *     unresolved list, per-nutrient coverage fractions) rather than as a
 *     complete result;
 *   - unmatched-quantity lines stay actionable so the AI entitlement surface is
 *     observable in a real browser.
 *
 * No personal data, no absolute local path, no token or key, no date
 * dependence, and no random identifiers. The `ingredient_digest` is a pure
 * function of the canonicalized ingredient lines and servings.
 */

import { join, resolve } from 'node:path';

// This module lives at tests/fixtures/, so the sibling vault directory is one
// level up from `tests/`, i.e. tests/fixtures/advancedNutritionBrowserAcceptanceVault.
const FIXTURE_DIR = join(
  resolve(import.meta.dirname, '.'),
  'advancedNutritionBrowserAcceptanceVault'
);

/** File name of the acceptance recipe inside the fixture vault directory. */
export const ACCEPTANCE_RECIPE_FILE = 'Weeknight Beef Rice Bowls.md';

/** Recipe title, which is also the gallery card identity used for selectors. */
export const ACCEPTANCE_RECIPE_TITLE = 'Weeknight Beef Rice Bowls';

/** Absolute path to the fixture vault directory handed to the production UI. */
export const ACCEPTANCE_VAULT_DIR = FIXTURE_DIR;

/** Absolute path to the single acceptance recipe Markdown file. */
export const ACCEPTANCE_RECIPE_PATH = join(FIXTURE_DIR, ACCEPTANCE_RECIPE_FILE);

/**
 * The acceptance recipe's ingredient lines, in file order.
 *
 * index -> expected live row status under the pinned bundle:
 *   0 direct_mass      680.38855 g
 *   1 source_portion   185 g
 *   2 count_portion    110 g
 *   3 household_portion  9 g
 *   4 source_portion    28 g
 *   5 household_portion 113 g
 *   6 matched identity, no mass -> needs_amount
 *   7 matched identity, no mass -> needs_amount
 *   8 matched identity, no mass -> needs_amount
 */
export const ACCEPTANCE_INGREDIENT_LINES: ReadonlyArray<string> = [
  '1.5 lb ground beef',
  '1 cup dry white rice',
  '1 medium onion',
  '3 cloves garlic, minced',
  '2 tbsp olive oil',
  '1 stick unsalted butter',
  '2 lemons',
  'freshly ground black pepper',
  'handful fresh spinach',
];

/** Servings declared in the fixture frontmatter. */
export const ACCEPTANCE_SERVINGS = 4;

/** USDA bundle release the pinned expectations were measured against. */
export const PINNED_BUNDLE_RELEASE = 'usda_fdc_87c5408a3e98838944a87be74824761e';

/** Canonical record count in the pinned bundle. */
export const PINNED_BUNDLE_RECORD_COUNT = 13559;

/** Logical USDA artifact names that the production browser loader must fetch. */
export const PINNED_BUNDLE_ARTIFACT_NAMES: ReadonlyArray<string> = [
  'artifact.json',
  'manifest.json',
  'records.foundation.json.gz',
  'records.sr_legacy.json.gz',
  'records.fndds.json.gz',
];

export interface RecipeLevelExpectations {
  readonly totalIngredientCount: number;
  readonly matchedCount: number;
  readonly needsAmountCount: number;
  readonly needsMatchCount: number;
  readonly reviewSuggestedCount: number;
  readonly qualitativeCount: number;
  readonly actionableCount: number;
  readonly calculationStatus: 'partial';
  readonly basis: 'total';
  readonly nutrientScopeCount: number;
  readonly nutrientsWithTotals: number;
  readonly unresolvedCount: number;
  readonly unresolvedOutcome: 'no_mass';
  readonly advisoryOnly: true;
  readonly applicationAuthorized: false;
}

/**
 * Recipe-level expectations measured offline against the pinned bundle.
 *
 * `nutrientsWithTotals` is 31 of the 34 declared nutrient-scope ids; the
 * remaining ids legitimately carry no total for this ingredient set. Coverage
 * fractions are per-nutrient and truthful (e.g. calories 5/9, fat 6/9).
 */
export const RECIPE_LEVEL_EXPECTATIONS: RecipeLevelExpectations = {
  totalIngredientCount: 9,
  matchedCount: 6,
  needsAmountCount: 3,
  needsMatchCount: 0,
  reviewSuggestedCount: 0,
  qualitativeCount: 0,
  actionableCount: 3,
  calculationStatus: 'partial',
  basis: 'total',
  nutrientScopeCount: 34,
  nutrientsWithTotals: 31,
  unresolvedCount: 3,
  unresolvedOutcome: 'no_mass',
  advisoryOnly: true,
  applicationAuthorized: false,
};

/**
 * Hosts that must never be contacted during the deterministic proof.
 *
 * The deterministic path invokes NO AI action, so any provider call is a proof
 * failure rather than an expected side effect.
 */
export const FORBIDDEN_PROOF_HOSTS: ReadonlyArray<string> = [
  'fdc.nal.usda.gov',
  'api.nal.usda.gov',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.openai.com',
  'world.openfoodfacts.org',
  'upload.wikimedia.org',
];

/** Product tier whose browser run proves the entitled-but-not-ready case. */
export const ENTITLED_TIER = 'ai_advanced';

/** Product tier whose browser run proves the not-entitled negative control. */
export const BASIC_TIER = 'basic';
