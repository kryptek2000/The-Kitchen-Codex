/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5D / post-Phase-5 smoke-test
 * remediation: ingredient-query projection.
 *
 * PURE, closed, versioned, offline. This module is the ONE authority for turning
 * a normalized food-name query into explicit ROLES:
 *
 *   - core identity      : the tokens that name the FOOD itself (what must
 *                          match). Preparation, size, form, and nutritionally
 *                          significant qualifier words are NOT core identity;
 *   - qualifiers         : nutritionally significant state/variant words
 *                          (unsalted, salted, raw, cooked, whole, skim, low,
 *                          reduced, nonfat, sweetened, unsweetened, canned,
 *                          dried, ...) preserved so they keep foods distinct;
 *   - forms              : bounded food-FORM words (powder, flakes, sauce, juice,
 *                          paste, ...) that describe the form, not the food;
 *   - measurement        : the raw measurement token (owned by the canonical
 *                          parser; recorded here for evidence only);
 *   - size qualifiers    : bounded portion/size words (small, medium, large, ...)
 *                          preserved for Phase 4.5E count compatibility;
 *   - preparation        : a closed set of ordinary physical preparation words
 *                          (sliced, shredded, chopped, chilled, ...) that must
 *                          NOT become mandatory food identity;
 *   - notes              : a bounded trailing recipe instruction
 *                          (e.g. `formed into 4 patties`) — non-authoritative;
 *   - numeric qualifiers : bounded numeric qualifiers such as `80 20`;
 *   - aliases            : bounded, directional culinary aliases that fired;
 *   - anchors            : deterministic required matching anchors derived from
 *                          the CORE identity. Each anchor is a GROUP of accepted
 *                          tokens (usually one); a candidate must contain a token
 *                          from every group.
 *
 * It NEVER mutates the source ingredient, never rewrites stored recipes, and
 * never authorizes an automatic match. The anchor rule is deterministic and
 * bounded, and is included in the review digest through the candidate set.
 *
 * POST-PHASE-5 SMOKE-TEST REMEDIATION (v2)
 * ----------------------------------------
 * v1 chose the anchor from the LAST non-stopword identity token, which let
 * preparation/noise prose (`and`, `chilled`, `flakes`, `total`) and form words
 * (`powder`) dominate retrieval. v2 introduces explicit CORE FOOD IDENTITY,
 * strips parenthetical and trailing preparation clauses, and treats a closed set
 * of form/conjunction tokens as non-identity. It also exposes the evidence
 * helpers used by the deterministic ranking and confidence contract.
 */

export const QUERY_PROJECTION_VERSION = 'usda_query_projection_v8';

/** A required anchor: the candidate must contain a token from `accepted`. */
export interface AnchorGroup {
  readonly accepted: ReadonlyArray<string>;
}

export interface IngredientQueryProjection {
  readonly version: string;
  /** Normalized food-identity text (roles removed). */
  readonly food_identity: string;
  /** Bounded identity tokens (order preserved): core + qualifiers + forms. */
  readonly food_tokens: ReadonlyArray<string>;
  /** The FOOD-name tokens only (qualifiers/forms/prep/size removed). */
  readonly core_tokens: ReadonlyArray<string>;
  /** Nutritionally significant state/variant qualifier tokens requested. */
  readonly qualifier_tokens: ReadonlyArray<string>;
  /** Food-FORM tokens requested (powder, flakes, sauce, juice, ...). */
  readonly form_tokens: ReadonlyArray<string>;
  /**
   * Bounded OPTIONAL culinary-refinement tokens (kosher, sea, fine, coarse).
   * Preserved as preference evidence; never required identity.
   */
  readonly refinement_tokens: ReadonlyArray<string>;
  /**
   * OR-alternative branches (`brioche or potato burger buns` ->
   * `[[brioche, burger, bun], [potato, burger, bun]]`). Empty when the query has
   * no OR construction. Each branch is a complete candidate-search intent; the
   * shared head is the required identity, so a generic same-food fallback remains
   * available when no subtype record exists.
   */
  readonly alternative_groups: ReadonlyArray<ReadonlyArray<string>>;
  readonly anchor_groups: ReadonlyArray<AnchorGroup>;
  readonly measurement_tokens: ReadonlyArray<string>;
  readonly size_qualifiers: ReadonlyArray<string>;
  readonly preparation_qualifiers: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly numeric_qualifiers: ReadonlyArray<string>;
  readonly aliases: ReadonlyArray<string>;
}

/**
 * A closed set of ordinary physical preparation terms. These are removed from
 * mandatory food identity. Nutritionally significant qualifiers (raw/cooked,
 * salted/unsalted, whole/skim, ...) are deliberately NOT in this set.
 */
const PREPARATION_QUALIFIERS: ReadonlySet<string> = new Set([
  'sliced',
  'slice',
  'slices',
  'shredded',
  'chopped',
  'diced',
  'minced',
  'grated',
  'peeled',
  'drained',
  'rinsed',
  'halved',
  'quartered',
  'crushed',
  'mashed',
  'beaten',
  'softened',
  'melted',
  'trimmed',
  'stemmed',
  'seeded',
  'cored',
  'julienned',
  'cubed',
  'cubing',
  'crumbled',
  'torn',
  'thawed',
  'defrosted',
  'fresh',
  'patted',
  'chilled',
  'chilling',
  'cold',
  'cooled',
  'warmed',
  'room',
  'temperature',
  'thinly',
  'thin',
  'thickly',
  'thick',
  'finely',
  'roughly',
  'coarsely',
  'lightly',
  'packed',
  'divided',
  'reserved',
  'optional',
  'beaten',
  // Home-recipe procedural / storage prose that must never become food
  // identity (post-smoke-test remediation): `kept cold and divided into four
  // loose 4-ounce balls`, `freshly ground`, `fine sea salt`, `coarse black
  // pepper`, `room temperature`. These are preparation/instruction words, not
  // food names.
  'kept',
  'loose',
  'freshly',
  'room',
  'temperature',
  'softened',
  'chilled',
  'plus',
  'more',
  'for',
  'serving',
  'garnish',
  'dusting',
  'coating',
  'dredging',
  'frying',
]);

/** Bounded size/portion qualifiers. Preserved (not deleted) for Phase 4.5E. */
const SIZE_QUALIFIERS: ReadonlySet<string> = new Set([
  'small',
  'medium',
  'large',
  'jumbo',
  'mini',
  'miniature',
  'petite',
  'xlarge',
  'xl',
  'xxl',
  'bite',
  'snack',
]);

/**
 * Closed count/portion unit words that appear in recipe prose but never name a
 * food. They are removed from identity.
 */
const COUNT_NOISE: ReadonlySet<string> = new Set([
  'piece',
  'pieces',
  'stalk',
  'stalks',
  'clove',
  'cloves',
  'head',
  'heads',
  'can',
  'cans',
  'jar',
  'jars',
  'package',
  'packages',
  'pkg',
  'container',
  'containers',
  'box',
  'boxes',
  'bag',
  'bags',
  'bunch',
  'bunches',
  'sprig',
  'sprigs',
  'handful',
  'handfuls',
  'pinch',
  'pinches',
  'dash',
  'dashes',
  'drop',
  'drops',
  'bottle',
  'bottles',
  'stick',
  'sticks',
  // Bounded prepared-shape count nouns (`formed into four loose balls`).
  'ball',
  'balls',
  'patty',
  'patties',
]);

/**
 * Bounded conjunction / measurement / prose noise. These never name a food and
 * are removed from identity entirely so they cannot become the required anchor
 * (`and`, `total`, `about`, `grams`, `to`, ...).
 */
const NOISE_TOKENS: ReadonlySet<string> = new Set([
  'and',
  'or',
  'as',
  'about',
  'total',
  'gram',
  'grams',
  'kilogram',
  'kilograms',
  'ounce',
  'ounces',
  'pound',
  'pounds',
  'milliliter',
  'milliliters',
  'liter',
  'liters',
  'teaspoon',
  'teaspoons',
  'tablespoon',
  'tablespoons',
  'cup',
  'cups',
  'tsp',
  'tbsp',
  'ml',
  'oz',
  'lb',
  'lbs',
  'kg',
  'to',
  'in',
  'into',
  'plus',
  'approximately',
  'approx',
  'each',
  'more',
  'less',
  'few',
  'several',
  'needed',
  'taste',
  'serving',
  'servings',
  'size',
  'count',
  // Bounded number words (`four loose 4-ounce balls`). Numeric digits are
  // handled separately by `extractNumericQualifiers`.
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]);

/**
 * Nutritionally significant qualifiers. These are preserved as identity-adjacent
 * evidence (agreement/opposition) but are NOT the required anchor and NOT part
 * of core food identity.
 */
const QUALIFIER_TOKENS: ReadonlySet<string> = new Set([
  'salted',
  'unsalted',
  'raw',
  'cooked',
  'uncooked',
  'whole',
  'skim',
  'lowfat',
  'nonfat',
  'low',
  'reduced',
  'sweetened',
  'unsweetened',
  'enriched',
  'unenriched',
  'canned',
  'dried',
  'dehydrated',
  'frozen',
  'prepared',
  'unprepared',
  'refrigerated',
  'bottled',
  'packaged',
  'fortified',
  'light',
  'lite',
  'diet',
  'free',
  'lean',
  'extra',
  'virgin',
  'plain',
  'regular',
  'natural',
  'organic',
  'table',
  'iodized',
  'cultured',
  'imitation',
  'substitute',
  'meatless',
  'vegan',
  'vegetarian',
  'tofu',
]);

/**
 * Bounded OPTIONAL culinary-refinement tokens. These preserve a meaningful
 * culinary modifier as evidence and as a ranking PREFERENCE, but they are NOT
 * required food identity: the pinned USDA bundle has no `Salt, sea` /
 * `Salt, kosher` / texture-specific record, so requiring them would fail a
 * perfectly ordinary `1 tsp kosher salt` / `0.5 tsp coarse black pepper`.
 *
 * When a matching refinement record DOES exist (`Spices, pepper, black` for
 * `black pepper`; a hypothetical `Salt, kosher`), the refinement-agreement
 * ranking dimension surfaces it ahead of the generic record. When it does not,
 * the deterministic generic same-food fallback is used instead — the modifier
 * is never treated as absent (it remains recorded in the projection and the
 * review evidence).
 */
const REFINEMENT_TOKENS: ReadonlySet<string> = new Set([
  'kosher',
  'sea',
  'fine',
  'coarse',
  'coarsely',
  'cracked',
]);

/**
 * Closed food-FORM words. A form word describes the preparation form of a food
 * rather than the food identity itself; it is preserved as requested-form
 * evidence and is never the required anchor.
 */
const FORM_TOKENS: ReadonlySet<string> = new Set([
  'powder',
  'powdered',
  'flake',
  'flakes',
  'sauce',
  'paste',
  'puree',
  'juice',
  'extract',
  'concentrate',
  'syrup',
  'spread',
  'dressing',
  'dip',
  'gravy',
  'broth',
  'stock',
  'soup',
  'sandwich',
  'salad',
  'casserole',
  'stew',
  'pie',
  'cake',
  'biscuit',
  'burrito',
  'wrap',
  'taco',
  'burger',
  'cheeseburger',
  'hamburger',
  'pizza',
  'cereal',
  'cookie',
  'cracker',
  'chips',
  'drink',
  'beverage',
  'mix',
  'bowl',
  'plate',
  'meal',
  'entree',
  'patty',
  'nugget',
  'tender',
  'loaf',
  'bar',
]);

/**
 * Generic non-identity words that never name a food and never describe a food
 * state. They are removed from query identity (like preparation/noise), but
 * UNLIKE a descriptor they do NOT suppress the compound-food demotion, so a
 * generic tail token (`blend`, `style`) cannot dominate or excuse a compound
 * candidate (`Cheese, Mexican blend`, `Corn, ..., cream style`).
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'form',
  'type',
  'style',
  'variety',
  'blend',
  'product',
  'food',
  'item',
  'include',
  'includes',
]);

/**
 * Bounded grammatical/connective words that are neither food identity nor a
 * compound signal by themselves. They are ignored by the runner-up materiality
 * comparison (`with added vitamin D` ~ `without added vitamin D`) but are NOT
 * descriptors, so `X with Y` still demotes the composed dish through the
 * compound penalty.
 */
const BENIGN_GRAMMAR_TOKENS: ReadonlySet<string> = new Set(['with', 'without']);

/**
 * Closed fortification / added-nutrient vocabulary. A `with <added nutrient>`
 * tail (`with added vitamin D`, `with vitamin A palmitate`) is a benign grammar
 * tail, not a composed dish, so it must not be treated as `with <other food>`.
 */
const FORTIFICATION_TOKENS: ReadonlySet<string> = new Set([
  'added',
  'vitamin',
  'vitamins',
  'mineral',
  'minerals',
  'fortified',
  'reconstituted',
  'calcium',
  'iron',
  'riboflavin',
  'niacin',
  'thiamin',
  'thiamine',
  'folate',
  'folic',
  'acid',
  'palmitate',
  'd',
  'a',
  'b',
  'b1',
  'b2',
  'b3',
  'b6',
  'b12',
  'c',
  'e',
  'k',
  'iu',
]);

/**
 * Bounded food-VARIETY heads that are a modifier of the requested family rather
 * than a foreign food (`Wild rice` for `rice`). They are NOT compound-suppressing
 * descriptors, so `Wild rice, raw` still carries the compound demotion that keeps
 * a bare `raw rice` query in review.
 */
const BENIGN_VARIETY_HEAD_TOKENS: ReadonlySet<string> = new Set(['wild']);

/**
 * Closed material preservation/storage/prepared-product state qualifiers. When a
 * candidate carries one of these and the QUERY did not request it, the candidate
 * is a materially altered variant (`Apple, dried` for `apple`, `Egg, whole,
 * dried` for `eggs`, `Milk, dry` for `milk`, `Eggs, scrambled, frozen mixture`
 * for `scrambled eggs`). Such a candidate may remain a review candidate but can
 * never be an automatic selection. `frozen` is a storage state, `mixture` is a
 * prepared-product form, and `omelet` is an unrequested prepared dish form
 * (`Egg omelet or scrambled egg` for `scrambled eggs`); all distinguish a
 * materially different product from the ordinary food without globally
 * penalizing benign descriptive prose. Unlike `FORM_TOKENS`, this set is NOT
 * exempted by an `NS`/`NFS` generic marker, so `Egg omelet or scrambled egg, NS
 * as to fat` cannot use its NS wording to excuse the unrequested dish form.
 */
const MATERIAL_STATE_TOKENS: ReadonlySet<string> = new Set([
  'dried',
  'dehydrated',
  'canned',
  'pickled',
  'smoked',
  'powdered',
  'reconstituted',
  'condensed',
  'evaporated',
  'dry',
  'frozen',
  'mixture',
  'omelet',
  'omelette',
]);

/**
 * Closed COOKING / PREPARATION-METHOD tokens. A cooking method materially
 * changes a food's preparation state (a raw egg is not a fried egg). A bare
 * family query does not request any method, so a candidate that names an
 * unrequested method (`Egg, whole, fried, NS as to fat` for `egg`) is a
 * materially altered preparation and may never be an automatic selection. The
 * generic state `cooked` is included and is SATISFIED by any explicitly
 * requested specific method (`2 boiled eggs` -> `Egg, whole, cooked,
 * hard-boiled`), so an explicit method is never penalized for also saying
 * `cooked`. Explicit requests (`fried eggs`, `raw egg`, `cooked rice`) remain
 * authoritative. This is what makes `fried`/`baked`/`boiled` visible to the
 * authority contract instead of being invisible descriptors.
 */
const COOKING_METHOD_TOKENS: ReadonlySet<string> = new Set([
  'cooked',
  'fried',
  'panfried',
  'deepfried',
  'stirfried',
  'boiled',
  'hardboiled',
  'softboiled',
  'coddled',
  'scrambled',
  'poached',
  'baked',
  'roasted',
  'broiled',
  'grilled',
  'steamed',
  'sauteed',
  'braised',
  'stewed',
  'microwaved',
  'toasted',
]);

/**
 * Closed DERIVED-COMPONENT tokens. A rendered fat or non-meat animal part is a
 * component DERIVED from a food, not the food family itself: `chicken` is not
 * `chicken fat`, `pork` is not `pork fat`, `beef` is not `beef tallow`, `milk` is
 * not `milk fat`/`butterfat`. When a candidate names one of these and the query
 * did not request it, the candidate is a food-family mismatch and can never be
 * the automatic choice. This is bounded and context-sensitive: the token is only
 * a component when it is the candidate HEAD (`Fat, chicken`) or immediately
 * follows a requested food token (`Chicken skin`). A composition descriptor
 * (`Beef, ground, 80% lean meat / 20% fat`) is NOT a component.
 */
const DERIVED_COMPONENT_TOKENS: ReadonlySet<string> = new Set([
  'fat',
  'tallow',
  'suet',
  'lard',
  'dripping',
  'drippings',
  'butterfat',
  'skin',
  'rind',
  'crackling',
  'cracklings',
]);

/**
 * Closed set of food nouns that commonly form a materially different COMPOUND
 * when placed adjacent to another food (`peanut butter`, `apple butter`,
 * `bread-and-butter pickles`, `bread rice`, `pepper steak`, `cream style corn`).
 * Used ONLY to override the category-head exemption in the compound demotion, so
 * a preceding category token never excuses a compound.
 */
const COMPOUND_PREFIX_TOKENS: ReadonlySet<string> = new Set([
  'peanut',
  'almond',
  'cashew',
  'sesame',
  'hazelnut',
  'walnut',
  'pecan',
  'pistachio',
  'macadamia',
  'coconut',
  'soy',
  'soybean',
  'apple',
  'bread',
  'rice',
  'corn',
  'cream',
  'tomato',
  'salt',
  'pepper',
  'sour',
  'butter',
  'milk',
  'oat',
  'oats',
  'wheat',
  'rye',
  'barley',
  'buckwheat',
  'quinoa',
  'honey',
  'maple',
  'chocolate',
  'cocoa',
  'banana',
  'lemon',
  'lime',
  'orange',
  'grape',
  'cherry',
  'strawberry',
  'blueberry',
  'raspberry',
  'cranberry',
  'potato',
  'sweet',
  'chili',
  'garlic',
  'onion',
  'ginger',
  'cinnamon',
  'vanilla',
  'mustard',
  'ketchup',
  'mayonnaise',
  'vinegar',
  'olive',
  'canola',
  'vegetable',
  'sunflower',
  'safflower',
  'flour',
  'sugar',
  'water',
  'oil',
  'oils',
  'starch',
  'meal',
  'pasta',
  'noodle',
  'noodles',
  'bean',
  'pea',
  'lentil',
  'chickpea',
  'nut',
  'seed',
  'grain',
  'bran',
  'germ',
]);

/**
 * Closed subset of qualifiers that MATERIALLY change the food identity for the
 * runner-up ambiguity contract (e.g. salted/unsalted, whole/skim,
 * sweetened/unsweetened, raw/cooked, canned/dried). Benign qualifiers
 * (`regular`, `cultured`, `nfs`, `fresh`, `raw`, ...) are NOT material here.
 */
const MATERIAL_QUALIFIER_TOKENS: ReadonlySet<string> = new Set([
  'salted',
  'unsalted',
  'sweetened',
  'unsweetened',
  'enriched',
  'unenriched',
  'whole',
  'skim',
  'lowfat',
  'nonfat',
  'low',
  'reduced',
  'fortified',
  'imitation',
  'meatless',
  'vegan',
  'vegetarian',
  'tofu',
  'substitute',
  'light',
  'diet',
  'free',
  // Fat/cream level classes. `heavy`/`half`/`whipping` are unrequested material
  // subtypes of cream, so a bare `cream` query must not auto a specific class.
  'heavy',
  'half',
  'whipping',
  'whipped',
  ...MATERIAL_STATE_TOKENS,
]);

/**
 * Closed descriptor vocabulary used ONLY to distinguish a compound-food
 * modifier (`peanut` in `peanut butter`) from an ordinary qualifier/descriptor
 * (`stick` in `Butter, stick, unsalted`). It never removes a token from
 * matching; it only informs the bounded compound-food demotion.
 */
const DESCRIPTOR_TOKENS: ReadonlySet<string> = new Set([
  ...PREPARATION_QUALIFIERS,
  ...SIZE_QUALIFIERS,
  ...COUNT_NOISE,
  ...NOISE_TOKENS,
  ...QUALIFIER_TOKENS,
  ...FORM_TOKENS,
  'spice',
  'spices',
  'seasoning',
  'stick',
  'creamy',
  'smooth',
  'chunky',
  'curd',
  'sharp',
  'mild',
  'granulated',
  'powdered',
  'ground',
  'solid',
  'liquid',
  'dry',
  'wet',
  // Leavening descriptors (`baking powder, double-acting, straight phosphate`,
  // `Leavening agents`) are ordinary product descriptors, not compound food
  // modifiers.
  'double',
  'acting',
  'straight',
  'phosphate',
  'aluminum',
  'sulfate',
  'agents',
  'dark',
  'golden',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'brown',
  'pink',
  'bell',
  'roma',
  'nfs',
  'ns',
  'heavy',
  'whipping',
  'whipped',
  'clarified',
  'half',
  'skin',
  'skinned',
  'skinless',
  'bone',
  'bones',
  'boneless',
  'coating',
  'coated',
  'breaded',
  'breading',
  'added',
  'sodium',
  'fat',
  'calcium',
  'vitamin',
  'mineral',
  'soluble',
  'insoluble',
  'refined',
  'unrefined',
  'bleached',
  'unbleached',
  // Grain-type descriptor (`Flour, wheat, all-purpose`), not a compound prefix.
  'wheat',
  'peeled',
  'pitted',
  'skinless',
  'boneless',
  'seedless',
  'shelled',
  'unshelled',
  'cracked',
  'rolled',
  'quick',
  'instant',
  'old',
  'fashioned',
  'style',
  'solid',
  // cooking / curing methods
  'cured',
  'uncured',
  'smoked',
  'unsmoked',
  'roasted',
  'baked',
  'broiled',
  'grilled',
  'fried',
  'pan',
  'boiled',
  'steamed',
  'sauteed',
  'braised',
  'microwaved',
  'toasted',
  'rendered',
  'precooked',
  'heat',
  'ready',
  'eaten',
  'side',
]);

/**
 * Closed USDA-style CATEGORY heads. A token immediately BEFORE a matched anchor
 * that is a category head is a food category (`Cheese, cheddar`,
 * `Peppers, jalapenos`), not a compound modifier (`Peanut butter`). This is used
 * ONLY by the bounded compound-food demotion, never to remove a token from
 * matching.
 */
const CATEGORY_TOKENS: ReadonlySet<string> = new Set([
  'cheese',
  'cheeses',
  'cream',
  'milk',
  'yogurt',
  'butter',
  'oil',
  'oils',
  'vinegar',
  'flour',
  'sugar',
  'salt',
  'water',
  'bread',
  'cereal',
  'cereals',
  'soup',
  'soups',
  'sauce',
  'sauces',
  'snack',
  'snacks',
  'sweet',
  'sweets',
  'candy',
  'candies',
  'dessert',
  'desserts',
  'babyfood',
  'spice',
  'spices',
  'herb',
  'herbs',
  'seasoning',
  'seasonings',
  // USDA groups baking powder/soda under a `Leavening agents` head; it is the
  // category of the food, not a different food, so it must not be a foreign head.
  'leavening',
  'poultry',
  'pork',
  'beef',
  'lamb',
  'veal',
  'meat',
  'meats',
  'fish',
  'finfish',
  'shellfish',
  'game',
  'legume',
  'legumes',
  'dairy',
  'egg',
  'eggs',
  'beverage',
  'beverages',
  'fruit',
  'fruits',
  'nut',
  'nuts',
  'seed',
  'seeds',
  'grain',
  'grains',
  'vegetable',
  'vegetables',
  'green',
  'greens',
  'onion',
  'onions',
  'pepper',
  'peppers',
  'tomato',
  'tomatoes',
  'potato',
  'potatoes',
  'carrot',
  'carrots',
  'mushroom',
  'mushrooms',
  'bean',
  'beans',
  'pea',
  'peas',
  'berry',
  'berries',
]);

/**
 * Closed PRODUCT / DISH / PREPARATION-FORM heads. A candidate whose HEAD token
 * is one of these is a composed product or a dish rather than the raw food
 * family, so it cannot be the automatic choice for a raw-food-family query
 * (`Dessert topping, powdered, ... milk` for `powdered milk`,
 * `Candies, SYMPHONY Milk Chocolate Bar` for `milk chocolate`, `Head cheese` for
 * `cheese`). It never removes a token from matching; it only informs the
 * food-family mismatch signal.
 */
const PRODUCT_HEAD_TOKENS: ReadonlySet<string> = new Set([
  'dessert',
  'desserts',
  'candies',
  'candy',
  'snacks',
  'snack',
  'beverages',
  'beverage',
  'babyfood',
  'soup',
  'soups',
  'sauce',
  'sauces',
  'salad',
  'salads',
  'dressing',
  'dressings',
  'gravy',
  'dip',
  'dips',
  'spread',
  'spreads',
  'granola',
  'formulated',
  'cookie',
  'cookies',
  'cake',
  'cakes',
  'pie',
  'pies',
  'cracker',
  'crackers',
  'chips',
  'bar',
  'bars',
  'mix',
  'drink',
  'drinks',
  'burger',
  'sandwich',
  'pizza',
  'taco',
  'burrito',
  'wrap',
  'casserole',
  'stew',
  'meal',
  'entree',
  'patty',
  'nugget',
  'tender',
  'loaf',
  'head',
  'biscuit',
  'muffin',
  'pancake',
  'waffle',
  'pudding',
  'puddings',
  'frosting',
  'icing',
  'ice',
]);

/**
 * Closed variety / cultivar / color / type tokens. When a candidate carries one
 * of these and the QUERY did not request it, the candidate is a specific
 * variety rather than the generic family member (`Cheese, blue` for `cheese`,
 * `Tomato, roma` for `tomato`, `Rice, black` for `raw rice`,
 * `Flour, whole wheat` for `flour`). Explicitly requested varieties remain
 * authoritative (`blue cheese`, `roma tomato`, `black rice`).
 */
const VARIETY_TOKENS: ReadonlySet<string> = new Set([
  // colors
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'brown',
  'pink',
  'golden',
  'dark',
  // tomato
  'roma',
  'beefsteak',
  'cherry',
  'grape',
  'plum',
  'heirloom',
  // rice / grain
  'basmati',
  'jasmine',
  'arborio',
  'glutinous',
  'calrose',
  'long',
  'short',
  'rye',
  'barley',
  'oat',
  'oats',
  'corn',
  'buckwheat',
  'quinoa',
  'millet',
  'sorghum',
  'spelt',
  'semolina',
  'durum',
  // flour types. `wheat`, `all`, and `purpose` are deliberately NOT varieties:
  // they are the ordinary descriptors of generic/all-purpose wheat flour, and
  // treating them as unrequested varieties pushed all-purpose flour below
  // irrelevant floured-chicken dishes.
  'self',
  'rising',
  'bread',
  'cake',
  'pastry',
  'tapioca',
  // cheese types
  'cheddar',
  'swiss',
  'provolone',
  'mozzarella',
  'parmesan',
  'romano',
  'gouda',
  'brie',
  'feta',
  'ricotta',
  'american',
  'colby',
  'monterey',
  'jack',
  'gruyere',
  'havarti',
  'muenster',
  'fontina',
  'manchego',
  'paneer',
  'asiago',
  'pecorino',
  'queso',
  'fresco',
  'blanco',
  'roquefort',
  'camembert',
  'neufchatel',
  'mascarpone',
  'burrata',
  'halloumi',
  'cotija',
  'oaxaca',
  // produce types
  'iceberg',
  'romaine',
  'boston',
  'arugula',
  'butterhead',
  'russet',
  'yukon',
  'fingerling',
  'navel',
  'valencia',
  'fuji',
  'gala',
  'granny',
  'honeycrisp',
  'delicious',
  'mcintosh',
  // Bean cultivars / types. The pinned USDA dry-bean records are ALL named
  // cultivars (`Beans, Dry, Tan`, `Beans, Dry, Carioca`, `Beans, Dry,
  // Cranberry`, ...) and there is NO generic dry-bean record. A bare or
  // `dry beans` query therefore must not auto-invent a cultivar purely from
  // rank/FDC order. A bounded, representative vocabulary is required because
  // the cultivar names are arbitrary proper nouns that no structural rule can
  // recognize. Color/size cultivars (`red`, `brown`, `black`, `pink`, `small`,
  // `light`, `dark`, `medium`) are already covered above; only the distinctive
  // names are listed here.
  'tan',
  'carioca',
  'cranberry',
  'navy',
  'pinto',
  'cannellini',
  'kidney',
  'northern',
  'flor',
  'mayo',
]);

/**
 * Closed MATERIAL-VARIETY subset. These are distinctive proper-noun cultivars
 * that name a genuinely different food within the same family rather than a
 * cosmetic color/ordinary variety (`Beans, Dry, Tan` vs `Beans, Dry, Carioca`).
 * A bare-family query must not auto-invent one of these; the best-effort
 * same-family default authority blocks when any otherwise-benign candidate
 * carries an unrequested material variety. Ordinary colors/levels
 * (`yellow`, `white`, `blue`, ...) are NOT material varieties.
 */
const MATERIAL_VARIETY_TOKENS: ReadonlySet<string> = new Set([
  'tan',
  'carioca',
  'cranberry',
  'navy',
  'pinto',
  'cannellini',
  'kidney',
  'northern',
  'flor',
  'mayo',
  // Specialty grains that are materially different from the ordinary staple:
  // `Rice, black` is not the plain white/brown rice default, and `Wild rice` is
  // a different grain. Explicit `black rice` / `wild rice` queries are honored.
  'black',
  'wild',
]);

/** Closed generic family markers (the plain/unspecified family member). */
const GENERIC_MARKER_TOKENS: ReadonlySet<string> = new Set(['nfs', 'ns', 'unspecified']);

/**
 * Closed material-state equivalence groups. A requested state/form token is
 * satisfied by any equivalent candidate state token (`powdered milk` is
 * satisfied by `Milk, dry, ...`), and an equivalent candidate state token is NOT
 * an unrequested alteration.
 */
const STATE_EQUIVALENCE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = Object.freeze([
  Object.freeze(['powdered', 'powder', 'dry', 'dried', 'dehydrated']),
]);

/**
 * Closed negation / contradiction markers (never positive relevance). `with` is
 * included so a candidate that is merely a food prepared `with <ingredient>`
 * (`Tuna salad, made with mayonnaise`, `Pumpkin, canned, with salt`) is not
 * treated as that ingredient — unless the query itself requests `with`.
 */
const NEGATION_TOKENS: ReadonlySet<string> = new Set([
  'without',
  'no',
  'not',
  'sans',
  'minus',
  'free',
  'less',
  'low',
  'with',
]);

/** Closed identity-changing variant qualifiers (unmatched -> lower relevance). */
const CONFLICT_QUALIFIER_TOKENS: ReadonlySet<string> = new Set([
  // Identity-changing variants (a materially different food).
  'meatless',
  'vegan',
  'vegetarian',
  'imitation',
  'turkey',
  'beef',
  'canadian',
  'bits',
  'tofu',
  'substitute',
  // Health-claim / diet qualifiers that mark a reduced or altered variant.
  'reduced',
  'light',
  'diet',
  'low',
  'free',
]);

/** Closed opposite qualifier pairs (requested -> contradicted by the other). */
const QUALIFIER_OPPOSITES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  Object.freeze(['salted', 'unsalted'] as const),
  Object.freeze(['sweetened', 'unsweetened'] as const),
  Object.freeze(['enriched', 'unenriched'] as const),
  Object.freeze(['raw', 'cooked'] as const),
  Object.freeze(['whole', 'skim'] as const),
]);

/** Bounded trailing recipe-instruction lead-ins (non-authoritative notes). */
const NOTE_LEAD_INS: ReadonlyArray<string> = [
  'formed into',
  'shaped into',
  'patted into',
  'divided into',
  'cut into',
  'sliced into',
  'chopped into',
  'rolled into',
  'made into',
  'to taste',
  'as needed',
  'as desired',
  'for garnish',
  'for serving',
  'for frying',
  'for dusting',
  'for coating',
  'for dredging',
  'plus more',
  'or more',
  'optional',
  'divided',
  'reserved',
];

interface CulinaryAlias {
  readonly id: string;
  readonly from: ReadonlyArray<string>;
  readonly to: ReadonlyArray<string>;
  /** Optional explicit anchor override (e.g. bun/roll). */
  readonly anchors: ReadonlyArray<ReadonlyArray<string>> | undefined;
}

/**
 * Bounded, source-controlled, directional culinary aliases required by
 * demonstrated home-recipe language. Aliases never rewrite stored recipes and
 * never authorize an automatic exact match.
 */
const ALIASES: ReadonlyArray<CulinaryAlias> = Object.freeze([
  Object.freeze({
    id: 'burger_bun_to_hamburger_bun',
    from: Object.freeze(['burger', 'bun']),
    to: Object.freeze(['hamburger', 'bun']),
    anchors: Object.freeze([Object.freeze(['bun', 'roll'])]),
  }),
  Object.freeze({
    id: 'burger_bun_to_hamburger_bun',
    from: Object.freeze(['burger', 'buns']),
    to: Object.freeze(['hamburger', 'bun']),
    anchors: Object.freeze([Object.freeze(['bun', 'roll'])]),
  }),
  // `neutral oil` names an ordinary neutral cooking/frying oil. USDA has no
  // `neutral oil` record; the bounded default family is the plain/generic
  // `Vegetable oil, NFS` (with `Oil, canola` / `Oil, soybean` / `Oil, peanut`
  // remaining acceptable same-family siblings). It must NOT select a flavored or
  // specialty oil (`walnut`, `coconut`, `sesame`, `olive`) merely because it
  // contains `oil`.
  Object.freeze({
    id: 'neutral_oil_to_vegetable_oil',
    from: Object.freeze(['neutral', 'oil']),
    to: Object.freeze(['vegetable', 'oil']),
    anchors: Object.freeze([Object.freeze(['oil'])]),
  }),
]);

const NUMERIC_TOKEN = /^\d+(?:\.\d+)?$/;

function containsPhrase(tokens: ReadonlyArray<string>, phrase: ReadonlyArray<string>): number {
  if (phrase.length === 0 || tokens.length < phrase.length) return -1;
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (tokens[i + j] !== phrase[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Bounded morphological equivalence for matching only. Two tokens match when
 * they are identical or differ by one of a small, closed set of regular plural
 * endings. Short tokens (< 3 chars) only match exactly, so a stray letter can
 * never match a food token.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return false;
  if (`${short}s` === long) return true;
  if (`${short}es` === long) return true;
  if (short.endsWith('y') && `${short.slice(0, -1)}ies` === long) return true;
  return false;
}

/** True when `token` names the same token as any entry in `tokens`. */
function tokenInSet(tokens: ReadonlyArray<string>, token: string): boolean {
  for (const entry of tokens) if (tokensMatch(entry, token)) return true;
  return false;
}

/** Morphological OR closed material-state equivalence (powdered ~ dry). */
export function tokensEquivalent(a: string, b: string): boolean {
  if (tokensMatch(a, b)) return true;
  for (const group of STATE_EQUIVALENCE_GROUPS) {
    if (group.includes(a) && group.includes(b)) return true;
  }
  return false;
}

/** True when any candidate token is equivalent to `wanted`. */
function candidateHasEquivalent(tokens: ReadonlyArray<string>, wanted: string): boolean {
  for (const entry of tokens) if (tokensEquivalent(entry, wanted)) return true;
  return false;
}

/** Removes parenthetical asides (`(about 75 to 100 grams in total)`). */
function stripParentheticals(text: string): string {
  // A parenthetical that is PURELY a numeric ratio (`(80/20)`, `(85 / 15)`) is a
  // meaningful food-defining modifier and is preserved as two numeric tokens.
  // Every other parenthetical is an aside and is removed.
  return text
    .replace(/\(\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*\)/g, ' $1 $2 ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ');
}

/**
 * Splits a query on commas and drops trailing clauses that contain ONLY
 * preparation/size/measurement/note words (e.g. `butter, chilled and cubed`,
 * `onions, chopped`). Clauses with real identity content are retained.
 */
function stripPreparationClauses(text: string): { text: string; notes: string[] } {
  const segments = text.split(',');
  if (segments.length <= 1) return { text, notes: [] };
  const kept: string[] = [segments[0]];
  const notes: string[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i].trim();
    if (segment.length === 0) continue;
    const tokens = segment.toLowerCase().split(/\s+/).filter(Boolean);
    const allNoise = tokens.every(
      (token) =>
        PREPARATION_QUALIFIERS.has(token) ||
        SIZE_QUALIFIERS.has(token) ||
        COUNT_NOISE.has(token) ||
        NOISE_TOKENS.has(token) ||
        NUMERIC_TOKEN.test(token)
    );
    if (allNoise) notes.push(segment);
    else kept.push(segment);
  }
  return { text: kept.join(', '), notes };
}

function stripTrailingNote(text: string): { text: string; notes: string[] } {
  const lower = text.toLowerCase();
  let best = -1;
  for (const lead of NOTE_LEAD_INS) {
    const pattern = new RegExp(`(?:^|\\s)${lead.replace(/ /g, '\\s+')}\\b`);
    const match = pattern.exec(lower);
    if (match) {
      const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
      if (best === -1 || start < best) best = start;
    }
  }
  if (best <= 0) return { text, notes: [] };
  return { text: text.slice(0, best).trim(), notes: [text.slice(best).trim()] };
}

function extractNumericQualifiers(tokens: string[]): { tokens: string[]; numeric: string[] } {
  const numeric: string[] = [];
  const kept: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (NUMERIC_TOKEN.test(tokens[i])) {
      let j = i;
      const run: string[] = [];
      while (j < tokens.length && NUMERIC_TOKEN.test(tokens[j])) {
        run.push(tokens[j]);
        j += 1;
      }
      // A run of exactly two numeric tokens is a bounded ratio qualifier
      // (e.g. `80 20` from `80/20`). A single numeric token is not identity.
      if (run.length === 2) numeric.push(run[0], run[1]);
      // Numeric tokens never become food identity.
      i = j;
      continue;
    }
    kept.push(tokens[i]);
    i += 1;
  }
  return { tokens: kept, numeric };
}

/**
 * Projects one normalized food-name query into closed roles. Deterministic and
 * independent of locale/time/state.
 */
/**
 * Deterministic OR-alternative decomposition (`brioche or potato burger buns`).
 *
 * The construction is treated as an elliptical list of two candidate-search
 * intents that share a trailing head phrase. The modifier is the leading token
 * of each side; the shared suffix is the longer of the two remainders. Returns
 * `{ shared, branches }` where `shared` is the required identity suffix and each
 * branch is a complete candidate intent. Returns empty `branches` when there is
 * no usable `or` construction, so ordinary queries are untouched.
 */
export function decomposeAlternatives(tokens: ReadonlyArray<string>): {
  shared: string[];
  branches: string[][];
} {
  const orIndex = tokens.indexOf('or');
  if (orIndex <= 0 || orIndex >= tokens.length - 1) return { shared: [], branches: [] };
  const left = tokens.slice(0, orIndex);
  const right = tokens.slice(orIndex + 1);
  if (left.length === 0 || right.length === 0) return { shared: [], branches: [] };

  const leftMod = left[0];
  const leftTail = left.slice(1);
  const rightMod = right[0];
  const rightTail = right.slice(1);

  let shared: string[];
  if (rightTail.length > 0) shared = rightTail;
  else if (leftTail.length > 0) shared = leftTail;
  else shared = [];

  const branchA = [leftMod, ...shared];
  const branchB = [rightMod, ...shared];
  return { shared, branches: [branchA, branchB] };
}

/** Assigned semantic roles for one token sequence. */
interface TokenRoles {
  readonly sizeQualifiers: string[];
  readonly preparationQualifiers: string[];
  readonly qualifierTokens: string[];
  readonly formTokens: string[];
  readonly refinementTokens: string[];
  readonly identityTokens: string[];
}

/** Assigns the closed semantic roles to one normalized token sequence. */
function assignRoles(tokens: ReadonlyArray<string>): TokenRoles {
  const sizeQualifiers: string[] = [];
  const preparationQualifiers: string[] = [];
  const qualifierTokens: string[] = [];
  const formTokens: string[] = [];
  const refinementTokens: string[] = [];
  const identityTokens: string[] = [];
  for (const token of tokens) {
    if (REFINEMENT_TOKENS.has(token)) {
      // Optional refinement: preserved as preference evidence, NOT required
      // identity (the bundle may have no subtype record).
      refinementTokens.push(token);
    } else if (SIZE_QUALIFIERS.has(token)) {
      sizeQualifiers.push(token);
    } else if (
      PREPARATION_QUALIFIERS.has(token) ||
      COUNT_NOISE.has(token) ||
      NOISE_TOKENS.has(token) ||
      GENERIC_TOKENS.has(token)
    ) {
      preparationQualifiers.push(token);
    } else if (QUALIFIER_TOKENS.has(token)) {
      qualifierTokens.push(token);
      identityTokens.push(token);
    } else if (FORM_TOKENS.has(token)) {
      formTokens.push(token);
      identityTokens.push(token);
    } else {
      identityTokens.push(token);
    }
  }
  return {
    sizeQualifiers,
    preparationQualifiers,
    qualifierTokens,
    formTokens,
    refinementTokens,
    identityTokens,
  };
}

/**
 * Projects one normalized food-name query into closed roles. Deterministic and
 * independent of locale/time/state.
 */
export function projectQueryText(text: string): IngredientQueryProjection {
  const normalized = String(text).trim();
  const measurementTokens: string[] = [];

  const withoutParens = stripParentheticals(normalized);
  const clauseResult = stripPreparationClauses(withoutParens);
  const noteResult = stripTrailingNote(clauseResult.text);
  const notes = [...clauseResult.notes, ...noteResult.notes];
  const withoutNote = noteResult.text;

  // Normalize punctuation BEFORE semantic-role assignment so a trailing comma
  // can never attach to a token (`butter,` -> `butter`) and a hyphenated word
  // can never collapse into a single token (`gluten-free` -> `gluten free`).
  const cleaned = withoutNote
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const rawTokens = cleaned.length === 0 ? [] : cleaned.split(' ').filter(Boolean);
  const { tokens: withoutNumeric, numeric } = extractNumericQualifiers(rawTokens);

  // OR alternatives are decomposed BEFORE role assignment so the `or` connector
  // is never lost and the alternative modifiers are preserved as candidate
  // intent. The required identity is the shared head phrase, so a generic
  // same-food fallback remains available when no subtype record exists.
  const orInfo = decomposeAlternatives(withoutNumeric);
  const hasAlternatives = orInfo.branches.length > 0;
  const roleSource = hasAlternatives
    ? orInfo.shared.length > 0
      ? orInfo.shared
      : orInfo.branches.flat()
    : withoutNumeric;

  const roles = assignRoles(roleSource);
  const identityTokens = roles.identityTokens;

  // Contextual rule for `ground`: identity-bearing only when a meat species is
  // present; otherwise it is an ordinary preparation word (e.g. ground pepper).
  const MEAT_SPECIES: ReadonlySet<string> = new Set([
    'beef',
    'pork',
    'chicken',
    'turkey',
    'lamb',
    'veal',
    'bison',
    'venison',
    'duck',
  ]);
  const hasMeatSpecies = identityTokens.some((token) => MEAT_SPECIES.has(token));
  if (!hasMeatSpecies && identityTokens.includes('ground')) {
    const filtered: string[] = [];
    for (const token of identityTokens) {
      if (token === 'ground') roles.preparationQualifiers.push(token);
      else filtered.push(token);
    }
    identityTokens.length = 0;
    identityTokens.push(...filtered);
  }

  // Bounded directional aliases (applied to the identity token sequence only).
  const aliases: string[] = [];
  let anchorOverride: ReadonlyArray<ReadonlyArray<string>> | undefined;
  for (const alias of ALIASES) {
    const index = containsPhrase(identityTokens, alias.from);
    if (index === -1) continue;
    identityTokens.splice(index, alias.from.length, ...alias.to);
    aliases.push(alias.id);
    if (alias.anchors) anchorOverride = alias.anchors;
    break;
  }

  // Re-derive the qualifier/form role lists from the ALIASED identity tokens so
  // an alias (`burger buns` -> `hamburger bun`) is reflected consistently. The
  // optional-refinement list is unaffected (refinements are never aliased and
  // are not part of identity).
  roles.qualifierTokens.length = 0;
  roles.formTokens.length = 0;
  for (const token of identityTokens) {
    if (QUALIFIER_TOKENS.has(token)) roles.qualifierTokens.push(token);
    else if (FORM_TOKENS.has(token)) roles.formTokens.push(token);
  }

  // CORE FOOD IDENTITY = identity tokens that are neither qualifiers, forms, nor
  // optional refinements.
  const coreTokens = identityTokens.filter(
    (token) =>
      !QUALIFIER_TOKENS.has(token) &&
      !FORM_TOKENS.has(token) &&
      !REFINEMENT_TOKENS.has(token)
  );

  // Deterministic anchor: the last CORE identity token (the food head noun),
  // falling back to the last identity token, then to the query itself.
  let anchorTokens = coreTokens.length > 0 ? [...coreTokens] : [...identityTokens];
  if (anchorTokens.length === 0) anchorTokens = [];
  let anchorGroups: AnchorGroup[];
  if (anchorOverride) {
    anchorGroups = anchorOverride.map((accepted) => Object.freeze({ accepted: Object.freeze([...accepted]) }));
  } else if (anchorTokens.length > 0) {
    anchorGroups = [Object.freeze({ accepted: Object.freeze([anchorTokens[anchorTokens.length - 1]]) })];
  } else {
    anchorGroups = [];
  }

  return Object.freeze({
    version: QUERY_PROJECTION_VERSION,
    food_identity: identityTokens.join(' '),
    food_tokens: Object.freeze([...identityTokens]),
    core_tokens: Object.freeze([...coreTokens]),
    qualifier_tokens: Object.freeze([...roles.qualifierTokens]),
    form_tokens: Object.freeze([...roles.formTokens]),
    refinement_tokens: Object.freeze([...roles.refinementTokens]),
    alternative_groups: Object.freeze(
      (hasAlternatives ? orInfo.branches : []).map((branch) => Object.freeze([...branch]))
    ),
    anchor_groups: Object.freeze(anchorGroups),
    measurement_tokens: Object.freeze(measurementTokens),
    size_qualifiers: Object.freeze([...roles.sizeQualifiers]),
    preparation_qualifiers: Object.freeze([...roles.preparationQualifiers]),
    notes: Object.freeze([...notes]),
    numeric_qualifiers: Object.freeze([...numeric]),
    aliases: Object.freeze([...aliases]),
  });
}

/** True when the query itself explicitly requests a negation/variant qualifier. */
export function queryRequestsNegation(projection: IngredientQueryProjection): boolean {
  return projection.food_tokens.some((token) => NEGATION_TOKENS.has(token));
}

/**
 * Closed forward-negation markers. Unlike `NEGATION_TOKENS` (which also carries
 * `with`/`free`/`less`/`low` for the back/next windows), these are the only
 * tokens that negate a FOLLOWING food token: `salt not added`, `salt no salt`,
 * `salt never added`.
 */
const FORWARD_NEGATION_TOKENS: ReadonlySet<string> = new Set(['not', 'no', 'never']);

/**
 * True when a candidate contradicts the query for `anchorToken` (e.g. a query
 * for `salt` against `without salt`, `no salt`, `salt free`, `low salt`, or
 * `salt not added in processing`). The query's own explicit negation is honored
 * by the caller.
 */
export function candidateContradicts(
  candidateTokens: ReadonlyArray<string>,
  identityTokens: ReadonlyArray<string>
): boolean {
  for (const token of identityTokens) {
    for (let i = 0; i < candidateTokens.length; i += 1) {
      if (!tokensMatch(candidateTokens[i], token)) continue;
      // `<negation> [word] <token>` within a 2-token window.
      for (let back = 1; back <= 2; back += 1) {
        const prev = candidateTokens[i - back];
        if (prev && NEGATION_TOKENS.has(prev)) return true;
      }
      // `<token> free` / `<token> less` / `<token> added`.
      const next = candidateTokens[i + 1];
      if (next === 'free' || next === 'less' || next === 'added') return true;
      // `<token> [word] not|no|never ...` within a 2-token forward window.
      for (let fwd = 1; fwd <= 2; fwd += 1) {
        const following = candidateTokens[i + fwd];
        if (following && FORWARD_NEGATION_TOKENS.has(following)) return true;
      }
    }
  }
  return false;
}

/** Counts unmatched identity-changing variant / dish-form qualifiers. */
export function qualifierConflictCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  // An explicit generic/NS/NFS candidate is the unspecified family member; the
  // variant words it enumerates (`Cream, NS as to light, heavy, or half and
  // half`) are options, not conflicts, so they must not push it below a specific
  // sibling. This is the "conflict qualifier bookkeeping" repair.
  if (genericMarkerCount(candidateTokens) > 0) return 0;
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  let conflicts = 0;
  for (const token of candidateTokens) {
    if (requested.has(token)) continue;
    if (CONFLICT_QUALIFIER_TOKENS.has(token) || FORM_TOKENS.has(token)) {
      conflicts += 1;
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Post-Phase-5 remediation: deterministic confidence evidence helpers
// ---------------------------------------------------------------------------

/** Number of CORE identity tokens absent from the candidate. */
export function missingCoreTokenCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  let missing = 0;
  for (const token of projection.core_tokens) {
    if (!tokenInSet(candidateTokens, token)) missing += 1;
  }
  return missing;
}

/** Number of requested qualifier/form tokens present in the candidate. */
export function qualifierAgreementCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  let agreement = 0;
  for (const token of projection.qualifier_tokens) {
    if (candidateHasEquivalent(candidateTokens, token)) agreement += 1;
  }
  for (const token of projection.form_tokens) {
    if (candidateHasEquivalent(candidateTokens, token)) agreement += 1;
  }
  return agreement;
}

/**
 * Number of requested qualifiers the candidate explicitly CONTRADICTS through a
 * closed opposite pair (e.g. query `unsalted` vs candidate `salted`).
 */
export function qualifierOppositionCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  let opposition = 0;
  for (const token of projection.qualifier_tokens) {
    for (const [a, b] of QUALIFIER_OPPOSITES) {
      const opposite = token === a ? b : token === b ? a : undefined;
      if (opposite && tokenInSet(candidateTokens, opposite)) opposition += 1;
    }
  }
  return opposition;
}

/** Number of requested qualifier tokens absent from the candidate. */
export function missingQualifierTokenCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  let missing = 0;
  for (const token of projection.qualifier_tokens) {
    if (!candidateHasEquivalent(candidateTokens, token)) missing += 1;
  }
  return missing;
}

/** Number of requested form tokens absent from the candidate. */
export function missingFormTokenCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  let missing = 0;
  for (const token of projection.form_tokens) {
    if (!candidateHasEquivalent(candidateTokens, token)) missing += 1;
  }
  return missing;
}

/**
 * Number of requested OPTIONAL culinary-refinement tokens present in the
 * candidate (`sea`/`kosher`/`fine`/`coarse`). Used as a ranking PREFERENCE so a
 * real refinement record outranks the generic sibling when it exists. It is
 * never required, so an absent refinement does not block the deterministic
 * generic same-food fallback.
 */
export function refinementAgreementCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  let agreement = 0;
  for (const token of projection.refinement_tokens) {
    if (candidateHasEquivalent(candidateTokens, token)) agreement += 1;
  }
  return agreement;
}

/**
 * Number of OR-alternative branches fully satisfied by the candidate
 * (`brioche or potato burger buns` -> a `brioche bun` record scores 1). Used as
 * a ranking PREFERENCE so a real subtype record outranks the generic fallback.
 * Never required: when no subtype record exists the shared-head generic food
 * remains a valid deterministic fallback.
 */
export function alternativeAgreementCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  if (projection.alternative_groups.length === 0) return 0;
  let agreement = 0;
  for (const branch of projection.alternative_groups) {
    if (branch.length === 0) continue;
    let all = true;
    for (const token of branch) {
      if (!candidateHasEquivalent(candidateTokens, token)) {
        all = false;
        break;
      }
    }
    if (all) agreement += 1;
  }
  return agreement;
}

/**
 * Number of UNREQUESTED form tokens present on the candidate (`sandwich`,
 * `sauce`, `powder`, `juice`, ...). A candidate that adds an unrequested form is
 * a different preparation/product form, not merely an ordinary variety sibling,
 * so it must never be chosen as a portion-aware tie sibling.
 */
export function unrequestedFormTokenCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  const requested = new Set(projection.form_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  let count = 0;
  for (const token of candidateTokens) {
    if (requested.has(token)) continue;
    if (FORM_TOKENS.has(token)) count += 1;
  }
  return count;
}

/**
 * Bounded COMPOUND-FOOD demotion. Counts candidate tokens that (a) are not
 * requested, (b) are not recognized descriptors/qualifiers/forms, and (c) are
 * immediately adjacent to a matched anchor token. This is what demotes
 * `Peanut butter` for a plain `butter` query without penalizing
 * `Butter, stick, unsalted`.
 */
export function compoundPenaltyCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  const anchorTokens: string[] = [];
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) anchorTokens.push(accepted);
  }
  if (anchorTokens.length === 0) return 0;

  const anchorIsCategory = anchorTokens.some((anchor) => CATEGORY_TOKENS.has(anchor));
  let penalty = 0;
  for (let i = 0; i < candidateTokens.length; i += 1) {
    if (!anchorTokens.some((anchor) => tokensMatch(candidateTokens[i], anchor))) continue;
    for (const offset of [-1, 1]) {
      const neighbor = candidateTokens[i + offset];
      if (!neighbor) continue;
      // Numeric qualifiers (`Flour, 00`) are never compound modifiers.
      if (/^\d+(?:\.\d+)?$/.test(neighbor)) continue;
      if (tokenInSet([...requested], neighbor)) continue;
      if (DESCRIPTOR_TOKENS.has(neighbor)) continue;
      // A category head BEFORE a NON-category anchor is a USDA category, not a
      // compound modifier (`Cheese, cheddar`, `Peppers, jalapenos`) — UNLESS it
      // is itself a known compound prefix (`Bread, rice`, `Apple butter`). When
      // the anchor is itself a category word, a preceding category word is a
      // different food (`Bread, onion`). A category word AFTER the anchor is
      // also a different food (`Bread, cheese`).
      if (
        offset === -1 &&
        !anchorIsCategory &&
        CATEGORY_TOKENS.has(neighbor) &&
        !COMPOUND_PREFIX_TOKENS.has(neighbor)
      ) {
        continue;
      }
      penalty += 1;
    }
  }
  return penalty;
}

/**
 * Bounded FOOD-COMPOUND count. Like `compoundPenaltyCount`, but counts ONLY a
 * compound modifier that is itself a FOOD noun (`milk` in `Rice milk`, `peanut`
 * in `Peanut butter`, `corn` in `Cream style corn`). A non-food compound
 * modifier (`double` in `baking powder, double-acting`) is a descriptor, not a
 * composed product, so it does NOT count. Used by the best-effort default
 * authority to block composed products without blocking ordinary descriptor
 * prose.
 */
export function compoundProductPenaltyCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  const anchorTokens: string[] = [];
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) anchorTokens.push(accepted);
  }
  if (anchorTokens.length === 0) return 0;

  let penalty = 0;
  for (let i = 0; i < candidateTokens.length; i += 1) {
    if (!anchorTokens.some((anchor) => tokensMatch(candidateTokens[i], anchor))) continue;
    for (const offset of [-1, 1]) {
      const neighbor = candidateTokens[i + offset];
      if (!neighbor) continue;
      if (/^\d+(?:\.\d+)?$/.test(neighbor)) continue;
      if (requested.has(neighbor)) continue;
      if (DESCRIPTOR_TOKENS.has(neighbor)) continue;
      if (!CATEGORY_TOKENS.has(neighbor) && !COMPOUND_PREFIX_TOKENS.has(neighbor)) continue;
      penalty += 1;
    }
  }
  return penalty;
}

/**
 * Bounded UNREQUESTED-VARIANT count. Counts candidate material state/preservation
 * qualifiers (`dried`, `canned`, `smoked`, ...) that the query did NOT request.
 * A candidate with any such token is a materially altered food variant and is
 * never auto-selected (`Apple, dried` for `apple`, `Egg, whole, dried` for
 * `eggs`, `Milk, dry` for `milk`).
 */
export function unrequestedMaterialVariantCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  const requestedList = [...requested];
  let count = 0;
  for (const token of candidateTokens) {
    if (requested.has(token)) continue;
    if (!MATERIAL_STATE_TOKENS.has(token)) continue;
    // An equivalent requested state (`powdered` ~ `dry`) is not an alteration.
    if (requestedList.some((requestedToken) => tokensEquivalent(requestedToken, token))) continue;
    count += 1;
  }
  return count;
}

/**
 * Bounded UNREQUESTED-COOKING-METHOD count. Counts candidate cooking/preparation
 * states (`fried`, `baked`, `boiled`, `scrambled`, `poached`, generic `cooked`,
 * ...) that the query did NOT request. A bare family query must not invent a
 * material preparation state merely because the record carries NS/NFS wording
 * or wins the FDC-id tie-break (`Egg, whole, fried, NS as to fat` for `egg`).
 * An explicitly requested specific method (`fried eggs`) also satisfies the
 * generic `cooked` state, so `Egg, whole, cooked, fried` stays authoritative.
 */
export function unrequestedCookingMethodCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  let requestsSpecificMethod = false;
  let requestsCooked = false;
  for (const token of requested) {
    if (!COOKING_METHOD_TOKENS.has(token)) continue;
    if (token === 'cooked') requestsCooked = true;
    else requestsSpecificMethod = true;
  }
  // A requested specific method implies the generic `cooked` state.
  const cookedSatisfied = requestsCooked || requestsSpecificMethod;
  let count = 0;
  for (const token of candidateTokens) {
    if (!COOKING_METHOD_TOKENS.has(token)) continue;
    if (token === 'cooked') {
      if (!cookedSatisfied) count += 1;
      continue;
    }
    if (requested.has(token)) continue;
    count += 1;
  }
  return count;
}

/**
 * FOOD-FAMILY MISMATCH. 1 when the candidate is not the requested food family:
 *
 *   - a DERIVED COMPONENT names an unrequested rendered fat/animal part
 *     (`Fat, chicken`, `Chicken skin`, `Beef tallow` for `chicken`/`beef`);
 *   - when the query EXPLICITLY requests a derived component (`beef fat`,
 *     `pork fat`, `chicken skin`), a candidate that merely contains the word as
 *     a composition descriptor (`Beef, steak, ribeye, lean and fat eaten`) is a
 *     mismatch: the component must be structural (head or immediately after the
 *     requested food);
 *   - the candidate HEAD is a composed PRODUCT/DISH head (`Dessert topping`,
 *     `Candies`, `Head cheese`, `Taquitos`, `Soup`);
 *   - the candidate HEAD is a FOREIGN food token (a food-like token that is
 *     neither the requested core identity nor a benign category/descriptor/form)
 *     so a bare family query never auto-selects a composed/coated dish that
 *     merely contains the requested token somewhere (`Chicken, ..., fried,
 *     flour` for `flour`, `Eggplant with cheese and tomato sauce` for
 *     `tomato sauce`).
 *
 * Bounded and explainable; it never removes a candidate from matching, it only
 * disqualifies it from automatic authority. Explicit compound queries still work
 * because an exact token-multiset match is authorized independently.
 */
export function familyMismatchCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  if (candidateTokens.length === 0) return 0;

  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  // OR-alternative modifiers (`brioche`, `potato`) are requested candidate
  // intent: a subtype-head record (`Brioche bun`) is the requested family, not a
  // foreign food.
  for (const branch of projection.alternative_groups) {
    for (const token of branch) requested.add(token);
  }
  const requestedList = [...requested];
  const head = candidateTokens[0];
  // True when the QUERY itself asks for a derived component (`beef fat`,
  // `chicken skin`, `beef tallow`). In that case a candidate whose HEAD is a
  // generic derived-component head (`Fat, beef tallow`) is the component family,
  // not a foreign food.
  const queryWantsDerivedComponent = requestedList.some((token) =>
    DERIVED_COMPONENT_TOKENS.has(token)
  );

  // 1. Derived component. A component token is STRUCTURAL only when it is the
  //    candidate head (`Fat, chicken`, `Fat, beef tallow`) or immediately
  //    follows a requested food token (`Chicken skin`). A composition descriptor
  //    (`Beef, steak, ribeye, lean and fat eaten`, `... / 20% fat`) is NOT a
  //    rendered component. When the query explicitly requests the component, a
  //    candidate that only carries it as a composition descriptor is a
  //    food-family mismatch (`beef fat` must never become ribeye).
  for (let i = 0; i < candidateTokens.length; i += 1) {
    const token = candidateTokens[i];
    if (!DERIVED_COMPONENT_TOKENS.has(token)) continue;
    const componentRequested =
      requested.has(token) ||
      requestedList.some((requestedToken) => tokensEquivalent(requestedToken, token));
    const previous = candidateTokens[i - 1];
    const structural =
      i === 0 ||
      (previous !== undefined &&
        requestedList.some((requestedToken) => tokensMatch(requestedToken, previous)));
    if (componentRequested) {
      if (!structural) return 1;
      continue;
    }
    if (i === 0) {
      if (queryWantsDerivedComponent) continue;
      return 1;
    }
    if (structural) return 1;
  }

  // 2. Composed product/dish head.
  if (PRODUCT_HEAD_TOKENS.has(head)) {
    let headIsRequested = false;
    for (const core of projection.core_tokens) {
      if (tokensMatch(head, core)) {
        headIsRequested = true;
        break;
      }
    }
    if (!headIsRequested) return 1;
  }

  // 3. Composed `with`/`without` dish. A candidate prepared `with <other food>`
  //    is a composed product, not the requested family (`Rice, cooked, with
  //    milk`, `Egg omelet, with cheese and tomatoes`, `Cheese, cottage, with
  //    vegetables`). A benign grammar tail (`with added vitamin D`) is exempt,
  //    and an explicit `with` query is honored.
  if (!requested.has('with') && !requested.has('without')) {
    for (let i = 0; i < candidateTokens.length; i += 1) {
      const token = candidateTokens[i];
      if (token !== 'with' && token !== 'without') continue;
      // Skip benign descriptors/colors/generic/noise so `with dark green
      // vegetables` is still recognised as a composed dish. A fortification tail
      // (`with added vitamin D`) is benign and ends the scan.
      let j = i + 1;
      let fortification = false;
      while (j < candidateTokens.length) {
        const current = candidateTokens[j];
        if (FORTIFICATION_TOKENS.has(current)) {
          fortification = true;
          break;
        }
        if (
          DESCRIPTOR_TOKENS.has(current) ||
          GENERIC_TOKENS.has(current) ||
          NOISE_TOKENS.has(current) ||
          /^\d+(?:\.\d+)?$/.test(current)
        ) {
          j += 1;
          continue;
        }
        break;
      }
      if (fortification) continue;
      const next = candidateTokens[j];
      if (!next) continue;
      if (requested.has(next)) continue;
      if (DESCRIPTOR_TOKENS.has(next) || GENERIC_TOKENS.has(next) || NOISE_TOKENS.has(next)) continue;
      if (/^\d+(?:\.\d+)?$/.test(next)) continue;
      return 1;
    }
  }

  // 3b. Composed conjunction dish. A candidate whose HEAD is a different food and
  //     that joins foods with an unrequested `and` (`Beans and white rice` for
  //     `rice`) is a composed dish. The head-requested exemption preserves
  //     legitimate compound names (`Cream, half and half`, `Bread and butter
  //     pickles` for `pickles`).
  if (!requested.has('and') && !requested.has(head)) {
    for (const token of candidateTokens) {
      if (token === 'and') return 1;
    }
  }

  // 4. Foreign head. A food-like head that is neither requested nor benign is a
  //    different food family.
  if (!requested.has(head)) {
    let headMatchesCore = false;
    for (const core of projection.core_tokens) {
      if (tokensMatch(head, core)) {
        headMatchesCore = true;
        break;
      }
    }
    const benignHead =
      headMatchesCore ||
      CATEGORY_TOKENS.has(head) ||
      DESCRIPTOR_TOKENS.has(head) ||
      GENERIC_TOKENS.has(head) ||
      BENIGN_GRAMMAR_TOKENS.has(head) ||
      BENIGN_VARIETY_HEAD_TOKENS.has(head) ||
      NOISE_TOKENS.has(head);
    if (!benignHead) return 1;
  }

  return 0;
}

/**
 * Closed PREPARED-PRODUCT / DISH form modifiers. A candidate that carries one of
 * these immediately next to a requested food token is a prepared product built
 * from that food (`Cornmeal stick`, `Cornmeal mush`, `Cornmeal fritter`), not the
 * plain food family.
 *
 * This is deliberately NOT the same as an ordinary form word (`powder`, `flakes`)
 * nor a packaging/retail form of a foundational single food (`Butter, stick,
 * unsalted`). The demotion applies ONLY to SURVEY (FNDDS) prepared-dish records,
 * because a foundational/SR-Legacy record with the same modifier is the food
 * itself in that form. It never removes a token from matching; it only demotes
 * the composed product below the plain family. An explicitly requested form
 * (`cornmeal mush`, `1 stick butter`) is honored.
 */
const PREPARED_PRODUCT_FORM_TOKENS: ReadonlySet<string> = new Set([
  'stick',
  'sticks',
  'mush',
  'fritter',
  'fritters',
  'porridge',
  'cake',
  'cakes',
  'pudding',
  'puddings',
  'loaf',
  'loaves',
]);

/**
 * Bounded PREPARED-PRODUCT demotion. Counts an unrequested prepared-dish form
 * modifier (`stick`, `mush`, `fritter`, `porridge`, `cake`, `pudding`, `loaf`)
 * that is immediately adjacent to a matched anchor on a SURVEY (FNDDS) record.
 * A foundational/SR-Legacy record is never demoted this way, so
 * `Butter, stick, unsalted` remains the ordinary form of butter.
 */
export function preparedProductFormCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection,
  dataType: string
): number {
  if (dataType !== 'fndds') return 0;
  if (candidateTokens.length === 0) return 0;

  const anchorTokens: string[] = [];
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) anchorTokens.push(accepted);
  }
  if (anchorTokens.length === 0) return 0;

  const requested = new Set<string>([
    ...projection.food_tokens,
    ...projection.qualifier_tokens,
    ...projection.form_tokens,
    ...projection.size_qualifiers,
    ...projection.preparation_qualifiers,
  ]);

  let count = 0;
  for (let i = 0; i < candidateTokens.length; i += 1) {
    const token = candidateTokens[i];
    if (!PREPARED_PRODUCT_FORM_TOKENS.has(token)) continue;
    if (requested.has(token)) continue;
    const previous = candidateTokens[i - 1];
    const next = candidateTokens[i + 1];
    const adjacentToAnchor =
      (previous !== undefined && anchorTokens.some((anchor) => tokensMatch(previous, anchor))) ||
      (next !== undefined && anchorTokens.some((anchor) => tokensMatch(next, anchor)));
    if (!adjacentToAnchor) continue;
    count += 1;
  }
  return count;
}

/**
 * Number of unrequested VARIETY / cultivar / color / type tokens. A candidate
 * with any such token is a specific variety rather than the generic family
 * member and is never auto-selected for a generic query (`Cheese, blue`,
 * `Tomato, roma`, `Rice, black`, `Flour, whole wheat`). Explicitly requested
 * varieties remain authoritative.
 */
export function unrequestedVarietyCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  // An explicit generic/NS/NFS candidate is the unspecified family member; the
  // variants it enumerates (`Cream, NS as to light, heavy, or half and half`)
  // are options, not a chosen variety, so they must not demote it.
  if (genericMarkerCount(candidateTokens) > 0) return 0;
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  let count = 0;
  for (const token of candidateTokens) {
    if (requested.has(token)) continue;
    if (VARIETY_TOKENS.has(token)) count += 1;
  }
  return count;
}

/**
 * Number of unrequested MATERIAL variety tokens (distinctive proper-noun
 * cultivars such as `tan`, `carioca`, `pinto`). Unlike an ordinary color/level
 * variety, a named cultivar is a genuinely different food within the family, so
 * a bare-family query must not auto-invent one. An explicit cultivar query
 * (`pinto beans`) is honored. Never removes a token from matching.
 */
export function unrequestedMaterialVarietyCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  let count = 0;
  for (const token of candidateTokens) {
    if (requested.has(token)) continue;
    if (MATERIAL_VARIETY_TOKENS.has(token)) count += 1;
  }
  return count;
}

/**
 * Closed display-only LEVEL/type subtype words. These are the ordinary fat/level
 * or type classes that a bare family query must not silently invent
 * (`whole wheat` for `flour`, `heavy`/`light`/`half and half` for `cream`,
 * `whole`/`nonfat` for `powdered milk`). This is a DISPLAY demotion only; the
 * auto-authority equivalence key deliberately omits it and instead relies on the
 * runner-up materiality contract.
 */
const SUBTYPE_TOKENS: ReadonlySet<string> = new Set([
  'whole',
  'skim',
  'lowfat',
  'nonfat',
  'low',
  'reduced',
  'light',
  'heavy',
  'half',
  'whipping',
  'whipped',
  'diet',
  'free',
]);

/**
 * Subtype tokens that demote a specific DISPLAY candidate but do NOT by
 * themselves make two candidates ambiguous for AUTO authority. `whole` is the
 * ordinary member for many foods (`Egg, whole, raw`, `Tomatoes, whole`), and the
 * health-claim modifiers are dietary variants rather than different foods.
 */
const NON_BLOCKING_SUBTYPE_TOKENS: ReadonlySet<string> = new Set([
  'whole',
  'lowfat',
  'low',
  'reduced',
  'light',
  'diet',
  'free',
]);

/**
 * Number of unrequested level/type subtype tokens plus unrequested NUMERIC
 * subtype tokens (e.g. the `00` in `Flour, 00`). A bare family query must not
 * silently invent a fat class, a grind, or a type; this demotes such a candidate
 * below the ordinary generic/all-purpose family record while explicitly
 * requested subtypes (`00 flour`, `whole powdered milk`) are honored. An
 * explicit generic/NS/NFS candidate is never demoted by the options it lists.
 */
export function unrequestedSubtypeCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  if (genericMarkerCount(candidateTokens) > 0) return 0;
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  const requestedList = [...requested];
  const numericRequested = new Set(projection.numeric_qualifiers);
  let count = 0;
  for (const token of candidateTokens) {
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      if (!numericRequested.has(token)) count += 1;
      continue;
    }
    if (requested.has(token)) continue;
    if (!SUBTYPE_TOKENS.has(token)) continue;
    if (requestedList.some((requestedToken) => tokensEquivalent(requestedToken, token))) continue;
    count += 1;
  }
  return count;
}

/** Number of generic family markers (`nfs`, `ns`, `unspecified`) present. */
export function genericMarkerCount(candidateTokens: ReadonlyArray<string>): number {
  let count = 0;
  for (const token of candidateTokens) {
    if (GENERIC_MARKER_TOKENS.has(token)) count += 1;
  }
  return count;
}

/**
 * True when two candidate token sequences are MATERIALLY different foods for the
 * runner-up ambiguity contract. Differences confined to benign descriptors
 * (colors, sizes, `nfs`, `raw`, `fresh`, variety names) are NOT material.
 */
export function candidateMateriallyDiffers(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): boolean {
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  const materialOf = (tokens: ReadonlyArray<string>): Set<string> => {
    const out = new Set<string>();
    for (const token of tokens) {
      if (requested.has(token)) continue;
      if (MATERIAL_QUALIFIER_TOKENS.has(token)) out.add(token);
    }
    return out;
  };
  const coreOf = (tokens: ReadonlyArray<string>): string[] => {
    const out: string[] = [];
    for (const token of tokens) {
      if (requested.has(token)) continue;
      // Numeric qualifiers (`80 20`) are agreement evidence, never core identity.
      if (/^\d+(?:\.\d+)?$/.test(token)) continue;
      if (DESCRIPTOR_TOKENS.has(token) || GENERIC_TOKENS.has(token)) continue;
      if (BENIGN_GRAMMAR_TOKENS.has(token)) continue;
      if (MATERIAL_QUALIFIER_TOKENS.has(token)) continue;
      out.push(token);
    }
    return out.sort();
  };
  const sameMultiset = (x: ReadonlyArray<string>, y: ReadonlyArray<string>): boolean => {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
    return true;
  };
  if (!sameMultiset(coreOf(a), coreOf(b))) return true;
  const ma = materialOf(a);
  const mb = materialOf(b);
  if (ma.size !== mb.size) return true;
  for (const token of ma) if (!mb.has(token)) return true;
  return false;
}

/**
 * True when two candidates differ in an UNREQUESTED MATERIAL SUBTYPE for the
 * AUTO-AUTHORITY runner-up contract. Only material qualifier/state tokens
 * (`whole`, `nonfat`, `heavy`, `half`, `salted`, `dried`, `enriched`, ...) and
 * numeric subtypes (`00`) count. Benign description differences (verbose USDA
 * wording, extra descriptors, a `with <dish>` tail, cooking method, color) do
 * NOT make two candidates ambiguous; those are handled by the coarse identity
 * key and the composed/family rules. This is what keeps a bare `cream` from
 * auto-selecting `Cream, heavy` over `Cream, light`/`half and half` without
 * over-blocking every verbose sibling record.
 */
export function candidateSubtypeDiffers(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): boolean {
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  const requestedList = [...requested];
  const subtypeOf = (tokens: ReadonlyArray<string>): Set<string> => {
    const out = new Set<string>();
    for (const token of tokens) {
      if (requested.has(token)) continue;
      if (requestedList.some((requestedToken) => tokensEquivalent(requestedToken, token))) continue;
      // A zero-padded numeric type token (`00` flour) is a specific grind. A
      // plain fat-percentage token (`2` from `2% milkfat`) is not treated as an
      // ambiguous subtype for auto authority.
      if (/^0\d+(?:\.\d+)?$/.test(token)) {
        out.add(token);
        continue;
      }
      if (!MATERIAL_QUALIFIER_TOKENS.has(token)) continue;
      // `whole` is the ordinary/default member for many foods (whole egg, whole
      // tomato), and health-claim modifiers (`lowfat`, `reduced`, `light`) do
      // not by themselves make two records ambiguous foods. They still demote a
      // specific top in DISPLAY ranking, but they do not block a plain/generic
      // automatic choice.
      if (NON_BLOCKING_SUBTYPE_TOKENS.has(token)) continue;
      out.add(token);
    }
    return out;
  };
  const sa = subtypeOf(a);
  const sb = subtypeOf(b);
  if (sa.size !== sb.size) return true;
  for (const token of sa) if (!sb.has(token)) return true;
  return false;
}
