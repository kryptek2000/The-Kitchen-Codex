/**
 * The Kitchen Codex — Advanced Nutrition Phase 0A: real-ingredient identity
 * safety corpus harness.
 *
 * Runs the checked-in identity corpus against the REAL pinned USDA bundle and
 * asserts explicit safety invariants:
 *   - incorrect automatic identities = 0;
 *   - the confirmed secondary-component defect (`canned tomato sauce` ->
 *     sardine) never recurs;
 *   - known-correct automatic identities are unchanged;
 *   - candidate ORDER for lines this slice must not touch is unchanged;
 *   - repeated runs are content-identical and bounded.
 *
 * Status counts are diagnostics, not frozen approvals: known-issue lines only
 * forbid a NEW automatic identity, they do not bless the current one.
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
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4';
import {
  IDENTITY_SAFETY_LINES,
  type IdentityCorpusLine,
} from '../fixtures/advancedNutritionIdentityCorpus';

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
  readonly category: string;
  readonly reviewOutcome: string;
  readonly autoFdc: number | null;
  readonly bestFdc: number | null;
  readonly topFdc: number | null;
  readonly topDescription: string | null;
  readonly candidateFdcs: ReadonlyArray<number>;
  readonly candidateDescriptions: ReadonlyArray<string>;
  readonly analyzerStatus: string;
  readonly analyzerSelectedFdc: number | null;
  readonly previewOutcome: string | null;
  readonly previewGrams: number | null;
  readonly previewMassSource: string | null;
  readonly liveStatus: string;
  readonly liveGrams: number | null;
  readonly qualitative: boolean;
}

interface CorDialRun {
  readonly diagnostics: ReadonlyArray<LineDiagnostic>;
  readonly descriptions: ReadonlyMap<number, string>;
}

function diagnose(lines: ReadonlyArray<IdentityCorpusLine>): CorDialRun {
  const adaptation = adaptRecipe({
    title: 'Identity Safety Corpus',
    servings: 4,
    ingredients: lines.map((spec) => structuredLine(spec.line)),
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

  const diagnostics = lines.map((spec, index) => {
    const row = rows[index];
    const review = row.review as never;
    const auto = selectAutomaticMatch(review);
    const best = selectBestEffortMatch(review);
    const analyzer = analysis.rows[index];
    const evidence = analysis.preview?.ingredients[index];
    const live = liveRows[index];
    return Object.freeze({
      line: spec.line,
      category: spec.category,
      reviewOutcome: row.outcome,
      autoFdc: auto?.fdc_id ?? null,
      bestFdc: best?.fdc_id ?? null,
      topFdc: row.candidates[0]?.fdc_id ?? null,
      topDescription: row.candidates[0]?.description ?? null,
      candidateFdcs: Object.freeze(row.candidates.map((candidate) => candidate.fdc_id)),
      candidateDescriptions: Object.freeze(row.candidates.map((candidate) => candidate.description)),
      analyzerStatus: analyzer.status,
      analyzerSelectedFdc: analyzer.selected_fdc_id ?? null,
      previewOutcome: evidence?.outcome ?? null,
      previewGrams: evidence?.resolved_grams ?? null,
      previewMassSource: evidence?.mass_source ?? null,
      liveStatus: live.status,
      liveGrams: live.resolved_grams ?? null,
      qualitative: live.status === 'qualitative',
    });
  });

  return { diagnostics: Object.freeze(diagnostics), descriptions };
}

/** The automatic paths that may bind an authoritative identity for a line. */
type AutomaticPathField = 'autoFdc' | 'bestFdc' | 'analyzerSelectedFdc';

const AUTOMATIC_PATH_FIELDS: ReadonlyArray<AutomaticPathField> = [
  'autoFdc',
  'bestFdc',
  'analyzerSelectedFdc',
];

type AutomaticPathDiagnostics = Pick<LineDiagnostic, AutomaticPathField>;

/**
 * Baseline identity contract for a line declaring `baselineAutoFdc`.
 *
 * The declared baseline may persist on any automatic path, and automatic
 * authority may be safely withheld on any path (`null`), but no automatic path
 * may silently bind a DIFFERENT identity. This is deliberately NOT an assertion
 * that the current baseline identity is correct: only a different non-null FDC
 * is a violation. A later safety repair must explicitly review and update the
 * corpus before a different automatic identity can become the baseline.
 */
function baselineIdentityViolations(
  spec: IdentityCorpusLine,
  diag: AutomaticPathDiagnostics,
  fields: ReadonlyArray<AutomaticPathField> = AUTOMATIC_PATH_FIELDS
): string[] {
  if (spec.baselineAutoFdc === undefined) return [];
  const violations: string[] = [];
  for (const field of fields) {
    const actual = diag[field];
    if (actual !== null && actual !== spec.baselineAutoFdc) {
      violations.push(
        `${spec.line}: ${field} is ${actual} but baselineAutoFdc is ${spec.baselineAutoFdc}`
      );
    }
  }
  return violations;
}

/** One bounded bundle pass: the corpus diagnostic is deterministic and read-only, so
 * repeated calls in separate tests reuse it (the repeated-run determinism test
 * deliberately calls `diagnose` directly). */
let cachedCorpusRun: CorDialRun | undefined;
function diagnoseCached(): CorDialRun {
  cachedCorpusRun ??= diagnose(IDENTITY_SAFETY_LINES);
  return cachedCorpusRun;
}

describe('identity safety corpus — automatic-identity invariants', () => {
  it(
    'zero incorrect automatic identities across the corpus',
    () => {
      const { diagnostics, descriptions } = diagnoseCached();
      const violations: string[] = [];
      const expectedMismatches: string[] = [];

      diagnostics.forEach((diag, index) => {
        const spec = IDENTITY_SAFETY_LINES[index];
        const automaticDescriptions = [diag.autoFdc, diag.bestFdc, diag.analyzerSelectedFdc]
          .filter((fdc): fdc is number => fdc !== null)
          .map((fdc) => descriptions.get(fdc) ?? '');

        for (const forbiddenFdc of spec.forbiddenAutoFdcs ?? []) {
          if (diag.autoFdc === forbiddenFdc) {
            violations.push(`${spec.line}: strict auto bound forbidden FDC ${forbiddenFdc}`);
          }
          if (diag.analyzerSelectedFdc === forbiddenFdc) {
            violations.push(`${spec.line}: pipeline bound forbidden FDC ${forbiddenFdc}`);
          }
        }

        if (spec.forbiddenAutoDescription !== undefined) {
          for (const description of automaticDescriptions) {
            if (spec.forbiddenAutoDescription.test(description)) {
              violations.push(`${spec.line}: automatic identity matched ${spec.forbiddenAutoDescription}: ${description}`);
            }
          }
        }

        if (spec.expectNoAutomatic === true) {
          if (diag.autoFdc !== null) violations.push(`${spec.line}: unexpected strict automatic FDC ${diag.autoFdc}`);
          if (diag.bestFdc !== null) violations.push(`${spec.line}: unexpected best-effort FDC ${diag.bestFdc}`);
          if (diag.analyzerSelectedFdc !== null) {
            violations.push(`${spec.line}: unexpected pipeline-selected FDC ${diag.analyzerSelectedFdc}`);
          }
        }

        if (spec.expectedAutoFdc !== undefined) {
          if (diag.analyzerSelectedFdc !== spec.expectedAutoFdc) {
            expectedMismatches.push(
              `${spec.line}: pipeline auto ${diag.analyzerSelectedFdc ?? 'none'} != expected ${spec.expectedAutoFdc}`
            );
          }
        }

        if (spec.baselineAutoFdc !== undefined) {
          violations.push(...baselineIdentityViolations(spec, diag));
        }

        if (spec.expectQualitative === true && !diag.qualitative) {
          violations.push(`${spec.line}: expected qualitative, got ${diag.liveStatus}`);
        }
      });

      expect(violations).toEqual([]);
      expect(expectedMismatches).toEqual([]);
    },
    120000
  );

  it(
    'baseline identity contract is mutation-sensitive on every automatic path',
    () => {
      const { diagnostics } = diagnoseCached();
      const baselineRows = IDENTITY_SAFETY_LINES.map((spec, index) => ({
        spec,
        diag: diagnostics[index],
      })).filter(({ spec }) => spec.baselineAutoFdc !== undefined);

      expect(baselineRows.length).toBeGreaterThan(0);

      for (const { spec, diag } of baselineRows) {
        const baseline = spec.baselineAutoFdc as number;

        // The untouched real run satisfies the repaired contract (the declared
        // baseline or a safely withheld `null` on every automatic path).
        expect(baselineIdentityViolations(spec, diag)).toEqual([]);

        // The declared baseline remains valid on all three paths ...
        expect(
          baselineIdentityViolations(spec, {
            autoFdc: baseline,
            bestFdc: baseline,
            analyzerSelectedFdc: baseline,
          })
        ).toEqual([]);

        // ... a safely withheld authority (`null`) remains valid ...
        expect(
          baselineIdentityViolations(spec, {
            autoFdc: null,
            bestFdc: null,
            analyzerSelectedFdc: null,
          })
        ).toEqual([]);

        // ... and a DIFFERENT identity on any single path is rejected.
        for (const field of AUTOMATIC_PATH_FIELDS) {
          const corrupted = {
            autoFdc: field === 'autoFdc' ? baseline + 1 : diag.autoFdc,
            bestFdc: field === 'bestFdc' ? baseline + 1 : diag.bestFdc,
            analyzerSelectedFdc:
              field === 'analyzerSelectedFdc' ? baseline + 1 : diag.analyzerSelectedFdc,
          };
          const fieldViolations = baselineIdentityViolations(spec, corrupted, [field]);
          expect(
            fieldViolations,
            `${spec.line}: a different ${field} must fail the baseline contract`
          ).toHaveLength(1);
          expect(fieldViolations[0]).toContain(spec.line);
          expect(fieldViolations[0]).toContain(field);
          expect(fieldViolations[0]).toContain(String(baseline));
          expect(fieldViolations[0]).toContain(String(baseline + 1));
        }
      }
    },
    60000
  );

  it(
    'preserves legitimate primary-food candidates and untouched candidate order',
    () => {
      const { diagnostics } = diagnoseCached();
      diagnostics.forEach((diag, index) => {
        const spec = IDENTITY_SAFETY_LINES[index];
        if (spec.expectCandidateDescription !== undefined) {
          const visible = [...diag.candidateDescriptions];
          if (diag.topDescription !== null) visible.push(diag.topDescription);
          expect(
            visible.some((description) => spec.expectCandidateDescription?.test(description)),
            `${spec.line}: no candidate matched ${spec.expectCandidateDescription}`
          ).toBe(true);
        }
        if (spec.expectTopFdc !== undefined) {
          expect(diag.topFdc, `${spec.line}: top candidate changed`).toBe(spec.expectTopFdc);
        }
      });
    },
    60000
  );

  it(
    'confirmed regression: `canned tomato sauce` binds only the plain tomato product and never the sardine record',
    () => {
      const { diagnostics, descriptions } = diagnoseCached();
      const diag = diagnostics[IDENTITY_SAFETY_LINES.findIndex((spec) => spec.line === 'canned tomato sauce')];
      expect(diag).toBeDefined();
      // Phase 3 plain-before-specialty: the plain canned tomato product wins and
      // is safe to authorize; every fish/sardine/dish description stays forbidden.
      expect(diag.autoFdc).toBe(170054);
      expect(diag.bestFdc).toBe(170054);
      expect(diag.analyzerSelectedFdc).toBe(170054);
      for (const fdc of [diag.autoFdc, diag.bestFdc, diag.analyzerSelectedFdc, diag.topFdc]) {
        if (fdc === null) continue;
        expect(descriptions.get(fdc) ?? '').not.toMatch(/sardine|fish|spaghetti|eggplant/i);
      }
      expect(diag.previewGrams).toBeNull();
      expect(diag.liveGrams).toBeNull();
    },
    30000
  );

  it(
    '`3 cans tomato sauce` binds the plain tomato product, invents no mass, and never binds fish',
    () => {
      const { diagnostics, descriptions } = diagnoseCached();
      const diag = diagnostics[IDENTITY_SAFETY_LINES.findIndex((spec) => spec.line === '3 cans tomato sauce')];
      expect(diag).toBeDefined();
      // Phase 3: the plain canned tomato product wins; nothing fish/dish-like.
      expect(diag.autoFdc).toBe(170054);
      expect(diag.analyzerSelectedFdc).toBe(170054);
      for (const fdc of [diag.autoFdc, diag.bestFdc, diag.analyzerSelectedFdc]) {
        if (fdc === null) continue;
        expect(descriptions.get(fdc) ?? '').not.toMatch(/sardine|fish|eggplant/i);
      }
      // Package count is not mass authority; no grams are invented.
      expect(diag.previewGrams).toBeNull();
      expect(diag.liveGrams).toBeNull();
    },
    30000
  );

  it(
    '`8 oz spaghetti` keeps its direct recipe mass untouched',
    () => {
      const { diagnostics } = diagnoseCached();
      const diag = diagnostics[IDENTITY_SAFETY_LINES.findIndex((spec) => spec.line === '8 oz spaghetti')];
      expect(diag).toBeDefined();
      expect(diag.liveGrams).toBeCloseTo(226.796185, 3);
    },
    30000
  );

  it(
    'is content-identical on repeated runs and bounded',
    () => {
      const started = Date.now();
      const first = diagnose(IDENTITY_SAFETY_LINES);
      const second = diagnose(IDENTITY_SAFETY_LINES);
      const elapsed = Date.now() - started;
      expect(second.diagnostics).toEqual(first.diagnostics);
      expect(first.diagnostics).toHaveLength(IDENTITY_SAFETY_LINES.length);
      expect(elapsed).toBeLessThan(120000);
    },
    180000
  );
});
