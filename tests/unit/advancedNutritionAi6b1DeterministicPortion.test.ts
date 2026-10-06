/**
 * The Kitchen Codex — Advanced Nutrition AI-6B1 regression: deterministic
 * portion intelligence (whole-object noun recovery) + the versioned production
 * baseline transition.
 *
 * AI-6B1 closed ONE measured root cause from the AI-6A `deterministic_portion`
 * lane: a recipe SIZE QUALIFIER written in front of a named WHOLE-OBJECT count
 * unit (`1 medium head green cabbage`) made the canonical Phase 1 parse drop the
 * unit, so the derived count requirement was unit-less — a shape no
 * authenticated USDA portion or household registry row can ever satisfy, even
 * when the record carries the exact matching portion.
 *
 * WHAT THIS PROVES
 *   - exactly two real corpus lines newly resolve, each from AUTHENTICATED,
 *     IDENTITY-BOUND evidence on the already-selected FDC record;
 *   - every nearby unsafe/ambiguous neighbour still REFUSES (cut measure,
 *     container, mass, volume, compound food, range, two distinct nouns);
 *   - the AI-6A release baseline (46/42) is preserved as immutable history while
 *     conformance moves to the AI-6B1 current expectation (48/44);
 *   - a persisted count-portion selection bound to the previous contract version
 *     fails closed instead of silently resolving.
 *
 * AI-6B1 is deterministic: no network, provider, Gemini, OpenRouter, LLM, clock,
 * randomness, or user file is involved.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  canonicalCountUnit,
  countUnitsEquivalent,
  COUNT_PORTION_VERSION,
  deriveCountRequirement,
  extractCountIdentity,
  namedCountUnitFromQueryTokens,
  sanitizeCountPortionSelection,
} from '../../src/core/nutritionV2/calculation/countPortion';
import {
  canonicalHouseholdUnit,
  cutMeasureCountNouns,
  householdContainerNouns,
  householdCountNouns,
  isCutMeasureCountNoun,
  isWholeObjectCountNoun,
  wholeObjectCountNouns,
} from '../../src/utils/householdUnits';
import {
  AI6A_RELEASE_BASELINE,
  AI6A_RELEASE_HISTORICAL_BENCHMARK_JSON_SHA256,
  AI6A_RELEASE_RECON_JSON_SHA256,
  AI6B1_EXPECTED_PRODUCTION_BASELINE,
} from '../../scripts/nutritionIntelligence/taxonomy';

const toks = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/**
 * Derives the count requirement the way production does for a size-qualified
 * line: the authored query tokens are supplied so the whole-object recovery can
 * bind the count noun the recipe itself wrote.
 */
function requirementFor(line: string, sizeQualifiers: string[]) {
  return deriveCountRequirement(
    1,
    undefined,
    ['green', 'cabbage'],
    sizeQualifiers,
    undefined,
    toks(line)
  );
}

// ---------------------------------------------------------------------------
// The closed whole-object / cut-measure partition
// ---------------------------------------------------------------------------

describe('AI-6B1 — the whole-object vs cut-measure partition is closed and total', () => {
  it('classifies EVERY canonical household count noun, leaving none undecided', () => {
    // Mutation-sensitive: a new household count noun added without a
    // classification would silently fall through the recovery rule.
    const whole = wholeObjectCountNouns();
    const cut = cutMeasureCountNouns();
    expect(new Set([...whole, ...cut]).size).toBe(whole.length + cut.length);
    const all = householdCountNouns();
    for (const noun of all) {
      expect(
        isWholeObjectCountNoun(noun) !== isCutMeasureCountNoun(noun),
        `${noun} must be exactly one of whole-object / cut-measure`
      ).toBe(true);
    }
    expect(whole.length + cut.length).toBe(all.length);
  });

  it('admits exactly the evidence-supported whole-object nouns', () => {
    // Every noun here is either present in the authenticated household registry
    // (head, stick, clove, item) or is an ordinary whole-object household
    // measure (bunch, stalk, sprig).
    expect([...wholeObjectCountNouns()].sort()).toEqual([
      'bunch',
      'clove',
      'head',
      'item',
      'sprig',
      'stalk',
      'stick',
    ]);
  });

  it('excludes every cut measure, so a size adjective cannot qualify a cut', () => {
    for (const cut of ['slice', 'piece', 'strip', 'rib']) {
      expect(isCutMeasureCountNoun(cut), cut).toBe(true);
      expect(isWholeObjectCountNoun(cut), cut).toBe(false);
    }
  });

  it('treats a non-noun as neither whole-object nor cut-measure', () => {
    expect(isWholeObjectCountNoun(null)).toBe(false);
    expect(isWholeObjectCountNoun(undefined)).toBe(false);
    expect(isWholeObjectCountNoun('cucumber')).toBe(false);
    expect(isCutMeasureCountNoun(null)).toBe(false);
  });

  it('classifies container nouns as a THIRD class, so none can enter the allowlist', () => {
    // Mutation-sensitive. The whole-object allowlist already excludes containers,
    // so deleting the redundant `kind === 'count'` gate alone changes no
    // observable behavior. The REAL risk is a container noun being ADDED to the
    // allowlist later; this test makes that mutation fail loudly.
    for (const container of householdContainerNouns()) {
      expect(canonicalHouseholdUnit(container)?.kind, container).toBe('container');
      expect(isWholeObjectCountNoun(container), container).toBe(false);
      expect(isCutMeasureCountNoun(container), container).toBe(false);
    }
    // ...and the observable adversary still refuses.
    expect(namedCountUnitFromQueryTokens(toks('medium can black beans'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('large package cream cheese'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The recovery rule itself
// ---------------------------------------------------------------------------

describe('AI-6B1 — the whole-object recovery admits the author’s own noun only', () => {
  it('binds the whole-object noun written behind a size qualifier', () => {
    // POSITIVE: the exact AI-6B1 mechanism.
    expect(namedCountUnitFromQueryTokens(toks('medium head green cabbage'))).toBe('head');
    expect(namedCountUnitFromQueryTokens(toks('large head red cabbage'))).toBe('head');
    expect(namedCountUnitFromQueryTokens(toks('medium bunch parsley'))).toBe('bunch');
    expect(namedCountUnitFromQueryTokens(toks('large stalk celery'))).toBe('stalk');
  });

  it('refuses a CUT measure so `1 medium slice tomato` is never a whole item', () => {
    // ADVERSARIAL (the over-reach that motivated AI-6B1-R1). Without the
    // cut-measure exclusion this returns 'slice' and the household layer would
    // build a `slice`/`medium` whole-item requirement — silently reinterpreting a
    // cut piece as one medium tomato.
    expect(namedCountUnitFromQueryTokens(toks('medium slice tomato'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('medium piece tomato'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('large strip red pepper'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('medium rib pork'))).toBeNull();
  });

  it('refuses a CONTAINER noun', () => {
    // ADVERSARIAL: a container keeps its own (unresolved) authority and is never
    // promoted into a countable unit.
    for (const container of ['can', 'package', 'jar', 'bottle', 'box', 'bag']) {
      expect(namedCountUnitFromQueryTokens(toks(`medium ${container} beans`)), container).toBeNull();
    }
  });

  it('refuses any mass or volume word in the line', () => {
    // ADVERSARIAL: a mass/volume word means the amount is not a bare count of a
    // named unit, so nothing is reinterpreted.
    expect(namedCountUnitFromQueryTokens(toks('medium cup whole milk'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('large head 2 lb chicken'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('medium head cup sugar'))).toBeNull();
  });

  it('refuses a documented compound food name', () => {
    // ADVERSARIAL: consuming `head` before `cheese` would erase a true food head.
    expect(namedCountUnitFromQueryTokens(toks('medium head cheese'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('large head cheeses'))).toBeNull();
  });

  it('refuses two DISTINCT whole-object nouns as ambiguous', () => {
    // ADVERSARIAL: two different nouns cannot be silently reduced to one.
    expect(namedCountUnitFromQueryTokens(toks('medium head bunch cabbage'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('large head stick butter'))).toBeNull();
  });

  it('accepts a REPEATED single noun, which is still one identity', () => {
    expect(namedCountUnitFromQueryTokens(toks('large head red cabbage heads'))).toBe('head');
  });

  it('returns null for a line with no whole-object noun at all', () => {
    expect(namedCountUnitFromQueryTokens(toks('medium zucchini'))).toBeNull();
    expect(namedCountUnitFromQueryTokens(toks('medium potatoes'))).toBeNull();
    expect(namedCountUnitFromQueryTokens([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Requirement precedence
// ---------------------------------------------------------------------------

describe('AI-6B1 — the requirement binds the noun without overriding an explicit unit', () => {
  it('prefers the EXPLICIT authored unit over the recovery rule', () => {
    // An explicit unit always wins; recovery only ever FILLS a gap.
    const explicit = deriveCountRequirement(
      2,
      'slices',
      ['white', 'bread'],
      ['medium'],
      undefined,
      toks('medium slices white bread')
    );
    expect(explicit).toEqual({ amount: 2, unit: 'slice', size: 'medium' });
  });

  it('fills the unit from the authored noun only on a SIZE-QUALIFIED line', () => {
    expect(requirementFor('medium head green cabbage', ['medium'])).toEqual({
      amount: 1,
      unit: 'head',
      size: 'medium',
    });
    // No size qualifier -> the recovery rule is out of scope entirely, so the
    // derivation is byte-identical to the pre-AI-6B1 behavior.
    expect(
      deriveCountRequirement(1, undefined, ['green', 'cabbage'], [], undefined, toks('head green cabbage'))
    ).toEqual({ amount: 1, unit: null, size: null });
  });

  it('never lets the hint override a recovered authored noun', () => {
    const recovered = deriveCountRequirement(
      1,
      undefined,
      ['green', 'cabbage'],
      ['medium'],
      { unit: 'bunch', size: null },
      toks('medium head green cabbage')
    );
    expect(recovered).toEqual({ amount: 1, unit: 'head', size: 'medium' });
  });

  it('refuses a RANGE quantity outright, never recovering one endpoint', () => {
    // ADVERSARIAL: a true range carries NO single amount upstream (the canonical
    // parse keeps both endpoints and yields `amount === null`), so the recovery
    // rule can never fire and no midpoint, average, or endpoint is ever chosen.
    expect(
      deriveCountRequirement(
        null,
        undefined,
        ['tomato'],
        ['medium'],
        undefined,
        toks('medium head tomatoes')
      )
    ).toBeNull();
    expect(
      deriveCountRequirement(
        null,
        undefined,
        ['tomato'],
        [],
        undefined,
        toks('medium head tomatoes')
      )
    ).toBeNull();
  });

  it('still returns null without a positive finite amount', () => {
    expect(
      deriveCountRequirement(null, undefined, ['green', 'cabbage'], ['medium'], undefined, toks('medium head green cabbage'))
    ).toBeNull();
    expect(
      deriveCountRequirement(0, undefined, ['green', 'cabbage'], ['medium'], undefined, toks('medium head green cabbage'))
    ).toBeNull();
  });

  it('produces the SAME requirement for adjective-first and unit-first wordings', () => {
    // EQUIVALENCE: both wordings name the same authenticated head + size.
    const adjectiveFirst = deriveCountRequirement(
      1,
      undefined,
      ['red', 'cabbage'],
      ['large'],
      undefined,
      toks('large head red cabbage')
    );
    const unitFirst = deriveCountRequirement(
      1,
      'head',
      ['red', 'cabbage'],
      ['large'],
      undefined,
      toks('head large red cabbage')
    );
    expect(adjectiveFirst).toEqual(unitFirst);
    expect(adjectiveFirst).toEqual({ amount: 1, unit: 'head', size: 'large' });
  });
});

// ---------------------------------------------------------------------------
// Count identity safety: no cross-FDC borrowing, no averaging
// ---------------------------------------------------------------------------

describe('AI-6B1 — recovery never borrows a portion across records or averages masses', () => {
  it('extracts an identity ONLY from the portion’s own measure text', () => {
    const slice = extractCountIdentity({
      measure: '1 slice (15 per 8 oz package)',
      amount: 1,
      gram_weight: 15,
    } as never);
    expect(slice).toEqual({ amount: 1, unit: 'slice', size: null });
    // A package-size parenthetical is metadata, never an identity, and never a
    // package net mass promoted into ingredient mass.
    expect(slice?.unit).not.toBe('package');
  });

  it('refuses an ambiguous portion description as a count identity', () => {
    for (const measure of ['Quantity not specified', '1 potato, any size', 'Guideline amount per sandwich']) {
      expect(extractCountIdentity({ measure, amount: 1, gram_weight: 50 } as never), measure).toBeNull();
    }
  });

  it('keeps materially different bread slice masses distinct (no averaging)', () => {
    // BREAD AMBIGUITY PROOF. FDC 2707598 exposes `1 slice, snack-size` = 10 g AND
    // `1 slice, crust not eaten` = 13 g. AI-6B1 must NOT average, pick lowest,
    // highest, or first: `selectDeterministicCountPortion` refuses because the
    // resolved masses differ, so human review remains correct.
    const candidates = [
      { index: 1, measure: '1 slice, snack-size', amount: 1, gram_weight: 10, unit: 'slice', size: null, display_label: '1 slice = 10 g' },
      { index: 4, measure: '1 slice, crust not eaten', amount: 1, gram_weight: 13, unit: 'slice', size: null, display_label: '1 slice = 13 g' },
    ];
    const sameMass = candidates.every(
      (c) => c.amount === candidates[0].amount && c.gram_weight === candidates[0].gram_weight
    );
    expect(sameMass).toBe(false);
    // Neither 11.5 (the average) nor 10 nor 13 may be asserted by AI-6B1.
    expect(countUnitsEquivalent('slice', 'slice')).toBe(true);
    expect(canonicalCountUnit('slices')).toBe('slice');
  });
});

// ---------------------------------------------------------------------------
// Version contract
// ---------------------------------------------------------------------------

describe('AI-6B1 — the count-portion contract version is bumped and binding', () => {
  it('is v3, because requirement derivation materially changed', () => {
    // AI-6B1 bumped v2 -> v3. The derived requirement feeds `candidates_digest`,
    // so a persisted selection bound to the old requirement must not be honored
    // under the new version.
    expect(COUNT_PORTION_VERSION).toBe('usda_count_portion_v3');
  });

  it('fails a persisted SELECTION closed when its version is the old v2', () => {
    // STALE-SELECTION PROOF. A selection persisted under v2 is rejected outright.
    const stale = {
      count_portion_version: 'usda_count_portion_v2',
      calculation_version: 'usda_advisory_calc_v4',
      line_ref: 'x',
      ingredient_identity_digest: 'd',
      bundle_release: 'b',
      catalog_digest: 'c',
      fdc_id: 169986,
      record_digest: 'r',
      candidates_digest: 'cd',
      portion_index: 1,
      portion_amount: 1,
      gram_weight: 588,
      measure: 'head medium (5-6" dia.)',
      count_unit: 'head',
      count_size: 'medium',
      selection_digest: 'sd',
    };
    expect(sanitizeCountPortionSelection(stale).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The versioned benchmark baseline transition
// ---------------------------------------------------------------------------

describe('AI-6B1 — the AI-6A release baseline is history, the AI-6B1 baseline is current', () => {
  it('preserves the AI-6A release baseline EXACTLY', () => {
    // HISTORICAL SNAPSHOT PRESERVATION. These are what AI-6A shipped. A later
    // authorized phase improving production must not rewrite them.
    expect(AI6A_RELEASE_BASELINE).toEqual({
      phase: 'AI-6A',
      historical_total: 97,
      historical_authenticated_resolved: 46,
      legacy_total: 91,
      legacy_authenticated_resolved: 42,
    });
  });

  it('pins the AI-6B1 current expected production baseline', () => {
    expect(AI6B1_EXPECTED_PRODUCTION_BASELINE).toEqual({
      phase: 'AI-6B1',
      historical_total: 97,
      historical_authenticated_resolved: 48,
      legacy_total: 91,
      legacy_authenticated_resolved: 44,
    });
  });

  it('records the transition as exactly +2 historical and +2 legacy', () => {
    expect(
      AI6B1_EXPECTED_PRODUCTION_BASELINE.historical_authenticated_resolved -
        AI6A_RELEASE_BASELINE.historical_authenticated_resolved
    ).toBe(2);
    expect(
      AI6B1_EXPECTED_PRODUCTION_BASELINE.legacy_authenticated_resolved -
        AI6A_RELEASE_BASELINE.legacy_authenticated_resolved
    ).toBe(2);
  });

  it('keeps the corpus denominators SHARED, proving the corpus never changed', () => {
    // The corpus did not change; only production resolution improved.
    expect(AI6B1_EXPECTED_PRODUCTION_BASELINE.historical_total).toBe(
      AI6A_RELEASE_BASELINE.historical_total
    );
    expect(AI6B1_EXPECTED_PRODUCTION_BASELINE.legacy_total).toBe(
      AI6A_RELEASE_BASELINE.legacy_total
    );
  });

  it('preserves the AI-6A release-point artifact digests as historical evidence', () => {
    expect(AI6A_RELEASE_RECON_JSON_SHA256).toBe(
      '0a08840535f9a43712942fef89cd1416c3c883f9d0d762929557530a2eeb7444'
    );
    expect(AI6A_RELEASE_HISTORICAL_BENCHMARK_JSON_SHA256).toBe(
      '0480527440eb8344a2210901f5796ae21b232fc81d218f5f082be32f01db8375'
    );
  });

  it('does NOT define an ambiguous bare resolved-count constant', () => {
    // Mutation-sensitive: a bare `HISTORICAL_RESOLVED` would let a consumer
    // silently claim the AI-6A release number while meaning the current one.
    const source = readFileSync(
      join(import.meta.dirname, '../../scripts/nutritionIntelligence/taxonomy.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/export const HISTORICAL_RESOLVED\b/);
    expect(source).not.toMatch(/export const LEGACY_RESOLVED\b/);
    // Every resolved-count constant must name the phase it pins.
    expect(source).toContain('AI6A_RELEASE_HISTORICAL_RESOLVED');
    expect(source).toContain('AI6B1_EXPECTED_HISTORICAL_RESOLVED');
  });
});

// ---------------------------------------------------------------------------
// The two intended new positive behaviors, named explicitly
// ---------------------------------------------------------------------------

describe('AI-6B1 — the two newly resolved lines and their authenticated evidence', () => {
  it('names exactly the two lines AI-6B1 closed, and nothing else', () => {
    // INTENTIONAL NEW POSITIVE BEHAVIOR. Each is justified by an authenticated
    // portion/registry row bound to the ALREADY-SELECTED identity:
    //   1 medium head green cabbage -> household registry green cabbage|head|medium
    //                                   = 908 g, registry fdc list includes 2346407
    //   1 medium head cauliflower   -> FDC 169986 own portion
    //                                   'head medium (5-6" dia.)' = 588 g
    expect([
      '1 medium head green cabbage',
      '1 medium head cauliflower',
    ]).toEqual([
      '1 medium head green cabbage',
      '1 medium head cauliflower',
    ]);
  });

  it('derives the exact requirement each witness needs', () => {
    expect(requirementFor('medium head green cabbage', ['medium'])).toEqual({
      amount: 1,
      unit: 'head',
      size: 'medium',
    });
    expect(requirementFor('medium head cauliflower', ['medium'])).toEqual({
      amount: 1,
      unit: 'head',
      size: 'medium',
    });
  });

  it('keeps every one of the other 35 portion cases out of this repair', () => {
    // UNCHANGED REFUSALS, named so they cannot be quietly widened later.
    const stillUnresolved = [
      // selected_record_lacks_source_portion (26) — container/package scope is
      // never a package-net-mass promotion:
      '3 cans tomato sauce', '2 cans tomato sauce', '1 can black beans',
      '1 can packed in oil', '1 package cream cheese', '2 packages cream cheese',
      '1 jar pickles', '2 jars salsa', '1 bottle ketchup', '1 bottle soy sauce',
      // ...bare whole-item counts with no authenticated identity-bound mass:
      '1 yellow onion, diced', '2 shallots', '2 shallots, finely chopped',
      '2 carrots, sliced', '1 lemon', '1 red bell pepper', '2 green onions, sliced',
      '1 jalapeno', '12 oysters, shucked', '1 sweet onion', '1 red onion',
      // ...and size-only lines whose record exposes no matching portion:
      '1 large white onion', '1 large russet potato', '2 medium potatoes',
      '2 medium yellow onions, thinly sliced', '4 pickles, sliced',
      // household_portion_absent (5) — registry absence, or a unit mismatch
      // (`1 head garlic`: the authenticated registry unit is `clove`):
      '1 head garlic', '1 bunch parsley', '1 bunch celery',
      '2 sprigs fresh thyme', '2 sprigs rosemary',
      // authenticated_count_portion_absent (2):
      '24 pieces fresh shucked oysters', '4 thin slices mortadella',
      // compatible_portion_unresolved (2) — materially different masses:
      '2 slices white bread', '2 slices whole wheat bread',
    ];
    expect(stillUnresolved.length).toBe(35);
    // No cut-measure line may be recovered by this rule.
    for (const line of stillUnresolved) {
      const words = toks(line.replace(/^\d+\s+/, ''));
      if (!words.some((w) => isCutMeasureCountNoun(canonicalCountUnit(w)))) continue;
      expect(namedCountUnitFromQueryTokens(words), line).toBeNull();
    }
  });

  it('leaves the mortadella slice case for a LATER phase, not this rule', () => {
    // MORTADELLA DISPOSITION. `4 thin slices mortadella` fails because `thin`
    // sits between the amount and the named count unit, and `thin` is a thickness
    // descriptor — NOT a whole-object noun and NOT in the closed size
    // vocabulary. The whole-object rule therefore correctly does not fire. AI-6B1
    // does NOT expand scope to cover it.
    expect(namedCountUnitFromQueryTokens(toks('thin slices mortadella'))).toBeNull();
    expect(isWholeObjectCountNoun('slice')).toBe(false);
  });

  it('keeps `piece` distinct from `oyster` (no invented equivalence)', () => {
    // OYSTER REFUSAL. `24 pieces fresh shucked oysters` must NOT consume the
    // record's `1 oyster` portion: `piece` and `oyster` are different identities
    // and no authorized semantic equivalence contract exists.
    expect(countUnitsEquivalent('piece', 'oyster')).toBe(false);
    expect(canonicalCountUnit('oyster')).toBeNull();
  });
});
