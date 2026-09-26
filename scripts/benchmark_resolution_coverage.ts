/**
 * The Kitchen Codex — Advanced Nutrition resolution-coverage benchmark.
 *
 * Runs the REAL pinned USDA bundle and the REAL Phase 4 pipeline (parse ->
 * review -> analyzer -> calculation -> live projection) over the checked-in
 * resolution corpus and reports, per ingredient line, the terminal resolution
 * state and (for unresolved lines) a bounded failure reason.
 *
 * Usage:
 *   bun x tsx scripts/benchmark_resolution_coverage.ts
 *   bun x tsx scripts/benchmark_resolution_coverage.ts --json /tmp/after.json
 *
 * This is a MEASUREMENT tool: it changes no production behavior and is not
 * imported by any production module.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../src/core/nutritionV2/matching/parse';
import { candidatePortionCompatibility } from '../src/core/nutritionV2/calculation/portionSemantics';
import { adaptRecipe } from '../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../src/core/nutritionV2/phase4/types';
import { projectLiveRows } from '../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../src/core/nutritionV2/phase4/display';
import type { AdvancedNutritionSession } from '../src/core/nutritionV2/phase4/types';
import {
  formatAiAdvancedBenchmarkReport,
  summarizeAiAdvancedBenchmark,
  type AiAdvancedBenchmarkEntry,
} from '../src/core/nutritionV2/aiAdvancedBenchmark';
import { RESOLUTION_COVERAGE_CORPUS } from '../tests/fixtures/advancedNutritionResolutionCorpus';

const ROOT = resolve(import.meta.dirname, '..');
const BUNDLE_DIR = join(
  ROOT,
  'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

type Terminal =
  | 'resolved_direct_mass'
  | 'resolved_source_portion'
  | 'resolved_count_portion'
  | 'resolved_household_portion'
  | 'needs_amount'
  | 'needs_match'
  | 'review_suggested'
  | 'qualitative'
  | 'unresolved';

interface LineResult {
  readonly line: string;
  readonly focus: string;
  readonly terminal: Terminal;
  readonly reason: string;
  readonly grams?: number;
}

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredient(line);
  if (!parsed.ok) return { original: line };
  const p = parsed.parsed;
  return {
    original: line,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function candidateHasCompatibleMass(
  session: AdvancedNutritionSession,
  ingredient: unknown,
  fdcId: number,
  measurementKind: string
): boolean {
  if (measurementKind === 'mass') return true;
  if (measurementKind === 'volume') {
    const review = session.reviewPortions(fdcId);
    if (!review.ok) return false;
    return review.review.candidates.some(
      (candidate) =>
        candidatePortionCompatibility(candidate, 'volume') === 'compatible' &&
        candidate.kind === 'volume' &&
        candidate.volume_ml !== null &&
        candidate.volume_ml > 0 &&
        candidate.gram_weight > 0
    );
  }
  if (measurementKind === 'count') {
    const review = session.reviewCountPortions(ingredient, fdcId);
    if (!review.ok) return false;
    return review.review.candidates.length > 0;
  }
  return false;
}

function classify(session: AdvancedNutritionSession, line: string, focus: string): LineResult {
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

  const parsed = parseIngredient(structured(line));
  if (!parsed.ok) {
    return { line, focus, terminal: 'unresolved', reason: 'parse_failed' };
  }
  const p = parsed.parsed;
  const measurementKind = p.measurement_kind;

  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) {
    return { line, focus, terminal: 'unresolved', reason: 'adapt_failed' };
  }
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  const analysisRow = analysis.rows[0];

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

  const reasonForUnresolved = (): string => {
    const review = analysisRow.review as { outcome?: string; candidates?: ReadonlyArray<{ fdc_id: number }> } | undefined;
    if (p.quantity_kind === 'range' && p.quantity_range) {
      if (measurementKind === 'mass') return 'mass_range_not_parsed';
      if (measurementKind === 'volume') return 'volume_range_unresolved';
      return 'count_range_unresolved';
    }
    if (measurementKind === 'mass' && typeof p.grams === 'number') {
      return 'direct_mass_unapplied';
    }
    if (p.container !== undefined && p.package_net_mass === undefined) {
      return 'container_mass_absent';
    }
    if (p.container !== undefined && p.package_net_mass !== undefined) {
      // The canonical parse represents the declared package net mass but never
      // converts it into mass authority (deliberate Phase 1 boundary).
      return 'container_net_mass_not_converted';
    }
    if (p.amount === null && p.container === undefined) {
      return 'qualitative_or_absent_amount';
    }
    if (review?.outcome === 'unmatched') return 'identity_unmatched';
    if (review?.outcome === 'invalid') return 'identity_invalid';
    if (review?.outcome === 'review_required') {
      const selected = analysisRow.selected_fdc_id;
      if (selected === undefined) return 'identity_needs_review';
      const selectedHasMass = candidateHasCompatibleMass(session, structured(line), selected, measurementKind);
      if (!selectedHasMass) {
        const alternative = (review.candidates ?? []).some(
          (candidate) =>
            candidate.fdc_id !== selected &&
            candidateHasCompatibleMass(session, structured(line), candidate.fdc_id, measurementKind)
        );
        return alternative
          ? 'compatible_candidate_exists_but_not_selected'
          : measurementKind === 'count'
            ? 'authenticated_count_absent'
            : 'selected_record_lacks_compatible_portion';
      }
      return 'mass_unresolved';
    }
    return 'unresolved_other';
  };

  if (live.status === 'matched' && live.resolved_grams !== undefined) {
    const bySource: Record<string, Terminal> = {
      direct_mass: 'resolved_direct_mass',
      source_portion: 'resolved_source_portion',
      count_portion: 'resolved_count_portion',
      household_portion: 'resolved_household_portion',
    };
    const terminal = live.mass_source ? bySource[live.mass_source] : undefined;
    if (terminal) return { line, focus, terminal, reason: 'resolved', grams: live.resolved_grams };
  }
  const terminal: Terminal =
    live.status === 'qualitative'
      ? 'qualitative'
      : live.status === 'needs_match'
        ? 'needs_match'
        : live.status === 'review_suggested'
          ? 'review_suggested'
          : live.status === 'needs_amount'
            ? 'needs_amount'
            : 'unresolved';
  return { line, focus, terminal, reason: reasonForUnresolved() };
}

async function main(): Promise<void> {
  const jsonIndex = process.argv.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : undefined;

  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!loaded.ok) throw new Error('the real USDA bundle failed to authenticate');
  const session = loaded.session;

  const seen = new Set<string>();
  const results: LineResult[] = [];
  for (const entry of RESOLUTION_COVERAGE_CORPUS) {
    if (seen.has(entry.line)) continue;
    seen.add(entry.line);
    results.push(classify(session, entry.line, entry.focus));
  }

  const count = (predicate: (r: LineResult) => boolean) => results.filter(predicate).length;
  const total = results.length;
  const resolved = count((r) => r.terminal.startsWith('resolved_'));
  const reasons = new Map<string, number>();
  for (const r of results) {
    if (r.terminal.startsWith('resolved_')) continue;
    reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  }
  const topReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]);

  console.log('=== RESOLUTION COVERAGE BENCHMARK ===');
  console.log(`total lines: ${total}`);
  console.log(
    `resolved (auto): ${resolved} (${((resolved / total) * 100).toFixed(1)}%)`
  );
  console.log(`  direct mass: ${count((r) => r.terminal === 'resolved_direct_mass')}`);
  console.log(`  source portion: ${count((r) => r.terminal === 'resolved_source_portion')}`);
  console.log(`  count portion: ${count((r) => r.terminal === 'resolved_count_portion')}`);
  console.log(`  household portion: ${count((r) => r.terminal === 'resolved_household_portion')}`);
  console.log(`needs amount: ${count((r) => r.terminal === 'needs_amount')}`);
  console.log(`needs match: ${count((r) => r.terminal === 'needs_match')}`);
  console.log(`review suggested: ${count((r) => r.terminal === 'review_suggested')}`);
  console.log(`qualitative: ${count((r) => r.terminal === 'qualitative')}`);
  console.log('--- top failure reasons ---');
  for (const [reason, n] of topReasons) console.log(`  ${n}\t${reason}`);
  console.log('--- unresolved lines ---');
  for (const r of results) {
    if (r.terminal.startsWith('resolved_')) continue;
    console.log(`  [${r.terminal}] ${r.reason} :: ${r.line}`);
  }

  // -------------------------------------------------------------------------
  // AI-ADVANCED ACCOUNTING (separate buckets; deterministic score unchanged)
  // -------------------------------------------------------------------------
  // This deterministic run has no AI assistance, so every resolved line lands in
  // `deterministic` and every unresolved line lands in `still_review` (actionable
  // exceptions) or `unresolved` (qualitative/non-actionable). The same module
  // classifies future AI-assisted runs without changing this denominator.
  const benchmarkEntries: AiAdvancedBenchmarkEntry[] = results.map((result) => {
    if (result.terminal.startsWith('resolved_')) {
      const bySource: Record<string, AiAdvancedBenchmarkEntry['mass_source']> = {
        resolved_direct_mass: 'direct_mass',
        resolved_source_portion: 'source_portion',
        resolved_count_portion: 'count_portion',
        resolved_household_portion: 'household_portion',
      };
      return { resolved: true, mass_source: bySource[result.terminal] };
    }
    return {
      resolved: false,
      review_required: result.terminal !== 'qualitative' && result.terminal !== 'unresolved',
    };
  });
  const aiAdvancedSummary = summarizeAiAdvancedBenchmark(benchmarkEntries);
  console.log('--- AI Advanced Nutrition separate accounting ---');
  console.log(formatAiAdvancedBenchmarkReport(aiAdvancedSummary));

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify({ total, resolved, results, topReasons, aiAdvanced: aiAdvancedSummary }, null, 2)
    );
    console.log(`json written: ${jsonPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'benchmark_failed');
  process.exit(1);
});
