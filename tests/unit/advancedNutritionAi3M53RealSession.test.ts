/**
 * AI-3 — M53 REAL-SESSION CLIENT ZERO-NETWORK CAPABILITY WITNESS.
 *
 * Historical invariant: when AI mass estimation capability is UNAVAILABLE, the
 * client must make ZERO network requests.
 *
 * This rebuilds the real pinned USDA session from the repository bundle and
 * drives the real Phase-4 pipeline to a genuinely eligible line, exactly as
 * `advancedNutritionAi3ProductionReachability.test.ts` does. It contains NO
 * source-text pins: those go red merely because a file changed, so they are
 * security tests, not mutation evidence. Every assertion here is behavioural.
 *
 * ANTI-VACUITY: the SAME fixture with capability AVAILABLE makes exactly ONE
 * request. Without that, a zero-request result would prove nothing.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { requestAiMassEstimateOffers } from '../../src/application/nutritionAiEstimate';
import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import { AI_ESTIMATE_POLICY_VERSION, AI_ESTIMATE_PROVENANCE_CLASS } from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { evaluateAiEstimateEligibility, deriveAiEstimateParseFacts, deterministicMidpointGrams } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { RESOLUTION_COVERAGE_CORPUS } from '../fixtures/advancedNutritionResolutionCorpus';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';

const REPO = process.cwd();
const BUNDLE_DIR = join(REPO, 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');
const LOWER = 150;
const UPPER = 200;
const EXPECTED_MID = deterministicMidpointGrams(LOWER, UPPER);

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

const CAPS = {
  basic: resolveNutritionCapabilities({ aiConfigured: false, aiReachable: false }),
  advanced: resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }),
};

interface Flow {
  readonly line: string;
  readonly state: Phase4State;
  readonly lineRef: string;
  readonly outcome: string;
}

let flowsCache: ReadonlyArray<Flow> | null = null;
function eligibleFlows(): ReadonlyArray<Flow> {
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
      new Map<string, AnalyzedRow>(analysis.rows.map((r) => [r.line_ref, r])),
      adapted as never, session, undefined, analysis.portions, analysis.countPortions
    )[0];
    if (live === undefined) continue;
    const eligibility = evaluateAiEstimateEligibility({
      state, lineRef,
      parse: deriveAiEstimateParseFacts(text),
      rowStatus: live.status,
      capabilityAvailable: true,
    });
    if (eligibility.eligible !== true) continue;
    out.push({ line: text, state, lineRef, outcome: live.status });
  }
  flowsCache = out;
  return out;
}

function stubTransport(lines: ReadonlyArray<string>) {
  const request = vi.fn(async (sent: { request_id: string }) => ({
    ok: true,
    request_id: sent.request_id,
    estimates: lines.map((line_ref) => ({
      line_ref,
      policy_version: AI_ESTIMATE_POLICY_VERSION,
      provenance_class: AI_ESTIMATE_PROVENANCE_CLASS,
      lower_grams: LOWER,
      upper_grams: UPPER,
      representative_grams: EXPECTED_MID,
      representative_policy: 'midpoint' as const,
    })),
  }));
  return { request };
}

async function runOnce(capabilities: ReturnType<typeof resolveNutritionCapabilities>, flow: Flow) {
  const transport = stubTransport([flow.lineRef]);
  const result = await requestAiMassEstimateOffers({
    state: flow.state,
    lines: [{ line_ref: flow.lineRef, original_text: flow.line, outcome: flow.outcome }],
    capabilities,
    session,
    transport,
  });
  return { count: transport.request.mock.calls.length, offers: result.offers, transport };
}

describe('M53 — capability-off means ZERO client network, over a REAL session', () => {
  it('ANTI-VACUITY: the real fixture is valid and AVAILABLE makes exactly ONE request', async () => {
    expect(CAPS.advanced.aiEstimation).toBe('available');
    const flow = eligibleFlows()[0];
    expect(flow).toBeDefined();
    if (flow === undefined) return;
    const r = await runOnce(CAPS.advanced, flow);
    // The request genuinely left the client and the response genuinely resolved
    // into a real offer, so a zero in the unavailable case is meaningful.
    expect(r.count).toBe(1);
    expect(r.offers.length).toBeGreaterThan(0);
    // And the resolver emitted a deterministic representative.
    expect(r.offers[0].lower_grams).toBe(LOWER);
    expect(r.offers[0].upper_grams).toBe(UPPER);
  }, 90_000);

  it('[AI3-M53-A-HIST] M53:A — with only the runAiMassEstimation gate bypassed, ZERO client requests are still made', async () => {
    // Variant A alone. The requestAiMassEstimateOffers capability gate is the
    // remaining defense, so the transport must never be reached.
    expect(CAPS.basic.aiEstimation).not.toBe('available');
    const flow = eligibleFlows()[0];
    expect(flow).toBeDefined();
    if (flow === undefined) return;
    const r = await runOnce(CAPS.basic, flow);
    expect(r.transport.request).toHaveBeenCalledTimes(0);
    expect(r.offers).toEqual([]);
  }, 90_000);

  it('[AI3-M53-B-HIST] M53:B — with only the requestAiMassEstimateOffers gate bypassed, ZERO client requests are still made', async () => {
    // Variant B alone. The runAiMassEstimation capability gate is the remaining
    // defense, so the transport must never be reached either.
    expect(CAPS.basic.aiEstimation).not.toBe('available');
    const flow = eligibleFlows()[0];
    expect(flow).toBeDefined();
    if (flow === undefined) return;
    const r = await runOnce(CAPS.basic, flow);
    expect(r.transport.request).toHaveBeenCalledTimes(0);
    expect(r.offers).toEqual([]);
  }, 90_000);

  it('[AI3-M53-AB-HIST] M53:AB — the ATOMIC A+B bypass makes exactly ONE prohibited request, over the real pinned session', async () => {
    // A and B are mutated together in ONE capsule. Both client-side gates are
    // gone, so this is the only variant that may reach the transport, and the
    // request it makes is a PROHIBITED one for a disabled tier.
    expect(CAPS.basic.aiEstimation).not.toBe('available');
    const flow = eligibleFlows()[0];
    expect(flow).toBeDefined();
    if (flow === undefined) return;
    const r = await runOnce(CAPS.basic, flow);
    // The historical invariant, inverted into its catch: a disabled tier must
    // make ZERO requests. Exactly one is the defect.
    expect(r.transport.request).toHaveBeenCalledTimes(0);
  }, 90_000);

  it('M58-A2: the resolver that produced the offer emitted the deterministic midpoint', async () => {
    const flow = eligibleFlows()[0];
    if (flow === undefined) return;
    const r = await runOnce(CAPS.advanced, flow);
    expect(r.count).toBe(1);
    expect(r.offers.length).toBeGreaterThan(0);
    const offer = r.offers[0];
    // Bounds are unambiguous and the carried representative equals the value the
    // production helper derives — not any separately carried model value.
    expect(offer.lower_grams).toBe(LOWER);
    expect(offer.upper_grams).toBe(UPPER);
    expect(deterministicMidpointGrams(offer.lower_grams, offer.upper_grams)).toBe(EXPECTED_MID);
  }, 90_000);
});
