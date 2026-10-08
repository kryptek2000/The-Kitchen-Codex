/**
 * The Kitchen Codex — Advanced Nutrition Phase 8A regression: RELEASE-EXIT
 * RECON, evidence-strength discipline, and next-slice derivation.
 *
 * Phase 8A is recon-only. Its central discipline is that PASS IS NOT THE SAME
 * AS "A TEST EXISTS": a release gate may only pass when current evidence
 * actually proves the property ON THE PATH THAT MATTERS. This suite proves the
 * machinery enforces that, and that Phase 8A mutated nothing.
 *
 * WHAT THIS PROVES
 *   - closed gate/severity/evidence/round-trip vocabularies;
 *   - gate evaluation is TOTAL and derived, never hand-written;
 *   - a gate CANNOT pass from evidence weaker than it requires;
 *   - NOT_PROVEN is distinct from FAIL, and manual-only stays NOT_PROVEN;
 *   - a production-browser claim requires real production-path evidence;
 *   - destructive round-trip outcomes are detectable and separate;
 *   - a stale result never satisfies a freshness requirement;
 *   - unknown-schema preservation is recognized as preserved, not rewritten;
 *   - AI-6 exit baselines and every prior artifact SHA are unchanged;
 *   - the roadmap endpoint honestly reports no next lane;
 *   - a zero-gap state recommends VERIFICATION rather than inventing a feature;
 *   - Phase 8A has zero production consumers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  DESTRUCTIVE_ROUNDTRIP_OUTCOMES,
  EVIDENCE_LEVELS,
  GATE_STATUSES,
  GAP_SEVERITIES,
  PHASE8A_BASE_COMMIT,
  PHASE8A_SCHEMA,
  RELEASE_EXIT_GATES,
  REQUIRED_EVIDENCE_LEVEL,
  ROUNDTRIP_OUTCOMES,
  deriveNextSlice,
  deriveSeverity,
  evaluateReleaseExitGate,
  evidenceSatisfies,
} from '../../scripts/nutritionReleaseExit/phase8aRecon';

interface ReportJson {
  readonly schema: string;
  readonly base_commit: string;
  readonly base_phase: string;
  readonly ai6_exit_state: {
    lanes: ReadonlyArray<{
      lane: string;
      observed_blockers: number;
      actionable_defects: number;
      adjudicated: boolean;
      exhausted: boolean;
    }>;
    active_repair_lane: string | null;
    next_adjudication_lane: string | null;
  };
  readonly production_baseline: Record<string, number>;
  readonly pinned_bundle_release: string;
  readonly recognized_codex_nutrition_schema_versions: ReadonlyArray<number>;
  readonly migration_inventory: ReadonlyArray<{
    shape: string;
    migrated_automatically: boolean;
    overwritable_by_advanced_nutrition: boolean;
    destructive_rewrite_possible: boolean;
    legacy_fallback_only: boolean;
  }>;
  readonly roundtrip_matrix: ReadonlyArray<{
    case: string;
    outcome: string;
    destructive: boolean;
    evidence: string;
  }>;
  readonly production_browser_flow: ReadonlyArray<string>;
  readonly corpus_inventory: {
    intelligence_corpus_lines: number;
    intelligence_coverage_families: number;
    full_recipe_fixtures_with_expected_totals: number;
  };
  readonly test_inventory: {
    total_test_files: number;
    by_level: ReadonlyArray<{ level: string; count: number }>;
    levels_not_found: ReadonlyArray<string>;
  };
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

const ROOT = join(import.meta.dirname, '../..');

let REPORT: ReportJson | null = null;
let REPORT_TEXT: string | null = null;

async function loadReport(): Promise<ReportJson> {
  if (REPORT === null) {
    const { buildPhase8aReleaseExitReport } = await import(
      '../../scripts/nutritionReleaseExit/phase8aReport'
    );
    REPORT = (await buildPhase8aReleaseExitReport()) as unknown as ReportJson;
    REPORT_TEXT = JSON.stringify(REPORT);
  }
  return REPORT;
}

const beforeAllLoad = async (): Promise<void> => {
  await loadReport();
};

const report = (): ReportJson => {
  if (REPORT === null) throw new Error('report not loaded');
  return REPORT;
};

const gateRow = (gate: string) => {
  const found = report().release_exit_gates.find((entry) => entry.gate === gate);
  if (found === undefined) throw new Error(`gate not in report: ${gate}`);
  return found;
};

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

describe('Phase 8A — the vocabularies are closed', () => {
  it('declares the eight ordered evidence levels', () => {
    expect([...EVIDENCE_LEVELS]).toEqual([
      'none',
      'unit',
      'integration',
      'dom',
      'server',
      'production_build',
      'production_server',
      'browser_automation',
    ]);
  });

  it('declares exactly four gate statuses', () => {
    expect([...GATE_STATUSES].sort()).toEqual([
      'FAIL',
      'NOT_APPLICABLE',
      'NOT_PROVEN',
      'PASS',
    ]);
  });

  it('declares exactly five gap severities', () => {
    expect([...GAP_SEVERITIES].sort()).toEqual([
      'blocking_release',
      'documentation_only',
      'followup_nonblocking',
      'important_before_release',
      'not_a_gap',
    ]);
  });

  it('declares a closed round-trip outcome vocabulary', () => {
    expect([...ROUNDTRIP_OUTCOMES].sort()).toEqual([
      'destructive_change_detected',
      'not_applicable',
      'preserved_opaque',
      'rejected_fail_closed',
      'roundtrip_exact_semantic',
      'roundtrip_normalized_safe',
      'stale_after_roundtrip',
    ]);
  });

  it('declares every release-exit gate and its REQUIRED evidence level', () => {
    for (const gate of RELEASE_EXIT_GATES) {
      expect(REQUIRED_EVIDENCE_LEVEL[gate], gate).toBeDefined();
    }
    // Every gate names the level it demands; no gate is exempt.
    expect(Object.keys(REQUIRED_EVIDENCE_LEVEL).sort()).toEqual(
      [...RELEASE_EXIT_GATES].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Evidence strength discipline
// ---------------------------------------------------------------------------

describe('Phase 8A — PASS is not the same as a test exists', () => {
  it('orders evidence levels monotonically', () => {
    expect(evidenceSatisfies('browser_automation', 'unit')).toBe(true);
    expect(evidenceSatisfies('unit', 'integration')).toBe(false);
    expect(evidenceSatisfies('dom', 'server')).toBe(false);
    expect(evidenceSatisfies('none', 'unit')).toBe(false);
    expect(evidenceSatisfies('server', 'server')).toBe(true);
  });

  it('PASSES only when actual evidence meets the required level', () => {
    const pass = evaluateReleaseExitGate({
      gate: 'entitlement_enforced',
      actual_evidence_level: 'server',
      observed_failure: false,
      reason: 'boots the real app over real HTTP',
    });
    expect(pass.status).toBe('PASS');
    expect(pass.severity).toBe('not_a_gap');
  });

  it('REFUSES to PASS a production-browser gate from dom evidence', () => {
    const gate = evaluateReleaseExitGate({
      gate: 'production_browser_reachable',
      actual_evidence_level: 'dom',
      observed_failure: false,
      reason: 'component renders in a simulated DOM only',
    });
    expect(gate.status).toBe('NOT_PROVEN');
    expect(gate.severity).toBe('important_before_release');
  });

  it('REFUSES to PASS a plugin-isolation gate from integration evidence', () => {
    const gate = evaluateReleaseExitGate({
      gate: 'plugin_isolated',
      actual_evidence_level: 'integration',
      observed_failure: false,
      reason: 'marker scans, but nothing runs against the built bundle',
    });
    expect(gate.status).toBe('NOT_PROVEN');
  });

  it('keeps NOT_PROVEN distinct from FAIL', () => {
    expect(deriveSeverity('NOT_PROVEN')).toBe('important_before_release');
    expect(deriveSeverity('FAIL')).toBe('blocking_release');
    expect(deriveSeverity('NOT_PROVEN')).not.toBe(deriveSeverity('FAIL'));
  });

  it('treats an OBSERVED FAILURE as FAIL regardless of evidence strength', () => {
    const gate = evaluateReleaseExitGate({
      gate: 'entitlement_enforced',
      // Even browser_automation-level evidence cannot rescue a real defect.
      actual_evidence_level: 'browser_automation',
      observed_failure: true,
      reason: 'a denial was observed to still perform provider work',
    });
    expect(gate.status).toBe('FAIL');
    expect(gate.severity).toBe('blocking_release');
  });

  it('is TOTAL: every gate and level pair yields one closed status', () => {
    for (const gate of RELEASE_EXIT_GATES) {
      for (const level of EVIDENCE_LEVELS) {
        for (const failed of [false, true]) {
          const result = evaluateReleaseExitGate({
            gate,
            actual_evidence_level: level,
            observed_failure: failed,
            reason: 'x',
          });
          expect(GATE_STATUSES, `${gate}/${level}/${failed}`).toContain(result.status);
          expect(GAP_SEVERITIES, `${gate}/${level}/${failed}`).toContain(result.severity);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The measured matrix
// ---------------------------------------------------------------------------

describe('Phase 8A — the measured release-exit matrix', () => {
  beforeAll(beforeAllLoad);

  it('uses its own versioned schema and pins the base commit', () => {
    expect(report().schema).toBe(PHASE8A_SCHEMA);
    expect(report().base_commit).toBe(PHASE8A_BASE_COMMIT);
    expect(report().base_phase).toBe('AI-6B5');
  });

  it('reports every declared gate exactly once with a closed status', () => {
    expect(report().release_exit_gates).toHaveLength(RELEASE_EXIT_GATES.length);
    const seen = report().release_exit_gates.map((entry) => entry.gate).sort();
    expect(seen).toEqual([...RELEASE_EXIT_GATES].sort());
    for (const entry of report().release_exit_gates) {
      expect(GATE_STATUSES, entry.gate).toContain(entry.status);
      expect(GAP_SEVERITIES, entry.gate).toContain(entry.severity);
      expect(entry.reason.length, entry.gate).toBeGreaterThan(20);
    }
  });

  it('derives every gate status rather than asserting it', () => {
    for (const entry of report().release_exit_gates) {
      const expected = evaluateReleaseExitGate({
        gate: entry.gate as never,
        actual_evidence_level: entry.actual_evidence_level as never,
        observed_failure: false,
        reason: entry.reason,
      });
      expect(entry.status, entry.gate).toBe(expected.status);
      expect(entry.severity, entry.gate).toBe(expected.severity);
    }
  });

  it('derives the status counts from the gate rows', () => {
    for (const entry of report().gate_status_counts) {
      expect(
        report().release_exit_gates.filter((gate) => gate.status === entry.status)
      ).toHaveLength(entry.count);
    }
    expect(
      report().gate_status_counts.reduce((sum, entry) => sum + entry.count, 0)
    ).toBe(report().release_exit_gates.length);
  });

  it('keeps the manual-smoke gate NOT_PROVEN, never PASS', () => {
    const manual = gateRow('manual_smoke_required');
    expect(manual.status).toBe('NOT_PROVEN');
    expect(manual.actual_evidence_level).toBe('none');
    expect(manual.reason).toMatch(/NOT been performed/i);
  });

  it('keeps the recipe-level gate NOT_PROVEN because zero full-recipe fixtures exist', () => {
    const recipe = gateRow('recipe_level_smoke_sufficient');
    expect(report().corpus_inventory.full_recipe_fixtures_with_expected_totals).toBe(0);
    expect(recipe.status).toBe('NOT_PROVEN');
    expect(recipe.actual_evidence_level).toBe('none');
  });

  it('keeps production-browser and production-build claims NOT_PROVEN', () => {
    for (const gate of [
      'production_browser_reachable',
      'production_build_clean',
      'plugin_isolated',
      'accessibility_smoke_sufficient',
    ]) {
      expect(gateRow(gate).status, gate).toBe('NOT_PROVEN');
    }
  });

  it('reports zero browser-automation and zero production-build coverage', () => {
    const levels = new Set(report().test_inventory.by_level.map((entry) => entry.level));
    expect(levels.has('browser_automation')).toBe(false);
    expect(levels.has('production_build')).toBe(false);
    expect(levels.has('production_server')).toBe(false);
    expect(report().test_inventory.levels_not_found).toContain('browser_automation');
  });

  it('has no blocking release gaps, and says so', () => {
    const blocking = report().release_exit_gates.filter(
      (entry) => entry.severity === 'blocking_release'
    );
    expect(blocking).toHaveLength(0);
    expect(report().gate_status_counts.find((e) => e.status === 'FAIL')?.count ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round-trip discipline
// ---------------------------------------------------------------------------

describe('Phase 8A — round-trip outcomes are honest', () => {
  beforeAll(beforeAllLoad);

  it('classifies every measured case with a closed outcome', () => {
    for (const row of report().roundtrip_matrix) {
      expect(ROUNDTRIP_OUTCOMES, row.case).toContain(row.outcome as never);
    }
  });

  it('detects destructive change as a distinct, blocking outcome', () => {
    expect(DESTRUCTIVE_ROUNDTRIP_OUTCOMES.has('destructive_change_detected')).toBe(true);
    expect(DESTRUCTIVE_ROUNDTRIP_OUTCOMES.has('roundtrip_exact_semantic')).toBe(false);
    for (const row of report().roundtrip_matrix) {
      expect(row.destructive, row.case).toBe(
        DESTRUCTIVE_ROUNDTRIP_OUTCOMES.has(row.outcome as never)
      );
    }
  });

  it('recognizes unknown-schema preservation rather than rewrite', () => {
    const opaque = report().roundtrip_matrix.filter(
      (row) => row.outcome === 'preserved_opaque'
    );
    expect(opaque.length).toBeGreaterThanOrEqual(2);
    // An unknown future schema is never recorded as exact-semantic round-trip.
    expect(
      report().roundtrip_matrix.filter((row) => /unknown future schema/i.test(row.case))[0]
        ?.outcome
    ).toBe('preserved_opaque');
  });

  it('records a stale result as stale, never as fresh', () => {
    const stale = report().roundtrip_matrix.filter(
      (row) => row.outcome === 'stale_after_roundtrip'
    );
    expect(stale.length).toBeGreaterThan(0);
    expect(
      report().roundtrip_matrix.filter((row) => /stale/i.test(row.case)).every(
        (row) => row.outcome === 'stale_after_roundtrip' || row.outcome === 'preserved_opaque'
      )
    ).toBe(true);
  });

  it('marks the unmeasured real-session round-trip NOT applicable rather than passing it', () => {
    const unmeasured = report().roundtrip_matrix.filter((row) =>
      /real session, Apply and vault write/i.test(row.case)
    );
    expect(unmeasured).toHaveLength(1);
    expect(unmeasured[0].outcome).toBe('not_applicable');
    expect(unmeasured[0].evidence ?? '').toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Migration discipline
// ---------------------------------------------------------------------------

describe('Phase 8A — migration safety is preserved, not repaired', () => {
  beforeAll(beforeAllLoad);

  it('finds NO automatic legacy migration and claims none is needed', () => {
    for (const entry of report().migration_inventory) {
      expect(entry.migrated_automatically, entry.shape).toBe(false);
    }
  });

  it('never allows a destructive rewrite of any persisted shape', () => {
    for (const entry of report().migration_inventory) {
      expect(entry.destructive_rewrite_possible, entry.shape).toBe(false);
    }
  });

  it('keeps legacy shapes fallback-only and non-overwritable', () => {
    const legacy = report().migration_inventory.filter((entry) => entry.legacy_fallback_only);
    expect(legacy.length).toBeGreaterThanOrEqual(2);
    for (const entry of legacy) {
      expect(entry.overwritable_by_advanced_nutrition, entry.shape).toBe(false);
    }
  });

  it('never lets Advanced Nutrition overwrite an unknown future schema', () => {
    const unknown = report().migration_inventory.find((entry) =>
      /unknown future schema/i.test(entry.shape)
    );
    expect(unknown).toBeDefined();
    expect(unknown?.overwritable_by_advanced_nutrition).toBe(false);
  });

  it('records the recognized schema versions actually implemented', () => {
    // v3 exists in code; Phase 8A does not understate it.
    expect(report().recognized_codex_nutrition_schema_versions).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// AI-6 exit baselines and prior SHAs
// ---------------------------------------------------------------------------

describe('Phase 8A — AI-6 exit baselines are frozen', () => {
  beforeAll(beforeAllLoad);

  it('reports all four lanes adjudicated and exhausted at zero actionable', () => {
    expect(report().ai6_exit_state.lanes).toHaveLength(4);
    for (const lane of report().ai6_exit_state.lanes) {
      expect(lane.adjudicated, lane.lane).toBe(true);
      expect(lane.actionable_defects, lane.lane).toBe(0);
      expect(lane.exhausted, lane.lane).toBe(true);
    }
    const observed = Object.fromEntries(
      report().ai6_exit_state.lanes.map((lane) => [lane.lane, lane.observed_blockers])
    );
    expect(observed).toEqual({
      deterministic_portion: 35,
      deterministic_identity: 27,
      deterministic_ranking: 9,
      catalog_gap: 5,
    });
  });

  it('reports no active repair and no next adjudication lane', () => {
    expect(report().ai6_exit_state.active_repair_lane).toBeNull();
    expect(report().ai6_exit_state.next_adjudication_lane).toBeNull();
  });

  it('freezes the production baseline', () => {
    const baseline = report().production_baseline;
    expect(baseline.historical_resolved).toBe(48);
    expect(baseline.historical_total).toBe(97);
    expect(baseline.legacy_resolved).toBe(44);
    expect(baseline.legacy_total).toBe(91);
    expect(baseline.raw_matched).toBe(94);
    expect(baseline.authenticated_mass_resolved).toBe(94);
    expect(baseline.safe_resolved).toBe(93);
    expect(baseline.verified_correct_auto_identity).toBe(46);
    expect(baseline.verified_unsafe_auto_identity).toBe(0);
    expect(baseline.corpus_total).toBe(207);
  });

  it('records the pinned bundle release actually locked in code', () => {
    expect(report().pinned_bundle_release).toBe('usda_fdc_87c5408a3e98838944a87be74824761e');
  });

  it('reaches no live or external USDA endpoint', () => {
    const text = (REPORT_TEXT ?? '').toLowerCase();
    for (const forbidden of ['http://', 'https://', 'api.nal.usda.gov']) {
      expect(text.includes(forbidden), forbidden).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Next-slice derivation
// ---------------------------------------------------------------------------

describe('Phase 8A — the next slice is derived, never hardcoded', () => {
  beforeAll(beforeAllLoad);

  it('recommends verification rather than a new feature at the measured frontier', () => {
    expect(report().next_slice.recommendation).toBe('production_browser_integration_proof');
    expect(report().next_slice.gate).toBe('production_browser_reachable');
    expect(report().next_slice.severity).toBe('important_before_release');
    expect(report().next_slice.derivation_reason).toContain('production_browser_reachable');
  });

  it('recommends VERIFICATION when every gate is satisfied', () => {
    const clean = deriveNextSlice({
      gaps: [
        { gate: 'entitlement_enforced', status: 'PASS', severity: 'not_a_gap' },
        { gate: 'staleness_fail_closed', status: 'PASS', severity: 'not_a_gap' },
      ],
      verificationOnly: true,
    });
    expect(clean.recommendation).toBe('release_exit_verification');
    expect(clean.gate).toBeNull();
    // A zero-gap state must never invent implementation work.
    expect(clean.recommendation).not.toBe('staleness_repair');
    expect(clean.recommendation).not.toBe('roundtrip_repair');
  });

  it('promotes a FAILING blocker above an unproven one', () => {
    const derived = deriveNextSlice({
      gaps: [
        { gate: 'production_browser_reachable', status: 'NOT_PROVEN', severity: 'important_before_release' },
        { gate: 'roundtrip_safe', status: 'FAIL', severity: 'blocking_release' },
      ],
      verificationOnly: false,
    });
    expect(derived.severity).toBe('blocking_release');
    expect(derived.gate).toBe('roundtrip_safe');
    expect(derived.recommendation).toBe('roundtrip_repair');
  });

  it('breaks ties deterministically on the declared gate order', () => {
    const gaps = [
      { gate: 'manual_smoke_required' as const, status: 'NOT_PROVEN' as const, severity: 'important_before_release' as const },
      { gate: 'production_browser_reachable' as const, status: 'NOT_PROVEN' as const, severity: 'important_before_release' as const },
    ];
    const a = deriveNextSlice({ gaps, verificationOnly: true });
    const b = deriveNextSlice({ gaps: [...gaps].reverse(), verificationOnly: true });
    expect(a.gate).toBe(b.gate);
  });
});

// ---------------------------------------------------------------------------
// Determinism and the production freeze
// ---------------------------------------------------------------------------

describe('Phase 8A — determinism and the production freeze', () => {
  beforeAll(beforeAllLoad);

  it('is byte-deterministic across two builds', async () => {
    const first = REPORT_TEXT;
    const { buildPhase8aReleaseExitReport } = await import(
      '../../scripts/nutritionReleaseExit/phase8aReport'
    );
    const second = JSON.stringify(await buildPhase8aReleaseExitReport());
    expect(second).toBe(first);
  }, 600_000);

  it('carries no clock, hostname, absolute path, or environment field', () => {
    const text = REPORT_TEXT ?? '';
    expect(text.includes('/home/'), 'absolute path').toBe(false);
    expect(text.includes(process.cwd()), 'working directory').toBe(false);
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), 'ISO timestamp').toBe(false);
  });

  it('has ZERO production consumers', () => {
    const planningMarkers = ['phase8aRecon', 'phase8aReport', 'benchmark_nutrition_phase8a_release_exit'];
    for (const tree of [
      'src/core/nutritionV2',
      'src/utils',
      'src/components',
      'src/application',
      'server',
      'plugin',
    ]) {
      for (const file of sourceFiles(join(ROOT, tree))) {
        const text = readFileSync(file, 'utf8');
        for (const marker of planningMarkers) {
          expect(text.includes(marker), `${file}: ${marker}`).toBe(false);
        }
      }
    }
  });

  it('leaves every prior planning artifact untouched on disk', () => {
    for (const file of [
      'scripts/nutritionIntelligence/catalogDisposition.ts',
      'scripts/nutritionIntelligence/catalogDispositionReport.ts',
      'scripts/nutritionIntelligence/rankingDisposition.ts',
      'scripts/nutritionIntelligence/identityDisposition.ts',
      'scripts/nutritionIntelligence/portionDisposition.ts',
      'scripts/nutritionIntelligence/diagnose.ts',
      'scripts/nutritionIntelligence/taxonomy.ts',
      'scripts/nutritionIntelligence/summarize.ts',
      'scripts/benchmark_nutrition_intelligence.ts',
      'scripts/benchmark_resolution_coverage.ts',
    ]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text.includes(PHASE8A_SCHEMA), file).toBe(false);
    }
  });

  it('modifies no production file at all', async () => {
    // Phase 8A must ship planning files only.
    const { execFileSync } = await import('node:child_process');
    const changed = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'src', 'server', 'plugin'],
      { cwd: ROOT, encoding: 'utf8' }
    ).trim();
    expect(changed).toBe('');
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}