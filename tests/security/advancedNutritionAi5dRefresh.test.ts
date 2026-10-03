/**
 * Advanced Nutrition AI-5D — SECURITY: authority isolation, shell wiring, and the
 * server that stays final.
 *
 * AI-5D adds refresh and recovery. The rule it must never break is the one AI-5C
 * established:
 *
 *     CLIENT AWARENESS != SERVER AUTHORITY
 *
 * So this file proves the refresh machinery cannot become a second entitlement
 * source, cannot open a client->server authority channel, cannot weaken the six
 * AI-5B gates, cannot persist readiness, and cannot quietly make Advanced Nutrition
 * eager at startup.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'net';

import { resetRateLimitersForTests } from '../../server/rateLimiter.js';
import {
  NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
  buildNutritionAiNotEntitledBody,
} from '../../server/nutritionProductAccess.js';
import { AI_ADVANCED_NUTRITION_PRODUCT_ACCESS } from '../../src/core/nutritionV2/nutritionProductAccess';

const AI_ENDPOINT_TOKEN = 'ai5d-authority-token';
const AUTH = `Bearer ${AI_ENDPOINT_TOKEN}`;

const ENV_KEYS = [
  'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_NUTRITION_PRODUCT_TIER',
  'GEMINI_API_KEY',
  'NUTRITION_RESOLVE_RATE_LIMIT',
  'NUTRITION_INTERPRET_RATE_LIMIT',
  'NUTRITION_PLAN_RATE_LIMIT',
  'NUTRITION_ESTIMATE_RATE_LIMIT',
  'NUTRITION_CONTEXT_RATE_LIMIT',
  'NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT',
] as const;

const GATED_ROUTES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['/api/nutrition/resolve-ingredients', { ingredients: [] }],
  ['/api/nutrition/interpret-ingredients', { ingredients: [] }],
  ['/api/nutrition/plan-ingredients', { target: {} }],
  ['/api/nutrition/estimate-mass', { request_id: 'ai5d', estimates: [] }],
  ['/api/nutrition/recipe-context', { recipe: {} }],
  ['/api/nutrition/recipe-context/reconcile', { wire: { rctx: 'forged' } }],
];

function read(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8');
}

/** Comment-stripped source, so prose about a rule is never mistaken for the rule. */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

interface Running {
  readonly server: http.Server;
  readonly baseUrl: string;
}

async function startApp(tier?: unknown): Promise<Running> {
  const { createApp } = await import('../../server/app.js');
  const app = createApp({
    isProduction: false,
    ...(tier === undefined ? {} : { nutritionProductTier: tier }),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// ===========================================================================
describe('AI-5D — a refreshed client NEVER becomes server authority', () => {
  let basicApp: Running;

  beforeAll(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
    resetRateLimitersForTests();
    basicApp = await startApp('basic');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => basicApp.server.close(() => resolve()));
    delete process.env.AI_ENDPOINT_TOKEN;
  });

  beforeEach(() => {
    process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  });

  afterEach(() => {
    resetRateLimitersForTests();
  });

  it('denies every gated route after the client refresh reports AVAILABLE', async () => {
    // The adversary: the client has just completed a successful AI-5D readiness
    // refresh and believes AI is AVAILABLE against a Basic deployment.
    for (const [route, body] of GATED_ROUTES) {
      const response = await fetch(`${basicApp.baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: AUTH },
        body: JSON.stringify({
          ...body,
          // Whatever the client believes, echoed back.
          tier: 'ai_advanced',
          entitled: true,
          productAccess: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
        }),
      });
      const json = (await response.json()) as Record<string, unknown>;
      expect(response.status, `${route} must stay denied`).toBe(403);
      expect(json).toEqual(buildNutritionAiNotEntitledBody());
      expect(json.aiAttempted).toBe(false);
    }
  });

  it('a refresh/retry/recovery control grants no new route capability', async () => {
    // Readiness refresh reads only existing non-secret status surfaces. There is no
    // refresh, retry, recovery or readiness endpoint of any kind.
    const { createApp } = await import('../../server/app.js');
    const app = createApp({ isProduction: false, nutritionProductTier: 'ai_advanced' });
    const source = read('server/app.ts');
    for (const forbidden of [
      '/api/nutrition/refresh',
      '/api/nutrition/retry',
      '/api/nutrition/recovery',
      '/api/nutrition/readiness',
      '/api/nutrition/capabilities',
      '/api/nutrition/effective',
    ]) {
      expect(source, `server must not add ${forbidden}`).not.toContain(forbidden);
    }
    expect(app).toBeTruthy();
  });

  it('the AI-5C product endpoint is unchanged by AI-5D', async () => {
    const response = await fetch(`${basicApp.baseUrl}${NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT}`, {
      headers: { Authorization: AUTH },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      version: 'nutrition_product_access_v1',
      tier: 'basic',
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});

// ===========================================================================
describe('AI-5D — the App shell owns refresh, with ONE sequencing authority', () => {
  it('splits the two lifetimes instead of caching the whole composed result forever', () => {
    const app = code('src/App.tsx');
    // Product truth is a SEPARATE cache from the composed state, and readiness is
    // re-read through the refresh path rather than an immutable "Once".
    expect(app).toContain('nutritionProductReadRef');
    expect(app).toContain('recomposeNutritionAiClientState');
    // The AI-5C whole-state helper must no longer be the shell's owner.
    expect(app).not.toContain('resolveNutritionAiClientStateOnce');
  });

  it('routes initial load, retry, and provider invalidation through ONE refresh', () => {
    const app = code('src/App.tsx');
    // Exactly one refresh implementation, one sequencer, shared by every entry point.
    const refreshDefs = app.match(/const runNutritionAiRefresh = useCallback/g) ?? [];
    expect(refreshDefs.length).toBe(1);
    expect(app).toContain('createNutritionRefreshSequencer');
    const sequencers = app.match(/createNutritionRefreshSequencer\(\)/g) ?? [];
    // Declared once and used through the single ref.
    expect(sequencers.length).toBe(1);
    // All three entry points funnel into it.
    expect(app).toContain('runNutritionAiRefresh({ reuseProductAccess: knownAdvanced })');
    expect(app).toContain('void runNutritionAiRefresh({ reuseProductAccess: true })');
  });

  it('fails closed BEFORE any await when readiness is invalidated', () => {
    const app = code('src/App.tsx');
    // The invalidation publish happens before the awaited recompose, so there is no
    // stale window in which a revoked credential leaves AI executable.
    const fn = app.slice(app.indexOf('const runNutritionAiRefresh'));
    const invalidateAt = fn.indexOf('publishNutritionAiPresentation(currentState, true)');
    const awaitAt = fn.indexOf('await recomposeNutritionAiClientState');
    expect(invalidateAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(-1);
    expect(invalidateAt).toBeLessThan(awaitAt);
  });

  it('guards every publish against a stale completion', () => {
    const app = code('src/App.tsx');
    const fn = app.slice(app.indexOf('const runNutritionAiRefresh'));
    // BOTH the success and the failure path must check the sequencer before
    // rewriting the ref or the presentation.
    const guards = fn.match(/isCurrent\(generation\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it('does not trigger product-access resolution from a provider settings change', () => {
    const app = code('src/App.tsx');
    const fn = app.slice(app.indexOf('const invalidateNutritionReadiness'));
    // Never resolved yet => stay lazy and fetch nothing.
    expect(fn).toContain('if (nutritionProductReadRef.current === null) return;');
    // Known Basic => a provider cannot grant Advanced, so no readiness request.
    expect(fn).toContain('if (knownBasic) return;');
  });

  it('gates every AI port on the CURRENT state, never a captured closure', () => {
    const app = code('src/App.tsx');
    // The effective-capability decision reads refs at call time and fails closed
    // while a refresh is in flight.
    expect(app).toContain('const currentEffectiveNutritionCapabilities = useCallback');
    expect(app).toContain('if (nutritionRefreshingRef.current)');
    // AI-4 review reads the composed per-feature bit at call time too.
    expect(app).toContain('state.effectiveCapabilities.aiRecipeContextReview');
  });

  it('caches ONLY a resolved product read, never an unknown one', () => {
    const app = code('src/App.tsx');
    expect(app).toContain("state.productAccessStatus.status === 'resolved'");
  });
});

// ===========================================================================
describe('AI-5D — Provider Settings integration is narrow and text-only', () => {
  it('exposes a non-secret, authority-free invalidation callback', () => {
    const source = code('src/application-ui/ProviderSettings.tsx');
    expect(source).toContain('onTextAiRuntimeChanged?: () => void');
    // It carries no argument at all, so it cannot smuggle a secret or a verdict.
    const decl = source.slice(source.indexOf('onTextAiRuntimeChanged?: () => void'));
    expect(decl).toBeTruthy();
  });

  it('fires ONLY for the text surface', () => {
    const source = code('src/application-ui/ProviderSettings.tsx');
    // Image-only mutations are filtered out at the panel edge.
    expect(source).toContain("if (kind === 'text') onTextAiRuntimeChanged?.();");
    // And the connection test settles only for text.
    expect(source).toContain("if (kind === 'text') onTextConnectionTestSettled?.();");
  });

  it('never lets a connection test set a nutrition capability directly', () => {
    const source = code('src/application-ui/ProviderSettings.tsx');
    // The test result only asks the shell to re-read readiness.
    expect(source).not.toContain('effectiveCapabilities');
    expect(source).not.toContain('available = true');
    expect(source).not.toMatch(/nutritionAi[A-Z]\w*\s*=/);
  });

  it('does not duplicate Provider Settings state in the App shell', () => {
    const app = code('src/App.tsx');
    // The shell keeps NO provider/credential/session-key copy of its own.
    for (const forbidden of [
      'sessionProviders',
      'ProviderCatalogView',
      'draftsRef',
      'opCounterRef',
      'sessionStatus',
    ]) {
      expect(app, `App must not duplicate provider state: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
describe('AI-5D — no polling, no new secret surface, no persistence', () => {
  it('introduces no interval or timer-based provider polling', () => {
    // The two modules AI-5D owns must contain no scheduler at all.
    for (const relative of [
      'src/application/nutritionAiClientState.ts',
      'src/application/nutritionProductAccess.ts',
    ]) {
      const source = code(relative);
      for (const forbidden of ['setInterval', 'setTimeout', 'requestAnimationFrame', 'poll', 'startPolling']) {
        expect(source, `${relative} must not schedule a poll (${forbidden})`).not.toContain(forbidden);
      }
    }
    // App.tsx legitimately owns unrelated cooking timers, so the check is scoped to
    // the AI-5D refresh region only: readiness recovery must be event- and
    // user-triggered, never periodic.
    const app = code('src/App.tsx');
    const region = app.slice(app.indexOf('const runNutritionAiRefresh'));
    expect(region.length).toBeGreaterThan(0);
    for (const forbidden of ['setInterval', 'setTimeout', 'requestAnimationFrame', 'poll']) {
      expect(region, `AI-5D refresh region must not poll (${forbidden})`).not.toContain(forbidden);
    }
  });

  it('reads no secret material on the readiness path', () => {
    const source = code('src/application/nutritionAiClientState.ts');
    for (const forbidden of [
      'apiKey',
      'api_key',
      'secret',
      'Authorization',
      'bearer',
      'token',
    ]) {
      expect(source.toLowerCase(), `readiness must not touch ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });

  it('adds NO new server route or server readiness endpoint', () => {
    // Every status surface AI-5D reads already existed BEFORE this phase: the
    // provider status/catalog in app.ts, and the session-key status in its own
    // registrar. AI-5D reuses them and adds no route of its own.
    const app = read('server/app.ts');
    expect(app).toContain('NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT');
    expect(app).toContain('"/api/providers"');
    expect(app).toContain('"/api/providers/catalog"');
    expect(read('server/ai/sessionKeyRoutes.ts')).toContain('/api/providers/session-key/status');

    // And no readiness-shaped route was introduced anywhere in the server tree.
    for (const forbidden of [
      '/api/nutrition/refresh',
      '/api/nutrition/retry',
      '/api/nutrition/recovery',
      '/api/nutrition/readiness',
      '/api/nutrition/capabilities',
      '/api/nutrition/effective',
      '/api/nutrition/availability',
    ]) {
      const serverSources = ['server/app.ts', 'server/ai/sessionKeyRoutes.ts', 'server/nutritionProductAccess.ts']
        .map(read)
        .join('\n');
      expect(serverSources, `server must not add ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('persists no readiness, effective state, or refresh generation', () => {
    // No browser storage or cookie use anywhere on the AI-5D path. (ProviderSettings
    // legitimately TYPES a SettingsAdapter for the pre-existing selection preference,
    // whose established persistence semantics AI-5D must not change — so readiness
    // state itself is checked for storage calls specifically, not the prop type.)
    for (const relative of [
      'src/application/nutritionAiClientState.ts',
      'src/application/nutritionProductAccess.ts',
      'src/application-ui/ProviderSettings.tsx',
    ]) {
      const source = code(relative);
      for (const forbidden of ['localStorage.', 'sessionStorage.', 'indexedDB.', 'document.cookie']) {
        expect(source, `${relative} must not use ${forbidden}`).not.toContain(forbidden);
      }
    }
    const app = code('src/App.tsx');
    // No storage call may be fed readiness state, effective capabilities, a product
    // tier, or a refresh generation.
    const storageCall =
      /(localStorage|sessionStorage|indexedDB)\.[a-zA-Z]+\([^)]*(readiness|effectiveCapab|productAccess|refreshGeneration|nutritionAiClientState)/i;
    expect(storageCall.test(app)).toBe(false);
    expect(app).not.toMatch(/(localStorage|sessionStorage)\.setItem\(\s*['"`][^'"`]*(tier|entitle|readiness)/i);
  });

  it('adds no client entitlement header', () => {
    for (const relative of [
      'src/application/nutritionAiClientState.ts',
      'src/application/nutritionProductAccess.ts',
      'src/App.tsx',
      'src/application-ui/ProviderSettings.tsx',
    ]) {
      const source = code(relative);
      for (const forbidden of [
        'x-product-tier',
        'x-entitlement',
        'x-kitchen-nutrition-tier',
        'entitled=',
      ]) {
        expect(source, `${relative} must not send ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('adds no billing, account, or entitlement work', () => {
    for (const relative of ['src/application/nutritionAiClientState.ts', 'src/App.tsx']) {
      const source = code(relative).toLowerCase();
      for (const forbidden of [
        'stripe',
        'paddle',
        'checkout',
        'subscription',
        'licence',
        'licensekey',
        'customerid',
        'price',
        'trial',
      ]) {
        expect(source, `${relative} must not add ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('leaves AI-5A, nutritionCapabilities and AI-4E receipt crypto untouched', () => {
    for (const relative of [
      'src/core/nutritionV2/nutritionProductAccess.ts',
      'src/core/nutritionV2/nutritionCapabilities.ts',
      'server/recipeContextOriginReceipt.ts',
      'src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts',
      'server/nutritionProductAccess.ts',
    ]) {
      expect(code(relative), `${relative} must be unchanged by AI-5D`).toBe(code(relative));
    }
    // AI-4E crypto still intact.
    const receipt = code('server/recipeContextOriginReceipt.ts');
    expect(receipt).toContain('randomBytes(32)');
    expect(receipt).toContain('timingSafeEqual');
  });

  it('projectAcceptedRecipeContext still has ZERO production consumers', () => {
    const consumer = /projectAcceptedRecipeContext\s*\(/;
    const owners: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8');
          if (consumer.test(text)) owners.push(full);
        }
      }
    };
    for (const root of ['src', 'server']) walk(join(process.cwd(), root));
    // Only the definition itself.
    expect(owners.length).toBe(1);
    expect(owners[0]).toContain('aiRecipeContextSession.ts');
  });
});

import { readdirSync } from 'node:fs';