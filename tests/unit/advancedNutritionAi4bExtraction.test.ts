/**
 * AI-4B — FOCUSED DETERMINISTIC EXTRACTION TESTS.
 *
 * These are the tests the AI-4B brief asks for: the basic context signals, the
 * boundaries that must NOT become context, and the adversarial instructions that
 * must never move any nutrition truth. Everything here drives the REAL Phase 4
 * narrow adaptation (`adaptRecipe`) so the extractor's input is a genuine
 * production `AdaptedRecipe`, never a hand-shaped look-alike.
 *
 * The behavioural half of the "no authority" proof lives in
 * `advancedNutritionAi4bAuthorityDifferential.test.ts`; the structural half
 * (absence of wiring) lives in `advancedNutritionAi4bIsolation.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import {
  AI_RECIPE_CONTEXT_SIGNALS,
  AI_RECIPE_CONTEXT_EXTRACTOR,
  MAX_RECIPE_CONTEXT_SIGNAL_SUBJECTS,
  MAX_RECIPE_CONTEXT_SIGNALS_PER_LINE,
  extractRecipeContext,
  type RecipeContextExtraction,
  type RecipeContextSignalEvidence,
} from '../../src/core/nutritionV2/phase4/recipeContextExtraction';
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
  MAX_RECIPE_CONTEXT_TARGETS,
  isAiRecipeContextAuthorityKey,
  sanitizeRecipeContextEnvelope,
  type RecipeContextEnvelope,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';
import {
  recipeContextSnapshotBinding,
  recipeContextSnapshotInputFromEnvelope,
} from '../../src/core/nutritionV2/phase4/recipeContextSnapshot';
import type { AdaptedRecipe } from '../../src/core/nutritionV2/phase4/adapt';

/** The proven production ingredient shape: original + parsed amount/unit/name. */
function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

interface Built {
  readonly extraction: RecipeContextExtraction;
  readonly adapted: AdaptedRecipe;
  /** The authored ingredient line text, by adapted index. */
  readonly lines: ReadonlyArray<string>;
}

function build(
  lines: ReadonlyArray<string>,
  instructions: ReadonlyArray<string>,
  options: { title?: string; servings?: number } = {}
): Built {
  const adaptedResult = adaptRecipe({
    title: options.title ?? 'Probe recipe',
    servings: options.servings ?? 4,
    ingredients: lines.map(structuredLine),
  } as never);
  if (!adaptedResult.ok) throw new Error('adapt failed');
  const result = extractRecipeContext({
    recipe: adaptedResult.recipe,
    instructions: instructions.map((text) => ({ text })),
  });
  if (!result.ok) {
    throw new Error(`extract failed: ${String((result as { code?: string }).code)}`);
  }
  return { extraction: result.extraction, adapted: adaptedResult.recipe, lines };
}

/** Deterministic, human-readable signal access for assertions. */
function signalFor(
  built: Built,
  signal: string,
  evidenceFragment: string
): RecipeContextSignalEvidence | undefined {
  return built.extraction.signals.find(
    (entry) => entry.signal === signal && entry.evidence.toLowerCase().includes(evidenceFragment)
  );
}

function targetFor(built: Built, text: string): RecipeContextEnvelope['targets'][number] | undefined {
  return built.extraction.envelope.targets.find((entry) => entry.source_text === text);
}

/**
 * THE STRUCTURAL AUTHORITY SCAN.
 *
 * A substring scan over serialized JSON would also flag AUTHORED recipe words
 * ("portions", "fat"), which are the source of truth and must stay. What actually
 * matters is:
 *   1. no KEY an extraction carries may be authority-shaped, and
 *   2. the ONLY numbers an extraction can carry are the recipe's own base
 *      serving count and structural line counts — there is deliberately no field
 *      able to express a mass, a fraction, a nutrient or an FDC identity.
 */
const NUMERIC_FIELDS_ALLOWED = new Set([
  'base_servings',
  'target_count',
  'signal_count',
  'omitted_target_count',
  'omitted_signal_count',
  'skipped_line_count',
]);

function walk(value: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit, depth + 1);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    visit(key, entry);
    walk(entry, visit, depth + 1);
  }
}

/** Authority-shaped keys an extraction must never expose, beyond the contract set. */
const EXTRA_BANNED_KEYS = [
  'calories',
  'protein',
  'carbohydrates',
  'fat',
  'sodium',
  'fiber',
  'fdc_id',
  'nutrient',
  'nutrients',
  'grams',
  'mass',
  'fraction',
  'yield',
  'servings',
  'portions',
  'portion_count',
  'role',
  'relations',
  'preparation_hints',
  'confidence',
  'abstain_reason',
  'suppress',
  'apply',
  'persist',
];

function structuralViolations(extraction: RecipeContextExtraction): string[] {
  const violations: string[] = [];
  walk(extraction, (key, value) => {
    if (isAiRecipeContextAuthorityKey(key)) violations.push(`authority key: ${key}`);
    if (EXTRA_BANNED_KEYS.includes(key)) violations.push(`banned key: ${key}`);
    if (typeof value === 'number' && !NUMERIC_FIELDS_ALLOWED.has(key)) {
      violations.push(`unexpected number at ${key}`);
    }
  });
  return violations;
}

/**
 * EVIDENCE IS QUOTED, NEVER COMPUTED: every evidence clause must appear verbatim
 * inside the authored text of an envelope target.
 */
function unquotedEvidence(extraction: RecipeContextExtraction): string[] {
  const texts = extraction.envelope.targets.map((target) => target.source_text);
  return extraction.signals
    .filter((signal) => !texts.some((text) => text.includes(signal.evidence)))
    .map((signal) => signal.evidence);
}

// ---------------------------------------------------------------------------
// BASIC — the four target context-signal families
// ---------------------------------------------------------------------------
describe('AI-4B basic — ingredient disposition', () => {
  it('"reserve half for sauce" becomes a partial-use signal with source evidence', () => {
    const built = build(['400 g chicken', '200 ml chicken stock'], [
      'Reserve half the chicken for the sauce',
      'Simmer the stock and reduce',
    ]);
    const signal = signalFor(built, 'partial_use', 'reserve half');
    expect(signal).toBeDefined();
    // EVIDENCE, PRESERVED: the exact authored clause, bounded.
    expect(signal?.evidence).toBe('Reserve half the chicken for the sauce');
    // The subject is the DETERMINISTICALLY NAMED ingredient line, never a match.
    expect(signal?.subject_kind).toBe('named_ingredient');
    expect(signal?.subjects).toEqual([built.adapted.adapted[0].line_ref]);
    // The authored ingredient line itself is untouched and present verbatim.
    expect(targetFor(built, '400 g chicken')?.source_text).toBe('400 g chicken');
    // A disposition signal is never a serving or quantity claim.
    expect(built.extraction.envelope.base_servings).toBe(4);
    expect(structuralViolations(built.extraction)).toEqual([]);
    expect(unquotedEvidence(built.extraction)).toEqual([]);
  });

  it('"discard marinade" becomes a not-consumed signal', () => {
    const built = build(['1/2 cup marinade', '400 g chicken thighs'], [
      'Marinate the chicken thighs for 4 hours',
      'Discard the marinade',
    ]);
    const signal = signalFor(built, 'not_consumed', 'discard the marinade');
    expect(signal).toBeDefined();
    expect(signal?.evidence).toBe('Discard the marinade');
    expect(signal?.subjects).toEqual([built.adapted.adapted[0].line_ref]);
    expect(structuralViolations(built.extraction)).toEqual([]);
    expect(unquotedEvidence(built.extraction)).toEqual([]);
  });

  it('"remove bones" becomes a preparation-only signal', () => {
    const built = build(['1 whole chicken'], ['Remove bones from the chicken', 'Roast until done']);
    const signal = signalFor(built, 'preparation_only', 'remove bones');
    expect(signal).toBeDefined();
    expect(signal?.evidence).toBe('Remove bones from the chicken');
    // A preparation signal is instruction evidence only: it states nothing about
    // how much of the line is eaten.
    expect(Object.keys(signal ?? {}).sort()).toEqual([
      'evidence',
      'instruction_line_ref',
      'signal',
      'subject_kind',
      'subjects',
    ]);
    expect(structuralViolations(built.extraction)).toEqual([]);
    expect(unquotedEvidence(built.extraction)).toEqual([]);
  });

  it('a preparation verb without a body part produces NO signal (conservative by design)', () => {
    const built = build(['1 whole chicken'], ['Remove the chicken from the water', 'Chill it']);
    expect(built.extraction.signals).toEqual([]);
  });
});

describe('AI-4B basic — garnish / context-only ingredients', () => {
  it('"garnish with parsley" is a context signal ONLY and mutates no nutrition', () => {
    const built = build(['2 tbsp parsley, for garnish', '400 g chicken'], ['Garnish with parsley']);
    const signal = signalFor(built, 'garnish_only', 'garnish with parsley');
    expect(signal).toBeDefined();
    expect(signal?.subject_kind).toBe('named_ingredient');
    expect(signal?.subjects).toEqual([built.adapted.adapted[0].line_ref]);
    // The garnish line keeps its authored amount text verbatim; nothing was
    // reweighted, zeroed or scaled anywhere in the extraction.
    expect(targetFor(built, '2 tbsp parsley, for garnish')?.source_text).toBe(
      '2 tbsp parsley, for garnish'
    );
    expect(structuralViolations(built.extraction)).toEqual([]);
    expect(unquotedEvidence(built.extraction)).toEqual([]);
  });

  it('"top with green onions" and "finish with parmesan" are garnish signals', () => {
    const built = build(['2 stalks green onions', '30 g parmesan'], [
      'Top with green onions',
      'Finish with parmesan',
    ]);
    expect(signalFor(built, 'garnish_only', 'top with green onions')).toBeDefined();
    expect(signalFor(built, 'garnish_only', 'finish with parmesan')).toBeDefined();
  });
});

describe('AI-4B basic — preparation transformations', () => {
  it('"brush chicken with oil" is instruction evidence only: no absorbed amount', () => {
    const built = build(['400 g chicken', '1 tbsp olive oil'], ['Brush chicken with oil']);
    const signal = signalFor(built, 'transformation', 'brush chicken with oil');
    expect(signal).toBeDefined();
    // There is NO field in the record that could carry an absorbed amount.
    for (const key of Object.keys(signal ?? {})) {
      expect(key.toLowerCase()).not.toContain('amount');
      expect(key.toLowerCase()).not.toContain('absorb');
      expect(key.toLowerCase()).not.toContain('mass');
      expect(key.toLowerCase()).not.toContain('gram');
    }
    expect(signal?.subjects).toContain(built.adapted.adapted[0].line_ref);
    expect(structuralViolations(built.extraction)).toEqual([]);
    expect(unquotedEvidence(built.extraction)).toEqual([]);
  });

  it('"coat vegetables with butter" and "marinate steak overnight" are transformations', () => {
    const built = build(['2 carrots', '30 g butter'], ['Coat the carrots with butter']);
    expect(signalFor(built, 'transformation', 'coat the carrots with butter')).toBeDefined();
    const other = build(['400 g steak'], ['Marinate steak overnight']);
    expect(signalFor(other, 'transformation', 'marinate steak overnight')).toBeDefined();
  });
});

describe('AI-4B basic — division language', () => {
  it('"divide dough into two portions" is instruction context, not a serving calculation', () => {
    const built = build(
      ['2 cups dough', '100 g sugar'],
      ['Divide the dough into two portions'],
      { servings: 3 }
    );
    const signal = signalFor(built, 'division', 'divide the dough into two portions');
    expect(signal).toBeDefined();
    // "two portions" is AUTHORED TEXT. It never becomes a serving count: the
    // envelope's only number is the recipe's own base serving count.
    expect(built.extraction.envelope.base_servings).toBe(3);
    const numbers = built.extraction.envelope.targets
      .map((target) => JSON.stringify(target))
      .filter((text) => /"\s*base_servings|portion_count|servings":/i.test(text));
    expect(numbers).toEqual([]);
  });

  it('"split mixture evenly" is a division signal', () => {
    const built = build(['500 ml milk'], ['Split the mixture evenly between two bowls']);
    expect(signalFor(built, 'division', 'split the mixture evenly')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY — measurement text must NEVER become context
// ---------------------------------------------------------------------------
describe('AI-4B boundary — measurement text is never instruction context', () => {
  it('"half teaspoon salt" does NOT become a context division', () => {
    const built = build(['half teaspoon salt', '400 g chicken'], ['Season the chicken and roast']);
    // No signal mentions the amount, and the amount line carries no evidence slot
    // unless a signal actually named it as a subject.
    for (const signal of built.extraction.signals) {
      expect(signal.evidence.toLowerCase()).not.toContain('teaspoon');
      expect(signal.signal).not.toBe('division');
    }
    const salt = targetFor(built, 'half teaspoon salt');
    expect(salt).toBeDefined();
    expect(salt?.instruction_slots).toBeUndefined();
  });

  it('"2 portions chicken" does NOT alter the serving count', () => {
    const built = build(['2 portions chicken', '1 onion'], ['Slice the onion'], { servings: 6 });
    expect(built.extraction.envelope.base_servings).toBe(6);
    const chicken = targetFor(built, '2 portions chicken');
    expect(chicken?.source_text).toBe('2 portions chicken');
    // The unit word "portions" is authored measurement text, not a division cue.
    for (const signal of built.extraction.signals) {
      expect(signal.signal).not.toBe('division');
      expect(signal.signal).not.toBe('partial_use');
    }
  });

  it('"1/2 cup oil" remains an ingredient amount, not instruction context', () => {
    const built = build(['1/2 cup oil', '400 g chicken'], ['Brush chicken with oil']);
    const oil = targetFor(built, '1/2 cup oil');
    expect(oil?.source_text).toBe('1/2 cup oil');
    // The amount is preserved as AUTHORED TEXT and is never restated as a number
    // the extractor computed.
    expect(oil?.food_semantics).toBe('oil');
    for (const signal of built.extraction.signals) {
      expect(signal.evidence).not.toMatch(/\d/);
    }
    expect(structuralViolations(built.extraction)).toEqual([]);
    expect(unquotedEvidence(built.extraction)).toEqual([]);
  });

  it('"half cooked" does NOT trigger partial-use logic', () => {
    const built = build(['400 g chicken'], ['Cook until the chicken is half cooked']);
    expect(built.extraction.signals).toEqual([]);
    expect(built.extraction.signal_count).toBe(0);
  });

  it('"half" alone, in any clause, never produces a disposition signal', () => {
    for (const text of [
      'Cook until half done',
      'Stir in the half teaspoon of salt',
      'Add half the stock',
      'Bake for half an hour',
    ]) {
      const built = build(['400 g chicken', '500 ml chicken stock'], [text]);
      for (const signal of built.extraction.signals) {
        expect(signal.signal, text).not.toBe('partial_use');
        expect(signal.signal, text).not.toBe('division');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL — unbounded or misleading instructions
// ---------------------------------------------------------------------------
describe('AI-4B adversarial — the evidence surface stays inert', () => {
  const ADVERSARIAL: ReadonlyArray<{
    text: string;
    expected: string | null;
  }> = [
    { text: 'Save half for tomorrow', expected: 'partial_use' },
    { text: 'Reserve remaining sauce', expected: 'partial_use' },
    { text: 'Discard excess flour', expected: 'not_consumed' },
    { text: 'Add oil until coated', expected: null },
    { text: 'Season to taste', expected: null },
    { text: 'Serve half immediately', expected: null },
  ];

  for (const { text, expected } of ADVERSARIAL) {
    it(`"${text}" => ${expected ?? 'no signal'}, and no authority moves`, () => {
      const built = build(
        ['400 g chicken thighs', '1/2 cup marinade', '500 g flour', '1 tbsp oil', '1 onion'],
        [text]
      );
      const matching = built.extraction.signals.filter((signal) =>
        signal.evidence.toLowerCase().includes(text.toLowerCase().split(' ')[0])
      );
      if (expected === null) {
        expect(matching, text).toEqual([]);
      } else {
        expect(matching.length, text).toBeGreaterThan(0);
        for (const signal of matching) expect(signal.signal, text).toBe(expected);
      }
      // The load-bearing adversarial assertion, for EVERY phrase: nothing about
      // nutrition, provenance, identity or persistence is present in the output.
      expect(structuralViolations(built.extraction), text).toEqual([]);
      expect(unquotedEvidence(built.extraction), text).toEqual([]);
      expect(built.extraction.envelope.base_servings, text).toBe(4);
      // The authored ingredient lines survive verbatim.
      for (const line of built.lines) {
        expect(targetFor(built, line)?.source_text, text).toBe(line);
      }
    });
  }

  it('an unbounded-quantity cue vetoes the whole clause ("until coated")', () => {
    const built = build(['1 tbsp oil', '400 g chicken'], ['Add oil until coated']);
    expect(built.extraction.signals).toEqual([]);
    // The instruction is still visible as authored context; only the claim is gone.
    expect(targetFor(built, 'Add oil until coated')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// THE CLOSED CONTRACT SURFACE
// ---------------------------------------------------------------------------
describe('AI-4B contract surface — closed, bounded, non-authoritative', () => {
  it('the extractor identity is the exact deterministic token', () => {
    const built = build(['1 onion'], ['Slice the onion']);
    expect(built.extraction.extractor).toBe(AI_RECIPE_CONTEXT_EXTRACTOR);
    expect(AI_RECIPE_CONTEXT_EXTRACTOR).toBe('nutrition_ai_recipe_context_deterministic_v1');
  });

  it('every emitted signal is a member of the closed signal vocabulary', () => {
    const built = build(
      ['400 g chicken', '2 cups dough', '1/2 cup marinade', '2 tbsp parsley, for garnish'],
      [
        'Reserve half the chicken for the sauce',
        'Discard the marinade',
        'Garnish with parsley',
        'Divide the dough into two portions',
        'Brush chicken with oil',
        'Remove bones from the chicken',
      ]
    );
    expect(built.extraction.signals.length).toBeGreaterThanOrEqual(5);
    for (const signal of built.extraction.signals) {
      expect(AI_RECIPE_CONTEXT_SIGNALS).toContain(signal.signal);
    }
  });

  it('the envelope is the output of the REAL production sanitizer (idempotent)', () => {
    const built = build(['400 g chicken'], ['Reserve half the chicken for the sauce']);
    const resanitized = sanitizeRecipeContextEnvelope(built.extraction.envelope);
    expect(resanitized.ok).toBe(true);
    if (!resanitized.ok) return;
    expect(JSON.stringify(resanitized.envelope)).toBe(JSON.stringify(built.extraction.envelope));
    expect(built.extraction.envelope.contract_version).toBe(AI_RECIPE_CONTEXT_CONTRACT_VERSION);
    expect(built.extraction.envelope.provenance_class).toBe(AI_RECIPE_CONTEXT_PROVENANCE_CLASS);
  });

  it('an extraction carries NO AI-4A interpretation vocabulary and NO confidence', () => {
    const built = build(['400 g chicken'], ['Reserve half the chicken for the sauce']);
    const text = JSON.stringify(built.extraction);
    for (const forbidden of [
      '"role"',
      '"relations"',
      '"preparation_hints"',
      '"confidence"',
      '"abstain_reason"',
      '"explanation"',
      'divided_into',
      'reserved_from',
      'duplicate_of',
      'same_as',
      'cooking_medium',
      'serving_component',
      'garnish"', // the interpretation ROLE, not the deterministic signal token
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('every line ref an extraction mentions is a real envelope target', () => {
    const built = build(
      ['400 g chicken', '2 cups dough', '1/2 cup marinade', '2 tbsp parsley, for garnish', '1 onion'],
      [
        'Reserve half the chicken for the sauce',
        'Discard the marinade',
        'Garnish with parsley',
        'Divide the dough into two portions',
      ]
    );
    const refs = new Set(built.extraction.envelope.targets.map((target) => target.line_ref));
    for (const signal of built.extraction.signals) {
      expect(refs.has(signal.instruction_line_ref), signal.instruction_line_ref).toBe(true);
      expect(signal.subjects.length).toBeLessThanOrEqual(MAX_RECIPE_CONTEXT_SIGNAL_SUBJECTS);
      for (const subject of signal.subjects) {
        expect(refs.has(subject), subject).toBe(true);
      }
      // A subject is only reported when one was deterministically identified.
      expect(signal.subject_kind).toBe(signal.subjects.length === 0 ? 'unlinked' : 'named_ingredient');
    }
  });

  it('signal slots are bounded, opaque and stable across runs', () => {
    const first = build(['400 g chicken'], ['Reserve half the chicken for the sauce']);
    const second = build(['400 g chicken'], ['Reserve half the chicken for the sauce']);
    expect(JSON.stringify(first.extraction)).toBe(JSON.stringify(second.extraction));
    const slots = first.extraction.envelope.targets
      .map((target) => target.instruction_slots ?? [])
      .flat();
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.length).toBeLessThanOrEqual(64);
      // Opaque: a slot exposes no food word, no amount and no kind name.
      expect(slot).toMatch(/^rc1:[0-9a-f]{16}$/);
    }
  });

  it('the AI-4A snapshot binding is stable for one recipe and changes with the authored text', () => {
    const binding = (built: Built): string => {
      const input = recipeContextSnapshotInputFromEnvelope(built.extraction.envelope, 'ai4b');
      expect(input.ok).toBe(true);
      if (!input.ok) throw new Error('snapshot refused');
      return recipeContextSnapshotBinding(input.snapshot);
    };
    const original = build(['400 g chicken'], ['Reserve half the chicken for the sauce']);
    expect(binding(original)).toBe(binding(build(['400 g chicken'], ['Reserve half the chicken for the sauce'])));
    // A different authored instruction is a different recipe context.
    expect(binding(build(['400 g chicken'], ['Reserve a third of the chicken for the sauce']))).not.toBe(
      binding(original)
    );
    // Gaining a signal changes the context, because the evidence is bound in.
    expect(binding(build(['400 g chicken'], ['Reserve half the chicken for the sauce, then discard it']))).not.toBe(
      binding(original)
    );
  });

  it('the AdaptedRecipe input is READ, never modified', () => {
    const lines = ['400 g chicken', '2 cups dough'];
    const adaptedResult = adaptRecipe({
      title: 'Immutability probe',
      servings: 4,
      ingredients: lines.map(structuredLine),
    } as never);
    if (!adaptedResult.ok) throw new Error('adapt failed');
    const before = JSON.stringify(adaptedResult.recipe);
    const instructions = [{ text: 'Reserve half the chicken for the sauce' }];
    const instructionsBefore = JSON.stringify(instructions);
    const result = extractRecipeContext({ recipe: adaptedResult.recipe, instructions });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(adaptedResult.recipe)).toBe(before);
    expect(JSON.stringify(instructions)).toBe(instructionsBefore);
  });

  it('an extraction is JSON-serializable and round-trips unchanged', () => {
    const built = build(['400 g chicken'], ['Garnish with parsley']);
    const round = JSON.parse(JSON.stringify(built.extraction));
    expect(JSON.stringify(round)).toBe(JSON.stringify(built.extraction));
  });
});

// ---------------------------------------------------------------------------
// BOUNDS + FAIL-CLOSED
// ---------------------------------------------------------------------------
describe('AI-4B bounds and fail-closed behavior', () => {
  it('the target budget is the contract budget and omissions are counted', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `${index + 1} g ingredient${index + 1}`);
    const instructions = Array.from({ length: 20 }, (_, index) => `Stir ingredient${index + 1}`);
    const built = build(lines, instructions);
    expect(built.extraction.envelope.targets.length).toBe(MAX_RECIPE_CONTEXT_TARGETS);
    expect(built.extraction.target_count).toBe(MAX_RECIPE_CONTEXT_TARGETS);
    expect(built.extraction.omitted_target_count).toBe(20 + 20 - MAX_RECIPE_CONTEXT_TARGETS);
  });

  it('a signal is never dropped silently when the budget overflows', () => {
    const instructions = Array.from({ length: 20 }, (_, index) => `Discard excess batch ${index}`);
    const built = build(['400 g chicken', '500 g flour', '1 onion'], instructions);
    expect(built.extraction.signal_count).toBe(MAX_RECIPE_CONTEXT_TARGETS);
    expect(built.extraction.omitted_signal_count).toBe(20 - MAX_RECIPE_CONTEXT_TARGETS);
  });

  it('a step longer than the contract text bound is SKIPPED, never truncated', () => {
    const long = `Reserve half the chicken for the sauce ${'x'.repeat(300)}`;
    const built = build(['400 g chicken'], [long, 'Garnish with parsley']);
    expect(built.extraction.skipped_line_count).toBe(1);
    for (const target of built.extraction.envelope.targets) {
      expect(target.source_text).not.toContain('xxxx');
    }
    expect(built.extraction.signals.some((signal) => signal.evidence.includes('xxxx'))).toBe(false);
  });

  it('signals per line are bounded', () => {
    const built = build(['400 g chicken'], [
      'Reserve the chicken, discard the skin, divide the chicken, garnish with the chicken, season the chicken',
    ]);
    expect(built.extraction.signals.length).toBeLessThanOrEqual(MAX_RECIPE_CONTEXT_SIGNALS_PER_LINE);
  });

  it('a recipe with no readable line fails closed with no_context_targets', () => {
    const result = extractRecipeContext({
      recipe: { adapted: [], title: 'Empty', base_servings: 4 },
      instructions: [],
    });
    expect(result).toEqual({ ok: false, code: 'no_context_targets' });
  });

  it('non-object, missing-recipe and non-array inputs fail closed', () => {
    expect(extractRecipeContext(null)).toEqual({ ok: false, code: 'invalid_context' });
    expect(extractRecipeContext('recipe')).toEqual({ ok: false, code: 'invalid_context' });
    expect(extractRecipeContext([])).toEqual({ ok: false, code: 'invalid_context' });
    expect(extractRecipeContext({ instructions: [] })).toEqual({
      ok: false,
      code: 'invalid_context',
    });
    expect(
      extractRecipeContext({ recipe: { adapted: {}, title: 'x' }, instructions: [] })
    ).toEqual({ ok: false, code: 'invalid_context' });
    expect(extractRecipeContext({ recipe: { adapted: [], title: 'x' }, instructions: {} })).toEqual({
      ok: false,
      code: 'invalid_context',
    });
  });

  it('an accessor, a symbol key and a dangerous key fail closed as unsafe', () => {
    const accessor = extractRecipeContext({
      recipe: { adapted: [], title: 'x', base_servings: 2 },
      instructions: [
        {
          get text(): string {
            throw new Error('hostile getter');
          },
        },
      ],
    });
    expect(accessor).toEqual({ ok: false, code: 'unsafe_context' });

    const symbolKeyed = { recipe: { adapted: [], title: 'x' }, instructions: [] } as Record<
      string,
      unknown
    >;
    (symbolKeyed as Record<symbol, unknown>)[Symbol('hostile')] = true;
    expect(extractRecipeContext(symbolKeyed)).toEqual({ ok: false, code: 'unsafe_context' });

    const dangerous = extractRecipeContext({
      recipe: { adapted: [], title: 'x' },
      instructions: [],
      __proto__: { polluted: true },
    } as never);
    expect(dangerous.ok).toBe(false);
  });

  it('an out-of-contract serving count is OMITTED, never coerced', () => {
    const built = build(['400 g chicken'], ['Garnish with parsley'], { servings: 100000 });
    expect(built.extraction.envelope.base_servings).toBeUndefined();
    expect('base_servings' in built.extraction.envelope).toBe(false);
  });

  it('an over-long or empty title is OMITTED, never truncated', () => {
    const long = build(['400 g chicken'], ['Garnish with parsley'], { title: 'T'.repeat(400) });
    expect(long.extraction.envelope.title).toBeUndefined();
    const empty = build(['400 g chicken'], ['Garnish with parsley'], { title: '   ' });
    expect(empty.extraction.envelope.title).toBeUndefined();
  });

  it('instructions are optional: an ingredient-only recipe still yields an envelope', () => {
    const adaptedResult = adaptRecipe({
      title: 'No steps',
      servings: 2,
      ingredients: ['400 g chicken'].map(structuredLine),
    } as never);
    if (!adaptedResult.ok) throw new Error('adapt failed');
    const result = extractRecipeContext({ recipe: adaptedResult.recipe });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.signals).toEqual([]);
    expect(result.extraction.envelope.targets).toHaveLength(1);
  });
});
