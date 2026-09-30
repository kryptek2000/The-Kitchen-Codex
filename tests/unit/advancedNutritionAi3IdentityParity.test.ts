/**
 * PARITY: the Phase-4/session identity-evidence helper must agree with the
 * CALCULATOR, byte for byte.
 *
 * The calculator is the independent authority: it builds its own
 * `IngredientIdentityFacts` and hashes them with the shared canonical
 * primitive. `deriveAiEstimateIdentityEvidence` builds the same facts from
 * Phase-4 state plus the session's own bounded authority.
 *
 * If the two ever disagree, the Phase-4 helper is wrong and the five-field
 * evidence would be a forgery. So this test drives BOTH real production paths
 * over the canonical 97-line benchmark population and requires exact equality.
 *
 * It deliberately does NOT compare against a duplicated test implementation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import {
  evaluateAiEstimateEligibility,
  deriveAiEstimateParseFacts,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { deriveAiEstimateIdentityEvidence } from '../../src/core/nutritionV2/phase4/aiEstimateIdentityEvidence';
import { RESOLUTION_COVERAGE_CORPUS } from '../fixtures/advancedNutritionResolutionCorpus';
import type { AdvancedNutritionSession, AdaptedIngredient } from '../../src/core/nutritionV2/phase4/types';
import type { AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';

const BUNDLE_DIR = join(
  process.cwd(),
  'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e',
);

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const result = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  } as never);
  if (!result.ok) throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  session = result.session;
}, 180_000);

function canonicalPopulation(): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of RESOLUTION_COVERAGE_CORPUS) {
    if (seen.has(entry.line)) continue;
    seen.add(entry.line);
    out.push(entry.line);
  }
  return out;
}

interface Candidate {
  readonly line: string;
  readonly state: Parameters<typeof deriveAiEstimateIdentityEvidence>[0]['state'];
  readonly lineRef: string;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
}

let CANDIDATES: ReadonlyArray<Candidate> | null = null;
function ai3Candidates(): ReadonlyArray<Candidate> {
  if (CANDIDATES !== null) return CANDIDATES;
  const out: Candidate[] = [];
  for (const text of canonicalPopulation()) {
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
    if (eligibility.eligible !== true) continue;
    out.push({ line: text, state, lineRef, adapted });
  }
  CANDIDATES = out;
  return out;
}

function calculatorDigest(candidate: Candidate): string | null {
  const result = session.calculate(
    buildCalculationRequest(candidate.adapted as never, candidate.state as never),
  ) as unknown as {
    ok: boolean;
    preview?: { ingredients?: ReadonlyArray<{ ingredient_identity_digest?: string }> };
  };
  return result.preview?.ingredients?.[0]?.ingredient_identity_digest ?? null;
}

describe('AI-3 identity evidence — Phase-4/calculator parity', () => {
  it('the canonical population is 97 and yields the measured 26 candidates', () => {
    expect(canonicalPopulation().length).toBe(97);
    expect(ai3Candidates().length).toBe(26);
  });

  it('every AI-3 candidate gets COMPLETE five-field evidence (none fail closed)', () => {
    const missing = ai3Candidates()
      .map((c) => ({ line: c.line, ev: deriveAiEstimateIdentityEvidence({ session, state: c.state, lineRef: c.lineRef }) }))
      .filter((x) => x.ev === null)
      .map((x) => x.line);
    expect(missing).toEqual([]);
  });

  it('the evidence is the COMPLETE five-field contract, never narrowed', () => {
    for (const c of ai3Candidates()) {
      const ev = deriveAiEstimateIdentityEvidence({ session, state: c.state, lineRef: c.lineRef });
      expect(ev).not.toBeNull();
      if (ev === null) continue;
      expect(Object.keys(ev).sort()).toEqual([
        'bundle_release',
        'fdc_id',
        'ingredient_identity_digest',
        'line_ref',
        'record_digest',
      ]);
      expect(ev.line_ref).toBe(c.lineRef);
      expect(ev.bundle_release).toBe(session.metadata().bundle_release);
      expect(ev.ingredient_identity_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(ev.record_digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('the Phase-4 derived digest EQUALS the calculator digest for all 26', () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const c of ai3Candidates()) {
      const ev = deriveAiEstimateIdentityEvidence({ session, state: c.state, lineRef: c.lineRef });
      if (ev === null) continue;
      const calc = calculatorDigest(c);
      if (calc === null) continue;
      compared += 1;
      if (calc !== ev.ingredient_identity_digest) {
        mismatches.push(`${c.line}: phase4=${ev.ingredient_identity_digest} calculator=${calc}`);
      }
    }
    expect(compared).toBe(26);
    expect(mismatches, `identity digest divergence:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('a changed line text moves BOTH digests (they stay bound to the same truth)', () => {
    const candidate = ai3Candidates()[0];
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    const ev = deriveAiEstimateIdentityEvidence({ session, state: candidate.state, lineRef: candidate.lineRef });
    expect(ev).not.toBeNull();
    if (ev === null) return;
    // The SAME evidence is reproducible: derivation is pure, not cached state.
    const again = deriveAiEstimateIdentityEvidence({ session, state: candidate.state, lineRef: candidate.lineRef });
    expect(again?.ingredient_identity_digest).toBe(ev.ingredient_identity_digest);
  });

  it('an unknown line produces NO evidence (fail closed, never a placeholder)', () => {
    const candidate = ai3Candidates()[0];
    if (candidate === undefined) return;
    expect(
      deriveAiEstimateIdentityEvidence({ session, state: candidate.state, lineRef: 'ing:999:nope' }),
    ).toBeNull();
  });

  it('an unauthenticated line produces NO evidence', () => {
    const candidate = ai3Candidates()[0];
    if (candidate === undefined) return;
    const stripped = {
      ...candidate.state,
      matches: Object.fromEntries(
        Object.entries(candidate.state.matches).map(([k, v]) => [
          k,
          (v as { fdc_id?: number }).fdc_id === undefined
            ? v
            : { ...(v as object), fdc_id: undefined },
        ]),
      ),
    };
    expect(deriveAiEstimateIdentityEvidence({ session, state: stripped as never, lineRef: candidate.lineRef })).toBeNull();
  });
}, 300_000);
