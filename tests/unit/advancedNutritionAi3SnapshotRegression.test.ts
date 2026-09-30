/**
 * AI-3 — DEDICATED `no_snapshot` REGRESSION + IDENTITY-EVIDENCE PURITY.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `deriveAiEstimateSnapshotInput` used to guard on
 * `typeof match.record_digest !== 'string'` against the Phase-4 `MatchChoice`.
 * `MatchChoice` has NO `record_digest` field, so that condition was ALWAYS
 * true and the function returned `null` for every line, always. Reconciliation
 * then classified every result `stale: no_snapshot` and `offer_count` was
 * structurally pinned at 0. The button could render and the feature could never
 * produce a single offer.
 *
 * The repair made the snapshot CONSUME the one canonical five-field identity
 * evidence instead. These tests fail closed if the dead `MatchChoice.record_digest`
 * dependency is ever reintroduced.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveAiEstimateSnapshotInput, aiEstimateSnapshotBinding } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { deriveAiEstimateIdentityEvidence } from '../../src/core/nutritionV2/phase4/aiEstimateIdentityEvidence';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime/bundle';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { evaluateAiEstimateEligibility, deriveAiEstimateParseFacts } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { RESOLUTION_COVERAGE_CORPUS } from '../fixtures/advancedNutritionResolutionCorpus';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';

const REPO = process.cwd();
const BUNDLE_DIR = join(REPO, 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');
const src = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

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
  readonly status: string;
}

/** ONE real, actionable AI-3 production candidate. */
let realCache: Real | null = null;
function realCandidate(): Real {
  if (realCache !== null) return realCache;
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
      realCache = { line: text, state, lineRef, status: live.status };
      return realCache;
    }
  }
  throw new Error('no real AI-3 candidate found');
}

// ---------------------------------------------------------------------------
// 2. DEDICATED no_snapshot REGRESSION
// ---------------------------------------------------------------------------
describe('no_snapshot regression — the exact production defect', () => {
  it('POSITIVE: a real candidate with canonical evidence produces a snapshot', () => {
    const real = realCandidate();
    expect(real.status).toBe('needs_amount');
    const evidence = deriveAiEstimateIdentityEvidence({ session, state: real.state, lineRef: real.lineRef });
    expect(evidence).not.toBeNull();

    // The match genuinely has NO record_digest — that is the defect's origin.
    const match = real.state.matches[real.lineRef] as unknown as Record<string, unknown>;
    expect(match.record_digest).toBeUndefined();

    const snapshot = deriveAiEstimateSnapshotInput(real.state, real.lineRef, real.line, evidence);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.recordDigest).toBe(evidence?.record_digest);
    expect(snapshot?.bundleRelease).toBe(evidence?.bundle_release);
    expect(snapshot?.fdcId).toBe(evidence?.fdc_id);
  }, 120_000);

  it('NEGATIVE: removing the canonical evidence makes the snapshot fail closed', () => {
    const real = realCandidate();
    expect(deriveAiEstimateSnapshotInput(real.state, real.lineRef, real.line, null)).toBeNull();
    expect(deriveAiEstimateSnapshotInput(real.state, real.lineRef, real.line, undefined)).toBeNull();
  }, 120_000);

  it('[AI3-M43-HIST] NEGATIVE: evidence that disagrees with the current match fails closed', () => {
    const real = realCandidate();
    const evidence = deriveAiEstimateIdentityEvidence({ session, state: real.state, lineRef: real.lineRef });
    expect(evidence).not.toBeNull();
    if (evidence === null) return;
    const tampered = { ...evidence, fdc_id: evidence.fdc_id + 1 };
    expect(deriveAiEstimateSnapshotInput(real.state, real.lineRef, real.line, tampered)).toBeNull();
  }, 120_000);

  it('NEGATIVE: a line with no match at all still fails closed', () => {
    const real = realCandidate();
    const evidence = deriveAiEstimateIdentityEvidence({ session, state: real.state, lineRef: real.lineRef });
    expect(deriveAiEstimateSnapshotInput(real.state, 'ing:9:does-not-exist', real.line, evidence)).toBeNull();
  }, 120_000);

  it('the dead MatchChoice.record_digest dependency is gone from production', () => {
    // A reintroduction would silently restore the always-null snapshot.
    for (const rel of [
      'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
      'src/core/nutritionV2/phase4/aiEstimateIdentityEvidence.ts',
      'src/application/nutritionAiEstimate.ts',
    ]) {
      const text = src(rel);
      expect(text, rel).not.toMatch(/match\.record_digest/);
      expect(text, rel).not.toMatch(/currentMatch\.record_digest/);
    }
    // And the session-record-digest map is gone, superseded by canonical evidence.
    const app = src('src/application/nutritionAiEstimate.ts');
    expect(app).not.toContain('sessionRecordDigests');
    expect(app).toContain('identityEvidence');
  });
});

// ---------------------------------------------------------------------------
// 7. IDENTITY-EVIDENCE PURITY
// ---------------------------------------------------------------------------
describe('identity-evidence purity — observational purity for AI-3', () => {
  it('repeated derivation is byte-identical and mutates nothing', () => {
    const real = realCandidate();
    const before = {
      rows: JSON.stringify(real.state.rows),
      matches: JSON.stringify(real.state.matches),
      ai: JSON.stringify(real.state.aiEstimates ?? null),
      op: real.state.operationSeq,
      meta: JSON.stringify(session.metadata()),
    };

    const first = deriveAiEstimateIdentityEvidence({ session, state: real.state, lineRef: real.lineRef });
    const second = deriveAiEstimateIdentityEvidence({ session, state: real.state, lineRef: real.lineRef });
    const third = deriveAiEstimateIdentityEvidence({ session, state: real.state, lineRef: real.lineRef });

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // Byte-identical, not merely deep-equal.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    expect(JSON.stringify(real.state.rows)).toBe(before.rows);
    expect(JSON.stringify(real.state.matches)).toBe(before.matches);
    expect(JSON.stringify(real.state.aiEstimates ?? null)).toBe(before.ai);
    expect(real.state.operationSeq).toBe(before.op);
    expect(JSON.stringify(session.metadata())).toBe(before.meta);
  }, 120_000);

  it('the evidence owner performs no network and no persistence', () => {
    const body = src('src/core/nutritionV2/phase4/aiEstimateIdentityEvidence.ts');
    expect(body).not.toMatch(/fetch\(/);
    expect(body).not.toMatch(/XMLHttpRequest/);
    expect(body).not.toMatch(/localStorage/);
    expect(body).not.toMatch(/indexedDB/);
    expect(body).not.toMatch(/networkAdapter/);
    // It is pure: it consumes the session and state, it never mutates them.
    expect(body).not.toMatch(/state\.[A-Za-z]+\s*=/);
    expect(body).not.toMatch(/\.push\(/);
  });

  it('a snapshot binding is stable for identical inputs and differs per bound field', () => {
    const real = realCandidate();
    const evidence = deriveAiEstimateIdentityEvidence({ session, state: real.state, lineRef: real.lineRef });
    const a = deriveAiEstimateSnapshotInput(real.state, real.lineRef, real.line, evidence);
    const b = deriveAiEstimateSnapshotInput(real.state, real.lineRef, real.line, evidence);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a === null || b === null) return;
    expect(aiEstimateSnapshotBinding(b)).toBe(aiEstimateSnapshotBinding(a));
    // Changing ONE bound dimension changes the binding.
    expect(aiEstimateSnapshotBinding({ ...b, sourceText: `${real.line} ` })).not.toBe(aiEstimateSnapshotBinding(b));
  }, 120_000);
});
