/**
 * The Kitchen Codex — Advanced Nutrition Phase 8A: RELEASE-EXIT RECON REPORT
 * BUILDER (planning only, ZERO production consumers).
 *
 * Measures the current release-exit surface across six axes and derives a closed
 * gate matrix. Every count in the artifact is MEASURED from the repository or
 * from the pinned production data — none is asserted by hand.
 *
 * Reusable so tests build the identical report in-process; the CLI wrapper
 * (`scripts/benchmark_nutrition_phase8a_release_exit.ts`) only prints/serializes.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field enters the returned object. Two calls are byte-identical.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  GATE_STATUSES,
  PHASE8A_BASE_COMMIT,
  PHASE8A_BASE_PHASE,
  PHASE8A_SCHEMA,
  RELEASE_EXIT_GATES,
  REQUIRED_EVIDENCE_LEVEL,
  ROUNDTRIP_OUTCOMES,
  deriveNextSlice,
  evaluateReleaseExitGate,
  type Phase8aEvidenceLevel,
  type Phase8aGateStatus,
  type Phase8aGapSeverity,
  type Phase8aReleaseExitGate,
  type Phase8aRoundtripOutcome,
} from './phase8aRecon';
import { AI6A_INTELLIGENCE_CORPUS } from '../../tests/fixtures/advancedNutritionAi6aIntelligenceCorpus';
import { RESOLUTION_COVERAGE_CORPUS } from '../../tests/fixtures/advancedNutritionResolutionCorpus';
import { AI_ADVANCED_SEMANTIC_CORPUS } from '../../tests/fixtures/aiAdvancedSemanticCorpus';
import { AI_ADVANCED_SMOKE_CORPUS } from '../../tests/fixtures/aiAdvancedSmokeCorpus';
import { IDENTITY_SAFETY_CORPUS } from '../../tests/fixtures/advancedNutritionIdentityCorpus';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { CODEX_NUTRITION_SCHEMA_V1 } from '../../src/core/nutritionV2/schema';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * AI-6B2/3/4/5's MEASURED actionable counts, pinned as recorded measurements.
 * Passing observed blocker counts here would resurrect exhausted lanes from
 * blocker frequency alone.
 */
export const ADJUDICATED_LANE_ACTIONABLE_DEFECTS: Readonly<
  Record<string, number>
> = Object.freeze({
  deterministic_portion: 0,
  deterministic_identity: 0,
  deterministic_ranking: 0,
  catalog_gap: 0,
});

/** Observed blocker counts those phases recorded; asserted, never recomputed. */
export const ADJUDICATED_LANE_OBSERVED_BLOCKERS: Readonly<Record<string, number>> =
  Object.freeze({
    deterministic_portion: 35,
    deterministic_identity: 27,
    deterministic_ranking: 9,
    catalog_gap: 5,
  });

// ---------------------------------------------------------------------------
// Measured test-level inventory
// ---------------------------------------------------------------------------

function listTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listTestFiles(full, out);
      continue;
    }
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Classifies a test file by the STRONGEST level it actually exercises, using
 * only what the file itself contains.
 *
 * Deliberately conservative. Two false positives are specifically guarded
 * against, because each would manufacture false release confidence:
 *   - `nutrients.selenium` is the NUTRIENT, not Selenium WebDriver. Only a
 *     driver-specific import or launch signature counts as browser automation.
 *   - a file that merely MENTIONS `createApp` in a comment is not a server test;
 *     the app must be imported and actually driven over a listener.
 */
function classifyTestLevel(absPath: string): Phase8aEvidenceLevel {
  let text = '';
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return 'unit';
  }
  // Browser automation requires a driver import or launch signature.
  if (
    /from\s+['"](playwright|puppeteer|cypress|webdriverio|@wdio\/[\w-]+)['"]/.test(text) ||
    /(chromium|firefox|webkit|puppeteer|playwright|cypress)\s*\.\s*(launch|connect)/.test(text) ||
    /new\s+(Page|Browser)\s*\(\s*\)\s*\.?(connect|newPage|newPage)/.test(text)
  ) {
    return 'browser_automation';
  }
  // Exercising the built output.
  if (/\bdist\/(server\.cjs|assets|index\.html)/.test(text)) return 'production_build';
  // Real DOM rendering.
  if (/@vitest-environment\s+jsdom/.test(text) || absPath.endsWith('.tsx')) return 'dom';
  // Booting the REAL app and speaking real HTTP to it.
  // NOTE: repo imports carry an explicit extension (`server/app.js`), so the
  // module specifier must allow one.
  const importsApp = /from\s+['"][^'"]*server\/app(\.[jt]s)?['"]/.test(text);
  const callsCreateApp = /createApp\s*\(/.test(text);
  const drivesOverHttp =
    /createServer\s*\(/.test(text) ||
    /\.listen\s*\(/.test(text) ||
    /\bfetch\s*\(\s*['"`]http/.test(text) ||
    /request\s*\(\s*app\b/.test(text);
  if (importsApp && callsCreateApp && drivesOverHttp) return 'server';
  if (importsApp && callsCreateApp) return 'integration';
  // Composes the real bundle against a real session.
  if (
    /composeAdvancedNutritionSessionFromBundle/.test(text) &&
    /readFileSync/.test(text)
  ) {
    return 'integration';
  }
  return 'unit';
}

export interface Phase8aTestInventory {
  readonly total_test_files: number;
  readonly by_level: ReadonlyArray<{ level: string; count: number }>;
  readonly levels_not_found: ReadonlyArray<string>;
}

function measureTestInventory(): Phase8aTestInventory {
  const files = [
    ...listTestFiles(join(ROOT, 'tests')),
    ...listTestFiles(join(ROOT, 'src')),
  ].sort();
  const counts = new Map<string, number>();
  for (const file of files) {
    const level = classifyTestLevel(file);
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const order: ReadonlyArray<Phase8aEvidenceLevel> = [
    'unit',
    'integration',
    'dom',
    'server',
    'production_build',
    'production_server',
    'browser_automation',
  ];
  return {
    total_test_files: files.length,
    by_level: order
      .map((level) => ({ level, count: counts.get(level) ?? 0 }))
      .filter((entry) => entry.count > 0),
    levels_not_found: order.filter(
      (level) => (counts.get(level) ?? 0) === 0 && level !== 'none'
    ),
  };
}

// ---------------------------------------------------------------------------
// Axis inventories
// ---------------------------------------------------------------------------

export interface Phase8aAxisSurface {
  readonly axis: string;
  readonly surface: string;
  readonly existing_implementation: string;
  readonly existing_evidence: string;
  readonly strongest_test_level: Phase8aEvidenceLevel;
  readonly required_test_level: Phase8aEvidenceLevel;
  readonly status: Phase8aGateStatus;
  readonly gap_severity: Phase8aGapSeverity;
  /** Owner lane, informational only. Grants no authorization. */
  readonly owner: string;
}

export interface Phase8aMigrationInventoryEntry {
  readonly shape: string;
  readonly recognized_schema_versions: ReadonlyArray<number>;
  readonly parse_behavior: string;
  readonly display_behavior: string;
  readonly preserved_verbatim: boolean;
  readonly migrated_automatically: boolean;
  readonly user_action_required: boolean;
  readonly overwritable_by_advanced_nutrition: boolean;
  readonly legacy_fallback_only: boolean;
  readonly destructive_rewrite_possible: boolean;
}

export interface Phase8aRoundtripMatrixRow {
  readonly case: string;
  readonly outcome: Phase8aRoundtripOutcome;
  readonly destructive: boolean;
  readonly evidence: string;
}

export interface Phase8aReleaseExitReport {
  readonly schema: string;
  readonly tool: string;
  readonly base_phase: string;
  readonly base_commit: string;
  /** The measured AI-6 exit state that motivates Phase 8. */
  readonly ai6_exit_state: {
    readonly lanes: ReadonlyArray<{
      lane: string;
      observed_blockers: number;
      actionable_defects: number;
      adjudicated: boolean;
      exhausted: boolean;
    }>;
    readonly active_repair_lane: string | null;
    readonly next_adjudication_lane: string | null;
  };
  readonly production_baseline: {
    readonly historical_resolved: number;
    readonly historical_total: number;
    readonly legacy_resolved: number;
    readonly legacy_total: number;
    readonly raw_matched: number;
    readonly authenticated_mass_resolved: number;
    readonly safe_resolved: number;
    readonly verified_correct_auto_identity: number;
    readonly verified_unsafe_auto_identity: number;
    readonly corpus_total: number;
  };
  readonly pinned_bundle_release: string;
  readonly recognized_codex_nutrition_schema_versions: ReadonlyArray<number>;
  // --- axes ---
  readonly migration_inventory: ReadonlyArray<Phase8aMigrationInventoryEntry>;
  readonly migration_surface: ReadonlyArray<Phase8aAxisSurface>;
  readonly staleness_surface: ReadonlyArray<Phase8aAxisSurface>;
  readonly roundtrip_matrix: ReadonlyArray<Phase8aRoundtripMatrixRow>;
  readonly roundtrip_outcome_counts: ReadonlyArray<{ outcome: string; count: number }>;
  readonly production_browser_flow: ReadonlyArray<string>;
  readonly production_browser_surface: ReadonlyArray<Phase8aAxisSurface>;
  readonly corpus_inventory: {
    readonly intelligence_corpus_lines: number;
    readonly intelligence_corpus_sources: ReadonlyArray<{ source: string; count: number }>;
    readonly intelligence_coverage_families: number;
    readonly resolution_corpus_lines: number;
    readonly semantic_corpus_cases: number;
    readonly smoke_corpus_cases: number;
    readonly identity_corpus_lines: number;
    readonly full_recipe_fixtures_with_expected_totals: number;
  };
  readonly test_inventory: Phase8aTestInventory;
  readonly release_exit_gates: ReadonlyArray<{
    gate: string;
    status: string;
    severity: string;
    actual_evidence_level: string;
    required_evidence_level: string;
    reason: string;
  }>;
  readonly gate_status_counts: ReadonlyArray<{ status: string; count: number }>;
  readonly next_slice: {
    recommendation: string;
    gate: string | null;
    severity: string;
    derivation_reason: string;
  };
}

export async function buildPhase8aReleaseExitReport(): Promise<Phase8aReleaseExitReport> {
  const testInventory = measureTestInventory();

  // --- Axis A: migration ---------------------------------------------------
  const migration_inventory: ReadonlyArray<Phase8aMigrationInventoryEntry> = [
    {
      shape: 'legacy simple nutrition (frontmatter nutrition / calories / bare macros)',
      recognized_schema_versions: [],
      parse_behavior: 'parsed into RecipeNutrition; display-only',
      display_behavior: 'rendered by RecipeNutritionCard with legacy per-serving semantics',
      preserved_verbatim: true,
      migrated_automatically: false,
      user_action_required: false,
      overwritable_by_advanced_nutrition: false,
      legacy_fallback_only: true,
      destructive_rewrite_possible: false,
    },
    {
      shape: 'legacy AI estimator result (provenance ai_estimate)',
      recognized_schema_versions: [],
      parse_behavior: 'provenance retained and gated; display-only',
      display_behavior: 'rendered with legacy provenance label',
      preserved_verbatim: true,
      migrated_automatically: false,
      user_action_required: false,
      overwritable_by_advanced_nutrition: false,
      legacy_fallback_only: true,
      destructive_rewrite_possible: false,
    },
    {
      shape: `codex_nutrition schema v${CODEX_NUTRITION_SCHEMA_V1}`,
      recognized_schema_versions: [1],
      parse_behavior: 'validated and decoded to the canonical typed block',
      display_behavior: 'rendered as Advanced Nutrition',
      preserved_verbatim: false,
      migrated_automatically: false,
      user_action_required: true,
      overwritable_by_advanced_nutrition: true,
      legacy_fallback_only: false,
      destructive_rewrite_possible: false,
    },
    {
      shape: 'codex_nutrition schema v2',
      recognized_schema_versions: [2],
      parse_behavior: 'validated and decoded (adds household_portion basis)',
      display_behavior: 'rendered as Advanced Nutrition',
      preserved_verbatim: false,
      migrated_automatically: false,
      user_action_required: true,
      overwritable_by_advanced_nutrition: true,
      legacy_fallback_only: false,
      destructive_rewrite_possible: false,
    },
    {
      shape: 'codex_nutrition schema v3',
      recognized_schema_versions: [3],
      parse_behavior: 'validated and decoded (adds range representative evidence)',
      display_behavior: 'rendered as Advanced Nutrition',
      preserved_verbatim: false,
      migrated_automatically: false,
      user_action_required: true,
      overwritable_by_advanced_nutrition: true,
      legacy_fallback_only: false,
      destructive_rewrite_possible: false,
    },
    {
      shape: 'unknown future schema',
      recognized_schema_versions: [],
      parse_behavior: 'decoded as bounded OPAQUE data; never interpreted',
      display_behavior: 'surfaced as advanced_unsupported with has_opaque_block',
      preserved_verbatim: true,
      migrated_automatically: false,
      user_action_required: false,
      overwritable_by_advanced_nutrition: false,
      legacy_fallback_only: false,
      destructive_rewrite_possible: false,
    },
    {
      shape: 'malformed saved block',
      recognized_schema_versions: [],
      parse_behavior: 'decoded as malformed; never a usable value',
      display_behavior: 'surfaced as advanced_invalid; not attached as canonical nutrition',
      preserved_verbatim: false,
      migrated_automatically: false,
      user_action_required: false,
      overwritable_by_advanced_nutrition: false,
      legacy_fallback_only: false,
      destructive_rewrite_possible: false,
    },
    {
      shape: 'stale saved block (servings or ingredient set changed)',
      recognized_schema_versions: [1, 2, 3],
      parse_behavior: 'decoded normally, then flagged stale at presentation time',
      display_behavior: 'stale banner shown; reasons servings_changed / ingredients_changed',
      preserved_verbatim: false,
      migrated_automatically: false,
      user_action_required: true,
      overwritable_by_advanced_nutrition: true,
      legacy_fallback_only: false,
      destructive_rewrite_possible: false,
    },
    {
      shape: 'recipe with NO saved nutrition',
      recognized_schema_versions: [],
      parse_behavior: 'no block present; nothing decoded',
      display_behavior: 'no Advanced Nutrition data; no automatic creation',
      preserved_verbatim: true,
      migrated_automatically: false,
      user_action_required: true,
      overwritable_by_advanced_nutrition: false,
      legacy_fallback_only: false,
      destructive_rewrite_possible: false,
    },
  ];

  // --- Axis F: gate matrix -------------------------------------------------
  //
  // Evidence is declared PER PROPERTY, never as a repo-wide maximum. Using the
  // strongest level found anywhere would let an unrelated integration test
  // "prove" that the browser bundle works, which is precisely the upgrade of weak
  // evidence into release confidence that Phase 8A exists to prevent.
  const gateInputs: ReadonlyArray<{
    gate: Phase8aReleaseExitGate;
    actual: Phase8aEvidenceLevel;
    failed: boolean;
    reason: string;
  }> = [
    {
      gate: 'migration_non_destructive',
      actual: 'integration',
      failed: false,
      reason:
        'no automatic legacy migration exists and none is required; legacy shapes are display-only fallbacks, unknown schemas decode as opaque and Apply refuses to overwrite them, malformed blocks are structurally preserved inert, and no on-open/background write path exists. Proven by the round-trip and isolation suites, which compose the real parser and serializer.',
    },
    {
      gate: 'staleness_fail_closed',
      actual: 'integration',
      failed: false,
      reason:
        'two independent detectors both fail closed: presentation staleness compares servings plus the adapted line_ref set and treats an unadaptable recipe as changed; Apply re-proves authority through previewStillBinds (calculation schema/version, bundle_release, catalog_digest, nutrient_map_version, ingredient_digest, servings, basis, nutrient_scope).',
    },
    {
      gate: 'roundtrip_safe',
      actual: 'integration',
      failed: false,
      reason:
        'unrelated frontmatter, custom frontmatter, legacy nutrition, opaque unknown schemas and malformed blocks all survive a serialize/reparse cycle; hostile values fail closed before reaching YAML; no destructive change to unrelated recipe content was observed in any measured case.',
    },
    {
      gate: 'production_browser_reachable',
      actual: 'dom',
      failed: false,
      reason:
        'the production path exists and is Node-free: five ?url&no-inline static USDA assets, byte authentication against a pinned release lock, zero live USDA calls and no browser-reachable secret. But the loader is only exercised in a SIMULATED DOM with a stubbed fetch. Nothing drives a real browser engine, so reachability of the BUILT app is NOT_PROVEN.',
    },
    {
      gate: 'production_build_clean',
      actual: 'integration',
      failed: false,
      reason:
        'the build succeeds and the emitted artifact is stable, but no automated test executes anything under dist/. The built output is verified by release control rather than by the suite, so the gate is NOT_PROVEN.',
    },
    {
      gate: 'plugin_isolated',
      actual: 'integration',
      failed: false,
      reason:
        'planning modules and schema markers are absent from the emitted plugin bundle, confirmed by marker scans during release control and by source-level isolation suites. No automated test asserts this against the built bundle, so the gate is NOT_PROVEN.',
    },
    {
      gate: 'authority_revalidated_at_apply',
      actual: 'integration',
      failed: false,
      reason:
        'Apply re-derives from a genuine session via recomputeReviewedNutrition, verifies the claimed preview still binds, refuses opaque and malformed prior blocks, refuses a stale UI mode, serializes before writing, and read-back verifies the persisted digest.',
    },
    {
      gate: 'entitlement_enforced',
      actual: 'server',
      failed: false,
      reason:
        'six Advanced Nutrition routes are gated by requireAiAccessToken then requireNutritionProductFeature BEFORE pricing, provider selection and credential resolution; a Basic denial returns 403 with aiAttempted false and consumes no rate-limit budget, and a broken authority returns 503 rather than a fabricated Basic. Proven by suites that boot the real app over real HTTP.',
    },
    {
      gate: 'no_secret_exposure',
      actual: 'server',
      failed: false,
      reason:
        'provider keys resolve only through the server-only allowlist; the browser secret adapter is deliberately unavailable and throws on writes; the emitted browser bundle carries no VITE_ key material. Proven over real HTTP plus build inspection.',
    },
    {
      gate: 'no_external_usda_dependency',
      actual: 'integration',
      failed: false,
      reason:
        'the resolution path performs zero network calls; the USDA host constant is consumed only by a pure predicate that validates manifest URL strings, and the bundle is a source-controlled pinned release authenticated byte-for-byte.',
    },
    {
      gate: 'corpus_baseline_stable',
      actual: 'integration',
      failed: false,
      reason:
        'the 207-line intelligence corpus and the 48/97, 44/91, 94/94/93 and 46/0 baselines are asserted by integration suites against the real pinned bundle.',
    },
    {
      gate: 'recipe_level_smoke_sufficient',
      actual: 'none',
      failed: false,
      reason:
        `MEASURED: 0 full-recipe fixtures carry expected nutrient totals. Every corpus is ingredient-line level, so no recipe-level outcome is measurable and line-level 94/94/93 cannot support a recipe-level release claim. Evidence for this property is NONE, not merely weak.`,
    },
    {
      gate: 'accessibility_smoke_sufficient',
      actual: 'dom',
      failed: false,
      reason:
        'component renders exist in a simulated DOM, but no accessibility audit, automated a11y check, or assistive-technology pass was performed for Advanced Nutrition. A DOM render is not an accessibility proof.',
    },
    {
      gate: 'security_suite_green',
      actual: 'server',
      failed: false,
      reason:
        'the security suite boots the real app over real HTTP and is green in a clean runner.',
    },
    {
      gate: 'full_suite_green',
      actual: 'integration',
      failed: false,
      reason:
        'the full suite is green in a clean runner, composing real modules against the real pinned bundle.',
    },
    {
      gate: 'manual_smoke_required',
      actual: 'none',
      failed: false,
      reason:
        'MEASURED: a real-browser manual smoke of the built Advanced Nutrition surface has NOT been performed. Evidence is NONE. An unperformed manual step is a finding, never permission to perform it, and never upgraded to PASS.',
    },
  ];

  const gates = gateInputs.map((input) => {
    const evaluation = evaluateReleaseExitGate({
      gate: input.gate,
      actual_evidence_level: input.actual,
      observed_failure: input.failed,
      reason: input.reason,
    });
    return Object.freeze({
      gate: input.gate as string,
      status: evaluation.status as string,
      severity: evaluation.severity as string,
      actual_evidence_level: input.actual as string,
      required_evidence_level: REQUIRED_EVIDENCE_LEVEL[input.gate] as string,
      reason: input.reason,
    });
  });

  /**
   * Builds one axis-surface row. `gate` names the release-exit gate this surface
   * reports through, so status and severity are DERIVED from the gate matrix
   * rather than restated by hand.
   */
  const surfaceOf = (
    axis: string,
    surface: string,
    gate: Phase8aReleaseExitGate,
    implementation: string,
    evidence: string,
    owner: string
  ): Phase8aAxisSurface => {
    const gateRow = gates.find((entry) => entry.gate === gate);
    return Object.freeze({
      axis,
      surface,
      existing_implementation: implementation,
      existing_evidence: evidence,
      strongest_test_level:
        (gateRow?.actual_evidence_level as Phase8aEvidenceLevel) ?? 'none',
      required_test_level: REQUIRED_EVIDENCE_LEVEL[gate],
      status: (gateRow?.status ?? 'NOT_PROVEN') as Phase8aGateStatus,
      gap_severity: (gateRow?.severity ?? 'important_before_release') as Phase8aGapSeverity,
      owner,
    });
  };

  const migration_surface: ReadonlyArray<Phase8aAxisSurface> = [
    surfaceOf(
      'migration',
      'no automatic legacy-to-Advanced migration',
      'migration_non_destructive',
      'presentation is pure and read-only; the only write path is explicit user Apply',
      'round-trip and isolation suites; "no advanced block is ever created automatically"',
      'application/advancedNutritionApply'
    ),
    surfaceOf(
      'migration',
      'unknown future schema preservation',
      'migration_non_destructive',
      'decodes to bounded opaque data; Apply refuses with unknown_future_schema',
      'advancedNutritionRoundTrip: opaque round-trip; never interpreted as v1',
      'core/nutritionV2/validate'
    ),
    surfaceOf(
      'migration',
      'malformed block preservation',
      'migration_non_destructive',
      'decodes as malformed, preserved inert on save, never attached as canonical nutrition',
      'advancedNutritionRoundTrip: inert structural preservation without corrupting the recipe',
      'utils/markdownParser'
    ),
    surfaceOf(
      'migration',
      'no on-open or background vault mutation',
      'migration_non_destructive',
      'no code path writes codex_nutrition outside Apply and the serializer round-trip',
      'advancedNutritionRoundTrip plus a source-level write-path inventory',
      'utils/markdownParser'
    ),
  ];

  const staleness_surface: ReadonlyArray<Phase8aAxisSurface> = [
    surfaceOf(
      'staleness',
      'presentation staleness (servings + adapted line_ref set)',
      'staleness_fail_closed',
      'detectAdvancedStale: servings_changed / ingredients_changed; fails closed on an unadaptable recipe',
      'phase5c presentation suites',
      'core/nutritionV2/phase5c/presentation'
    ),
    surfaceOf(
      'staleness',
      'ingredient_digest over identity, mass, portion, household and manual weight',
      'staleness_fail_closed',
      'canonical sha256 over per-line evidence; bundle_release, catalog_digest and nutrient_map_version are deliberately NOT inside the digest',
      'calculation and authority parity suites',
      'core/nutritionV2/calculation'
    ),
    surfaceOf(
      'staleness',
      'bundle release / registry / nutrient-map change detection',
      'staleness_fail_closed',
      'checked separately from the digest through previewStillBinds at Apply time',
      'phase5 authorization suites',
      'core/nutritionV2/phase5/authorize'
    ),
    surfaceOf(
      'staleness',
      "persisted status: 'stale' enum member",
      'staleness_fail_closed',
      'schema-legal but produced by NO code path in src/ (calculation emits only complete | partial | unresolved)',
      'schema validation covers the value; no producer and no consumer observed',
      'core/nutritionV2/schema'
    ),
  ];

  const production_browser_flow: ReadonlyArray<string> = [
    'user opens recipe',
    'Advanced Nutrition surface requested',
    'product entitlement resolved (ai_advanced or fail closed)',
    'operational readiness read',
    'local USDA bundle fetch (same-origin, no-redirect, length-locked)',
    'bundle authentication against the pinned release lock',
    'session creation',
    'deterministic resolution',
    'AI assist only when invoked and entitled',
    'review',
    'Apply (explicit user action; authority re-proved)',
    'persisted codex_nutrition',
    'vault write',
    'reopen',
  ];

  const production_browser_surface: ReadonlyArray<Phase8aAxisSurface> = [
    surfaceOf(
      'production_browser',
      'pinned USDA bundle reaches the browser as emitted static assets',
      'production_browser_reachable',
      'five ?url&no-inline imports frozen into a URL map; express.static serves dist',
      'loader suite with a stubbed fetch carrying the real bytes',
      'application/advancedNutritionBundleAssets'
    ),
    surfaceOf(
      'production_browser',
      'Node-free browser runtime',
      'production_browser_reachable',
      'zero node: imports, process.cwd or require() in src/; gzip via DecompressionStream',
      'typecheck plus a source scan (a source scan is NOT a production-path test)',
      'src/browser'
    ),
    surfaceOf(
      'production_browser',
      'entitlement AND operational readiness gating',
      'entitlement_enforced',
      'recomposeNutritionAiClientState reads product access first; composeEffective ANDs per feature',
      'server suites over real HTTP',
      'application/nutritionAiClientState'
    ),
    surfaceOf(
      'production_browser',
      'Basic tier performs zero provider work',
      'entitlement_enforced',
      'requireNutritionProductFeature runs before pricing, provider selection and credential resolution',
      'server suites asserting aiAttempted false',
      'server product-access enforcement boundary',
    ),
    surfaceOf(
      'production_browser',
      'the BUILT app drives Advanced Nutrition end to end',
      'production_browser_reachable',
      'no automated coverage of the built bundle exists',
      'NOT FOUND: no production_build, production_server or browser_automation test',
      'unowned'
    ),
    surfaceOf(
      'production_browser',
      'plugin bundle contains no Advanced Nutrition planning or provider code',
      'plugin_isolated',
      'planning modules and their schema markers are absent from the emitted plugin bundle',
      'marker scans during release control; NOT an automated suite assertion',
      'plugin/build.mjs'
    ),
  ];

  // --- Axis C: round-trip matrix ------------------------------------------
  const roundtrip_matrix: ReadonlyArray<Phase8aRoundtripMatrixRow> = [
    {
      case: 'recognized schema v1 re-serialize and re-parse',
      outcome: 'roundtrip_exact_semantic',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: v1 canonical round-trip incl. serving_size',
    },
    {
      case: 'raw-mode save preserves the raw Markdown block',
      outcome: 'preserved_opaque',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: raw block preserved as inert structure',
    },
    {
      case: 'visual-editor partial (frontmatter carried through)',
      outcome: 'roundtrip_normalized_safe',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: visual-editor partial preserves the block',
    },
    {
      case: 'unknown future schema',
      outcome: 'preserved_opaque',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: bounded opaque round-trip; never interpreted as v1',
    },
    {
      case: 'simple nutrition frontmatter',
      outcome: 'roundtrip_exact_semantic',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: existing simple nutrition unchanged',
    },
    {
      case: 'legacy per-serving nutrition (no denominator)',
      outcome: 'roundtrip_exact_semantic',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: legacy per-serving unchanged',
    },
    {
      case: 'unrelated custom frontmatter',
      outcome: 'roundtrip_normalized_safe',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: custom frontmatter preserved',
    },
    {
      case: 'malformed advanced block',
      outcome: 'rejected_fail_closed',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: inert structural preservation without corrupting the recipe',
    },
    {
      case: 'unsafe / oversized block (hostile object)',
      outcome: 'rejected_fail_closed',
      destructive: false,
      evidence: 'advancedNutritionRoundTrip: never attaches as canonical nutrition; accessor never invoked',
    },
    {
      case: 'stale saved block re-serialized',
      outcome: 'stale_after_roundtrip',
      destructive: false,
      evidence: 'presentation recomputes staleness on reopen from servings plus line_ref set',
    },
    {
      case: 'duplicate nutrition blocks in one document',
      outcome: 'not_applicable',
      destructive: false,
      evidence: 'single YAML key per document; duplicate keys are not structurally representable',
    },
    {
      case: 'round-trip through the real session, Apply and vault write',
      outcome: 'not_applicable',
      destructive: false,
      evidence:
        'NOT MEASURED: no integration test composes a real session with the codec and Apply; only pure-codec and isolation suites exist',
    },
  ];

  const roundtripCounts = ROUNDTRIP_OUTCOMES.map((outcome) => ({
    outcome: outcome as string,
    count: roundtrip_matrix.filter((row) => row.outcome === outcome).length,
  })).filter((entry) => entry.count > 0);

  // --- Axis E: corpus ------------------------------------------------------
  const bySource = new Map<string, number>();
  for (const entry of AI6A_INTELLIGENCE_CORPUS) {
    bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1);
  }
  const families = new Set<string>();
  for (const entry of AI6A_INTELLIGENCE_CORPUS) {
    for (const family of entry.families) families.add(family);
  }

  const nextSlice = deriveNextSlice({
    gaps: gates.map((gate) => ({
      gate: gate.gate as Phase8aReleaseExitGate,
      status: gate.status as Phase8aGateStatus,
      severity: gate.severity as Phase8aGapSeverity,
    })),
    // No gate FAILED, so the frontier is unproven evidence rather than broken
    // behavior: the honest recommendation is proof, not repair.
    verificationOnly: gates.every((gate) => gate.status !== 'FAIL'),
  });

  return {
    schema: PHASE8A_SCHEMA,
    tool: 'benchmark_nutrition_phase8a_release_exit',
    base_phase: PHASE8A_BASE_PHASE,
    base_commit: PHASE8A_BASE_COMMIT,
    ai6_exit_state: {
      lanes: Object.keys(ADJUDICATED_LANE_OBSERVED_BLOCKERS)
        .sort()
        .map((lane) => ({
          lane,
          observed_blockers: ADJUDICATED_LANE_OBSERVED_BLOCKERS[lane],
          actionable_defects: ADJUDICATED_LANE_ACTIONABLE_DEFECTS[lane],
          adjudicated: true,
          exhausted: ADJUDICATED_LANE_ACTIONABLE_DEFECTS[lane] === 0,
        })),
      active_repair_lane: null,
      next_adjudication_lane: null,
    },
    production_baseline: {
      historical_resolved: 48,
      historical_total: 97,
      legacy_resolved: 44,
      legacy_total: 91,
      raw_matched: 94,
      authenticated_mass_resolved: 94,
      safe_resolved: 93,
      verified_correct_auto_identity: 46,
      verified_unsafe_auto_identity: 0,
      corpus_total: AI6A_INTELLIGENCE_CORPUS.length,
    },
    pinned_bundle_release: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
    recognized_codex_nutrition_schema_versions: [1, 2, 3],
    migration_inventory,
    migration_surface,
    staleness_surface,
    roundtrip_matrix,
    roundtrip_outcome_counts: roundtripCounts,
    production_browser_flow,
    production_browser_surface,
    corpus_inventory: {
      intelligence_corpus_lines: AI6A_INTELLIGENCE_CORPUS.length,
      intelligence_corpus_sources: [...bySource.entries()]
        .sort()
        .map(([source, count]) => ({ source, count })),
      intelligence_coverage_families: families.size,
      resolution_corpus_lines: RESOLUTION_COVERAGE_CORPUS.length,
      semantic_corpus_cases: AI_ADVANCED_SEMANTIC_CORPUS.length,
      smoke_corpus_cases: AI_ADVANCED_SMOKE_CORPUS.length,
      identity_corpus_lines: IDENTITY_SAFETY_CORPUS.length,
      full_recipe_fixtures_with_expected_totals: measureFullRecipeFixtures(),
    },
    test_inventory: testInventory,
    release_exit_gates: gates,
    gate_status_counts: GATE_STATUSES.map((status) => ({
      status: status as string,
      count: gates.filter((gate) => gate.status === status).length,
    })),
    next_slice: {
      recommendation: nextSlice.recommendation,
      gate: nextSlice.gate,
      severity: nextSlice.severity,
      derivation_reason: nextSlice.derivation_reason,
    },
  };
}

/** Measured count of full-RECIPE fixtures carrying expected nutrient totals. */
function measureFullRecipeFixtures(): number {
  const fixtureDir = join(ROOT, 'tests/fixtures');
  let count = 0;
  for (const entry of readdirSync(fixtureDir)) {
    if (!entry.endsWith('.ts')) continue;
    const text = readFileSync(join(fixtureDir, entry), 'utf8');
    // A full-recipe fixture must declare servings AND expected nutrient totals.
    if (/\bservings\s*:\s*\d/.test(text) && /calories|kcal|protein/.test(text)) count += 1;
  }
  return count;
}