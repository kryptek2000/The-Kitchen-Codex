/**
 * The Kitchen Codex — Advanced Nutrition AI-6B4: ranking DISPOSITION benchmark.
 *
 * A SEPARATE, versioned PLANNING artifact. It does not modify the AI-6A/AI-6B1
 * intelligence recon schema, the AI-6B2 portion disposition schema, the AI-6B3
 * identity disposition schema, or any production behavior: it reads the real
 * pinned USDA bundle, runs the real production pipeline, ADJUDICATES each
 * `compatible_candidate_not_selected` line into exactly one closed disposition
 * with exactly one closed evidence code, and SIMULATES the hypothetical general
 * ranking rules that could ever justify a repair.
 *
 * The point is to keep two numbers apart forever:
 *   OBSERVED RANKING BLOCKERS ................. 9
 *   REPAIRABLE DETERMINISTIC RANKING DEFECTS .. measured, never assumed
 *
 * A candidate must never outrank a semantically better food identity merely
 * because it has a convenient USDA portion.
 *
 * All evidence gathering and derivation lives in
 * `nutritionIntelligence/rankingDispositionReport.ts`; this file only prints and
 * serializes it, so tests can build the identical report in-process.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field. Two runs are byte-identical.
 *
 * Usage:
 *   bun x tsx scripts/benchmark_nutrition_ranking_disposition.ts
 *   bun x tsx scripts/benchmark_nutrition_ranking_disposition.ts --json /tmp/b4.json
 */

import { writeFileSync } from 'node:fs';

import { buildNutritionRankingDispositionReport } from './nutritionIntelligence/rankingDispositionReport';

function printCounters(
  title: string,
  counters: ReadonlyArray<{ readonly key: string; readonly count: number }>
): void {
  console.log(title);
  for (const entry of counters) console.log(`  ${entry.count}\t${entry.key}`);
}

async function main(): Promise<void> {
  const jsonIndex = process.argv.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : undefined;

  const report = await buildNutritionRankingDispositionReport();
  const baseline = report.production_baseline;

  console.log(`AI-6B4 ranking disposition report (${report.schema})`);
  console.log(`  base: ${report.base_phase} @ ${report.base_commit}`);
  console.log(
    `  production unchanged: ${baseline.historical_resolved}/${baseline.historical_total} historical, ${baseline.legacy_resolved}/${baseline.legacy_total} legacy`
  );
  console.log(`  OBSERVED ranking blockers: ${report.observed_ranking_blockers}`);
  console.log(
    `  REPAIRABLE deterministic ranking defects: ${report.repairable_deterministic_ranking_defects}`
  );
  console.log(`  ranking lane exhausted: ${report.ranking_lane_exhausted}`);
  console.log(
    `  separate lanes: deterministic_identity=${report.deterministic_identity_blockers}  deterministic_portion=${report.deterministic_portion_blockers}`
  );
  printCounters('  ranking blocker split:', report.ranking_blocker_split);
  printCounters('  dispositions:', report.disposition_counts);
  printCounters('  evidence codes:', report.evidence_counts);
  printCounters('  selected/alternate semantic parity:', report.semantic_parity_counts);
  printCounters('  handoff lanes:', report.handoff_lane_counts);
  printCounters('  AI-3 eligibility (unchanged contract):', report.ai3_eligibility_counts);
  console.log('--- ranking-lane corpus constraints ---');
  const constraints = report.ranking_lane_constraint_counts;
  console.log(
    `  expectedAutoFdc=${constraints.expected_auto_fdc}  baselineAutoFdc=${constraints.baseline_auto_fdc}  expectTopFdc=${constraints.expect_top_fdc}  expectCandidateDescription=${constraints.expect_candidate_description}`
  );
  console.log(
    `  expectNoAutomatic=${constraints.expect_no_automatic}  forbiddenAutoFdcs=${constraints.forbidden_auto_fdcs}  forbiddenAutoDescription=${constraints.forbidden_auto_description}  knownIssue=${constraints.known_issue}`
  );
  console.log('--- hypothetical rule simulation (never executed in production) ---');
  for (const simulation of report.hypothetical_rule_simulations) {
    console.log(
      `  ${simulation.rule_id}: eligible=${simulation.repairable_eligible} (${simulation.eligibility_reason})`
    );
    console.log(
      `    ranking-lane bindings=${simulation.ranking_lane_new_bindings}  new auto=${simulation.new_automatic_identities}  changed auto=${simulation.changed_automatic_identities}  unchanged=${simulation.unchanged_automatic_identities}`
    );
    console.log(
      `    expectedFdc divergences=${simulation.expected_fdc_divergences}  baselineFdc=${simulation.baseline_fdc_divergences}  expectTopFdc=${simulation.expect_top_fdc_violations}  new masses=${simulation.new_authenticated_masses}  changed grams=${simulation.changed_grams}`
    );
    console.log(
      `    expectNoAutomatic=${simulation.expect_no_automatic_violations}  forbiddenFdc=${simulation.forbidden_fdc_violations}  forbiddenDescription=${simulation.forbidden_description_violations}  food-inside-preparation safety=${simulation.safety_history_bindings}`
    );
  }
  console.log('--- lane repairability ---');
  for (const lane of report.lane_repairability) {
    console.log(
      `  ${lane.lane.padEnd(30)} observed=${String(lane.observed_blockers).padEnd(4)} actionable=${lane.actionable_defects === null ? 'not_adjudicated' : lane.actionable_defects} exhausted=${lane.exhausted}`
    );
  }
  console.log(
    `  recommended active repair lane: ${report.recommended_active_repair_lane ?? 'none'} (${report.recommended_active_repair_reason})`
  );
  console.log(
    `  next adjudication target lane: ${report.next_adjudication_target_lane ?? 'none'} (${report.next_adjudication_reason})`
  );

  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`json written: ${jsonPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});