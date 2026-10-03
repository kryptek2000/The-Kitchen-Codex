/**
 * AI-3 — PRODUCTION REACHABILITY WITNESS (the closing witness for Muse
 * IMPORTANT-1: "no production parent supplies `onEstimateMassesWithAi`").
 *
 * The defect was a real dead end: `AdvancedNutritionCard` and
 * `AdvancedNutritionModal` both CONSUMED `onEstimateMassesWithAi`, and no
 * parent ever SUPPLIED it, so `Estimate remaining amounts with AI` could never
 * render in the shipped app.
 *
 * This witness has two halves, because the composition is two different kinds
 * of fact:
 *
 *   1. THE WIRING is a structural fact about four source files. It is proven by
 *      pinning the exact create-and-forward chain:
 *        App -> RecipeDetailView -> RecipeNutritionSection -> AdvancedNutritionCard
 *      including that App builds the callback by calling the ONE approved
 *      application adapter, and that the endpoint is the one dedicated route.
 *
 *   2. THE BEHAVIOUR is a runtime fact. It is proven by driving the REAL
 *      `requestAiMassEstimateOffers` adapter over the REAL pinned USDA bundle
 *      and the REAL Phase-4 session, and showing: a Basic tier makes ZERO
 *      transport calls, an AI Advanced tier makes exactly ONE dedicated request,
 *      the returned offer carries COMPLETE five-field evidence, and the offer is
 *      INERT (it does not touch working state, the preview or Apply).
 *
 * LIMITATION, stated honestly: this repository has no React mount harness, so
 * the four React hops are proven structurally (source pins) plus behaviourally at
 * the adapter boundary, NOT by mounting <App/>. That is weaker than a full
 * render; it is not claimed to be a render test.
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
import {
  evaluateAiEstimateEligibility,
  deriveAiEstimateParseFacts,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { deriveAiEstimateIdentityEvidence } from '../../src/core/nutritionV2/phase4/aiEstimateIdentityEvidence';
import { hasActiveAiEstimateForPreview } from '../../src/core/nutritionV2/phase4/aiEstimateApplyGate';
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

// ---------------------------------------------------------------------------
// 1. THE WIRING — the exact chain that used to be dead
// ---------------------------------------------------------------------------
describe('AI-3 reachability — the production chain is connected end to end', () => {
  it('App CREATES the callback from the ONE approved application adapter', () => {
    const app = src('src/App.tsx');
    expect(app).toContain('handleEstimateMassesWithAi');
    expect(app).toContain('requestAiMassEstimateOffers');
    // It must not re-implement orchestration, parsing, hashing or selection.
    expect(app).not.toMatch(/computeIngredientIdentityDigest/);
    expect(app).not.toMatch(/evaluateAiEstimateEligibility/);
    expect(app).not.toMatch(/select_ai_estimate/);
    // Exactly one dedicated route, and it is not the AI-2 planning route.
    expect(app).toContain("'/api/nutrition/estimate-mass'");
  });

  it('App PASSES the callback to RecipeDetailView', () => {
    expect(src('src/App.tsx')).toContain('onEstimateMassesWithAi={handleEstimateMassesWithAi}');
    expect(src('src/App.tsx')).toContain('<RecipeDetailView');
  });

  it('RecipeDetailView DECLARES and FORWARDS the prop', () => {
    const view = src('src/components/RecipeDetailView.tsx');
    expect(view).toContain('onEstimateMassesWithAi?:');
    expect(view).toContain('onEstimateMassesWithAi={onEstimateMassesWithAi}');
  });

  it('RecipeNutritionSection DECLARES and FORWARDS the prop', () => {
    const section = src('src/components/RecipeNutritionSection.tsx');
    expect(section).toContain('onEstimateMassesWithAi?:');
    expect(section).toContain('onEstimateMassesWithAi={onEstimateMassesWithAi}');
    expect(section).toContain('<AdvancedNutritionCard');
  });

  it('AdvancedNutritionCard CONSUMES it and the modal renders the button', () => {
    const card = src('src/components/AdvancedNutritionCard.tsx');
    expect(card).toContain('onEstimateMassesWithAi?:');
    // The card is the ONLY caller of the port, and only on an explicit click.
    expect(card).toContain('await onEstimateMassesWithAi({');
    const modal = src('src/components/AdvancedNutritionModal.tsx');
    expect(modal).toContain('onEstimateMassesWithAi');
    expect(modal).toContain('Estimate remaining amounts with AI');
  });

  it('no UI component imports server or provider code', () => {
    for (const rel of [
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
      'src/components/RecipeNutritionSection.tsx',
      'src/components/RecipeDetailView.tsx',
    ]) {
      const text = src(rel);
      expect(text, rel).not.toMatch(/from '.*server\//);
      expect(text, rel).not.toMatch(/api\/nutrition\/estimate-mass/);
      expect(text, rel).not.toMatch(/estimateMassOnServer/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE BEHAVIOUR — capability authority and the inert offer
// ---------------------------------------------------------------------------
interface Flow {
  readonly line: string;
  readonly state: Phase4State;
  readonly lineRef: string;
  readonly outcome: string;
}

// The pipeline walk over the canonical 97 lines is real work (~19s), so it is
// computed ONCE and shared. This is memoization of a test fixture, not a
// production cache.
let flowsCache: ReadonlyArray<Flow> | null = null;
function ai3Flows(): ReadonlyArray<Flow> {
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
    out.push({ line: text, state, lineRef, outcome: live.status });
  }
  flowsCache = out;
  return out;
}

const CAPS = {
  basic: resolveNutritionCapabilities({ aiConfigured: false, aiReachable: false }),
  advanced: resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }),
};

function stubTransport(lines: ReadonlyArray<string>) {
  const request = vi.fn(async (sent: { request_id: string }) => ({
    ok: true,
    // The dedicated route echoes the request id; the adapter refuses anything
    // else as `request_binding_mismatch`.
    request_id: sent.request_id,
    estimates: lines.map((line_ref) => ({
      line_ref,
      policy_version: AI_ESTIMATE_POLICY_VERSION,
      provenance_class: AI_ESTIMATE_PROVENANCE_CLASS,
      lower_grams: 150,
      upper_grams: 200,
      representative_grams: 175,
      representative_policy: 'midpoint',
    })),
  }));
  return { request };
}

describe('AI-3 reachability — capability authority', () => {
  it('the Basic tier makes ZERO transport calls', async () => {
    expect(CAPS.basic.aiEstimation).not.toBe('available');
    const flow = ai3Flows()[0];
    expect(flow).toBeDefined();
    if (flow === undefined) return;
    const transport = stubTransport([flow.lineRef]);
    const result = await requestAiMassEstimateOffers({
      state: flow.state,
      lines: [{ line_ref: flow.lineRef, original_text: flow.line, outcome: flow.outcome }],
      capabilities: CAPS.basic,
      session,
      transport,
    });
    expect(transport.request).not.toHaveBeenCalled();
    expect(result.offers).toEqual([]);
  }, 60_000);

  it('the AI Advanced tier may execute and makes exactly ONE dedicated request', async () => {
    expect(CAPS.advanced.aiEstimation).toBe('available');
    const flow = ai3Flows()[0];
    if (flow === undefined) return;
    const transport = stubTransport([flow.lineRef]);
    const result = await requestAiMassEstimateOffers({
      state: flow.state,
      lines: [{ line_ref: flow.lineRef, original_text: flow.line, outcome: flow.outcome }],
      capabilities: CAPS.advanced,
      session,
      transport,
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(result.offers.length).toBeGreaterThan(0);
  }, 60_000);

  it('the adapter has no raw capability flag a caller could forge', () => {
    const app = src('src/App.tsx');
    // App supplies the shell's ONE resolved decision and nothing else. Since AI-5C
    // that decision is the COMPOSED effective capability (product entitled AND
    // operationally ready), resolved through the single centralized callback.
    expect(app).toContain('capabilities: await resolveEffectiveNutritionCapabilitiesOnce()');
    // The projection is the only way a capability value reaches a port, and it never
    // re-derives availability from provider state or product state on its own.
    expect(app).toContain('const toEffectiveNutritionCapabilities = useCallback');
    const adapter = src('src/application/nutritionAiEstimate.ts');
    // The adapter's own gate reads that value verbatim.
    expect(adapter).toContain("const capabilities = input.capabilities;");
  });
});

describe('AI-3 reachability — the returned offer is inert but fully evidenced', () => {
  it('every actionable offer carries COMPLETE five-field evidence', async () => {
    const flows = ai3Flows();
    expect(flows.length).toBe(26);
    for (const flow of flows) {
      const transport = stubTransport([flow.lineRef]);
      const result = await requestAiMassEstimateOffers({
        state: flow.state,
        lines: [{ line_ref: flow.lineRef, original_text: flow.line, outcome: flow.outcome }],
        capabilities: CAPS.advanced,
        session,
        transport,
      });
      for (const offer of result.offers) {
        expect(Object.keys(offer.evidence).sort()).toEqual([
          'bundle_release',
          'fdc_id',
          'ingredient_identity_digest',
          'line_ref',
          'record_digest',
        ]);
        const expected = deriveAiEstimateIdentityEvidence({
          session,
          state: flow.state,
          lineRef: offer.line_ref,
        });
        expect(offer.evidence.ingredient_identity_digest).toBe(expected?.ingredient_identity_digest);
        expect(offer.representative_policy).toBe('midpoint');
      }
    }
  }, 300_000);

  it('an offer does NOT enter working state, the preview, or the Apply gate', async () => {
    const flow = ai3Flows()[0];
    if (flow === undefined) return;
    const before = JSON.stringify({ rows: flow.state.rows, matches: flow.state.matches, ai: flow.state.aiEstimates ?? null, op: flow.state.operationSeq });
    const transport = stubTransport([flow.lineRef]);
    const result = await requestAiMassEstimateOffers({
      state: flow.state,
      lines: [{ line_ref: flow.lineRef, original_text: flow.line, outcome: flow.outcome }],
      capabilities: CAPS.advanced,
      session,
      transport,
    });
    expect(result.offers.length).toBeGreaterThan(0);
    // The adapter received the state read-only; it returned offers, not state.
    expect(result).not.toHaveProperty('state');
    const after = JSON.stringify({ rows: flow.state.rows, matches: flow.state.matches, ai: flow.state.aiEstimates ?? null, op: flow.state.operationSeq });
    expect(after).toBe(before);
    // No estimate is active, so the Apply gate is NOT tripped by the offer.
    expect(hasActiveAiEstimateForPreview(flow.state)).toBe(false);
  }, 60_000);
});
