/**
 * AI-4D1 — AUTHORITY DIFFERENTIAL: A RECONCILIATION CHANGES NOTHING.
 *
 * AI-4D1 reconciles a returned proposal against the CURRENT server-derived
 * context. This test drives the REAL Advanced Nutrition pipeline (pinned local
 * USDA bundle, real session, real analyzer, real `buildCalculationRequest` +
 * `session.calculate`, real `authorizeNutritionPersistence`, real
 * `applyAdvancedNutrition`) and compares three rigs:
 *
 *   BASELINE  — no AI-4 work in existence.
 *   CURRENT   — a REAL AI-4C-shaped wire reconciled successfully by the REAL
 *               AI-4D1 path (server derivation -> strict read -> request
 *               correlation -> whole-proposal freshness -> inert review plan).
 *   STALE     — the same wire reconciled against a CHANGED recipe, which must
 *               fail closed rather than produce a partial plan.
 *
 * Because the reconciliation is pure, offline and inert, every nutrition truth
 * must be byte-identical across all three: a proposal having been obtained and
 * reconciled must move no gram, no identity, no digest, no total, no eligibility,
 * no persistence authorization and no Apply verdict.
 *
 * NO provider is involved: the wire is constructed locally, exactly as AI-4C would
 * have returned it from the released wire builder.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime/bundle';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
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
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';
import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from '../../src/core/nutritionV2/aiRecipeContextRequest';
import { toAiRecipeContextWirePayload } from '../../src/core/nutritionV2/aiRecipeContextWire';
import { reconcileRecipeContext } from '../../src/core/nutritionV2/aiRecipeContextReconcile';
import { deriveRecipeContextModelInput } from '../../server/recipeContextDerivation';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';

const REPO = process.cwd();
const BUNDLE_DIR = join(REPO, 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');
const FIXED_TIME = '2026-01-01T00:00:00.000Z';

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

const RECIPE_INSTRUCTIONS: ReadonlyArray<string> = [
  'Reserve half the chicken for the sauce',
  'Discard the marinade',
  'Garnish with parsley',
  'Divide the onion into two portions',
  'Brush the chicken with butter',
  'Remove bones from the chicken',
];

/** A genuinely different authored recipe (same ingredients, one step changed). */
const CHANGED_INSTRUCTIONS: ReadonlyArray<string> = [
  'Reserve a third of the chicken for the sauce',
  ...RECIPE_INSTRUCTIONS.slice(1),
];

const RECIPE = {
  title: 'Creamy chickpea stew',
  servings: 6,
  ingredients: RECIPE_LINES.map(structuredLine),
};

const REQUEST_ID = 'ai4d1-differential';

interface Rig {
  readonly state: Phase4State;
  readonly lineRefs: ReadonlyArray<string>;
  readonly preview: NonNullable<ReturnType<typeof analyzeRecipe>['preview']>;
  readonly outcome: string;
  readonly reviewableCount: number;
  readonly staleCount: number;
}

/**
 * Builds the wire AI-4C would have returned, using the RELEASED wire builder over
 * a proposal that passed the RELEASED AI-4A sanitizer. No provider is involved.
 */
function buildWireFor(instructions: ReadonlyArray<string>): Record<string, unknown> {
  const derived = deriveRecipeContextModelInput({
    recipe: RECIPE,
    instructions: instructions.map((text) => ({ text })),
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: REQUEST_ID,
    recipeInstance: 'instance-differential',
  });
  if (!derived.ok) throw new Error(`derivation failed: ${String((derived as { code?: string }).code)}`);
  const refs = derived.request.allowed_line_refs;
  const proposal = {
    contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
    provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
    interpretations: [
      {
        line_ref: refs[0],
        role: 'reserved',
        relations: refs.length > 1 ? [{ kind: 'reserved_from', target_ref: refs[1] }] : [],
        preparation_hints: ['reserved'],
        confidence: 'medium',
        explanation: 'the instruction says so',
      },
    ],
  };
  const wire = toAiRecipeContextWirePayload({
    requestId: REQUEST_ID,
    contextBinding: derived.request.model_input_binding,
    proposal: proposal as never,
  });
  return JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
}

function runRig(mode: 'baseline' | 'current' | 'stale'): Rig {
  const adaptedResult = adaptRecipe(RECIPE as never);
  if (!adaptedResult.ok) throw new Error('adapt failed');
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, RECIPE.servings);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai4d1-differential',
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

  // ---- The AI-4D1 side: a real reconciliation, current or stale. -----------
  let outcome = 'no_ai4';
  let reviewableCount = 0;
  let staleCount = 0;
  if (mode !== 'baseline') {
    const wire = buildWireFor(RECIPE_INSTRUCTIONS);
    const current = deriveRecipeContextModelInput({
      recipe: RECIPE,
      instructions: (mode === 'current' ? RECIPE_INSTRUCTIONS : CHANGED_INSTRUCTIONS).map((text) => ({
        text,
      })),
      requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      requestId: REQUEST_ID,
      recipeInstance: 'instance-differential',
    });
    if (!current.ok) throw new Error('current derivation failed');
    const reconciled = reconcileRecipeContext({
      wire,
      expectedRequestId: REQUEST_ID,
      current: {
        context_binding: current.request.model_input_binding,
        targets: current.request.provider_request.targets.map((target) => ({
          line_ref: target.line_ref,
          source_text: target.source_text,
        })),
      },
    });
    if (reconciled.ok) {
      outcome = 'reconciled';
      reviewableCount = reconciled.reconciliation.reviewable_count;
    } else {
      outcome = String((reconciled as { code: string }).code);
      staleCount = reconciled.ok ? 0 : 1;
    }
  }

  if (analysis.preview === null) throw new Error('no preview');
  const request = buildCalculationRequest(adapted as never, state);
  const calculated = session.calculate(request as never);
  if (!calculated.ok) throw new Error('calculate failed');

  return {
    state,
    lineRefs: adapted.map((entry) => entry.line_ref),
    preview: calculated.preview,
    outcome,
    reviewableCount,
    staleCount,
  };
}

let baseline: Rig | null = null;
let current: Rig | null = null;
let stale: Rig | null = null;
beforeAll(() => {
  baseline = runRig('baseline');
  current = runRig('current');
  stale = runRig('stale');
}, 180_000);

// ---------------------------------------------------------------------------
// ANTI-VACUITY
// ---------------------------------------------------------------------------
describe('AI-4D1 differential — the AI-4D1 side is real, reconciled, and stale is refused', () => {
  it('a REAL reconciliation succeeded with real reviewable rows', () => {
    if (current === null) throw new Error('no rig');
    expect(current.outcome).toBe('reconciled');
    expect(current.reviewableCount).toBeGreaterThan(0);
  });

  it('the STALE rig failed closed with no partial plan', () => {
    if (stale === null) throw new Error('no rig');
    expect(stale.outcome).toBe('stale_context');
    expect(stale.reviewableCount).toBe(0);
    expect(stale.staleCount).toBe(1);
  });

  it('the recipe really produces resolved nutrition (non-vacuous baseline)', () => {
    if (baseline === null) throw new Error('no baseline');
    const withGrams = baseline.preview.ingredients.filter((entry) => entry.resolved_grams !== undefined);
    expect(withGrams.length, 'at least one resolved gram value').toBeGreaterThan(0);
    expect(baseline.preview.ingredient_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(baseline.preview.advisory_only).toBe(true);
    expect(baseline.preview.application_authorized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE DIFFERENTIAL
// ---------------------------------------------------------------------------
describe('AI-4D1 differential — every nutrition authority truth is byte-identical', () => {
  const rigs = (): ReadonlyArray<[string, Rig]> => {
    if (baseline === null || current === null || stale === null) throw new Error('no rigs');
    return [
      ['reconciled', current],
      ['stale-refused', stale],
    ];
  };

  it('A. resolved grams and the per-line mass evidence block are byte-identical', () => {
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
    for (const [name, rig] of rigs()) expect(pick(rig), name).toBe(expected);
  });

  it('B/C. FDC identity, identity digests, aggregate digest and every pin are byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
    const identity = (rig: Rig) =>
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
    for (const [name, rig] of rigs()) {
      expect(identity(rig), name).toBe(identity(baseline));
      expect(rig.preview.ingredient_digest, name).toBe(baseline.preview.ingredient_digest);
      expect(rig.preview.bundle_release, name).toBe(baseline.preview.bundle_release);
      expect(rig.preview.catalog_digest, name).toBe(baseline.preview.catalog_digest);
      expect(rig.preview.nutrient_map_version, name).toBe(baseline.preview.nutrient_map_version);
      expect(rig.preview.calculation_version, name).toBe(baseline.preview.calculation_version);
      expect(JSON.stringify(rig.preview.totals), name).toBe(JSON.stringify(baseline.preview.totals));
      expect(JSON.stringify(rig.preview.unresolved), name).toBe(
        JSON.stringify(baseline.preview.unresolved)
      );
    }
  });

  it('THE WHOLE PREVIEW is byte-identical with a reconciliation in existence', () => {
    if (baseline === null) throw new Error('no baseline');
    for (const [name, rig] of rigs()) {
      expect(JSON.stringify(rig.preview), name).toBe(JSON.stringify(baseline.preview));
    }
  });

  it('the persistence authorization payload is byte-identical', () => {
    if (baseline === null || current === null || stale === null) throw new Error('no rigs');
    const authorize = (state: Phase4State) =>
      JSON.stringify(
        authorizeNutritionPersistence({
          session,
          recipe: { title: RECIPE.title, servings: RECIPE.servings, ingredients: [] },
          state,
          computedAt: FIXED_TIME,
        })
      );
    const expected = authorize(baseline.state);
    expect(authorize(current.state)).toBe(expected);
    expect(authorize(stale.state)).toBe(expected);
  });

  it('the Apply verdict is byte-identical and the writer is NEVER reached', async () => {
    if (baseline === null || current === null || stale === null) throw new Error('no rigs');
    const run = async (state: Phase4State) => {
      const write = vi.fn(async () => {});
      const readBack = vi.fn(async () => 'stored');
      const result = await applyAdvancedNutrition({
        session,
        recipe: { title: RECIPE.title, servings: RECIPE.servings, ingredients: [] },
        state,
        write,
        readBack,
        computedAt: FIXED_TIME,
        expectedMode: 'create',
      } as never);
      return { json: JSON.stringify(result), write, readBack };
    };
    const baselineResult = await run(baseline.state);
    expect(baselineResult.write).not.toHaveBeenCalled();
    for (const [name, rig] of [
      ['reconciled', current],
      ['stale-refused', stale],
    ] as ReadonlyArray<[string, Rig]>) {
      const attempt = await run(rig.state);
      expect(attempt.json, name).toBe(baselineResult.json);
      expect(attempt.write, name).not.toHaveBeenCalled();
      expect(attempt.readBack, name).not.toHaveBeenCalled();
    }
  });

  it('the effective-mass decision and the AI-3 eligibility verdict are byte-identical', () => {
    if (baseline === null || current === null || stale === null) throw new Error('no rigs');
    const claims: EffectiveMassClaims = {
      directMassGrams: undefined,
      hasUserMass: false,
      hasSourcePortion: false,
      hasCountPortion: false,
      hasHouseholdPortion: false,
      hasAiEstimate: false,
    };
    const decision = JSON.stringify(resolveEffectiveMassDecision(claims));
    const verdict = (rig: Rig) =>
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
            capabilityAvailable: true,
          });
          return [lineRef, result.eligible === true, result.eligible === false ? result.reason : null];
        })
      );
    const expectedVerdict = verdict(baseline);
    for (const [name, rig] of [
      ['reconciled', current],
      ['stale-refused', stale],
    ] as ReadonlyArray<[string, Rig]>) {
      expect(JSON.stringify(resolveEffectiveMassDecision(claims)), name).toBe(decision);
      expect(verdict(rig), name).toBe(expectedVerdict);
      expect(rig.lineRefs, name).toEqual(baseline.lineRefs);
    }
  });

  it('the working nutrition state is byte-identical and carries no AI-4 store', () => {
    if (baseline === null || current === null || stale === null) throw new Error('no rigs');
    const expected = JSON.stringify(baseline.state);
    for (const [name, rig] of [
      ['reconciled', current],
      ['stale-refused', stale],
    ] as ReadonlyArray<[string, Rig]>) {
      expect(JSON.stringify(rig.state), name).toBe(expected);
      for (const key of Object.keys(rig.state)) {
        const lowered = key.toLowerCase();
        expect(lowered, key).not.toContain('recipecontext');
        expect(lowered, key).not.toContain('aicontext');
        expect(lowered, key).not.toContain('reconcil');
      }
    }
  });

  it('the serialized preview contains no AI-4 or AI-4D1 concept at all', () => {
    if (current === null || stale === null) throw new Error('no rig');
    for (const rig of [current, stale]) {
      const text = JSON.stringify(rig.preview).toLowerCase();
      for (const banned of [
        'ai_recipe_context',
        'recipe_context',
        'nutrition_ai_recipe_context',
        'rc1:',
        'reviewable',
        'abstained',
        'uninterpreted',
        'context_binding',
        'reconcil',
      ]) {
        expect(text, banned).not.toContain(banned);
      }
    }
  });
});
