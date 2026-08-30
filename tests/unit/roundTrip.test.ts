import { describe, it, expect } from 'vitest';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown, renderIngredientLine } from '../../src/utils/markdownParser';
import { obsidianToCanonicalRecipe, canonicalToObsidianRecipe, validateCanonicalRecipe } from '../../src/schema';

describe('Markdown to Canonical Schema Round-Trip Serialization & Integrity Tests', () => {
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
author: Chef Somchai
customField: preserved-value
---

# Authentic Thai Green Curry

A fragrant, creamy coconut milk curry with tender chicken and bamboo shoots.

originRegion:: Central Thailand
spiceRating:: 4/5

> [!tip] Fresh Herbs
> Add fresh Thai basil leaves right at the very end with heat turned off to preserve essential oils.

## Ingredients
- [x] 500g [[Chicken Thighs]], sliced into bite-size pieces
- [ ] 2 tbsp [[Thai Green Curry Paste|Green Curry Paste]]
- [ ] 400ml [[Coconut Milk]]
- [ ] 1 cup [[Bamboo Shoots]]
- [x] 2 tbsp [[Fish Sauce]]
- [ ] 1 tbsp Palm Sugar
- [ ] 1 cup Fresh Thai Sweet Basil leaves (optional)

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

    // Verify Custom Frontmatter Preservation
    expect(serialized).toContain('author: Chef Somchai');
    expect(serialized).toContain('customField: preserved-value');

    // Verify Dataview Inline Fields Preservation
    expect(serialized).toContain('originRegion:: Central Thailand');
    expect(serialized).toContain('spiceRating:: 4/5');

    // Verify Exact Wikilink Preservation & Checklist State Preservation
    expect(serialized).toContain('- [x] 500g [[Chicken Thighs]]');
    expect(serialized).toContain('- [ ] 2 tbsp [[Thai Green Curry Paste|Green Curry Paste]]');
    expect(serialized).toContain('- [ ] 400ml [[Coconut Milk]]');
    expect(serialized).toContain('- [x] 2 tbsp [[Fish Sauce]]');

    // Verify Plain Ingredient Non-Generation of Wikilinks
    expect(serialized).toContain('- [ ] 1 tbsp Palm Sugar');
    expect(serialized).not.toContain('[[Palm Sugar]]');
    expect(serialized).not.toContain('[[Fresh Thai Sweet Basil leaves]]');

    // Step 5: Re-parse serialized markdown and verify data stability
    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Green_Curry.md', 'Recipes/Thai/Green_Curry.md');
    expect(reparsed).not.toBeNull();
    if (!reparsed) return;

    expect(reparsed.title).toBe(parsedRecipe.title);
    expect(reparsed.servings).toBe(parsedRecipe.servings);
    expect(reparsed.ingredients.length).toBe(parsedRecipe.ingredients.length);
    expect(reparsed.instructions.length).toBe(parsedRecipe.instructions.length);

    // Re-verify Dataview & Custom Frontmatter on reparsed note
    expect(reparsed.dataviewFields['originRegion']).toBe('Central Thailand');
    expect(reparsed.dataviewFields['spiceRating']).toBe('4/5');
    expect(reparsed.frontmatter?.author).toBe('Chef Somchai');
    expect(reparsed.frontmatter?.customField).toBe('preserved-value');

    // Re-verify checklist state on reparsed ingredients
    expect(reparsed.ingredients[0].isChecked).toBe(true);
    expect(reparsed.ingredients[0].wikilinkTarget).toBe('Chicken Thighs');
    expect(reparsed.ingredients[1].isChecked).toBe(false);
    expect(reparsed.ingredients[1].wikilinkTarget).toBe('Thai Green Curry Paste');
    expect(reparsed.ingredients[1].wikilinkAlias).toBe('Green Curry Paste');
  });

  it('preserves top-level legacy calories into canonical nutrition block and back', () => {
    const markdownWithCalories = `---
title: Quick Oatmeal
calories: 320
---

# Quick Oatmeal

## Ingredients
- [ ] 1 cup Rolled Oats
- [ ] 2 cups Water
`;

    const parsed = parseObsidianRecipeMarkdown(markdownWithCalories, 'Oatmeal.md');
    expect(parsed.calories).toBe(320);

    const canonical = obsidianToCanonicalRecipe(parsed);
    expect(canonical.nutrition).toBeDefined();
    expect(canonical.nutrition?.calories).toBe(320);

    const backToLegacy = canonicalToObsidianRecipe(canonical);
    expect(backToLegacy.calories).toBe(320);

    const serialized = serializeRecipeToObsidianMarkdown(backToLegacy);
    expect(serialized).toContain('calories: 320');
  });

  it('does NOT fabricate metadata (images, created dates, total_time) on notes lacking them', () => {
    const minimalMarkdown = `---
title: Simple Salted Eggs
tags:
  - breakfast
---

# Simple Salted Eggs

## Ingredients
- [ ] 2 Eggs
- [ ] 1 pinch Salt

## Instructions
1. Boil eggs for 7 minutes.
`;

    const parsed = parseObsidianRecipeMarkdown(minimalMarkdown, 'Eggs.md');
    // Ensure image is undefined and not populated with Unsplash URL in persisted data
    expect(parsed.image).toBeUndefined();

    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    // Serialized frontmatter must NOT contain fabricated image URL or created date
    expect(serialized).not.toContain('image: https://images.unsplash.com');
    expect(serialized).not.toContain('image:');
    expect(serialized).not.toContain('created:');
    expect(serialized).not.toContain('total_time:');
  });

  it('resolves Dataview standard fields case-insensitively while preserving original key casing during serialization', () => {
    const markdownWithMixedCasing = `---
title: Classic Carbonara
tags:
  - pasta
  - italian
---

# Classic Carbonara

Cuisine:: Italian
Category:: Pasta & Mains
DIFFICULTY:: Medium
RATING:: 5
IMAGE:: https://images.unsplash.com/photo-carbonara
customChef:: Mario

## Ingredients
- [ ] 400g [[Spaghetti]]
- [ ] 150g [[Guanciale]]

## Instructions
1. Crisp the guanciale and mix with eggs and pecorino.
`;

    // Parse (Load path)
    const parsed = parseObsidianRecipeMarkdown(markdownWithMixedCasing, 'Carbonara.md');
    
    // Check standard fields are resolved case-insensitively
    expect(parsed.cuisine).toBe('Italian');
    expect(parsed.category).toBe('Pasta & Mains');
    expect(parsed.difficulty).toBe('Medium');
    expect(parsed.rating).toBe(5);
    expect(parsed.image).toBe('https://images.unsplash.com/photo-carbonara');

    // Serialize (Save path)
    const serialized = serializeRecipeToObsidianMarkdown(parsed);

    // Verify original Dataview key casing is preserved intact in serialized markdown
    expect(serialized).toContain('Cuisine:: Italian');
    expect(serialized).toContain('Category:: Pasta & Mains');
    expect(serialized).toContain('DIFFICULTY:: Medium');
    expect(serialized).toContain('RATING:: 5');
    expect(serialized).toContain('IMAGE:: https://images.unsplash.com/photo-carbonara');
    expect(serialized).toContain('customChef:: Mario');
  });

  it('exercises full production-boundary load and save cycle through CanonicalRecipe Schema', () => {
    const rawNote = `---
title: Roman Cacio e Pepe
tags:
  - italian
  - quick
prepTime: 5 mins
cookTime: 10 mins
totalTime: 15 mins
author: Nonna Maria
date: 2026-01-15
---

# Roman Cacio e Pepe

Region:: Lazio

## Ingredients
- [ ] 200g [[Pecorino Romano]]
- [x] 1 tbsp [[Black Pepper|Cracked Black Peppercorns]]
- [ ] 300g Tonnarelli

## Instructions
1. Toast pepper, cook pasta, emulsify with starchy pasta water and cheese.
`;

    // Production Load Path: Markdown -> parseObsidianRecipeMarkdown (which normalizes via CanonicalRecipe)
    const loadedRecipe = parseObsidianRecipeMarkdown(rawNote, 'Cacio_e_Pepe.md');
    
    // Check Canonical Invariants on loaded model
    expect(loadedRecipe.title).toBe('Roman Cacio e Pepe');
    expect(loadedRecipe.prepTime).toBe('5 mins');
    expect(loadedRecipe.cookTime).toBe('10 mins');
    expect(loadedRecipe.totalTime).toBe('15 mins');
    expect(loadedRecipe.ingredients.length).toBe(3);
    expect(loadedRecipe.ingredients[1].wikilinkTarget).toBe('Black Pepper');
    expect(loadedRecipe.ingredients[1].wikilinkAlias).toBe('Cracked Black Peppercorns');
    expect(loadedRecipe.ingredients[1].isChecked).toBe(true);

    // Production Save Path: ObsidianRecipe -> serializeRecipeToObsidianMarkdown (which normalizes via CanonicalRecipe)
    const savedMarkdown = serializeRecipeToObsidianMarkdown(loadedRecipe);

    // Re-parse saved markdown to verify round-trip stability
    const reloadedRecipe = parseObsidianRecipeMarkdown(savedMarkdown, 'Cacio_e_Pepe.md');
    expect(reloadedRecipe.title).toBe('Roman Cacio e Pepe');
    expect(reloadedRecipe.cuisine).toBe(loadedRecipe.cuisine);
    expect(reloadedRecipe.ingredients[1].original).toBe(loadedRecipe.ingredients[1].original);
    expect(reloadedRecipe.ingredients[1].isChecked).toBe(true);
    expect(savedMarkdown).toContain('Region:: Lazio');
    expect(savedMarkdown).toContain('author: Nonna Maria');
    expect(savedMarkdown).toMatch(/date:\s*['"]?2026-01-15['"]?/);
    expect(savedMarkdown).toContain('total_time: 15 mins');
  });

  it('preserves body-derived timing values across full production parse -> canonical -> serialize -> reload cycle', () => {
    const bodyTimingNote = `# Chili

Prep: 15 mins
Cook: 45 mins

## Ingredients
- [ ] 500g Ground Beef
- [ ] 1 can Kidney Beans

## Instructions
1. Brown the beef and simmer with beans and spices.
`;

    // 1. Initial Parse: Markdown -> ObsidianRecipe (via CanonicalRecipe production boundary)
    const initialParsed = parseObsidianRecipeMarkdown(bodyTimingNote, 'Chili.md');

    expect(initialParsed.prepTime).toBe('15 mins');
    expect(initialParsed.cookTime).toBe('45 mins');
    expect(initialParsed.totalTime).toBe('1 hr'); // normalized 15m + 45m = 60m = 1 hr

    // 2. Production Save: ObsidianRecipe -> Serialized Obsidian Markdown
    const savedMarkdown = serializeRecipeToObsidianMarkdown(initialParsed);

    // Verify timings are persisted into frontmatter and not discarded
    expect(savedMarkdown).toContain('prep_time: 15 mins');
    expect(savedMarkdown).toContain('cook_time: 45 mins');
    expect(savedMarkdown).toContain('total_time: 1 hr');

    // 3. Reload: Saved Markdown -> ObsidianRecipe (via CanonicalRecipe production boundary)
    const reloaded = parseObsidianRecipeMarkdown(savedMarkdown, 'Chili.md');

    expect(reloaded.prepTime).toBe('15 mins');
    expect(reloaded.cookTime).toBe('45 mins');
    expect(reloaded.totalTime).toBe('1 hr');
    expect(reloaded.title).toBe('Chili');
    expect(reloaded.ingredients.length).toBe(2);

    // Verify no unrelated metadata (e.g. image, calories) was fabricated
    expect(reloaded.image).toBeUndefined();
    expect(reloaded.calories).toBeUndefined();
    expect(savedMarkdown).not.toContain('image:');
    expect(savedMarkdown).not.toContain('calories:');
  });

  it('normalizes frontmatter timing aliases into canonical keys without creating duplicate YAML fields', () => {
    const noteWithAliasTimings = `---
title: Quick Oatmeal
prepTime: 2 mins
cook-time: 5 mins
total: 7 mins
---

# Quick Oatmeal

## Ingredients
- [ ] 1 cup Rolled Oats
- [ ] 2 cups Water

## Instructions
1. Microwave on high for 2 minutes.
`;

    const parsed = parseObsidianRecipeMarkdown(noteWithAliasTimings, 'Oatmeal.md');
    expect(parsed.prepTime).toBe('2 mins');
    expect(parsed.cookTime).toBe('5 mins');
    expect(parsed.totalTime).toBe('7 mins');

    const serialized = serializeRecipeToObsidianMarkdown(parsed);

    // Should contain canonical keys
    expect(serialized).toContain('prep_time: 2 mins');
    expect(serialized).toContain('cook_time: 5 mins');
    expect(serialized).toContain('total_time: 7 mins');

    // Should NOT contain duplicate alias keys in frontmatter
    expect(serialized).not.toContain('prepTime:');
    expect(serialized).not.toContain('cook-time:');
    expect(serialized).not.toContain('total: 7 mins');
  });

  it('F1 — Preserves freeform body prose across full parse -> canonical -> serialize -> reload cycle without duplication', () => {
    const noteWithProse = `# Chili

This is a lovely intro paragraph explaining the recipe.

This second paragraph contains additional user-authored notes.

## Ingredients

- 1 lb ground beef

## Instructions

1. Brown the beef.
`;

    // 1. Initial Parse (Production load boundary)
    const parsed1 = parseObsidianRecipeMarkdown(noteWithProse, 'Chili.md');
    expect(parsed1.title).toBe('Chili');
    expect(parsed1.description).toContain('This is a lovely intro paragraph explaining the recipe.');
    expect(parsed1.description).toContain('This second paragraph contains additional user-authored notes.');

    // 2. Initial Save (Production save boundary)
    const saved1 = serializeRecipeToObsidianMarkdown(parsed1);
    expect(saved1).toContain('This is a lovely intro paragraph explaining the recipe.');
    expect(saved1).toContain('This second paragraph contains additional user-authored notes.');

    // 3. First Reload (Production load boundary)
    const parsed2 = parseObsidianRecipeMarkdown(saved1, 'Chili.md');
    expect(parsed2.description).toContain('This is a lovely intro paragraph explaining the recipe.');
    expect(parsed2.description).toContain('This second paragraph contains additional user-authored notes.');

    // 4. Second Save (Test repeated save/serialize does not duplicate prose)
    const saved2 = serializeRecipeToObsidianMarkdown(parsed2);
    
    // Ensure exact occurrence count is 1 (no duplication)
    const matchesPara1 = saved2.match(/This is a lovely intro paragraph explaining the recipe\./g);
    const matchesPara2 = saved2.match(/This second paragraph contains additional user-authored notes\./g);
    expect(matchesPara1?.length).toBe(1);
    expect(matchesPara2?.length).toBe(1);

    // 5. Third Reload
    const parsed3 = parseObsidianRecipeMarkdown(saved2, 'Chili.md');
    expect(parsed3.description).toBe(parsed2.description);
    expect(parsed3.ingredients.length).toBe(1);
    expect(parsed3.instructions.length).toBe(1);
  });

  it('F2 — Extracts Markdown-tolerant body timing variants and survives round-trip', () => {
    const variants = [
      {
        name: 'Plain timing format',
        body: `# Recipe 1\n\nPrep: 15 mins\nCook: 45 mins\nTotal: 1 hr\n\n## Ingredients\n- 1 cup Rice\n`,
        expectedPrep: '15 mins',
        expectedCook: '45 mins',
        expectedTotal: '1 hr',
      },
      {
        name: 'Bold with colon inside',
        body: `# Recipe 2\n\n**Prep:** 15 mins\n**Cook:** 45 mins\n**Total:** 1 hr\n\n## Ingredients\n- 1 cup Rice\n`,
        expectedPrep: '15 mins',
        expectedCook: '45 mins',
        expectedTotal: '1 hr',
      },
      {
        name: 'List item with bold and "time" suffix',
        body: `# Recipe 3\n\n- **Prep time:** 15 mins\n- **Cook time:** 45 mins\n\n## Ingredients\n- 1 cup Rice\n`,
        expectedPrep: '15 mins',
        expectedCook: '45 mins',
        expectedTotal: '1 hr',
      },
      {
        name: 'Bold with whitespace before colon',
        body: `# Recipe 4\n\n**Prep** : 15 mins\n**Cook** : 45 mins\n\n## Ingredients\n- 1 cup Rice\n`,
        expectedPrep: '15 mins',
        expectedCook: '45 mins',
        expectedTotal: '1 hr',
      },
    ];

    for (const v of variants) {
      // 1. Parse variant
      const parsed = parseObsidianRecipeMarkdown(v.body, 'Recipe.md');
      expect(parsed.prepTime, `${v.name} prepTime`).toBe(v.expectedPrep);
      expect(parsed.cookTime, `${v.name} cookTime`).toBe(v.expectedCook);
      expect(parsed.totalTime, `${v.name} totalTime`).toBe(v.expectedTotal);

      // 2. Save
      const saved = serializeRecipeToObsidianMarkdown(parsed);
      expect(saved).toContain(`prep_time: ${v.expectedPrep}`);
      expect(saved).toContain(`cook_time: ${v.expectedCook}`);

      // 3. Reload
      const reloaded = parseObsidianRecipeMarkdown(saved, 'Recipe.md');
      expect(reloaded.prepTime, `${v.name} reloaded prepTime`).toBe(v.expectedPrep);
      expect(reloaded.cookTime, `${v.name} reloaded cookTime`).toBe(v.expectedCook);
      expect(reloaded.totalTime, `${v.name} reloaded totalTime`).toBe(v.expectedTotal);
    }
  });

  it('F3 — Does not fabricate created: from date: in YAML frontmatter', () => {
    const dateOnlyMarkdown = `---
title: Roman Cacio e Pepe
date: 2026-01-15
author: Nonna Maria
---

# Roman Cacio e Pepe

## Ingredients
- [ ] 200g Pecorino Romano

## Instructions
1. Cook pasta.
`;

    // 1. Parse date-only markdown
    const parsed = parseObsidianRecipeMarkdown(dateOnlyMarkdown, 'Cacio.md');
    expect(parsed.frontmatter?.date).toBe('2026-01-15');
    expect(parsed.frontmatter?.created).toBeUndefined();

    // 2. Save
    const saved = serializeRecipeToObsidianMarkdown(parsed);

    // Verify date is preserved, and created is NOT fabricated
    expect(saved).toMatch(/date:\s*['"]?2026-01-15['"]?/);
    expect(saved).not.toContain('created:');

    // 3. Confirm that notes with explicit created: STILL preserve created:
    const createdMarkdown = `---
title: Roman Cacio e Pepe
created: 2026-01-15
---

# Roman Cacio e Pepe

## Ingredients
- [ ] 200g Pecorino Romano
`;
    const parsedWithCreated = parseObsidianRecipeMarkdown(createdMarkdown, 'Cacio.md');
    const savedWithCreated = serializeRecipeToObsidianMarkdown(parsedWithCreated);
    expect(savedWithCreated).toMatch(/created:\s*['"]?2026-01-15['"]?/);
  });

  it('does NOT fabricate ingredients/instructions/servings/image when a recipe is empty', () => {
    // Save path: an empty recipe (no ingredients, no instructions, no servings, no image)
    const empty = serializeRecipeToObsidianMarkdown({
      title: 'Empty Recipe',
    } as any);

    // No fabricated ingredient/instruction rows or invented servings
    expect(empty).not.toContain('2 tbsp Olive Oil');
    expect(empty).not.toContain('1 tsp Sea Salt');
    expect(empty).not.toContain('Prepare ingredients');
    expect(empty).not.toContain('servings:');

    // Reload: no fabricated data appears after re-parse
    const reparsed = parseObsidianRecipeMarkdown(empty, 'Empty Recipe.md');
    expect(reparsed.ingredients).toHaveLength(0);
    expect(reparsed.instructions).toHaveLength(0);
    expect(reparsed.servings).toBeUndefined();
    expect(reparsed.image).toBeUndefined();

    // Regression: a normal recipe with real content still serializes correctly
    const normal = serializeRecipeToObsidianMarkdown({
      title: 'Real Recipe',
      prepTime: '15 mins',
      cookTime: '30 mins',
      servings: 4,
      ingredients: [
        { original: '2 cups flour', name: 'flour', amount: 2, unit: 'cup', isChecked: false },
        { original: '[[Salt|Sea Salt]]', name: 'Salt', wikilinkTarget: 'Salt', wikilinkAlias: 'Sea Salt', isChecked: false },
      ],
      instructions: [{ stepNumber: 1, text: 'Mix the dry ingredients.' }],
    } as any);
    expect(normal).toContain('2 cups flour');
    expect(normal).toContain('[[Salt|Sea Salt]]');
    expect(normal).toContain('Mix the dry ingredients.');
    expect(normal).toContain('servings: 4');
  });
});

