/**
 * The Kitchen Codex — AI Advanced Nutrition SEMANTIC ACCEPTANCE CORPUS (AI-1).
 *
 * EXPANDS the AI-0 smoke corpus (`aiAdvancedSmokeCorpus.ts`, untouched and still
 * pinned) into a semantic acceptance corpus. Each case carries THREE independent
 * things, so a future change cannot quietly move the goalposts:
 *
 *   1. `source`     — the REAL deterministic parse/state of the authored line
 *                     (observed from the frozen parser, never from a provider);
 *   2. `reading`    — the semantic interpretation a competent provider is
 *                     expected to return for that wording;
 *   3. `invariants` — what the CONTRACT SYSTEM must enforce for that reading:
 *                     amount semantics, unit family, preserved food-defining
 *                     wording, alternatives, ambiguity, scope of withholding,
 *                     and the permanent `no_ai_mass` safety rule.
 *
 * The corpus asserts SEMANTIC INVARIANTS, never provider prose: no case pins the
 * wording of a note, a reason string, or a confidence value.
 */

import type {
  AiAdvancedAmountKind,
  AiAdvancedAmountSemantics,
  AiAdvancedCountSemantics,
  AiAdvancedIngredientInterpretation,
  AiAdvancedSemanticFood,
  AiAdvancedUnitSemantics,
} from '../../src/core/nutritionV2/aiAdvanced';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';

/** Deterministic authored source state, observed from the frozen parser. */
export interface AiAdvancedSemanticSource {
  readonly quantity_kind: 'exact' | 'range' | 'absent' | 'invalid';
  readonly amount: number | null;
  readonly measurement_kind: 'mass' | 'volume' | 'count' | 'unknown';
  readonly quantity_range?: { readonly lower: number; readonly upper: number } | null;
  readonly mass_range?: { readonly lower: number; readonly upper: number } | null;
  readonly representative_grams?: number | null;
}

/** The reading a competent provider is expected to return for the wording. */
export interface AiAdvancedSemanticReading {
  readonly semantic_food: AiAdvancedSemanticFood;
  readonly search_phrases: ReadonlyArray<string>;
  readonly amount_semantics: AiAdvancedAmountSemantics;
  readonly unit_semantics: AiAdvancedUnitSemantics;
  readonly count_semantics: AiAdvancedCountSemantics;
  readonly alternatives: ReadonlyArray<{ readonly normalized_name: string }>;
  readonly ambiguity: { readonly ambiguous: boolean; readonly reasons: ReadonlyArray<string> };
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly notes?: string;
}

export interface AiAdvancedSemanticInvariants {
  /** Canonical amount-semantics class the reading must be built with. */
  readonly amount_kind: AiAdvancedAmountKind;
  readonly unit_family: AiAdvancedUnitSemantics['family'];
  readonly count_noun?: string;
  /**
   * Food-defining / preparation / household wording that MUST survive into the
   * bounded deterministic search surface (identity name, search phrases, or the
   * closed hint vocabulary) whenever the line is resolution-eligible.
   */
  readonly preserved_wording: ReadonlyArray<string>;
  /** True when the authored line offers alternatives (never auto-collapsed). */
  readonly alternatives_preserved: boolean;
  /** True when the reading itself reports ambiguity. */
  readonly ambiguity_expected: boolean;
  /** True when the interpretation must be WITHHELD from resolution queries. */
  readonly withheld_from_resolution: boolean;
  /** Whether the reading is compatible with the authored source. */
  readonly reconciliation: 'accepted' | 'refused';
  /** Expected refusal classification, when `reconciliation` is refused. */
  readonly refusal_code?: string;
  /** Authored range endpoints that must remain the only range authority. */
  readonly authored_range?: { readonly lower: number; readonly upper: number };
  /** Permanent safety invariant (always true; explicit for auditability). */
  readonly no_ai_mass: true;
}

export interface AiAdvancedSemanticCase {
  readonly family: string;
  readonly line: string;
  readonly source: AiAdvancedSemanticSource;
  readonly reading: AiAdvancedSemanticReading;
  readonly invariants: AiAdvancedSemanticInvariants;
}

const NO_ALTERNATIVES: ReadonlyArray<{ readonly normalized_name: string }> = Object.freeze([]);
const UNAMBIGUOUS = Object.freeze({ ambiguous: false, reasons: Object.freeze([]) });

function reading(fields: {
  name?: string;
  modifiers?: ReadonlyArray<string>;
  preparation?: ReadonlyArray<string>;
  state?: ReadonlyArray<string>;
  qualifiers?: ReadonlyArray<string>;
  phrases?: ReadonlyArray<string>;
  amount: AiAdvancedAmountSemantics;
  unit: AiAdvancedUnitSemantics;
  count?: AiAdvancedCountSemantics;
  alternatives?: ReadonlyArray<{ readonly normalized_name: string }>;
  ambiguity?: { readonly ambiguous: boolean; readonly reasons: ReadonlyArray<string> };
  confidence?: 'high' | 'medium' | 'low';
  notes?: string;
}): AiAdvancedSemanticReading {
  return Object.freeze({
    semantic_food: Object.freeze({
      ...(fields.name !== undefined ? { normalized_name: fields.name } : {}),
      modifiers: Object.freeze(fields.modifiers ?? []),
      preparation: Object.freeze(fields.preparation ?? []),
      state: Object.freeze(fields.state ?? []),
      qualifiers: Object.freeze(fields.qualifiers ?? []),
    }),
    search_phrases: Object.freeze(fields.phrases ?? []),
    amount_semantics: Object.freeze(fields.amount),
    unit_semantics: Object.freeze(fields.unit),
    count_semantics: Object.freeze(fields.count ?? {}),
    alternatives: Object.freeze(fields.alternatives ?? []),
    ambiguity: Object.freeze(fields.ambiguity ?? UNAMBIGUOUS),
    ...(fields.confidence !== undefined ? { confidence: fields.confidence } : {}),
    ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
  });
}

/** Builds the canonical envelope a provider would return for a corpus reading. */
export function semanticInterpretationFor(
  lineRef: string,
  caseValue: AiAdvancedSemanticCase
): AiAdvancedIngredientInterpretation {
  return Object.freeze({
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: lineRef,
    ...caseValue.reading,
  }) as AiAdvancedIngredientInterpretation;
}

/** The exact `{contract_version, interpretations}` envelope a route would serve. */
export function semanticEnvelopeFor(
  entries: ReadonlyArray<{ readonly lineRef: string; readonly case: AiAdvancedSemanticCase }>
): Record<string, unknown> {
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    interpretations: entries.map((entry) => semanticInterpretationFor(entry.lineRef, entry.case)),
  };
}

export const AI_ADVANCED_SEMANTIC_CORPUS: ReadonlyArray<AiAdvancedSemanticCase> = Object.freeze([
  {
    family: 'onion_sliced',
    line: '2 medium yellow onions, thinly sliced',
    source: { quantity_kind: 'exact', amount: 2, measurement_kind: 'unknown' },
    reading: reading({
      name: 'yellow onion',
      modifiers: ['medium', 'yellow'],
      preparation: ['thinly sliced'],
      phrases: ['medium yellow onion', 'yellow onions'],
      amount: { kind: 'exact', echoed_value: 2 },
      unit: { family: 'count', interpreted_unit: 'onion' },
      count: { noun: 'onion', size: 'medium' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'count',
      count_noun: 'onion',
      preserved_wording: ['yellow onion', 'thinly sliced'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'garlic_cloves_minced',
    line: '3 cloves garlic, minced',
    source: { quantity_kind: 'exact', amount: 3, measurement_kind: 'count' },
    reading: reading({
      name: 'garlic',
      preparation: ['minced'],
      phrases: ['garlic cloves', 'minced garlic'],
      amount: { kind: 'exact', echoed_value: 3 },
      unit: { raw: 'cloves', family: 'count', interpreted_unit: 'clove' },
      count: { noun: 'clove' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'count',
      count_noun: 'clove',
      preserved_wording: ['garlic', 'minced', 'clove'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'unsalted_butter_sticks',
    line: '2 sticks unsalted butter',
    source: { quantity_kind: 'exact', amount: 2, measurement_kind: 'count' },
    reading: reading({
      name: 'unsalted butter',
      state: ['unsalted'],
      phrases: ['unsalted butter stick'],
      amount: { kind: 'exact', echoed_value: 2 },
      unit: { raw: 'sticks', family: 'household', interpreted_unit: 'stick' },
      count: { noun: 'stick' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'household',
      count_noun: 'stick',
      preserved_wording: ['unsalted butter', 'stick'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'heavy_cream_volume',
    line: '1 cup heavy cream',
    source: { quantity_kind: 'exact', amount: 1, measurement_kind: 'volume' },
    reading: reading({
      name: 'heavy cream',
      phrases: ['heavy whipping cream'],
      amount: { kind: 'exact', echoed_value: 1 },
      unit: { raw: 'cup', family: 'volume', interpreted_unit: 'cup' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'volume',
      preserved_wording: ['heavy cream'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'chuck_roast_mass_range',
    line: '3-4 lb beef chuck roast, cut into chunks',
    source: {
      quantity_kind: 'range',
      amount: null,
      measurement_kind: 'mass',
      quantity_range: { lower: 3, upper: 4 },
      mass_range: { lower: 3, upper: 4 },
      representative_grams: 1587.5732950000001,
    },
    reading: reading({
      name: 'beef chuck roast',
      preparation: ['cut into chunks'],
      phrases: ['chuck roast', 'beef roast'],
      amount: { kind: 'range', range_lower: 3, range_upper: 4 },
      unit: { raw: 'lb', family: 'mass', interpreted_unit: 'pound' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'range',
      unit_family: 'mass',
      preserved_wording: ['beef chuck roast'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      authored_range: { lower: 3, upper: 4 },
      no_ai_mass: true,
    },
  },
  {
    family: 'chuck_roast_range_collapsed_to_scalar',
    line: '3-4 lb beef chuck roast, cut into chunks',
    source: {
      quantity_kind: 'range',
      amount: null,
      measurement_kind: 'mass',
      quantity_range: { lower: 3, upper: 4 },
      mass_range: { lower: 3, upper: 4 },
      representative_grams: 1587.5732950000001,
    },
    reading: reading({
      name: 'beef chuck roast',
      phrases: ['chuck roast'],
      // A plausible but WRONG collapse: the authored range is the author's
      // evidence and may never be replaced by the provider's own scalar.
      amount: { kind: 'exact', echoed_value: 3.5 },
      unit: { raw: 'lb', family: 'mass', interpreted_unit: 'pound' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'mass',
      preserved_wording: [],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'refused',
      refusal_code: 'range_source_collapsed_to_scalar',
      authored_range: { lower: 3, upper: 4 },
      no_ai_mass: true,
    },
  },
  {
    family: 'chuck_roast_exact_scalar_claimed_as_range',
    line: '3.5 lb beef chuck roast',
    source: {
      quantity_kind: 'exact',
      amount: 3.5,
      measurement_kind: 'mass',
      representative_grams: null,
    },
    reading: reading({
      name: 'beef chuck roast',
      phrases: ['chuck roast'],
      // Symmetric failure: an authored EXACT scalar may never become a range.
      amount: { kind: 'range', range_lower: 3, range_upper: 4 },
      unit: { raw: 'lb', family: 'mass', interpreted_unit: 'pound' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'range',
      unit_family: 'mass',
      preserved_wording: [],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'refused',
      refusal_code: 'exact_source_claimed_as_range',
      no_ai_mass: true,
    },
  },
  {
    family: 'provolone_count_range_claim_refused',
    line: '3 to 4 slices provolone (about 75-100 g in total)',
    source: {
      quantity_kind: 'range',
      amount: null,
      measurement_kind: 'mass',
      quantity_range: { lower: 3, upper: 4 },
      mass_range: { lower: 75, upper: 100 },
      representative_grams: 87.5,
    },
    reading: reading({
      name: 'provolone cheese',
      phrases: ['provolone slice'],
      // The authored line carries a WRITTEN MASS range, which is the
      // deterministic range authority for this line: a slice-count range claim
      // can never replace it.
      amount: { kind: 'range', range_lower: 3, range_upper: 4 },
      unit: { raw: 'slices', family: 'count', interpreted_unit: 'slice' },
      count: { noun: 'slice' },
      confidence: 'medium',
    }),
    invariants: {
      amount_kind: 'range',
      unit_family: 'count',
      count_noun: 'slice',
      preserved_wording: [],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'refused',
      refusal_code: 'range_endpoints_mismatch',
      no_ai_mass: true,
    },
  },
  {
    family: 'provolone_written_mass_range_echoed',
    line: '3 to 4 slices provolone (about 75-100 g in total)',
    source: {
      quantity_kind: 'range',
      amount: null,
      measurement_kind: 'mass',
      quantity_range: { lower: 3, upper: 4 },
      mass_range: { lower: 75, upper: 100 },
      representative_grams: 87.5,
    },
    reading: reading({
      name: 'provolone cheese',
      phrases: ['provolone slice'],
      amount: { kind: 'range', range_lower: 75, range_upper: 100 },
      unit: { raw: 'slices', family: 'count', interpreted_unit: 'slice' },
      count: { noun: 'slice' },
      confidence: 'medium',
    }),
    invariants: {
      amount_kind: 'range',
      unit_family: 'count',
      count_noun: 'slice',
      preserved_wording: ['provolone', 'slice'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      authored_range: { lower: 75, upper: 100 },
      no_ai_mass: true,
    },
  },
  {
    family: 'provolone_representative_echo_admitted',
    line: '3 to 4 slices provolone (about 75-100 g in total)',
    source: {
      quantity_kind: 'range',
      amount: null,
      measurement_kind: 'mass',
      quantity_range: { lower: 3, upper: 4 },
      mass_range: { lower: 75, upper: 100 },
      representative_grams: 87.5,
    },
    reading: reading({
      name: 'provolone cheese',
      phrases: ['provolone'],
      // Within the documented 5% tolerance the DETERMINISTIC representative is
      // adopted verbatim: the transport must carry 87.5 g, never the
      // provider's 90.
      amount: { kind: 'exact', echoed_value: 90 },
      unit: { raw: 'slices', family: 'count', interpreted_unit: 'slice' },
      count: { noun: 'slice' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'count',
      count_noun: 'slice',
      preserved_wording: ['provolone'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'provolone_ai_scalar_refused',
    line: '3 to 4 slices provolone (about 75-100 g in total)',
    source: {
      quantity_kind: 'range',
      amount: null,
      measurement_kind: 'mass',
      quantity_range: { lower: 3, upper: 4 },
      mass_range: { lower: 75, upper: 100 },
      representative_grams: 87.5,
    },
    reading: reading({
      name: 'provolone cheese',
      phrases: ['provolone'],
      // Far outside the deterministic evidence: refused outright.
      amount: { kind: 'exact', echoed_value: 500 },
      unit: { raw: 'slices', family: 'count', interpreted_unit: 'slice' },
      count: { noun: 'slice' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'count',
      count_noun: 'slice',
      preserved_wording: [],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'refused',
      refusal_code: 'range_source_collapsed_to_scalar',
      no_ai_mass: true,
    },
  },
  {
    family: 'oysters_shucked',
    line: '12 oysters, shucked',
    source: { quantity_kind: 'exact', amount: 12, measurement_kind: 'unknown' },
    reading: reading({
      name: 'oysters',
      preparation: ['shucked'],
      state: ['shucked'],
      phrases: ['shucked oysters'],
      amount: { kind: 'exact', echoed_value: 12 },
      unit: { family: 'count', interpreted_unit: 'oyster' },
      count: { noun: 'oyster', state: 'shucked' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'count',
      count_noun: 'oyster',
      preserved_wording: ['oysters', 'shucked'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'mortadella_thin_slices',
    line: '4 thin slices mortadella',
    source: { quantity_kind: 'exact', amount: 4, measurement_kind: 'count' },
    reading: reading({
      name: 'mortadella',
      modifiers: ['thin'],
      phrases: ['thin slices mortadella', 'mortadella slice'],
      amount: { kind: 'exact', echoed_value: 4 },
      unit: { family: 'count', interpreted_unit: 'slice' },
      count: { noun: 'slice', size: 'thin' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'count',
      count_noun: 'slice',
      preserved_wording: ['mortadella', 'thin slices mortadella'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'basil_handful_qualitative',
    line: '1 handful fresh basil',
    source: { quantity_kind: 'exact', amount: 1, measurement_kind: 'unknown' },
    reading: reading({
      name: 'basil',
      state: ['fresh'],
      phrases: ['fresh basil leaves'],
      amount: { kind: 'qualitative', phrasing: 'handful' },
      unit: { raw: 'handful', family: 'household', interpreted_unit: 'handful' },
      count: { noun: 'handful' },
      confidence: 'medium',
      notes: 'handful is household wording, not a mass',
    }),
    invariants: {
      amount_kind: 'qualitative',
      unit_family: 'household',
      count_noun: 'handful',
      preserved_wording: ['basil', 'handful'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'red_pepper_flakes_pinch',
    line: 'a pinch of crushed red pepper flakes',
    source: { quantity_kind: 'absent', amount: null, measurement_kind: 'unknown' },
    reading: reading({
      name: 'crushed red pepper flakes',
      preparation: ['crushed'],
      phrases: ['red pepper flakes', 'crushed red pepper'],
      amount: { kind: 'qualitative', phrasing: 'pinch' },
      unit: { family: 'household', interpreted_unit: 'pinch' },
      count: { noun: 'pinch' },
      confidence: 'medium',
    }),
    invariants: {
      amount_kind: 'qualitative',
      unit_family: 'household',
      count_noun: 'pinch',
      preserved_wording: ['crushed red pepper flakes', 'pinch'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'apple_cider_vinegar',
    line: 'apple cider vinegar',
    source: { quantity_kind: 'absent', amount: null, measurement_kind: 'unknown' },
    reading: reading({
      name: 'apple cider vinegar',
      qualifiers: ['cider'],
      phrases: ['cider vinegar', 'acv'],
      amount: { kind: 'unknown', phrasing: 'no authored amount' },
      unit: { family: 'unknown' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'unknown',
      unit_family: 'unknown',
      preserved_wording: ['apple cider vinegar'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'butter_or_olive_oil',
    line: 'butter or olive oil',
    source: { quantity_kind: 'absent', amount: null, measurement_kind: 'unknown' },
    reading: reading({
      name: 'butter',
      phrases: ['butter', 'olive oil'],
      amount: { kind: 'alternative', phrasing: 'butter or olive oil' },
      unit: { family: 'unknown' },
      alternatives: [{ normalized_name: 'olive oil' }, { normalized_name: 'butter' }],
      confidence: 'medium',
    }),
    invariants: {
      amount_kind: 'alternative',
      unit_family: 'unknown',
      preserved_wording: [],
      alternatives_preserved: true,
      ambiguity_expected: false,
      withheld_from_resolution: true,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'cloves_ambiguous',
    line: '2 cloves',
    source: { quantity_kind: 'exact', amount: 2, measurement_kind: 'count' },
    reading: reading({
      name: 'clove',
      phrases: ['cloves'],
      amount: { kind: 'exact', echoed_value: 2 },
      unit: { raw: 'cloves', family: 'count', interpreted_unit: 'clove' },
      count: { noun: 'clove' },
      ambiguity: { ambiguous: true, reasons: ['garlic clove vs spice clove'] },
      confidence: 'medium',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'count',
      count_noun: 'clove',
      preserved_wording: [],
      alternatives_preserved: false,
      ambiguity_expected: true,
      withheld_from_resolution: true,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'skim_milk',
    line: 'skim milk',
    source: { quantity_kind: 'absent', amount: null, measurement_kind: 'unknown' },
    reading: reading({
      name: 'skim milk',
      state: ['skim'],
      modifiers: ['skim'],
      phrases: ['skim milk', 'fat free milk'],
      amount: { kind: 'unknown' },
      unit: { family: 'volume', interpreted_unit: 'cup' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'unknown',
      unit_family: 'volume',
      preserved_wording: ['skim milk'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'whole_milk',
    line: 'whole milk',
    source: { quantity_kind: 'absent', amount: null, measurement_kind: 'unknown' },
    reading: reading({
      name: 'whole milk',
      state: ['whole'],
      modifiers: ['whole'],
      phrases: ['whole milk', 'full fat milk'],
      amount: { kind: 'unknown' },
      unit: { family: 'volume', interpreted_unit: 'cup' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'unknown',
      unit_family: 'volume',
      preserved_wording: ['whole milk'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'jar_pickles',
    line: '1 jar pickles',
    source: { quantity_kind: 'exact', amount: 1, measurement_kind: 'count' },
    reading: reading({
      name: 'pickles',
      phrases: ['dill pickles'],
      amount: { kind: 'exact', echoed_value: 1 },
      unit: { raw: 'jar', family: 'household', interpreted_unit: 'jar' },
      count: { noun: 'jar' },
      confidence: 'medium',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'household',
      count_noun: 'jar',
      preserved_wording: ['pickles', 'jar'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'shallots_finely_chopped',
    line: '2 shallots, finely chopped',
    source: { quantity_kind: 'exact', amount: 2, measurement_kind: 'unknown' },
    reading: reading({
      name: 'shallots',
      preparation: ['finely chopped'],
      phrases: ['shallot'],
      amount: { kind: 'exact', echoed_value: 2 },
      unit: { family: 'count', interpreted_unit: 'shallot' },
      count: { noun: 'shallot' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'exact',
      unit_family: 'count',
      count_noun: 'shallot',
      preserved_wording: ['shallots', 'finely chopped'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
  {
    family: 'fresh_parsley_chopped',
    line: 'fresh parsley, chopped',
    source: { quantity_kind: 'absent', amount: null, measurement_kind: 'unknown' },
    reading: reading({
      name: 'parsley',
      state: ['fresh'],
      preparation: ['chopped'],
      phrases: ['fresh parsley', 'flat leaf parsley'],
      amount: { kind: 'unknown' },
      unit: { family: 'unknown' },
      confidence: 'high',
    }),
    invariants: {
      amount_kind: 'unknown',
      unit_family: 'unknown',
      preserved_wording: ['parsley', 'fresh'],
      alternatives_preserved: false,
      ambiguity_expected: false,
      withheld_from_resolution: false,
      reconciliation: 'accepted',
      no_ai_mass: true,
    },
  },
]);
