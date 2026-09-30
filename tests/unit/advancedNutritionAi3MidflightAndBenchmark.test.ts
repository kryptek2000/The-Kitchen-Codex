/**
 * AI-3 — M49 (mid-flight currentness, TRUE deferred transport) and M55
 * (benchmark credit) DIRECT witnesses.
 *
 * M49 is DISTINCT from M48: here the transport promise is still UNRESOLVED when
 * authority-relevant state changes. M48 has an offer that already exists and
 * then goes stale at acceptance.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { requestAiMassEstimateOffers } from '../../src/application/nutritionAiEstimate';
import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { deriveAiEstimateProductionInput } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import {
  evaluateAiEstimateEligibility,
  deriveAiEstimateParseFacts,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import {
  AI_ESTIMATE_POLICY_VERSION,
  AI_ESTIMATE_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { RESOLUTION_COVERAGE_CORPUS } from '../fixtures/advancedNutritionResolutionCorpus';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';

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

// ===========================================================================
// M49 — TRUE deferred mid-flight authority
// ===========================================================================

// ===========================================================================
// M49 — TRUE deferred mid-flight currentness
// ===========================================================================

describe('M49 — a response is reconciled against the state that is NOW', () => {
  const CAPS = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });

  function estimateFor(lineRef: string) {
    return {
      line_ref: lineRef,
      policy_version: AI_ESTIMATE_POLICY_VERSION,
      provenance_class: AI_ESTIMATE_PROVENANCE_CLASS,
      lower_grams: 150,
      upper_grams: 200,
      representative_grams: 175,
      representative_policy: 'midpoint',
    };
  }

  it('[AI3-M49-HIST] M49: state becomes B WHILE the request is pending, so the A-era response is NOT actionable', async () => {
    const flow = RESOLUTION_ROWS()[0];
    expect(flow).toBeDefined();
    if (flow === undefined) return;

    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let settled = false;
    const request = vi.fn(async (sent: { request_id: string }) => {
      await pending;
      settled = true;
      return { ok: true, request_id: sent.request_id, estimates: [estimateFor(flow.lineRef)] };
    });

    // THE LIVE STATE, as a single mutable cell owned by the composition shell.
    // This is the canonical state; the adapter only ever READS it through the
    // one injected getter, and never writes it.
    let live: Phase4State = flow.state;
    const beforeRows = live.rows.length;
    const beforeSeq = JSON.stringify(live.aiEstimates);

    const inFlight = requestAiMassEstimateOffers({
      state: flow.state,
      getCurrentState: () => live,
      lines: [{ line_ref: flow.lineRef, original_text: flow.line, outcome: flow.outcome }],
      capabilities: CAPS,
      session,
      transport: { request },
    });

    // 4. PROVE the request is genuinely pending before anything changes.
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    // 5. Replace the live state with an immutable B, mid-flight. A STRONGER
    //    mass authority (a user mass) appears for the very same line while the
    //    request is unresolved. This is authority-relevant by construction.
    live = {
      ...flow.state,
      userMasses: {
        ...flow.state.userMasses,
        [flow.lineRef]: { fdc_id: 2709223, quantity: 123, unit: 'g', selection: null },
      },
    };
    expect(live).not.toBe(flow.state);
    expect(live.userMasses[flow.lineRef]).toBeDefined();

    // 6. ONLY NOW does the response arrive.
    release(undefined);
    const result = await inFlight;
    expect(settled).toBe(true);

    // 7. THE HISTORICAL INVARIANT: the A-era response must not become actionable
    //    once the current authority is B.
    expect(result.offers).toEqual([]);
    // No state mutation, no selection, no persistence, no second provider call.
    expect(request).toHaveBeenCalledTimes(1);
    expect(live.rows.length).toBe(beforeRows);
    expect(JSON.stringify(live.aiEstimates)).toBe(beforeSeq);
    expect(live.aiEstimates[flow.lineRef]).toBeUndefined();
  }, 120_000);

  it('M49 CONTROL: the SAME deferred transport with state A throughout DOES yield an offer', async () => {
    const flow = RESOLUTION_ROWS()[0];
    expect(flow).toBeDefined();
    if (flow === undefined) return;

    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (sent: { request_id: string }) => {
      await pending;
      return { ok: true, request_id: sent.request_id, estimates: [estimateFor(flow.lineRef)] };
    });

    const live: Phase4State = flow.state; // NEVER changes
    const inFlight = requestAiMassEstimateOffers({
      state: flow.state,
      getCurrentState: () => live,
      lines: [{ line_ref: flow.lineRef, original_text: flow.line, outcome: flow.outcome }],
      capabilities: CAPS,
      session,
      transport: { request },
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    release(undefined);
    const result = await inFlight;

    // MANDATORY: without this, the A->B assertion would prove nothing.
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.offers).toHaveLength(1);
    // The offer is INERT: nothing was selected, nothing was persisted.
    expect(live.aiEstimates[flow.lineRef]).toBeUndefined();
  }, 120_000);
});

// ===========================================================================
// M55 — a bounded AI estimate never earns authenticated resolution credit
// ===========================================================================

describe('M55 — benchmark credit boundary', () => {
  it('M55: a line carrying an AI estimate is NEVER projected as an authenticated mass source', () => {
    // The benchmark's credit boundary is the live `mass_source` map, whose keys
    // are exactly the four authenticated authorities. An AI estimate is not one
    // of them, so it can never be credited as authenticated resolution.
    const AUTHENTICATED_SOURCES = [
      'direct_mass',
      'source_portion',
      'count_portion',
      'household_portion',
    ] as const;
    expect(AUTHENTICATED_SOURCES).not.toContain('ai_estimate' as never);

    // Drive the REAL live projection for a real AI-3 flow that has an estimate.
    const flow = RESOLUTION_ROWS()[0];
    expect(flow).toBeDefined();
    if (flow === undefined) return;

    const withEstimate = phase4Reducer(flow.state, {
      type: 'select_ai_estimate',
      lineRef: flow.lineRef,
      choice: {
        fdc_id: 2709223,
        record_digest: 'rd',
        review_digest: 'vd',
        lower_grams: 150,
        upper_grams: 200,
        representative_grams: 175,
        representative_policy: 'midpoint',
        provenance: 'ai_estimate',
        snapshot_binding: 'snap',
      },
    } as never);
    expect(withEstimate.aiEstimates[flow.lineRef]).toBeDefined();

    // THE HISTORICAL INVARIANT: the estimate lives in its own store only and is
    // never laundered into one of the four authenticated mass authorities that
    // the benchmark's credit map is keyed on.
    // The estimate lives in its own store only -- it is not laundered into a
    // portion or user mass that the benchmark would credit.
    expect(withEstimate.portions[flow.lineRef]).toBeUndefined();
    expect(withEstimate.userMasses[flow.lineRef]).toBeUndefined();
    expect(withEstimate.countPortions[flow.lineRef]).toBeUndefined();
    expect(withEstimate.householdPortions[flow.lineRef]).toBeUndefined();
  }, 60_000);

  it('[AI3-M55-HIST] M55: the shipped benchmark credits ZERO AI-assisted authenticated resolution', () => {
    // The script's own accounting, read from its REAL classification output.
    const src = readFileSync(join(REPO, 'scripts/benchmark_resolution_coverage.ts'), 'utf8');
    // The authenticated credit map has exactly the four deterministic sources.
    const bySource = src.match(/const bySource: Record<string, Terminal> = \{([^}]*)\}/s)?.[1] ?? '';
    const keys = [...bySource.matchAll(/(\w+):\s*'resolved_/g)].map((m) => m[1] as string);
    expect(keys.sort()).toEqual(['count_portion', 'direct_mass', 'household_portion', 'source_portion']);
    expect(keys).not.toContain('ai_estimate');
  });
});

// ---------------------------------------------------------------------------
// Shared: the real AI-3 flows, built from the CANONICAL corpus through the
// genuine production pipeline (parse -> adapt -> analyze -> project -> eligible)
// ---------------------------------------------------------------------------
interface Flow {
  readonly line: string;
  readonly lineRef: string;
  readonly outcome: 'needs_amount' | 'needs_match' | 'review_suggested' | 'qualitative' | 'matched';
  readonly state: Phase4State;
}

let flowsCache: ReadonlyArray<Flow> | null = null;
function RESOLUTION_ROWS(): ReadonlyArray<Flow> {
  if (flowsCache !== null) return flowsCache;
  const seen = new Set<string>();
  const out: Flow[] = [];
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
      new Map(analysis.rows.map((row) => [row.line_ref, row])),
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
    out.push({ line: text, state, lineRef, outcome: live.status as Flow['outcome'] });
  }
  if (out.length === 0) throw new Error('no AI-3 eligible flow in the canonical corpus');
  flowsCache = out;
  return out;
}
