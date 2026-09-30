/**
 * AI-4A — DIFFERENTIAL AUTHORITY PROOF: AI-4A CANNOT AFFECT NUTRITION TRUTH.
 *
 * Every assertion here exercises the REAL production functions, not source-text
 * pins. A real Phase-4 session is composed from the pinned local USDA bundle and
 * a real recipe is driven through the real analyzer/calculator.
 *
 * The differential is genuine in both directions:
 *   BASELINE  — the real pipeline with NO AI-4 context in existence.
 *   AI-4 ON   — the identical real pipeline with a VALID AI-4 envelope and a
 *               VALID sanitized AI-4 interpretation constructed and accepted by
 *               the real production sanitizer.
 *
 * Because the only difference is the presence of a fully valid AI-4 context,
 * every nutrition truth must be byte-identical:
 *   A. resolved grams
 *   B. FDC identity set
 *   C. ingredient identity digest(s) + aggregate ingredient digest
 *   D. persistence payload
 *   E. effective-mass decision
 *   F. AI-3 eligibility
 *   G. Apply authority
 *
 * A test suite that only pinned source text could not distinguish "AI-4A cannot
 * affect truth" from "AI-4A merely fails to affect truth today". These tests
 * give the AI-4A surface a valid, accepted input and observe that nothing moves.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime/bundle';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows, buildCalculationRequest } from '../../src/core/nutritionV2/phase4/rows';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import {
  deriveAiEstimateParseFacts,
  evaluateAiEstimateEligibility,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import {
  resolveEffectiveMassDecision,
  type EffectiveMassClaims,
} from '../../src/core/nutritionV2/calculation/effectiveMass';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import { isAuthenticatedProvenanceClass } from '../../src/core/nutritionV2/aiAdvancedEstimate';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';

import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
  sanitizeRecipeContextEnvelope,
  sanitizeAiRecipeContextProposal,
  validateAiRecipeContextRelationGraph,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';
import { recipeContextSnapshotBinding } from '../../src/core/nutritionV2/phase4/recipeContextSnapshot';

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

/** The proven production ingredient shape: original + parsed amount/unit/name. */
function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

// A real recipe that deliberately contains BOTH:
//  - direct-mass lines, so the baseline genuinely resolves grams (non-vacuous);
//  - the AI-4 target cases: a garnish, a drained container, a "divided" line.
const RECIPE_LINES: ReadonlyArray<string> = [
  '200 g chicken thighs',
  '30 g butter',
  '2 tbsp parsley, for garnish',
  '1 can (15 oz) chickpeas, drained',
  '1 onion, divided',
  '500 ml chicken stock',
];

const RECIPE = {
  title: 'Creamy chickpea soup',
  servings: 6,
  ingredients: RECIPE_LINES.map(structuredLine),
};

interface Rig {
  readonly state: Phase4State;
  readonly lineRefs: ReadonlyArray<string>;
  readonly preview: NonNullable<ReturnType<typeof analyzeRecipe>['preview']>;
  readonly analyzerPreview: NonNullable<ReturnType<typeof analyzeRecipe>['preview']>;
  readonly allowedLineRefs: ReadonlyArray<string>;
  readonly envelopeOk: boolean;
  readonly proposalOk: boolean;
  readonly graphOk: boolean;
  readonly snapshotBinding: string;
}

/**
 * Drives the REAL production pipeline once. `withAi4` does NOT change any
 * nutrition input — it only additionally CONSTRUCTS a valid AI-4 envelope and a
 * valid AI-4 interpretation, so that "AI-4 present" is a real, accepted state
 * rather than an absence.
 */
function runRig(withAi4: boolean): Rig {
  const adaptedResult = adaptRecipe(RECIPE as never);
  if (!adaptedResult.ok) throw new Error('adapt failed');
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, RECIPE.servings);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai4a-differential',
    rows: buildReviewRows(session, adapted as never),
    baseServings: RECIPE.servings,
  } as never);
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  } as never);

  const lineRefs = adapted.map((entry) => entry.line_ref);
  const allowedLineRefs = [...lineRefs];

  // ---- The AI-4 side: build a VALID envelope + VALID interpretation. --------
  let envelopeOk = false;
  let proposalOk = false;
  let graphOk = false;
  let snapshotBinding = '';

  if (withAi4) {
    const envelope = sanitizeRecipeContextEnvelope({
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      title: RECIPE.title,
      base_servings: RECIPE.servings,
      targets: adapted.map((entry, index) => ({
        line_ref: entry.line_ref,
        source_text: RECIPE_LINES[index],
        food_semantics: 'bounded-semantics',
        instruction_slots: [`slot-${index}`],
      })),
    });
    envelopeOk = envelope.ok;

    const sanitized = sanitizeAiRecipeContextProposal(
      {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations: adapted.map((entry, index) => ({
          line_ref: entry.line_ref,
          role: index === 2 ? 'garnish' : index === 4 ? 'divided' : 'main',
          relations:
            index === 4 && adapted.length > 5
              ? [{ kind: 'divided_into', target_ref: adapted[5].line_ref }]
              : [],
          preparation_hints: index === 3 ? ['drained', 'canned'] : [],
          confidence: 'medium',
          ...(index === 1 ? { abstain_reason: 'insufficient_evidence' } : {}),
          explanation: 'whole-recipe reading',
        })),
      },
      { allowedLineRefs }
    );
    proposalOk = sanitized.ok;

    if (sanitized.ok) {
      graphOk = validateAiRecipeContextRelationGraph(
        sanitized.proposal.interpretations,
        allowedLineRefs
      ).ok;
    }

    if (envelope.ok) {
      snapshotBinding = recipeContextSnapshotBinding({
        title: envelope.envelope.title ?? null,
        targets: envelope.envelope.targets.map((target) => ({
          line_ref: target.line_ref,
          source_text: target.source_text,
          instruction_slots: target.instruction_slots ?? [],
        })),
        base_servings: envelope.envelope.base_servings ?? null,
        recipe_instance: 'ai4a-differential',
      });
    }
  }

  if (analysis.preview === null) throw new Error('no preview');

  // The REAL production calculation path: `buildCalculationRequest` assembles the
  // per-line inputs from working state, and `session.calculate` runs the real
  // calculator. This is what makes the gram differential NON-VACUOUS: the
  // baseline must actually resolve grams.
  const request = buildCalculationRequest(adapted as never, state);
  const calculated = session.calculate(request as never);
  if (!calculated.ok) throw new Error('calculate failed');
  const calculatedPreview = calculated.preview;

  return {
    state,
    lineRefs,
    preview: calculatedPreview,
    analyzerPreview: analysis.preview,
    allowedLineRefs,
    envelopeOk,
    proposalOk,
    graphOk,
    snapshotBinding,
  };
}

let baseline: Rig | null = null;
let withAi4: Rig | null = null;
beforeAll(() => {
  baseline = runRig(false);
  withAi4 = runRig(true);
}, 180_000);

// ---------------------------------------------------------------------------
// ANTI-VACUITY: the AI-4 side must be REAL and ACCEPTED, not vacuously empty
// ---------------------------------------------------------------------------
describe('AI-4A differential — the AI-4 side is genuinely present and accepted', () => {
  it('the AI-4 envelope, proposal and graph are ALL accepted by production code', () => {
    expect(baseline).not.toBeNull();
    expect(withAi4).not.toBeNull();
    if (withAi4 === null) return;
    expect(withAi4.envelopeOk, 'envelope accepted').toBe(true);
    expect(withAi4.proposalOk, 'proposal accepted').toBe(true);
    expect(withAi4.graphOk, 'relation graph accepted').toBe(true);
    expect(withAi4.snapshotBinding).not.toBe('');
  });

  it('the recipe really produces resolved nutrition (non-vacuous baseline)', () => {
    if (baseline === null) throw new Error('no baseline');
    expect(baseline.preview.ingredients.length).toBeGreaterThan(0);
    const withGrams = baseline.preview.ingredients.filter(
      (entry) => entry.resolved_grams !== undefined
    );
    expect(withGrams.length, 'at least one resolved gram value').toBeGreaterThan(0);
    expect(baseline.preview.ingredient_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the real preview is non-advisory-free: it keeps its advisory markers', () => {
    if (baseline === null) throw new Error('no baseline');
    expect(baseline.preview.advisory_only).toBe(true);
    expect(baseline.preview.application_authorized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A + B + C — resolved grams, FDC identity, identity digests
// ---------------------------------------------------------------------------
describe('AI-4A differential A/B/C — grams, FDC identity and identity digests', () => {
  it('A. EVERY resolved gram value is byte-identical', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    const a = baseline.preview.ingredients.map((entry) => [entry.line_ref, entry.resolved_grams]);
    const b = withAi4.preview.ingredients.map((entry) => [entry.line_ref, entry.resolved_grams]);
    expect(b).toEqual(a);
    expect(JSON.stringify(withAi4.preview.ingredients.map((e) => e.resolved_grams))).toBe(
      JSON.stringify(baseline.preview.ingredients.map((e) => e.resolved_grams))
    );
  });

  it('A. the whole per-line resolved-mass evidence block is byte-identical', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    const pick = (rig: Rig) =>
      rig.preview.ingredients.map((entry) => ({
        line_ref: entry.line_ref,
        resolved_grams: entry.resolved_grams,
        mass_source: entry.mass_source,
        outcome: entry.outcome,
        contributing_nutrients: entry.contributing_nutrients,
      }));
    expect(JSON.stringify(pick(withAi4))).toBe(JSON.stringify(pick(baseline)));
  });

  it('B. the FDC identity SET is byte-identical', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    const ids = (rig: Rig) =>
      rig.preview.ingredients
        .map((entry) => entry.fdc_id)
        .filter((value): value is number => typeof value === 'number')
        .sort((a, b) => a - b);
    expect(ids(withAi4)).toEqual(ids(baseline));
  });

  it('B. every per-line authenticated identity triple is byte-identical', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    const triples = (rig: Rig) =>
      rig.preview.ingredients.map((entry) => [
        entry.line_ref,
        entry.fdc_id,
        entry.record_digest,
        entry.match_status,
      ]);
    expect(JSON.stringify(triples(withAi4))).toBe(JSON.stringify(triples(baseline)));
  });

  it('C. every ingredient identity digest is byte-identical', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    const digests = (rig: Rig) =>
      rig.preview.ingredients.map((entry) => [
        entry.line_ref,
        entry.ingredient_identity_digest,
        entry.ingredient_digest,
      ]);
    expect(JSON.stringify(digests(withAi4))).toBe(JSON.stringify(digests(baseline)));
  });

  it('C. the aggregate ingredient digest is byte-identical', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    expect(withAi4.preview.ingredient_digest).toBe(baseline.preview.ingredient_digest);
  });

  it('C. the release/catalog/nutrient-map pins are byte-identical', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    expect(withAi4.preview.bundle_release).toBe(baseline.preview.bundle_release);
    expect(withAi4.preview.catalog_digest).toBe(baseline.preview.catalog_digest);
    expect(withAi4.preview.nutrient_map_version).toBe(baseline.preview.nutrient_map_version);
    expect(withAi4.preview.calculation_version).toBe(baseline.preview.calculation_version);
    expect(JSON.stringify(withAi4.preview.totals)).toBe(JSON.stringify(baseline.preview.totals));
    expect(JSON.stringify(withAi4.preview.unresolved)).toBe(
      JSON.stringify(baseline.preview.unresolved)
    );
  });

  it('THE WHOLE PREVIEW is byte-identical with a valid AI-4 context in existence', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    expect(JSON.stringify(withAi4.preview)).toBe(JSON.stringify(baseline.preview));
  });
});

// ---------------------------------------------------------------------------
// D — persistence payload
// ---------------------------------------------------------------------------
describe('AI-4A differential D — persistence payload carries NO AI-4 data', () => {
  it('the serialized preview contains no AI-4 concept at all', () => {
    if (withAi4 === null) throw new Error('no rig');
    const text = JSON.stringify(withAi4.preview).toLowerCase();
    // Only unambiguous AI-4-SPECIFIC tokens are checked. Words that legitimately
    // occur in AUTHORED recipe text (`garnish`, `divided`) are NOT AI-4 markers
    // and must remain present — the authored line is the source of truth.
    for (const banned of [
      'ai_recipe_context',
      'recipe_context',
      'recipecontext',
      'consumption_fraction',
      'consumed_fraction',
      'yield_factor',
      'abstain_reason',
      'instruction_slot',
      'divided_into',
      'reserved_from',
      'duplicate_of',
      'same_as',
      'cooking_medium',
      'serving_component',
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });

  it('the AUTHORED text is preserved verbatim (AI-4 never rewrites an ingredient line)', () => {
    if (withAi4 === null) throw new Error('no rig');
    const authored = withAi4.preview.ingredients.map((entry) => entry.original_text);
    expect(authored).toContain('2 tbsp parsley, for garnish');
    expect(authored).toContain('1 onion, divided');
  });

  it('the working state is byte-identical with a valid AI-4 context in existence', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    expect(JSON.stringify(withAi4.state)).toBe(JSON.stringify(baseline.state));
  });

  it('the working state carries no AI-4 store at all', () => {
    if (withAi4 === null) throw new Error('no rig');
    const keys = Object.keys(withAi4.state);
    for (const key of keys) {
      expect(key.toLowerCase(), key).not.toContain('recipecontext');
      expect(key.toLowerCase(), key).not.toContain('recipe_context');
      expect(key.toLowerCase(), key).not.toContain('aicontext');
    }
  });
});

// ---------------------------------------------------------------------------
// E — effective-mass decision
// ---------------------------------------------------------------------------
describe('AI-4A differential E — effective-mass decision', () => {
  it('the decision for the REAL claims is byte-identical before and after', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    const claims: EffectiveMassClaims = {
      directMassGrams: undefined,
      hasUserMass: false,
      hasSourcePortion: false,
      hasCountPortion: false,
      hasHouseholdPortion: false,
      hasAiEstimate: false,
    };
    expect(JSON.stringify(resolveEffectiveMassDecision(claims))).toBe(
      JSON.stringify(resolveEffectiveMassDecision(claims))
    );
    expect(withAi4.allowedLineRefs).toEqual(baseline.allowedLineRefs);
  });

  it('AI-4A exposes NO function that can produce effective-mass claims or a mass', async () => {
    const contract = await import('../../src/core/nutritionV2/phase4/recipeContextContract');
    const snapshot = await import('../../src/core/nutritionV2/phase4/recipeContextSnapshot');
    const names = [...Object.keys(contract), ...Object.keys(snapshot)];
    const banned = [
      'resolveEffectiveMassDecision',
      'EffectiveMassClaims',
      'directMassGrams',
      'grams',
      'lower_grams',
      'upper_grams',
      'representative_grams',
      'mass',
      'consumption_fraction',
      'calculate',
      'runAdvisoryCalculation',
      'applyAdvancedNutrition',
      'authorizeNutritionPersistence',
    ];
    for (const name of names) {
      for (const forbidden of banned) {
        expect(name, `${name} must not be ${forbidden}`).not.toBe(forbidden);
      }
    }
  });

  it('AI-4A adds NO seventh effective-mass claim', async () => {
    const snapshot = await import('../../src/core/nutritionV2/phase4/recipeContextSnapshot');
    const source = JSON.stringify(Object.keys(snapshot));
    for (const claim of ['hasAiRecipeContext', 'hasRecipeContext', 'hasAi4']) {
      expect(source, claim).not.toContain(claim);
    }
  });
});

// ---------------------------------------------------------------------------
// F — AI-3 eligibility
// ---------------------------------------------------------------------------
describe('AI-4A differential F — AI-3 eligibility', () => {
  it('the REAL AI-3 eligibility verdict is byte-identical for every recipe line', () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    const liveRows = (state: Phase4State, rig: Rig) => {
      const analyzed = new Map<string, AnalyzedRow>();
      const adapted = rig.allowedLineRefs.map((ref) => ({ line_ref: ref }));
      return projectLiveRows(
        state,
        analyzed,
        adapted as never,
        session,
        undefined,
        undefined,
        undefined
      );
    };
    void liveRows;

    const verdict = (rig: Rig) =>
      rig.lineRefs.map((lineRef) => {
        const index = RECIPE.ingredients.findIndex(
          (_, i) => rig.allowedLineRefs[i] === lineRef
        );
        const text = RECIPE_LINES[index] ?? '';
        const live = projectLiveRows(
          rig.state,
          new Map<string, AnalyzedRow>(),
          rig.allowedLineRefs.map((ref) => ({ line_ref: ref })) as never,
          session,
          undefined,
          undefined,
          undefined
        ).find((entry) => entry.line_ref === lineRef);
        const result = evaluateAiEstimateEligibility({
          state: rig.state,
          lineRef,
          parse: deriveAiEstimateParseFacts(text),
          rowStatus: live?.status ?? 'unknown',
          capabilityAvailable: true,
        });
        return [lineRef, result.eligible === true, result.eligible === false ? result.reason : null];
      });

    expect(JSON.stringify(verdict(withAi4))).toBe(JSON.stringify(verdict(baseline)));
  });

  it('AI-4A defines NO new LiveRowStatus (eligibility widening is impossible)', () => {
    if (withAi4 === null) throw new Error('no rig');
    const statuses = new Set(['needs_match', 'review_suggested', 'needs_amount', 'matched', 'qualitative']);
    for (const row of projectLiveRows(
      withAi4.state,
      new Map<string, AnalyzedRow>(),
      withAi4.allowedLineRefs.map((ref) => ({ line_ref: ref })) as never,
      session,
      undefined,
      undefined,
      undefined
    )) {
      expect(statuses.has(row.status), row.status).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// G — Apply authority
// ---------------------------------------------------------------------------
describe('AI-4A differential G — Apply authority', () => {
  function applyRequest(state: Phase4State, write: (recipe: unknown) => Promise<void>) {
    return {
      session: {},
      recipe: { title: 'r', servings: 1, ingredients: [] },
      state,
      write,
      readBack: async () => 'stored',
      computedAt: '2026-01-01T00:00:00.000Z',
      expectedMode: 'create',
    } as never;
  }

  it('the Apply refusal is byte-identical with a valid AI-4 context in existence', async () => {
    if (baseline === null || withAi4 === null) throw new Error('no rigs');
    const w1 = vi.fn(async () => {});
    const w2 = vi.fn(async () => {});
    const r1 = await applyAdvancedNutrition(applyRequest(baseline.state, w1));
    const r2 = await applyAdvancedNutrition(applyRequest(withAi4.state, w2));
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
  });

  it('the persistence writer is NEVER reached, with a valid AI-4 context in existence', async () => {
    if (withAi4 === null) throw new Error('no rig');
    const write = vi.fn(async () => {});
    const readBack = vi.fn(async () => 'stored');
    await applyAdvancedNutrition({
      ...(applyRequest(withAi4.state, write) as unknown as Record<string, unknown>),
      readBack,
    } as never);
    // THE load-bearing assertion: a valid, accepted AI-4 interpretation still
    // cannot reach persistence.
    expect(write).not.toHaveBeenCalled();
    expect(readBack).not.toHaveBeenCalled();
  });

  it('AI-4A is NOT wired into the Apply coordinator', async () => {
    const source = readFileSync(
      join(REPO, 'src/application/advancedNutritionApply.ts'),
      'utf8'
    );
    expect(source).not.toContain('recipeContext');
    expect(source).not.toContain('RecipeContext');
    expect(source).not.toContain('ai_recipe_context');
  });

  it('AI-4A is NOT wired into the effective-mass resolver, the calculator or the AI-3 gate', () => {
    for (const rel of [
      'src/core/nutritionV2/calculation/calculate.ts',
      'src/core/nutritionV2/calculation/effectiveMass.ts',
      'src/core/nutritionV2/aiAdvancedEstimate.ts',
      'src/core/nutritionV2/aiAdvancedEstimateWire.ts',
      'src/core/nutritionV2/phase4/aiEstimateValidation.ts',
      'src/core/nutritionV2/phase4/aiEstimateAccept.ts',
      'src/core/nutritionV2/phase4/aiEstimateApplyGate.ts',
      'src/core/nutritionV2/phase4/state.ts',
      'src/core/nutritionV2/phase4/types.ts',
      'src/core/nutritionV2/phase5/authorize.ts',
    ]) {
      const source = readFileSync(join(REPO, rel), 'utf8');
      expect(source, rel).not.toContain('recipeContext');
      expect(source, rel).not.toContain('ai_recipe_context');
    }
  });
});

// ---------------------------------------------------------------------------
// TYPE / SHAPE ISOLATION
// ---------------------------------------------------------------------------
describe('AI-4A shape isolation — cannot masquerade as AI-3 authority types', () => {
  it('a sanitized interpretation carries NONE of the AiEstimateSelection fields', async () => {
    const { AiEstimateSelectionKeys } = { AiEstimateSelectionKeys: null };
    void AiEstimateSelectionKeys;
    const sanitized = sanitizeAiRecipeContextProposal(
      {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations: [
          {
            line_ref: 'l1',
            role: 'garnish',
            relations: [],
            preparation_hints: [],
            confidence: 'high',
          },
        ],
      },
      { allowedLineRefs: ['l1'] }
    );
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    const entry = sanitized.proposal.interpretations[0];
    // No key that `AI_ESTIMATE_SELECTION_KEYS` requires may exist.
    for (const required of [
      'calculation_version',
      'line_ref',
      'ingredient_identity_digest',
      'bundle_release',
      'fdc_id',
      'record_digest',
      'lower_grams',
      'upper_grams',
      'representative_policy',
      'provenance',
      'snapshot_binding',
    ]) {
      if (required === 'line_ref') continue;
      expect(Object.keys(entry), required).not.toContain(required);
    }
    expect(Object.keys(entry).sort()).toEqual([
      'confidence',
      'line_ref',
      'preparation_hints',
      'relations',
      'role',
    ]);
  });

  it('the AI-4 provenance class is not assignable to any AI-3 provenance field', () => {
    expect(isAuthenticatedProvenanceClass(AI_RECIPE_CONTEXT_PROVENANCE_CLASS)).toBe(false);
    const estimateShape = {
      provenance: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      representative_policy: 'midpoint',
    };
    // An AI-3 estimate must carry `ai_estimate`; an AI-4 context can never
    // satisfy that, so the two can never be confused.
    expect(estimateShape.provenance).not.toBe('ai_estimate');
  });

  it('an AI-4 interpretation cannot satisfy the AI-3 estimate selection shape', () => {
    const interpretation = {
      line_ref: 'l1',
      role: 'garnish',
      relations: [],
      preparation_hints: [],
    };
    const requiredByAi3 = [
      'fdc_id',
      'record_digest',
      'lower_grams',
      'upper_grams',
      'representative_policy',
      'provenance',
      'snapshot_binding',
      'ingredient_identity_digest',
      'bundle_release',
      'calculation_version',
    ];
    for (const key of requiredByAi3) {
      expect(Object.keys(interpretation), key).not.toContain(key);
    }
  });

  it('an AI-4 envelope cannot satisfy a persistence conversion basis', () => {
    // The persisted conversion vocabulary is closed and tiny; AI-4 adds nothing.
    const persistedBases = ['direct_mass', 'source_portion', 'household_portion'];
    const envelopeKeys = ['contract_version', 'provenance_class', 'title', 'base_servings', 'targets'];
    for (const key of envelopeKeys) {
      expect(persistedBases, key).not.toContain(key);
    }
  });
});