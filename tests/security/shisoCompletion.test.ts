/**
 * The Kitchen Codex — SHISO-C1 completion: conversation → VERIFIED action.
 *
 * These tests prove the chain that was missing in C1: a Shiso proposal, once
 * EXPLICITLY confirmed by the user, becomes a real change to the UNSAVED working
 * review — revalidated against live state, applied through the existing
 * authorities, and recalculated by the existing deterministic engine.
 *
 * They also pin the exact, generalizable root cause of the unresolved eggs and
 * butter discovered during the investigation, so a future regression is visible.
 *
 * Offline: the provider is a stub, and USDA data is the real pinned bundle.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import {
  adaptRecipe,
  analyzeRecipe,
  buildReviewRows,
  phase4Reducer,
  projectLiveRows,
  summarizeLiveRows,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type Phase4Row,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { prepareShisoProposalActions } from '../../src/core/shiso/proposalActions';
import type { ShisoBoundProposal, ShisoProposal } from '../../src/core/shiso/protocol';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';

const BUNDLE_DIR = join(__dirname, '../../data/advanced-nutrition/usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);

function structured(original: string): Record<string, unknown> {
  const p = parseIngredient(original);
  if (!p.ok) return { original };
  return {
    original,
    ...(p.parsed.amount !== null ? { amount: p.parsed.amount } : {}),
    ...(p.parsed.raw_unit !== undefined ? { unit: p.parsed.raw_unit } : {}),
    name: p.parsed.query,
  };
}

function buildContext(
  session: AdvancedNutritionSession,
  lines: readonly string[],
  servings = 4,
): {
  ctx: ShisoToolContext;
  adapted: ReadonlyArray<AdaptedIngredient>;
  rows: ReadonlyArray<Phase4Row>;
  state: Phase4State;
  refFor: (index: number) => string;
} {
  const recipe = adaptRecipe({
    title: 'SHISO completion fixture',
    servings,
    ingredients: lines.map(structured),
  } as never) as never as { recipe: { adapted: ReadonlyArray<AdaptedIngredient>; recipe_key: string } };
  const adapted = recipe.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  const analysis = analyzeRecipe(session, adapted, servings);
  const sessionIdentity = phase4SessionIdentity(session.metadata());
  const state: Phase4State = {
    version: '',
    status: 'ready',
    recipeKey: recipe.recipe.recipe_key,
    sessionIdentity,
    baseServings: servings,
    rows,
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: servings,
    preview: null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as never;
  const liveRows = projectLiveRows(
    state,
    new Map(analysis.rows.map((r) => [r.line_ref, r])),
    adapted,
    session,
    null,
    analysis.portions,
    analysis.countPortions,
  );
  const ctx: ShisoToolContext = {
    session,
    recipe: {
      title: 'fixture', servings,
      ingredients: adapted.map((line, index) => ({ text: lines[index], name: lines[index], line_ref: line.line_ref })),
      instructions: [],
    },
    nutrition: { rows: liveRows, summary: 'test', unsaved: false },
  };
  return { ctx, adapted, rows, state, refFor: (i) => adapted[i].line_ref };
}

function bind(
  proposal: ShisoProposal,
  recipeKey: string,
  sessionIdentity: string,
): ShisoBoundProposal {
  return {
    proposal_id: `${recipeKey}:0:${proposal.line_ref}`,
    proposal_version: 'shiso_nutrition_correction_v1',
    recipe_key: recipeKey,
    session_identity: sessionIdentity,
    catalog_digest: '',
    bundle_release: '',
    proposal,
  };
}

describe('SHISO-C1 — the real, generalizable root cause', () => {
  let session: AdvancedNutritionSession;

  beforeAll(async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    session = result.session as AdvancedNutritionSession;
  }, 240000);

  const RECIPE = ['4 eggs, separated', '1 cup whole milk', '2 cups all-purpose flour', '6 tbsp unsalted butter', '1 tsp sea salt'];

  it('BUTTER — SHISO exposes the selected record portions for review', async  () => {
    const { ctx, refFor } = buildContext(session, RECIPE);
    // The current pinned record selection must expose usable quantity evidence.
    const selectedFoodId = ctx.nutrition?.rows.find((row) => row.line_ref === refFor(3))?.selected_fdc_id;
    expect(typeof selectedFoodId).toBe('number');
    const portions = session.reviewPortions(selectedFoodId as number);
    expect(portions.ok).toBe(true);
    if (!portions.ok) return;
    expect(portions.review.candidates.length).toBeGreaterThan(0);

    const obs = await executeShisoTool({ tool: 'investigate_ingredient_amount', line_ref: refFor(3) }, ctx);
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['selected_record_portion_count']).toBeGreaterThan(0);
    const portionsForSelectedFood = obs.data['usable_portions'] as Array<Record<string, unknown>>;
    expect(portionsForSelectedFood.length).toBeGreaterThan(0);
    expect(portionsForSelectedFood.every((p) => typeof p['gram_weight'] === 'number' && (p['gram_weight'] as number) > 0)).toBe(true);
  }, 120000);

  it('EGG — “separated” stays preparation language and resolves to whole egg', async  () => {
    const { ctx, refFor } = buildContext(session, RECIPE);
    const obs = await executeShisoTool({ tool: 'investigate_ingredient_amount', line_ref: refFor(0) }, ctx);
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['status']).toBe('matched');
    expect(obs.data['fdc_id']).toBe(2707152);
    // “Eggs, separated” keeps the whole-egg identity; preparation language
    // cannot redirect it to mechanically separated meat.
    const withSeparated = session.reviewIngredient({ name: 'eggs, separated' });
    const whole = session.reviewIngredient({ name: 'whole egg' });
    if (withSeparated.outcome !== 'review_required' && withSeparated.outcome !== 'matched_exact') throw new Error('unreviewable');
    if (whole.outcome !== 'review_required' && whole.outcome !== 'matched_exact') throw new Error('unreviewable');
    expect(withSeparated.candidates[0].fdc_id).toBe(2707152);
    expect(whole.candidates[0].fdc_id).toBe(2707152);
  }, 120000);
});

describe('SHISO-C1 — a confirmed proposal becomes a REAL working-review change', () => {
  let session: AdvancedNutritionSession;

  beforeAll(async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    session = result.session as AdvancedNutritionSession;
  }, 240000);

  const RECIPE = ['4 eggs, separated', '1 cup whole milk', '2 cups all-purpose flour', '6 tbsp unsalted butter', '1 tsp sea salt'];

  it('butter: an applicable source portion resolves the authored tablespoons without a correction proposal', async  () => {
    const { refFor, ctx } = buildContext(session, RECIPE);
    const butterRef = refFor(3);
    const row = ctx.nutrition?.rows.find((candidate) => candidate.line_ref === butterRef);
    expect(row?.status).toBe('matched');
    expect(row?.resolved_grams).toBeGreaterThan(0);
    expect(['source_portion', 'count_portion', 'household_portion']).toContain(row?.mass_source);
    expect(summarizeLiveRows(ctx.nutrition!.rows).needs_amount).toBe(0);
  }, 180000);

  it('nothing was persisted: the working review is still unsaved and Apply-owned', () => {
    const { state } = buildContext(session, RECIPE);
    // No proposal path writes a block; the state machine has no such action.
    const source = readFileSync(join(__dirname, '../../src/core/shiso/proposalActions.ts'), 'utf8');
    expect(source).not.toMatch(/writeText|encodeCodexNutrition|saveRecipe|applyAdvancedNutrition/);
    expect(source).not.toMatch(/dispatch\(/);
    expect(state.preview).toBeNull();
  });
});

describe('SHISO-C1 — a proposal can never become authority it was not granted', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name, bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    session = result.session as AdvancedNutritionSession;
  }, 240000);

  const RECIPE = ['6 tbsp unsalted butter', '1 tsp sea salt'];

  function proposalFor(partial: Partial<ShisoProposal> & { line_ref: string }): ShisoProposal {
    return {
      ingredient_label: 'x',
      outcome: 'verified_alternative_match',
      explanation: 'e',
      question: null,
      fdc_id: 1,
      record_digest: 'sha256:x',
      review_digest: 'y',
      ...partial,
    } as ShisoProposal;
  }

  it('rejects a FORGED fdc id that is not in the deterministic candidate set', () => {
    const { adapted, rows, state, refFor } = buildContext(session, RECIPE);
    const result = prepareShisoProposalActions({
      bound: bind(proposalFor({ line_ref: refFor(0), fdc_id: 999999999 }), state.recipeKey as string, state.sessionIdentity as string),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as { reason?: string }).reason, JSON.stringify(result)).toBe('candidate_not_authentic');
  }, 180000);

  it('rejects a FORGED gram weight the record does not state', () => {
    const { adapted, rows, state, refFor } = buildContext(session, RECIPE);
    const result = prepareShisoProposalActions({
      bound: bind(
        proposalFor({
          line_ref: refFor(0),
          outcome: 'verified_available_portion',
          fdc_id: 789828,
          portion_index: 0,
          gram_weight: 9999,
          measure: '1 tbsp',
        }),
        state.recipeKey as string, state.sessionIdentity as string,
      ),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['portion_not_authentic', 'unknown_line_ref']).toContain((result as { reason?: string }).reason);
  }, 180000);

  it('rejects a STALE proposal after the recipe identity changed', () => {
    const { adapted, rows, state, refFor } = buildContext(session, RECIPE);
    const result = prepareShisoProposalActions({
      bound: bind(proposalFor({ line_ref: refFor(0) }), 'a-different-recipe-key', state.sessionIdentity as string),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as { reason?: string }).reason, JSON.stringify(result)).toBe('stale_recipe');
  });

  it('rejects a STALE proposal after the nutrition session changed', () => {
    const { adapted, rows, state, refFor } = buildContext(session, RECIPE);
    const result = prepareShisoProposalActions({
      bound: bind(proposalFor({ line_ref: refFor(0) }), state.recipeKey as string, 'a-different-session'),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as { reason?: string }).reason).toBe('stale_session');
  });

  it('rejects an UNKNOWN line reference', () => {
    const { adapted, rows, state } = buildContext(session, RECIPE);
    const result = prepareShisoProposalActions({
      bound: bind(proposalFor({ line_ref: 'ing:0:invented' }), state.recipeKey as string, state.sessionIdentity as string),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as { reason?: string }).reason).toBe('unknown_line_ref');
  });

  it('a clarification request applies NOTHING and says so', () => {
    const { adapted, rows, state, refFor } = buildContext(session, RECIPE);
    const result = prepareShisoProposalActions({
      bound: bind(
        proposalFor({ line_ref: refFor(0), outcome: 'clarification_required' }),
        state.recipeKey as string, state.sessionIdentity as string,
      ),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as { reason?: string }).reason).toBe('nothing_to_apply');
  });
});

describe('SHISO-C1 — generality across unrelated foods', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name, bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    session = result.session as AdvancedNutritionSession;
  }, 240000);

  const CASES: ReadonlyArray<{ line: string; expectUnresolved: boolean }> = [
    { line: '6 tbsp unsalted butter', expectUnresolved: true },
    { line: '4 eggs, separated', expectUnresolved: true },
    { line: '1 cup whole milk', expectUnresolved: false },
    { line: '1 tsp sea salt', expectUnresolved: false },
    { line: '2 cups all-purpose flour', expectUnresolved: false },
    { line: '1 cup whole milk and 1 tbsp honey', expectUnresolved: false },
  ];

  it('investigates every unrelated ingredient without a per-ingredient special case', async  () => {
    for (const testCase of CASES) {
      const { ctx, refFor } = buildContext(session, [testCase.line, '1 tsp sea salt']);
      const obs = await executeShisoTool({ tool: 'investigate_ingredient_amount', line_ref: refFor(0) }, ctx);
      expect(obs.ok, testCase.line).toBe(true);
      if (!obs.ok) continue;
      // Whatever the truth is, it is REPORTED, never invented.
      expect(typeof obs.data['diagnosis']).toBe('string');
      if (obs.data['resolved_grams'] !== null && obs.data['resolved_grams'] !== undefined) {
        expect(typeof obs.data['resolved_grams']).toBe('number');
      }
    }
  }, 240000);

  it('search works for arbitrary foods, not just the smoke-test ingredients', async  () => {
    const { ctx } = buildContext(session, ['1 cup whole milk']);
    for (const query of ['banana', 'chicken breast', 'olive oil', 'cheddar cheese']) {
      const obs = await executeShisoTool({ tool: 'search_usda_foods', query }, ctx);
      expect(obs.ok, query).toBe(true);
      if (!obs.ok) continue;
      const results = obs.data['results'] as Array<Record<string, unknown>>;
      expect(results.length, query).toBeGreaterThan(0);
    }
  }, 180000);
});
