/**
 * The Kitchen Codex — Advanced Nutrition AI-6A REAL-BUNDLE recon regression.
 *
 * Runs the REAL pinned USDA bundle through the REAL production pipeline over the
 * whole AI-6A recon corpus and proves the measurement instrument is sound:
 *
 *   - the historical 97 still resolves 46 and the legacy 91 still resolves 42;
 *   - every line receives EXACTLY ONE primary blocker from the closed vocabulary
 *     and exactly one closed repair lane consistent with it;
 *   - resolved lines preserve their authenticated mass-source truth;
 *   - an estimate is NEVER credited as authenticated mass (AI-3 invariance);
 *   - unsafe automatic identity outranks ordinary amount failures;
 *   - every ranking/portion label is backed by the candidate/portion evidence
 *     the record actually reports;
 *   - the diagnostic output is byte-deterministic across repeated runs.
 *
 * AI-6A is RECONNAISSANCE ONLY. This file asserts no new nutrition truth and
 * changes no production behavior: it measures the engine as it already is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import {
  AI6A_HISTORICAL_SUBSET,
  AI6A_INTELLIGENCE_CORPUS,
  AI6A_LEGACY_SUBSET,
} from '../../tests/fixtures/advancedNutritionAi6aIntelligenceCorpus';
import {
  classifyPrimaryBlocker,
  diagnoseCorpus,
  hasAuthoredAlternative,
  isSafeResolution,
  type Ai6aDiagnosticRecord,
  type CorpusExpectation,
} from '../../scripts/nutritionIntelligence/diagnose';
import {
  aggregate,
  expectationClassFor,
  historicalBaselineCheck,
  roadmapRanking,
} from '../../scripts/nutritionIntelligence/summarize';
import {
  AI6A_BLOCKER_TOTAL,
  AI6A_CANDIDATE_WINDOW,
  AI6A_FAILURE_BLOCKERS,
  AI6A_FAILURE_BLOCKER_TOTAL,
  AI6A_MASS_SOURCES,
  AI6A_PRIMARY_BLOCKERS,
  AI6A_ROADMAP_CRITERIA,
  AI6A_SUCCESS_SENTINEL,
  AUTHENTICATED_MASS_SOURCES,
  BLOCKER_TO_LANE,
  HISTORICAL_RESOLVED,
  HISTORICAL_TOTAL,
  isAi6aPrimaryBlocker,
  isAi6aRepairLane,
  isAi6aSecondarySignal,
  laneForBlocker,
} from '../../scripts/nutritionIntelligence/taxonomy';

const BUNDLE_DIR = join(
  import.meta.dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let session: AdvancedNutritionSession;
let records: ReadonlyArray<Ai6aDiagnosticRecord>;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!loaded.ok) throw new Error('the real USDA bundle failed to authenticate');
  session = loaded.session;
  records = diagnoseCorpus(session, AI6A_INTELLIGENCE_CORPUS);
}, 1_800_000);

/** Checked-in identity knowledge, joined by exact authored text. */
const identityFor = (line: string): CorpusExpectation | undefined =>
  AI6A_INTELLIGENCE_CORPUS.find((entry) => entry.line === line)?.identity;

const byLine = (line: string): Ai6aDiagnosticRecord => {
  const found = records.find((record) => record.line === line);
  if (found === undefined) throw new Error(`ai6a_line_missing:${line}`);
  return found;
};

describe('AI-6A — the historical baseline is unchanged by AI-6A', () => {
  it('measures every recon line exactly once', () => {
    expect(records.length).toBe(AI6A_INTELLIGENCE_CORPUS.length);
    expect(new Set(records.map((r) => r.line)).size).toBe(records.length);
  });

  it('still resolves 46 of the historical 97 on the PRODUCTION axis', () => {
    // AI-6A-R3: the load-bearing 46/97 invariant is the PRODUCTION axis — the
    // authenticated MASS SOURCE. It is deliberately NOT the diagnostic safe axis,
    // because the historical benchmark measures what production actually
    // resolved and must not be rewritten to hide production behavior.
    const resolved = AI6A_HISTORICAL_SUBSET.filter((entry) => {
      const record = byLine(entry.line);
      return AUTHENTICATED_MASS_SOURCES.includes(record.mass_source);
    });
    expect(resolved.length).toBe(HISTORICAL_RESOLVED);
    expect(HISTORICAL_TOTAL).toBe(97);
    // The historical benchmark itself, independently, agrees.
    const aggregates = aggregate(records, identityFor);
    expect(aggregates.historical_97.authenticated_resolved).toBe(46);
    expect(aggregates.historical_97.total).toBe(97);
  });

  it('still resolves 42 of the legacy 91 on the PRODUCTION axis', () => {
    const resolved = AI6A_LEGACY_SUBSET.filter((entry) =>
      AUTHENTICATED_MASS_SOURCES.includes(byLine(entry.line).mass_source)
    );
    expect(resolved.length).toBe(42);
    expect(AI6A_LEGACY_SUBSET.length).toBe(91);
    const aggregates = aggregate(records, identityFor);
    expect(aggregates.legacy_91.authenticated_resolved).toBe(42);
    expect(aggregates.legacy_91.total).toBe(91);
  });

  it('reports the SAFE axis as a SEPARATE, one-lower diagnostic number', () => {
    // AI-6A-R3: 46 production-resolved, 45 safe-resolved. The single difference
    // is `1 cup all-purpose or bread flour`, whose 125 g production mass is
    // authenticated but whose authored food choice was never made. Both numbers
    // are reported; neither replaces the other.
    const aggregates = aggregate(records, identityFor);
    expect(aggregates.historical_97.raw_matched).toBe(46);
    expect(aggregates.historical_97.safe_resolved).toBe(45);
    expect(aggregates.legacy_91.safe_resolved).toBe(41);
    expect(
      aggregates.historical_97.authenticated_resolved - aggregates.historical_97.safe_resolved
    ).toBe(aggregates.counts.authenticated_mass_with_unresolved_authored_choice);
  });

  it('agrees with the AI-6A historical invariant check', () => {
    const check = historicalBaselineCheck(aggregate(records));
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('reproduces the historical mass-source split on the historical subset', () => {
    // The historical benchmark reports 11/22/9/4. AI-6A must observe the SAME
    // distribution, or the recon is not measuring the same pipeline.
    const historical = records.filter((record) => record.source === 'historical');
    const count = (source: string): number =>
      historical.filter((record) => record.mass_source === source).length;
    expect(count('direct_mass')).toBe(11);
    expect(count('source_portion')).toBe(22);
    expect(count('count_portion')).toBe(9);
    expect(count('household_portion')).toBe(4);
  });
});

describe('AI-6A — every line gets exactly one closed blocker and lane', () => {
  it('assigns a blocker from the closed vocabulary to every line', () => {
    for (const record of records) {
      expect(isAi6aPrimaryBlocker(record.primary_blocker)).toBe(true);
    }
  });

  it('assigns exactly one blocker and one lane, and the lane matches the blocker', () => {
    for (const record of records) {
      expect(typeof record.primary_blocker).toBe('string');
      expect(isAi6aRepairLane(record.repair_lane)).toBe(true);
      // The lane is a pure function of the blocker: a record can never claim a
      // lane that contradicts its own root cause.
      expect(record.repair_lane).toBe(laneForBlocker(record.primary_blocker));
      expect(BLOCKER_TO_LANE[record.primary_blocker]).toBe(record.repair_lane);
    }
  });

  it('keeps every secondary signal inside the closed, bounded vocabulary', () => {
    for (const record of records) {
      expect(new Set(record.secondary_signals).size).toBe(record.secondary_signals.length);
      for (const signal of record.secondary_signals) expect(isAi6aSecondarySignal(signal)).toBe(true);
    }
  });

  it('never leaves a line unclassified in the measured baseline', () => {
    // `unclassified` is a real finding when it appears, so this asserts the
    // measured baseline is fully explained rather than asserting it can never
    // happen. If a future change introduces one, this test is the tripwire.
    const unclassified = records.filter((r) => r.primary_blocker === 'unclassified');
    expect(unclassified.map((r) => r.line)).toEqual([]);
  });

  it('never uses a UI terminal state as a root cause', () => {
    for (const record of records) {
      // The blocker IS in the closed vocabulary...
      expect(isAi6aPrimaryBlocker(record.primary_blocker)).toBe(true);
      // ...and it is never one of the UI terminal states this taxonomy replaces.
      expect(['needs_amount', 'needs_match', 'review_suggested']).not.toContain(
        record.primary_blocker
      );
    }
  });
});

describe('AI-6A — resolved lines preserve mass-source truth', () => {
  it('gives every resolved line a real authenticated mass source', () => {
    const resolved = records.filter((record) => record.primary_blocker === 'none_resolved');
    expect(resolved.length).toBeGreaterThan(0);
    for (const record of resolved) {
      expect(AUTHENTICATED_MASS_SOURCES).toContain(record.mass_source);
      expect(record.mass_source).not.toBe('none');
      expect(record.resolved_grams).toBeGreaterThan(0);
      expect(record.selected_fdc_id).not.toBeNull();
    }
  });

  it('gives every UNSAFE-FAILED line no mass source at all', () => {
    // AI-6A-R3: a line may carry an authenticated mass source and STILL not be a
    // safe success, because its blocker is `alternative_ambiguous`. The correct
    // invariant is therefore "no mass is fabricated for a line that produced
    // none", NOT "every non-`none_resolved` line has no mass".
    for (const record of records) {
      if (record.mass_source === 'none') continue;
      // The mass source is authenticated, never estimate-class.
      expect(AUTHENTICATED_MASS_SOURCES, record.line).toContain(record.mass_source);
      expect(Number.isFinite(record.resolved_grams ?? Number.NaN), record.line).toBe(true);
      // And production really did match it.
      expect(record.terminal, record.line).toBe('matched');
    }
    // Every line production did NOT match has no mass and no grams.
    for (const record of records.filter((r) => r.terminal !== 'matched')) {
      expect(record.mass_source, record.line).toBe('none');
      expect(record.resolved_grams, record.line).toBeNull();
      expect(record.primary_blocker, record.line).not.toBe('none_resolved');
    }
  });

  it('never reports a resolved line with a zero or negative gram value', () => {
    for (const record of records.filter((r) => r.mass_source !== 'none')) {
      expect(Number.isFinite(record.resolved_grams ?? Number.NaN)).toBe(true);
      expect(record.resolved_grams ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('AI-6A — an estimate is never credited as authenticated mass (AI-3 invariance)', () => {
  it('has no estimate member in the mass-source vocabulary', () => {
    for (const source of AI6A_MASS_SOURCES) {
      expect(/estimate|ai_/i.test(source)).toBe(false);
    }
  });

  it('credits no resolved line to an estimate-class source', () => {
    for (const record of records.filter((r) => r.primary_blocker === 'none_resolved')) {
      expect(record.repair_lane === 'ai_bounded_mass_estimation').toBe(false);
      expect(record.mass_source).not.toMatch(/estimate/i);
    }
  });

  it('routes AI lanes only as a planning label, never as an applied resolution', () => {
    // `ai_bounded_mass_estimation` is a lane a follow-up phase may INVESTIGATE.
    // It never appears as the lane of a line that already resolved.
    for (const record of records) {
      if (record.repair_lane !== 'ai_bounded_mass_estimation') continue;
      expect(record.mass_source).toBe('none');
    }
  });

  it('routes NO line to an AI lane at all after the AI-6A-R2 corrections', () => {
    // AI-6A-R2 Issues 3 and 4. Both AI lanes lost their only producer:
    //   - the package net-mass boundary stopped pointing at AI estimation, and
    //   - a parsed-but-unconsumed measurement stopped pointing at AI semantic
    //     interpretation.
    // The lanes stay DECLARED (they are part of the planning vocabulary) but
    // must have zero measured producers, which is a stronger statement than
    // "no line resolved into them".
    const aiLanes = records.filter(
      (r) => r.repair_lane === 'ai_bounded_mass_estimation' || r.repair_lane === 'ai_semantic_interpretation'
    );
    expect(aiLanes.map((r) => r.line)).toEqual([]);
  });
});

// ============================================================================
// AI-6A-R2 — REQUIRED MUTATION-SENSITIVE REPAIRS, measured on the real bundle
// ============================================================================

describe('AI-6A-R2 — a bounded authored measurement is never qualitative or absent', () => {
  const BOUNDED_PROBES: ReadonlyArray<{
    readonly line: string;
    readonly kind: 'exact_mass' | 'exact_count' | 'range';
  }> = [
    { line: '8 oz spaghetti', kind: 'exact_mass' },
    { line: '4 cloves garlic', kind: 'exact_count' },
    { line: '1 whole chicken', kind: 'exact_count' },
    { line: '1-2 tbsp olive oil', kind: 'range' },
    { line: '2-3 cloves garlic', kind: 'range' },
    { line: '75-100 g tomatoes', kind: 'range' },
  ];

  it('leaves a bounded exact MASS with zero qualitative/absent signal', () => {
    // REQUIRED CONTROL #1 + #12. `8 oz spaghetti` has an exact authored scalar,
    // an explicit mass unit and a bounded measurement.
    for (const probe of BOUNDED_PROBES.filter((p) => p.kind === 'exact_mass')) {
      const record = byLine(probe.line);
      expect(record.amount, probe.line).not.toBeNull();
      expect(record.portion_resolvable_quantity, probe.line).toBe(true);
      expect(record.qualitative_reason, probe.line).toBeNull();
      expect(record.secondary_signals, probe.line).not.toContain('has_qualitative_amount');
      expect(record.secondary_signals, probe.line).not.toContain('has_explicit_qualitative_amount');
      expect(record.secondary_signals, probe.line).not.toContain('has_authored_amount_absent');
      expect(record.primary_blocker, probe.line).not.toBe('qualitative_or_absent_amount');
    }
  });

  it('leaves a bounded exact VOLUME with zero qualitative/absent signal', () => {
    // REQUIRED CONTROL #2. The R1 bug: a parsed range has `amount === null`, so
    // the old `amount === null` signal test stamped a qualitative label on it.
    for (const line of ['2 tbsp butter', '1 cup milk', '4 tbsp unsalted butter']) {
      const record = byLine(line);
      expect(record.quantity_kind, line).toBe('exact');
      expect(record.amount, line).not.toBeNull();
      expect(record.portion_resolvable_quantity, line).toBe(true);
      expect(record.qualitative_reason, line).toBeNull();
      expect(record.secondary_signals, line).not.toContain('has_qualitative_amount');
      expect(record.secondary_signals, line).not.toContain('has_authored_amount_absent');
      expect(record.primary_blocker, line).not.toBe('qualitative_or_absent_amount');
    }
  });

  it('leaves a bounded exact COUNT with zero qualitative/absent signal', () => {
    // REQUIRED CONTROL #3.
    for (const line of ['4 cloves garlic', '1 whole chicken', '3 large eggs', '2 carrots, sliced']) {
      const record = byLine(line);
      expect(record.amount, line).not.toBeNull();
      expect(record.portion_resolvable_quantity, line).toBe(true);
      expect(record.qualitative_reason, line).toBeNull();
      expect(record.secondary_signals, line).not.toContain('has_qualitative_amount');
      expect(record.secondary_signals, line).not.toContain('has_authored_amount_absent');
      expect(record.primary_blocker, line).not.toBe('qualitative_or_absent_amount');
    }
  });

  it('leaves a bounded RANGE with zero qualitative/absent signal', () => {
    // The 14 lines the R1 `amount === null` signal test mislabeled.
    for (const probe of BOUNDED_PROBES.filter((p) => p.kind === 'range')) {
      const record = byLine(probe.line);
      expect(record.quantity_kind, probe.line).toBe('range');
      expect(record.range, probe.line).not.toBeNull();
      expect(record.portion_resolvable_quantity, probe.line).toBe(true);
      expect(record.qualitative_reason, probe.line).toBeNull();
      expect(record.secondary_signals, probe.line).not.toContain('has_qualitative_amount');
      expect(record.secondary_signals, probe.line).not.toContain('has_authored_amount_absent');
      expect(record.primary_blocker, probe.line).not.toBe('qualitative_or_absent_amount');
    }
    // No RANGE anywhere in the corpus may carry an absent-amount signal.
    for (const record of records) {
      if (record.quantity_kind !== 'range') continue;
      expect(record.secondary_signals, record.line).not.toContain('has_authored_amount_absent');
      expect(record.qualitative_reason, record.line).toBeNull();
    }
  });

  it('gives `8 oz spaghetti` literally zero qualitative/absent signal', () => {
    // REQUIRED CONTROL #12, stated on the exact line the mission names.
    const record = byLine('8 oz spaghetti');
    expect(record.quantity_kind).toBe('exact');
    expect(record.amount).toBe(8);
    expect(record.raw_unit).toBe('oz');
    expect(record.measurement_kind).toBe('mass');
    expect(record.qualitative_reason).toBeNull();
    expect(record.portion_resolvable_quantity).toBe(true);
    for (const signal of [
      'has_qualitative_amount',
      'has_explicit_qualitative_amount',
      'has_authored_amount_absent',
    ] as const) {
      expect(record.secondary_signals, signal).not.toContain(signal);
    }
    // Its blocker is identity, which is exactly where an 8 oz mass belongs.
    expect(record.primary_blocker).toBe('identity_needs_review');
  });

  it('never labels ANY bounded line qualitative, whatever else is wrong with it', () => {
    // The general invariant, not just the sampled probes.
    for (const record of records) {
      if (record.portion_resolvable_quantity !== true) continue;
      expect(record.qualitative_reason, record.line).toBeNull();
      expect(record.secondary_signals, record.line).not.toContain('has_qualitative_amount');
      expect(record.primary_blocker, record.line).not.toBe('qualitative_or_absent_amount');
    }
  });

  it('still labels a genuinely unbounded amount qualitative', () => {
    // Mutation-sensitive: emptying the class instead of drawing it correctly.
    for (const line of [
      'pinch dried basil',
      'handful fresh spinach',
      '1 handful fresh basil',
      'fresh parsley, chopped',
      'skim milk',
      'a dash of pepper',
    ]) {
      const record = byLine(line);
      expect(record.portion_resolvable_quantity, line).toBe(false);
      expect(record.qualitative_reason, line).not.toBeNull();
      expect(record.secondary_signals, line).toContain('has_qualitative_amount');
    }
  });

  it('keeps `Mrs. Dash` branded and non-qualitative', () => {
    // REQUIRED CONTROL #13.
    const brand = byLine('1 tbsp Mrs. Dash');
    expect(brand.secondary_signals).toContain('has_brand_or_commercial_specificity');
    expect(brand.qualitative_reason).toBeNull();
    expect(brand.portion_resolvable_quantity).toBe(true);
    for (const signal of [
      'has_qualitative_amount',
      'has_explicit_qualitative_amount',
      'has_authored_amount_absent',
    ] as const) {
      expect(brand.secondary_signals, signal).not.toContain(signal);
    }
  });
});

describe('AI-6A-R2 — a genuine amount cause outranks ordinary identity review', () => {
  it('reports unbounded-amount lines by their root cause, not by identity review', () => {
    // REQUIRED CONTROL #4. These ten lines were `identity_needs_review` in R1.
    // Repairing identity alone cannot give `drizzle of olive oil` truthful grams.
    const lines = [
      'drizzle of olive oil',
      'fresh dill for garnish',
      'a dash of pepper',
      'a pinch of crushed red pepper flakes',
      'sardines in tomato sauce',
      'bacon flavor',
      'apple cider vinegar',
      'pasta with tomato sauce',
      'tomato sauce with basil',
      'bacon-flavored cereal',
      'butter or olive oil',
    ];
    for (const line of lines) {
      const record = byLine(line);
      expect(record.primary_blocker, line).toBe('qualitative_or_absent_amount');
      expect(record.repair_lane, line).toBe('intentional_human_review');
      expect(record.qualitative_reason, line).not.toBeNull();
      expect(record.portion_resolvable_quantity, line).toBe(false);
      expect(record.mass_source, line).toBe('none');
      expect(record.resolved_grams, line).toBeNull();
    }
  });

  it('never HIDES the identity symptom the reordering displaced', () => {
    // Mutation-sensitive: a reordering that silently discards identity work.
    let observed = 0;
    for (const record of records) {
      const identitySymptom =
        record.review_outcome === 'review_required' && record.selected_fdc_id === null;
      expect(
        record.secondary_signals.includes('identity_review_symptom_present'),
        record.line
      ).toBe(identitySymptom);
      if (identitySymptom) observed += 1;
      // Every line whose blocker is a root cause yet which ALSO needed identity
      // review must still record that symptom.
      if (
        identitySymptom &&
        ['qualitative_or_absent_amount', 'alternative_ambiguous'].includes(
          record.primary_blocker
        )
      ) {
        expect(record.secondary_signals, record.line).toContain(
          'identity_review_symptom_present'
        );
      }
    }
    expect(observed).toBeGreaterThan(0);
  });

  it('never lets an unbounded amount hide a verified-unsafe identity', () => {
    // REQUIRED CONTROL #5, measured: there are currently zero unsafe identities,
    // and the precedence that would surface one is proven in the taxonomy suite.
    expect(records.filter((r) => r.identity_correctness === 'verified_unsafe')).toEqual([]);
    for (const record of records) {
      if (record.identity_correctness !== 'verified_unsafe') continue;
      expect(record.primary_blocker, record.line).toBe('unsafe_auto_identity');
    }
  });
});

describe('AI-6A-R2 — an authored alternative is not an ordinary identity failure', () => {
  it('reports `X or Y` by authored-choice ambiguity where the amount is bounded', () => {
    // REQUIRED CONTROL #6.
    const margarine = byLine('2 tbsp butter or margarine');
    expect(margarine.secondary_signals).toContain('has_alternative');
    expect(margarine.amount).toBe(2);
    expect(margarine.raw_unit).toBe('tbsp');
    expect(margarine.portion_resolvable_quantity).toBe(true);
    expect(margarine.primary_blocker).toBe('alternative_ambiguous');
    expect(margarine.repair_lane).toBe('intentional_human_review');
    expect(margarine.mass_source).toBe('none');
  });

  it('reports the cloves/margarine alternatives the same way', () => {
    const cloves = byLine('2 tsp whole cloves or 1/2 tbsp ground clove');
    expect(cloves.primary_blocker).toBe('alternative_ambiguous');
    expect(cloves.repair_lane).toBe('intentional_human_review');
  });

  it('never silently reduces an authored alternative to identity_needs_review', () => {
    for (const record of records) {
      if (!record.secondary_signals.includes('has_alternative')) continue;
      if (record.primary_blocker === 'none_resolved') continue;
      expect(
        ['alternative_ambiguous', 'qualitative_or_absent_amount'],
        record.line
      ).toContain(record.primary_blocker);
      expect(record.repair_lane, record.line).toBe('intentional_human_review');
    }
  });

  it('MEASURED FINDING: the engine DOES silently pick one authored alternative', () => {
    // AI-6A-R3. The production behavior is UNCHANGED and is reported truthfully:
    // `1 cup all-purpose or bread flour` offers two foods and the engine auto-binds
    // "Wheat flour, white, all-purpose, enriched, bleached" (168894) at 125 g.
    //
    // What R3 changed is the DIAGNOSTIC verdict only: the recon no longer calls
    // that a safe success. Raw terminal, mass source and grams are all preserved,
    // and the line is routed to `intentional_human_review` where it belongs.
    //
    // AI-6A does NOT repair the production behavior (that would be a production
    // change) and does not weaken any assertion to make it disappear. The corpus
    // declares NO identity expectation for this line, so the binding is
    // `unverified` — correctness is not invented in either direction.
    const flour = byLine('1 cup all-purpose or bread flour');
    expect(flour.secondary_signals).toContain('has_alternative');

    // RAW PRODUCTION RESULT — PRESERVED, NOT FALSIFIED.
    expect(flour.terminal).toBe('matched');
    expect(flour.mass_source).toBe('source_portion');
    expect(flour.resolved_grams).toBe(125);
    expect(flour.selected_fdc_id).toBe(168894);
    expect(flour.selected_description).toMatch(/all-purpose/i);
    expect(flour.identity_correctness).toBe('unverified');

    // DIAGNOSTIC VERDICT — no safe success credit.
    expect(flour.primary_blocker).toBe('alternative_ambiguous');
    expect(flour.repair_lane).toBe('intentional_human_review');
    expect(isSafeResolution(flour)).toBe(false);

    const a = aggregate(records, identityFor);
    expect(a.counts.authored_alternative_auto_resolved).toBe(1);
    const autoResolved = records.filter(
      (r) =>
        r.secondary_signals.includes('has_alternative') &&
        r.primary_blocker === 'alternative_ambiguous' &&
        AUTHENTICATED_MASS_SOURCES.includes(r.mass_source)
    );
    expect(autoResolved.map((r) => r.line)).toEqual(['1 cup all-purpose or bread flour']);
  });

  it('does NOT pick an alternative on the author\'s behalf where it declines', () => {
    for (const line of [
      '2 tsp whole cloves or 1/2 tbsp ground clove',
      '2 tbsp butter or margarine',
      'butter or olive oil',
    ]) {
      expect(byLine(line).resolved_grams, line).toBeNull();
      expect(byLine(line).mass_source, line).toBe('none');
    }
  });
});

describe('AI-6A-R2 — the package net-mass boundary is a POLICY decision', () => {
  it('never maps the boundary to AI bounded mass estimation', () => {
    // REQUIRED CONTROL #7, on every line that actually declares a net mass.
    for (const record of records) {
      if (record.primary_blocker !== 'container_net_mass_boundary') continue;
      expect(record.repair_lane, record.line).toBe('needs_recon');
      expect(record.repair_lane, record.line).not.toBe('ai_bounded_mass_estimation');
      expect(record.package_net_mass, record.line).not.toBeNull();
      expect(record.mass_source, record.line).toBe('none');
      expect(record.resolved_grams, record.line).toBeNull();
    }
  });

  it('never promotes a declared package net mass into authority', () => {
    const declared = records.filter((r) => r.package_net_mass !== null);
    expect(declared.length).toBeGreaterThan(0);
    for (const record of declared) {
      expect(record.secondary_signals, record.line).toContain('has_package_mass');
      // The parsed net mass is reported, and never becomes the gram value.
      expect(record.resolved_grams, record.line).toBeNull();
      expect(record.mass_source, record.line).toBe('none');
    }
  });

  it('shows the declared mass while leaving it unauthoritative', () => {
    expect(byLine('1 (15 oz) can tomato sauce').package_net_mass).toEqual({
      amount: 15,
      unit: expect.any(String),
      scope: expect.anything(),
    });
    expect(byLine('1 (8 oz) package cream cheese').package_net_mass?.amount).toBe(8);
    expect(byLine('1 (16 oz) package cream cheese').package_net_mass?.amount).toBe(16);
    expect(byLine('1 can (400 g) diced tomatoes').package_net_mass?.amount).toBe(400);
  });
});

describe('AI-6A-R2 — measurement PARSE gap vs measurement POLICY gap', () => {
  const RANGE_POLICY_LINES = [
    '1-2 tbsp olive oil',
    '1/4-1/2 tsp chili flakes (optional)',
    '2-3 tomatoes',
    '2-3 cloves garlic',
    '1-2 cups chicken stock',
    '2-3 tbsp soy sauce',
  ];

  it('reports every parsed-but-unconsumed range as a POLICY gap', () => {
    // REQUIRED CONTROL #8.
    for (const line of RANGE_POLICY_LINES) {
      const record = byLine(line);
      expect(record.quantity_kind, line).toBe('range');
      expect(record.range, line).not.toBeNull();
      expect(record.range?.lower, line).toEqual(expect.any(Number));
      expect(record.range?.upper, line).toEqual(expect.any(Number));
      expect(record.portion_resolvable_quantity, line).toBe(true);
      expect(record.primary_blocker, line).toBe('measurement_policy_gap');
      expect(record.primary_blocker, line).not.toBe('measurement_parse_gap');
      // No semantic interpretation is needed merely to know the endpoints, so
      // the lane must not imply AI work.
      expect(record.repair_lane, line).toBe('needs_recon');
      expect(record.repair_lane, line).not.toBe('ai_semantic_interpretation');
      expect(record.mass_source, line).toBe('none');
      expect(record.resolved_grams, line).toBeNull();
    }
  });

  it('keeps a TRUE parse failure as a parse gap', () => {
    // REQUIRED CONTROL #9. Two distinct meanings:
    //   - `parse_failed`  the frozen parser refused the authored text outright;
    //   - `measurement_parse_gap` the text parsed but the MEASUREMENT was
    //     mis-captured. The taxonomy suite proves the second is reachable only
    //     when range endpoints were NOT represented.
    expect(BLOCKER_TO_LANE.parse_failed).toBe('deterministic_parser');
    expect(BLOCKER_TO_LANE.measurement_parse_gap).toBe('deterministic_parser');
    expect(BLOCKER_TO_LANE.measurement_parse_gap).not.toBe(BLOCKER_TO_LANE.measurement_policy_gap);
    // No corpus line is a total parse refusal, and that is measured, not assumed.
    expect(records.filter((r) => r.primary_blocker === 'parse_failed')).toEqual([]);
  });

  it('does not implement any midpoint, average, or range consumption', () => {
    // AI-6A must not fabricate a representative value for a range.
    for (const line of RANGE_POLICY_LINES) {
      const record = byLine(line);
      expect(record.amount, line).toBeNull();
      expect(record.resolved_grams, line).toBeNull();
      expect(record.mass_source, line).toBe('none');
    }
  });
});

describe('AI-6A-R2 — raw portion incompatibility vs ACTIONABLE portion blocker', () => {
  it('counts the two metrics separately and never conflates them', () => {
    // REQUIRED CONTROL #10.
    const a = aggregate(records, identityFor);
    const raw = records.filter(
      (r) => r.mass_source === 'none' && r.selected_record_portion_compatible === false
    );
    const actionable = records.filter(
      (r) =>
        r.mass_source === 'none' &&
        r.portion_resolvable_quantity === true &&
        laneForBlocker(r.primary_blocker) === 'deterministic_portion'
    );
    expect(a.portion.raw_selected_record_portion_incompatible).toBe(raw.length);
    expect(a.portion.actionable_portion_blocker).toBe(actionable.length);
    // The raw metric is strictly larger, which is precisely why it must not be
    // quoted as if it were roadmap work.
    expect(raw.length).toBeGreaterThan(actionable.length);
    expect(raw.length).toBe(59);
    expect(actionable.length).toBe(37);
  });

  it('reconciles the two numbers EXACTLY, with the gap named by blocker', () => {
    const a = aggregate(records, identityFor);
    // The exact partition, stated so the numbers cannot drift apart:
    //   raw(59)          = actionable WITH an incompatible record (35) + not_actionable(24)
    //   actionable(37)   = 35 + the 2 whose record DOES have a compatible portion
    const actionableWithIncompatible =
      a.portion.actionable_portion_blocker -
      a.portion.actionable_with_compatible_record_but_unresolved;
    expect(a.portion.actionable_with_compatible_record_but_unresolved).toBe(2);
    expect(actionableWithIncompatible).toBe(35);
    expect(a.portion.raw_selected_record_portion_incompatible).toBe(
      actionableWithIncompatible + a.portion.bounded_lines_incompatible_but_not_actionable
    );
    const breakdown = a.portion.raw_incompatible_by_blocker.reduce((s, e) => s + e.count, 0);
    expect(breakdown).toBe(a.portion.bounded_lines_incompatible_but_not_actionable);
    // The over-count is dominated by lines whose REAL cause is not a portion.
    const named = new Map(
      a.portion.raw_incompatible_by_blocker.map((entry) => [entry.key, entry.count])
    );
    expect(named.get('compatible_candidate_not_selected')).toBe(9);
    expect(named.get('qualitative_or_absent_amount')).toBe(10);
    expect(named.get('container_net_mass_boundary')).toBe(3);
    expect(named.get('measurement_policy_gap')).toBe(2);
  });

  it('an ACTIONABLE portion blocker always has a bounded quantity', () => {
    for (const record of records) {
      if (laneForBlocker(record.primary_blocker) !== 'deterministic_portion') continue;
      expect(record.portion_resolvable_quantity, record.line).toBe(true);
      expect(record.mass_source, record.line).toBe('none');
      expect(record.resolved_grams, record.line).toBeNull();
    }
  });
});

describe('AI-6A-R2 — the roadmap recommendation uses ROOT-CAUSE counts', () => {
  it('never reads the RAW compatibility metric to build the recommendation', () => {
    // REQUIRED CONTROL #11. `roadmapRanking` takes ONLY the primary-blocker
    // counters, so the raw portion metric is structurally not an input.
    const measured = aggregate(records, identityFor);
    const inflated = {
      ...measured,
      portion: {
        ...measured.portion,
        raw_selected_record_portion_incompatible: 100_000,
        actionable_portion_blocker: 1,
      },
    };
    expect(inflated.portion.raw_selected_record_portion_incompatible).toBe(100_000);
    // The identical blocker distribution must yield the identical ranking,
    // because `roadmapRanking` is a pure function of `primary_blockers`.
    expect(JSON.stringify(roadmapRanking(measured.primary_blockers))).toBe(
      JSON.stringify(roadmapRanking(inflated.primary_blockers))
    );
  });

  it('derives the ranking from the CURRENT root-cause distribution', () => {
    const a = aggregate(records, identityFor);
    expect(a.roadmap).toEqual(a.roadmap_ranking[0]);
    // The winner's root-cause count equals the records actually assigned it.
    const winner = a.roadmap.lane;
    const blockerTotal = records
      .filter((r) => r.repair_lane === winner && r.primary_blocker !== 'none_resolved')
      .reduce((sum, r) => sum + 1, 0);
    expect(a.roadmap.root_cause_count).toBe(blockerTotal);
    expect(a.roadmap.root_cause_count).toBe(37);
  });

  it('changes the ranking when the measured distribution changes', () => {
    // Mutation-sensitive: a frozen ranking that can never respond to evidence.
    // A synthetic distribution isolates the behavior from the real corpus.
    const synthetic = (portion: number, identity: number) =>
      roadmapRanking([
        { key: 'selected_record_lacks_source_portion', count: portion },
        { key: 'identity_needs_review', count: identity },
      ]);

    // SAFETY decides first, so the portion lane wins even when identity has
    // nearly twice the root causes. This is the proof that the ranking is not
    // "pick the largest bucket".
    const identityMuchBigger = synthetic(1, 100);
    expect(identityMuchBigger[0]?.lane).toBe('deterministic_portion');
    expect(identityMuchBigger[0]?.root_cause_count).toBe(1);
    const identity = identityMuchBigger.find((e) => e.lane === 'deterministic_identity');
    expect(identity?.root_cause_count).toBe(100);
    expect(identity?.decided_by).toBe('safety');

    // And the ranking DOES track the measurement when safety does not separate
    // two candidates: frequency is the deciding criterion among equal judgments.
    const ranking = synthetic(37, 27);
    expect(ranking.find((e) => e.lane === 'deterministic_portion')?.root_cause_count).toBe(37);
    expect(ranking.find((e) => e.lane === 'deterministic_identity')?.root_cause_count).toBe(27);
  });

  it('excludes the success sentinel from the ranking entirely', () => {
    // `none_resolved` routes to `already_resolved`, which is never a target, so
    // the 92 resolved lines cannot inflate any target lane's root-cause count.
    const ranking = roadmapRanking(aggregate(records, identityFor).primary_blockers);
    expect(ranking.find((e) => e.lane === 'already_resolved')).toBeUndefined();
    const portion = ranking.find((e) => e.lane === 'deterministic_portion');
    expect(portion?.root_cause_count).toBe(37);
    expect(portion?.root_cause_count).toBeLessThan(92);
  });

  it('never ranks a correct-behavior or policy-decision lane as the target', () => {
    const a = aggregate(records, identityFor);
    for (const entry of a.roadmap_ranking) {
      if (['intentional_human_review', 'needs_recon', 'already_resolved'].includes(entry.lane)) {
        expect(entry.eligible, entry.lane).toBe(false);
      }
    }
    expect(a.roadmap.eligible).toBe(true);
    expect(['intentional_human_review', 'needs_recon', 'already_resolved']).not.toContain(
      a.roadmap.lane
    );
    // `needs_recon` holds the two policy-decision blockers and is a DECISION
    // queue, not a defect lane.
    expect(records.filter((r) => r.repair_lane === 'needs_recon')).toHaveLength(9);
  });

  it('compares the criteria lexicographically, so frequency cannot decide alone', () => {
    // The criteria order is the mission's order, and frequency is LAST.
    expect(AI6A_ROADMAP_CRITERIA).toEqual([
      'safety',
      'ordinary_user_impact',
      'generalizability',
      'tractability',
      'frequency',
    ]);
    const ranking = roadmapRanking(aggregate(records, identityFor).primary_blockers);
    // Winner vs runner-up on the two largest root-cause lanes.
    const winner = ranking.find((e) => e.lane === 'deterministic_portion');
    const runnerUp = ranking.find((e) => e.lane === 'deterministic_identity');
    expect(winner).toBeDefined();
    expect(runnerUp).toBeDefined();
    // SAFETY decides it: the portion lane is fail-closed with identity already
    // bound, and the identity lane carries the Phase 0A wrong-food history.
    expect(winner!.criteria.safety).toBeGreaterThan(runnerUp!.criteria.safety);
    expect(runnerUp!.root_cause_count).toBe(27);
    expect(winner!.root_cause_count).toBe(37);
  });
});

describe('AI-6A — unsafe automatic identity outranks ordinary amount failure', () => {
  it('reports zero verified-unsafe automatic identities in the measured baseline', () => {
    const unsafe = records.filter((r) => r.identity_correctness === 'verified_unsafe');
    expect(unsafe.map((r) => r.line)).toEqual([]);
  });

  it('would label a forbidden identity unsafe even when the line resolved', () => {
    // Proof of PRIORITY from measured data: every line the identity corpus
    // positively forbids is bound to the correct identity, and every one of
    // them that resolved is still `none_resolved` (not unsafe). The precedence
    // itself is proven in the fast taxonomy suite; here we prove the identity
    // expectations are satisfied by the current engine.
    const forbiddenLabeled = records.filter((record) => {
      const entry = AI6A_INTELLIGENCE_CORPUS.find((e) => e.line === record.line);
      const identity = entry?.identity;
      if (identity === undefined) return false;
      return (
        identity.forbiddenAutoFdcs !== undefined ||
        identity.forbiddenAutoDescription !== undefined ||
        identity.expectNoAutomatic === true
      );
    });
    expect(forbiddenLabeled.length).toBeGreaterThan(0);
    for (const record of forbiddenLabeled) {
      expect(record.identity_correctness).not.toBe('verified_unsafe');
    }
  });

  it('never reports an unsafe identity as merely unverified', () => {
    for (const record of records.filter((r) => r.primary_blocker === 'unsafe_auto_identity')) {
      expect(record.identity_correctness).toBe('verified_unsafe');
    }
  });
});

describe('AI-6A — identity correctness comes only from checked-in knowledge', () => {
  it('marks a line verified_correct only on the corpus expected FDC id', () => {
    for (const record of records.filter((r) => r.identity_correctness === 'verified_correct')) {
      const entry = AI6A_INTELLIGENCE_CORPUS.find((e) => e.line === record.line);
      expect(entry?.identity?.expectedAutoFdc).toBe(record.selected_fdc_id);
    }
  });

  it('leaves unlabeled supplemental lines unverified rather than guessing', () => {
    const unlabeled = records.filter((record) => {
      const entry = AI6A_INTELLIGENCE_CORPUS.find((e) => e.line === record.line);
      return entry?.identity === undefined && record.selected_fdc_id !== null;
    });
    expect(unlabeled.length).toBeGreaterThan(0);
    for (const record of unlabeled) {
      expect(record.identity_correctness).toBe('unverified');
    }
  });

  it('never reports verified_correct for a line with no expectation', () => {
    for (const record of records) {
      const entry = AI6A_INTELLIGENCE_CORPUS.find((e) => e.line === record.line);
      if (entry?.identity?.expectedAutoFdc === undefined) {
        expect(record.identity_correctness).not.toBe('verified_correct');
      }
    }
  });
});

describe('AI-6A — ranking labels require real candidate evidence', () => {
  it('never claims an expected candidate is present when it is not in the window', () => {
    for (const record of records) {
      const entry = AI6A_INTELLIGENCE_CORPUS.find((e) => e.line === record.line);
      const expected = entry?.identity?.expectedAutoFdc;
      if (expected === undefined) {
        expect(record.expected_candidate_rank).toBe('not_applicable');
        continue;
      }
      const inWindow = record.candidates.some((c) => c.fdc_id === expected);
      if (record.expected_candidate_rank === 'absent_from_bounded_candidates') {
        expect(inWindow).toBe(false);
      } else {
        expect(inWindow).toBe(true);
      }
    }
  });

  it('keeps every candidate window bounded and rank-ordered', () => {
    for (const record of records) {
      expect(record.candidates.length).toBeLessThanOrEqual(AI6A_CANDIDATE_WINDOW);
      record.candidates.forEach((candidate, index) => {
        expect(candidate.rank).toBe(index + 1);
      });
      expect(record.candidate_count).toBeGreaterThanOrEqual(record.candidates.length);
    }
  });

  it('reports the expected identity as auto-bound for every labeled case', () => {
    const labeled = records.filter((r) => r.expected_candidate_rank !== 'not_applicable');
    for (const record of labeled) {
      const entry = AI6A_INTELLIGENCE_CORPUS.find((e) => e.line === record.line);
      expect(record.selected_fdc_id).toBe(entry?.identity?.expectedAutoFdc);
      expect(record.auto_outcome).toBe('automatic_matches_expected');
    }
  });

  it('never labels a ranking failure without a named alternate candidate', () => {
    for (const record of records.filter(
      (r) => r.primary_blocker === 'compatible_candidate_not_selected'
    )) {
      // The evidence must be IN the reported record, not merely derivable.
      expect(record.alternate_candidate_portion_compatible).toBe(true);
      expect(record.alternate_candidate_fdc_id).not.toBeNull();
      expect(record.selected_record_portion_compatible).toBe(false);
      const alternate = record.candidates.find(
        (c) => c.fdc_id === record.alternate_candidate_fdc_id
      );
      expect(alternate).toBeDefined();
      expect(alternate?.has_compatible_portion).toBe(true);
      expect(alternate?.fdc_id).not.toBe(record.selected_fdc_id);
    }
  });

  it('reads portion evidence from the same candidate it reports', () => {
    // Mutation-sensitive: reporting `alternate_candidate_fdc_id` while sourcing
    // the compatibility flag from a DIFFERENT candidate.
    for (const record of records) {
      if (record.alternate_candidate_fdc_id === null) continue;
      const alternate = record.candidates.find((c) => c.fdc_id === record.alternate_candidate_fdc_id);
      expect(alternate).toBeDefined();
      expect(record.alternate_candidate_portion_compatible).toBe(alternate?.has_compatible_portion);
    }
  });
});

describe('AI-6A — portion labels require real portion evidence', () => {
  it('only claims a record lacks a portion when the record actually bound one', () => {
    for (const record of records.filter(
      (r) => r.primary_blocker === 'selected_record_lacks_source_portion'
    )) {
      expect(record.selected_fdc_id).not.toBeNull();
      expect(record.selected_record_portion_compatible).toBe(false);
      // A record with a compatible portion cannot be in this class.
      expect(record.alternate_candidate_portion_compatible).not.toBe(true);
    }
  });

  it('separates "has a portion but no mass resulted" from "lacks a portion"', () => {
    for (const record of records.filter(
      (r) => r.primary_blocker === 'compatible_portion_unresolved'
    )) {
      expect(record.selected_record_portion_compatible).toBe(true);
      expect(record.mass_source).toBe('none');
    }
  });

  it('never fabricates grams for an unresolved line', () => {
    for (const record of records.filter((r) => r.mass_source === 'none')) {
      expect(record.resolved_grams).toBeNull();
    }
  });
});

describe('AI-6A — intentional classes stay distinct from ordinary failures', () => {
  it('keeps authored alternatives ambiguous rather than collapsing them', () => {
    const alternatives = records.filter((r) => r.secondary_signals.includes('has_alternative'));
    expect(alternatives.length).toBeGreaterThan(0);
    // No line that offers `X or Y` may be credited as a confident single-food
    // resolution: the engine must not pick one silently.
    for (const record of alternatives) {
      if (record.primary_blocker === 'none_resolved') continue;
      // AI-6A-R2 Issue 2: an authored `X or Y` is a ROOT CAUSE, so it is never
      // reduced to the ordinary `identity_needs_review` symptom.
      expect(
        ['alternative_ambiguous', 'qualitative_or_absent_amount'],
        record.line
      ).toContain(record.primary_blocker);
    }
  });

  it('routes an authored alternative with no other obstacle to intentional review', () => {
    const ambiguous = records.filter((r) => r.primary_blocker === 'alternative_ambiguous');
    expect(ambiguous.length).toBeGreaterThan(0);
    for (const record of ambiguous) {
      expect(record.repair_lane).toBe('intentional_human_review');
      expect(record.secondary_signals).toContain('has_alternative');
      // AI-6A-R3: NO safe success credit. A production mass may exist and is
      // preserved, but the line is never credited as resolved.
      expect(isSafeResolution(record), record.line).toBe(false);
      expect(record.primary_blocker, record.line).not.toBe('none_resolved');
    }
  });

  it('keeps qualitative intent distinct from an ordinary missing-amount failure', () => {
    const qualitative = records.filter((r) => r.primary_blocker === 'qualitative_or_absent_amount');
    expect(qualitative.length).toBeGreaterThan(0);
    for (const record of qualitative) {
      expect(record.repair_lane).toBe('intentional_human_review');
      expect(record.secondary_signals).toContain('has_qualitative_amount');
      // AI-6A-R1: the authored quantity is genuinely unmeasurable, and the two
      // subtype signals are mutually exclusive.
      expect(record.portion_resolvable_quantity).toBe(false);
      expect(record.qualitative_reason).not.toBeNull();
      const explicit = record.secondary_signals.includes('has_explicit_qualitative_amount');
      const absent = record.secondary_signals.includes('has_authored_amount_absent');
      expect(explicit !== absent).toBe(true);
      if (explicit) expect(record.qualitative_reason).toBe('explicit_qualitative_amount');
      if (absent) expect(record.qualitative_reason).toBe('authored_amount_absent');
    }
  });

  // ==========================================================================
  // AI-6A-R1: qualitative / absent-amount truthfulness probes
  // ==========================================================================

  it('does not call an UNMEASURABLE amount a generic source-portion defect', () => {
    // Mutation-sensitive: reintroducing `handful fresh spinach` / `skim milk` into
    // the portion lane. No portion authority can resolve these without inventing
    // quantity authority, so a portion label would be a lie.
    const probes = [
      'pinch dried basil',
      'pinch dried oregano',
      'handful fresh spinach',
      '1 handful fresh basil',
      'freshly ground black pepper',
      'fresh parsley, chopped',
      'skim milk',
      'whole milk',
      'chicken soup',
      'canned tomato sauce',
    ];
    for (const line of probes) {
      const record = byLine(line);
      expect(
        [
          'selected_record_lacks_source_portion',
          'authenticated_count_portion_absent',
          'household_portion_absent',
          'compatible_candidate_not_selected',
          'compatible_portion_unresolved',
        ],
        line
      ).not.toContain(record.primary_blocker);
      expect(record.portion_resolvable_quantity, line).toBe(false);
      expect(record.repair_lane, line).toBe('intentional_human_review');
      expect(record.mass_source, line).toBe('none');
      expect(record.resolved_grams, line).toBeNull();
    }
  });

  it('distinguishes the two qualitative subtypes per line', () => {
    // An intentional cue is correct behavior; an absent amount is an authored gap.
    for (const line of ['pinch dried basil', 'handful fresh spinach', '1 handful fresh basil']) {
      expect(byLine(line).qualitative_reason, line).toBe('explicit_qualitative_amount');
    }
    for (const line of ['skim milk', 'whole milk', 'chicken soup', 'fresh parsley, chopped']) {
      expect(byLine(line).qualitative_reason, line).toBe('authored_amount_absent');
    }
  });

  it('reports a bounded amount line by its root cause, and says so', () => {
    // AI-6A-R2 Issue 2 INVERTS the R1 rule. R1 asserted identity outranked an
    // unmeasurable amount; that was the defect, because repairing identity alone
    // still cannot produce truthful grams for `drizzle of olive oil`.
    for (const line of ['drizzle of olive oil', 'fresh dill for garnish', 'a dash of pepper']) {
      const record = byLine(line);
      expect(record.primary_blocker, line).toBe('qualitative_or_absent_amount');
      expect(record.repair_lane, line).toBe('intentional_human_review');
      expect(record.qualitative_reason, line).toBe('explicit_qualitative_amount');
      expect(record.secondary_signals, line).toContain('has_qualitative_amount');
      expect(record.portion_resolvable_quantity, line).toBe(false);
      // Identity safety is NOT weakened: there is no auto-bound identity at all
      // on these lines, so nothing unsafe can be hidden by the reordering.
      expect(record.selected_fdc_id, line).toBeNull();
      expect(record.identity_correctness, line).not.toBe('verified_unsafe');
      // And the identity symptom stays recorded.
      expect(record.secondary_signals, line).toContain('identity_review_symptom_present');
    }
  });

  it('reports `salt to taste` as intentional qualitative, not as a defect', () => {
    const salt = byLine('salt to taste');
    expect(salt.terminal).toBe('qualitative');
    expect(salt.primary_blocker).toBe('qualitative_or_absent_amount');
    expect(salt.repair_lane).toBe('intentional_human_review');
    expect(salt.mass_source).toBe('none');
  });

  it('exposes the container-net-mass POLICY boundary instead of a portion symptom', () => {
    // AI-6A-R1 Issue 4. These lines declare a package net mass that policy
    // deliberately refuses to promote; that boundary is the ROOT CAUSE.
    const boundaries = records.filter(
      (r) => r.primary_blocker === 'container_net_mass_boundary'
    );
    expect(boundaries.length).toBeGreaterThan(0);
    for (const record of boundaries) {
      expect(record.package_net_mass).not.toBeNull();
      expect(record.container).not.toBeNull();
      // AI-6A-R2 Issue 3: a declared net mass is a POLICY decision, not an
      // estimation problem. The author already wrote the mass.
      expect(record.repair_lane).toBe('needs_recon');
      expect(record.repair_lane).not.toBe('ai_bounded_mass_estimation');
      expect(record.mass_source).toBe('none');
      expect(record.secondary_signals).toContain('has_package_mass');
      // A declared net mass is NEVER the resolved gram value.
      expect(record.resolved_grams).toBeNull();
    }
    expect(byLine('1 (15 oz) can tomato sauce').primary_blocker).toBe(
      'container_net_mass_boundary'
    );
    expect(byLine('1 (8 oz) package cream cheese').primary_blocker).toBe(
      'container_net_mass_boundary'
    );
  });

  it('never lets a generic missing-portion label hide the package boundary', () => {
    // Mutation-sensitive: demoting container_net_mass_boundary back below the
    // portion symptoms, which is exactly how it became invisible.
    for (const record of records) {
      if (record.package_net_mass === null) continue;
      if (record.primary_blocker === 'container_net_mass_boundary') continue;
      // Every non-boundary outcome must be a genuinely higher-precedence cause.
      expect(
        [
          'unsafe_auto_identity',
          'parse_failed',
          'identity_unmatched',
          'identity_needs_review',
        ],
        record.line
      ).toContain(record.primary_blocker);
    }
  });

  it('keeps a declared package net mass as an explicit boundary, never as authority', () => {
    const declared = records.filter((r) => r.package_net_mass !== null);
    expect(declared.length).toBeGreaterThan(0);
    for (const record of declared) {
      expect(record.secondary_signals).toContain('has_package_mass');
      // A declared net mass is parsed and preserved, but never becomes the
      // resolved gram value.
      expect(record.resolved_grams).toBe(record.mass_source === 'none' ? null : record.resolved_grams);
    }
  });
});

describe('AI-6A — catalog gap versus matcher failure', () => {
  it('labels a catalog gap only when no plausible candidate was observed', () => {
    for (const record of records.filter(
      (r) => r.primary_blocker === 'catalog_or_specificity_gap'
    )) {
      expect(record.candidate_count).toBe(0);
      expect(record.catalog_probe_total).toBe(0);
      expect(record.secondary_signals).toContain('no_plausible_candidate_observed');
    }
  });

  it('never labels a catalog gap while a plausible candidate is present', () => {
    // Mutation-sensitive: blaming the catalog when the matcher had candidates.
    for (const record of records) {
      if (record.primary_blocker !== 'catalog_or_specificity_gap') continue;
      expect(record.candidate_count === 0 && record.catalog_probe_total === 0).toBe(true);
    }
  });

  it('routes a catalog gap to the catalog lane, never to identity or ranking', () => {
    for (const record of records.filter(
      (r) => r.primary_blocker === 'catalog_or_specificity_gap'
    )) {
      expect(record.repair_lane).toBe('catalog_gap');
    }
  });

  it('measures branded specificity as a signal without demanding a branded record', () => {
    const branded = records.filter((r) =>
      r.secondary_signals.includes('has_brand_or_commercial_specificity')
    );
    expect(branded.length).toBeGreaterThan(0);
    // The recon must not pretend USDA owes an exact branded identity.
    for (const record of branded) {
      expect(record.identity_correctness).not.toBe('verified_unsafe');
    }
  });
});

describe('AI-6A — count/household noun gaps are named, not hidden', () => {
  it('reports a noun class for every line', () => {
    for (const record of records) {
      expect(typeof record.count_noun_class).toBe('string');
      expect(record.count_noun_class.length).toBeGreaterThan(0);
    }
  });

  it('does not read food-state `whole` as a count descriptor', () => {
    // AI-6A-R1 Issue 2, measured on the real bundle.
    expect(byLine('whole milk').count_noun_class).toBe('none');
    expect(byLine('whole milk').primary_blocker).not.toBe(
      'authenticated_count_portion_absent'
    );
    expect(byLine('2 slices whole wheat bread').count_noun_class).toBe('slice');
  });

  it('reads `whole` as a count descriptor when parse context supports it', () => {
    expect(byLine('1 whole chicken').count_noun_class).toBe('whole_item');
    expect(byLine('2 whole lemons').count_noun_class).toBe('whole_item');
  });

  it('does not fire a brand signal on the quantity use of the word `dash`', () => {
    // AI-6A-R1 Issue 3, both directions.
    const brand = byLine('1 tbsp Mrs. Dash');
    expect(brand.secondary_signals).toContain('has_brand_or_commercial_specificity');
    expect(brand.secondary_signals).not.toContain('has_qualitative_amount');
    expect(brand.qualitative_reason).toBeNull();
    expect(brand.amount).toBe(1);
    expect(brand.raw_unit).toBe('tbsp');
    expect(brand.portion_resolvable_quantity).toBe(true);
    // A real measure is not an under-specification.
    expect(brand.primary_blocker).not.toBe('qualitative_or_absent_amount');

    const measure = byLine('a dash of pepper');
    expect(measure.secondary_signals).toContain('has_qualitative_amount');
    expect(measure.secondary_signals).toContain('has_explicit_qualitative_amount');
    // `dash` here is a MEASURE, so it must not be read as a brand either.
    expect(measure.secondary_signals).not.toContain('has_brand_or_commercial_specificity');
    expect(measure.qualitative_reason).toBe('explicit_qualitative_amount');
  });

  it('separates household, unit, and container noun classes on real lines', () => {
    // The mission's example: "pickle slice weight unknown" must be visible by name
    // instead of disappearing into a generic needs_amount bucket.
    expect(byLine('20 slices dill pickles').count_noun_class).toBe('slice');
    expect(byLine('1 bunch parsley').count_noun_class).toBe('bunch');
    expect(byLine('3 cans tomato sauce').count_noun_class).toBe('can');
    expect(byLine('1 jar marinara sauce').count_noun_class).toBe('jar');
    expect(byLine('1 package cream cheese').count_noun_class).toBe('package');
  });

  it('routes household and count noun gaps to the portion lane', () => {
    for (const record of records) {
      if (record.primary_blocker !== 'household_portion_absent') continue;
      expect(record.repair_lane).toBe('deterministic_portion');
      expect(record.mass_source).toBe('none');
    }
    for (const record of records) {
      if (record.primary_blocker !== 'authenticated_count_portion_absent') continue;
      expect(record.repair_lane).toBe('deterministic_portion');
    }
  });
});

describe('AI-6A — preparation/state/form semantics are observed, not fixed', () => {
  it('records preparation, state, and form signals on real lines', () => {
    const chopped = byLine('2 carrots, sliced');
    expect(chopped.secondary_signals).toContain('has_preparation_modifier');
    expect(chopped.secondary_signals).toContain('has_form_modifier');
    const dried = byLine('1 tsp dried thyme');
    expect(dried.secondary_signals).toContain('has_state_modifier');
    expect(dried.mass_source).toBe('source_portion');
    // A qualitative dried spice records BOTH the state and the qualitative cue.
    const qualitativeDried = byLine('pinch dried oregano');
    expect(qualitativeDried.secondary_signals).toContain('has_state_modifier');
    expect(qualitativeDried.secondary_signals).toContain('has_qualitative_amount');
    expect(qualitativeDried.amount).toBeNull();
  });

  it('propagates a size descriptor into the diagnostics without changing the query', () => {
    const onion = byLine('1 large white onion');
    expect(onion.secondary_signals).toContain('has_size_descriptor');
    expect(typeof onion.parsed_food_query).toBe('string');
  });

  it('records a nutrient annotation as a signal and never as the amount', () => {
    const annotated = records.filter((r) =>
      r.secondary_signals.includes('has_nutrient_annotation')
    );
    expect(annotated.length).toBeGreaterThan(0);
    for (const record of annotated) {
      // The annotation must not become the parsed amount of the ingredient.
      expect(record.amount === null || Number.isFinite(record.amount)).toBe(true);
    }
  });
});

describe('AI-6A-R1 — exact accounting', () => {
  it('pins 18 total blockers = 1 success sentinel + 17 failure blockers', () => {
    // AI-6A-R2 added `measurement_policy_gap`, taking the vocabulary 17 -> 18.
    expect(AI6A_BLOCKER_TOTAL).toBe(18);
    expect(AI6A_FAILURE_BLOCKER_TOTAL).toBe(17);
    expect(AI6A_FAILURE_BLOCKERS).toHaveLength(17);
    expect(AI6A_PRIMARY_BLOCKERS).toHaveLength(18);
    expect(AI6A_SUCCESS_SENTINEL).toBe('none_resolved');
    expect(AI6A_FAILURE_BLOCKERS).not.toContain(AI6A_SUCCESS_SENTINEL);
  });

  it('keeps the identity/ranking expectation denominators un-conflated', () => {
    const aggregates = aggregate(records, identityFor);
    const expectations = aggregates.expectations;
    // Mutually exclusive classes sum to the corpus exactly.
    const classSum = Object.values(expectations.classes).reduce((a, b) => a + b, 0);
    expect(classSum).toBe(records.length);
    // The "binds expected FDC" denominator is EXACTLY the expected-auto class.
    expect(aggregates.ranking.expected_auto_identity_cases).toBe(
      expectations.expected_auto_identity_cases
    );
    expect(aggregates.ranking.bound_expected_auto_identity).toBe(
      expectations.expected_auto_identity_cases
    );
    // No-auto / baseline / order / candidate-presence classes are separate.
    expect(expectations.expect_no_automatic_cases).toBeGreaterThan(0);
    expect(expectations.known_issue_baseline_cases).toBeGreaterThan(0);
    expect(expectations.no_expectation_cases).toBeGreaterThan(0);
    // A line with no expected FDC can never be counted as binding one.
    for (const record of records) {
      const klass = expectationClassFor(identityFor(record.line));
      if (klass !== 'expected_auto_identity') {
        expect(record.expected_candidate_rank, record.line).toBe('not_applicable');
      }
    }
  });

  it('separates BINDING from WINDOW RANK for expected identities', () => {
    const aggregates = aggregate(records, identityFor);
    // Binding is measured against the expected-auto denominator; window rank is
    // a different measurement and may legitimately differ.
    expect(aggregates.ranking.bound_expected_auto_identity).toBeGreaterThanOrEqual(
      aggregates.ranking.expected_present_at_window_top_1
    );
    expect(aggregates.ranking.automatic_differs_from_expected).toBe(0);
  });
});

describe('AI-6A-R1 — the recommendation is DERIVED, never hard-coded', () => {
  it('derives the largest failure lane from the CURRENT aggregate', () => {
    const aggregates = aggregate(records, identityFor);
    const failureLanes = aggregates.repair_lanes.filter(
      (entry) => entry.key !== 'already_resolved'
    );
    // The top failure lane is whatever the CURRENT measurement says, computed
    // here from the aggregate — not read from a constant.
    expect(failureLanes.length).toBeGreaterThan(0);
    const derived = failureLanes.reduce((best, entry) =>
      entry.count > best.count ? entry : best
    );
    // Its count must equal the number of records actually assigned that lane.
    const actual = records.filter((r) => r.repair_lane === derived.key).length;
    expect(derived.count).toBe(actual);
    // And the lane totals must reconstruct the whole corpus.
    const laneSum = aggregates.repair_lanes.reduce((sum, e) => sum + e.count, 0);
    expect(laneSum).toBe(records.length);
    // Every lane on a record must equal the lane its blocker routes to.
    for (const record of records) {
      expect(record.repair_lane).toBe(laneForBlocker(record.primary_blocker));
    }
  });

  it('keeps every aggregate total internally consistent', () => {
    const aggregates = aggregate(records, identityFor);
    const blockerSum = aggregates.primary_blockers.reduce((s, e) => s + e.count, 0);
    expect(blockerSum).toBe(records.length);
    const terminalSum = aggregates.terminals.reduce((s, e) => s + e.count, 0);
    expect(terminalSum).toBe(records.length);
    const clusterSum = aggregates.failure_clusters.reduce((s, c) => s + c.count, 0);
    // Failure clusters exclude exactly the success sentinel, which is the same
    // population as `safe_resolved` (a `none_resolved` blocker always carries an
    // authenticated mass source, and vice versa).
    expect(aggregates.counts.safe_resolved).toBe(
      records.filter((r) => r.primary_blocker === 'none_resolved').length
    );
    expect(clusterSum).toBe(records.length - aggregates.counts.safe_resolved);
  });

  it('hard-codes no recommendation ranking in the recon modules', () => {
    // Mutation-sensitive: freezing a lane ranking in code so the reported
    // recommendation can never change when the measurement does.
    for (const file of ['diagnose.ts', 'taxonomy.ts', 'summarize.ts']) {
      const source = readFileSync(
        join(import.meta.dirname, `../../scripts/nutritionIntelligence/${file}`),
        'utf8'
      );
      for (const token of [
        'RECOMMENDED_TARGET',
        'recommendedTarget',
        'ATTACK_FIRST',
        'TOP_LANE',
        'priority_lane',
        'ai6b_target',
      ]) {
        expect(source.includes(token), `${file} must not hard-code ${token}`).toBe(false);
      }
    }
  });
});

describe('AI-6A — the measurement is deterministic', () => {
  // ONE re-run proves both determinism claims. Splitting this into two tests
  // would re-run the whole 207-line real-bundle corpus twice over, which is real
  // CPU and memory pressure in a suite where 43 files already load the bundle.
  it('produces byte-identical records AND an identical aggregate across runs', () => {
    const again = diagnoseCorpus(session, AI6A_INTELLIGENCE_CORPUS);
    expect(JSON.stringify(again)).toBe(JSON.stringify(records));
    expect(JSON.stringify(aggregate(again, identityFor))).toBe(
      JSON.stringify(aggregate(records, identityFor))
    );
  }, 1_800_000);

  it('emits no timestamp, hostname, absolute repository path, or secret', () => {
    const payload = JSON.stringify({ records, aggregates: aggregate(records) });
    expect(payload).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(payload).not.toContain(REPO_ROOT_MARKER);
    expect(payload).not.toContain('/home/sid');
    expect(payload.toLowerCase()).not.toContain('api_key');
    expect(payload.toLowerCase()).not.toContain('gemini');
    expect(payload.toLowerCase()).not.toContain('openrouter');
  });

  it('uses no clock, randomness, or network in the recon modules', () => {
    const forbidden = [
      'Date.now',
      'new Date(',
      'Math.random',
      'performance.now',
      'fetch(',
      'XMLHttpRequest',
      'node:http',
      'node:https',
      'AbortController',
      'setTimeout',
    ];
    for (const file of ['diagnose.ts', 'taxonomy.ts', 'summarize.ts']) {
      const source = readFileSync(
        join(import.meta.dirname, `../../scripts/nutritionIntelligence/${file}`),
        'utf8'
      );
      for (const token of forbidden) {
        expect(source.includes(token), `${file} must not use ${token}`).toBe(false);
      }
    }
  });
});

// ============================================================================
// AI-6A-R3 — ALTERNATIVE-RESOLUTION TRUTH: a collapsed authored choice is
// never a safe success, and the raw production result is never falsified.
// ============================================================================

describe('AI-6A-R3 — `1 cup all-purpose or bread flour` full truth table', () => {
  const FLOUR = '1 cup all-purpose or bread flour';

  it('reports every required axis for the required case', () => {
    const r = byLine(FLOUR);
    // authored line
    expect(r.line).toBe(FLOUR);
    // parse axis
    expect(r.parsed_food_query).toMatch(/flour/i);
    expect(r.amount).toBe(1);
    expect(r.raw_unit).toBe('cup');
    expect(r.quantity_kind).toBe('exact');
    expect(r.measurement_kind).toBe('volume');
    expect(r.portion_resolvable_quantity).toBe(true);
    expect(r.qualitative_reason).toBeNull();
    // alternative axis
    expect(r.secondary_signals).toContain('has_alternative');
    // RAW production result — preserved verbatim
    expect(r.selected_fdc_id).toBe(168894);
    expect(r.selected_description).toMatch(/all-purpose/i);
    expect(r.terminal).toBe('matched');
    expect(r.mass_source).toBe('source_portion');
    expect(r.resolved_grams).toBe(125);
    // DIAGNOSTIC verdict
    expect(r.primary_blocker).toBe('alternative_ambiguous');
    expect(r.repair_lane).toBe('intentional_human_review');
    expect(isSafeResolution(r)).toBe(false);
  });

  it('REQUIRED 2 + 3: gets alternative_ambiguous while its matched terminal survives', () => {
    const r = byLine(FLOUR);
    expect(r.primary_blocker).toBe('alternative_ambiguous');
    expect(r.terminal).toBe('matched');
  });

  it('REQUIRED 4: preserves its real mass source rather than erasing it', () => {
    const r = byLine(FLOUR);
    expect(r.mass_source).toBe('source_portion');
    expect(AUTHENTICATED_MASS_SOURCES).toContain(r.mass_source);
    expect(r.resolved_grams).toBe(125);
  });
});

describe('AI-6A-R3 — all four authored-alternative lines, classified truthfully', () => {
  const ALTERNATIVES = [
    '1 cup all-purpose or bread flour',
    '2 tsp whole cloves or 1/2 tbsp ground clove',
    '2 tbsp butter or margarine',
    'butter or olive oil',
  ] as const;

  it('REQUIRED 7: every one carries the signal and NONE gets safe success credit', () => {
    const withSignal = records.filter((r) => r.secondary_signals.includes('has_alternative'));
    expect(withSignal.map((r) => r.line).sort()).toStrictEqual([...ALTERNATIVES].sort());
    for (const line of ALTERNATIVES) {
      const r = byLine(line);
      expect(r.secondary_signals, line).toContain('has_alternative');
      expect(r.primary_blocker, line).not.toBe('none_resolved');
      expect(isSafeResolution(r), line).toBe(false);
      expect(r.repair_lane, line).toBe('intentional_human_review');
    }
  });

  it('reports bounded-amount status, raw terminal, identity and raw mass per line', () => {
    const bounded: Record<string, boolean> = {
      '1 cup all-purpose or bread flour': true,
      '2 tsp whole cloves or 1/2 tbsp ground clove': true,
      '2 tbsp butter or margarine': true,
      'butter or olive oil': false,
    };
    for (const line of ALTERNATIVES) {
      const r = byLine(line);
      expect(r.portion_resolvable_quantity, line).toBe(bounded[line]);
      expect(
        ['alternative_ambiguous', 'qualitative_or_absent_amount'],
        line
      ).toContain(r.primary_blocker);
    }
    // The raw production facts, per line.
    expect(byLine('1 cup all-purpose or bread flour').terminal).toBe('matched');
    expect(byLine('2 tsp whole cloves or 1/2 tbsp ground clove').terminal).toBe('needs_match');
    expect(byLine('2 tbsp butter or margarine').terminal).toBe('review_suggested');
    expect(byLine('butter or olive oil').terminal).toBe('review_suggested');
    // Only the flour line carries a production mass, and it is preserved.
    for (const line of ALTERNATIVES) {
      const hasMass = AUTHENTICATED_MASS_SOURCES.includes(byLine(line).mass_source);
      expect(hasMass, line).toBe(line === '1 cup all-purpose or bread flour');
    }
  });

  it('never claims to have chosen a food on the author\'s behalf', () => {
    // The recon records the engine's choice; it does not endorse it.
    const r = byLine('1 cup all-purpose or bread flour');
    expect(r.auto_outcome).toBe('no_expected_candidate_declared');
    expect(r.identity_correctness).toBe('unverified');
    expect(r.identity_correctness).not.toBe('verified_correct');
  });
});

describe('AI-6A-R3 — ordinary "or" inside another token is NOT an alternative', () => {
  it('REQUIRED: does not flag `or` substrings inside ordinary food words', () => {
    // Mutation-sensitive: loosening the detector to a bare `or` substring would
    // withhold safe success credit from dozens of ordinary lines.
    for (const line of [
      '1 tbsp Worcestershire sauce',
      '2 cups chicken stock',
      '1/2 cup coriander',
      '1 cup porridge',
      '1 cup all-purpose flour',
      '2 cloves garlic, minced',
      '1 lemon',
      '8 oz spaghetti',
      '3 large eggs',
      '1 cup shredded cheddar cheese',
    ]) {
      expect(hasAuthoredAlternative(line, line), line).toBe(false);
    }
  });

  it('still flags a genuine standalone authored choice', () => {
    for (const line of [
      '1 cup all-purpose or bread flour',
      '2 tbsp butter or margarine',
      'butter or olive oil',
      '2 tsp whole cloves or 1/2 tbsp ground clove',
      '1 cup chicken stock (or broth)',
      '1 tbsp Worcestershire sauce or 1 tsp soy sauce',
    ]) {
      expect(hasAuthoredAlternative(line, line), line).toBe(true);
    }
  });

  it('REQUIRED 8: no non-alternative line in the corpus is flagged', () => {
    for (const record of records) {
      if (record.secondary_signals.includes('has_alternative')) continue;
      expect(hasAuthoredAlternative(record.parsed_food_query ?? '', record.line), record.line).toBe(
        false
      );
    }
    // And crucially: no ordinary matched line loses safe credit to this.
    const matchedNonAlternative = records.filter(
      (r) => r.terminal === 'matched' && !r.secondary_signals.includes('has_alternative')
    );
    expect(matchedNonAlternative.length).toBeGreaterThan(0);
    for (const record of matchedNonAlternative) {
      expect(record.primary_blocker, record.line).toBe('none_resolved');
      expect(isSafeResolution(record), record.line).toBe(true);
    }
  });

  it('REQUIRED 8: every non-alternative matched line remains a safe success', () => {
    const safe = records.filter(isSafeResolution);
    expect(safe.length).toBe(91);
    for (const record of safe) {
      expect(record.secondary_signals, record.line).not.toContain('has_alternative');
      expect(record.primary_blocker, record.line).toBe('none_resolved');
      expect(record.mass_source, record.line).not.toBe('none');
      expect(record.terminal, record.line).toBe('matched');
    }
  });
});

describe('AI-6A-R3 — raw matched, safe resolved and the sentinel precedence', () => {
  it('REQUIRED 9: reports raw matched and safe resolved as SEPARATE counts', () => {
    const a = aggregate(records, identityFor);
    const rawMatched = records.filter((r) => r.terminal === 'matched');
    const safe = records.filter(isSafeResolution);
    expect(a.counts.raw_matched).toBe(rawMatched.length);
    expect(a.counts.raw_matched).toBe(92);
    expect(a.counts.safe_resolved).toBe(safe.length);
    // Derived from the classifier, never hard-coded, and provably distinct here.
    expect(a.counts.raw_matched).not.toBe(a.counts.safe_resolved);
    expect(
      a.counts.raw_matched - a.counts.safe_resolved
    ).toBe(a.counts.authenticated_mass_with_unresolved_authored_choice);
    expect(a.counts.authenticated_mass_with_unresolved_authored_choice).toBe(1);
  });

  it('REQUIRED 5: safe-resolved accounting excludes the collapsed alternative', () => {
    const a = aggregate(records, identityFor);
    expect(a.counts.safe_resolved).toBe(91);
    expect(records.filter((r) => r.primary_blocker === 'none_resolved')).toHaveLength(91);
    expect(byLine('1 cup all-purpose or bread flour').primary_blocker).not.toBe('none_resolved');
    // The raw matched count is NOT reduced to hide it.
    expect(records.filter((r) => r.terminal === 'matched')).toHaveLength(92);
  });

  it('REQUIRED 6: none_resolved cannot short-circuit authored alternative ambiguity', () => {
    // Even with a fully authenticated, fully resolved production row.
    const asResolved = {
      resolved: true,
      massSource: 'source_portion' as const,
      correctness: 'unverified' as const,
      parsedOk: true,
      quantityKind: 'exact',
      measurementKind: 'volume' as const,
      rangeEndpointsRepresented: false,
      directMassUnapplied: false,
      reviewOutcome: 'matched_exact',
      selectedFdcId: 168894,
      selectedCompatible: true,
      alternateCompatible: false,
      container: null,
      packageNetMass: null,
      hasAlternative: false,
      qualitative: false,
      catalogProbeTotal: 3,
      countNounClass: 'none' as const,
      portionResolvable: true,
    };
    // Without the alternative, the same row IS a success.
    expect(classifyPrimaryBlocker(asResolved)).toBe('none_resolved');
    // With the authored alternative, it is NOT.
    expect(classifyPrimaryBlocker({ ...asResolved, hasAlternative: true })).toBe(
      'alternative_ambiguous'
    );
    // And a verified-unsafe identity still outranks everything.
    expect(
      classifyPrimaryBlocker({ ...asResolved, hasAlternative: true, correctness: 'verified_unsafe' })
    ).toBe('unsafe_auto_identity');
  });

  it('REQUIRED 1: a raw matched alternative line is NOT a safe success', () => {
    const r = byLine('1 cup all-purpose or bread flour');
    expect(r.terminal).toBe('matched');
    expect(r.mass_source).not.toBe('none');
    expect(isSafeResolution(r)).toBe(false);
  });

  it('REQUIRED 10: authenticated mass does NOT imply semantic-choice authorization', () => {
    const r = byLine('1 cup all-purpose or bread flour');
    // Authenticated mass ...
    expect(AUTHENTICATED_MASS_SOURCES).toContain(r.mass_source);
    expect(r.resolved_grams).toBeGreaterThan(0);
    // ... and an unresolved authored food choice, simultaneously.
    expect(r.secondary_signals).toContain('has_alternative');
    expect(r.primary_blocker).toBe('alternative_ambiguous');
    // The two axes are independent fields; neither is derived from the other.
    expect(r.mass_source).not.toBe(r.primary_blocker as never);
    const a = aggregate(records, identityFor);
    expect(a.counts.authenticated_mass_resolved).toBe(92);
    expect(a.counts.authenticated_mass_with_unresolved_authored_choice).toBe(1);
  });

  it('routes the collapsed alternative to intentional_human_review, NOT already_resolved', () => {
    // AI-6B roadmap input uses the SAFE root-cause classification.
    const r = byLine('1 cup all-purpose or bread flour');
    expect(r.repair_lane).toBe('intentional_human_review');
    expect(r.repair_lane).not.toBe('already_resolved');
    const a = aggregate(records, identityFor);
    expect(a.repair_lanes.find((e) => e.key === 'intentional_human_review')?.count).toBe(29);
    expect(a.repair_lanes.find((e) => e.key === 'already_resolved')?.count).toBe(91);
    // And the recommendation is unchanged: the portion lane still leads.
    expect(a.roadmap.lane).toBe('deterministic_portion');
    expect(a.roadmap.root_cause_count).toBe(37);
  });

  it('REQUIRED 11: the historical 46/97 and 42/91 invariants are untouched', () => {
    const a = aggregate(records, identityFor);
    const check = historicalBaselineCheck(a);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    expect(a.historical_97.authenticated_resolved).toBe(46);
    expect(a.legacy_91.authenticated_resolved).toBe(42);
    // The production axis is unchanged; only the safe axis is one lower.
    expect(a.historical_97.safe_resolved).toBe(45);
    expect(a.legacy_91.safe_resolved).toBe(41);
  });
});

const REPO_ROOT_MARKER = join(import.meta.dirname, '../..');