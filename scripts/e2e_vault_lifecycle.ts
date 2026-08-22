import * as fs from 'fs/promises';
import * as path from 'path';
import { 
  parseObsidianRecipeMarkdown, 
  serializeRecipeToObsidianMarkdown, 
  scaleIngredientText, 
  extractTimerMinutes, 
  parseMealPlanFromMarkdown, 
  serializeMealPlanToMarkdown, 
  parseShoppingListFromMarkdown, 
  serializeShoppingListToMarkdown, 
  parseVaultNoteMarkdown 
} from '../src/utils/markdownParser';
import type { ObsidianRecipe, MealPlanDay, ShoppingCategoryGroup, ParsedIngredient, RecipeStep } from '../src/types';

let totalSteps = 0;
let passedSteps = 0;
let failedSteps = 0;

function assert(condition: boolean, stepName: string, details?: string) {
  totalSteps++;
  if (condition) {
    passedSteps++;
    console.log(`  ✅ [PASS] ${stepName}`);
  } else {
    failedSteps++;
    console.error(`  ❌ [FAIL] ${stepName} ${details ? `(${details})` : ''}`);
  }
}

async function runFullE2EVaultLifecycle() {
  console.log('========================================================================');
  console.log('THE KITCHEN CODEX v0.2.1 — END-TO-END OBSIDIAN VAULT LIFECYCLE TEST');
  console.log('========================================================================\n');

  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const VAULT_DIR = path.join(process.cwd(), `.test_obsidian_vault_${uniqueId}`);
  const RECIPES_DIR = path.join(VAULT_DIR, 'Recipes');
  const NOTES_DIR = path.join(VAULT_DIR, 'Notes');
  const BASE_URL = 'http://localhost:3000';

  // -------------------------------------------------------------------------
  // STEP 1: Connect an Actual Obsidian Vault
  // -------------------------------------------------------------------------
  console.log('📁 STEP 1: CONNECT AN ACTUAL OBSIDIAN VAULT');
  {
    await fs.mkdir(VAULT_DIR, { recursive: true });
    await fs.mkdir(RECIPES_DIR, { recursive: true });
    await fs.mkdir(NOTES_DIR, { recursive: true });

    assert(await fs.stat(VAULT_DIR).then(() => true).catch(() => false), 'Vault root directory established');
    assert(await fs.stat(RECIPES_DIR).then(() => true).catch(() => false), 'Recipes directory created');
    assert(await fs.stat(NOTES_DIR).then(() => true).catch(() => false), 'Notes directory created');
  }

  // -------------------------------------------------------------------------
  // STEP 2: Import a Recipe from the Web / Text (AI Recipe Grabber)
  // -------------------------------------------------------------------------
  console.log('\n🌐 STEP 2: IMPORT A RECIPE FROM THE WEB / TEXT');
  let importedRecipe: ObsidianRecipe;
  {
    const rawWebPayload = {
      rawText: `Authentic Roman Pasta Carbonara
A classic Roman pasta dish made with egg yolks, Pecorino Romano, guanciale, and freshly cracked black pepper.

Prep time: 10 mins
Cook time: 15 mins
Total time: 25 mins
Servings: 4
Cuisine: Italian
Category: Dinner
Tags: italian, pasta, dinner, roman

Ingredients:
- 1 lb [[Spaghetti]]
- 200g [[Guanciale]], diced into 1/4-inch pieces
- 4 large [[Egg Yolks]]
- 1 whole [[Large Egg]]
- 1 cup [[Pecorino Romano]], finely grated
- 1 tbsp [[Coarse Black Pepper]], freshly cracked
- 1 pinch [[Sea Salt]]

Instructions:
1. Bring a large pot of salted water to a gentle boil and cook spaghetti for 9 minutes until al dente.
2. In a cold skillet, add diced guanciale and cook over medium-low heat for 8 minutes until crisp and golden.
3. In a mixing bowl, whisk together egg yolks, whole egg, and grated Pecorino Romano until a thick paste forms.
4. Reserve 1/2 cup of starchy pasta water, then drain spaghetti and add directly to the skillet with warm guanciale fat.
5. Remove skillet from heat. Pour egg mixture and 2 tbsp warm pasta water into pasta, tossing vigorously for 2 minutes to create a glossy emulsion.
6. Serve immediately garnished with extra Pecorino Romano and freshly cracked black pepper.`
    };

    const res = await fetch(`${BASE_URL}/api/grab-recipe`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Forwarded-For': `198.51.100.${Math.floor(Math.random() * 200 + 10)}`
      },
      body: JSON.stringify(rawWebPayload),
    });

    assert(res.status === 200, 'Web recipe grabber endpoint returned 200 OK');
    const data = await res.json();
    assert(data.success === true, 'Grabber parsed structured recipe payload');
    assert(typeof data.recipe?.title === 'string' && data.recipe.title.length > 0, 'Extracted recipe title');
    assert(Array.isArray(data.recipe?.ingredients) && data.recipe.ingredients.length >= 5, 'Extracted ingredients list');
    assert(Array.isArray(data.recipe?.instructions) && data.recipe.instructions.length >= 5, 'Extracted instructions list');

    // Convert to ObsidianRecipe structure
    const parsedIngs: ParsedIngredient[] = data.recipe.ingredients.map((ing: any) => ({
      original: ing.original || ing.name || String(ing),
      name: ing.name || ing.original || String(ing),
      amount: ing.amount,
      unit: ing.unit,
      wikilink: ing.wikilink,
      isChecked: false,
    }));

    const parsedSteps: RecipeStep[] = data.recipe.instructions.map((step: any, idx: number) => ({
      stepNumber: step.stepNumber || idx + 1,
      text: step.text,
      timerMinutes: step.timerMinutes || extractTimerMinutes(step.text),
      isCompleted: false,
    }));

    importedRecipe = {
      id: 'carbonara-1',
      title: data.recipe.title || 'Authentic Roman Pasta Carbonara',
      fileName: 'Authentic Roman Pasta Carbonara.md',
      filePath: 'Recipes/Authentic Roman Pasta Carbonara.md',
      cuisine: data.recipe.cuisine || 'Italian',
      category: data.recipe.category || 'Dinner',
      difficulty: (data.recipe.difficulty as any) || 'Medium',
      rating: 5,
      prepTime: '10 mins',
      cookTime: '15 mins',
      totalTime: '25 mins',
      servings: 4,
      calories: 620,
      tags: ['food/recipes', 'cuisine/italian', 'pasta'],
      source: 'https://roman-kitchen.example/carbonara',
      image: 'https://images.unsplash.com/photo-1612874742237-6526221588e3',
      callouts: [
        {
          type: 'tip',
          title: "Chef's Emulsion Technique",
          content: 'Always take the skillet completely off the heat before adding the egg mixture to avoid scrambling the eggs.'
        }
      ],
      ingredients: parsedIngs,
      instructions: parsedSteps,
      notes: 'Authentic Roman recipe without cream.',
      rawMarkdown: '',
      dataviewFields: {},
      wikilinks: ['Spaghetti', 'Guanciale', 'Egg Yolks', 'Pecorino Romano', 'Coarse Black Pepper'],
    };
  }

  // -------------------------------------------------------------------------
  // STEP 3 & 4: Edit and Save Recipe into Vault
  // -------------------------------------------------------------------------
  console.log('\n✏️ STEP 3 & 4: EDIT RECIPE AND SAVE TO OBSIDIAN VAULT');
  const recipeFilePath = path.join(RECIPES_DIR, importedRecipe.fileName);
  {
    importedRecipe.tags.push('favorite');
    importedRecipe.notes += ' Best paired with a dry Italian white wine like Frascati.';

    const markdownToSave = serializeRecipeToObsidianMarkdown(importedRecipe);
    importedRecipe.rawMarkdown = markdownToSave;

    await fs.writeFile(recipeFilePath, markdownToSave, 'utf-8');

    const fileSaved = await fs.stat(recipeFilePath).then(() => true).catch(() => false);
    assert(fileSaved, 'Saved recipe Markdown file directly to Recipes/ folder on disk');

    const diskContent = await fs.readFile(recipeFilePath, 'utf-8');
    assert(diskContent.includes('---'), 'Frontmatter YAML opening delimiter present');
    assert(diskContent.includes(importedRecipe.title), 'Frontmatter title serialized');
    assert(diskContent.includes(importedRecipe.cuisine), 'Frontmatter cuisine serialized');
    assert(diskContent.includes('> [!tip] Chef\'s Emulsion Technique'), 'Callout block serialized');
    assert(diskContent.includes('[[Pecorino Romano]]') || diskContent.includes('Pecorino Romano'), 'Ingredients serialized properly');
  }

  // -------------------------------------------------------------------------
  // STEP 5: Close / Reopen App (Re-scan Vault from Disk)
  // -------------------------------------------------------------------------
  console.log('\n🔄 STEP 5: CLOSE / REOPEN APP & RE-SCAN VAULT FROM DISK');
  let reloadedRecipe: ObsidianRecipe;
  {
    const files = await fs.readdir(RECIPES_DIR);
    assert(files.length === 1 && files[0] === importedRecipe.fileName, 'Vault scan identifies saved recipe file');

    const fileContent = await fs.readFile(recipeFilePath, 'utf-8');
    reloadedRecipe = parseObsidianRecipeMarkdown(fileContent, importedRecipe.fileName, `Recipes/${importedRecipe.fileName}`);

    assert(reloadedRecipe.title === importedRecipe.title, 'Reloaded recipe title matches');
    assert(reloadedRecipe.servings === 4, 'Reloaded recipe servings matches');
    assert(reloadedRecipe.ingredients.length === importedRecipe.ingredients.length, 'Reloaded recipe ingredients count matches');
    assert(reloadedRecipe.callouts.length === 1, 'Reloaded recipe callouts preserved');
  }

  // -------------------------------------------------------------------------
  // STEP 6 & 7: Modify Recipe Directly in Obsidian & Verify App Detects Change
  // -------------------------------------------------------------------------
  console.log('\n📝 STEP 6 & 7: DIRECT OBSIDIAN MODIFICATION & SYNC DETECTION');
  {
    // Simulate user editing the markdown file directly in Obsidian Desktop
    let rawDiskMarkdown = await fs.readFile(recipeFilePath, 'utf-8');
    rawDiskMarkdown = rawDiskMarkdown.replace(/prep_time:\s*"?10 mins"?/i, 'prep_time: "12 mins"');
    rawDiskMarkdown = rawDiskMarkdown.replace('## 🥘 Ingredients\n', '## 🥘 Ingredients\n- [ ] 1 pinch [[Nutmeg|Fresh Ground Nutmeg]]\n');
    await fs.writeFile(recipeFilePath, rawDiskMarkdown, 'utf-8');

    // App re-scans the vault
    const updatedDiskMarkdown = await fs.readFile(recipeFilePath, 'utf-8');
    const syncedRecipe = parseObsidianRecipeMarkdown(updatedDiskMarkdown, importedRecipe.fileName, `Recipes/${importedRecipe.fileName}`);

    assert(syncedRecipe.prepTime === '12 mins', 'App detected external YAML prep_time edit from Obsidian');
    assert(syncedRecipe.ingredients.some(i => i.original.includes('Nutmeg') || i.name.includes('Nutmeg')), 'App detected newly added ingredient from Obsidian');
    assert(syncedRecipe.wikilinks.includes('Nutmeg'), 'App extracted aliased wikilink target Nutmeg');
    reloadedRecipe = syncedRecipe;
  }

  // -------------------------------------------------------------------------
  // STEP 8: Add Recipe to Weekly Meal Plan (Meal Plan.md)
  // -------------------------------------------------------------------------
  console.log('\n📅 STEP 8: ADD RECIPE TO WEEKLY MEAL PLAN (Meal Plan.md)');
  const mealPlanFilePath = path.join(VAULT_DIR, 'Meal Plan.md');
  {
    const weeklyMealPlan: MealPlanDay[] = [
      { dayName: 'Monday', dinner: { recipeTitle: reloadedRecipe.title, customText: 'Family dinner' } },
      { dayName: 'Tuesday' },
      { dayName: 'Wednesday', lunch: { recipeTitle: reloadedRecipe.title, customText: 'Leftover lunch' } },
      { dayName: 'Thursday' },
      { dayName: 'Friday' },
      { dayName: 'Saturday' },
      { dayName: 'Sunday' },
    ];

    const mealPlanMarkdown = serializeMealPlanToMarkdown(weeklyMealPlan);
    await fs.writeFile(mealPlanFilePath, mealPlanMarkdown, 'utf-8');

    assert(await fs.stat(mealPlanFilePath).then(() => true).catch(() => false), 'Meal Plan.md written to vault');

    const mealPlanContent = await fs.readFile(mealPlanFilePath, 'utf-8');
    const reparsedPlan = parseMealPlanFromMarkdown(mealPlanContent);

    assert(reparsedPlan[0].dinner?.recipeTitle === reloadedRecipe.title, 'Monday dinner matches Carbonara');
    assert(reparsedPlan[2].lunch?.recipeTitle === reloadedRecipe.title, 'Wednesday lunch matches Carbonara');
  }

  // -------------------------------------------------------------------------
  // STEP 9: Generate and Save Synchronized Shopping List (Shopping List.md)
  // -------------------------------------------------------------------------
  console.log('\n🛒 STEP 9: GENERATE SYNCHRONIZED SHOPPING LIST (Shopping List.md)');
  const shoppingListFilePath = path.join(VAULT_DIR, 'Shopping List.md');
  {
    const shoppingCategories: ShoppingCategoryGroup[] = [
      {
        category: 'Pasta & Grains',
        items: [
          { id: '1', text: '1 lb Spaghetti', recipeSources: [reloadedRecipe.title], isChecked: false }
        ]
      },
      {
        category: 'Meat & Seafood',
        items: [
          { id: '2', text: '200g Guanciale, diced', recipeSources: [reloadedRecipe.title], isChecked: false }
        ]
      },
      {
        category: 'Dairy & Eggs',
        items: [
          { id: '3', text: '4 large Egg Yolks', recipeSources: [reloadedRecipe.title], isChecked: false },
          { id: '4', text: '1 cup Pecorino Romano', recipeSources: [reloadedRecipe.title], isChecked: true }
        ]
      },
      {
        category: 'Spices & Pantry',
        items: [
          { id: '5', text: '1 tbsp Coarse Black Pepper', recipeSources: [reloadedRecipe.title], isChecked: false }
        ]
      }
    ];

    const shoppingListMarkdown = serializeShoppingListToMarkdown(shoppingCategories);
    await fs.writeFile(shoppingListFilePath, shoppingListMarkdown, 'utf-8');

    assert(await fs.stat(shoppingListFilePath).then(() => true).catch(() => false), 'Shopping List.md written to vault');

    const shoppingListContent = await fs.readFile(shoppingListFilePath, 'utf-8');
    const reparsedShopping = parseShoppingListFromMarkdown(shoppingListContent);

    assert(reparsedShopping.length === 4, 'Parsed all 4 shopping categories');
    assert(reparsedShopping[2].items[1].isChecked === true, 'Checked state for Pecorino Romano preserved');
    assert(reparsedShopping[0].items[0].text === '1 lb Spaghetti', 'Shopping list items parsed from markdown');
  }

  // -------------------------------------------------------------------------
  // STEP 10: Scale Portions & Fractional Arithmetic
  // -------------------------------------------------------------------------
  console.log('\n⚖️ STEP 10: DYNAMIC PORTION SCALING & FRACTION ARITHMETIC');
  {
    const testIng1 = '1/2 cup [[Heavy Cream]]';
    const scaledDouble = scaleIngredientText(testIng1, 4, 8);
    assert(scaledDouble.includes('1 cup'), 'Scaled 1/2 cup x 2 = 1 cup');

    const testIng2 = '1 1/2 lbs [[Spaghetti]]';
    const scaledTriple = scaleIngredientText(testIng2, 4, 12);
    assert(scaledTriple.includes('4 1/2') || scaledTriple.includes('4.5'), 'Scaled 1 1/2 lbs x 3 = 4 1/2 lbs');

    const testIng3 = '¾ tsp [[Nutmeg]]';
    const scaledHalf = scaleIngredientText(testIng3, 4, 2);
    assert(scaledHalf.includes('3/8') || scaledHalf.includes('0.38'), 'Scaled ¾ tsp / 2 = 3/8 tsp');
  }

  // -------------------------------------------------------------------------
  // STEP 11: Cooking Mode & Step Timer Extraction
  // -------------------------------------------------------------------------
  console.log('\n⏱️ STEP 11: COOKING MODE & STEP TIMER EXTRACTION');
  {
    const step1Timer = extractTimerMinutes('Bring a large pot of salted water to a gentle boil and cook spaghetti for 9 minutes until al dente.');
    assert(step1Timer === 9, 'Extracted 9 minute boiling timer from step 1');

    const step2Timer = extractTimerMinutes('In a cold skillet, add diced guanciale and cook over medium-low heat for 8 minutes until crisp.');
    assert(step2Timer === 8, 'Extracted 8 minute guanciale timer from step 2');

    const step5Timer = extractTimerMinutes('tossing vigorously for 2 minutes to create a glossy emulsion');
    assert(step5Timer === 2, 'Extracted 2 minute emulsion timer from step 5');
  }

  // -------------------------------------------------------------------------
  // STEP 12: Create / Open Wikilink Knowledge Note
  // -------------------------------------------------------------------------
  console.log('\n🧠 STEP 12: CREATE / OPEN WIKILINK KNOWLEDGE NOTE (Notes/Guanciale.md)');
  const noteFilePath = path.join(NOTES_DIR, 'Guanciale.md');
  {
    const guancialeNoteContent = `---
title: "Guanciale"
tags:
  - charcuterie
  - italian
  - pork
category: "Ingredient Guide"
created: "2026-08-21"
---

# Guanciale

> [!tip] Culinary Definition
> Italian cured meat prepared from pork jowl or cheeks. Its name derives from *guancia*, the Italian word for cheek.

## Flavor Profile & Uses
- Unsmoked, seasoned with salt, black pepper, and sometimes rosemary or garlic.
- Higher fat-to-meat ratio than pancetta, imparting rich silkiness to sauces.
- Essential cornerstone ingredient for [[Authentic Roman Pasta Carbonara]] and [[Pasta all'Amatriciana]].
`;

    await fs.writeFile(noteFilePath, guancialeNoteContent, 'utf-8');
    assert(await fs.stat(noteFilePath).then(() => true).catch(() => false), 'Notes/Guanciale.md written to vault');

    const readNoteContent = await fs.readFile(noteFilePath, 'utf-8');
    const parsedNote = parseVaultNoteMarkdown(readNoteContent, 'Guanciale.md', 'Notes/Guanciale.md');

    assert(parsedNote.title === 'Guanciale', 'Note title parsed correctly');
    assert(parsedNote.tags.includes('italian'), 'Note tags parsed correctly');
  }

  // -------------------------------------------------------------------------
  // STEP 13: Estimate Nutrition & Serialize Frontmatter
  // -------------------------------------------------------------------------
  console.log('\n🥗 STEP 13: ESTIMATE NUTRITION VIA GEMINI & SAVE TO FRONTMATTER');
  {
    const rawIngStrings = reloadedRecipe.ingredients.map(i => i.original);
    const nutritionPayload = {
      title: reloadedRecipe.title,
      recipeTitle: reloadedRecipe.title,
      servings: reloadedRecipe.servings || 4,
      ingredients: rawIngStrings,
    };

    const res = await fetch(`${BASE_URL}/api/estimate-nutrition`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 200 + 10)}`
      },
      body: JSON.stringify(nutritionPayload),
    });

    const rawResponseText = await res.text();
    let nutData: any = {};
    try {
      nutData = JSON.parse(rawResponseText);
    } catch (e) {
      console.error('Failed to parse nutrition response JSON:', rawResponseText);
    }

    if (res.status !== 200) {
      console.error('Nutrition API status error:', res.status, rawResponseText);
    }

    assert(res.status === 200, 'Nutrition API returned 200 OK');
    assert(nutData.success === true && !!nutData.nutrition, 'Received validated nutrition breakdown');
    assert(nutData.nutrition.calories > 300, `Calories calculated: ${nutData.nutrition.calories}`);
    assert(nutData.nutrition.protein > 10, `Protein calculated: ${nutData.nutrition.protein}g`);

    // Attach nutrition to recipe
    reloadedRecipe.nutrition = nutData.nutrition;
    reloadedRecipe.calories = nutData.nutrition.calories;

    // Reserialize and write to disk
    const updatedRecipeMarkdown = serializeRecipeToObsidianMarkdown(reloadedRecipe);
    await fs.writeFile(recipeFilePath, updatedRecipeMarkdown, 'utf-8');
  }

  // -------------------------------------------------------------------------
  // STEP 14: Final Full-Vault File Integrity & Markdown Fidelity Verification
  // -------------------------------------------------------------------------
  console.log('\n🔍 STEP 14: FULL-VAULT INTEGRITY & MARKDOWN FIDELITY AUDIT');
  {
    const finalRecipeRaw = await fs.readFile(recipeFilePath, 'utf-8');
    const finalNoteRaw = await fs.readFile(noteFilePath, 'utf-8');
    const finalMealPlanRaw = await fs.readFile(mealPlanFilePath, 'utf-8');
    const finalShoppingRaw = await fs.readFile(shoppingListFilePath, 'utf-8');

    const finalRecipe = parseObsidianRecipeMarkdown(finalRecipeRaw, reloadedRecipe.fileName, `Recipes/${reloadedRecipe.fileName}`);
    const finalNote = parseVaultNoteMarkdown(finalNoteRaw, 'Guanciale.md', 'Notes/Guanciale.md');
    const finalMealPlan = parseMealPlanFromMarkdown(finalMealPlanRaw);
    const finalShopping = parseShoppingListFromMarkdown(finalShoppingRaw);

    assert(finalRecipe.title === reloadedRecipe.title, 'Final recipe title preserved');
    assert(finalRecipe.nutrition !== undefined && (finalRecipe.nutrition.calories || 0) > 0, 'Final recipe frontmatter contains nutrition block');
    assert(finalRecipe.callouts.length === 1, 'Final recipe callouts intact');
    assert(finalRecipe.ingredients.length > 0, 'Final recipe ingredients intact');
    assert(finalNote.title === 'Guanciale', 'Final knowledge note intact');
    assert(finalMealPlan.length === 7, 'Final meal plan 7 days intact');
    assert(finalShopping.length === 4, 'Final shopping list 4 categories intact');

    console.log('\n--- Final Recipe Frontmatter on Disk ---');
    const frontmatterPreview = finalRecipeRaw.split('---').slice(0, 2).join('---') + '---';
    console.log(frontmatterPreview);
  }

  // Cleanup isolated test vault
  try {
    await fs.rm(VAULT_DIR, { recursive: true, force: true });
  } catch (e) {}

  console.log('========================================================================');
  console.log(`E2E LIFECYCLE SUMMARY: ${totalSteps} TESTS | ${passedSteps} PASSED | ${failedSteps} FAILED`);
  console.log('========================================================================\n');

  if (failedSteps > 0) {
    process.exit(1);
  }
}

runFullE2EVaultLifecycle().catch((err) => {
  console.error('Fatal E2E test failure:', err);
  process.exit(1);
});
