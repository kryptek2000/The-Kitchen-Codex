/**
 * AI-3 — ELIGIBILITY AUTHORITY REPAIR: regression tests for the three defects.
 *
 * 1. AUTHORED MASS IS ABSOLUTE INELIGIBILITY. A line the deterministic parser
 *    already weighed (scalar mass, written mass range, authoritative secondary
 *    mass) must never be AI-3 eligible. Previously `hasDirectMass` was a DEAD
 *    parameter: `effectiveMassDecisionFor` accepted it and never read it, so
 *    `1.5 lb ground beef` and `100 g tomatoes` were offered estimates.
 * 2. THE LINE MUST BE A CURRENT ACTIONABLE AMOUNT EXCEPTION. An already-resolved
 *    row (direct mass, source portion, count portion, household portion) or a
 *    non-actionable row (needs_match, review_suggested, qualitative) is refused.
 * 3. A WRITTEN QUANTITY RANGE IS USABLE QUANTITY. `2-3 tomatoes` must not be
 *    abstained merely because the scalar `amount` is null.
 *
 * The corpus block drives the REAL pipeline over the canonical 97-line
 * benchmark population and asserts the cross-check invariant: no
 * already-resolved benchmark row may be AI-3 eligible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  evaluateAiEstimateEligibility,
  hasUsableQuantity,
  AI_ESTIMATE_ROW_ACTIONABLE,
  type AiEstimateParseFacts,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { RESOLUTION_COVERAGE_CORPUS } from '../fixtures/advancedNutritionResolutionCorpus';
import type { Phase4State } from '../../src/core/nutritionV2/phase4/types';

const LINE = 'ing:0:elig';
const BUNDLE_DIR = join(process.cwd(), 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');

function stateWithMatch(over: Partial<Phase4State> = {}): Phase4State {
  return {
    ...INITIAL_PHASE4_STATE,
    status: 'ready',
    recipeKey: 'r1',
    sessionIdentity: 's1',
    rows: [{ line_ref: LINE, original_text: '2 onions', query: 'onion' }],
    matches: { [LINE]: { fdc_id: 2709223, record_digest: 'rd', review_digest: 'vd' } },
    ...over,
  } as unknown as Phase4State;
}

const BASE_PARSE: AiEstimateParseFacts = {
  hasDirectMass: false,
  directMassGrams: null,
  amount: 2,
  quantityRange: null,
  container: null,
};

function evaluate(over: {
  state?: Phase4State;
  parse?: Partial<AiEstimateParseFacts>;
  rowStatus?: string;
  capability?: boolean;
}) {
  return evaluateAiEstimateEligibility({
    state: over.state ?? stateWithMatch(),
    lineRef: LINE,
    parse: { ...BASE_PARSE, ...(over.parse ?? {}) },
    rowStatus: over.rowStatus ?? AI_ESTIMATE_ROW_ACTIONABLE,
    capabilityAvailable: over.capability ?? true,
  });
}

describe('AI-3 eligibility repair — A. authored mass is absolute ineligibility', () => {
  it('[AI3-M59-HIST] a scalar authored metric mass refuses with direct_mass_authority', () => {
    const r = evaluate({ parse: { hasDirectMass: true, directMassGrams: 680.4 } });
    expect(r.eligible).toBe(false);
    if (r.eligible === false) expect(r.reason).toBe('direct_mass_authority');
  });

  it('authored mass refuses even when grams are absent (no placeholder is required)', () => {
    const r = evaluate({ parse: { hasDirectMass: true, directMassGrams: null } });
    expect(r.eligible).toBe(false);
    if (r.eligible === false) expect(r.reason).toBe('direct_mass_authority');
  });

  it('hasDirectMass is NO LONGER a dead parameter', async () => {
    const { effectiveMassDecisionFor } = await import(
      '../../src/core/nutritionV2/phase4/aiEstimateValidation'
    );
    const withGrams = effectiveMassDecisionFor(stateWithMatch(), LINE, {
      hasDirectMass: true,
      directMassGrams: 680.4,
    });
    expect(withGrams.kind).toBe('direct_mass');
    // No fabricated grams: the flag alone cannot invent a value.
    const noGrams = effectiveMassDecisionFor(stateWithMatch(), LINE, {
      hasDirectMass: true,
      directMassGrams: null,
    });
    expect(noGrams.kind).not.toBe('direct_mass');
  });

  it('real benchmark mass lines are ineligible through the real pipeline', () => {
    for (const line of ['1.5 lb ground beef', '100 g tomatoes', '1 lb pork shoulder']) {
      const parsed = parseIngredient(line);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const p = parsed.parsed;
      expect(p.measurement_kind).toBe('mass');
      const r = evaluate({ parse: { hasDirectMass: true, directMassGrams: p.grams ?? null } });
      expect(r.eligible).toBe(false);
    }
  });

  it('a WRITTEN MASS RANGE is authored mass authority, not estimateable quantity', () => {
    const r = evaluate({
      parse: { hasDirectMass: true, directMassGrams: 900, amount: null, quantityRange: { lower: 3, upper: 4 } },
    });
    expect(r.eligible).toBe(false);
    if (r.eligible === false) expect(r.reason).toBe('direct_mass_authority');
  });
});

describe('AI-3 eligibility repair — B. the row must be a current actionable exception', () => {
  it('needs_amount + authenticated identity may proceed', () => {
    expect(evaluate({}).eligible).toBe(true);
  });

  it('an already-resolved source portion forbids AI-3', () => {
    const s = stateWithMatch({ portions: { [LINE]: { portion_index: 1, grams: 158 } } } as never);
    const r = evaluate({ state: s });
    expect(r.eligible).toBe(false);
    if (r.eligible === false) expect(r.reason).toBe('stronger_mass_source');
  });

  it('an already-resolved count portion forbids AI-3', () => {
    const s = stateWithMatch({ countPortions: { [LINE]: { portion_index: 1, grams: 150 } } } as never);
    expect(evaluate({ state: s }).eligible).toBe(false);
  });

  it('an already-resolved household portion forbids AI-3', () => {
    const s = stateWithMatch({ householdPortions: { [LINE]: { unit: 'cup', size_class: 'small' } } } as never);
    expect(evaluate({ state: s }).eligible).toBe(false);
  });

  it('a user mass forbids AI-3', () => {
    const s = stateWithMatch({ userMasses: { [LINE]: { grams: 120 } } } as never);
    expect(evaluate({ state: s }).eligible).toBe(false);
  });

  it('an unresolved identity forbids AI-3', () => {
    const s = stateWithMatch({ matches: {} } as never);
    const r = evaluate({ state: s });
    expect(r.eligible).toBe(false);
    if (r.eligible === false) expect(r.reason).toBe('identity_unresolved');
  });

  it('[AI3-M61-HIST] a NON-actionable live status forbids AI-3 even with a clean parse and identity', () => {
    for (const status of ['matched', 'needs_match', 'review_suggested', 'qualitative']) {
      const r = evaluate({ rowStatus: status });
      expect(r.eligible, `status ${status} must not be eligible`).toBe(false);
      if (r.eligible === false) expect(r.reason).toBe('not_actionable');
    }
  });

  it('an unknown/missing status fails CLOSED', () => {
    const r = evaluate({ rowStatus: 'unknown' });
    expect(r.eligible).toBe(false);
  });
});

describe('AI-3 eligibility repair — C. a written quantity range is usable quantity', () => {
  it('[AI3-M60-HIST] 2-3 tomatoes has a real deterministic quantity range', () => {
    const parsed = parseIngredient('2-3 tomatoes');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const p = parsed.parsed;
    expect(p.amount).toBeNull();
    expect(p.quantity_range).not.toBeNull();
    expect(hasUsableQuantity({
      hasDirectMass: false,
      amount: p.amount,
      quantityRange: { lower: p.quantity_range!.lower, upper: p.quantity_range!.upper },
      container: null,
    })).toBe(true);
  });

  it('a written range keeps BOTH bounds; no scalar is invented', () => {
    const r = evaluate({ parse: { amount: null, quantityRange: { lower: 2, upper: 3 } } });
    expect(r.eligible).toBe(true);
  });

  it('a degenerate range is not usable quantity', () => {
    expect(hasUsableQuantity({ hasDirectMass: false, amount: null, quantityRange: { lower: 0, upper: 0 }, container: null })).toBe(false);
    expect(hasUsableQuantity({ hasDirectMass: false, amount: null, quantityRange: { lower: 5, upper: 2 }, container: null })).toBe(false);
  });

  it('[AI3-M56A-HIST] pure qualitative quantity remains abstained', () => {
    const r = evaluate({ parse: { amount: null, quantityRange: null } });
    expect(r.eligible).toBe(false);
    if (r.eligible === false) expect(r.reason).toBe('no_usable_quantity');
  });

  it('authored mass is NOT counted as usable quantity for estimation', () => {
    // it is absolute ineligibility, checked earlier -- not a licence to estimate
    expect(hasUsableQuantity({ hasDirectMass: true, amount: null, quantityRange: null, container: null })).toBe(false);
  });
});

describe('AI-3 eligibility repair — D. the canonical 97-line corpus invariant', async () => {
  const loaded = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  } as never);
  const session = loaded.ok ? loaded.session : null;

  function population(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of RESOLUTION_COVERAGE_CORPUS) {
      if (seen.has(e.line)) continue;
      seen.add(e.line);
      out.push(e.line);
    }
    return out;
  }

  it('the canonical benchmark population is 97 distinct authored lines', () => {
    expect(RESOLUTION_COVERAGE_CORPUS.length).toBe(145);
    expect(population().length).toBe(97);
  });

  it('no duplicate authored line is counted twice', () => {
    const all = population();
    expect(new Set(all).size).toBe(all.length);
  });

  it('NO already-resolved benchmark row is AI-3 eligible', async () => {
    expect(session).not.toBeNull();
    if (session === null) return;
    const violations: string[] = [];
    for (const text of population()) {
      const parsed = parseIngredient(text);
      const ing = {
        original: text,
        ...(parsed.ok && parsed.parsed.amount !== null ? { amount: parsed.parsed.amount } : {}),
        ...(parsed.ok && parsed.parsed.raw_unit !== undefined ? { unit: parsed.parsed.raw_unit } : {}),
        ...(parsed.ok ? { name: parsed.parsed.query } : {}),
      };
      const recipe = { title: 't', servings: 1, ingredients: [ing] };
      const ad = adaptRecipe(recipe as never);
      if (!ad.ok) continue;
      const adapted = ad.recipe.adapted;
      const an = analyzeRecipe(session, adapted, 1);
      let st = phase4Reducer(INITIAL_PHASE4_STATE, {
        type: 'initialize', recipeKey: ad.recipe.recipe_key, sessionIdentity: 't',
        rows: buildReviewRows(session, adapted), baseServings: 1,
      } as never);
      st = phase4Reducer(st, {
        type: 'apply_analysis', matches: an.matches, portions: an.portions,
        countPortions: an.countPortions, householdPortions: an.householdPortions, preview: an.preview,
      } as never);
      const lineRef = adapted[0].line_ref;
      const live = projectLiveRows(
        st, new Map(an.rows.map((r) => [r.line_ref, r])), adapted, session,
        undefined, an.portions, an.countPortions
      )[0];
      if (live === undefined) continue;
      if (!(live.status === 'matched' && live.resolved_grams !== undefined)) continue;

      const p = parsed.ok ? parsed.parsed : null;
      const grams = p !== null && typeof p.grams === 'number' ? p.grams : null;
      const r = evaluateAiEstimateEligibility({
        state: st, lineRef,
        parse: {
          hasDirectMass: p !== null && p.measurement_kind === 'mass' && grams !== null,
          directMassGrams: grams,
          amount: p !== null ? p.amount : null,
          quantityRange: p !== null && p.quantity_range ? { lower: p.quantity_range.lower, upper: p.quantity_range.upper } : null,
          container: null,
        },
        rowStatus: live.status,
        capabilityAvailable: true,
      });
      if (r.eligible === true) violations.push(text);
    }
    expect(violations, `resolved rows wrongly eligible: ${violations.join(' | ')}`).toEqual([]);
    // This test drives the real Phase-4 pipeline over all 97 canonical
    // benchmark lines, so it legitimately needs more than the default budget.
  }, 300_000);
});
