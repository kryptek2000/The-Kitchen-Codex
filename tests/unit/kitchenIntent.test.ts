import { describe, it, expect } from 'vitest';
import {
  sanitizeKitchenIntent,
  isMeaningfulKitchenIntent,
  KITCHEN_INTENT_VERSION,
  MAX_REQUESTED_RESULT_COUNT,
  MAX_STRING_LIST_ITEMS,
  type KitchenIntent,
  type KitchenIntentType,
  type KitchenSource,
  type KitchenIntentPreferences,
  type TrustedKitchenContext,
} from '../../src/utils/kitchenIntent';

const VALID_INTENTS: KitchenIntentType[] = [
  'find_recipes',
  'meal_suggestion',
  'similar_recipe',
  'pairing',
  'compare',
  'ingredient_use',
  'discover_online',
  'browse_category',
];

const VALID_SOURCES: KitchenSource[] = ['vault', 'vault_then_web', 'web'];

function baseIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, intent: 'find_recipes', source: 'vault', ...overrides };
}

describe('kitchenIntent: minimal valid intent', () => {
  it('A: sanitizes a valid minimal KitchenIntent to a deterministic shape', () => {
    const result = sanitizeKitchenIntent({ version: 1, intent: 'meal_suggestion', source: 'vault' });
    expect(result).not.toBeNull();
    expect(result!.version).toBe(KITCHEN_INTENT_VERSION);
    expect(result!.intent).toBe('meal_suggestion');
    expect(result!.source).toBe('vault');
    expect(result!.constraints).toEqual({});
    expect(result!.preferences).toEqual({});
    expect(result!.requiresClarification).toBe(false);
    expect(result!.requestedResultCount).toBeUndefined();
    expect(result!.confidence).toBeUndefined();
    expect(result!.unresolvedTerms).toBeUndefined();
  });

  it('accepts a numeric-string version "1"', () => {
    expect(sanitizeKitchenIntent(baseIntent({ version: '1' }))).not.toBeNull();
  });

  it('rejects a bad/missing version', () => {
    expect(sanitizeKitchenIntent(baseIntent({ version: 2 }))).toBeNull();
    expect(sanitizeKitchenIntent(baseIntent({ version: '2' }))).toBeNull();
    expect(sanitizeKitchenIntent(baseIntent({ version: undefined }))).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(sanitizeKitchenIntent(null)).toBeNull();
    expect(sanitizeKitchenIntent('meal_suggestion')).toBeNull();
    expect(sanitizeKitchenIntent([1, 2])).toBeNull();
    expect(sanitizeKitchenIntent(42)).toBeNull();
  });
});

describe('kitchenIntent: enum validity', () => {
  it('B: accepts every allowed intent value', () => {
    for (const intent of VALID_INTENTS) {
      const r = sanitizeKitchenIntent({ version: 1, intent, source: 'vault' });
      expect(r).not.toBeNull();
      expect(r!.intent).toBe(intent);
    }
  });

  it('C: accepts every allowed source value', () => {
    for (const source of VALID_SOURCES) {
      const r = sanitizeKitchenIntent({ version: 1, intent: 'meal_suggestion', source });
      expect(r).not.toBeNull();
      expect(r!.source).toBe(source);
    }
  });

  it('D: rejects an unknown intent value', () => {
    expect(sanitizeKitchenIntent(baseIntent({ intent: 'teleport_recipes' }))).toBeNull();
  });

  it('E: rejects an unknown source value', () => {
    expect(sanitizeKitchenIntent(baseIntent({ source: 'supernet' }))).toBeNull();
    expect(sanitizeKitchenIntent(baseIntent({ source: 'VAULT' }))).toBeNull();
  });
});

describe('kitchenIntent: field stripping', () => {
  it('F: strips unknown top-level fields', () => {
    const r = sanitizeKitchenIntent(baseIntent({ zebra: 'x', nested: { a: 1 }, intent: 'meal_suggestion' }));
    expect(r).not.toBeNull();
    expect((r as unknown as Record<string, unknown>)['zebra']).toBeUndefined();
    expect((r as unknown as Record<string, unknown>)['nested']).toBeUndefined();
  });

  it('G: strips unknown preference fields', () => {
    const r = sanitizeKitchenIntent(
      baseIntent({ intent: 'meal_suggestion', preferences: { mood: ['happy'], fanciness: 'high', evil: {} } })
    );
    expect(r!.preferences.mood).toEqual(['happy']);
    expect((r!.preferences as unknown as Record<string, unknown>)['fanciness']).toBeUndefined();
    expect((r!.preferences as unknown as Record<string, unknown>)['evil']).toBeUndefined();
  });

  it('H: strips unknown reference fields and invalid values', () => {
    const r = sanitizeKitchenIntent(
      baseIntent({ intent: 'compare', references: { currentRecipe: true, comparisonTargets: 3, list: ['a'] } })
    );
    expect(r!.references).toEqual({ currentRecipe: true, comparisonTargets: 3 });
  });

  it('I: strips invented recipe identity fields at top level and inside constraints', () => {
    const r = sanitizeKitchenIntent(
      baseIntent({
        intent: 'similar_recipe',
        targetRecipeId: 't',
        comparisonRecipeIds: ['a', 'b'],
        recipeIds: ['a', 'b'],
        candidateIds: ['c'],
        trustedRecipeId: 'trusted',
        similarToRecipeId: 's',
        constraints: {
          similarToRecipeId: 's',
          includeIngredients: ['rice'],
          recipeIds: ['a', 'b'],
          recipes: [{ id: 'x' }],
        },
      })
    );
    // Top-level identity fields never survive.
    const top = r as unknown as Record<string, unknown>;
    for (const key of ['targetRecipeId', 'comparisonRecipeIds', 'recipeIds', 'candidateIds', 'trustedRecipeId', 'similarToRecipeId']) {
      expect(top[key]).toBeUndefined();
    }
    // Constraint-level identity authority is drained too.
    expect(r!.constraints.similarToRecipeId).toBeUndefined();
    expect((r!.constraints as unknown as Record<string, unknown>)['recipeIds']).toBeUndefined();
    expect((r!.constraints as unknown as Record<string, unknown>)['recipes']).toBeUndefined();
    expect(r!.constraints.includeIngredients).toEqual(['rice']);
  });

  it('P: the sanitized intent never exposes any trusted recipe identity', () => {
    const r = sanitizeKitchenIntent(baseIntent({ intent: 'similar_recipe', similarToRecipeId: 'hacked' }));
    expect(r!.constraints.similarToRecipeId).toBeUndefined();
    const keys = Object.keys(r as unknown as Record<string, unknown>);
    for (const key of keys) {
      expect(key).not.toMatch(/recipeIds?|candidateIds|trustedRecipeId/i);
    }
  });
});

describe('kitchenIntent: constraints sanitation', () => {
  it('J: malformed constraints sanitize to a safe empty query', () => {
    for (const junk of ['not an object', 42, null, undefined, { includeIngredients: 'nope', nested: { x: 1 }, recipes: [{ id: 'a' }] }]) {
      const r = sanitizeKitchenIntent(baseIntent({ constraints: junk }));
      expect(r).not.toBeNull();
      expect(r!.constraints).toBeDefined();
      expect((r!.constraints as unknown as Record<string, unknown>)['recipes']).toBeUndefined();
      expect((r!.constraints as unknown as Record<string, unknown>)['nested']).toBeUndefined();
    }
  });

  it('reuses the existing KitchenQuery sanitizer (valid filters pass through)', () => {
    const r = sanitizeKitchenIntent(
      baseIntent({ constraints: { includeIngredients: ['chicken', 'rice'], maxTotalMinutes: 30, favoritesOnly: true } })
    );
    expect(r!.constraints.includeIngredients).toEqual(['chicken', 'rice']);
    expect(r!.constraints.maxTotalMinutes).toBe(30);
    expect(r!.constraints.favoritesOnly).toBe(true);
  });
});

describe('kitchenIntent: requestedResultCount / confidence / unresolvedTerms bounds', () => {
  it('K: requestedResultCount clamps to [1, 20] and rejects non-integers', () => {
    expect(sanitizeKitchenIntent(baseIntent({ requestedResultCount: 8 }))!.requestedResultCount).toBe(8);
    expect(sanitizeKitchenIntent(baseIntent({ requestedResultCount: -3 }))!.requestedResultCount).toBe(1);
    expect(sanitizeKitchenIntent(baseIntent({ requestedResultCount: 0 }))!.requestedResultCount).toBe(1);
    expect(sanitizeKitchenIntent(baseIntent({ requestedResultCount: 1000 }))!.requestedResultCount).toBe(MAX_REQUESTED_RESULT_COUNT);
    expect(sanitizeKitchenIntent(baseIntent({ requestedResultCount: 2.5 }))!.requestedResultCount).toBeUndefined();
  });

  it('L: confidence clamps to [0, 1] and rejects NaN / non-numbers', () => {
    expect(sanitizeKitchenIntent(baseIntent({ confidence: 0.5 }))!.confidence).toBe(0.5);
    expect(sanitizeKitchenIntent(baseIntent({ confidence: -0.5 }))!.confidence).toBe(0);
    expect(sanitizeKitchenIntent(baseIntent({ confidence: 2 }))!.confidence).toBe(1);
    expect(sanitizeKitchenIntent(baseIntent({ confidence: Number.NaN }))!.confidence).toBeUndefined();
    expect(sanitizeKitchenIntent(baseIntent({ confidence: 'high' }))!.confidence).toBeUndefined();
  });

  it('M: unresolvedTerms trims, drops empties, caps, and rejects non-strings', () => {
    const many = Array.from({ length: 50 }, (_, i) => `term-${i}`);
    const r = sanitizeKitchenIntent(baseIntent({ unresolvedTerms: [' a ', 'a', '', 42, 'b', ...many] }))!;
    expect(r.unresolvedTerms).toEqual(['a', 'b', ...many.slice(0, MAX_STRING_LIST_ITEMS - 2)]);
    expect(r.unresolvedTerms!.length).toBeLessThanOrEqual(MAX_STRING_LIST_ITEMS);
  });

  it('N: preference string arrays trim, dedupe (case-insensitive), and cap', () => {
    const preferences: KitchenIntentPreferences = { mood: [' Comfort ', 'comfort', 'easy', '', '  '] };
    const r = sanitizeKitchenIntent(baseIntent({ preferences }))!;
    // Case-insensitive dedupe preserves the FIRST occurrence's casing, exactly
    // like the existing KitchenQuery string-list handling.
    expect(r.preferences.mood).toEqual(['Comfort', 'easy']);
  });
});

describe('kitchenIntent: meaningfulness', () => {
  const sanitize = (o: Record<string, unknown>) => sanitizeKitchenIntent(o) as unknown as KitchenIntent;

  it('Q1: meal_suggestion with a valid source is meaningful', () => {
    expect(isMeaningfulKitchenIntent(sanitize({ version: 1, intent: 'meal_suggestion', source: 'vault' }))).toBe(true);
  });

  it('Q2: discover_online with a valid source is meaningful', () => {
    expect(isMeaningfulKitchenIntent(sanitize({ version: 1, intent: 'discover_online', source: 'web' }))).toBe(true);
  });

  it('Q3: find_recipes with a real constraint is meaningful', () => {
    const r = sanitize({ version: 1, intent: 'find_recipes', source: 'vault', constraints: { includeIngredients: ['rice'] } });
    expect(isMeaningfulKitchenIntent(r)).toBe(true);
  });

  it('Q4: pairing with a semantic currentRecipe reference is meaningful', () => {
    const r = sanitize({ version: 1, intent: 'pairing', source: 'vault', references: { currentRecipe: true } });
    expect(isMeaningfulKitchenIntent(r)).toBe(true);
  });

  it('Q5: compare with a valid comparison target count is meaningful', () => {
    const r = sanitize({ version: 1, intent: 'compare', source: 'vault', references: { comparisonTargets: 3 } });
    expect(isMeaningfulKitchenIntent(r)).toBe(true);
  });

  it('Q6: an empty/malformed intent is NOT meaningful', () => {
    expect(sanitizeKitchenIntent({})).toBeNull();
    const empty = sanitize({ version: 1, intent: 'find_recipes', source: 'vault' });
    expect(isMeaningfulKitchenIntent(empty)).toBe(false);
    // compare with zero usable context
    const compareEmpty = sanitize({ version: 1, intent: 'compare', source: 'vault', references: { comparisonTargets: 1 } });
    expect(isMeaningfulKitchenIntent(compareEmpty)).toBe(false);
    // similar_recipe with no semantic reference
    const similar = sanitize({ version: 1, intent: 'similar_recipe', source: 'vault' });
    expect(isMeaningfulKitchenIntent(similar)).toBe(false);
  });
});

describe('kitchenIntent: safety / purity', () => {
  it('R: source values cause no side effects (enum-only, no escalation here)', () => {
    for (const source of VALID_SOURCES) {
      const r = sanitizeKitchenIntent({ version: 1, intent: 'discover_online', source });
      expect(r!.source).toBe(source);
    }
  });

  it('S: does not mutate the raw input', () => {
    const raw = Object.freeze({
      version: 1,
      intent: 'meal_suggestion',
      source: 'vault',
      constraints: Object.freeze({ includeIngredients: Object.freeze(['rice']) }),
    });
    const before = JSON.stringify(raw);
    sanitizeKitchenIntent(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe('kitchenIntent: trusted context is a SEPARATE type only', () => {
  it('O: TrustedKitchenContext is a distinct type and not part of KitchenIntent', () => {
    // Type-only contract: verify it carries only identity-bearing fields.
    const ctx: TrustedKitchenContext = { currentRecipeId: 'a', selectedRecipeIds: ['b', 'c'] };
    expect(ctx.currentRecipeId).toBe('a');
    expect(ctx.selectedRecipeIds).toEqual(['b', 'c']);

    // A sanitized KitchenIntent never has these fields.
    const r = sanitizeKitchenIntent(baseIntent({ intent: 'similar_recipe', currentRecipeId: 'a', selectedRecipeIds: ['b'] }));
    expect((r as unknown as Record<string, unknown>)['currentRecipeId']).toBeUndefined();
    expect((r as unknown as Record<string, unknown>)['selectedRecipeIds']).toBeUndefined();
  });
});
