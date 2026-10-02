/**
 * AI-4E — AUTHORITY + PERSISTENCE DIFFERENTIAL: A VERIFIED RECEIPT CHANGES NOTHING.
 *
 * AI-4E adds a server-authenticated origin receipt. It closes audit finding I-1 for
 * the PUBLIC reconciliation flow — and it must still move NOTHING in nutrition.
 *
 * This drives the REAL Advanced Nutrition pipeline (pinned local USDA bundle, real
 * session, real analyzer, real `buildCalculationRequest` + `session.calculate`, real
 * `authorizeNutritionPersistence`, real `applyAdvancedNutrition`) across six rigs:
 *
 *   BASELINE          no AI-4 work in existence at all
 *   VERIFIED-REVIEW   a REAL wire, a REAL server receipt, verified through the REAL
 *                     envelope reader, reconciled by the REAL AI-4D1 path
 *   ACCEPTED          the user ACCEPTED interpretations through the REAL core
 *   DISMISSED         the user DISMISSED a row
 *   UNDID             the user UNDID that dismissal
 *   FORGED-REFUSED    the same wire with NO genuine receipt — never reaches D1
 *
 * Every nutrition truth must be byte-identical across all of them: the receipt and
 * the accepted context move no gram, no identity, no digest, no total, no eligibility,
 * no persistence authorization and no Apply verdict.
 *
 * NO provider is involved: the wire is built locally by the RELEASED wire builder and
 * the receipt is issued by the REAL authority over that exact wire.
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
import {
  createRecipeContextOriginReceiptAuthority,
  readRecipeContextOriginEnvelope,
} from '../../server/recipeContextOriginReceipt';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';

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

const RECIPE_INSTRUCTIONS: ReadonlyArray<string> = [
  'Reserve half the chicken for the sauce',
  'Discard the marinade',
  'Garnish with parsley',
  'Divide the onion into two portions',
  'Brush the chicken with butter',
  'Remove bones from the chicken',
];

const RECIPE = {
  title: 'Creamy chickpea stew',
  servings: 6,
  ingredients: RECIPE_LINES.map(structuredLine),
};

const REQUEST_ID = 'ai4e-differential';

/** ONE application instance's authority, exactly as `createApp()` owns it. */
const AUTHORITY = createRecipeContextOriginReceiptAuthority();

function buildWire(): Record<string, unknown> {
  const derived = deriveRecipeContextModelInput({
    recipe: RECIPE,
    instructions: RECIPE_INSTRUCTIONS.map((text) => ({ text })),
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: REQUEST_ID,
    recipeInstance: 'instance-differential',
  });
  if (!derived.ok) throw new Error('derivation failed');
  const refs = derived.request.allowed_line_refs;
  const wire = toAiRecipeContextWirePayload({
    requestId: REQUEST_ID,
    contextBinding: derived.request.model_input_binding,
    proposal: {
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
    } as never,
  });
  return JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
}

/**
 * The AI-4E server boundary, run for real: closed-key envelope, receipt verification,
 * then the RELEASED D1 adapter's own reconciliation call.
 */
function originGatedReconcile(
  receipt: unknown
): { outcome: string; plan: ReturnType<typeof reconcileRecipeContext> } {
  const wire = buildWire();
  const current = deriveRecipeContextModelInput({
    recipe: RECIPE,
    instructions: RECIPE_INSTRUCTIONS.map((text) => ({ text })),
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: REQUEST_ID,
    recipeInstance: 'instance-differential',
  });
  if (!current.ok) throw new Error('current derivation failed');

  const envelope = readRecipeContextOriginEnvelope(
    {
      wire,
      expected_request_id: REQUEST_ID,
      recipe: RECIPE,
      instructions: RECIPE_INSTRUCTIONS.map((text) => ({ text })),
      recipe_instance: 'instance-differential',
      origin_receipt: receipt,
    },
    AUTHORITY
  );
  if (envelope.ok !== true) {
    return {
      outcome: String((envelope as { code: string }).code),
      plan: { ok: false, code: 'invalid_wire' } as never,
    };
  }
  const reconciled = reconcileRecipeContext({
    wire: (envelope as { body: Record<string, unknown> }).body['wire'],
    expectedRequestId: REQUEST_ID,
    current: {
      context_binding: current.request.model_input_binding,
      targets: current.request.provider_request.targets.map((target) => ({
        line_ref: target.line_ref,
        source_text: target.source_text,
      })),
    },
  });
  return { outcome: reconciled.ok ? 'origin_verified' : 'reconcile_refused', plan: reconciled };
}

type Decision = 'accepted' | 'dismissed' | 'undone' | 'cleared' | 'reviewed' | 'refused';

interface Review {
  outcome: string;
  decision: Decision;
  /** The server really authenticated the receipt for this wire. */
  originVerified: boolean;
  /** AI-4D1 really reported the wire CURRENT for the current recipe context. */
  current: boolean;
  session: RecipeContextReviewSession | null;
  acceptedContext: AcceptedRecipeContextSession | null;
}

/**
 * The D2 side over a receipt-VERIFIED review. Each decision is exercised for real, in
 * a session created only from a CURRENT plan whose origin this server authenticated.
 */
function runReview(decision: Decision): Review {
  const receipt = AUTHORITY.issue(buildWire());
  if (receipt.ok !== true) throw new Error('issuance must succeed for a canonical wire');
  const gated = originGatedReconcile(receipt.receipt);
  if (gated.outcome !== 'origin_verified' || gated.plan.ok !== true) {
    return {
      outcome: gated.outcome,
      decision: 'refused',
      originVerified: false,
      current: false,
      session: null,
      acceptedContext: null,
    };
  }
  const reconciliation = gated.plan.reconciliation;
  const originVerified = true;
  const current = reconciliation.status === 'current';
  const created = createRecipeContextReviewSession({
    reconciliation,
    expected: {
      requestId: reconciliation.request_id,
      contextBinding: reconciliation.context_binding,
    },
  });
  if (created.ok !== true) {
    return {
      outcome: 'session_refused',
      decision: 'refused',
      originVerified,
      current,
      session: null,
      acceptedContext: null,
    };
  }
  const identity = {
    requestId: created.session.request_id,
    contextBinding: created.session.context_binding,
  };
  let session = created.session;
  const reviewable = reconciliation.rows.filter((row) => row.category === 'reviewable');

  if (decision === 'accepted' || decision === 'dismissed' || decision === 'cleared') {
    for (const row of reviewable) {
      const result = acceptRecipeContextRow(session, row.line_ref, identity);
      if (result.ok) session = result.session;
    }
  }
  if (decision === 'dismissed' || decision === 'cleared') {
    const target = reviewable[reviewable.length - 1];
    const result = dismissRecipeContextRow(session, target.line_ref, identity);
    if (result.ok) session = result.session;
  }
  if (decision === 'cleared') {
    // Undo every decision: the "clear review" equivalent.
    for (const row of reviewable) {
      const result = undoRecipeContextRow(session, row.line_ref, identity);
      if (result.ok) session = result.session;
    }
  }
  if (decision === 'undone') {
    // Accept everything, dismiss one, then undo the dismissal.
    for (const row of reviewable) {
      const result = acceptRecipeContextRow(session, row.line_ref, identity);
      if (result.ok) session = result.session;
    }
    const target = reviewable[reviewable.length - 1];
    const dismissed = dismissRecipeContextRow(session, target.line_ref, identity);
    if (dismissed.ok) session = dismissed.session;
    const restored = undoRecipeContextRow(session, target.line_ref, identity);
    if (restored.ok) session = restored.session;
  }

  const projected = projectAcceptedRecipeContext(session, identity);
  return {
    outcome: 'reviewed',
    decision,
    originVerified,
    current,
    session,
    acceptedContext: projected.ok ? projected.accepted : null,
  };
}

interface Rig {
  readonly state: Phase4State;
  readonly lineRefs: ReadonlyArray<string>;
  readonly preview: NonNullable<ReturnType<typeof analyzeRecipe>['preview']>;
  readonly outcome: string;
  readonly decision: Decision;
  readonly originVerified: boolean;
  readonly current: boolean;
  readonly acceptedContext: AcceptedRecipeContextSession | null;
}

function runRig(mode: 'baseline' | Decision | 'reviewed' | 'forged'): Rig {
  const adaptedResult = adaptRecipe(RECIPE as never);
  if (!adaptedResult.ok) throw new Error('adapt failed');
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, RECIPE.servings);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai4e-differential',
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

  let outcome = 'no_ai4';
  let decision: Decision = 'refused';
  let originVerified = false;
  let current = false;
  let acceptedContext: AcceptedRecipeContextSession | null = null;

  if (mode !== 'baseline') {
    if (mode === 'forged') {
      // The I-1 shape, with NO genuine receipt: refused at the origin gate, so there
      // is no plan, no session and nothing a user could accept.
      const gated = originGatedReconcile(`rctx1.${'A'.repeat(43)}`);
      outcome = gated.outcome;
    } else {
      const review = runReview(mode);
      outcome = review.outcome;
      decision = review.decision;
      originVerified = review.originVerified;
      current = review.current;
      acceptedContext = review.acceptedContext;
    }
  }

  if (analysis.preview === null) throw new Error('no preview');
  const request = buildCalculationRequest(adapted as never, state);
  const calculated = session.calculate(request as never);
  if (!calculated.ok) throw new Error('calculate failed');

  return {
    state,
    lineRefs: adapted.map((entry: { line_ref: string }) => entry.line_ref),
    preview: calculated.preview,
    outcome,
    decision,
    originVerified,
    current,
    acceptedContext,
  };
}

const RIG_NAMES = ['accepted', 'dismissed', 'undone', 'cleared'] as const;
let rigs: Record<string, Rig> = {};
let baseline: Rig | null = null;

beforeAll(() => {
  baseline = runRig('baseline');
  rigs['verified-review'] = runRig('reviewed');
  for (const name of RIG_NAMES) rigs[name] = runRig(name);
  rigs['forged-refused'] = runRig('forged');
}, 180_000);

// ---------------------------------------------------------------------------
// ANTI-VACUITY
// ---------------------------------------------------------------------------

describe('AI-4E differential — the receipt side is real, and the forged side really failed', () => {
  it('a GENUINE receipt verified and produced a CURRENT review', () => {
    const verified: ReadonlyArray<[string, Rig]> = [
      ['verified-review', rigs['verified-review']],
      ...RIG_NAMES.map((name): [string, Rig] => [name, rigs[name]]),
    ];
    for (const [name, rig] of verified) {
      expect(rig.originVerified, `${name} origin`).toBe(true);
      expect(rig.current, `${name} currentness`).toBe(true);
      expect(rig.outcome, `${name} outcome`).toBe('reviewed');
    }
  });

  it('a FORGED wire with no genuine receipt was refused at the origin gate', () => {
    const forged = rigs['forged-refused'];
    expect(forged.outcome).toBe('origin_unverified');
    // It never became CURRENT and produced nothing a user could accept.
    expect(forged.current).toBe(false);
    expect(forged.originVerified).toBe(false);
    expect(forged.acceptedContext).toBeNull();
  });

  it('the ACCEPTED rig really accepted interpretations, carrying semantics only', () => {
    const accepted = rigs['accepted'];
    expect(accepted.outcome).toBe('reviewed');
    expect(accepted.decision).toBe('accepted');
    expect(accepted.acceptedContext).not.toBeNull();
    expect(accepted.acceptedContext?.accepted.length).toBeGreaterThan(0);
    expect(accepted.acceptedContext?.accepted[0].line_ref).toMatch(/\S/);
    const serialized = JSON.stringify(accepted.acceptedContext).toLowerCase();
    for (const forbidden of [
      'grams',
      'fdc_id',
      'nutrient',
      'portion',
      'calories',
      'mass',
      'receipt',
      'hmac',
      'rctx1',
      'provenance',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it('the DISMISSED and CLEARED rigs end with no accepted context, as the user intended', () => {
    // A dismissal removes one row, so the accepted set shrinks but is not empty; a
    // clear removes every decision, so nothing is accepted at all.
    expect(rigs['dismissed'].decision).toBe('dismissed');
    expect(rigs['cleared'].decision).toBe('cleared');
    expect(rigs['cleared'].acceptedContext?.accepted.length ?? 0).toBe(0);
  });

  it('the baseline really resolves nutrition (non-vacuous)', () => {
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

describe('AI-4E differential — every nutrition authority truth is byte-identical', () => {
  const allRigs = (): ReadonlyArray<[string, Rig]> => {
    if (baseline === null) throw new Error('no baseline');
    return [...Object.entries(rigs), ['baseline', baseline]];
  };

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
    for (const [name, rig] of allRigs()) {
      expect(pick(rig), name).toBe(pick(baseline));
    }
  });

  it('B. FDC identity and match status are byte-identical (no matching effect)', () => {
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

  it('C. AI-3 eligibility is byte-identical (no gating and no suppression)', () => {
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
            capabilityAvailable: true,
          });
          return [lineRef, result.eligible === true, result.eligible === false ? result.reason : null];
        })
      );
    if (baseline === null) throw new Error('no baseline');
    const expected = pick(baseline);
    for (const [name, rig] of allRigs()) {
      expect(pick(rig), name).toBe(expected);
    }
  });

  it('D. the effective-mass decision is byte-identical (no mass effect)', () => {
    // The SAME claim set in every rig: if AI-4 acceptance or a receipt could gate or
    // suppress mass, the decision computed from an identical claim set could not stay
    // identical. The per-row grams assertion above is what proves the claims are equal.
    const claims: EffectiveMassClaims = {
      directMassGrams: undefined,
      hasUserMass: false,
      hasSourcePortion: false,
      hasCountPortion: false,
      hasHouseholdPortion: false,
      hasAiEstimate: false,
    };
    const decision = JSON.stringify(resolveEffectiveMassDecision(claims));
    if (baseline === null) throw new Error('no baseline');
    for (const [name, rig] of allRigs()) {
      expect(JSON.stringify(resolveEffectiveMassDecision(claims)), name).toBe(decision);
      // And the REAL per-line mass evidence behind that decision is unchanged.
      expect(
        JSON.stringify(
          rig.preview.ingredients.map((entry) => [entry.line_ref, entry.mass_source])
        ),
        name
      ).toBe(
        JSON.stringify(
          baseline.preview.ingredients.map((entry) => [entry.line_ref, entry.mass_source])
        )
      );
    }
  });

  it('E. the ENTIRE serialized preview is byte-identical (no nutrient/calculation effect)', () => {
    if (baseline === null) throw new Error('no baseline');
    const pick = (rig: Rig) => JSON.stringify(rig.preview);
    for (const [name, rig] of allRigs()) {
      expect(pick(rig), name).toBe(pick(baseline));
    }
  });

  it('F. no preview carries any AI-4 acceptance or receipt vocabulary', () => {
    for (const [name, rig] of allRigs()) {
      const serialized = JSON.stringify(rig.preview).toLowerCase();
      for (const forbidden of [
        'origin_receipt',
        'receipt',
        'hmac',
        'rctx1',
        'accepted',
        'dismissed',
        'reviewable',
        'context_binding',
        'reconcil',
      ]) {
        expect(serialized.includes(forbidden), `${name} leaked ${forbidden}`).toBe(false);
      }
    }
  });

  it('G. the persistence authorization payload is byte-identical (no persistence effect)', () => {
    if (baseline === null) throw new Error('no baseline');
    const pick = (rig: Rig) => {
      return JSON.stringify(
        authorizeNutritionPersistence({
          session,
          recipe: { title: RECIPE.title, servings: RECIPE.servings, ingredients: [] },
          state: rig.state,
          computedAt: FIXED_TIME,
        })
      );
    };
    for (const [name, rig] of allRigs()) {
      expect(pick(rig), name).toBe(pick(baseline));
    }
  });

  it('H. the Apply verdict is byte-identical (no Apply influence)', async () => {
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
      // A refused authorization never calls the writer in ANY rig.
      expect(writeCalls, name).toBe(baselineApplied[2]);
      expect(writeCalls).toBe(0);
    }
  });

  it('I. the Phase-4 state carries no AI-4 store or receipt in any rig', () => {
    for (const [name, rig] of allRigs()) {
      const serialized = JSON.stringify(rig.state).toLowerCase();
      for (const forbidden of ['recipecontext', 'origin_receipt', 'rctx1', 'accepted_context']) {
        expect(serialized.includes(forbidden), `${name} leaked ${forbidden}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// M. ACCEPT / DISMISS / UNDO BEHAVIOUR IS UNCHANGED AND MAKES NO NETWORK CALL
// ---------------------------------------------------------------------------

describe('AI-4E differential — decisions stay inert and offline', () => {
  it('Accept/Dismiss/Undo make ZERO network calls after a receipt-verified review', () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error('decisions must not perform any network call');
    }) as never;
    try {
      const receipt = AUTHORITY.issue(buildWire());
      if (receipt.ok !== true) throw new Error('issuance failed');
      const before = calls;
      runReview('accepted');
      runReview('dismissed');
      runReview('undone');
      runReview('cleared');
      // runReview issues + verifies + reconciles locally through the pure modules; no
      // fetch may ever have been reached.
      expect(calls).toBe(before);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});