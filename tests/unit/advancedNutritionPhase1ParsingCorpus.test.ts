/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: canonical parsing corpus
 * against the REAL pinned USDA bundle.
 *
 * Proves the Phase 1 parsing slice:
 *   - the canonical parse matches the fixture exactly (offline assertions are in
 *     `advancedNutritionPhase1CanonicalParsing.test.ts`);
 *   - identity safety: no incorrect automatic identity, no forbidden bind, the
 *     Phase 0A secondary-component veto stays intact;
 *   - mass truthfulness: a range never produces grams, a container/package net
 *     mass never becomes a generic container mass, and grams appear ONLY through
 *     the existing authenticated routes (direct mass / source portion /
 *     count portion);
 *   - every automatic-identity effect of this slice is enumerated and pinned.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { selectAutomaticMatch, selectBestEffortMatch } from '../../src/core/nutritionV2/matching/confidence';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { buildCalculationRequest } from '../../src/core/nutritionV2/phase4/rows';
import { selectDeterministicCountPortion } from '../../src/core/nutritionV2/calculation/countPortion';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4';
import {
  PHASE1_PARSING_CASES,
  type Phase1ParsingCase,
} from '../fixtures/advancedNutritionPhase1ParsingCorpus';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) {
    throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  }
  session = result.session;
}, 180000);

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

interface LineDiagnostic {
  readonly line: string;
  readonly reviewOutcome: string;
  readonly autoFdc: number | null;
  readonly bestFdc: number | null;
  readonly analyzerSelectedFdc: number | null;
  readonly analyzerStatus: string;
  readonly previewGrams: number | null;
  readonly previewMassSource: string | null;
  readonly liveStatus: string;
  readonly liveGrams: number | null;
  readonly liveMassSource: string | null;
  readonly candidateDescriptions: ReadonlyArray<string>;
  readonly automaticDescriptions: ReadonlyArray<string>;
}

function diagnose(cases: ReadonlyArray<Phase1ParsingCase>): ReadonlyArray<LineDiagnostic> {
  const adaptation = adaptRecipe({
    title: 'Phase 1 Canonical Parsing Corpus',
    servings: 4,
    ingredients: cases.map((spec) => structuredLine(spec.line)),
  });
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  const analysis = analyzeRecipe(session, adapted, 4);
  const state = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: null,
    baseServings: 4,
    rows,
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: 4,
    preview: analysis.preview ?? null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as Phase4State;
  const liveRows = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
    analysis.portions,
    analysis.countPortions
  );

  const descriptions = new Map<number, string>();
  for (const row of rows) {
    for (const candidate of row.candidates) descriptions.set(candidate.fdc_id, candidate.description);
  }

  return cases.map((spec, index) => {
    const row = rows[index];
    const review = row.review as never;
    const auto = selectAutomaticMatch(review);
    const best = selectBestEffortMatch(review);
    const analyzer = analysis.rows[index];
    const evidence = analysis.preview?.ingredients[index];
    const live = liveRows[index];
    const automaticFdcs = [auto?.fdc_id, best?.fdc_id, analyzer.selected_fdc_id].filter(
      (fdc): fdc is number => fdc !== undefined && fdc !== null
    );
    return Object.freeze({
      line: spec.line,
      reviewOutcome: row.outcome,
      autoFdc: auto?.fdc_id ?? null,
      bestFdc: best?.fdc_id ?? null,
      analyzerSelectedFdc: analyzer.selected_fdc_id ?? null,
      analyzerStatus: analyzer.status,
      previewGrams: evidence?.resolved_grams ?? null,
      previewMassSource: evidence?.mass_source ?? null,
      liveStatus: live.status,
      liveGrams: live.resolved_grams ?? null,
      liveMassSource: live.mass_source ?? null,
      candidateDescriptions: Object.freeze(row.candidates.map((candidate) => candidate.description)),
      automaticDescriptions: Object.freeze(
        automaticFdcs.map((fdc) => descriptions.get(fdc)).filter((d): d is string => d !== undefined)
      ),
    });
  });
}

interface SingleLineAnalysis {
  readonly adapted: ReadonlyArray<import('../../src/core/nutritionV2/phase4').AdaptedIngredient>;
  readonly rows: ReadonlyArray<import('../../src/core/nutritionV2/phase4').Phase4Row>;
  readonly analysis: ReturnType<typeof analyzeRecipe>;
  readonly state: Phase4State;
}

/** Runs one line through the REAL pinned bundle pipeline. */
function analyzeLine(line: string): SingleLineAnalysis {
  const adaptation = adaptRecipe({
    title: 'Phase 1 Single Line',
    servings: 4,
    ingredients: [structuredLine(line)],
  });
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  const analysis = analyzeRecipe(session, adapted, 4);
  const state = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: null,
    baseServings: 4,
    rows,
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: 4,
    preview: analysis.preview ?? null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as Phase4State;
  return { adapted, rows, analysis, state };
}

describe('phase 1 canonical parsing corpus — chickpea / canned-state authority', () => {
  interface ChickpeaCase {
    readonly line: string;
    readonly expectedAutoFdc: number | null;
    readonly expectedLiveStatus: string;
    readonly container?: string;
    readonly packageMassAmount?: number;
  }

  const CASES: ReadonlyArray<ChickpeaCase> = [
    // The established ordinary identities: `chickpeas` and its container form
    // already bound 2707414 (Chickpeas, NFS) in committed Phase 0B.
    { line: 'chickpeas', expectedAutoFdc: 2707414, expectedLiveStatus: 'needs_amount' },
    { line: '1 can chickpeas', expectedAutoFdc: 2707414, expectedLiveStatus: 'needs_amount', container: 'can' },
    { line: '1 400 g can chickpeas', expectedAutoFdc: 2707414, expectedLiveStatus: 'needs_amount', container: 'can', packageMassAmount: 400 },
    { line: '1 can (400 g) chickpeas', expectedAutoFdc: 2707414, expectedLiveStatus: 'needs_amount', container: 'can', packageMassAmount: 400 },
    { line: '1 (400 g) can chickpeas', expectedAutoFdc: 2707414, expectedLiveStatus: 'needs_amount', container: 'can', packageMassAmount: 400 },
    // `drained` is a preparation qualifier; the established identity is the same.
    { line: 'drained chickpeas', expectedAutoFdc: 2707414, expectedLiveStatus: 'needs_amount' },
    { line: '1 can drained chickpeas', expectedAutoFdc: 2707414, expectedLiveStatus: 'needs_amount', container: 'can' },
    // State-ambiguous or non-matching forms withhold automatic authority.
    { line: 'canned chickpeas', expectedAutoFdc: null, expectedLiveStatus: 'review_suggested' },
    { line: 'garbanzo beans', expectedAutoFdc: null, expectedLiveStatus: 'review_suggested' },
    { line: '1 can garbanzo beans', expectedAutoFdc: null, expectedLiveStatus: 'review_suggested', container: 'can' },
  ];

  it(
    'never widens automatic authority beyond the established ordinary chickpea identity',
    () => {
      // ONE bundle pass over all lines (the harness reuses the session), then
      // per-line identity/state assertions.
      const diagnostics = diagnose(CASES as unknown as ReadonlyArray<Phase1ParsingCase>);
      CASES.forEach((spec, index) => {
        const diag = diagnostics[index];
        const parsed = parseIngredient(spec.line);
        expect(parsed.ok, spec.line).toBe(true);
        if (!parsed.ok) return;
        expect(diag.analyzerSelectedFdc ?? null, spec.line).toBe(spec.expectedAutoFdc);
        expect(diag.liveStatus, spec.line).toBe(spec.expectedLiveStatus);
        expect(diag.liveGrams ?? null, spec.line).toBeNull();
        expect(diag.previewGrams ?? null, spec.line).toBeNull();
        if (spec.container !== undefined) {
          expect(parsed.parsed.container, spec.line).toBe(spec.container);
          expect(parsed.parsed.unit_kind, spec.line).toBe('container');
        }
        if (spec.packageMassAmount !== undefined) {
          expect(parsed.parsed.package_net_mass?.amount, spec.line).toBe(spec.packageMassAmount);
          expect(parsed.parsed.package_net_mass?.unit, spec.line).toBe('g');
        }
        // `canned` state wording is retained in the food phrase, never dropped.
        if (spec.line === 'canned chickpeas') {
          expect(parsed.parsed.query, spec.line).toContain('canned');
        }
        // The established identity is a state-neutral NFS record: no false
        // raw/cooked/canned/drained claim.
        if (spec.expectedAutoFdc === 2707414) {
          expect(diag.candidateDescriptions, spec.line).toContain('Chickpeas, NFS');
          expect('Chickpeas, NFS', spec.line).not.toMatch(/raw|cooked|canned|drained/i);
        }
      });
    },
    60000
  );
});

describe('phase 1 canonical parsing corpus — compound-food collisions', () => {
  interface CollisionCase {
    readonly line: string;
    readonly expectedAutoFdc: number | null;
    readonly expectedLiveStatus: string;
  }

  const CASES: ReadonlyArray<CollisionCase> = [
    { line: '1 bottle gourd', expectedAutoFdc: 169232, expectedLiveStatus: 'needs_amount' },
    { line: '2 bottle gourds', expectedAutoFdc: 169232, expectedLiveStatus: 'needs_amount' },
    { line: '1 head cheese', expectedAutoFdc: 2706180, expectedLiveStatus: 'needs_amount' },
    { line: '2 fish sticks', expectedAutoFdc: 2706224, expectedLiveStatus: 'needs_amount' },
    { line: '2 sausage links', expectedAutoFdc: null, expectedLiveStatus: 'review_suggested' },
    { line: '4 spare ribs', expectedAutoFdc: null, expectedLiveStatus: 'needs_match' },
    { line: '2 bay leaves', expectedAutoFdc: null, expectedLiveStatus: 'needs_match' },
    { line: '2 lemon strips', expectedAutoFdc: null, expectedLiveStatus: 'needs_match' },
    { line: '1 spring roll', expectedAutoFdc: null, expectedLiveStatus: 'needs_match' },
    { line: '1 breadstick', expectedAutoFdc: 2707689, expectedLiveStatus: 'needs_amount' },
    { line: '1 bagel', expectedAutoFdc: 2707684, expectedLiveStatus: 'needs_amount' },
    { line: '1 chicken-fried steak', expectedAutoFdc: null, expectedLiveStatus: 'needs_match' },
    { line: '1 bottle of hot sauce', expectedAutoFdc: null, expectedLiveStatus: 'review_suggested' },
    { line: '1 bottle hot sauce', expectedAutoFdc: null, expectedLiveStatus: 'review_suggested' },
  ];

  it(
    'preserves every compound food head and never invents grams',
    () => {
      // ONE bundle pass over all collision lines.
      const diagnostics = diagnose(CASES as unknown as ReadonlyArray<Phase1ParsingCase>);
      CASES.forEach((spec, index) => {
        const diag = diagnostics[index];
        expect(diag.analyzerSelectedFdc ?? null, spec.line).toBe(spec.expectedAutoFdc);
        expect(diag.liveStatus, spec.line).toBe(spec.expectedLiveStatus);
        expect(diag.liveGrams ?? null, spec.line).toBeNull();
        expect(diag.liveMassSource ?? null, spec.line).toBeNull();
        expect(diag.previewGrams ?? null, spec.line).toBeNull();
        expect(diag.previewMassSource ?? null, spec.line).toBeNull();
      });
    },
    60000
  );
});

describe('phase 1 canonical parsing corpus — `3 large carrots` authority proof', () => {
  it(
    'resolves only the authenticated whole-large-carrot portion and nothing strip-sized',
    () => {
      const review = session.reviewCountPortions('3 large carrots', 170393);
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.review.requirement).toEqual({ amount: 3, unit: null, size: 'large' });
      // Exactly one compatible portion: the WHOLE large carrot (72 g).
      expect(review.review.candidates).toHaveLength(1);
      const chosen = review.review.candidates[0];
      expect(chosen.gram_weight).toBe(72);
      expect(chosen.size).toBe('large');
      expect(chosen.unit).toBeNull();
      expect(chosen.modifier ?? '').toMatch(/large/i);
      expect(chosen.modifier ?? '').not.toMatch(/strip/i);
      expect(selectDeterministicCountPortion(review.review.candidates)?.candidate.gram_weight).toBe(72);

      // The removed competitor is genuinely a STRIP portion: under the matching
      // strip/size requirement the same record exposes it (7 g, `strip large`).
      const strips = session.reviewCountPortions('2 large carrot strips', 170393);
      expect(strips.ok).toBe(true);
      if (!strips.ok) return;
      expect(strips.review.requirement).toEqual({ amount: 2, unit: 'strip', size: 'large' });
      const stripCandidate = strips.review.candidates.find(
        (candidate) => candidate.gram_weight === 7 && candidate.size === 'large'
      );
      expect(stripCandidate).toBeDefined();
    },
    60000
  );

  it(
    'agrees across calculation and live projection and stays digest-authenticated',
    () => {
      const { adapted, analysis, state } = analyzeLine('3 large carrots');
      const calculated = session.calculate(buildCalculationRequest(adapted, state));
      expect(calculated.ok).toBe(true);
      if (!calculated.ok) return;
      const evidence = calculated.preview.ingredients[0];
      expect(evidence.outcome).toBe('calculated');
      expect(evidence.mass_source).toBe('count_portion');
      expect(evidence.resolved_grams).toBe(216); // 3 x authenticated 72 g
      expect(evidence.count_unit).toBeUndefined(); // size-only identity, no invented unit

      const live = projectLiveRows(
        state,
        new Map(analysis.rows.map((row) => [row.line_ref, row])),
        adapted,
        session,
        ingredientEvidenceViews(calculated.preview),
        analysis.portions,
        analysis.countPortions
      )[0];
      expect(live.status).toBe('matched');
      expect(live.resolved_grams).toBe(216);
      expect(live.mass_source).toBe('count_portion');

      // No generic carrot weight: the grams are exactly count x authenticated
      // portion gram weight.
      const chosen = session.reviewCountPortions('3 large carrots', 170393);
      expect(chosen.ok).toBe(true);
      if (chosen.ok) {
        expect(evidence.resolved_grams).toBe(3 * chosen.review.candidates[0].gram_weight);
      }
    },
    60000
  );

  it(
    'invalidates the choice when the size or the food changes',
    () => {
      const large = analyzeLine('3 large carrots');
      const largeState = large.state;
      const stored = largeState.countPortions[large.adapted[0].line_ref];
      // Analysis may store a deterministic count selection; if it does not, the
      // deterministic path is already proven above. When stored, it must be
      // rejected by the calculator on a different size/food.
      if (stored !== undefined) {
        const medium = analyzeLine('3 medium carrots');
        const staleState = {
          ...medium.state,
          countPortions: { ...medium.state.countPortions, [medium.adapted[0].line_ref]: stored },
        } as Phase4State;
        const stale = session.calculate(buildCalculationRequest(medium.adapted, staleState));
        const staleGrams = stale.ok ? stale.preview.ingredients[0].resolved_grams : undefined;
        expect(staleGrams).not.toBe(216);

        const potato = analyzeLine('3 large potatoes');
        const crossState = {
          ...potato.state,
          countPortions: { ...potato.state.countPortions, [potato.adapted[0].line_ref]: stored },
        } as Phase4State;
        const cross = session.calculate(buildCalculationRequest(potato.adapted, crossState));
        const crossGrams = cross.ok ? cross.preview.ingredients[0].resolved_grams : undefined;
        expect(crossGrams).not.toBe(216);
      }
    },
    60000
  );
});

/**
 * One bounded bundle pass per case-list identity. The corpus assertions are pure
 * reads of deterministic diagnostics, so re-running the same list is redundant
 * work; the repeated-run determinism test deliberately uses `diagnose` directly.
 */
const diagnoseCache = new WeakMap<object, ReadonlyArray<LineDiagnostic>>();
function diagnoseCached(cases: ReadonlyArray<Phase1ParsingCase>): ReadonlyArray<LineDiagnostic> {
  const cached = diagnoseCache.get(cases as object);
  if (cached) return cached;
  const fresh = diagnose(cases);
  diagnoseCache.set(cases as object, fresh);
  return fresh;
}

describe('phase 1 canonical parsing corpus — identity and mass truthfulness', () => {
  it(
    'matches every pinned identity expectation and never binds a forbidden food',
    () => {
      const diagnostics = diagnoseCached(PHASE1_PARSING_CASES);
      const violations: string[] = [];
      diagnostics.forEach((diag, index) => {
        const spec = PHASE1_PARSING_CASES[index];
        if (spec.expectedAutoFdc !== undefined && diag.analyzerSelectedFdc !== spec.expectedAutoFdc) {
          violations.push(
            `${spec.line}: pipeline auto ${diag.analyzerSelectedFdc ?? 'none'} != expected ${spec.expectedAutoFdc}`
          );
        }
        if (spec.expectNoAutomatic === true) {
          if (diag.autoFdc !== null) violations.push(`${spec.line}: unexpected strict automatic FDC ${diag.autoFdc}`);
          if (diag.bestFdc !== null) violations.push(`${spec.line}: unexpected best-effort FDC ${diag.bestFdc}`);
          if (diag.analyzerSelectedFdc !== null) {
            violations.push(`${spec.line}: unexpected pipeline-selected FDC ${diag.analyzerSelectedFdc}`);
          }
        }
        if (spec.forbiddenAutoDescription !== undefined) {
          for (const description of diag.automaticDescriptions) {
            if (spec.forbiddenAutoDescription.test(description)) {
              violations.push(`${spec.line}: automatic identity matched ${spec.forbiddenAutoDescription}: ${description}`);
            }
          }
        }
        if (spec.expectCandidateDescription !== undefined) {
          expect(
            diag.candidateDescriptions.some((description) => spec.expectCandidateDescription?.test(description)),
            `${spec.line}: no candidate matched ${spec.expectCandidateDescription}`
          ).toBe(true);
        }
      });
      expect(violations).toEqual([]);
    },
    60000
  );

  it(
    'proves a range never yields grams and never leaks an endpoint into mass',
    () => {
      const rangeCases = PHASE1_PARSING_CASES.filter((entry) => entry.quantityKind === 'range');
      expect(rangeCases.length).toBeGreaterThan(0);
      const diagnostics = diagnose(rangeCases);
      for (const diag of diagnostics) {
        expect(diag.previewGrams, diag.line).toBeNull();
        expect(diag.liveGrams, diag.line).toBeNull();
        expect(diag.previewMassSource, diag.line).toBeNull();
        expect(diag.liveMassSource, diag.line).toBeNull();
      }
    },
    60000
  );

  it(
    'proves containers and package net masses never become a generic container mass',
    () => {
      const containerCases = PHASE1_PARSING_CASES.filter(
        (entry) => entry.category === 'container' || entry.category === 'package-net-mass'
      );
      expect(containerCases.length).toBeGreaterThan(0);
      const diagnostics = diagnose(containerCases);
      for (const diag of diagnostics) {
        expect(diag.previewGrams, diag.line).toBeNull();
        expect(diag.liveGrams, diag.line).toBeNull();
      }
    },
    60000
  );

  it(
    'resolves mass only through the existing authenticated routes, exactly as declared',
    () => {
      const diagnostics = diagnoseCached(PHASE1_PARSING_CASES);
      diagnostics.forEach((diag, index) => {
        const spec = PHASE1_PARSING_CASES[index];
        if (spec.expectLiveGrams !== undefined) {
          expect(diag.liveGrams, spec.line).toBeCloseTo(spec.expectLiveGrams, 6);
          if (spec.expectMassSource !== undefined) {
            expect(diag.liveMassSource, spec.line).toBe(spec.expectMassSource);
          }
          expect(['direct_mass', 'source_portion', 'count_portion'], spec.line).toContain(diag.liveMassSource);
        }
        if (spec.expectLiveStatus !== undefined) {
          expect(diag.liveStatus, spec.line).toBe(spec.expectLiveStatus);
        }
      });
    },
    60000
  );

  it(
    'binds newly canonicalized household count units only through authenticated USDA portions',
    () => {
      // `3 garlic cloves` (noun after the food) drives the count requirement from
      // the recipe's own text: the authenticated clove portions bind with no
      // hint, and every candidate is an authenticated USDA portion (gram weight
      // comes from the bundle, never from the parser).
      const review = session.reviewCountPortions('3 garlic cloves', 169230);
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.review.applicable).toBe(true);
      expect(review.review.requirement).toEqual({ amount: 3, unit: 'clove', size: null });
      expect(review.review.candidates.length).toBeGreaterThan(0);
      for (const candidate of review.review.candidates) {
        expect(candidate.unit).toBe('clove');
        expect(candidate.gram_weight).toBeGreaterThan(0);
      }
      // A unit with no authenticated portion on the bound food stays unresolved.
      const celery = session.reviewCountPortions('2 celery stalks', 169988);
      expect(celery.ok).toBe(true);
      if (!celery.ok) return;
      expect(celery.review.candidates).toHaveLength(0);
    },
    60000
  );

  it(
    'keeps the Phase 0A secondary-component veto intact through range/container cleanup',
    () => {
      // `1 (15 oz) can tomato sauce` must still never bind sardine/fish/eggplant.
      const diag = diagnoseCached(PHASE1_PARSING_CASES).find(
        (entry) => entry.line === '1 (15 oz) can tomato sauce'
      );
      expect(diag).toBeDefined();
      for (const description of diag?.automaticDescriptions ?? []) {
        expect(description).not.toMatch(/sardine|fish|eggplant/i);
      }
      expect(diag?.liveGrams).toBeNull();
    },
    60000
  );

  it(
    'is content-identical on repeated runs and bounded',
    () => {
      const started = Date.now();
      const first = diagnose(PHASE1_PARSING_CASES);
      const second = diagnose(PHASE1_PARSING_CASES);
      const elapsed = Date.now() - started;
      expect(second).toEqual(first);
      expect(first).toHaveLength(PHASE1_PARSING_CASES.length);
      expect(elapsed).toBeLessThan(120000);
    },
    60000
  );
});
