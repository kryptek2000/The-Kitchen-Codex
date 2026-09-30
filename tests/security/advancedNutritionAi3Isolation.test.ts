/**
 * AI-3 — ISOLATION AND AUTHORITY BOUNDARIES.
 *
 * Static, provider-free pins on the AI-3 slice. They assert the SHAPE of the
 * system, not one function's behaviour: one route, one requester, no Phase 5
 * widening, no persistence of an estimate, and no authority leakage into the
 * model payload.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import {
  AI_ESTIMATE_REQUEST_VERSION,
  buildAiEstimateModelRequest,
  MAX_AI_ESTIMATE_REQUEST_BYTES,
  MAX_AI_ESTIMATE_RESPONSE_BYTES,
} from '../../src/core/nutritionV2/aiAdvancedEstimateWire';
import { sanitizeEstimateTransportRequest, sanitizeEstimateProviderResponse } from '../../server/nutritionEstimate';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO, relativePath), 'utf8');
}
/** Every .ts/.tsx file under a repo-relative directory, recursively. */
function listFiles(relativeDir: string): ReadonlyArray<string> {
  const root = join(REPO, relativeDir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const rel = `${relativeDir}/${name.name}`;
    if (name.isDirectory()) out.push(...listFiles(rel));
    else if (name.name.endsWith('.ts') || name.name.endsWith('.tsx')) out.push(rel);
  }
  return out.sort();
}
function importSpecifiers(source: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const m of source.matchAll(/from\s+'([^']+)'/g)) out.push(m[1]!);
  for (const m of source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)) out.push(m[1]!);
  return out;
}

const APP = 'server/app.ts';
const APP_SOURCE = read(APP);
const ROUTE = '/api/nutrition/estimate-mass';
const SERVER_MODULE = 'server/nutritionEstimate.ts';

describe('AI-3 isolation — exactly one estimate route and one limiter', () => {
  it('exactly one estimate-mass route exists', () => {
    const occurrences = APP_SOURCE.split(`"${ROUTE}"`).length - 1;
    expect(occurrences).toBe(1);
  });

  it('the AI-3 route is DEDICATED and does not reuse the AI-2B planning route', () => {
    const line = APP_SOURCE.split('\n').find((l) => l.includes(ROUTE));
    expect(line).toBeDefined();
    expect(line).not.toContain('plan-ingredients');
    expect(line).toContain('nutritionMassEstimateRateLimiter');
  });

  it('the legacy /api/estimate-nutrition route remains intact', () => {
    expect(APP_SOURCE).toContain('"/api/estimate-nutrition"');
  });

  it('the legacy nutritionEstimateRateLimiter remains intact and is not renamed', () => {
    const limiter = read('server/rateLimiter.ts');
    expect(limiter).toContain('export function nutritionEstimateRateLimiter');
    expect(limiter).toContain('export function nutritionMassEstimateRateLimiter');
    // Separate store keys => separate buckets.
    expect(limiter).toContain('`nutr_${clientIp}`');
    expect(limiter).toContain('`nutr_mass_estimate_${clientIp}`');
  });

  it('exactly one network owner module exists for estimates', () => {
    const owners = readdirSync(join(REPO, 'server')).filter(
      (f) => f === 'nutritionEstimate.ts'
    );
    expect(owners).toEqual(['nutritionEstimate.ts']);
    // The wire owner is the only other estimate transport module.
    const wireOwners = readdirSync(join(REPO, 'src/core/nutritionV2')).filter(
      (f) => /Estimate/.test(f) && /Wire/.test(f)
    );
    expect(wireOwners).toEqual(['aiAdvancedEstimateWire.ts']);
  });

  it('the AI-2B planning route and module are unchanged in shape', () => {
    expect(APP_SOURCE).toContain('"/api/nutrition/plan-ingredients"');
    expect(existsSync(join(REPO, 'server/nutritionPlan.ts'))).toBe(true);
  });
});

describe('AI-3 isolation — the model-facing payload carries no authority', () => {
  const goodLine = {
    line_ref: 'L1',
    source_text: '2 tomatoes',
    amount: 2,
    unit: null,
    measurement_kind: 'count',
    count_noun: null,
    food_semantics: 'tomatoes',
    local_food_description: 'Tomatoes, red, ripe, raw',
    evidence_absent_reason: 'no_authenticated_portion',
  };

  it('the built model payload exposes only the approved bounded fields', () => {
    const request = buildAiEstimateModelRequest([goodLine]);
    expect(Object.keys(request).sort()).toEqual(['contract_version', 'lines', 'provenance_class']);
    expect(Object.keys(request.lines[0] as object).sort()).toEqual([
      'amount',
      'count_noun',
      'evidence_absent_reason',
      'food_semantics',
      'line_ref',
      'local_food_description',
      'measurement_kind',
      'source_text',
      'unit',
    ]);
  });

  it('no FDC id, digest, nutrient, calorie, macro or recipe/user field is sent', () => {
    const text = JSON.stringify(buildAiEstimateModelRequest([goodLine])).toLowerCase();
    for (const forbidden of [
      'fdc_id',
      'fdc id',
      'record_digest',
      'review_digest',
      'catalog_digest',
      'bundle',
      'nutrient',
      'calorie',
      'protein',
      'fat',
      'carb',
      'recipe_key',
      'session',
      'vault',
      'provider',
      'apply',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('the transport request version contract is a single fixed literal', () => {
    expect(AI_ESTIMATE_REQUEST_VERSION).toBe('nutrition_ai_estimate_request_v1');
    expect(APP_SOURCE).toContain(ROUTE);
  });

  it('the request cap is enforced against the COMPLETE dynamic payload', () => {
    expect(MAX_AI_ESTIMATE_REQUEST_BYTES).toBe(32 * 1024);
    expect(MAX_AI_ESTIMATE_RESPONSE_BYTES).toBe(32 * 1024);
  });
});

describe('AI-3 isolation — authority-shaped output is refused at the boundary', () => {
  function response(extra: Record<string, unknown>) {
    return {
      response_version: 'nutrition_ai_estimate_response_v1',
      estimates: [
        {
          line_ref: 'L1',
          policy_version: 'nutrition_ai_estimate_policy_v1',
          provenance_class: 'ai_estimate',
          lower_grams: 150,
          upper_grams: 200,
          representative_grams: 175,
          representative_policy: 'midpoint',
          input_semantics: ['count noun'],
          evidence_absent_reason: 'no_authenticated_portion',
          ...extra,
        },
      ],
    };
  }

  it('a well-formed bounded estimate IS accepted', () => {
    expect(sanitizeEstimateProviderResponse(response({}), ['L1']).ok).toBe(true);
  });

  it('M46: model nutrient/calorie authority is refused', () => {
    for (const key of ['nutrients', 'calories', 'protein']) {
      expect(sanitizeEstimateProviderResponse(response({ [key]: {} }), ['L1']).ok).toBe(false);
    }
  });

  it('M47: model FDC/portion authority is refused', () => {
    for (const key of ['fdc_id', 'portion_id', 'serving_weight', 'density', 'usda_derived']) {
      expect(sanitizeEstimateProviderResponse(response({ [key]: 1 }), ['L1']).ok).toBe(false);
    }
  });

  it('model persistence/Apply authority is refused', () => {
    for (const key of ['apply', 'persist', 'authorization', 'user_confirmed']) {
      expect(sanitizeEstimateProviderResponse(response({ [key]: true }), ['L1']).ok).toBe(false);
    }
  });

  it('a response for an UNREQUESTED line_ref is dropped', () => {
    expect(sanitizeEstimateProviderResponse(response({}), ['OTHER']).ok).toBe(false);
  });

  it('M53: a wrong request version is refused before any provider work', () => {
    expect(sanitizeEstimateTransportRequest({ request_version: 'wrong' }).ok).toBe(false);
  });

  it('61: more than 12 lines is refused', () => {
    const lines = Array.from({ length: 13 }, (_, i) => ({ ...goodLine(), line_ref: `L${i}` }));
    const result = sanitizeEstimateTransportRequest({
      request_version: AI_ESTIMATE_REQUEST_VERSION,
      request_id: 'r',
      estimate_request: { contract_version: 'nutrition_ai_estimate_policy_v1', provenance_class: 'ai_estimate', lines },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('too_many_lines');
  });

  function goodLine() {
    return {
      line_ref: 'L1',
      source_text: '2 tomatoes',
      amount: 2,
      unit: null,
      measurement_kind: 'count',
      count_noun: null,
      food_semantics: 'tomatoes',
      local_food_description: 'Tomatoes',
      evidence_absent_reason: 'no_authenticated_portion',
    };
  }
});

describe('AI-3 isolation — capability gating and phase boundaries', () => {
  it('the Basic tier keeps estimation disabled (zero provider calls possible)', () => {
    // The tier is DERIVED from a configured AND reachable provider, so every
    // Basic-tier path yields `disabled` and estimation can never be requested.
    expect(resolveNutritionCapabilities().aiEstimation).toBe('disabled');
    expect(resolveNutritionCapabilities({}).aiEstimation).toBe('disabled');
    expect(resolveNutritionCapabilities({ aiConfigured: true }).aiEstimation).toBe('disabled');
    expect(resolveNutritionCapabilities({ aiReachable: true }).aiEstimation).toBe('disabled');
    expect(resolveNutritionCapabilities({ aiConfigured: false, aiReachable: true }).aiEstimation).toBe('disabled');
  });

  it('only a fully available AI Advanced surface enables estimation', () => {
    const advanced = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });
    expect(advanced.tier).toBe('ai_advanced');
    expect(advanced.aiEstimation).toBe('available');
  });

  it('an unreachable provider downgrades estimation rather than leaving it on', () => {
    expect(resolveNutritionCapabilities({ aiConfigured: true, aiReachable: false }).aiEstimation).toBe(
      'disabled'
    );
  });

  it('no AI-3 module imports Phase 5 core authorization', () => {
    for (const file of [
      'src/core/nutritionV2/aiAdvancedEstimateWire.ts',
      'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
      'src/core/nutritionV2/phase4/aiEstimateResolve.ts',
      'src/core/nutritionV2/phase4/aiEstimateSelection.ts',
      'src/core/nutritionV2/phase4/aiEstimateApplyGate.ts',
      'src/application/nutritionAiEstimate.ts',
    ]) {
      const source = read(file);
      expect(source).not.toContain('phase5');
      expect(source).not.toContain('authorizeNutritionPersistence');
      expect(source).not.toContain('schema');
    }
  });

  it('no AI-3 module performs persistence, Markdown writing, vault or localStorage', () => {
    for (const file of [
      'src/core/nutritionV2/aiAdvancedEstimateWire.ts',
      'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
      'src/core/nutritionV2/phase4/aiEstimateResolve.ts',
      'src/core/nutritionV2/phase4/aiEstimateApplyGate.ts',
      'src/application/nutritionAiEstimate.ts',
    ]) {
      const source = read(file);
      for (const forbidden of ['localStorage', 'obsidian', 'Vault', 'app.vault', 'process.env']) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it('the application layer is injection-only: it imports no provider or server module', () => {
    const specifiers = importSpecifiers(read('src/application/nutritionAiEstimate.ts'));
    for (const spec of specifiers) {
      expect(spec).not.toContain('/server/');
      expect(spec).not.toContain('provider');
      expect(spec).not.toContain('node:');
    }
  });

  it('no USDA network/search adapter is reachable from AI-3', () => {
    for (const file of [
      'src/core/nutritionV2/aiAdvancedEstimateWire.ts',
      'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
      'src/application/nutritionAiEstimate.ts',
    ]) {
      const source = read(file);
      expect(source).not.toContain('fetch(');
      expect(source).not.toContain('api.nal.usda.gov');
    }
  });

  it('the UI never imports server or provider code', () => {
    const card = read('src/components/AdvancedNutritionCard.tsx');
    for (const spec of importSpecifiers(card)) {
      expect(spec).not.toContain('/server/');
      expect(spec).not.toContain('provider');
    }
  });
});

describe('AI-3 isolation — Phase 5 and the schema are untouched', () => {
  it('no schema v4 and no estimate member in the closed conversion_basis union', () => {
    const schema = read('src/core/nutritionV2/schema.ts');
    expect(schema).not.toContain("'v4'");
    expect(schema).not.toContain('ai_estimate');
  });

  it('Phase 5 core authorization does not import any AI-3 module', () => {
    const authorize = read('src/core/nutritionV2/phase5/authorize.ts');
    expect(authorize).not.toContain('aiEstimate');
    expect(authorize).not.toContain('ai_estimate');
  });
});

describe('AI-3 isolation — the Slice D UI is injection-only and inert', () => {
  it('the card and modal import NO server, provider, or requester code', () => {
    for (const file of [
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
      'src/core/nutritionV2/phase4/aiEstimateAccept.ts',
    ]) {
      for (const spec of importSpecifiers(read(file))) {
        expect(spec).not.toContain('/server/');
        expect(spec).not.toContain('provider');
        expect(spec).not.toContain('nutritionAiEstimate');
        expect(spec).not.toContain('node:');
      }
    }
  });

  it('the UI reaches the estimate port ONLY through the injected prop', () => {
    const card = read('src/components/AdvancedNutritionCard.tsx');
    // The port is a prop, never a module import.
    expect(card).toContain('onEstimateMassesWithAi?:');
    expect(importSpecifiers(card).some((s) => s.includes('estimate') && s.includes('application'))).toBe(false);
    // The ONLY call site is the explicit first-click handler.
    const calls = card.match(/onEstimateMassesWithAi\(/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it('there is NO render-time or effect-time estimate request', () => {
    const card = read('src/components/AdvancedNutritionCard.tsx');
    // No effect, no memo and no render body may invoke the request.
    expect(card).not.toMatch(/useEffect\([^)]*handleEstimateMassesWithAi/s);
    expect(card).not.toMatch(/useMemo\([^)]*handleEstimateMassesWithAi/s);
  });

  it('offers cannot mutate working state by themselves', () => {
    const accept = read('src/core/nutritionV2/phase4/aiEstimateAccept.ts');
    // The pure offer module contains no dispatch and no reducer call.
    expect(accept).not.toContain('phase4Reducer');
    expect(accept).not.toContain('dispatch(');
    // buildAiEstimateOffer cannot produce a choice: it carries no selection.
    const offerBlock = accept.slice(accept.indexOf('export function buildAiEstimateOffer'),
                                   accept.indexOf('export function buildAiEstimateUiSnapshot'));
    expect(offerBlock).not.toContain('selection');
  });

  it('the acceptance path dispatches the EXISTING reducer action, not a new one', () => {
    const types = read('src/core/nutritionV2/phase4/types.ts');
    const actionCount = (types.match(/'select_ai_estimate'/g) ?? []).length;
    // The action existed before Slice D; Slice D added no parallel action.
    expect(actionCount).toBeGreaterThan(0);
    expect(types).not.toContain("'accept_ai_estimate'");
    expect(types).not.toContain("'apply_ai_estimate'");
  });

  it('no Apply or persistence authority reaches the estimate transport', () => {
    const app = read('src/application/nutritionAiEstimate.ts');
    expect(app).not.toContain('advancedNutritionApply');
    expect(app).not.toContain('writer');
    expect(app).not.toContain('readBack');
    // The Apply coordinator imports no estimate transport at all.
    expect(read('src/application/advancedNutritionApply.ts')).not.toContain('nutritionAiEstimate');
  });

  it('there is exactly ONE estimate route, ONE requester and ONE payload owner', () => {
    const server = read('server/app.ts');
    expect((server.match(/estimate-mass/g) ?? []).length).toBe(1);
    expect(server).toContain('nutritionMassEstimateRateLimiter');
    // The legacy limiter and its route are untouched.
    expect(server).toContain('nutritionEstimateRateLimiter');
    expect(server).toContain('estimate-nutrition');
    // ONE model-facing payload owner: the wire DEFINES the request, the server
    // only calls it. The server must not re-declare or re-build the payload.
    const wire = read('src/core/nutritionV2/aiAdvancedEstimateWire.ts');
    const serverEstimate = read('server/nutritionEstimate.ts');
    expect(wire).toContain('export function buildAiEstimateModelRequest');
    expect(serverEstimate).toContain('buildAiEstimateModelRequest');
    // No second payload literal in the server module.
    expect(serverEstimate).not.toContain('const payload = {');
    expect(serverEstimate).not.toContain('const modelRequest = {');
  });

  it('the route/limiter isolation remains intact after the UI', () => {
    const limiter = read('server/rateLimiter.ts');
    expect(limiter).toContain('nutritionEstimateRateLimiter');
    expect(limiter).toContain('nutritionMassEstimateRateLimiter');
  });
});

// -------------------------------------------------------------------------
function walk(dir: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe('AI-3 identity evidence — exactly ONE canonical digest owner', () => {
  const SRC = join(REPO, 'src');
  const OWNER = join(SRC, 'core/nutritionV2/calculation/identityEvidence.ts');

  it('the canonical identity primitive lives in exactly one module', () => {
    expect(existsSync(OWNER)).toBe(true);
    const owners = walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /(?:export\s+)?function\s+(?:ingredient)?[Ii]dentityPayload\b|(?:const|let)\s+[Ii]dentityPayload\s*[=:]/.test(text);
    });
    expect(owners).toEqual([OWNER]);
  });

  it('no module other than the owner exports or re-implements the primitive', () => {
    const src = walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    const definers = src.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /export\s+function\s+ingredientIdentityPayload\b/.test(text) ||
             /export\s+function\s+computeIngredientIdentityDigest\b/.test(text);
    });
    expect(definers).toEqual([OWNER]);

    // Nobody may re-derive the identity digest privately: a module that needs
    // it must import the shared helper. `digestOf` alone is a general-purpose
    // digest utility, so only the two canonical payload entry points are pinned.
    const localRebuilds = src.filter((f) => {
      const text = readFileSync(f, 'utf8');
      const buildsPayload = /function\s+[Ii]dentityPayload\b|(?:const|let)\s+[Ii]dentityPayload\s*[=:]/.test(text);
      return buildsPayload && !text.includes('identityEvidence');
    });
    expect(localRebuilds).toEqual([]);

    // Every consumer imports the one shared owner.
    const consumers = src.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /computeIngredientIdentityDigest|ingredientIdentityPayload/.test(text);
    });
    for (const f of consumers) {
      expect(readFileSync(f, 'utf8'), f).toContain('identityEvidence');
    }
  });

  it('the CALCULATOR consumes the shared helper and keeps its own verification', () => {
    const calc = readFileSync(join(SRC, 'core/nutritionV2/calculation/calculate.ts'), 'utf8');
    expect(calc).toContain("from './identityEvidence'");
    expect(calc).toContain('ingredientIdentityPayload as identityPayload');
    // It must NOT redefine the primitive locally any more.
    expect(calc).not.toMatch(/function\s+ingredientIdentityPayload\b/);
    expect(calc).not.toMatch(/function\s+digestOf\b/);
    // The calculator remains the final INDEPENDENT verifier.
    expect(calc).toContain('selection.ingredient_identity_digest !== identityDigest');
  });

  it('App, the UI and the application adapter never implement hashing', () => {
    for (const rel of [
      'App.tsx',
      'components/AdvancedNutritionCard.tsx',
      'components/AdvancedNutritionModal.tsx',
      'components/RecipeNutritionSection.tsx',
      'components/RecipeDetailView.tsx',
      'application/nutritionAiEstimate.ts',
    ]) {
      if (!existsSync(join(REPO, rel))) continue;
      const text = read(rel);
      expect(text, rel).not.toMatch(/sha256/i);
      expect(text, rel).not.toMatch(/canonicalStringify/);
      expect(text, rel).not.toMatch(/identityPayload/);
    }
  });

  it('identity evidence is NOT persisted anywhere', () => {
    for (const rel of [
      'src/core/nutritionV2/schema.ts',
      'src/application/advancedNutritionApply.ts',
      'src/core/nutritionV2/phase5/authorize.ts',
    ]) {
      if (!existsSync(join(REPO, rel))) continue;
      const text = read(rel);
      expect(text, rel).not.toMatch(/ai_estimate_evidence|identityEvidenceByLine/);
    }
  });

  // -------------------------------------------------------------------------
  // FINAL ARCHITECTURE PINS (AI-3 proof package)
  // -------------------------------------------------------------------------
  // Scoped to the AI-3 SLICE. `hydrate.ts` legitimately reads a
  // `record_digest` for Phase-4 session hydration and is NOT an AI-3 owner.
  const AI3 = [
    'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
    'src/core/nutritionV2/phase4/aiEstimateIdentityEvidence.ts',
    'src/core/nutritionV2/phase4/aiEstimateResolve.ts',
    'src/core/nutritionV2/phase4/aiEstimateSelection.ts',
    'src/core/nutritionV2/phase4/aiEstimateAccept.ts',
    'src/core/nutritionV2/phase4/aiEstimateApplyGate.ts',
    'src/core/nutritionV2/aiAdvancedEstimate.ts',
    'src/core/nutritionV2/aiAdvancedEstimateWire.ts',
    'src/core/nutritionV2/aiEstimateBounds.ts',
    'src/application/nutritionAiEstimate.ts',
  ];

  it('the snapshot-binding owner is exactly one, and it consumes canonical evidence', () => {
    const owner = read('src/core/nutritionV2/phase4/aiEstimateValidation.ts');
    expect(owner.match(/export function deriveAiEstimateSnapshotInput/g) ?? []).toHaveLength(1);
    for (const rel of AI3) {
      if (rel === 'src/core/nutritionV2/phase4/aiEstimateValidation.ts') continue;
      expect(read(rel), rel).not.toContain('function deriveAiEstimateSnapshotInput');
    }
  });

  it('ZERO AI-3 production dependency on the nonexistent MatchChoice.record_digest', () => {
    // This field NEVER existed on a Phase-4 MatchChoice. Two readers of it made
    // the snapshot null for every line, so every offer was silently dropped.
    for (const rel of AI3) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/match\.record_digest/);
      expect(text, rel).not.toMatch(/currentMatch\.record_digest/);
    }
  });

  it('the loose sessionRecordDigests map does not exist', () => {
    for (const rel of AI3) expect(read(rel), rel).not.toContain('sessionRecordDigests');
    expect(read('src/application/nutritionAiEstimate.ts')).toContain('identityEvidence');
  });

  it('there is exactly one identity-evidence derivation owner and one hash owner', () => {
    const identity = read('src/core/nutritionV2/phase4/aiEstimateIdentityEvidence.ts');
    expect(identity.match(/export function deriveAiEstimateIdentityEvidence/g) ?? []).toHaveLength(1);
    expect(read('src/core/nutritionV2/calculation/identityEvidence.ts')).toContain('export function computeIngredientIdentityDigest');
  });

  it('App does not hash and owns the ONE production estimate callback', () => {
    const app = read('src/App.tsx');
    expect(app).not.toMatch(/sha256/i);
    expect(app).not.toMatch(/canonicalStringify/);
    expect(app.match(/const handleEstimateMassesWithAi/g) ?? []).toHaveLength(1);
    expect(app).toContain("'/api/nutrition/estimate-mass'");
  });

  it('the application adapter does not hash', () => {
    const adapter = read('src/application/nutritionAiEstimate.ts');
    expect(adapter).not.toMatch(/sha256/i);
    expect(adapter).not.toMatch(/canonicalStringify/);
    expect(adapter).not.toMatch(/createHash/);
  });

  it('capability authority is centralized and not forgeable from data', () => {
    const adapter = read('src/application/nutritionAiEstimate.ts');
    expect(adapter).toContain('const capabilities = input.capabilities;');
    expect(adapter).not.toMatch(/capabilities\.aiEstimation\s*=/);
    expect(adapter).not.toMatch(/entry\[['"]aiEstimation/);
  });

  it('the snapshot is NOT persisted anywhere', () => {
    for (const rel of [
      'src/core/nutritionV2/schema.ts',
      'src/application/advancedNutritionApply.ts',
      'src/core/nutritionV2/phase5/authorize.ts',
    ]) {
      if (!existsSync(join(REPO, rel))) continue;
      expect(read(rel), rel).not.toMatch(/snapshotBinding/);
    }
  });

  it('UI imports no server or provider implementation', () => {
    for (const rel of listFiles('src/components')) {
      if (!rel.endsWith('.tsx')) continue;
      const text = read(rel);
      expect(text, rel).not.toMatch(/from ['"].*server\//);
      expect(text, rel).not.toMatch(/nutritionEstimate['"]|estimateMassOnServer/);
    }
  });
});

// ---------------------------------------------------------------------------
// M49 — post-await live-state re-read security pins
// ---------------------------------------------------------------------------
describe('AI-3 M49 — mid-flight currentness authority is not forgeable', () => {
  const ADAPTER = 'src/application/nutritionAiEstimate.ts';

  function src(rel: string): string {
    return readFileSync(join(process.cwd(), rel), 'utf8');
  }

  it('current state is obtained through ONE injected read-only getter', () => {
    const source = src(ADAPTER);
    // The getter is REQUIRED on the orchestration deps, never optional.
    expect(source).toContain('readonly getCurrentState: () => AiEstimateReconcileState;');
    // No captured-state dependency survives.
    expect(source).not.toContain('readonly currentState: AiEstimateReconcileState;');
  });

  it('the post-await re-read EXISTS and reconciliation uses the NOW state', () => {
    const source = src(ADAPTER);
    // A read AFTER the transport await, used for the reconcile call.
    expect(source).toMatch(/currentState: deps\.getCurrentState\(\)/);
    // The request-start state is captured, but is NEVER the reconcile input.
    expect(source).toContain('const requestStartState = deps.getCurrentState();');
    expect(source).not.toMatch(/currentState: requestStartState/);
  });

  it('current state cannot come from request, model, network or response data', () => {
    const source = src(ADAPTER);
    // The getter is only ever invoked; never constructed from request data.
    expect(source).not.toMatch(/getCurrentState\s*[:=]\s*\(?\s*request/);
    expect(source).not.toMatch(/getCurrentState\s*[:=]\s*\(?\s*response/);
    expect(source).not.toMatch(/getCurrentState\s*\([^)]*estimates/);
  });

  it('no global mutable singleton state authority is introduced', () => {
    const source = src(ADAPTER);
    expect(source).not.toMatch(/globalThis\.[A-Za-z_$]+\s*=/);
    expect(source).not.toMatch(/let\s+currentPhase4State\b/);
  });

  it('there is exactly ONE state-authority helper -- no duplicate copy', () => {
    const source = src(ADAPTER);
    const definitions = source.match(/getCurrentState/g) ?? [];
    // Every mention is either the dep declaration, the adapter input, or a
    // call site -- and there is no second implementation of the concept.
    expect(source).not.toMatch(/function\s+getCurrentState/);
    expect(source.match(/readonly getCurrentState/g) ?? []).toHaveLength(2); // deps + adapter input
  });
});
