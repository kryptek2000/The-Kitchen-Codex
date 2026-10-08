/**
 * The Kitchen Codex — Phase 8B browser-proof artifact CLI.
 *
 * Emits the deterministic Phase 8B proof artifact. With no `--observations`
 * file it derives gates from the SHAPE of a proof run (design-level contract);
 * with one it derives gates from REAL browser observations recorded by
 * `scripts/verify_advanced_nutrition_browser_prod.ts --observations`.
 *
 * It never encodes a CI result: `post_push_ci_proof` is always `pending` and
 * `durable_ci_required` is always `true`, so no local run can self-promote a
 * CI-dependent gate to PASS.
 *
 * Usage:
 *   bun x tsx scripts/benchmark_nutrition_phase8b_browser_proof.ts
 *   bun x tsx scripts/benchmark_nutrition_phase8b_browser_proof.ts --json /tmp/p8b.json
 *   bun x tsx scripts/benchmark_nutrition_phase8b_browser_proof.ts \
 *     --observations /tmp/p8b-observations.json --json /tmp/p8b.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  buildPhase8bProof,
  PHASE8B_SCHEMA,
  type Phase8bObservation,
} from './nutritionReleaseExit/phase8bReport';

const BASE_COMMIT = 'ea4be87e3d21a2ba04aaf2335254005859e441f8';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/**
 * The observation shape a real browser run produces. Used only when no recorded
 * observations are supplied, so the artifact can still describe the proof's
 * design contract deterministically without claiming a browser ever ran.
 */
function designObservations(): Phase8bObservation[] {
  const noBundle = {
    artifactsRequested: [] as string[],
    allSameOrigin: false,
    allSucceeded: false,
    authenticated: false,
    genuineSession: false,
    liveUsdaRequests: 0,
  };
  const cleanRuntime = { consoleErrors: 0, exceptions: 0, unexpectedExternalRequests: 0, providerRequests: 0, liveUsdaRequests: 0 };
  return [
    {
      tier: 'ai_advanced',
      productionServer: true,
      builtApp: true,
      recipe: { title: 'Weeknight Beef Rice Bowls', servings: 4, ingredientCount: 9 },
      bundle: noBundle,
      review: null,
      calculation: null,
      entitlement: { productAccessTier: 'ai_advanced', aiPanelRendered: false, expectedReason: null, observedMessage: '', aiActionsDisabled: false },
      apply: { attempted: false, succeeded: false, successMessage: '', downloadObserved: false, persistedDigestMatchesPreview: false, persistedBlock: null },
      accessibility: null,
      runtime: cleanRuntime,
    },
    {
      tier: 'basic',
      productionServer: true,
      builtApp: true,
      recipe: null,
      bundle: noBundle,
      review: null,
      calculation: null,
      entitlement: { productAccessTier: 'basic', aiPanelRendered: false, expectedReason: null, observedMessage: '', aiActionsDisabled: false },
      apply: { attempted: false, succeeded: false, successMessage: '', downloadObserved: false, persistedDigestMatchesPreview: false, persistedBlock: null },
      accessibility: null,
      runtime: cleanRuntime,
    },
  ];
}

function main(): void {
  const observationsPath = argValue('--observations');
  const jsonPath = argValue('--json');
  const baseCommit = argValue('--base-commit') ?? BASE_COMMIT;

  let observations: Phase8bObservation[];
  if (observationsPath) {
    if (!existsSync(observationsPath)) {
      console.error(`observations file not found: ${observationsPath}`);
      process.exit(1);
    }
    observations = JSON.parse(readFileSync(observationsPath, 'utf8')) as Phase8bObservation[];
  } else {
    observations = designObservations();
  }

  const report = buildPhase8bProof({ baseCommit, observations });

  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${jsonPath}`);
  }

  console.log(`schema: ${PHASE8B_SCHEMA}`);
  console.log(`base_commit: ${report.base_commit}`);
  console.log(`observations: ${report.observations.length} (${observationsPath ? 'recorded browser run' : 'design contract, no browser run'})`);
  for (const gate of report.gates) {
    console.log(`  ${gate.status.padEnd(11)} ${gate.gate}  [${gate.evidence_level}/${gate.required_evidence_level}]`);
  }
  console.log(`totals: ${report.totals.proven} proven / ${report.totals.refuted} refuted / ${report.totals.not_proven} not_proven`);
  console.log(`durable_ci_required: ${report.durable_ci_required}`);
  console.log(`local_browser_proof: ${report.local_browser_proof}`);
  console.log(`post_push_ci_proof: ${report.post_push_ci_proof}`);
}

main();
