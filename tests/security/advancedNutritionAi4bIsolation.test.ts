/**
 * AI-4B — ISOLATION: NO PROVIDER, NO REACHABILITY, NO AUTHORITY, NO MEASUREMENT VOCABULARY.
 *
 * AI-4B is a deterministic, offline phrase matcher. These are the structural pins
 * that keep it exactly that: no network, no provider, no route, no limiter, no UI,
 * no reducer, no persistence, no clock, no randomness, and no path from the live
 * Advanced Nutrition workflow into the module.
 *
 * The two pins unique to AI-4B are worth calling out:
 *
 *  1. THE RULE TABLE CONTAINS NO MEASUREMENT VOCABULARY. Every rule trigger is a
 *     lowercase alphabetic English word that is not a canonical unit, not a
 *     household measure, and carries no digit. A rule therefore cannot fire on an
 *     amount, so no amount can ever be read as context.
 *
 *  2. AI-4B DOES NOT USE THE AI-4A INTERPRETATION VOCABULARY. A deterministic
 *     signal can never be emitted in the shape of a model's `role`, `relation` or
 *     `preparation_hint`, so the two can never be confused, merged, or silently
 *     upgraded into each other.
 *
 * HONEST LIMITATION
 *  Static source pins go red whenever a file changes, so on their own they cannot
 *  distinguish "AI-4B has no authority" from "AI-4B has no authority *today*". The
 *  behavioural proof lives in `advancedNutritionAi4bAuthorityDifferential.test.ts`,
 *  which drives the REAL production pipeline with a REAL AI-4B extraction in
 *  existence. This file covers what behaviour alone cannot: absence of wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { CANONICAL_UNITS } from '../../src/core/nutritionV2/units';
import {
  AI_RECIPE_CONTEXT_SIGNALS,
  AI_RECIPE_CONTEXT_SIGNAL_RULES,
  QUANTITY_CUE_GROUPS,
  RECIPE_CONTEXT_NAME_STOP_TOKENS,
} from '../../src/core/nutritionV2/phase4/recipeContextExtraction';

const REPO = process.cwd();
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
const EXTRACTION = 'src/core/nutritionV2/phase4/recipeContextExtraction.ts';
const AI4B_MODULES: ReadonlyArray<string> = [EXTRACTION];

/**
 * Source with every comment removed, so a pin can never be satisfied (or
 * defeated) by prose. Documentation legitimately mentions `provider`, `route` and
 * `mass`; only CODE may be pinned against those words.
 */
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

// ---------------------------------------------------------------------------
// 1. ZERO NETWORK / ZERO I/O
// ---------------------------------------------------------------------------
describe('AI-4B isolation — ZERO network, ZERO I/O capability exists', () => {
  it('no AI-4B module contains fetch, storage, env or timer access', () => {
    for (const rel of AI4B_MODULES) {
      const source = code(rel);
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
        'node:',
        "'fs'",
        "'path'",
        "'http'",
      ]) {
        expect(source, `${rel} must not contain ${banned}`).not.toContain(banned);
      }
    }
  });

  it('no AI-4B module imports a server, provider, transport or network module', () => {
    for (const rel of AI4B_MODULES) {
      const source = code(rel);
      for (const banned of [
        '/server/',
        'aiEndpointAuth',
        'requireAiAccessToken',
        'AI_ENDPOINT_TOKEN',
        'generateStructured',
        'openRouter',
        'gemini',
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

  it('no AI-4B module declares a route, a limiter or a network host', () => {
    for (const rel of AI4B_MODULES) {
      const source = code(rel);
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

  it('AI-4B is deterministic: no clock, no randomness, no locale, no async', () => {
    for (const rel of AI4B_MODULES) {
      const source = code(rel);
      for (const banned of [
        'Date.now',
        'new Date',
        'Math.random',
        'performance.now',
        'toLocale',
        'Intl.',
        'await ',
        'async function',
        'Promise',
      ]) {
        expect(source, `${rel} must not contain ${banned}`).not.toContain(banned);
      }
    }
  });

  it('AI-4B performs NO persistence, NO React and NO UI', () => {
    for (const rel of AI4B_MODULES) {
      const source = code(rel);
      for (const banned of [
        'codex_nutrition',
        'encodeCodexNutrition',
        'serializeRecipeToObsidianMarkdown',
        'applyAdvancedNutrition',
        'buildNutritionApplyPayload',
        'frontmatter',
        'from \'react\'',
        'data-testid',
        'useState',
        'dispatch',
      ]) {
        expect(source, `${rel} must not contain ${banned}`).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. NO REACHABILITY
// ---------------------------------------------------------------------------
describe('AI-4B isolation — AI-4B is not reachable from any live surface', () => {
  it('AI-4B is exported from NO barrel', () => {
    for (const barrel of [
      'src/core/nutritionV2/index.ts',
      'src/core/nutritionV2/phase4/index.ts',
      'src/core/index.ts',
    ]) {
      const source = src(barrel);
      expect(source, barrel).not.toContain('recipeContextExtraction');
      expect(source, barrel).not.toContain('extractRecipeContext');
    }
  });

  it('the module is reachable ONLY from the ONE derivation owner', () => {
    // AI-4B itself introduced no server reachability. `server/recipeContextDerivation.ts`
    // is the single authorized server consumer: the ONE owner of the deterministic
    // derivation chain, consumed by the AI-4C transport and the AI-4D1 reconciler
    // so neither can implement its own context derivation. This is a STRICTER pin
    // than "no server module", and it also forbids a second implementation.
    const offenders: string[] = [];
    for (const rel of walk(join(REPO, 'server'))) {
      if (src(rel).includes('recipeContextExtraction') || src(rel).includes('extractRecipeContext')) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual(['server/recipeContextDerivation.ts']);
    // And that authorized owner holds no authority, provider or persistence surface.
    const consumer = code('server/recipeContextDerivation.ts');
    for (const forbidden of [
      '/phase4/state',
      '/phase5/',
      'applyAdvancedNutrition',
      'authorizeNutritionPersistence',
      'aiEstimateAccept',
    ]) {
      expect(consumer.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('the module is NOT reachable from the live Advanced Nutrition workflow', () => {
    const live: ReadonlyArray<string> = [
      'src/App.tsx',
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
      'src/components/RecipeDetailView.tsx',
      'src/components/RecipeNutritionSection.tsx',
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
      'src/core/nutritionV2/phase5/authorize.ts',
    ];
    for (const rel of live) {
      const source = src(rel);
      expect(source, rel).not.toContain('recipeContextExtraction');
      expect(source, rel).not.toContain('extractRecipeContext');
      expect(source, rel).not.toContain('AI_RECIPE_CONTEXT_EXTRACTOR');
    }
  });

  it('AI-4B itself adds NO route and NO limiter entry', () => {
    // AI-4B remains INERT and unreachable from the live workflow. The ONE
    // `/api/nutrition/recipe-context` route and the `nutritionContextRateLimiter`
    // bucket belong to AI-4C (architecture section 51); neither names the AI-4B
    // extractor, and no AI-4B-shaped route or limiter entry exists.
    const app = src('server/app.ts');
    expect(app).not.toContain('recipeContextExtraction');
    expect(app).not.toContain('extractRecipeContext');
    expect(app).not.toContain('recipe-context-extract');
    const limiter = src('server/rateLimiter.ts');
    expect(limiter).not.toContain('recipeContextExtraction');
    expect(limiter).not.toContain('extractRecipeContext');
  });

  it('AI-4B adds NO capability gate and NO capability key', () => {
    const capabilities = src('src/core/nutritionV2/nutritionCapabilities.ts');
    expect(capabilities).not.toContain('recipeContext');
    expect(capabilities).not.toContain('RecipeContext');
    expect(capabilities).not.toContain('extractRecipeContext');
  });
});

// ---------------------------------------------------------------------------
// 3. EXACTLY ONE OWNER OF EVERY TOKEN IT REUSES
// ---------------------------------------------------------------------------
describe('AI-4B isolation — AI-4B re-owns nothing', () => {
  it('the contract version and provenance class are still declared exactly once', () => {
    for (const declaration of [
      'AI_RECIPE_CONTEXT_CONTRACT_VERSION',
      'AI_RECIPE_CONTEXT_PROVENANCE_CLASS',
    ]) {
      const owners: string[] = [];
      for (const rel of walk(join(REPO, 'src'))) {
        if (new RegExp(`export const ${declaration}\\s*=`).test(src(rel))) owners.push(rel);
      }
      expect(owners, declaration).toEqual(['src/core/nutritionV2/phase4/recipeContextContract.ts']);
    }
  });

  it('no AI-4A sanitizer or validator is redefined by AI-4B', () => {
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

  it('AI-4B defines exactly ONE exported function: the extractor', () => {
    const source = code(EXTRACTION);
    const exported = source.match(/export function \w+/g) ?? [];
    expect(exported).toEqual(['export function extractRecipeContext']);
  });

  it('AI-4B imports ONLY the local pure modules it is allowed to read', () => {
    const source = code(EXTRACTION);
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(specifiers.sort()).toEqual([
      '../schema',
      '../usda/digest',
      './materialize',
      './recipeContextContract',
      './types',
    ]);
  });

  it('AI-4B does NOT use the AI-4A INTERPRETATION vocabulary', () => {
    const source = code(EXTRACTION);
    for (const forbidden of [
      'AI_RECIPE_CONTEXT_ROLES',
      'AI_RECIPE_CONTEXT_RELATIONS',
      'AI_RECIPE_CONTEXT_PREPARATION_HINTS',
      'AI_RECIPE_CONTEXT_SINGLE_PARENT_RELATIONS',
      'AI_RECIPE_CONTEXT_ABSTAIN_REASONS',
      'AI_RECIPE_CONTEXT_CONFIDENCE_VALUES',
      'AiRecipeContextRole',
      'AiRecipeContextRelation',
      'AiRecipeContextPreparationHint',
      'AiRecipeContextAbstainReason',
      'AiRecipeContextConfidence',
      'AiRecipeContextInterpretation',
      'AiRecipeContextProposal',
      'sanitizeAiRecipeContextProposal',
      'validateAiRecipeContextRelationGraph',
      'divided_into',
      'reserved_from',
      'duplicate_of',
      'same_as',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('AI-4B exports NO authority-capable name', async () => {
    const module = await import('../../src/core/nutritionV2/phase4/recipeContextExtraction');
    const banned = [
      'calculate',
      'resolveEffectiveMassDecision',
      'applyAdvancedNutrition',
      'authorizeNutritionPersistence',
      'grams',
      'mass',
      'portion',
      'fraction',
      'yield',
      'nutrients',
      'fdcId',
      'confidence',
      'abstain',
      'provenance',
      'suppress',
    ];
    for (const name of Object.keys(module)) {
      const lowered = name.toLowerCase();
      for (const forbidden of banned) {
        expect(name, `${name} must not be authority-shaped (${forbidden})`).not.toContain(forbidden);
      }
      expect(lowered).not.toContain('interpret');
      expect(lowered).not.toContain('provenance');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE RULE TABLE IS FINITE, CLOSED, AND MEASUREMENT-FREE
// ---------------------------------------------------------------------------

/**
 * Measurement vocabulary. NO rule trigger, completion cue or quantity cue may be
 * one of these words: a rule that fires on a unit could read an amount as
 * context, which is exactly the failure AI-4B exists to make impossible.
 */
const HOUSEHOLD_MEASURES: ReadonlyArray<string> = [
  'cup',
  'cups',
  'tbsp',
  'tbs',
  'tsp',
  'oz',
  'ounce',
  'lb',
  'lbs',
  'pound',
  'ml',
  'l',
  'liter',
  'litre',
  'gal',
  'quart',
  'pint',
  'gallon',
  'portion',
  'portions',
  'serving',
  'servings',
  'piece',
  'pieces',
  'clove',
  'cloves',
  'slice',
  'slices',
  'pinch',
  'dash',
  'sprig',
  'sprigs',
  'half',
  'quarter',
  'dozen',
  'batch',
  'batches',
  'gram',
  'grams',
];

const CANONICAL_UNIT_TOKENS: ReadonlySet<string> = new Set<string>(Object.keys(CANONICAL_UNITS));

/**
 * Words that denote an AMOUNT OF THE FOOD ITSELF. A stop token is dropped from an
 * ingredient name before it is matched against an instruction, so none of these
 * may ever be stoppable: dropping `half` from "half chicken" would let a bare
 * "chicken" satisfy the whole name.
 *
 * Role tails ("for serving", "for garnish", "divided") are deliberately NOT in
 * this list: they are the parser's role markers, they never denote an amount of
 * the food, and requiring an instruction to contain them would defeat subject
 * reference for every "parsley, for garnish" line.
 */
const AMOUNT_OF_FOOD_WORDS: ReadonlyArray<string> = [
  'half',
  'halves',
  'quarter',
  'quarters',
  'third',
  'thirds',
  'portion',
  'portions',
  'piece',
  'pieces',
  'cup',
  'cups',
  'tbsp',
  'tbs',
  'tsp',
  'oz',
  'ounce',
  'ounces',
  'lb',
  'lbs',
  'pound',
  'pounds',
  'gram',
  'grams',
  'ml',
  'liter',
  'litre',
  'quart',
  'pint',
  'gallon',
  'dozen',
  'batch',
  'batches',
  'pinch',
  'dash',
  'clove',
  'cloves',
  'slice',
  'slices',
  'sprig',
  'sprigs',
];

describe('AI-4B rule table — finite, closed, and free of any measurement vocabulary', () => {
  it('every rule emits a CLOSED signal token', () => {
    for (const rule of AI_RECIPE_CONTEXT_SIGNAL_RULES) {
      expect(AI_RECIPE_CONTEXT_SIGNALS).toContain(rule.signal);
    }
    // And the signal vocabulary itself stays exactly the six documented tokens.
    expect([...AI_RECIPE_CONTEXT_SIGNALS]).toEqual([
      'partial_use',
      'not_consumed',
      'preparation_only',
      'garnish_only',
      'transformation',
      'division',
    ]);
  });

  it('the rule table is finite and every trigger is a non-empty token phrase', () => {
    expect(AI_RECIPE_CONTEXT_SIGNAL_RULES.length).toBeGreaterThan(0);
    expect(AI_RECIPE_CONTEXT_SIGNAL_RULES.length).toBeLessThanOrEqual(256);
    for (const rule of AI_RECIPE_CONTEXT_SIGNAL_RULES) {
      expect(rule.trigger.length).toBeGreaterThan(0);
      expect(rule.trigger.length).toBeLessThanOrEqual(3);
    }
  });

  it('every OBSERVING token is alphabetic and is never a unit or a measure', () => {
    // Triggers and completion cues are the tokens that can make AI-4B OBSERVE
    // something, so none of them may be a measuring word: a rule that fires on
    // "cup" or "half" could read an amount as context.
    const observing = [
      ...AI_RECIPE_CONTEXT_SIGNAL_RULES.flatMap((rule) => rule.trigger),
      ...AI_RECIPE_CONTEXT_SIGNAL_RULES.flatMap((rule) => rule.completion.flat()),
    ];
    for (const token of observing) {
      expect(token, token).toMatch(/^[a-z]+$/);
      expect(CANONICAL_UNIT_TOKENS.has(token), token).toBe(false);
      for (const measure of HOUSEHOLD_MEASURES) expect(token, token).not.toBe(measure);
    }
    // Veto groups are the opposite: they only REFUSE a signal, so a measuring
    // word there is safe (and useful — "for serving" must not become context).
    // They are still pinned to plain lowercase alphabetic tokens.
    for (const group of QUANTITY_CUE_GROUPS) {
      for (const token of group) expect(token, token).toMatch(/^[a-z]+$/);
    }
  });

  it('the stop list is closed, tiny, and drops no word that names an amount of food', () => {
    const stop = [...RECIPE_CONTEXT_NAME_STOP_TOKENS];
    expect(stop.length).toBeGreaterThan(0);
    expect(stop.length).toBeLessThanOrEqual(32);
    for (const token of stop) {
      expect(token).toMatch(/^[a-z]+$/);
      expect(CANONICAL_UNIT_TOKENS.has(token), token).toBe(false);
      for (const amount of AMOUNT_OF_FOOD_WORDS) expect(token, token).not.toBe(amount);
    }
    // The stop list governs SUBJECT reference only; it is deliberately a
    // different vocabulary from the phrase triggers, so a token may appear in
    // both without any interaction (nothing in this module reads a name token as
    // a trigger, or a trigger as a name token).
  });

  it('the quantity-cue veto can never permanently silence a rule', () => {
    expect(QUANTITY_CUE_GROUPS.length).toBeGreaterThan(0);
    expect(QUANTITY_CUE_GROUPS.length).toBeLessThanOrEqual(64);
    // A veto group that CONTAINS a trigger phrase (contiguously) would refuse
    // exactly the clauses that rule exists to observe.
    for (const rule of AI_RECIPE_CONTEXT_SIGNAL_RULES) {
      for (const group of QUANTITY_CUE_GROUPS) {
        expect(
          group.join(' ').includes(rule.trigger.join(' ')),
          `veto "${group.join(' ')}" must not contain trigger "${rule.trigger.join(' ')}"`
        ).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. AI-3 CLEARED EVIDENCE IS UNTOUCHED
// ---------------------------------------------------------------------------
describe('AI-4B isolation — AI-3 cleared evidence and the authority chain are untouched', () => {
  it('the AI-3 mutation manifest, executor and production verifier are unmodified', () => {
    for (const rel of [
      'scripts/ai3_mutation_manifest.json',
      'scripts/verify_ai3_mutations.py',
      'scripts/verify_ai3_estimate_prod.ts',
    ]) {
      const source = src(rel);
      expect(source, rel).not.toContain('recipeContextExtraction');
      expect(source, rel).not.toContain('extractRecipeContext');
      expect(source, rel).not.toContain('ai_recipe_context');
    }
  });

  it('the AI-3 authority chain contains no AI-4B concept', () => {
    for (const rel of [
      'src/core/nutritionV2/aiAdvancedEstimate.ts',
      'src/core/nutritionV2/aiAdvancedEstimateWire.ts',
      'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
      'src/core/nutritionV2/phase4/aiEstimateAccept.ts',
      'src/core/nutritionV2/phase4/aiEstimateApplyGate.ts',
      'src/core/nutritionV2/phase4/aiEstimateResolve.ts',
      'src/core/nutritionV2/phase4/aiEstimateSelection.ts',
      'src/core/nutritionV2/calculation/calculate.ts',
      'src/core/nutritionV2/calculation/effectiveMass.ts',
      'src/core/nutritionV2/phase4/adapt.ts',
      'src/core/nutritionV2/phase5/authorize.ts',
    ]) {
      const source = src(rel);
      expect(source, rel).not.toContain('recipeContextExtraction');
      expect(source, rel).not.toContain('extractRecipeContext');
    }
  });

  it('AI-4B adds NO seventh effective-mass claim', () => {
    const source = code(EXTRACTION);
    for (const claim of [
      'hasAiRecipeContext',
      'hasRecipeContext',
      'hasAi4',
      'directMassGrams',
      'EffectiveMassClaims',
    ]) {
      expect(source, claim).not.toContain(claim);
    }
  });
});
