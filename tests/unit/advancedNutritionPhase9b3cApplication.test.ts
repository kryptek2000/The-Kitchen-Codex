/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-3C.
 * BROWSER/APPLICATION INTEGRATION — the full existing Advanced Nutrition flow.
 *
 * This suite drives the REAL application orchestration against the REAL Express
 * server over REAL HTTP, with the REAL pinned USDA catalog and the REAL
 * deterministic matcher. It proves the complete product path:
 *
 *   recipe -> Advanced Nutrition rows -> ONE explicit AI action -> atomic route
 *   (interpret whole recipe -> issue + verify wsem1 -> advisory bridge)
 *   -> browser transport re-sanitization -> REAL deterministic USDA matching
 *   -> existing review-suggested withholding -> AiResolveOutcome
 *
 * Only the external AI PROVIDER is mocked. Receipt verification, the bridge, the
 * transport sanitizer, the USDA catalog and the matching algorithm are real.
 *
 * No FDC identity is fabricated: every candidate is asserted to carry a genuine
 * catalog record digest bound to the session's catalog digest, and the chosen
 * record is cross-checked against a direct catalog review with no AI involved.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NutritionProductAccessAuthority } from '../../server/nutritionProductAccessAuthority.js';
import type { RegisteredProvider } from '../../server/ai/providerRegistry';
import type { AiCapabilities, AiJsonSchema, AiProvider, AiStructuredOptions } from '../../src/core/ai/types';
import type { NetworkAdapter, NetworkResponse } from '../../src/application/adapters/NetworkAdapter';
import { resolveUnresolvedRowsWithAi } from '../../src/application/nutritionAiResolve';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import {
  adaptRecipe, analyzeRecipe, buildReviewRows, liveExceptionKind, projectLiveRows,
  resolveFoodsFromAiSuggestions,
  type AdaptedIngredient, type AdvancedNutritionSession, type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import {
  BASIC_NUTRITION_CAPABILITIES,
  resolveNutritionCapabilities,
} from '../../src/core/nutritionV2/nutritionCapabilities';

/** The AI-Advanced composed capability set (product entitled + provider ready). */
const AI_ADVANCED_CAPABILITIES = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });
import type { AiResolutionIssueKind } from '../../src/core/nutritionV2/aiResolution';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);
const AI_ENDPOINT_TOKEN = '9b3c-app-token';

// ---------------------------------------------------------------------------
// THE RECIPE FIXTURE — whole-recipe, with instructions
// ---------------------------------------------------------------------------

const LINES = ['4 eggs, separated', '1 cup whole milk', '2 cups all-purpose flour', '6 tbsp unsalted butter', '1 tsp sea salt'];
const INSTRUCTIONS = [
  'Separate the whites from the yolks.',
  'Beat the whites until stiff peaks.',
  'Fold the whites back into the yolks.',
];

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

// ---------------------------------------------------------------------------
// PROVIDER MOCK — the ONLY substitution
// ---------------------------------------------------------------------------

const prov = vi.hoisted(() => ({
  calls: 0,
  prompts: [] as string[],
  throwAll: false,
  override: null as null | ((prompt: string) => unknown),
}));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return {
    ...actual,
    getRegisteredProviders: () =>
      (globalThis as never as { __APP3C_REGISTRY?: RegisteredProvider[] }).__APP3C_REGISTRY ?? [],
  };
});

function parsePayload(prompt: string): { requested_targets: Array<{ line_ref: string }> } {
  const at = prompt.indexOf('RECIPE DATA');
  const data = prompt.slice(at);
  return JSON.parse(data.slice(data.indexOf('\n') + 1)) as { requested_targets: Array<{ line_ref: string }> };
}

function wholeEggRow(line_ref: string) {
  return {
    contract_version: 'nutrition_ai_advanced_interpretation_v1',
    line_ref,
    semantic_food: {
      normalized_name: 'whole egg',
      modifiers: ['separated', 'recombined'],
      preparation: ['beaten'],
      state: ['raw'],
      qualifiers: [],
    },
    search_phrases: ['whole egg'],
    amount_semantics: { kind: 'exact', echoed_value: 4, phrasing: '4' },
    unit_semantics: { family: 'count', raw: 'eggs', interpreted_unit: 'count' },
    count_semantics: { noun: 'eggs' },
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
  };
}

const mockProvider: AiProvider = {
  id: 'gemini',
  name: 'gemini',
  capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
  isAvailable: () => true,
  testConnection: async () => true,
  generate: async () => '',
  generateStructured: async (prompt: string, _s: AiJsonSchema, _o?: AiStructuredOptions) => {
    prov.calls += 1;
    prov.prompts.push(prompt);
    if (prov.throwAll) throw new Error('provider down');
    if (prov.override) return prov.override(prompt) as never;
    return {
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: parsePayload(prompt).requested_targets.map((t) => wholeEggRow(t.line_ref)),
    } as never;
  },
};

// ---------------------------------------------------------------------------
// REAL SERVER
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_TEXT_PROVIDER', 'KITCHEN_CODEX_TEXT_MODEL', 'NUTRITION_INTERPRET_RATE_LIMIT',
] as const;

let server: http.Server;
let baseUrl: string;
let network: NetworkAdapter;

beforeAll(async () => {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  process.env.NUTRITION_INTERPRET_RATE_LIMIT = '1000';

  (globalThis as never as { __APP3C_REGISTRY?: RegisteredProvider[] }).__APP3C_REGISTRY = [
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // The browser transport port — real HTTP, real auth header.
  const doFetch = async <T>(method: string, path: string, bodyValue?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_ENDPOINT_TOKEN}` },
      ...(bodyValue !== undefined ? { body: JSON.stringify(bodyValue) } : {}),
    });
    const raw = await response.text();
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = undefined; }
    return { status: response.status, ok: response.ok, data };
  };
  network = {
    request: (r) => doFetch(r.method, r.path, r.body),
    get: (p) => doFetch('GET', p),
    post: (p, b) => doFetch('POST', p, b),
  } as unknown as NetworkAdapter;
}, 240000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  delete (globalThis as never as { __APP3C_REGISTRY?: unknown }).__APP3C_REGISTRY;
});

// ---------------------------------------------------------------------------
// REAL USDA SESSION + REAL ADVANCED NUTRITION ROWS
// ---------------------------------------------------------------------------

let session: AdvancedNutritionSession;
let adapted: ReadonlyArray<AdaptedIngredient>;
let rows: ReturnType<typeof buildReviewRows>;
let liveRows: ReturnType<typeof projectLiveRows>;
let issueKinds: Readonly<Record<string, AiResolutionIssueKind>>;
let state: Phase4State;

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

  const adaptation = adaptRecipe({ title: 'Separated Egg Souffle Base', servings: 4, ingredients: LINES.map(structuredLine) });
  if (!adaptation.ok) throw new Error('adapt failed');
  adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 4);
  rows = buildReviewRows(session, adapted);
  state = {
    version: '', status: 'ready', recipeKey: adaptation.recipe.recipe_key, sessionIdentity: null,
    baseServings: 4, rows, matches: analysis.matches, portions: analysis.portions,
    countPortions: analysis.countPortions, householdPortions: analysis.householdPortions,
    userMasses: {}, basis: 'entire_recipe', selectedServings: 4,
    preview: analysis.preview ?? null, previewKey: null, failure: null, operationSeq: 0,
  } as Phase4State;
  const analyzedByRef = new Map(analysis.rows.map((r) => [r.line_ref, r]));
  liveRows = projectLiveRows(state, analyzedByRef, adapted, session, null, analysis.portions, analysis.countPortions);
  const kinds: Record<string, AiResolutionIssueKind> = {};
  for (const row of liveRows) {
    const kind = liveExceptionKind(row.status);
    if (kind !== undefined) kinds[row.line_ref] = kind;
  }
  issueKinds = Object.freeze(kinds);
}, 240000);

beforeAll(async () => {
  // The AI selection surfaces must be hydrated before any AI request is built;
  // `buildAiSelectionRequestOptions` fails CLOSED otherwise (as it does for the
  // existing AI-1 path). This is an app-lifecycle fact, not a test shortcut.
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
});

beforeEach(() => {
  prov.calls = 0;
  prov.prompts = [];
  prov.throwAll = false;
  prov.override = null;
});

/** The whole-recipe source exactly as the SHELL builds it from the card recipe. */
function wholeRecipeSource() {
  return {
    recipe: { ingredients: LINES.map((name) => ({ name })) },
    instructions: INSTRUCTIONS.map((text) => ({ text })),
    targets: adapted.map((row) => ({ line_ref: row.line_ref as string })),
  };
}

// ---------------------------------------------------------------------------
// §2 / §25 — THE INTENDED USER EXPERIENCE
// ---------------------------------------------------------------------------

describe('9B-3C — the existing AI action drives authenticated whole-recipe resolution', () => {
  it('one click -> whole recipe -> real wsem1 -> advisory -> REAL USDA candidate', async () => {
    const eggRef = adapted[0].line_ref as string;
    // The live deterministic matcher now resolves eggs, separated to the
    // catalog's whole-egg identity. Its trusted classification correctly keeps
    // it out of the semantic AI retargeting bridge.
    expect(issueKinds[eggRef]).toBeUndefined();

    const result = await resolveUnresolvedRowsWithAi({
      network,
      session,
      rows,
      adapted,
      issueKinds,
      liveRows,
      state,
      capabilities: AI_ADVANCED_CAPABILITIES,
      liveCanonicalInterpretation: true,
      wholeRecipe: wholeRecipeSource(),
    });

    expect(result.ok).toBe(true);
    expect(result.aiAttempted).toBe(true);
    // ONE application-level provider chain for ONE user action.
    expect(prov.calls).toBe(1);

    // The WHOLE recipe, with instructions, was interpreted.
    const prompt = prov.prompts[0] as string;
    for (const line of LINES) expect(prompt).toContain(line);
    for (const step of INSTRUCTIONS) expect(prompt).toContain(step);

    // The GENUINE deterministic matcher produced a catalog-backed candidate.
    const candidate = result.outcome.candidates.find((c) => c.line_ref === eggRef);
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(candidate.fdc_id).toBeGreaterThan(0);
    expect(candidate.choice.record_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.choice.catalog_digest).toBe(session.metadata().catalog_digest);
    expect(candidate.description).toMatch(/egg/i);
    expect(candidate.description).toMatch(/whole/i);
    // The catalog also offers duck/goose/quail; source constraints vetoed them.
    expect(candidate.description).not.toMatch(/duck|goose|quail/i);

    // Cross-check the identity belongs to the CATALOG, not the AI.
    const direct = session.reviewIngredient({ name: 'whole egg' });
    if (direct.outcome !== 'invalid' && direct.outcome !== 'unmatched') {
      expect(direct.candidates.some((c) => c.fdc_id === candidate.fdc_id)).toBe(true);
    }
  }, 60000);

  it('an advisory result NEVER writes nutrition (no Apply, no persistence)', async () => {
    const before = JSON.stringify(state);
    const result = await resolveUnresolvedRowsWithAi({
      network, session, rows, adapted, issueKinds, liveRows, state,
      capabilities: AI_ADVANCED_CAPABILITIES, liveCanonicalInterpretation: true,
      wholeRecipe: wholeRecipeSource(),
    });
    expect(result.ok).toBe(true);
    // Working state is untouched by a RESOLUTION run: the caller merges.
    expect(JSON.stringify(state)).toBe(before);
    expect((result as unknown as Record<string, unknown>)['preview']).toBeUndefined();
  }, 60000);
});

// ---------------------------------------------------------------------------
// §7 / §15 — CAPABILITY AND FAILURE BEHAVIOR
// ---------------------------------------------------------------------------

describe('9B-3C — capability gating and non-destructive failure', () => {
  it('Basic Nutrition costs ZERO provider calls', async () => {
    const result = await resolveUnresolvedRowsWithAi({
      network, session, rows, adapted, issueKinds, liveRows, state,
      capabilities: BASIC_NUTRITION_CAPABILITIES, liveCanonicalInterpretation: true,
      wholeRecipe: wholeRecipeSource(),
    });
    expect(result.ok).toBe(false);
    expect(result.aiAttempted).toBe(false);
    expect(prov.calls).toBe(0);
    expect(result.outcome.candidates).toHaveLength(0);
  });

  it('a provider failure degrades to manual review with ZERO candidates', async () => {
    prov.throwAll = true;
    const result = await resolveUnresolvedRowsWithAi({
      network, session, rows, adapted, issueKinds, liveRows, state,
      capabilities: AI_ADVANCED_CAPABILITIES, liveCanonicalInterpretation: true,
      wholeRecipe: wholeRecipeSource(),
    });
    expect(result.ok).toBe(false);
    expect(result.aiAttempted).toBe(true);
    expect(result.outcome.candidates).toHaveLength(0);
    expect(result.message).toBeTruthy();
    // Manual USDA search is untouched: the session still works.
    expect(session.reviewIngredient({ name: 'whole egg' }).outcome).not.toBe('invalid');
  }, 60000);

  it('a review_suggested row is NEVER upgraded to automatic by AI agreement', async () => {
    // The released withholding is what stops SHISO's agreeable wording from
    // manufacturing authority on a row the DETERMINISTIC analyzer only
    // "credibly" matched. Force that classification and prove the downgrade.
    const eggRef = adapted[0].line_ref as string;
    const forcedKinds = { ...issueKinds, [eggRef]: 'review_suggested' as AiResolutionIssueKind };
    const result = await resolveUnresolvedRowsWithAi({
      network, session, rows, adapted, issueKinds: forcedKinds, liveRows, state,
      capabilities: AI_ADVANCED_CAPABILITIES, liveCanonicalInterpretation: true,
      wholeRecipe: wholeRecipeSource(),
    });
    expect(result.ok).toBe(true);
    const candidate = result.outcome.candidates.find((c) => c.line_ref === eggRef);
    if (candidate) {
      expect(candidate.auto).toBe(false);
      expect((candidate.choice as unknown as Record<string, unknown>)['aiAccepted']).toBeUndefined();
    }
    // The candidate is still OFFERED for explicit human confirmation.
    expect(result.outcome.candidates.find((c) => c.line_ref === eggRef)?.fdc_id).toBeGreaterThan(0);
  }, 60000);

  it('an ambiguous interpretation produces NO automatic selection', async () => {
    prov.override = (prompt) => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: parsePayload(prompt).requested_targets.map((t) => ({
        ...wholeEggRow(t.line_ref),
        ambiguity: { ambiguous: true, reasons: ['yolk or white'] },
      })),
    });
    const result = await resolveUnresolvedRowsWithAi({
      network, session, rows, adapted, issueKinds, liveRows, state,
      capabilities: AI_ADVANCED_CAPABILITIES, liveCanonicalInterpretation: true,
      wholeRecipe: wholeRecipeSource(),
    });
    expect(result.ok).toBe(true);
    // Withheld, so nothing reached the matcher for that row.
    expect(result.withheld.some((w) => w.reason === 'ambiguous')).toBe(true);
    const ambiguousRef = result.withheld.find((w) => w.reason === 'ambiguous')?.line_ref;
    if (ambiguousRef) {
      expect(result.outcome.candidates.find((c) => c.line_ref === ambiguousRef)).toBeUndefined();
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// §10 — TRANSPORT VALIDATION
// ---------------------------------------------------------------------------

describe('9B-3C — the browser re-validates advisory transport', () => {
  it('a hostile transport is refused rather than trusted', async () => {
    // A server that answers 200 but lies about authority must not be believed.
    const lyingResponse = {
      status: 200,
      ok: true,
      data: {
        ok: true,
        contract_version: 'nutrition_ai_authenticated_advisory_suggestions_v1',
        suggestions: [
          {
            line_ref: adapted[0].line_ref,
            interpreted_food_name: 'whole egg',
            suggested_usda_queries: ['whole egg'],
            // FORBIDDEN authority claims the browser must refuse:
            fdc_id: 2707152,
            grams: 50,
            verified: true,
          },
        ],
      },
    } as unknown as NetworkResponse;
    const lying: NetworkAdapter = {
      ...network,
      post: (async (path: string) =>
        path === '/api/nutrition/resolve-whole-recipe'
          ? lyingResponse
          : network.post(path, {})) as NetworkAdapter['post'],
    };
    const result = await resolveUnresolvedRowsWithAi({
      network: lying, session, rows, adapted, issueKinds, liveRows, state,
      capabilities: AI_ADVANCED_CAPABILITIES, liveCanonicalInterpretation: true,
      wholeRecipe: wholeRecipeSource(),
    });
    // The closed sanitizer refuses unknown suggestion keys whole.
    expect(result.ok).toBe(false);
    expect(result.outcome.candidates).toHaveLength(0);
  });

  it('a suggestion for a line_ref that was NEVER requested is discarded', async () => {
    // The browser allowlist is derived from the REQUESTED targets, so a server
    // that echoes back an unrequested/fabricated ref must never produce a
    // candidate — reconciliation is the backstop that makes this safe.
    const { sanitizeAiResolutionResponse } = await import('../../src/core/nutritionV2/aiResolution');
    const requestedRefs = wholeRecipeSource().targets.map((t) => t.line_ref);
    const sanitized = sanitizeAiResolutionResponse(
      {
        version: 'nutrition_ai_resolution_v4',
        suggestions: [
          {
            line_ref: 'ing:fabricated:0',
            interpreted_food_name: 'whole egg',
            suggested_usda_queries: ['whole egg'],
            normalized_food_query: 'whole egg',
          },
        ],
      },
      { allowedLineRefs: requestedRefs }
    );
    expect(sanitized.ok).toBe(false);
    expect((sanitized as { code?: string }).code).toBe('unknown_line_ref');

    // Backstop: even if the allowlist were bypassed, the matcher skips any
    // suggestion whose line_ref is not a REAL review row.
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows,
      adapted,
      suggestions: [
        {
          line_ref: 'ing:fabricated:0',
          interpreted_food_name: 'whole egg',
          suggested_usda_queries: ['whole egg'],
          normalized_food_query: 'whole egg',
        },
      ],
    });
    expect(outcome.candidates).toHaveLength(0);
  });

  it('an empty suggestion set is valid and simply resolves nothing', async () => {
    prov.override = () => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: [],
    });
    const result = await resolveUnresolvedRowsWithAi({
      network, session, rows, adapted, issueKinds, liveRows, state,
      capabilities: AI_ADVANCED_CAPABILITIES, liveCanonicalInterpretation: true,
      wholeRecipe: wholeRecipeSource(),
    });
    // An empty row set fails at reconciliation -> unavailable, never a fake match.
    expect(result.outcome.candidates).toHaveLength(0);
    expect(prov.calls).toBe(1);
  }, 60000);
});

// ---------------------------------------------------------------------------
// §8 — SHELL SOURCE CONSTRUCTION (structural pins)
// ---------------------------------------------------------------------------

describe('9B-3C — the SHELL builds the WHOLE recipe, structurally pinned', () => {
  const APP = readFileSync(join(__dirname, '../../src/App.tsx'), 'utf8');
  const handlerAt = APP.indexOf('const handleResolveAdvancedNutritionAi');
  const body = APP.slice(handlerAt, handlerAt + 2600);

  it('sends EVERY authored ingredient in original order — never a slice', () => {
    expect(body).toContain('recipe.ingredients');
    expect(body).toContain('ingredient.original ?? ingredient.name');
    expect(body).toContain('ingredients.map((name) => ({ name }))');
    // No truncation of the authored ingredient list.
    expect(body).not.toMatch(/ingredients\.slice\(/);
    expect(body).not.toMatch(/ingredients\.filter\([^)]*isChecked/);
    // No silent text rewriting of the authored line.
    expect(body).not.toMatch(/\.replace\(/);
  });

  it('sends the COMPLETE bounded instruction list', () => {
    expect(body).toContain('instructions: recipe.instructions.map((step) => ({ text: step.text }))');
    expect(body).not.toMatch(/instructions\.slice\(/);
    // It must not fabricate an empty instruction list when none is authored.
    expect(body).not.toContain('instructions: []');
  });

  it('derives targets from the ACTIONABLE rows through the existing adapter refs', () => {
    expect(body).toContain('rows\n        .map((row) => row.line_ref)');
    // Never a hand-authored or fabricated line ref.
    expect(body).not.toMatch(/line_ref:\s*['"`]ing:/);
    expect(body).not.toContain("line_ref: `ing:");
  });

  it('does not import any server authority into the shell', () => {
    const handler = APP.slice(handlerAt, handlerAt + 3000);
    for (const forbidden of [
      'wholeRecipeSemanticAuthority', 'wholeRecipeSemanticOriginReceipt',
      'createWholeRecipeSemanticOriginAuthority', 'wholeRecipeSemanticConsumption',
      'wholeRecipeSemanticUsdaBridge',
    ]) {
      expect(APP.includes(forbidden), `shell imports ${forbidden}`).toBe(false);
    }
    expect(handler).not.toContain('node:crypto');
  });
});
