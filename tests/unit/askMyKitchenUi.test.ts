import { describe, it, expect } from 'vitest';
import type { ObsidianRecipe } from '../../src/types';
import type { KitchenQuery, SearchableRecipe } from '../../src/utils/kitchenSearch';
import { buildAnswerEvidence } from '../../src/utils/kitchenAnswer';
import { searchKitchenRecipes } from '../../src/utils/kitchenSearch';
import {
  resolveAnswerRecipe,
  applyTrustedSimilarContext,
  buildInterpretRequest,
  buildAnswerRequest,
  isInterpretResponse,
  isAnswerResponse,
} from '../../src/utils/askMyKitchenUi';

function asRecipe(partial: Record<string, unknown>): ObsidianRecipe {
  return partial as unknown as ObsidianRecipe;
}

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

describe('askMyKitchenUi: resolveAnswerRecipe', () => {
  const recipes = [
    asRecipe({ id: 'a', filePath: 'a.md', fileName: 'a.md', title: 'Alpha' }),
    asRecipe({ id: 'b', filePath: 'b.md', fileName: 'b.md', title: 'Beta' }),
  ];

  it('resolves an existing recipe by identity', () => {
    expect(resolveAnswerRecipe('a', recipes)?.title).toBe('Alpha');
    expect(resolveAnswerRecipe('b', recipes)?.title).toBe('Beta');
  });

  it('returns undefined for unknown or empty identity', () => {
    expect(resolveAnswerRecipe('zzz', recipes)).toBeUndefined();
    expect(resolveAnswerRecipe('', recipes)).toBeUndefined();
  });
});

describe('askMyKitchenUi: trusted similar context', () => {
  it('seeds similarToRecipeId from trusted context on a clear similar cue', () => {
    const query: KitchenQuery = { includeIngredients: ['rice'] };
    const out = applyTrustedSimilarContext(query, 'recipe-a', 'what is similar to this recipe?');
    expect(out.similarToRecipeId).toBe('recipe-a');
    expect(out.includeIngredients).toEqual(['rice']);
  });

  it('treats "recipes like this" as a similar cue', () => {
    const out = applyTrustedSimilarContext({}, 'recipe-a', 'show recipes like this');
    expect(out.similarToRecipeId).toBe('recipe-a');
  });

  it('clears a model-inferred similarToRecipeId when there is no similar intent', () => {
    const query: KitchenQuery = { similarToRecipeId: 'model-guessed', courses: ['Dessert'] };
    const out = applyTrustedSimilarContext(query, 'recipe-a', 'what desserts can I make?');
    expect(out.similarToRecipeId).toBeUndefined();
    expect(out.courses).toEqual(['Dessert']);
  });

  it('never trusts a model-inferred similarToRecipeId without trusted context', () => {
    const query: KitchenQuery = { similarToRecipeId: 'model-guessed', includeIngredients: ['eggs'] };
    const out = applyTrustedSimilarContext(query, undefined, 'what can I make with eggs?');
    expect(out.similarToRecipeId).toBeUndefined();
    expect(out.includeIngredients).toEqual(['eggs']);
  });

  it('does not mutate the input query', () => {
    const query: KitchenQuery = { includeIngredients: ['rice'] };
    const snapshot = JSON.stringify(query);
    applyTrustedSimilarContext(Object.freeze({ ...query }) as KitchenQuery, 'recipe-a', 'similar to this');
    expect(JSON.stringify(query)).toBe(snapshot);
  });
});

describe('askMyKitchenUi: privacy request builders', () => {
  it('buildInterpretRequest sends only the question', () => {
    const body = buildInterpretRequest('What can I make with chicken and rice?');
    expect(body).toEqual({ question: 'What can I make with chicken and rice?' });
  });

  it('buildAnswerRequest contains only compact evidence (no vault data)', () => {
    const recipes = [r({ id: 'chicken-rice', title: 'Chicken Rice', ingredients: [ing('chicken'), ing('rice')] })];
    const query: KitchenQuery = { includeIngredients: ['chicken', 'rice'] };
    const results = searchKitchenRecipes(recipes, query);
    const evidence = buildAnswerEvidence(results);
    const body = buildAnswerRequest('question', query, evidence);

    expect(body.question).toBe('question');
    expect(body.query).toBe(query);
    expect(body.results).toBe(evidence);
    // No unrelated/vault keys leak.
    expect(Object.keys(body)).toEqual(['question', 'query', 'results']);
    for (const e of body.results as Array<Record<string, unknown>>) {
      expect((e as Record<string, unknown>)['ingredients']).toBeUndefined();
      expect((e as Record<string, unknown>)['rawMarkdown']).toBeUndefined();
      expect((e as Record<string, unknown>)['notes']).toBeUndefined();
    }
  });
});

describe('askMyKitchenUi: response shape validation', () => {
  it('accepts a valid interpret response', () => {
    expect(isInterpretResponse({ ok: true, source: 'deterministic', query: { maxTotalMinutes: 30 } })).toBe(true);
  });

  it('rejects malformed interpret responses', () => {
    expect(isInterpretResponse({ ok: false, error: 'x' })).toBe(false);
    expect(isInterpretResponse({ ok: true })).toBe(false);
    expect(isInterpretResponse({ ok: true, query: [] as unknown })).toBe(false);
    expect(isInterpretResponse(null)).toBe(false);
    expect(isInterpretResponse('nope')).toBe(false);
  });

  it('accepts a valid answer response', () => {
    const payload = {
      ok: true,
      source: 'deterministic',
      summary: 'I found 1 matching recipe in your vault.',
      noMatches: false,
      items: [{ recipeIdentity: 'a', explanation: 'contains "rice"' }],
    };
    expect(isAnswerResponse(payload)).toBe(true);
  });

  it('rejects malformed answer responses', () => {
    expect(isAnswerResponse({ ok: false, error: 'x' })).toBe(false);
    expect(isAnswerResponse({ ok: true, summary: '', noMatches: false, items: 'x' })).toBe(false);
    expect(isAnswerResponse({ ok: true, summary: '', noMatches: false, items: [{ recipeIdentity: 5 }] })).toBe(false);
    expect(isAnswerResponse({ ok: true, summary: '', noMatches: false, items: [{ recipeIdentity: 'a' }] })).toBe(false);
    expect(isAnswerResponse(null)).toBe(false);
  });
});
