/**
 * The Kitchen Codex — Advanced Nutrition AI-6B5: catalog DISPOSITION benchmark.
 *
 * A SEPARATE, versioned PLANNING artifact. It does not modify the AI-6A/AI-6B1
 * intelligence recon schema, the AI-6B2/3/4 disposition schemas, or any
 * production behavior: it reads the real pinned USDA bundle, proves whether each
 * catalog-lane food is genuinely absent from that authenticated bundle, and
 * ADJUDICATES each line into exactly one closed disposition with exactly one
 * closed evidence code.
 *
 * The point is to keep two numbers apart forever:
 *   OBSERVED CATALOG BLOCKERS ................ 5
 *   REPAIRABLE CATALOG SURFACE DEFECTS ....... measured, never assumed
 *
 * Catalog absence is NOT matcher failure: when an authorized record exists but
 * the search surface never surfaces it, that is a handoff, not a catalog gap.
 *
 * All evidence gathering and derivation lives in
 * `nutritionIntelligence/catalogDispositionReport.ts`; this file only prints and
 * serializes it, so tests can build the identical report in-process.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field. Two runs are byte-identical.
 *
 * Usage:
 *   bun x tsx scripts/benchmark_nutrition_catalog_disposition.ts
 *   bun x tsx scripts/benchmark_nutrition_catalog_disposition.ts --json /tmp/b5.json
 */

import { writeFileSync } from 'node:fs';

import { buildNutritionCatalogDispositionReport } from './nutritionIntelligence/catalogDispositionReport';

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

  const report = await buildNutritionCatalogDispositionReport();
  const baseline = report.production_baseline;

  console.log(`AI-6B5 catalog disposition report (${report.schema})`);
  console.log(`  base: ${report.base_phase} @ ${report.base_commit}`);
  console.log(
    `  production unchanged: ${baseline.historical_resolved}/${baseline.historical_total} historical, ${baseline.legacy_resolved}/${baseline.legacy_total} legacy`
  );
  console.log(`  OBSERVED catalog blockers: ${report.observed_catalog_blockers}`);
  console.log(
    `  REPAIRABLE deterministic catalog surface defects: ${report.repairable_deterministic_catalog_surface_defects}`
  );
  console.log(`  catalog lane exhausted: ${report.catalog_lane_exhausted}`);
  console.log(
    `  separate lanes: portion=${report.deterministic_portion_blockers}  identity=${report.deterministic_identity_blockers}  ranking=${report.deterministic_ranking_blockers}`
  );
  printCounters('  catalog blocker split:', report.blocker_split);
  printCounters('  dispositions:', report.disposition_counts);
  printCounters('  evidence codes:', report.evidence_counts);
  printCounters('  handoff lanes:', report.handoff_lane_counts);
  printCounters('  AI-3 eligibility (unchanged contract):', report.ai3_eligibility_counts);
  console.log('--- catalog-existence evidence per line ---');
  for (const line of report.lines) {
    console.log(`  "${line.line}"`);
    console.log(
      `    direct("${line.catalog_probe_phrase}")=${line.exact_search_total}  variantSplits=${line.variant_split_count}  variantHits=${line.variant_found_total}  broaderGeneric=${line.broader_generic_family_exists}  portionAuthority=${line.portion_authority_available_for_variant}`
    );
    console.log(
      `    -> ${line.disposition} / ${line.evidence}  repairable=${line.repairable} handoff=${line.handoff_lane} ownedByOtherLane=${line.owned_by_other_lane}`
    );
  }
  console.log('--- catalog-lane constraints ---');
  const constraints = report.catalog_lane_constraint_counts;
  console.log(
    `  expectedAutoFdc=${constraints.expected_auto_fdc}  baselineAutoFdc=${constraints.baseline_auto_fdc}  expectTopFdc=${constraints.expect_top_fdc}  expectNoAutomatic=${constraints.expect_no_automatic}`
  );
  console.log(
    `  forbiddenAutoFdcs=${constraints.forbidden_auto_fdcs}  forbiddenAutoDescription=${constraints.forbidden_auto_description}  knownIssue=${constraints.known_issue}  brandSpecificity=${constraints.brand_specificity}`
  );
  console.log('--- hypothetical surface-rule simulation (never applied) ---');
  const sim = report.hypothetical_surface_simulation;
  console.log(`  ${sim.rule_id}`);
  console.log(`    lines probed: ${sim.lines_probed}  direct surface empty: ${sim.lines_whose_direct_surface_is_empty}`);
  console.log(`    variant surface finds records: ${sim.lines_whose_variant_surface_finds_records}  of which brand-genericizing: ${sim.lines_whose_variant_surface_is_brand_genericizing}`);
  console.log(`    expectedFdc divergences=${sim.expected_fdc_divergences}  expectNoAutomatic=${sim.expect_no_automatic_violations}  forbiddenFdc=${sim.forbidden_fdc_violations}  forbiddenDesc=${sim.forbidden_description_violations}`);
  console.log(`    identity/mass changes computed: ${sim.identity_or_mass_changes_computed} (${sim.not_computed_reason})`);
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