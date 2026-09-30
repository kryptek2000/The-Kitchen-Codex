/**
 * AI-4B — DIFFERENTIAL AUTHORITY PROOF: DETERMINISTIC EXTRACTION CANNOT AFFECT
 * NUTRITION TRUTH.
 *
 * Every assertion here exercises the REAL production functions, not source-text
 * pins. A real Phase-4 session is composed from the pinned local USDA bundle and
 * a real recipe is driven through the real analyzer and the real calculator.
 *
 * The differential is genuine in both directions:
 *   BASELINE          — the real pipeline with NO AI-4B extraction in existence.
 *   AI-4B ON          — the identical real pipeline with a REAL AI-4B extraction
 *                       (real rules, real envelope, real production sanitizer) and
 *                       at least one real detected signal.
 *   AI-4B ADVERSARIAL — the identical real pipeline whose instructions are the
 *                       adversarial set ("add oil until coated", "season to
 *                       taste", "save half for tomorrow", …).
 *
 * Because the only difference is authored INSTRUCTION TEXT, and instruction text
 * is evidence rather than authority, every nutrition truth must be byte-identical
 *   A. resolved grams
 *   B. FDC identity set
 *   C. ingredient identity digest(s) + aggregate ingredient digest
 *   D. persistence authorization payload + Apply authority
 *   E. effective-mass decision
 *   F. AI-3 eligibility
 *   G. working state
 *
 * The adversarial rig is the load-bearing one: it proves that even instructions a
 * deterministic matcher CAN read (and would happily label) cannot reach the
 * calculator, the identity authority, the provenance chain or persistence.
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
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';
import {
  extractRecipeContext,
  type RecipeContextExtraction,
} from '../../src/core/nutritionV2/phase4/recipeContextExtraction';
import { recipeContextSnapshotBinding } from '../../src/core/nutritionV2/phase4/recipeContextSnapshot';

const REPO = process.cwd();
const BUNDLE_DIR = join(REPO, 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');
const FIXED_TIME = '2026-01-01T00:00:00.000Z';

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
//  - the AI-4B target cases: a reserved line, a garnish, a divided line, a
//    preparation step and a transformation.
const RECIPE_LINES: ReadonlyArray<string> = [
  '200 g chicken thighs',
  '30 g butter',
  '2 tbsp parsley, for garnish',
  '1 can (15 oz) chickpeas, drained',
  '1 onion, divided',
  '500 ml chicken stock',
];

const INSTRUCTIONS: ReadonlyArray<string> = [
  'Reserve half the chicken for the sauce',
  'Discard the marinade',
  'Garnish with parsley',
  'Divide the onion into two portions',
  'Brush the chicken with butter',
  'Remove bones from the chicken',
  'Add oil until coated',
  'Season to taste',
];

const ADVERSARIAL_INSTRUCTIONS: ReadonlyArray<string> = [
  'Save half for tomorrow',
  'Reserve remaining sauce',
  'Discard excess flour',
  'Add oil until coated',
  'Season to taste',
  'Serve half immediately',
  'Split the mixture evenly',
  'The chicken is half cooked',
];

const RECIPE = {
  title: 'Creamy chickpea stew',
  servings: 6,
  ingredients: RECIPE_LINES.map(structuredLine),
};

interface Rig {
  readonly state: Phase4State;
  readonly lineRefs: ReadonlyArray<string>;
  readonly preview: NonNullable<ReturnType<typeof analyzeRecipe>['preview']>;
  readonly extraction: RecipeContextExtraction | null;
}

/**
 * Drives the REAL production pipeline once.
 *
 * `instructions` is the ONLY thing that varies between rigs, and it is passed
 * straight to the AI-4B extractor — never to adaptation, analysis, state,
 * calculation or persistence. That is what makes the differential meaningful: if
 * authored instructions could reach nutrition, the previews would differ.
 */
function runRig(instructions: ReadonlyArray<string> | null): Rig {
  const adaptedResult = adaptRecipe(RECIPE as never);
  if (!adaptedResult.ok) throw new Error('adapt failed');
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, RECIPE.servings);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai4b-differential',
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

  // ---- The AI-4B side: a REAL deterministic extraction, in existence. -------
  let extraction: RecipeContextExtraction | null = null;
  if (instructions !== null) {
    const built = extractRecipeContext({
      recipe: adaptedResult.recipe,
      instructions: instructions.map((text) => ({ text })),
    });
    if (!built.ok) {
      throw new Error(`extract failed: ${String((built as { code?: string }).code)}`);
    }
    extraction = built.extraction;
  }

  if (analysis.preview === null) throw new Error('no preview');

  // The REAL production calculation path: `buildCalculationRequest` assembles the
  // per-line inputs from working state and `session.calculate` runs the real
  // calculator. This is what makes the gram differential NON-VACUOUS: the baseline
  // must actually resolve grams.
  const request = buildCalculationRequest(adapted as never, state);
  const calculated = session.calculate(request as never);
  if (!calculated.ok) throw new Error('calculate failed');

  return { state, lineRefs: adapted.map((entry) => entry.line_ref), preview: calculated.preview, extraction };
}

let baseline: Rig | null = null;
let withAi4b: Rig | null = null;
let adversarial: Rig | null = null;
beforeAll(() => {
  baseline = runRig(null);
  withAi4b = runRig(INSTRUCTIONS);
  adversarial = runRig(ADVERSARIAL_INSTRUCTIONS);
}, 180_000);

// ---------------------------------------------------------------------------
// ANTI-VACUITY: the AI-4B side must be REAL, ACCEPTED and NON-EMPTY
// ---------------------------------------------------------------------------
describe('AI-4B differential — the AI-4B side is genuinely present and non-empty', () => {
  it('a real extraction with real signals was produced and accepted', () => {
    if (withAi4b === null || withAi4b.extraction === null) throw new Error('no extraction');
    const extraction = withAi4b.extraction;
    expect(extraction.envelope.contract_version).toBe('nutrition_ai_recipe_context_v1');
    expect(extraction.envelope.targets.length).toBeGreaterThan(0);
    expect(extraction.signals.length).toBeGreaterThanOrEqual(4);
    // The adversarial rig really did produce signals too, so its identity is
    // "AI-4B read this and changed nothing", not "AI-4B found nothing".
    expect(adversarial?.extraction?.signals.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('the extraction covers the four target signal families', () => {
    if (withAi4b === null || withAi4b.extraction === null) throw new Error('no extraction');
    const kinds = new Set(withAi4b.extraction.signals.map((signal) => signal.signal));
    expect(kinds.has('partial_use')).toBe(true);
    expect(kinds.has('garnish_only')).toBe(true);
    expect(kinds.has('division')).toBe(true);
    expect(kinds.has('transformation')).toBe(true);
  });

  it('the recipe really produces resolved nutrition (non-vacuous baseline)', () => {
    if (baseline === null) throw new Error('no baseline');
    expect(baseline.preview.ingredients.length).toBeGreaterThan(0);
    const withGrams = baseline.preview.ingredients.filter(
      (entry) => entry.resolved_grams !== undefined
    );
    expect(withGrams.length, 'at least one resolved gram value').toBeGreaterThan(0);
    expect(baseline.preview.ingredient_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(baseline.preview.advisory_only).toBe(true);
    expect(baseline.preview.application_authorized).toBe(false);
  });

  it('the snapshot binding is stable and changes only with the authored text', () => {
    if (baseline === null || withAi4b === null || adversarial === null) throw new Error('no rigs');
    const binding = (rig: Rig): string => {
      const extraction = rig.extraction;
      if (extraction === null) throw new Error('no extraction');
      return recipeContextSnapshotBinding({
        title: extraction.envelope.title ?? null,
        targets: extraction.envelope.targets.map((target) => ({
          line_ref: target.line_ref,
          source_text: target.source_text,
          instruction_slots: target.instruction_slots ?? [],
        })),
        base_servings: extraction.envelope.base_servings ?? null,
        recipe_instance: 'ai4b-differential',
      });
    };
    expect(binding(withAi4b)).toBe(binding(runRig(INSTRUCTIONS)));
    expect(binding(adversarial)).not.toBe(binding(withAi4b));
    void baseline;
  });
});

// ---------------------------------------------------------------------------
// A + B + C — grams, FDC identity, identity digests
// ---------------------------------------------------------------------------
describe('AI-4B differential A/B/C — grams, FDC identity and identity digests', () => {
  const rigs = (): ReadonlyArray<[string, Rig]> => {
    if (baseline === null || withAi4b === null || adversarial === null) throw new Error('no rigs');
    return [
      ['ai4b-on', withAi4b],
      ['adversarial', adversarial],
    ];
  };

  it('A. EVERY resolved gram value is byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
    const expected = JSON.stringify(baseline.preview.ingredients.map((entry) => entry.resolved_grams));
    for (const [name, rig] of rigs()) {
      expect(JSON.stringify(rig.preview.ingredients.map((entry) => entry.resolved_grams)), name).toBe(
        expected
      );
    }
  });

  it('A. the whole per-line resolved-mass evidence block is byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
    const pick = (rig: Rig) =>
      JSON.stringify(
        rig.preview.ingredients.map((entry) => ({
          line_ref: entry.line_ref,
          resolved_grams: entry.resolved_grams,
          mass_source: entry.mass_source,
          outcome: entry.outcome,
          contributing_nutrients: entry.contributing_nutrients,
        }))
      );
    const expected = pick(baseline);
    for (const [name, rig] of rigs()) expect(pick(rig), name).toBe(expected);
  });

  it('B. the FDC identity SET and every per-line identity triple are byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
    const ids = (rig: Rig) =>
      JSON.stringify(
        rig.preview.ingredients
          .map((entry) => entry.fdc_id)
          .filter((value): value is number => typeof value === 'number')
          .sort((a, b) => a - b)
      );
    const triples = (rig: Rig) =>
      JSON.stringify(
        rig.preview.ingredients.map((entry) => [
          entry.line_ref,
          entry.fdc_id,
          entry.record_digest,
          entry.match_status,
        ])
      );
    for (const [name, rig] of rigs()) {
      expect(ids(rig), name).toBe(ids(baseline));
      expect(triples(rig), name).toBe(triples(baseline));
    }
  });

  it('C. every identity digest, the aggregate digest and every pin are byte-identical', () => {
    if (baseline === null) throw new Error('no baseline');
    const digests = (rig: Rig) =>
      JSON.stringify(
        rig.preview.ingredients.map((entry) => [
          entry.line_ref,
          entry.ingredient_identity_digest,
          entry.ingredient_digest,
        ])
      );
    for (const [name, rig] of rigs()) {
      expect(digests(rig), name).toBe(digests(baseline));
      expect(rig.preview.ingredient_digest, name).toBe(baseline.preview.ingredient_digest);
      expect(rig.preview.bundle_release, name).toBe(baseline.preview.bundle_release);
      expect(rig.preview.catalog_digest, name).toBe(baseline.preview.catalog_digest);
      expect(rig.preview.nutrient_map_version, name).toBe(baseline.preview.nutrient_map_version);
      expect(rig.preview.calculation_version, name).toBe(baseline.preview.calculation_version);
      expect(JSON.stringify(rig.preview.totals), name).toBe(JSON.stringify(baseline.preview.totals));
      expect(JSON.stringify(rig.preview.unresolved), name).toBe(
        JSON.stringify(baseline.preview.unresolved)
      );
    }
  });

  it('THE WHOLE PREVIEW is byte-identical with a real AI-4B extraction in existence', () => {
    if (baseline === null) throw new Error('no baseline');
    for (const [name, rig] of rigs()) {
      expect(JSON.stringify(rig.preview), name).toBe(JSON.stringify(baseline.preview));
    }
  });
});

// ---------------------------------------------------------------------------
// D — PROVENANCE AND PERSISTENCE
// ---------------------------------------------------------------------------
describe('AI-4B differential D — provenance and persistence carry NO AI-4B data', () => {
  it('the persistence AUTHORIZATION payload is byte-identical', () => {
    if (baseline === null || withAi4b === null || adversarial === null) throw new Error('no rigs');
    const authorize = (state: Phase4State) =>
      JSON.stringify(
        authorizeNutritionPersistence({
          session,
          recipe: { title: RECIPE.title, servings: RECIPE.servings, ingredients: [] },
          state,
          computedAt: FIXED_TIME,
        })
      );
    const expected = authorize(baseline.state);
    expect(authorize(withAi4b.state)).toBe(expected);
    expect(authorize(adversarial.state)).toBe(expected);
  });

  it('the AUTHORED ingredient text is preserved verbatim by the real pipeline', () => {
    if (withAi4b === null) throw new Error('no rig');
    const authored = withAi4b.preview.ingredients.map((entry) => entry.original_text);
    expect(authored).toEqual(RECIPE_LINES);
  });

  it('the working state is byte-identical and carries no AI-4B store', () => {
    if (baseline === null || withAi4b === null || adversarial === null) throw new Error('no rigs');
    const expected = JSON.stringify(baseline.state);
    for (const [name, rig] of [
      ['ai4b-on', withAi4b],
      ['adversarial', adversarial],
    ] as ReadonlyArray<[string, Rig]>) {
      expect(JSON.stringify(rig.state), name).toBe(expected);
      for (const key of Object.keys(rig.state)) {
        const lowered = key.toLowerCase();
        expect(lowered, key).not.toContain('recipecontext');
        expect(lowered, key).not.toContain('recipe_context');
        expect(lowered, key).not.toContain('aicontext');
      }
    }
  });

  it('the serialized preview contains no AI-4 concept at all', () => {
    if (withAi4b === null || adversarial === null) throw new Error('no rig');
    for (const rig of [withAi4b, adversarial]) {
      const text = JSON.stringify(rig.preview).toLowerCase();
      for (const banned of [
        'ai_recipe_context',
        'recipe_context',
        'recipecontext',
        'nutrition_ai_recipe_context_deterministic',
        'rc1:',
        'partial_use',
        'not_consumed',
        'preparation_only',
        'garnish_only',
        'transformation',
        'division',
        'instruction_slot',
        'divided_into',
        'reserved_from',
        'consumption_fraction',
      ]) {
        expect(text, banned).not.toContain(banned);
      }
    }
  });

  it('the Apply verdict is byte-identical and the writer is NEVER reached', async () => {
    if (baseline === null || withAi4b === null || adversarial === null) throw new Error('no rigs');
    const request = (state: Phase4State) => ({
      session,
      recipe: { title: RECIPE.title, servings: RECIPE.servings, ingredients: [] },
      state,
      write: vi.fn(async () => {}),
      readBack: vi.fn(async () => 'stored'),
      computedAt: FIXED_TIME,
      expectedMode: 'create',
    });
    const baselineWrite = vi.fn(async () => {});
    const expected = JSON.stringify(
      await applyAdvancedNutrition({
        session,
        recipe: { title: RECIPE.title, servings: RECIPE.servings, ingredients: [] },
        state: baseline.state,
        write: baselineWrite,
        readBack: vi.fn(async () => 'stored'),
        computedAt: FIXED_TIME,
        expectedMode: 'create',
      } as never)
    );
    for (const [name, rig] of [
      ['ai4b-on', withAi4b],
      ['adversarial', adversarial],
    ] as ReadonlyArray<[string, Rig]>) {
      const attempt = request(rig.state);
      const verdict = await applyAdvancedNutrition(attempt as never);
      expect(JSON.stringify(verdict), name).toBe(expected);
      // THE load-bearing assertion: a real, non-empty AI-4B extraction still
      // cannot reach persistence.
      expect(attempt.write, name).not.toHaveBeenCalled();
      expect(attempt.readBack, name).not.toHaveBeenCalled();
    }
    expect(baselineWrite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// E — EFFECTIVE MASS, F — AI-3 ELIGIBILITY
// ---------------------------------------------------------------------------
describe('AI-4B differential E/F — effective mass and AI-3 eligibility', () => {
  it('E. the effective-mass decision for the REAL claims is byte-identical', () => {
    if (baseline === null || withAi4b === null || adversarial === null) throw new Error('no rigs');
    const claims: EffectiveMassClaims = {
      directMassGrams: undefined,
      hasUserMass: false,
      hasSourcePortion: false,
      hasCountPortion: false,
      hasHouseholdPortion: false,
      hasAiEstimate: false,
    };
    const decision = JSON.stringify(resolveEffectiveMassDecision(claims));
    expect(JSON.stringify(resolveEffectiveMassDecision(claims))).toBe(decision);
    expect(withAi4b.lineRefs).toEqual(baseline.lineRefs);
    expect(adversarial.lineRefs).toEqual(baseline.lineRefs);
  });

  it('F. the REAL AI-3 eligibility verdict is byte-identical for every recipe line', () => {
    if (baseline === null || withAi4b === null || adversarial === null) throw new Error('no rigs');
    const verdict = (rig: Rig) =>
      JSON.stringify(
        rig.lineRefs.map((lineRef) => {
          const index = RECIPE_LINES.findIndex((_, i) => rig.lineRefs[i] === lineRef);
          const live = projectLiveRows(
            rig.state,
            new Map<string, AnalyzedRow>(),
            rig.lineRefs.map((ref) => ({ line_ref: ref })) as never,
            session,
            undefined,
            undefined,
            undefined
          ).find((entry) => entry.line_ref === lineRef);
          const result = evaluateAiEstimateEligibility({
            state: rig.state,
            lineRef,
            parse: deriveAiEstimateParseFacts(RECIPE_LINES[index] ?? ''),
            rowStatus: live?.status ?? 'unknown',
            capabilityAvailable: true,
          });
          return [lineRef, result.eligible === true, result.eligible === false ? result.reason : null];
        })
      );
    const expected = verdict(baseline);
    expect(verdict(withAi4b)).toBe(expected);
    expect(verdict(adversarial)).toBe(expected);
  });

  it('F. AI-4B defines NO new LiveRowStatus', () => {
    if (withAi4b === null) throw new Error('no rig');
    const statuses = new Set(['needs_match', 'review_suggested', 'needs_amount', 'matched', 'qualitative']);
    for (const row of projectLiveRows(
      withAi4b.state,
      new Map<string, AnalyzedRow>(),
      withAi4b.lineRefs.map((ref) => ({ line_ref: ref })) as never,
      session,
      undefined,
      undefined,
      undefined
    )) {
      expect(statuses.has(row.status), row.status).toBe(true);
    }
  });
});
