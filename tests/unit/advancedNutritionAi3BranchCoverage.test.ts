/**
 * AI-3 — THE `unique_exact` AND MANUAL / USER-CONFIRMED BRANCHES.
 *
 * All 26 canonical AI-3 candidates are `review_required` matches, so the real
 * corpus never exercises the other two calculator branches. These tests drive
 * them directly.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveAiEstimateIdentityEvidence } from '../../src/core/nutritionV2/phase4/aiEstimateIdentityEvidence';
import { computeIngredientIdentityDigest } from '../../src/core/nutritionV2/calculation/identityEvidence';
import { phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime/bundle';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';

const REPO = process.cwd();
const BUNDLE_DIR = join(REPO, 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');

let session: AdvancedNutritionSession;
let FDC: number;
let PINNED_RECORD_DIGEST: string;
let BUNDLE_RELEASE: string;

beforeAll(async () => {
  const result = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  } as never);
  if (!result.ok) throw new Error('bundle failed');
  session = result.session;
  BUNDLE_RELEASE = session.metadata().bundle_release;
  // A real pinned record from the real bundle.
  const sample = (session as unknown as { reviewPortions(id: number): { ok: boolean; review?: { fdc_id: number; record_digest: string } } })
    .reviewPortions(2709719);
  if (!sample.ok || sample.review === undefined) throw new Error('no pinned record');
  FDC = sample.review.fdc_id;
  PINNED_RECORD_DIGEST = sample.review.record_digest;
}, 180_000);

const LINE_REF = 'ing:0:branchtest';
const TEXT = '2 tomatoes';

/** A minimal Phase-4 state carrying exactly the branch under test. */
function branchState(outcome: 'matched_exact' | 'review_required', kind: 'candidate' | 'manual', automatic: boolean): Phase4State {
  return {
    recipeKey: 'recipe',
    sessionIdentity: 'session',
    rows: [
      { line_ref: LINE_REF, original_text: TEXT, query: 'tomatoes', note: null, outcome, review_digest: 'sha256:review' },
    ],
    matches: {
      [LINE_REF]: { kind, automatic, fdc_id: FDC, review_digest: 'sha256:review' },
    },
  } as unknown as Phase4State;
}

describe('unique_exact branch', () => {
  it('the calculator omits confirmation_digest and record_digest for unique_exact', () => {
    const withBoth = computeIngredientIdentityDigest({
      lineRef: LINE_REF,
      originalText: TEXT,
      amount: 2,
      rawUnit: undefined,
      normalizedUnit: 'unknown',
      measurementKind: 'unknown',
      query: 'tomatoes',
      normalizedQuery: 'tomatoes',
      note: null,
      qualitative: false,
      matchStatus: 'unique_exact',
      fdcId: FDC,
      recordDigest: PINNED_RECORD_DIGEST,
      confirmationDigest: 'sha256:review',
    });
    const bare = computeIngredientIdentityDigest({
      lineRef: LINE_REF,
      originalText: TEXT,
      amount: 2,
      rawUnit: undefined,
      normalizedUnit: 'unknown',
      measurementKind: 'unknown',
      query: 'tomatoes',
      normalizedQuery: 'tomatoes',
      note: null,
      qualitative: false,
      matchStatus: 'unique_exact',
      fdcId: FDC,
      // Both omitted, exactly as the calculator does for a bare exact match.
      recordDigest: undefined,
      confirmationDigest: undefined,
    });
    // Omission is load-bearing: including them changes the digest.
    expect(bare).not.toBe(withBoth);
  });

  it('five-field evidence IS truthfully provable, with calculator parity', () => {
    const state = branchState('matched_exact', 'candidate', true);
    const evidence = deriveAiEstimateIdentityEvidence({ session, state, lineRef: LINE_REF });

    // The session CAN prove every one of the five fields for a bare exact match.
    expect(evidence).not.toBeNull();
    if (evidence === null) return;
    expect(Object.keys(evidence).sort()).toEqual([
      'bundle_release',
      'fdc_id',
      'ingredient_identity_digest',
      'line_ref',
      'record_digest',
    ]);
    expect(evidence.fdc_id).toBe(FDC);
    expect(evidence.record_digest).toBe(PINNED_RECORD_DIGEST);
    expect(evidence.bundle_release).toBe(BUNDLE_RELEASE);

    // And the identity digest equals the calculator's OWN unique_exact digest,
    // which omits both the record and confirmation digests.
    const expected = computeIngredientIdentityDigest({
      lineRef: LINE_REF,
      originalText: TEXT,
      amount: 2,
      rawUnit: undefined,
      normalizedUnit: 'unknown',
      measurementKind: 'unknown',
      query: 'tomatoes',
      normalizedQuery: 'tomatoes',
      note: null,
      qualitative: false,
      matchStatus: 'unique_exact',
      fdcId: FDC,
      recordDigest: undefined,
      confirmationDigest: undefined,
    });
    expect(evidence.ingredient_identity_digest).toBe(expected);
  });

  it('a line with no authenticated fdc id fails closed on every branch', () => {
    const state = branchState('matched_exact', 'candidate', true);
    const broken = {
      ...state,
      matches: { [LINE_REF]: { kind: 'candidate', automatic: true, review_digest: 'sha256:review' } },
    } as unknown as Phase4State;
    expect(deriveAiEstimateIdentityEvidence({ session, state: broken, lineRef: LINE_REF })).toBeNull();
  });
});

describe('manual / user-confirmed branch', () => {
  it('uses the current review digest as confirmation authority and matches the calculator', () => {
    const state = branchState('review_required', 'manual', false);
    const evidence = deriveAiEstimateIdentityEvidence({ session, state, lineRef: LINE_REF });
    expect(evidence).not.toBeNull();
    if (evidence === null) return;

    expect(evidence.fdc_id).toBe(FDC);
    expect(evidence.record_digest).toBe(PINNED_RECORD_DIGEST);
    expect(evidence.bundle_release).toBe(BUNDLE_RELEASE);

    // Manual + not automatic == the calculator's `user_confirmed` branch, and
    // that branch INCLUDES both the record and confirmation digests.
    const expected = computeIngredientIdentityDigest({
      lineRef: LINE_REF,
      originalText: TEXT,
      amount: 2,
      rawUnit: undefined,
      normalizedUnit: 'unknown',
      measurementKind: 'unknown',
      query: 'tomatoes',
      normalizedQuery: 'tomatoes',
      note: null,
      qualitative: false,
      matchStatus: 'user_confirmed',
      fdcId: FDC,
      recordDigest: PINNED_RECORD_DIGEST,
      confirmationDigest: 'sha256:review',
    });
    expect(evidence.ingredient_identity_digest).toBe(expected);
  });

  it('an automatic confirmed match takes the auto_confirmed branch, not user_confirmed', () => {
    const auto = deriveAiEstimateIdentityEvidence({
      session,
      state: branchState('review_required', 'candidate', true),
      lineRef: LINE_REF,
    });
    const manual = deriveAiEstimateIdentityEvidence({
      session,
      state: branchState('review_required', 'manual', false),
      lineRef: LINE_REF,
    });
    expect(auto).not.toBeNull();
    expect(manual).not.toBeNull();
    if (auto === null || manual === null) return;
    // Different match status => different identity digest. Neither is aliased.
    expect(auto.ingredient_identity_digest).not.toBe(manual.ingredient_identity_digest);
  });

  it('stale confirmation authority changes the digest, so a stale offer cannot match', () => {
    const fresh = deriveAiEstimateIdentityEvidence({
      session,
      state: branchState('review_required', 'manual', false),
      lineRef: LINE_REF,
    });
    const staled = {
      ...branchState('review_required', 'manual', false),
      matches: { [LINE_REF]: { kind: 'manual', automatic: false, fdc_id: FDC, review_digest: 'sha256:stale' } },
    } as unknown as Phase4State;
    const stale = deriveAiEstimateIdentityEvidence({ session, state: staled, lineRef: LINE_REF });
    expect(fresh).not.toBeNull();
    expect(stale).not.toBeNull();
    if (fresh === null || stale === null) return;
    expect(stale.ingredient_identity_digest).not.toBe(fresh.ingredient_identity_digest);
  });

  it('a review outcome with no confirmation authority fails closed', () => {
    expect(
      deriveAiEstimateIdentityEvidence({
        session,
        state: branchState('unmatched' as never, 'candidate', true),
        lineRef: LINE_REF,
      }),
    ).toBeNull();
  });
});

/**
 * M54 — the REAL production guard on `select_ai_estimate`.
 *
 * The historic row labelled this "IDEMPOTENCY BYPASS". That label is wrong. The
 * load-bearing guard is MUTUAL EXCLUSIVITY: a bounded AI estimate is the LOWEST
 * mass authority, so the reducer must refuse to write it over a stronger stored
 * source, returning the state untouched with `operationSeq` unmoved.
 *
 * This test exists because a causal mutation removing the guard SURVIVED the
 * whole AI-3 suite. There was no witness. This is that witness.
 */
describe('M54 — select_ai_estimate never overwrites a stronger mass source', () => {
  function stateWithMass(): Phase4State {
    return {
      recipeKey: 'recipe',
      sessionIdentity: 'session',
      rows: [{ line_ref: LINE_REF, original_text: TEXT, query: 'tomatoes', note: null, outcome: 'review_required', review_digest: 'sha256:review' }],
      matches: { [LINE_REF]: { kind: 'candidate', automatic: true, fdc_id: FDC, review_digest: 'sha256:review' } },
      aiEstimates: {},
      userMasses: { [LINE_REF]: { grams: 200 } },
      portions: {},
      countPortions: {},
      householdPortions: {},
      operationSeq: 7,
    } as unknown as Phase4State;
  }

  const SOURCES = ['userMasses', 'portions', 'countPortions', 'householdPortions'] as const;
  // Each parameterised case carries its OWN stable historical token. The shared
  // `${source}` template is SOURCE TEXT, not a runtime Vitest identity, so a single
  // generic token could never designate a runtime failure.
  const M54_TOKEN = {
    userMasses: '[AI3-M54-USER-MASS-HIST]',
    portions: '[AI3-M54-PORTION-HIST]',
    countPortions: '[AI3-M54-COUNT-PORTION-HIST]',
    householdPortions: '[AI3-M54-HOUSEHOLD-HIST]',
  } as const;

  for (const source of SOURCES) {
    it(`${M54_TOKEN[source]} M54: select_ai_estimate cannot overwrite a stored ${source}`, () => {
      const base = stateWithMass();
      const populated = { ...base, userMasses: {}, portions: {}, countPortions: {}, householdPortions: {},
        [source]: { [LINE_REF]: { grams: 200 } } } as unknown as Phase4State;
      const next = phase4Reducer(populated, {
        type: 'select_ai_estimate',
        lineRef: LINE_REF,
        choice: { line_ref: LINE_REF, range: { lower_grams: 150, upper_grams: 200 }, fdc_id: FDC, record_digest: 'sha256:r', review_digest: 'sha256:review' },
      } as never);
      // Refused: same object, no write, and NOT EVEN a sequence bump.
      expect(next).toBe(populated);
      expect(next.operationSeq).toBe(populated.operationSeq);
      expect(next.aiEstimates).toEqual({});
    });
  }

  it('DOES write the estimate when no stronger source exists', () => {
    const base = {
      recipeKey: 'recipe', sessionIdentity: 'session',
      rows: [{ line_ref: LINE_REF, original_text: TEXT, query: 'tomatoes', note: null, outcome: 'review_required', review_digest: 'sha256:review' }],
      matches: { [LINE_REF]: { kind: 'candidate', automatic: true, fdc_id: FDC, review_digest: 'sha256:review' } },
      aiEstimates: {}, userMasses: {}, portions: {}, countPortions: {}, householdPortions: {}, operationSeq: 7,
    } as unknown as Phase4State;
    const next = phase4Reducer(base, {
      type: 'select_ai_estimate', lineRef: LINE_REF,
      choice: { line_ref: LINE_REF, range: { lower_grams: 150, upper_grams: 200 }, fdc_id: FDC, record_digest: 'sha256:r', review_digest: 'sha256:review' },
    } as never);
    expect(next).not.toBe(base);
    expect(next.operationSeq).toBe(8);
    expect((next.aiEstimates as Record<string, unknown>)[LINE_REF]).toBeDefined();
  });
});
