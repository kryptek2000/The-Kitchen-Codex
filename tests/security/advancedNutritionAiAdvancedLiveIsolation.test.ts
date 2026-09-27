/**
 * AI-1 — CANONICAL LIVE PATH ISOLATION AND ARCHITECTURE INVARIANTS.
 *
 * Static, provider-free assertions that pin the ARCHITECTURE of the AI-1 slice:
 * the live canonical path stays provider-neutral, the two nutrition AI routes
 * never share a path or a response format, the prompt carries no authority, the
 * client never imports the server adapter, estimation stays disabled, and no
 * focused/skipped test can hide a gap.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { NUTRITION_INTERPRET_INSTRUCTIONS } from '../../server/nutritionInterpret.js';
import {
  NUTRITION_AI_STATUS_ENDPOINT,
  NUTRITION_INTERPRET_ENDPOINT,
  NUTRITION_RESOLVE_ENDPOINT,
} from '../../src/application/nutritionAiResolve';
import { isAiEstimationEnabled } from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';
import { AI_RESOLUTION_VERSION } from '../../src/core/nutritionV2/aiResolution';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO, relativePath), 'utf8');
}

function sourceFiles(relativeDir: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO, relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(relative));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

const AI1_FILES = [
  'server/nutritionInterpret.ts',
  'src/core/nutritionV2/aiAdvancedSource.ts',
  'tests/unit/advancedNutritionInterpretLive.test.ts',
  'tests/unit/advancedNutritionAiAdvancedSource.test.ts',
  'tests/unit/advancedNutritionAiAdvancedSemanticCorpus.test.ts',
  'tests/security/nutritionInterpretRoute.test.ts',
  'tests/fixtures/aiAdvancedSemanticCorpus.ts',
];

describe('AI-1 isolation — one route per response format', () => {
  it('exposes three DISTINCT, versioned nutrition AI surfaces', () => {
    expect(NUTRITION_INTERPRET_ENDPOINT).toBe('/api/nutrition/interpret-ingredients');
    expect(NUTRITION_RESOLVE_ENDPOINT).toBe('/api/nutrition/resolve-ingredients');
    expect(NUTRITION_AI_STATUS_ENDPOINT).toBe('/api/providers');
    expect(new Set([
      NUTRITION_INTERPRET_ENDPOINT,
      NUTRITION_RESOLVE_ENDPOINT,
      NUTRITION_AI_STATUS_ENDPOINT,
    ]).size).toBe(3);
    // Two different canonical contracts, never mixed on one endpoint.
    expect(AI_ADVANCED_CONTRACT_VERSION).toBe('nutrition_ai_advanced_interpretation_v1');
    expect(AI_RESOLUTION_VERSION).toBe('nutrition_ai_resolution_v4');
    expect(AI_ADVANCED_CONTRACT_VERSION).not.toBe(AI_RESOLUTION_VERSION);
  });

  it('registers the canonical route exactly once with the full guard chain', () => {
    const app = read('server/app.ts');
    const registrations = app.match(/app\.post\(\s*"\/api\/nutrition\/interpret-ingredients"/g) ?? [];
    expect(registrations).toHaveLength(1);
    const line = app
      .split('\n')
      .find((entry) => entry.includes('"/api/nutrition/interpret-ingredients"')) ?? '';
    expect(line).toContain('requireAiAccessToken');
    expect(line).toContain('textPricingGuard');
    expect(line).toContain('nutritionInterpretRateLimiter');
    // The legacy v4 route is untouched and still registered exactly once.
    const legacy = app.match(/app\.post\(\s*"\/api\/nutrition\/resolve-ingredients"/g) ?? [];
    expect(legacy).toHaveLength(1);
  });

  it('keeps its OWN rate-limit bucket', () => {
    const limiter = read('server/rateLimiter.ts');
    expect(limiter).toContain('nutritionInterpretRateLimiter');
    expect(limiter).toContain('NUTRITION_INTERPRET_RATE_LIMIT');
    expect(limiter).toContain('nutr_interpret_');
  });
});

describe('AI-1 isolation — provider neutrality', () => {
  it('the canonical server adapter binds to no provider SDK or model', () => {
    const adapter = read('server/nutritionInterpret.ts');
    for (const forbidden of [
      'openai',
      'OpenAI',
      'gemini',
      '@google/genai',
      'anthropic',
      'deepseek',
      'openrouter',
      'groq',
      'gpt-',
      'claude-',
    ]) {
      expect(adapter.includes(forbidden), `adapter binds to ${forbidden}`).toBe(false);
    }
    // It reuses the generic provider infrastructure instead.
    expect(adapter).toContain('runWithAiFallback');
    expect(adapter).toContain('resolveExecutableTextCandidates');
  });

  it('the client application layer never imports a server module', () => {
    for (const file of sourceFiles('src')) {
      const source = read(file);
      expect(source.includes('/server/') || source.includes("'../../server"), `${file} imports server`).toBe(false);
    }
  });

  it('only the shell wires the canonical live path (the UI stays port-only)', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('liveCanonicalInterpretation: true');
    expect(app).toContain('resolveNutritionAiCapabilities');
    // The Advanced Nutrition UI never imports the application layer or the network.
    for (const file of ['src/components/AdvancedNutritionModal.tsx', 'src/components/AdvancedNutritionCard.tsx']) {
      const source = read(file);
      expect(source).not.toMatch(/from '\.\.\/application\//);
      expect(source).not.toMatch(/fetch\(|NetworkAdapter/);
    }
  });
});

describe('AI-1 isolation — the prompt carries semantics only', () => {
  it('explicitly prohibits every authority surface', () => {
    const prompt = NUTRITION_INTERPRET_INSTRUCTIONS.toLowerCase();
    for (const forbidden of [
      'fdc',
      'food-database',
      'gram',
      'density',
      'nutrient',
      'calorie',
      'portion gram weights',
      'authorization',
      'persistence',
      'digest',
      'tokens',
      'schema version',
    ]) {
      expect(prompt, `prompt does not forbid ${forbidden}`).toContain(forbidden);
    }
  });

  it('declares the ingredient text untrusted and forbids obeying it', () => {
    const prompt = NUTRITION_INTERPRET_INSTRUCTIONS.toLowerCase();
    expect(prompt).toMatch(/untrusted/);
    expect(prompt).toMatch(/ignore any instruction/);
    expect(prompt).toContain(AI_ADVANCED_CONTRACT_VERSION);
  });

  it('keeps the server sanitizer as the final truth (defence in depth)', () => {
    const adapter = read('server/nutritionInterpret.ts');
    expect(adapter).toContain('sanitizeAiAdvancedInterpretationResponse');
    expect(adapter).toContain('buildAiAdvancedInterpretationSchema');
    const application = read('src/application/nutritionAiResolve.ts');
    // Sanitized on the server AND re-sanitized in the application, twice.
    const occurrences = application.match(/sanitizeAiAdvancedInterpretationResponse\(/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

describe('AI-1 isolation — scope discipline', () => {
  it('keeps bounded estimation disabled and unwired', () => {
    expect(isAiEstimationEnabled()).toBe(false);
    const application = read('src/application/nutritionAiResolve.ts');
    const adapter = read('server/nutritionInterpret.ts');
    for (const source of [application, adapter]) {
      expect(source).not.toContain('aiAdvancedEstimate');
      expect(source).not.toContain('aiAdvancedCandidates');
      expect(source).not.toContain('aiAdvancedPlan');
    }
  });

  it('adds no focused or skipped test', () => {
    for (const file of AI1_FILES) {
      const source = read(file);
      expect(source).not.toMatch(/\.only\s*\(/);
      expect(source).not.toMatch(/\.(skip|todo)\s*\(/);
    }
  });

  it('ships no secret, no absolute home path, and no key material', () => {
    for (const file of AI1_FILES) {
      const source = read(file);
      expect(source).not.toMatch(/\/home\/sid/);
      expect(source).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      expect(source).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i);
    }
  });

  it('does not modify the AI-0 contract version or the frozen smoke corpus', () => {
    const aiAdvanced = read('src/core/nutritionV2/aiAdvanced.ts');
    expect(aiAdvanced).toContain("export const AI_ADVANCED_CONTRACT_VERSION = 'nutrition_ai_advanced_interpretation_v1'");
    // The AI-0 smoke corpus remains exactly as audited (its own file, unmodified).
    const smoke = read('tests/fixtures/aiAdvancedSmokeCorpus.ts');
    expect(smoke).toContain('AI_ADVANCED_SMOKE_CORPUS');
    expect(smoke).not.toContain('AI-1');
  });
});
