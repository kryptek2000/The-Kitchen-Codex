/**
 * The Kitchen Codex — Advanced Nutrition AI-6B5 regression: CATALOG
 * disposition, REPAIRABILITY measurement, and the derived next-lane handoff.
 *
 * AI-6B5 is planning-only. Its central claim is the SAME correction AI-6B2 made
 * for portions, AI-6B3 for identity, and AI-6B4 for ranking: a catalog-lane
 * BLOCKER is not a REPAIRABLE catalog DEFECT.
 *
 * THE LOAD-BEARING RULES UNDER TEST
 *   - CATALOG ABSENCE IS NOT MATCHER FAILURE. A record that exists in the
 *     authenticated pinned bundle but that search never surfaces is a HANDOFF,
 *     not a catalog gap, and not automatically catalog repair work.
 *   - A RELATED RECORD IS NOT AN EQUIVALENT RECORD. rigatoni != generic pasta,
 *     Mrs. Dash != an arbitrary seasoning blend, breadcrumbs != seasoned
 *     breadcrumbs, and breadcrumbs != a coffee cake.
 *   - A BRAND NAME IS NEVER PERMISSION TO GUESS A FORMULATION.
 *   - PACKAGE MASS IS AN EXTERNAL FACT. It is never inferred from a typical
 *     retail size, another brand, or a USDA serving size.
 *   - A surface rule that cannot isolate ONE record needs a food-specific
 *     discrimination rule, which this phase must not invent.
 *
 * WHAT THIS PROVES
 *   - all 5 catalog-lane lines receive EXACTLY ONE closed disposition with ONE
 *     closed evidence code, and nothing is unclassified;
 *   - the repairable count is MEASURED, not assumed;
 *   - catalog absence, candidate-surface failure, branded specificity, and
 *     external-fact absence stay four separate things;
 *   - identity (27), ranking (9), portion (35) and catalog (5) stay distinct;
 *   - the known-good identity oracle stays 46/46 with zero unsafe identities;
 *   - the roadmap reaching "no next adjudication target" is reported truthfully
 *     rather than padded with zero-blocker lanes;
 *   - production behavior is completely unchanged by AI-6B5.
 *
 * AI-6B5 binds no FDC, invents no equivalence, infers no package mass, and
 * reaches no external or live USDA source.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CATALOG_DISPOSITIONS,
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_EVIDENCE_CODES,
  classifyCatalogDisposition,
  isAi6b5CatalogDisposition,
  isAi6b5CatalogEvidenceCode,
  type Ai6b5CatalogEvidence,
} from '../../scripts/nutritionIntelligence/catalogDisposition';
import {
  AI6B5_VARIANT_PROBE_MIN_TOKEN_LENGTH,
  compoundSplitProbes,
} from '../../scripts/nutritionIntelligence/catalogDispositionReport';
import { deriveNextWork } from '../../scripts/nutritionIntelligence/portionDisposition';

interface SimulationJson {
  readonly rule_id: string;
  readonly lines_probed: number;
  readonly lines_whose_direct_surface_is_empty: number;
  readonly lines_whose_variant_surface_finds_records: number;
  readonly lines_whose_variant_surface_is_brand_genericizing: number;
  readonly expected_fdc_divergences: number;
  readonly expect_no_automatic_violations: number;
  readonly forbidden_fdc_violations: number;
  readonly forbidden_description_violations: number;
  readonly identity_or_mass_changes_computed: boolean;
  readonly not_computed_reason: string;
}

interface LineJson {
  readonly line: string;
  readonly primary_blocker: string;
  readonly head_tokens: ReadonlyArray<string>;
  readonly catalog_probe_phrase: string;
  readonly exact_search_total: number | null;
  readonly variant_split_count: number;
  readonly variant_found_total: number | null;
  readonly variant_found_fdc_ids: ReadonlyArray<number>;
  readonly variant_found_descriptions: ReadonlyArray<string>;
  readonly variant_surface_unambiguous: boolean;
  readonly broader_generic_family_exists: boolean;
  readonly portion_authority_available_for_variant: boolean;
  readonly brand_specificity: boolean;
  readonly container: string | null;
  readonly package_net_mass_declared: boolean;
  readonly selected_fdc_id: number | null;
  readonly mass_source: string;
  readonly resolved_grams: number | null;
  readonly expected_auto_fdc: number | null;
  readonly expect_no_automatic: boolean;
  readonly forbidden_auto_fdcs: ReadonlyArray<number>;
  readonly forbidden_auto_description: string | null;
  readonly disposition: string;
  readonly evidence: string;
  readonly repairable: boolean;
  readonly handoff_lane: string | null;
  readonly owned_by_other_lane: boolean;
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
  readonly observed_catalog_blockers: number;
  readonly blocker_split: ReadonlyArray<{ key: string; count: number }>;
  readonly repairable_deterministic_catalog_surface_defects: number;
  readonly catalog_lane_exhausted: boolean;
  readonly deterministic_portion_blockers: number;
  readonly deterministic_identity_blockers: number;
  readonly deterministic_ranking_blockers: number;
  readonly disposition_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly evidence_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly handoff_lane_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ai3_eligibility_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly catalog_lane_constraint_counts: {
    expected_auto_fdc: number;
    baseline_auto_fdc: number;
    expect_top_fdc: number;
    expect_no_automatic: number;
    forbidden_auto_fdcs: number;
    forbidden_auto_description: number;
    known_issue: number;
    brand_specificity: number;
  };
  readonly hypothetical_surface_simulation: SimulationJson;
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
    const { buildNutritionCatalogDispositionReport } = await import(
      '../../scripts/nutritionIntelligence/catalogDispositionReport'
    );
    REPORT = (await buildNutritionCatalogDispositionReport()) as unknown as ReportJson;
    REPORT_TEXT = JSON.stringify(REPORT);
  }
  return REPORT;
}

// The report build authenticates the real USDA bundle and runs the real phase-4
// flow plus bounded searches per line, so the hook needs a large timeout.
const beforeAllLoad = async (): Promise<void> => {
  await loadReport();
};

const report = (): ReportJson => {
  if (REPORT === null) throw new Error('report not loaded');
  return REPORT;
};

const lineFor = (text: string): LineJson => {
  const found = report().lines.find((entry) => entry.line === text);
  if (found === undefined) throw new Error(`line not in report: ${text}`);
  return found;
};

/** Nothing found, nothing forbidden, no brand, no container. */
const EMPTY_CATALOG: Ai6b5CatalogEvidence = Object.freeze({
  container_authored: false,
  package_net_mass_declared: false,
  brand_specificity: false,
  exact_identity_found: false,
  exact_identity_found_via_variant: false,
  variant_surface_unambiguous: false,
  broader_generic_family_exists: false,
  portion_authority_available: false,
  expect_no_automatic: false,
  surfaced_candidate_forbidden: false,
  would_require_dropping_brand_token: false,
});

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

describe('AI-6B5 — the disposition and evidence vocabularies are closed', () => {
  it('declares exactly the nine catalog disposition concepts', () => {
    expect([...CATALOG_DISPOSITIONS].sort()).toEqual([
      'authenticated_catalog_absence',
      'branded_specificity_not_in_catalog',
      'candidate_generation_handoff',
      'catalog_blocker_misclassified',
      'container_net_mass_absent_from_authored_text',
      'generic_substitution_not_authorized',
      'needs_catalog_recon',
      'portion_authority_handoff',
      'repairable_catalog_surface_defect',
    ]);
  });

  it('rejects any disposition outside the closed vocabulary', () => {
    for (const bad of ['probably_missing', '', 'ABSENT', 'unknown', null, 7]) {
      expect(isAi6b5CatalogDisposition(bad), String(bad)).toBe(false);
    }
    for (const good of CATALOG_DISPOSITIONS) {
      expect(isAi6b5CatalogDisposition(good), good).toBe(true);
    }
  });

  it('rejects any evidence code outside the closed vocabulary', () => {
    for (const bad of ['feels_missing', '', 'UNKNOWN', null, 3]) {
      expect(isAi6b5CatalogEvidenceCode(bad), String(bad)).toBe(false);
    }
    for (const good of CATALOG_EVIDENCE_CODES) {
      expect(isAi6b5CatalogEvidenceCode(good), good).toBe(true);
    }
  });

  it('is TOTAL: every evidence shape yields exactly one closed verdict', () => {
    const shapes: ReadonlyArray<Partial<Ai6b5CatalogEvidence>> = [
      {},
      { exact_identity_found: true },
      { exact_identity_found_via_variant: true, variant_surface_unambiguous: true, portion_authority_available: true },
      { exact_identity_found_via_variant: true, variant_surface_unambiguous: false },
      { broader_generic_family_exists: true },
      { brand_specificity: true, broader_generic_family_exists: true },
      { container_authored: true, package_net_mass_declared: false },
      { container_authored: true, package_net_mass_declared: true },
      { expect_no_automatic: true },
      { surfaced_candidate_forbidden: true },
      { would_require_dropping_brand_token: true },
    ];
    for (const shape of shapes) {
      const verdict = classifyCatalogDisposition({ ...EMPTY_CATALOG, ...shape });
      expect(isAi6b5CatalogDisposition(verdict.disposition), JSON.stringify(shape)).toBe(true);
      expect(isAi6b5CatalogEvidenceCode(verdict.evidence), JSON.stringify(shape)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Classifier semantics
// ---------------------------------------------------------------------------

describe('AI-6B5 — classifier semantics', () => {
  // M1 TARGET: every related record is NOT an equivalent record.
  it('M1 — an ambiguous variant surface is a handoff, never a repair', () => {
    const verdict = classifyCatalogDisposition({
      ...EMPTY_CATALOG,
      exact_identity_found_via_variant: true,
      // plain crumbs + SEASONED crumbs + a cake: the surface cannot isolate the
      // authored food, so isolating it needs a food-specific rule.
      variant_surface_unambiguous: false,
      portion_authority_available: true,
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('candidate_generation_handoff');
    expect(verdict.evidence).toBe('repair_owned_by_tokenization_not_catalog_surface');
    expect(verdict.owned_by_other_lane).toBe(true);
  });

  it('is repairable ONLY when the variant surface isolates exactly one record', () => {
    const verdict = classifyCatalogDisposition({
      ...EMPTY_CATALOG,
      exact_identity_found_via_variant: true,
      variant_surface_unambiguous: true,
      portion_authority_available: true,
    });
    expect(verdict.disposition).toBe('repairable_catalog_surface_defect');
    expect(verdict.repairable).toBe(true);
    expect(verdict.handoff_lane).toBe('catalog_gap');
    expect(verdict.owned_by_other_lane).toBe(false);
  });

  // M2 TARGET: a brand is never genericized into a blend.
  it('M2 — a branded food is refused even when generic records exist', () => {
    const verdict = classifyCatalogDisposition({
      ...EMPTY_CATALOG,
      brand_specificity: true,
      broader_generic_family_exists: true,
      exact_identity_found_via_variant: true,
      variant_surface_unambiguous: true,
      portion_authority_available: true,
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('branded_specificity_not_in_catalog');
    expect(verdict.evidence).toBe('brand_record_absent_and_generic_not_equivalent');
  });

  // M6 TARGET: deleting a brand token is never a route to repairability.
  it('M6 — a repair requiring a brand-token drop is refused', () => {
    const verdict = classifyCatalogDisposition({
      ...EMPTY_CATALOG,
      exact_identity_found_via_variant: true,
      variant_surface_unambiguous: true,
      portion_authority_available: true,
      would_require_dropping_brand_token: true,
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).not.toBe('repairable_catalog_surface_defect');
  });

  // M3 TARGET: package mass is never inferred.
  it('M3 — a container with no authored net mass stays unauthenticated', () => {
    const verdict = classifyCatalogDisposition({
      ...EMPTY_CATALOG,
      container_authored: true,
      package_net_mass_declared: false,
      // even with a perfectly good identity and portion, the mass is absent
      exact_identity_found: true,
      portion_authority_available: true,
    });
    expect(verdict.repairable).toBe(false);
    expect(verdict.disposition).toBe('container_net_mass_absent_from_authored_text');
    expect(verdict.evidence).toBe('authored_package_net_mass_absent');
    expect(verdict.owned_by_other_lane).toBe(true);
  });

  // M4 TARGET: a record that EXISTS must never be reported as catalog absence.
  it('M4 — an existing record is never reported as catalog absence', () => {
    const verdict = classifyCatalogDisposition({
      ...EMPTY_CATALOG,
      exact_identity_found_via_variant: true,
    });
    expect(verdict.disposition).not.toBe('authenticated_catalog_absence');
    expect(verdict.disposition).not.toBe('generic_substitution_not_authorized');
    expect(verdict.evidence).not.toBe('exact_authored_record_absent_from_bundle');
  });

  // M5 TARGET: portion absence is never catalog identity absence.
  it('M5 — portion authority is not catalog identity', () => {
    const verdict = classifyCatalogDisposition({
      ...EMPTY_CATALOG,
      exact_identity_found: true,
      portion_authority_available: false,
    });
    expect(verdict.disposition).not.toBe('authenticated_catalog_absence');
    expect(verdict.disposition).not.toBe('generic_substitution_not_authorized');
  });

  it('reports genuine absence when nothing at all exists', () => {
    const verdict = classifyCatalogDisposition(EMPTY_CATALOG);
    expect(verdict.disposition).toBe('authenticated_catalog_absence');
    expect(verdict.evidence).toBe('exact_authored_record_absent_from_bundle');
    expect(verdict.repairable).toBe(false);
  });

  it('reports a broader generic family as unauthorized substitution', () => {
    const verdict = classifyCatalogDisposition({
      ...EMPTY_CATALOG,
      broader_generic_family_exists: true,
    });
    expect(verdict.disposition).toBe('generic_substitution_not_authorized');
    expect(verdict.evidence).toBe('broader_generic_family_exists_but_not_equivalent');
    expect(verdict.repairable).toBe(false);
  });

  it('never repairs a forbidden or expectNoAutomatic candidate', () => {
    for (const shape of [{ expect_no_automatic: true }, { surfaced_candidate_forbidden: true }]) {
      const verdict = classifyCatalogDisposition({
        ...EMPTY_CATALOG,
        exact_identity_found_via_variant: true,
        variant_surface_unambiguous: true,
        portion_authority_available: true,
        ...shape,
      });
      expect(verdict.repairable, JSON.stringify(shape)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The variant probe itself
// ---------------------------------------------------------------------------

describe('AI-6B5 — the compound-split probe is general, not a word table', () => {
  it('never splits a short token', () => {
    for (const token of ['mrs', 'egg', 'nut', 'jam']) {
      expect(compoundSplitProbes(token), token).toEqual([]);
    }
  });

  it('probes the separated form of a long compound without hardcoding it', () => {
    const probes = compoundSplitProbes('breadcrumbs');
    expect(probes).toContain('bread crumbs');
    // General: it enumerates internal positions, it does not encode a word pair.
    expect(probes.length).toBeGreaterThan(1);
    expect(AI6B5_VARIANT_PROBE_MIN_TOKEN_LENGTH).toBeGreaterThanOrEqual(8);
    // The probe enumerates EVERY internal position rather than encoding a known
    // word pair: a token with no separable form still yields candidate splits,
    // and it is the BUNDLE (not this function) that decides whether they match.
    const rigatoniProbes = compoundSplitProbes('rigatoni');
    expect(rigatoniProbes.length).toBeGreaterThan(0);
    expect(rigatoniProbes.every((p) => p.includes(' '))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The 5-line census
// ---------------------------------------------------------------------------

describe('AI-6B5 — the five-line catalog census reconciles', () => {
  beforeAll(beforeAllLoad, 600000);

  // M10 TARGET: dropping a line must fail loudly.
  it('M10 — exactly 5 blockers, split 4 specificity + 1 container mass', () => {
    expect(report().observed_catalog_blockers).toBe(5);
    expect(report().lines).toHaveLength(5);
    const split = Object.fromEntries(report().blocker_split.map((entry) => [entry.key, entry.count]));
    expect(split.catalog_or_specificity_gap).toBe(4);
    expect(split.container_mass_absent).toBe(1);
    expect(report().blocker_split.reduce((sum, e) => sum + e.count, 0)).toBe(5);
  });

  it('records each named line exactly once', () => {
    const texts = report().lines.map((line) => line.line);
    expect(new Set(texts).size).toBe(5);
    for (const expected of [
      '1 lb rigatoni',
      '2 cups breadcrumbs',
      '2 cups firmly packed breadcrumbs',
      '1 tbsp Mrs. Dash',
      '1 package breadcrumbs',
    ]) {
      expect(texts.filter((t) => t === expected).length, expected).toBe(1);
    }
  });

  it('gives every line EXACTLY ONE closed disposition and closed evidence code', () => {
    for (const line of report().lines) {
      expect(isAi6b5CatalogDisposition(line.disposition), line.line).toBe(true);
      expect(isAi6b5CatalogEvidenceCode(line.evidence), line.line).toBe(true);
      expect(CATALOG_DISPOSITIONS).toContain(line.disposition as never);
      expect(CATALOG_EVIDENCE_CODES).toContain(line.evidence as never);
    }
  });

  it('leaves NO line unclassified', () => {
    expect(
      report().lines.filter((line) => line.disposition === '' || line.evidence === '')
    ).toHaveLength(0);
  });

  it('derives every count from the per-line records', () => {
    expect(report().disposition_counts.reduce((s, e) => s + e.count, 0)).toBe(5);
    expect(report().evidence_counts.reduce((s, e) => s + e.count, 0)).toBe(5);
    expect(report().handoff_lane_counts.reduce((s, e) => s + e.count, 0)).toBe(5);
    for (const entry of report().disposition_counts) {
      expect(report().lines.filter((l) => l.disposition === entry.key)).toHaveLength(entry.count);
    }
  });

  it('records catalog-existence evidence for every line', () => {
    for (const line of report().lines) {
      expect(line.catalog_probe_phrase.length, line.line).toBeGreaterThan(0);
      expect(
        line.exact_search_total === null || line.exact_search_total >= 0,
        line.line
      ).toBe(true);
      expect(Array.isArray(line.variant_found_fdc_ids), line.line).toBe(true);
      expect(line.variant_found_fdc_ids.length, line.line).toBe(
        line.variant_found_descriptions.length
      );
    }
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

  it('pins the base commit so later HEAD movement cannot perturb the artifact', () => {
    expect(report().base_commit).toBe('5ee912999fa2cf7bd83efc56a0fcfa89c2df258f');
    expect(report().base_phase).toBe('AI-6B4');
    expect(report().schema).toBe(CATALOG_DISPOSITION_SCHEMA);
  });
});

// ---------------------------------------------------------------------------
// The five individual findings
// ---------------------------------------------------------------------------

describe('AI-6B5 — the named findings are classified for the RIGHT reason', () => {
  beforeAll(beforeAllLoad, 600000);

  it('rigatoni is genuine AUTHENTICATED CATALOG ABSENCE', () => {
    const line = lineFor('1 lb rigatoni');
    expect(line.head_tokens).toEqual(['rigatoni']);
    expect(line.exact_search_total).toBe(0);
    // No split variant finds it either: the food itself is absent.
    expect(line.variant_found_fdc_ids).toEqual([]);
    expect(line.disposition).toBe('authenticated_catalog_absence');
    expect(line.evidence).toBe('exact_authored_record_absent_from_bundle');
    expect(line.repairable).toBe(false);
  });

  it('Mrs. Dash is BRANDED SPECIFICITY, never genericized into a blend', () => {
    const line = lineFor('1 tbsp Mrs. Dash');
    expect(line.brand_specificity).toBe(true);
    expect(line.exact_search_total).toBe(0);
    expect(line.disposition).toBe('branded_specificity_not_in_catalog');
    expect(line.evidence).toBe('brand_record_absent_and_generic_not_equivalent');
    expect(line.repairable).toBe(false);
    expect(line.handoff_lane).toBe('intentional_human_review');
  });

  it('1 package breadcrumbs is EXTERNAL FACT ABSENT, not catalog absence', () => {
    const line = lineFor('1 package breadcrumbs');
    expect(line.primary_blocker).toBe('container_mass_absent');
    expect(line.container).toBe('package');
    expect(line.package_net_mass_declared).toBe(false);
    expect(line.disposition).toBe('container_net_mass_absent_from_authored_text');
    expect(line.evidence).toBe('authored_package_net_mass_absent');
    expect(line.repairable).toBe(false);
    // No mass is ever manufactured.
    expect(line.mass_source).toBe('none');
    expect(line.resolved_grams).toBeNull();
  });

  it('both breadcrumb VOLUME lines are a CANDIDATE-GENERATION HANDOFF', () => {
    for (const text of ['2 cups breadcrumbs', '2 cups firmly packed breadcrumbs']) {
      const line = lineFor(text);
      // The direct surface is blind: the authored compound returns nothing.
      expect(line.exact_search_total, text).toBe(0);
      // But the bundle DOES contain records under the separated form...
      expect(line.variant_found_fdc_ids.length, text).toBeGreaterThan(0);
      expect(line.variant_found_fdc_ids, text).toContain(174928);
      // ...including a SEASONED variant and an unrelated cake, so the surface
      // cannot isolate the authored food without a food-specific rule.
      expect(line.variant_surface_unambiguous, text).toBe(false);
      expect(
        line.variant_found_descriptions.some((d) => /seasoned/i.test(d)),
        text
      ).toBe(true);
      expect(
        line.variant_found_descriptions.some((d) => /coffee cake/i.test(d)),
        text
      ).toBe(true);
      expect(line.disposition, text).toBe('candidate_generation_handoff');
      expect(line.evidence, text).toBe('repair_owned_by_tokenization_not_catalog_surface');
      expect(line.repairable, text).toBe(false);
      expect(line.owned_by_other_lane, text).toBe(true);
    }
  });

  it('the plain bread-crumbs record would carry usable portion authority', () => {
    // Recorded as measured fact: IF the identity were authorized, the mass would
    // resolve. That is why this is a surface failure and not an absence.
    for (const text of ['2 cups breadcrumbs', '2 cups firmly packed breadcrumbs']) {
      expect(lineFor(text).portion_authority_available_for_variant, text).toBe(true);
    }
  });

  it('never binds an FDC or manufactures mass on any catalog line', () => {
    for (const line of report().lines) {
      expect(line.selected_fdc_id, line.line).toBeNull();
      expect(line.mass_source, line.line).toBe('none');
      expect(line.resolved_grams, line.line).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Hypothetical surface rule
// ---------------------------------------------------------------------------

describe('AI-6B5 — the hypothetical surface rule is measured, never applied', () => {
  beforeAll(beforeAllLoad, 600000);

  it('reports measured surface reach without computing identity changes', () => {
    const sim = report().hypothetical_surface_simulation;
    expect(sim.lines_probed).toBeGreaterThan(0);
    expect(sim.lines_whose_direct_surface_is_empty).toBeGreaterThan(0);
    expect(sim.lines_whose_variant_surface_finds_records).toBeGreaterThan(0);
    // AI-6B5 never applies the rule, so it must not claim computed mass effects.
    expect(sim.identity_or_mass_changes_computed).toBe(false);
    expect(sim.not_computed_reason.length).toBeGreaterThan(0);
  });

  it('violates no checked-in constraint', () => {
    const sim = report().hypothetical_surface_simulation;
    expect(sim.expected_fdc_divergences).toBe(0);
    expect(sim.expect_no_automatic_violations).toBe(0);
    expect(sim.forbidden_fdc_violations).toBe(0);
    expect(sim.forbidden_description_violations).toBe(0);
    // M2/M17: the variant surface must not genericize a brand.
    expect(sim.lines_whose_variant_surface_is_brand_genericizing).toBe(0);
  });

  it('cannot repair any line, because the surface is ambiguous where it bites', () => {
    // Every line the variant surface reaches is ambiguous, so none is repairable.
    const reached = report().lines.filter((line) => line.variant_found_fdc_ids.length > 0);
    expect(reached.length).toBeGreaterThan(0);
    for (const line of reached) {
      expect(line.variant_surface_unambiguous, line.line).toBe(false);
      expect(line.repairable, line.line).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Repairability, oracle, lane separation
// ---------------------------------------------------------------------------

describe('AI-6B5 — repairability is measured and the oracle is untouched', () => {
  beforeAll(beforeAllLoad, 600000);

  it('derives the repairable count from the per-line verdicts', () => {
    const derived = report().lines.filter((line) => line.repairable).length;
    expect(report().repairable_deterministic_catalog_surface_defects).toBe(derived);
    expect(derived).toBe(0);
    expect(report().catalog_lane_exhausted).toBe(true);
  });

  // M7 TARGET: the 46 known-good identities are never touched.
  it('M7 — leaves the known-good identity oracle at 46/46 with zero unsafe', () => {
    expect(report().production_baseline.verified_correct_auto_identity).toBe(46);
    expect(report().production_baseline.verified_unsafe_auto_identity).toBe(0);
  });

  it('keeps catalog, identity, ranking and portion as distinct lanes', () => {
    expect(report().observed_catalog_blockers).toBe(5);
    expect(report().deterministic_portion_blockers).toBe(35);
    expect(report().deterministic_identity_blockers).toBe(27);
    expect(report().deterministic_ranking_blockers).toBe(9);
    expect(
      report().observed_catalog_blockers +
        report().deterministic_identity_blockers +
        report().deterministic_ranking_blockers +
        report().deterministic_portion_blockers
    ).toBe(76);
    // Identity-lane and ranking-lane lines are NOT in the catalog census.
    for (const text of ['2 cloves', '3 stalks celery', '2 cups tomato sauce']) {
      expect(report().lines.some((l) => l.line === text), text).toBe(false);
    }
  });

  it('reports AI-3 eligibility per line without changing it', () => {
    expect(report().ai3_eligibility_counts.reduce((s, e) => s + e.count, 0)).toBe(5);
    for (const line of report().lines) {
      // An unresolved catalog identity blocks estimation entirely: AI-6B5 must
      // not expand AI identity authority to cover any of them.
      expect(line.ai3_eligible, line.line).toBe(false);
      expect(line.ai3_reason.length, line.line).toBeGreaterThan(0);
    }
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

describe('AI-6B5 — the roadmap follows measured repairability', () => {
  beforeAll(beforeAllLoad, 600000);

  it('marks all four adjudicated lanes exhausted at zero actionable defects', () => {
    for (const lane of [
      'deterministic_portion',
      'deterministic_identity',
      'deterministic_ranking',
      'catalog_gap',
    ]) {
      const row = report().lane_repairability.find((entry) => entry.lane === lane);
      expect(row?.adjudicated, lane).toBe(true);
      expect(row?.actionable_defects, lane).toBe(0);
      expect(row?.exhausted, lane).toBe(true);
    }
    const catalog = report().lane_repairability.find((lane) => lane.lane === 'catalog_gap');
    expect(catalog?.observed_blockers).toBe(5);
  });

  it('never reports an un-adjudicated lane as zero actionable', () => {
    const adjudicated = [
      'deterministic_portion',
      'deterministic_identity',
      'deterministic_ranking',
      'catalog_gap',
    ];
    for (const lane of report().lane_repairability) {
      if (adjudicated.includes(lane.lane)) continue;
      expect(lane.adjudicated, lane.lane).toBe(false);
      expect(lane.actionable_defects, lane.lane).toBeNull();
      expect(lane.exhausted, lane.lane).toBe(false);
    }
  });

  // M8 TARGET: the recommendation is derived, never hardcoded.
  it('M8 — the recommendation is derived, not hardcoded to catalog_gap', () => {
    const measured = deriveNextWork({
      observedBlockers: [
        { lane: 'deterministic_portion', count: 35 },
        { lane: 'deterministic_identity', count: 27 },
        { lane: 'deterministic_ranking', count: 9 },
        { lane: 'catalog_gap', count: 5 },
      ],
      adjudicatedActionableDefects: {
        deterministic_portion: 0,
        deterministic_identity: 0,
        deterministic_ranking: 0,
        catalog_gap: 0,
      },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(measured.recommended_active_repair_lane).toBeNull();

    const catalogRepaired = deriveNextWork({
      observedBlockers: [
        { lane: 'deterministic_portion', count: 35 },
        { lane: 'deterministic_identity', count: 27 },
        { lane: 'deterministic_ranking', count: 9 },
        { lane: 'catalog_gap', count: 5 },
      ],
      adjudicatedActionableDefects: {
        deterministic_portion: 0,
        deterministic_identity: 0,
        deterministic_ranking: 0,
        catalog_gap: 1,
      },
      criteriaScores: SCORES,
      criteriaOrder: ORDER,
      neverTargetLanes: new Set<string>(),
    });
    expect(catalogRepaired.recommended_active_repair_lane).toBe('catalog_gap');
  });

  it('reports no active repair once every adjudicated lane is exhausted', () => {
    expect(report().recommended_active_repair_lane).toBeNull();
    expect(report().recommended_active_repair_reason).toBe(
      'no_adjudicated_lane_has_actionable_defects'
    );
  });

  // M9 TARGET: never-target lane frequency is not implementation work.
  it('M9 — no next adjudication target is invented from never-target lanes', () => {
    expect(report().next_adjudication_target_lane).toBeNull();
    expect(report().next_adjudication_reason).toBe(
      'every remaining eligible un-adjudicated lane has zero observed blockers'
    );
    // The high-frequency lanes left over are never-target by contract.
    for (const never of ['intentional_human_review', 'needs_recon', 'already_resolved']) {
      expect(report().next_adjudication_target_lane, never).not.toBe(never);
      const row = report().lane_repairability.find((lane) => lane.lane === never);
      // `already_resolved` is a never-target bookkeeping lane, not a scored one.
      if (row !== undefined) expect(row.adjudicated, never).toBe(false);
    }
    // The remaining ELIGIBLE lanes genuinely carry zero observed blockers.
    for (const lane of [
      'deterministic_parser',
      'ai_semantic_interpretation',
      'ai_bounded_mass_estimation',
    ]) {
      const row = report().lane_repairability.find((entry) => entry.lane === lane);
      expect(row?.observed_blockers, lane).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism and the production freeze
// ---------------------------------------------------------------------------

describe('AI-6B5 — determinism and the production freeze', () => {
  beforeAll(beforeAllLoad, 600000);

  // The report build authenticates the real USDA bundle and runs the real
  // phase-4 flow plus bounded searches per line, so it needs a large timeout.
  it('is byte-deterministic across two builds', async () => {
    const first = REPORT_TEXT;
    const { buildNutritionCatalogDispositionReport } = await import(
      '../../scripts/nutritionIntelligence/catalogDispositionReport'
    );
    const second = JSON.stringify(await buildNutritionCatalogDispositionReport());
    expect(second).toBe(first);
  }, 900_000);

  it('carries no clock, hostname, absolute path, or environment field', () => {
    const text = REPORT_TEXT ?? '';
    expect(text.includes('/home/'), 'absolute path').toBe(false);
    expect(text.includes(process.cwd()), 'working directory').toBe(false);
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), 'ISO timestamp').toBe(false);
  });

  it('reaches no external or live USDA source', () => {
    const text = (REPORT_TEXT ?? '').toLowerCase();
    for (const forbidden of ['api.nal.usda.gov', 'fdc.nal.usda.gov', 'https://', 'http://']) {
      expect(text.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('has ZERO production consumers', () => {
    const planningMarkers = ['catalogDisposition', 'benchmark_nutrition_catalog_disposition'];
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
      'scripts/nutritionIntelligence/rankingDisposition.ts',
      'scripts/nutritionIntelligence/rankingDispositionReport.ts',
      'scripts/nutritionIntelligence/identityDisposition.ts',
      'scripts/nutritionIntelligence/identityDispositionReport.ts',
      'scripts/nutritionIntelligence/portionDisposition.ts',
      'scripts/nutritionIntelligence/portionDispositionReport.ts',
      'scripts/nutritionIntelligence/diagnose.ts',
      'scripts/nutritionIntelligence/taxonomy.ts',
      'scripts/nutritionIntelligence/summarize.ts',
      'scripts/benchmark_nutrition_intelligence.ts',
      'scripts/benchmark_resolution_coverage.ts',
    ]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text.includes(CATALOG_DISPOSITION_SCHEMA), file).toBe(false);
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