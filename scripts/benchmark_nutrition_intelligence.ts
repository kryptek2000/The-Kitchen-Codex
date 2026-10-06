/**
 * The Kitchen Codex — Advanced Nutrition AI-6A intelligence recon benchmark.
 *
 * Runs the REAL pinned USDA bundle and the REAL production pipeline over the
 * AI-6A recon corpus and reports, per ingredient line, a MULTI-AXIS diagnostic
 * record: parse facts, live terminal state, authenticated mass source, bounded
 * candidates with real portion evidence, identity correctness, one primary
 * blocker, bounded secondary signals, and a planning-only repair lane.
 *
 * Usage:
 *   bun x tsx scripts/benchmark_nutrition_intelligence.ts
 *   bun x tsx scripts/benchmark_nutrition_intelligence.ts --json /tmp/ai6a.json
 *
 * This is a RECONNAISSANCE tool:
 *   - it changes NO production behavior and is imported by NO production module;
 *   - it makes NO network, provider, Gemini, OpenRouter, or AI request;
 *   - it uses NO clock, randomness, user files, or private vault;
 *   - it uses ONLY the checked-in corpus and the pinned USDA bundle;
 *   - its JSON is byte-stable for the same repository state (no timestamp, no
 *     hostname, no absolute repository path, no secrets, no random ids).
 *
 * It does NOT replace `scripts/benchmark_resolution_coverage.ts`. That historical
 * benchmark keeps its own 97-line denominator and its own outcomes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../src/core/nutritionV2/usda/releaseLock';
import { diagnoseCorpus, type Ai6aDiagnosticRecord } from './nutritionIntelligence/diagnose';
import {
  aggregate,
  countNounFailures,
  historicalBaselineCheck,
  rate,
  type Ai6aAggregates,
} from './nutritionIntelligence/summarize';
import {
  AI6A_RECON_SCHEMA,
  AI6A_RECON_TOOL,
  AUTHENTICATED_MASS_SOURCES,
  type Ai6aPrimaryBlocker,
  type Ai6aTerminal,
} from './nutritionIntelligence/taxonomy';
import {
  AI6A_HISTORICAL_SUBSET,
  AI6A_INTELLIGENCE_CORPUS,
  AI6A_LEGACY_SUBSET,
} from '../tests/fixtures/advancedNutritionAi6aIntelligenceCorpus';

const ROOT = resolve(import.meta.dirname, '..');
const BUNDLE_DIR = join(
  ROOT,
  'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

function printCounters(
  title: string,
  counters: ReadonlyArray<{ readonly key: string; readonly count: number }>
): void {
  if (counters.length === 0) {
    console.log(`${title}: (none)`);
    return;
  }
  console.log(title);
  for (const entry of counters) console.log(`  ${entry.count}\t${entry.key}`);
}

function printReport(records: ReadonlyArray<Ai6aDiagnosticRecord>, a: Ai6aAggregates): void {
  console.log('=== AI-6A INTELLIGENCE RECON ===');
  console.log(`schema: ${AI6A_RECON_SCHEMA}`);
  console.log(`TOTAL UNIQUE LINES: ${a.total_unique_lines}`);
  console.log(
    `HISTORICAL SUBSET (load-bearing PRODUCTION axis): ${a.historical_97.authenticated_resolved}/${a.historical_97.total}`
  );
  console.log(
    `  historical RAW matched: ${a.historical_97.raw_matched} | historical SAFE resolved: ${a.historical_97.safe_resolved}`
  );
  console.log(
    `LEGACY SUBSET (load-bearing PRODUCTION axis): ${a.legacy_91.authenticated_resolved}/${a.legacy_91.total}`
  );
  console.log(
    `  legacy RAW matched: ${a.legacy_91.raw_matched} | legacy SAFE resolved: ${a.legacy_91.safe_resolved}`
  );
  console.log(
    `SAFE RESOLVED: ${a.counts.safe_resolved} (${rate(
      a.counts.safe_resolved,
      a.total_unique_lines
    )})`
  );
  console.log('--- resolution axes (AI-6A-R3: three DISTINCT axes, never conflated) ---');
  console.log(
    `  RAW  live terminal was 'matched' (production fact): ${a.counts.raw_matched}`
  );
  console.log(
    `  MASS authenticated mass source produced (says NOTHING about authored food choice): ${a.counts.authenticated_mass_resolved}`
  );
  console.log(
    `  SAFE resolved (authenticated mass AND no diagnostic failure): ${a.counts.safe_resolved}`
  );
  console.log(
    `  authenticated mass WITH an unresolved authored choice: ${a.counts.authenticated_mass_with_unresolved_authored_choice}`
  );
  console.log('--- by mass source ---');
  for (const source of AUTHENTICATED_MASS_SOURCES) {
    const entry = a.mass_sources.find((item) => item.key === source);
    console.log(`  ${entry?.count ?? 0}\t${source}`);
  }
  console.log('--- identity correctness ---');
  console.log(`VERIFIED UNSAFE AUTO IDENTITIES: ${a.counts.verified_unsafe_auto_identity}`);
  console.log(`VERIFIED CORRECT AUTO IDENTITIES: ${a.counts.verified_correct_auto_identity}`);
  console.log(`UNVERIFIED AUTO IDENTITIES: ${a.counts.unverified_auto_identity}`);
  printCounters('--- by live terminal ---', a.terminals);
  printCounters('--- primary blocker counts ---', a.primary_blockers);
  printCounters('--- repair lane counts ---', a.repair_lanes);
  printCounters('--- focus/family counts ---', a.focus_counts);

  console.log('--- top failure clusters (blocker | lane | terminal) ---');
  for (const cluster of a.failure_clusters.slice(0, 15)) {
    console.log(
      `  ${cluster.count}\t${cluster.primary_blocker} | ${cluster.repair_lane} | ${cluster.terminal}`
    );
  }
  console.log('--- top failing count/household nouns ---');
  for (const entry of countNounFailures(records)) {
    console.log(`  ${entry.count}\t${entry.key}`);
  }

  console.log('--- candidate / ranking statistics (labeled identity cases) ---');
  console.log(`  --- identity expectation denominators (mutually exclusive) ---`);
  console.log(`  expected_auto_identity cases (ONLY "binds expected" denominator): ${a.expectations.expected_auto_identity_cases}`);
  console.log(`  expect_no_automatic cases: ${a.expectations.expect_no_automatic_cases}`);
  console.log(`  known_issue_baseline cases (NOT a correctness contract): ${a.expectations.known_issue_baseline_cases}`);
  console.log(`  top_fdc_order_only cases (says nothing about auto-binding): ${a.expectations.top_fdc_order_only_cases}`);
  console.log(`  candidate_description_only cases: ${a.expectations.candidate_description_only_cases}`);
  console.log(`  forbidden_only cases (no positive expectation): ${a.expectations.forbidden_only_cases}`);
  console.log(`  no_expectation cases (unknowable): ${a.expectations.no_expectation_cases}`);
  console.log(`  --- ranking window vs binding (different denominators) ---`);
  console.log(`  bound expected auto identity: ${a.ranking.bound_expected_auto_identity} / ${a.ranking.expected_auto_identity_cases}`);
  console.log(`  expected present at window top 1: ${a.ranking.expected_present_at_window_top_1}`);
  console.log(`  expected within top 3: ${a.ranking.expected_within_top_3}`);
  console.log(`  expected within top 5: ${a.ranking.expected_within_top_5}`);
  console.log(`  expected absent from bounded candidates: ${a.ranking.expected_absent_from_bounded_candidates}`);
  console.log(`  automatic matches expected: ${a.ranking.automatic_matches_expected}`);
  console.log(`  automatic differs from expected: ${a.ranking.automatic_differs_from_expected}`);
  console.log(`  correct candidate present but auto withheld: ${a.ranking.correct_candidate_present_but_auto_withheld}`);

  console.log('--- portion diagnostics: RAW observation vs ACTIONABLE blocker ---');
  console.log(
    `  RAW  selected record has no compatible portion (probe only): ${a.portion.raw_selected_record_portion_incompatible}`
  );
  console.log(
    `  ACTIONABLE portion blocker (bounded quantity AND primary blocker): ${a.portion.actionable_portion_blocker}`
  );
  console.log(
    `    ...of which the record DOES have a compatible portion (no mass resulted): ${a.portion.actionable_with_compatible_record_but_unresolved}`
  );
  console.log(
    `  bounded lines probe-incompatible but NOT actionable (raw over-count): ${a.portion.bounded_lines_incompatible_but_not_actionable}`
  );
  console.log('  ...those lines actually break down as (raw over-count by real blocker):');
  for (const entry of a.portion.raw_incompatible_by_blocker) {
    console.log(`      ${entry.count}\t${entry.key}`);
  }
  console.log(`  compatible candidate exists but was not selected: ${a.portion.compatible_candidate_not_selected}`);
  console.log(`  another candidate has compatible portion: ${a.portion.alternate_candidate_has_compatible_portion}`);
  console.log(
    `  selected record HAS compatible portion but line unresolved: ${a.portion.selected_record_has_compatible_portion_but_unresolved}`
  );
  console.log(
    `  lines with a BOUNDED authored measurement (denominator): ${a.counts.bounded_authored_measurement}`
  );

  console.log('--- class separations ---');
  console.log(`  catalog/specificity gap: ${a.counts.catalog_or_specificity_gap}`);
  console.log(`  intentional alternative ambiguity: ${a.counts.alternative_ambiguous}`);
  console.log(
    `  FINDING authored alternative AUTO-RESOLVED (one food chosen): ${a.counts.authored_alternative_auto_resolved}`
  );
  console.log(`  qualitative / intentionally unresolved: ${a.counts.qualitative_or_absent_amount}`);
  console.log(`  measurement PARSE gap (mis-captured measurement): ${a.counts.measurement_parse_gap}`);
  console.log(`  measurement POLICY gap (captured, unconsumed): ${a.counts.measurement_policy_gap}`);
  console.log(`  container mass absent: ${a.counts.container_mass_absent}`);
  console.log(`  container net-mass boundary (policy decision): ${a.counts.container_net_mass_boundary}`);
  console.log(`  identity needs review (PRIMARY): ${a.counts.identity_needs_review}`);
  console.log(`  identity needs review (SYMPTOM observed): ${a.counts.identity_review_symptom_observed}`);
  console.log(`  unclassified (ALWAYS a finding): ${a.counts.unclassified}`);

  console.log('--- AI-6B roadmap ranking (derived from ROOT-CAUSE counts) ---');
  for (const entry of a.roadmap_ranking) {
    console.log(
      `  ${entry.eligible ? 'TARGET ' : 'no     '}${entry.lane}` +
        ` :: root_cause=${entry.root_cause_count}` +
        ` :: criteria=${Object.entries(entry.criteria)
          .map(([key, value]) => `${key}=${value}`)
          .join(',')}` +
        ` :: decided_by=${entry.decided_by}`
    );
  }

  console.log('--- per-line unresolved / unsafe table ---');
  for (const record of records) {
    if (record.primary_blocker === 'none_resolved' && record.identity_correctness !== 'verified_unsafe') {
      continue;
    }
    const unsafe = record.identity_correctness === 'verified_unsafe' ? ' UNSAFE_AUTO_IDENTITY' : '';
    console.log(
      `  [${record.terminal}] ${record.primary_blocker}${unsafe} :: ${record.line}` +
        ` :: lane=${record.repair_lane}` +
        ` :: noun=${record.count_noun_class}` +
        ` :: selected=${record.selected_fdc_id ?? '-'}` +
        ` :: candidates=${record.candidate_count}`
    );
  }
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

  const records = diagnoseCorpus(loaded.session, AI6A_INTELLIGENCE_CORPUS);
  // Identity knowledge is joined from the checked-in corpus by exact authored
  // text, so the expectation breakdown can never invent a denominator.
  const IDENTITY_BY_LINE = new Map(
    AI6A_INTELLIGENCE_CORPUS.filter((entry) => entry.identity !== undefined).map((entry) => [
      entry.line,
      entry.identity!,
    ])
  );
  const aggregates = aggregate(records, (line) => IDENTITY_BY_LINE.get(line));
  const baseline = historicalBaselineCheck(aggregates);

  printReport(records, aggregates);

  console.log('--- blocker accounting (exact) ---');
  console.log(
    `  enum total ${aggregates.accounting.blocker_enum_total} = ${aggregates.accounting.success_sentinel_count} success sentinel + ${aggregates.accounting.failure_blocker_count} failure blockers`
  );
  console.log('--- qualitative / absent-amount subtypes ---');
  console.log(`  explicit qualitative cue: ${aggregates.counts.qualitative_explicit_cue}`);
  console.log(`  authored amount absent: ${aggregates.counts.qualitative_amount_absent}`);
  console.log('--- versioned production baseline transition ---');
  const rel = baseline.ai6a_release_baseline;
  const exp = baseline.expected_production_baseline;
  console.log(
    `  AI-6A RELEASE baseline (immutable, before any AI-6B change): historical ${rel.historical_authenticated_resolved}/${rel.historical_total}, legacy ${rel.legacy_authenticated_resolved}/${rel.legacy_total}`
  );
  console.log(
    `  ${exp.phase} EXPECTED production baseline (current authorized): historical ${exp.historical_authenticated_resolved}/${exp.historical_total}, legacy ${exp.legacy_authenticated_resolved}/${exp.legacy_total}`
  );
  console.log(
    `  OBSERVED: historical ${baseline.observed.historical_authenticated_resolved}/${baseline.observed.historical_total}, legacy ${baseline.observed.legacy_authenticated_resolved}/${baseline.observed.legacy_total}`
  );
  console.log(
    `  DELTA vs AI-6A release: historical ${baseline.delta_from_ai6a_release.historical_authenticated_resolved >= 0 ? '+' : ''}${baseline.delta_from_ai6a_release.historical_authenticated_resolved}, legacy ${baseline.delta_from_ai6a_release.legacy_authenticated_resolved >= 0 ? '+' : ''}${baseline.delta_from_ai6a_release.legacy_authenticated_resolved}`
  );
  console.log(
    `  corpus UNCHANGED (${AI6A_INTELLIGENCE_CORPUS.length} lines, 97/91 denominators); only production resolution changed`
  );
  console.log(`  conformance ok: ${baseline.ok}${baseline.problems.length > 0 ? ` (${baseline.problems.join(', ')})` : ''}`);
  console.log(
    `  SAFE axis (diagnostic, NOT the invariant): historical ${aggregates.historical_97.safe_resolved}/${aggregates.historical_97.total}, legacy ${aggregates.legacy_91.safe_resolved}/${aggregates.legacy_91.total}`
  );

  if (jsonPath) {
    // Deterministic by construction: every field below is derived from the
    // checked-in corpus and the pinned bundle. No clock, no hostname, no
    // absolute path, no environment value.
    const payload = {
      schema: AI6A_RECON_SCHEMA,
      tool: AI6A_RECON_TOOL,
      corpus: {
        total_unique_lines: AI6A_INTELLIGENCE_CORPUS.length,
        historical_subset_total: AI6A_HISTORICAL_SUBSET.length,
        legacy_subset_total: AI6A_LEGACY_SUBSET.length,
      },
      historical_baseline: {
        // The load-bearing invariant is the PRODUCTION axis.
        historical_total: aggregates.historical_97.total,
        historical_authenticated_resolved: aggregates.historical_97.authenticated_resolved,
        historical_raw_matched: aggregates.historical_97.raw_matched,
        historical_safe_resolved: aggregates.historical_97.safe_resolved,
        legacy_total: aggregates.legacy_91.total,
        legacy_authenticated_resolved: aggregates.legacy_91.authenticated_resolved,
        legacy_raw_matched: aggregates.legacy_91.raw_matched,
        legacy_safe_resolved: aggregates.legacy_91.safe_resolved,
        ok: baseline.ok,
        problems: baseline.problems,
      },
      aggregates: {
        terminals: aggregates.terminals,
        mass_sources: aggregates.mass_sources,
        primary_blockers: aggregates.primary_blockers,
        repair_lanes: aggregates.repair_lanes,
        identity_correctness: aggregates.identity_correctness,
        secondary_signals: aggregates.secondary_signals,
        focus_counts: aggregates.focus_counts,
        family_counts: aggregates.family_counts,
        failure_clusters: aggregates.failure_clusters,
        count_noun_failures: aggregates.count_noun_failures,
        ranking: aggregates.ranking,
        expectations: aggregates.expectations,
        accounting: aggregates.accounting,
        portion: aggregates.portion,
        counts: aggregates.counts,
        // AI-6A-R3: the roadmap is the AI-6B INPUT, so it belongs in the JSON.
        // It is derived from `primary_blockers` alone; the raw portion
        // compatibility metric is deliberately not an input.
        roadmap: aggregates.roadmap,
        roadmap_ranking: aggregates.roadmap_ranking,
      },
      lines: records,
    };
    writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`json written: ${jsonPath}`);
  }

  if (!baseline.ok) {
    console.error('AI6A_HISTORICAL_BASELINE_DRIFT');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'ai6a_recon_failed');
  process.exit(1);
});