/**
 * The Kitchen Codex — AI Advanced Nutrition (AI-0) benchmark foundation.
 *
 * Pins the EXISTING deterministic benchmark denominators/scores (expanded
 * `46/97`; legacy subset `42/91`) on the REAL pinned bundle, and proves the new
 * separate AI-Advanced accounting can report future AI-assisted performance
 * WITHOUT inflating the deterministic score or counting an AI interpretation
 * that the deterministic core did not accept.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import {
  classifyAiAdvancedBenchmarkOutcome,
  formatAiAdvancedBenchmarkReport,
  summarizeAiAdvancedBenchmark,
  type AiAdvancedBenchmarkEntry,
} from '../../src/core/nutritionV2/aiAdvancedBenchmark';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import { RESOLUTION_COVERAGE_CORPUS } from '../fixtures/advancedNutritionResolutionCorpus';

const BUNDLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
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
  if (!result.ok) throw new Error('session failed');
  session = result.session;
}, 180000);

interface DeterministicLineResult {
  readonly line: string;
  readonly focus: string;
  readonly resolved: boolean;
  readonly massSource?: string;
}

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredient(line);
  if (!parsed.ok) return { original: line };
  const p = parsed.parsed as { amount: number | null; raw_unit?: string; query: string };
  return {
    original: line,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function classifyLine(line: string, focus: string): DeterministicLineResult {
  const recipe = {
    id: 'bench',
    fileName: 'bench.md',
    filePath: 'bench.md',
    rawMarkdown: '',
    title: 'bench',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [structured(line)],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as never;
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) return { line, focus, resolved: false };
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows: buildReviewRows(session, adapted),
    baseServings: 1,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  });
  const calc = session.calculate(buildCalculationRequest(adapted, state));
  const live = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    calc.ok ? ingredientEvidenceViews(calc.preview) : null,
    analysis.portions,
    analysis.countPortions
  )[0];
  if (live.status === 'matched' && live.resolved_grams !== undefined && live.mass_source !== undefined) {
    return { line, focus, resolved: true, massSource: live.mass_source };
  }
  return { line, focus, resolved: false };
}

describe('AI-0 benchmark foundation', () => {
  it('keeps the deterministic expanded benchmark at 46/97 and legacy subset at 42/91', () => {
    const seen = new Set<string>();
    const results: DeterministicLineResult[] = [];
    for (const entry of RESOLUTION_COVERAGE_CORPUS) {
      if (seen.has(entry.line)) continue;
      seen.add(entry.line);
      results.push(classifyLine(entry.line, entry.focus));
    }
    const resolved = results.filter((result) => result.resolved).length;
    expect(results.length).toBe(97);
    expect(resolved).toBe(46);

    const legacy = results.filter((result) => result.focus !== 'nutrient_annotation');
    expect(legacy.length).toBe(91);
    expect(legacy.filter((result) => result.resolved).length).toBe(42);
  }, 180000);

  it('reports AI-Advanced buckets separately without inflating resolution credit', () => {
    const deterministic: AiAdvancedBenchmarkEntry[] = [
      { resolved: true, mass_source: 'direct_mass' },
      { resolved: true, mass_source: 'source_portion' },
      { resolved: false, review_required: true },
      { resolved: false },
    ];
    // A future AI-assisted run of the SAME denominator. An interpretation that
    // the deterministic core did not accept stays in `still_review`.
    const aiAssisted: AiAdvancedBenchmarkEntry[] = [
      { resolved: true, mass_source: 'direct_mass' },
      { resolved: true, mass_source: 'source_portion', ai_assisted: true },
      { resolved: true, mass_source: 'household_portion', authority_class: 'bounded_estimate', ai_assisted: true },
      { resolved: false, ai_assisted: true, review_required: true },
    ];
    const deterministicSummary = summarizeAiAdvancedBenchmark(deterministic);
    expect(deterministicSummary.resolved_authenticated).toBe(2);
    expect(deterministicSummary.ai_assisted_bounded_estimate).toBe(0);
    expect(deterministicSummary.still_review).toBe(1);
    expect(deterministicSummary.unresolved).toBe(1);

    const aiSummary = summarizeAiAdvancedBenchmark(aiAssisted);
    expect(aiSummary.deterministic).toBe(1);
    expect(aiSummary.ai_assisted_authenticated).toBe(1);
    expect(aiSummary.ai_assisted_bounded_estimate).toBe(1);
    expect(aiSummary.still_review).toBe(1);
    // Estimates are never counted as authenticated resolutions.
    expect(aiSummary.resolved_authenticated).toBe(2);

    expect(classifyAiAdvancedBenchmarkOutcome({ resolved: false, ai_assisted: true })).toBe(
      'unresolved'
    );
    expect(formatAiAdvancedBenchmarkReport(aiSummary)).toContain('AI-assisted bounded estimate: 1 / 4');
  });
});
