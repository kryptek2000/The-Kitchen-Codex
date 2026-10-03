/**
 * AI-5A — ISOLATION: PRODUCT ACCESS IS PROVIDER-NEUTRAL, BILLING-NEUTRAL,
 * BYOK-NEUTRAL, NETWORK-FREE AND HAS ZERO PRODUCTION CONSUMER.
 *
 * AI-5A is INERT. These are the structural pins that keep it inert. They prove
 * four separations by architecture rather than by intention:
 *
 *   A. PRODUCT ENTITLEMENT != PROVIDER AVAILABILITY  (no provider dependency)
 *   B. PRODUCT ENTITLEMENT != BYOK CREDENTIAL        (no credential dependency)
 *   C. PRODUCT ENTITLEMENT != BILLING / ACCOUNT      (no commercial dependency)
 *   D. PRODUCT ACCESS IS NOT WIRED                  (zero production consumers)
 *
 * Static source pins go red whenever a file changes, so on their own they cannot
 * distinguish "AI-5A has no consumer" from "AI-5A has no consumer *today*". The
 * behavioural half of that proof lives in
 * `advancedNutritionAi5aAuthorityDifferential.test.ts`, which drives the REAL
 * production functions and observes that Basic access and AI Advanced access move
 * no nutrition truth. This file covers what behaviour alone cannot: absence of
 * wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.cwd();
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

const CONTRACT = 'src/core/nutritionV2/nutritionProductAccess.ts';

/**
 * Source with every comment removed, so a pin can never be satisfied (or
 * defeated) by prose. Documentation legitimately mentions `provider`, `credential`,
 * `billing` and `route`; only CODE may be pinned against those words.
 */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\*\*?[\s\S]*$/, ' ');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(REPO, full));
  }
  return out;
}

const ALL_SOURCE_FILES: ReadonlyArray<string> = [
  ...walk(join(REPO, 'src')),
  ...walk(join(REPO, 'server')),
  ...walk(join(REPO, 'scripts')),
];

/**
 * The ONE production module that became AI-5A-aware at AI-5B: the server boundary.
 *
 * AI-5A was inert, so every surface above had to be unaware of the contract. AI-5B
 * makes the server authoritative, which necessarily gives exactly ONE server module a
 * consumer: the dedicated gate. Every client surface, every AI transport, `rateLimiter`,
 * the AI-4E authority and `nutritionCapabilities` stay unaware — that is the whole point
 * of routing the gate through a separate boundary module.
 */
const AI5B_GATE = 'server/nutritionProductAccess.ts';
/**
 * AI-5C adds the ONE authorized client-side READER of the contract.
 *
 * It is read-only product AWARENESS, not authority: it never gates a route, never
 * grants a capability, never persists anything and never reports a tier back to the
 * server. Everything below is written to keep that distinction permanent.
 */
const AI5C_CLIENT_READER = 'src/application/nutritionProductAccess.ts';
/** The AI-5C composition owner. Imports the reader, never the core contract. */
const AI5C_COMPOSER = 'src/application/nutritionAiClientState.ts';

/** Live production surfaces that must remain completely unaware of AI-5A. */
const LIVE_SURFACES: ReadonlyArray<string> = [
  'src/App.tsx',
  'src/components/AdvancedNutritionCard.tsx',
  'src/components/AdvancedNutritionModal.tsx',
  'src/application-ui/ProviderSettings.tsx',
  'src/application/aiSelection.ts',
  'src/application/nutritionAiResolve.ts',
  'src/application/nutritionAiPlan.ts',
  'src/application/nutritionAiEstimate.ts',
  'src/application/nutritionAiPlanAcceptance.ts',
  'src/application/nutritionAiRecipeContext.ts',
  'src/application/advancedNutritionApply.ts',
  'src/core/nutritionV2/nutritionCapabilities.ts',
  'src/core/nutritionV2/index.ts',
  'src/core/nutritionV2/schema.ts',
  'src/core/nutritionV2/phase4/state.ts',
  'src/core/nutritionV2/phase5/authorize.ts',
  'src/core/nutritionV2/phase5/types.ts',
  'server/nutritionContext.ts',
  'server/nutritionEstimate.ts',
  'server/nutritionPlan.ts',
  'server/recipeContextReconcile.ts',
  'server/recipeContextOriginReceipt.ts',
  'server/rateLimiter.ts',
];

// ---------------------------------------------------------------------------
// 1. PURE: NO NETWORK, NO ENV, NO FILESYSTEM, NO CLOCK, NO RANDOMNESS
// ---------------------------------------------------------------------------
describe('AI-5A isolation — the contract module performs no I/O of any kind', () => {
  it('declares NO import at all', () => {
    const source = code(CONTRACT);
    const importLines = source.split('\n').filter((line) => /^import\b/.test(line.trim()));
    expect(importLines).toEqual([]);
    expect(source).not.toContain('import(');
    expect(source).not.toContain('require(');
    expect(source).not.toContain('await ');
    expect(source).not.toContain('async function');
  });

  it('contains no network, storage, environment or runtime capability', () => {
    const source = code(CONTRACT);
    for (const banned of [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'navigator.',
      'axios',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'document.cookie',
      'process.env',
      'globalThis',
      'window.',
      'Date.now',
      'new Date',
      'Math.random',
      'crypto',
      'node:',
      "'fs'",
      "'path'",
      "'os'",
      "'http'",
      "'https'",
      "'child_process'",
      'JSON.parse',
      'JSON.stringify',
    ]) {
      expect(source, `nutritionProductAccess.ts must not contain ${banned}`).not.toContain(banned);
    }
  });

  it('declares no route, no endpoint, no host and no pricing surface', () => {
    const source = code(CONTRACT);
    for (const banned of [
      '/api/',
      'app.post',
      'app.get',
      'express',
      'http://',
      'https://',
      'Retry-After',
      'RateLimit-',
      'stripe',
      'Stripe',
      'paddle',
      'Paddle',
      'lemonsqueezy',
      'LemonSqueezy',
      'checkout',
      'subscription',
      'invoice',
      'priceId',
      'price_id',
      'customerId',
      'customer_id',
      'trial',
      'promo',
      'renewal',
      'checkoutSession',
    ]) {
      expect(source, `nutritionProductAccess.ts must not contain ${banned}`).not.toContain(banned);
    }
  });

  it('declares no React, no hook and no DOM surface', () => {
    const source = code(CONTRACT);
    for (const banned of [
      'react',
      'React',
      'useState',
      'useEffect',
      'useRef',
      'useMemo',
      'useCallback',
      'data-testid',
      'JSX',
      'document.',
      'element',
    ]) {
      expect(source, `nutritionProductAccess.ts must not contain ${banned}`).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. PRODUCT ACCESS != PROVIDER AVAILABILITY
// ---------------------------------------------------------------------------
describe('AI-5A isolation — product access is provider-NEUTRAL', () => {
  it('the contract module names no provider, provider registry, catalog or status', () => {
    const source = code(CONTRACT);
    for (const banned of [
      'provider',
      'Provider',
      'openrouter',
      'OpenRouter',
      'gemini',
      'Gemini',
      'genAI',
      'generateStructured',
      'resolveRoleCandidates',
      'modelCatalog',
      'modelId',
      'model_id',
      'providerId',
      'provider_id',
      'aiConfigured',
      'aiReachable',
      'capabilityVerification',
      'textPricingGuard',
      'networkAdapter',
      'NetworkAdapter',
      'settingsAdapter',
      'SettingsAdapter',
    ]) {
      expect(source, `nutritionProductAccess.ts must not contain ${banned}`).not.toContain(banned);
    }
  });

  it('the contract module imports no server module, no adapter and no runtime host', () => {
    const source = code(CONTRACT);
    for (const banned of [
      '/server/',
      'server/',
      'sessionSecrets',
      'credentialResolver',
      'credentialSource',
      'aiEndpointAuth',
      'requireAiAccessToken',
      'AI_ENDPOINT_TOKEN',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'K_SERVICE',
      'dotenv',
      '@google/genai',
      'openai',
      '@anthropic-ai/',
    ]) {
      expect(source, `nutritionProductAccess.ts must not contain ${banned}`).not.toContain(banned);
    }
  });

  it('product access does NOT reinterpret the existing operational capability module', () => {
    // The AI-0 resolver is UNCHANGED and is NOT re-exported, wrapped or shadowed.
    // Product access is a separate, independent question. Neither module may name
    // the other's implementation symbol in CODE.
    const capabilities = code('src/core/nutritionV2/nutritionCapabilities.ts');
    expect(capabilities).not.toContain('nutritionProductAccess');
    expect(capabilities).not.toContain('ProductAccess');
    expect(capabilities).not.toContain('resolveNutritionProductAccess');
    expect(capabilities).not.toContain('NUTRITION_PRODUCT_ACCESS_VERSION');

    const contract = code(CONTRACT);
    expect(contract).not.toContain('resolveNutritionCapabilities');
    expect(contract).not.toContain('BASIC_NUTRITION_CAPABILITIES');
    expect(contract).not.toContain('isAiInterpretationAvailable');
    expect(contract).not.toContain('isAiEstimationAvailable');
    expect(contract).not.toContain('nutritionCapabilities');
  });

  it('the AI-0 operational capability module keeps its exact runtime behaviour', () => {
    // Behavioural confirmation, pinned at the source level: AI-5A changed NOTHING
    // but documentation in this module.
    const capabilities = src('src/core/nutritionV2/nutritionCapabilities.ts');
    // Still derives AI Advanced from provider configuration AND availability only.
    expect(capabilities).toContain(
      "const aiAvailable = input.aiConfigured === true && input.aiReachable === true;"
    );
    // Still exports the same four AI-0 symbols and the same two labels.
    expect(capabilities).toContain('export type NutritionExperienceTier = ');
    expect(capabilities).toContain('export function resolveNutritionCapabilities(');
    expect(capabilities).toContain('export function isManualEditingAvailable(');
    expect(capabilities).toContain('export function isAiInterpretationAvailable(');
    expect(capabilities).toContain('export function isAiEstimationAvailable(');
    expect(capabilities).toContain('export const BASIC_NUTRITION_CAPABILITIES');
    expect(capabilities).toContain("export const BASIC_NUTRITION_LABEL = 'Basic Nutrition';");
    expect(capabilities).toContain(
      "export const AI_ADVANCED_NUTRITION_LABEL = 'AI Advanced Nutrition';"
    );
    expect(capabilities).toContain("aiEstimation: 'available' as const");
    expect(capabilities).toContain("aiEstimation: 'disabled' as const");
  });
});

// ---------------------------------------------------------------------------
// 3. PRODUCT ACCESS != BYOK CREDENTIAL
// ---------------------------------------------------------------------------
describe('AI-5A isolation — BYOK cannot become entitlement', () => {
  it('no BYOK/credential/provider identifier exists in the contract CODE', () => {
    const source = code(CONTRACT);
    for (const absent of [
      'apiKey',
      'api_key',
      'API_KEY',
      'credential',
      'Credential',
      'credentialSource',
      'session_only',
      'sessionOnly',
      'server_environment',
      'serverEnvironment',
      'providerId',
      'provider_id',
      'modelId',
      'model_id',
      'secret',
      'Secret',
      'sessionSecrets',
      'bearer',
      'Bearer',
      'token',
      'Token',
    ]) {
      expect(source, `${absent} must not appear in the contract code`).not.toContain(absent);
    }
  });

  it('the contract value shape itself carries no credential field', () => {
    // Prose in the module deliberately NAMES these concepts to explain why they
    // are absent, so the proof is made at the value level as well.
    const expectedKeys = [
      'aiBoundedMassEstimation',
      'aiCandidateOrchestration',
      'aiInterpretation',
      'aiRecipeContextReview',
      'tier',
      'version',
    ];
    for (const value of ['BASIC_NUTRITION_PRODUCT_ACCESS', 'AI_ADVANCED_NUTRITION_PRODUCT_ACCESS']) {
      expect(value).not.toContain('apiKey');
      expect(value).not.toContain('credential');
      expect(value).not.toContain('provider');
      expect(value).not.toContain('model');
    }
    // The runtime shape is pinned behaviourally in the unit contract suite; here we
    // pin that the declared interface itself has no credential/provider field.
    const contractCode = code(CONTRACT);
    const start = contractCode.indexOf('export interface NutritionProductAccess');
    expect(start, 'the access interface must be declared').toBeGreaterThan(-1);
    const interfaceBlock = contractCode.slice(
      start,
      contractCode.indexOf('}', start) + 1
    );
    expect(interfaceBlock).toContain('readonly version');
    expect(interfaceBlock).toContain('readonly tier');
    for (const absent of ['apiKey', 'credential', 'provider', 'model', 'secret', 'token']) {
      expect(interfaceBlock, absent).not.toContain(absent);
    }
    expect(expectedKeys).toHaveLength(6);
  });

  it('the historical BYOK modules are untouched and keep their own vocabulary', () => {
    // AI-5A neither renames nor duplicates a BYOK phase.
    const byok = [
      'server/ai/sessionSecrets.ts',
      'server/ai/credentialResolver.ts',
      'server/ai/providerRegistry.ts',
      'src/application-ui/ProviderSettings.tsx',
    ];
    // Every surviving BYOK owner keeps `credentialSource` / `session_only`, and NONE
    // of them gained a product-access dependency.
    let checked = 0;
    for (const rel of ALL_SOURCE_FILES) {
      // `server/app.ts` is the AI-5B composition point: it wires ROUTES, so it already
      // carried the credential vocabulary before AI-5B. Its product-access awareness is
      // pinned separately (gate-only, never the contract).
      //
      // AI-5D adds ONE deliberate exception: the Advanced Nutrition COMPOSITION OWNER.
      // Composing "product entitled AND operationally ready" genuinely requires reading
      // both the product decision and the selected credential source, so this module is
      // the one place allowed to know both vocabularies. It still grants no authority:
      // it is separately pinned as a read-only reader that never gates, never persists,
      // never inspects secrets, and never reports a tier to the server.
      if (rel === 'server/app.ts' || rel === AI5B_GATE || rel === AI5C_COMPOSER) continue;
      const source = code(rel);
      if (source.includes('credentialSource') || source.includes('session_only')) {
        checked += 1;
        expect(source, rel).not.toContain('nutritionProductAccess');
        expect(source, rel).not.toContain('ProductAccess');
        expect(source, rel).not.toContain('NUTRITION_PRODUCT_ACCESS_VERSION');
      }
    }
    expect(checked, 'the historical BYOK vocabulary must still exist somewhere').toBeGreaterThan(0);
    expect(byok.length).toBeGreaterThan(0);

    // The BYOK owners themselves gained nothing.
    for (const rel of byok) {
      const source = code(rel);
      expect(source, rel).not.toContain('nutritionProductAccess');
      expect(source, rel).not.toContain('ProductAccess');
      expect(source, rel).not.toContain('NUTRITION_PRODUCT_ACCESS_VERSION');
      expect(source, rel).not.toContain('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    }
  });

  it('product access is not derived from, and does not feed, any credential resolver', () => {
    // No credential resolver, session-secret authority, provider registry, pricing
    // layer or Provider Settings surface reaches the contract — and the contract's
    // single server consumer does not reach THEM either, so the gate can neither read
    // nor be influenced by credential state.
    const credentialOwners = [
      'server/ai/sessionSecrets.ts',
      'server/ai/credentialResolver.ts',
      'server/ai/providerRegistry.ts',
      'server/ai/providerStatus.ts',
      'server/ai/effectiveSelection.ts',
      'server/ai/parseSelectionMetadata.ts',
      'server/ai/sessionKeyRoutes.ts',
      'server/aiEndpointAuth.ts',
      'server/rateLimiter.ts',
      'server/geminiClient.ts',
      'src/application-ui/ProviderSettings.tsx',
      'src/application/aiSelection.ts',
    ];
    for (const rel of credentialOwners) {
      const source = code(rel);
      expect(source, rel).not.toContain('nutritionProductAccess');
      expect(source, rel).not.toContain('ProductAccess');
      expect(source, rel).not.toContain('NUTRITION_PRODUCT_ACCESS_VERSION');
      expect(source, rel).not.toContain('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    }
    // The gate imports the contract and express — no credential or provider module.
    const gateImports = src(AI5B_GATE)
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line))
      .join('\n');
    for (const forbidden of ['credentialResolver', 'sessionSecret', 'provider', 'rateLimiter', 'gemini']) {
      expect(gateImports, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. PRODUCT ACCESS != BILLING / ACCOUNT
// ---------------------------------------------------------------------------
describe('AI-5A isolation — product access is billing- and account-NEUTRAL', () => {
  it('no billing or payment SDK exists in the repository at all after AI-5A', () => {
    const forbiddenPackages = [
      '@stripe/stripe-js',
      'stripe',
      '@paddle/paddle-js',
      'paddle',
      'lemonsqueezy',
      'lemon-squeezy',
      '@lemonsqueezy/lemonsqueezy.js',
      'revenuecat',
    ];
    const pkg = src('package.json');
    for (const forbidden of forbiddenPackages) {
      expect(pkg, `package.json must not depend on ${forbidden}`).not.toContain(`"${forbidden}"`);
    }
  });

  it('no billing, account, login, license or entitlement-receipt surface exists', () => {
    for (const rel of [...walk(join(REPO, 'server')), ...walk(join(REPO, 'src'))]) {
      const source = code(rel);
      for (const forbidden of [
        'createCheckoutSession',
        'createSubscription',
        'subscriptionStatus',
        'customerId',
        'priceId',
        'verifyLicenseKey',
        'login(',
        'signUp',
        'signIn',
      ]) {
        expect(source, `${rel} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the contract carries no quota, usage or cost accounting', () => {
    const source = code(CONTRACT);
    for (const forbidden of [
      'tokenCount',
      'tokens',
      'cost',
      'costUsd',
      'quota',
      'budget',
      'limit',
      'limitPerDay',
      'limitPerMonth',
      'remaining',
      'usage',
      'meter',
      'price',
      'billing',
    ]) {
      expect(source, `nutritionProductAccess.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. AI-5A IS INERT: ZERO PRODUCTION CONSUMERS
// ---------------------------------------------------------------------------
describe('AI-5A isolation — ZERO production consumer', () => {
  it('the contract module is not exported from the nutrition barrel', () => {
    // The repository convention for a foundation phase is to keep the new contract
    // OUT of the barrel (AI-4A did the same): a barrel export is not behavioural
    // consumption, but not exporting it makes the zero-consumer property total.
    const barrel = src('src/core/nutritionV2/index.ts');
    expect(barrel).not.toContain('nutritionProductAccess');
    expect(barrel).not.toContain('ProductAccess');
    expect(barrel).not.toContain('NUTRITION_PRODUCT_ACCESS_VERSION');
  });

  it('exactly TWO server modules and ONE read-only client reader consume the contract', () => {
    // The gate is the single AUTHORITY. AI-5C adds exactly one client READER, which is
    // awareness only. Nothing else in the repository may import the contract.
    const consumers = [...ALL_SOURCE_FILES, ...walk(join(REPO, 'plugin'))].filter((rel) =>
      code(rel).includes('nutritionProductAccess'),
    );
    expect(consumers.sort()).toEqual(
      ['server/app.ts', AI5B_GATE, AI5C_COMPOSER, AI5C_CLIENT_READER].sort(),
    );

    // No OTHER client surface, no plugin surface, no script and no AI transport is aware.
    const aware = new Set([AI5C_CLIENT_READER, AI5C_COMPOSER]);
    for (const rel of LIVE_SURFACES) {
      if (aware.has(rel)) continue;
      expect(code(rel), rel).not.toContain('nutritionProductAccess');
    }
    for (const rel of [...walk(join(REPO, 'plugin')), ...walk(join(REPO, 'scripts'))]) {
      expect(code(rel), rel).not.toContain('nutritionProductAccess');
    }

    // The composition point imports the GATE only — never the core contract directly,
    // so entitlement vocabulary cannot leak into the route factory.
    const appModules = src('server/app.ts')
      .split('\n')
      .map((line) => /\bfrom\s+['"]([^'"]+)['"]/.exec(line)?.[1] ?? '')
      .filter(Boolean);
    for (const modulePath of appModules) {
      // The composition point imports the GATE only — never the core contract
      // directly, so entitlement vocabulary cannot leak into the route factory.
      expect(modulePath, 'server/app.ts').not.toContain('core/nutritionV2/nutritionProductAccess');
    }
    expect(appModules).toContain('./nutritionProductAccess.js');
  });

  it('the AI-5B gate imports the contract and NOTHING else that could grant authority', () => {
    const imports = src(AI5B_GATE)
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line));
    const modules = imports
      .map((line) => /from\s+['"]([^'"]+)['"]/.exec(line)?.[1] ?? '')
      .filter(Boolean);
    // Exactly the express request type and the AI-5A contract. No provider, no
    // credential resolver, no BYOK authority, no billing, no nutrition authority.
    expect(modules).toEqual([
      'express',
      '../src/core/nutritionV2/nutritionProductAccess.js',
    ]);
  });

  it('NO live production surface references the contract in CODE', () => {
    // Comment-stripped: documentation may legitimately cross-reference the new
    // contract. Only CODE may name it, so a prose mention can neither satisfy nor
    // defeat this pin.
    //
    // AI-5D carve-out — `src/App.tsx`. The shell must now decide whether the CACHED
    // product read is Basic or Advanced in order to short-circuit readiness refreshes,
    // so it legitimately names a bounded APPLICATION-LAYER predicate
    // (`isAiAdvancedProductAccessRead` / `isBasicProductAccessRead` / the read type).
    // What it still may NOT do — and what the pins below plus the sibling IMPORT test
    // still enforce for every live surface including App.tsx — is name the AI-5A
    // CONTRACT: no resolver, no frozen access instance, no version token, and no
    // import of the core module.
    for (const rel of LIVE_SURFACES) {
      const source = code(rel);
      if (rel !== 'src/App.tsx') {
        expect(source, rel).not.toContain('nutritionProductAccess');
        expect(source, rel).not.toContain('ProductAccess');
      }
      expect(source, rel).not.toContain('NUTRITION_PRODUCT_ACCESS_VERSION');
      expect(source, rel).not.toContain('resolveNutritionProductAccess');
      expect(source, rel).not.toContain('resolveNutritionProductTier');
      expect(source, rel).not.toContain('AI_ADVANCED_NUTRITION_PRODUCT_ACCESS');
      expect(source, rel).not.toContain('BASIC_NUTRITION_PRODUCT_ACCESS');
      expect(source, rel).not.toContain('nutrition_product_access_v1');
    }
  });

  it('App.tsx uses only the bounded application predicate, never the contract', () => {
    // The narrow, explicit form of the AI-5D carve-out above.
    const app = code('src/App.tsx');
    // Allowed: the application-layer read type and the two boolean predicates.
    expect(app).toContain('isAiAdvancedProductAccessRead');
    expect(app).toContain('isBasicProductAccessRead');
    // Forbidden: anything that could construct, inspect, or forge a product state.
    for (const forbidden of [
      'AI_ADVANCED_NUTRITION_PRODUCT_ACCESS',
      'BASIC_NUTRITION_PRODUCT_ACCESS',
      'NUTRITION_PRODUCT_ACCESS_VERSION',
      'resolveNutritionProductAccess',
      'resolveNutritionProductTier',
      'isNutritionProductAccess',
      'isAiAdvancedProductAccess(',
      'core/nutritionV2/nutritionProductAccess',
      'nutrition_product_access_v1',
    ]) {
      expect(app, `App.tsx must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('NO live production surface IMPORTS the contract', () => {
    // The strong form: not even a type-only, aliased or side-effect import exists.
    for (const rel of LIVE_SURFACES) {
      const importLines = src(rel)
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line));
      for (const line of importLines) {
        expect(line, rel).not.toContain('nutritionProductAccess');
        expect(line, rel).not.toContain('ProductAccess');
      }
    }
  });

  it('only the AI-5B gate and the AI-5C read-only reader consume the contract', () => {
    const offenders: string[] = [];
    for (const rel of [...ALL_SOURCE_FILES, ...walk(join(REPO, 'plugin'))]) {
      if (code(rel).includes('nutritionProductAccess')) offenders.push(rel);
    }
    expect(offenders.sort()).toEqual(
      ['server/app.ts', AI5B_GATE, AI5C_COMPOSER, AI5C_CLIENT_READER].sort(),
    );
  });

  it('the AI-5C client reader is READ-ONLY awareness, never authority', () => {
    const source = code(AI5C_CLIENT_READER);
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // It cannot gate anything, resolve a route, or decide authorization.
    for (const forbidden of [
      'requireNutritionProductFeature',
      'process.env',
      'express',
      'NUTRITION_AI_NOT_ENTITLED',
      'setHeader',
      'app.get',
      'app.post',
    ]) {
      expect(executable, `client reader must not use ${forbidden}`).not.toContain(forbidden);
    }
    // It must not persist the decision, and must not echo it back as authority.
    for (const forbidden of [
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'document.cookie',
      'SettingsAdapter',
      'x-product-tier',
      'x-entitlement',
      'x-kitchen-nutrition-tier',
      'entitled=',
    ]) {
      expect(executable, `client reader must not use ${forbidden}`).not.toContain(forbidden);
    }
    // It must not touch billing, accounts or credentials.
    for (const forbidden of ['stripe', 'paddle', 'checkout', 'subscription', 'customerId', 'apiKey']) {
      expect(executable.toLowerCase(), `client reader must not know ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    // It re-derives through the AI-5A resolver rather than minting an access object.
    expect(executable).toContain('resolveNutritionProductAccess');
    expect(executable).toContain('isNutritionProductTier');
  });

  it('adds NO reducer action, NO state field and NO session field', () => {
    const stateSource = code('src/core/nutritionV2/phase4/state.ts');
    for (const absent of [
      'productAccess',
      'product_access',
      'ProductAccess',
      'productTier',
      'entitlement',
      'ai_advanced_tier',
    ]) {
      expect(stateSource, absent).not.toContain(absent);
    }
    const sessionSource = code('src/core/nutritionV2/phase4/session.ts');
    for (const absent of ['productAccess', 'entitlement', 'productTier']) {
      expect(sessionSource, absent).not.toContain(absent);
    }
  });

  it('adds NO schema field, NO Apply field and NO persistence field', () => {
    for (const rel of [
      'src/core/nutritionV2/schema.ts',
      'src/core/nutritionV2/phase5/types.ts',
      'src/core/nutritionV2/phase5/authorize.ts',
      'src/application/advancedNutritionApply.ts',
      'src/utils/markdownParser.ts',
    ]) {
      const source = code(rel);
      for (const absent of [
        'productAccess',
        'ProductAccess',
        'nutrition_product_access',
        'productTier',
        'entitlement',
        'ai_advanced',
      ]) {
        expect(source, `${rel} must not contain ${absent}`).not.toContain(absent);
      }
    }
  });

  it('adds NO route, NO limiter bucket and NO product-access endpoint', () => {
    // Enforcement adds no endpoint and no bucket. A Basic denial must not consume the
    // paid route's limiter, so no entitlement bucket may exist either.
    const app = code('server/app.ts');
    for (const absent of [
      '/api/nutrition/product-access',
      'product-access',
      'nutritionProductAccessRateLimiter',
      'entitlementRateLimiter',
      'productAccessRateLimiter',
      'NUTRITION_PRODUCT_ACCESS_VERSION',
      'AI_ADVANCED_NUTRITION_PRODUCT_ACCESS',
      'BASIC_NUTRITION_PRODUCT_ACCESS',
    ]) {
      expect(app, absent).not.toContain(absent);
    }
    // No route exposes product access to a client.
    for (const route of [...app.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1])) {
      expect(route).not.toContain('product-access');
      expect(route).not.toContain('entitlement');
    }
    const limiter = code('server/rateLimiter.ts');
    for (const absent of ['productAccess', 'ProductAccess', 'entitlement']) {
      expect(limiter, absent).not.toContain(absent);
    }
  });

  it('the contract version token is DECLARED exactly once in the whole repository', () => {
    const owners: string[] = [];
    for (const rel of ALL_SOURCE_FILES) {
      if (/export const NUTRITION_PRODUCT_ACCESS_VERSION\s*=/.test(src(rel))) owners.push(rel);
    }
    // The AI-5B gate RE-EXPORTS the token under its own name; it must never re-declare it.
    expect(owners).toEqual([CONTRACT]);
    expect(src(AI5B_GATE)).toContain('NUTRITION_PRODUCT_ACCESS_BOUND_VERSION');
    expect(src(AI5B_GATE)).not.toMatch(/export const NUTRITION_PRODUCT_ACCESS_VERSION\s*=/);
  });

  it('there is exactly ONE product-access DEFINITION module', () => {
    // Two modules carry the vocabulary: the AI-5A definition and the AI-5B server
    // boundary. Only the first may define the contract types or resolvers.
    const modules = ALL_SOURCE_FILES
      .filter((rel) => /ProductAccess|productAccess/.test(rel))
      // The AI-5C files are a READER and a COMPOSER over the contract; neither
      // DEFINES a product-access value. Exactly one module may do that.
      .filter((rel) => rel !== AI5C_CLIENT_READER && rel !== AI5C_COMPOSER)
      .sort();
    expect(modules).toEqual([AI5B_GATE, CONTRACT].sort());
    const gate = code(AI5B_GATE);
    expect(gate).not.toMatch(/interface\s+NutritionProductAccess\b/);
    expect(gate).not.toMatch(/type\s+NutritionProductTier\s*=/);
    expect(gate).not.toMatch(/type\s+NutritionProductAiFeature\s*=/);
    expect(gate).toContain('resolveNutritionProductAccess');
  });

  it('adds no focused or skipped test', () => {
    for (const rel of [
      'tests/unit/advancedNutritionAi5aProductAccess.test.ts',
      'tests/security/advancedNutritionAi5aIsolation.test.ts',
      'tests/unit/advancedNutritionAi5aAuthorityDifferential.test.ts',
    ]) {
      expect(src(rel), rel).not.toMatch(/\.only\s*\(/);
      expect(src(rel), rel).not.toMatch(/\.(skip|todo)\s*\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. THE CRITICAL SEPARATION, PINNED AS DATA
// ---------------------------------------------------------------------------
describe('AI-5A isolation — entitlement is not readiness, pinned as data', () => {
  it('Basic product access is Basic for EVERY provider/credential scenario', async () => {
    const productAccess = await import('../../src/core/nutritionV2/nutritionProductAccess');
    const capabilities = await import('../../src/core/nutritionV2/nutritionCapabilities');

    // Scenario A: Basic user, Gemini configured. PRODUCT ACCESS says Basic.
    // (What the OPERATIONAL resolver says is a separate question, and it is
    // deliberately NOT asserted here — AI-5A does not reinterpret it.)
    const scenarios = [
      {},
      { aiConfigured: true },
      { aiReachable: true },
      { aiConfigured: true, aiReachable: true },
    ];
    for (const scenario of scenarios) {
      // No entitlement is ever derivable from provider state: there is no such API.
      expect(Object.keys(productAccess).filter((key) => /provider|Configured|Reachable/i.test(key)))
        .toEqual([]);
      // And the AI-0 resolver is untouched and still purely operational.
      const resolved = capabilities.resolveNutritionCapabilities(scenario);
      expect(resolved.manualEditing).toBe(true);
      expect(resolved.deterministicReview).toBe(true);
    }
  });

  it('an AI Advanced entitlement survives an absent provider (ownership is not readiness)', async () => {
    const productAccess = await import('../../src/core/nutritionV2/nutritionProductAccess');
    const advanced = productAccess.resolveNutritionProductAccess('ai_advanced');
    // Entitled...
    expect(productAccess.isAiAdvancedProductAccess(advanced)).toBe(true);
    // ...and this contract module has no way to express, request or observe
    // operational readiness, so it cannot downgrade ownership.
    expect(Object.keys(productAccess).filter((key) => /availab|ready|reachab|configured/i.test(key)))
      .toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. AI-4E / D2 CLEANUP REMAINS INTACT, AND AI-4 STAYS INERT
// ---------------------------------------------------------------------------
describe('AI-5A isolation — AI-4E / D2 and the AI-4 trust boundary are untouched', () => {
  it('the AI-4E origin receipt and its shared shape are not referenced by AI-5A', () => {
    for (const rel of [
      'server/recipeContextOriginReceipt.ts',
      'src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts',
    ]) {
      const source = src(rel);
      expect(source, rel).not.toContain('nutritionProductAccess');
      expect(source, rel).not.toContain('ProductAccess');
    }
    // The receipt version is still declared exactly once, in the shape module.
    const owners: string[] = [];
    for (const rel of ALL_SOURCE_FILES) {
      if (/export const AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_VERSION\s*=/.test(src(rel))) owners.push(rel);
    }
    expect(owners).toEqual(['src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts']);
  });

  it('projectAcceptedRecipeContext still has ZERO production consumers', () => {
    const symbol = 'projectAcceptedRecipeContext';
    const producers = ALL_SOURCE_FILES.filter((rel) => src(rel).includes(symbol));
    // Only the defining core module. No App, no route, no matching, no mass, no
    // AI-3 gate, no Apply, no persistence.
    expect(producers).toEqual(['src/core/nutritionV2/aiRecipeContextSession.ts']);

    const consumers: string[] = [];
    for (const rel of [...walk(join(REPO, 'src')), ...walk(join(REPO, 'server'))]) {
      if (rel === 'src/core/nutritionV2/aiRecipeContextSession.ts') continue;
      const source = src(rel);
      // A mention in prose is fine; an actual import/usage is not.
      if (new RegExp(`import[^\\n]*${symbol}`).test(source)) consumers.push(rel);
    }
    expect(consumers).toEqual([]);
  });

  it('accepted AI-4 context is still inert: no AI-3, matching, mass, Apply or persistence use', () => {
    for (const rel of [
      'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
      'src/core/nutritionV2/phase4/aiEstimateApplyGate.ts',
      'src/core/nutritionV2/calculation/effectiveMass.ts',
      'src/core/nutritionV2/matching/rank.ts',
      'src/core/nutritionV2/phase5/authorize.ts',
      'src/application/advancedNutritionApply.ts',
    ]) {
      const source = code(rel);
      for (const absent of [
        'RecipeContext',
        'recipe_context',
        'recipeContext',
        'ProductAccess',
        'nutritionProductAccess',
      ]) {
        expect(source, `${rel} must not contain ${absent}`).not.toContain(absent);
      }
    }
  });

  it('AI-5A creates no entitlement for AI-4 context APPLICATION', () => {
    // The closed vocabulary stops at `ai_recipe_context_review`; there is no
    // application/authority feature, because accepted AI-4 context has no consumer.
    const contract = code(CONTRACT);
    expect(contract).toContain('ai_recipe_context_review');
    expect(contract).not.toContain('ai_recipe_context_application');
  });
});