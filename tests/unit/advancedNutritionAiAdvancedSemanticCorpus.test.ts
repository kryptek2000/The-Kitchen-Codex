/**
 * AI-1 — SEMANTIC ACCEPTANCE CORPUS (invariants only, no live provider).
 *
 * Proves the CONTRACT SYSTEM, not a provider, owns every authoritative
 * decision:
 *
 *   authored wording -> deterministic source observation -> reconciliation
 *   -> canonical adaptation -> resolution-eligibility guard
 *
 * Every case asserts semantic invariants (amount kind, unit family, count
 * noun, preserved food-defining wording, alternatives, ambiguity, scope of
 * withholding, no AI mass) and never provider prose.
 */

import { describe, it, expect } from 'vitest';

import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import {
  reconcileAiAdvancedAmount,
  sanitizeAiAdvancedInterpretationResponse,
  adaptAiAdvancedInterpretationsForResolution,
  withholdNonDeterministicAdaptations,
  AI_ADVANCED_CONTRACT_VERSION,
} from '../../src/core/nutritionV2/aiAdvanced';
import {
  buildAuthoritativeAmountObservations,
  sourceAmountObservation,
} from '../../src/core/nutritionV2/aiAdvancedSource';
import {
  AI_ADVANCED_SEMANTIC_CORPUS,
  semanticEnvelopeFor,
} from '../fixtures/aiAdvancedSemanticCorpus';
import type { AdaptedIngredient } from '../../src/core/nutritionV2/phase4/types';

const REQUIRED_AI1_LINES = [
  '2 medium yellow onions, thinly sliced',
  '3 cloves garlic, minced',
  '2 sticks unsalted butter',
  '1 cup heavy cream',
  '3-4 lb beef chuck roast, cut into chunks',
  '3 to 4 slices provolone (about 75-100 g in total)',
  '12 oysters, shucked',
  '4 thin slices mortadella',
  '1 handful fresh basil',
  'a pinch of crushed red pepper flakes',
  'apple cider vinegar',
  'butter or olive oil',
  '2 cloves',
  'skim milk',
  'whole milk',
  '1 jar pickles',
  '2 shallots, finely chopped',
  'fresh parsley, chopped',
];

const TRANSPORT_KEYS = new Set([
  'line_ref',
  'interpreted_food_name',
  'suggested_usda_queries',
  'notes',
  'confidence',
  'normalized_food_query',
  'preparation_hint',
  'quantity_value',
  'quantity_unit_hint',
  'count_descriptor_hint',
  'portion_search_hint',
  'household_unit_hint',
  'household_size_hint',
  'household_state_hint',
]);

function adaptedFor(line: string): { adapted: AdaptedIngredient; lineRef: string } {
  const parsedLine = parseIngredientLine(line);
  const ingredient = {
    original: line,
    ...(parsedLine.amount !== null ? { amount: parsedLine.amount } : {}),
    ...(parsedLine.unit !== undefined ? { unit: parsedLine.unit } : {}),
    name: parsedLine.name,
  };
  const recipe = {
    id: 'semantic-corpus',
    fileName: 'semantic-corpus.md',
    filePath: 'Recipes/semantic-corpus.md',
    rawMarkdown: '',
    title: 'Semantic corpus',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [ingredient],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as never;
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted[0];
  return { adapted, lineRef: adapted.line_ref };
}

function boundedSurface(suggestion: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string') parts.push(value);
  };
  push(suggestion.interpreted_food_name);
  push(suggestion.normalized_food_query);
  push(suggestion.preparation_hint);
  push(suggestion.count_descriptor_hint);
  push(suggestion.portion_search_hint);
  push(suggestion.household_unit_hint);
  push(suggestion.household_size_hint);
  push(suggestion.household_state_hint);
  push(suggestion.notes);
  const queries = suggestion.suggested_usda_queries;
  if (Array.isArray(queries)) for (const query of queries) push(query);
  return parts.join(' | ').toLowerCase();
}

describe('AI-1 semantic acceptance corpus — coverage', () => {
  it('includes every required AI-1 acceptance line', () => {
    const lines = new Set(AI_ADVANCED_SEMANTIC_CORPUS.map((entry) => entry.line));
    for (const required of REQUIRED_AI1_LINES) {
      expect(lines.has(required), `corpus missing: ${required}`).toBe(true);
    }
    expect(REQUIRED_AI1_LINES).toHaveLength(18);
  });

  it('pins no_ai_mass on every case', () => {
    for (const entry of AI_ADVANCED_SEMANTIC_CORPUS) {
      expect(entry.invariants.no_ai_mass).toBe(true);
    }
  });
});

describe('AI-1 semantic acceptance corpus — invariants', () => {
  for (const entry of AI_ADVANCED_SEMANTIC_CORPUS) {
    it(`${entry.family} — "${entry.line}"`, () => {
      const { adapted, lineRef } = adaptedFor(entry.line);

      // 1. The deterministic parser owns the authored source state.
      const parsed = parseIngredient(adapted.ingredient);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const observation = sourceAmountObservation(adapted);
      expect(parsed.parsed.quantity_kind).toBe(entry.source.quantity_kind);
      expect(parsed.parsed.measurement_kind).toBe(entry.source.measurement_kind);
      expect(observation.quantity_kind).toBe(entry.source.quantity_kind);
      expect(observation.amount).toBe(entry.source.amount);
      expect(observation.measurement_kind).toBe(entry.source.measurement_kind);
      if (entry.source.quantity_range !== undefined) {
        expect(observation.quantity_range).toEqual(entry.source.quantity_range);
      }
      if (entry.source.representative_grams !== undefined && entry.source.representative_grams !== null) {
        expect(observation.representative_grams).toBe(entry.source.representative_grams);
      }

      // 2. The reading is expressed in the canonical contract only.
      expect(entry.reading.amount_semantics.kind).toBe(entry.invariants.amount_kind);
      expect(entry.reading.unit_semantics.family).toBe(entry.invariants.unit_family);
      if (entry.invariants.count_noun !== undefined) {
        expect(entry.reading.count_semantics.noun).toBe(entry.invariants.count_noun);
      }
      const sanitized = sanitizeAiAdvancedInterpretationResponse(
        semanticEnvelopeFor([{ lineRef, case: entry }]),
        { allowedLineRefs: [lineRef] }
      );
      expect(sanitized.ok).toBe(true);
      if (!sanitized.ok) return;
      const interpretation = sanitized.interpretations[0];

      // 3. Source text wins: exact/range compatibility is deterministic.
      const reconciled = reconcileAiAdvancedAmount(interpretation.amount_semantics, observation);
      if (entry.invariants.reconciliation === 'accepted') {
        expect(reconciled.ok).toBe(true);
      } else {
        expect(reconciled.ok).toBe(false);
        const refusal = reconciled as { readonly ok: false; readonly code: string };
        expect(refusal.code).toBe(entry.invariants.refusal_code);
      }

      // 4. Adaptation + AI-1 eligibility guard (through the real row pipeline).
      const rows = [{ line_ref: lineRef }] as never;
      const authoritativeByLineRef = buildAuthoritativeAmountObservations({
        rows: rows as never,
        adapted: [adapted],
      });
      expect(authoritativeByLineRef.has(lineRef)).toBe(true);
      const adaptedOutcome = adaptAiAdvancedInterpretationsForResolution({
        interpretations: [interpretation],
        authoritativeByLineRef,
      });
      const eligible = withholdNonDeterministicAdaptations({
        interpretations: [interpretation],
        outcome: adaptedOutcome,
      });

      if (entry.invariants.reconciliation === 'refused') {
        expect(adaptedOutcome.contradicted).toEqual([lineRef]);
        expect(eligible.suggestions).toHaveLength(0);
        expect(eligible.withheld).toEqual([]);
        return;
      }

      if (entry.invariants.withheld_from_resolution) {
        expect(eligible.suggestions).toHaveLength(0);
        expect(eligible.withheld).toHaveLength(1);
        expect(eligible.withheld[0].line_ref).toBe(lineRef);
        expect(eligible.withheld[0].reason).toBe(
          entry.invariants.ambiguity_expected ? 'ambiguous' : 'alternatives'
        );
        expect(adaptedOutcome.contradicted).toEqual([]);
        if (entry.invariants.alternatives_preserved) {
          expect(interpretation.alternatives.length).toBeGreaterThan(1);
        }
        return;
      }

      expect(eligible.withheld).toEqual([]);
      expect(adaptedOutcome.contradicted).toEqual([]);
      expect(eligible.suggestions).toHaveLength(1);
      const suggestion = eligible.suggestions[0] as unknown as Record<string, unknown>;

      // 5. Bounded transport: closed key set, never an authority-shaped key.
      for (const key of Object.keys(suggestion)) {
        expect(TRANSPORT_KEYS.has(key), `unexpected transport key: ${key}`).toBe(true);
        expect(/grams|density|fdc|nutrient|calorie|portion_grams|usda_id/.test(key)).toBe(false);
      }
      expect(JSON.stringify(suggestion)).not.toMatch(
        /"(grams|density|fdc_id|calories|protein|fat|carbohydrates)"/
      );

      // 6. Food-defining / preparation / household wording survives.
      const surface = boundedSurface(suggestion);
      for (const wording of entry.invariants.preserved_wording) {
        expect(surface, `lost wording: ${wording}`).toContain(wording.toLowerCase());
      }

      // 7. AI may only ECHO deterministic evidence: any quantity that reaches the
      //    deterministic transport equals the authored scalar or the documented
      //    deterministic representative — never the provider's own number.
      if (entry.invariants.authored_range !== undefined && reconciled.ok) {
        expect(reconciled.range_lower).toBe(entry.invariants.authored_range.lower);
        expect(reconciled.range_upper).toBe(entry.invariants.authored_range.upper);
      }
      if (suggestion.quantity_value !== undefined) {
        const deterministic = [observation.amount, observation.representative_grams].filter(
          (value): value is number => typeof value === 'number'
        );
        expect(deterministic.length).toBeGreaterThan(0);
        expect(deterministic).toContain(suggestion.quantity_value);
      }
    });
  }
});

describe('AI-1 semantic acceptance corpus — contract hygiene', () => {
  it('the whole corpus sanitizes as ONE canonical envelope', () => {
    const entries = AI_ADVANCED_SEMANTIC_CORPUS.map((entry) => ({
      lineRef: `line:${entry.family}`,
      case: entry,
    }));
    const sanitized = sanitizeAiAdvancedInterpretationResponse(semanticEnvelopeFor(entries), {
      allowedLineRefs: entries.map((entry) => entry.lineRef),
    });
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    expect(sanitized.interpretations).toHaveLength(entries.length);
    for (const interpretation of sanitized.interpretations) {
      expect(interpretation.contract_version).toBe(AI_ADVANCED_CONTRACT_VERSION);
    }
  });

  it('a corpus reading can never carry provider-authored mass into transport', () => {
    const entry = AI_ADVANCED_SEMANTIC_CORPUS[0];
    const base = (
      semanticEnvelopeFor([{ lineRef: 'line:forged', case: entry }]) as {
        interpretations: ReadonlyArray<Record<string, unknown>>;
      }
    ).interpretations[0];
    const sanitized = sanitizeAiAdvancedInterpretationResponse(
      {
        contract_version: AI_ADVANCED_CONTRACT_VERSION,
        interpretations: [{ ...base, grams: 500 }],
      },
      { allowedLineRefs: ['line:forged'] }
    );
    expect(sanitized.ok).toBe(false);
    const failure = sanitized as { readonly ok: false; readonly code: string };
    expect(failure.code).toBe('authority_field');
  });

  it('the ADAPTATION BOUNDARY never substitutes an alternative for the primary food', () => {
    // The canonical contract carries alternatives; the adaptation boundary must
    // only ever map the PRIMARY semantic identity. A mutation that prefers an
    // alternative would otherwise be invisible (alternatives are withheld from
    // resolution), so this pins the boundary itself.
    const entry = AI_ADVANCED_SEMANTIC_CORPUS.find(
      (item) => item.invariants.alternatives_preserved
    );
    expect(entry).toBeDefined();
    if (!entry) return;

    const base = (
      semanticEnvelopeFor([{ lineRef: 'line:alt', case: entry }]) as {
        interpretations: ReadonlyArray<Record<string, unknown>>;
      }
    ).interpretations[0];
    const withAlternatives = {
      ...base,
      semantic_food: { normalized_name: 'olive oil', modifiers: [], preparation: [], state: [], qualifiers: [] },
      search_phrases: ['olive oil'],
      alternatives: [
        { normalized_name: 'butter' },
        { normalized_name: 'ghee' },
      ],
    };
    const sanitized = sanitizeAiAdvancedInterpretationResponse(
      { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: [withAlternatives] },
      { allowedLineRefs: ['line:alt'] }
    );
    if (sanitized.ok !== true) throw new Error(`unexpected sanitizer failure: ${sanitized.code}`);
    const interpretation = sanitized.interpretations[0];
    expect(interpretation.alternatives.map((alternative) => alternative.normalized_name)).toEqual([
      'butter',
      'ghee',
    ]);

    const adaptedOutcome = adaptAiAdvancedInterpretationsForResolution({
      interpretations: [interpretation],
    });
    expect(adaptedOutcome.suggestions).toHaveLength(1);
    const suggestion = adaptedOutcome.suggestions[0] as unknown as Record<string, unknown>;
    // The primary identity survives; no alternative is ever promoted.
    expect(suggestion.interpreted_food_name).toBe('olive oil');
    expect(suggestion.normalized_food_query).toBe('olive oil');
    for (const query of suggestion.suggested_usda_queries as ReadonlyArray<string>) {
      expect(['butter', 'ghee']).not.toContain(query);
    }

    // And the resolution guard still withholds the line's queries entirely.
    const eligible = withholdNonDeterministicAdaptations({
      interpretations: [interpretation],
      outcome: adaptedOutcome,
    });
    expect(eligible.suggestions).toHaveLength(0);
    expect(eligible.withheld).toEqual([{ line_ref: 'line:alt', reason: 'alternatives' }]);
  });
});
