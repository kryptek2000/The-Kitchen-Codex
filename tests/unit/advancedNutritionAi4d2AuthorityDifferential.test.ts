/**
 * AI-4D2 — AUTHORITY DIFFERENTIAL: ACCEPTING AI-4 CONTEXT CHANGES NOTHING.
 *
 * AI-4D2 lets a HUMAN explicitly accept or dismiss AI recipe-context
 * interpretations. Acceptance is real, user-driven and session-only — and it must
 * still move NOTHING in nutrition.
 *
 * This test drives the REAL Advanced Nutrition pipeline (pinned local USDA bundle,
 * real session, real analyzer, real `buildCalculationRequest` + `session.calculate`,
 * real `authorizeNutritionPersistence`, real `applyAdvancedNutrition`) and compares
 * three rigs:
 *
 *   BASELINE  — no AI-4 work in existence at all.
 *   ACCEPTED  — a REAL AI-4C-shaped wire, reconciled by the REAL AI-4D1 path, with
 *               rows explicitly ACCEPTED and DISMISSED by the user through the REAL
 *               acceptance core.
 *   STALE     — a review that is no longer current, where an accept is REFUSED. It
 *               must fail closed and produce no accepted context whatsoever.
 *
 * Because acceptance is inert and session-only, every nutrition truth must be
 * byte-identical across all three: accepting AI-4 context must move no gram, no
 * identity, no digest, no total, no eligibility, no persistence authorization and no
 * Apply verdict.
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
import {
  acceptRecipeContextRow,
  createRecipeContextReviewSession,
  dismissRecipeContextRow,
  projectAcceptedRecipeContext,
  undoRecipeContextRow,
  type AcceptedRecipeContextSession,
  type RecipeContextReviewSession,
} from '../../src/core/nutritionV2/aiRecipeContextSession';
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

const REQUEST_ID = 'ai4d2-differential';

interface Rig {
  readonly state: Phase4State;
  readonly lineRefs: ReadonlyArray<string>;
  readonly preview: NonNullable<ReturnType<typeof analyzeRecipe>['preview']>;
  readonly outcome: string;
  readonly acceptedCount: number;
  readonly dismissedCount: number;
  readonly acceptedContext: AcceptedRecipeContextSession | null;
}

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

/**
 * The D2 side: reconcile, then let the USER decide — accept everything reviewable,
 * dismiss one row, undo that dismissal so both transitions are exercised.
 */
function runReview(mode: 'accepted' | 'stale'): {
  outcome: string;
  session: RecipeContextReviewSession | null;
  acceptedCount: number;
  dismissedCount: number;
  acceptedContext: AcceptedRecipeContextSession | null;
} {
  const wire = buildWireFor(RECIPE_INSTRUCTIONS);
  const current = deriveRecipeContextModelInput({
    recipe: RECIPE,
    instructions: (mode === 'accepted' ? RECIPE_INSTRUCTIONS : CHANGED_INSTRUCTIONS).map((text) => ({
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
  if (!reconciled.ok) {
    return {
      outcome: String((reconciled as { code: string }).code),
      session: null,
      acceptedCount: 0,
      dismissedCount: 0,
      acceptedContext: null,
    };
  }
  const created = createRecipeContextReviewSession({
    reconciliation: reconciled.reconciliation,
    expected: {
      requestId: reconciled.reconciliation.request_id,
      contextBinding: reconciled.reconciliation.context_binding,
    },
  });
  if (!created.ok) {
    return {
      outcome: `session_${String((created as { code: string }).code)}`,
      session: null,
      acceptedCount: 0,
      dismissedCount: 0,
      acceptedContext: null,
    };
  }

  // The stale rig accepts against the OLD identity: every action must fail closed.
  const identity =
    mode === 'stale'
      ? { requestId: REQUEST_ID, contextBinding: 'sha256:'.concat('0'.repeat(64)) }
      : { requestId: created.session.request_id, contextBinding: created.session.context_binding };

  let session = created.session;
  const reviewable = reconciled.reconciliation.rows.filter((row) => row.category === 'reviewable');
  for (const row of reviewable) {
    const accepted = acceptRecipeContextRow(session, row.line_ref, identity);
    if (accepted.ok) session = accepted.session;
  }
  // Dismiss one, then undo it: both user transitions are exercised for real.
  let dismissedCount = 0;
  if (reviewable.length > 1) {
    const target = reviewable[1];
    const dismissed = dismissRecipeContextRow(session, target.line_ref, identity);
    if (dismissed.ok) {
      session = dismissed.session;
      dismissedCount = 1;
      const restored = undoRecipeContextRow(session, target.line_ref, identity);
      if (restored.ok) session = restored.session;
      dismissedCount = 0;
    }
  }
  const projected = projectAcceptedRecipeContext(session, identity);
  return {
    outcome: 'reviewed',
    session,
    acceptedCount: Object.values(session.decisions).filter((d) => d === 'accepted').length,
    dismissedCount,
    acceptedContext: projected.ok ? projected.accepted : null,
  };
}

function runRig(mode: 'baseline' | 'accepted' | 'stale'): Rig {
  const adaptedResult = adaptRecipe(RECIPE as never);
  if (!adaptedResult.ok) throw new Error('adapt failed');
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, RECIPE.servings);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai4d2-differential',
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

  // ---- The AI-4D2 side: a real review with real user decisions. --------------
  let outcome = 'no_ai4';
  let acceptedCount = 0;
  let dismissedCount = 0;
  let acceptedContext: AcceptedRecipeContextSession | null = null;
  if (mode !== 'baseline') {
    const review = runReview(mode);
    outcome = review.outcome;
    acceptedCount = review.acceptedCount;
    dismissedCount = review.dismissedCount;
    acceptedContext = review.acceptedContext;
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
    acceptedCount,
    dismissedCount,
    acceptedContext,
  };
}

let baseline: Rig | null = null;
let accepted: Rig | null = null;
let stale: Rig | null = null;
beforeAll(() => {
  baseline = runRig('baseline');
  accepted = runRig('accepted');
  stale = runRig('stale');
}, 180_000);

// ---------------------------------------------------------------------------
// ANTI-VACUITY
// ---------------------------------------------------------------------------
describe('AI-4D2 differential — the D2 side is real: rows were accepted, stale was refused', () => {
  it('a REAL review succeeded and the user really accepted interpretations', () => {
    if (accepted === null) throw new Error('no rig');
    expect(accepted.outcome).toBe('reviewed');
    expect(accepted.acceptedCount).toBeGreaterThan(0);
    expect(accepted.acceptedContext).not.toBeNull();
    expect(accepted.acceptedContext?.accepted.length).toBe(accepted.acceptedCount);
    // The accepted context is real semantic data, not an empty placeholder.
    expect(accepted.acceptedContext?.accepted[0].line_ref).toMatch(/\S/);
  });

  it('the accepted context carries accepted semantics only — never a quantity', () => {
    if (accepted === null) throw new Error('no rig');
    const serialized = JSON.stringify(accepted.acceptedContext).toLowerCase();
    for (const forbidden of [
      'grams',
      'fdc_id',
      'nutrient',
      'portion',
      'calories',
      'mass',
      'confidence',
      'explanation',
      'abstain_reason',
      'match_choice',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it('the STALE rig failed closed: no session, no decision, no accepted context', () => {
    if (stale === null) throw new Error('no rig');
    // The recipe changed underneath the review, so reconciliation refuses BEFORE a
    // session exists. There is therefore nothing the user could have accepted.
    expect(stale.outcome).toBe('stale_context');
    expect(stale.acceptedCount).toBe(0);
    expect(stale.dismissedCount).toBe(0);
    expect(stale.acceptedContext).toBeNull();
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
describe('AI-4D2 differential — every nutrition authority truth is byte-identical', () => {
  const rigs = (): ReadonlyArray<[string, Rig]> => {
    if (baseline === null || accepted === null || stale === null) throw new Error('no rigs');
    return [
      ['accepted', accepted],
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

  it('THE WHOLE PREVIEW is byte-identical with accepted AI-4 context in existence', () => {
    if (baseline === null) throw new Error('no baseline');
    for (const [name, rig] of rigs()) {
      expect(JSON.stringify(rig.preview), name).toBe(JSON.stringify(baseline.preview));
    }
  });

  it('the persistence authorization payload is byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
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
    for (const [name, rig] of rigs()) expect(authorize(rig.state), name).toBe(expected);
  });

  it('the Apply verdict is byte-identical and the writer is NEVER reached', async () => {
    if (baseline === null) throw new Error('no baseline');
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
    for (const [name, rig] of rigs()) {
      const attempt = await run(rig.state);
      expect(attempt.json, name).toBe(baselineResult.json);
      expect(attempt.write, name).not.toHaveBeenCalled();
      expect(attempt.readBack, name).not.toHaveBeenCalled();
    }
  });

  it('the effective-mass decision and the AI-3 eligibility verdict are byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
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
    for (const [name, rig] of rigs()) {
      expect(JSON.stringify(resolveEffectiveMassDecision(claims)), name).toBe(decision);
      expect(verdict(rig), name).toBe(expectedVerdict);
      expect(rig.lineRefs, name).toEqual(baseline.lineRefs);
    }
  });

  it('the working nutrition state is byte-identical and carries no AI-4 store', () => {
    if (baseline === null) throw new Error('no baseline');
    const expected = JSON.stringify(baseline.state);
    for (const [name, rig] of rigs()) {
      expect(JSON.stringify(rig.state), name).toBe(expected);
      for (const key of Object.keys(rig.state)) {
        const lowered = key.toLowerCase();
        expect(lowered, key).not.toContain('recipecontext');
        expect(lowered, key).not.toContain('aicontext');
        expect(lowered, key).not.toContain('reconcil');
        expect(lowered, key).not.toContain('accepted');
      }
    }
  });

  it('the serialized preview contains no AI-4 acceptance concept at all', () => {
    for (const [, rig] of rigs()) {
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
        'accepted',
        'dismissed',
      ]) {
        expect(text, banned).not.toContain(banned);
      }
    }
  });
});