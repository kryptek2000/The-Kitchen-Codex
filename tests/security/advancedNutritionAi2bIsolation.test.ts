/**
 * The Kitchen Codex — AI-2B live candidate planning: isolation, route separation
 * and scope.
 *
 * Static, provider-free assertions pinning the AI-2B architecture:
 *   - the server adapter talks ONLY to the existing provider abstraction and the
 *     frozen AI plan/request/wire contracts: no USDA runtime/catalog, no Phase 2
 *     `matching`, no Phase 4 state, no persistence, no vault, no UI;
 *   - the application requester is an application-layer module: transport port,
 *     capability boundary, AI-2A context, frozen sanitizer — no server, no
 *     provider implementation, no storage/vault, no React;
 *   - no AI-2B module imports the bounded estimate, and no module is
 *     provider-specific (no hard-coded OpenAI/Gemini/OpenRouter path);
 *   - the plan route is SEPARATE from the AI-1 interpretation route, with its own
 *     limiter and its own response schema;
 *   - the frozen AI-0/AI-2A contracts are untouched and never import AI-2B;
 *   - the wire rebuild (never a direct serialization of sanitized internal plans)
 *     is the only way the adapter emits a plan;
 *   - no focused/skipped test, no secret and no absolute home path ships.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { AI_ADVANCED_PLAN_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlan';
import { AI_ADVANCED_PLAN_REQUEST_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import {
  AI_ADVANCED_PLAN_WIRE_ENTRY_KEYS,
  AI_ADVANCED_PLAN_WIRE_ENVELOPE_KEYS,
} from '../../src/core/nutritionV2/aiAdvancedPlanWire';
import {
  AI_ADVANCED_PLAN_TARGET_BINDING_KEYS,
  AI_ADVANCED_PLAN_TARGET_KEYS,
  AI_ADVANCED_PLAN_TARGET_SEMANTIC_KEYS,
  AI_ADVANCED_PLAN_TARGET_VERSION,
} from '../../src/core/nutritionV2/aiAdvancedPlanTarget';
import { NUTRITION_PLAN_ENDPOINT } from '../../src/application/nutritionAiPlan';
import { MAX_AI_ADVANCED_PLAN_RESPONSE_BYTES } from '../../server/nutritionPlan';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO, relativePath), 'utf8');
}

function importSpecifiers(source: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) out.push(match[1]!);
  for (const match of source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)) out.push(match[1]!);
  return out;
}

/**
 * Code-only view of a module: comments AND string literals legitimately DISCUSS
 * the things a module must never do ("never persists", "do NOT output portion_ref"),
 * so absence claims are asserted against executable code, not against prose.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const SERVER_ADAPTER = 'server/nutritionPlan.ts';
const APPLICATION_REQUESTER = 'src/application/nutritionAiPlan.ts';
const WIRE_MODULE = 'src/core/nutritionV2/aiAdvancedPlanWire.ts';
const TARGET_MODULE = 'src/core/nutritionV2/aiAdvancedPlanTarget.ts';

const AI2B_PRODUCTION_MODULES = [
  SERVER_ADAPTER,
  APPLICATION_REQUESTER,
  WIRE_MODULE,
  TARGET_MODULE,
] as const;

const AI2B_TESTS = [
  'tests/unit/advancedNutritionAi2bPlanTransport.test.ts',
  'tests/unit/advancedNutritionAi2bPlanRequest.test.ts',
  'tests/unit/advancedNutritionAi2bPlanTarget.test.ts',
  'tests/security/nutritionPlanRoute.test.ts',
  'tests/security/advancedNutritionAi2bIsolation.test.ts',
] as const;

const FROZEN_MODULES = [
  'src/core/nutritionV2/aiAdvancedPlan.ts',
  'src/core/nutritionV2/aiAdvancedCandidates.ts',
  'src/core/nutritionV2/aiAdvanced.ts',
  'src/core/nutritionV2/aiAdvancedEstimate.ts',
  'src/core/nutritionV2/aiAdvancedPlanSource.ts',
  'src/core/nutritionV2/aiAdvancedPlanRequest.ts',
  'src/core/nutritionV2/aiAdvancedPlanApply.ts',
] as const;

const FORBIDDEN_ANYWHERE = [
  'matching/',
  'phase4',
  'usda/',
  'localStorage',
  'indexedDB',
  'react',
  'components/',
  'vault',
  'persist',
  'aiAdvancedEstimate',
  'resolveAiBoundedEstimate',
  'buildAiAdvancedPortionSet',
  'isDeterministicAutomaticSelection(',
  'isDeterministicBestEffortSelection(',
  'selectAutomaticMatch(',
  'selectBestEffortMatch(',
] as const;

describe('AI-2B isolation — server adapter', () => {
  const source = read(SERVER_ADAPTER);

  it('imports only the provider abstraction and the frozen canonical contracts', () => {
    const allowed = new Set([
      './ai/provider.js',
      './ai/effectiveSelection.js',
      './ai/providerErrors.js',
      './ai/types.js',
      './providerDiagnostics.js',
      '../src/core/nutritionV2/aiAdvancedCandidates.js',
      '../src/core/nutritionV2/aiAdvancedPlan.js',
      '../src/core/nutritionV2/aiAdvancedPlanRequest.js',
      '../src/core/nutritionV2/aiAdvancedPlanWire.js',
      '../src/core/nutritionV2/aiAdvancedPlanTarget.js',
      '../src/core/nutritionV2/schema.js',
      'dotenv',
    ]);
    for (const specifier of importSpecifiers(source)) {
      expect(allowed.has(specifier), `${SERVER_ADAPTER} imports ${specifier}`).toBe(true);
    }
  });

  it('touches no USDA runtime/catalog, Phase 2 matching, Phase 4 state, persistence, vault or UI', () => {
    const code = stripComments(source);
    for (const token of FORBIDDEN_ANYWHERE) {
      expect(code.includes(token), `${SERVER_ADAPTER} references ${token}`).toBe(false);
    }
  });

  it('is provider-neutral: no hard-coded provider SDK, vendor or model path', () => {
    for (const token of [
      '@google/genai',
      'GoogleGenAI',
      'googleapis',
      'openai',
      'OpenAI',
      'openrouter',
      'OpenRouter',
      'anthropic',
      'api.openai.com',
      'generativelanguage',
    ]) {
      expect(source.includes(token), `${SERVER_ADAPTER} hard-codes ${token}`).toBe(false);
    }
    // …and it uses the EXISTING provider infrastructure instead.
    expect(source).toContain('runWithAiFallback');
    expect(source).toContain('resolveRoleCandidates');
    expect(source).toContain('resolveExecutableTextCandidates');
    expect(source).toContain('buildAiAdvancedPlanSchema');
    expect(source).toContain('normalizeProviderError');
  });

  it('rebuilds the WIRE payload instead of serializing sanitized internal plans', () => {
    const code = stripComments(source);
    // The wire rebuild is the ONLY path from sanitized plans to a payload…
    // CLOSURE 3: the accepted plan passes through the server's ambiguity /
    // alternative enforcement before the wire form is rebuilt.
    expect(source).toContain(
      'const enforcedPlans = enforceTargetAmbiguityPolicy(sanitized.plans, request.planningTargets);'
    );
    expect(source).toContain('const plan = toAiAdvancedPlanWirePayload(enforcedPlans)');
    expect(code).toContain('return { ok: true, requestId: request.requestId, plan, aiAttempted: true }');
    // …and nothing serializes the sanitizer's internal (per-entry plan_version)
    // representation, which application re-sanitization would reject.
    expect(code).not.toContain('JSON.stringify(sanitized');
    expect(code).not.toContain('JSON.stringify(accepted');
    expect(code).not.toContain('JSON.stringify(plans');
    expect(code).not.toContain('JSON.stringify(internal');
  });

  it('enforces the 32 KiB request cap on the rebuilt payload and the response cap', () => {
    expect(source).toContain('MAX_AI_ADVANCED_PLAN_REQUEST_BYTES');
    expect(source).toContain('MAX_AI_ADVANCED_PLAN_RESPONSE_BYTES');
    expect(MAX_AI_ADVANCED_PLAN_RESPONSE_BYTES).toBe(32 * 1024);
    expect(source).toContain('utf8ByteLength');
  });

  it('bounds the COMPLETE model-facing request, not just the candidate set', () => {
    // The cap must be measured on the exact payload the provider receives — the
    // candidate set AND the planning targets — with the target block inside the
    // bound. A candidate-only measurement silently leaves the target unbounded.
    const code = stripComments(source);
    expect(code).toMatch(
      /const modelRequestBytes = utf8ByteLength\(\s*JSON\.stringify\(buildPlanPromptPayload\(/
    );
    expect(code).toMatch(/modelRequestBytes > MAX_AI_ADVANCED_PLAN_REQUEST_BYTES/);
    // Measured AFTER target validation (otherwise a rejected/absent target set
    // would be measured, and the accepted set would not be).
    expect(code.indexOf('const modelRequestBytes')).toBeGreaterThan(
      code.indexOf('sanitizeAiAdvancedPlanTargets(envelope["planning_targets"]')
    );
    // There is exactly ONE prompt-payload owner: the cap and the prompt cannot drift.
    // (The return TYPE also names `candidate_set`, hence the lookbehind.)
    expect(code.match(/(?<!readonly )candidate_set: \{/g)?.length).toBe(1);
    expect(code).toContain('const payload = buildPlanPromptPayload(providerRequest, planningTargets);');
  });

  it('never sends the request identity to the model', () => {
    // The prompt builder takes ONLY the provider request (which has no request id)
    // and the bounded planning targets (which carry no identity either).
    expect(source).toMatch(
      /export function buildPlanPrompt\(\s*providerRequest: AiAdvancedPlanProviderRequest,\s*planningTargets: ReadonlyArray<AiAdvancedPlanTarget>\s*\)/
    );
    expect(source).not.toMatch(/buildPlanPrompt\([^)]*requestId/);
    // The call site may pass only the identity-free provider request and the
    // identity-free targets — never the sanitized request (which carries requestId).
    expect(source).not.toMatch(/buildPlanPrompt\([^)]*request\.request_id/);
    expect(source).not.toMatch(/buildPlanPrompt\(request\)|buildPlanPrompt\(request,\s*\)/);
  });
});

describe('AI-2B isolation — application requester', () => {
  const source = read(APPLICATION_REQUESTER);

  it('imports only application-layer ports, the capability boundary and frozen contracts', () => {
    const allowed = new Set([
      './adapters/NetworkAdapter',
      './aiSelection',
      '../core/nutritionV2/aiAdvancedPlanRequest',
      '../core/nutritionV2/aiAdvancedPlan',
      '../core/nutritionV2/aiAdvancedPlanWire',
      '../core/nutritionV2/aiAdvancedPlanTarget',
      '../core/nutritionV2/schema',
      '../core/nutritionV2/nutritionCapabilities',
    ]);
    for (const specifier of importSpecifiers(source)) {
      expect(allowed.has(specifier), `${APPLICATION_REQUESTER} imports ${specifier}`).toBe(true);
    }
  });

  it('never imports the server, a provider implementation, storage/vault, or UI', () => {
    const code = stripComments(source);
    for (const token of [...FORBIDDEN_ANYWHERE, 'server/', 'ai/provider']) {
      expect(code.includes(token), `${APPLICATION_REQUESTER} references ${token}`).toBe(false);
    }
    // The one adapter import is a TYPE-ONLY transport port.
    expect(source).toContain("import type { NetworkAdapter } from './adapters/NetworkAdapter'");
  });

  it('never applies, persists or mutates anything', () => {
    const code = stripComments(source);
    for (const token of [
      'validateAndApplyAiAdvancedPlan',
      'applyCanonicalInterpretations',
      'workingState',
      'localStorage',
      'saveRecipe',
      'persist',
    ]) {
      expect(code.includes(token), `${APPLICATION_REQUESTER} touches ${token}`).toBe(false);
    }
    // It re-sanitizes and returns an inert plan.
    expect(code).toContain('sanitizeAiAdvancedPlanResponse');
    expect(code).toContain('readAiAdvancedPlanWirePayload');
    expect(code).toContain('AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS');
  });

  it('is not wired into the AI-1 resolver, the app shell or any component', () => {
    for (const file of [
      'src/application/nutritionAiResolve.ts',
      'src/App.tsx',
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
    ]) {
      const surface = read(file);
      for (const token of ['nutritionAiPlan', 'requestAiAdvancedCandidatePlan', 'plan-ingredients']) {
        expect(surface.includes(token), `${file} references ${token}`).toBe(false);
      }
    }
  });
});

describe('AI-2B isolation — wire module purity', () => {
  const source = read(WIRE_MODULE);

  it('is pure: no async, network, provider, or environment access', () => {
    for (const token of [
      'fetch(',
      'NetworkAdapter',
      'async ',
      'await ',
      'process.',
      'Date.now(',
      'Math.random(',
      ...FORBIDDEN_ANYWHERE,
    ]) {
      expect(source.includes(token), `${WIRE_MODULE} contains ${token}`).toBe(false);
    }
  });

  it('owns the closed wire key sets, and the entry keys exclude plan_version', () => {
    expect([...AI_ADVANCED_PLAN_WIRE_ENVELOPE_KEYS]).toEqual(['plan_version', 'plans']);
    expect([...AI_ADVANCED_PLAN_WIRE_ENTRY_KEYS]).not.toContain('plan_version');
    expect(source).toContain('plan_version');
  });

  it('no AI-2B production module imports the bounded estimate or a portion builder', () => {
    for (const file of AI2B_PRODUCTION_MODULES) {
      const moduleSource = read(file);
      expect(moduleSource.includes('aiAdvancedEstimate'), `${file} imports the estimate`).toBe(false);
      expect(moduleSource.includes('buildAiAdvancedPortionSet'), `${file} builds portions`).toBe(false);
    }
  });
});

describe('AI-2B isolation — planning target module purity and authority firewall', () => {
  const source = read(TARGET_MODULE);
  const code = stripComments(source);

  it('is pure: no async, network, provider, environment, or clock access', () => {
    for (const token of [
      'fetch(',
      'NetworkAdapter',
      'async ',
      'await ',
      'process.',
      'Date.now(',
      'Math.random(',
      'server/',
      ...FORBIDDEN_ANYWHERE,
    ]) {
      expect(code.includes(token), `${TARGET_MODULE} contains ${token}`).toBe(false);
    }
  });

  it('imports only the canonical semantic bounds and the shared shape helpers', () => {
    const allowed = new Set(['./aiAdvanced', './aiAdvancedPlanSource', './schema']);
    for (const specifier of importSpecifiers(source)) {
      expect(allowed.has(specifier), `${TARGET_MODULE} imports ${specifier}`).toBe(true);
    }
    // The bounds are NOT re-declared here: the target has no second vocabulary
    // owner (a duplicated cap would silently drift from AI-1).
    expect(code).not.toMatch(/export const MAX_/);
    expect(source).toContain('MAX_AI_ADVANCED_DOCUMENT_TEXT');
    expect(source).toContain('MAX_AI_ADVANCED_NAME_LENGTH');
  });

  it('keeps a CLOSED target shape with no authority field at any level', () => {
    expect([...AI_ADVANCED_PLAN_TARGET_KEYS]).toEqual([
      'line_ref',
      'source_text',
      'semantic_food',
      'search_phrases',
      'ambiguity',
      'alternatives',
    ]);
    expect([...AI_ADVANCED_PLAN_TARGET_SEMANTIC_KEYS]).toEqual([
      'normalized_name',
      'modifiers',
      'preparation',
      'state',
      'qualifiers',
    ]);
    expect(AI_ADVANCED_PLAN_TARGET_VERSION).toBe('nutrition_ai_advanced_plan_target_v1');
    for (const token of [
      'fdc_id',
      'fdcId',
      'record_digest',
      'review_digest',
      'catalog_digest',
      'bundle_release',
      'grams',
      'nutrient',
      'portion_ref',
      'strict_automatic_fdc_id',
      'best_effort',
      'candidate_ref',
      'review_required',
      'confidence',
      'apply',
    ]) {
      expect(
        // The key sets and the closed-shape guard are the firewall: none of these
        // names may be an ACCEPTED target key (the module may name a few of them in
        // prose as forbidden).
        [...(AI_ADVANCED_PLAN_TARGET_KEYS as ReadonlyArray<string>), ...(AI_ADVANCED_PLAN_TARGET_SEMANTIC_KEYS as ReadonlyArray<string>)].includes(token),
        `${token} is an accepted target key`
      ).toBe(false);
    }
  });

it('CLOSURE 2/3/4: the three new enforcement boundaries are present and independent', () => {
    const target = stripComments(read(TARGET_MODULE));
    const requester = stripComments(read(APPLICATION_REQUESTER));
    const server = stripComments(read(SERVER_ADAPTER));

    // CLOSURE 4 — canonical AI-1 re-sanitization, NOT duck typing: the target module
    // calls the existing AI-1 sanitizer and never hand-rolls an interpretation key set.
    expect(target).toContain('sanitizeAiAdvancedInterpretationResponse(');
    expect(target).not.toContain('INTERPRETATION_KEYS');

    // CLOSURE 2 — the fingerprint binding check happens in the requester, before any
    // network access, and compares the AI-1 source against the local binding.
    expect(requester).toContain('context.line(lineRef)?.interpretation_fingerprint');
    expect(requester).toContain('readAiAdvancedPlanTargetBinding(');

    // CLOSURE 3 — ambiguity / alternative enforcement exists INDEPENDENTLY at BOTH
    // trust boundaries (defense in depth), not as one shared sanitizer.
    for (const [name, source] of [
      ['server', server],
      ['application', requester],
    ] as ReadonlyArray<readonly [string, string]>) {
      expect({ boundary: name, ambiguous: source.includes('ambiguity?.ambiguous === true') }).toEqual({
        boundary: name,
        ambiguous: true,
      });
      expect({ boundary: name, alternatives: source.includes('alternatives?.length ?? 0) > 0') }).toEqual({
        boundary: name,
        alternatives: true,
      });
    }
  });

  it('keeps the interpretation fingerprint LOCAL: beside the target, never inside it', () => {
    // Closure 2: the binding retains the AI-1 interpretation fingerprint so AI-2C can
    // compare it against the acceptance port's `stale_interpretation` check — as LOCAL
    // metadata. It must not become a target key, or it would ride into the provider
    // payload (the prompt is built from the target alone).
    expect([...AI_ADVANCED_PLAN_TARGET_BINDING_KEYS]).toEqual(['target', 'interpretation_fingerprint']);
    expect([...(AI_ADVANCED_PLAN_TARGET_KEYS as ReadonlyArray<string>)]).not.toContain(
      'interpretation_fingerprint'
    );
    // The bound is AI-2A's, imported — not re-declared here.
    expect(source).toContain('MAX_AI_ADVANCED_FINGERPRINT_LENGTH');
    expect(code).not.toMatch(/export const MAX_/);
    // The PROVIDER boundary is the server adapter: it builds the prompt and the
    // provider request, so it must never reference a fingerprint at all.
    expect(
      stripComments(read(SERVER_ADAPTER)).includes('interpretation_fingerprint'),
      `${SERVER_ADAPTER} references a fingerprint`
    ).toBe(false);
    // The application layer is NOT under a categorical ban (corrected: that rule was
    // too strict). The requester may carry a fingerprint locally as binding metadata;
    // what it must never do is put one into the provider-facing transport. That is
    // pinned at runtime instead — see the requester suite's
    // "a bound target's fingerprint never enters the provider-facing transport", and
    // the invariant that the fingerprint is not a target key, above.
  });

  it('carries no portion or candidate authority: targets never select or allow', () => {
    for (const token of [
      'AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS',
      'MAX_AI_ADVANCED_PORTION_OPTIONS',
      'buildAiAdvancedPortionSet',
      'selectAutomaticMatch',
      'selectBestEffortMatch',
      'validateAndApplyAiAdvancedPlan',
    ]) {
      expect(code.includes(token), `${TARGET_MODULE} references ${token}`).toBe(false);
    }
    // It is a description, not a decision: the module exports no selection callback.
    expect(source).not.toContain('isDeterministicAutomaticSelection(');
  });
});

describe('AI-2B route separation and frozen contracts', () => {
  it('registers a dedicated plan route with its own limiter and middleware posture', () => {
    const app = read('server/app.ts');
    expect(app).toContain(NUTRITION_PLAN_ENDPOINT);
    expect(app).toContain('nutritionPlanRateLimiter');
    expect(app).toContain('import { planIngredientsOnServer } from "./nutritionPlan.js";');
    // Mirrors the canonical interpretation route's security posture.
    const planRoute = app.slice(app.indexOf(NUTRITION_PLAN_ENDPOINT));
    const routeLine = planRoute.slice(0, planRoute.indexOf('\n'));
    for (const middleware of [
      'requireAiAccessToken',
      'textPricingGuard',
      'nutritionPlanRateLimiter',
    ]) {
      expect(routeLine.includes(middleware), `plan route is missing ${middleware}`).toBe(true);
    }
    // The AI-1 route keeps ITS limiter, and its middleware posture is unchanged apart
    // from the AI-5B product-entitlement gate the server now inserts after endpoint
    // authentication. The RELATIVE order of the pre-existing middleware is what this
    // suite owns, so it is asserted by index rather than by one literal route line.
    const interpretRoute = app.slice(app.indexOf('"/api/nutrition/interpret-ingredients"'));
    const interpretLine = interpretRoute.slice(0, interpretRoute.search(/\basync\s*\(/));
    const orderOf = (line: string, needle: string) => line.indexOf(needle);
    for (const middleware of [
      'requireAiAccessToken',
      'requireNutritionProductFeature',
      'textPricingGuard',
      'nutritionInterpretRateLimiter',
    ]) {
      expect(interpretLine.includes(middleware), `interpret route is missing ${middleware}`).toBe(true);
    }
    expect(orderOf(interpretLine, 'requireAiAccessToken')).toBeLessThan(
      orderOf(interpretLine, 'requireNutritionProductFeature'),
    );
    expect(orderOf(interpretLine, 'requireNutritionProductFeature')).toBeLessThan(
      orderOf(interpretLine, 'textPricingGuard'),
    );
    expect(orderOf(interpretLine, 'textPricingGuard')).toBeLessThan(
      orderOf(interpretLine, 'nutritionInterpretRateLimiter'),
    );
    // Two separate endpoints — no mixed discriminator, no shared schema.
    expect(app).not.toContain('/api/nutrition/plan-or-interpret');
    expect(app).not.toContain('mode: "plan"');
  });

  it('keeps the plan contract constants pinned to the frozen values', () => {
    expect(AI_ADVANCED_PLAN_VERSION).toBe('nutrition_ai_advanced_plan_v1');
    expect(AI_ADVANCED_PLAN_REQUEST_VERSION).toBe('nutrition_ai_advanced_plan_request_v1');
    expect(NUTRITION_PLAN_ENDPOINT).toBe('/api/nutrition/plan-ingredients');
  });

  it('the frozen AI-0/AI-2A modules never import the AI-2B slice backward', () => {
    for (const file of FROZEN_MODULES) {
      const source = read(file);
      for (const token of [
        'aiAdvancedPlanWire',
        'PlanWire',
        'nutritionAiPlan',
        'nutritionPlan',
        'plan-ingredients',
      ]) {
        expect(source.includes(token), `${file} imports ${token}`).toBe(false);
      }
    }
  });

  it('keeps the AI-1 live path contract-equivalent', () => {
    const application = read('src/application/nutritionAiResolve.ts');
    expect(application).toContain('liveCanonicalInterpretation');
    expect(application).toContain('NUTRITION_INTERPRET_ENDPOINT');
    expect(read('server/nutritionInterpret.ts')).toContain('sanitizeAiAdvancedInterpretationResponse');
    expect(read('server/app.ts')).toContain('/api/nutrition/interpret-ingredients');
  });
});

describe('AI-2B hygiene', () => {
  it('ships no focused/skipped test, no secret and no absolute home path', () => {
    for (const file of [...AI2B_TESTS, ...AI2B_PRODUCTION_MODULES, 'scripts/verify_ai_plan_prod.ts']) {
      const source = read(file);
      expect(source).not.toMatch(/\.only\s*\(/);
      expect(source).not.toMatch(/\.(skip|todo)\s*\(/);
      expect(source).not.toMatch(/\/home\/sid/);
      expect(source).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      expect(source).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i);
    }
  });

  it('adds no package/lock/config change and no new dependency import', () => {
    for (const file of AI2B_PRODUCTION_MODULES) {
      const source = read(file);
      for (const specifier of importSpecifiers(source)) {
        expect(specifier.startsWith('.') || specifier === 'dotenv', `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});
