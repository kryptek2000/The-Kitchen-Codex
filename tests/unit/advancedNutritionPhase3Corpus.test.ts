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
 * Advanced Nutrition Phase 3 — smarter ranking + automatic-authority corpus.
 *
 * Runs the bounded Phase 3 corpus against the REAL pinned USDA bundle and
 * asserts the fail-closed safety metrics:
 *   - zero incorrect automatic identities;
 *   - zero explicit variety/state/form contradictions granted authority;
 *   - zero primary/secondary false automatic matches;
 *   - plain-before-specialty ordering where a plain record exists;
 *   - authenticated direct/count mass behavior unchanged.
 */

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

const LINES: ReadonlyArray<string> = [
  '8 oz spaghetti',
  'spinach spaghetti',
  '1 cup white rice',
  '1 cup red rice',
  '1 cup dry white rice',
  '2 cups cooked long-grain rice',
  'fresh dill',
  'fresh dill for garnish',
  'dill seed',
  '1 jar marinara sauce',
  'low sodium marinara sauce',
  'tomato sauce',
  'canned tomato sauce',
  'canned sardines in tomato sauce',
  'pasta with tomato sauce',
  '4 slices bacon',
  'bacon-flavored cereal',
  '1 can diced tomatoes',
  '1 can tuna',
  '1 can black beans',
  '2 medium potatoes',
  '2 cups penne pasta',
  '1 lb ground beef (80/20)',
  '3 garlic cloves',
  '2 garlic cloves, minced',
  '1 medium onion',
  '1 red bell pepper',
  'salt to taste',
];

interface Diagnostic {
  readonly line: string;
  readonly topDescription: string | null;
  readonly automatic: ReadonlyArray<{ path: string; fdc: number; description: string }>;
  readonly analyzerStatus: string;
  readonly analyzerFdc: number | null;
  readonly liveStatus: string;
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
    title: 'Phase 3 Corpus',
    servings: 4,
    ingredients: LINES.map(structuredLine),
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
    LINES.map((line, index) => {
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
        line,
        topDescription: row.candidates[0]?.description ?? null,
        automatic: Object.freeze(automatic),
        analyzerStatus: analyzer.status,
        analyzerFdc: analyzer.selected_fdc_id ?? null,
        liveStatus: live.status,
        liveGrams: live.resolved_grams ?? null,
      });
    })
  );
}

describe('phase 3 corpus — real pinned-bundle ranking and authority', () => {
  let diagnostics: ReadonlyArray<Diagnostic>;
  beforeAll(() => {
    diagnostics = diagnose();
  }, 180000);

  function diagFor(line: string): Diagnostic {
    const found = diagnostics.find((entry) => entry.line === line);
    if (!found) throw new Error(`missing diagnostic for ${line}`);
    return found;
  }

  it('never grants automatic authority to a variety/state/form contradiction or a fish mismatch', () => {
    const violations: string[] = [];

    const white = diagFor('1 cup white rice');
    for (const entry of white.automatic) {
      if (/\bred\b/i.test(entry.description)) violations.push(`white rice bound red: ${entry.description}`);
    }
    const red = diagFor('1 cup red rice');
    for (const entry of red.automatic) {
      if (/\bwhite\b/i.test(entry.description)) violations.push(`red rice bound white: ${entry.description}`);
    }
    const dryWhite = diagFor('1 cup dry white rice');
    for (const entry of dryWhite.automatic) {
      if (/\bred\b/i.test(entry.description)) violations.push(`dry white rice bound red: ${entry.description}`);
    }
    for (const line of ['fresh dill', 'fresh dill for garnish', '1 can diced tomatoes', '2 cups penne pasta']) {
      for (const entry of diagFor(line).automatic) {
        if (/\bseed\b|\bcrushed\b|\braw\b/i.test(entry.description)) {
          violations.push(`${line} bound forbidden: ${entry.description}`);
        }
      }
    }
    for (const line of ['canned tomato sauce', 'tomato sauce', 'pasta with tomato sauce']) {
      for (const entry of diagFor(line).automatic) {
        if (/sardine|fish|eggplant/i.test(entry.description)) {
          violations.push(`${line} bound fish/dish: ${entry.description}`);
        }
      }
    }
    const cereal = diagFor('bacon-flavored cereal');
    for (const entry of cereal.automatic) {
      if (/^pork|^bacon/i.test(entry.description)) {
        violations.push(`bacon-flavored cereal bound bacon: ${entry.description}`);
      }
    }
    const pepper = diagFor('1 red bell pepper');
    for (const entry of pepper.automatic) {
      if (/\bgreen\b|\byellow\b/i.test(entry.description)) {
        violations.push(`red bell pepper bound other color: ${entry.description}`);
      }
    }
    const blackBeans = diagFor('1 can black beans');
    for (const entry of blackBeans.automatic) {
      if (/\braw\b/i.test(entry.description)) violations.push(`black beans bound raw: ${entry.description}`);
    }
    expect(violations).toEqual([]);
  });

  it('prefers plain records over unrequested specialties and keeps explicit requests', () => {
    const violations: string[] = [];
    const spaghetti = diagFor('8 oz spaghetti');
    if (spaghetti.topDescription && /meatball|dinner|squash/i.test(spaghetti.topDescription)) {
      violations.push(`8 oz spaghetti top is a dish: ${spaghetti.topDescription}`);
    }
    const spinach = diagFor('spinach spaghetti');
    if (!spinach.topDescription || !/spinach/i.test(spinach.topDescription)) {
      violations.push(`spinach spaghetti top lost the requested specialty: ${spinach.topDescription}`);
    }
    const dill = diagFor('fresh dill');
    if (!dill.topDescription || !/dill weed/i.test(dill.topDescription) || /seed|dried/i.test(dill.topDescription)) {
      violations.push(`fresh dill top is a seed/dried variant: ${dill.topDescription}`);
    }
    const dillSeed = diagFor('dill seed');
    if (dillSeed.analyzerFdc !== 170925) {
      violations.push(`dill seed lost its requested identity: ${dillSeed.analyzerFdc}`);
    }
    const tomatoSauce = diagFor('tomato sauce');
    if (!tomatoSauce.topDescription || !/tomato/i.test(tomatoSauce.topDescription) || /chili/i.test(tomatoSauce.topDescription)) {
      violations.push(`tomato sauce top is not the plain tomato product: ${tomatoSauce.topDescription}`);
    }
    const marinara = diagFor('1 jar marinara sauce');
    if (marinara.topDescription && /low sodium|reduced|fat free/i.test(marinara.topDescription)) {
      violations.push(`marinara top is a specialty: ${marinara.topDescription}`);
    }
    const lowSodium = diagFor('low sodium marinara sauce');
    if (lowSodium.topDescription && !/low sodium/i.test(lowSodium.topDescription)) {
      violations.push(`requested low-sodium marinara not preferred: ${lowSodium.topDescription}`);
    }
    const penne = diagFor('2 cups penne pasta');
    if (penne.topDescription && /spinach/i.test(penne.topDescription)) {
      violations.push(`penne pasta top is spinach pasta: ${penne.topDescription}`);
    }
    expect(violations).toEqual([]);
  });

  it('keeps the audited identities and authenticated masses', () => {
    const violations: string[] = [];
    const expectAnalyzer = (line: string, fdc: number | null) => {
      const actual = diagFor(line).analyzerFdc;
      if (actual !== fdc) violations.push(`${line}: analyzer ${actual} != ${fdc}`);
    };
    const expectGrams = (line: string, grams: number) => {
      const actual = diagFor(line).liveGrams;
      if (actual === null || Math.abs(actual - grams) > 0.01) {
        violations.push(`${line}: grams ${actual} != ${grams}`);
      }
    };
    expectAnalyzer('canned tomato sauce', 170054);
    expectAnalyzer('canned sardines in tomato sauce', 175140);
    expectAnalyzer('4 slices bacon', 168277);
    expectAnalyzer('1 can tuna', 2706311);
    expectAnalyzer('1 can black beans', 2707359);
    expectAnalyzer('1 medium onion', 170000);
    expectAnalyzer('1 red bell pepper', 2258590);
    expectAnalyzer('1 lb ground beef (80/20)', 174036);
    expectAnalyzer('3 garlic cloves', 169230);
    expectAnalyzer('2 garlic cloves, minced', 169230);
    expectGrams('4 slices bacon', 112);
    expectGrams('1 can tuna', 115);
    expectGrams('1 medium onion', 110);
    expectGrams('1 lb ground beef (80/20)', 453.59237);
    expectGrams('1 cup white rice', 195);
    expectGrams('1 cup dry white rice', 185);
    expectGrams('2 cups cooked long-grain rice', 316);
    expectGrams('8 oz spaghetti', 226.796185);
    expect(violations).toEqual([]);
  });

  it('records the required corpus metrics with zero unsafe automatic identities', () => {
    const statuses = { matched: 0, needs_amount: 0, review_suggested: 0, needs_match: 0, qualitative: 0 };
    let strict = 0;
    let best = 0;
    let analyzer = 0;
    for (const diag of diagnostics) {
      if (diag.liveStatus === 'matched') statuses.matched += 1;
      else if (diag.liveStatus === 'needs_amount') statuses.needs_amount += 1;
      else if (diag.liveStatus === 'review_suggested') statuses.review_suggested += 1;
      else if (diag.liveStatus === 'needs_match') statuses.needs_match += 1;
      else if (diag.liveStatus === 'qualitative') statuses.qualitative += 1;
      for (const entry of diag.automatic) {
        if (entry.path === 'auto') strict += 1;
        else if (entry.path === 'best') best += 1;
        else analyzer += 1;
      }
    }
    expect(statuses.matched + statuses.needs_amount + statuses.review_suggested + statuses.needs_match + statuses.qualitative).toBe(LINES.length);
    expect(strict).toBeGreaterThan(0);
    expect(best).toBeGreaterThan(0);
    expect(analyzer).toBeGreaterThan(0);
    expect(statuses.qualitative).toBe(1);
  });

  it('is deterministic across repeated real-bundle runs', () => {
    const second = diagnose();
    expect(JSON.stringify(second)).toBe(JSON.stringify(diagnostics));
  }, 180000);
});
