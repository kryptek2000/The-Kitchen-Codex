/**
 * The Kitchen Codex — Household-Portion Registry (registry-track Phase 5):
 * candidate / usefulness census (repaired).
 *
 * TEST-ONLY deterministic diagnostic table. It records, for every priority food
 * and investigated amount family, exactly one outcome:
 *
 *   - `included`                 production records exist in the initial dataset;
 *   - `already_resolved`         the existing authenticated count-portion path
 *                                deterministically answers the conversion for the
 *                                fresh-matched identity (no registry record added);
 *   - `no_authenticated_portion` the pinned bundle has no amount-bearing portion
 *                                that can serve the conversion truthfully;
 *   - `ambiguous_or_conflicting` the bundle exposes materially different
 *                                authenticated values that must not be averaged
 *                                or silently selected;
 *   - `state_or_size_mismatch`   the available portion's state/size semantics do
 *                                not match the ordinary food identity;
 *   - `identity_unsuitable`      the candidate is a container/package, a
 *                                reference amount (RACC/NLEA), a prepared dish,
 *                                or otherwise not a food-specific household unit;
 *   - `duplicate_key`            the candidate would duplicate an existing
 *                                registry lookup key.
 *
 * KEYS. A census family key carries every authority dimension needed to prevent
 * future collisions:
 *
 *   `${fdcSet}|${food_key}|${unit}|${size}|${state}`
 *
 * where `fdcSet` is the numerically sorted bound-FDC set joined with `+`, and a
 * null size/state is written `null`. A census entry may cover several registry
 * lookup tuples (one per size), so the test maps every family entry to the exact
 * registry keys it covers and asserts the union is exactly the dataset inventory.
 */

export type HouseholdPhase5CensusOutcome =
  | 'included'
  | 'already_resolved'
  | 'no_authenticated_portion'
  | 'ambiguous_or_conflicting'
  | 'state_or_size_mismatch'
  | 'identity_unsuitable'
  | 'duplicate_key';

/** One authority tuple covered by a census family entry. */
export interface HouseholdPhase5CensusFamily {
  readonly food_key: string;
  readonly household_unit: string;
  readonly size_class: string | null;
  readonly requires_state: string | null;
  readonly fdc_ids: ReadonlyArray<number>;
}

/** Stable census key: bound-FDC set + food key + unit + size + required state. */
export function householdPhase5CensusKey(family: HouseholdPhase5CensusFamily): string {
  const fdcSet = [...family.fdc_ids].sort((a, b) => a - b).join('+');
  return `${fdcSet}|${family.food_key}|${family.household_unit}|${family.size_class ?? 'null'}|${
    family.requires_state ?? 'null'
  }`;
}

export interface HouseholdPhase5CensusEntry {
  readonly candidate: string;
  readonly outcome: HouseholdPhase5CensusOutcome;
  readonly reason: string;
  readonly families?: ReadonlyArray<HouseholdPhase5CensusFamily>;
}

export const HOUSEHOLD_PHASE5_CANDIDATE_CENSUS: ReadonlyArray<HouseholdPhase5CensusEntry> =
  Object.freeze([
    // --- priority: included fallbacks -------------------------------------
    {
      candidate: 'garlic clove',
      outcome: 'included',
      reason:
        'The current count path withholds mass because the bundle has two non-identical clove portions ' +
        '(1 clove = 3 g and 3 cloves = 9 g); the registry records the exact per-unit 3 g. Primary ' +
        'support is source FDC 169230: 1 clove = 3 g and 3 cloves = 9 g, an identical 3 g per-clove ' +
        'relationship. FNDDS 2709786 carries an amount-less 3 g clove-shaped portion and is only a gram ' +
        'match, not an independent amount-bearing conversion; its category difference is a survey-' +
        'grouping artifact and is disclosed in the cross-FDC rationale.',
      families: [
        {
          food_key: 'garlic',
          household_unit: 'clove',
          size_class: null,
          requires_state: null,
          fdc_ids: [169230, 2709786],
        },
      ],
    },
    {
      candidate: 'tomato, food-specific small/medium/large items',
      outcome: 'included',
      reason:
        'The ordinary matched identity for tomatoes is FNDDS 2709719, whose portions omit `amount`; the ' +
        'SR Legacy 170457 whole sizes (91/123/182 g) are bound as a deliberate cross-identity fallback ' +
        'with a positive whole-tomato equivalence rationale. The SR identity’s own explicit-size phrase ' +
        'is also resolvable by the count path.',
      families: [
        { food_key: 'tomato', household_unit: 'item', size_class: 'small', requires_state: null, fdc_ids: [170457, 2709719] },
        { food_key: 'tomato', household_unit: 'item', size_class: 'medium', requires_state: null, fdc_ids: [170457, 2709719] },
        { food_key: 'tomato', household_unit: 'item', size_class: 'large', requires_state: null, fdc_ids: [170457, 2709719] },
      ],
    },
    {
      candidate: 'bell pepper, food-specific small/medium/large items',
      outcome: 'included',
      reason:
        'The ordinary matched identities (Foundation 2258588 green / 2258590 red) expose only a RACC ' +
        'reference amount; the SR Legacy sweet-pepper whole sizes (74/119/164 g) are bound with a ' +
        'positive same-species green/red whole-pepper equivalence rationale. RACC is never used.',
      families: [
        { food_key: 'green bell pepper', household_unit: 'item', size_class: 'small', requires_state: null, fdc_ids: [170427, 2258588] },
        { food_key: 'green bell pepper', household_unit: 'item', size_class: 'medium', requires_state: null, fdc_ids: [170427, 2258588] },
        { food_key: 'green bell pepper', household_unit: 'item', size_class: 'large', requires_state: null, fdc_ids: [170427, 2258588] },
        { food_key: 'red bell pepper', household_unit: 'item', size_class: 'small', requires_state: null, fdc_ids: [170108, 2258590] },
        { food_key: 'red bell pepper', household_unit: 'item', size_class: 'medium', requires_state: null, fdc_ids: [170108, 2258590] },
        { food_key: 'red bell pepper', household_unit: 'item', size_class: 'large', requires_state: null, fdc_ids: [170108, 2258590] },
      ],
    },
    {
      candidate: 'cabbage, food-specific head portions',
      outcome: 'included',
      reason:
        'The ordinary matched identities (Foundation 2346407 green / 2346408 red) expose only a RACC ' +
        'reference amount; the SR Legacy head sizes (714/908/1248 g and 567/839/1134 g) are bound with a ' +
        'positive same-species/color whole-head equivalence rationale. FNDDS `1 head` = 900 g is not ' +
        'size-classified and is not bound; RACC is never used.',
      families: [
        { food_key: 'green cabbage', household_unit: 'head', size_class: 'small', requires_state: null, fdc_ids: [169975, 2346407] },
        { food_key: 'green cabbage', household_unit: 'head', size_class: 'medium', requires_state: null, fdc_ids: [169975, 2346407] },
        { food_key: 'green cabbage', household_unit: 'head', size_class: 'large', requires_state: null, fdc_ids: [169975, 2346407] },
        { food_key: 'red cabbage', household_unit: 'head', size_class: 'small', requires_state: null, fdc_ids: [169977, 2346408] },
        { food_key: 'red cabbage', household_unit: 'head', size_class: 'medium', requires_state: null, fdc_ids: [169977, 2346408] },
        { food_key: 'red cabbage', household_unit: 'head', size_class: 'large', requires_state: null, fdc_ids: [169977, 2346408] },
      ],
    },
    {
      candidate: 'egg, food-specific size portions',
      outcome: 'included',
      reason:
        'The generic FNDDS `1 egg` = 50 g path ignores requested size; on the SR Legacy identity the ' +
        'explicit-size phrase is blocked because the food name supplies the count noun `egg`. The five ' +
        'authenticated sizes (38/44/50/56/63 g) are recorded; `extra large` is canonicalized once to `xl`.',
      families: [
        { food_key: 'egg', household_unit: 'item', size_class: 'small', requires_state: null, fdc_ids: [171287] },
        { food_key: 'egg', household_unit: 'item', size_class: 'medium', requires_state: null, fdc_ids: [171287] },
        { food_key: 'egg', household_unit: 'item', size_class: 'large', requires_state: null, fdc_ids: [171287] },
        { food_key: 'egg', household_unit: 'item', size_class: 'xl', requires_state: null, fdc_ids: [171287] },
        { food_key: 'egg', household_unit: 'item', size_class: 'jumbo', requires_state: null, fdc_ids: [171287] },
      ],
    },
    {
      candidate: 'butter, stick, unsalted',
      outcome: 'included',
      reason:
        'The ordinary matched Foundation identity 789828 carries no portions; SR Legacy 173430 declares ' +
        '`1 stick` = 113 g and is bound with a positive same-food/same-variety/stick-form equivalence ' +
        'rationale. The salted identity’s own stick conversion is already resolved and is not duplicated.',
      families: [
        {
          food_key: 'unsalted butter',
          household_unit: 'stick',
          size_class: null,
          requires_state: null,
          fdc_ids: [173430, 789828],
        },
      ],
    },
    {
      candidate: 'mushrooms, white, food-specific small/medium/large items',
      outcome: 'included',
      reason:
        'The ordinary matched FNDDS identity 2709793 exposes `1 whole` = 18 g without a declared amount; ' +
        'the SR Legacy item sizes (10/18/23 g) are bound with a positive whole-mushroom equivalence ' +
        'rationale, and the FNDDS whole value exactly corroborates the medium record.',
      families: [
        { food_key: 'white mushroom', household_unit: 'item', size_class: 'small', requires_state: null, fdc_ids: [169251, 2709793] },
        { food_key: 'white mushroom', household_unit: 'item', size_class: 'medium', requires_state: null, fdc_ids: [169251, 2709793] },
        { food_key: 'white mushroom', household_unit: 'item', size_class: 'large', requires_state: null, fdc_ids: [169251, 2709793] },
      ],
    },
    {
      candidate: 'peach, food-specific small/medium/large items',
      outcome: 'included',
      reason:
        'The ordinary matched FNDDS identity 2709249 exposes `1 fruit` = 150 g without a declared amount; ' +
        'the SR Legacy sizes (130/150/175 g) are bound with a positive whole-fruit equivalence rationale, ' +
        'and the FNDDS fruit value exactly corroborates the medium record.',
      families: [
        { food_key: 'peach', household_unit: 'item', size_class: 'small', requires_state: null, fdc_ids: [169928, 2709249] },
        { food_key: 'peach', household_unit: 'item', size_class: 'medium', requires_state: null, fdc_ids: [169928, 2709249] },
        { food_key: 'peach', household_unit: 'item', size_class: 'large', requires_state: null, fdc_ids: [169928, 2709249] },
      ],
    },
    {
      candidate: 'zucchini, food-specific small/medium/large items',
      outcome: 'included',
      reason:
        'The ordinary zucchini phrase currently reaches no automatic identity; the SR Legacy 169291 whole ' +
        'sizes (118/196/323 g) are recorded as the truthful fallback for the eligible zucchini identity ' +
        'once Phase 6 fixes identity selection.',
      families: [
        { food_key: 'zucchini', household_unit: 'item', size_class: 'small', requires_state: null, fdc_ids: [169291] },
        { food_key: 'zucchini', household_unit: 'item', size_class: 'medium', requires_state: null, fdc_ids: [169291] },
        { food_key: 'zucchini', household_unit: 'item', size_class: 'large', requires_state: null, fdc_ids: [169291] },
      ],
    },

    // --- rejected: generic onion and lime (Phase 5 repair) ----------------
    {
      candidate: 'onion, yellow, whole item (Foundation 790646)',
      outcome: 'ambiguous_or_conflicting',
      reason:
        'REMOVED IN REPAIR. Foundation `1 Onion, Edible` = 143 g is a sampled specimen mass, not a ' +
        'standardized generic onion; same-food SR Legacy portions range materially by size (small 70 g / ' +
        'medium 110 g / large 150 g) and FNDDS `1 whole` = 148 g differs again. A null-size universal ' +
        'item mass cannot be truthfully derived from one specimen, and no reclassification is made.',
      families: [],
    },
    {
      candidate: 'onion, red, whole item (Foundation 790577)',
      outcome: 'ambiguous_or_conflicting',
      reason:
        'REMOVED IN REPAIR. Foundation `1 Onion, Edible` = 197 g is a sampled specimen mass that ' +
        'conflicts with the broader same-food size landscape (SR 70/110/150 g; FNDDS whole 148 g). No ' +
        'null-size universal item mass is derivable and none is retained.',
      families: [],
    },
    {
      candidate: 'lime, food-specific item portion',
      outcome: 'state_or_size_mismatch',
      reason:
        'REMOVED IN REPAIR. SR 168155 declares `fruit (2" dia)` = 67 g: the measure carries explicit ' +
        'physical size evidence (a 2-inch fruit) that cannot truthfully be represented as ' +
        '`size_class: null`, and FNDDS 2709170 declares 65 g for the same identity. No null-size record ' +
        'is retained.',
      families: [],
    },

    // --- priority: already resolved ---------------------------------------
    {
      candidate: 'onion, SR Legacy sized items (small/medium/large)',
      outcome: 'already_resolved',
      reason:
        '`1 medium onion` / `1 small onion` / `2 large onions` deterministically resolve through the ' +
        'authenticated size-only count path (70/110/150 g) once the food is matched/confirmed.',
    },
    {
      candidate: 'carrot, food-specific small/medium/large items',
      outcome: 'already_resolved',
      reason:
        '`2 medium carrots` and `3 large carrots` resolve through the authenticated size count path ' +
        '(50/61/72 g) once the food is matched/confirmed; the size-unspecified phrase has no ' +
        'size-unspecified authenticated portion.',
    },
    {
      candidate: 'celery, food-specific stalk sizes',
      outcome: 'already_resolved',
      reason:
        '`2 medium celery stalks` resolves through the authenticated size count path (40 g medium) once ' +
        'the food is matched/confirmed.',
    },
    {
      candidate: 'potato, food-specific variety sizes (russet/red)',
      outcome: 'already_resolved',
      reason:
        'The SR Legacy variety identities resolve their explicit-size phrases (170/213/369 g) once the ' +
        'food is matched/confirmed.',
    },
    {
      candidate: 'cabbage, SR Legacy head sizes on its own identity',
      outcome: 'already_resolved',
      reason:
        'The food identity may match, and the authenticated head-size portion becomes usable after the ' +
        'required explicit food confirmation/review; the existing portion path is therefore sufficient ' +
        'after confirmation and a duplicate registry record is unnecessary. No current automatic ' +
        'resolution is implied (the live status before confirmation is `needs_amount`).',
    },
    {
      candidate: 'cauliflower, food-specific head sizes',
      outcome: 'already_resolved',
      reason:
        'The food identity may match, and the authenticated head-size portion (265/588/840 g) becomes ' +
        'usable after the required explicit food confirmation/review; the existing portion path is ' +
        'sufficient after confirmation, so a duplicate registry record is unnecessary. No current ' +
        'automatic resolution is implied (the live status before confirmation is `needs_amount`).',
    },
    {
      candidate: 'pear, food-specific small/medium/large items',
      outcome: 'ambiguous_or_conflicting',
      reason:
        'The FNDDS ordinary identity 2709254 declares `1 fruit` = 180 g while SR Legacy 169118 declares ' +
        'medium = 178 g; the two authenticated values differ and must not be silently selected.',
    },
    {
      candidate: 'bread slice',
      outcome: 'already_resolved',
      reason:
        '`2 slices bread` resolves through the authenticated slice portion (29 g) on the matched ' +
        'wheat-bread identity once the food is matched/confirmed.',
    },
    {
      candidate: 'bacon slice',
      outcome: 'already_resolved',
      reason: '`4 slices bacon` resolves through the authenticated slice portion (28 g).',
    },
    {
      candidate: 'butter, stick, salted',
      outcome: 'already_resolved',
      reason: 'The SR Legacy salted identity resolves `1 stick` = 113 g; no duplicate added.',
    },
    {
      candidate: 'lettuce head / spinach bunch / broccoli stalk-bunch',
      outcome: 'already_resolved',
      reason:
        'Authenticated head/bunch/stalk portions resolve these unit phrases once the food is ' +
        'matched/confirmed.',
    },

    // --- excluded ---------------------------------------------------------
    {
      candidate: 'onion, bare whole item (`1 onion`)',
      outcome: 'no_authenticated_portion',
      reason:
        'No amount-bearing size-unspecified whole-onion portion exists; FNDDS `1 whole` = 148 g omits ' +
        'the declared amount and is never used to invent one.',
    },
    {
      candidate: 'celery, bare stalks (`2 celery stalks`)',
      outcome: 'no_authenticated_portion',
      reason:
        'All three authenticated stalk portions declare a size class (small/medium/large); a ' +
        'size-unspecified stalk record cannot be derived truthfully.',
    },
    {
      candidate: 'carrot, bare items (`2 carrots, sliced`)',
      outcome: 'no_authenticated_portion',
      reason:
        'Only size-classified whole-carrot portions exist; a size-unspecified record is not derivable.',
    },
    {
      candidate: 'potato, ordinary NFS identity (`2 medium potatoes`)',
      outcome: 'no_authenticated_portion',
      reason:
        'FNDDS `Potato, NFS` portions omit declared amounts; binding a specific-variety value to the ' +
        'NFS identity would be a variety selection, and the Foundation russet identity is ' +
        'skin-state-incompatible.',
    },
    {
      candidate: 'lemon, food-specific item/size portions',
      outcome: 'ambiguous_or_conflicting',
      reason:
        'SR Legacy 167746 declares two materially different whole-fruit sizes (58 g and 84 g) with no ' +
        'closed size class; FNDDS declares 65 g. No single value may be silently selected.',
    },
    {
      candidate: 'orange, food-specific item/size portions',
      outcome: 'ambiguous_or_conflicting',
      reason:
        'FNDDS 2709171 declares `1 fruit` = 154 g while SR Legacy 169097 declares 131 g; the values ' +
        'differ and must not be averaged or silently selected.',
    },
    {
      candidate: 'banana, food-specific item/size portions',
      outcome: 'ambiguous_or_conflicting',
      reason:
        'FNDDS `1 banana` = 126 g, SR Legacy medium = 118 g, and SR Legacy NLEA serving = 126 g ' +
        '(not a household unit) do not agree on one authenticatable value.',
    },
    {
      candidate: 'white bread, specific `2 slices white bread` line',
      outcome: 'ambiguous_or_conflicting',
      reason:
        'SR Legacy 174924 declares multiple non-identical slice portions (29/25/20/15/12/9 g) and ' +
        'FNDDS 2707598 omits declared amounts; no deterministic value exists.',
    },
    {
      candidate: 'apple, food-specific item/size portions',
      outcome: 'state_or_size_mismatch',
      reason:
        'SR Legacy apple portions are `without skin`; the ordinary matched FNDDS identity is ' +
        'with-skin and its portions omit declared amounts. Skin state is an identity constraint.',
    },
    {
      candidate: 'cucumber, food-specific item/size portions',
      outcome: 'state_or_size_mismatch',
      reason:
        'With-peel raw cucumber FDC 168409 has amount-bearing portions, including a whole 8-1/4-inch ' +
        'cucumber at 301 g; peeled raw cucumber FDC 169225 also has amount-bearing portions ' +
        '(small/medium/large 158/201/280 g, slice 7 g, stick 9 g). Neither establishes a safe generic ' +
        'item conversion: the whole cucumber is a specific-sized specimen and must not become a ' +
        'null-size universal mass, and the current identity/state binding does not establish a safe ' +
        'generic item conversion. Exclusion is consistent with the onion and lime policy.',
    },
    {
      candidate: 'sweet potato, food-specific item/size portions',
      outcome: 'no_authenticated_portion',
      reason:
        'FNDDS sizes omit declared amounts; SR Legacy raw declares only a single 5-inch item ' +
        '(130 g) with no size classes and its sized portions are cooked/baked states.',
    },
    {
      candidate: 'green onions (`2 green onions, sliced`)',
      outcome: 'state_or_size_mismatch',
      reason:
        'The SR Legacy record is `young green, tops only` (stalk = 12 g) and FNDDS `1 whole` = 15 g ' +
        'omits a declared amount; neither matches the ordinary whole-green-onion identity.',
    },
    {
      candidate: 'parsley bunch',
      outcome: 'no_authenticated_portion',
      reason:
        '170416 declares only chopped-cup, tablespoon, and `10 sprigs` portions; no bunch portion ' +
        'exists (the sprig conversion itself resolves today).',
    },
    {
      candidate: 'thyme sprigs (`2 sprigs fresh thyme`)',
      outcome: 'no_authenticated_portion',
      reason: '173470 declares only teaspoon portions; no sprig portion exists.',
    },
    {
      candidate: 'summer squash (`2 summer squash`)',
      outcome: 'identity_unsuitable',
      reason:
        'The ordinary phrase auto-matches `Squash, summer, souffle`, a prepared dish; the SR Legacy ' +
        '`all varieties` sizes are not bound across that identity.',
    },
    {
      candidate: 'FNDDS portions that omit `amount`',
      outcome: 'identity_unsuitable',
      reason:
        'Derivation policy requires a declared positive amount and gram weight; an omitted amount is ' +
        'never invented (this defers many FNDDS item portions, e.g. `1 whole`).',
    },
    {
      candidate: 'RACC / NLEA serving portions',
      outcome: 'identity_unsuitable',
      reason: 'Reference amounts are not household count units and are never used.',
    },
    {
      candidate: 'can / package / jar / box / bag / bottle conversions',
      outcome: 'identity_unsuitable',
      reason:
        'Containers are forbidden by the Phase 4 contract; a recipe-authored net weight remains ' +
        'recipe-authored direct evidence and is outside this data phase.',
    },
    {
      candidate: 'generic density or generic container-weight tables',
      outcome: 'identity_unsuitable',
      reason: 'No density conversion, no generic mass, no web/AI/manufacturer values are admissible.',
    },
  ]);

/** Closed set of census outcomes (for completeness tests). */
export const HOUSEHOLD_PHASE5_CENSUS_OUTCOMES: ReadonlyArray<HouseholdPhase5CensusOutcome> =
  Object.freeze([
    'included',
    'already_resolved',
    'no_authenticated_portion',
    'ambiguous_or_conflicting',
    'state_or_size_mismatch',
    'identity_unsuitable',
    'duplicate_key',
  ]);
