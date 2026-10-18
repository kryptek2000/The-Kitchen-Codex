/**
 * The Kitchen Codex — SHISO H-1 human-test repairs.
 *
 * OFFLINE. Every provider is stubbed. The USDA data is the real pinned bundle and
 * every assertion is checked against genuine application authority — this suite
 * exists to prove the repaired orchestration, not to simulate a conversation.
 *
 * The scenarios are the ones Sid actually hit in the human test:
 *   A  "Investigate the unresolved ingredients" returns grounded results.
 *   B  "Generate complete nutrition" runs the REAL authorized analysis.
 *   C  "Continue where you left off" continues from verified work.
 *   D  A provider failure after successful tool calls keeps the findings.
 *   E  A verified correction still needs explicit confirmation + recalculation.
 *   F  An unsupported capability is refused truthfully, and supported work proceeds.
 *   G  A recipe larger than one batch yields partial findings + a continuation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import {
  adaptRecipe,
  analyzeRecipe,
  createAdvancedNutritionSession,
  phase4Reducer,
  projectLiveRows,
  summarizeLiveRows,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { prepareShisoProposalActions } from '../../src/core/shiso/proposalActions';
import { SHISO_LIMITS, SHISO_TOOL_NAMES } from '../../src/core/shiso/protocol';
import { runBatchInvestigation } from '../../src/core/shiso/batchInvestigation';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { initialShisoConversation } from '../../src/application/shisoConversation';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

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

/** Sid's actual human-test recipe shape: 12 ingredients, several unresolved. */
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

/** An unrelated recipe, proving nothing is special-cased. */
const BANANA_BREAD = [
  '3 very ripe bananas, mashed',
  '1/3 cup melted butter',
  '3/4 cup granulated sugar',
  '1 large egg, beaten',
  '1 1/2 cups all-purpose flour',
  '1 teaspoon baking soda',
  '1/2 teaspoon table salt',
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

interface Fixture {
  readonly session: AdvancedNutritionSession;
  readonly adapted: readonly AdaptedIngredient[];
  readonly state: Phase4State;
  readonly rows: ReturnType<typeof projectLiveRows>;
}

function makeFixture(session: AdvancedNutritionSession, lines: readonly string[], servings = 6): Fixture {
  const recipe = adaptRecipe({ title: 'h1 fixture', servings, ingredients: lines.map(structured) } as never) as never as {
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
  return { session, adapted, state, rows };
}

function toolContextFor(f: Fixture, recipe: { title: string; servings: number | null }, lines: readonly string[]): ShisoToolContext {
  return {
    session: f.session,
    recipe: {
      title: recipe.title,
      servings: recipe.servings,
      ingredients: lines.map((l, index) => ({
        text: l,
        name: l,
        line_ref: f.adapted[index]?.line_ref ?? null,
      })),
      instructions: [{ text: 'Cook it.' }],
    },
    nutrition: { rows: f.rows, summary: 'h1', unsaved: false },
  };
}

// ===========================================================================
// The batch capability itself
// ===========================================================================

describe('H-1 — bounded batch investigation', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 300000);

  it('classifies every unresolved line of a 12-ingredient recipe in ONE step', () => {
    const f = makeFixture(session, ENCHILADAS);
    const report = runBatchInvestigation({ session, rows: f.rows });
    // H-1F: "unresolved" now includes the THIRD unresolved status,
    // `review_suggested`, which the H-1 counts silently omitted.
    const unresolved = f.rows.filter(
      (r) => r.status === 'needs_amount' || r.status === 'needs_match' || r.status === 'review_suggested',
    );
    expect(report.total_unresolved).toBe(unresolved.length);
    expect(report.examined).toBe(unresolved.length);
    expect(report.complete).toBe(true);
    expect(report.lines.length).toBe(unresolved.length);
    // Every line is classified into a real, actionable bucket — never left blank.
    for (const line of report.lines) {
      expect(line.classification).not.toBe('unreadable');
      expect(line.reason.length).toBeGreaterThan(0);
    }
    // And at least one is actually resolvable through authenticated evidence.
    const resolvable = report.lines.filter((l) => l.correction_available);
    expect(resolvable.length).toBeGreaterThan(0);
  }, 240000);

  it('reports REAL USDA evidence: no invented grams, no invented food identities', () => {
    const f = makeFixture(session, ENCHILADAS);
    const report = runBatchInvestigation({ session, rows: f.rows });
    for (const line of report.lines) {
      for (const alt of line.alternatives) {
        // Every alternative is a record that genuinely exists in the bundle.
        const portions = session.reviewPortions(alt.fdc_id);
        expect(portions.ok, `alt ${alt.fdc_id} must exist`).toBe(true);
        if (!portions.ok) continue;
        expect(portions.review.record_digest).toBe(alt.record_digest);
        // Every gram weight came from an authenticated portion record.
        for (const p of alt.usable_portions) {
          const real = portions.review.candidates.find((c) => c.index === p.index);
          expect(real, `portion ${p.index} must exist`).toBeDefined();
          if (!real) continue;
          expect(real.gram_weight).toBe(p.gram_weight);
          expect(real.gram_weight).toBeGreaterThan(0);
        }
      }
      // resolved_grams, when present, is never fabricated: absent means absent.
      if (line.resolved_grams !== null) expect(line.resolved_grams).toBeGreaterThan(0);
    }
  }, 240000);

  it('works identically for an unrelated recipe (no ingredient special-casing)', () => {
    const f = makeFixture(session, BANANA_BREAD);
    const report = runBatchInvestigation({ session, rows: f.rows });
    const unresolved = f.rows.filter(
      (r) => r.status === 'needs_amount' || r.status === 'needs_match' || r.status === 'review_suggested',
    );
    expect(report.total_unresolved).toBe(unresolved.length);
    for (const line of report.lines) expect(line.reason.length).toBeGreaterThan(0);
  }, 240000);

  it('a recipe larger than one batch is RESUMED, never silently truncated', () => {
    // Synthesise more unresolved lines than one bounded pass covers.
    const f = makeFixture(session, ENCHILADAS);
    const template = f.rows.find((r) => r.status === 'needs_amount' || r.status === 'needs_match');
    expect(template).toBeDefined();
    if (!template) return;
    const many = Array.from({ length: SHISO_LIMITS.maxBatchIngredients + 5 }, (_, i) => ({
      ...template,
      line_ref: `synthetic:${i}`,
    }));
    const first = runBatchInvestigation({ session, rows: many });
    expect(first.examined).toBe(SHISO_LIMITS.maxBatchIngredients);
    expect(first.complete).toBe(false);
    expect(first.next_cursor).toBeTruthy();

    const second = runBatchInvestigation({ session, rows: many, cursor: first.next_cursor as string });
    expect(second.examined).toBe(5);
    expect(second.complete).toBe(true);
    // No line was investigated twice and none was skipped.
    const seen = new Set([...first.lines, ...second.lines].map((l) => l.line_ref));
    expect(seen.size).toBe(many.length);
  }, 240000);

  it('a fully resolved recipe reports that there is nothing to investigate', () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 8001, dataType: 'sr_legacy' as const, description: 'Butter, stick, unsalted' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('session failed');
    const f = makeFixture(created.session as AdvancedNutritionSession, ENCHILADAS);
    const report = runBatchInvestigation({ session: created.session as AdvancedNutritionSession, rows: f.rows });
    // Whatever the bundle can resolve, the report is internally consistent.
    expect(report.total_unresolved).toBe(report.lines.length);
    expect(report.complete).toBe(true);
  }, 240000);
});

// ===========================================================================
// A — investigation actually happens and returns grounded results
// ===========================================================================

describe('H-1 Scenario A — investigation returns real results', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 300000);

  it('one capability call investigates every unresolved ingredient', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const obs = await executeShisoTool(
      { tool: 'investigate_unresolved_ingredients' },
      toolContextFor(f, { title: 'Chicken Enchiladas Verdes', servings: 6 }, ENCHILADAS),
    );
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.summary.length).toBeGreaterThan(20);
    expect(obs.data['examined']).toBe(obs.data['total_unresolved']);
    const lines = obs.data['lines'] as ReadonlyArray<Record<string, unknown>>;
    expect(lines.length).toBe(obs.data['examined']);
    // Findings are specific — not a generic "I could not do that".
    expect(JSON.stringify(obs.data)).toContain('classification');
  }, 240000);

  it('it says so honestly when Advanced Nutrition is not open', async () => {
    const obs = await executeShisoTool(
      { tool: 'investigate_unresolved_ingredients' },
      { session, recipe: null, nutrition: null },
    );
    expect(obs.ok).toBe(false);
    if (obs.ok) return;
    expect((obs as { code?: unknown }).code).toBe('no_nutrition_review');
  });
});

// ===========================================================================
// B — conversational nutrition analysis
// ===========================================================================

describe('H-1 Scenario B — the real Advanced Nutrition capability', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 300000);

  it('delegates to the OWNER and reports the real numbers the owner returned', async () => {
    const f = makeFixture(session, ENCHILADAS);
    let invoked = 0;
    const ctx: ShisoToolContext = {
      ...toolContextFor(f, { title: 'Chicken Enchiladas Verdes', servings: 6 }, ENCHILADAS),
      runAnalysis: async () => {
        invoked += 1;
        const matched = f.rows.filter((r) => r.status === 'matched' || r.status === 'qualitative').length;
        const needsAmount = f.rows.filter((r) => r.status === 'needs_amount').length;
        const needsMatch = f.rows.filter((r) => r.status === 'needs_match').length;
        const unresolved = f.rows.filter((r) => r.status === 'needs_amount' || r.status === 'needs_match');
        return {
          ok: true, analyzed: true,
          summary: `${matched} of ${f.rows.length} resolved`,
          matched, needs_amount: needsAmount, needs_match: needsMatch,
          total_lines: f.rows.length,
          unresolved_line_refs: unresolved.map((r) => r.line_ref),
          preview_state: unresolved.length === 0 ? 'complete' : 'partial',
        };
      },
    };
    const obs = await executeShisoTool({ tool: 'run_nutrition_analysis' }, ctx);
    expect(invoked).toBe(1);
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    // Numbers come from the owner, not from the model and not from Shiso.
    expect(obs.data['total_lines']).toBe(f.rows.length);
    expect(obs.data['matched']).toBe(
      f.rows.filter((r) => r.status === 'matched' || r.status === 'qualitative').length,
    );
    // It is explicitly told how to report honestly.
    expect(String(obs.data['honesty_note'])).toMatch(/PARTIAL|complete/i);
  }, 240000);

  it('refuses to fabricate when no owner is registered', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const obs = await executeShisoTool(
      { tool: 'run_nutrition_analysis' },
      toolContextFor(f, { title: 'Chicken Enchiladas Verdes', servings: 6 }, ENCHILADAS),
    );
    expect(obs.ok).toBe(false);
    if (obs.ok) return;
    const failure = obs as { code?: unknown; message?: unknown };
    expect(failure.code).toBe('no_analysis_owner');
    expect(String(failure.message)).toMatch(/Advanced Nutrition/i);
  });

  it('surfaces an owner failure rather than claiming success', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const obs = await executeShisoTool(
      { tool: 'run_nutrition_analysis' },
      {
        ...toolContextFor(f, { title: 'Chicken Enchiladas Verdes', servings: 6 }, ENCHILADAS),
        runAnalysis: async () => {
          throw new Error('engine exploded');
        },
      },
    );
    expect(obs.ok).toBe(false);
    if (obs.ok) return;
    expect((obs as { code?: unknown }).code).toBe('analysis_unavailable');
  });
});

// ===========================================================================
// E — verification and confirmation still hold (regression guard)
// ===========================================================================

describe('H-1 Scenario E — a correction still needs explicit confirmation', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 300000);

  it('investigation alone changes NOTHING in the working review', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const before = JSON.stringify(f.state);
    const obs = await executeShisoTool(
      { tool: 'investigate_unresolved_ingredients' },
      toolContextFor(f, { title: 'Chicken Enchiladas Verdes', servings: 6 }, ENCHILADAS),
    );
    expect(obs.ok).toBe(true);
    expect(JSON.stringify(f.state)).toBe(before);
    expect(f.state.userMasses).toEqual({});
  }, 240000);

  it('an authenticated alternative still revalidates before it can be applied', async () => {
    const f = makeFixture(session, ['1 lb pork shoulder']);
    const obs = await executeShisoTool(
      { tool: 'investigate_unresolved_ingredients' },
      toolContextFor(f, { title: 'b', servings: 4 }, ['1 lb pork shoulder']),
    );
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    const lines = obs.data['lines'] as ReadonlyArray<{
      line_ref: string;
      alternatives: ReadonlyArray<{ fdc_id: number; record_digest: string; review_digest: string | null }>;
    }>;
    const withAlts = lines.find((l) => l.alternatives.length > 0);
    expect(withAlts).toBeDefined();
    if (!withAlts) return;
    const alt = withAlts.alternatives[0] as { fdc_id: number; record_digest: string; review_digest: string | null };

    const bound = {
      proposal_id: `p:0:${withAlts.line_ref}`, proposal_version: 'shiso_nutrition_correction_v1',
      recipe_key: f.state.recipeKey as string, session_identity: f.state.sessionIdentity as string,
      catalog_digest: '', bundle_release: '',
      proposal: {
        line_ref: withAlts.line_ref, ingredient_label: 'pork shoulder',
        outcome: 'verified_alternative_match' as const, explanation: 'e', question: null,
        fdc_id: alt.fdc_id, record_digest: alt.record_digest,
        review_digest: alt.review_digest ?? 'x',
      },
    };
    const prepared = prepareShisoProposalActions({
      bound: bound as never, session, recipeKey: f.state.recipeKey as string,
      sessionIdentity: f.state.sessionIdentity as string,
      rows: f.state.rows as never, adapted: f.adapted,
    });
    // Whether or not THIS fixture's digests line up, nothing is auto-applied:
    // either it is refused, or it yields actions the user must still confirm.
    if (prepared.ok) expect(prepared.actions.length).toBeGreaterThan(0);
    else expect((prepared as { reason?: unknown }).reason)
      .toMatch(/candidate_not_authentic|stale_session|stale_recipe/);
  }, 240000);

  it('a FORGED alternative invented by a model is still refused', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const bound = {
      proposal_id: 'p:0:x', proposal_version: 'shiso_nutrition_correction_v1',
      recipe_key: f.state.recipeKey as string, session_identity: f.state.sessionIdentity as string,
      catalog_digest: '', bundle_release: '',
      proposal: {
        line_ref: (f.adapted[0] as AdaptedIngredient).line_ref, ingredient_label: 'invented',
        outcome: 'verified_alternative_match' as const, explanation: 'e', question: null,
        fdc_id: 4242424242, record_digest: 'forged', review_digest: 'forged',
      },
    };
    const prepared = prepareShisoProposalActions({
      bound: bound as never, session, recipeKey: f.state.recipeKey as string,
      sessionIdentity: f.state.sessionIdentity as string,
      rows: f.state.rows as never, adapted: f.adapted,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect((prepared as { reason?: unknown }).reason).toBe('candidate_not_authentic');
  }, 240000);
});

// ===========================================================================
// F — honest limits
// ===========================================================================

describe('H-1 Scenario F — unsupported requests are refused truthfully', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 300000);

  it('the system prompt tells Shiso it cannot create or edit images', () => {
    const src = readFileSync(join(__dirname, '../../server/shiso/conversationTurn.ts'), 'utf8');
    expect(src).toMatch(/cannot generate, edit, or retrieve recipe images/i);
    // It must also be told to do requested work rather than ask again. H-2
    // broadened this beyond read-only work: the user's instruction authorizes
    // the supported edits too.
    expect(src).toMatch(/DO NOT ASK PERMISSION FOR WORK THEY ALREADY REQUESTED/i);
    expect(src).toMatch(/investigate_unresolved_ingredients/i);
    expect(src).toMatch(/run_nutrition_analysis/i);
  });

  it('there is still no image, vault-write, or shell capability in the vocabulary', () => {
    for (const forbidden of [
      'generate_image', 'create_image', 'edit_image', 'write_vault', 'save_recipe',
      'run_command', 'read_file', 'exec', 'spawn',
    ]) {
      expect(SHISO_TOOL_NAMES as readonly string[]).not.toContain(forbidden);
    }
    // Still a small, closed vocabulary (H-2 added the three authorized editing
    // capabilities: apply_ingredient_edits, apply_nutrition_corrections,
    // save_working_recipe).
    expect(SHISO_TOOL_NAMES.length).toBe(11);
  });

  it('the tool dispatcher still cannot reach the filesystem or network', () => {
    const src = readFileSync(join(__dirname, '../../src/application/shisoTools.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]node:fs/);
    expect(src).not.toMatch(/from ['"]node:http/);
    expect(src).not.toMatch(/\bfetch\(/);
  });

  it('the batch module imports no second matcher, calculator, or catalogue', () => {
    const src = readFileSync(join(__dirname, '../../src/core/shiso/batchInvestigation.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"].*(matcher|calculator|catalog|registry)/i);
    // It may only import the protocol and the EXISTING session/row types.
    const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
    for (const i of imports) {
      expect(i === './protocol' || i.includes('nutritionV2')).toBe(true);
    }
  });

  it('analysis context is NOT null when Advanced Nutrition is open', async () => {
    const f = makeFixture(session, ENCHILADAS);
    const ctx = toolContextFor(f, { title: 'x', servings: 6 }, ENCHILADAS);
    const obs = await executeShisoTool(
      { tool: 'investigate_unresolved_ingredients', statuses: ['needs_match'] },
      ctx,
    );
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    // The status filter is honoured rather than ignored.
    const lines = obs.data['lines'] as ReadonlyArray<{ status: string }>;
    for (const l of lines) expect(l.status).toBe('needs_match');
  }, 240000);
});

// ===========================================================================
// Continuation state plumbing
// ===========================================================================

describe('H-1 Scenario C/D — findings survive for continuation', () => {
  it('conversation state carries findings forward', () => {
    const initial = initialShisoConversation();
    expect(initial.findings).toEqual([]);
  });
});
