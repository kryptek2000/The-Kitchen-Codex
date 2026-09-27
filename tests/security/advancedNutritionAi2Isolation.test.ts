/**
 * The Kitchen Codex — AI-2A candidate authority foundation: isolation + scope.
 *
 * Static, provider-free assertions pinning the architecture of the slice:
 *   - the AI-2A modules are PURE core modules: no persistence/storage/vault, no
 *     server, no UI/React, no provider or network module, no bounded estimate;
 *   - no production route, application caller, or UI wiring exists yet (AI-2A is
 *     provable with injected fixtures alone);
 *   - the frozen AI-0 contracts are unchanged and never import AI-2A backward;
 *   - the AI-1 live path stays untouched by this slice;
 *   - no focused/skipped test and no secret/absolute path ships with it.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { AI_ADVANCED_PLAN_VERSION, MAX_AI_ADVANCED_PLANS } from '../../src/core/nutritionV2/aiAdvancedPlan';
import { MAX_AI_ADVANCED_CANDIDATES } from '../../src/core/nutritionV2/aiAdvancedCandidates';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';
import { isAiEstimationEnabled } from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { MAX_AI_ADVANCED_PLAN_LINES, MAX_AI_ADVANCED_PLAN_REQUEST_BYTES } from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import { AI_ADVANCED_PLAN_SOURCE_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import { AI_ADVANCED_PLAN_APPLY_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlanApply';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO, relativePath), 'utf8');
}

const AI2A_MODULES = [
  'src/core/nutritionV2/aiAdvancedPlanRequest.ts',
  'src/core/nutritionV2/aiAdvancedPlanSource.ts',
  'src/core/nutritionV2/aiAdvancedPlanApply.ts',
] as const;

const AI2A_TESTS = [
  'tests/unit/advancedNutritionAi2PlanSource.test.ts',
  'tests/unit/advancedNutritionAi2PlanApply.test.ts',
  'tests/unit/advancedNutritionAi2Corpus.test.ts',
  'tests/security/advancedNutritionAi2Isolation.test.ts',
] as const;

const FROZEN_MODULES = [
  'src/core/nutritionV2/aiAdvancedPlan.ts',
  'src/core/nutritionV2/aiAdvancedCandidates.ts',
  'src/core/nutritionV2/aiAdvanced.ts',
  'src/core/nutritionV2/aiAdvancedEstimate.ts',
] as const;

function importSpecifiers(source: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) out.push(match[1]!);
  for (const match of source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)) out.push(match[1]!);
  return out;
}

describe('AI-2A isolation — pure core modules with no side channels', () => {
  it('imports only its own core siblings and a closed allowlist', () => {
    const allowlist: Record<string, ReadonlyArray<string>> = {
      'src/core/nutritionV2/aiAdvancedPlanSource.ts': [
        './aiAdvancedCandidates',
        './aiAdvanced',
        './aiResolution',
      ],
      'src/core/nutritionV2/aiAdvancedPlanRequest.ts': [
        './schema',
        './aiAdvancedPlan',
        './aiAdvancedCandidates',
        './aiAdvancedPlanSource',
      ],
      'src/core/nutritionV2/aiAdvancedPlanApply.ts': [
        './aiAdvancedPlan',
        './aiResolution',
        './aiAdvancedPlanRequest',
      ],
    };
    for (const file of AI2A_MODULES) {
      for (const specifier of importSpecifiers(read(file))) {
        expect(
          allowlist[file]!.includes(specifier),
          `${file} imports unexpected module ${specifier}`
        ).toBe(true);
      }
    }
  });

  it('never imports Phase 2 matching directly (audited layering rule)', () => {
    // `tests/security/usdaMatchingIsolation.test.ts` allows `matching/*` to be
    // imported ONLY by the Phase 4 review/display boundary (plus Phase 3/5C).
    // AI-2A therefore takes deterministic acceptance through an injected PORT
    // instead of importing Phase 2 itself.
    for (const file of AI2A_MODULES) {
      for (const specifier of importSpecifiers(read(file))) {
        expect(specifier.includes('matching'), `${file} imports Phase 2 (${specifier})`).toBe(false);
      }
    }
    const apply = read('src/core/nutritionV2/aiAdvancedPlanApply.ts');
    expect(apply).toContain('deterministicAcceptance');
    expect(apply).toContain('invalid_acceptance_port');
    // The bare identifiers may appear in doc comments; a CALL to any Phase 2
    // predicate may not exist in this pure module.
    for (const predicate of [
      'selectAutomaticMatch',
      'selectBestEffortMatch',
      'isDeterministicBestEffortSelection',
      'isDeterministicAutomaticSelection',
    ]) {
      expect(apply.includes(`${predicate}(`), `Phase 2 call in a pure module: ${predicate}`).toBe(false);
    }
  });

  it('names no persistence, storage, vault, server, UI, provider or estimate module', () => {
    const forbidden = [
      'server/',
      'src/application',
      'application/',
      'components/',
      'react',
      'storage',
      'vault',
      'persist',
      'Estimate',
      'estimate',
      'provider',
      'adapters',
      'fs',
      'node:',
    ];
    for (const file of AI2A_MODULES) {
      const source = read(file);
      for (const token of forbidden) {
        expect(source.includes(`'${token}`) && source.includes(`from '${token}`), `${file} imports ${token}`).toBe(false);
      }
    }
  });

  it('contains no network, I/O or async side channel at all', () => {
    for (const file of AI2A_MODULES) {
      const source = read(file);
      for (const token of [
        'fetch(',
        'XMLHttpRequest',
        'NetworkAdapter',
        'http://',
        'https://',
        'setTimeout(',
        'localStorage',
        'indexedDB',
        'async ',
        'await ',
        'process.',
        'Date.now(',
        'Math.random(',
      ]) {
        expect(source.includes(token), `${file} contains ${token}`).toBe(false);
      }
    }
  });

  it('is not wired into any production route, application caller or UI', () => {
    const surfaces = [
      'server/app.ts',
      'src/App.tsx',
      'src/application/nutritionAiResolve.ts',
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
    ];
    for (const file of surfaces) {
      const source = read(file);
      for (const token of ['aiAdvancedPlanRequest', 'aiAdvancedPlanSource', 'aiAdvancedPlanApply']) {
        expect(source.includes(token), `${file} references ${token}`).toBe(false);
      }
    }
    // No plan route exists anywhere on the server.
    const app = read('server/app.ts');
    expect(app.includes('plan-ingredients')).toBe(false);
    expect(app.includes('nutritionPlan')).toBe(false);
    // The server tree has no AI-2A adapter yet.
    expect(read('server/app.ts').includes('aiAdvancedPlan')).toBe(false);
  });

  it('keeps the AI-1 live path and the AI-0 contract pins untouched', () => {
    expect(AI_ADVANCED_CONTRACT_VERSION).toBe('nutrition_ai_advanced_interpretation_v1');
    expect(AI_ADVANCED_PLAN_VERSION).toBe('nutrition_ai_advanced_plan_v1');
    expect(MAX_AI_ADVANCED_CANDIDATES).toBe(12);
    expect(MAX_AI_ADVANCED_PLANS).toBe(25);
    expect(MAX_AI_ADVANCED_PLAN_LINES).toBe(12);
    expect(MAX_AI_ADVANCED_PLAN_REQUEST_BYTES).toBe(32 * 1024);
    expect(AI_ADVANCED_PLAN_SOURCE_VERSION).toBe('nutrition_ai_advanced_plan_source_v1');
    expect(AI_ADVANCED_PLAN_APPLY_VERSION).toBe('nutrition_ai_advanced_plan_apply_v1');
    // The live canonical AI-1 path still exists and still owns its route.
    const application = read('src/application/nutritionAiResolve.ts');
    expect(application).toContain('liveCanonicalInterpretation');
    expect(read('server/app.ts')).toContain('/api/nutrition/interpret-ingredients');
  });

  it('the frozen AI-0 modules never import the AI-2A slice backward', () => {
    for (const file of FROZEN_MODULES) {
      const source = read(file);
      for (const token of ['aiAdvancedPlanRequest', 'aiAdvancedPlanSource', 'aiAdvancedPlanApply']) {
        expect(source.includes(token), `${file} imports ${token}`).toBe(false);
      }
    }
    // Bounded estimation stays disabled and unwired.
    expect(isAiEstimationEnabled()).toBe(false);
    for (const file of [...AI2A_MODULES, ...FROZEN_MODULES]) {
      expect(read(file).includes('resolveAiBoundedEstimate')).toBe(file.includes('aiAdvancedEstimate'));
    }
  });

  it('ships no focused/skipped test, no secret and no absolute home path', () => {
    for (const file of AI2A_TESTS) {
      const source = read(file);
      expect(source).not.toMatch(/\.only\s*\(/);
      expect(source).not.toMatch(/\.(skip|todo)\s*\(/);
      expect(source).not.toMatch(/\/home\/sid/);
      expect(source).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      expect(source).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i);
    }
    for (const file of AI2A_MODULES) {
      const source = read(file);
      expect(source).not.toMatch(/\/home\/sid/);
      expect(source).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    }
  });
});