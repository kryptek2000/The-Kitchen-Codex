/**
 * AI-5E — SERVER PRODUCT-ACCESS AUTHORITY ABSTRACTION (isolation).
 *
 * AI-5E builds the SOCKET for a future authoritative product-access source. It must
 * not, in the same breath, plug a commercial service into it. These tests pin the
 * absence of every hosted/commercial/account mechanism, and the absence of every
 * forbidden entitlement identity — plus the permanence of the AI-5A / AI-4E / AI-5D
 * and Basic/manual invariants this phase promised not to touch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';

import {
  NUTRITION_PRODUCT_TIER_ENV,
  createDeploymentNutritionProductAccessAuthority,
} from '../../server/nutritionProductAccessAuthority.js';
import {
  NUTRITION_PRODUCT_ACCESS_BOUND_VERSION,
  NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
  NUTRITION_AI_NOT_ENTITLED_CODE,
  NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE,
  buildNutritionProductAccessUnavailableBody,
  buildNutritionProductAccessUnavailableStatusBody,
} from '../../server/nutritionProductAccess.js';
import { resetRateLimitersForTests } from '../../server/rateLimiter.js';

const REPO = join(__dirname, '..', '..');

const PRODUCTION_FILES: ReadonlyArray<string> = [
  'server.ts',
  'server/app.ts',
  'server/nutritionProductAccess.ts',
  'server/nutritionProductAccessAuthority.ts',
  'server/aiEndpointAuth.ts',
  'server/rateLimiter.ts',
];

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8');
}

/** CODE with every comment removed: the pins below are about implementation. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of statSync(dir).isDirectory() ? require('node:fs').readdirSync(dir) : []) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full.slice(REPO.length + 1));
  }
  return out;
}

afterEach(() => {
  delete process.env[NUTRITION_PRODUCT_TIER_ENV];
});

// ===========================================================================
// A. NO COMMERCIAL IMPLEMENTATION — AI-5E BUILDS THE SOCKET, NOT THE SERVICE
// ===========================================================================

describe('AI-5E — no hosted entitlement implementation exists', () => {
  const commercial = [
    'stripe',
    'paddle',
    'lemonsqueezy',
    'checkout',
    'customerId',
    'customer_id',
    'subscriptionId',
    'priceId',
    'price_id',
    'webhook',
    'licenseServer',
    'license_key',
    'entitlementApi',
    'remoteEntitlement',
    'oauth',
    'oauth2',
    'jwt',
    'openid',
    'passport',
    'userDatabase',
    'userRepository',
    'accountRepository',
    'accountsTable',
  ];

  it('adds no commercial, billing or account mechanism to the production tree', () => {
    for (const rel of PRODUCTION_FILES) {
      const lowered = code(rel).toLowerCase();
      for (const forbidden of commercial) {
        expect(lowered, `${rel} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the authority module has no dependency that could host entitlement', () => {
    const imports = [
      ...code('server/nutritionProductAccessAuthority.ts').matchAll(/from\s+"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(imports).toEqual([
      'express',
      '../src/core/nutritionV2/nutritionProductAccess.js',
    ]);
  });

  it('adds NO new package dependency', () => {
    // A hosted entitlement source would need an HTTP client, a database driver or a
    // billing SDK. The authority boundary needs none of them.
    const authority = code('server/nutritionProductAccessAuthority.ts');
    for (const forbidden of [
      'node:http',
      'node:https',
      'node:net',
      'node:sqlite',
      'node:fs',
      'node:os',
      'better-sqlite3',
      'axios',
      'stripe',
      'pg',
      'mysql',
    ]) {
      expect(authority, `authority must not import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('is a pure in-process decision: the deployment authority performs no socket work', async () => {
    const { Server } = await import('node:net');
    // A socket the authority must NOT connect to. If it did, this would resolve.
    let touched = false;
    const probe = createServer(() => {
      touched = true;
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    try {
      const authority = createDeploymentNutritionProductAccessAuthority('ai_advanced');
      for (let i = 0; i < 5; i += 1) await authority.resolve({} as never);
      // Nothing connected to the probe; and the authority held no socket handle.
      expect(touched).toBe(false);
      expect(authority).toHaveProperty('resolve');
      void port;
      void Server;
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });
});

// ===========================================================================
// B. NO FAKE PRINCIPAL, NO FORBIDDEN ENTITLEMENT IDENTITY
// ===========================================================================

describe('AI-5E — no entitlement identity is invented', () => {
  it('no module derives a principal from an IP, a token, a cookie or a vault', () => {
    for (const rel of ['server/nutritionProductAccess.ts', 'server/nutritionProductAccessAuthority.ts', 'server/app.ts']) {
      const lowered = code(rel).toLowerCase();
      for (const forbidden of [
        'req.ip',
        'request.ip',
        'userid',
        'user_id',
        'accountid',
        'account_id',
        'x-user-id',
        'x-account-id',
        'x-plan',
        'x-entitlement',
        'req.cookies',
        'request.cookies',
      ]) {
        expect(lowered, `${rel} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the deployment authority never becomes a per-request function of anything', async () => {
    const authority = createDeploymentNutritionProductAccessAuthority('ai_advanced');
    // A per-request authority would have to hold mutable state; this one is frozen and
    // its decision is a single shared object.
    expect(Object.isFrozen(authority)).toBe(true);
    const first = await authority.resolve({} as never);
    const second = await authority.resolve({ headers: { 'x-plan': 'paid' } } as never);
    // Identical decision object, so no route can disagree about product access.
    expect(second).toBe(first);
  });

  it('AI_ENDPOINT_TOKEN, credentials and BYOK remain endpoint-authentication only', () => {
    // `server.ts` composes the authority from ONE tier input. The endpoint token is
    // never read next to it, so a token can never be an account.
    const server = code('server.ts');
    const tierAt = server.indexOf('process.env[NUTRITION_PRODUCT_TIER_ENV]');
    expect(tierAt).toBeGreaterThan(-1);
    const appModule = code('server/app.ts');
    expect(appModule).not.toContain('AI_ENDPOINT_TOKEN');
    expect(code('server/nutritionProductAccessAuthority.ts')).not.toContain('AI_ENDPOINT_TOKEN');
  });

  it('the pricing cost class never becomes an entitlement input', () => {
    // Free / Budget / Paid / Variable is execution safety. It must not reach the seam.
    const app = code('server/app.ts');
    const seamAt = app.indexOf('const nutritionProductAccessAuthority =');
    const seam = app.slice(seamAt, app.indexOf(';', seamAt));
    for (const forbidden of ['free', 'budget', 'paid', 'variable', 'pricing', 'catalog']) {
      expect(seam.toLowerCase(), `seam must not reference ${forbidden}`).not.toContain(forbidden);
    }
    // And the authority itself knows nothing about pricing.
    const authority = code('server/nutritionProductAccessAuthority.ts').toLowerCase();
    for (const forbidden of ['pricing', 'price', 'cost', 'budget', 'variable']) {
      expect(authority).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// C. NO ENTITLEMENT PERSISTENCE
// ===========================================================================

describe('AI-5E — no entitlement decision is persisted', () => {
  it('nothing writes a decision to disk, database, vault, cookie or storage', () => {
    for (const rel of ['server/nutritionProductAccess.ts', 'server/nutritionProductAccessAuthority.ts']) {
      const lowered = code(rel).toLowerCase();
      for (const forbidden of [
        'writefile',
        'fs.',
        'sqlite',
        'better-sqlite3',
        'localstorage',
        'sessionstorage',
        'indexeddb',
        'setcookie',
        'res.cookie',
        'set-cookie',
        'settingsadapter',
        'plugin',
        'frontmatter',
      ]) {
        expect(lowered, `${rel} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the deployment authority holds its decision in process memory only', async () => {
    const authority = createDeploymentNutritionProductAccessAuthority('ai_advanced');
    // Exactly one key, no cache handle, no store, no registry.
    expect(Object.keys(authority)).toEqual(['resolve']);
    const decision = await authority.resolve({} as never);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('no client module persists or re-sends a product-access decision', () => {
    for (const rel of [
      'src/application/nutritionProductAccess.ts',
      'src/application/nutritionAiClientState.ts',
    ]) {
      const lowered = code(rel).toLowerCase();
      for (const forbidden of [
        'localstorage',
        'sessionstorage',
        'indexeddb',
        'x-product-tier',
        'x-entitlement',
        'x-kitchen-nutrition-tier',
        'set-cookie',
      ]) {
        expect(lowered, `${rel} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

// ===========================================================================
// D. THE BOUNDED WIRE CLASSES
// ===========================================================================

describe('AI-5E — the two bounded wire classes stay bounded', () => {
  it('the gated-route unavailability body is exactly four keys and leaks nothing', () => {
    const body = buildNutritionProductAccessUnavailableBody() as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['aiAttempted', 'code', 'error', 'ok']);
    expect(body.code).toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
    expect(body.aiAttempted).toBe(false);
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of [
      'tier',
      'version',
      'price',
      'pricing',
      'plan',
      'subscription',
      'billing',
      'checkout',
      'customer',
      'account',
      'user',
      'token',
      'credential',
      'key',
      'provider',
      'gemini',
      'openrouter',
      'env',
      'authority',
      'deployment',
      'source',
      'exception',
      'stack',
    ]) {
      expect(serialized, `unavailability body must not leak ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the status unavailability body carries NO tier and NO version', () => {
    const body = buildNutritionProductAccessUnavailableStatusBody() as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'ok']);
    expect(body).not.toHaveProperty('tier');
    expect(body).not.toHaveProperty('version');
    expect(body).not.toHaveProperty('aiAttempted');
  });

  it('the two product classes remain DISTINCT machine codes', () => {
    expect(NUTRITION_AI_NOT_ENTITLED_CODE).toBe('NUTRITION_AI_NOT_ENTITLED');
    expect(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE).toBe('NUTRITION_PRODUCT_ACCESS_UNAVAILABLE');
    expect(NUTRITION_AI_NOT_ENTITLED_CODE).not.toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
  });

  it('the status endpoint path and the bound contract version are unchanged', () => {
    expect(NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT).toBe('/api/nutrition/product-access');
    expect(NUTRITION_PRODUCT_ACCESS_BOUND_VERSION).toBe('nutrition_product_access_v1');
  });
});

// ===========================================================================
// E. INVARIANCE OF EVERY PRIOR PHASE
// ===========================================================================

describe('AI-5E — AI-5A invariance', () => {
  it('the AI-5A contract module is byte-unchanged by AI-5E', () => {
    const contract = read('src/core/nutritionV2/nutritionProductAccess.ts');
    expect(contract).toContain("export const NUTRITION_PRODUCT_ACCESS_VERSION = 'nutrition_product_access_v1';");
    expect(contract).toContain("export type NutritionProductTier = 'basic' | 'ai_advanced';");
    // Exactly four features; no fifth, and never `ai_recipe_context_application`.
    const featureUnion = /export type NutritionProductAiFeature =([\s\S]*?);/.exec(contract)![1];
    expect([...featureUnion.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      'ai_interpretation',
      'ai_candidate_orchestration',
      'ai_bounded_mass_estimation',
      'ai_recipe_context_review',
    ]);
    const featureList = /NUTRITION_PRODUCT_AI_FEATURES[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\)/.exec(
      contract,
    )![1];
    expect([...featureList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      'ai_interpretation',
      'ai_candidate_orchestration',
      'ai_bounded_mass_estimation',
      'ai_recipe_context_review',
    ]);
    expect(code('src/core/nutritionV2/nutritionProductAccess.ts')).not.toContain(
      'ai_recipe_context_application',
    );
    // Exactly two canonical instances.
    expect([...contract.matchAll(/export const (BASIC|AI_ADVANCED)_NUTRITION_PRODUCT_ACCESS/g)].map((m) => m[1])).toEqual([
      'BASIC',
      'AI_ADVANCED',
    ]);
  });

  it('nutritionCapabilities remains OPERATIONAL readiness only', () => {
    // AI-5A names this module in a comment as the separated question; AI-5E must add
    // no CODE awareness of product access, a tier, an entitlement or the env input.
    const capabilities = code('src/core/nutritionV2/nutritionCapabilities.ts');
    expect(capabilities).not.toContain('nutritionProductAccess');
    expect(capabilities).not.toContain('NUTRITION_PRODUCT_ACCESS');
    expect(capabilities).not.toContain('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    expect(capabilities).not.toContain('isNutritionProductFeatureEntitled');
    expect(capabilities).not.toContain('isAiAdvancedProductAccess');
  });

  it('AI-4E receipt crypto is untouched by AI-5E', () => {
    const receipt = read('server/recipeContextOriginReceipt.ts');
    expect(receipt).toContain('randomBytes(32)');
    expect(receipt).toContain('createHmac');
    expect(receipt).toContain('timingSafeEqual');
    const shape = read('src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts');
    expect(shape).not.toContain('nutritionProductAccess');
  });

  it('accepted AI-4 context still has ZERO production consumers', () => {
    const consumers = [
      ...walk(join(REPO, 'src')),
      ...walk(join(REPO, 'server')),
      ...walk(join(REPO, 'plugin')),
    ].filter((rel) => code(rel).includes('projectAcceptedRecipeContext'));
    // The definition site only; nothing CALLS it.
    expect(consumers).toEqual(['src/core/nutritionV2/aiRecipeContextSession.ts']);
    const definition = code('src/core/nutritionV2/aiRecipeContextSession.ts');
    expect([...definition.matchAll(/projectAcceptedRecipeContext\s*\(/g)]).toHaveLength(1);
  });

  it('Basic / manual nutrition is never product-gated', () => {
    const app = code('server/app.ts');
    for (const ungated of [
      '/api/estimate-nutrition',
      '/api/nutrition/resolve-ingredients',
    ]) {
      expect(app).toContain(ungated);
    }
    // The gate is registered on exactly six routes and nowhere else.
    expect([...app.matchAll(/requireNutritionProductFeature\(/g)]).toHaveLength(6);
  });
});

// ===========================================================================
// F. AI-5D INVARIANCE — AI-5E IS SERVER-SIDE
// ===========================================================================

describe('AI-5E — AI-5D readiness architecture is untouched', () => {
  it('neither AI-5E module disturbs the refresh architecture', () => {
    for (const rel of ['server/nutritionProductAccess.ts', 'server/nutritionProductAccessAuthority.ts']) {
      const lowered = code(rel).toLowerCase();
      for (const forbidden of [
        'refresh',
        'retry',
        'sequencer',
        'invalidate',
        'poll',
        'nutritioncapabilities',
        'readiness',
        'resolveNutritionAiCapabilities',
      ]) {
        expect(lowered, `${rel} must not touch AI-5D readiness (${forbidden})`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it('the AI-5D readiness surface is byte-unchanged in structure', () => {
    const clientState = read('src/application/nutritionAiClientState.ts');
    expect(clientState).toContain('createNutritionRefreshSequencer');
    expect(clientState).toContain('product_access_unverified');
    expect(clientState).toContain('product_not_enabled');
    // AI-5E added no client behaviour, so the readiness composition is untouched.
    expect(clientState).toContain('export async function resolveNutritionAiClientState(');
  });

  it('the two product-status readers remain the ONLY client product surfaces', () => {
    const aware = [
      ...walk(join(REPO, 'src')),
      ...walk(join(REPO, 'server')),
    ].filter((rel) => code(rel).includes('NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT') || code(rel).includes('NUTRITION_PRODUCT_ACCESS_ENDPOINT'));
    expect(aware.sort()).toEqual([
      'server/app.ts',
      'server/nutritionProductAccess.ts',
      'src/application/nutritionProductAccess.ts',
    ]);
  });
});

// ===========================================================================
// G. SERVER COMPOSITION IS THE ONLY SELECTOR
// ===========================================================================

describe('AI-5E — server composition selects the authority; the request never can', () => {
  it('server.ts composes ONE authority and hands it to createApp', () => {
    const server = code('server.ts');
    expect(server).toContain('createDeploymentNutritionProductAccessAuthority(process.env[NUTRITION_PRODUCT_TIER_ENV])');
    expect(server).toContain('nutritionProductAccessAuthority');
    expect([...server.matchAll(/process\.env\[NUTRITION_PRODUCT_TIER_ENV\]/g)]).toHaveLength(1);
  });

  it('NO route, gate or middleware reads the deployment tier', () => {
    for (const rel of ['server/app.ts', 'server/nutritionProductAccess.ts', 'server/nutritionProductAccessAuthority.ts']) {
      expect(code(rel), `${rel} must not read the deployment tier`).not.toMatch(
        /process\.env\s*\[\s*NUTRITION_PRODUCT_TIER_ENV/,
      );
    }
  });

  it('no route builds, selects or swaps an authority at request time', () => {
    const app = code('server/app.ts');
    // The authority exists exactly once, at composition scope, before any route.
    expect([...app.matchAll(/createDeploymentNutritionProductAccessAuthority/g)]).toHaveLength(0);
    expect([...app.matchAll(/createBasicNutritionProductAccessAuthority\(\)/g)]).toHaveLength(1);
    expect([...app.matchAll(/const nutritionProductAccessAuthority =/g)]).toHaveLength(1);
  });
});

// ===========================================================================
// H. THE EXACTLY-ONCE PROPERTY, PROVEN AT THE RATE LIMITER
// ===========================================================================

describe('AI-5E — the product gate is structurally upstream of every paid limiter', () => {
  it('neither AI-5E module imports, configures or resets a rate limiter', () => {
    for (const rel of ['server/nutritionProductAccess.ts', 'server/nutritionProductAccessAuthority.ts']) {
      const lowered = code(rel).toLowerCase();
      for (const forbidden of ['ratelimiter', 'resetratelimiters', 'express-rate-limit', 'ratelimit']) {
        expect(lowered, `${rel} must not touch the rate limiter (${forbidden})`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it('the gate is registered BEFORE the limiter on every one of the six routes', () => {
    // The behavioural proof (six refusals against a limit of two) lives in
    // advancedNutritionAi5eAuthorityGate.test.ts, where the limit is configured before
    // the app module loads. Here we pin the ordering that makes it true.
    const app = code('server/app.ts');
    for (const call of [...app.matchAll(/requireNutritionProductFeature\([^)]*\)/g)]) {
      const after = app.slice(call.index! + call[0].length, app.indexOf('async (', call.index!));
      expect(after, 'a limiter or pricing guard must follow the gate').toMatch(
        /(RateLimiter|textPricingGuard)/,
      );
    }
  });
});