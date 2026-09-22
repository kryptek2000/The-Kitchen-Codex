/**
 * The Kitchen Codex — Advanced Nutrition Phase 0A: real-ingredient identity
 * safety corpus.
 *
 * A bounded, deterministic diagnostic corpus of ordinary recipe ingredients
 * (based on the Phase 0 reconnaissance corpus). It exists to MEASURE identity
 * safety and to prevent regressions; it is not an approval of the current
 * baseline. Lines with a known identity/amount limitation are marked
 * `knownIssue` and only assert that no NEW automatic identity appears.
 *
 * Expectations:
 *   - `expectedAutoFdc`   the automatic identity the pipeline must bind;
 *   - `baselineAutoFdc`   a known-issue line: automatic identity may stay the
 *                         same or disappear, but must never become a different
 *                         food;
 *   - `forbiddenAutoFdcs` / `forbiddenAutoDescription`  automatic binds that are
 *                         never allowed for this line;
 *   - `expectNoAutomatic` no automatic identity may be bound;
 *   - `expectCandidateDescription` at least one visible candidate must match;
 *   - `expectQualitative` the live row must remain qualitative;
 *   - `expectTopFdc`      candidate ORDER must remain unchanged for lines this
 *                         slice must not touch.
 */

export interface IdentityCorpusLine {
  readonly line: string;
  readonly category: string;
  readonly expectedAutoFdc?: number;
  readonly baselineAutoFdc?: number;
  readonly knownIssue?: string;
  readonly forbiddenAutoFdcs?: ReadonlyArray<number>;
  readonly forbiddenAutoDescription?: RegExp;
  readonly expectNoAutomatic?: boolean;
  readonly expectCandidateDescription?: RegExp;
  readonly expectQualitative?: boolean;
  readonly expectTopFdc?: number;
}

export const IDENTITY_SAFETY_CORPUS: ReadonlyArray<IdentityCorpusLine> = [
  // meats by weight / ground
  { line: '1.5 lb ground beef', category: 'meat', expectedAutoFdc: 2705854 },
  { line: '1 lb ground beef (80/20)', category: 'meat', expectedAutoFdc: 174036 },
  { line: '2 chicken breasts', category: 'meat', expectedAutoFdc: 2646170 },
  { line: '1 lb pork shoulder', category: 'meat', expectedAutoFdc: 167845 },
  // rice
  { line: '2 cups cooked long-grain rice (cooled)', category: 'rice', expectedAutoFdc: 168878 },
  { line: '1 cup dry white rice', category: 'rice', expectedAutoFdc: 169707 },
  // pasta
  { line: '8 oz spaghetti', category: 'pasta', knownIssue: 'variant-ranking', expectTopFdc: 168911 },
  { line: '2 cups penne pasta', category: 'pasta', knownIssue: 'no-penne-record' },
  // eggs
  { line: '3 large eggs', category: 'eggs', expectedAutoFdc: 2707152 },
  { line: '1 egg', category: 'eggs', expectedAutoFdc: 2707152 },
  // garlic (both word orders)
  { line: '3 cloves garlic, minced', category: 'garlic', expectedAutoFdc: 169230 },
  { line: '2 garlic cloves, minced', category: 'garlic', expectedAutoFdc: 169230 },
  // onions
  { line: '1 yellow onion, diced', category: 'onion', expectedAutoFdc: 790646 },
  { line: '1 medium onion', category: 'onion', expectedAutoFdc: 170000 },
  { line: '2 green onions, sliced', category: 'onion', expectedAutoFdc: 2709794 },
  // cabbage
  { line: '1 medium head green cabbage', category: 'cabbage', expectedAutoFdc: 2346407 },
  // bacon
  {
    line: '4 slices bacon',
    category: 'bacon',
    expectedAutoFdc: 168277,
    forbiddenAutoDescription: /grits|cereal/i,
  },
  {
    line: '8 slices bacon',
    category: 'bacon',
    expectedAutoFdc: 168277,
    forbiddenAutoDescription: /grits|cereal/i,
  },
  // tomatoes / sauce / canned
  { line: '2 medium tomatoes, sliced', category: 'tomato', expectedAutoFdc: 2709719 },
  {
    line: '3 cans tomato sauce',
    category: 'tomato-sauce',
    knownIssue: 'sauce-variant-ambiguity',
    forbiddenAutoDescription: /sardine|fish|eggplant/i,
  },
  {
    line: '1 (15 oz) can tomato sauce',
    category: 'tomato-sauce',
    knownIssue: 'package-net-mass-discarded',
    forbiddenAutoDescription: /sardine|fish|eggplant/i,
  },
  {
    line: '1 can diced tomatoes',
    category: 'canned-tomatoes',
    baselineAutoFdc: 2709719,
    knownIssue: 'canned-state-drift',
  },
  {
    line: '1 can black beans',
    category: 'canned-beans',
    baselineAutoFdc: 2707359,
    knownIssue: 'nfs-variant',
  },
  {
    line: '1 can tuna',
    category: 'tuna',
    baselineAutoFdc: 2706309,
    knownIssue: 'nfs-variant',
  },
  {
    line: '1 jar marinara sauce',
    category: 'marinara',
    knownIssue: 'container-unit',
    expectCandidateDescription: /marinara/i,
  },
  // carrots / celery
  { line: '2 carrots, sliced', category: 'carrots', expectedAutoFdc: 170393 },
  { line: '3 large carrots', category: 'carrots', expectedAutoFdc: 170393 },
  { line: '2 celery stalks, chopped', category: 'celery', expectedAutoFdc: 169988 },
  { line: '2 stalks celery', category: 'celery', expectedAutoFdc: 169988 },
  // potatoes
  {
    line: '2 medium potatoes',
    category: 'potatoes',
    baselineAutoFdc: 2709382,
    knownIssue: 'nfs-variant',
  },
  { line: '1 large russet potato', category: 'potatoes', expectedAutoFdc: 2346401 },
  // peppers
  { line: '1 red bell pepper', category: 'peppers', expectedAutoFdc: 2258590 },
  { line: '1 jalapeno', category: 'peppers', expectedAutoFdc: 2710096 },
  // herbs
  { line: '2 tbsp fresh parsley, chopped', category: 'herbs-fresh', expectedAutoFdc: 170416 },
  { line: '1 bunch parsley', category: 'herbs-fresh', expectedAutoFdc: 170416 },
  { line: '2 sprigs fresh thyme', category: 'herbs-fresh', expectedAutoFdc: 173470 },
  { line: '1 tsp dried thyme', category: 'herbs-dried', expectedAutoFdc: 170938 },
  // butter / bread
  { line: '1 stick unsalted butter', category: 'butter', expectedAutoFdc: 789828 },
  { line: '2 tbsp unsalted butter', category: 'butter', expectedAutoFdc: 789828 },
  { line: '4 slices bread', category: 'bread', expectedAutoFdc: 172686 },
  { line: '2 slices white bread', category: 'bread', expectedAutoFdc: 2707598 },
  // citrus
  { line: '1 lemon', category: 'citrus', expectedAutoFdc: 2709168 },
  { line: '2 tbsp lemon juice', category: 'citrus', expectedAutoFdc: 167747 },
  // liquids
  { line: '1/2 cup water', category: 'liquids', expectedAutoFdc: 2710706 },
  { line: '1 cup milk', category: 'liquids', expectedAutoFdc: 2705384 },
  { line: '2 tbsp olive oil', category: 'liquids', expectedAutoFdc: 2710186 },
  // qualitative / seasoning
  { line: 'salt to taste', category: 'seasoning', expectQualitative: true },
  { line: 'freshly ground black pepper', category: 'seasoning', expectedAutoFdc: 170931 },
  { line: 'fresh dill for garnish', category: 'seasoning', knownIssue: 'qualitative-cue', expectTopFdc: 170925 },
  // ranges / optional
  {
    line: '1/4-1/2 tsp chili flakes (optional)',
    category: 'range',
    knownIssue: 'range-parse',
  },
  { line: '1-2 tbsp olive oil', category: 'range', expectedAutoFdc: 2710186 },
  { line: '1/4 cup chopped cilantro (optional)', category: 'optional', expectedAutoFdc: 2709782 },
  // package
  { line: '1 package cream cheese', category: 'package', expectedAutoFdc: 173418 },
  { line: '1 (8 oz) package cream cheese', category: 'package', expectedAutoFdc: 173418 },
  // misc real recipe
  { line: '1 tbsp Worcestershire sauce', category: 'misc', expectedAutoFdc: 2707447 },
];

/**
 * The confirmed class/primary-head defect plus the mandatory legitimate cases
 * that the Phase 0A guard must preserve.
 */
export const IDENTITY_SAFETY_REGRESSION_LINES: ReadonlyArray<IdentityCorpusLine> = [
  {
    line: 'canned tomato sauce',
    category: 'safety-secondary',
    expectNoAutomatic: true,
    forbiddenAutoDescription: /sardine|fish|spaghetti|eggplant/i,
    expectCandidateDescription: /tomato/i,
  },
  {
    line: 'tomato sauce',
    category: 'safety-secondary',
    forbiddenAutoDescription: /sardine|fish/i,
    expectCandidateDescription: /tomato/i,
  },
  {
    line: 'sardines in tomato sauce',
    category: 'safety-primary',
    forbiddenAutoDescription: /^tomato/i,
    expectCandidateDescription: /sardine|fish/i,
  },
  {
    line: 'canned sardines in tomato sauce',
    category: 'safety-primary',
    expectedAutoFdc: 175140,
  },
  {
    line: 'bacon flavor',
    category: 'safety-flavor',
    forbiddenAutoFdcs: [168277],
    forbiddenAutoDescription: /^pork, cured, bacon/i,
  },
  {
    line: 'bacon-flavored cereal',
    category: 'safety-flavor',
    forbiddenAutoFdcs: [168277],
    forbiddenAutoDescription: /^pork/i,
  },
  {
    line: 'pasta with tomato sauce',
    category: 'safety-primary',
    forbiddenAutoDescription: /sardine|fish/i,
    expectCandidateDescription: /pasta/i,
  },
  {
    line: 'tomato sauce with basil',
    category: 'safety-primary',
    knownIssue: 'candidate-gap',
  },
];

export const IDENTITY_SAFETY_LINES: ReadonlyArray<IdentityCorpusLine> = [
  ...IDENTITY_SAFETY_CORPUS,
  ...IDENTITY_SAFETY_REGRESSION_LINES,
];
