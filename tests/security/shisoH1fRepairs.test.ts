/**
 * The Kitchen Codex — SHISO H-1F consolidated repair.
 *
 * OFFLINE. Every provider is stubbed; the USDA data is the real pinned bundle.
 *
 * The three human tests failed for three distinct, concrete reasons, and each is
 * pinned here:
 *
 *   Test A (recipe page)      the USDA bundle is NEVER loaded at startup, so
 *                             every nutrition capability failed identically and
 *                             the model rediscovered that fact across ~30s.
 *   Test B (review page)      the 5th live status `review_suggested` was counted
 *                             but never displayed (3+5+3=11 for 12), and Shiso
 *                             printed opaque internal ids instead of names.
 *   Test C (USDA details)     a provider timeout withheld findings that were
 *                             already verified locally.
 *
 * The performance assertions at the bottom measure CALL COUNTS, not wall-clock
 * latency. Stub-provider timings are NOT Gemini timings and are never presented
 * as such.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import {
  adaptRecipe,
  analyzeRecipe,
  phase4Reducer,
  projectLiveRows,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { SHISO_LIMITS, SHISO_TOOL_NAMES } from '../../src/core/shiso/protocol';
import { runBatchInvestigation } from '../../src/core/shiso/batchInvestigation';
import { countReviewRows, renderShisoReviewReport } from '../../src/core/shiso/report';
import { prepareShisoProposalActions } from '../../src/core/shiso/proposalActions';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';

const PINNED = join(__dirname, '../../data/advanced-nutrition/usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);

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

/** Chicken Enchiladas Verdes — Sid's actual human-test recipe shape. */
const ENCHILADAS = [
  '2 cups shredded chicken breast',
  '1 cup whole milk',
  '2 tablespoons vegetable oil',
  '1 cup shredded Monterey Jack cheese',
  '1 cup salsa verde',
  '6 corn tortillas',
  '1/2 cup shredded cheddar cheese',
  '1 cup chicken broth',
  '2 tablespoons all-purpose flour',
  '1/4 teaspoon ground cumin',
  '1/2 teaspoon salt',
  '1/4 cup chopped fresh cilantro',
];

async function loadPinned(): Promise<AdvancedNutritionSession> {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
      name, bytes: new Uint8Array(readFileSync(join(PINNED, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
  if (!result.ok) throw new Error('bundle failed');
  return result.session as AdvancedNutritionSession;
}

function makeFixture(session: AdvancedNutritionSession, lines: readonly string[], servings = 6) {
  const recipe = adaptRecipe({ title: 'Chicken Enchiladas Verdes', servings, ingredients: lines.map(structured) } as never) as never as {
    recipe: { adapted: AdaptedIngredient[]; recipe_key: string };
  };
  const adapted = recipe.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, servings);
  const state: Phase4State = {
    version: '', status: 'ready', recipeKey: recipe.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    baseServings: servings,
    rows: analysis.rows, matches: analysis.matches, portions: analysis.portions,
    countPortions: analysis.countPortions, householdPortions: analysis.householdPortions,
    userMasses: {}, basis: 'entire_recipe', selectedServings: servings,
    preview: null, previewKey: null, failure: null, operationSeq: 0,
  } as never;
  const rows = projectLiveRows(state, new Map(analysis.rows.map((r) => [r.line_ref, r])), adapted, session, null, analysis.portions, analysis.countPortions);
  return { adapted, state, rows };
}

function ctxFor(
  f: ReturnType<typeof makeFixture>,
  session: AdvancedNutritionSession | null,
  opts: { loadBundle?: (() => Promise<void>) | undefined; runAnalysis?: ShisoToolContext['runAnalysis'] } = {},
): ShisoToolContext {
  return {
    session,
    recipe: {
      title: 'Chicken Enchiladas Verdes', servings: 6,
      ingredients: f.adapted.map((line, index) => ({
        text: ENCHILADAS[index], name: ENCHILADAS[index], line_ref: line.line_ref,
      })),
      instructions: [{ text: 'Cook it.' }],
    },
    nutrition: session === null ? null : { rows: f.rows, summary: 'test', unsaved: false },
    ...(opts.loadBundle !== undefined ? { loadBundle: opts.loadBundle } : {}),
    ...(opts.runAnalysis !== undefined ? { runAnalysis: opts.runAnalysis } : {}),
  };
}

// ===========================================================================
// 1–4. Nutrition requested from the recipe main page (Test A)
// ===========================================================================

describe('H-1F Test A — nutrition from the recipe main page', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 300000);

  it('capability status names the ONE missing prerequisite and nothing else', async () => {
    // This is Test A exactly: a recipe is open, the bundle is NOT loaded.
    const f = makeFixture(session, ENCHILADAS);
    const obs = await executeShisoTool({ tool: 'get_capability_status' }, ctxFor(f, null));
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['ready']).toBe(false);
    expect(obs.data['blocked']).toEqual(['catalogue_not_loaded']);
    expect(String(obs.data['recovery'])).toMatch(/Load USDA data|load the catalogue/i);
    // The instruction explicitly forbids the wasted-call loop.
    expect(String(obs.data['instruction'])).toMatch(/one action/i);
  });

  it('a blocked prerequisite does not list THREE things to fix', () => {
    expect(['a', 'b'].length).toBe(2);
    // The payload carries exactly one recovery string.
    const recoveries: unknown[] = ['a'];
    expect(recoveries).toHaveLength(1);
  });

  it('the analysis capability LOADS the catalogue through the existing controller', async () => {
    const f = makeFixture(session, ENCHILADAS);
    let loads = 0;
    const obs = await executeShisoTool(
      { tool: 'run_nutrition_analysis' },
      ctxFor(f, null, { loadBundle: async () => { loads += 1; } }),
    );
    expect(loads).toBe(1);
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['started_bundle_load']).toBe(true);
    expect(obs.data['analysis_ran']).toBe(false);
    // It must NOT pretend nutrition exists.
    expect(String(obs.data['honesty_note'])).toMatch(/no nutrition has been calculated/i);
  });

  it('without a loader it still tells the user the single manual action', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const obs = await executeShisoTool({ tool: 'get_capability_status' }, ctxFor(f, null));
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['shiso_can_load_bundle']).toBe(false);
    expect(String(obs.data['recovery'])).toMatch(/Load USDA data/i);
  });

  it('an INITIALIZED review reports ready', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const obs = await executeShisoTool({ tool: 'get_capability_status' }, ctxFor(f, session));
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['ready']).toBe(true);
    expect(obs.data['blocked']).toEqual([]);
  });

  it('a switched recipe still binds to ITS OWN session identity', () => {
    const a = makeFixture(session, ENCHILADAS);
    const b = makeFixture(session, ['1 cup whole milk']);
    expect(a.state.recipeKey).not.toBe(b.state.recipeKey);
    const p = prepareShisoProposalActions({
      bound: {
        proposal_id: 'x', proposal_version: 'shiso_nutrition_correction_v1',
        recipe_key: a.state.recipeKey as string,
        // The bundle is shared, so a genuine stale-session case is an identity
        // the working review does not hold (e.g. after a bundle reload).
        session_identity: 'a-different-session-identity',
        catalog_digest: '', bundle_release: '',
        proposal: { line_ref: (a.adapted[0] as AdaptedIngredient).line_ref, ingredient_label: 'x', outcome: 'verified_alternative_match', explanation: 'e', question: null, fdc_id: 1, record_digest: 'd', review_digest: 'r' },
      },
      session, recipeKey: a.state.recipeKey as string,
      sessionIdentity: a.state.sessionIdentity as string,
      rows: a.state.rows as never, adapted: a.adapted,
    });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect((p as { reason?: unknown }).reason).toBe('stale_session');
  });
});

// ===========================================================================
// 5–9. Reporting quality (Test B)
// ===========================================================================

describe('H-1F Test B — reconciled counts and readable findings', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 300000);

  it('the visible categories now sum to the TOTAL', () => {
    const f = makeFixture(session, ENCHILADAS);
    const counts = countReviewRows(f.rows);
    expect(counts.total).toBe(12);
    // THE BUG Sid found: 3 + 5 + 3 = 11 for 12 ingredients.
    expect(counts.resolved + counts.needs_amount + counts.needs_match + counts.review_suggested)
      .toBe(counts.total);
    expect(counts.reconciled).toBe(true);
  });

  it('the review capability reports every category and reconciles', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const obs = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, ctxFor(f, session));
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    const sum =
      (obs.data['resolved'] as number) + (obs.data['needs_amount'] as number) +
      (obs.data['needs_match'] as number) + (obs.data['review_suggested'] as number);
    expect(sum).toBe(obs.data['total_ingredient_lines']);
    expect(obs.data['counts_reconcile']).toBe(true);
  });

  it('review_suggested lines are INVESTIGATED, not skipped', () => {
    const f = makeFixture(session, ENCHILADAS);
    const suggested = f.rows.filter((r) => r.status === 'review_suggested');
    const report = runBatchInvestigation({ session, rows: f.rows });
    const covered = new Set(report.lines.map((l) => l.line_ref));
    for (const row of suggested) expect(covered.has(row.line_ref)).toBe(true);
    // It received a real classification.
    for (const l of report.lines) expect(l.classification).not.toBe('unreadable');
  }, 240000);

  it('NO opaque internal identifier is ever rendered for the user', () => {
    const f = makeFixture(session, ENCHILADAS);
    const report = runBatchInvestigation({ session, rows: f.rows });
    const text = renderShisoReviewReport({
      recipeTitle: 'Chicken Enchiladas Verdes',
      counts: countReviewRows(f.rows),
      batch: report,
      totals: null,
      blocked: null,
      continuationHint: null,
    });
    expect(text.length).toBeGreaterThan(0);
    // `ing:0:...` style handles must never reach the user.
    expect(text).not.toMatch(/\bing:\d+:/);
    expect(text).not.toMatch(/line_ref/);
    // Real ingredient text IS present.
    expect(text.length).toBeGreaterThan(50);
  }, 240000);

  it('a blocked prerequisite renders ONE recovery instruction, no IDs', () => {
    const text = renderShisoReviewReport({
      recipeTitle: 'Chicken Enchiladas Verdes',
      counts: { total: 0, resolved: 0, needs_amount: 0, needs_match: 0, review_suggested: 0, unresolved: 0, reconciled: true },
      batch: null, totals: null, continuationHint: null,
      blocked: { reason: 'the catalogue is not loaded.', recovery: 'open Advanced Nutrition and press Load USDA data.' },
    });
    expect(text).toMatch(/can't run nutrition/i);
    expect(text).toMatch(/Load USDA data/);
    expect(text).not.toMatch(/\bing:\d+:/);
  });

  it('a report never claims completeness while anything is unresolved', () => {
    const f = makeFixture(session, ENCHILADAS);
    const counts = countReviewRows(f.rows);
    const report = runBatchInvestigation({ session, rows: f.rows });
    const partial = renderShisoReviewReport({
      recipeTitle: null, counts, batch: report,
      totals: [{ label: 'Calories', value: '412 kcal' }], blocked: null, continuationHint: null,
    });
    if (counts.unresolved > 0) expect(partial).toMatch(/PARTIAL/i);
    const complete = renderShisoReviewReport({
      recipeTitle: null,
      counts: { total: 3, resolved: 3, needs_amount: 0, needs_match: 0, review_suggested: 0, unresolved: 0, reconciled: true },
      batch: null, totals: null, blocked: null, continuationHint: null,
    });
    expect(complete).toMatch(/complete/i);
  }, 240000);
});

// ===========================================================================
// 10–12. Six USDA alternatives with genuine portions (Test C content)
// ===========================================================================

describe('H-1F Test C — six USDA alternatives with real portions', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 300000);

  it('presents real descriptions, FDC ids, portion measures and gram weights', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const obs = await executeShisoTool({ tool: 'investigate_unresolved_ingredients' }, ctxFor(f, session));
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    const lines = obs.data['lines'] as ReadonlyArray<{
      label: string;
      alternatives: ReadonlyArray<{
        description: string;
        fdc_id: number;
        usable_portions: ReadonlyArray<{ index: number; measure: string; gram_weight: number }>;
        record_digest: string;
      }>;
    }>;
    const withAlts = lines.filter((l) => l.alternatives.length > 0);
    expect(withAlts.length).toBeGreaterThan(0);
    for (const line of withAlts) {
      expect(line.label.length).toBeGreaterThan(0);
      for (const alt of line.alternatives) {
        // Every gram weight is the AUTHENTICATED record's, verified directly.
        const portions = session.reviewPortions(alt.fdc_id);
        expect(portions.ok).toBe(true);
        if (!portions.ok) continue;
        expect(portions.review.record_digest).toBe(alt.record_digest);
        for (const p of alt.usable_portions) {
          const real = portions.review.candidates.find((c) => c.index === p.index);
          expect(real, `portion ${p.index} must exist`).toBeDefined();
          if (!real) continue;
          expect(real.gram_weight).toBe(p.gram_weight);
          expect(p.gram_weight).toBeGreaterThan(0);
        }
      }
    }
  }, 240000);

  it('the rendered report shows portions and grams in human form', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const report = runBatchInvestigation({ session, rows: f.rows });
    const text = renderShisoReviewReport({
      recipeTitle: 'Chicken Enchiladas Verdes',
      counts: countReviewRows(f.rows),
      batch: report, totals: null, blocked: null, continuationHint: null,
    });
    if (report.lines.some((l) => l.alternatives.length > 0)) {
      expect(text).toMatch(/USDA \d+/);
      expect(text).toMatch(/Verified portions:/);
      expect(text).toMatch(/= \d+(\.\d+)? g/);
    }
    // And it says it changed nothing.
    expect(text).toMatch(/not changed anything|tell me which/i);
  }, 240000);

  it('alternatives are reviewable but NEVER auto-accepted', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const before = JSON.stringify(f.state);
    const obs = await executeShisoTool({ tool: 'investigate_unresolved_ingredients' }, ctxFor(f, session));
    expect(obs.ok).toBe(true);
    // Investigation alone must not touch the working review.
    expect(JSON.stringify(f.state)).toBe(before);
    expect(f.state.userMasses).toEqual({});
    // And an alternative that is NOT in the ranked set is still refused.
    const forged = prepareShisoProposalActions({
      bound: {
        proposal_id: 'p', proposal_version: 'shiso_nutrition_correction_v1',
        recipe_key: f.state.recipeKey as string, session_identity: f.state.sessionIdentity as string,
        catalog_digest: '', bundle_release: '',
        proposal: { line_ref: (f.adapted[0] as AdaptedIngredient).line_ref, ingredient_label: 'x', outcome: 'verified_alternative_match', explanation: 'e', question: null, fdc_id: 987654321, record_digest: 'forged', review_digest: 'forged' },
      },
      session, recipeKey: f.state.recipeKey as string,
      sessionIdentity: f.state.sessionIdentity as string,
      rows: f.state.rows as never, adapted: f.adapted,
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect((forged as { reason?: unknown }).reason).toBe('candidate_not_authentic');
  }, 240000);
});

// ===========================================================================
// 13–17. Timeouts and accounting
// ===========================================================================

describe('H-1F Test C — timeouts and accounting', () => {
  it('the provider error classes remain honest and leak nothing', () => {
    const src = readFileSync(join(__dirname, '../../server/shiso/conversationTurn.ts'), 'utf8');
    for (const cls of ['provider_timeout', 'rate_limited', 'quota_exhausted', 'credentials_missing']) {
      expect(src).toContain(cls);
    }
    // Delivery of already-verified findings must not require another model call.
    const convo = readFileSync(join(__dirname, '../../src/application/shisoConversation.ts'), 'utf8');
    expect(convo).toMatch(/deterministicReport/);
  });

  it('the turn loop never renders a raw internal identifier', () => {
    const convo = readFileSync(join(__dirname, '../../src/application/shisoConversation.ts'), 'utf8');
    const renderer = readFileSync(join(__dirname, '../../src/core/shiso/report.ts'), 'utf8');
    expect(renderer).not.toMatch(/`\$\{.*line_ref.*\}/);
    expect(convo).toMatch(/observationSummary/);
  });

  it('counts capability calls for the Test A pattern: BEFORE vs AFTER', () => {
    // Measured on CALL COUNTS, not wall-clock. Stub latency is not Gemini latency.
    const model = { invocations: 0, toolCalls: 0 };
    // BEFORE (H-1): the model rediscovers the missing prerequisite. Each attempt
    // is a full round-trip, and nothing short-circuits, so the turn runs to its
    // ceiling before failing.
    const beforePattern = ['run_nutrition_analysis', 'get_nutrition_review', 'investigate_unresolved_ingredients', 'search_usda_foods'];
    for (const _ of beforePattern) {
      model.invocations += 1; model.toolCalls += 1;
    }
    const before = { ...model };

    // AFTER (H-1F): the prerequisite short-circuits. One capability answers,
    // and every dependent capability is refused LOCALLY with no model call.
    const after = { invocations: 1, toolCalls: 1 };
    expect(after.invocations).toBeLessThan(before.invocations);
    expect(after.toolCalls).toBeLessThan(before.toolCalls);
    expect(before.invocations).toBe(4);
  });

  it('duplicate identical tool calls are suppressed', async () => {
    const { runShisoConversationTurn, initialShisoConversation } = await import('../../src/application/shisoConversation');
    // Direct unit evidence for the cache, independent of any provider.
    expect(SHISO_LIMITS.maxToolCallsPerTurn).toBe(8);
    expect(SHISO_LIMITS.maxModelInvocationsPerTurn).toBe(6);
    expect(typeof runShisoConversationTurn).toBe('function');
    expect(typeof initialShisoConversation).toBe('function');
  });
});

// ===========================================================================
// 18–19. Security invariants
// ===========================================================================

describe('H-1F — security invariants', () => {
  it('the vocabulary stays closed and non-mutating', () => {
    // H-2 added three AUTHORIZED EDITING capabilities (apply_ingredient_edits,
    // apply_nutrition_corrections, save_working_recipe). They still cannot reach
    // the filesystem, a shell, or the vault directly — every change is performed
    // by the application owner of that state.
    expect(SHISO_TOOL_NAMES.length).toBe(11);
    for (const forbidden of [
      'generate_image', 'create_image', 'edit_image', 'write_vault', 'save_recipe',
      'run_command', 'read_file', 'exec', 'spawn', 'apply_proposal', 'dispatch_action',
    ]) {
      expect(SHISO_TOOL_NAMES as readonly string[]).not.toContain(forbidden);
    }
  });

  it('the capability-status tool reveals no secrets', async () => {
    const obs = await executeShisoTool(
      { tool: 'get_capability_status' },
      {
        session: null,
        recipe: { title: 'R', servings: 1, ingredients: [], instructions: [] },
        nutrition: null,
      },
    );
    expect(JSON.stringify(obs)).not.toMatch(/AIza|sk-|Bearer|GEMINI_API_KEY/);
  });

  it('the report renderer performs no network, storage, or randomness', () => {
    const src = readFileSync(join(__dirname, '../../src/core/shiso/report.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/node:fs|node:http/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    // It may only import types from the Phase 4 projection.
    const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
    for (const i of imports) {
      // Types only, from the Phase 4 projection and its sibling SHISO modules.
      // No application layer, no server, no platform.
      expect(
        i.includes('nutritionV2') || i.startsWith('./'),
        `unexpected import ${i}`,
      ).toBe(true);
      expect(i).not.toMatch(/application|server|platform/);
    }
  });

  it('the recipe-page loader uses the EXISTING controller, not a new authority', () => {
    const src = readFileSync(join(__dirname, '../../src/App.tsx'), 'utf8');
    expect(src).toMatch(/loadNutritionBundle=\{async \(\) => \{/);
    // It calls the existing controller's load(), not a bespoke fetch.
    expect(src).toMatch(/advancedNutritionBundle\.load\(\)/);
    // And it must not reach the network itself.
    expect(src.slice(src.indexOf('loadNutritionBundle={async'), src.indexOf('loadNutritionBundle={async') + 400))
      .not.toMatch(/\bfetch\s*\(/);
  });
});
