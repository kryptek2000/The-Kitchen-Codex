/**
 * AI-4C — SECURITY / ISOLATION PINS.
 *
 * AI-4C adds a transport, so the invariants that matter are structural: exactly
 * one route, exactly one limiter bucket, no freeform prompt surface, no UI, no
 * reducer, no working-state mutation, no persistence, no Apply integration, no
 * reconciliation, no AI-3 authority import, and exactly ONE semantic provider
 * invocation per whole-recipe interpretation.
 *
 * WHERE EACH PIN LIVES AND WHY
 *  - Behaviour that only a real provider call can prove (call counts, the
 *    transport-fallback distinction) is proven HERE against the REAL
 *    `runWithAiFallback`, with a fake provider. The focused transport suite stubs
 *    the provider abstraction on purpose to count AI-4C's own invocations; this
 *    file proves the layer that owns retries behaves as documented.
 *  - Everything else is proven by behaviour or by a narrowly targeted structural
 *    pin. Incidental wording is never the subject of a test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { runWithAiFallback } from '../../server/ai/provider.js';
import { ProviderOperationError } from '../../server/ai/providerErrors.js';
import type { AiJsonSchema, AiStructuredOptions } from '../../server/ai/types.js';
import {
  BASIC_NUTRITION_CAPABILITIES,
  isAiInterpretationAvailable,
  resolveNutritionCapabilities,
} from '../../src/core/nutritionV2/nutritionCapabilities.js';
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract.js';
import { isAuthenticatedProvenanceClass } from '../../src/core/nutritionV2/aiAdvancedEstimate.js';

const REPO = process.cwd();
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

const APP = 'server/app.ts';
const LIMITER = 'server/rateLimiter.ts';
const TRANSPORT = 'server/nutritionContext.ts';
const DERIVATION = 'server/recipeContextDerivation.ts';
const REQUEST = 'src/core/nutritionV2/aiRecipeContextRequest.ts';
const WIRE = 'src/core/nutritionV2/aiRecipeContextWire.ts';

/** Source with every comment removed, so prose can never satisfy a code pin. */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The module's EXACT import specifier set. Pinning the import list (rather than
 * grepping for module-name substrings) is what makes "this transport cannot
 * reach a reducer / Apply / AI-3 module" a real invariant: a new import cannot
 * be added without failing this test.
 */
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
// 1. EXACTLY ONE ROUTE, EXACTLY ONE LIMITER
// ---------------------------------------------------------------------------
describe('AI-4C isolation — exactly one route and one limiter path', () => {
  it('exactly one PROVIDER-BACKED AI-4 recipe-context route exists', () => {
    const app = src(APP);
    const routes = [
      ...(app.match(/app\.(post|get|put|delete|patch)\([^)]*recipe-context[^)]*/g) ?? []),
    ].map((route) => route.replace(/\s+/g, ''));
    // AI-4C remains the ONLY route that can spend a provider call. AI-4D1 shipped
    // no route; AI-4D2 added the provider-FREE reconciliation route beside it, so
    // the AI-4C route is still the single provider-backed path.
    expect(routes).toHaveLength(2);
    // Only the AI-4C route is guarded by the paid-text pricing guard, so only it
    // can reach (and spend) a provider.
    expect(routes.filter((route) => route.includes('textPricingGuard'))).toHaveLength(1);
    expect(routes[0]).toContain('app.post("/api/nutrition/recipe-context",requireAiAccessToken,textPricingGuard');
    // The AI-4D2 route is provider-free: no pricing guard, its own limiter.
    expect(routes[1]).toContain(
      'app.post("/api/nutrition/recipe-context/reconcile",requireAiAccessToken,nutritionContextReconcileRateLimiter'
    );
    expect(routes[1]).not.toContain('textPricingGuard');
  });

  it('that route is guarded by the standard AI endpoint middleware chain', () => {
    const app = src(APP);
    const route = (app.match(/app\.post\("\/api\/nutrition\/recipe-context"[^\n]*/) ?? [''])[0];
    expect(route).toContain('requireAiAccessToken');
    expect(route).toContain('textPricingGuard');
    expect(route).toContain('nutritionContextRateLimiter');
  });

  it('exactly one AI-4 limiter exists, owning exactly one dedicated bucket', () => {
    const limiter = src(LIMITER);
    expect(limiter.match(/export function nutritionContextRateLimiter/g) ?? []).toHaveLength(1);
    // One `get` + one `set` on ONE store key, so exactly one limiter can ever
    // consume or be consumed by AI-4 traffic.
    expect(limiter.match(/get\(`nutr_context_\$\{clientIp\}`\)/g) ?? []).toHaveLength(1);
    expect(limiter.match(/set\(`nutr_context_\$\{clientIp\}`/g) ?? []).toHaveLength(1);
  });

  it('AI-4C raises NO existing limiter default and no other bucket is touched', () => {
    const limiter = src(LIMITER);
    // The established AI-1/AI-2B/AI-3 buckets keep their exact store keys.
    for (const key of [
      'nutr_',
      'nutr_resolve_',
      'nutr_interpret_',
      'nutr_plan_',
      'nutr_mass_estimate_',
    ]) {
      expect(limiter, key).toContain(`get(\`${key}\${clientIp}\`)`);
    }
  });

  it('there is NO arbitrary-prompt or generic provider proxy route', () => {
    const app = src(APP);
    // No route may accept a freeform model instruction, and there is no generic
    // provider passthrough endpoint.
    expect(app).not.toContain('"/api/ai/proxy"');
    expect(app).not.toContain('"/api/provider/proxy"');
    for (const forbidden of ['systemPrompt', 'rawPrompt', 'freeformPrompt']) {
      expect(app, forbidden).not.toContain(forbidden);
    }
  });

  it('AI-4C adds no second server entrypoint module', () => {
    const transportCode = code(TRANSPORT);
    const exported = transportCode.match(/export (async )?function \w+/g) ?? [];
    expect(exported.sort()).toEqual([
      'export async function interpretRecipeContextOnServer',
      'export function buildRecipeContextPrompt',
      'export function sanitizeRecipeContextProviderResponse',
      'export function sanitizeRecipeContextTransportRequest',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. NO UI, NO STATE, NO APPLY, NO PERSISTENCE, NO RECONCILIATION
// ---------------------------------------------------------------------------
describe('AI-4C isolation — no UI, no working state, no Apply, no reconciliation', () => {
  it('no client module references the AI-4 route or the transport', () => {
    for (const rel of [
      'src/App.tsx',
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
      'src/application/nutritionAiEstimate.ts',
      'src/application/nutritionAiResolve.ts',
      'src/application/advancedNutritionApply.ts',
    ]) {
      const source = src(rel);
      expect(source, rel).not.toContain('nutrition/recipe-context');
      expect(source, rel).not.toContain('interpretRecipeContext');
      expect(source, rel).not.toContain('nutritionContext');
    }
  });

  it('the transport imports NO reducer, state, apply, persistence or reconcile module', () => {
    const source = code(TRANSPORT);
    for (const forbidden of [
      '/phase4/state',
      '/phase4/rows',
      '/phase4/liveRow',
      '/phase5/',
      'advancedNutritionApply',
      'applyAdvancedNutrition',
      'authorizeNutritionPersistence',
      'encodeCodexNutrition',
      'codex_nutrition',
      'aiPlanReconcile',
      'aiResolve',
      'aiEstimateAccept',
      'aiEstimateApplyGate',
      'serializeRecipeToObsidianMarkdown',
      'frontmatter',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('the transport performs NO I/O of its own (no fetch, fs, storage, clock, randomness)', () => {
    const source = code(TRANSPORT);
    for (const forbidden of [
      'fetch(',
      'XMLHttpRequest',
      "require('node:fs')",
      "'node:fs'",
      "'fs'",
      "require('node:http')",
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'Date.now',
      'new Date',
      'Math.random',
      'process.env',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('the pure core request/wire modules import NOTHING but the local pure core', () => {
    // An exact import set: adding a server, provider, storage, clock or UI import
    // to either module fails here.
    expect(importsOf(REQUEST)).toEqual([
      './phase4/recipeContextContract',
      './phase4/recipeContextSnapshot',
      './schema',
      './usda/digest',
    ]);
    expect(importsOf(WIRE)).toEqual([
      './aiRecipeContextRequest',
      './phase4/recipeContextContract',
      './schema',
    ]);
  });

  it('the pure core request/wire modules perform no I/O, clock or randomness', () => {
    for (const rel of [REQUEST, WIRE]) {
      const source = code(rel);
      for (const forbidden of ['fetch(', 'Date.now', 'new Date', 'Math.random', 'process.env', 'localStorage']) {
        expect(source.includes(forbidden), `${rel} must not contain ${forbidden}`).toBe(false);
      }
    }
  });

  it('AI-4C re-owns NO AI-4A or AI-4B token and redefines NO AI-4A function', () => {
    for (const rel of [REQUEST, WIRE, TRANSPORT]) {
      const source = src(rel);
      // It CONSUMES the AI-4A contract; it never re-declares it.
      expect(source, rel).not.toMatch(/export const AI_RECIPE_CONTEXT_CONTRACT_VERSION\s*=/);
      expect(source, rel).not.toMatch(/export const AI_RECIPE_CONTEXT_PROVENANCE_CLASS\s*=/);
      expect(source, rel).not.toMatch(/export const AI_RECIPE_CONTEXT_EXTRACTOR\s*=/);
    }
    for (const symbol of [
      'sanitizeAiRecipeContextProposal',
      'validateAiRecipeContextRelationGraph',
      'sanitizeRecipeContextEnvelope',
      'sanitizeRecipeContextSnapshotInput',
      'recipeContextSnapshotBinding',
      'recipeContextSnapshotDigest',
    ]) {
      expect(code(TRANSPORT).includes(`function ${symbol}(`), symbol).toBe(false);
      expect(code(REQUEST).includes(`function ${symbol}(`), symbol).toBe(false);
    }
  });

  it('AI-4C does not modify the AI-4B extractor or the AI-4A contract/snapshot modules', () => {
    // They are consumed read-only; the AI-4C concepts do not appear in them.
    for (const rel of [
      'src/core/nutritionV2/phase4/recipeContextContract.ts',
      'src/core/nutritionV2/phase4/recipeContextSnapshot.ts',
      'src/core/nutritionV2/phase4/recipeContextExtraction.ts',
    ]) {
      const source = src(rel);
      expect(source, rel).not.toContain('aiRecipeContextRequest');
      expect(source, rel).not.toContain('aiRecipeContextWire');
      expect(source, rel).not.toContain('nutrition_ai_recipe_context_request_v1');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. NO AI-3 AUTHORITY IMPORT / NO AI-3 CAP INCREASE
// ---------------------------------------------------------------------------
describe('AI-4C isolation — AI-3 authority and caps are untouched', () => {
  it('the transport imports EXACTLY the provider abstraction + the AI-4 contract', () => {
    // The strongest form of the "no AI-3 authority import" pin: the import set
    // is closed, so an AI-3 estimate / plan / calculator / session / analyzer
    // module cannot be reached without failing this test.
    //
    // The transport reaches the deterministic derivation ONLY through the single
    // shared owner (`./recipeContextDerivation.js`), which is what stops a second,
    // drift-prone derivation implementation from appearing.
    expect(importsOf(TRANSPORT)).toEqual([
      '../src/core/nutritionV2/aiRecipeContextRequest.js',
      '../src/core/nutritionV2/aiRecipeContextWire.js',
      '../src/core/nutritionV2/nutritionCapabilities.js',
      '../src/core/nutritionV2/phase4/recipeContextContract.js',
      '../src/core/nutritionV2/schema.js',
      './ai/effectiveSelection.js',
      './ai/provider.js',
      './ai/providerErrors.js',
      './ai/types.js',
      './providerDiagnostics.js',
      './providerDiagnostics.js',
      './providerDiagnostics.js',
      './recipeContextDerivation.js',
    ].filter((value, index, all) => all.indexOf(value) === index).sort());
  });

  it('the derivation owner is the ONE server module that runs the AI-4B extraction', () => {
    // The repaired graph: AI-4A contracts <- AI-4B extraction <- ONE derivation
    // owner <- { AI-4C transport, AI-4D1 reconciler }. The transport and the
    // reconciler both call that owner, so the freshness comparison is computed over
    // exactly the context the transport would have sent.
    const consumers: string[] = [];
    for (const rel of walk(join(REPO, 'server'))) {
      if (src(rel).includes('extractRecipeContext') || src(rel).includes('recipeContextExtraction')) {
        consumers.push(rel);
      }
    }
    expect(consumers).toEqual([DERIVATION]);
    // Exactly TWO server modules may consume the owner, and both must actually
    // call it — no second derivation implementation can hide elsewhere.
    const ownerConsumers: string[] = [];
    for (const rel of walk(join(REPO, 'server'))) {
      // The owner declares the function; only CALLERS count as consumers.
      if (rel === DERIVATION) continue;
      if (/deriveRecipeContextModelInput\(/.test(code(rel))) ownerConsumers.push(rel);
    }
    expect(ownerConsumers.sort()).toEqual(
      ['server/nutritionContext.ts', 'server/recipeContextReconcile.ts'].sort()
    );
    expect(code(TRANSPORT)).toContain('deriveRecipeContextModelInput(');
    // The owner itself performs no provider work.
    for (const forbidden of ['provider', 'fetch(', 'runWithAiFallback']) {
      expect(code(DERIVATION).includes(forbidden), forbidden).toBe(false);
    }
  });

  it('the transport derives rather than trusts: no caller-authored envelope is accepted', () => {
    const transportCode = code(TRANSPORT);
    // A caller-supplied envelope is not an accepted input: the closed edge key
    // set has no context/envelope/targets key at all.
    const requestKeys = (transportCode.match(/const REQUEST_KEYS = new Set\(\[[^\]]*\]\)/) ?? [''])[0];
    expect(requestKeys).not.toContain('context');
    expect(requestKeys).not.toContain('envelope');
    expect(requestKeys).not.toContain('targets');
    expect(transportCode).toContain('REFUSED_REQUEST_KEYS');
    // And the edge refuses them BY NAME.
    for (const refused of ['context', 'envelope', 'recipe_context', 'targets', 'interpretations']) {
      expect(transportCode, refused).toContain(`'${refused}'`);
    }
  });

  it('AI-4C adds no bound to, and raises no cap in, any AI-3 module', () => {
    // The AI-3 request/response bounds are owned by their own modules; AI-4C only
    // owns an INDEPENDENT, additive 12-line / 32 KiB budget for AI-4.
    for (const rel of [
      'src/core/nutritionV2/aiAdvancedPlanRequest.ts',
      'src/core/nutritionV2/aiAdvancedEstimateWire.ts',
      'server/nutritionPlan.ts',
      'server/nutritionEstimate.ts',
    ]) {
      const source = src(rel);
      expect(source, rel).not.toContain('AI_RECIPE_CONTEXT_REQUEST');
      expect(source, rel).not.toContain('MAX_AI_RECIPE_CONTEXT');
    }
    expect(src(REQUEST)).toContain('MAX_AI_RECIPE_CONTEXT_REQUEST_BYTES = 32 * 1024');
    expect(src(REQUEST)).toContain(
      'MAX_AI_RECIPE_CONTEXT_REQUEST_LINES = MAX_RECIPE_CONTEXT_TARGETS'
    );
  });

  it('the AI-3 estimation, planning and interpretation routes are unchanged', () => {
    const app = src(APP);
    for (const route of [
      '"/api/nutrition/plan-ingredients"',
      '"/api/nutrition/estimate-mass"',
      '"/api/nutrition/interpret-ingredients"',
      '"/api/nutrition/resolve-ingredients"',
    ]) {
      expect(app).toContain(route);
    }
    // The AI-3 limiter is still the ONLY limiter on the AI-3 estimate route.
    const estimateRoute = (app.match(/app\.post\("\/api\/nutrition\/estimate-mass"[^\n]*/) ?? [''])[0];
    expect(estimateRoute).toContain('nutritionMassEstimateRateLimiter');
    expect(estimateRoute).not.toContain('nutritionContextRateLimiter');
  });

  it('the context binding is never described as provenance', () => {
    // Terminology discipline: the binding is a deterministic CONTEXT / FRESHNESS
    // binding. It must not be called provenance, authentication or a signature,
    // and it must never appear as an authenticated class.
    for (const rel of [TRANSPORT, REQUEST, WIRE]) {
      const source = src(rel);
      for (const forbidden of [
        'authenticated_provenance',
        'authenticated_nutrition',
        'provenance_proof',
        'signed_context',
        'attested',
      ]) {
        expect(source.includes(forbidden), `${rel}: ${forbidden}`).toBe(false);
      }
    }
    // The ONE binding owner: the request module. No second digest claims to
    // represent the interpreted context.
    const bindingOwners: string[] = [];
    for (const rel of [...walk(join(REPO, 'src')), ...walk(join(REPO, 'server'))]) {
      if (/export (function|const) .*ContextBinding|export function .*ModelInputBinding/.test(src(rel))) {
        bindingOwners.push(rel);
      }
    }
    expect(bindingOwners).toEqual([REQUEST]);
  });

  it('the AI-4 provenance class remains non-authenticated', () => {
    expect(isAuthenticatedProvenanceClass(AI_RECIPE_CONTEXT_PROVENANCE_CLASS)).toBe(false);
    expect(isAuthenticatedProvenanceClass(AI_RECIPE_CONTEXT_PROVENANCE_CLASS as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. EXACTLY ONE SEMANTIC PROVIDER INVOCATION (real transport mechanics)
// ---------------------------------------------------------------------------
describe('AI-4C isolation — one semantic invocation per interpretation', () => {
  interface FakeOptions {
    readonly failWith?: Error;
  }
  function countingProvider(id: string, options: FakeOptions = {}) {
    const calls: string[] = [];
    const capabilities = {
      reasoning: false,
      structuredOutput: true,
      recipeGeneration: false,
      webSearch: false,
    };
    const provider = {
      id,
      name: id,
      capabilities,
      isAvailable: () => true,
      testConnection: async () => true,
      generate: async () => '',
      generateStructured: async <T = unknown>(_p: string, _s: AiJsonSchema, _o: AiStructuredOptions) => {
        calls.push(id);
        if (options.failWith) throw options.failWith;
        return SUCCESS_PAYLOAD as unknown as T;
      },
    };
    // A genuine `RegisteredProvider` entry, so the REAL `selectCandidates`
    // capability filter runs instead of being bypassed.
    const registered = { provider, defaultCapabilities: { ...capabilities }, enabled: true };
    return { provider, registered, calls };
  }

  const SUCCESS_PAYLOAD = {
    contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
    provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
    interpretations: [],
  };

  const SUCCESS = SUCCESS_PAYLOAD;

  it('a successful interpretation is EXACTLY ONE real generateStructured call', async () => {
    const { provider, registered, calls } = countingProvider('p1');
    const { result } = await runWithAiFallback<unknown>({
      registry: [registered] as never,
      candidates: [{ provider, model: 'm1' }] as never,
      requiredCapabilities: ['structuredOutput'],
      // EXACTLY the option set AI-4C passes: no `retry` policy.
      run: (candidate) =>
        (candidate as unknown as { provider: typeof provider }).provider.generateStructured('', {} as AiJsonSchema, {} as AiStructuredOptions),
    });
    expect(result).toEqual(SUCCESS);
    expect(calls).toHaveLength(1);
  });

  it('AI-4C passes NO retry policy, so there is never a same-model retry', async () => {
    const source = code(TRANSPORT);
    const call = (source.match(/runWithAiFallback<[^>]*>\(\{[\s\S]*?\}\);/) ?? [''])[0];
    expect(call).toContain('requiredCapabilities');
    // A `retry` option here would enable same-model transport retries.
    expect(call).not.toContain('retry');
  });

  it('a retryable failure is NOT retried on the same model (one invocation per candidate)', async () => {
    const { provider, registered, calls } = countingProvider('p1', {
      failWith: new ProviderOperationError('UNAVAILABLE', 'temporarily unavailable', { providerId: 'p1' }),
    });
    await expect(
      runWithAiFallback<unknown>({
        registry: [registered] as never,
        candidates: [{ provider, model: 'm1' }] as never,
        requiredCapabilities: ['structuredOutput'],
        run: (candidate) =>
          (candidate as unknown as { provider: typeof provider }).provider.generateStructured('', {} as AiJsonSchema, {} as AiStructuredOptions),
      })
    ).rejects.toBeTruthy();
    // ONE attempt on the single candidate: no same-model retry fan-out.
    expect(calls).toHaveLength(1);
  });

  it('transport-level fallback across DIFFERENT candidates is bounded, not a semantic fan-out', async () => {
    // Documented honestly: a fallback-eligible failure may advance to the next
    // ordered candidate. That is the pre-existing transport resilience shared
    // with AI-1/AI-2B/AI-3 — never one call per line, per signal or per relation.
    const first = countingProvider('p1', {
      failWith: new ProviderOperationError('UNAVAILABLE', 'temporarily unavailable', { providerId: 'p1' }),
    });
    const second = countingProvider('p2');
    const { result } = await runWithAiFallback<unknown>({
      registry: [first.registered, second.registered] as never,
      candidates: [
        { provider: first.provider, model: 'm1' },
        { provider: second.provider, model: 'm2' },
      ] as never,
      requiredCapabilities: ['structuredOutput'],
      run: (candidate) => {
        const p = (candidate as unknown as { provider: { id: string } }).provider;
        return p.id === 'p1' ? first.provider.generateStructured('', {} as AiJsonSchema, {} as AiStructuredOptions) : second.provider.generateStructured('', {} as AiJsonSchema, {} as AiStructuredOptions);
      },
    });
    expect(result).toEqual(SUCCESS);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    // Two candidates, two invocations: bounded transport fallback, not N-per-line.
    expect(first.calls.length + second.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. CAPABILITY / TIER GATE (server-side, one owner)
// ---------------------------------------------------------------------------
describe('AI-4C isolation — the tier gate is server-side and uses the ONE owner', () => {
  it('the transport gates through resolveNutritionCapabilities / isAiInterpretationAvailable', () => {
    const source = code(TRANSPORT);
    expect(source).toContain('resolveNutritionCapabilities');
    expect(source).toContain('isAiInterpretationAvailable');
    // No bespoke tier string, no client-supplied "tier" or "entitled" flag.
    expect(source).not.toContain("'ai_advanced'");
    expect(source).not.toContain('entitled');
    expect(source).not.toContain('subscription');
  });

  it('the Basic tier is genuinely non-entitled in the ONE capability owner', () => {
    expect(isAiInterpretationAvailable(BASIC_NUTRITION_CAPABILITIES)).toBe(false);
    expect(isAiInterpretationAvailable(resolveNutritionCapabilities({}))).toBe(false);
    expect(isAiInterpretationAvailable(resolveNutritionCapabilities({ aiConfigured: true }))).toBe(false);
    expect(
      isAiInterpretationAvailable(resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }))
    ).toBe(true);
  });

  it('the route maps a capability refusal to a bounded 400, not a provider error', () => {
    const app = src(APP);
    const route = (app.match(/app\.post\("\/api\/nutrition\/recipe-context"[\s\S]*?\n  \}\);/) ?? [''])[0];
    expect(route).toContain('"capability_unavailable"');
    expect(route).toContain('"invalid_recipe"');
    expect(route).toContain('"unsupported_request_version"');
    expect(route).toContain('res.status(400)');
    // A capability refusal is never reported as a provider failure.
    expect(route).not.toContain('capability_unavailable" \n          ? 503');
  });
});

// ---------------------------------------------------------------------------
// 6. ERROR MODEL: NOTHING LEAKS
// ---------------------------------------------------------------------------
describe('AI-4C isolation — the error model leaks nothing', () => {
  it('the transport returns only bounded codes and never echoes provider internals', () => {
    const source = src(TRANSPORT);
    // The result type is a CLOSED union of bounded codes + booleans.
    expect(source).toContain('export type NutritionContextFailureCode');
    for (const code of [
      'invalid_request',
      'unsupported_request_version',
      'invalid_recipe',
      'no_targets',
      'too_many_targets',
      'request_too_large',
      'capability_unavailable',
      'unavailable',
      'provider_error',
      'invalid_response',
    ]) {
      expect(source).toContain(`'${code}'`);
    }
    // No raw error text, stack, provider id, model id or key can reach a result.
    expect(source).not.toContain('error.message');
    expect(source).not.toContain('JSON.stringify(err');
    expect(source).not.toContain('rawText');
  });

  it('the route response bodies are fixed copy and never echo the request', () => {
    const app = src(APP);
    const route = (app.match(/app\.post\("\/api\/nutrition\/recipe-context"[\s\S]*?\n  \}\);/) ?? [''])[0];
    for (const bounded of [
      'Invalid recipe-context request.',
      'AI recipe-context interpretation is unavailable.',
      'An unexpected error occurred during recipe-context interpretation.',
    ]) {
      expect(route).toContain(bounded);
    }
    // The success response is an EXACT, closed key set: request identity, the
    // validated proposal, the AI-4A digest and the attempt flag. Nothing else —
    // no provider, no model, no credential, and never the request body echoed.
    const body = (route.match(/res\.json\(\{([\s\S]*?)\}\);/) ?? ['', ''])[1];
    const keys = [...body.matchAll(/^ {8}([A-Za-z_]+):/gm)].map((match) => match[1]);
    expect(keys.sort()).toEqual(['aiAttempted', 'context_binding', 'ok', 'proposal', 'request_id']);
    expect(route).not.toMatch(/res\.json\([^)]*req\.body/);
    expect(route).not.toMatch(/\.\.\.req\.body/);
  });
});
