/**
 * AI-4D1 — SECURITY / ISOLATION PINS.
 *
 * AI-4D1 reconciles a returned proposal against the CURRENT server-derived
 * context. The invariants that matter are therefore negative ones, and they are
 * pinned here:
 *
 *   - ZERO provider reachability (the AI has already spoken; this phase is
 *     deterministic), proven by a THROWING provider module stub in the focused
 *     suite and by closed import sets here;
 *   - ONE derivation owner: the freshness comparison is computed over exactly the
 *     context the transport would have sent, and no second derivation can appear;
 *   - NO acceptance surface: no reducer action, no state setter, no accepted-context
 *     object, no persistence, no Apply integration, no UI, no new route, no limiter;
 *   - NO AI-3 gating or suppression of any kind;
 *   - the AI-4A/AI-4B/AI-4C closure protections are all still in place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES,
  AI_RECIPE_CONTEXT_RECONCILE_STATUSES,
  AI_RECIPE_CONTEXT_RECONCILE_VERSION,
} from '../../src/core/nutritionV2/aiRecipeContextReconcile.js';

const REPO = process.cwd();
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

const RECONCILE = 'src/core/nutritionV2/aiRecipeContextReconcile.ts';
const DERIVATION = 'server/recipeContextDerivation.ts';
const SERVER_ADAPTER = 'server/recipeContextReconcile.ts';
const TRANSPORT = 'server/nutritionContext.ts';
const AI4D1_MODULES: ReadonlyArray<string> = [RECONCILE, DERIVATION, SERVER_ADAPTER];

/** Source with every comment removed, so prose can never satisfy a code pin. */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(REPO, full));
  }
  return out;
}

function importsOf(rel: string): ReadonlyArray<string> {
  return [...new Set([...code(rel).matchAll(/from '([^']+)'/g)].map((match) => match[1]))].sort();
}

// ---------------------------------------------------------------------------
// 1. ZERO PROVIDER REACHABILITY
// ---------------------------------------------------------------------------
describe('AI-4D1 isolation — ZERO provider execution', () => {
  it('no AI-4D1 module imports or names a provider', () => {
    for (const rel of AI4D1_MODULES) {
      const source = code(rel);
      for (const forbidden of [
        'ai/provider',
        'ai/provider.js',
        'providerRegistry',
        'runWithAiFallback',
        'resolveRoleCandidates',
        'resolveExecutableTextCandidates',
        'logModelAttempt',
        'normalizeProviderError',
        'gemini',
        'openRouter',
        'deepSeek',
        'generateStructured',
        'selectCandidates',
        'GEMINI_API_KEY',
        'OPENROUTER_API_KEY',
      ]) {
        expect(source.includes(forbidden), `${rel} must not reference ${forbidden}`).toBe(false);
      }
    }
  });

  it('no AI-4D1 module performs network, storage, env, clock or randomness', () => {
    for (const rel of AI4D1_MODULES) {
      const source = code(rel);
      for (const forbidden of [
        'fetch(',
        'XMLHttpRequest',
        'axios',
        'WebSocket',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'process.env',
        'Date.now',
        'new Date',
        'Math.random',
        'toLocale',
        'Intl.',
        'await ',
        'async function',
        'Promise',
      ]) {
        expect(source.includes(forbidden), `${rel} must not contain ${forbidden}`).toBe(false);
      }
    }
  });

  it('the reconciliation core imports NOTHING but local pure core', () => {
    expect(importsOf(RECONCILE)).toEqual([
      './aiRecipeContextWire',
      './phase4/materialize',
      './phase4/recipeContextContract',
      './schema',
    ]);
  });

  it('the server adapter imports ONLY the core reconcile, the shared derivation and the released version constant', () => {
    expect(importsOf(SERVER_ADAPTER)).toEqual([
      '../src/core/nutritionV2/aiRecipeContextReconcile.js',
      '../src/core/nutritionV2/aiRecipeContextRequest.js',
      '../src/core/nutritionV2/schema.js',
      './recipeContextDerivation.js',
    ]);
  });

  it('the derivation owner is provider-free and imports only the derivation chain', () => {
    expect(importsOf(DERIVATION)).toEqual([
      '../src/core/nutritionV2/aiRecipeContextRequest.js',
      '../src/core/nutritionV2/phase4/adapt.js',
      '../src/core/nutritionV2/phase4/recipeContextExtraction.js',
    ]);
  });

  it('the reconciliation core has exactly its three intended consumers, and NO UI', () => {
    // AI-4D1 shipped the server adapter only. AI-4D2 then added the two CLIENT
    // consumers that legitimately need the reconciliation contract: the pure
    // acceptance session (the plan it overlays decisions onto) and the application
    // layer (the transport response assertion). No component, view or hook reaches
    // the reconciliation core directly.
    const consumers: string[] = [];
    for (const rel of [...walk(join(REPO, 'src')), ...walk(join(REPO, 'server'))]) {
      if (rel === RECONCILE) continue;
      if (/aiRecipeContextReconcile/.test(src(rel))) consumers.push(rel);
    }
    expect(consumers.sort()).toEqual(
      [
        SERVER_ADAPTER,
        'src/application/nutritionAiRecipeContext.ts',
        'src/core/nutritionV2/aiRecipeContextSession.ts',
      ].sort()
    );
    for (const rel of consumers) {
      expect(rel.startsWith('src/components/'), rel).toBe(false);
      expect(rel.startsWith('src/hooks/'), rel).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SINGLE DERIVATION OWNER
// ---------------------------------------------------------------------------
describe('AI-4D1 isolation — ONE derivation owner, no drift', () => {
  it('exactly two server modules consume the derivation owner: the transport and this adapter', () => {
    const consumers: string[] = [];
    for (const rel of walk(join(REPO, 'server'))) {
      if (rel === DERIVATION) continue;
      if (/deriveRecipeContextModelInput\(/.test(code(rel))) consumers.push(rel);
    }
    expect(consumers.sort()).toEqual([TRANSPORT, SERVER_ADAPTER].sort());
  });

  it('only the owner implements the derivation chain', () => {
    const offenders: string[] = [];
    for (const rel of walk(join(REPO, 'server'))) {
      if (rel === DERIVATION) continue;
      const source = code(rel);
      if (/adaptRecipe\(/.test(source) || /extractRecipeContext\(/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the adapter reuses the released request projection and the ONE binding owner', () => {
    const source = code(SERVER_ADAPTER);
    // The adapter must not re-implement the projection or the binding.
    expect(source).toContain('derived.request.model_input_binding');
    expect(source).toContain('derived.request.provider_request.targets');
    for (const forbidden of [
      'aiRecipeContextModelInputBinding',
      'buildAiRecipeContextRequest',
      'sha256',
      'canonicalStringify',
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
    // And the request version is the RELEASED constant, never a caller field: the
    // closed external request keys contain no version key at all.
    expect(source).toContain('AI_RECIPE_CONTEXT_REQUEST_VERSION');
    const requestKeys = (source.match(/const RECONCILE_REQUEST_KEYS = new Set\(\[[^\]]*\]\)/) ?? [''])[0];
    expect(requestKeys).not.toContain('version');
    expect(requestKeys).not.toContain('binding');
  });

  it('no second AI-4 digest is introduced anywhere', () => {
    // AI-4D1 must not create another AI-4 transport/context digest, and must not
    // resurrect `snapshot_digest` as competing truth.
    for (const rel of AI4D1_MODULES) {
      // CODE only: prose legitimately NAMES `snapshot_digest` to forbid it.
      const source = code(rel);
      for (const forbidden of [
        'snapshot_digest',
        'recipeContextSnapshotDigest',
        'recipeContextSnapshotBinding',
        'sha256Hex',
        'stableChoiceKey',
      ]) {
        expect(source.includes(forbidden), `${rel}: ${forbidden}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. NO ACCEPTANCE SURFACE (R)
// ---------------------------------------------------------------------------
describe('AI-4D1 isolation — NO acceptance, state, persistence, Apply, UI, route or limiter', () => {
  it('no reducer action, state setter, accepted-context object or undo/dismiss action', () => {
    for (const rel of AI4D1_MODULES) {
      const source = src(rel);
      for (const forbidden of [
        'accept_recipe_context',
        'clear_recipe_context',
        'undo_recipe_context',
        'dismiss_recipe_context',
        'phase4Reducer',
        'INITIAL_PHASE4_STATE',
        'Phase4Action',
        'useReducer',
        'useState',
        'dispatch(',
        'acceptedContext',
        'accepted_context',
      ]) {
        expect(source.includes(forbidden), `${rel}: ${forbidden}`).toBe(false);
      }
    }
  });

  it('no persistence, no Phase 5, no Apply integration', () => {
    for (const rel of AI4D1_MODULES) {
      const source = code(rel);
      for (const forbidden of [
        '/phase5/',
        'applyAdvancedNutrition',
        'authorizeNutritionPersistence',
        'encodeCodexNutrition',
        'codex_nutrition',
        'serializeRecipeToObsidianMarkdown',
        'frontmatter',
      ]) {
        expect(source.includes(forbidden), `${rel}: ${forbidden}`).toBe(false);
      }
    }
  });

  it('no AI-3 gating, suppression, mass, nutrient or matching reachability', () => {
    // Module reachability is pinned exactly by the import-set tests above; this
    // scan covers the AI-3 authority VOCABULARY, which must appear nowhere.
    for (const rel of AI4D1_MODULES) {
      const source = code(rel);
      for (const forbidden of [
        'aiEstimate',
        'aiAdvancedPlan',
        'aiResolution',
        'effectiveMass',
        'EffectiveMass',
        'resolved_grams',
        'representative_grams',
        'suppress',
        'eligibility',
        'AiEstimate',
        'phase4/state',
        'phase4/rows',
        'phase4/session',
        'phase4/analyzer',
        'calculation/',
        'matching/',
        'usda/',
      ]) {
        expect(source.includes(forbidden), `${rel}: ${forbidden}`).toBe(false);
      }
    }
  });

  it('the exported reconciliation surface carries NO acceptance vocabulary', async () => {
    const module = await import('../../src/core/nutritionV2/aiRecipeContextReconcile.js');
    const forbidden = [
      'accept',
      'approve',
      'appl',
      'authorit',
      'automat',
      'select',
      'suppress',
      'undo',
      'dismiss',
      'commit',
      'persist',
    ];
    for (const name of Object.keys(module)) {
      const lowered = name.toLowerCase();
      for (const word of forbidden) {
        expect(lowered, `${name} must not contain ${word}`).not.toContain(word);
      }
    }
    expect([...AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES]).toEqual([
      'reviewable',
      'abstained',
      'uninterpreted',
    ]);
    expect([...AI_RECIPE_CONTEXT_RECONCILE_STATUSES]).toEqual(['current']);
    expect(AI_RECIPE_CONTEXT_RECONCILE_VERSION).toBe('nutrition_ai_recipe_context_reconcile_v1');
  });

  it('exactly ONE AI-4D route exists: the AI-4D2 provider-free reconciliation endpoint', () => {
    const app = src('server/app.ts');
    const routes = [
      ...(app.match(/app\.(post|get|put|delete|patch)\(\s*\n?\s*"\/api\/[^"]*"/g) ?? []),
    ].map((route) => route.replace(/\s+/g, ''));
    // AI-4C interpretation remains the only PROVIDER-backed recipe-context route.
    const recipeContextRoutes = routes.filter((route) => route.includes('/api/nutrition/recipe-context'));
    expect(recipeContextRoutes).toEqual([
      'app.post("/api/nutrition/recipe-context"',
      'app.post("/api/nutrition/recipe-context/reconcile"',
    ]);
    // The single AI-4D route is the reconciliation one, and nothing else mentions
    // AI-4D in the route inventory.
    expect(routes.filter((route) => route.toLowerCase().includes('ai4d'))).toEqual([]);
  });

  it('AI-4D1 added no limiter; AI-4D2 added exactly one, on its own key', () => {
    const limiter = src('server/rateLimiter.ts');
    // Exactly one reconcile limiter exists, and it is the AI-4D2 provider-free one.
    expect(limiter.match(/export function \w*Reconcile\w*RateLimiter/g) ?? []).toEqual([
      'export function nutritionContextReconcileRateLimiter',
    ]);
    // It is a DEDICATED key: it never shares the AI-4C provider budget's entry.
    expect(limiter).toContain('nutr_context_reconcile_${clientIp}');
    expect(limiter).toContain('nutr_context_${clientIp}');
    // The AI-4C provider bucket itself is untouched by this phase.
    expect(limiter).toContain('NUTRITION_CONTEXT_RATE_LIMIT');
    expect(limiter).toContain('NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT');
    // No bucket was ever named for a later phase, and AI-4D1 added no bucket.
    expect(limiter.toLowerCase()).not.toContain('ai4d');
    expect(limiter).not.toContain('nutr_reconcile');
  });

  it('NO UI: no client module references the AI-4D1 modules', () => {
    for (const rel of [
      'src/App.tsx',
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
      'src/components/RecipeDetailView.tsx',
      'src/components/RecipeNutritionSection.tsx',
      'src/application/nutritionAiEstimate.ts',
      'src/application/advancedNutritionApply.ts',
    ]) {
      const source = src(rel);
      expect(source, rel).not.toContain('aiRecipeContextReconcile');
      expect(source, rel).not.toContain('reconcileRecipeContext');
      expect(source, rel).not.toContain('recipeContextReconcile');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. AI-4A/4B/4C CLOSURE PROTECTIONS STILL IN PLACE
// ---------------------------------------------------------------------------
describe('AI-4D1 isolation — the released AI-4 closure protections are intact', () => {
  it('server-derived context only: the transport still refuses a caller envelope by name', () => {
    const source = code(TRANSPORT);
    const requestKeys = (source.match(/const REQUEST_KEYS = new Set\(\[[^\]]*\]\)/) ?? [''])[0];
    expect(requestKeys).not.toContain('context');
    expect(requestKeys).not.toContain('envelope');
    expect(requestKeys).not.toContain('targets');
    for (const refused of ['context', 'envelope', 'recipe_context', 'targets', 'interpretations']) {
      expect(source, refused).toContain(`'${refused}'`);
    }
  });

  it('request_version validation, the ONE binding and one provider operation are intact', () => {
    const transport = code(TRANSPORT);
    const request = src('src/core/nutritionV2/aiRecipeContextRequest.ts');
    // Exact-version discrimination.
    expect(request).toContain('unsupported_request_version');
    expect(request).toContain("input.requestVersion !== AI_RECIPE_CONTEXT_REQUEST_VERSION");
    // ONE binding owner, and the AI-4A snapshot binding is not shipped on the wire.
    const wire = src('src/core/nutritionV2/aiRecipeContextWire.ts');
    const wireCode = code('src/core/nutritionV2/aiRecipeContextWire.ts');
    expect(wire).toContain('context_binding');
    // CODE carries no competing snapshot/binding field; prose may explain why.
    expect(wireCode).not.toContain('snapshot');
    expect(wireCode).not.toContain('recipeContextSnapshot');
    // Exactly one provider semantic invocation: no retry policy is passed.
    const call = (transport.match(/runWithAiFallback<[^>]*>\(\{[\s\S]*?\}\);/) ?? [''])[0];
    expect(call).toContain('requiredCapabilities');
    expect(call).not.toContain('retry');
  });

  it('the AI-4A contract and the AI-4B extractor are unmodified by AI-4D1', () => {
    for (const rel of [
      'src/core/nutritionV2/phase4/recipeContextContract.ts',
      'src/core/nutritionV2/phase4/recipeContextExtraction.ts',
      'src/core/nutritionV2/phase4/recipeContextSnapshot.ts',
    ]) {
      const source = src(rel);
      expect(source, rel).not.toContain('aiRecipeContextReconcile');
      expect(source, rel).not.toContain('RECONCILE_VERSION');
      expect(source, rel).not.toContain('recipeContextReconcile');
    }
  });

  it('AI-4D1 adds no AI-3 authority surface and no second reconciliation module', () => {
    for (const rel of [
      'src/core/nutritionV2/aiAdvancedEstimate.ts',
      'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
      'src/core/nutritionV2/phase4/aiEstimateAccept.ts',
      'src/core/nutritionV2/calculation/calculate.ts',
      'src/core/nutritionV2/calculation/effectiveMass.ts',
      'src/core/nutritionV2/phase5/authorize.ts',
    ]) {
      expect(src(rel), rel).not.toContain('aiRecipeContextReconcile');
    }
    // Exactly one module declares the reconciliation version token.
    const owners: string[] = [];
    for (const rel of [...walk(join(REPO, 'src')), ...walk(join(REPO, 'server'))]) {
      if (/export const AI_RECIPE_CONTEXT_RECONCILE_VERSION\s*=/.test(src(rel))) owners.push(rel);
    }
    expect(owners).toEqual([RECONCILE]);
  });

  it('the output is produced with Object.freeze and there is no mutation of inputs', () => {
    const source = code(RECONCILE);
    expect(source).toContain('Object.freeze');
    // No assignment into an input-shaped object: the plan is built, not patched.
    expect(source).not.toMatch(/wire\[[^\]]*\]\s*=/);
    expect(source).not.toMatch(/current\.[a-z_]+\s*=/);
  });
});
