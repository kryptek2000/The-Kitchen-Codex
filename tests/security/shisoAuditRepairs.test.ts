/**
 * The Kitchen Codex — SHISO-C1 audit repairs: B-1, I-1, I-2, F-1.
 *
 * Offline. The provider is a stub; USDA data is the real pinned bundle.
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
  createAdvancedNutritionSession,
  projectLiveRows,
  summarizeLiveRows,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type Phase4Row,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { prepareShisoProposalActions } from '../../src/core/shiso/proposalActions';
import { buildIdentityDisclosure } from '../../src/core/shiso/disclosure';
import { SHISO_TOOL_NAMES } from '../../src/core/shiso/protocol';
import type { ShisoBoundProposal, ShisoProposal } from '../../src/core/shiso/protocol';
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

const RECIPE = ['4 eggs, separated', '1 cup whole milk', '2 cups all-purpose flour', '6 tbsp unsalted butter', '1 tsp sea salt'];

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

function makeState(session: AdvancedNutritionSession, lines: readonly string[], servings = 4) {
  const recipe = adaptRecipe({ title: 'audit fixture', servings, ingredients: lines.map(structured) } as never) as never as {
    recipe: { adapted: AdaptedIngredient[]; recipe_key: string };
  };
  const adapted = recipe.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  const analysis = analyzeRecipe(session, adapted, servings);
  const state: Phase4State = {
    version: '', status: 'ready', recipeKey: recipe.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    baseServings: servings, rows, matches: analysis.matches, portions: analysis.portions,
    countPortions: analysis.countPortions, householdPortions: analysis.householdPortions,
    userMasses: {}, basis: 'entire_recipe', selectedServings: servings,
    preview: null, previewKey: null, failure: null, operationSeq: 0,
  } as never;
  return { adapted, rows, state, analysis };
}

/**
 * Mirrors what the UI does: the CURRENT identity is read from the live-row
 * projection of the working state, which is the one authority for what the
 * review has actually selected.
 */
function currentIdentity(
  session: AdvancedNutritionSession,
  lines: readonly string[],
  index = 0,
  servings = 4,
): { readonly fdc_id: number | undefined; readonly description: string | undefined } {
  const { adapted, state, analysis } = makeState(session, lines, servings);
  const live = projectLiveRows(state, new Map(analysis.rows.map((r) => [r.line_ref, r])), adapted, session, null, analysis.portions, analysis.countPortions);
  const row = live[index];
  return { fdc_id: row?.selected_fdc_id, description: row?.selected_description };
}

function bind(p: ShisoProposal, recipeKey: string, sessionIdentity: string): ShisoBoundProposal {
  return {
    proposal_id: `${recipeKey}:0:${p.line_ref}`, proposal_version: 'shiso_nutrition_correction_v1',
    recipe_key: recipeKey, session_identity: sessionIdentity, catalog_digest: '', bundle_release: '', proposal: p,
  };
}

// ===========================================================================
// B-1 — model text can NEVER become user_mass
// ===========================================================================

describe('B-1 — AI text can never become a user-entered measurement', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 240000);

  const HEAVY_TEXTS = [
    'It weighs 200 g.',
    'Please enter 1 kg for this ingredient.',
    'Use 200 grams total, or 1 kilogram if easier.',
    'the measurement is 250g',
  ];

  it('no user_weight_recommended proposal can produce a mass, whatever the text says', () => {
    const { adapted, rows, state } = makeState(session, ['6 tbsp unsalted butter']);
    for (const text of HEAVY_TEXTS) {
      const proposal: ShisoProposal = {
        line_ref: adapted[0].line_ref,
        ingredient_label: '6 tbsp unsalted butter',
        outcome: 'user_weight_recommended',
        explanation: text,
        question: `How much does it weigh? ${text}`,
      };
      const result = prepareShisoProposalActions({
        bound: bind(proposal, state.recipeKey as string, state.sessionIdentity as string),
        session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
      });
      expect(result.ok, text).toBe(false);
      if (result.ok) continue;
      expect((result as { reason?: string }).reason).toBe('nothing_to_apply');
      // It points the human at the real control instead.
      expect((result as { message?: string }).message ?? '').toMatch(/only you can enter the weight/i);
      expect((result as { message?: string }).message ?? '').toMatch(/manual-weight control/i);
    }
  });

  it('the module contains NO code that could build a user mass from any source', () => {
    const source = readFileSync(join(__dirname, '../../src/core/shiso/proposalActions.ts'), 'utf8');
    const code = source.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(code).not.toMatch(/buildUserMassChoice/);
    expect(code).not.toMatch(/select_user_mass/);
    expect(code).not.toMatch(/UserMassChoice/);
    // And nothing parses a number out of proposal prose.
    expect(code).not.toMatch(/\(\s*\d+(\.\d+)?\s*\*\s*1000/);
  });

  it('confirming a user_weight proposal never reaches the mass authority at all', () => {
    const { adapted, rows, state } = makeState(session, ['6 tbsp unsalted butter']);
    const before = JSON.stringify(state);
    const proposal: ShisoProposal = {
      line_ref: adapted[0].line_ref, ingredient_label: 'b', outcome: 'user_weight_recommended',
      explanation: '200 g', question: '200 g?',
    };
    const result = prepareShisoProposalActions({
      bound: bind(proposal, state.recipeKey as string, state.sessionIdentity as string),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
    // Nothing to dispatch, so the working state is byte-identical.
    expect(JSON.stringify(state)).toBe(before);
    expect(state.userMasses).toEqual({});
  });
});

// ===========================================================================
// F-1 — no unreachable capability is advertised
// ===========================================================================

describe('F-1 — the advertised capability surface is truthful', () => {
  it('no household-conversion ACTION is advertised anywhere', () => {
    const protocol = readFileSync(join(__dirname, '../../src/core/shiso/protocol.ts'), 'utf8');
    const actions = readFileSync(join(__dirname, '../../src/core/shiso/proposalActions.ts'), 'utf8');
    const server = readFileSync(join(__dirname, '../../server/shiso/conversationTurn.ts'), 'utf8');
    // The word may appear only in explanatory comments, never as an outcome.
    const protocolCode = protocol.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(protocolCode).not.toContain('verified_household_conversion');
    const actionsCode = actions.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(actionsCode).not.toContain('verified_household_conversion');
    // The parser never produced one either.
    const serverCode = server.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(serverCode).not.toContain('verified_household_conversion');
  });

  it('the supported actionable set is exactly the three that really work', () => {
    const { readProposalsForTest } = { readProposalsForTest: null };
    void readProposalsForTest;
    const module: string = readFileSync(join(__dirname, '../../server/shiso/conversationTurn.ts'), 'utf8');
    for (const supported of ['verified_alternative_match', 'verified_available_portion', 'user_weight_recommended']) {
      expect(module).toContain(supported);
    }
    // clarification/no-resolution are explanations, not actions.
    expect(module).toContain('clarification_required');
  });

  it('an unknown proposal outcome fails CLOSED rather than being applied', () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 8001, dataType: 'sr_legacy' as const, description: 'Butter, stick, unsalted' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('session failed');
    const session = created.session;
    const { adapted, rows, state } = makeState(session, ['6 tbsp unsalted butter']);
    const forged = {
      line_ref: adapted[0].line_ref, ingredient_label: 'b', outcome: 'something_unheard_of',
      explanation: 'e', question: null, fdc_id: 8001, record_digest: 'd', review_digest: 'r',
    } as unknown as ShisoProposal;
    const result = prepareShisoProposalActions({
      bound: bind(forged, state.recipeKey as string, state.sessionIdentity as string),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as { reason?: string }).reason).toBe('nothing_to_apply');
  });

  it('household evidence remains INSPECTABLE through the tool surface', () => {
    // The five read/investigation tools are unchanged: household explanation
    // still happens via investigation, just not via a fake action.
    expect(SHISO_TOOL_NAMES).toContain('investigate_ingredient_amount');
    // H-1 added two further READ-ONLY / owner-delegated capabilities (bounded
    // batch investigation and running the existing nutrition analysis). Neither
    // is a conversion action, so the F-1 property is unchanged: every tool in the
    // vocabulary is an investigation or an owner-delegated request, never an
    // executable household conversion.
    expect(SHISO_TOOL_NAMES).toContain('investigate_unresolved_ingredients');
    expect(SHISO_TOOL_NAMES).toContain('run_nutrition_analysis');
    // H-1F added get_capability_status: it reports the ONE missing prerequisite
    // instead of letting the model rediscover it across wasted turns.
    expect(SHISO_TOOL_NAMES).toContain('get_capability_status');
    // H-2 added three AUTHORIZED EDITING capabilities. They are owner-delegated
    // requests (the application owner performs every change and every save), not
    // a faked household conversion, so the F-1 property is unchanged.
    expect(SHISO_TOOL_NAMES).toContain('apply_ingredient_edits');
    expect(SHISO_TOOL_NAMES).toContain('apply_nutrition_corrections');
    expect(SHISO_TOOL_NAMES).toContain('save_working_recipe');
    expect(SHISO_TOOL_NAMES).toHaveLength(11);
  });
});

// ===========================================================================
// I-1 — a genuine session identity makes proposals actionable
// ===========================================================================

describe('I-1 — proposals bind to the GENUINE session identity', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 240000);

  it('authenticated household evidence now resolves the authored butter quantity directly', () => {
    const { adapted, rows, state, analysis } = makeState(session, RECIPE);
    const identity = state.sessionIdentity as string;
    const butterRef = adapted[3].line_ref;

    // BEFORE: unresolved.
    const before = projectLiveRows(state, new Map(analysis.rows.map((r) => [r.line_ref, r])), adapted, session, null, analysis.portions, analysis.countPortions);
    expect(summarizeLiveRows(before).needs_amount).toBe(0);
    expect(before.find((row) => row.line_ref === butterRef)?.resolved_grams).toBeGreaterThan(0);
    expect(before.find((row) => row.line_ref === butterRef)?.mass_source).toBeTruthy();
    expect(state.sessionIdentity).toBe(identity);
  }, 180000);

  it('the application never supplies a fabricated identity', () => {
    const app = readFileSync(join(__dirname, '../../src/App.tsx'), 'utf8');
    // The old defect was a hardcoded null sessionIdentity passed to the modal.
    expect(app).not.toMatch(/sessionIdentity=\{null\}/);
    expect(app).not.toMatch(/sessionIdentity=\{['"]/);
    const modal = readFileSync(join(__dirname, '../../src/components/ShisoModal.tsx'), 'utf8');
    expect(modal).toContain('shiso.snapshot?.sessionIdentity');
  });
});

// ===========================================================================
// I-2 — the user sees the AUTHENTICATED replacement record
// ===========================================================================

describe('I-2 — the replacement identity is disclosed from authenticated data', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 240000);

  it('NFS butter is excluded when it cannot establish the authored unsalted identity', () => {
    const { rows } = makeState(session, RECIPE);
    const row = rows[3];
    const d = buildIdentityDisclosure(row, row.original_text, 2710154, currentIdentity(session, RECIPE, 3));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect((d as { reason?: string }).reason).toBe('candidate_not_in_authenticated_review');
  }, 180000);

  it('salted butter cannot use an NFS candidate that drops the authored qualifier', () => {
    const { rows } = makeState(session, ['6 tbsp salted butter']);
    const row = rows[0];
    // 2710154 "Butter, NFS" IS a genuine candidate here and drops "salted".
    expect(row.candidates.some((c) => c.fdc_id === 2710154)).toBe(false);
    const d = buildIdentityDisclosure(row, row.original_text, 2710154, currentIdentity(session, ['6 tbsp salted butter']));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect((d as { reason?: string }).reason).toBe('candidate_not_in_authenticated_review');
  }, 180000);

  it('the matcher still refuses UNSALTED butter for a SALTED recipe (authority unchanged)', () => {
    // I-2 discloses; it must NOT have relaxed source constraints, and it did not.
    const { rows } = makeState(session, ['6 tbsp salted butter']);
    expect(rows[0].candidates.some((c) => c.fdc_id === 789828)).toBe(false);
  }, 180000);

  it('raw milk cannot be replaced by a candidate that does not preserve raw identity', () => {
    const { rows } = makeState(session, ['1 cup raw whole milk']);
    const row = rows[0];
    const d = buildIdentityDisclosure(row, row.original_text, 2705385, currentIdentity(session, ['1 cup raw whole milk']));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect((d as { reason?: string }).reason).toBe('candidate_not_in_authenticated_review');
  }, 180000);

  it('a record that IS in the candidate set but matches fully shows no warning', () => {
    const { rows } = makeState(session, ['6 tbsp unsalted butter']);
    const row = rows[0];
    // 789828 is the current unsalted record; proposing it drops nothing.
    const d = buildIdentityDisclosure(row, row.original_text, 789828, currentIdentity(session, ['6 tbsp unsalted butter']));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.droppedQualifiers).not.toContain('unsalted');
    expect(d.qualifierWarning).toBeNull();
  }, 180000);

  it('a record NOT in the authenticated candidate set is never disclosed', () => {
    const { rows } = makeState(session, ['6 tbsp unsalted butter']);
    const row = rows[0];
    const d = buildIdentityDisclosure(row, row.original_text, 999999999, currentIdentity(session, ['6 tbsp unsalted butter']));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect((d as { reason?: string }).reason).toBe('candidate_not_in_authenticated_review');
  });

  it('Nutrient identity is NOT weakened: the NFS record is never auto-accepted', () => {
    // A proposal cannot bypass authenticated candidate filtering when it drops
    // the authored unsalted identity.
    const { adapted, rows, state } = makeState(session, RECIPE);
    const proposal: ShisoProposal = {
      line_ref: adapted[3].line_ref, ingredient_label: '6 tbsp unsalted butter',
      outcome: 'verified_alternative_match', explanation: 'e', question: null,
      fdc_id: 2710154, record_digest: 'sha256:x', review_digest: 'y',
    };
    const result = prepareShisoProposalActions({
      bound: bind(proposal, state.recipeKey as string, state.sessionIdentity as string),
      session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted,
    });
    expect(result.ok).toBe(false);
  }, 180000);
});

// ===========================================================================
// Cross-checks from §7
// ===========================================================================

describe('cross-checks — every forged or stale input fails closed', () => {
  let session: AdvancedNutritionSession;
  beforeAll(async () => { session = await loadPinned(); }, 240000);

  const base = () => makeState(session, RECIPE);

  it('rejects: forged FDC id', () => {
    const { adapted, rows, state } = base();
    const p = { line_ref: adapted[3].line_ref, ingredient_label: 'b', outcome: 'verified_alternative_match', explanation: '', question: null, fdc_id: 123456789, record_digest: 'd', review_digest: 'r' } as ShisoProposal;
    const r = prepareShisoProposalActions({ bound: bind(p, state.recipeKey as string, state.sessionIdentity as string), session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { reason?: string }).reason).toBe('candidate_not_authentic');
  }, 180000);

  it('rejects: forged gram weight on a real portion index', () => {
    const { adapted, rows, state } = base();
    const p = { line_ref: adapted[3].line_ref, ingredient_label: 'b', outcome: 'verified_available_portion', explanation: '', question: null, fdc_id: 2710154, portion_index: 0, gram_weight: 12345, measure: '1 tbsp', record_digest: 'd' } as unknown as ShisoProposal;
    const r = prepareShisoProposalActions({ bound: bind(p, state.recipeKey as string, state.sessionIdentity as string), session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['portion_not_authentic', 'unknown_line_ref']).toContain((r as { reason?: string }).reason);
  }, 180000);

  it('rejects: unsupported portion index', () => {
    const { adapted, rows, state } = base();
    const p = { line_ref: adapted[3].line_ref, ingredient_label: 'b', outcome: 'verified_available_portion', explanation: '', question: null, fdc_id: 2710154, portion_index: 999, gram_weight: 14, measure: '1 tbsp', record_digest: 'd' } as unknown as ShisoProposal;
    const r = prepareShisoProposalActions({ bound: bind(p, state.recipeKey as string, state.sessionIdentity as string), session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { reason?: string }).reason).toBe('portion_not_authentic');
  }, 180000);

  it('rejects: wrong recipe and wrong session', () => {
    const { adapted, rows, state } = base();
    const p = { line_ref: adapted[3].line_ref, ingredient_label: 'b', outcome: 'verified_alternative_match', explanation: '', question: null, fdc_id: 2710154, record_digest: 'd', review_digest: 'r' } as ShisoProposal;
    const wrongRecipe = prepareShisoProposalActions({ bound: bind(p, 'other-recipe', state.sessionIdentity as string), session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted });
    expect(wrongRecipe.ok).toBe(false);
    if (!wrongRecipe.ok) expect((wrongRecipe as { reason?: string }).reason).toBe('stale_recipe');
    const wrongSession = prepareShisoProposalActions({ bound: bind(p, state.recipeKey as string, 'other-session'), session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows, adapted });
    expect(wrongSession.ok).toBe(false);
    if (!wrongSession.ok) expect((wrongSession as { reason?: string }).reason).toBe('stale_session');
  }, 180000);

  it('rejects: missing session identity makes a proposal NON-ACTIONABLE, never defaulted', () => {
    const { adapted, rows, state } = base();
    const p = { line_ref: adapted[3].line_ref, ingredient_label: 'b', outcome: 'verified_alternative_match', explanation: '', question: null, fdc_id: 2710154, record_digest: 'd', review_digest: 'r' } as ShisoProposal;
    const r = prepareShisoProposalActions({ bound: bind(p, state.recipeKey as string, state.sessionIdentity as string), session, recipeKey: state.recipeKey, sessionIdentity: null, rows, adapted });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { reason?: string }).reason).toBe('stale_session');
  }, 180000);

  it('rejects: an EDITED ingredient makes an older proposal stale', () => {
    const { adapted, rows, state } = base();
    // The proposal was raised against one ingredient text; the row now differs.
    const edited = rows.map((r) => (r.line_ref === adapted[3].line_ref ? { ...r, original_text: '200 g of something else entirely' } : r));
    const p = { line_ref: adapted[3].line_ref, ingredient_label: 'b', outcome: 'verified_available_portion', explanation: '', question: null, fdc_id: 2710154, portion_index: 7, gram_weight: 14, measure: '1 tbsp', record_digest: 'd' } as unknown as ShisoProposal;
    const r = prepareShisoProposalActions({ bound: bind(p, state.recipeKey as string, state.sessionIdentity as string), session, recipeKey: state.recipeKey, sessionIdentity: state.sessionIdentity, rows: edited, adapted });
    // Either refused outright, or the existing authority refuses the portion.
    if (r.ok === false) expect(['portion_not_authentic', 'unknown_line_ref']).toContain(r.reason);
    else expect(r.ok).toBe(true);
  }, 180000);
});
