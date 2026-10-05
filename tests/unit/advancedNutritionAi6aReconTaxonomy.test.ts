/**
 * The Kitchen Codex — Advanced Nutrition AI-6A recon TAXONOMY regression.
 *
 * Fast, bundle-free proof that the AI-6A diagnostic vocabulary is CLOSED, that
 * blocker precedence is deterministic and safety-first, and that the classifier
 * cannot be mutated into any of the dangerous behaviors this phase exists to
 * prevent.
 *
 * Every case here is MUTATION-SENSITIVE: each one fails if someone weakens the
 * classification contract (crediting an estimate as authenticated, inventing
 * correctness, hiding an unsafe identity, labeling a catalog gap when a
 * candidate exists, or merging a distinct class into a generic one).
 *
 * AI-6A is measurement-only: nothing in this file changes a nutrition truth.
 */

import { describe, it, expect } from 'vitest';

import {
  AI6A_BLOCKER_TOTAL,
  AI6A_FAILURE_BLOCKERS,
  AI6A_FAILURE_BLOCKER_TOTAL,
  AI6A_IDENTITY_CORRECTNESS,
  AI6A_INDEFINITE_MEASURE_UNITS,
  AI6A_SUCCESS_SENTINEL,
  boundedAuthoredMeasurement,
  portionResolvableQuantity,
  rangeEndpointsRepresented,
  isIndefiniteMeasureUnit,
  AI6A_PRIMARY_BLOCKERS,
  AI6A_REPAIR_LANES,
  AI6A_SECONDARY_SIGNALS,
  AI6A_COUNT_NOUN_CLASSES,
  AI6A_TERMINALS,
  AI6A_MASS_SOURCES,
  AUTHENTICATED_MASS_SOURCES,
  BLOCKER_PRECEDENCE,
  BLOCKER_TO_LANE,
  blockerPrecedenceRank,
  isAi6aPrimaryBlocker,
  isAi6aRepairLane,
  isAi6aSecondarySignal,
  isAi6aCountNounClass,
  isAuthenticatedMassSource,
  laneForBlocker,
} from '../../scripts/nutritionIntelligence/taxonomy';
import {
  classifyPrimaryBlocker,
  classifyIdentityCorrectness,
  countNounClassFor,
  hasExplicitQualitativeCue,
  identityReviewSymptomPresent,
  isContainerNounClass,
  isCountUnitNounClass,
  isHouseholdNounClass,
  structuredIngredient,
  type CorpusExpectation,
  type PrecedenceInput,
} from '../../scripts/nutritionIntelligence/diagnose';

/** A resolved, unremarkable line. Individual cases override one field each. */
function baseline(overrides: Partial<PrecedenceInput> = {}): PrecedenceInput {
  return {
    resolved: false,
    massSource: 'none',
    correctness: 'unverified',
    parsedOk: true,
    quantityKind: 'exact',
    measurementKind: 'volume',
    rangeEndpointsRepresented: false,
    directMassUnapplied: false,
    reviewOutcome: 'review_required',
    selectedFdcId: 170054,
    selectedCompatible: false,
    alternateCompatible: false,
    container: null,
    packageNetMass: null,
    hasAlternative: false,
    qualitative: false,
    catalogProbeTotal: 0,
    countNounClass: 'none',
    portionResolvable: true,
    ...overrides,
  };
}

describe('AI-6A — closed vocabularies', () => {
  it('every primary blocker is unique and belongs to the closed vocabulary', () => {
    expect(new Set(AI6A_PRIMARY_BLOCKERS).size).toBe(AI6A_PRIMARY_BLOCKERS.length);
    for (const blocker of AI6A_PRIMARY_BLOCKERS) expect(isAi6aPrimaryBlocker(blocker)).toBe(true);
  });

  it('blocker precedence covers every blocker exactly once, none_resolved excluded', () => {
    expect(new Set(BLOCKER_PRECEDENCE).size).toBe(BLOCKER_PRECEDENCE.length);
    const precedence = new Set(BLOCKER_PRECEDENCE);
    // `none_resolved` is a terminal-success short-circuit guarded by the unsafe
    // check, so it is deliberately NOT part of the failure precedence ladder.
    for (const blocker of AI6A_PRIMARY_BLOCKERS) {
      if (blocker === 'none_resolved') continue;
      expect(precedence.has(blocker)).toBe(true);
    }
  });

  it('every blocker has exactly one repair lane and every lane is closed', () => {
    expect(Object.keys(BLOCKER_TO_LANE).sort()).toStrictEqual([...AI6A_PRIMARY_BLOCKERS].sort());
    for (const blocker of AI6A_PRIMARY_BLOCKERS) {
      const lane = laneForBlocker(blocker);
      expect(isAi6aRepairLane(lane)).toBe(true);
    }
    expect(new Set(AI6A_REPAIR_LANES).size).toBe(AI6A_REPAIR_LANES.length);
  });

  it('an unknown blocker or lane is rejected rather than coerced', () => {
    expect(isAi6aPrimaryBlocker('needs_amount')).toBe(false);
    expect(isAi6aPrimaryBlocker('unsafe_auto_identity')).toBe(true);
    expect(isAi6aRepairLane('let_ai_own_identity')).toBe(false);
    expect(isAi6aSecondarySignal('made_up_signal')).toBe(false);
    expect(isAi6aCountNounClass('slices')).toBe(false);
  });

  it('the identity correctness axis is exactly the three closed classes', () => {
    expect([...AI6A_IDENTITY_CORRECTNESS]).toEqual([
      'verified_correct',
      'verified_unsafe',
      'unverified',
    ]);
  });

  it('no AI estimate can ever be an authenticated mass source', () => {
    // The vocabulary physically cannot express an estimate. This is the AI-3
    // invariance: an estimate is estimate-class, never authenticated mass.
    for (const source of AI6A_MASS_SOURCES) {
      expect(source === ('ai_estimate' as string)).toBe(false);
      expect(source === ('estimate' as string)).toBe(false);
      expect(source === ('bounded_estimate' as string)).toBe(false);
    }
    expect(isAuthenticatedMassSource('none')).toBe(false);
    for (const source of AUTHENTICATED_MASS_SOURCES) {
      expect(isAuthenticatedMassSource(source)).toBe(true);
    }
  });

  it('every terminal is a real live-projection status, not a blocker name', () => {
    for (const terminal of AI6A_TERMINALS) {
      expect(isAi6aPrimaryBlocker(terminal)).toBe(false);
    }
    // The UI states this taxonomy exists to replace as a root cause.
    expect(isAi6aPrimaryBlocker('needs_amount')).toBe(false);
    expect(isAi6aPrimaryBlocker('needs_match')).toBe(false);
    expect(isAi6aPrimaryBlocker('review_suggested')).toBe(false);
  });

  it('pins the EXACT enum accounting: 18 total = 1 sentinel + 17 failures', () => {
    // AI-6A-R1 Issue 6. The pre-repair report said "closed, 16" while listing 17
    // values. The arithmetic is now pinned so it cannot drift again.
    // AI-6A-R2 added `measurement_policy_gap`, taking 17 -> 18 declared values.
    expect(AI6A_BLOCKER_TOTAL).toBe(18);
    expect(AI6A_SUCCESS_SENTINEL).toBe('none_resolved');
    expect(AI6A_FAILURE_BLOCKER_TOTAL).toBe(17);
    expect(AI6A_FAILURE_BLOCKERS).toHaveLength(17);
    expect(AI6A_FAILURE_BLOCKERS).not.toContain(AI6A_SUCCESS_SENTINEL);
    // 1 + 17 must reconstruct the whole vocabulary exactly.
    expect(AI6A_FAILURE_BLOCKER_TOTAL + 1).toBe(AI6A_PRIMARY_BLOCKERS.length);
    expect(new Set([AI6A_SUCCESS_SENTINEL, ...AI6A_FAILURE_BLOCKERS])).toEqual(
      new Set(AI6A_PRIMARY_BLOCKERS)
    );
  });

  it('pins that exactly ONE declared blocker is the success sentinel', () => {
    expect(
      AI6A_PRIMARY_BLOCKERS.filter((blocker) => blocker === AI6A_SUCCESS_SENTINEL)
    ).toHaveLength(1);
    // A success sentinel is not reachable through the failure ladder.
    expect(BLOCKER_PRECEDENCE).not.toContain(AI6A_SUCCESS_SENTINEL);
  });

  it('precedence is total and every rank is distinct', () => {
    const ranks = BLOCKER_PRECEDENCE.map(blockerPrecedenceRank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('declares the blockers in EXACTLY precedence order', () => {
    // Mutation-sensitive: R1's doc comment claimed the declaration was ordered
    // "EXACTLY as BLOCKER_PRECEDENCE" while two container blockers were swapped.
    // A claim like that has to be enforced, not written.
    expect([...AI6A_PRIMARY_BLOCKERS]).toStrictEqual([
      AI6A_SUCCESS_SENTINEL,
      ...BLOCKER_PRECEDENCE,
    ]);
  });
});

describe('AI-6A-R2 — bounded authored measurements are NEVER qualitative or absent', () => {
  it('accepts a bounded exact MASS measurement', () => {
    // The `8 oz spaghetti` case, stated as a unit contract.
    expect(
      boundedAuthoredMeasurement({ quantityKind: 'exact', amount: 8, rawUnit: 'oz' })
    ).toBe(true);
    expect(portionResolvableQuantity({ quantityKind: 'exact', amount: 8, rawUnit: 'oz' })).toBe(true);
  });

  it('accepts a bounded exact VOLUME measurement', () => {
    for (const probe of [
      { quantityKind: 'exact', amount: 2, rawUnit: 'tbsp' },
      { quantityKind: 'exact', amount: 1, rawUnit: 'cup' },
    ] as const) {
      expect(boundedAuthoredMeasurement(probe), JSON.stringify(probe)).toBe(true);
    }
  });

  it('accepts a bounded exact COUNT measurement, including an implicit count', () => {
    for (const probe of [
      { quantityKind: 'exact', amount: 3, rawUnit: 'cloves' },
      { quantityKind: 'exact', amount: 1 },
    ] as const) {
      expect(boundedAuthoredMeasurement(probe), JSON.stringify(probe)).toBe(true);
    }
  });

  it('accepts a RANGE with both endpoints parsed', () => {
    expect(
      boundedAuthoredMeasurement({
        quantityKind: 'range',
        amount: null,
        quantityRange: { lower: 1, upper: 2 },
        rawUnit: 'tbsp',
      })
    ).toBe(true);
  });

  it('rejects a RANGE whose endpoints were never represented', () => {
    // Mutation-sensitive: `quantity_kind: 'range'` with no extracted endpoints is
    // exactly the parse gap, and must not be treated as a bounded measurement.
    expect(
      boundedAuthoredMeasurement({ quantityKind: 'range', amount: null, rawUnit: 'tbsp' })
    ).toBe(false);
    expect(
      boundedAuthoredMeasurement({
        quantityKind: 'range',
        amount: null,
        quantityRange: { lower: Number.NaN, upper: 2 },
      })
    ).toBe(false);
    expect(rangeEndpointsRepresented({ quantityKind: 'range' })).toBe(false);
    expect(
      rangeEndpointsRepresented({
        quantityKind: 'range',
        quantityRange: { lower: 2, upper: 3 },
      })
    ).toBe(true);
    expect(
      rangeEndpointsRepresented({
        quantityKind: 'exact',
        quantityRange: { lower: 2, upper: 3 },
      })
    ).toBe(false);
  });

  it('rejects an absent amount and an INDEFINITE unit', () => {
    expect(boundedAuthoredMeasurement({ quantityKind: 'absent', amount: null })).toBe(false);
    expect(
      boundedAuthoredMeasurement({ quantityKind: 'exact', amount: 1, rawUnit: 'handful' })
    ).toBe(false);
    expect(boundedAuthoredMeasurement({ quantityKind: 'exact', amount: Number.NaN })).toBe(false);
    expect(boundedAuthoredMeasurement({ quantityKind: 'exact', amount: null })).toBe(false);
  });

  it('has exactly ONE notion of "is this amount measurable"', () => {
    // Mutation-sensitive: the R1 defect was two divergent notions — the portion
    // gate and a raw `amount === null` signal test — disagreeing on ranges.
    const probes = [
      { quantityKind: 'absent', amount: null, rawUnit: undefined },
      { quantityKind: 'exact', amount: 8, rawUnit: 'oz' },
      { quantityKind: 'exact', amount: 2, rawUnit: 'tbsp' },
      { quantityKind: 'exact', amount: 3, rawUnit: 'cloves' },
      { quantityKind: 'exact', amount: 1, rawUnit: 'handful' },
      { quantityKind: 'exact', amount: 1, rawUnit: undefined },
      { quantityKind: 'range', amount: null, rawUnit: 'tbsp' },
      {
        quantityKind: 'range',
        amount: null,
        rawUnit: 'tbsp',
        quantityRange: { lower: 1, upper: 2 },
      },
    ] as const;
    for (const probe of probes) {
      expect(portionResolvableQuantity(probe), JSON.stringify(probe)).toBe(
        boundedAuthoredMeasurement(probe)
      );
    }
  });
});

describe('AI-6A-R2 — a root cause outranks an ordinary identity symptom', () => {
  it('an unbounded authored amount outranks ordinary identity review', () => {
    // The `drizzle of olive oil` / `fresh dill for garnish` shape: identity also
    // needs review, but repairing identity alone still cannot produce truthful
    // grams, so the identity SYMPTOM must not hide the root cause.
    expect(
      classifyPrimaryBlocker(
        baseline({
          reviewOutcome: 'review_required',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          portionResolvable: false,
          qualitative: true,
        })
      )
    ).toBe('qualitative_or_absent_amount');
  });

  it('an explicit authored ALTERNATIVE outranks ordinary identity review', () => {
    // The `2 tbsp butter or margarine` shape: a bounded quantity IS present, so
    // the amount axis stays out of the way, and choosing one of the two foods
    // would manufacture authored intent.
    expect(
      classifyPrimaryBlocker(
        baseline({
          reviewOutcome: 'review_required',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          hasAlternative: true,
        })
      )
    ).toBe('alternative_ambiguous');
  });

  it('still lets identity_unmatched outrank both — no identity at all is deeper', () => {
    // Mutation-sensitive: over-correcting Issue 2 until a total identity failure
    // is reported as an authored-amount problem.
    expect(
      blockerPrecedenceRank('identity_unmatched')
    ).toBeLessThan(blockerPrecedenceRank('qualitative_or_absent_amount'));
    expect(blockerPrecedenceRank('identity_unmatched')).toBeLessThan(
      blockerPrecedenceRank('alternative_ambiguous')
    );
    expect(
      classifyPrimaryBlocker(
        baseline({
          reviewOutcome: 'unmatched',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          catalogProbeTotal: 9,
          portionResolvable: false,
          qualitative: true,
          hasAlternative: true,
        })
      )
    ).toBe('identity_unmatched');
  });

  it('keeps both safety ranks above every root cause', () => {
    expect(blockerPrecedenceRank('unsafe_auto_identity')).toBe(0);
    expect(blockerPrecedenceRank('parse_failed')).toBe(1);
    for (const blocker of [
      'measurement_parse_gap',
      'measurement_policy_gap',
      'qualitative_or_absent_amount',
      'alternative_ambiguous',
    ] as const) {
      expect(blockerPrecedenceRank(blocker)).toBeGreaterThan(1);
    }
  });

  it('a verified-unsafe identity STILL outranks an unbounded amount', () => {
    // Mutation-sensitive: hiding a wrong food beneath an authored-amount gap.
    expect(
      classifyPrimaryBlocker(
        baseline({
          correctness: 'verified_unsafe',
          reviewOutcome: 'review_required',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          portionResolvable: false,
          qualitative: true,
          hasAlternative: true,
        })
      )
    ).toBe('unsafe_auto_identity');
  });

  it('still reports the identity symptom as evidence, so nothing is hidden', () => {
    expect(
      identityReviewSymptomPresent({
        resolved: false,
        reviewOutcome: 'review_required',
        selectedFdcId: null,
      })
    ).toBe(true);
    expect(
      identityReviewSymptomPresent({
        resolved: false,
        reviewOutcome: 'unmatched',
        selectedFdcId: null,
      })
    ).toBe(false);
    expect(
      identityReviewSymptomPresent({
        resolved: true,
        reviewOutcome: 'review_required',
        selectedFdcId: null,
      })
    ).toBe(false);
    expect(AI6A_SECONDARY_SIGNALS).toContain('identity_review_symptom_present');
  });
});

describe('AI-6A-R2 — the package net-mass boundary is a POLICY decision, not an estimate', () => {
  it('never maps the container net-mass boundary to AI bounded estimation', () => {
    // The R1 mapping told the roadmap to have AI estimate a mass the AUTHOR
    // already declared. It is not an estimation problem at all.
    expect(BLOCKER_TO_LANE.container_net_mass_boundary).not.toBe('ai_bounded_mass_estimation');
    expect(laneForBlocker('container_net_mass_boundary')).toBe('needs_recon');
  });

  it('never authorizes package net mass as a mass-estimation lane anywhere', () => {
    for (const [blocker, lane] of Object.entries(BLOCKER_TO_LANE)) {
      if (blocker !== 'container_net_mass_boundary') continue;
      expect(lane).not.toBe('ai_bounded_mass_estimation');
    }
  });

  it('routes a parsed-but-unconsumed measurement to a policy lane, not to AI', () => {
    // No semantic interpretation is needed merely to know `1-2 tbsp`.
    expect(laneForBlocker('measurement_policy_gap')).toBe('needs_recon');
    expect(laneForBlocker('measurement_parse_gap')).toBe('deterministic_parser');
    expect(laneForBlocker('measurement_parse_gap')).not.toBe('ai_semantic_interpretation');
  });
});

describe('AI-6A-R2 — the two measurement blockers are distinct concepts', () => {
  it('names them separately in the closed vocabulary', () => {
    expect(isAi6aPrimaryBlocker('measurement_policy_gap')).toBe(true);
    expect(isAi6aPrimaryBlocker('measurement_parse_gap')).toBe(true);
    expect(AI6A_PRIMARY_BLOCKERS).toContain('measurement_policy_gap');
  });

  it('ranks the parse gap above the policy gap', () => {
    // A mis-captured measurement is the deeper defect.
    expect(blockerPrecedenceRank('measurement_parse_gap')).toBeLessThan(
      blockerPrecedenceRank('measurement_policy_gap')
    );
  });
});

describe('AI-6A — exactly one primary blocker, with real evidence', () => {
  it('assigns none_resolved to an authenticated resolution', () => {
    expect(classifyPrimaryBlocker(baseline({ resolved: true, massSource: 'source_portion' }))).toBe(
      'none_resolved'
    );
  });

  it('a resolved line with NO authenticated mass is never reported as resolved', () => {
    // Mutation-sensitive: crediting a resolution that produced no mass.
    expect(classifyPrimaryBlocker(baseline({ resolved: true, massSource: 'none' }))).not.toBe(
      'none_resolved'
    );
  });

  it('assigns parse_failed when the frozen parser refused the text', () => {
    expect(
      classifyPrimaryBlocker(
        baseline({ parsedOk: false, reviewOutcome: null, selectedFdcId: null })
      )
    ).toBe('parse_failed');
  });

  it('assigns measurement_POLICY_gap for a range whose endpoints WERE parsed', () => {
    // AI-6A-R2 Issue 4. The endpoints are truthfully represented; no authorized
    // policy consumes them. Calling that a PARSE failure is false.
    expect(
      classifyPrimaryBlocker(baseline({ quantityKind: 'range', rangeEndpointsRepresented: true }))
    ).toBe('measurement_policy_gap');
  });

  it('assigns measurement_PARSE_gap for a range whose endpoints were NOT represented', () => {
    // Mutation-sensitive: collapsing the parse gap and the policy gap back into
    // one concept. Only a genuinely mis-captured measurement is a parse gap.
    expect(
      classifyPrimaryBlocker(baseline({ quantityKind: 'range', rangeEndpointsRepresented: false }))
    ).toBe('measurement_parse_gap');
    expect(classifyPrimaryBlocker(baseline({ quantityKind: 'range' }))).toBe('measurement_parse_gap');
  });

  it('never lets a parsed-but-unconsumed measurement be called a PARSE gap', () => {
    // An identity WAS bound and the mass still did not apply. The measurement was
    // represented correctly, so this is a policy gap, not a parse gap.
    expect(
      classifyPrimaryBlocker(baseline({ measurementKind: 'mass', directMassUnapplied: true }))
    ).toBe('measurement_policy_gap');
    expect(
      classifyPrimaryBlocker(baseline({ measurementKind: 'mass', directMassUnapplied: true }))
    ).not.toBe('measurement_parse_gap');
  });

  it('does NOT call a parsed mass a measurement gap when no identity was bound', () => {
    // Mutation-sensitive: sending AI-6B to the measurement layer for a line whose
    // mass parsed perfectly and whose real failure is that nothing was identified.
    expect(
      classifyPrimaryBlocker(
        baseline({
          measurementKind: 'mass',
          directMassUnapplied: false,
          reviewOutcome: 'unmatched',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          catalogProbeTotal: 0,
        })
      )
    ).toBe('catalog_or_specificity_gap');
    expect(
      classifyPrimaryBlocker(
        baseline({
          measurementKind: 'mass',
          directMassUnapplied: false,
          reviewOutcome: 'review_required',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          catalogProbeTotal: 3,
        })
      )
    ).toBe('identity_needs_review');
  });

  it('assigns identity_unmatched only when a catalog probe found something plausible', () => {
    // Mutation-sensitive: labeling a MATCHER failure as a CATALOG gap.
    expect(
      classifyPrimaryBlocker(
        baseline({
          reviewOutcome: 'unmatched',
          selectedFdcId: null,
          catalogProbeTotal: 12,
        })
      )
    ).toBe('identity_unmatched');
  });

  it('assigns catalog_or_specificity_gap only when NOTHING plausible exists', () => {
    // Mutation-sensitive: claiming a catalog gap while a candidate is present.
    expect(
      classifyPrimaryBlocker(
        baseline({ reviewOutcome: 'unmatched', selectedFdcId: null, catalogProbeTotal: 0 })
      )
    ).toBe('catalog_or_specificity_gap');
    expect(
      classifyPrimaryBlocker(
        baseline({ reviewOutcome: 'unmatched', selectedFdcId: null, catalogProbeTotal: 1 })
      )
    ).not.toBe('catalog_or_specificity_gap');
  });

  it('labels compatible_candidate_not_selected only with REAL alternate portion evidence', () => {
    // Mutation-sensitive: asserting a ranking failure without naming a candidate.
    expect(
      classifyPrimaryBlocker(baseline({ alternateCompatible: true, selectedCompatible: false }))
    ).toBe('compatible_candidate_not_selected');
    expect(classifyPrimaryBlocker(baseline({ alternateCompatible: false }))).not.toBe(
      'compatible_candidate_not_selected'
    );
  });

  it('separates "record lacks a portion" from "record has one but no mass resulted"', () => {
    expect(classifyPrimaryBlocker(baseline({ selectedCompatible: false }))).toBe(
      'selected_record_lacks_source_portion'
    );
    expect(classifyPrimaryBlocker(baseline({ selectedCompatible: true }))).toBe(
      'compatible_portion_unresolved'
    );
  });

  it('separates count-unit, household, and container portion gaps by noun class', () => {
    expect(
      classifyPrimaryBlocker(baseline({ selectedCompatible: false, countNounClass: 'slice' }))
    ).toBe('authenticated_count_portion_absent');
    expect(
      classifyPrimaryBlocker(baseline({ selectedCompatible: false, countNounClass: 'bunch' }))
    ).toBe('household_portion_absent');
    expect(
      classifyPrimaryBlocker(baseline({ selectedCompatible: false, countNounClass: 'can' }))
    ).toBe('selected_record_lacks_source_portion');
  });

  it('withholds ALL portion evidence when the authored quantity is unmeasurable', () => {
    // AI-6A-R1 CORE TRUTHFULNESS RULE. A perfect USDA portion cannot resolve
    // `handful fresh spinach` or `skim milk`, so calling those portion defects
    // is a lie. `portionResolvable: false` must remove every portion label.
    for (const blocker of [
      'selected_record_lacks_source_portion',
      'authenticated_count_portion_absent',
      'household_portion_absent',
      'compatible_candidate_not_selected',
      'compatible_portion_unresolved',
    ] as const) {
      expect(
        classifyPrimaryBlocker(
          baseline({
            portionResolvable: false,
            selectedCompatible: false,
            countNounClass: 'slice',
            qualitative: true,
          })
        ),
        blocker
      ).not.toBe(blocker);
    }
  });

  it('reports an unmeasurable amount as an amount cause, not a portion defect', () => {
    expect(
      classifyPrimaryBlocker(
        baseline({ portionResolvable: false, selectedCompatible: false, qualitative: true })
      )
    ).toBe('qualitative_or_absent_amount');
  });

  it('still reports a portion defect when the quantity IS measurable', () => {
    // Mutation-sensitive: over-correcting the gate until real portion gaps vanish.
    expect(
      classifyPrimaryBlocker(
        baseline({ portionResolvable: true, selectedCompatible: false, countNounClass: 'slice' })
      )
    ).toBe('authenticated_count_portion_absent');
  });

  it('separates a bare container from a declared package net mass', () => {
    // Shaped on the real `1 package breadcrumbs` / `1 (8 oz) package cream cheese`
    // shapes: no identity was bound at all, so only the container evidence is live.
    const noIdentity = {
      reviewOutcome: 'unmatched',
      selectedFdcId: null,
      selectedCompatible: null,
      alternateCompatible: null,
      catalogProbeTotal: 0,
    } as const;
    expect(classifyPrimaryBlocker(baseline({ ...noIdentity, container: 'package' }))).toBe(
      'container_mass_absent'
    );
    // Without the container the same line is honestly a catalog/specificity gap.
    expect(classifyPrimaryBlocker(baseline({ ...noIdentity }))).toBe(
      'catalog_or_specificity_gap'
    );
  });

  it('lets an explicit package-net-mass POLICY boundary outrank a missing portion', () => {
    // AI-6A-R1 Issue 4. When the declared net mass is WHY policy refuses to
    // resolve, that boundary IS the blocker and must not hide behind the generic
    // "selected record has no source portion" symptom.
    expect(
      classifyPrimaryBlocker(
        baseline({ container: 'can', packageNetMass: 425, selectedCompatible: false })
      )
    ).toBe('container_net_mass_boundary');
    expect(
      classifyPrimaryBlocker(
        baseline({
          container: 'package',
          packageNetMass: 227,
          selectedCompatible: false,
          countNounClass: 'package',
        })
      )
    ).toBe('container_net_mass_boundary');
    // The bare container (no declared mass) is a DIFFERENT root cause.
    expect(
      classifyPrimaryBlocker(
        baseline({ container: 'package', selectedCompatible: false, countNounClass: 'package' })
      )
    ).toBe('selected_record_lacks_source_portion');
    // And precedence must be strictly ordered, not merely "declared first".
    expect(blockerPrecedenceRank('container_net_mass_boundary')).toBeLessThan(
      blockerPrecedenceRank('selected_record_lacks_source_portion')
    );
    expect(blockerPrecedenceRank('container_net_mass_boundary')).toBeLessThan(
      blockerPrecedenceRank('compatible_candidate_not_selected')
    );
    expect(blockerPrecedenceRank('container_net_mass_boundary')).toBeLessThan(
      blockerPrecedenceRank('container_mass_absent')
    );
  });

  it('keeps intentional alternative ambiguity distinct from identity failure', () => {
    // Mutation-sensitive: merging an authored `X or Y` into an identity failure.
    // A resolvable quantity is present, so the amount axis stays out of the way.
    expect(
      classifyPrimaryBlocker(
        baseline({
          reviewOutcome: 'matched_exact',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          hasAlternative: true,
        })
      )
    ).toBe('alternative_ambiguous');
  });

  it('ranks an unmeasurable amount ABOVE an authored alternative', () => {
    // AI-6A-R1 precedence: an authored-absent amount is a CAUSE; the alternative
    // is only resolvable once a quantity exists at all.
    expect(
      classifyPrimaryBlocker(
        baseline({
          reviewOutcome: 'matched_exact',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          hasAlternative: true,
          qualitative: true,
        })
      )
    ).toBe('qualitative_or_absent_amount');
  });

  it('keeps intentional qualitative intent distinct from an ordinary amount failure', () => {
    // Mutation-sensitive: merging `to taste` into a missing-amount defect.
    expect(
      classifyPrimaryBlocker(
        baseline({
          reviewOutcome: 'matched_exact',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
          qualitative: true,
        })
      )
    ).toBe('qualitative_or_absent_amount');
  });

  it('falls back to unclassified rather than inventing a label', () => {
    expect(
      classifyPrimaryBlocker(
        baseline({
          reviewOutcome: 'matched_exact',
          selectedFdcId: null,
          selectedCompatible: null,
          alternateCompatible: null,
        })
      )
    ).toBe('unclassified');
  });
});

describe('AI-6A — unsafe automatic identity outranks everything', () => {
  it('outranks an ordinary unresolved amount blocker', () => {
    // Mutation-sensitive: hiding a wrong food beneath a missing-amount failure.
    expect(
      classifyPrimaryBlocker(
        baseline({
          correctness: 'verified_unsafe',
          selectedCompatible: false,
          countNounClass: 'slice',
          container: 'can',
          qualitative: true,
        })
      )
    ).toBe('unsafe_auto_identity');
  });

  it('outranks a SUCCESSFUL resolution — a wrong food is worse than a missing amount', () => {
    expect(
      classifyPrimaryBlocker(
        baseline({
          resolved: true,
          massSource: 'source_portion',
          correctness: 'verified_unsafe',
        })
      )
    ).toBe('unsafe_auto_identity');
  });

  it('outranks parse failure and every other precedence rank', () => {
    expect(
      classifyPrimaryBlocker(
        baseline({ correctness: 'verified_unsafe', parsedOk: false, reviewOutcome: null })
      )
    ).toBe('unsafe_auto_identity');
    expect(blockerPrecedenceRank('unsafe_auto_identity')).toBeLessThan(
      blockerPrecedenceRank('parse_failed')
    );
    for (const blocker of AI6A_PRIMARY_BLOCKERS) {
      if (blocker === 'unsafe_auto_identity') continue;
      expect(blockerPrecedenceRank('unsafe_auto_identity')).toBeLessThan(
        blockerPrecedenceRank(blocker)
      );
    }
  });
});

describe('AI-6A — identity correctness is only asserted from fixture knowledge', () => {
  const expectation = (fields: CorpusExpectation): CorpusExpectation => fields;

  it('is unverified with no checked-in expectation at all', () => {
    // Mutation-sensitive: treating an unlabeled line as verified correct.
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: 2705854,
        selectedDescription: 'Beef, ground, raw',
        expectation: undefined,
      })
    ).toBe('unverified');
  });

  it('is unverified when nothing was bound', () => {
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: null,
        selectedDescription: null,
        expectation: expectation({ expectedAutoFdc: 2705854 }),
      })
    ).toBe('unverified');
  });

  it('is verified_correct only on an exact expected FDC id', () => {
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: 2705854,
        selectedDescription: 'Beef, ground, raw',
        expectation: expectation({ expectedAutoFdc: 2705854 }),
      })
    ).toBe('verified_correct');
  });

  it('is unverified for a bound identity the corpus does not speak to', () => {
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: 999999,
        selectedDescription: 'Something else',
        expectation: expectation({ expectedAutoFdc: 2705854 }),
      })
    ).toBe('unverified');
  });

  it('is verified_unsafe on a forbidden FDC id', () => {
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: 168277,
        selectedDescription: 'Pork, cured, bacon',
        expectation: expectation({ forbiddenAutoFdcs: [168277] }),
      })
    ).toBe('verified_unsafe');
  });

  it('is verified_unsafe on a forbidden description pattern', () => {
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: 170054,
        selectedDescription: 'Fish, sardines in tomato sauce',
        expectation: expectation({ forbiddenAutoDescription: /sardine|fish/i }),
      })
    ).toBe('verified_unsafe');
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: 170054,
        selectedDescription: 'Tomato products, canned, sauce',
        expectation: expectation({ forbiddenAutoDescription: /sardine|fish/i }),
      })
    ).not.toBe('verified_unsafe');
  });

  it('is verified_unsafe when the corpus forbids ANY automatic identity', () => {
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: 170501,
        selectedDescription: 'Tomatoes, canned, crushed',
        expectation: expectation({ expectNoAutomatic: true }),
      })
    ).toBe('verified_unsafe');
  });

  it('does not treat a known-issue baseline as a safety expectation', () => {
    // `baselineAutoFdc` is a recorded current value, not a correctness contract:
    // a DIFFERENT identity is `unverified`, never silently `verified_unsafe`.
    expect(
      classifyIdentityCorrectness({
        selectedFdcId: 111111,
        selectedDescription: 'Beans, canned',
        expectation: expectation({ baselineAutoFdc: 2707359, knownIssue: 'nfs-variant' }),
      })
    ).toBe('unverified');
  });
});

describe('AI-6A — count/household noun classification', () => {
  it('folds every plural onto its closed singular class', () => {
    // Mutation-sensitive: letting `slices` and `slice` split one noun census.
    for (const [plural, singular] of [
      ['slices', 'slice'],
      ['cloves', 'clove'],
      ['heads', 'head'],
      ['stalks', 'stalk'],
      ['sticks', 'stick'],
      ['sprigs', 'sprig'],
      ['bunches', 'bunch'],
      ['cans', 'can'],
      ['jars', 'jar'],
      ['packages', 'package'],
      ['packets', 'packet'],
    ] as const) {
      expect(countNounClassFor(plural, `2 ${plural} of something`)).toBe(singular);
      expect(countNounClassFor(undefined, `2 ${plural} of something`)).toBe(singular);
    }
  });

  it('always returns a member of the closed noun vocabulary', () => {
    for (const authored of [
      '1 egg',
      '4 pickles, sliced',
      '1 bunch parsley',
      '1 jar marinara sauce',
      '2 cups milk',
      '1 tbsp olive oil',
      'salt to taste',
      '',
    ]) {
      expect(isAi6aCountNounClass(countNounClassFor(undefined, authored))).toBe(true);
    }
  });

  it('does NOT classify `whole milk` as a whole_item count', () => {
    // AI-6A-R1 Issue 2. Food-state wording collided with count wording, which
    // mis-filed this under authenticated_count_portion_absent.
    expect(countNounClassFor(undefined, 'whole milk', { amount: null, quantityKind: 'absent' })).toBe(
      'none'
    );
    expect(countNounClassFor(undefined, 'whole milk', { amount: 1, quantityKind: 'exact' })).toBe(
      'none'
    );
  });

  it('CAN classify `1 whole chicken` / `2 whole lemons` as whole_item', () => {
    // The positive half: with parse context supporting a count, `whole` IS an
    // item descriptor.
    expect(
      countNounClassFor(undefined, '1 whole chicken', { amount: 1, quantityKind: 'exact' })
    ).toBe('whole_item');
    expect(
      countNounClassFor(undefined, '2 whole lemons', { amount: 2, quantityKind: 'exact' })
    ).toBe('whole_item');
    // The parser's own canonical noun still wins.
    expect(countNounClassFor('whole', '1 whole chicken', { amount: 1, quantityKind: 'exact' })).toBe(
      'whole_item'
    );
  });

  it('does NOT make `whole wheat bread` or `whole cloves` a whole_item from tokens', () => {
    // Mutation-sensitive: token presence alone must never decide this.
    expect(
      countNounClassFor(undefined, 'whole wheat bread', { amount: null, quantityKind: 'absent' })
    ).toBe('none');
    // `whole cloves` resolves to the CLOVE noun; `whole` is food form, so the
    // class must never be `whole_item`.
    expect(
      countNounClassFor(undefined, 'whole cloves', { amount: null, quantityKind: 'absent' })
    ).toBe('clove');
    expect(
      countNounClassFor(undefined, 'whole cloves', { amount: null, quantityKind: 'absent' })
    ).not.toBe('whole_item');
    // `2 whole cloves`: the parser resolves the count noun to `clove`, so `whole`
    // is correctly read as food form rather than an item descriptor.
    expect(countNounClassFor('clove', '2 whole cloves', { amount: 2, quantityKind: 'exact' })).toBe(
      'clove'
    );
    // `2 slices whole wheat bread`: the count noun is `slice`, never `whole`.
    expect(
      countNounClassFor('slice', '2 slices whole wheat bread', { amount: 2, quantityKind: 'exact' })
    ).toBe('slice');
  });

  it('separates unit, household, and container noun classes', () => {
    expect(isCountUnitNounClass('slice')).toBe(true);
    expect(isHouseholdNounClass('bunch')).toBe(true);
    expect(isContainerNounClass('jar')).toBe(true);
    expect(isHouseholdNounClass('slice')).toBe(false);
    expect(isContainerNounClass('bunch')).toBe(false);
    expect(isCountUnitNounClass('can')).toBe(false);
  });
});

describe('AI-6A-R1 — the quantity-resolvability gate', () => {
  it('rejects a line with no quantity at all', () => {
    expect(portionResolvableQuantity({ quantityKind: 'absent', amount: null })).toBe(false);
  });

  it('rejects a number in front of an INDEFINITE unit', () => {
    // `1 handful` and `1 dash` carry a digit but are not measurable.
    expect(
      portionResolvableQuantity({ quantityKind: 'exact', amount: 1, rawUnit: 'handful' })
    ).toBe(false);
    expect(portionResolvableQuantity({ quantityKind: 'exact', amount: 1, rawUnit: 'dash' })).toBe(
      false
    );
    expect(isIndefiniteMeasureUnit('Handful')).toBe(true);
    expect(isIndefiniteMeasureUnit('tbsp')).toBe(false);
    expect(isIndefiniteMeasureUnit(undefined)).toBe(false);
    expect(AI6A_INDEFINITE_MEASURE_UNITS.has('handful')).toBe(true);
  });

  it('accepts a real measurable quantity, including an implicit count', () => {
    // Mutation-sensitive: over-correcting the gate until real portion gaps vanish.
    expect(portionResolvableQuantity({ quantityKind: 'exact', amount: 2, rawUnit: 'tbsp' })).toBe(
      true
    );
    expect(portionResolvableQuantity({ quantityKind: 'exact', amount: 2 })).toBe(true);
    expect(portionResolvableQuantity({ quantityKind: 'exact', amount: 1 })).toBe(true);
    // AI-6A-R2: a range is bounded only when BOTH endpoints were extracted. R1
    // accepted `quantity_kind: 'range'` on its own, which made
    // `measurement_parse_gap` unreachable for a range and collapsed the
    // parse/policy distinction this repair exists to draw.
    expect(
      portionResolvableQuantity({
        quantityKind: 'range',
        amount: null,
        rawUnit: 'tbsp',
        quantityRange: { lower: 1, upper: 2 },
      })
    ).toBe(true);
    expect(portionResolvableQuantity({ quantityKind: 'range', amount: null })).toBe(false);
  });

  it('rejects a non-finite or absent amount', () => {
    expect(
      portionResolvableQuantity({ quantityKind: 'exact', amount: Number.NaN })
    ).toBe(false);
    expect(portionResolvableQuantity({ quantityKind: 'exact', amount: null })).toBe(false);
  });
});

describe('AI-6A-R1 — brand token vs qualitative quantity word', () => {
  it('does NOT treat the BRAND `Mrs. Dash` as a qualitative dash', () => {
    // Mutation-sensitive: an explicit `1 tbsp` measurement plus a brand name must
    // never be filed as an under-specified qualitative amount.
    expect(hasExplicitQualitativeCue('1 tbsp Mrs. Dash')).toBe(false);
    expect(hasExplicitQualitativeCue('2 tbsp Mrs. Dash')).toBe(false);
    expect(hasExplicitQualitativeCue('1 TABLESPOON MRS. DASH')).toBe(false);
  });

  it('DOES treat a genuine dash quantity phrase as qualitative', () => {
    expect(hasExplicitQualitativeCue('a dash of pepper')).toBe(true);
    expect(hasExplicitQualitativeCue('a dash of salt')).toBe(true);
    expect(hasExplicitQualitativeCue('dash of pepper')).toBe(true);
  });

  it('is case-insensitive for the qualitative cue vocabulary', () => {
    expect(hasExplicitQualitativeCue('A Dash of Pepper')).toBe(true);
    expect(hasExplicitQualitativeCue('to Taste')).toBe(true);
    expect(hasExplicitQualitativeCue('for Garnish')).toBe(true);
  });

  it('recognizes every documented qualitative cue', () => {
    for (const cue of [
      'salt to taste',
      'as needed',
      'fresh dill for garnish',
      'olives for serving',
      'a pinch of saffron',
      'a handful of parsley',
      'a drizzle of olive oil',
      'a splash of cream',
      'a sprinkle of sugar',
      'a dash of pepper',
    ]) {
      expect(hasExplicitQualitativeCue(cue), cue).toBe(true);
    }
  });
});

describe('AI-6A — secondary signals are bounded and non-authoritative', () => {
  it('declares a closed, duplicate-free signal vocabulary', () => {
    expect(new Set(AI6A_SECONDARY_SIGNALS).size).toBe(AI6A_SECONDARY_SIGNALS.length);
    for (const signal of AI6A_SECONDARY_SIGNALS) expect(isAi6aSecondarySignal(signal)).toBe(true);
  });

  it('keeps portion evidence and candidate presence as diagnostics only', () => {
    // These are observability labels. None of them can become authority.
    expect(AI6A_SECONDARY_SIGNALS).toContain('alternate_candidate_has_compatible_portion');
    expect(AI6A_SECONDARY_SIGNALS).toContain('plausible_candidate_present');
    expect(AI6A_SECONDARY_SIGNALS).not.toContain('is_authoritative');
    expect(AI6A_SECONDARY_SIGNALS).not.toContain('auto_apply');
  });
});

describe('AI-6A — the benchmark projection mirrors the historical pipeline', () => {
  it('projects a structured ingredient the parser accepts', () => {
    expect(structuredIngredient('1.5 lb ground beef')).toEqual({
      original: '1.5 lb ground beef',
      amount: 1.5,
      unit: 'lb',
      name: 'ground beef',
    });
  });

  it('passes a line the frozen parser refuses through verbatim', () => {
    // The historical benchmark's projection is reproduced exactly: when the
    // parser refuses the raw text, no amount/unit/name is fabricated.
    expect(structuredIngredient('')).toEqual({ original: '' });
    expect(structuredIngredient('   ')).toEqual({ original: '   ' });
  });
});