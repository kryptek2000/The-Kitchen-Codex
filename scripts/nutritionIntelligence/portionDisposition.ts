/**
 * The Kitchen Codex — Advanced Nutrition AI-6B2: portion DISPOSITION and
 * REPAIRABILITY (planning only, zero production consumers).
 *
 * WHY THIS EXISTS
 * ---------------
 * AI-6B1 closed two genuine deterministic-portion defects and left 35 lines in
 * the `deterministic_portion` lane. After adjudication, most of those 35 are NOT
 * deterministic implementation defects: they are CORRECT REFUSALS because
 * authenticated mass authority is absent, policy forbids an inference, or
 * authoritative evidence is genuinely ambiguous.
 *
 * The planning label `deterministic_portion = 35` therefore OVERSTATED the
 * remaining implementation work, because a BLOCKER and a REPAIRABILITY verdict
 * are not the same thing.
 *
 * THE ARCHITECTURAL CORRECTION
 * ----------------------------
 * A blocker stays EXACTLY as observed. This module adds an ORTHOGONAL, closed
 * disposition axis beside it. Nothing here rewrites blocker truth, corpus
 * membership, authored text, identity labels, mass sources, or grams in order to
 * move a roadmap ranking — that would be scoreboard gaming. The disposition is
 * derived from real, read-only evidence gathered through the existing public
 * session contracts.
 *
 * CONTAINER TAXONOMY PRECISION (AI-6B2-R1)
 * -----------------------------------------
 * Container/package PRESENCE by itself is not a policy boundary. A policy
 * boundary means the information EXISTS and policy refuses to promote it, so it
 * requires relevant mass evidence. The two container situations are therefore
 * separated by whether an authored package net mass actually exists:
 *   - package net mass declared -> `policy_boundary` / `container_scope_not_authorized`
 *     (information exists, consumption scope is deliberately unauthorized);
 *   - no package net mass declared -> `authority_absent` / `package_net_mass_not_declared`
 *     (there is no mass authority to promote in the first place).
 * `policy_boundary` remains a live member of the closed vocabulary with a
 * synthetic witness; it simply has zero instances in the current 35-line
 * deterministic-portion set, because every container line there declares no mass.
 *
 * WHAT IT IS NOT
 * --------------
 * It grants no authority, resolves no mass, changes no production behavior, and
 * imports no production module for the purpose of altering one. It never invents
 * an average item weight, never borrows a portion across FDC records, never
 * promotes a package net mass, never averages two authenticated masses, and
 * never asserts a count-unit equivalence the canonical contracts do not hold.
 *
 * PURE, offline, deterministic: no clock, randomness, hostname, absolute path, or
 * environment-dependent field. Two runs are byte-identical.
 */

/** Explicit planning-artifact schema version (independent of the AI-6A recon). */
export const PORTION_DISPOSITION_SCHEMA = 'nutrition_ai6b2_portion_disposition_v1';

// ---------------------------------------------------------------------------
// CLOSED disposition vocabulary
// ---------------------------------------------------------------------------

/**
 * What KIND of problem a portion-lane blocker actually is.
 *
 * The distinction that matters: only `repairable_deterministic_defect` means
 * "authenticated deterministic authority exists and production fails to consume
 * it because of an implementation defect". Every other value is a correct
 * refusal, an authority decision we decline to make automatically, or work that
 * belongs to a different lane entirely.
 */
export const PORTION_DISPOSITIONS = [
  /** Authenticated authority EXISTS and production fails to consume it (a real bug). */
  'repairable_deterministic_defect',
  /**
   * No authenticated USDA/count/household/package mass authority exists for the
   * authored quantity. ABSENCE of authority, including a container line that
   * declares no package net mass — nothing was refused because nothing was there
   * to promote.
   */
  'authority_absent',
  /**
   * RELEVANT MASS EVIDENCE EXISTS and policy deliberately declines to promote it
   * into consumed-ingredient authority. This requires the evidence to be present:
   * container/package presence by itself is NOT a policy boundary.
   */
  'policy_boundary',
  /** Multiple authenticated choices with materially different results; nothing authorizes choosing. */
  'authoritative_ambiguity',
  /** Authority may exist, but deterministic parsing does not preserve the authored unit/form. */
  'parser_followup',
  /** Resolving would require asserting an equivalence no canonical contract authorizes. */
  'semantic_equivalence_not_authorized',
  /** Genuinely requires user intent rather than any more specific disposition above. */
  'human_choice_required',
] as const;

export type Ai6b2PortionDisposition = (typeof PORTION_DISPOSITIONS)[number];

const DISPOSITION_SET: ReadonlySet<string> = new Set(PORTION_DISPOSITIONS);

/** Closed membership test for the disposition vocabulary. */
export function isAi6b2PortionDisposition(value: unknown): value is Ai6b2PortionDisposition {
  return typeof value === 'string' && DISPOSITION_SET.has(value);
}

// ---------------------------------------------------------------------------
// CLOSED evidence vocabulary
// ---------------------------------------------------------------------------

/**
 * A bounded, machine-checkable REASON for a disposition. Free-form prose is not
 * evidence; every disposition must name one of these codes.
 */
export const PORTION_EVIDENCE_CODES = [
  /**
   * An authored package net mass EXISTS that could otherwise represent a package
   * quantity, but policy refuses to promote it (promoting would assert the whole
   * container was consumed). Requires the declared mass; see
   * `package_net_mass_not_declared` for the absence case.
   */
  'container_scope_not_authorized',
  /**
   * A container/package is authored with NO declared package net mass, so there is
   * no mass authority to scope against. Authority absence, not a policy refusal.
   */
  'package_net_mass_not_declared',
  /** An authenticated portion exists that would resolve deterministically, yet none is consumed. */
  'authenticated_portion_present_but_unconsumed',
  /** The parser did not retain an authored count unit, so no requirement can reach the portion. */
  'parser_dropped_authored_count_unit',
  /** An authored count unit and the record's portion noun are not equated by any contract. */
  'count_unit_equivalence_not_authorized',
  /** Two or more authenticated candidates resolve to materially different masses. */
  'materially_different_authenticated_masses',
  /** The selected record exposes no authenticated item mass usable for the authored quantity. */
  'selected_record_has_no_authenticated_item_mass',
  /** A size is authored but the record exposes no portion carrying that size. */
  'size_specific_portion_absent',
  /** No authenticated household-registry row matches this food/unit/size key. */
  'household_registry_key_absent',
] as const;

export type Ai6b2PortionEvidenceCode = (typeof PORTION_EVIDENCE_CODES)[number];

const EVIDENCE_SET: ReadonlySet<string> = new Set(PORTION_EVIDENCE_CODES);

/** Closed membership test for the evidence vocabulary. */
export function isAi6b2PortionEvidenceCode(value: unknown): value is Ai6b2PortionEvidenceCode {
  return typeof value === 'string' && EVIDENCE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Evidence shape
// ---------------------------------------------------------------------------

/** One authenticated count-portion candidate, reduced to the decisive numbers. */
export interface Ai6b2CountCandidateView {
  readonly amount: number;
  readonly gram_weight: number;
  readonly unit: string | null;
  readonly size: string | null;
}

/**
 * All evidence the classifier needs, gathered READ-ONLY through the existing
 * public session contracts. Nothing here is inferred from prose.
 */
export interface Ai6b2PortionEvidence {
  /** Container noun authored by the recipe (`can`, `jar`, `bottle`, ...), else null. */
  readonly container: string | null;
  /** True when the recipe declared a package net mass alongside the container. */
  readonly package_net_mass_declared: boolean;
  /** Canonical count unit derived from an EXPLICIT authored unit word, else null. */
  readonly explicit_count_unit: string | null;
  /** Count noun the authored line contains behind other words (e.g. `thin slices`). */
  readonly authored_count_noun: string | null;
  /** True when the line authors a size qualifier. */
  readonly size_qualifier_present: boolean;
  /** Authenticated count candidates reachable by the CURRENT derived requirement. */
  readonly compatible_count_candidates: ReadonlyArray<Ai6b2CountCandidateView>;
  /**
   * Authenticated count candidates reachable ONLY when the authored count noun is
   * supplied as a bounded hint. A non-empty set here with an empty
   * `compatible_count_candidates` proves authority exists that production cannot
   * currently reach.
   */
  readonly hinted_count_candidates: ReadonlyArray<Ai6b2CountCandidateView>;
  /** True when a selected-record portion names the recipe's own food head noun. */
  readonly record_portion_names_food_head: boolean;
  /** True when the observed blocker is household-authority absence. */
  readonly household_blocker: boolean;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface Ai6b2DispositionVerdict {
  readonly disposition: Ai6b2PortionDisposition;
  readonly evidence: Ai6b2PortionEvidenceCode;
  /** True only for a genuine deterministic implementation defect. */
  readonly repairable: boolean;
  /** Closed handoff lane for non-repairable work, else null. */
  readonly handoff_lane: string | null;
}

/** True when every candidate resolves to the SAME authoritative (amount, gram_weight). */
function allEquivalent(
  candidates: ReadonlyArray<Ai6b2CountCandidateView>
): boolean {
  if (candidates.length === 0) return false;
  const first = candidates[0];
  return candidates.every(
    (entry) => entry.amount === first.amount && entry.gram_weight === first.gram_weight
  );
}

/**
 * Maps evidence to exactly ONE disposition plus ONE evidence code.
 *
 * The predicates are ordered from most specific to most general, so a line is
 * never given a vaguer verdict than the evidence supports. Total: every input
 * yields a verdict, so no line can be unclassified.
 */
export function classifyPortionDisposition(
  evidence: Ai6b2PortionEvidence
): Ai6b2DispositionVerdict {
  // 1. Container / package presence is NOT by itself a policy boundary.
  //
  //    A policy boundary means the information EXISTS and policy deliberately
  //    declines to promote it. Container presence alone proves no such thing, so
  //    the two container situations must be separated by whether authored package
  //    net mass actually exists:
  //
  //    CASE A — a package net mass IS declared (e.g. `1 (15 oz) can tomato sauce`).
  //    The mass could otherwise represent a package quantity, but promoting it
  //    would assert the WHOLE container was consumed. Information exists; policy
  //    refuses. That is a genuine `policy_boundary`.
  if (evidence.container !== null && evidence.package_net_mass_declared) {
    return Object.freeze({
      disposition: 'policy_boundary' as const,
      evidence: 'container_scope_not_authorized' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
    });
  }

  //    CASE B — NO authored or authenticated package net mass exists (e.g.
  //    `1 can black beans`). There is no mass authority to promote in the first
  //    place, so nothing was refused: this is ABSENCE of authority, not a policy
  //    boundary. Calling it `policy_boundary` would overstate policy and hide the
  //    real reason from any later phase.
  if (evidence.container !== null) {
    return Object.freeze({
      disposition: 'authority_absent' as const,
      evidence: 'package_net_mass_not_declared' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
    });
  }

  // 2. Authenticated authority exists but only behind an authored count noun the
  //    current requirement never reaches. That is a PARSER handoff, not a
  //    missing-authority case and not a portion-authority invention.
  if (
    evidence.compatible_count_candidates.length === 0 &&
    evidence.hinted_count_candidates.length > 0 &&
    allEquivalent(evidence.hinted_count_candidates)
  ) {
    return Object.freeze({
      disposition: 'parser_followup' as const,
      evidence: 'parser_dropped_authored_count_unit' as const,
      repairable: false,
      handoff_lane: 'deterministic_parser',
    });
  }

  // 3. An authored count unit plus a record portion that names the food itself,
  //    with no contract equating them (`piece` vs `oyster`).
  if (
    evidence.explicit_count_unit !== null &&
    evidence.compatible_count_candidates.length === 0 &&
    evidence.record_portion_names_food_head
  ) {
    return Object.freeze({
      disposition: 'semantic_equivalence_not_authorized' as const,
      evidence: 'count_unit_equivalence_not_authorized' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
    });
  }

  // 4. Several authenticated candidates that materially disagree. Human review is
  //    the correct outcome; averaging or picking one is forbidden.
  if (evidence.compatible_count_candidates.length > 1 && !allEquivalent(evidence.compatible_count_candidates)) {
    return Object.freeze({
      disposition: 'authoritative_ambiguity' as const,
      evidence: 'materially_different_authenticated_masses' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
    });
  }

  // 5. THE ONLY REPAIRABLE CLASS. Authenticated authority is reachable by the
  //    CURRENT requirement and resolves deterministically, yet production has not
  //    consumed it. This is a genuine implementation defect.
  if (evidence.compatible_count_candidates.length > 0 && allEquivalent(evidence.compatible_count_candidates)) {
    return Object.freeze({
      disposition: 'repairable_deterministic_defect' as const,
      evidence: 'authenticated_portion_present_but_unconsumed' as const,
      repairable: true,
      handoff_lane: 'deterministic_portion',
    });
  }

  // 6. No reachable authenticated authority at all. Distinguish WHY, because the
  //    reason is what a later phase would need to change.
  if (evidence.household_blocker) {
    return Object.freeze({
      disposition: 'authority_absent' as const,
      evidence: 'household_registry_key_absent' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
    });
  }
  if (evidence.size_qualifier_present) {
    return Object.freeze({
      disposition: 'authority_absent' as const,
      evidence: 'size_specific_portion_absent' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
    });
  }
  return Object.freeze({
    disposition: 'authority_absent' as const,
    evidence: 'selected_record_has_no_authenticated_item_mass' as const,
    repairable: false,
    handoff_lane: 'needs_recon',
  });
}

// ---------------------------------------------------------------------------
// Repairability-aware roadmap handoff
// ---------------------------------------------------------------------------

export interface Ai6b2LaneRepairability {
  readonly lane: string;
  /** Observed blocker count for the lane (unchanged truth from the recon). */
  readonly observed_blockers: number;
  /**
   * Count of lines in the lane that are genuinely actionable now, or null when
   * AI-6B2 has NOT adjudicated that lane. Null is honest: it must never be
   * silently read as zero.
   */
  readonly actionable_defects: number | null;
  readonly adjudicated: boolean;
  /** True only when adjudicated AND actionable_defects === 0. */
  readonly exhausted: boolean;
}

export interface Ai6b2NextWork {
  /** The lane to actively repair now, or null when nothing is actionable. */
  readonly recommended_active_repair_lane: string | null;
  readonly recommended_active_repair_reason: string;
  /** The un-adjudicated lane to measure next (NOT a repair instruction). */
  readonly next_adjudication_target_lane: string | null;
  readonly next_adjudication_reason: string;
  /** Full ranking over every lane, with repairability attached. */
  readonly lanes: ReadonlyArray<Ai6b2LaneRepairability>;
}

export interface Ai6b2NextWorkInput {
  readonly observedBlockers: ReadonlyArray<{ readonly lane: string; readonly count: number }>;
  /** Lane -> actionable defect count, only for lanes AI-6B2 adjudicated. */
  readonly adjudicatedActionableDefects: Readonly<Record<string, number>>;
  readonly criteriaScores: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly criteriaOrder: ReadonlyArray<string>;
  readonly neverTargetLanes: ReadonlySet<string>;
}

/**
 * Derives the current next-work recommendation from MEASURED repairability.
 *
 * This is deliberately NOT "the lane with the most blockers". An exhausted lane
 * (adjudicated, zero actionable defects) can never be recommended, however large
 * its observed blocker count, because correct refusals are not implementation
 * backlog. Nothing about a specific lane name is hardcoded: the recommendation
 * falls out of the criteria order applied to measured actionable counts, and
 * changing any disposition changes the derived result.
 */
export function deriveNextWork(input: Ai6b2NextWorkInput): Ai6b2NextWork {
  // Several blockers can map to one lane, so blocker counts are SUMMED per lane
  // before anything is derived from them.
  const observed = new Map<string, number>();
  for (const entry of input.observedBlockers) {
    observed.set(entry.lane, (observed.get(entry.lane) ?? 0) + entry.count);
  }
  const lanes: Ai6b2LaneRepairability[] = [];
  for (const lane of Object.keys(input.criteriaScores)) {
    const raw = input.adjudicatedActionableDefects[lane];
    const adjudicated = raw !== undefined;
    const actionable = adjudicated ? (raw as number) : null;
    lanes.push(
      Object.freeze({
        lane,
        observed_blockers: observed.get(lane) ?? 0,
        actionable_defects: actionable,
        adjudicated,
        exhausted: adjudicated && actionable === 0,
      })
    );
  }

  const eligible = lanes.filter(
    (lane) => !input.neverTargetLanes.has(lane.lane)
  );
  const actionableLanes = eligible.filter(
    (lane) => lane.adjudicated && (lane.actionable_defects ?? 0) > 0
  );

  // Lexicographic comparison in the DECLARED criterion order, with frequency
  // replaced by the MEASURED actionable-defect count rather than raw blockers.
  const compare = (a: Ai6b2LaneRepairability, b: Ai6b2LaneRepairability): number => {
    const sa = input.criteriaScores[a.lane];
    const sb = input.criteriaScores[b.lane];
    for (const criterion of input.criteriaOrder) {
      const va = criterion === 'frequency' ? (a.actionable_defects ?? 0) : (sa?.[criterion] ?? 0);
      const vb = criterion === 'frequency' ? (b.actionable_defects ?? 0) : (sb?.[criterion] ?? 0);
      if (va !== vb) return vb - va;
    }
    return (b.actionable_defects ?? 0) - (a.actionable_defects ?? 0);
  };

  const rankedActionable = [...actionableLanes].sort(compare);
  const recommended =
    rankedActionable.length > 0 ? rankedActionable[0].lane : null;

  // Next ADJUDICATION target: the eligible lane whose repairability is still
  // unmeasured, ranked by observed blocker count. This is a measurement
  // instruction, deliberately NOT presented as a repair instruction.
  const unadjudicated = eligible
    .filter((lane) => !lane.adjudicated)
    .sort((a, b) => b.observed_blockers - a.observed_blockers);
  const adjudicationTarget = unadjudicated.length > 0 ? unadjudicated[0].lane : null;

  return Object.freeze({
    recommended_active_repair_lane: recommended,
    recommended_active_repair_reason:
      recommended !== null
        ? `adjudicated actionable defects: ${rankedActionable[0].actionable_defects}`
        : 'no_adjudicated_lane_has_actionable_defects',
    next_adjudication_target_lane: adjudicationTarget,
    next_adjudication_reason:
      adjudicationTarget !== null
        ? `largest un-adjudicated eligible lane by observed blockers: ${unadjudicated[0].observed_blockers}`
        : 'every eligible lane has been adjudicated',
    lanes: Object.freeze(lanes),
  });
}
