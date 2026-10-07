/**
 * The Kitchen Codex — Advanced Nutrition AI-6B4 regression: RANKING
 * disposition, REPAIRABILITY measurement, and the derived next-lane handoff.
 *
 * AI-6B4 is planning-only. Its central claim is the SAME correction AI-6B2 made
 * for portions and AI-6B3 made for identity, applied to ranking: a
 * `compatible_candidate_not_selected` BLOCKER is not a REPAIRABLE deterministic
 * ranking DEFECT.
 *
 * THE LOAD-BEARING RULE UNDER TEST
 *   A candidate must NEVER outrank a semantically better food identity merely
 *   because it has a convenient USDA portion. Portion compatibility may only
 *   break a tie AFTER food-identity fidelity is satisfied. AI-6B4 therefore does
 *   NOT count a rerank as repairable merely because the alternate has a usable
 *   portion, and it does NOT count a line as repairable unless a GENERAL rule
 *   survives simulation across all 207 recon lines.
 *
 * WHAT THIS PROVES
 *   - all 9 ranking-lane lines are `compatible_candidate_not_selected` and each
 *     receives EXACTLY ONE closed disposition with ONE closed evidence code;
 *   - the repairable count is MEASURED and is gated on corpus-wide rule
 *     simulation, not on a line-local look;
 *   - a semantically IDENTICAL alternate with a convenient portion still does not
 *     become a repair, because the minimal general rule would break verified
 *     identities elsewhere;
 *   - authored qualifiers (`unsalted`), state (`raw`), and product class
 *     (meatless) each independently block a rerank;
 *   - a checked-in `expectedAutoFdc` pinning the SELECTED record is authoritative
 *     over portion convenience;
 *   - identity (27) and ranking (9) stay distinct lanes;
 *   - the known-good 46/46 identity oracle is untouched;
 *   - production behavior is completely unchanged by AI-6B4.
 *
 * AI-6B4 binds no FDC, reranks nothing, and averages nothing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  RANKING_DISPOSITIONS,
  RANKING_DISPOSITION_SCHEMA,
  RANKING_EVIDENCE_CODES,
  SEMANTIC_PARITY_VALUES,
  HYPOTHETICAL_RANKING_RULES,
  applyRuleSafetyGate,
  classifyRankingDisposition,
  isAi6b4RankingDisposition,
  isAi6b4RankingEvidenceCode,
  type Ai6b4RankingEvidence,
} from '../../scripts/nutritionIntelligence/rankingDisposition';
import { deriveNextWork } from '../../scripts/nutritionIntelligence/portionDisposition';
import {
  AI6B4_FOOD_INSIDE_PREPARATION_EXCLUSIONS,
  AI6B4_FOOD_INSIDE_PREPARATION_WITNESSES,
  isFoodInsidePreparationWitness,
} from '../../scripts/nutritionIntelligence/rankingDispositionReport';

interface SimulationJson {
  readonly rule_id: string;
  readonly new_automatic_identities: number;
  readonly changed_automatic_identities: number;
  readonly unchanged_automatic_identities: number;
  readonly expected_fdc_divergences: number;
  readonly baseline_fdc_divergences: number;
  readonly expect_top_fdc_violations: number;
  readonly expect_no_automatic_violations: number;
  readonly forbidden_fdc_violations: number;
  readonly forbidden_description_violations: number;
  readonly safety_history_bindings: number;
  readonly ranking_lane_new_bindings: number;
  readonly new_authenticated_masses: number;
  readonly changed_grams: number;
  readonly repairable_eligible: boolean;
  readonly eligibility_reason: string;
}

interface LineJson {
  readonly line: string;
  readonly primary_blocker: string;
  readonly head_tokens: ReadonlyArray<string>;
  readonly selected_fdc_id: number | null;
  readonly selected_description: string | null;
  readonly selected_rank: number | null;
  readonly selected_has_compatible_portion: boolean;
  readonly selected_data_type: string | null;
  readonly mass_source: string;
  readonly resolved_grams: number | null;
  readonly terminal: string;
  readonly review_outcome: string | null;
  readonly compatible_alternate_count: number;
  readonly compatible_alternates: ReadonlyArray<{
    fdc_id: number;
    rank: number;
    description: string;
    preserves_authored_head: boolean;
    identical_description_to_selected: boolean;
    adds_unauthored_specificity: boolean;
    contradicts_authored_state: boolean;
    changes_food_identity: boolean;
    forbidden: boolean;
  }>;
  readonly expected_auto_fdc: number | null;
  readonly baseline_auto_fdc: number | null;
  readonly expect_top_fdc: number | null;
  readonly expect_candidate_description: string | null;
  readonly expect_no_automatic: boolean;
  readonly forbidden_auto_fdcs: ReadonlyArray<number>;
  readonly forbidden_auto_description: string | null;
  readonly known_issue: string | null;
  readonly identity_correctness: string;
  readonly auto_outcome: string;
  readonly disposition: string;
  readonly evidence: string;
  readonly semantic_parity: string;
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
    historical_resolved: number;
    historical_total: number;
    legacy_resolved: number;
    legacy_total: number;
    raw_matched: number;
    authenticated_mass_resolved: number;
    safe_resolved: number;
    verified_correct_auto_identity: number;
    verified_unsafe_auto_identity: number;
    corpus_total: number;
  };
  readonly observed_ranking_blockers: number;
  readonly ranking_blocker_split: ReadonlyArray<{ key: string; count: number }>;
  readonly repairable_deterministic_ranking_defects: number;
  readonly ranking_lane_exhausted: boolean;
  readonly deterministic_identity_blockers: number;
  readonly deterministic_portion_blockers: number;
  readonly disposition_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly evidence_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly semantic_parity_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly handoff_lane_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ai3_eligibility_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ranking_lane_constraint_counts: {
    expected_auto_fdc: number;
    baseline_auto_fdc: number;
    expect_top_fdc: number;
    expect_candidate_description: number;
    expect_no_automatic: number;
    forbidden_auto_fdcs: number;
    forbidden_auto_description: number;
    known_issue: number;
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
    const { buildNutritionRankingDispositionReport } = await import(
      '../../scripts/nutritionIntelligence/rankingDispositionReport'
    );
    REPORT = (await buildNutritionRankingDispositionReport()) as unknown as ReportJson;
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

const load = async (): Promise<void> => {
  await loadReport();
};

// The report build authenticates the real USDA bundle and runs the real phase-4
// flow for every line, so the hook needs a far larger timeout than the default.
const beforeAllLoad = async (): Promise<void> => {
  await loadReport();
};

/** A selected record with no alternate at all. */
const NO_ALTERNATE: Ai6b4RankingEvidence = Object.freeze({
  expected_fdc_pins_selected: false,
  expect_no_automatic: false,
  alternate_forbidden: false,
  compatible_alternates: [],
  selected_is_branded: false,
});

const ALTERNATE = (over: Partial<Ai6b4RankingEvidence['compatible_alternates'][number]>) => ({
  fdc_id: 1,
  description: 'x',
  preserves_authored_head: true,
  identical_description_to_selected: false,
  adds_unauthored_specificity: false,
  contradicts_authored_state: false,
  changes_food_identity: false,
  ...over,
});

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

describe('AI-6B4 — the disposition and evidence vocabularies are closed', () => {
  it('declares exactly the eleven ranking disposition concepts', () => {
    expect([...RANKING_DISPOSITIONS].sort()).toEqual([
      'alternate_identity_not_equivalent',
      'authoritative_ranking_ambiguity',
      'brand_or_product_specificity_blocks_rerank',
      'corpus_constraint_blocks_rerank',
      'needs_ranking_recon',
      'no_safe_general_ranking_rule',
      'portion_compatibility_only_advantage',
      'qualifier_fidelity_blocks_rerank',
      'ranking_blocker_misclassified',
      'repairable_deterministic_ranking_defect',
      'selected_identity_semantically_preferred',
    ]);
  });

  it('rejects any disposition outside the closed vocabulary', () => {
    for (const bad of ['probably_fine', '', 'REPAIRABLE', 'unknown', null, 7]) {
      expect(isAi6b4RankingDisposition(bad), String(bad)).toBe(false);
    }
    for (const good of RANKING_DISPOSITIONS) {
      expect(isAi6b4RankingDisposition(good), good).toBe(true);
    }
  });

  it('rejects any evidence code outside the closed vocabulary', () => {
    for (const bad of ['looks_right', '', 'UNKNOWN', null, 3]) {
      expect(isAi6b4RankingEvidenceCode(bad), String(bad)).toBe(false);
    }
    for (const good of RANKING_EVIDENCE_CODES) {
      expect(isAi6b4RankingEvidenceCode(good), good).toBe(true);
    }
  });

  it('declares a closed semantic-parity vocabulary', () => {
    expect([...SEMANTIC_PARITY_VALUES].sort()).toEqual([
      'alternate_more_faithful',
      'ambiguous',
      'materially_different',
      'same_semantic_identity',
      'selected_more_faithful',
    ]);
  });

  it('declares a closed hypothetical-rule set, none of which is applied', () => {
    expect([...HYPOTHETICAL_RANKING_RULES].sort()).toEqual([
      'prefer_head_token_preserving_candidate_with_compatible_portion',
      'prefer_identical_description_with_compatible_portion',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Classifier semantics (pure, mutation-sensitive)
// ---------------------------------------------------------------------------

describe('AI-6B4 — classifier semantics', () => {
  // M1 TARGET: a convenient portion must NEVER on its own make a rerank repairable.
  it('M1 — a merely convenient alternate is never repairable', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      compatible_alternates: [ALTERNATE({ adds_unauthored_specificity: true })],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('portion_compatibility_only_advantage');
  });

  it('is repairable ONLY for a token-identical, constraint-clean alternate', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      compatible_alternates: [ALTERNATE({ identical_description_to_selected: true })],
    });
    expect(verdict.disposition).toBe('repairable_deterministic_ranking_defect');
    expect(verdict.repairable).toBe(true);
    expect(verdict.evidence).toBe('same_food_semantics');
    expect(verdict.semantic_parity).toBe('same_semantic_identity');
    expect(verdict.handoff_lane).toBe('deterministic_ranking');
    expect(verdict.hypothetical_safe_rule).toBe(
      'prefer_identical_description_with_compatible_portion'
    );
  });

  // M3 TARGET: portion compatibility must not override an authored qualifier.
  it('M3 — an alternate that drops the authored head is a qualifier block', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      compatible_alternates: [
        ALTERNATE({ preserves_authored_head: false }),
        ALTERNATE({ fdc_id: 2, preserves_authored_head: false }),
      ],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('qualifier_fidelity_blocks_rerank');
    expect(verdict.evidence).toBe('alternate_drops_authored_qualifier');
  });

  // M10 TARGET: same-semantic parity must never be claimed for a different state.
  it('M10 — a state contradiction blocks the rerank and denies same-semantic parity', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      compatible_alternates: [ALTERNATE({ contradicts_authored_state: true })],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('alternate_identity_not_equivalent');
    expect(verdict.evidence).toBe('alternate_contradicts_authored_state');
    expect(verdict.semantic_parity).not.toBe('same_semantic_identity');
  });

  it('refuses a product-class substitution (a meatless analog is not bacon)', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      compatible_alternates: [ALTERNATE({ changes_food_identity: true })],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('alternate_identity_not_equivalent');
    expect(verdict.evidence).toBe('alternate_changes_food_identity');
  });

  // M4 TARGET: a forbidden alternate must never count as repairable.
  it('M4 — a forbidden alternate blocks the rerank outright', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      alternate_forbidden: true,
      compatible_alternates: [ALTERNATE({ identical_description_to_selected: true })],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('corpus_constraint_blocks_rerank');
    expect(verdict.evidence).toBe('forbidden_candidate_constraint');
  });

  // M5 TARGET: expectNoAutomatic must block even a perfect-semantics alternate.
  it('M5 — expectNoAutomatic blocks even a token-identical alternate', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      expect_no_automatic: true,
      compatible_alternates: [ALTERNATE({ identical_description_to_selected: true })],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('corpus_constraint_blocks_rerank');
    expect(verdict.evidence).toBe('expect_no_automatic_constraint');
  });

  it('treats an expectedAutoFdc pinning the selected record as authoritative', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      expected_fdc_pins_selected: true,
      compatible_alternates: [ALTERNATE({ identical_description_to_selected: true })],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('corpus_constraint_blocks_rerank');
    expect(verdict.evidence).toBe('expected_candidate_supports_selected');
  });

  it('never genericizes a branded selected identity', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      selected_is_branded: true,
      compatible_alternates: [ALTERNATE({ identical_description_to_selected: true })],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('brand_or_product_specificity_blocks_rerank');
  });

  it('reports ambiguity when several alternates preserve the authored head', () => {
    const verdict = classifyRankingDisposition({
      ...NO_ALTERNATE,
      compatible_alternates: [
        ALTERNATE({ fdc_id: 1, description: 'a' }),
        ALTERNATE({ fdc_id: 2, description: 'b' }),
        ALTERNATE({ fdc_id: 3, description: 'c' }),
      ],
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('authoritative_ranking_ambiguity');
    expect(verdict.evidence).toBe('multiple_compatible_alternates');
  });

  it('is TOTAL: every evidence shape yields exactly one closed verdict', () => {
    const shapes: ReadonlyArray<Partial<Ai6b4RankingEvidence>> = [
      {},
      { compatible_alternates: [ALTERNATE({ identical_description_to_selected: true })] },
      { compatible_alternates: [ALTERNATE({ preserves_authored_head: false })] },
      { compatible_alternates: [ALTERNATE({ contradicts_authored_state: true })] },
      { compatible_alternates: [ALTERNATE({ changes_food_identity: true })] },
      { compatible_alternates: [ALTERNATE({ adds_unauthored_specificity: true })] },
      { expect_no_automatic: true },
      { alternate_forbidden: true },
      { expected_fdc_pins_selected: true },
      { selected_is_branded: true },
    ];
    for (const shape of shapes) {
      const verdict = classifyRankingDisposition({ ...NO_ALTERNATE, ...shape });
      expect(isAi6b4RankingDisposition(verdict.disposition), JSON.stringify(shape)).toBe(true);
      expect(isAi6b4RankingEvidenceCode(verdict.evidence), JSON.stringify(shape)).toBe(true);
      expect(SEMANTIC_PARITY_VALUES).toContain(verdict.semantic_parity);
    }
  });
});

// ---------------------------------------------------------------------------
// The corpus-wide rule-safety gate
// ---------------------------------------------------------------------------

describe('AI-6B4 — the rule-safety gate overrides a line-local repairable verdict', () => {
  it('keeps a repairable verdict when its rule survived simulation', () => {
    const provisional = classifyRankingDisposition({
      ...NO_ALTERNATE,
      compatible_alternates: [ALTERNATE({ identical_description_to_selected: true })],
    });
    const gated = applyRuleSafetyGate(provisional, {
      prefer_identical_description_with_compatible_portion: true,
    });
    expect(gated.repairable).toBe(true);
    expect(gated.disposition).toBe('repairable_deterministic_ranking_defect');
  });

  it('downgrades a repairable verdict whose rule broke the oracle', () => {
    const provisional = classifyRankingDisposition({
      ...NO_ALTERNATE,
      compatible_alternates: [ALTERNATE({ identical_description_to_selected: true })],
    });
    const gated = applyRuleSafetyGate(provisional, {
      prefer_identical_description_with_compatible_portion: false,
    });
    expect(gated.repairable).toBe(false);
    expect(gated.disposition).toBe('no_safe_general_ranking_rule');
    expect(gated.evidence).toBe('rule_would_break_known_good_identity_oracle');
    expect(gated.handoff_lane).toBe('needs_recon');
    // Semantic parity is preserved through the gate: the gate is about RULE
    // safety, not about the food identity.
    expect(gated.semantic_parity).toBe(provisional.semantic_parity);
  });
});

// ---------------------------------------------------------------------------
// The 9-line census
// ---------------------------------------------------------------------------

describe('AI-6B4 — the 9-line ranking census reconciles', () => {
  beforeAll(beforeAllLoad, 300000);

  it('observes exactly 9 ranking blockers, all compatible_candidate_not_selected', () => {
    expect(report().observed_ranking_blockers).toBe(9);
    expect(report().lines).toHaveLength(9);
    expect(report().ranking_blocker_split).toHaveLength(1);
    expect(report().ranking_blocker_split[0].key).toBe('compatible_candidate_not_selected');
    expect(report().ranking_blocker_split[0].count).toBe(9);
    for (const line of report().lines) {
      expect(line.primary_blocker, line.line).toBe('compatible_candidate_not_selected');
    }
  });

  // M2 TARGET: dropping a single line must fail loudly.
  it('M2 — every one of the 9 appears exactly once', () => {
    const texts = report().lines.map((line) => line.line);
    expect(new Set(texts).size).toBe(9);
    for (const expected of [
      '4 tbsp unsalted butter',
      '2 tbsp unsalted butter',
      '2 celery stalks, chopped',
      '2 stalks celery',
      '2 chicken breasts',
      '1/2 cup chopped bacon',
      '3 stalks celery',
      '1 head cabbage',
      '1 cup raw chicken breast',
    ]) {
      expect(texts.filter((t) => t === expected).length, expected).toBe(1);
    }
  });

  it('gives every line EXACTLY ONE closed disposition and closed evidence code', () => {
    for (const line of report().lines) {
      expect(isAi6b4RankingDisposition(line.disposition), line.line).toBe(true);
      expect(isAi6b4RankingEvidenceCode(line.evidence), line.line).toBe(true);
      expect(RANKING_DISPOSITIONS).toContain(line.disposition as never);
      expect(RANKING_EVIDENCE_CODES).toContain(line.evidence as never);
      expect(SEMANTIC_PARITY_VALUES).toContain(line.semantic_parity as never);
    }
  });

  it('leaves NO line unclassified', () => {
    expect(
      report().lines.filter(
        (line) => line.disposition === '' || line.evidence === '' || line.disposition === 'unclassified'
      )
    ).toHaveLength(0);
  });

  it('derives every count from the per-line records', () => {
    const total = report().disposition_counts.reduce((s, e) => s + e.count, 0);
    expect(total).toBe(9);
    expect(report().evidence_counts.reduce((s, e) => s + e.count, 0)).toBe(9);
    expect(report().semantic_parity_counts.reduce((s, e) => s + e.count, 0)).toBe(9);
    expect(report().handoff_lane_counts.reduce((s, e) => s + e.count, 0)).toBe(9);
    for (const entry of report().disposition_counts) {
      expect(report().lines.filter((l) => l.disposition === entry.key)).toHaveLength(entry.count);
    }
    for (const entry of report().semantic_parity_counts) {
      expect(report().lines.filter((l) => l.semantic_parity === entry.key)).toHaveLength(
        entry.count
      );
    }
  });

  it('records selected-candidate evidence for every line', () => {
    for (const line of report().lines) {
      expect(line.selected_fdc_id, line.line).not.toBeNull();
      expect(line.selected_description, line.line).toBeTruthy();
      expect(line.selected_rank, line.line).toBe(1);
      // The blocker definition: selected CANNOT satisfy the authored measurement.
      expect(line.selected_has_compatible_portion, line.line).toBe(false);
      expect(line.compatible_alternate_count, line.line).toBeGreaterThan(0);
    }
  });

  it('records compatible-alternate evidence for every line', () => {
    for (const line of report().lines) {
      expect(line.compatible_alternates.length, line.line).toBe(line.compatible_alternate_count);
      for (const alternate of line.compatible_alternates) {
        expect(alternate.fdc_id, line.line).not.toBe(line.selected_fdc_id);
        expect(alternate.description.length, line.line).toBeGreaterThan(0);
        expect(alternate.rank, line.line).toBeGreaterThan(line.selected_rank ?? 0);
      }
    }
  });

  it('reports every checked-in corpus constraint for the 9 lines', () => {
    const constraints = report().ranking_lane_constraint_counts;
    expect(constraints.expected_auto_fdc).toBe(4);
    expect(constraints.baseline_auto_fdc).toBe(0);
    expect(constraints.expect_top_fdc).toBe(0);
    expect(constraints.expect_candidate_description).toBe(0);
    expect(constraints.expect_no_automatic).toBe(0);
    expect(constraints.forbidden_auto_fdcs).toBe(0);
    expect(constraints.forbidden_auto_description).toBe(0);
    expect(constraints.known_issue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ranking is not portion shopping
// ---------------------------------------------------------------------------

describe('AI-6B4 — semantic fidelity outranks portion convenience', () => {
  beforeAll(beforeAllLoad, 300000);

  it('refuses every butter alternate because none keeps the authored `unsalted`', () => {
    for (const text of ['4 tbsp unsalted butter', '2 tbsp unsalted butter']) {
      const line = lineFor(text);
      expect(line.head_tokens).toContain('unsalted');
      expect(line.compatible_alternate_count).toBe(4);
      for (const alternate of line.compatible_alternates) {
        expect(alternate.preserves_authored_head, `${text}: ${alternate.fdc_id}`).toBe(false);
      }
      expect(line.semantic_parity).toBe('selected_more_faithful');
      expect(line.repairable).toBe(false);
    }
    expect(lineFor('4 tbsp unsalted butter').disposition).toBe(
      'qualifier_fidelity_blocks_rerank'
    );
    // One of the two additionally carries a checked-in expectedAutoFdc pin.
    expect(lineFor('2 tbsp unsalted butter').disposition).toBe(
      'corpus_constraint_blocks_rerank'
    );
  });

  it('refuses a fried alternate for an authored `raw` chicken breast', () => {
    const line = lineFor('1 cup raw chicken breast');
    expect(line.head_tokens).toContain('raw');
    expect(line.selected_description).toContain('raw');
    expect(line.compatible_alternates).toHaveLength(1);
    const alternate = line.compatible_alternates[0];
    expect(alternate.description.toLowerCase()).toContain('fried');
    expect(alternate.contradicts_authored_state).toBe(true);
    expect(line.disposition).toBe('alternate_identity_not_equivalent');
    expect(line.evidence).toBe('alternate_contradicts_authored_state');
    expect(line.semantic_parity).toBe('materially_different');
    expect(line.repairable).toBe(false);
  });

  it('refuses a meatless analog as a substitute for pork bacon', () => {
    const line = lineFor('1/2 cup chopped bacon');
    expect(line.selected_description).toContain('Pork');
    const meatless = line.compatible_alternates.find((a) =>
      a.description.toLowerCase().includes('meatless')
    );
    expect(meatless).toBeDefined();
    expect(meatless?.changes_food_identity).toBe(true);
    expect(line.semantic_parity).toBe('materially_different');
    expect(line.repairable).toBe(false);
  });

  it('refuses to add an un-authored specificity (green) to a generic cabbage', () => {
    const line = lineFor('1 head cabbage');
    expect(line.head_tokens).toEqual(['cabbage']);
    expect(line.selected_description).toBe('Cabbage, raw');
    expect(line.compatible_alternates[0].description).toBe('Cabbage, green, raw');
    expect(line.compatible_alternates[0].adds_unauthored_specificity).toBe(true);
    expect(line.disposition).toBe('portion_compatibility_only_advantage');
    expect(line.repairable).toBe(false);
  });

  it('refuses celery because the only general rule would break two verified identities', () => {
    // All three celery lines share the identical token-identical alternate.
    for (const text of ['2 celery stalks, chopped', '2 stalks celery', '3 stalks celery']) {
      const line = lineFor(text);
      expect(line.semantic_parity, text).toBe('same_semantic_identity');
      expect(line.compatible_alternates[0].description).toBe('Celery, raw');
      expect(line.compatible_alternates[0].identical_description_to_selected, text).toBe(true);
      expect(line.repairable, text).toBe(false);
    }
    // Two of the three carry a checked-in oracle pin on the SELECTED record.
    expect(lineFor('2 celery stalks, chopped').expected_auto_fdc).toBe(169988);
    expect(lineFor('2 stalks celery').expected_auto_fdc).toBe(169988);
    expect(lineFor('3 stalks celery').expected_auto_fdc).toBeNull();
    // The unpinned one is still refused, because the general rule it needs would
    // rerank its two pinned siblings.
    expect(lineFor('3 stalks celery').disposition).toBe('no_safe_general_ranking_rule');
    expect(lineFor('3 stalks celery').evidence).toBe(
      'rule_would_break_known_good_identity_oracle'
    );
  });

  it('never calls a line repairable without a simulated, eligible rule', () => {
    for (const line of report().lines) {
      if (!line.repairable) continue;
      expect(line.hypothetical_safe_rule, line.line).not.toBeNull();
      const simulation = report().hypothetical_rule_simulations.find(
        (s) => s.rule_id === line.hypothetical_safe_rule
      );
      expect(simulation, String(line.hypothetical_safe_rule)).toBeDefined();
      expect(simulation?.repairable_eligible, String(line.hypothetical_safe_rule)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Repairability is measured and gated
// ---------------------------------------------------------------------------

describe('AI-6B4 — repairability is measured, gated, and never assumed', () => {
  beforeAll(beforeAllLoad, 300000);

  it('derives the repairable count from the gated per-line verdicts', () => {
    const derived = report().lines.filter((line) => line.repairable).length;
    expect(report().repairable_deterministic_ranking_defects).toBe(derived);
    expect(derived).toBe(0);
    expect(report().ranking_lane_exhausted).toBe(true);
  });

  it('finds no repairable-eligible hypothetical rule, and says why', () => {
    expect(report().hypothetical_rule_simulations).toHaveLength(
      HYPOTHETICAL_RANKING_RULES.length
    );
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(simulation.repairable_eligible, simulation.rule_id).toBe(false);
      expect(simulation.eligibility_reason.length, simulation.rule_id).toBeGreaterThan(0);
      expect(simulation.eligibility_reason, simulation.rule_id).toContain(
        'hypothetical_rule_would_violate'
      );
    }
  });

  it('shows the naive rules would rewrite many already-correct identities', () => {
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(simulation.changed_automatic_identities, simulation.rule_id).toBeGreaterThan(0);
      expect(simulation.expected_fdc_divergences, simulation.rule_id).toBeGreaterThan(0);
      // A rank-by-portion rule is never justified by new coverage here: it
      // changes existing identities rather than unlocking new mass.
      expect(simulation.new_automatic_identities, simulation.rule_id).toBe(0);
      expect(simulation.new_authenticated_masses, simulation.rule_id).toBe(0);
    }
  });

  it('reopens no checked-in constraint, and no safety-history claim is made', () => {
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(simulation.expect_no_automatic_violations, simulation.rule_id).toBe(0);
      expect(simulation.forbidden_fdc_violations, simulation.rule_id).toBe(0);
      expect(simulation.forbidden_description_violations, simulation.rule_id).toBe(0);
      // AI-6B4-R1: the rules hit NO true nested-food structural witness. The
      // earlier "2 safety-history bindings" were same-food provolone swaps caught
      // by a broad `/ in /` detector, so no safety-history claim is made. The
      // rules remain ineligible on exact-record authority alone.
      expect(simulation.safety_history_bindings, simulation.rule_id).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Safety: oracle, identity/ranking separation
// ---------------------------------------------------------------------------

describe('AI-6B4 — identity, ranking, and the oracle stay distinct', () => {
  beforeAll(beforeAllLoad, 300000);

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
    expect(report().base_commit).toBe('d31070978c44cb21721441158b130b8ad98831b6');
    expect(report().base_phase).toBe('AI-6B3');
    expect(report().schema).toBe(RANKING_DISPOSITION_SCHEMA);
  });

  // M6 TARGET: identity and ranking must never merge.
  it('M6 — ranking 9 stays distinct from identity 27 and portion 35', () => {
    expect(report().observed_ranking_blockers).toBe(9);
    expect(report().deterministic_identity_blockers).toBe(27);
    expect(report().deterministic_portion_blockers).toBe(35);
    // No ranking line appears in the identity census and vice versa.
    for (const text of [
      '2 chicken breasts',
      '1 head cabbage',
      '3 stalks celery',
      '2 tbsp unsalted butter',
    ]) {
      expect(report().lines.some((l) => l.line === text), text).toBe(true);
    }
    const identityOnly = [
      '2 cloves',
      '1 packet Lipton onion soup mix',
      '1 cup canned chickpeas',
      '2 cups penne pasta',
    ];
    for (const text of identityOnly) {
      expect(report().lines.some((l) => l.line === text), text).toBe(false);
    }
  });

  it('never rebinds a verified identity away from its expected FDC', () => {
    for (const line of report().lines) {
      if (line.expected_auto_fdc === null) continue;
      // The selected record IS the expected one, and it stays selected.
      expect(line.selected_fdc_id, line.line).toBe(line.expected_auto_fdc);
      expect(line.identity_correctness, line.line).toBe('verified_correct');
      expect(line.auto_outcome, line.line).toBe('automatic_matches_expected');
    }
  });

  it('freezes every current FDC and gram value', () => {
    for (const line of report().lines) {
      expect(line.selected_fdc_id, line.line).not.toBeNull();
      expect(line.mass_source, line.line).toBe('none');
      expect(line.resolved_grams, line.line).toBeNull();
      expect(line.terminal, line.line).toBe('needs_amount');
    }
  });
});

// ---------------------------------------------------------------------------
// AI-3 cross-check
// ---------------------------------------------------------------------------

describe('AI-6B4 — the AI interpretation boundary is unchanged', () => {
  beforeAll(beforeAllLoad, 300000);

  it('reports AI-3 eligibility per line without changing it', () => {
    const total = report().ai3_eligibility_counts.reduce((s, e) => s + e.count, 0);
    expect(total).toBe(9);
    for (const line of report().lines) {
      expect(typeof line.ai3_eligible, line.line).toBe('boolean');
      expect(line.ai3_reason.length, line.line).toBeGreaterThan(0);
    }
  });

  it('shows ranking blockers do NOT block downstream estimation the way identity does', () => {
    // Unlike the 27 identity-lane lines (all `not_actionable`), every ranking
    // blocker is a `needs_amount` row, so AI-3 eligibility is unaffected by the
    // unresolved amount. AI-6B4 changes nothing here.
    expect(report().ai3_eligibility_counts).toHaveLength(1);
    expect(report().ai3_eligibility_counts[0].key).toBe('eligible');
    expect(report().ai3_eligibility_counts[0].count).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Roadmap derivation
// ---------------------------------------------------------------------------

const SCORES = {
  deterministic_portion: { safety: 5, ordinary_user_impact: 5, generalizability: 5, tractability: 5, frequency: 0 },
  deterministic_identity: { safety: 2, ordinary_user_impact: 4, generalizability: 3, tractability: 2, frequency: 0 },
  deterministic_ranking: { safety: 3, ordinary_user_impact: 3, generalizability: 3, tractability: 3, frequency: 0 },
  catalog_gap: { safety: 3, ordinary_user_impact: 2, generalizability: 2, tractability: 2, frequency: 0 },
};
const ORDER = ['safety', 'ordinary_user_impact', 'generalizability', 'tractability', 'frequency'];
const OBSERVED = [
  { lane: 'deterministic_portion', count: 35 },
  { lane: 'deterministic_identity', count: 27 },
  { lane: 'deterministic_ranking', count: 9 },
  { lane: 'catalog_gap', count: 5 },
];

describe('AI-6B4 — the roadmap follows measured repairability', () => {
  beforeAll(beforeAllLoad, 300000);

  it('marks all three adjudicated lanes exhausted at zero actionable defects', () => {
    for (const lane of ['deterministic_portion', 'deterministic_identity', 'deterministic_ranking']) {
      const row = report().lane_repairability.find((entry) => entry.lane === lane);
      expect(row?.adjudicated, lane).toBe(true);
      expect(row?.actionable_defects, lane).toBe(0);
      expect(row?.exhausted, lane).toBe(true);
    }
    const ranking = report().lane_repairability.find(
      (entry) => entry.lane === 'deterministic_ranking'
    );
    expect(ranking?.observed_blockers).toBe(9);
  });

  it('never reports an un-adjudicated lane as zero actionable', () => {
    const adjudicated = ['deterministic_portion', 'deterministic_identity', 'deterministic_ranking'];
    for (const lane of report().lane_repairability) {
      if (adjudicated.includes(lane.lane)) continue;
      expect(lane.adjudicated, lane.lane).toBe(false);
      expect(lane.actionable_defects, lane.lane).toBeNull();
      expect(lane.exhausted, lane.lane).toBe(false);
    }
  });

  // M7 TARGET: the recommendation is derived, never hardcoded.
  it('M7 — the recommendation is derived, not hardcoded to the ranking lane', () => {
    const measured = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: {
        deterministic_portion: 0,
        deterministic_identity: 0,
        deterministic_ranking: 0,
      },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(measured.recommended_active_repair_lane).toBeNull();

    const rankingRepaired = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: {
        deterministic_portion: 0,
        deterministic_identity: 0,
        deterministic_ranking: 2,
      },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(rankingRepaired.recommended_active_repair_lane).toBe('deterministic_ranking');

    const identityRepaired = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: {
        deterministic_portion: 0,
        deterministic_identity: 1,
        deterministic_ranking: 0,
      },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(identityRepaired.recommended_active_repair_lane).toBe('deterministic_identity');
  });

  // M8 TARGET: exhausted lanes never resurrect from blocker frequency.
  it('M8 — exhausted portion/identity lanes cannot resurrect as repair targets', () => {
    expect(report().recommended_active_repair_lane).toBeNull();
    expect(report().recommended_active_repair_reason).toBe(
      'no_adjudicated_lane_has_actionable_defects'
    );
    const derived = deriveNextWork({
      observedBlockers: OBSERVED,
      adjudicatedActionableDefects: {
        deterministic_portion: 0,
        deterministic_identity: 0,
        deterministic_ranking: 1,
      },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(derived.recommended_active_repair_lane).toBe('deterministic_ranking');
    for (const lane of ['deterministic_portion', 'deterministic_identity']) {
      const row = derived.lanes.find((entry) => entry.lane === lane);
      expect(row?.exhausted, lane).toBe(true);
      expect(row?.observed_blockers, lane).toBeGreaterThan(row?.actionable_defects ?? 0);
    }
  });

  it('recommends no active repair and names the next ADJUDICATION target', () => {
    expect(report().recommended_active_repair_lane).toBeNull();
    expect(report().next_adjudication_target_lane).toBe('catalog_gap');
    const target = report().lane_repairability.find(
      (lane) => lane.lane === report().next_adjudication_target_lane
    );
    expect(target?.adjudicated).toBe(false);
    expect(target?.observed_blockers).toBe(5);
    for (const never of ['intentional_human_review', 'needs_recon', 'already_resolved']) {
      expect(report().next_adjudication_target_lane, never).not.toBe(never);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism and the production freeze
// ---------------------------------------------------------------------------

describe('AI-6B4 — determinism and the production freeze', () => {
  beforeAll(beforeAllLoad, 300000);

  // The report build authenticates the real USDA bundle and runs the real
  // phase-4 flow per line, so it needs a far larger timeout than the default.
  it('is byte-deterministic across two builds', async () => {
    const first = REPORT_TEXT;
    const { buildNutritionRankingDispositionReport } = await import(
      '../../scripts/nutritionIntelligence/rankingDispositionReport'
    );
    const second = JSON.stringify(await buildNutritionRankingDispositionReport());
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

  it('binds no AI-selected FDC and grants no AI authority', () => {
    const text = REPORT_TEXT ?? '';
    expect(text.toLowerCase().includes('gemini')).toBe(false);
    expect(text.toLowerCase().includes('openrouter')).toBe(false);
  });

  it('has ZERO production consumers', () => {
    const planningMarkers = ['rankingDisposition', 'benchmark_nutrition_ranking_disposition'];
    for (const tree of ['src/core/nutritionV2', 'src/utils', 'server', 'plugin']) {
      for (const file of sourceFiles(join(ROOT, tree))) {
        const text = readFileSync(file, 'utf8');
        for (const marker of planningMarkers) {
          expect(text.includes(marker), `${file}: ${marker}`).toBe(false);
        }
      }
    }
  });

  it('leaves every previous planning artifact untouched on disk', () => {
    for (const file of [
      'scripts/nutritionIntelligence/portionDisposition.ts',
      'scripts/nutritionIntelligence/portionDispositionReport.ts',
      'scripts/nutritionIntelligence/identityDisposition.ts',
      'scripts/nutritionIntelligence/identityDispositionReport.ts',
      'scripts/benchmark_nutrition_portion_disposition.ts',
      'scripts/benchmark_nutrition_identity_disposition.ts',
      'scripts/nutritionIntelligence/diagnose.ts',
      'scripts/nutritionIntelligence/taxonomy.ts',
      'scripts/nutritionIntelligence/summarize.ts',
      'scripts/benchmark_nutrition_intelligence.ts',
      'scripts/benchmark_resolution_coverage.ts',
    ]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text.includes(RANKING_DISPOSITION_SCHEMA), file).toBe(false);
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

// ---------------------------------------------------------------------------
// AI-6B4-R1 — SAFETY-HISTORY DETECTOR PRECISION REPAIR
// ---------------------------------------------------------------------------

describe('AI-6B4-R1 — the safety-history detector no longer over-claims', () => {
  beforeAll(beforeAllLoad);

  it('still recognises the historical nested-food witness', () => {
    // The hazard itself must remain modelled: an authored `food in preparation`
    // line where binding the embedded component instead of the containing food
    // is the known failure.
    expect(isFoodInsidePreparationWitness('sardines in tomato sauce')).toBe(true);
  });

  // M2 TARGET: a same-food record swap is not the sardines class.
  it('M2 — does NOT treat a same-food provolone swap as food-inside-preparation', () => {
    // These are the two lines the broad `/ in /` detector wrongly flagged. Their
    // `in` is inside a parenthetical mass annotation ("in total"), and the swap
    // under evaluation was 170850 Cheese, provolone -> 2705733 Cheese, Provolone
    // — the same food from a different data source.
    for (const line of [
      '3 to 4 slices provolone (about 75 to 100 grams in total)',
      '3 to 4 slices provolone (about 75-100 g in total)',
    ]) {
      expect(isFoodInsidePreparationWitness(line), line).toBe(false);
      expect(line.includes(' in '), 'the broad detector really did match').toBe(true);
    }
  });

  it('does NOT treat a preparation state phrase as a nested-food hazard', () => {
    // "packed in oil" is a state phrase, not a nested food identity, even though
    // it is syntactically identical to the historical witness once parentheticals
    // are stripped. Distinguishing them would require food semantics this
    // artifact must not invent, so the exclusion is declared and auditable.
    expect(isFoodInsidePreparationWitness('1 can packed in oil')).toBe(false);
  });

  it('keeps the declared witness and exclusion sets disjoint and bounded', () => {
    for (const line of AI6B4_FOOD_INSIDE_PREPARATION_WITNESSES) {
      expect(AI6B4_FOOD_INSIDE_PREPARATION_EXCLUSIONS.has(line), line).toBe(false);
      expect(isFoodInsidePreparationWitness(line), line).toBe(true);
    }
    for (const line of AI6B4_FOOD_INSIDE_PREPARATION_EXCLUSIONS) {
      expect(AI6B4_FOOD_INSIDE_PREPARATION_WITNESSES.has(line), line).toBe(false);
      expect(isFoodInsidePreparationWitness(line), line).toBe(false);
    }
    expect(AI6B4_FOOD_INSIDE_PREPARATION_WITNESSES.size).toBeGreaterThan(0);
  });

  it('reports ZERO safety-history hits for both hypothetical rules', () => {
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(simulation.safety_history_bindings, simulation.rule_id).toBe(0);
    }
  });

  // M3 TARGET: exact-record authority alone must keep both rules ineligible.
  it('M3 — oracle divergences alone keep both rules ineligible', () => {
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(simulation.repairable_eligible, simulation.rule_id).toBe(false);
      // PRIMARY decisive evidence, unchanged by the detector repair.
      expect(simulation.expected_fdc_divergences, simulation.rule_id).toBeGreaterThan(0);
      // And the refusal reason must be exactly that, with no safety claim.
      expect(simulation.eligibility_reason, simulation.rule_id).toBe(
        'hypothetical_rule_would_violate:diverges_expected_identity_oracle'
      );
      expect(simulation.eligibility_reason, simulation.rule_id).not.toContain('safety');
    }
  });

  it('preserves the exact divergence counts the audit verified', () => {
    const byRule = Object.fromEntries(
      report().hypothetical_rule_simulations.map((s) => [s.rule_id, s.expected_fdc_divergences])
    );
    expect(byRule.prefer_identical_description_with_compatible_portion).toBe(7);
    expect(byRule.prefer_head_token_preserving_candidate_with_compatible_portion).toBe(23);
  });

  it('still unlocks no new coverage: zero new identities and zero new mass', () => {
    for (const simulation of report().hypothetical_rule_simulations) {
      expect(simulation.new_automatic_identities, simulation.rule_id).toBe(0);
      expect(simulation.new_authenticated_masses, simulation.rule_id).toBe(0);
    }
  });
});

describe('AI-6B4-R1 — the central verdict and roadmap are untouched', () => {
  beforeAll(beforeAllLoad);

  it('keeps repairable ranking defects at zero', () => {
    expect(report().repairable_deterministic_ranking_defects).toBe(
      report().lines.filter((line) => line.repairable).length
    );
    expect(report().repairable_deterministic_ranking_defects).toBe(0);
    expect(report().ranking_lane_exhausted).toBe(true);
    expect(report().observed_ranking_blockers).toBe(9);
  });

  // M4 TARGET: celery must not be reranked despite the identical description.
  it('M4 — celery stays non-repairable under exact-record authority', () => {
    for (const text of ['2 celery stalks, chopped', '2 stalks celery', '3 stalks celery']) {
      const line = lineFor(text);
      expect(line.selected_fdc_id, text).toBe(169988);
      expect(line.compatible_alternates[0].fdc_id, text).toBe(2709778);
      // Same rendered description, but not interchangeable records.
      expect(line.compatible_alternates[0].identical_description_to_selected, text).toBe(true);
      expect(line.repairable, text).toBe(false);
    }
    // Two lines carry exact-record authority for 169988...
    expect(lineFor('2 celery stalks, chopped').expected_auto_fdc).toBe(169988);
    expect(lineFor('2 stalks celery').expected_auto_fdc).toBe(169988);
    // ...and the third is still refused because the general rule it needs would
    // rerank those two.
    expect(lineFor('3 stalks celery').disposition).toBe('no_safe_general_ranking_rule');
    expect(lineFor('3 stalks celery').evidence).toBe(
      'rule_would_break_known_good_identity_oracle'
    );
  });

  it('leaves the roadmap unchanged', () => {
    expect(report().recommended_active_repair_lane).toBeNull();
    expect(report().recommended_active_repair_reason).toBe(
      'no_adjudicated_lane_has_actionable_defects'
    );
    expect(report().next_adjudication_target_lane).toBe('catalog_gap');
    const target = report().lane_repairability.find(
      (lane) => lane.lane === 'catalog_gap'
    );
    expect(target?.observed_blockers).toBe(5);
    expect(target?.adjudicated).toBe(false);
    for (const lane of [
      'deterministic_portion',
      'deterministic_identity',
      'deterministic_ranking',
    ]) {
      const row = report().lane_repairability.find((entry) => entry.lane === lane);
      expect(row?.adjudicated, lane).toBe(true);
      expect(row?.actionable_defects, lane).toBe(0);
      expect(row?.exhausted, lane).toBe(true);
    }
  });

  it('keeps the disposition partition identical to the audited AI-6B4 result', () => {
    const counts = Object.fromEntries(
      report().disposition_counts.map((entry) => [entry.key, entry.count])
    );
    expect(counts.corpus_constraint_blocks_rerank).toBe(4);
    expect(counts.portion_compatibility_only_advantage).toBe(2);
    expect(counts.qualifier_fidelity_blocks_rerank).toBe(1);
    expect(counts.alternate_identity_not_equivalent).toBe(1);
    expect(counts.no_safe_general_ranking_rule).toBe(1);
    expect(counts.repairable_deterministic_ranking_defect ?? 0).toBe(0);
    expect(report().disposition_counts.reduce((s, e) => s + e.count, 0)).toBe(9);
  });
});
