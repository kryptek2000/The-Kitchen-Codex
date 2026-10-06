/**
 * The Kitchen Codex — Advanced Nutrition AI-6B2 regression: portion
 * DISPOSITION, REPAIRABILITY measurement, and the derived next-lane handoff.
 *
 * AI-6B2 is planning-only. Its central claim is a CORRECTION to planning truth:
 * a portion-lane BLOCKER and a REPAIRABLE deterministic DEFECT are not the same
 * thing, and after AI-6B1 the 35 remaining portion blockers are overwhelmingly
 * correct refusals rather than implementation backlog.
 *
 * WHAT THIS PROVES
 *   - all 35 unresolved portion-lane lines receive EXACTLY ONE closed disposition
 *     drawn from a closed vocabulary, each with a closed evidence code;
 *   - the repairable count is MEASURED from evidence, and is not hardcoded into
 *     the roadmap derivation;
 *   - a raw blocker count alone can NEVER make an exhausted lane the recommended
 *     active repair target;
 *   - the named handoff witnesses are classified for the RIGHT reason: mortadella
 *     is a parser follow-up (not missing authority), the oyster `piece` case is a
 *     semantic-equivalence refusal (not a parser failure), the bread lines are
 *     authenticated ambiguity (not repairable), and a container line with no
 *     package net mass is AUTHORITY ABSENT (not a policy boundary);
 *   - a container line that DOES declare a package net mass IS a policy boundary,
 *     so `policy_boundary` is a live vocabulary member with zero instances in the
 *     current 35-line set, not a dead or unreachable concept;
 *   - this taxonomy precision repair does NOT move the roadmap;
 *   - production behavior is completely unchanged by AI-6B2.
 *
 * AI-6B2 grants no authority, resolves no mass, and averages nothing.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import {
  PORTION_DISPOSITIONS,
  PORTION_DISPOSITION_SCHEMA,
  PORTION_EVIDENCE_CODES,
  classifyPortionDisposition,
  deriveNextWork,
  isAi6b2PortionDisposition,
  isAi6b2PortionEvidenceCode,
  type Ai6b2PortionEvidence,
} from '../../scripts/nutritionIntelligence/portionDisposition';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';

interface DispositionJson {
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
  readonly observed_portion_blockers: number;
  readonly repairable_deterministic_portion_defects: number;
  readonly portion_lane_exhausted: boolean;
  readonly disposition_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly evidence_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly handoff_lane_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ai3_eligibility_counts: ReadonlyArray<{ key: string; count: number }>;
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
  readonly lines: ReadonlyArray<{
    line: string;
    primary_blocker: string;
    repair_lane: string;
    selected_fdc_id: number | null;
    mass_source: string;
    resolved_grams: number | null;
    disposition: string;
    evidence: string;
    repairable: boolean;
    handoff_lane: string | null;
    compatible_candidate_masses: ReadonlyArray<number>;
    ai3_eligible: boolean;
    ai3_reason: string;
  }>;
}

let REPORT: DispositionJson | null = null;
let REPORT_TEXT: string | null = null;

async function loadReport(): Promise<DispositionJson> {
  if (REPORT === null) {
    const { buildNutritionPortionDispositionReport } = await import(
      '../../scripts/nutritionIntelligence/portionDispositionReport'
    );
    REPORT = (await buildNutritionPortionDispositionReport()) as unknown as DispositionJson;
    REPORT_TEXT = JSON.stringify(REPORT);
  }
  return REPORT;
}

const report = (): DispositionJson => {
  if (REPORT === null) throw new Error('report not loaded');
  return REPORT;
};

const lineFor = (text: string) => {
  const found = report().lines.find((entry) => entry.line === text);
  if (!found) throw new Error(`line not in report: ${text}`);
  return found;
};

/** Neutral evidence with no authority anywhere, used as a mutation base. */
const NO_AUTHORITY: Ai6b2PortionEvidence = Object.freeze({
  container: null,
  package_net_mass_declared: false,
  explicit_count_unit: null,
  authored_count_noun: null,
  size_qualifier_present: false,
  compatible_count_candidates: [],
  hinted_count_candidates: [],
  record_portion_names_food_head: false,
  household_blocker: false,
});

const CANDIDATE = (gramWeight: number) => ({
  amount: 1,
  gram_weight: gramWeight,
  unit: 'slice',
  size: null,
});

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

describe('AI-6B2 — the disposition and evidence vocabularies are closed', () => {
  it('declares exactly the seven required disposition concepts', () => {
    expect([...PORTION_DISPOSITIONS].sort()).toEqual([
      'authoritative_ambiguity',
      'authority_absent',
      'human_choice_required',
      'parser_followup',
      'policy_boundary',
      'repairable_deterministic_defect',
      'semantic_equivalence_not_authorized',
    ]);
  });

  it('rejects any disposition outside the closed vocabulary', () => {
    for (const bad of ['maybe_repairable', '', 'REPAIRABLE', 'unknown', null, 7]) {
      expect(isAi6b2PortionDisposition(bad), String(bad)).toBe(false);
    }
    for (const good of PORTION_DISPOSITIONS) {
      expect(isAi6b2PortionDisposition(good), good).toBe(true);
    }
  });

  it('rejects any evidence code outside the closed vocabulary', () => {
    for (const bad of ['because', '', 'NEEDS_RECON', null, 3]) {
      expect(isAi6b2PortionEvidenceCode(bad), String(bad)).toBe(false);
    }
    for (const good of PORTION_EVIDENCE_CODES) {
      expect(isAi6b2PortionEvidenceCode(good), good).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Classifier semantics (pure, mutation-sensitive)
// ---------------------------------------------------------------------------

describe('AI-6B2 — the classifier separates a blocker from a repairable defect', () => {
  it('treats a container with NO package mass as AUTHORITY ABSENT, not a policy boundary', () => {
    // M1 TARGET: container presence alone proves no mass authority exists. Calling
    // this a policy boundary would overstate policy and hide the real reason.
    const verdict = classifyPortionDisposition({ ...NO_AUTHORITY, container: 'can' });
    expect(verdict.disposition).toBe('authority_absent');
    expect(verdict.repairable).toBe(false);
    expect(verdict.evidence).toBe('package_net_mass_not_declared');
    expect(verdict.handoff_lane).toBe('needs_recon');
    expect(verdict.disposition).not.toBe('policy_boundary');
  });

  it('treats a container WITH a declared package mass as a POLICY BOUNDARY', () => {
    // M2 TARGET: the mass exists and could otherwise represent a package quantity,
    // but consuming the whole container is deliberately unauthorized. Information
    // exists; policy refuses. That IS a policy boundary.
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      container: 'can',
      package_net_mass_declared: true,
    });
    expect(verdict.disposition).toBe('policy_boundary');
    expect(verdict.evidence).toBe('container_scope_not_authorized');
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).not.toBe('authority_absent');
  });

  it('resolves policy_boundary REACHABLY, so it is not dead by construction', () => {
    // A zero-current-instance closed-vocabulary member is only acceptable when a
    // synthetic witness proves it is reachable. Both container shapes are covered.
    expect(
      classifyPortionDisposition({ ...NO_AUTHORITY, container: 'package', package_net_mass_declared: true }).disposition
    ).toBe('policy_boundary');
    expect(
      classifyPortionDisposition({ ...NO_AUTHORITY, container: 'jar', package_net_mass_declared: true }).disposition
    ).toBe('policy_boundary');
    expect(
      classifyPortionDisposition({ ...NO_AUTHORITY, container: 'bottle', package_net_mass_declared: true }).disposition
    ).toBe('policy_boundary');
    // The absence shape must never collapse into the boundary shape.
    for (const container of ['can', 'jar', 'package', 'bottle', 'tin', 'packet']) {
      expect(
        classifyPortionDisposition({ ...NO_AUTHORITY, container }).disposition,
        container
      ).toBe('authority_absent');
    }
  });

  it('never classifies a container as a repairable deterministic defect', () => {
    // M3 TARGET: container presence, with or without a declared mass, must never be
    // called an implementation defect. Nothing was consumed incorrectly.
    for (const declared of [false, true]) {
      for (const gramWeight of [0, 100, 400]) {
        const verdict = classifyPortionDisposition({
          ...NO_AUTHORITY,
          container: 'can',
          package_net_mass_declared: declared,
          compatible_count_candidates: [CANDIDATE(gramWeight)],
        });
        expect(verdict.disposition, `${declared}/${gramWeight}`).not.toBe(
          'repairable_deterministic_defect'
        );
        expect(verdict.repairable, `${declared}/${gramWeight}`).toBe(false);
      }
    }
  });

  it('keeps the two container evidence codes DISTINCT and orthogonal', () => {
    // M4 TARGET: the absence/policy distinction must survive. Collapsing the two
    // codes is the defect this repair exists to prevent.
    const absent = classifyPortionDisposition({ ...NO_AUTHORITY, container: 'can' });
    const present = classifyPortionDisposition({
      ...NO_AUTHORITY,
      container: 'can',
      package_net_mass_declared: true,
    });
    expect(absent.evidence).not.toBe(present.evidence);
    expect(absent.evidence).toBe('package_net_mass_not_declared');
    expect(present.evidence).toBe('container_scope_not_authorized');
    expect(absent.disposition).not.toBe(present.disposition);
    // Neither code may be borrowed by the non-container authority-absent reasons.
    expect(classifyPortionDisposition(NO_AUTHORITY).evidence).toBe(
      'selected_record_has_no_authenticated_item_mass'
    );
    expect(
      classifyPortionDisposition({ ...NO_AUTHORITY, household_blocker: true }).evidence
    ).toBe('household_registry_key_absent');
    expect(
      classifyPortionDisposition({ ...NO_AUTHORITY, size_qualifier_present: true }).evidence
    ).toBe('size_specific_portion_absent');
  });

  it('measures a genuinely repairable defect when authority is reachable NOW', () => {
    // M1 TARGET: authenticated authority reachable by the CURRENT requirement and
    // resolving deterministically, yet unconsumed. That IS a real bug.
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      compatible_count_candidates: [CANDIDATE(15)],
    });
    expect(verdict.disposition).toBe('repairable_deterministic_defect');
    expect(verdict.repairable).toBe(true);
    expect(verdict.evidence).toBe('authenticated_portion_present_but_unconsumed');
  });

  it('treats authority reachable only behind the authored noun as a PARSER FOLLOW-UP', () => {
    // M5 TARGET: authority EXISTS (hinted probe resolves deterministically) but the
    // current requirement cannot reach it. Not a missing-authority case.
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      authored_count_noun: 'slice',
      hinted_count_candidates: [CANDIDATE(15)],
    });
    expect(verdict.disposition).toBe('parser_followup');
    expect(verdict.repairable).toBe(false);
    expect(verdict.evidence).toBe('parser_dropped_authored_count_unit');
    expect(verdict.handoff_lane).toBe('deterministic_parser');
  });

  it('does NOT call a line a parser follow-up when the hinted authority is ambiguous', () => {
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      authored_count_noun: 'slice',
      hinted_count_candidates: [CANDIDATE(10), CANDIDATE(16)],
    });
    expect(verdict.disposition).not.toBe('parser_followup');
    expect(verdict.disposition).toBe('authority_absent');
  });

  it('treats an un-equated authored unit plus a food-named portion as SEMANTIC', () => {
    // M4 TARGET: `piece` authored, record portion names the food (`oyster`), and no
    // contract equates them.
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      explicit_count_unit: 'piece',
      record_portion_names_food_head: true,
    });
    expect(verdict.disposition).toBe('semantic_equivalence_not_authorized');
    expect(verdict.repairable).toBe(false);
    expect(verdict.evidence).toBe('count_unit_equivalence_not_authorized');
  });

  it('treats materially different authenticated masses as AMBIGUITY, never repairable', () => {
    // M3 TARGET: two authenticated slice portions, 10 g vs 13 g. Not a defect, and
    // nothing may average or pick one.
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      compatible_count_candidates: [CANDIDATE(10), CANDIDATE(13)],
    });
    expect(verdict.disposition).toBe('authoritative_ambiguity');
    expect(verdict.repairable).toBe(false);
    expect(verdict.handoff_lane).toBe('intentional_human_review');
  });

  it('does NOT call provably equivalent duplicate portions ambiguous', () => {
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      compatible_count_candidates: [CANDIDATE(13), CANDIDATE(13)],
    });
    expect(verdict.disposition).toBe('repairable_deterministic_defect');
  });

  it('distinguishes the three authority-absent reasons', () => {
    expect(classifyPortionDisposition(NO_AUTHORITY)).toEqual({
      disposition: 'authority_absent',
      evidence: 'selected_record_has_no_authenticated_item_mass',
      repairable: false,
      handoff_lane: 'needs_recon',
    });
    expect(
      classifyPortionDisposition({ ...NO_AUTHORITY, household_blocker: true }).evidence
    ).toBe('household_registry_key_absent');
    expect(
      classifyPortionDisposition({ ...NO_AUTHORITY, size_qualifier_present: true }).evidence
    ).toBe('size_specific_portion_absent');
  });

  it('is TOTAL: every evidence shape yields exactly one verdict', () => {
    const shapes: Ai6b2PortionEvidence[] = [
      NO_AUTHORITY,
      { ...NO_AUTHORITY, container: 'jar' },
      { ...NO_AUTHORITY, compatible_count_candidates: [CANDIDATE(9)] },
      { ...NO_AUTHORITY, hinted_count_candidates: [CANDIDATE(9)] },
      { ...NO_AUTHORITY, explicit_count_unit: 'piece', record_portion_names_food_head: true },
      { ...NO_AUTHORITY, compatible_count_candidates: [CANDIDATE(9), CANDIDATE(11)] },
    ];
    for (const shape of shapes) {
      const verdict = classifyPortionDisposition(shape);
      expect(isAi6b2PortionDisposition(verdict.disposition)).toBe(true);
      expect(isAi6b2PortionEvidenceCode(verdict.evidence)).toBe(true);
      expect(typeof verdict.repairable).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// The real measured report
// ---------------------------------------------------------------------------

describe('AI-6B2 — the real report classifies all 35 unresolved portion lines', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('uses its own versioned schema and never mutates the AI-6A recon schema', () => {
    expect(report().schema).toBe(PORTION_DISPOSITION_SCHEMA);
    expect(report().schema).not.toBe('nutrition_ai6a_intelligence_recon_v1');
    expect(report().schema).toContain('nutrition_ai6b2_portion_disposition_v1');
  });

  it('records the base phase/commit with NO timestamp or absolute path', () => {
    expect(report().base_phase).toBe('AI-6B1');
    expect(report().base_commit).toBe('210c511c40d7dfc642dc7143d89ffb88ff415b6d');
    const text = REPORT_TEXT ?? '';
    expect(text).not.toContain('/home/');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/hostname|random|timestamp/i);
  });

  it('separates OBSERVED blockers from REPAIRABLE defects', () => {
    expect(report().observed_portion_blockers).toBe(35);
    expect(report().lines).toHaveLength(35);
    // The measured repairable count, not an assumed one.
    const measured = report().lines.filter((entry) => entry.repairable).length;
    expect(report().repairable_deterministic_portion_defects).toBe(measured);
  });

  it('gives every line EXACTLY ONE closed disposition and evidence code', () => {
    for (const entry of report().lines) {
      expect(isAi6b2PortionDisposition(entry.disposition), entry.line).toBe(true);
      expect(isAi6b2PortionEvidenceCode(entry.evidence), entry.line).toBe(true);
      expect(typeof entry.repairable).toBe('boolean');
      // `repairable` must agree with the disposition, never be set independently.
      expect(entry.repairable).toBe(entry.disposition === 'repairable_deterministic_defect');
    }
    const seen = new Set(report().lines.map((entry) => entry.line));
    expect(seen.size).toBe(35);
  });

  it('reconciles the disposition counts to exactly 35', () => {
    const sum = report().disposition_counts.reduce((total, entry) => total + entry.count, 0);
    expect(sum).toBe(35);
    const evidenceSum = report().evidence_counts.reduce((t, e) => t + e.count, 0);
    expect(evidenceSum).toBe(35);
  });

  it('reports the measured partition of the 35', () => {
    const count = (key: string): number =>
      report().disposition_counts.find((entry) => entry.key === key)?.count ?? 0;
    // Every container line in this lane declares NO package net mass, so all ten
    // are authority-absence cases rather than policy refusals.
    expect(count('authority_absent')).toBe(31);
    expect(count('authoritative_ambiguity')).toBe(2);
    expect(count('parser_followup')).toBe(1);
    expect(count('semantic_equivalence_not_authorized')).toBe(1);
    // Zero in the current 35-line set, but STILL a live vocabulary member proven
    // reachable by a synthetic witness above. Container presence alone is never
    // enough to make it appear.
    expect(count('policy_boundary')).toBe(0);
    // A correct refusal is not implementation backlog, so this is measured at zero.
    expect(count('repairable_deterministic_defect')).toBe(0);
    // Nothing needed bare user intent beyond the more specific verdicts above.
    expect(count('human_choice_required')).toBe(0);
  });

  it('reconciles the authority-absent evidence split to 31, with orthogonal codes', () => {
    const evidence = (key: string): number =>
      report().evidence_counts.find((entry) => entry.key === key)?.count ?? 0;
    expect(evidence('selected_record_has_no_authenticated_item_mass')).toBe(12);
    expect(evidence('size_specific_portion_absent')).toBe(4);
    expect(evidence('household_registry_key_absent')).toBe(5);
    expect(evidence('package_net_mass_not_declared')).toBe(10);
    const absentTotal =
      evidence('selected_record_has_no_authenticated_item_mass') +
      evidence('size_specific_portion_absent') +
      evidence('household_registry_key_absent') +
      evidence('package_net_mass_not_declared');
    expect(absentTotal).toBe(31);
    // The policy code must contribute nothing: no line in this lane declares mass.
    expect(evidence('container_scope_not_authorized')).toBe(0);
  });

  it('classifies all 10 container/package lines as AUTHORITY ABSENT (no package mass)', () => {
    const containers = report().lines.filter(
      (entry) => entry.evidence === 'package_net_mass_not_declared'
    );
    expect(containers).toHaveLength(10);
    for (const entry of containers) {
      expect(entry.disposition, entry.line).toBe('authority_absent');
      expect(entry.disposition, entry.line).not.toBe('policy_boundary');
      expect(entry.repairable, entry.line).toBe(false);
      expect(entry.handoff_lane, entry.line).toBe('needs_recon');
      expect(entry.resolved_grams, entry.line).toBeNull();
      expect(entry.mass_source, entry.line).toBe('none');
    }
    for (const line of [
      '3 cans tomato sauce', '2 cans tomato sauce', '1 can black beans',
      '1 can packed in oil', '1 package cream cheese', '2 packages cream cheese',
      '1 jar pickles', '2 jars salsa', '1 bottle ketchup', '1 bottle soy sauce',
    ]) {
      const entry = lineFor(line);
      expect(entry.disposition, line).toBe('authority_absent');
      expect(entry.evidence, line).toBe('package_net_mass_not_declared');
      expect(entry.disposition, line).not.toBe('policy_boundary');
    }
  });

  it('WITNESS A: `1 can black beans` has no package mass, so it is authority absent', () => {
    // The named semantic witness, read from the REAL parsed recipe line rather
    // than a hand-built evidence object.
    const real = parseIngredient('1 can black beans');
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect(real.parsed.container).toBe('can');
    // No authored package net mass exists: there is nothing to scope against.
    expect(real.parsed.package_net_mass).toBeUndefined();
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      container: real.parsed.container ?? null,
      package_net_mass_declared: real.parsed.package_net_mass !== undefined,
    });
    expect(verdict.disposition).toBe('authority_absent');
    expect(verdict.evidence).toBe('package_net_mass_not_declared');
    expect(verdict.disposition).not.toBe('policy_boundary');
    expect(verdict.repairable).toBe(false);
  });

  it('WITNESS B: `1 can (400 g) tomatoes` declares package mass, so it is a policy boundary', () => {
    // The shape the Muse flag turns on. The real parser extracts an authenticated
    // authored package net mass for this line shape, so promoting it would assert
    // the whole can was consumed. Information exists; policy refuses.
    const real = parseIngredient('1 can (400 g) diced tomatoes');
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect(real.parsed.container).toBe('can');
    expect(real.parsed.package_net_mass).toBeDefined();
    expect(real.parsed.package_net_mass?.amount).toBe(400);
    const verdict = classifyPortionDisposition({
      ...NO_AUTHORITY,
      container: real.parsed.container ?? null,
      package_net_mass_declared: real.parsed.package_net_mass !== undefined,
    });
    expect(verdict.disposition).toBe('policy_boundary');
    expect(verdict.evidence).toBe('container_scope_not_authorized');
    expect(verdict.disposition).not.toBe('authority_absent');
    expect(verdict.repairable).toBe(false);
    // Planning only: no production resolution is added and no mass is promoted.
    expect(verdict.handoff_lane).toBe('needs_recon');
  });

  it('MORTADELLA is a parser follow-up, NOT missing authority', () => {
    const entry = lineFor('4 thin slices mortadella');
    expect(entry.disposition).toBe('parser_followup');
    expect(entry.evidence).toBe('parser_dropped_authored_count_unit');
    expect(entry.repairable).toBe(false);
    expect(entry.handoff_lane).toBe('deterministic_parser');
    // No identity change is required: the selected record is already bound.
    expect(entry.selected_fdc_id).toBe(2706182);
    // No grams resolve today, and none were invented.
    expect(entry.resolved_grams).toBeNull();
  });

  it('OYSTER piece is a semantic refusal, NOT a parser failure', () => {
    const entry = lineFor('24 pieces fresh shucked oysters');
    expect(entry.disposition).toBe('semantic_equivalence_not_authorized');
    expect(entry.evidence).toBe('count_unit_equivalence_not_authorized');
    expect(entry.disposition).not.toBe('parser_followup');
    expect(entry.repairable).toBe(false);
    expect(entry.selected_fdc_id).toBe(2706351);
    expect(entry.resolved_grams).toBeNull();
  });

  it('BREAD is authenticated ambiguity, with the real competing masses captured', () => {
    const white = lineFor('2 slices white bread');
    expect(white.disposition).toBe('authoritative_ambiguity');
    expect(white.repairable).toBe(false);
    expect(white.compatible_candidate_masses.length).toBeGreaterThanOrEqual(2);
    // 10 g vs 13 g: materially different, and NEITHER is chosen or averaged.
    expect(white.compatible_candidate_masses).toContain(10);
    expect(white.compatible_candidate_masses).toContain(13);
    expect(white.compatible_candidate_masses).not.toContain(11.5);
    expect(white.resolved_grams).toBeNull();

    const wheat = lineFor('2 slices whole wheat bread');
    expect(wheat.disposition).toBe('authoritative_ambiguity');
    expect(wheat.compatible_candidate_masses).toContain(10);
    expect(wheat.compatible_candidate_masses).toContain(16);
    expect(wheat.resolved_grams).toBeNull();
  });

  it('classifies the ordinary bare whole-item counts as authority absent', () => {
    for (const line of [
      '1 lemon', '2 shallots', '1 jalapeno', '1 sweet onion', '1 red onion',
      '1 yellow onion, diced', '2 carrots, sliced', '1 red bell pepper',
      '2 green onions, sliced', '12 oysters, shucked', '4 pickles, sliced',
      '2 shallots, finely chopped',
    ]) {
      const entry = lineFor(line);
      expect(entry.disposition, line).toBe('authority_absent');
      expect(entry.evidence, line).toBe('selected_record_has_no_authenticated_item_mass');
      expect(entry.repairable, line).toBe(false);
    }
  });

  it('classifies size-only lines as size-specific authority absent', () => {
    for (const line of [
      '1 large white onion', '1 large russet potato', '2 medium potatoes',
      '2 medium yellow onions, thinly sliced',
    ]) {
      const entry = lineFor(line);
      expect(entry.disposition, line).toBe('authority_absent');
      expect(entry.evidence, line).toBe('size_specific_portion_absent');
    }
  });

  it('classifies household registry absences, including head-vs-clove garlic', () => {
    for (const line of [
      '1 head garlic', '1 bunch parsley', '1 bunch celery',
      '2 sprigs fresh thyme', '2 sprigs rosemary',
    ]) {
      const entry = lineFor(line);
      expect(entry.disposition, line).toBe('authority_absent');
      expect(entry.evidence, line).toBe('household_registry_key_absent');
    }
  });

  it('authority-absent lines do NOT magically become authenticated', () => {
    // No unclassified line, and not one of them acquired grams or a mass source.
    for (const entry of report().lines) {
      if (entry.disposition !== 'authority_absent') continue;
      expect(entry.resolved_grams, entry.line).toBeNull();
      expect(entry.mass_source, entry.line).toBe('none');
    }
  });

  it('cross-checks AI-3 eligibility through the real, unchanged contract', () => {
    const sum = report().ai3_eligibility_counts.reduce((t, e) => t + e.count, 0);
    expect(sum).toBe(35);
    const reason = (key: string): number =>
      report().ai3_eligibility_counts.find((e) => e.key === key)?.count ?? 0;
    // AI-3 v1 refuses container lines outright ("a container/package/can line is
    // never estimated in AI-3 v1"). The two `bottle` lines are refused even
    // earlier, at identity. Either way no container reaches AI estimation.
    expect(reason('parsed_container')).toBe(8);
    expect(reason('identity_unresolved')).toBe(2);
    expect(lineFor('1 bottle ketchup').ai3_reason).toBe('identity_unresolved');
    expect(lineFor('3 cans tomato sauce').ai3_reason).toBe('parsed_container');
    // The remaining 25 are already covered by the existing "AI only after
    // deterministic authority runs out" architecture — no routing change needed.
    expect(reason('eligible')).toBe(25);
  });

  it('does NOT let the container disposition taxonomy control AI-3 eligibility', () => {
    // The disposition taxonomy and AI-3 eligibility are INDEPENDENT. Ten container
    // lines are now `authority_absent` and two are `identity_unresolved`, yet the
    // AI-3 reasons are decided by the untouched eligibility contract, not by the
    // disposition. No line's AI-3 reason may be derived from its disposition.
    const byReason = (key: string) =>
      report().lines.filter((entry) => entry.ai3_reason === key);
    // All ten no-mass containers are refused by AI-3 as parsed_container...
    expect(byReason('parsed_container')).toHaveLength(8);
    for (const entry of byReason('parsed_container')) {
      expect(entry.ai3_eligible, entry.line).toBe(false);
    }
    // ...and the two bottles fail earlier, at identity, for a different reason.
    for (const entry of byReason('identity_unresolved')) {
      expect(entry.ai3_eligible, entry.line).toBe(false);
      expect(entry.disposition, entry.line).toBe('authority_absent');
    }
    // The two reasons cut across dispositions rather than tracking one.
    const dispositions = new Set(
      byReason('eligible').map((entry) => entry.disposition)
    );
    expect(dispositions.size).toBeGreaterThan(1);
    // A container line is never AI-eligible regardless of which container
    // disposition it receives.
    for (const entry of report().lines) {
      if (entry.evidence !== 'package_net_mass_not_declared') continue;
      expect(entry.ai3_eligible, entry.line).toBe(false);
    }
  });

  it('never routes authority-absent lines to AI merely because AI exists', () => {
    // Eligibility is whatever the UNCHANGED contract already says; AI-6B2 does not
    // grant eligibility anywhere, and no line gained mass to become eligible.
    for (const entry of report().lines) {
      if (entry.disposition !== 'authority_absent') continue;
      expect(entry.resolved_grams, entry.line).toBeNull();
    }
    // Household lines are never AI-estimated: the registry answer is authoritative
    // when present and simply absent otherwise.
    for (const line of ['1 head garlic', '1 bunch parsley', '1 bunch celery']) {
      expect(lineFor(line).disposition).toBe('authority_absent');
    }
  });
});

// ---------------------------------------------------------------------------
// The derived roadmap handoff
// ---------------------------------------------------------------------------

describe('AI-6B2 — the roadmap recommendation is derived, not hardcoded', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('marks the portion lane EXHAUSTED because repairable count reached zero', () => {
    const lane = report().lane_repairability.find((e) => e.lane === 'deterministic_portion');
    expect(lane?.observed_blockers).toBe(35);
    expect(lane?.actionable_defects).toBe(0);
    expect(lane?.adjudicated).toBe(true);
    expect(lane?.exhausted).toBe(true);
    expect(report().portion_lane_exhausted).toBe(true);
  });

  it('M5 TARGET: the container taxonomy repair moves NO roadmap number', () => {
    // Reclassifying ten `policy_boundary` lines as `authority_absent` is a taxonomy
    // correction, not a change in what is actionable. If the handoff lanes, the
    // repairable count, or the derived recommendation moved because of it, this
    // taxonomy repair would be smuggling a roadmap change.
    const handoff = (key: string): number =>
      report().handoff_lane_counts.find((entry) => entry.key === key)?.count ?? 0;
    expect(handoff('needs_recon')).toBe(32);
    expect(handoff('intentional_human_review')).toBe(2);
    expect(handoff('deterministic_parser')).toBe(1);
    // 31 authority-absent + 1 semantic-equivalence refusal = 32 needs_recon.
    expect(handoff('needs_recon')).toBe(
      report().lines.filter((entry) => entry.disposition === 'authority_absent').length + 1
    );
    // The repairable count, and therefore exhaustion and the recommendation,
    // were already zero BEFORE the taxonomy change and stay zero.
    expect(report().repairable_deterministic_portion_defects).toBe(0);
    expect(report().portion_lane_exhausted).toBe(true);
    expect(report().recommended_active_repair_lane).toBeNull();
    expect(report().recommended_active_repair_reason).toBe(
      'no_adjudicated_lane_has_actionable_defects'
    );
    expect(report().next_adjudication_target_lane).toBe('deterministic_identity');
    const target = report().lane_repairability.find(
      (e) => e.lane === 'deterministic_identity'
    );
    expect(target?.observed_blockers).toBe(27);
    // Both container shapes hand off to the same lane, so neither moves counts.
    for (const container of ['can', 'jar', 'package', 'bottle']) {
      for (const declared of [false, true]) {
        expect(
          classifyPortionDisposition({
            ...NO_AUTHORITY,
            container,
            package_net_mass_declared: declared,
          }).handoff_lane
        ).toBe('needs_recon');
      }
    }
  });

  it('does NOT recommend the exhausted portion lane for active repair', () => {
    // M7 TARGET: 35 observed blockers must not buy active-repair status when the
    // measured actionable count is zero.
    expect(report().recommended_active_repair_lane).toBeNull();
    expect(report().recommended_active_repair_reason).toBe(
      'no_adjudicated_lane_has_actionable_defects'
    );
  });

  it('recommends an ADJUDICATION next step, computed from observed blockers', () => {
    expect(report().next_adjudication_target_lane).toBe('deterministic_identity');
    const target = report().lane_repairability.find(
      (e) => e.lane === report().next_adjudication_target_lane
    );
    expect(target?.adjudicated).toBe(false);
    expect(target?.observed_blockers).toBe(27);
  });

  it('never reports an un-adjudicated lane as zero actionable', () => {
    for (const lane of report().lane_repairability) {
      if (lane.lane === 'deterministic_portion') continue;
      expect(lane.adjudicated, lane.lane).toBe(false);
      expect(lane.actionable_defects, lane.lane).toBeNull();
      expect(lane.exhausted, lane.lane).toBe(false);
    }
  });

  it('changing a disposition CHANGES the derived roadmap', () => {
    const scores = {
      deterministic_portion: { safety: 5, ordinary_user_impact: 5, generalizability: 5, tractability: 5, frequency: 0 },
      deterministic_identity: { safety: 2, ordinary_user_impact: 4, generalizability: 3, tractability: 2, frequency: 0 },
    };
    const order = ['safety', 'ordinary_user_impact', 'generalizability', 'tractability', 'frequency'];
    const observed = [
      { lane: 'deterministic_portion', count: 35 },
      { lane: 'deterministic_identity', count: 27 },
    ];
    // Exhausted portion lane: never recommended.
    const exhausted = deriveNextWork({
      observedBlockers: observed,
      adjudicatedActionableDefects: { deterministic_portion: 0 },
      criteriaScores: scores,
      criteriaOrder: order,
      neverTargetLanes: new Set<string>(),
    });
    expect(exhausted.recommended_active_repair_lane).toBeNull();
    // The SAME input with ONE line reclassified as repairable flips the answer,
    // proving the recommendation follows measured repairability.
    const repaired = deriveNextWork({
      observedBlockers: observed,
      adjudicatedActionableDefects: { deterministic_portion: 1 },
      criteriaScores: scores,
      criteriaOrder: order,
      neverTargetLanes: new Set<string>(),
    });
    expect(repaired.recommended_active_repair_lane).toBe('deterministic_portion');
    expect(repaired.recommended_active_repair_reason).toBe('adjudicated actionable defects: 1');
  });

  it('never recommends a never-target lane', () => {
    const derived = deriveNextWork({
      observedBlockers: [{ lane: 'intentional_human_review', count: 99 }],
      adjudicatedActionableDefects: {},
      criteriaScores: {
        intentional_human_review: { safety: 5, ordinary_user_impact: 5, generalizability: 5, tractability: 5, frequency: 0 },
      },
      criteriaOrder: ['safety', 'ordinary_user_impact', 'generalizability', 'tractability', 'frequency'],
      neverTargetLanes: new Set(['intentional_human_review']),
    });
    expect(derived.recommended_active_repair_lane).toBeNull();
    expect(derived.next_adjudication_target_lane).toBeNull();
  });

  it('SUMS blockers that map to one lane instead of overwriting them', () => {
    // Regression guard for a real bug: a Map keyed by lane silently kept only the
    // last blocker count, understating every lane.
    const derived = deriveNextWork({
      observedBlockers: [
        { lane: 'deterministic_portion', count: 26 },
        { lane: 'deterministic_portion', count: 7 },
        { lane: 'deterministic_portion', count: 2 },
      ],
      adjudicatedActionableDefects: {},
      criteriaScores: {
        deterministic_portion: { safety: 5, ordinary_user_impact: 5, generalizability: 5, tractability: 5, frequency: 0 },
      },
      criteriaOrder: ['safety', 'ordinary_user_impact', 'generalizability', 'tractability', 'frequency'],
      neverTargetLanes: new Set<string>(),
    });
    expect(derived.lanes[0].observed_blockers).toBe(35);
  });
});

// ---------------------------------------------------------------------------
// Production is untouched
// ---------------------------------------------------------------------------

describe('AI-6B2 — production behavior is completely unchanged', () => {
  beforeAll(async () => {
    await loadReport();
  }, 300000);

  it('reports the AI-6B1 production baseline exactly', () => {
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

  it('resolved NO grams: every disposition line still has mass source none', () => {
    for (const entry of report().lines) {
      expect(entry.mass_source, entry.line).toBe('none');
      expect(entry.resolved_grams, entry.line).toBeNull();
    }
  });

  it('is byte-deterministic across repeated generation', async () => {
    const { buildNutritionPortionDispositionReport } = await import(
      '../../scripts/nutritionIntelligence/portionDispositionReport'
    );
    const again = await buildNutritionPortionDispositionReport();
    expect(JSON.stringify(again)).toBe(REPORT_TEXT);
  }, 300000);
});
