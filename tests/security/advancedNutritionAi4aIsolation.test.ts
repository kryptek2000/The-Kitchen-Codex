/**
 * AI-4A — ISOLATION: ZERO NETWORK, ZERO REACHABILITY, ZERO AUTHORITY WIRING.
 *
 * AI-4A is INERT. These are the structural pins that keep it inert: no provider,
 * no route, no limiter, no UI, no reducer, no persistence, and no path from the
 * live Advanced Nutrition workflow into the new modules.
 *
 * HONEST LIMITATION
 *  Static source pins go red whenever a file changes, so on their own they
 *  cannot distinguish "AI-4A has no authority" from "AI-4A has no authority
 *  *today*". The behavioural half of that proof lives in
 *  `advancedNutritionAi4aAuthorityDifferential.test.ts`, which drives the REAL
 *  production functions with a VALID accepted AI-4 context and observes that no
 *  nutrition truth moves. This file covers what behaviour alone cannot: absence
 *  of wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.cwd();
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

const CONTRACT = 'src/core/nutritionV2/phase4/recipeContextContract.ts';
const SNAPSHOT = 'src/core/nutritionV2/phase4/recipeContextSnapshot.ts';
const AI4A_MODULES: ReadonlyArray<string> = [CONTRACT, SNAPSHOT];

/**
 * Source with every comment removed, so a pin can never be satisfied (or
 * defeated) by prose. Documentation legitimately mentions `provider`, `route`,
 * `cache` and `limiter`; only CODE may be pinned against those words.
 */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\*\*?[\s\S]*$/, ' ');
}

function codeOf(rel: string): string {
  return code(rel);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(REPO, full));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. ZERO NETWORK PROOF (§18)
// ---------------------------------------------------------------------------
describe('AI-4A isolation — ZERO network capability exists', () => {
  it('no AI-4A module contains fetch, storage, env or timer network access', () => {
    for (const rel of AI4A_MODULES) {
      const source = codeOf(rel);
      for (const banned of [
        'fetch(',
        'XMLHttpRequest',
        'navigator.',
        'axios',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'document.cookie',
        'process.env',
        'require(',
        'WebSocket',
        'EventSource',
      ]) {
        expect(source, `${rel} must not contain ${banned}`).not.toContain(banned);
      }
    }
  });

  it('no AI-4A module imports a server, provider, transport or network module', () => {
    for (const rel of AI4A_MODULES) {
      const source = codeOf(rel);
      for (const banned of [
        '/server/',
        'server/',
        'aiEndpointAuth',
        'requireAiAccessToken',
        'AI_ENDPOINT_TOKEN',
        'provider',
        'Provider',
        'generateStructured',
        'resolveRoleCandidates',
        'openRouter',
        'OpenRouter',
        'gemini',
        'Gemini',
        'genAI',
        'apikey',
        'apiKey',
        'API_KEY',
        'capabilityVerification',
        'textPricingGuard',
        'rateLimiter',
        'RateLimiter',
      ]) {
        expect(source, `${rel} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });

  it('no AI-4A module declares a route, a limiter or a network host', () => {
    for (const rel of AI4A_MODULES) {
      const source = codeOf(rel);
      for (const banned of [
        '/api/',
        'app.post',
        'app.get',
        'express',
        'http://',
        'https://',
        'nal.usda.gov',
        'openrouter.ai',
        'generativelanguage',
        'Retry-After',
        'RateLimit-',
      ]) {
        expect(source, `${rel} must not contain ${banned}`).not.toContain(banned);
      }
    }
  });

  it('AI-4A is not exported from the nutrition barrel', () => {
    const barrel = src('src/core/nutritionV2/index.ts');
    expect(barrel).not.toContain('recipeContext');
    expect(barrel).not.toContain('RecipeContext');
  });

  it('the new modules are NOT reachable from any server module', () => {
    const offenders: string[] = [];
    for (const rel of walk(join(REPO, 'server'))) {
      const source = src(rel);
      if (source.includes('recipeContextContract') || source.includes('recipeContextSnapshot')) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the new modules are NOT reachable from the live Advanced Nutrition workflow', () => {
    const live: ReadonlyArray<string> = [
      'src/App.tsx',
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
      'src/components/RecipeDetailView.tsx',
      'src/components/RecipeNutritionSection.tsx',
      'src/components/AdvancedNutritionCard.tsx',
      'src/application/advancedNutritionApply.ts',
      'src/application/nutritionAiEstimate.ts',
      'src/core/nutritionV2/phase4/state.ts',
      'src/core/nutritionV2/phase4/types.ts',
      'src/core/nutritionV2/phase4/analyzer.ts',
      'src/core/nutritionV2/phase4/session.ts',
      'src/core/nutritionV2/phase4/rows.ts',
      'src/core/nutritionV2/phase4/adapt.ts',
      'src/core/nutritionV2/phase4/liveRow.ts',
      'src/core/nutritionV2/calculation/calculate.ts',
      'src/core/nutritionV2/calculation/effectiveMass.ts',
    ];
    for (const rel of live) {
      const source = src(rel);
      expect(source, rel).not.toContain('recipeContextContract');
      expect(source, rel).not.toContain('recipeContextSnapshot');
      expect(source, rel).not.toContain('ai_recipe_context');
      expect(source, rel).not.toContain('RecipeContextEnvelope');
    }
  });

  it('AI-4A adds NO route and NO limiter', () => {
    const app = src('server/app.ts');
    expect(app).not.toContain('recipe-context');
    expect(app).not.toContain('recipeContext');
    const limiter = src('server/rateLimiter.ts');
    expect(limiter).not.toContain('RecipeContext');
    expect(limiter).not.toContain('nutr_context_');
  });

  it('AI-4A adds NO capability gate and NO capability key', () => {
    const capabilities = src('src/core/nutritionV2/nutritionCapabilities.ts');
    expect(capabilities).not.toContain('recipeContext');
    expect(capabilities).not.toContain('aiRecipeContext');
  });
});

// ---------------------------------------------------------------------------
// 2. EXACTLY ONE CONTRACT OWNER
// ---------------------------------------------------------------------------
describe('AI-4A isolation — exactly ONE contract owner', () => {
  it('the contract version token is declared exactly once in the whole repository', () => {
    const owners: string[] = [];
    for (const rel of walk(join(REPO, 'src'))) {
      const source = src(rel);
      const matches = source.split('nutrition_ai_recipe_context_v1').length - 1;
      // The declaring module may mention it in docs; only ONE file may ASSIGN it.
      if (/export const AI_RECIPE_CONTEXT_CONTRACT_VERSION\s*=/.test(source)) owners.push(rel);
      expect(matches, rel).toBeLessThan(6);
    }
    expect(owners).toEqual([CONTRACT]);
  });

  it('each sanitizer and validator has exactly one defininer', () => {
    const symbols = [
      'sanitizeRecipeContextEnvelope',
      'sanitizeAiRecipeContextProposal',
      'validateAiRecipeContextRelationGraph',
      'sanitizeRecipeContextSnapshotInput',
      'recipeContextSnapshotBinding',
      'recipeContextSnapshotDigest',
      'isRecipeContextSnapshotCurrent',
    ];
    for (const symbol of symbols) {
      const owners: string[] = [];
      for (const rel of walk(join(REPO, 'src'))) {
        if (new RegExp(`export (async )?function ${symbol}\\b`).test(src(rel))) owners.push(rel);
      }
      expect(owners, symbol).toHaveLength(1);
      expect(owners[0], symbol).toMatch(/recipeContext(Contract|Snapshot)\.ts$/);
    }
  });

  it('the provenance class token is declared exactly once', () => {
    const owners: string[] = [];
    for (const rel of walk(join(REPO, 'src'))) {
      if (/export const AI_RECIPE_CONTEXT_PROVENANCE_CLASS\s*=/.test(src(rel))) owners.push(rel);
    }
    expect(owners).toEqual([CONTRACT]);
  });
});

// ---------------------------------------------------------------------------
// 3. PRIVACY BOUNDARY (§17)
// ---------------------------------------------------------------------------
describe('AI-4A privacy boundary — the exact allowed key set', () => {
  it('the contract module names no excluded private field as an allowed key', () => {
    const source = codeOf(CONTRACT);
    const allowedBlock = source.slice(
      source.indexOf('const ENVELOPE_KEYS'),
      source.indexOf('const TARGET_KEYS')
    );
    const targetBlock = source.slice(
      source.indexOf('const TARGET_KEYS'),
      source.indexOf('const TARGET_KEYS') + 400
    );
    const combined = `${allowedBlock}${targetBlock}`;
    for (const excluded of [
      'notes',
      'description',
      'tags',
      'category',
      'cuisine',
      'image',
      'rawMarkdown',
      'frontmatter',
      'dataviewFields',
      'wikilinks',
      'filePath',
      'fileName',
      'recipe_key',
      'sessionIdentity',
      'request_id',
      'instructions',
      'calories',
      'nutrition',
      'FdcId',
      'Digest',
      'apiKey',
      'credential',
    ]) {
      expect(combined, excluded).not.toContain(`'${excluded}'`);
    }
  });

  it('the contract module names no excluded private field in the snapshot key set', () => {
    const source = codeOf(SNAPSHOT);
    const snapshotKeys = source.slice(
      source.indexOf('const SNAPSHOT_KEYS'),
      source.indexOf('const SNAPSHOT_TARGET_KEYS')
    );
    const targetKeys = source.slice(
      source.indexOf('const SNAPSHOT_TARGET_KEYS'),
      source.indexOf('const SNAPSHOT_TARGET_KEYS') + 400
    );
    for (const excluded of [
      'notes',
      'filePath',
      'fileName',
      'recipe_key',
      'sessionIdentity',
      'rawMarkdown',
      'instructions',
      'tags',
      'fdc_id',
      'record_digest',
      'catalog_digest',
      'apiKey',
    ]) {
      expect(`${snapshotKeys}${targetKeys}`, excluded).not.toContain(`'${excluded}'`);
    }
  });

  it('the snapshot module never binds a file path or a file name as CODE', () => {
    const source = codeOf(SNAPSHOT);
    // Documented as deliberately excluded, so the words may appear in PROSE but
    // must never appear as a string literal in code.
    for (const excluded of ["'filePath'", "'fileName'", "'rawMarkdown'", "'id'", "'wikilinks'"]) {
      expect(source, excluded).not.toContain(excluded);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. AI-3 CLEARED EVIDENCE IS UNTOUCHED
// ---------------------------------------------------------------------------
describe('AI-4A isolation — AI-3 cleared evidence is untouched', () => {
  it('the AI-3 mutation manifest is not modified by AI-4A', () => {
    const manifest = src('scripts/ai3_mutation_manifest.json');
    // The cleared corpus is AI-3 historical evidence; AI-4 must not append to it.
    expect(manifest).not.toContain('ai_recipe_context');
    expect(manifest).not.toContain('AI4-A');
    expect(manifest).not.toContain('recipe_context');
  });

  it('the AI-3 mutation executor is not modified by AI-4A', () => {
    const executor = src('scripts/verify_ai3_mutations.py');
    expect(executor).not.toContain('ai_recipe_context');
    expect(executor).not.toContain('recipeContext');
  });

  it('the AI-3 production verifier is not modified by AI-4A', () => {
    const verifier = src('scripts/verify_ai3_estimate_prod.ts');
    expect(verifier).not.toContain('recipeContext');
    expect(verifier).not.toContain('ai_recipe_context');
  });

  it('the AI-3 estimate contract is byte-unchanged in shape: no AI-4 concepts', () => {
    for (const rel of [
      'src/core/nutritionV2/aiAdvancedEstimate.ts',
      'src/core/nutritionV2/aiAdvancedEstimateWire.ts',
      'src/core/nutritionV2/phase4/aiEstimateApplyGate.ts',
    ]) {
      expect(src(rel), rel).not.toContain('RecipeContext');
      expect(src(rel), rel).not.toContain('ai_recipe_context');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. DOCUMENTED SCOPE OF AI-4A
// ---------------------------------------------------------------------------
describe('AI-4A isolation — AI-4A does only what AI-4A is allowed to do', () => {
  it('no instruction extractor, recipe wiring, orchestration or UI shipped', () => {
    const all = AI4A_MODULES.map(codeOf).join('\n');
    for (const outOfScope of [
      'ObsidianRecipe',
      'adaptRecipe',
      'analyzeRecipe',
      'phase4Reducer',
      'dispatch',
      'useState',
      'data-testid',
      'cache',
      'localStorage',
      'fetch',
      'route',
      'limiter',
      'suppressAi3',
      'autoAccept',
    ]) {
      expect(all, outOfScope).not.toContain(outOfScope);
    }
  });

  it('the snapshot module imports nothing that could perform I/O', () => {
    const source = codeOf(SNAPSHOT);
    for (const banned of ['node:', "'fs'", "'path'", "'http'", "'https'", "'net'", "'os'", "'child_process'"]) {
      expect(source, banned).not.toContain(banned);
    }
  });

  it('the contract module is inert data plus pure functions only', () => {
    const source = codeOf(CONTRACT);
    expect(source).not.toContain('await ');
    expect(source).not.toContain('async function');
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('Math.random');
  });

  it('the snapshot binding is deterministic: no clock, no randomness', () => {
    const source = codeOf(SNAPSHOT);
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Math.random');
  });
});