import { describe, it, expect } from 'vitest';

import {
  QUERY_PROJECTION_VERSION,
  projectQueryText,
  preparationFormContradictionCount,
  stateContradictionCount,
  impliedStateCompatibilityMismatchCount,
} from '../../src/core/nutritionV2/matching/query';
import {
  MATCH_CONFIDENCE_VERSION,
  explainCandidate,
  classifyReviewConfidence,
  isDeterministicAutomaticSelection,
  selectAutomaticMatch,
  selectBestEffortMatch,
} from '../../src/core/nutritionV2/matching/confidence';
import { createReviewCatalog, reviewIngredient } from '../../src/core/nutritionV2/matching/review';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import type { IngredientReviewResult, RankedCandidate } from '../../src/core/nutritionV2/matching/types';

/**
 * Advanced Nutrition Phase 2 — deterministic query + food-class projection.
 *
 * Proves the ONE versioned projection contract: closed descriptor roles,
 * Phase 1 context consumption (count noun / container), state-contradiction
 * evidence, container-implied canned compatibility, and the primary/head safety
 * surfaces that withhold automatic authority without ever manufacturing a match.
 */

function candidate(
  fdcId: number,
  description: string,
  matchClass = 'all_query_tokens_present'
): RankedCandidate {
  return {
    fdc_id: fdcId,
    data_type: 'foundation',
    description,
    normalized_description: description
      .toLowerCase()
      .replace(/[^a-z0-9% ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    record_digest: 'a'.repeat(64),
    match_class: matchClass as RankedCandidate['match_class'],
    evidence: {
      exact_phrase: false,
      exact_token_multiset: false,
      matched_query_token_count: 1,
      missing_query_token_count: 0,
      extra_candidate_token_count: 0,
      order_agreement: true,
    },
  };
}

function reviewWith(
  normalizedQuery: string,
  candidates: ReadonlyArray<RankedCandidate>,
  extra: { count_noun?: string; container?: string } = {}
): IngredientReviewResult {
  return {
    outcome: 'review_required',
    line_ref: normalizedQuery,
    original_text: normalizedQuery,
    query: normalizedQuery,
    normalized_query: normalizedQuery,
    query_tokens: normalizedQuery.split(' '),
    bundle_release: 'test_release',
    catalog_digest: 'b'.repeat(64),
    normalization_version: 'usda_match_normalize_v2',
    ranking_version: 'usda_match_rank_v10',
    result_limit: 10,
    candidates,
    review_digest: 'c'.repeat(64),
    ...extra,
  } as IngredientReviewResult;
}

describe('phase 2 projection — versioned contract and determinism', () => {
  it('pins the Phase 2 projection contract version', () => {
    expect(QUERY_PROJECTION_VERSION).toBe('usda_query_projection_v10');
    expect(projectQueryText('black beans').version).toBe('usda_query_projection_v10');
    expect(MATCH_CONFIDENCE_VERSION).toBe('usda_match_confidence_v12');
  });

  it('is deterministic and never mutates its input or context', () => {
    const context = { count_noun: 'can', container: 'can' };
    const first = JSON.stringify(projectQueryText('diced tomatoes', context));
    const second = JSON.stringify(projectQueryText('diced tomatoes', context));
    expect(first).toBe(second);
    expect(context).toEqual({ count_noun: 'can', container: 'can' });
  });

  it('ignores unsafe or oversized Phase 1 context without throwing', () => {
    expect(projectQueryText('tomatoes', { container: 'x'.repeat(500) }).container).toBeNull();
    expect(projectQueryText('tomatoes', { container: 'not a noun!' as string }).container).toBeNull();
    expect(projectQueryText('tomatoes', { container: 42 as unknown as string }).container).toBeNull();
    const hostile = {
      get container(): string {
        throw new Error('boom');
      },
    };
    expect(projectQueryText('tomatoes', hostile as never).container).toBeNull();
    expect(
      projectQueryText('tomatoes', JSON.parse('{"__proto__":{"polluted":true}}') as never).container
    ).toBeNull();
    expect((Object.prototype as unknown as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('phase 2 projection — closed descriptor roles', () => {
  it('classifies variety/color as identity evidence (never discarded)', () => {
    const blackBeans = projectQueryText('black beans');
    expect(blackBeans.core_tokens).toEqual(['black', 'beans']);
    expect(blackBeans.primary_identity_tokens).toEqual(['beans']);
    expect(blackBeans.variety_tokens).toEqual(['black']);

    const roma = projectQueryText('roma tomatoes');
    expect(roma.variety_tokens).toEqual(['roma']);
    expect(roma.primary_identity_tokens).toEqual(['tomatoes']);
  });

  it('separates preparation and size from identity, and owns no qualitative field', () => {
    const onions = projectQueryText('finely chopped onions');
    expect(onions.core_tokens).toEqual(['onions']);
    expect(onions.preparation_qualifiers).toContain('chopped');
    expect(onions.preparation_qualifiers).toContain('finely');

    const eggs = projectQueryText('large eggs');
    expect(eggs.size_qualifiers).toEqual(['large']);
    expect(eggs.core_tokens).toEqual(['eggs']);

    // Qualitative cues are owned earlier (Phase 1 / `ingredientSemantics`); the
    // projection does not carry a qualitative field at all.
    const salt = projectQueryText('salt to taste');
    expect(salt.core_tokens).toEqual(['salt']);
    expect('qualitative_cue' in salt).toBe(false);
  });

  it('retains an unknown descriptor as identity evidence', () => {
    const unknown = projectQueryText('fresh huitlacoche');
    expect(unknown.core_tokens).toEqual(['huitlacoche']);
    expect(unknown.preparation_qualifiers).toContain('fresh');
  });

  it('extracts bounded secondary-component evidence without authority', () => {
    expect(projectQueryText('sardines in tomato sauce').secondary_component_tokens).toEqual([
      'tomato',
      'sauce',
    ]);
    expect(projectQueryText('bacon flavored cereal').secondary_component_tokens).toEqual(['bacon']);
    expect(projectQueryText('tomato sauce').secondary_component_tokens).toEqual([]);
  });

  it('exposes the primary head through the ONE anchor derivation', () => {
    expect(projectQueryText('black pepper').primary_identity_tokens).toEqual(['pepper']);
    expect(projectQueryText('burger buns').primary_identity_tokens).toEqual(['bun', 'roll']);
    expect(projectQueryText('roma tomatoes').anchor_groups.map((g) => [...g.accepted])).toEqual([
      ['tomatoes'],
    ]);
  });
});

describe('phase 2 projection — Phase 1 metadata consumption', () => {
  it('copies canonical count noun and container verbatim (bounded)', () => {
    const projection = projectQueryText('diced tomatoes', { container: 'can', count_noun: 'can' });
    expect(projection.container).toBe('can');
    expect(projection.count_noun).toBe('can');
    expect(projection.state_tokens).toContain('canned');
  });

  it('does not invent Phase 1 metadata when no context is supplied', () => {
    const projection = projectQueryText('2 cans beans');
    expect(projection.container).toBeNull();
    expect(projection.count_noun).toBeNull();
    expect(projection.state_tokens).toEqual([]);
  });

  it('carries Phase 1 count/container from a real parsed review into the review snapshot', () => {
    const { manifest, records } = buildMatchingBundle([{ fdcId: 6101, dataType: 'foundation', description: 'Beans, canned' }]);
    const result = createReviewCatalog(manifest, records);
    if (!result.ok) throw new Error('catalog failed');
    const review = reviewIngredient(result.catalog, '2 cans beans') as IngredientReviewResult & {
      container?: string;
      count_noun?: string;
    };
    expect(review.container).toBe('can');
    expect(review.count_noun).toBeUndefined();
  });
});

describe('phase 2 projection — state contradiction evidence', () => {
  it('withholds automatic authority on an explicit state contradiction', () => {
    const driedDill = explainCandidate('fresh dill', candidate(1, 'Spices, dill weed, dried'));
    expect(driedDill.state_contradiction).toBe(1);
    expect(driedDill.automatic_eligible).toBe(false);
    expect(driedDill.same_family_default_eligible).toBe(false);
    expect(driedDill.reasons).toContain('state_contradiction');

    const freshThyme = explainCandidate('dried thyme', candidate(2, 'Thyme, fresh'));
    expect(freshThyme.state_contradiction).toBe(1);
    expect(freshThyme.automatic_eligible).toBe(false);

    const undrained = explainCandidate('drained tuna', candidate(3, 'Fish, tuna, undrained'));
    expect(undrained.state_contradiction).toBe(1);
    expect(undrained.automatic_eligible).toBe(false);

    const whole = explainCandidate('ground almonds', candidate(4, 'Nuts, almonds, whole, raw'));
    expect(whole.state_contradiction).toBe(1);
    expect(whole.automatic_eligible).toBe(false);

    const raw = explainCandidate('canned tomatoes', candidate(5, 'Tomatoes, raw'));
    expect(raw.state_contradiction).toBe(1);
    expect(raw.automatic_eligible).toBe(false);
  });

  it('treats an omitted state as compatible (a plain record is not a contradiction)', () => {
    const plain = explainCandidate('whole almonds', candidate(6, 'Nuts, almonds, whole, raw'));
    expect(stateContradictionCount(
      'nuts almonds whole raw'.split(' '),
      projectQueryText('whole almonds')
    )).toBe(0);
    expect(plain.automatic_eligible).toBe(true);
  });

  it('honors the closed equivalence group (powdered ~ dry)', () => {
    const powdered = explainCandidate('powdered milk', candidate(7, 'Milk, dry, whole'));
    expect(powdered.state_contradiction).toBe(0);
    expect(powdered.automatic_eligible).toBe(true);

    const fresh = explainCandidate('fresh milk', candidate(8, 'Milk, dry, whole'));
    expect(fresh.state_contradiction).toBe(1);
    expect(fresh.automatic_eligible).toBe(false);
  });

  it('never contradicts raw ground beef (ground <> raw is not an opposed pair)', () => {
    const groundBeef = explainCandidate('ground beef', candidate(9, 'Beef, ground, 80% lean meat / 20% fat, raw'));
    expect(groundBeef.state_contradiction).toBe(0);
    expect(groundBeef.automatic_eligible).toBe(true);
  });
});

describe('phase 2 projection — container-implied canned compatibility', () => {
  const context = { container: 'can' };

  it('blocks an explicitly raw candidate and a silent named variety', () => {
    const raw = explainCandidate('diced tomatoes', candidate(10, 'Tomatoes, raw'), context);
    expect(raw.state_contradiction).toBe(1);
    expect(raw.automatic_eligible).toBe(false);

    const roma = explainCandidate('diced tomatoes', candidate(11, 'Tomato, roma'), context);
    expect(roma.state_contradiction).toBe(0);
    expect(roma.implied_state_mismatch).toBe(1);
    expect(roma.automatic_eligible).toBe(false);
    expect(roma.reasons).toContain('container_state_incompatible');
  });

  it('accepts an explicit canned same-form sibling and a generic NFS family record', () => {
    const cannedCrushed = explainCandidate(
      'crushed tomatoes',
      candidate(12, 'Tomatoes, crushed, canned'),
      context
    );
    expect(cannedCrushed.preparation_form_contradiction).toBe(0);
    expect(cannedCrushed.implied_state_mismatch).toBe(0);
    expect(cannedCrushed.automatic_eligible).toBe(true);

    const nfs = explainCandidate('tuna', candidate(13, 'Fish, tuna, NFS'), context);
    expect(impliedStateCompatibilityMismatchCount(['fish', 'tuna', 'nfs'], projectQueryText('tuna', context))).toBe(0);
    expect(nfs.automatic_eligible).toBe(true);
  });

  it('leaves non-can containers free of implied state', () => {
    const projection = projectQueryText('diced tomatoes', { container: 'box' });
    expect(projection.state_tokens).toEqual([]);
    const raw = explainCandidate('diced tomatoes', candidate(14, 'Tomatoes, raw'), { container: 'box' });
    expect(raw.state_contradiction).toBe(0);
    expect(raw.implied_state_mismatch).toBe(0);
  });
});

describe('phase 2 projection — primary/head and Phase 0A safety integration', () => {
  it('keeps a flavoring from becoming the primary identity', () => {
    const projection = projectQueryText('bacon flavored cereal');
    expect(projection.secondary_component_tokens).toEqual(['bacon']);
    const foreign = explainCandidate('bacon flavored cereal', candidate(15, 'Bacon, cooked'));
    expect(foreign.missing_core_tokens).toBeGreaterThan(0);
    expect(foreign.automatic_eligible).toBe(false);
    expect(foreign.reasons).toContain('missing_core_identity');
  });

  it('reuses the Phase 0A secondary-component guard evidence', () => {
    const sardine = explainCandidate(
      'canned tomato sauce',
      candidate(16, 'Fish, sardine, canned in tomato sauce, drained solids with bone')
    );
    expect(sardine.secondary_component_only).toBe(1);
    expect(sardine.family_mismatch).toBe(1);
    expect(sardine.automatic_eligible).toBe(false);
    expect(sardine.reasons).toContain('secondary_component_only');
    expect(sardine.reasons).toContain('food_family_mismatch');
  });

  it('demotes an incompatible product/dish head', () => {
    const dressing = explainCandidate('dill', candidate(17, 'Salad dressing, ranch'));
    expect(dressing.family_mismatch).toBe(1);
    expect(dressing.automatic_eligible).toBe(false);
    expect(dressing.reasons).toContain('food_family_mismatch');
  });
});

describe('phase 2 projection — confidence and selection integration', () => {
  it('withholds strict, best-effort, analyzer, and AI-deterministic identity for a different explicit form', () => {
    const review = reviewWith(
      'diced tomatoes',
      [
        candidate(2709719, 'Tomatoes, raw'),
        candidate(170501, 'Tomatoes, crushed, canned'),
        candidate(1999634, 'Tomato, roma'),
      ],
      { container: 'can' }
    );
    expect(selectAutomaticMatch(review)).toBeUndefined();
    expect(selectBestEffortMatch(review)).toBeUndefined();
    // The AI-assisted deterministic path validates against the same contracts.
    expect(isDeterministicAutomaticSelection(review, 170501)).toBe(false);
    expect(isDeterministicAutomaticSelection(review, 2709719)).toBe(false);
    expect(classifyReviewConfidence(review)).toBe('review');
  });

  it('keeps a same-form canned candidate eligible for automatic selection', () => {
    const review = reviewWith(
      'crushed tomatoes',
      [candidate(170501, 'Tomatoes, crushed, canned')],
      { container: 'can' }
    );
    expect(selectAutomaticMatch(review)?.fdc_id).toBe(170501);
    expect(selectBestEffortMatch(review)?.fdc_id).toBe(170501);
  });

  it('keeps a plain NFS canned-family record eligible best-effort', () => {
    const review = reviewWith('tuna', [candidate(2706309, 'Fish, tuna, NFS')], { container: 'can' });
    expect(selectAutomaticMatch(review)?.fdc_id).toBe(2706309);
    expect(selectBestEffortMatch(review)?.fdc_id).toBe(2706309);
  });

  it('withholds automatic authority for a strict state contradiction', () => {
    const review = reviewWith('fresh dill', [
      candidate(170925, 'Spices, dill seed'),
      candidate(170924, 'Dill weed, fresh'),
    ]);
    expect(selectAutomaticMatch(review)).toBeUndefined();
    expect(selectBestEffortMatch(review)).toBeUndefined();
    // Full core identity is present, so it stays a credible REVIEW suggestion
    // (never automatic) rather than an unresolved family mismatch.
    expect(classifyReviewConfidence(review)).toBe('review');
  });
});

describe('phase 2 projection — preparation-form authority', () => {
  it('treats the same explicit form as compatible (no contradiction)', () => {
    const diced = explainCandidate('diced tomatoes', candidate(20, 'Tomatoes, diced, canned'));
    expect(diced.preparation_form_contradiction).toBe(0);

    const plural = explainCandidate('sliced mushrooms', candidate(21, 'Mushrooms, slices'));
    expect(plural.preparation_form_contradiction).toBe(0);

    const puree = explainCandidate('pureed carrots', candidate(22, 'Carrots, purée'));
    expect(puree.preparation_form_contradiction).toBe(0);
    expect(
      preparationFormContradictionCount(
        'carrots purée'.split(' '),
        projectQueryText('pureed carrots')
      )
    ).toBe(0);
    expect(projectQueryText('purée carrots').food_tokens).toContain('purée');
  });

  it('contradicts different explicit forms and keeps them out of automatic authority', () => {
    const crushed = explainCandidate('diced tomatoes', candidate(23, 'Tomatoes, crushed, canned'));
    expect(crushed.preparation_form_contradiction).toBe(1);
    expect(crushed.automatic_eligible).toBe(false);
    expect(crushed.same_family_default_eligible).toBe(false);
    expect(crushed.reasons).toContain('preparation_form_contradiction');

    for (const [query, description] of [
      ['sliced mushrooms', 'Mushrooms, whole'],
      ['sliced mushrooms', 'Mushrooms, chopped'],
      ['sliced mushrooms', 'Mushrooms, minced'],
      ['sliced mushrooms', 'Mushrooms, crushed'],
      ['chopped onions', 'Onions, minced'],
      ['mashed potatoes', 'Potatoes, diced'],
      ['shredded carrots', 'Carrots, grated'],
      ['halved tomatoes', 'Tomatoes, quartered'],
    ] as const) {
      const explanation = explainCandidate(query, candidate(24, description));
      expect(explanation.preparation_form_contradiction, `${query} vs ${description}`).toBe(1);
      expect(explanation.automatic_eligible, `${query} vs ${description}`).toBe(false);
    }
  });

  it('stays neutral when the candidate is silent about preparation form', () => {
    const silent = explainCandidate('diced tomatoes', candidate(25, 'Tomatoes, canned'));
    expect(silent.preparation_form_contradiction).toBe(0);

    const counter = preparationFormContradictionCount(
      'tomatoes canned'.split(' '),
      projectQueryText('diced tomatoes')
    );
    expect(counter).toBe(0);

    const unknown = projectQueryText('crumbled feta');
    expect(unknown.preparation_qualifiers).toContain('crumbled');
    const crumbled = explainCandidate('crumbled feta', candidate(26, 'Cheese, feta, crumbled'));
    expect(crumbled.preparation_form_contradiction).toBe(0);
  });

  it('cannot grant positive authority through form agreement alone', () => {
    const wrongFood = explainCandidate('diced tomatoes', candidate(27, 'Carrots, diced'));
    expect(wrongFood.preparation_form_contradiction).toBe(0);
    expect(wrongFood.automatic_eligible).toBe(false);
    expect(wrongFood.reasons).toContain('missing_core_identity');
  });

  it('does not change the ranking comparator evidence (no double-counting)', () => {
    const crushed = explainCandidate('diced tomatoes', candidate(28, 'Tomatoes, crushed, canned'));
    expect(crushed.family_mismatch).toBe(0);
    expect(crushed.missing_core_tokens).toBe(0);
    expect(crushed.missing_form_tokens).toBe(0);
  });

  it('normalizes punctuation, plurals, hyphens, and accents through the closed map', () => {
    const hyphenated = explainCandidate('hand-diced tomatoes', candidate(29, 'Tomatoes, diced'));
    expect(hyphenated.preparation_form_contradiction).toBe(0);
    const accents = explainCandidate('pureed carrots', candidate(30, 'Carrots, purées'));
    expect(accents.preparation_form_contradiction).toBe(0);
    const candidateCase = explainCandidate('diced tomatoes', candidate(31, 'Tomatoes, DICED'));
    expect(candidateCase.preparation_form_contradiction).toBe(0);
  });

  it('is deterministic, mutation-free, and bounded on hostile input', () => {
    const projection = projectQueryText('diced tomatoes');
    const candidateTokens = 'tomatoes crushed canned'.split(' ');
    const snapshot = JSON.stringify(candidateTokens);
    const first = preparationFormContradictionCount(candidateTokens, projection);
    const second = preparationFormContradictionCount(candidateTokens, projection);
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(JSON.stringify(candidateTokens)).toBe(snapshot);

    const hostile = new Array(5000).fill('crushed');
    expect(preparationFormContradictionCount(hostile, projection)).toBe(1);
    expect(preparationFormContradictionCount([], projection)).toBe(0);
    expect(preparationFormContradictionCount(['tomatoes'], projection)).toBe(0);
  });
});
