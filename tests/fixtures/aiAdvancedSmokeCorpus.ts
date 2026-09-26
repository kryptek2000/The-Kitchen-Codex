/**
 * The Kitchen Codex — AI Advanced Nutrition smoke contract corpus (AI-0).
 *
 * A small, explicit contract corpus of the HARD cases AI Advanced Nutrition is
 * intended to solve later. AI-0 does NOT have to resolve them: the corpus pins
 * the semantic interpretation and the safety expectations BEFORE later phases,
 * so a future implementation cannot quietly change the meaning of these lines.
 *
 * Every case carries the uniform safety invariant `ai_must_not_author_mass`:
 * whatever the AI interprets, the authored amount remains the deterministic
 * parse's authority and the AI never supplies grams/FDC ids/nutrients.
 */

import type { AiAdvancedAmountKind, AiAdvancedUnitFamily } from '../../src/core/nutritionV2/aiAdvanced';

export interface AiAdvancedSmokeExpectation {
  /** Canonical amount-semantics class for the authored line. */
  readonly amount_kind: AiAdvancedAmountKind;
  /** Canonical unit family the interpretation should use. */
  readonly unit_family: AiAdvancedUnitFamily;
  /** Deterministic parse quantity kind, when pinned. */
  readonly parsed_quantity_kind?: 'exact' | 'range' | 'absent' | 'invalid';
  /** Deterministic measurement class, when pinned. */
  readonly parsed_measurement_kind?: 'mass' | 'volume' | 'count' | 'unknown';
  /** Count noun the interpretation should name, when applicable. */
  readonly count_noun?: string;
  /** Size-class wording the interpretation may fill, when applicable. */
  readonly size?: string;
  /** Physical-state wording the interpretation may name, when applicable. */
  readonly state?: string;
  /** Number of authored alternatives, when the line offers alternatives. */
  readonly alternative_count?: number;
  /** True when the interpretation must flag ambiguity. */
  readonly ambiguous?: boolean;
  /** Authored range endpoints the interpretation may echo (never author). */
  readonly range_endpoints?: { readonly lower: number; readonly upper: number };
  /** Permanent safety invariant (always true; explicit for auditability). */
  readonly ai_must_not_author_mass: true;
}

export interface AiAdvancedSmokeCase {
  readonly family: string;
  readonly line: string;
  readonly expectation: AiAdvancedSmokeExpectation;
  /** Bounded semantic food wording the interpretation is expected to use. */
  readonly semantic_food: string;
}

export const AI_ADVANCED_SMOKE_CORPUS: ReadonlyArray<AiAdvancedSmokeCase> = Object.freeze([
  {
    family: 'unsalted_butter_sticks',
    line: '1 stick unsalted butter',
    semantic_food: 'unsalted butter',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'household',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'count',
      count_noun: 'stick',
      state: 'unsalted',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'unsalted_butter_volume',
    line: '4 tbsp unsalted butter',
    semantic_food: 'unsalted butter',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'volume',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'volume',
      state: 'unsalted',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'heavy_cream_volume',
    line: '1 cup heavy cream',
    semantic_food: 'heavy cream',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'volume',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'volume',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'chuck_roast_written_range',
    line: '3-4 lb beef chuck roast, cut into 2"-3" chunks',
    semantic_food: 'beef chuck roast',
    expectation: {
      amount_kind: 'range',
      unit_family: 'mass',
      parsed_quantity_kind: 'range',
      parsed_measurement_kind: 'mass',
      range_endpoints: { lower: 3, upper: 4 },
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'provolone_parenthetical_total_mass_range',
    line: '3 to 4 slices provolone (about 75 to 100 grams in total)',
    semantic_food: 'provolone',
    expectation: {
      amount_kind: 'range',
      unit_family: 'mass',
      parsed_quantity_kind: 'range',
      parsed_measurement_kind: 'mass',
      count_noun: 'slice',
      range_endpoints: { lower: 75, upper: 100 },
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'onion',
    line: '1 large white onion',
    semantic_food: 'white onion',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'household',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'unknown',
      count_noun: 'onion',
      size: 'large',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'garlic_cloves',
    line: '3 cloves garlic, minced',
    semantic_food: 'garlic',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'count',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'count',
      count_noun: 'clove',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'shallots',
    line: '2 shallots',
    semantic_food: 'shallots',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'household',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'unknown',
      count_noun: 'shallot',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'oysters',
    line: '24 pieces fresh shucked oysters',
    semantic_food: 'oysters',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'count',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'count',
      count_noun: 'piece',
      state: 'fresh',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'mortadella_slices',
    line: '6 slices mortadella',
    semantic_food: 'mortadella',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'count',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'count',
      count_noun: 'slice',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'pickles',
    line: '4 pickles, sliced',
    semantic_food: 'pickles',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'household',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'unknown',
      count_noun: 'pickle',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'crushed_red_pepper_flakes',
    line: '1/4 teaspoon crushed red pepper flakes',
    semantic_food: 'crushed red pepper flakes',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'volume',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'volume',
      // Adversarial identity: must never become a fresh bell pepper.
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'cloves_ambiguity',
    line: '2 tsp whole cloves or 1/2 tbsp ground clove',
    semantic_food: 'cloves',
    expectation: {
      amount_kind: 'alternative',
      unit_family: 'volume',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'volume',
      alternative_count: 2,
      ambiguous: true,
      // The two alternatives must never be collapsed into one fabricated blend.
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'pinch',
    line: 'pinch dried basil',
    semantic_food: 'dried basil',
    expectation: {
      amount_kind: 'qualitative',
      unit_family: 'unknown',
      parsed_quantity_kind: 'absent',
      parsed_measurement_kind: 'unknown',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'handful',
    line: 'handful fresh spinach',
    semantic_food: 'fresh spinach',
    expectation: {
      amount_kind: 'qualitative',
      unit_family: 'unknown',
      parsed_quantity_kind: 'absent',
      parsed_measurement_kind: 'unknown',
      state: 'fresh',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'fresh_herb_wording',
    line: '2 tbsp fresh parsley, chopped',
    semantic_food: 'parsley',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'volume',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'volume',
      state: 'fresh',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'apple_cider_vinegar',
    line: '1/4 cup apple cider vinegar',
    semantic_food: 'apple cider vinegar',
    expectation: {
      amount_kind: 'exact',
      unit_family: 'volume',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'volume',
      ai_must_not_author_mass: true,
    },
  },
  {
    family: 'alternatives',
    line: '2 tbsp butter or olive oil',
    semantic_food: 'butter',
    expectation: {
      amount_kind: 'alternative',
      unit_family: 'volume',
      parsed_quantity_kind: 'exact',
      parsed_measurement_kind: 'volume',
      alternative_count: 2,
      ambiguous: true,
      ai_must_not_author_mass: true,
    },
  },
]);
