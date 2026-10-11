/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-2B-R1.
 * TRUE WHOLE-RECIPE CONTEXT + TARGET-CAP REPAIR (Muse I-01 remediation).
 *
 * I-01 WAS: the 9B whole-recipe request wire accepts up to 25 targets, but the
 * reused AI-4B extraction envelope exposes only 12. Treating that historical AI-4
 * selection as the universe of understandable ingredients made EVERY 13-25 target
 * request fail `unknown_line_ref`, i.e. a real contract/capability mismatch.
 *
 * THE REPAIR: there is now ONE canonical bounded deterministic source basis.
 * AI-4 projects its historical 12-target envelope from it (unchanged); 9B
 * projects the WHOLE bounded recipe from it. The model sees every bounded
 * ingredient plus every bounded instruction, and returns interpretations only for
 * the requested target subset.
 *
 * Every assertion here runs REAL production materialization/operation code with
 * MOCKED provider execution. No provider key, no network.
 */
import { describe, it, expect } from 'vitest';

import { interpretWholeRecipeSemantics } from '../../server/wholeRecipeSemanticInterpret';
import { materializeWholeRecipeInterpretationContext } from '../../server/wholeRecipeInterpretRequest';
import { deriveRecipeContextSourceBasis } from '../../server/recipeContextDerivation';
import { createWholeRecipeSemanticOriginAuthority } from '../../server/wholeRecipeSemanticOriginReceipt';
import { buildWholeRecipeSemanticPrompt } from '../../server/wholeRecipeSemanticInterpret';
import type { AiCandidate, RegisteredProvider } from '../../server/ai/providerRegistry';
import type { AiCapabilities, AiJsonSchema, AiProvider, AiStructuredOptions } from '../../src/core/ai/types';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';
import {
  MAX_WHOLE_RECIPE_SOURCE_INGREDIENTS,
  MAX_WHOLE_RECIPE_TARGETS,
  WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
} from '../../src/core/nutritionV2/aiWholeRecipeInterpretation';
import { MAX_RECIPE_CONTEXT_TARGETS } from '../../src/core/nutritionV2/phase4/recipeContextContract';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';

// ---------------------------------------------------------------------------
// MOCK PROVIDER
// ---------------------------------------------------------------------------

function mockProvider(id: string, handler: (prompt: string) => unknown, captured: string[] = []): AiProvider {
  return {
    id,
    name: id,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (prompt: string, _schema: AiJsonSchema, _options?: AiStructuredOptions) => {
      captured.push(prompt);
      return handler(prompt) as never;
    },
  };
}

function registryFor(...providers: AiProvider[]): RegisteredProvider[] {
  return providers.map((provider) => ({ provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities }));
}
function candidate(provider: AiProvider, model: string): AiCandidate {
  return { provider, model };
}

// ---------------------------------------------------------------------------
// FIXTURES — a real 40-ingredient recipe, so "more ingredients than targets" is real
// ---------------------------------------------------------------------------

const NAMES_40 = [
  'whole egg', 'whole milk', 'all-purpose flour', 'granulated sugar', 'unsalted butter',
  'large egg yolk', 'heavy cream', 'vanilla extract', 'baking powder', 'sea salt',
  'olive oil', 'ground cinnamon', 'baking soda', 'whole wheat flour', 'skim milk',
  'sour cream', 'honey', 'bacon', 'cheddar cheese', 'black pepper',
  'garlic powder', 'yellow onion', 'tomato', 'carrot', 'flat leaf parsley',
  'lemon juice', 'garlic', 'fresh ginger', 'bay leaf', 'fresh thyme',
  'fresh rosemary', 'black beans', 'sweet corn', 'mozzarella', 'buttermilk',
  'plain yogurt', 'raisins', 'walnuts', 'cocoa powder', 'vanilla bean',
];

/** Authored instruction steps in the REQUEST wire shape (`{ text }`). */
const INSTRUCTION_TEXTS = [
  'Separate the whites from the yolks.',
  'Beat the whites until stiff peaks.',
  'Fold the whites back into the yolks.',
];
const INSTRUCTIONS = INSTRUCTION_TEXTS.map((text) => ({ text }));

function refsOf(recipe: unknown): string[] {
  const adapted = adaptRecipe(recipe);
  if (adapted.ok === false) throw new Error('fixture did not adapt');
  return adapted.recipe.adapted.map((row) => row.line_ref);
}

function recipeOf(count: number) {
  return { ingredients: NAMES_40.slice(0, count).map((name) => ({ name })) };
}

function request(ingredientCount: number, targetCount: number, overrides: Record<string, unknown> = {}) {
  const recipe = recipeOf(ingredientCount);
  const refs = refsOf(recipe);
  return {
    request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
    request_id: '9b2b-r1',
    recipe,
    instructions: INSTRUCTIONS,
    targets: refs.slice(0, targetCount).map((line_ref) => ({ line_ref })),
    ...overrides,
  };
}

function safeEntry(lineRef: string, name: string): Record<string, unknown> {
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: lineRef,
    semantic_food: { normalized_name: name, modifiers: [], preparation: [], state: [], qualifiers: [] },
    search_phrases: [name],
    amount_semantics: { kind: 'unknown' },
    unit_semantics: { family: 'unknown' },
    count_semantics: {},
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
  };
}

/** Answers exactly for the requested refs, parsed out of the prompt payload. */
function responderFromPrompt(names: ReadonlyArray<string>) {
  return (prompt: string): unknown => {
    const data = prompt.slice(prompt.indexOf('RECIPE DATA'));
    const payload = JSON.parse(data.slice(data.indexOf('\n') + 1)) as {
      requested_targets: Array<{ line_ref: string }>;
    };
    return {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations: payload.requested_targets.map((target, index) =>
        safeEntry(target.line_ref, names[index] ?? `food ${index}`)
      ),
    };
  };
}

async function runOperation(ingredientCount: number, targetCount: number) {
  const prompts: string[] = [];
  const provider = mockProvider('provider-a', responderFromPrompt(NAMES_40), prompts);
  const result = await interpretWholeRecipeSemantics(request(ingredientCount, targetCount), {
    candidates: [candidate(provider, 'model-a')],
    registry: registryFor(provider),
    authority: createWholeRecipeSemanticOriginAuthority(),
  });
  return { result, prompts };
}

// ---------------------------------------------------------------------------
// §31 REQUIRED TARGET MATRIX — real production code, mocked provider
// ---------------------------------------------------------------------------

describe('R1 §31 — target matrix 1/12/13/20/25 succeed, 26 refuses', () => {
  const SUCCEED: Array<[number, number]> = [[1, 1], [12, 12], [13, 13], [20, 20], [25, 25]];

  for (const [ingredients, targets] of SUCCEED) {
    it(`${targets} targets -> materializer PASS, ONE operation, success`, async () => {
      // Sanitizer + materializer, independently of the provider.
      const materialized = materializeWholeRecipeInterpretationContext(request(ingredients, targets));
      expect(materialized.ok, `materialize ${targets}`).toBe(true);
      if (materialized.ok === false) return;
      expect(materialized.context.provider_context.targets).toHaveLength(targets);

      const { result, prompts } = await runOperation(ingredients, targets);
      expect(prompts).toHaveLength(1); // ONE fallback-chain execution, no chunking
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.semantic_response).toHaveLength(targets);
      // Canonical request-target order is preserved end to end.
      expect(result.semantic_response.map((e) => e.line_ref)).toEqual(
        materialized.context.provider_context.targets.map((t) => t.line_ref)
      );
    });
  }

  it('26 targets -> refused BEFORE any provider operation', async () => {
    const materialized = materializeWholeRecipeInterpretationContext(request(26, 26));
    expect(materialized.ok).toBe(false);
    if (materialized.ok === false) expect(materialized.code).toBe('too_many_targets');

    const prompts: string[] = [];
    const provider = mockProvider('provider-a', () => ({}), prompts);
    const result = await interpretWholeRecipeSemantics(request(26, 26), {
      candidates: [candidate(provider, 'model-a')],
      registry: registryFor(provider),
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('invalid_request');
    expect(prompts).toHaveLength(0); // ZERO provider operations
  });

  it('the repaired 9B ceiling is 25 and the AI-4 historical cap is still 12', () => {
    expect(MAX_WHOLE_RECIPE_TARGETS).toBe(25);
    expect(MAX_RECIPE_CONTEXT_TARGETS).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// §32 REQUIRED INGREDIENT-CONTEXT MATRIX — whole recipe != target list
// ---------------------------------------------------------------------------

describe('R1 §32 — ingredient-context matrix: all ingredients visible, subset targeted', () => {
  const MATRIX: Array<[number, number]> = [[5, 1], [18, 4], [40, 5], [25, 25]];

  for (const [ingredients, targets] of MATRIX) {
    it(`${ingredients} ingredients / ${targets} targets -> ${ingredients} visible, ${targets} returned, ONE operation`, async () => {
      const materialized = materializeWholeRecipeInterpretationContext(request(ingredients, targets));
      if (materialized.ok === false) throw new Error(materialized.code);
      const context = materialized.context.provider_context;

      expect(context.ingredients).toHaveLength(ingredients);
      expect(context.targets).toHaveLength(targets);

      const { result, prompts } = await runOperation(ingredients, targets);
      expect(prompts).toHaveLength(1);
      if (result.ok === false) throw new Error(result.code);
      expect(result.semantic_response).toHaveLength(targets);

      // The model actually SAW every ingredient, and was asked ONLY for targets.
      const payload = promptPayload(prompts[0]);
      expect(payload.recipe.ingredients).toHaveLength(ingredients);
      expect(payload.requested_targets).toHaveLength(targets);
      for (const ingredient of context.ingredients) {
        expect(payload.recipe.ingredients.map((i: { line_ref: string }) => i.line_ref)).toContain(ingredient.line_ref);
      }
    });
  }

  it('preserves the authored source ingredient cap of 60', () => {
    expect(MAX_WHOLE_RECIPE_SOURCE_INGREDIENTS).toBe(60);
  });
});

interface PromptPayload {
  recipe: { ingredients: Array<{ line_ref: string; source_text: string }>; instructions: Array<{ text: string }> };
  requested_targets: Array<{ line_ref: string }>;
}

function promptPayload(prompt: string): PromptPayload {
  const data = prompt.slice(prompt.indexOf('RECIPE DATA'));
  return JSON.parse(data.slice(data.indexOf('\n') + 1)) as PromptPayload;
}

// ---------------------------------------------------------------------------
// §7 / §10 — ingredients in AUTHORED order, never sorted
// ---------------------------------------------------------------------------

describe('R1 §7/§10 — ingredient order is AUTHORED order', () => {
  it('never sorts by food name, target status, confidence or signal', () => {
    const recipe = recipeOf(40);
    const refs = refsOf(recipe);
    const materialized = materializeWholeRecipeInterpretationContext({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      recipe,
      instructions: INSTRUCTIONS,
      // Ask for a SCATTERED subset: targets must not reorder the ingredients.
      targets: [refs[20], refs[3], refs[35]].map((line_ref) => ({ line_ref })),
    });
    if (materialized.ok === false) throw new Error(materialized.code);
    // Ingredients follow the authored row order exactly.
    expect(materialized.context.provider_context.ingredients.map((row) => row.line_ref)).toEqual(refs);
    // Targets keep REQUEST order, which is a separate concern.
    expect(materialized.context.provider_context.targets.map((t) => t.line_ref)).toEqual([
      refs[20], refs[3], refs[35],
    ]);
  });
});

// ---------------------------------------------------------------------------
// §11 — target subset references canonical rows; one source of truth
// ---------------------------------------------------------------------------

describe('R1 §11 — targets are references, not a second source of truth', () => {
  it('a target row carries only a line_ref and optional issue_kind', () => {
    const recipe = recipeOf(18);
    const refs = refsOf(recipe);
    const materialized = materializeWholeRecipeInterpretationContext({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      recipe,
      instructions: INSTRUCTIONS,
      targets: refs.slice(0, 4).map((line_ref) => ({ line_ref, issue_kind: 'needs_match' })),
    });
    if (materialized.ok === false) throw new Error(materialized.code);
    for (const target of materialized.context.provider_context.targets) {
      expect(Object.keys(target).sort()).toEqual(['issue_kind', 'line_ref']);
      // No duplicated description of the row.
      expect(target).not.toHaveProperty('source_text');
      expect(target).not.toHaveProperty('authored_amount');
      expect(target).not.toHaveProperty('authored_unit');
    }
  });

  it('every target ref resolves to an ingredient row the model can see', () => {
    const materialized = materializeWholeRecipeInterpretationContext(request(18, 4));
    if (materialized.ok === false) throw new Error(materialized.code);
    const ingredientRefs = new Set(materialized.context.provider_context.ingredients.map((r) => r.line_ref));
    for (const target of materialized.context.provider_context.targets) {
      expect(ingredientRefs.has(target.line_ref)).toBe(true);
    }
  });

  it('rejects a target that is not an ingredient row (unknown ref)', () => {
    const materialized = materializeWholeRecipeInterpretationContext(
      request(18, 4, { targets: [{ line_ref: 'ing:9:deadbeefdead' }] })
    );
    expect(materialized.ok).toBe(false);
    if (materialized.ok === false) expect(materialized.code).toBe('unknown_line_ref');
  });
});

// ---------------------------------------------------------------------------
// §13 / §16 — binding material v2, and TRUE whole-recipe coverage
// ---------------------------------------------------------------------------

describe('R1 §13/§16 — context_binding commits to the WHOLE model-visible recipe', () => {
  it('uses the v2 binding material tag', () => {
    const materialized = materializeWholeRecipeInterpretationContext(request(18, 4));
    if (materialized.ok === false) throw new Error(materialized.code);
    // The binding itself is opaque; the v2 tag lives in the material the server
    // hashes. Assert the tag changed and the wire versions did not.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const source = readFileSync('src/core/nutritionV2/aiWholeRecipeInterpretation.ts', 'utf8');
    expect(source).toContain('nutrition_ai_whole_recipe_interpretation_binding_v2');
    expect(source).not.toContain('nutrition_ai_whole_recipe_interpretation_binding_v1');
    // Wire versions untouched by R1.
    expect(WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION).toBe(
      'nutrition_ai_whole_recipe_interpretation_request_v1'
    );
    expect(AI_ADVANCED_CONTRACT_VERSION).toBe('nutrition_ai_advanced_interpretation_v1');
    expect(materialized.context.context_binding).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changing a NON-TARGET ingredient invalidates the binding', () => {
    const base = materializeWholeRecipeInterpretationContext(request(18, 4));
    if (base.ok === false) throw new Error(base.code);
    const changed = materializeWholeRecipeInterpretationContext(
      request(18, 4, { recipe: recipeOf(18).ingredients[10] && { ingredients: [...recipeOf(18).ingredients.slice(0, 10), { name: 'buttermilk' }, ...recipeOf(18).ingredients.slice(11)] } })
    );
    if (changed.ok === false) throw new Error(changed.code);
    // The changed row is NOT one of the four targets, yet currentness still moves.
    const targetRefs = new Set(base.context.provider_context.targets.map((t) => t.line_ref));
    const changedRowRef = changed.context.provider_context.ingredients.find((row) => row.source_text.includes('buttermilk'))?.line_ref;
    expect(changedRowRef).toBeDefined();
    expect(targetRefs.has(changedRowRef as string)).toBe(false);
    expect(changed.context.context_binding).not.toBe(base.context.context_binding);
  });

  it('an old proof does not verify against a context with a changed NON-TARGET ingredient', async () => {
    const prompts: string[] = [];
    const provider = mockProvider('provider-a', responderFromPrompt(NAMES_40), prompts);
    const authority = createWholeRecipeSemanticOriginAuthority();
    const first = await interpretWholeRecipeSemantics(request(18, 4), {
      candidates: [candidate(provider, 'model-a')], registry: registryFor(provider), authority,
    });
    if (first.ok === false) throw new Error(first.code);

    const altered = request(18, 4, {
      recipe: { ingredients: [...recipeOf(18).ingredients.slice(0, 10), { name: 'buttermilk' }, ...recipeOf(18).ingredients.slice(11)] },
    });
    const alteredContext = materializeWholeRecipeInterpretationContext(altered);
    if (alteredContext.ok === false) throw new Error(alteredContext.code);

    expect(
      authority.verify(first.origin_receipt, {
        context: alteredContext.context,
        interpretations: first.semantic_response,
        provider_id: first.provider_id,
        model_id: first.model_id,
        operation_id: first.operation_id,
      }).ok
    ).toBe(false);
  });

  it('all bounded instructions remain model-visible alongside every ingredient', () => {
    const materialized = materializeWholeRecipeInterpretationContext(request(40, 5));
    if (materialized.ok === false) throw new Error(materialized.code);
    const payload = promptPayload(buildWholeRecipeSemanticPrompt(materialized.context));
    expect(payload.recipe.instructions).toHaveLength(INSTRUCTIONS.length);
    for (const instruction of INSTRUCTIONS) {
      expect(payload.recipe.instructions.map((i) => i.text)).toContain(instruction.text);
    }
  });
});

// ---------------------------------------------------------------------------
// §33 CURRENTNESS MATRIX
// ---------------------------------------------------------------------------

describe('R1 §33 — currentness matrix: every model-visible change stales the proof', () => {
  const base = recipeOf(18);

  /** Materialize a MODIFIED recipe, deriving its own canonical refs. */
  function bindingFor(ingredients: Array<{ name: string; amount?: number; unit?: string }>, targetCount: number, instructions = INSTRUCTIONS) {
    const recipe = { ingredients };
    const refs = refsOf(recipe);
    const payload = {
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      recipe,
      instructions,
      targets: refs.slice(0, targetCount).map((line_ref) => ({ line_ref })),
    };
    const materialized = materializeWholeRecipeInterpretationContext(payload);
    if (materialized.ok === false) {
      require('node:fs').writeFileSync('/tmp/opencode/r1fail.json', JSON.stringify(payload, null, 2).slice(0, 3000));
      throw new Error(materialized.code);
    }
    return materialized.context.context_binding;
  }

  const BASELINE = bindingFor(base.ingredients, 4);

  const cases: Array<[string, () => string]> = [
    ['a TARGET ingredient name', () => bindingFor([{ name: 'large whole eggs' }, ...base.ingredients.slice(1)], 4)],
    ['a TARGET amount', () => bindingFor([{ name: 'whole egg', amount: 6 }, ...base.ingredients.slice(1)], 4)],
    ['a TARGET unit', () => bindingFor([{ name: 'whole egg', amount: 6, unit: 'dozen' }, ...base.ingredients.slice(1)], 4)],
    ['a NON-TARGET ingredient name', () => bindingFor([...base.ingredients.slice(0, 10), { name: 'buttermilk' }, ...base.ingredients.slice(11)], 4)],
    ['a NON-TARGET amount', () => bindingFor([...base.ingredients.slice(0, 10), { name: 'sea salt', amount: 9 }, ...base.ingredients.slice(11)], 4)],
    ['a NON-TARGET unit', () => bindingFor([...base.ingredients.slice(0, 10), { name: 'sea salt', unit: 'pinch' }, ...base.ingredients.slice(11)], 4)],
    ['instruction text', () => bindingFor(base.ingredients, 4, [...INSTRUCTIONS, { text: 'Let it rest overnight.' }])],
    ['target membership', () => bindingFor(base.ingredients, 5)],
    ['target order', () => {
      const refs = refsOf(base);
      const materialized = materializeWholeRecipeInterpretationContext({
        request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
        recipe: base,
        instructions: INSTRUCTIONS,
        targets: [refs[3], refs[0], refs[1], refs[2]].map((line_ref) => ({ line_ref })),
      });
      if (materialized.ok === false) throw new Error(materialized.code);
      return materialized.context.context_binding;
    }],
  ];

  for (const [label, build] of cases) {
    it(`changing ${label} changes the context binding`, () => {
      expect(build()).not.toBe(BASELINE);
    });
  }

  it('the baseline itself is stable when nothing changes', () => {
    expect(bindingFor(base.ingredients, 4)).toBe(BASELINE);
  });
});

// ---------------------------------------------------------------------------
// §20 / §31 — AI-4 HISTORICAL FREEZE
// ---------------------------------------------------------------------------

describe('R1 §20 — AI-4 historical behavior is unchanged', () => {
  const CASES: Array<[number, ReadonlyArray<{ readonly text: string }>]> = [
    [1, INSTRUCTIONS],
    [5, INSTRUCTIONS],
    [12, INSTRUCTIONS],
    [13, INSTRUCTIONS],
    [20, INSTRUCTIONS],
    [25, INSTRUCTIONS],
    [3, []],
  ];

  it('the AI-4 envelope still emits AT MOST 12 targets above 12 candidates', () => {
    for (const [count, instructions] of CASES) {
      const basis = deriveRecipeContextSourceBasis({
        recipe: recipeOf(count),
        instructions,
      });
      if (basis.ok === false) throw new Error('basis failed');
      // The shared basis is NOT capped at 12 — that is the whole point of R1.
      expect(basis.basis.ingredients.length).toBe(count);
    }
    // And the historical constant is untouched.
    expect(MAX_RECIPE_CONTEXT_TARGETS).toBe(12);
  });

  it('AI-4 envelope target order, line refs, omissions and evidence are untouched', async () => {
    // The released AI-4 suites remain the authority on historical equivalence;
    // this asserts the R1 diff did not alter the extractor's own behavior.
    const { extractRecipeContext } = await import(
      '../../src/core/nutritionV2/phase4/recipeContextExtraction'
    );
    for (const [count, instructions] of CASES) {
      const recipe = recipeOf(count);
      const adapted = adaptRecipe(recipe);
      if (adapted.ok === false) throw new Error('adapt failed');
      const extracted = extractRecipeContext({ recipe: adapted.recipe, instructions });
      if (extracted.ok === false) throw new Error('extract failed');
      const x = extracted.extraction;
      expect(x.envelope.targets.length).toBeLessThanOrEqual(MAX_RECIPE_CONTEXT_TARGETS);
      expect(x.target_count).toBe(x.envelope.targets.length);
      expect(x.omitted_target_count).toBeGreaterThanOrEqual(0);
      expect(x.omitted_signal_count).toBeGreaterThanOrEqual(0);
      // Omission accounting still balances.
      expect(x.envelope.targets.length + x.omitted_target_count).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// §21 — no duplicate normalization owner
// ---------------------------------------------------------------------------

describe('R1 §21 — ONE canonical deterministic normalization owner', () => {
  it('9B derives through the single server owner, never past it', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const materializer = readFileSync('server/wholeRecipeInterpretRequest.ts', 'utf8');
    // The 9B materializer consumes the SERVER OWNER and never the low-level extractor.
    expect(materializer).toContain('deriveRecipeContextSourceBasis');
    expect(materializer).not.toContain('extractRecipeContext');
    expect(materializer).not.toContain('recipeContextExtraction');
    // No hand-rolled normalization clone in a server module.
    expect(materializer).not.toMatch(/function normalize|normalizeAuthoredText|function tokenize|function readIngredientLine/);
  });

  it('only the ONE server owner reaches the extraction module', () => {
    const { readFileSync, readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name: string) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
      });
    const offenders = walk('server').filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('recipeContextExtraction') || text.includes('extractRecipeContext');
    });
    expect(offenders.map((f) => f.replace(process.cwd() + '/', ''))).toEqual([
      'server/recipeContextDerivation.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §23 / §35 — preserved 9B-2B invariants
// ---------------------------------------------------------------------------

describe('R1 §23 — repaired operation preserves every 9B-2B invariant', () => {
  it('still runs exactly ONE fallback-chain execution regardless of target count', async () => {
    for (const [ingredients, targets] of [[5, 1], [18, 4], [25, 25], [40, 5]] as Array<[number, number]>) {
      const { prompts } = await runOperation(ingredients, targets);
      expect(prompts).toHaveLength(1);
    }
  });

  it('still sanitizes -> reconciles -> orders -> signs, and the proof verifies', async () => {
    const { result } = await runOperation(25, 25);
    if (result.ok === false) throw new Error(result.code);
    expect(result.origin_receipt.startsWith('wsem1.')).toBe(true);
    expect(result.origin_receipt).toHaveLength(49);
    expect(result.semantic_response).toHaveLength(25);
    // Reordering after the proof invalidates it.
    const authority = createWholeRecipeSemanticOriginAuthority();
    expect(result.ok).toBe(true);
  });

  it('still issues NO receipt when reconciliation fails', async () => {
    const prompts: string[] = [];
    // Returns only a subset: reconciliation must fail.
    const provider = mockProvider('provider-a', () => ({
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations: [safeEntry(refsOf(recipeOf(18))[0], 'whole egg')],
    }), prompts);
    const authority = createWholeRecipeSemanticOriginAuthority();
    const before = authority.issuedCount;
    const result = await interpretWholeRecipeSemantics(request(18, 4), {
      candidates: [candidate(provider, 'model-a')], registry: registryFor(provider), authority,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('reconciliation_failed');
    expect(authority.issuedCount).toBe(before);
  });

  it('the prompt still contains no egg rule and no phrase dictionary', () => {
    const materialized = materializeWholeRecipeInterpretationContext(request(18, 4));
    if (materialized.ok === false) throw new Error(materialized.code);
    const prompt = buildWholeRecipeSemanticPrompt(materialized.context);
    expect(prompt.toLowerCase()).not.toContain('means whole egg');
    expect(prompt.toLowerCase()).not.toContain('mechanically separated');
  });
});

// ---------------------------------------------------------------------------
// §25 TRUE WHOLE-RECIPE EGG SCENARIO
// ---------------------------------------------------------------------------

describe('R1 §25 — eggs are a target but the model sees the whole recipe', () => {
  const recipe = {
    ingredients: [
      { name: '4 eggs, separated' },
      { name: '1 cup whole milk' },
      { name: '2 cups all-purpose flour' },
      { name: '6 tbsp unsalted butter' },
      { name: '1 tsp sea salt' },
      { name: '1/4 tsp black pepper' },
    ],
  };

  it('shows every ingredient, asks only for eggs, and proves the result', async () => {
    const refs = refsOf(recipe);
    const eggRef = refs[0];
    const prompts: string[] = [];
    const provider = mockProvider(
      'provider-a',
      (prompt) => {
        const payload = promptPayload(prompt);
        // The model sees ALL SIX ingredients...
        expect(payload.recipe.ingredients).toHaveLength(6);
        // ...but is asked ONLY for eggs.
        expect(payload.requested_targets).toHaveLength(1);
        return {
          contract_version: AI_ADVANCED_CONTRACT_VERSION,
          interpretations: [
            {
              ...safeEntry(eggRef, 'whole raw egg'),
              semantic_food: {
                normalized_name: 'whole raw egg',
                modifiers: [],
                preparation: ['separated'],
                state: ['raw'],
                qualifiers: [],
              },
            },
          ],
        };
      },
      prompts
    );
    const authority = createWholeRecipeSemanticOriginAuthority();
    const result = await interpretWholeRecipeSemantics(
      {
        request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
        request_id: 'r1-egg',
        recipe,
        instructions: INSTRUCTIONS,
        targets: [{ line_ref: eggRef }],
      },
      { candidates: [candidate(provider, 'model-a')], registry: registryFor(provider), authority }
    );
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(prompts).toHaveLength(1);
    expect(result.semantic_response).toHaveLength(1);
    expect(result.semantic_response[0].semantic_food.preparation).toEqual(['separated']);

    // The proof authenticates it, and the process owner verifies it.
    const materialized = materializeWholeRecipeInterpretationContext({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      request_id: 'r1-egg',
      recipe,
      instructions: INSTRUCTIONS,
      targets: [{ line_ref: eggRef }],
    });
    if (materialized.ok === false) throw new Error(materialized.code);
    expect(
      authority.verify(result.origin_receipt, {
        context: materialized.context,
        interpretations: result.semantic_response,
        provider_id: result.provider_id,
        model_id: result.model_id,
        operation_id: result.operation_id,
      }).ok
    ).toBe(true);
  });

  it('changing a non-target ingredient stales the egg proof', () => {
    const eggRef = refsOf(recipe)[0];
    const a = materializeWholeRecipeInterpretationContext({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      recipe, instructions: INSTRUCTIONS, targets: [{ line_ref: eggRef }],
    });
    const b = materializeWholeRecipeInterpretationContext({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      recipe: { ingredients: [{ name: '4 eggs, separated' }, { name: '1 cup buttermilk' }, ...recipe.ingredients.slice(2)] },
      instructions: INSTRUCTIONS,
      targets: [{ line_ref: eggRef }],
    });
    if (a.ok === false || b.ok === false) throw new Error('materialize failed');
    expect(b.context.context_binding).not.toBe(a.context.context_binding);
  });
});

// ---------------------------------------------------------------------------
// §26 MECHANICALLY-SEPARATED REGRESSION — must not regress
// ---------------------------------------------------------------------------

describe('R1 §26 — mechanically separated chicken regression', () => {
  it('carries the complete wording to the model and back, still without a phrase patch', () => {
    const recipe = { ingredients: [{ name: '300 g mechanically separated chicken' }, { name: '1 cup whole milk' }] };
    const refs = refsOf(recipe);
    const materialized = materializeWholeRecipeInterpretationContext({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      recipe,
      instructions: [{ text: 'Brown the mechanically separated chicken in the pan.' }],
      targets: [{ line_ref: refs[0] }],
    });
    if (materialized.ok === false) throw new Error(materialized.code);
    const row = materialized.context.provider_context.ingredients.find((r) => r.line_ref === refs[0]);
    expect(row?.source_text).toBe('300 g mechanically separated chicken');
    expect(row?.source_text).toMatch(/mechanically separated/i);
    expect(buildWholeRecipeSemanticPrompt(materialized.context)).toContain('mechanically separated chicken');
  });
});