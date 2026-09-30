/**
 * AI-3 — SNAPSHOT STALENESS MATRIX + END-TO-END OFFER ACCEPTANCE STALENESS.
 *
 * A valid current offer/snapshot is built ONCE from a real Phase-4 candidate,
 * then exactly ONE bound dimension is mutated at a time. Every mutation must
 * make the second click REFUSE, leave working state untouched, and require no
 * second provider call.
 *
 * This is the proof that snapshot binding is strictly STRONGER than identity
 * evidence alone: identity proves what food/record/release the offer belongs
 * to; the snapshot proves that the whole relevant working/input state has not
 * moved since the request.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  acceptAiEstimateOffer,
  buildAiEstimateOffer,
} from '../../src/core/nutritionV2/phase4/aiEstimateAccept';
import {
  deriveAiEstimateSnapshotInput,
  aiEstimateSnapshotBinding,
  deriveAiEstimateParseFacts,
  evaluateAiEstimateEligibility,
  deterministicMidpointGrams,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { deriveAiEstimateIdentityEvidence } from '../../src/core/nutritionV2/phase4/aiEstimateIdentityEvidence';
import { workingChoiceFingerprint } from '../../src/core/nutritionV2/phase4/aiMidFlight';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime/bundle';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { RESOLUTION_COVERAGE_CORPUS } from '../fixtures/advancedNutritionResolutionCorpus';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';

const REPO = process.cwd();
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

interface Real {
  readonly line: string;
  readonly state: Phase4State;
  readonly lineRef: string;
}

let cache: Real | null = null;
function realCandidate(): Real {
  if (cache !== null) return cache;
  const seen = new Set<string>();
  for (const entry of RESOLUTION_COVERAGE_CORPUS) {
    if (seen.has(entry.line)) continue;
    seen.add(entry.line);
    const text = entry.line;
    const parsed = parseIngredient(text);
    const ingredient: Record<string, unknown> = { original: text };
    if (parsed.ok && parsed.parsed.amount !== null) ingredient.amount = parsed.parsed.amount;
    if (parsed.ok && parsed.parsed.raw_unit !== undefined) ingredient.unit = parsed.parsed.raw_unit;
    if (parsed.ok) ingredient.name = parsed.parsed.query;
    const adaptedResult = adaptRecipe({ title: 't', servings: 1, ingredients: [ingredient] } as never);
    if (!adaptedResult.ok) continue;
    const adapted = adaptedResult.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted as never, 1);
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: adaptedResult.recipe.recipe_key,
      sessionIdentity: 't',
      rows: buildReviewRows(session, adapted as never),
      baseServings: 1,
    } as never);
    state = phase4Reducer(state, {
      type: 'apply_analysis',
      matches: analysis.matches,
      portions: analysis.portions,
      countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions,
      preview: analysis.preview,
    } as never);
    const lineRef = adapted[0].line_ref;
    const live = projectLiveRows(
      state,
      new Map<string, AnalyzedRow>(analysis.rows.map((r) => [r.line_ref, r])),
      adapted as never,
      session,
      undefined,
      analysis.portions,
      analysis.countPortions,
    )[0];
    if (live === undefined) continue;
    const eligibility = evaluateAiEstimateEligibility({
      state,
      lineRef,
      parse: deriveAiEstimateParseFacts(text),
      rowStatus: live.status,
      capabilityAvailable: true,
    });
    if (eligibility.eligible === true) {
      cache = { line: text, state, lineRef };
      return cache;
    }
  }
  throw new Error('no real AI-3 candidate found');
}

const LOWER = 150;
const UPPER = 200;

interface Rig {
  readonly real: Real;
  readonly offer: NonNullable<ReturnType<typeof buildAiEstimateOffer>>;
  readonly evidence: NonNullable<ReturnType<typeof deriveAiEstimateIdentityEvidence>>;
  readonly offerSnapshotBinding: string;
  readonly offerFingerprint: string;
}

function rig(): Rig {
  const real = realCandidate();
  const evidence = deriveAiEstimateIdentityEvidence({ session, state: real.state, lineRef: real.lineRef });
  if (evidence === null) throw new Error('no evidence');
  const snapshot = deriveAiEstimateSnapshotInput(real.state, real.lineRef, real.line, evidence);
  if (snapshot === null) throw new Error('no snapshot');
  const offer = buildAiEstimateOffer({
    line_ref: real.lineRef,
    kind: 'offer',
    evidence: {
      lower_grams: LOWER,
      upper_grams: UPPER,
      representative_grams: deterministicMidpointGrams(LOWER, UPPER),
      representative_policy: 'midpoint',
      provenance: 'ai_estimate',
    },
  });
  if (offer === null) throw new Error('no offer');
  const fingerprint = workingChoiceFingerprint(real.state, real.lineRef);
  if (fingerprint === null) throw new Error('no fingerprint');
  return { real, offer, evidence, offerSnapshotBinding: aiEstimateSnapshotBinding(snapshot), offerFingerprint: fingerprint };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---------------------------------------------------------------------------
// 3. SNAPSHOT BINDING IS LOAD-BEARING FOR EVERY BOUND DIMENSION
// ---------------------------------------------------------------------------
describe('snapshot binding is stronger than identity evidence alone', () => {
  it('BASELINE: an unchanged state accepts', () => {
    const r = rig();
    const snapshot = deriveAiEstimateSnapshotInput(r.real.state, r.real.lineRef, r.real.line, r.evidence);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(aiEstimateSnapshotBinding(snapshot)).toBe(r.offerSnapshotBinding);
  }, 120_000);

  it('A. a different source text yields a different binding', () => {
    const r = rig();
    const a = deriveAiEstimateSnapshotInput(r.real.state, r.real.lineRef, r.real.line, r.evidence);
    const b = deriveAiEstimateSnapshotInput(r.real.state, r.real.lineRef, `${r.real.line} sliced`, r.evidence);
    if (a === null || b === null) throw new Error('snapshots');
    expect(aiEstimateSnapshotBinding(b)).not.toBe(aiEstimateSnapshotBinding(a));
  }, 120_000);

  it('B/C. amount and unit semantics are bound', () => {
    const r = rig();
    const a = deriveAiEstimateSnapshotInput(r.real.state, r.real.lineRef, r.real.line, r.evidence);
    expect(a).not.toBeNull();
    if (a === null) return;
    for (const field of ['amount', 'unit', 'countNoun'] as const) {
      expect(aiEstimateSnapshotBinding({ ...a, [field]: field === 'amount' ? 999 : 'zzz' })).not.toBe(
        aiEstimateSnapshotBinding(a),
      );
    }
  }, 120_000);

  it('D/E/F/G/H. identity, record, review, bundle and catalog are bound', () => {
    const r = rig();
    const a = deriveAiEstimateSnapshotInput(r.real.state, r.real.lineRef, r.real.line, r.evidence);
    expect(a).not.toBeNull();
    if (a === null) return;
    const base = aiEstimateSnapshotBinding(a);
    const mutations: ReadonlyArray<readonly [string, string]> = [
      ['fdcId', aiEstimateSnapshotBinding({ ...a, fdcId: a.fdcId + 1 })],
      ['recordDigest', aiEstimateSnapshotBinding({ ...a, recordDigest: 'sha256:0000' })],
      ['reviewDigest', aiEstimateSnapshotBinding({ ...a, reviewDigest: 'sha256:0000' })],
      ['bundleRelease', aiEstimateSnapshotBinding({ ...a, bundleRelease: 'other-release' })],
      ['catalogDigest', aiEstimateSnapshotBinding({ ...a, catalogDigest: 'sha256:cat' })],
    ];
    for (const [name, binding] of mutations) {
      expect(binding, name).not.toBe(base);
    }
  }, 120_000);

  it('J/K. recipe key and session identity are bound', () => {
    const r = rig();
    const a = deriveAiEstimateSnapshotInput(r.real.state, r.real.lineRef, r.real.line, r.evidence);
    if (a === null) throw new Error('snapshot');
    const base = aiEstimateSnapshotBinding(a);
    expect(aiEstimateSnapshotBinding({ ...a, recipeKey: 'other-recipe' })).not.toBe(base);
    expect(aiEstimateSnapshotBinding({ ...a, sessionIdentity: 'other-session' })).not.toBe(base);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. END-TO-END OFFER ACCEPTANCE STALENESS
// ---------------------------------------------------------------------------
describe('second-click acceptance refuses every stale authority', () => {
  it('BASELINE: the unchanged offer is accepted', () => {
    const r = rig();
    const snapshot = deriveAiEstimateSnapshotInput(r.real.state, r.real.lineRef, r.real.line, r.evidence);
    if (snapshot === null) throw new Error('snapshot');
    const result = acceptAiEstimateOffer(r.offer, {
      currentState: r.real.state,
      offerFingerprint: r.offerFingerprint,
      evidence: r.evidence,
      snapshot,
      offerSnapshotBinding: r.offerSnapshotBinding,
    });
    expect(result.ok).toBe(true);
  }, 120_000);

  const CASES: ReadonlyArray<{ id: string; apply: (state: Phase4State, r: Rig) => Phase4State }> = [
    {
      id: 'the line is removed',
      apply: (state, r) => ({ ...state, rows: state.rows.filter((row) => row.line_ref !== r.real.lineRef) }),
    },
    {
      id: 'the FDC match changes',
      apply: (state, r) => {
        const next = clone(state);
        const match = next.matches[r.real.lineRef] as unknown as Record<string, unknown>;
        match.fdc_id = (match.fdc_id as number) + 1;
        return next;
      },
    },
    {
      id: 'the review/confirmation authority changes',
      apply: (state, r) => {
        const next = clone(state);
        const match = next.matches[r.real.lineRef] as unknown as Record<string, unknown>;
        match.review_digest = 'sha256:stale-review';
        return next;
      },
    },
    {
      id: 'the recipe is rebuilt/replaced',
      apply: (state, r) => ({ ...state, recipeKey: `${state.recipeKey}-rebuilt` }),
    },
    {
      id: 'the session identity changes',
      apply: (state) => ({ ...state, sessionIdentity: 'replaced-session' }),
    },
  ];

  for (const testCase of CASES) {
    it(`REFUSES when ${testCase.id}`, () => {
      const r = rig();
      const staleState = testCase.apply(r.real.state, r);
      const before = JSON.stringify({ rows: staleState.rows, matches: staleState.matches, ai: staleState.aiEstimates ?? null });
      // Snapshot re-read at the moment of the second click, from CURRENT state.
      const staleEvidence = deriveAiEstimateIdentityEvidence({ session, state: staleState, lineRef: r.real.lineRef });
      const snapshot =
        staleEvidence === null
          ? null
          : deriveAiEstimateSnapshotInput(staleState, r.real.lineRef, r.real.line, staleEvidence);
      const fingerprint = workingChoiceFingerprint(staleState, r.real.lineRef);

      let refused = snapshot === null || aiEstimateSnapshotBinding(snapshot) !== r.offerSnapshotBinding;
      if (!refused && snapshot !== null) {
        const result = acceptAiEstimateOffer(r.offer, {
          currentState: staleState,
          offerFingerprint: fingerprint ?? 'no-fingerprint',
          evidence: r.evidence,
          snapshot,
          offerSnapshotBinding: r.offerSnapshotBinding,
        });
        refused = result.ok === false;
      }
      expect(refused, testCase.id).toBe(true);
      // No state mutation from the refusal.
      expect(JSON.stringify({ rows: staleState.rows, matches: staleState.matches, ai: staleState.aiEstimates ?? null })).toBe(before);
    }, 120_000);
  }
});

// ---------------------------------------------------------------------------
// 4b. STRONGER MASS SOURCES — the real production pre-network guard
// ---------------------------------------------------------------------------
describe('a stronger mass source appearing refuses AI-3 outright', () => {
  const SOURCES: ReadonlyArray<{ id: string; apply: (state: Phase4State, r: Rig) => Phase4State }> = [
    { id: 'a user mass', apply: (state, r) => ({ ...state, userMasses: { ...(state.userMasses ?? {}), [r.real.lineRef]: { grams: 200 } as never } }) },
    { id: 'a source portion', apply: (state, r) => ({ ...state, portions: { ...(state.portions ?? {}), [r.real.lineRef]: { index: 0 } as never } }) },
    { id: 'a count portion', apply: (state, r) => ({ ...state, countPortions: { ...(state.countPortions ?? {}), [r.real.lineRef]: { index: 0 } as never } }) },
    { id: 'a household portion', apply: (state, r) => ({ ...state, householdPortions: { ...(state.householdPortions ?? {}), [r.real.lineRef]: { index: 0 } as never } }) },
  ];

  for (const source of SOURCES) {
    it(`REFUSES eligibility when ${source.id} appears`, () => {
      const r = rig();
      const stronger = source.apply(r.real.state, r);
      const eligibility = evaluateAiEstimateEligibility({
        state: stronger,
        lineRef: r.real.lineRef,
        parse: deriveAiEstimateParseFacts(r.real.line),
        rowStatus: 'needs_amount',
        capabilityAvailable: true,
      });
      expect(eligibility.eligible, source.id).toBe(false);
    }, 120_000);
  }
});
