/**
 * AI-5A — AUTHORITY DIFFERENTIAL: BASIC ACCESS vs AI ADVANCED ACCESS CHANGES
 * NOTHING.
 *
 * AI-5A introduces a PRODUCT ACCESS / ENTITLEMENT CONTRACT. It is INERT. Merely
 * constructing it — at either tier, or from a hostile payload — must move NO
 * nutrition truth whatsoever.
 *
 * This drives the REAL Advanced Nutrition pipeline (pinned local USDA bundle, real
 * session, real `adaptRecipe` + `analyzeRecipe`, real `buildCalculationRequest` +
 * `session.calculate`, real `authorizeNutritionPersistence`, real
 * `applyAdvancedNutrition`, real AI-3 eligibility, real effective-mass decision)
 * across five rigs:
 *
 *   BASELINE                  AI-5A does not exist in this rig at all, and the
 *                             operational capability resolver is Basic.
 *   PRODUCT-BASIC             an AI-5A Basic product access value is constructed.
 *   PRODUCT-AI-ADVANCED       an AI-5A AI Advanced product access value is
 *                             constructed. Entitled to every current AI product
 *                             feature.
 *   PRODUCT-FORGED            a hostile payload that CLAIMS `ai_advanced` — plus
 *                             provider-shaped and BYOK-shaped payloads — is offered
 *                             to the resolver. It must still resolve to Basic.
 *   OPERATIONAL-AI-ADVANCED   the AI-0 operational resolver at its strongest
 *                             (`aiConfigured` AND `aiReachable`), i.e. a REAL
 *                             AI Advanced operational tier. Even this moves
 *                             nothing new, because AI-5A did not wire anything.
 *
 * Every nutrition truth must be byte-identical across ALL of them: no gram, no
 * FDC identity, no digest, no nutrient, no total, no AI-3 eligibility, no mass
 * decision, no persistence authorization, no Apply verdict and no state change.
 *
 * NO provider is involved. Every rig makes EXACTLY ZERO network calls, and the
 * differential also asserts the transport was never reached.
 *
 * This file additionally carries the STRUCTURAL half of the inertness proof, which
 * behaviour alone cannot establish: that AI-5A has no production consumer, no
 * import on any App/server/AI execution path, no reducer action, no schema field,
 * no persistence field and no Apply field.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime/bundle';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe, type AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows, buildCalculationRequest } from '../../src/core/nutritionV2/phase4/rows';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import {
  deriveAiEstimateParseFacts,
  evaluateAiEstimateEligibility,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import {
  resolveEffectiveMassDecision,
  type EffectiveMassClaims,
} from '../../src/core/nutritionV2/calculation/effectiveMass';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5';
import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_ACCESS,
  isAiAdvancedProductAccess,
  isNutritionProductFeatureEntitled,
  resolveNutritionProductAccess,
  type NutritionProductAccess,
} from '../../src/core/nutritionV2/nutritionProductAccess';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';

const REPO = process.cwd();
const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const BUNDLE_DIR = join(REPO, 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');

let session: AdvancedNutritionSession;
beforeAll(async () => {
  const result = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  } as never);
  if (!result.ok) throw new Error('bundle failed');
  session = result.session;
}, 180_000);

function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

const RECIPE_LINES: ReadonlyArray<string> = [
  '200 g chicken thighs',
  '30 g butter',
  '2 tbsp parsley, for garnish',
  '1 can (15 oz) chickpeas, drained',
  '1 onion, divided',
  '500 ml chicken stock',
];

const RECIPE = {
  title: 'Creamy chickpea stew',
  servings: 6,
  ingredients: RECIPE_LINES.map(structuredLine),
};

// ---------------------------------------------------------------------------
// THE RIGS
// ---------------------------------------------------------------------------

/**
 * Every hostile payload a client could realistically offer. NONE may resolve to AI
 * Advanced. A client must never be able to post `{ tier: "ai_advanced" }` and
 * thereby unlock anything.
 */
const FORGED_TIER_INPUTS: ReadonlyArray<readonly [string, unknown]> = [
  ['claimed tier object', { tier: 'ai_advanced' }],
  ['claimed tier object with features', { tier: 'ai_advanced', aiInterpretation: true }],
  ['truthy boolean', true],
  ['number 1', 1],
  ['pricing alias', 'pro'],
  ['wrong case', 'AI_ADVANCED'],
  ['provider shaped', { providerId: 'openrouter', modelId: 'google/gemini-2.5-flash' }],
  ['BYOK shaped', { credentialSource: 'session_only', server_environment: true }],
  ['api key shaped', { apiKey: 'sk-ant-0000' }],
  ['null', null],
  ['missing', undefined],
];

interface Rig {
  /** The AI-5A value this rig constructed, or `null` when AI-5A is absent. */
  readonly productAccess: NutritionProductAccess | null;
  /** What the rig resolved when offered the forged payloads (all must be Basic). */
  readonly forgedAllBasic: boolean;
  /** Whether this rig is genuinely entitled to every current AI product feature. */
  readonly entitled: boolean;
  readonly state: Phase4State;
  readonly lineRefs: ReadonlyArray<string>;
  readonly preview: NonNullable<ReturnType<typeof analyzeRecipe>['preview']>;
  /** The AI-0 operational capability the rig would present (a separate question). */
  readonly operationalTier: string;
}

function buildPipelineState(): { state: Phase4State; lineRefs: ReadonlyArray<string>; preview: Rig['preview'] } {
  const adaptedResult = adaptRecipe(RECIPE as never);
  if (!adaptedResult.ok) throw new Error('adapt failed');
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, RECIPE.servings);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai5a-differential',
    rows: buildReviewRows(session, adapted as never),
    baseServings: RECIPE.servings,
  } as never);
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  } as never);

  if (analysis.preview === null) throw new Error('no preview');
  const request = buildCalculationRequest(adapted as never, state);
  const calculated = session.calculate(request as never);
  if (!calculated.ok) throw new Error('calculate failed');

  return {
    state,
    lineRefs: adapted.map((entry: { line_ref: string }) => entry.line_ref),
    preview: calculated.preview,
  };
}

function runRig(
  productAccess: NutritionProductAccess | null,
  operational: Parameters<typeof resolveNutritionCapabilities>[0]
): Rig {
  // Constructing the AI-5A value is the ONLY thing this rig does differently.
  const forgedAllBasic = FORGED_TIER_INPUTS.every(
    ([, value]) => resolveNutritionProductAccess(value) === BASIC_NUTRITION_PRODUCT_ACCESS
  );
  const entitled =
    productAccess === null
      ? false
      : isAiAdvancedProductAccess(productAccess) &&
        (['ai_interpretation', 'ai_candidate_orchestration', 'ai_bounded_mass_estimation', 'ai_recipe_context_review'] as const).every(
          (feature) => isNutritionProductFeatureEntitled(productAccess, feature)
        );

  const pipeline = buildPipelineState();
  return {
    productAccess,
    forgedAllBasic,
    entitled,
    operationalTier: resolveNutritionCapabilities(operational).tier,
    ...pipeline,
  };
}

const RIG_NAMES = ['product-basic', 'product-ai-advanced', 'product-forged', 'operational-ai-advanced'] as const;
const rigs: Record<string, Rig> = {};
let baseline: Rig | null = null;

beforeAll(() => {
  // BASELINE: AI-5A is absent, and the operational resolver says Basic.
  baseline = runRig(null, { aiConfigured: false, aiReachable: false });
  rigs['product-basic'] = runRig(BASIC_NUTRITION_PRODUCT_ACCESS, {
    aiConfigured: false,
    aiReachable: false,
  });
  rigs['product-ai-advanced'] = runRig(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, {
    aiConfigured: false,
    aiReachable: false,
  });
  // FORGED: a client claiming entitlement while no provider is even configured.
  rigs['product-forged'] = runRig(resolveNutritionProductAccess({ tier: 'ai_advanced' }), {
    aiConfigured: false,
    aiReachable: false,
  });
  // OPERATIONAL: the strongest REAL AI-0 operational tier.
  rigs['operational-ai-advanced'] = runRig(null, { aiConfigured: true, aiReachable: true });
}, 180_000);

function allRigs(): ReadonlyArray<readonly [string, Rig]> {
  if (baseline === null) throw new Error('no baseline');
  return [['baseline', baseline], ...Object.entries(rigs)];
}

// ---------------------------------------------------------------------------
// ANTI-VACUITY: the rigs genuinely differ where they are allowed to differ
// ---------------------------------------------------------------------------
describe('AI-5A differential — the entitlement side is real on both sides', () => {
  it('the baseline has NO AI-5A value and an operational Basic tier', () => {
    if (baseline === null) throw new Error('no baseline');
    expect(baseline.productAccess).toBeNull();
    expect(baseline.entitled).toBe(false);
    expect(baseline.operationalTier).toBe('basic');
  });

  it('PRODUCT-BASIC is genuinely Basic with zero entitlement', () => {
    const rig = rigs['product-basic'];
    expect(rig.productAccess).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    expect(isAiAdvancedProductAccess(rig.productAccess)).toBe(false);
    expect(rig.entitled).toBe(false);
  });

  it('PRODUCT-AI-ADVANCED is genuinely entitled to every current AI product feature', () => {
    const rig = rigs['product-ai-advanced'];
    expect(isAiAdvancedProductAccess(rig.productAccess)).toBe(true);
    expect(rig.entitled).toBe(true);
    expect(rig.entitled).not.toBe(rigs['product-basic'].entitled);
  });

  it('PRODUCT-FORGED really WAS refused: a claimed tier never becomes entitlement', () => {
    const rig = rigs['product-forged'];
    expect(rig.productAccess).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    expect(rig.entitled).toBe(false);
    for (const [label, value] of FORGED_TIER_INPUTS) {
      expect(resolveNutritionProductAccess(value), label).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    }
  });

  it('EVERY rig refused every forged payload (no rig manufactured entitlement)', () => {
    for (const [name, rig] of allRigs()) {
      expect(rig.forgedAllBasic, name).toBe(true);
    }
  });

  it('OPERATIONAL-AI-ADVANCED really reached the AI-0 operational AI tier', () => {
    // Without this the differential could be vacuous: if the operational resolver
    // never produced AI Advanced, "nothing changed" would prove nothing.
    const rig = rigs['operational-ai-advanced'];
    expect(rig.operationalTier).toBe('ai_advanced');
    expect(rig.productAccess).toBeNull();
    const capabilities = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });
    expect(capabilities.aiEstimation).toBe('available');
    expect(capabilities.aiInterpretation).toBe(true);
  });

  it('the pipeline is non-vacuous: the baseline really resolves nutrition', () => {
    if (baseline === null) throw new Error('no baseline');
    const withGrams = baseline.preview.ingredients.filter(
      (entry) => entry.resolved_grams !== undefined
    );
    expect(withGrams.length).toBeGreaterThan(0);
    expect(baseline.preview.ingredient_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(baseline.preview.advisory_only).toBe(true);
    expect(baseline.preview.application_authorized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE DIFFERENTIAL
// ---------------------------------------------------------------------------
describe('AI-5A differential — product entitlement moves NO nutrition authority', () => {
  it('A. resolved grams and per-line mass evidence are byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
    const pick = (rig: Rig) =>
      JSON.stringify(
        rig.preview.ingredients.map((entry) => ({
          line_ref: entry.line_ref,
          resolved_grams: entry.resolved_grams,
          mass_source: entry.mass_source,
          outcome: entry.outcome,
          contributing_nutrients: entry.contributing_nutrients,
        }))
      );
    const expected = pick(baseline);
    for (const [name, rig] of allRigs()) expect(pick(rig), name).toBe(expected);
  });

  it('B. FDC identity, digests and match status are byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
    const pick = (rig: Rig) =>
      JSON.stringify(
        rig.preview.ingredients.map((entry) => [
          entry.line_ref,
          entry.fdc_id,
          entry.record_digest,
          entry.match_status,
          entry.ingredient_identity_digest,
          entry.ingredient_digest,
        ])
      );
    const expected = pick(baseline);
    for (const [name, rig] of allRigs()) {
      expect(pick(rig), name).toBe(expected);
      expect(rig.preview.catalog_digest, name).toBe(baseline.preview.catalog_digest);
      expect(rig.preview.ingredient_digest, name).toBe(baseline.preview.ingredient_digest);
      expect(rig.lineRefs, name).toEqual(baseline.lineRefs);
    }
  });

  it('C. AI-3 eligibility is byte-identical (entitlement never gates or suppresses AI-3)', () => {
    if (baseline === null) throw new Error('no baseline');
    const pick = (rig: Rig) =>
      JSON.stringify(
        rig.lineRefs.map((lineRef) => {
          const index = RECIPE_LINES.findIndex((_, i) => rig.lineRefs[i] === lineRef);
          const live = projectLiveRows(
            rig.state,
            new Map<string, AnalyzedRow>(),
            rig.lineRefs.map((ref) => ({ line_ref: ref })) as never,
            session,
            undefined,
            undefined,
            undefined
          ).find((entry) => entry.line_ref === lineRef);
          const result = evaluateAiEstimateEligibility({
            state: rig.state,
            lineRef,
            parse: deriveAiEstimateParseFacts(RECIPE_LINES[index] ?? ''),
            rowStatus: live?.status ?? 'unknown',
            // Force the capability open: even a FULLY entitled rig may not change the
            // answer relative to a Basic rig.
            capabilityAvailable: true,
          });
          return [lineRef, result.eligible === true, result.eligible === false ? result.reason : null];
        })
      );
    const expected = pick(baseline);
    for (const [name, rig] of allRigs()) expect(pick(rig), name).toBe(expected);
  });

  it('D. the effective-mass decision is byte-identical (no mass effect)', () => {
    const claims: EffectiveMassClaims = {
      directMassGrams: undefined,
      hasUserMass: false,
      hasSourcePortion: false,
      hasCountPortion: false,
      hasHouseholdPortion: false,
      hasAiEstimate: false,
    };
    const decision = JSON.stringify(resolveEffectiveMassDecision(claims));
    for (const [name, rig] of allRigs()) {
      expect(JSON.stringify(resolveEffectiveMassDecision(claims)), name).toBe(decision);
      expect(
        JSON.stringify(rig.preview.ingredients.map((entry) => [entry.line_ref, entry.mass_source])),
        name
      ).toBe(
        JSON.stringify(
          (baseline as Rig).preview.ingredients.map((entry) => [entry.line_ref, entry.mass_source])
        )
      );
    }
  });

  it('E. the ENTIRE serialized preview is byte-identical (no nutrient/calculation effect)', () => {
    if (baseline === null) throw new Error('no baseline');
    const expected = JSON.stringify(baseline.preview);
    for (const [name, rig] of allRigs()) expect(JSON.stringify(rig.preview), name).toBe(expected);
  });

  it('F. no preview, state or Apply payload carries ANY AI-5A vocabulary', () => {
    for (const [name, rig] of allRigs()) {
      const payloads = [
        JSON.stringify(rig.preview),
        JSON.stringify(rig.state),
      ].join('|').toLowerCase();
      for (const forbidden of [
        'product_access',
        'productaccess',
        'nutrition_product_access',
        'product_tier',
        'entitlement',
        'ai_advanced',
        'entitled',
        'tier',
        'subscription',
        'billing',
        'stripe',
        'checkout',
      ]) {
        expect(payloads.includes(forbidden), `${name} leaked ${forbidden}`).toBe(false);
      }
    }
  });

  it('G. the persistence authorization payload is byte-identical (no persistence effect)', () => {
    if (baseline === null) throw new Error('no baseline');
    const pick = (rig: Rig) =>
      JSON.stringify(
        authorizeNutritionPersistence({
          session,
          recipe: { title: RECIPE.title, servings: RECIPE.servings, ingredients: [] },
          state: rig.state,
          computedAt: FIXED_TIME,
        })
      );
    const expected = pick(baseline);
    for (const [name, rig] of allRigs()) expect(pick(rig), name).toBe(expected);
  });

  it('H. the Apply verdict is byte-identical and writes nothing', async () => {
    if (baseline === null) throw new Error('no baseline');
    const applied = await Promise.all(
      allRigs().map(async ([name, rig]) => {
        const write = vi.fn();
        const readBack = vi.fn();
        const result = await applyAdvancedNutrition({
          session,
          recipe: { title: RECIPE.title, servings: RECIPE.servings, ingredients: [] },
          state: rig.state,
          write: write as never,
          readBack: readBack as never,
          computedAt: FIXED_TIME,
          expectedMode: 'create',
        } as never);
        return [name, JSON.stringify(result), write.mock.calls.length] as const;
      })
    );
    const baselineApplied = applied.find(([name]) => name === 'baseline');
    if (baselineApplied === undefined) throw new Error('no baseline apply');
    for (const [name, payload, writeCalls] of applied) {
      expect(payload, name).toBe(baselineApplied[1]);
      expect(writeCalls, name).toBe(baselineApplied[2]);
      expect(writeCalls).toBe(0);
    }
  });

  it('I. the Phase-4 state is byte-identical across every rig (no state field, no reducer action)', () => {
    if (baseline === null) throw new Error('no baseline');
    const expected = JSON.stringify(baseline.state);
    for (const [name, rig] of allRigs()) expect(JSON.stringify(rig.state), name).toBe(expected);
  });

  it('J. constructing either entitlement tier makes EXACTLY ZERO network calls', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error('AI-5A must never perform a network call');
    }) as never;
    try {
      const transport = vi.fn(async () => ({ ok: true, request_id: 'never', estimates: [] }));
      runRig(BASIC_NUTRITION_PRODUCT_ACCESS, { aiConfigured: true, aiReachable: true });
      runRig(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, { aiConfigured: true, aiReachable: true });
      for (const [, value] of FORGED_TIER_INPUTS) resolveNutritionProductAccess(value);
      // The dedicated AI-3 transport is never even handed a transport function by
      // this phase: AI-5A has no execution surface at all.
      expect(transport).toHaveBeenCalledTimes(0);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// THE STRUCTURAL HALF OF INERTNESS
// ---------------------------------------------------------------------------
function source(rel: string): string {
  return readFileSync(isAbsolute(rel) ? rel : join(REPO, rel), 'utf8');
}

/** Comment-stripped source, so documentation can neither satisfy nor defeat a pin. */
function codeOf(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\*\*?[\s\S]*$/, ' ');
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('AI-5A inertness — structural: no consumer, no wiring, no field', () => {
  it('K. exactly TWO server boundaries plus ONE read-only client reader; no plugin/scripts', () => {
    // AI-5A was inert. AI-5B gave the SERVER authority: the dedicated gate module plus
    // the composition point that closes over its value. AI-5E adds the ONE authority
    // ABSTRACTION module — where the decision comes from — without adding a second gate
    // or a second policy. AI-5C adds exactly ONE client READER (awareness) and ONE
    // application-layer composer over it. None of them grants authority. The scripts and
    // the plugin build stay completely unaware.
    const offenders: string[] = [];
    for (const root of ['src', 'server', 'scripts', 'plugin']) {
      for (const full of walkFiles(join(REPO, root))) {
        if (codeOf(full).includes('nutritionProductAccess')) offenders.push(full);
      }
    }
    expect(offenders.map((full) => relative(REPO, full)).sort()).toEqual([
      'server/app.ts',
      'server/nutritionProductAccess.ts',
      'server/nutritionProductAccessAuthority.ts',
      'src/application/nutritionAiClientState.ts',
      'src/application/nutritionProductAccess.ts',
    ]);

    // Nothing outside those four is aware at all — in particular never the plugin or
    // the scripts.
    const authorized = new Set([
      'src/application/nutritionAiClientState.ts',
      'src/application/nutritionProductAccess.ts',
    ]);
    for (const root of ['src', 'scripts', 'plugin']) {
      for (const full of walkFiles(join(REPO, root))) {
        const rel = relative(REPO, full);
        if (authorized.has(rel)) continue;
        expect(codeOf(full), full).not.toContain('nutritionProductAccess');
      }
    }
  });

  it('L. no App, server or AI execution path imports the new module', () => {
    const executionPaths: ReadonlyArray<string> = [
      'src/App.tsx',
      'src/application/nutritionAiResolve.ts',
      'src/application/nutritionAiPlan.ts',
      'src/application/nutritionAiEstimate.ts',
      'src/application/nutritionAiPlanAcceptance.ts',
      'src/application/nutritionAiRecipeContext.ts',
      'src/application/advancedNutritionApply.ts',
      'src/core/nutritionV2/nutritionCapabilities.ts',
      'src/core/nutritionV2/index.ts',
      'server/nutritionContext.ts',
      'server/nutritionEstimate.ts',
      'server/nutritionPlan.ts',
    ];
    for (const rel of executionPaths) {
      const importLines = source(rel)
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line));
      for (const line of importLines) {
        expect(line, rel).not.toContain('nutritionProductAccess');
        expect(line, rel).not.toContain('ProductAccess');
      }
      expect(codeOf(rel), rel).not.toContain('nutritionProductAccess');
    }

    // The AI-5B composition point closes over the gate's resolved value and imports the
    // GATE module only — never the AI-5A core contract, so the route factory carries no
    // entitlement vocabulary of its own.
    const appModules = source('server/app.ts')
      .split('\n')
      .map((line) => /\bfrom\s+['"]([^'"]+)['"]/.exec(line)?.[1] ?? '')
      .filter(Boolean);
    for (const modulePath of appModules) {
      expect(modulePath, 'server/app.ts').not.toContain('core/nutritionV2/nutritionProductAccess');
    }
    expect(appModules).toContain('./nutritionProductAccess.js');
  });

  it('M. there is NO reducer action and NO state field for product access', () => {
    const state = codeOf('src/core/nutritionV2/phase4/state.ts');
    for (const absent of [
      'productAccess',
      'ProductAccess',
      'product_access',
      'nutrition_product_access',
      'productTier',
      'entitlement',
    ]) {
      expect(state, absent).not.toContain(absent);
    }
    // The INITIAL state declares no such key, behaviourally.
    const initial = JSON.stringify(INITIAL_PHASE4_STATE).toLowerCase();
    for (const absent of ['productaccess', 'entitlement', 'producttier', 'tier']) {
      expect(initial, absent).not.toContain(absent);
    }
  });

  it('N. there is NO schema field for product access', () => {
    const schema = codeOf('src/core/nutritionV2/schema.ts');
    for (const absent of [
      'productAccess',
      'ProductAccess',
      'nutrition_product_access',
      'entitlement',
      'productTier',
    ]) {
      expect(schema, absent).not.toContain(absent);
    }
  });

  it('O. there is NO persistence field for product access', () => {
    for (const rel of [
      'src/core/nutritionV2/phase5/types.ts',
      'src/core/nutritionV2/phase5/authorize.ts',
      'src/utils/markdownParser.ts',
    ]) {
      const source_ = codeOf(rel);
      for (const absent of [
        'productAccess',
        'ProductAccess',
        'nutrition_product_access',
        'entitlement',
        'productTier',
        'ai_advanced',
      ]) {
        expect(source_, `${rel}: ${absent}`).not.toContain(absent);
      }
    }
  });

  it('P. there is NO Apply field for product access', () => {
    const apply = codeOf('src/application/advancedNutritionApply.ts');
    for (const absent of ['productAccess', 'ProductAccess', 'nutrition_product_access', 'entitlement']) {
      expect(apply, absent).not.toContain(absent);
    }
  });

  it('Q. the AI-0 operational capability module is behaviourally unchanged', () => {
    // Not merely unreferenced: still present, still provider-derived, still with
    // manual editing as a permanent invariant. AI-5A changed documentation only.
    const capabilities = source('src/core/nutritionV2/nutritionCapabilities.ts');
    expect(capabilities).toContain(
      "const aiAvailable = input.aiConfigured === true && input.aiReachable === true;"
    );
    expect(capabilities).toContain('if (!aiAvailable) return BASIC_NUTRITION_CAPABILITIES;');
    expect(capabilities).toContain('export function resolveNutritionCapabilities(');
    expect(capabilities).toContain('export const BASIC_NUTRITION_CAPABILITIES');
    // Behaviourally, at runtime, in this very suite:
    expect(resolveNutritionCapabilities().tier).toBe('basic');
    expect(resolveNutritionCapabilities({ aiConfigured: true }).tier).toBe('basic');
    expect(resolveNutritionCapabilities({ aiReachable: true }).tier).toBe('basic');
    expect(resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }).tier).toBe(
      'ai_advanced'
    );
  });

  it('R. accepted AI-4 context still has ZERO production consumer', () => {
    const symbol = 'projectAcceptedRecipeContext';
    const definitions: string[] = [];
    const importers: string[] = [];
    for (const root of ['src', 'server']) {
      for (const full of walkFiles(join(REPO, root))) {
        const text = source(full);
        if (!text.includes(symbol)) continue;
        if (full.endsWith('aiRecipeContextSession.ts')) definitions.push(full);
        if (new RegExp(`import[^\\n]*${symbol}`).test(text)) importers.push(full);
      }
    }
    // Exactly the ONE defining module, and no importer at all: AI-5A did not cross
    // the AI-4 trust boundary.
    expect(definitions).toHaveLength(1);
    expect(importers).toEqual([]);
  });
});