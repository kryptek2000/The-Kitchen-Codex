/**
 * The Kitchen Codex — Advanced Nutrition Phase 8A: RELEASE-EXIT RECON
 * (planning only, zero production consumers).
 *
 * WHY THIS EXISTS
 * ---------------
 * AI-6B is complete. Four observable lanes are adjudicated and exhausted at ZERO
 * actionable defects each:
 *
 *   deterministic_portion  35 observed / 0 actionable / exhausted
 *   deterministic_identity 27 observed / 0 actionable / exhausted
 *   deterministic_ranking   9 observed / 0 actionable / exhausted
 *   catalog_gap             5 observed / 0 actionable / exhausted
 *
 * Active repair: none. Next adjudication: none. There is therefore NO measured
 * evidence justifying a fifth deterministic lane, and inventing one would be
 * scoreboard churn rather than engineering. The canonical roadmap's next real
 * program is Phase 8 — the broader final migration, staleness, round-trip,
 * production-browser, corpus, and release-exit program.
 *
 * Phase 8A is RECON ONLY. It establishes the exact release-exit surface. It
 * implements no repair, mutates no production behavior, and grants no authority.
 *
 * PASS IS NOT THE SAME AS "A TEST EXISTS"
 * ----------------------------------------
 * A release gate passes only when current evidence actually PROVES the property
 * on the path that matters. A unit test that exercises a codec does not prove the
 * browser bundle works. A jsdom render does not prove the production build works.
 * A manual smoke that was never performed is NOT_PROVEN, never PASS. This module
 * therefore models evidence STRENGTH explicitly and refuses to upgrade weak
 * evidence into release confidence.
 *
 * Pure, offline, deterministic: no clock, randomness, hostname, absolute path, or
 * environment-dependent field, so two runs are byte-identical.
 */

/** Explicit planning-artifact schema version (independent of every recon schema). */
export const PHASE8A_SCHEMA = 'nutrition_phase8a_release_exit_recon_v1';

/** The base commit this recon is measured against. Pinned so HEAD cannot perturb it. */
export const PHASE8A_BASE_COMMIT = '150b68582213ae4b63a06e92f083fb70d8568a85';
export const PHASE8A_BASE_PHASE = 'AI-6B5';

// ---------------------------------------------------------------------------
// CLOSED evidence-strength taxonomy
// ---------------------------------------------------------------------------

/**
 * The STRONGEST level a body of evidence actually exercises. Ordered weakest to
 * strongest; comparison is by index.
 */
export const EVIDENCE_LEVELS = [
  /** Pure logic, no I/O, no composition. */
  'none',
  /** Pure logic over in-memory values. */
  'unit',
  /** Composes several REAL modules in-process against real inputs. */
  'integration',
  /** Renders real components in a simulated DOM. */
  'dom',
  /** Boots the real Express app and speaks real HTTP to it. */
  'server',
  /** Exercises the actual `dist/` build output. */
  'production_build',
  /** Boots the BUILT server and drives it over HTTP. */
  'production_server',
  /** Drives a real browser engine. */
  'browser_automation',
] as const;

export type Phase8aEvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

const LEVEL_ORDER: ReadonlyMap<string, number> = new Map(
  EVIDENCE_LEVELS.map((level, index) => [level, index])
);

function levelRank(level: Phase8aEvidenceLevel): number {
  return LEVEL_ORDER.get(level) ?? 0;
}

/** True when actual evidence is at least as strong as required. */
export function evidenceSatisfies(
  actual: Phase8aEvidenceLevel,
  required: Phase8aEvidenceLevel
): boolean {
  return levelRank(actual) >= levelRank(required);
}

// ---------------------------------------------------------------------------
// CLOSED gate status vocabulary
// ---------------------------------------------------------------------------

/**
 * A gate is PASS, FAIL, NOT_PROVEN, or NOT_APPLICABLE. There is no "looks good".
 */
export const GATE_STATUSES = ['PASS', 'FAIL', 'NOT_PROVEN', 'NOT_APPLICABLE'] as const;

export type Phase8aGateStatus = (typeof GATE_STATUSES)[number];

// ---------------------------------------------------------------------------
// CLOSED gap-severity vocabulary
// ---------------------------------------------------------------------------

export const GAP_SEVERITIES = [
  'blocking_release',
  'important_before_release',
  'followup_nonblocking',
  'documentation_only',
  'not_a_gap',
] as const;

export type Phase8aGapSeverity = (typeof GAP_SEVERITIES)[number];

/** Derive a severity from a gate status. NOT_PROVEN is not the same as FAIL. */
export function deriveSeverity(status: Phase8aGateStatus): Phase8aGapSeverity {
  switch (status) {
    case 'PASS':
    case 'NOT_APPLICABLE':
      return 'not_a_gap';
    case 'FAIL':
      return 'blocking_release';
    case 'NOT_PROVEN':
    default:
      // An unproven property is not a demonstrated defect, but it cannot support
      // a release-exit claim either, so it is important-before-release.
      return 'important_before_release';
  }
}

// ---------------------------------------------------------------------------
// CLOSED round-trip outcome vocabulary
// ---------------------------------------------------------------------------

export const ROUNDTRIP_OUTCOMES = [
  'roundtrip_exact_semantic',
  'roundtrip_normalized_safe',
  'preserved_opaque',
  'rejected_fail_closed',
  'stale_after_roundtrip',
  'destructive_change_detected',
  'not_applicable',
] as const;

export type Phase8aRoundtripOutcome = (typeof ROUNDTRIP_OUTCOMES)[number];

/** Outcomes that would BLOCK a future release if observed. */
export const DESTRUCTIVE_ROUNDTRIP_OUTCOMES: ReadonlySet<Phase8aRoundtripOutcome> = new Set([
  'destructive_change_detected',
]);

// ---------------------------------------------------------------------------
// CLOSED release-exit gate vocabulary
// ---------------------------------------------------------------------------

export const RELEASE_EXIT_GATES = [
  'migration_non_destructive',
  'staleness_fail_closed',
  'roundtrip_safe',
  'production_browser_reachable',
  'production_build_clean',
  'plugin_isolated',
  'authority_revalidated_at_apply',
  'entitlement_enforced',
  'no_secret_exposure',
  'no_external_usda_dependency',
  'corpus_baseline_stable',
  'recipe_level_smoke_sufficient',
  'accessibility_smoke_sufficient',
  'security_suite_green',
  'full_suite_green',
  'manual_smoke_required',
] as const;

export type Phase8aReleaseExitGate = (typeof RELEASE_EXIT_GATES)[number];

/**
 * The evidence level each gate actually REQUIRES before it may be called PASS.
 * This is the load-bearing table: it is what stops a unit test from standing in
 * for production-browser proof.
 */
export const REQUIRED_EVIDENCE_LEVEL: Readonly<Record<Phase8aReleaseExitGate, Phase8aEvidenceLevel>> =
  Object.freeze({
    migration_non_destructive: 'integration',
    staleness_fail_closed: 'integration',
    roundtrip_safe: 'integration',
    production_browser_reachable: 'browser_automation',
    production_build_clean: 'production_build',
    plugin_isolated: 'production_build',
    authority_revalidated_at_apply: 'integration',
    entitlement_enforced: 'server',
    no_secret_exposure: 'server',
    no_external_usda_dependency: 'integration',
    corpus_baseline_stable: 'integration',
    recipe_level_smoke_sufficient: 'integration',
    accessibility_smoke_sufficient: 'browser_automation',
    security_suite_green: 'server',
    full_suite_green: 'integration',
    manual_smoke_required: 'browser_automation',
  });

export interface Phase8aGateEvaluationInput {
  readonly gate: Phase8aReleaseExitGate;
  /** Strongest level of evidence that actually exists for this property today. */
  readonly actual_evidence_level: Phase8aEvidenceLevel;
  /** True when a documented defect has been observed for this property. */
  readonly observed_failure: boolean;
  /** Bounded, factual reason for the status. Never vague. */
  readonly reason: string;
}

/**
 * Derives a gate status. This is the ONLY place a gate status is produced.
 *
 * The order matters and encodes the evidence-strength rules:
 *   1. An OBSERVED FAILURE is FAIL, regardless of any other evidence.
 *   2. Evidence weaker than the gate requires is NOT_PROVEN — never PASS.
 *   3. Only evidence at or above the required level can PASS.
 */
export function evaluateReleaseExitGate(
  input: Phase8aGateEvaluationInput
): { status: Phase8aGateStatus; severity: Phase8aGapSeverity } {
  if (input.observed_failure) {
    return { status: 'FAIL', severity: deriveSeverity('FAIL') };
  }
  if (!evidenceSatisfies(input.actual_evidence_level, REQUIRED_EVIDENCE_LEVEL[input.gate])) {
    return { status: 'NOT_PROVEN', severity: deriveSeverity('NOT_PROVEN') };
  }
  return { status: 'PASS', severity: deriveSeverity('PASS') };
}

// ---------------------------------------------------------------------------
// Next-slice derivation (planning only, never authorization)
// ---------------------------------------------------------------------------

export const PHASE8_NEXT_SLICE_PRIORITY: ReadonlyArray<Phase8aGapSeverity> = [
  'blocking_release',
  'important_before_release',
  'followup_nonblocking',
  'documentation_only',
  'not_a_gap',
];

export interface Phase8aNextSliceInput {
  readonly gaps: ReadonlyArray<{
    readonly gate: Phase8aReleaseExitGate;
    readonly status: Phase8aGateStatus;
    readonly severity: Phase8aGapSeverity;
  }>;
  /**
   * True when the strongest remaining work is EVIDENCE rather than behavior. In
   * that case the recommendation is verification, not a new feature.
   */
  readonly verificationOnly: boolean;
}

export interface Phase8aNextSlice {
  /** Closed vocabulary of recommended next work. Planning only. */
  readonly recommendation:
    | 'release_exit_verification'
    | 'production_browser_integration_proof'
    | 'staleness_repair'
    | 'roundtrip_repair'
    | 'migration_non_destruction_repair'
    | 'recipe_level_corpus_expansion'
    | 'accessibility_verification'
    | 'none';
  readonly gate: Phase8aReleaseExitGate | null;
  readonly severity: Phase8aGapSeverity;
  readonly derivation_reason: string;
}

/** Maps an unresolved gate to the work that would actually close it. */
const GATE_REMEDIATION: Readonly<Partial<Record<Phase8aReleaseExitGate, Phase8aNextSlice['recommendation']>>> =
  Object.freeze({
    production_browser_reachable: 'production_browser_integration_proof',
    production_build_clean: 'production_browser_integration_proof',
    plugin_isolated: 'production_browser_integration_proof',
    accessibility_smoke_sufficient: 'accessibility_verification',
    manual_smoke_required: 'release_exit_verification',
    recipe_level_smoke_sufficient: 'recipe_level_corpus_expansion',
    staleness_fail_closed: 'staleness_repair',
    roundtrip_safe: 'roundtrip_repair',
    migration_non_destructive: 'migration_non_destruction_repair',
  });

/**
 * Derives the next Phase 8 slice from the HIGHEST-SEVERITY unresolved gate.
 * Nothing about a specific topic is hardcoded as the answer: when no gate is
 * unresolved the recommendation is verification, never a new feature.
 */
export function deriveNextSlice(input: Phase8aNextSliceInput): Phase8aNextSlice {
  const unresolved = input.gaps.filter((gap) => gap.status === 'FAIL' || gap.status === 'NOT_PROVEN');
  if (unresolved.length === 0) {
    return Object.freeze({
      recommendation: 'release_exit_verification',
      gate: null,
      severity: 'not_a_gap',
      derivation_reason:
        'every release-exit gate is PASS or NOT_APPLICABLE; the remaining work is verification, not new implementation',
    });
  }

  const rank = (severity: Phase8aGapSeverity): number =>
    PHASE8_NEXT_SLICE_PRIORITY.indexOf(severity);
  // Ties break on the declared gate order, so the result is deterministic.
  const best = [...unresolved].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      RELEASE_EXIT_GATES.indexOf(a.gate) - RELEASE_EXIT_GATES.indexOf(b.gate)
  )[0];

  // A verification-only frontier means the highest-severity gaps are unproven
  // rather than broken, so the honest recommendation is proof, not repair.
  const recommendation =
    input.verificationOnly && best.status === 'NOT_PROVEN'
      ? (GATE_REMEDIATION[best.gate] ?? 'release_exit_verification')
      : (GATE_REMEDIATION[best.gate] ?? 'release_exit_verification');

  return Object.freeze({
    recommendation,
    gate: best.gate,
    severity: best.severity,
    derivation_reason: `highest-severity unresolved gate is "${best.gate}" (${best.severity}, ${best.status}); remediation for that gate is "${recommendation}"`,
  });
}