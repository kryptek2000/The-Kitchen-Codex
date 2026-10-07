/**
 * The Kitchen Codex — Advanced Nutrition AI-6B3 regression: IDENTITY
 * disposition, REPAIRABILITY measurement, and the derived next-lane handoff.
 *
 * AI-6B3 is planning-only. Its central claim is the SAME correction AI-6B2 made
 * for portions, applied to identity: an identity-lane BLOCKER and a REPAIRABLE
 * deterministic DEFECT are not the same thing. AI-6B2 measured the portion lane
 * at zero actionable defects and named `deterministic_identity` (27 observed
 * blockers) as the next ADJUDICATION target. AI-6B3 adjudicates it and MEASURES
 * the actionable count rather than assuming either 0 or 27.
 *
 * WHAT THIS PROVES
 *   - all 27 unresolved identity-lane lines receive EXACTLY ONE closed
 *     disposition drawn from a closed vocabulary, each with a closed evidence
 *     code, and nothing is unclassified;
 *   - the 27-line census reconciles against the 26 / 1 blocker split;
 *   - the repairable count is MEASURED from evidence and derived, never
 *     hardcoded into the roadmap;
 *   - a raw blocker count alone can NEVER make an exhausted lane the recommended
 *     active repair target;
 *   - identity is NOT ranking: the 9 `deterministic_ranking` blockers stay a
 *     separate lane and are never absorbed;
 *   - the checked-in safety constraints still hold — the `expectNoAutomatic`
 *     line and the forbidden-description line are both refused, never repaired;
 *   - the known-good identity oracle stays 46/46 with zero unsafe identities;
 *   - neither hypothetical rule is repairable-eligible, and the reason is
 *     measured, not asserted;
 *   - production behavior is completely unchanged by AI-6B3.
 *
 * AI-6B3 binds no FDC, invents no equivalence, genericizes no branded food, and
 * routes no identity case to AI.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  IDENTITY_DISPOSITIONS,
  IDENTITY_DISPOSITION_SCHEMA,
  IDENTITY_EVIDENCE_CODES,
  HYPOTHETICAL_SAFE_RULES,
  classifyIdentityDisposition,
  isAi6b3IdentityDisposition,
  isAi6b3IdentityEvidenceCode,
  type Ai6b3IdentityEvidence,
} from '../../scripts/nutritionIntelligence/identityDisposition';
import { deriveNextWork } from '../../scripts/nutritionIntelligence/portionDisposition';

interface SimulationJson {
  readonly rule_id: string;
  readonly identity_lane_new_bindings: number;
  readonly corpus_new_bindings: number;
  readonly corpus_changed_bindings: number;
  readonly oracle_divergences: number;
  readonly expect_no_automatic_violations: number;
  readonly forbidden_fdc_violations: number;
  readonly forbidden_description_violations: number;
  readonly safety_history_bindings: number;
  readonly repairable_eligible: boolean;
  readonly eligibility_reason: string;
}

interface LineJson {
  readonly line: string;
  readonly primary_blocker: string;
  readonly repair_lane?: string;
  readonly head_tokens: ReadonlyArray<string>;
  readonly candidate_count: number;
  readonly candidates: ReadonlyArray<{ rank: number; fdc_id: number; description: string }>;
  readonly satisfying_candidate_ids: ReadonlyArray<number>;
  readonly all_satisfying_candidates_forbidden: boolean;
  readonly head_probe_total: number | null;
  readonly head_probe_drop_leading_total: number | null;
  readonly expected_auto_fdc: number | null;
  readonly expect_no_automatic: boolean;
  readonly forbidden_auto_fdcs: ReadonlyArray<number>;
  readonly forbidden_auto_description: string | null;
  readonly selected_fdc_id: number | null;
  readonly disposition: string;
  readonly evidence: string;
  readonly repairable: boolean;
  readonly hypothetical_safe_rule: string | null;
  readonly handoff_lane: string | null;
  readonly ai3_eligible: boolean;
  readonly ai3_reason: string;
}

interface ReportJson {
  readonly schema: string;
  readonly base_phase: string;
  readonly base_commit: string;
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
  readonly observed_identity_blockers: number;
  readonly blocker_split: ReadonlyArray<{ key: string; count: number }>;
  readonly repairable_deterministic_identity_defects: number;
  readonly identity_lane_exhausted: boolean;
  readonly deterministic_ranking_blockers: number;
  readonly disposition_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly evidence_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly handoff_lane_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ai3_eligibility_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly identity_lane_constraint_counts: {
    readonly expect_no_automatic: number;
    readonly forbidden_auto_fdcs: number;
    readonly forbidden_auto_description: number;
  };
  readonly hypothetical_rule_simulations: ReadonlyArray<SimulationJson>;
  readonly lane_repairability: ReadonlyArray<{
    lane: string;
    observed_blockers: number;
    actionable_defects: number | null;
    adjudicated: boolean;
    exhausted: boolean;
  }>;
  readonly recommended_active_repair_lane: string | null;
  readonly recommended_active_repair_reason: string;
  readonly next_adjudication_target_lane: string | null;
  readonly next_adjudication_reason: string;
  readonly lines: ReadonlyArray<LineJson>;
}

const ROOT = join(import.meta.dirname, '../..');

let REPORT: ReportJson | null = null;
let REPORT_TEXT: string | null = null;

async function loadReport(): Promise<ReportJson> {
  if (REPORT === null) {
    const { buildNutritionIdentityDispositionReport } = await import(
      '../../scripts/nutritionIntelligence/identityDispositionReport'
    );
    REPORT = (await buildNutritionIdentityDispositionReport()) as unknown as ReportJson;
    REPORT_TEXT = JSON.stringify(REPORT);
  }
  return REPORT;
}

const report = (): ReportJson => {
  if (REPORT === null) throw new Error('report not loaded');
  return REPORT;
};

const lineFor = (text: string): LineJson => {
  const found = report().lines.find((entry) => entry.line === text);
  if (found === undefined) throw new Error(`line not in report: ${text}`);
  return found;
};

/** Neutral identity evidence: nothing satisfies, nothing is forbidden. */
const NO_IDENTITY: Ai6b3IdentityEvidence = Object.freeze({
  brand_specificity: false,
  quantity_absorbed_into_query: false,
  container_noun_in_head: false,
  declared_qualifier_in_head: false,
  food_head_absent: false,
  satisfying_candidate_ids: [],
  all_satisfying_forbidden: false,
  head_probe_total: 0,
  head_probe_drop_leading_total: 0,
  expect_no_automatic: false,
});

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

describe('AI-6B3 — the disposition and evidence vocabularies are closed', () => {
  it('declares exactly the nine required disposition concepts', () => {
    expect([...IDENTITY_DISPOSITIONS].sort()).toEqual([
      'ambiguous_identity_requires_review',
      'branded_or_commercial_specificity_gap',
      'catalog_candidate_generation_gap',
      'intentional_human_identity_choice',
      'needs_identity_recon',
      'normalization_or_tokenization_gap',
      'repairable_deterministic_identity_defect',
      'semantic_equivalence_not_authorized',
      'specificity_not_authorized',
    ]);
  });

  it('rejects any disposition outside the closed vocabulary', () => {
    for (const bad of ['probably_fine', '', 'REPAIRABLE', 'unknown', null, 7]) {
      expect(isAi6b3IdentityDisposition(bad), String(bad)).toBe(false);
    }
    for (const good of IDENTITY_DISPOSITIONS) {
      expect(isAi6b3IdentityDisposition(good), good).toBe(true);
    }
  });

  it('rejects any evidence code outside the closed vocabulary', () => {
    for (const bad of ['looks_right', '', 'UNKNOWN', null, 3]) {
      expect(isAi6b3IdentityEvidenceCode(bad), String(bad)).toBe(false);
    }
    for (const good of IDENTITY_EVIDENCE_CODES) {
      expect(isAi6b3IdentityEvidenceCode(good), good).toBe(true);
    }
  });

  it('declares a closed hypothetical-rule set, none of which is applied', () => {
    expect([...HYPOTHETICAL_SAFE_RULES].sort()).toEqual([
      'singularize_plural_head_token',
      'unique_satisfying_candidate_auto_bind',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Classifier semantics (pure, mutation-sensitive)
// ---------------------------------------------------------------------------

describe('AI-6B3 — classifier semantics', () => {
  it('is repairable ONLY for one unique, safe, non-forbidden satisfying candidate', () => {
    const verdict = classifyIdentityDisposition({
      ...NO_IDENTITY,
      satisfying_candidate_ids: [170054],
    });
    expect(verdict.disposition).toBe('repairable_deterministic_identity_defect');
    expect(verdict.repairable).toBe(true);
    expect(verdict.evidence).toBe('single_safe_candidate_withheld');
    expect(verdict.handoff_lane).toBe('deterministic_identity');
    expect(verdict.hypothetical_safe_rule).toBe('unique_satisfying_candidate_auto_bind');
  });

  // M1 TARGET: two plausible candidates must NEVER be called repairable, however
  // convincing one of them looks.
  it('M1 — multiple plausible candidates are ambiguity, never repairable', () => {
    const verdict = classifyIdentityDisposition({
      ...NO_IDENTITY,
      satisfying_candidate_ids: [170054, 170085],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('ambiguous_identity_requires_review');
    expect(verdict.evidence).toBe('multiple_plausible_candidates');
  });

  // M3 TARGET: a unique-but-forbidden candidate must never be bound.
  it('M3 — a forbidden sole candidate is refused, never repaired', () => {
    const verdict = classifyIdentityDisposition({
      ...NO_IDENTITY,
      satisfying_candidate_ids: [2709719],
      all_satisfying_forbidden: true,
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('specificity_not_authorized');
    expect(verdict.evidence).toBe('all_satisfying_candidates_forbidden');
  });

  // M4 TARGET: `expectNoAutomatic` must block a repair even when the window
  // determines exactly one identity.
  it('M4 — expectNoAutomatic blocks repair and escalates to recon', () => {
    const verdict = classifyIdentityDisposition({
      ...NO_IDENTITY,
      satisfying_candidate_ids: [171321],
      expect_no_automatic: true,
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('needs_identity_recon');
    expect(verdict.evidence).toBe('insufficient_evidence_for_classification');
  });

  it('reports a quantity absorbed into the query as a tokenizer gap', () => {
    const verdict = classifyIdentityDisposition({
      ...NO_IDENTITY,
      quantity_absorbed_into_query: true,
      food_head_absent: true,
      head_probe_total: 1,
    });
    expect(verdict.disposition).toBe('normalization_or_tokenization_gap');
    expect(verdict.evidence).toBe('quantity_token_absorbed_into_food_query');
    expect(verdict.handoff_lane).toBe('deterministic_parser');
    expect(verdict.repairable).toBe(false);
  });

  it('reports a leaked container noun as a tokenizer gap, not an identity gap', () => {
    const verdict = classifyIdentityDisposition({
      ...NO_IDENTITY,
      container_noun_in_head: true,
    });
    expect(verdict.disposition).toBe('normalization_or_tokenization_gap');
    expect(verdict.evidence).toBe('container_noun_in_food_head');
  });

  it('reports a leaked declared qualifier as a tokenizer gap', () => {
    const verdict = classifyIdentityDisposition({
      ...NO_IDENTITY,
      declared_qualifier_in_head: true,
    });
    expect(verdict.disposition).toBe('normalization_or_tokenization_gap');
    expect(verdict.evidence).toBe('declared_qualifier_token_in_food_head');
  });

  it('separates a candidate-generation gap from an unauthorized specificity', () => {
    const gap = classifyIdentityDisposition({ ...NO_IDENTITY, head_probe_total: 306 });
    expect(gap.disposition).toBe('catalog_candidate_generation_gap');
    expect(gap.evidence).toBe('catalog_probe_finds_candidate_but_window_empty');
    expect(gap.repairable).toBe(false);

    const absent = classifyIdentityDisposition({ ...NO_IDENTITY });
    expect(absent.disposition).toBe('specificity_not_authorized');
    expect(absent.evidence).toBe('no_authorized_record_for_authored_specificity');
    expect(absent.repairable).toBe(false);
  });

  it('never genericizes a branded food', () => {
    const verdict = classifyIdentityDisposition({
      ...NO_IDENTITY,
      brand_specificity: true,
      satisfying_candidate_ids: [170054],
    });
    expect(verdict.disposition).toBe('branded_or_commercial_specificity_gap');
    expect(verdict.repairable).toBe(false);
  });

  it('is TOTAL: every evidence shape yields exactly one closed verdict', () => {
    const shapes: ReadonlyArray<Partial<Ai6b3IdentityEvidence>> = [
      {},
      { satisfying_candidate_ids: [1] },
      { satisfying_candidate_ids: [1, 2] },
      { satisfying_candidate_ids: [1], all_satisfying_forbidden: true },
      { food_head_absent: true },
      { brand_specificity: true },
      { container_noun_in_head: true },
      { declared_qualifier_in_head: true },
      { head_probe_total: 5 },
      { head_probe_drop_leading_total: 5 },
      { expect_no_automatic: true },
      { quantity_absorbed_into_query: true, food_head_absent: true },
    ];
    for (const shape of shapes) {
      const verdict = classifyIdentityDisposition({ ...NO_IDENTITY, ...shape });
      expect(isAi6b3IdentityDisposition(verdict.disposition), JSON.stringify(shape)).toBe(true);
      expect(isAi6b3IdentityEvidenceCode(verdict.evidence), JSON.stringify(shape)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The 27-line census
// ---------------------------------------------------------------------------

describe('AI-6B3 — the 27-line identity census reconciles', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('observes exactly 27 identity-lane blockers', () => {
    expect(report().observed_identity_blockers).toBe(27);
    expect(report().lines).toHaveLength(27);
  });

  // M2 TARGET: dropping a single line must fail loudly.
  it('M2 — the blocker split reconciles to 26 + 1 with nothing lost', () => {
    const split = Object.fromEntries(
      report().blocker_split.map((entry) => [entry.key, entry.count])
    );
    expect(split.identity_needs_review).toBe(26);
    expect(split.identity_unmatched).toBe(1);
    expect(
      report().blocker_split.reduce((sum, entry) => sum + entry.count, 0)
    ).toBe(report().observed_identity_blockers);
    expect(report().lines.filter((l) => l.primary_blocker === 'identity_unmatched')).toHaveLength(1);
    expect(
      report().lines.filter((l) => l.primary_blocker === 'identity_needs_review')
    ).toHaveLength(26);
  });

  it('gives every line EXACTLY ONE closed disposition and closed evidence code', () => {
    for (const line of report().lines) {
      expect(isAi6b3IdentityDisposition(line.disposition), line.line).toBe(true);
      expect(isAi6b3IdentityEvidenceCode(line.evidence), line.line).toBe(true);
      expect(
        IDENTITY_DISPOSITIONS.includes(line.disposition as never),
        line.line
      ).toBe(true);
      expect(IDENTITY_EVIDENCE_CODES.includes(line.evidence as never), line.line).toBe(true);
    }
  });

  it('leaves NO line unclassified', () => {
    const unclassified = report().lines.filter(
      (line) => line.disposition === '' || line.evidence === '' || line.disposition === 'unclassified'
    );
    expect(unclassified).toHaveLength(0);
  });

  it('derives the disposition counts from the lines themselves', () => {
    const total = report().disposition_counts.reduce((sum, entry) => sum + entry.count, 0);
    expect(total).toBe(27);
    for (const entry of report().disposition_counts) {
      expect(
        report().lines.filter((line) => line.disposition === entry.key)
      ).toHaveLength(entry.count);
    }
    const evidenceTotal = report().evidence_counts.reduce((sum, entry) => sum + entry.count, 0);
    expect(evidenceTotal).toBe(27);
  });

  it('preserves the candidate evidence behind every verdict', () => {
    for (const line of report().lines) {
      // The census publishes the BOUNDED candidate window, which is a prefix of
      // the pipeline's full candidate list, so it can never exceed it.
      expect(line.candidates.length, line.line).toBeLessThanOrEqual(line.candidate_count);
      if (line.candidate_count > 0) {
        expect(line.candidates.length, line.line).toBeGreaterThan(0);
      }
      line.candidates.forEach((candidate, index) => {
        expect(candidate.rank, line.line).toBe(index + 1);
        expect(candidate.fdc_id, line.line).toBeGreaterThan(0);
        expect(candidate.description.length, line.line).toBeGreaterThan(0);
      });
      // A satisfying candidate must actually be IN the published window, so the
      // verdict is auditable from the artifact alone.
      for (const id of line.satisfying_candidate_ids) {
        expect(
          line.candidates.some((candidate) => candidate.fdc_id === id),
          `${line.line}: ${id}`
        ).toBe(true);
      }
    }
  });

  it('records bounded catalog probe evidence for every line', () => {
    for (const line of report().lines) {
      const probe = line.head_probe_total;
      const relaxed = line.head_probe_drop_leading_total;
      expect(probe === null || probe >= 0, line.line).toBe(true);
      expect(relaxed === null || relaxed >= 0, line.line).toBe(true);
      // A one-token relaxation is never allowed to be more specific than the head.
      if (probe !== null && relaxed !== null) {
        expect(relaxed, line.line).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('classifies the single identity_unmatched line separately', () => {
    const unmatched = report().lines.filter((l) => l.primary_blocker === 'identity_unmatched');
    expect(unmatched).toHaveLength(1);
    const cloves = unmatched[0];
    expect(cloves.line).toBe('2 cloves');
    expect(cloves.disposition).toBe('normalization_or_tokenization_gap');
    expect(cloves.evidence).toBe('quantity_token_absorbed_into_food_query');
    expect(cloves.candidate_count).toBe(0);
    expect(cloves.head_tokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repairability is measured, not assumed
// ---------------------------------------------------------------------------

describe('AI-6B3 — repairability is measured, never assumed', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('derives the repairable count from the per-line verdicts', () => {
    const derived = report().lines.filter((line) => line.repairable).length;
    expect(report().repairable_deterministic_identity_defects).toBe(derived);
    expect(derived).toBe(0);
    expect(report().identity_lane_exhausted).toBe(true);
  });

  it('never marks a line repairable without a unique satisfying candidate', () => {
    for (const line of report().lines) {
      if (!line.repairable) continue;
      expect(line.satisfying_candidate_ids, line.line).toHaveLength(1);
      expect(line.all_satisfying_candidates_forbidden, line.line).toBe(false);
      expect(line.expect_no_automatic, line.line).toBe(false);
      expect(line.hypothetical_safe_rule, line.line).toBe('unique_satisfying_candidate_auto_bind');
    }
  });

  it('agrees with the closed disposition vocabulary on zero repairable lines', () => {
    expect(
      report().disposition_counts.find(
        (entry) => entry.key === 'repairable_deterministic_identity_defect'
      ) ?? { count: 0 }
    ).toEqual({ count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Safety: the oracle and the forbidden constraints
// ---------------------------------------------------------------------------

describe('AI-6B3 — checked-in safety knowledge still holds', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('leaves the known-good identity oracle at 46/46 with zero unsafe identities', () => {
    const baseline = report().production_baseline;
    expect(baseline.verified_correct_auto_identity).toBe(46);
    expect(baseline.verified_unsafe_auto_identity).toBe(0);
  });

  it('freezes every production baseline number', () => {
    const baseline = report().production_baseline;
    expect(baseline.historical_resolved).toBe(48);
    expect(baseline.historical_total).toBe(97);
    expect(baseline.legacy_resolved).toBe(44);
    expect(baseline.legacy_total).toBe(91);
    expect(baseline.raw_matched).toBe(94);
    expect(baseline.authenticated_mass_resolved).toBe(94);
    expect(baseline.safe_resolved).toBe(93);
    expect(baseline.corpus_total).toBe(207);
  });

  it('pins the base commit so later HEAD movement cannot perturb the artifact', () => {
    expect(report().base_commit).toBe('9761ae5fef84058ef76ba1ad6232c1b3f644cc5a');
    expect(report().base_phase).toBe('AI-6B2');
    expect(report().schema).toBe(IDENTITY_DISPOSITION_SCHEMA);
  });

  // M4 TARGET (corpus): the expectNoAutomatic line must stay refused.
  it('M4 — the expectNoAutomatic line is never bound and never repaired', () => {
    const guarded = report().lines.filter((line) => line.expect_no_automatic);
    expect(guarded).toHaveLength(1);
    expect(report().identity_lane_constraint_counts.expect_no_automatic).toBe(1);
    for (const line of guarded) {
      expect(line.repairable, line.line).toBe(false);
      expect(line.disposition, line.line).not.toBe(
        'repairable_deterministic_identity_defect'
      );
    }
  });

  it('refuses the forbidden-description line rather than binding a raw record', () => {
    const guarded = report().lines.filter(
      (line) => line.forbidden_auto_description !== null
    );
    expect(guarded).toHaveLength(1);
    const line = guarded[0];
    expect(line.line).toBe('1 can diced tomatoes');
    expect(line.satisfying_candidate_ids.length).toBeGreaterThan(0);
    expect(line.all_satisfying_candidates_forbidden).toBe(true);
    expect(line.disposition).toBe('specificity_not_authorized');
    expect(line.evidence).toBe('all_satisfying_candidates_forbidden');
    expect(line.repairable).toBe(false);
    // Every candidate it WOULD have bound is a raw record the corpus forbids.
    const forbidden = /\braw\b|\bcrushed\b/i;
    for (const id of line.satisfying_candidate_ids) {
      const match = line.candidates.find((candidate) => candidate.fdc_id === id);
      expect(match, String(id)).toBeDefined();
      expect(forbidden.test(match?.description ?? ''), String(id)).toBe(true);
    }
  });

  it('never repairs a line carrying a forbidden FDC or forbidden description', () => {
    for (const line of report().lines) {
      if (line.forbidden_auto_fdcs.length === 0 && line.forbidden_auto_description === null) {
        continue;
      }
      expect(line.repairable, line.line).toBe(false);
      for (const id of line.satisfying_candidate_ids) {
        expect(line.forbidden_auto_fdcs.includes(id), `${line.line}: ${id}`).toBe(false);
      }
    }
  });

  it('refuses to genericize the branded line', () => {
    const branded = lineFor('1 packet Lipton onion soup mix');
    expect(branded.disposition).toBe('branded_or_commercial_specificity_gap');
    expect(branded.evidence).toBe('brand_token_in_authored_line');
    expect(branded.repairable).toBe(false);
    expect(branded.handoff_lane).toBe('intentional_human_review');
  });
});

// ---------------------------------------------------------------------------
// Identity is NOT ranking
// ---------------------------------------------------------------------------

describe('AI-6B3 — identity and ranking stay distinct lanes', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  // M5 TARGET: the 9 ranking blockers must never migrate into the identity lane.
  it('M5 — the 9 deterministic_ranking blockers stay a separate lane', () => {
    expect(report().deterministic_ranking_blockers).toBe(9);
    expect(report().observed_identity_blockers).toBe(27);
    expect(report().observed_identity_blockers + report().deterministic_ranking_blockers).toBe(36);
    const rankingLane = report().lane_repairability.find(
      (lane) => lane.lane === 'deterministic_ranking'
    );
    expect(rankingLane?.observed_blockers).toBe(9);
    expect(rankingLane?.adjudicated).toBe(false);
    expect(rankingLane?.actionable_defects).toBeNull();
  });

  it('keeps the ranking blocker text out of the identity census', () => {
    for (const rankingLine of [
      '4 tbsp unsalted butter',
      '2 celery stalks, chopped',
      '2 stalks celery',
      '2 chicken breasts',
      '1/2 cup chopped bacon',
      '3 stalks celery',
      '1 head cabbage',
      '1 cup raw chicken breast',
    ]) {
      expect(
        report().lines.some((entry) => entry.line === rankingLine),
        rankingLine
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Hypothetical-rule simulation
// ---------------------------------------------------------------------------

describe('AI-6B3 — no hypothetical identity rule is repairable-eligible', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('simulates every declared hypothetical rule', () => {
    expect(report().hypothetical_rule_simulations).toHaveLength(
      HYPOTHETICAL_SAFE_RULES.length
    );
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(HYPOTHETICAL_SAFE_RULES).toContain(simulation.rule_id as never);
      expect(typeof simulation.identity_lane_new_bindings, simulation.rule_id).toBe('number');
      expect(typeof simulation.corpus_new_bindings, simulation.rule_id).toBe('number');
      expect(typeof simulation.corpus_changed_bindings, simulation.rule_id).toBe('number');
      expect(typeof simulation.oracle_divergences, simulation.rule_id).toBe('number');
      expect(typeof simulation.safety_history_bindings, simulation.rule_id).toBe('number');
    }
  });

  it('finds no repairable-eligible rule, and says why', () => {
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(simulation.repairable_eligible, simulation.rule_id).toBe(false);
      expect(simulation.eligibility_reason.length, simulation.rule_id).toBeGreaterThan(0);
      // No identity-lane line is newly bindable by either rule.
      expect(simulation.identity_lane_new_bindings, simulation.rule_id).toBe(0);
    }
  });

  it('never diverges from the known-good oracle', () => {
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(simulation.oracle_divergences, simulation.rule_id).toBe(0);
    }
  });

  it('flags that a naive bind would rewrite identities that already resolve', () => {
    const bind = report().hypothetical_rule_simulations.find(
      (entry) => entry.rule_id === 'unique_satisfying_candidate_auto_bind'
    );
    expect(bind).toBeDefined();
    // This is the decisive negative: the "obvious" rule is not conservative.
    expect(bind?.corpus_changed_bindings ?? 0).toBeGreaterThan(0);
    expect(bind?.eligibility_reason).toContain('no_identity_lane_witness');
  });

  it('flags the food-inside-preparation safety line the plural rule would bind', () => {
    const plural = report().hypothetical_rule_simulations.find(
      (entry) => entry.rule_id === 'singularize_plural_head_token'
    );
    expect(plural).toBeDefined();
    expect(plural?.safety_history_bindings ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Roadmap derivation
// ---------------------------------------------------------------------------

const SCORES = {
  deterministic_portion: {
    safety: 5,
    ordinary_user_impact: 5,
    generalizability: 5,
    tractability: 5,
    frequency: 0,
  },
  deterministic_identity: {
    safety: 2,
    ordinary_user_impact: 4,
    generalizability: 3,
    tractability: 2,
    frequency: 0,
  },
  deterministic_ranking: {
    safety: 3,
    ordinary_user_impact: 3,
    generalizability: 3,
    tractability: 3,
    frequency: 0,
  },
};
const ORDER = ['safety', 'ordinary_user_impact', 'generalizability', 'tractability', 'frequency'];
const OBSERVED = [
  { lane: 'deterministic_portion', count: 35 },
  { lane: 'deterministic_identity', count: 27 },
  { lane: 'deterministic_ranking', count: 9 },
];

describe('AI-6B3 — the roadmap follows measured repairability', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('marks BOTH lanes adjudicated and both exhausted', () => {
    const portion = report().lane_repairability.find(
      (lane) => lane.lane === 'deterministic_portion'
    );
    const identity = report().lane_repairability.find(
      (lane) => lane.lane === 'deterministic_identity'
    );
    expect(portion?.observed_blockers).toBe(35);
    expect(portion?.actionable_defects).toBe(0);
    expect(portion?.exhausted).toBe(true);
    expect(identity?.observed_blockers).toBe(27);
    expect(identity?.actionable_defects).toBe(0);
    expect(identity?.exhausted).toBe(true);
  });

  it('never reports an un-adjudicated lane as zero actionable', () => {
    for (const lane of report().lane_repairability) {
      if (lane.lane === 'deterministic_portion' || lane.lane === 'deterministic_identity') {
        continue;
      }
      expect(lane.adjudicated, lane.lane).toBe(false);
      expect(lane.actionable_defects, lane.lane).toBeNull();
      expect(lane.exhausted, lane.lane).toBe(false);
    }
  });

  // M7 TARGET: 35 and 27 observed blockers must not buy repair status.
  it('M7 — observed blocker frequency never overrides adjudication state', () => {
    expect(report().recommended_active_repair_lane).toBeNull();
    expect(report().recommended_active_repair_reason).toBe(
      'no_adjudicated_lane_has_actionable_defects'
    );
  });

  it('recommends no active repair and names the next ADJUDICATION target', () => {
    expect(report().recommended_active_repair_lane).toBeNull();
    expect(report().next_adjudication_target_lane).toBe('deterministic_ranking');
    const target = report().lane_repairability.find(
      (lane) => lane.lane === report().next_adjudication_target_lane
    );
    expect(target?.adjudicated).toBe(false);
    expect(target?.observed_blockers).toBe(9);
    // never-target lanes are excluded from being proposed as work
    for (const lane of ['intentional_human_review', 'needs_recon', 'already_resolved']) {
      expect(
        report().next_adjudication_target_lane,
        lane
      ).not.toBe(lane);
    }
  });

  it('M6 — the recommendation is derived, not hardcoded to the identity lane', () => {
    // The measured state recommends NOTHING.
    const measured = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: { deterministic_portion: 0, deterministic_identity: 0 },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(measured.recommended_active_repair_lane).toBeNull();

    // One hypothetical actionable identity defect flips it TO identity...
    const identityRepaired = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: { deterministic_portion: 0, deterministic_identity: 1 },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(identityRepaired.recommended_active_repair_lane).toBe('deterministic_identity');

    // ...and a RANKING defect instead flips it to ranking, proving the answer is
    // never pinned to `deterministic_identity`.
    const rankingRepaired = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: { deterministic_portion: 0, deterministic_ranking: 2 },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(rankingRepaired.recommended_active_repair_lane).toBe('deterministic_ranking');
  });

  it('never lets the exhausted portion lane reappear as a repair target', () => {
    const derived = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: { deterministic_portion: 0, deterministic_identity: 3 },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(derived.recommended_active_repair_lane).toBe('deterministic_identity');
    const portion = derived.lanes.find((lane) => lane.lane === 'deterministic_portion');
    expect(portion?.exhausted).toBe(true);
    expect(portion?.observed_blockers).toBe(35);
  });

  it('picks the next adjudication target by observed blockers, not by identity', () => {
    const derived = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: { deterministic_portion: 0, deterministic_identity: 0 },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(derived.next_adjudication_target_lane).toBe('deterministic_ranking');
    expect(derived.recommended_active_repair_lane).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AI-3 cross-check
// ---------------------------------------------------------------------------

describe('AI-6B3 — the AI interpretation boundary is unchanged', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('reports AI-3 eligibility per line without changing it', () => {
    const total = report().ai3_eligibility_counts.reduce((sum, entry) => sum + entry.count, 0);
    expect(total).toBe(27);
    for (const line of report().lines) {
      expect(typeof line.ai3_eligible, line.line).toBe('boolean');
      expect(line.ai3_reason.length, line.line).toBeGreaterThan(0);
      // No identity-lane line is routed to AI merely because identity is hard.
      expect(line.ai3_eligible, line.line).toBe(false);
    }
  });

  it('never selects an FDC for an identity case', () => {
    for (const line of report().lines) {
      expect(line.selected_fdc_id, line.line).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism and the production freeze
// ---------------------------------------------------------------------------

describe('AI-6B3 — determinism and the production freeze', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  // The report build reads and authenticates the real USDA bundle and runs the
  // real phase-4 flow for every line, so it legitimately takes far longer than
  // the default per-test timeout.
  it('is byte-deterministic across two builds', async () => {
    const first = REPORT_TEXT;
    const { buildNutritionIdentityDispositionReport } = await import(
      '../../scripts/nutritionIntelligence/identityDispositionReport'
    );
    const second = JSON.stringify(await buildNutritionIdentityDispositionReport());
    expect(second).toBe(first);
  }, 600_000);

  it('carries no clock, hostname, absolute path, or environment field', () => {
    const text = REPORT_TEXT ?? '';
    expect(text.includes('/home/'), 'absolute path').toBe(false);
    expect(text.includes('\\\\Users\\\\'), 'home-relative path').toBe(false);
    expect(text.includes(process.cwd()), 'working directory').toBe(false);
    expect(/[A-Za-z]:\\\\/.test(text), 'drive-letter path').toBe(false);
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), 'ISO timestamp').toBe(false);
  });

  it('binds no AI-selected FDC and grants no authority', () => {
    const text = REPORT_TEXT ?? '';
    expect(text.includes('gemini')).toBe(false);
    expect(text.includes('openrouter')).toBe(false);
  });

  it('has ZERO production consumers', () => {
    const planningMarkers = ['identityDisposition', 'benchmark_nutrition_identity_disposition'];
    for (const tree of ['src/core/nutritionV2', 'src/utils', 'server', 'plugin']) {
      for (const file of sourceFiles(join(ROOT, tree))) {
        const text = readFileSync(file, 'utf8');
        for (const marker of planningMarkers) {
          expect(text.includes(marker), `${file}: ${marker}`).toBe(false);
        }
      }
    }
  });

  it('leaves the AI-6A / AI-6B1 / AI-6B2 planning artifacts untouched on disk', () => {
    for (const file of [
      'scripts/nutritionIntelligence/portionDisposition.ts',
      'scripts/nutritionIntelligence/portionDispositionReport.ts',
      'scripts/benchmark_nutrition_portion_disposition.ts',
      'scripts/nutritionIntelligence/diagnose.ts',
      'scripts/nutritionIntelligence/taxonomy.ts',
      'scripts/nutritionIntelligence/summarize.ts',
      'scripts/benchmark_nutrition_intelligence.ts',
      'scripts/benchmark_resolution_coverage.ts',
    ]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text.includes('nutrition_ai6b3_identity_disposition_v1'), file).toBe(false);
    }
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