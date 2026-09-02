import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { load as yamlLoad } from 'js-yaml';
import {
  parseObsidianRecipeMarkdown,
  serializeRecipeToObsidianMarkdown,
} from '../../src/utils/markdownParser';
import { obsidianToCanonicalRecipe, canonicalToObsidianRecipe } from '../../src/schema';
import {
  estimateRecipeNutrition,
  estimateAlgorithmicNutrition,
} from '../../server/nutritionEstimator';
import { getGemini } from '../../server/geminiClient';
import { deriveNutritionProvenance } from '../../src/components/RecipeEditorModal';

// Deterministically control whether the estimator takes the Gemini or offline
// path without any live network call. Default returns null => offline.
vi.mock('../../server/geminiClient.js', () => ({ getGemini: vi.fn() }));
const mockGetGemini = getGemini as unknown as ReturnType<typeof vi.fn>;

const DB_MD = `---
title: Provenance Test
servings: 4
nutrition:
  calories: 500
  protein: 30
  carbohydrates: 40
  fat: 20
  fiber: 5
  sodium: 800
  servings: 4
  source: database
  confidence: high
  confidenceNote: From the deterministic database.
---

# Provenance Test

## Ingredients
- 2 cups flour
`;

const LEGACY_MD = `---
title: Legacy Recipe
servings: 4
nutrition:
  calories: 500
  protein: 30
  carbohydrates: 40
  fat: 20
  fiber: 5
  sodium: 800
  servings: 4
---

# Legacy Recipe

## Ingredients
- 2 cups flour
`;

function frontmatterNutrition(markdown: string): Record<string, any> {
  const fm = yamlLoad(markdown.split('---')[1]) as Record<string, any>;
  return fm?.nutrition ?? {};
}

describe('A) Full Markdown provenance round trip', () => {
  it('preserves source, confidence, confidenceNote, servings and all numbers', () => {
    const parsed = parseObsidianRecipeMarkdown(DB_MD, 'Provenance.md', 'Provenance.md');
    expect(parsed.nutrition?.source).toBe('database');
    expect(parsed.nutrition?.confidence).toBe('high');
    expect(parsed.nutrition?.confidenceNote).toBe('From the deterministic database.');
    expect(parsed.nutrition?.servings).toBe(4);
    expect(parsed.nutrition?.calories).toBe(500);
    expect(parsed.nutrition?.protein).toBe(30);

    const canonical = obsidianToCanonicalRecipe(parsed);
    expect(canonical.nutrition?.source).toBe('database');
    expect(canonical.nutrition?.confidence).toBe('high');

    const backToLegacy = canonicalToObsidianRecipe(canonical);
    expect(backToLegacy.nutrition?.source).toBe('database');
    expect(backToLegacy.nutrition?.confidence).toBe('high');

    const serialized = serializeRecipeToObsidianMarkdown(backToLegacy);
    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Provenance.md', 'Provenance.md');
    expect(reparsed.nutrition?.source).toBe('database');
    expect(reparsed.nutrition?.confidence).toBe('high');
    expect(reparsed.nutrition?.confidenceNote).toBe('From the deterministic database.');
    expect(reparsed.nutrition?.servings).toBe(4);
    expect(reparsed.nutrition?.calories).toBe(500);
    expect(reparsed.nutrition?.protein).toBe(30);
    expect(reparsed.nutrition?.carbohydrates).toBe(40);
    expect(reparsed.nutrition?.fat).toBe(20);
    expect(reparsed.nutrition?.fiber).toBe(5);
    expect(reparsed.nutrition?.sodium).toBe(800);
  });
});

describe('B) Legacy compatibility (no fabricated provenance)', () => {
  it('keeps source/confidence undefined and omits them on serialize', () => {
    const parsed = parseObsidianRecipeMarkdown(LEGACY_MD, 'Legacy.md', 'Legacy.md');
    expect(parsed.nutrition?.source).toBeUndefined();
    expect(parsed.nutrition?.confidence).toBeUndefined();

    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    const nut = frontmatterNutrition(serialized);
    expect(nut.source).toBeUndefined();
    expect(nut.confidence).toBeUndefined();
    expect(nut.calories).toBe(500);
    expect(nut.servings).toBe(4);

    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Legacy.md', 'Legacy.md');
    expect(reparsed.nutrition?.source).toBeUndefined();
    expect(reparsed.nutrition?.confidence).toBeUndefined();
    expect(reparsed.nutrition?.calories).toBe(500);
  });
});

describe('C) Adapter fidelity (both directions)', () => {
  it('carries source/confidence through the legacy <-> canonical boundary', () => {
    const parsed = parseObsidianRecipeMarkdown(DB_MD, 'x.md', 'x.md');
    const canonical = obsidianToCanonicalRecipe(parsed);
    expect(canonical.nutrition?.source).toBe('database');
    expect(canonical.nutrition?.confidence).toBe('high');

    const legacy = canonicalToObsidianRecipe(canonical);
    expect(legacy.nutrition?.source).toBe('database');
    expect(legacy.nutrition?.confidence).toBe('high');
    expect(legacy.nutrition?.servings).toBe(4);
    expect(legacy.nutrition?.protein).toBe(30);
  });
});

describe('D) Gemini path provenance', () => {
  beforeEach(() => {
    const fakeGemini = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            calories: 100,
            protein: 5,
            carbohydrates: 10,
            fat: 3,
            fiber: 1,
            sodium: 100,
            confidenceNote: 'from model',
          }),
        }),
      },
    };
    mockGetGemini.mockReturnValue(fakeGemini);
  });

  afterEach(() => {
    mockGetGemini.mockReturnValue(null);
  });

  it('tags a Gemini-derived result ai_estimate / medium by application logic', async () => {
    const result = await estimateRecipeNutrition({
      title: 'Test',
      servings: 4,
      ingredients: ['2 cups flour'],
    });
    expect(result.source).toBe('ai_estimate');
    expect(result.confidence).toBe('medium');
    expect(result.calories).toBe(100);
  });
});

describe('E) Offline heuristic provenance', () => {
  beforeEach(() => {
    mockGetGemini.mockReturnValue(null);
  });

  it('tags offline_heuristic / low and leaves the nutrition math unchanged', async () => {
    const ingredients = ['400g spaghetti pasta', '200g guanciale', '4 egg yolks', '100g Pecorino'];
    const result = await estimateRecipeNutrition({ title: 'Carbonara', servings: 4, ingredients });
    const algorithm = estimateAlgorithmicNutrition('Carbonara', 4, ingredients);

    expect(result.source).toBe('offline_heuristic');
    expect(result.confidence).toBe('low');
    // The entry point delegates to the identical algorithm (no "improvement").
    expect(result).toEqual(algorithm);
    expect(result.calories).toBeGreaterThan(0);
  });

  it('is invariant to requested serving count and matches the algorithm total', async () => {
    const ingredients = ['2 cups flour', '1 cup sugar'];
    const one = await estimateRecipeNutrition({ title: 'X', servings: 1, ingredients });
    const eight = await estimateRecipeNutrition({ title: 'X', servings: 8, ingredients });
    const algorithm = estimateAlgorithmicNutrition('X', 4, ingredients);
    expect(one).toEqual(algorithm);
    expect(eight).toEqual(algorithm);
  });
});

describe('F) Manual edit provenance', () => {
  it('marks a manual nutrition edit as user_defined / medium', () => {
    const result = deriveNutritionProvenance(true, {
      source: 'database',
      confidence: 'high',
      confidenceNote: 'From database.',
    });
    expect(result.source).toBe('user_defined');
    expect(result.confidence).toBe('medium');
    expect(result.confidenceNote).toBeUndefined();
  });

  it('persists a user_defined block through Markdown', () => {
    const serialized = serializeRecipeToObsidianMarkdown({
      title: 'Edited',
      servings: 4,
      nutrition: {
        calories: 700,
        protein: 40,
        source: 'user_defined',
        confidence: 'medium',
        servings: 4,
      },
    });
    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Edited.md', 'Edited.md');
    expect(reparsed.nutrition?.source).toBe('user_defined');
    expect(reparsed.nutrition?.confidence).toBe('medium');
    expect(reparsed.nutrition?.calories).toBe(700);
  });
});

describe('G) Unrelated edit preserves provenance', () => {
  it('never relabels existing provenance when nutrition itself is untouched', () => {
    const preserved = deriveNutritionProvenance(false, {
      source: 'ai_estimate',
      confidence: 'medium',
      confidenceNote: 'estimated',
    });
    expect(preserved.source).toBe('ai_estimate');
    expect(preserved.confidence).toBe('medium');
    expect(preserved.confidenceNote).toBe('estimated');
  });

  it('leaves legacy (absent) provenance absent on a non-dirty save', () => {
    const preserved = deriveNutritionProvenance(false, undefined);
    expect(preserved.source).toBeUndefined();
    expect(preserved.confidence).toBeUndefined();
    expect(preserved.confidenceNote).toBeUndefined();
  });
});

describe('H) Unknown confidence round trip', () => {
  it('parses, serializes and round-trips confidence: unknown', () => {
    const md = `---
title: UnknownConf
servings: 4
nutrition:
  calories: 500
  servings: 4
  source: ai_estimate
  confidence: unknown
---

# UnknownConf

## Ingredients
- 1 egg
`;
    const parsed = parseObsidianRecipeMarkdown(md, 'U.md', 'U.md');
    expect(parsed.nutrition?.source).toBe('ai_estimate');
    expect(parsed.nutrition?.confidence).toBe('unknown');

    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    const nut = frontmatterNutrition(serialized);
    expect(nut.source).toBe('ai_estimate');
    expect(nut.confidence).toBe('unknown');

    const reparsed = parseObsidianRecipeMarkdown(serialized, 'U.md', 'U.md');
    expect(reparsed.nutrition?.confidence).toBe('unknown');
  });

  it('does not inject invalid provenance values', () => {
    const md = `---
title: BadProvenance
nutrition:
  calories: 500
  source: bogus
  confidence: extreme
---

# BadProvenance

## Ingredients
- 1 egg
`;
    const parsed = parseObsidianRecipeMarkdown(md, 'B.md', 'B.md');
    expect(parsed.nutrition?.source).toBeUndefined();
    expect(parsed.nutrition?.confidence).toBeUndefined();
  });
});
