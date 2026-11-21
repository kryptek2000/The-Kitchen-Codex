/**
 * AI-FIRST Advanced Nutrition — real end-to-end vertical slice.
 *
 * REAL Express server over REAL HTTP, REAL pinned USDA bundle, REAL Phase-4
 * session, REAL deterministic verification and calculation. ONLY the external
 * AI provider is mocked.
 *
 * The workflow under test is exactly the product flow:
 *
 *   authored recipe
 *     -> pass 1 whole-recipe interpretation (ONE provider chain)
 *     -> local full-catalog USDA discovery (no lexical confidence gate)
 *     -> pass 2 candidate evaluation over the ACTUAL records (ONE provider chain)
 *     -> local record/source verification + authenticated portion
 *     -> existing calculation / working state / Apply boundary
 *
 * No live provider is contacted and no nutrition authority is fabricated.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NutritionProductAccessAuthority } from '../../server/nutritionProductAccessAuthority.js';
import type { RegisteredProvider } from '../../server/ai/providerRegistry';
import type { AiCapabilities, AiJsonSchema, AiProvider, AiStructuredOptions } from '../../src/core/ai/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import { resolveWithAiFirst } from '../../src/application/nutritionAiFirst';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import {
  adaptRecipe,
  analyzeRecipe,
  buildCalculationRequest,
  buildReviewRows,
  liveExceptionKind,
  projectLiveRows,
  verifyAiFirstCandidateDecisions,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import {
  BASIC_NUTRITION_CAPABILITIES,
  resolveNutritionCapabilities,
} from '../../src/core/nutritionV2/nutritionCapabilities';

const AI_ADVANCED_CAPABILITIES = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);
const AI_ENDPOINT_TOKEN = 'aif1-app-token';

const BENCHMARK_A_LINES = ['2 tbsp unsalted butter', '1 cup half and half', '1 cup passata'];
const BENCHMARK_A_INSTRUCTIONS = [
  'Melt the butter in a saucepan over medium heat.',
  'Stir in the half and half and the passata.',
  'Simmer gently for ten minutes, then season to taste.',
];

const BENCHMARK_B_LINES = ['1 cup canned coconut milk'];
const BENCHMARK_B_INSTRUCTIONS = [
  'Use canned coconut milk, not the sweetened beverage.',
  'Shake the can well, then measure one cup for the curry.',
  'Simmer gently; do not boil hard.',
];

/**
 * The app is imported AFTER `vi.resetModules()`, so the test must use the SAME
 * fresh providerErrors module instance for an `instanceof`-preserved CANCELLED
 * error. A module loaded before `resetModules` would be a different class.
 */
let liveCallerCancellationError:
  | ((ctx?: { providerId?: string; model?: string }, cause?: unknown) => Error)
  | null = null;

const prov = vi.hoisted(() => ({
  calls: 0,
  prompts: [] as string[],
  throwOnPass: 0 as 0 | 1 | 2,
  overridePassOne: null as null | ((payload: unknown) => unknown),
  overridePassTwo: null as null | ((payload: unknown) => unknown),
  abortPassOne: false,
  passOneSignal: null as AbortSignal | null,
  markPassOneStarted: null as (() => void) | null,
}));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return {
    ...actual,
    getRegisteredProviders: () =>
      (globalThis as never as { __AIF1_REGISTRY?: RegisteredProvider[] }).__AIF1_REGISTRY ?? [],
  };
});

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

function payloadAfter(prompt: string, marker: string): unknown {
  const at = prompt.indexOf(marker);
  if (at < 0) throw new Error(`missing prompt marker: ${marker}`);
  const data = prompt.slice(at);
  return JSON.parse(data.slice(data.indexOf('\n') + 1));
}

function semanticInterpretation(lineRef: string, sourceText: string): unknown {
  const parsed = parseIngredient(sourceText);
  const query = parsed.ok ? parsed.parsed.query : sourceText;
  const amount = parsed.ok ? parsed.parsed.amount : null;
  const unit = parsed.ok ? parsed.parsed.raw_unit : undefined;
  const lower = sourceText.toLowerCase();
  let identity = query;
  let phrases = [query];
  if (lower.includes('half and half')) {
    identity = 'half and half';
    phrases = ['half and half', 'cream half and half'];
  } else if (lower.includes('passata')) {
    identity = 'tomato passata';
    phrases = ['tomato puree', 'tomato passata', 'crushed tomatoes'];
  } else if (lower.includes('butter')) {
    identity = 'unsalted butter';
    phrases = ['unsalted butter', 'butter stick unsalted'];
  } else if (lower.includes('coconut milk')) {
    identity = 'canned coconut milk';
    phrases = ['coconut milk canned', 'canned coconut milk', 'coconut milk'];
  } else if (lower.includes('quinoa')) {
    identity = 'quinoa';
    phrases = ['quinoa', 'quinoa uncooked', 'dry quinoa'];
  }
  const family =
    unit === 'cup' || unit === 'tbsp' || unit === 'tsp' || unit === 'ml' || unit === 'l'
      ? 'volume'
      : 'unknown';
  return {
    contract_version: 'nutrition_ai_advanced_interpretation_v1',
    line_ref: lineRef,
    semantic_food: {
      normalized_name: identity,
      modifiers: [],
      preparation: [],
      state: [],
      qualifiers: [],
    },
    search_phrases: phrases,
    amount_semantics: {
      kind: 'exact',
      ...(typeof amount === 'number' ? { echoed_value: amount } : {}),
      phrasing: 'authored quantity',
    },
    unit_semantics: {
      family,
      ...(unit !== undefined ? { raw: unit } : {}),
    },
    count_semantics: {},
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
  };
}

function semanticReply(prompt: string): unknown {
  const payload = payloadAfter(prompt, 'RECIPE DATA') as {
    requested_targets: Array<{ line_ref: string }>;
    recipe: { ingredients: Array<{ line_ref: string; source_text: string }> };
  };
  const sourceByRef = new Map(payload.recipe.ingredients.map((entry) => [entry.line_ref, entry.source_text]));
  return {
    contract_version: 'nutrition_ai_advanced_interpretation_v1',
    interpretations: payload.requested_targets.map((target) =>
      semanticInterpretation(target.line_ref, sourceByRef.get(target.line_ref) ?? '')
    ),
  };
}

function chooseCandidateFor(
  sourceText: string,
  candidates: Array<{ candidate_ref: string; description: string; portion_summary?: string }>
) {
  const lower = sourceText.toLowerCase();
  const find = (test: (description: string) => boolean) =>
    candidates.find((candidate) => test(candidate.description.toLowerCase()));
  const findMeasurable = (test: (description: string) => boolean) =>
    candidates.find(
      (candidate) =>
        test(candidate.description.toLowerCase()) &&
        typeof candidate.portion_summary === 'string' &&
        candidate.portion_summary.toLowerCase().includes('cup')
    );
  if (lower.includes('half and half')) {
    return (
      findMeasurable((d) => d === 'cream, fluid, half and half') ??
      findMeasurable((d) => d.includes('half and half') && !d.includes('fat free') && !d.includes('lowfat')) ??
      find((d) => d.includes('half and half'))
    );
  }
  if (lower.includes('passata')) {
    return (
      findMeasurable((d) => d.includes('tomato products') && d.includes('puree') && d.includes('without salt')) ??
      findMeasurable((d) => d.includes('tomato') && d.includes('puree') && d.includes('without salt')) ??
      findMeasurable((d) => d.includes('tomato') && d.includes('puree')) ??
      find((d) => d.includes('tomato') && d.includes('puree')) ??
      find((d) => d.includes('tomato') && d.includes('crushed'))
    );
  }
  if (lower.includes('butter')) {
    return (
      findMeasurable((d) => d.includes('butter') && d.includes('without salt') && !d.includes('seed')) ??
      findMeasurable((d) => d.includes('butter') && d.includes('unsalted') && !d.includes('seed')) ??
      find((d) => d.includes('butter') && d.includes('unsalted')) ??
      find((d) => d.includes('butter') && d.includes('without salt') && !d.includes('seed'))
    );
  }
  if (lower.includes('coconut milk')) {
    return (
      findMeasurable((d) => d.includes('coconut milk') && d.includes('canned') && !d.includes('sweetened') && !d.includes('beverage')) ??
      findMeasurable((d) => d.includes('coconut milk') && d.includes('canned')) ??
      find((d) => d.includes('coconut milk') && d.includes('canned'))
    );
  }
  if (lower.includes('quinoa')) {
    return find((d) => d.includes('quinoa') && d.includes('uncooked'));
  }
  return candidates[0];
}

function evaluationReply(prompt: string): unknown {
  const payload = payloadAfter(prompt, 'RECIPE AND USDA CANDIDATE DATA') as {
    recipe: { ingredients: Array<{ line_ref: string; source_text: string }> };
    requested_targets: Array<{
      line_ref: string;
      candidates: Array<{
        candidate_ref: string;
        description: string;
        portion_summary?: string;
      }>;
    }>;
  };
  const sourceByRef = new Map(payload.recipe.ingredients.map((entry) => [entry.line_ref, entry.source_text]));
  return {
    contract_version: 'nutrition_ai_first_candidate_evaluation_v1',
    decisions: payload.requested_targets.map((target) => {
      const source = sourceByRef.get(target.line_ref) ?? '';
      const selected = chooseCandidateFor(source, target.candidates);
      if (!selected) {
        return {
          line_ref: target.line_ref,
          decision: 'needs_review',
          candidate_ref: '',
          justification: 'No supplied candidate is a defensible identity for this line.',
          uncertainty: 'The available records differ materially from the authored food.',
        };
      }
      const isPassata = source.toLowerCase().includes('passata');
      const isCoconutMilk = source.toLowerCase().includes('coconut milk');
      return {
        line_ref: target.line_ref,
        decision: 'select',
        candidate_ref: selected.candidate_ref,
        justification: isPassata
          ? 'Canned tomato puree is the closest available identity for passata.'
          : isCoconutMilk
            ? 'The canned cooking milk matches the recipe’s explicit canned state; the sweetened beverage does not.'
            : 'The candidate description matches the authored food identity and constraints.',
        uncertainty: isPassata
          ? 'Passata is typically uncooked and strained; this canned puree may differ in salt and processing.'
          : '',
      };
    }),
  };
}

const mockProvider: AiProvider = {
  id: 'gemini',
  name: 'gemini',
  capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
  isAvailable: () => true,
  testConnection: async () => true,
  generate: async () => '',
  generateStructured: async (prompt: string, _schema: AiJsonSchema, _options?: AiStructuredOptions) => {
    prov.calls += 1;
    prov.prompts.push(prompt);
    if (prov.throwOnPass === 1 || prov.throwOnPass === 2) {
      throw new Error('provider unavailable');
    }
    const isPassTwo = prompt.includes('RECIPE AND USDA CANDIDATE DATA');
    if (!isPassTwo && prov.abortPassOne) {
      prov.passOneSignal = _options?.signal ?? null;
      prov.markPassOneStarted?.();
      return await new Promise<never>((_resolve, reject) => {
        const signal = _options?.signal;
        if (!signal) {
          reject(new Error('missing pass-1 cancellation signal'));
          return;
        }
        const cancellation = () =>
          liveCallerCancellationError
            ? liveCallerCancellationError({ providerId: 'gemini', model: 'mock-pass-1' })
            : new Error('cancelled');
        if (signal.aborted) {
          reject(cancellation());
          return;
        }
        signal.addEventListener('abort', () => reject(cancellation()), { once: true });
      });
    }
    if (isPassTwo) {
      if (prov.overridePassTwo) return prov.overridePassTwo(payloadAfter(prompt, 'RECIPE AND USDA CANDIDATE DATA')) as never;
      return evaluationReply(prompt) as never;
    }
    if (prov.overridePassOne) return prov.overridePassOne(payloadAfter(prompt, 'RECIPE DATA')) as never;
    return semanticReply(prompt) as never;
  },
};

// ---------------------------------------------------------------------------
// Real server + real network adapter
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_TEXT_PROVIDER',
  'KITCHEN_CODEX_TEXT_MODEL',
  'NUTRITION_INTERPRET_RATE_LIMIT',
] as const;

let server: http.Server;
let baseUrl: string;
let network: NetworkAdapter;

beforeAll(async () => {
  vi.resetModules();
  const liveErrors = await import('../../server/ai/providerErrors.js');
  liveCallerCancellationError = liveErrors.callerCancellationError;
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  process.env.NUTRITION_INTERPRET_RATE_LIMIT = '1000';

  (globalThis as never as { __AIF1_REGISTRY?: RegisteredProvider[] }).__AIF1_REGISTRY = [
    { provider: mockProvider, defaultCapabilities: { ...mockProvider.capabilities } as AiCapabilities },
  ];

  const { createApp } = await import('../../server/app.js');
  const { resetRateLimitersForTests } = await import('../../server/rateLimiter.js');
  const authorityModule = await import('../../server/nutritionProductAccessAuthority.js');
  resetRateLimitersForTests();
  const authority: NutritionProductAccessAuthority =
    authorityModule.createDeploymentNutritionProductAccessAuthority('ai_advanced');
  const app = createApp({ isProduction: false, nutritionProductAccessAuthority: authority });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const doFetch = async <T>(
    method: string,
    path: string,
    bodyValue?: unknown,
    options?: { signal?: AbortSignal }
  ) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_ENDPOINT_TOKEN}` },
      ...(bodyValue !== undefined ? { body: JSON.stringify(bodyValue) } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    const raw = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = undefined;
    }
    return { status: response.status, ok: response.ok, data };
  };
  network = {
    request: (request: { method: string; path: string; body?: unknown; signal?: AbortSignal }) =>
      doFetch(request.method, request.path, request.body, { signal: request.signal }),
    get: (path: string, options?: { signal?: AbortSignal }) =>
      doFetch('GET', path, undefined, options),
    post: (path: string, body?: unknown, options?: { signal?: AbortSignal }) =>
      doFetch('POST', path, body, options),
  } as unknown as NetworkAdapter;
}, 240000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  delete (globalThis as never as { __AIF1_REGISTRY?: unknown }).__AIF1_REGISTRY;
});

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  session = result.session;
}, 240000);

beforeAll(async () => {
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
});

beforeEach(() => {
  prov.calls = 0;
  prov.prompts = [];
  prov.throwOnPass = 0;
  prov.overridePassOne = null;
  prov.overridePassTwo = null;
  prov.abortPassOne = false;
  prov.passOneSignal = null;
  prov.markPassOneStarted = null;
});

interface PreparedRecipe {
  readonly recipe: { title: string; servings: number; ingredients: unknown[] };
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly rows: ReturnType<typeof buildReviewRows>;
  readonly state: Phase4State;
  readonly liveRows: ReturnType<typeof projectLiveRows>;
}

function prepare(lines: string[], instructions: string[]): PreparedRecipe {
  const recipe = {
    title: 'AI-first benchmark',
    servings: 4,
    ingredients: lines.map(structuredLine),
  };
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 4);
  const rows = buildReviewRows(session, adapted);
  const state = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: null,
    baseServings: 4,
    rows,
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: 4,
    preview: analysis.preview ?? null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as Phase4State;
  const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
  const liveRows = projectLiveRows(
    state,
    analyzedByRef,
    adapted,
    session,
    null,
    analysis.portions,
    analysis.countPortions
  );
  return {
    recipe: {
      ...recipe,
      instructions: instructions.map((text) => ({ text })),
    } as unknown as PreparedRecipe['recipe'],
    adapted,
    rows,
    state,
    liveRows,
  };
}

function wholeRecipeSource(
  prepared: PreparedRecipe,
  lines: string[],
  instructions: string[],
  targetRows: PreparedRecipe['rows']
) {
  return {
    recipe: { ingredients: lines.map((name) => ({ name })) },
    instructions: instructions.map((text) => ({ text })),
    // Only ACTIONABLE rows are targets. The deterministic baseline may already
    // have resolved another authored ingredient; sending its ref would ask the
    // model for a decision the current review has no row to accept.
    targets: targetRows.map((entry) => ({ line_ref: entry.line_ref as string })),
  };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('AI-first Generate — real USDA records, two passes, local authority', () => {
  it('Benchmark A: resolves half-and-half and passata from real USDA descriptions', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    expect(actionable.length).toBeGreaterThanOrEqual(2);
    const targetRefs = new Set(actionable.map((row) => row.line_ref));
    const targetRows = prepared.rows.filter((row) => targetRefs.has(row.line_ref));
    const stateBefore = JSON.stringify(prepared.state);

    const result = await resolveWithAiFirst({
      network,
      session,
      rows: targetRows,
      adapted: prepared.adapted,
      capabilities: AI_ADVANCED_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS, targetRows),
    });

    expect(result.ok).toBe(true);
    expect(result.aiAttempted).toBe(true);
    // The resolution operation NEVER mutates or persists the caller's state.
    expect(JSON.stringify(prepared.state)).toBe(stateBefore);
    // EXACTLY TWO structured provider passes, regardless of target count.
    expect(prov.calls).toBe(2);

    // Neither prompt leaks an FDC id, digest, gram weight or nutrient value.
    for (const prompt of prov.prompts) {
      expect(prompt).not.toMatch(/"fdc_id"\s*:/);
      expect(prompt).not.toMatch(/"record_digest"\s*:/);
      expect(prompt).not.toMatch(/"grams"\s*:/);
      expect(prompt).not.toMatch(/"nutrients"\s*:/);
    }

    const byLine = new Map(result.outcome.candidates.map((candidate) => [candidate.line_ref, candidate]));
    const halfAndHalf = prepared.adapted.find((entry) => entry.ingredient.original.includes('half and half'));
    const passata = prepared.adapted.find((entry) => entry.ingredient.original.includes('passata'));
    expect(halfAndHalf).toBeDefined();
    expect(passata).toBeDefined();

    const dairy = byLine.get(halfAndHalf?.line_ref as string);
    expect(dairy).toBeDefined();
    expect(dairy?.description.toLowerCase()).toContain('half and half');
    expect(dairy?.auto).toBe(true);
    expect(dairy?.choice.aiFirst).toBe(true);
    expect(dairy?.choice.aiAssisted).toBe(true);
    expect(dairy?.choice.aiFirstJustification).toBeTruthy();
    expect(dairy?.choice.record_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(dairy?.choice.catalog_digest).toBe(session.metadata().catalog_digest);
    // 1 cup is resolved from ONE authenticated volume portion, never an AI gram.
    expect(dairy?.portion).toBeDefined();

    const tomato = byLine.get(passata?.line_ref as string);
    expect(tomato).toBeDefined();
    expect(tomato?.description.toLowerCase()).toContain('tomato');
    expect(tomato?.description.toLowerCase()).toContain('puree');
    expect(tomato?.auto).toBe(true);
    expect(tomato?.choice.aiFirst).toBe(true);
    expect(tomato?.choice.aiFirstJustification).toBeTruthy();
    expect(tomato?.choice.aiFirstUncertainty).toBeTruthy();
    expect(tomato?.portion).toBeDefined();

    // The selected records are REAL catalog records with the current digest.
    for (const candidate of [dairy, tomato]) {
      const lookup = session.searchFoods(String(candidate?.fdc_id), 1);
      expect(lookup.ok).toBe(true);
      if (lookup.ok) {
        expect(lookup.results.some((hit) => hit.fdc_id === candidate?.fdc_id && hit.record_digest === candidate?.choice.record_digest)).toBe(true);
      }
    }

    // AUTHENTICATED NUTRIENT CONTRIBUTION. Apply the working state exactly as the
    // card does and calculate through the genuine session.
    const matches = { ...prepared.state.matches };
    const portions = { ...prepared.state.portions };
    for (const candidate of result.outcome.candidates) {
      matches[candidate.line_ref] = candidate.choice;
      if (candidate.portion) portions[candidate.line_ref] = candidate.portion;
    }
    const calculated = session.calculate(
      buildCalculationRequest(prepared.adapted, { ...prepared.state, matches, portions } as Phase4State)
    );
    expect(calculated.ok).toBe(true);
    if (calculated.ok) {
      const evidence = calculated.preview.ingredients.filter((entry) => entry.fdc_id !== undefined);
      expect(evidence.length).toBeGreaterThanOrEqual(2);
      for (const entry of evidence) {
        expect(entry.resolved_grams).toBeGreaterThan(0);
      }
      expect(calculated.preview.totals.calories?.amount ?? 0).toBeGreaterThan(0);
    }
  }, 120000);

  it('investigates a broader USDA food family from an AI-declared qualifier when the authored name is absent', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    const targetRows = prepared.rows.filter((row) => actionable.some((live) => live.line_ref === row.line_ref));

    // A REALISTIC live failure shape: the model provides only `tomato passata`
    // for passata, but declares `tomato` as its food-family qualifier. The
    // generic discovery fallback must investigate actual tomato records rather
    // than leaving an empty candidate set.
    prov.overridePassOne = (payload) => {
      const data = payload as {
        requested_targets: Array<{ line_ref: string }>;
        recipe: { ingredients: Array<{ line_ref: string; source_text: string }> };
      };
      const sourceByRef = new Map(data.recipe.ingredients.map((entry) => [entry.line_ref, entry.source_text]));
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: data.requested_targets.map((target) => {
          const source = sourceByRef.get(target.line_ref) ?? '';
          const base = semanticInterpretation(target.line_ref, source) as any;
          if (!source.toLowerCase().includes('passata')) return base;
          return {
            ...base,
            semantic_food: { ...base.semantic_food, qualifiers: ['tomato'] },
            search_phrases: ['tomato passata'],
          };
        }),
      };
    };

    const result = await resolveWithAiFirst({
      network,
      session,
      rows: targetRows,
      adapted: prepared.adapted,
      capabilities: AI_ADVANCED_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS, targetRows),
    });

    expect(result.ok).toBe(true);
    expect(prov.calls).toBe(2);
    const passataRef = prepared.adapted.find((entry) => entry.ingredient.original.includes('passata'))?.line_ref as string;
    const selected = result.outcome.candidates.find((candidate) => candidate.line_ref === passataRef);
    expect(selected).toBeDefined();
    expect(selected?.description.toLowerCase()).toContain('tomato');
    expect(selected?.description.toLowerCase()).toContain('puree');
    expect(selected?.choice.aiFirst).toBe(true);
    // The pass-2 prompt must contain actual tomato records, not an empty set.
    const passTwo = prov.prompts[1] as string;
    expect(passTwo.toLowerCase()).toContain('tomato, puree, canned');
  }, 120000);

  it('relaxes only model-declared preparation wording to investigate the underlying food family', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    const targetRows = prepared.rows.filter((row) => actionable.some((live) => live.line_ref === row.line_ref));

    // EXACT live-response shape from AN-AIFIRST-1R: passata was interpreted as
    // `passata` with preparation `strained`, state `pureed`, no qualifiers, and
    // two search phrases. `strained tomato puree` finds nothing under the AND
    // search contract because no USDA description contains `strained`.
    prov.overridePassOne = (payload) => {
      const data = payload as {
        requested_targets: Array<{ line_ref: string }>;
        recipe: { ingredients: Array<{ line_ref: string; source_text: string }> };
      };
      const sourceByRef = new Map(data.recipe.ingredients.map((entry) => [entry.line_ref, entry.source_text]));
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: data.requested_targets.map((target) => {
          const source = sourceByRef.get(target.line_ref) ?? '';
          const base = semanticInterpretation(target.line_ref, source) as any;
          if (!source.toLowerCase().includes('passata')) return base;
          return {
            ...base,
            semantic_food: {
              ...base.semantic_food,
              preparation: ['strained'],
              state: ['pureed'],
              qualifiers: [],
            },
            search_phrases: ['tomato passata', 'strained tomato puree'],
          };
        }),
      };
    };

    const result = await resolveWithAiFirst({
      network,
      session,
      rows: targetRows,
      adapted: prepared.adapted,
      capabilities: AI_ADVANCED_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS, targetRows),
    });

    expect(result.ok).toBe(true);
    expect(prov.calls).toBe(2);
    const passataRef = prepared.adapted.find((entry) => entry.ingredient.original.includes('passata'))?.line_ref as string;
    const selected = result.outcome.candidates.find((candidate) => candidate.line_ref === passataRef);
    expect(selected).toBeDefined();
    expect(selected?.fdc_id).toBe(170460);
    expect(selected?.description.toLowerCase()).toContain('tomato');
    expect(selected?.description.toLowerCase()).toContain('puree');
    expect(selected?.choice.aiFirst).toBe(true);
    expect(selected?.portion).toBeDefined();
    const passTwo = prov.prompts[1] as string;
    expect(passTwo.toLowerCase()).toContain('tomato products, canned, puree, without salt added');
  }, 120000);

  it('preserves the exact live needs_review explanation and its real candidate set', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    const targetRows = prepared.rows.filter((row) => actionable.some((live) => live.line_ref === row.line_ref));

    prov.overridePassOne = (payload) => {
      const data = payload as {
        requested_targets: Array<{ line_ref: string }>;
        recipe: { ingredients: Array<{ line_ref: string; source_text: string }> };
      };
      const sourceByRef = new Map(data.recipe.ingredients.map((entry) => [entry.line_ref, entry.source_text]));
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: data.requested_targets.map((target) => {
          const source = sourceByRef.get(target.line_ref) ?? '';
          const base = semanticInterpretation(target.line_ref, source) as any;
          if (!source.toLowerCase().includes('passata')) return base;
          return {
            ...base,
            semantic_food: {
              ...base.semantic_food,
              preparation: ['strained'],
              state: ['pureed'],
              qualifiers: [],
            },
            search_phrases: ['tomato passata', 'strained tomato puree'],
          };
        }),
      };
    };
    prov.overridePassTwo = (payload) => {
      const data = payload as {
        requested_targets: Array<{ line_ref: string }>;
        recipe: { ingredients: Array<{ line_ref: string; source_text: string }> };
      };
      const sourceByRef = new Map(data.recipe.ingredients.map((entry) => [entry.line_ref, entry.source_text]));
      return {
        contract_version: 'nutrition_ai_first_candidate_evaluation_v1',
        decisions: data.requested_targets.map((target) => {
          const source = sourceByRef.get(target.line_ref) ?? '';
          if (source.toLowerCase().includes('passata')) {
            return {
              line_ref: target.line_ref,
              decision: 'needs_review',
              candidate_ref: '',
              justification: 'Passata is an uncooked tomato puree, and it is unclear if the recipe requires added salt or no salt.',
              uncertainty: 'The recipe does not specify if the passata should be salted or unsalted.',
            };
          }
          return {
            line_ref: target.line_ref,
            decision: 'select',
            candidate_ref: 'c2',
            justification: 'Cream, fluid, half and half is the standard culinary definition for half-and-half.',
            uncertainty: '',
          };
        }),
      };
    };

    const result = await resolveWithAiFirst({
      network,
      session,
      rows: targetRows,
      adapted: prepared.adapted,
      capabilities: AI_ADVANCED_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS, targetRows),
    });

    expect(result.ok).toBe(true);
    expect(prov.calls).toBe(2);
    const passataRef = prepared.adapted.find((entry) => entry.ingredient.original.includes('passata'))?.line_ref as string;
    expect(result.outcome.candidates.some((candidate) => candidate.line_ref === passataRef)).toBe(false);
    const review = result.aiFirstReviews?.find((entry) => entry.line_ref === passataRef);
    expect(review).toBeDefined();
    expect(review?.decision).toBe('needs_review');
    expect(review?.justification).toContain('unclear if the recipe requires added salt');
    expect(review?.uncertainty).toContain('does not specify if the passata should be salted');
    expect(review?.candidate_count).toBe(3);
    expect(review?.candidate_query).toBe('Tomato, puree, canned');
  }, 120000);

  it('forwards client cancellation through the real HTTP route to the pass-1 provider signal', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    const targetRows = prepared.rows.filter((row) => actionable.some((live) => live.line_ref === row.line_ref));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    prov.abortPassOne = true;
    prov.markPassOneStarted = markStarted;
    const controller = new AbortController();
    const running = resolveWithAiFirst({
      network,
      session,
      rows: targetRows,
      adapted: prepared.adapted,
      capabilities: AI_ADVANCED_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS, targetRows),
      signal: controller.signal,
    });
    await started;
    expect(prov.passOneSignal).not.toBeNull();
    controller.abort();
    const result = await running;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.ok).toBe(false);
    expect(prov.passOneSignal?.aborted).toBe(true);
    // ONE provider attempt. Cancellation is terminal: no retry, no pass 2.
    expect(prov.calls).toBe(1);
  }, 120000);

  it('Benchmark B: uses recipe context to distinguish canned cooking milk from a sweetened product', async () => {
    const prepared = prepare(BENCHMARK_B_LINES, BENCHMARK_B_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    const targetRows = prepared.rows.filter((row) => actionable.some((live) => live.line_ref === row.line_ref));

    const result = await resolveWithAiFirst({
      network,
      session,
      rows: targetRows,
      adapted: prepared.adapted,
      capabilities: AI_ADVANCED_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_B_LINES, BENCHMARK_B_INSTRUCTIONS, targetRows),
    });

    expect(actionable.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    expect(prov.calls).toBe(2);
    const lineRef = prepared.adapted[0].line_ref as string;
    const chosen = result.outcome.candidates.find((candidate) => candidate.line_ref === lineRef);
    expect(chosen).toBeDefined();
    expect(chosen?.description.toLowerCase()).toContain('coconut milk');
    expect(chosen?.description.toLowerCase()).toContain('canned');
    expect(chosen?.description.toLowerCase()).not.toContain('beverage');
    expect(chosen?.description.toLowerCase()).not.toContain('sweetened');
    expect(chosen?.choice.aiFirst).toBe(true);
    expect(chosen?.portion).toBeDefined();

    // The pass-2 prompt really contained the viable canned record. The local
    // source-constraint veto is covered by the unit suite; this fixture proves
    // the model was shown real, materially different records.
    const passTwo = prov.prompts[1] as string;
    expect(passTwo.toLowerCase()).toContain('nuts, coconut milk, canned');
  }, 120000);

  it('an invented candidate ref fails closed with NO selection and no third call', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    const targetRows = prepared.rows.filter((row) => actionable.some((live) => live.line_ref === row.line_ref));
    prov.overridePassTwo = (payload) => {
      const data = payload as {
        requested_targets: Array<{ line_ref: string }>;
      };
      return {
        contract_version: 'nutrition_ai_first_candidate_evaluation_v1',
        decisions: data.requested_targets.map((target) => ({
          line_ref: target.line_ref,
          decision: 'select',
          candidate_ref: 'c99',
          justification: 'invented',
          uncertainty: '',
        })),
      };
    };
    const result = await resolveWithAiFirst({
      network,
      session,
      rows: targetRows,
      adapted: prepared.adapted,
      capabilities: AI_ADVANCED_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS, targetRows),
    });
    expect(result.ok).toBe(false);
    expect(result.outcome.candidates).toHaveLength(0);
    expect(prov.calls).toBe(2);
  }, 120000);

  it('a pass-2 provider failure is visible and does not trigger a legacy retry', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    const targetRows = prepared.rows.filter((row) => actionable.some((live) => live.line_ref === row.line_ref));
    prov.throwOnPass = 2;
    const result = await resolveWithAiFirst({
      network,
      session,
      rows: targetRows,
      adapted: prepared.adapted,
      capabilities: AI_ADVANCED_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS, targetRows),
    });
    expect(result.ok).toBe(false);
    expect(result.aiAttempted).toBe(true);
    expect(result.outcome.candidates).toHaveLength(0);
    expect(prov.calls).toBe(2);
  }, 120000);

  it('Basic Nutrition makes ZERO provider calls', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const result = await resolveWithAiFirst({
      network,
      session,
      rows: prepared.rows,
      adapted: prepared.adapted,
      capabilities: BASIC_NUTRITION_CAPABILITIES,
      wholeRecipe: wholeRecipeSource(prepared, BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS, prepared.rows),
    });
    expect(result.ok).toBe(false);
    expect(result.aiAttempted).toBe(false);
    expect(prov.calls).toBe(0);
    expect(result.outcome.candidates).toHaveLength(0);
  });

  it('the pass-2 route refuses an authority-bearing candidate field with a bounded 400', async () => {
    const prepared = prepare(BENCHMARK_A_LINES, BENCHMARK_A_INSTRUCTIONS);
    const actionable = prepared.liveRows.filter((row) => liveExceptionKind(row.status) !== undefined);
    const targetRows = prepared.rows.filter((row) => actionable.some((live) => live.line_ref === row.line_ref));
    const source = wholeRecipeSource(
      prepared,
      BENCHMARK_A_LINES,
      BENCHMARK_A_INSTRUCTIONS,
      targetRows
    );
    const response = await network.post<Record<string, unknown>>(
      '/api/nutrition/evaluate-candidates',
      {
        request_version: 'nutrition_ai_first_candidate_evaluation_request_v1',
        recipe: source.recipe,
        instructions: source.instructions,
        targets: source.targets,
        candidate_sets: source.targets.map((target, index) => ({
          line_ref: target.line_ref,
          candidates:
            index === 0
              ? [
                  {
                    candidate_ref: 'c1',
                    description: 'Butter, without salt',
                    data_type: 'sr_legacy',
                    fdc_id: 173430,
                  },
                ]
              : [],
        })),
      }
    );
    expect(response.status).toBe(400);
    expect(response.data).toMatchObject({ ok: false, aiAttempted: false });
    // The refusal is bounded: no provider identity, model, prompt or credential.
    const serialized = JSON.stringify(response.data);
    expect(serialized).not.toContain('provider');
    expect(serialized).not.toContain('model');
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('AIza');
  });
});

describe('AI-first local verification — deterministic authority, not model authority', () => {
  function butterLocalCandidate(description: string) {
    const lookup = session.searchFoods(description, 5);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) throw new Error('search failed');
    const hit = lookup.results.find((entry) => entry.description === description);
    expect(hit).toBeDefined();
    if (!hit) throw new Error('fixture record missing');
    return {
      candidate_ref: 'c1',
      fdc_id: hit.fdc_id,
      description: hit.description,
      record_digest: hit.record_digest,
      data_type: hit.data_type,
    };
  }

  it('vetoes a model-selected record that contradicts an authored qualifier', () => {
    const prepared = prepare(['2 tbsp unsalted butter'], []);
    const lineRef = prepared.adapted[0].line_ref as string;
    const salted = butterLocalCandidate('Butter, stick, salted');
    const outcome = verifyAiFirstCandidateDecisions({
      session,
      rows: prepared.rows,
      adapted: prepared.adapted,
      candidateSets: [{ line_ref: lineRef, candidates: [salted] }],
      decisions: [
        {
          line_ref: lineRef,
          decision: 'select',
          candidate_ref: 'c1',
          justification: 'Looks like butter.',
          uncertainty: '',
        },
      ],
    });
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.rejected).toContain(lineRef);
    expect(outcome.unresolved).toContain(lineRef);
  });

  it('accepts the matching record and provides an authenticated volume portion', () => {
    const prepared = prepare(['2 tbsp unsalted butter'], []);
    const lineRef = prepared.adapted[0].line_ref as string;
    const unsalted = butterLocalCandidate('Butter, without salt');
    const outcome = verifyAiFirstCandidateDecisions({
      session,
      rows: prepared.rows,
      adapted: prepared.adapted,
      candidateSets: [{ line_ref: lineRef, candidates: [unsalted] }],
      decisions: [
        {
          line_ref: lineRef,
          decision: 'select',
          candidate_ref: 'c1',
          justification: 'Unsalted stick butter matches the authored qualifier.',
          uncertainty: '',
        },
      ],
    });
    expect(outcome.rejected).toHaveLength(0);
    expect(outcome.candidates).toHaveLength(1);
    const candidate = outcome.candidates[0];
    expect(candidate.choice.aiFirst).toBe(true);
    expect(candidate.choice.catalog_digest).toBe(session.metadata().catalog_digest);
    expect(candidate.portion).toBeDefined();
    expect(candidate.portion?.selection).toBeDefined();
  });

  it('refuses a tampered record digest before constructing a selection', () => {
    const prepared = prepare(['2 tbsp unsalted butter'], []);
    const lineRef = prepared.adapted[0].line_ref as string;
    const unsalted = butterLocalCandidate('Butter, stick, unsalted');
    const outcome = verifyAiFirstCandidateDecisions({
      session,
      rows: prepared.rows,
      adapted: prepared.adapted,
      candidateSets: [
        { line_ref: lineRef, candidates: [{ ...unsalted, record_digest: '0'.repeat(64) }] },
      ],
      decisions: [
        {
          line_ref: lineRef,
          decision: 'select',
          candidate_ref: 'c1',
          justification: 'Tampered fixture.',
          uncertainty: '',
        },
      ],
    });
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.rejected).toContain(lineRef);
  });

  it('refuses a candidate ref that has no local record', () => {
    const prepared = prepare(['2 tbsp unsalted butter'], []);
    const lineRef = prepared.adapted[0].line_ref as string;
    const unsalted = butterLocalCandidate('Butter, stick, unsalted');
    const outcome = verifyAiFirstCandidateDecisions({
      session,
      rows: prepared.rows,
      adapted: prepared.adapted,
      candidateSets: [{ line_ref: lineRef, candidates: [unsalted] }],
      decisions: [
        {
          line_ref: lineRef,
          decision: 'select',
          candidate_ref: 'c9',
          justification: 'Invented ref.',
          uncertainty: '',
        },
      ],
    });
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.rejected).toContain(lineRef);
  });
});
