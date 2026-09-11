/**
 * Ask My Kitchen — generic ingredient matching END-TO-END.
 *
 * Proves that the deterministic candidate set (built through the real Ask My
 * Kitchen path: deterministicKitchenIntent -> buildKitchenCandidates) now finds
 * generic-ingredient variants ("chicken" -> "chicken breast"/"rotisserie
 * chicken"), keeps ALL include semantics, never leaks across sequential queries,
 * and that AI ranking cannot introduce candidates outside the deterministic set.
 *
 * The matcher is query-side ONLY: canonical ingredient identity is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { deterministicKitchenIntent } from '../../src/utils/kitchenQueryInterpreter';
import {
  buildKitchenCandidates,
  rankKitchenCandidates,
  buildGroundedKitchenAnswer,
} from '../../src/utils/kitchenRanking';
import type { ResolvedKitchenContext } from '../../src/utils/kitchenIntentPolicy';
import type { SearchableRecipe } from '../../src/utils/kitchenSearch';

const ing = (original: string) => ({ original });

function r(overrides: Partial<SearchableRecipe> & { id: string }): SearchableRecipe {
  return {
    title: overrides.id,
    tags: [],
    category: '',
    cuisine: '',
    difficulty: '',
    rating: 0,
    isFavorite: false,
    ingredients: [],
    ...overrides,
  };
}

const VAULT: SearchableRecipe[] = [
  r({
    id: 'chicken-roman',
    title: 'Roman-Style Chicken',
    tags: ['chicken', 'cuisine/italian'],
    ingredients: [ing('4 skinless chicken breast halves, with ribs'), ing('2 cloves garlic')],
  }),
  r({
    id: 'chicken-soup',
    title: 'Chicken & Black Bean Soup',
    tags: ['chicken'],
    ingredients: [ing('2 cups shredded rotisserie chicken'), ing('1 can black beans')],
  }),
  r({
    id: 'garlic-sauce',
    title: 'Garlic Sauce',
    tags: ['sauce'],
    ingredients: [ing('4 garlic cloves'), ing('olive oil')],
  }),
  r({
    id: 'beef-stew',
    title: 'Beef Stew',
    tags: ['beef'],
    ingredients: [ing('1 lb beef chuck'), ing('carrots')],
  }),
];

const resolved: ResolvedKitchenContext = { currentRecipeId: undefined };

function candidatesFor(question: string) {
  const intent = deterministicKitchenIntent(question);
  return { intent, candidates: buildKitchenCandidates(intent, VAULT, resolved, {}) };
}

describe('Ask My Kitchen — generic ingredient matching end-to-end', () => {
  it('"contain chicken" returns chicken variants and excludes unrelated recipes', () => {
    const { intent, candidates } = candidatesFor('What recipes in my vault contain chicken?');
    expect(intent.constraints?.includeIngredients).toEqual(['chicken']);
    const ids = candidates.map((c) => c.recipeId).sort();
    expect(ids).toEqual(['chicken-roman', 'chicken-soup']);
    for (const c of candidates) expect(c.matchedConstraints).toContain('contains "chicken"');
    expect(ids).not.toContain('garlic-sauce');
    expect(ids).not.toContain('beef-stew');
  });

  it('a garlic-only sauce does NOT enter a chicken query merely because it has garlic', () => {
    const { candidates } = candidatesFor('What recipes in my vault contain chicken?');
    expect(candidates.map((c) => c.recipeId)).not.toContain('garlic-sauce');
  });

  it('AI ranking cannot introduce candidates outside the deterministic set', async () => {
    const { intent, candidates } = candidatesFor('What recipes in my vault contain chicken?');
    const { selected } = await rankKitchenCandidates(intent, candidates, resolved, {
      question: 'What recipes in my vault contain chicken?',
      aiRank: async () => [
        { recipeId: 'ghost-recipe', score: 1, reasons: [] },
        { recipeId: 'beef-stew', score: 1, reasons: [] },
        { recipeId: candidates[0]?.recipeId ?? 'chicken-roman', score: 1, reasons: [] },
      ],
    });
    const ids = selected.map((s) => s.recipeId);
    expect(ids).not.toContain('ghost-recipe');
    expect(ids).not.toContain('beef-stew');
    expect(ids.every((id) => candidates.some((c) => c.recipeId === id))).toBe(true);
  });

  it('grounded answer reflects the matched ingredient evidence', async () => {
    const { intent, candidates } = candidatesFor('What recipes in my vault contain chicken?');
    const { selected } = await rankKitchenCandidates(intent, candidates, resolved, {
      question: 'What recipes in my vault contain chicken?',
    });
    const answer = buildGroundedKitchenAnswer(selected, candidates, { source: 'deterministic' });
    expect(answer.noMatches).toBe(false);
    expect(answer.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(answer.items)).toContain('chicken');
  });

  it('sequential queries do not leak candidate terms between runs', () => {
    const garlic = candidatesFor('What recipes contain garlic?').candidates.map((c) => c.recipeId).sort();
    const chicken = candidatesFor('What recipes contain chicken?').candidates.map((c) => c.recipeId).sort();
    const beef = candidatesFor('What recipes contain beef?').candidates.map((c) => c.recipeId).sort();

    // The garlic query legitimately returns BOTH the garlic-only sauce and the
    // chicken recipe (which contains garlic cloves) — that is not leakage.
    expect(garlic).toEqual(['chicken-roman', 'garlic-sauce']);
    expect(chicken).toEqual(['chicken-roman', 'chicken-soup']);
    expect(beef).toEqual(['beef-stew']);

    // No cross-query leakage: each query's constraint is applied independently.
    expect(chicken).not.toContain('garlic-sauce');
    expect(chicken).not.toContain('beef-stew');
    expect(beef).not.toContain('chicken-roman');
    expect(beef).not.toContain('garlic-sauce');
  });
});
