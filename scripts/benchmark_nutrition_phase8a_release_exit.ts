/**
 * The Kitchen Codex — Advanced Nutrition Phase 8A: RELEASE-EXIT RECON benchmark.
 *
 * A SEPARATE, versioned PLANNING artifact. It changes no production behavior and
 * grants no authority: it measures the release-exit surface across six axes,
 * derives a closed gate matrix from MEASURED evidence strength, and computes the
 * next planning slice without hardcoding a topic.
 *
 * AI-6B is complete: four lanes adjudicated and exhausted at zero actionable
 * defects. There is no measured evidence for a fifth deterministic lane, so none
 * is invented. Phase 8 is the real next program.
 *
 * All gathering and derivation lives in `nutritionReleaseExit/phase8aReport.ts`;
 * this file only prints and serializes it, so tests can build the identical
 * report in-process.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field. Two runs are byte-identical.
 *
 * Usage:
 *   bun x tsx scripts/benchmark_nutrition_phase8a_release_exit.ts
 *   bun x tsx scripts/benchmark_nutrition_phase8a_release_exit.ts --json /tmp/p8a.json
 */

import { writeFileSync } from 'node:fs';

import { buildPhase8aReleaseExitReport } from './nutritionReleaseExit/phase8aReport';

async function main(): Promise<void> {
  const jsonIndex = process.argv.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : undefined;

  const report = await buildPhase8aReleaseExitReport();
  const baseline = report.production_baseline;

  console.log(`Phase 8A release-exit recon (${report.schema})`);
  console.log(`  base: ${report.base_phase} @ ${report.base_commit}`);
  console.log(
    `  production unchanged: ${baseline.historical_resolved}/${baseline.historical_total} historical, ${baseline.legacy_resolved}/${baseline.legacy_total} legacy, ${baseline.raw_matched}/${baseline.authenticated_mass_resolved}/${baseline.safe_resolved} raw/auth/safe`
  );
  console.log(`  pinned bundle release: ${report.pinned_bundle_release}`);
  console.log(
    `  recognized codex_nutrition schema versions: ${report.recognized_codex_nutrition_schema_versions.join(', ')}`
  );

  console.log('--- AI-6 exit state (why Phase 8 starts here) ---');
  for (const lane of report.ai6_exit_state.lanes) {
    console.log(
      `  ${lane.lane.padEnd(24)} observed=${String(lane.observed_blockers).padEnd(4)} actionable=${lane.actionable_defects} exhausted=${lane.exhausted}`
    );
  }
  console.log(
    `  active repair: ${report.ai6_exit_state.active_repair_lane ?? 'none'}   next adjudication: ${report.ai6_exit_state.next_adjudication_lane ?? 'none'}`
  );

  console.log('--- axis A: migration ---');
  for (const entry of report.migration_inventory) {
    console.log(
      `  ${entry.shape.padEnd(52)} versions=[${entry.recognized_schema_versions.join(',')}] migrated=${entry.migrated_automatically} overwritable=${entry.overwritable_by_advanced_nutrition}`
    );
  }

  console.log('--- axis B: staleness ---');
  for (const surface of report.staleness_surface) {
    console.log(`  ${surface.surface}  [level=${surface.strongest_test_level}]`);
  }

  console.log('--- axis C: round-trip matrix ---');
  for (const row of report.roundtrip_matrix) {
    console.log(
      `  ${row.case.padEnd(56)} ${row.outcome}${row.destructive ? '  *** DESTRUCTIVE ***' : ''}`
    );
  }
  console.log('  outcome counts:');
  for (const entry of report.roundtrip_outcome_counts) {
    console.log(`    ${entry.count}\t${entry.outcome}`);
  }

  console.log('--- axis D: production browser ---');
  for (const step of report.production_browser_flow) console.log(`  -> ${step}`);

  console.log('--- axis E: corpus ---');
  const corpus = report.corpus_inventory;
  console.log(`  intelligence corpus lines : ${corpus.intelligence_corpus_lines}`);
  console.log(`  by source                : ${JSON.stringify(corpus.intelligence_corpus_sources)}`);
  console.log(`  coverage families        : ${corpus.intelligence_coverage_families}`);
  console.log(`  resolution corpus lines  : ${corpus.resolution_corpus_lines}`);
  console.log(`  semantic corpus cases    : ${corpus.semantic_corpus_cases}`);
  console.log(`  smoke corpus cases       : ${corpus.smoke_corpus_cases}`);
  console.log(`  identity corpus lines    : ${corpus.identity_corpus_lines}`);
  console.log(`  FULL-RECIPE fixtures with expected totals: ${corpus.full_recipe_fixtures_with_expected_totals}`);

  console.log('--- test inventory by strongest level ---');
  console.log(`  total test files: ${report.test_inventory.total_test_files}`);
  for (const entry of report.test_inventory.by_level) {
    console.log(`    ${String(entry.count).padStart(4)}  ${entry.level}`);
  }
  console.log(
    `  levels NOT FOUND: ${report.test_inventory.levels_not_found.join(', ') || 'none'}`
  );

  console.log('--- axis F: release-exit gate matrix ---');
  for (const gate of report.release_exit_gates) {
    console.log(
      `  ${gate.gate.padEnd(34)} ${gate.status.padEnd(13)} ${gate.severity.padEnd(26)} evidence=${gate.actual_evidence_level} (need ${gate.required_evidence_level})`
    );
  }
  console.log('  status counts:');
  for (const entry of report.gate_status_counts) {
    console.log(`    ${String(entry.count).padStart(3)}  ${entry.status}`);
  }

  console.log('--- next slice (planning only, not authorization) ---');
  console.log(`  recommendation : ${report.next_slice.recommendation}`);
  console.log(`  gate          : ${report.next_slice.gate ?? 'none'}`);
  console.log(`  severity      : ${report.next_slice.severity}`);
  console.log(`  reason        : ${report.next_slice.derivation_reason}`);

  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`json written: ${jsonPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});