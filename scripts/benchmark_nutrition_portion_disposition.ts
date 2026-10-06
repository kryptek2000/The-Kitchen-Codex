/**
 * The Kitchen Codex — Advanced Nutrition AI-6B2: portion DISPOSITION benchmark.
 *
 * A SEPARATE, versioned PLANNING artifact. It does not modify the AI-6A/AI-6B1
 * intelligence recon schema and it does not change production behavior: it reads
 * the real pinned USDA bundle, runs the real production pipeline, and then
 * ADJUDICATES each unresolved `deterministic_portion` line into exactly one closed
 * disposition with exactly one closed evidence code.
 *
 * The point is to keep two numbers apart forever:
 *   OBSERVED PORTION BLOCKERS .................. 35
 *   REPAIRABLE DETERMINISTIC PORTION DEFECTS ... measured, never assumed
 *
 * All evidence gathering and derivation lives in
 * `nutritionIntelligence/portionDispositionReport.ts`; this file only prints and
 * serializes it, so tests can build the identical report in-process.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field. Two runs are byte-identical.
 *
 * Usage:
 *   bun x tsx scripts/benchmark_nutrition_portion_disposition.ts
 *   bun x tsx scripts/benchmark_nutrition_portion_disposition.ts --json /tmp/b2.json
 */

import { writeFileSync } from 'node:fs';

import { buildNutritionPortionDispositionReport } from './nutritionIntelligence/portionDispositionReport';

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

  const report = await buildNutritionPortionDispositionReport();
  const baseline = report.production_baseline;

  console.log(`AI-6B2 portion disposition report (${report.schema})`);
  console.log(`  base: ${report.base_phase} @ ${report.base_commit}`);
  console.log(
    `  production unchanged: ${baseline.historical_resolved}/${baseline.historical_total} historical, ${baseline.legacy_resolved}/${baseline.legacy_total} legacy`
  );
  console.log(`  OBSERVED portion blockers: ${report.observed_portion_blockers}`);
  console.log(
    `  REPAIRABLE deterministic portion defects: ${report.repairable_deterministic_portion_defects}`
  );
  console.log(`  portion lane exhausted: ${report.portion_lane_exhausted}`);
  printCounters('  dispositions:', report.disposition_counts);
  printCounters('  evidence codes:', report.evidence_counts);
  printCounters('  handoff lanes:', report.handoff_lane_counts);
  printCounters('  AI-3 eligibility (unchanged contract):', report.ai3_eligibility_counts);
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
