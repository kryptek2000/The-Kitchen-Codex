import { describe, it, expect } from 'vitest';
import type { ObsidianRecipe } from '../../src/types';
import type { KitchenQuery, SearchableRecipe } from '../../src/utils/kitchenSearch';
import type { KitchenIntent } from '../../src/utils/kitchenIntent';
import type { ResolvedKitchenContext } from '../../src/utils/kitchenIntentPolicy';
import { sanitizeKitchenIntent } from '../../src/utils/kitchenIntent';
import { prepareKitchenIntentForExecution } from '../../src/utils/kitchenIntentPolicy';
import { buildAnswerEvidence } from '../../src/utils/kitchenAnswer';
import { searchKitchenRecipes } from '../../src/utils/kitchenSearch';
import {
  resolveAnswerRecipe,
  applyTrustedSimilarContext,
  buildInterpretRequest,
  buildAnswerRequest,
  isInterpretResponse,
  isAnswerResponse,
  httpErrorMessage,
  NETWORK_ERROR_MESSAGE,
  INVALID_RESPONSE_MESSAGE,
  intentBlockedMessage,
  intentToQuery,
  isIntentRuntimeSupported,
  canExecuteLocalRetrieval,
  RUNTIME_NOT_SUPPORTED_MESSAGE,
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
  it('accepts a valid interpret response (sanitized KitchenIntent)', () => {
    expect(
      isInterpretResponse({
        ok: true,
        source: 'deterministic',
        intent: {
          version: 1,
          intent: 'find_recipes',
          source: 'vault',
          constraints: { maxTotalMinutes: 30 },
          preferences: {},
          requiresClarification: false,
        },
      })
    ).toBe(true);
  });

  it('rejects malformed interpret responses', () => {
    expect(isInterpretResponse({ ok: false, error: 'x' })).toBe(false);
    expect(isInterpretResponse({ ok: true })).toBe(false);
    expect(isInterpretResponse({ ok: true, intent: [] as unknown })).toBe(false);
    expect(isInterpretResponse({ ok: true, query: { maxTotalMinutes: 30 } as unknown })).toBe(false);
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

  it('validates item title strictly (audit fix A)', () => {
    const ok = (items: unknown[]) => ({ ok: true, source: 'deterministic', summary: 'x', noMatches: false, items });
    // string title accepted
    expect(isAnswerResponse(ok([{ recipeIdentity: 'a', explanation: 'e', title: 'Alpha' }]))).toBe(true);
    // title absent accepted (UI falls back to identity)
    expect(isAnswerResponse(ok([{ recipeIdentity: 'a', explanation: 'e' }]))).toBe(true);
    // non-string title rejected (object/array/number must never reach React)
    expect(isAnswerResponse(ok([{ recipeIdentity: 'a', explanation: 'e', title: { x: 1 } }]))).toBe(false);
    expect(isAnswerResponse(ok([{ recipeIdentity: 'a', explanation: 'e', title: ['x'] }]))).toBe(false);
    expect(isAnswerResponse(ok([{ recipeIdentity: 'a', explanation: 'e', title: 5 }]))).toBe(false);
  });
});

describe('askMyKitchenUi: safe UI error messages', () => {
  it('maps known HTTP statuses to fixed, non-technical messages', () => {
    expect(httpErrorMessage(400)).toBe('That request was invalid. Please check your question and try again.');
    expect(httpErrorMessage(401)).toBe('This action is not available with the current vault setup.');
    expect(httpErrorMessage(422)).toBe('I could not understand that question. Please try a different wording.');
    expect(httpErrorMessage(429)).toBe('Too many requests. Please wait a moment and try again.');
    expect(httpErrorMessage(503)).toBe("Ask My Kitchen's AI interpreter is temporarily unavailable. Please try again.");
    expect(httpErrorMessage(500)).toBe('Something went wrong on the server. Please try again.');
    // Unknown/other statuses fall back to the generic server message.
    expect(httpErrorMessage(502)).toBe('Something went wrong on the server. Please try again.');
  });

  it('provides fixed network and invalid-response messages', () => {
    expect(NETWORK_ERROR_MESSAGE).toContain('server');
    expect(INVALID_RESPONSE_MESSAGE).toContain('unexpected response');
  });
});

describe('askMyKitchenUi: strict similar-to cues (audit fix B)', () => {
  const trusted = 'recipe-a';

  it('seeds similarToRecipeId for explicit similar-to phrases (true positives)', () => {
    const questions = [
      'what is similar to this recipe?',
      'recipes similar to this',
      'something similar to this',
      'recipes like this',
    ];
    for (const q of questions) {
      expect(applyTrustedSimilarContext({}, trusted, q).similarToRecipeId).toBe(trusted);
    }
  });

  it('does NOT seed for similar/like phrasing that is not recipe-similarity (false positives)', () => {
    const questions = [
      'I like this recipe',
      "I'd like this for dinner",
      'this looks similar in color',
      'how is this similar to other cuisines',
    ];
    for (const q of questions) {
      expect(applyTrustedSimilarContext({}, trusted, q).similarToRecipeId).toBeUndefined();
    }
  });

  it('still always strips a model-inferred similarToRecipeId (trusted source wins)', () => {
    expect(applyTrustedSimilarContext({ similarToRecipeId: 'guess' }, undefined, 'similar to this').similarToRecipeId).toBeUndefined();
    expect(applyTrustedSimilarContext({ similarToRecipeId: 'guess' }, trusted, 'what desserts are there?').similarToRecipeId).toBeUndefined();
  });
});

describe('askMyKitchenUi: v0.5.0 intent consumption helpers', () => {
  const mkIntent = (o: Partial<KitchenIntent>): KitchenIntent =>
    ({
      version: 1,
      intent: 'find_recipes',
      source: 'vault',
      constraints: {},
      preferences: {},
      requiresClarification: false,
      ...o,
    } as KitchenIntent);

  it('isIntentRuntimeSupported: only phase-supported intents, never pairing/compare/discover_online', () => {
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'find_recipes' }))).toBe(true);
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'ingredient_use' }))).toBe(true);
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'browse_category' }))).toBe(true);
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'meal_suggestion' }))).toBe(true);
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'similar_recipe' }))).toBe(true);
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'pairing' }))).toBe(false);
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'compare' }))).toBe(false);
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'discover_online' }))).toBe(false);
  });

  it('intentToQuery: carries sanitized constraints and never invents ids', () => {
    const intent = mkIntent({ intent: 'find_recipes', constraints: { includeIngredients: ['rice'], maxTotalMinutes: 30 } });
    const q = intentToQuery(intent, {});
    expect(q).toEqual({ includeIngredients: ['rice'], maxTotalMinutes: 30 });
    expect(q.similarToRecipeId).toBeUndefined();
  });

  it('intentToQuery: similar_recipe attaches only the TRUSTED currentRecipeId', () => {
    const intent = mkIntent({ intent: 'similar_recipe', constraints: { includeIngredients: ['chicken'] } });
    const resolved: ResolvedKitchenContext = { currentRecipeId: 'trusted-recipe' };
    const q = intentToQuery(intent, resolved);
    expect(q).toEqual({ includeIngredients: ['chicken'], similarToRecipeId: 'trusted-recipe' });
    // Without a trusted id, nothing is fabricated.
    const noId = intentToQuery(intent, {});
    expect(noId.similarToRecipeId).toBeUndefined();
  });

  it('intentBlockedMessage: executable -> empty; non-executable -> safe fixed message', () => {
    expect(intentBlockedMessage({ executable: true })).toBe('');
    expect(intentBlockedMessage({ executable: false, reason: 'requires_clarification' })).toContain('information');
    expect(intentBlockedMessage({ executable: false, reason: 'not_meaningful' })).toContain('understand');
    expect(intentBlockedMessage({ executable: false, reason: 'missing_current_recipe' })).toContain('which recipe');
    expect(intentBlockedMessage({ executable: false, reason: 'insufficient_comparison_context' })).toContain('at least two');
    expect(intentBlockedMessage({ executable: false, reason: 'source_conflict' })).toContain('source');
    expect(RUNTIME_NOT_SUPPORTED_MESSAGE.length).toBeGreaterThan(10);
  });
});

describe('askMyKitchenUi: Step 3 hardening — explicit-web is NOT locally executable', () => {
  const expectOk = (p: ReturnType<typeof prepareKitchenIntentForExecution>) => {
    if (!p.ok) throw new Error('expected an ok preparation');
    return p;
  };

  const prep = (raw: Record<string, unknown>, trusted: unknown = {}) =>
    prepareKitchenIntentForExecution(sanitizeKitchenIntent(raw), trusted);

  it('A: find_recipes + source=web is execution-blocked (no local vault search)', () => {
    const p = expectOk(prep({ version: 1, intent: 'find_recipes', source: 'web', constraints: { includeIngredients: ['chicken'] } }));
    expect(p.readiness.executable).toBe(true);
    expect(p.sourcePolicy.initialSource).toBe('web');
    expect(canExecuteLocalRetrieval(p)).toBe(false);
  });

  it('B: meal_suggestion + source=web is blocked', () => {
    expect(canExecuteLocalRetrieval(prep({ version: 1, intent: 'meal_suggestion', source: 'web' }))).toBe(false);
  });

  it('C: ingredient_use + source=web is blocked', () => {
    expect(canExecuteLocalRetrieval(prep({ version: 1, intent: 'ingredient_use', source: 'web', constraints: { includeIngredients: ['chicken'] } }))).toBe(false);
  });

  it('D: browse_category + source=web is blocked', () => {
    expect(canExecuteLocalRetrieval(prep({ version: 1, intent: 'browse_category', source: 'web', constraints: { courses: ['Dessert'] } }))).toBe(false);
  });

  it('E: similar_recipe + source=web with trusted currentRecipeId is blocked', () => {
    const p = expectOk(
      prep(
        { version: 1, intent: 'similar_recipe', source: 'web', references: { currentRecipe: true } },
        { currentRecipeId: 'recipe-1' }
      )
    );
    expect(p.readiness.executable).toBe(true);
    expect(canExecuteLocalRetrieval(p)).toBe(false);
  });

  it('F: discover_online + source=web remains blocked in Step 3', () => {
    expect(canExecuteLocalRetrieval(prep({ version: 1, intent: 'discover_online', source: 'web' }))).toBe(false);
  });

  it('GATE: a vault-scoped supported intent IS executable', () => {
    const p = prep({ version: 1, intent: 'find_recipes', source: 'vault', constraints: { includeIngredients: ['rice'] } });
    expect(canExecuteLocalRetrieval(p)).toBe(true);
  });
});

describe('askMyKitchenUi: Step 3 hardening — meal_suggestion is bounded', () => {
  const meal = (opts: { constraints?: KitchenQuery; requestedResultCount?: number }): KitchenIntent => ({
    version: 1,
    intent: 'meal_suggestion',
    source: 'vault',
    constraints: opts.constraints ?? {},
    preferences: {},
    requiresClarification: false,
    ...(opts.requestedResultCount !== undefined ? { requestedResultCount: opts.requestedResultCount } : {}),
  });

  it('G: meal_suggestion + requestedResultCount=4 -> query.limit=4', () => {
    expect(intentToQuery(meal({ requestedResultCount: 4 }), {}).limit).toBe(4);
  });

  it('H: meal_suggestion with no requestedResultCount -> query.limit=6', () => {
    expect(intentToQuery(meal({}), {}).limit).toBe(6);
  });

  it('I: meal_suggestion + constraints.limit=3 + requestedResultCount=8 -> limit stays 3', () => {
    expect(intentToQuery(meal({ constraints: { limit: 3 }, requestedResultCount: 8 }), {}).limit).toBe(3);
  });

  it('J: meal_suggestion + constraints.limit=10 + requestedResultCount=4 -> limit becomes 4', () => {
    expect(intentToQuery(meal({ constraints: { limit: 10 }, requestedResultCount: 4 }), {}).limit).toBe(4);
  });

  it('K: meal_suggestion NEVER returns an unbounded query', () => {
    for (const o of [{}, { requestedResultCount: 1 }, { constraints: { limit: 5 } }]) {
      const limit = intentToQuery(meal(o), {}).limit;
      expect(typeof limit).toBe('number');
      expect((limit as number) >= 1).toBe(true);
    }
  });

  it('L: find_recipes behavior is unchanged (no limit injected)', () => {
    const intent: KitchenIntent = {
      version: 1,
      intent: 'find_recipes',
      source: 'vault',
      constraints: { includeIngredients: ['rice'] },
      preferences: {},
      requiresClarification: false,
    };
    expect(intentToQuery(intent, {}).limit).toBeUndefined();
  });
});
