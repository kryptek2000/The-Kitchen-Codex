import { 
  parseObsidianRecipeMarkdown, 
  serializeRecipeToObsidianMarkdown, 
  parseFractionToDecimal, 
  formatAmount, 
  scaleIngredientText, 
  extractTimerMinutes, 
  cleanRecipeTitle,
  parseMealPlanFromMarkdown,
  serializeMealPlanToMarkdown,
  parseShoppingListFromMarkdown,
  serializeShoppingListToMarkdown,
  parseVaultNoteMarkdown,
  renderIngredientLine
} from '../src/utils/markdownParser';
import { isRestrictedIP, validateUrlForSSRF } from '../server/ssrfGuard';
import { generateMarkdown } from '../server/recipeGrabber';
import {
  assessRecipeHealth,
  summarizeVaultHealth,
  mergeRecoveredMetadata,
  normalizeTimeString,
} from '../src/utils/vaultIntelligence';
import { recoverMetadataAlgorithmically } from '../server/metadataRecovery';
import type { ObsidianRecipe, MealPlanDay, ShoppingCategoryGroup } from '../src/types';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, details?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ PASS: ${testName}`);
  } else {
    failedTests++;
    console.error(`  ❌ FAIL: ${testName} ${details ? `(${details})` : ''}`);
  }
}

console.log('====================================================');
console.log('THE KITCHEN CODEX v0.2.2 — COMPREHENSIVE QA TEST SUITE');
console.log('====================================================\n');

// ----------------------------------------------------
// SECTION 1: FRACTION & NUMBER ARITHMETIC TESTS
// ----------------------------------------------------
console.log('🧪 1. FRACTION ARITHMETIC & MEASUREMENT SCALING');
{
  assert(parseFractionToDecimal('1/2') === 0.5, 'Simple fraction: 1/2 -> 0.5');
  assert(parseFractionToDecimal('3/4') === 0.75, 'Simple fraction: 3/4 -> 0.75');
  assert(parseFractionToDecimal('1 1/2') === 1.5, 'Mixed fraction: 1 1/2 -> 1.5');
  assert(parseFractionToDecimal('2 1/4') === 2.25, 'Mixed fraction: 2 1/4 -> 2.25');
  assert(parseFractionToDecimal('½') === 0.5, 'Unicode fraction: ½ -> 0.5');
  assert(parseFractionToDecimal('1 ½') === 1.5, 'Mixed unicode: 1 ½ -> 1.5');
  assert(parseFractionToDecimal('¾') === 0.75, 'Unicode fraction: ¾ -> 0.75');
  assert(parseFractionToDecimal('⅓') !== null && Math.abs((parseFractionToDecimal('⅓') || 0) - 0.3333) < 0.01, 'Unicode fraction: ⅓ -> ~0.333');
  assert(parseFractionToDecimal('2') === 2, 'Integer string: 2 -> 2');
  assert(parseFractionToDecimal('2.5') === 2.5, 'Decimal string: 2.5 -> 2.5');
  assert(parseFractionToDecimal('') === null, 'Empty string returns null');

  assert(formatAmount(0.5) === '1/2', 'Format 0.5 -> 1/2');
  assert(formatAmount(1.5) === '1 1/2', 'Format 1.5 -> 1 1/2');
  assert(formatAmount(2) === '2', 'Format 2 -> 2');
  assert(formatAmount(0.25) === '1/4', 'Format 0.25 -> 1/4');
  assert(formatAmount(0.75) === '3/4', 'Format 0.75 -> 3/4');

  // Ingredient scaling
  const originalIng = '1 1/2 cups [[Heavy Cream]]';
  const scaledDouble = scaleIngredientText(originalIng, 4, 8);
  assert(scaledDouble.includes('3 cups') && scaledDouble.includes('[[Heavy Cream]]'), 'Scale 1 1/2 cups from 4 to 8 servings -> 3 cups');

  const scaledHalf = scaleIngredientText(originalIng, 4, 2);
  assert(scaledHalf.includes('3/4 cups') || scaledHalf.includes('3/4 cup'), 'Scale 1 1/2 cups from 4 to 2 servings -> 3/4 cups');

  const unicodeIng = '½ tsp [[Sea Salt]]';
  const scaledUnicode = scaleIngredientText(unicodeIng, 2, 4);
  assert(scaledUnicode.includes('1 tsp'), 'Scale ½ tsp from 2 to 4 servings -> 1 tsp');
}

// ----------------------------------------------------
// SECTION 2: MARKDOWN PARSER & ROUND-TRIP FIDELITY
// ----------------------------------------------------
console.log('\n🧪 2. MARKDOWN PARSER & SERIALIZATION ROUND-TRIP');
{
  const sampleMarkdown = `---
title: "Creamy Tuscan Garlic Chicken"
tags:
  - food/recipes
  - cuisine/italian
  - dinner
cuisine: "Italian"
category: "Dinner"
difficulty: "Medium"
rating: 5
prep_time: "15 mins"
cook_time: "25 mins"
total_time: "40 mins"
servings: 4
calories: 520
nutrition:
  calories: 520
  protein: 42
  carbohydrates: 12
  fat: 32
  fiber: 3
  sodium: 680
  confidenceNote: "Estimated from 8 ingredients across 4 servings."
source: "https://example.com/tuscan-chicken"
image: "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d"
created: "2026-08-21"
---

# Creamy Tuscan Garlic Chicken

> [!tip] Chef's Note
> Use freshly grated Parmigiano-Reggiano for the silkiest sauce texture.

## 🥘 Ingredients
- [ ] 2 large [[Chicken Breast|chicken breasts]], sliced
- [ ] 1 tbsp [[Olive Oil]]
- [ ] 4 cloves [[Garlic]], minced
- [ ] 1/2 cup [[Heavy Cream]]
- [ ] 1/2 cup [[Chicken Broth]]
- [ ] 1/2 cup [[Sun-Dried Tomatoes]], chopped
- [ ] 2 cups [[Baby Spinach]]
- [ ] 1/2 cup [[Parmesan Cheese]], grated

## 🍳 Instructions
1. Season chicken breasts with sea salt and black pepper.
2. Heat olive oil in a stainless steel skillet over medium-high heat. Sear chicken for 5 minutes per side until golden brown.
3. Add minced garlic to the pan and saute for 1 minute until fragrant.
4. Pour in chicken broth, heavy cream, and sun-dried tomatoes. Simmer for 3 minutes.
5. Add baby spinach and parmesan cheese; stir for 2 minutes until wilted.
6. Return chicken to skillet and simmer for 5 minutes until internal temp reaches 165°F.

## 💡 Notes & Variations
Serve over warm fettuccine pasta or roasted garlic mashed potatoes.
`;

  const parsed = parseObsidianRecipeMarkdown(sampleMarkdown, 'Tuscan Chicken.md', 'Recipes/Tuscan Chicken.md');

  assert(parsed.title === 'Creamy Tuscan Garlic Chicken', 'Recipe title parsed accurately');
  assert(parsed.cuisine === 'Italian', 'Cuisine parsed accurately');
  assert(parsed.category === 'Dinner', 'Category parsed accurately');
  assert(parsed.difficulty === 'Medium', 'Difficulty parsed accurately');
  assert(parsed.servings === 4, 'Servings parsed accurately');
  assert(parsed.calories === 520, 'Calories parsed accurately');
  assert(parsed.nutrition?.protein === 42, 'Nutrition protein parsed accurately (42g)');
  assert(parsed.nutrition?.carbohydrates === 12, 'Nutrition carbs parsed accurately (12g)');
  assert(parsed.nutrition?.fat === 32, 'Nutrition fat parsed accurately (32g)');
  assert(parsed.nutrition?.fiber === 3, 'Nutrition fiber parsed accurately (3g)');
  assert(parsed.nutrition?.sodium === 680, 'Nutrition sodium parsed accurately (680mg)');
  assert(parsed.ingredients.length === 8, 'Parsed all 8 ingredients');
  assert(parsed.instructions.length === 6, 'Parsed all 6 instructions');
  assert(parsed.callouts.length === 1, 'Parsed callout block');
  assert(parsed.callouts[0].type === 'tip', 'Callout type is tip');
  assert(parsed.wikilinks.includes('Chicken Breast'), 'Parsed wikilink target Chicken Breast');
  assert(parsed.wikilinks.includes('Olive Oil'), 'Parsed wikilink target Olive Oil');
  assert(parsed.instructions[1].timerMinutes === 5, 'Instruction timer extracted: 5 minutes');

  // Test Round-Trip serialization & re-parsing
  const serialized = serializeRecipeToObsidianMarkdown(parsed);
  const reparsed = parseObsidianRecipeMarkdown(serialized, 'Tuscan Chicken.md', 'Recipes/Tuscan Chicken.md');

  assert(reparsed.title === parsed.title, 'Round-trip: title preserved');
  assert(reparsed.cuisine === parsed.cuisine, 'Round-trip: cuisine preserved');
  assert(reparsed.servings === parsed.servings, 'Round-trip: servings preserved');
  assert(reparsed.calories === parsed.calories, 'Round-trip: calories preserved');
  assert(reparsed.nutrition?.protein === parsed.nutrition?.protein, 'Round-trip: nutrition protein preserved');
  assert(reparsed.nutrition?.carbohydrates === parsed.nutrition?.carbohydrates, 'Round-trip: nutrition carbs preserved');
  assert(reparsed.nutrition?.fat === parsed.nutrition?.fat, 'Round-trip: nutrition fat preserved');
  assert(reparsed.ingredients.length === parsed.ingredients.length, 'Round-trip: ingredient count preserved');
  assert(reparsed.instructions.length === parsed.instructions.length, 'Round-trip: instruction count preserved');
  assert(reparsed.callouts.length === parsed.callouts.length, 'Round-trip: callout count preserved');
}

// ----------------------------------------------------
// SECTION 3: WIKILINK & TITLE INTELLIGENCE
// ----------------------------------------------------
console.log('\n🧪 3. WIKILINK INTELLIGENCE & TITLE SANITIZATION');
{
  assert(cleanRecipeTitle('Creamy Tuscan Chicken') === 'Creamy Tuscan Chicken', 'Plain title preserved');
  assert(cleanRecipeTitle('[[Creamy Tuscan Chicken]]') === 'Creamy Tuscan Chicken', 'Wikilink stripped from title');
  assert(cleanRecipeTitle('[[Recipes/Pasta|Authentic Carbonara]]') === 'Authentic Carbonara', 'Wikilink with alias stripped to alias');
  assert(cleanRecipeTitle('[Best Brownies](https://example.com/brownies)') === 'Best Brownies', 'Markdown hyperlink stripped from title');
  assert(cleanRecipeTitle('# Homemade Sourdough Bread') === 'Homemade Sourdough Bread', 'Heading symbol stripped from title');
  assert(cleanRecipeTitle('**Crispy Roast Potatoes**') === 'Crispy Roast Potatoes', 'Bold markdown stripped from title');

  // Vault Note parsing
  const rawNote = `---
title: Olive Oil
tags:
  - pantry
  - italian
category: Ingredient Guide
---

# Olive Oil

> [!tip] Sourcing Note
> Look for cold-pressed Extra Virgin Olive Oil with a harvest date.
`;

  const parsedNote = parseVaultNoteMarkdown(rawNote, 'Olive Oil.md', 'Notes/Olive Oil.md');
  assert(parsedNote.title === 'Olive Oil', 'Vault note title extracted');
  assert(parsedNote.tags.includes('pantry'), 'Vault note tags extracted');
  assert(parsedNote.content.includes('Look for cold-pressed'), 'Vault note body content extracted');
}

// ----------------------------------------------------
// REV 1: WIKILINK PRESERVATION IN SERIALIZATION & WEB GRABBER (regression)
// ----------------------------------------------------
console.log('\n🧪 REV-1. WIKILINK PRESERVATION (renderIngredientLine + generateMarkdown)');
{
  // A. renderIngredientLine: measured ingredient with a wikilink target.
  const measured = renderIngredientLine({ original: '1 tbsp olive oil', name: 'olive oil', wikilink: 'Olive Oil' });
  assert(measured.includes('[[Olive Oil]]'), 'renderIngredientLine emits [[Target]] for measured ingredient', measured);
  assert(measured.includes('1 tbsp'), 'renderIngredientLine preserves measurement', measured);

  // B. renderIngredientLine: ingredient name == whole line -> no duplication.
  const nameOnly = renderIngredientLine({ original: 'Olive Oil', name: 'Olive Oil', wikilink: 'Olive Oil' });
  assert(nameOnly.includes('[[Olive Oil]]'), 'renderIngredientLine wraps a name-only ingredient with link', nameOnly);
  assert(countOccurrences(nameOnly, 'Olive Oil') === 1, 'renderIngredientLine does NOT duplicate the name', nameOnly);

  // C. renderIngredientLine: aliased wikilink [[Target|Alias]] preserved.
  const alias = renderIngredientLine({ original: '4 cloves garlic, minced', name: 'garlic', wikilinkTarget: 'Garlic', wikilinkAlias: 'cloves' });
  assert(alias.includes('[[Garlic|cloves]]'), 'renderIngredientLine emits [[Target|Alias]] correctly', alias);
  assert(alias.includes('4 cloves'), 'renderIngredientLine preserves measurement around alias link', alias);

  // D. renderIngredientLine: no metadata -> original text untouched (no stray link).
  const noLink = renderIngredientLine({ original: 'salt and pepper to taste', name: 'salt' });
  assert(!noLink.includes('[[') && noLink.includes('salt and pepper to taste'), 'renderIngredientLine leaves link-less ingredients untouched', noLink);

  // E. renderIngredientLine: already-inked original preserved verbatim (incl alias).
  const inline = renderIngredientLine({ original: '2 large [[Chicken Breast|chicken breasts]], sliced', name: 'chicken breasts', wikilink: 'Chicken Breast' });
  assert(inline.includes('2 large [[Chicken Breast|chicken breasts]], sliced'), 'renderIngredientLine preserves an existing [[Target|Alias]] verbatim', inline);

  // F. generateMarkdown (Web Grabber): recipe WITH wikilink ingredients keeps them.
  const withLinks = generateMarkdown({
    title: 'Garlic Pasta',
    tags: ['food/recipes'],
    cuisine: 'Italian',
    category: 'Dinner',
    prepTime: '10 mins',
    cookTime: '15 mins',
    totalTime: '25 mins',
    servings: 2,
    ingredients: [
      { original: '200g [[Spaghetti]]', name: 'Spaghetti', wikilink: 'Spaghetti' },
      { original: '2 tbsp [[Olive Oil]]', name: 'Olive Oil', wikilink: 'Olive Oil' },
      { original: '4 cloves [[Garlic]]', name: 'Garlic', wikilink: 'Garlic' },
    ],
    instructions: [{ stepNumber: 1, text: 'Boil spaghetti.' }],
  });
  assert(withLinks.includes('[[Spaghetti]]') && withLinks.includes('[[Olive Oil]]') && withLinks.includes('[[Garlic]]'),
    'generateMarkdown retains ingredient wikilinks ([[]] targets)', withLinks.slice(0, 120));

  // G. generateMarkdown (Web Grabber): recipe WITHOUT wikilinks adds none.
  const noLinks = generateMarkdown({
    title: 'Plain Salad',
    tags: ['food/recipes'],
    cuisine: 'General',
    category: 'Dinner',
    prepTime: '5 mins',
    cookTime: '0 mins',
    totalTime: '5 mins',
    servings: 2,
    ingredients: [
      { original: '2 cups lettuce', name: 'lettuce' },
      { original: '1 tbsp vinaigrette', name: 'vinaigrette' },
    ],
    instructions: [{ stepNumber: 1, text: 'Toss and serve.' }],
  });
  assert(!noLinks.includes('[['), 'generateMarkdown adds NO wikilinks when none are provided', noLinks.slice(0, 120));
  assert(noLinks.includes('2 cups lettuce'), 'generateMarkdown keeps ingredient text intact', noLinks.slice(0, 120));
}

// helper used by REV-1 assertions
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ----------------------------------------------------
// SECTION 4: MEAL PLANNER & SHOPPING LIST ROUND-TRIP
// ----------------------------------------------------
console.log('\n🧪 4. MEAL PLANNER & SHOPPING LIST SERIALIZATION');
{
  const sampleMealPlan: MealPlanDay[] = [
    { dayName: 'Monday', breakfast: { recipeTitle: 'Avocado Toast' }, dinner: { recipeTitle: 'Tuscan Chicken' } },
    { dayName: 'Tuesday', lunch: { recipeTitle: 'Greek Salad' }, dinner: { recipeTitle: 'Pasta Carbonara' } },
    { dayName: 'Wednesday' },
    { dayName: 'Thursday' },
    { dayName: 'Friday', dinner: { recipeTitle: 'Homemade Pizza' } },
    { dayName: 'Saturday' },
    { dayName: 'Sunday' },
  ];

  const serializedMealPlan = serializeMealPlanToMarkdown(sampleMealPlan);
  const reparsedMealPlan = parseMealPlanFromMarkdown(serializedMealPlan);

  assert(reparsedMealPlan[0].breakfast?.recipeTitle === 'Avocado Toast', 'Meal Plan Mon Breakfast round-trip');
  assert(reparsedMealPlan[0].dinner?.recipeTitle === 'Tuscan Chicken', 'Meal Plan Mon Dinner round-trip');
  assert(reparsedMealPlan[1].lunch?.recipeTitle === 'Greek Salad', 'Meal Plan Tue Lunch round-trip');
  assert(reparsedMealPlan[4].dinner?.recipeTitle === 'Homemade Pizza', 'Meal Plan Fri Dinner round-trip');

  const sampleShopping: ShoppingCategoryGroup[] = [
    {
      category: 'Produce',
      items: [
        { id: '1', text: '2 cups Baby Spinach', recipeSources: ['Tuscan Chicken'], isChecked: false },
        { id: '2', text: '4 cloves Garlic', recipeSources: ['Tuscan Chicken'], isChecked: true },
      ],
    },
    {
      category: 'Dairy',
      items: [
        { id: '3', text: '1/2 cup Heavy Cream', recipeSources: ['Tuscan Chicken'], isChecked: false },
      ],
    },
  ];

  const serializedShopping = serializeShoppingListToMarkdown(sampleShopping);
  const reparsedShopping = parseShoppingListFromMarkdown(serializedShopping);

  assert(reparsedShopping.length === 2, 'Shopping list category count preserved (2)');
  assert(reparsedShopping[0].category === 'Produce', 'Shopping list category 1 is Produce');
  assert(reparsedShopping[0].items.length === 2, 'Produce item count is 2');
  assert(reparsedShopping[0].items[1].isChecked === true, 'Checked item state preserved (Garlic: true)');
  assert(reparsedShopping[1].items[0].isChecked === false, 'Unchecked item state preserved (Cream: false)');
}

// ----------------------------------------------------
// SECTION 5: SECURITY & SSRF GUARD HARDENING
// ----------------------------------------------------
console.log('\n🧪 5. SECURITY, SSRF GUARD & INPUT VALIDATION');
{
  // Blocked IPv4 Private and Loopback
  assert(isRestrictedIP('127.0.0.1') === true, 'Block IPv4 loopback: 127.0.0.1');
  assert(isRestrictedIP('127.0.0.2') === true, 'Block IPv4 loopback subnet: 127.0.0.2');
  assert(isRestrictedIP('10.0.0.1') === true, 'Block RFC 1918 10.0.0.0/8: 10.0.0.1');
  assert(isRestrictedIP('172.16.0.1') === true, 'Block RFC 1918 172.16.0.0/12: 172.16.0.1');
  assert(isRestrictedIP('172.31.255.254') === true, 'Block RFC 1918 172.31.255.254');
  assert(isRestrictedIP('192.168.1.1') === true, 'Block RFC 1918 192.168.0.0/16: 192.168.1.1');
  assert(isRestrictedIP('169.254.169.254') === true, 'Block AWS/GCP Metadata 169.254.169.254');
  assert(isRestrictedIP('0.0.0.0') === true, 'Block 0.0.0.0/8');
  assert(isRestrictedIP('224.0.0.1') === true, 'Block Multicast 224.0.0.1');

  // Blocked IPv6
  assert(isRestrictedIP('::1') === true, 'Block IPv6 Loopback: ::1');
  assert(isRestrictedIP('::') === true, 'Block IPv6 Unspecified: ::');
  assert(isRestrictedIP('fe80::1') === true, 'Block IPv6 Link-local fe80::1');
  assert(isRestrictedIP('fc00::1') === true, 'Block IPv6 Unique Local fc00::1');
  assert(isRestrictedIP('fd12:3456:789a::1') === true, 'Block IPv6 ULA fd12::1');
  assert(isRestrictedIP('::ffff:127.0.0.1') === true, 'Block IPv4-mapped IPv6 ::ffff:127.0.0.1');
  assert(isRestrictedIP('::ffff:7f00:1') === true, 'Block IPv4-mapped IPv6 hex ::ffff:7f00:1');
  assert(isRestrictedIP('::ffff:192.168.1.1') === true, 'Block IPv4-mapped IPv6 ::ffff:192.168.1.1');
  assert(isRestrictedIP('2002:7f00:0001::') === true, 'Block 6to4 prefix with 127.0.0.1');

  // Allowed Public IPs
  assert(isRestrictedIP('8.8.8.8') === false, 'Allow Public IPv4: 8.8.8.8');
  assert(isRestrictedIP('1.1.1.1') === false, 'Allow Public IPv4: 1.1.1.1');
  assert(isRestrictedIP('2606:4700:4700::1111') === false, 'Allow Public IPv6: Cloudflare DNS');

  // SSRF URL Validation
  async function testSSRFRejection(url: string, expectedReason: string) {
    try {
      await validateUrlForSSRF(url);
      assert(false, `Rejected unsafe URL: ${url}`, 'Should have thrown SSRF error');
    } catch (err: any) {
      assert(true, `Rejected unsafe URL: ${url} (${err.message})`);
    }
  }

  (async () => {
    await testSSRFRejection('http://127.0.0.1/secret', 'loopback');
    await testSSRFRejection('http://localhost:3000/api', 'localhost');
    await testSSRFRejection('http://169.254.169.254/computeMetadata/v1/', 'metadata');
    await testSSRFRejection('http://[::1]/', 'ipv6 loopback');
    await testSSRFRejection('http://[::ffff:127.0.0.1]/', 'mapped ipv6');
    await testSSRFRejection('file:///etc/passwd', 'file scheme');
    await testSSRFRejection('ftp://example.com/recipe', 'ftp scheme');
    await testSSRFRejection('http://admin:password@example.com/', 'embedded credentials');
  })();
}

// ----------------------------------------------------
// SECTION 8: VAULT INTELLIGENCE & LEGACY RECOVERY TESTS
// ----------------------------------------------------
console.log('\n🧠 8. VAULT INTELLIGENCE & LEGACY METADATA RECOVERY');
{
  // Test 1: Legacy Recipe Detection
  const legacyMarkdown = `---
tags:
  - recipe
cuisine: Hawaiian
category: Seasonings
difficulty: Easy
author: Derrick Riches
url: https://example.com/recipe
---

# Hawaiian Pork Rib Rub

### Ingredients
- 1/4 cup brown sugar
- 2 tbsp sea salt
- 1 tbsp smoked paprika
- 1 tsp garlic powder

### Instructions
1. Mix all dry spices thoroughly in a glass bowl.
2. Rub evenly across pork ribs 30 minutes before smoking.
`;

  const parsedLegacy = parseObsidianRecipeMarkdown(legacyMarkdown, 'Hawaiian Pork Rib Rub.md');
  const healthReport = assessRecipeHealth(parsedLegacy);

  assert(healthReport.status === 'legacy', 'Legacy status identified correctly on un-migrated recipe note');
  assert(healthReport.missingFields.includes('prepTime'), 'Identifies missing prepTime');
  assert(healthReport.missingFields.includes('cookTime'), 'Identifies missing cookTime');
  assert(healthReport.missingFields.includes('servings'), 'Identifies missing servings');
  assert(healthReport.healthScore < 60, `Calculated health score (${healthReport.healthScore}%) reflects missing key metadata`);

  // Test 2: Heuristic Algorithmic Fallback Recovery
  const recoveredData = recoverMetadataAlgorithmically({
    title: parsedLegacy.title,
    rawMarkdown: parsedLegacy.rawMarkdown,
    ingredients: parsedLegacy.ingredients,
    instructions: parsedLegacy.instructions,
  });

  assert(recoveredData.prepTime !== undefined, 'Algorithmic recovery generated prep time');
  assert(recoveredData.servings !== undefined && recoveredData.servings.value > 0, 'Algorithmic recovery generated valid servings yield');
  assert(recoveredData.suggestedTags !== undefined && recoveredData.suggestedTags.value.length > 0, 'Algorithmic recovery inferred tags');

  // Test 3: Safe Non-destructive Merging
  const mergedRecipe = mergeRecoveredMetadata(parsedLegacy, recoveredData, ['prepTime', 'cookTime', 'servings', 'suggestedTags']);
  assert(mergedRecipe.prepTime === recoveredData.prepTime.value, 'Merged prepTime correctly onto recipe');
  assert(mergedRecipe.servings === recoveredData.servings.value, 'Merged servings yield onto recipe');
  assert(mergedRecipe.rawMarkdown.includes('author: Derrick Riches'), 'Preserved custom non-recipe YAML frontmatter (author)');
  assert(mergedRecipe.rawMarkdown.includes('url: https://example.com/recipe'), 'Preserved custom URL frontmatter');
  assert(mergedRecipe.rawMarkdown.includes('# Hawaiian Pork Rib Rub'), 'Preserved recipe title markdown header');

  // Test 4: Time Normalization
  assert(normalizeTimeString('15 mins') === '15 mins', 'Normalize 15 mins');
  assert(normalizeTimeString('1 hour 30 minutes') === '1 hr 30 mins', 'Normalize 1 hour 30 minutes');
  assert(normalizeTimeString('PT45M') === '45 mins', 'Normalize ISO 8601 PT45M');

  // Test 5: Vault Health Summary
  const summary = summarizeVaultHealth([parsedLegacy, mergedRecipe]);
  assert(summary.totalRecipes === 2, 'Vault summary counts total recipes');
  assert(summary.legacyCount >= 1, 'Vault summary identifies legacy recipes');
}

// Summary display
setTimeout(() => {
  console.log('\n====================================================');
  console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`);
  console.log('====================================================\n');
  if (failedTests > 0) {
    process.exit(1);
  }
}, 1000);
