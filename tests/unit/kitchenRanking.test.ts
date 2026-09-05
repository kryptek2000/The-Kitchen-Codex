import { describe, it, expect } from 'vitest';
import type { SearchableRecipe } from '../../src/utils/kitchenSearch';
import type { KitchenIntent } from '../../src/utils/kitchenIntent';
import type { ResolvedKitchenContext } from '../../src/utils/kitchenIntentPolicy';
import { buildRecipeRelationshipIndex } from '../../src/utils/recipeRelationships';
import {
  buildKitchenCandidates,
  deterministicRankKitchenCandidates,
  finalizeRankedCandidates,
  resolveRankedResultCount,
  sanitizeAiRankedCandidates,
  bindAiRankingToEvidence,
  buildGroundedKitchenAnswer,
  buildRankPrompt,
  rankKitchenCandidates,
  sanitizeCandidateEvidence,
  sanitizeCandidateEvidenceList,
  familyRelation,
  MAX_KITCHEN_CANDIDATES,
  MAX_RANKED_RESULTS,
  DEFAULT_RANKED_RESULTS,
  type KitchenCandidateEvidence,
  type RankedKitchenCandidate,
} from '../../src/utils/kitchenRanking';
import { isIntentRuntimeSupported } from '../../src/utils/askMyKitchenUi';

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

function mkIntent(o: Partial<KitchenIntent>): KitchenIntent {
  return {
    version: 1,
    intent: 'meal_suggestion',
    source: 'vault',
    constraints: {},
    preferences: {},
    requiresClarification: false,
    ...o,
  } as KitchenIntent;
}

const EMPTY_CTX: ResolvedKitchenContext = {};

describe('A: hard constraints determine candidate membership', () => {
  const recipes = [
    r({ id: 'a', title: 'Chicken', ingredients: [ing('chicken')], totalTime: '20 mins' }),
    r({ id: 'b', title: 'Beef', ingredients: [ing('beef')], totalTime: '20 mins' }),
    r({ id: 'c', title: 'Chicken Slow', ingredients: [ing('chicken')], totalTime: '90 mins' }),
  ];

  it('include ingredient + max total keeps ONLY the eligible recipe (AI cannot widen)', () => {
    const intent = mkIntent({ intent: 'find_recipes', constraints: { includeIngredients: ['chicken'], maxTotalMinutes: 30 } });
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    expect(candidates.map((c) => c.recipeId)).toEqual(['a']);
  });

  it('exclude ingredient is authoritative', () => {
    const intent = mkIntent({ intent: 'find_recipes', constraints: { excludeIngredients: ['chicken'] } });
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    expect(candidates.map((c) => c.recipeId)).toEqual(['b']);
  });
});

describe('B: soft preferences affect rank, not membership', () => {
  const recipes = [
    r({ id: 'a', title: 'Easy', difficulty: 'Easy', totalTime: '20 mins' }),
    r({ id: 'b', title: 'Medium', difficulty: 'Medium', totalTime: '40 mins' }),
  ];

  it('effort=low keeps both eligible but ranks Easy higher', () => {
    const intent = mkIntent({ intent: 'meal_suggestion', preferences: { effort: 'low' } });
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    expect(candidates.map((c) => c.recipeId)).toEqual(['a', 'b']);
    const ranked = deterministicRankKitchenCandidates(intent, candidates, EMPTY_CTX);
    expect(ranked.map((x) => x.recipeId)).toEqual(['a', 'b']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe('C: meal_suggestion bounded candidate set', () => {
  it('never exceeds MAX_KITCHEN_CANDIDATES before AI', () => {
    const recipes = Array.from({ length: 25 }, (_, i) => r({ id: `r${i}`, title: `R${i}` }));
    const intent = mkIntent({ intent: 'meal_suggestion' });
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    expect(candidates.length).toBeLessThanOrEqual(MAX_KITCHEN_CANDIDATES);
    expect(candidates.length).toBe(MAX_KITCHEN_CANDIDATES);
  });
});

describe('D: requestedResultCount respected', () => {
  const recipes = Array.from({ length: 10 }, (_, i) => r({ id: `r${i}`, title: `R${i}` }));

  it('uses the bounded requested count', () => {
    const intent = mkIntent({ intent: 'meal_suggestion', requestedResultCount: 3 });
    expect(resolveRankedResultCount(intent)).toBe(3);
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    const ranked = deterministicRankKitchenCandidates(intent, candidates, EMPTY_CTX);
    const final = finalizeRankedCandidates(ranked, resolveRankedResultCount(intent));
    expect(final.length).toBe(3);
  });

  it('clamps an oversized request to MAX_RANKED_RESULTS', () => {
    const intent = mkIntent({ intent: 'meal_suggestion', requestedResultCount: 20 });
    expect(resolveRankedResultCount(intent)).toBe(MAX_RANKED_RESULTS);
  });

  it('defaults to DEFAULT_RANKED_RESULTS when absent', () => {
    const intent = mkIntent({ intent: 'meal_suggestion' });
    expect(resolveRankedResultCount(intent)).toBe(DEFAULT_RANKED_RESULTS);
  });
});

describe('E: deterministic fallback is stable', () => {
  it('same input yields identical ordering and scores across runs', () => {
    const recipes = [
      r({ id: 'b', title: 'B', difficulty: 'Easy', totalTime: '25 mins' }),
      r({ id: 'a', title: 'A', difficulty: 'Medium', totalTime: '45 mins' }),
    ];
    const intent = mkIntent({ intent: 'meal_suggestion', preferences: { effort: 'low' } });
    const run = () => {
      const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
      return deterministicRankKitchenCandidates(intent, candidates, EMPTY_CTX);
    };
    const first = run();
    const second = run();
    expect(first.map((x) => [x.recipeId, x.score])).toEqual(second.map((x) => [x.recipeId, x.score]));
  });

  it('the whole orchestration (no AI) is deterministic', async () => {
    const recipes = [
      r({ id: 'a', title: 'A', ingredients: [ing('chicken')] }),
      r({ id: 'b', title: 'B', ingredients: [ing('beef')] }),
    ];
    const intent = mkIntent({ intent: 'find_recipes', constraints: { includeIngredients: ['chicken'] } });
    const run = async () => {
      const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
      const out = await rankKitchenCandidates(intent, candidates, EMPTY_CTX, {});
      return out.selected.map((x) => x.recipeId);
    };
    expect(await run()).toEqual(await run());
  });
});

describe('F/G/H: AI ranker only accepts supplied IDs, drops unknown, dedupes', () => {
  const allow = new Set(['a', 'b']);

  it('F: only supplied IDs survive', () => {
    const out = sanitizeAiRankedCandidates(
      { ranked: [{ recipeId: 'a', score: 0.9 }, { recipeId: 'c', score: 0.8 }] },
      allow
    );
    expect(out!.map((x) => x.recipeId)).toEqual(['a']);
  });

  it('G: unknown and evil IDs are dropped', () => {
    const out = sanitizeAiRankedCandidates(
      { ranked: [{ recipeId: 'evil-id' }, { recipeId: 'unknown' }, { recipeId: 'a' }] },
      allow
    );
    expect(out!.map((x) => x.recipeId)).toEqual(['a']);
  });

  it('H: duplicate IDs are deduped', () => {
    const out = sanitizeAiRankedCandidates(
      { ranked: [{ recipeId: 'a' }, { recipeId: 'b' }, { recipeId: 'a' }] },
      allow
    );
    expect(out!.map((x) => x.recipeId)).toEqual(['a', 'b']);
  });
});

describe('I: malformed AI ranking falls back', () => {
  const allow = new Set(['a']);

  it('returns undefined for structurally invalid output', () => {
    expect(sanitizeAiRankedCandidates(null, allow)).toBeUndefined();
    expect(sanitizeAiRankedCandidates('x', allow)).toBeUndefined();
    expect(sanitizeAiRankedCandidates({}, allow)).toBeUndefined();
    expect(sanitizeAiRankedCandidates({ ranked: 'x' }, allow)).toBeUndefined();
    expect(sanitizeAiRankedCandidates({ ranked: [{ recipeId: 'evil' }] }, allow)).toBeUndefined();
  });

  it('scores are clamped and reasons bounded', () => {
    const long = 'x'.repeat(2000);
    const out = sanitizeAiRankedCandidates(
      {
        ranked: [
          { recipeId: 'a', score: 5, reason: long },
          { recipeId: 'b', score: -1, reason: 'ok' },
          { recipeId: 'c', score: Number.NaN },
        ],
      },
      new Set(['a', 'b', 'c'])
    );
    expect(out!).toHaveLength(3);
    expect(out![0].score).toBe(1);
    expect(out![1].score).toBe(0);
    expect(out![2].score).toBe(0);
    expect(out![0].reasons[0].length).toBeLessThanOrEqual(220);
  });
});

describe('J: AI throws -> deterministic fallback', () => {
  const recipes = [r({ id: 'a', title: 'A' }), r({ id: 'b', title: 'B' })];
  const intent = mkIntent({ intent: 'meal_suggestion' });

  it('falls back to deterministic when the AI ranker throws', async () => {
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    const out = await rankKitchenCandidates(intent, candidates, EMPTY_CTX, {
      aiRank: async () => {
        throw new Error('boom');
      },
    });
    expect(out.source).toBe('deterministic');
    expect(out.selected.length).toBeGreaterThan(0);
  });

  it('falls back to deterministic when the AI ranker returns null', async () => {
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    const out = await rankKitchenCandidates(intent, candidates, EMPTY_CTX, {
      aiRank: async () => null,
    });
    expect(out.source).toBe('deterministic');
  });

  it('uses AI order when valid, still only over supplied ids', async () => {
    const intent2 = mkIntent({ intent: 'meal_suggestion' });
    const candidates = buildKitchenCandidates(intent2, recipes, EMPTY_CTX);
    const out = await rankKitchenCandidates(intent2, candidates, EMPTY_CTX, {
      aiRank: async () => [{ recipeId: 'b', score: 0.9, reasons: [] }, { recipeId: 'a', score: 0.1, reasons: [] }],
    });
    expect(out.source).toBe('ai');
    expect(out.selected.map((x) => x.recipeId)).toEqual(['b', 'a']);
  });
});

describe('K: ranking payload privacy / grounding', () => {
  it('buildRankPrompt never contains raw vault content', () => {
    const recipes = [
      r({
        id: 'chicken-rice',
        title: 'Chicken Rice',
        ingredients: [ing('chicken'), ing('rice')],
        totalTime: '25 mins',
        category: 'Dinner',
        difficulty: 'Easy',
      }),
    ];
    const intent = mkIntent({ intent: 'meal_suggestion', constraints: { includeIngredients: ['chicken'] } });
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    const prompt = buildRankPrompt({ question: 'What should I make tonight?', intent, candidates, resultCount: 6 });

    for (const forbidden of ['rawMarkdown', 'markdown', 'filePath', 'fileName', 'notes', 'frontmatter', 'instructions', 'image', 'data:image', 'img src']) {
      expect(prompt).not.toContain(forbidden);
    }
    // The prompt IS grounded in the compact evidence (ids + titles present).
    expect(prompt).toContain('chicken-rice');
    expect(prompt).toContain('Chicken Rice');
  });

  it('sanitizeCandidateEvidence drops unknown custom metadata', () => {
    const ev = sanitizeCandidateEvidence({
      recipeId: 'a',
      title: 'A',
      rawMarkdown: '# raw',
      notes: 'secret',
      frontmatter: { x: 1 },
      filePath: '/path/to/a.md',
      zebra: 'ignored',
    });
    expect(ev).toBeDefined();
    expect((ev as unknown as Record<string, unknown>)['rawMarkdown']).toBeUndefined();
    expect((ev as unknown as Record<string, unknown>)['notes']).toBeUndefined();
    expect((ev as unknown as Record<string, unknown>)['frontmatter']).toBeUndefined();
    expect((ev as unknown as Record<string, unknown>)['filePath']).toBeUndefined();
    expect((ev as unknown as Record<string, unknown>)['zebra']).toBeUndefined();
  });

  it('sanitizeCandidateEvidenceList caps and dedupes', () => {
    const raw = Array.from({ length: 25 }, (_, i) => ({ recipeId: `r${i % 5}`, title: `R${i}` }));
    const out = sanitizeCandidateEvidenceList(raw, { maxCandidates: 5 });
    expect(out.length).toBeLessThanOrEqual(5);
    expect(new Set(out.map((e) => e.recipeId)).size).toBe(out.length);
  });
});

describe('L: trusted current recipe never surfaces as a model-invented identity', () => {
  it('a candidate id that is not in the allowlist is dropped', () => {
    const allow = new Set(['a', 'b']);
    const out = sanitizeAiRankedCandidates({ ranked: [{ recipeId: 'current-recipe' }] }, allow);
    expect(out).toBeUndefined();
  });

  it('the prompt does not carry a trusted current recipe id', () => {
    const candidates: KitchenCandidateEvidence[] = [
      { recipeId: 'a', title: 'A' },
    ];
    const intent = mkIntent({ intent: 'meal_suggestion' });
    const prompt = buildRankPrompt({ question: 'similar to this', intent, candidates, resultCount: 6 });
    expect(prompt).not.toContain('current-recipe');
    expect(prompt).not.toContain('currentRecipeId');
  });
});

describe('M: similar_recipe keeps deterministic membership authority', () => {
  const recipes = [
    r({ id: 'focaccia', title: 'Focaccia', category: 'Bread', ingredients: [ing('flour'), ing('olive oil'), ing('salt')] }),
    r({ id: 'bread', title: 'Bread', category: 'Bread', ingredients: [ing('flour'), ing('yeast'), ing('salt')] }),
    r({ id: 'pizza', title: 'Pizza', category: 'Bread', ingredients: [ing('flour'), ing('yeast'), ing('cheese')] }),
    r({ id: 'soup', title: 'Soup', category: 'Soup', ingredients: [ing('stock'), ing('onion'), ing('carrot')] }),
  ];

  it('candidate set is the existing similarity authority (self excluded, unrelated excluded)', () => {
    const intent = mkIntent({ intent: 'similar_recipe', references: { currentRecipe: true } });
    const resolved: ResolvedKitchenContext = { currentRecipeId: 'focaccia' };
    const candidates = buildKitchenCandidates(intent, recipes, resolved);
    const ids = candidates.map((c) => c.recipeId);
    expect(ids).not.toContain('focaccia');
    expect(ids).toContain('bread');
    expect(ids).toContain('pizza');
    expect(ids).not.toContain('soup');
  });
});

describe('N: avoidRepetition / novelty affect score only where evidence exists', () => {
  const recipes = [
    r({ id: 'taco', title: 'Taco', tags: ['taco'] }),
    r({ id: 'taco-bowl', title: 'Taco Bowl', tags: ['taco'] }),
    r({ id: 'soup', title: 'Soup', tags: ['soup'] }),
  ];
  const index = buildRecipeRelationshipIndex(recipes);

  it('same family is penalized, different family is rewarded, when a current recipe exists', () => {
    const intent = mkIntent({ intent: 'meal_suggestion', preferences: { avoidRepetition: true } });
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX, { index });
    const resolved: ResolvedKitchenContext = { currentRecipeId: 'taco' };
    const ranked = deterministicRankKitchenCandidates(intent, candidates, resolved, { index });
    const tacoBowl = ranked.find((x) => x.recipeId === 'taco-bowl')!;
    const soup = ranked.find((x) => x.recipeId === 'soup')!;
    expect(tacoBowl.score).toBeLessThan(soup.score);
    expect(tacoBowl.reasons).not.toContain('Different recipe family from the current dish');
    expect(soup.reasons).toContain('Different recipe family from the current dish');
  });

  it('no current recipe -> no novelty signal (no fabricated reason)', () => {
    const intent = mkIntent({ intent: 'meal_suggestion', preferences: { avoidRepetition: true } });
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX, { index });
    const ranked = deterministicRankKitchenCandidates(intent, candidates, EMPTY_CTX, { index });
    for (const entry of ranked) {
      expect(entry.reasons).not.toContain('Different recipe family from the current dish');
    }
  });

  it('familyRelation is grounded: same / different / unknown', () => {
    expect(familyRelation(index, 'taco', 'taco-bowl')).toBe('same');
    expect(familyRelation(index, 'taco', 'soup')).toBe('different');
    expect(familyRelation(undefined, 'taco', 'soup')).toBe('unknown');
  });
});

describe('O: ranking reasons are grounded in evidence', () => {
  it('reasons only state facts supported by the evidence', () => {
    const recipes = [
      r({ id: 'a', title: 'Chicken', ingredients: [ing('chicken')], difficulty: 'Easy', totalTime: '25 mins', category: 'Dinner' }),
    ];
    const intent = mkIntent({
      intent: 'meal_suggestion',
      preferences: { effort: 'low', mealContext: ['dinner'] },
    });
    const candidates = buildKitchenCandidates(intent, recipes, EMPTY_CTX);
    const ranked = deterministicRankKitchenCandidates(intent, candidates, EMPTY_CTX);
    const reasons = ranked[0].reasons;
    expect(reasons).toContain('Easy difficulty');
    expect(reasons).toContain('Under 30 minutes');
    expect(reasons).toContain('Dinner recipe');
    for (const reason of reasons) {
      expect(reason.length).toBeGreaterThan(0);
      expect(reason.length).toBeLessThanOrEqual(220);
    }
  });
});

describe('P/Q/R: unsupported intents are runtime-blocked', () => {
  const unsupported = ['pairing', 'compare', 'discover_online'] as const;
  it('pairing / compare / discover_online are not runtime-supported', () => {
    for (const intentType of unsupported) {
      const intent = mkIntent({ intent: intentType as KitchenIntent['intent'] });
      expect(isIntentRuntimeSupported(intent)).toBe(false);
    }
    expect(isIntentRuntimeSupported(mkIntent({ intent: 'meal_suggestion' }))).toBe(true);
  });
});

describe('buildGroundedKitchenAnswer', () => {
  const candidates: KitchenCandidateEvidence[] = [
    { recipeId: 'a', title: 'Alpha', matchedConstraints: ['contains "chicken"', 'Easy difficulty'] },
    { recipeId: 'b', title: 'Beta', matchedConstraints: ['contains "rice"'] },
  ];
  const selected: RankedKitchenCandidate[] = [
    { recipeId: 'a', score: 0.9, reasons: ['contains "chicken"', 'Easy difficulty'] },
    { recipeId: 'b', score: 0.5, reasons: ['contains "rice"'] },
  ];

  it('builds a grounded answer from selected candidates + evidence', () => {
    const answer = buildGroundedKitchenAnswer(selected, candidates, { source: 'deterministic' });
    expect(answer.ok).toBe(true);
    expect(answer.noMatches).toBe(false);
    expect(answer.source).toBe('deterministic');
    expect(answer.items.map((i) => i.recipeIdentity)).toEqual(['a', 'b']);
    expect(answer.items[0].title).toBe('Alpha');
    expect(answer.items[0].explanation).toContain('chicken');
  });

  it('returns a no-match answer when nothing is selected', () => {
    const answer = buildGroundedKitchenAnswer([], candidates);
    expect(answer.ok).toBe(true);
    expect(answer.noMatches).toBe(true);
    expect(answer.items).toEqual([]);
  });
});

describe('bindAiRankingToEvidence', () => {
  it('binds deterministic grounded reasons onto the AI-supplied order', () => {
    const base: RankedKitchenCandidate[] = [
      { recipeId: 'a', score: 0.8, reasons: ['contains "chicken"'] },
      { recipeId: 'b', score: 0.2, reasons: ['contains "rice"'] },
    ];
    const ai: RankedKitchenCandidate[] = [
      { recipeId: 'b', score: 0.9, reasons: ['fabricated'] },
      { recipeId: 'a', score: 0.4, reasons: ['fabricated'] },
    ];
    const bound = bindAiRankingToEvidence(ai, base);
    expect(bound.map((x) => x.recipeId)).toEqual(['b', 'a']);
    expect(bound[0].reasons).toEqual(['contains "rice"']);
    expect(bound[1].reasons).toEqual(['contains "chicken"']);
  });
});
