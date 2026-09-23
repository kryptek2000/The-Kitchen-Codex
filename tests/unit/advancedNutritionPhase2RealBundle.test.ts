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

/**
 * Advanced Nutrition Phase 2 — real pinned-bundle projection corpus.
 *
 * Proves the projection/state changes against the REAL pinned USDA bundle:
 *   - no automatic path binds a record that explicitly contradicts an explicit
 *     or container-implied state;
 *   - the Phase 0A secondary-component guarantees still hold;
 *   - bacon count mass, direct mass, and range truthfulness are unchanged;
 *   - cooked and dry rice stay distinct.
 */

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

interface Case {
  readonly line: string;
  /** No automatic path may bind a description matching this. */
  readonly forbiddenAutomaticDescription?: RegExp;
  /** When a pipeline identity is selected, its description must match this. */
  readonly expectAnalyzerDescription?: RegExp;
  readonly expectedLiveGrams?: number;
  readonly expectNoGrams?: boolean;
  /** No automatic path (strict, best-effort, analyzer) may bind any identity. */
  readonly expectNoAutomatic?: boolean;
}

const CASES: ReadonlyArray<Case> = [
  // --- must remain safe ------------------------------------------------------
  { line: 'canned tomato sauce', forbiddenAutomaticDescription: /sardine|fish|eggplant/i },
  { line: 'canned sardines in tomato sauce', expectAnalyzerDescription: /sardine/i },
  { line: 'tomato sauce', forbiddenAutomaticDescription: /sardine|fish/i },
  { line: '4 slices bacon', expectAnalyzerDescription: /bacon/i, expectedLiveGrams: 112 },
  { line: '8 slices bacon', expectAnalyzerDescription: /bacon/i, expectedLiveGrams: 224 },
  { line: 'bacon-flavored cereal', forbiddenAutomaticDescription: /^bacon\b/i },
  { line: '1 cup dry white rice', forbiddenAutomaticDescription: /\bcooked\b/i, expectedLiveGrams: 185 },
  {
    line: '2 cups cooked long-grain rice (cooled)',
    forbiddenAutomaticDescription: /\b(dry|uncooked|raw)\b/i,
    expectedLiveGrams: 316,
  },
  {
    line: '1 lb ground beef (80/20)',
    expectAnalyzerDescription: /80% lean/i,
    expectedLiveGrams: 453.59237,
  },
  { line: '2 to 3 cloves garlic', expectNoGrams: true },
  { line: '1 (15 oz) can tomato sauce', forbiddenAutomaticDescription: /sardine|fish|eggplant/i },
  { line: '2 tins beans', expectAnalyzerDescription: /beans/i },
  // --- state-sensitive targets ----------------------------------------------
  {
    line: '1 can diced tomatoes',
    forbiddenAutomaticDescription: /\b(raw|crushed)\b/i,
    expectNoAutomatic: true,
    expectNoGrams: true,
  },
  {
    line: '2 (14.5 oz) cans diced tomatoes',
    forbiddenAutomaticDescription: /\b(raw|crushed)\b/i,
    expectNoAutomatic: true,
    expectNoGrams: true,
  },
  // Same explicit form stays legitimate.
  { line: '1 can crushed tomatoes', expectAnalyzerDescription: /crushed/i },
  // A different explicit cut form must never be substituted automatically.
  {
    line: '1 can sliced mushrooms',
    forbiddenAutomaticDescription: /\b(whole|chopped|minced|crushed)\b/i,
    expectNoAutomatic: true,
  },
  { line: '1 can black beans', forbiddenAutomaticDescription: /\braw\b/i },
  {
    line: '1 can tuna',
    forbiddenAutomaticDescription: /\b(raw|fresh)\b/i,
    expectAnalyzerDescription: /tuna/i,
  },
  { line: 'fresh dill', forbiddenAutomaticDescription: /\b(dried|dehydrated)\b/i },
  { line: 'dried thyme', forbiddenAutomaticDescription: /\bfresh\b/i, expectAnalyzerDescription: /dried/i },
  {
    line: 'cooked rice',
    forbiddenAutomaticDescription: /\b(dry|uncooked|raw)\b/i,
    expectAnalyzerDescription: /cooked/i,
  },
  { line: 'dry rice', forbiddenAutomaticDescription: /\bcooked\b/i },
  { line: 'ground almonds', forbiddenAutomaticDescription: /\bwhole\b/i },
  { line: 'whole almonds', expectAnalyzerDescription: /whole/i },
  { line: 'drained tuna', forbiddenAutomaticDescription: /\bundrained\b/i },
  { line: 'undrained tomatoes', forbiddenAutomaticDescription: /\bdrained\b/i },
  { line: 'frozen strawberries', forbiddenAutomaticDescription: /\braw\b/i, expectAnalyzerDescription: /frozen/i },
  { line: 'fresh strawberries', forbiddenAutomaticDescription: /\b(frozen|dried)\b/i },
];

interface Diagnostic {
  readonly line: string;
  readonly automaticDescriptions: ReadonlyArray<{ path: string; fdc: number; description: string }>;
  readonly analyzerStatus: string;
  readonly analyzerFdc: number | null;
  readonly liveGrams: number | null;
}

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

function diagnose(): ReadonlyArray<Diagnostic> {
  const adaptation = adaptRecipe({
    title: 'Phase 2 Projection Corpus',
    servings: 4,
    ingredients: CASES.map((spec) => structuredLine(spec.line)),
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

  return Object.freeze(
    CASES.map((spec, index) => {
      const row = rows[index];
      const review = row.review as never;
      const auto = selectAutomaticMatch(review);
      const best = selectBestEffortMatch(review);
      const analyzer = analysis.rows[index];
      const live = liveRows[index];
      const automatic: Array<{ path: string; fdc: number; description: string }> = [];
      if (auto) automatic.push({ path: 'auto', fdc: auto.fdc_id, description: descriptions.get(auto.fdc_id) ?? '' });
      if (best) automatic.push({ path: 'best', fdc: best.fdc_id, description: descriptions.get(best.fdc_id) ?? '' });
      if (analyzer.selected_fdc_id !== undefined && analyzer.selected_fdc_id !== null) {
        automatic.push({
          path: 'analyzer',
          fdc: analyzer.selected_fdc_id,
          description: descriptions.get(analyzer.selected_fdc_id) ?? '',
        });
      }
      return Object.freeze({
        line: spec.line,
        automaticDescriptions: Object.freeze(automatic),
        analyzerStatus: analyzer.status,
        analyzerFdc: analyzer.selected_fdc_id ?? null,
        liveGrams: live.resolved_grams ?? null,
      });
    })
  );
}

describe('phase 2 projection — real pinned-bundle corpus', () => {
  let diagnostics: ReadonlyArray<Diagnostic>;
  beforeAll(() => {
    diagnostics = diagnose();
  }, 180000);

  it('never binds a state-contradicting (or otherwise forbidden) automatic identity', () => {
    const violations: string[] = [];
    diagnostics.forEach((diag, index) => {
      const spec = CASES[index];
      if (spec.forbiddenAutomaticDescription) {
        for (const entry of diag.automaticDescriptions) {
          if (spec.forbiddenAutomaticDescription.test(entry.description)) {
            violations.push(
              `${spec.line}: ${entry.path} bound ${entry.fdc} "${entry.description}" matching ${spec.forbiddenAutomaticDescription}`
            );
          }
        }
      }
      if (spec.expectNoAutomatic === true) {
        for (const entry of diag.automaticDescriptions) {
          violations.push(
            `${spec.line}: expected no automatic identity, but ${entry.path} bound ${entry.fdc} "${entry.description}"`
          );
        }
        if (diag.liveGrams !== null) {
          violations.push(`${spec.line}: expected no automatic grams, got ${diag.liveGrams}`);
        }
      }
    });
    expect(violations).toEqual([]);
  });

  it('keeps the reviewed pipeline identities and authenticated grams', () => {
    const violations: string[] = [];
    diagnostics.forEach((diag, index) => {
      const spec = CASES[index];
      if (spec.expectAnalyzerDescription) {
        const entry = diag.automaticDescriptions.find((candidate) => candidate.path === 'analyzer');
        if (!entry) {
          violations.push(`${spec.line}: expected a pipeline identity matching ${spec.expectAnalyzerDescription}, got none (${diag.analyzerStatus})`);
        } else if (!spec.expectAnalyzerDescription.test(entry.description)) {
          violations.push(
            `${spec.line}: pipeline identity ${entry.fdc} "${entry.description}" does not match ${spec.expectAnalyzerDescription}`
          );
        }
      }
      if (spec.expectedLiveGrams !== undefined) {
        if (diag.liveGrams === null || Math.abs(diag.liveGrams - spec.expectedLiveGrams) > 0.01) {
          violations.push(`${spec.line}: live grams ${diag.liveGrams} != ${spec.expectedLiveGrams}`);
        }
      }
      if (spec.expectNoGrams === true && diag.liveGrams !== null) {
        violations.push(`${spec.line}: expected no grams, got ${diag.liveGrams}`);
      }
    });
    expect(violations).toEqual([]);
  });

  it('is deterministic across repeated real-bundle runs', () => {
    const second = diagnose();
    expect(JSON.stringify(second)).toBe(JSON.stringify(diagnostics));
  }, 180000);
});
