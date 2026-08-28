import { describe, it, expect } from 'vitest';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import { obsidianToCanonicalRecipe, canonicalToObsidianRecipe, validateCanonicalRecipe } from '../../src/schema';

describe('Markdown to Canonical Schema Round-Trip Serialization', () => {
  const sampleMarkdown = `---
title: Authentic Thai Green Curry
tags:
  - thai
  - curry
  - dinner
  - spicy
cuisine: Thai
category: Main Dishes
servings: 4
prepTime: 20 mins
cookTime: 25 mins
totalTime: 45 mins
difficulty: Medium
rating: 5
source: https://example.com/green-curry
---

# Authentic Thai Green Curry

A fragrant, creamy coconut milk curry with tender chicken and bamboo shoots.

> [!tip] Fresh Herbs
> Add fresh Thai basil leaves right at the very end with heat turned off to preserve essential oils.

## Ingredients
- 500g [[Chicken Thighs]], sliced into bite-size pieces
- 2 tbsp [[Thai Green Curry Paste|Green Curry Paste]]
- 400ml [[Coconut Milk]]
- 1 cup [[Bamboo Shoots]]
- 2 tbsp [[Fish Sauce]]
- 1 tbsp Palm Sugar
- 1 cup Fresh Thai Sweet Basil leaves (optional)

## Instructions
1. Heat 3 tbsp of thick coconut cream in a wok over medium heat until oil separates.
2. Add the green curry paste and fry for 2 minutes until aromatic.
3. Add chicken slices and cook until no longer pink outside.
4. Pour in remaining coconut milk, fish sauce, and palm sugar. Simmer for 15 minutes.
5. Stir in bamboo shoots and simmer for 5 more minutes.
6. Turn off heat and fold in fresh Thai basil leaves.

## Notes
Serve immediately over steamed Jasmine Rice.
`;

  it('performs full round-trip from Raw Markdown -> Parsed -> Canonical -> Legacy -> Serialized Markdown', () => {
    // Step 1: Parse Markdown to ObsidianRecipe
    const parsedRecipe = parseObsidianRecipeMarkdown(sampleMarkdown, 'Green_Curry.md', 'Recipes/Thai/Green_Curry.md');
    expect(parsedRecipe).not.toBeNull();
    if (!parsedRecipe) return;

    expect(parsedRecipe.title).toBe('Authentic Thai Green Curry');
    expect(parsedRecipe.ingredients.length).toBe(7);
    expect(parsedRecipe.instructions.length).toBe(6);

    // Step 2: Convert to Canonical Schema v1
    const canonical = obsidianToCanonicalRecipe(parsedRecipe);
    expect(canonical.schemaVersion).toBe(1);
    expect(canonical.identity.title).toBe('Authentic Thai Green Curry');
    expect(canonical.timings.prepMinutes).toBe(20);
    expect(canonical.timings.cookMinutes).toBe(25);
    expect(canonical.timings.totalMinutes).toBe(45);
    expect(canonical.metadata.tags).toContain('thai');
    expect(canonical.metadata.tags).toContain('curry');

    // Validate schema
    const validation = validateCanonicalRecipe(canonical);
    expect(validation.isValid).toBe(true);

    // Step 3: Convert back to ObsidianRecipe
    const roundTripRecipe = canonicalToObsidianRecipe(canonical);
    expect(roundTripRecipe.title).toBe('Authentic Thai Green Curry');
    expect(roundTripRecipe.servings).toBe(4);
    expect(roundTripRecipe.prepTime).toBe('20 mins');
    expect(roundTripRecipe.cookTime).toBe('25 mins');

    // Step 4: Serialize back to Markdown
    const serialized = serializeRecipeToObsidianMarkdown(roundTripRecipe);
    expect(serialized).toContain('title: Authentic Thai Green Curry');
    expect(serialized).toContain('Chicken Thighs');
    expect(serialized).toContain('Green Curry Paste');
    expect(serialized).toContain('Serve immediately over steamed Jasmine Rice');

    // Step 5: Re-parse serialized markdown and verify data stability
    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Green_Curry.md', 'Recipes/Thai/Green_Curry.md');
    expect(reparsed).not.toBeNull();
    if (!reparsed) return;

    expect(reparsed.title).toBe(parsedRecipe.title);
    expect(reparsed.servings).toBe(parsedRecipe.servings);
    expect(reparsed.ingredients.length).toBe(parsedRecipe.ingredients.length);
    expect(reparsed.instructions.length).toBe(parsedRecipe.instructions.length);
  });
});
