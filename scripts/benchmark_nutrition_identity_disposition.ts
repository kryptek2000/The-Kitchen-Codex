/**
 * The Kitchen Codex — Advanced Nutrition AI-6B3: identity DISPOSITION benchmark.
 *
 * A SEPARATE, versioned PLANNING artifact. It does not modify the AI-6A/AI-6B1
 * intelligence recon schema, the AI-6B2 portion disposition schema, or any
 * production behavior: it reads the real pinned USDA bundle, runs the real
 * production pipeline, ADJUDICATES each unresolved `deterministic_identity` line
 * into exactly one closed disposition with exactly one closed evidence code, and
 * SIMULATES the hypothetical rules that could ever justify an identity repair.
 *
 * The point is to keep two numbers apart forever:
 *   OBSERVED IDENTITY BLOCKERS ................. 27
 *   REPAIRABLE DETERMINISTIC IDENTITY DEFECTS .. measured, never assumed
 *
 * All evidence gathering and derivation lives in
 * `nutritionIntelligence/identityDispositionReport.ts`; this file only prints and
 * serializes it, so tests can build the identical report in-process.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field. Two runs are byte-identical.
 *
 * Usage:
 *   bun x tsx scripts/benchmark_nutrition_identity_disposition.ts
 *   bun x tsx scripts/benchmark_nutrition_identity_disposition.ts --json /tmp/b3.json
 */

import { writeFileSync } from 'node:fs';

import { buildNutritionIdentityDispositionReport } from './nutritionIntelligence/identityDispositionReport';

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

  const report = await buildNutritionIdentityDispositionReport();
  const baseline = report.production_baseline;

  console.log(`AI-6B3 identity disposition report (${report.schema})`);
  console.log(`  base: ${report.base_phase} @ ${report.base_commit}`);
  console.log(
    `  production unchanged: ${baseline.historical_resolved}/${baseline.historical_total} historical, ${baseline.legacy_resolved}/${baseline.legacy_total} legacy`
  );
  console.log(`  OBSERVED identity blockers: ${report.observed_identity_blockers}`);
  console.log(
    `  REPAIRABLE deterministic identity defects: ${report.repairable_deterministic_identity_defects}`
  );
  console.log(`  identity lane exhausted: ${report.identity_lane_exhausted}`);
  console.log(
    `  deterministic_ranking blockers (separate lane, never absorbed): ${report.deterministic_ranking_blockers}`
  );
  printCounters('  identity blocker split:', report.blocker_split);
  printCounters('  dispositions:', report.disposition_counts);
  printCounters('  evidence codes:', report.evidence_counts);
  printCounters('  handoff lanes:', report.handoff_lane_counts);
  printCounters('  AI-3 eligibility (unchanged contract):', report.ai3_eligibility_counts);
  console.log('--- identity-lane safety constraints ---');
  console.log(
    `  expectNoAutomatic=${report.identity_lane_constraint_counts.expect_no_automatic}  forbiddenAutoFdcs=${report.identity_lane_constraint_counts.forbidden_auto_fdcs}  forbiddenAutoDescription=${report.identity_lane_constraint_counts.forbidden_auto_description}`
  );
  console.log('--- hypothetical rule simulation (never executed in production) ---');
  for (const simulation of report.hypothetical_rule_simulations) {
    console.log(`  ${simulation.rule_id}: eligible=${simulation.repairable_eligible} (${simulation.eligibility_reason})`);
    console.log(
      `    identity-lane new bindings=${simulation.identity_lane_new_bindings}  corpus new=${simulation.corpus_new_bindings}  changed=${simulation.corpus_changed_bindings}  oracle divergences=${simulation.oracle_divergences}`
    );
    console.log(
      `    expectNoAutomatic=${simulation.expect_no_automatic_violations}  forbiddenFdc=${simulation.forbidden_fdc_violations}  forbiddenDescription=${simulation.forbidden_description_violations}  food-inside-preparation safety bindings=${simulation.safety_history_bindings}`
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