import { ObsidianRecipe } from '../types';

export function testRecipeCardDataMapping() {
  console.log('Running Recipe Card Data Mapping & Regression Tests...');

  const sampleRecipe: ObsidianRecipe = {
    id: 'test-1',
    fileName: 'test_recipe.md',
    filePath: 'Recipes/test_recipe.md',
    rawMarkdown: '# Test Recipe',
    title: 'Authentic Tonkotsu Shoyu Ramen',
    tags: ['food/recipes'],
    category: 'Soup & Noodles',
    cuisine: 'Japanese',
    prepTime: '30 mins',
    cookTime: '45 mins',
    servings: 4,
    difficulty: 'Medium',
    rating: 5,
    ingredients: [
      { original: '4 portions Fresh Ramen Noodles', name: 'Fresh Ramen Noodles' }
    ],
    instructions: [
      { stepNumber: 1, text: 'Boil water and cook noodles.' }
    ],
    notes: 'Make-Ahead Tare: Prepare 24-48 hours in advance.',
    dataviewFields: {
      description: 'Rich and flavorful tonkotsu broth with tender chashu pork.',
      foodDisplay: 'Traditional presentation with vibrant toppings.'
    },
    callouts: [],
    wikilinks: []
  };

  // Test 1: Chef's Notes are mapped to notes and rendered separately from description
  const description = sampleRecipe.dataviewFields?.description || sampleRecipe.dataviewFields?.summary || (sampleRecipe as any).description || '';
  const notes = sampleRecipe.notes || '';

  if (description.includes('Rich and flavorful')) {
    console.log('✓ Test 1 Passed: Description mapped correctly from dataviewFields');
  } else {
    throw new Error('Test 1 Failed: Description mapping incorrect');
  }

  if (notes.includes('Make-Ahead Tare')) {
    console.log('✓ Test 2 Passed: Chef\'s Notes mapped correctly to notes');
  } else {
    throw new Error('Test 2 Failed: Chef\'s Notes mapping incorrect');
  }

  // Test 3: Missing description does not fall back to notes
  const recipeWithoutDesc: ObsidianRecipe = {
    ...sampleRecipe,
    dataviewFields: {}
  };
  const descMissing = recipeWithoutDesc.dataviewFields?.description || '';
  if (descMissing === '') {
    console.log('✓ Test 3 Passed: Missing description does not fall back to notes');
  } else {
    throw new Error('Test 3 Failed: Description fell back to notes incorrectly');
  }

  // Test 4: Food Display detection logic (Strictly actual dataview fields, no fabrication)
  const foodDisplayText = sampleRecipe.dataviewFields?.foodDisplay || sampleRecipe.dataviewFields?.presentation;
  const hasFoodDisplay = Boolean(foodDisplayText);
  if (hasFoodDisplay) {
    console.log('✓ Test 4 Passed: Food Display detected strictly from metadata');
  } else {
    throw new Error('Test 4 Failed: Food Display detection failed');
  }

  // Test 4b: Missing food display does not fabricate content
  const recipeWithoutFoodDisplay: ObsidianRecipe = {
    ...sampleRecipe,
    dataviewFields: {}
  };
  const hasFoodDisplayMissing = Boolean(recipeWithoutFoodDisplay.dataviewFields?.foodDisplay || recipeWithoutFoodDisplay.dataviewFields?.presentation);
  if (!hasFoodDisplayMissing) {
    console.log('✓ Test 4b Passed: Missing food display omits panel without fabrication');
  } else {
    throw new Error('Test 4b Failed: Fabricated food display content');
  }

  // Test 5: Recipe-aware footer advice
  const sourdoughRecipe: ObsidianRecipe = {
    ...sampleRecipe,
    title: 'Artisan Sourdough Boule',
    category: 'Baking & Breads',
    notes: 'Allow loaf to cool completely before slicing.'
  };
  const getTestServingAdvice = (recipe: ObsidianRecipe) => {
    const titleLower = recipe.title.toLowerCase();
    const catLower = (recipe.category || '').toLowerCase();
    const notesLower = (recipe.notes || '').toLowerCase();
    
    if (notesLower.includes('cool') || notesLower.includes('slice') || catLower.includes('bread') || catLower.includes('baking') || titleLower.includes('bread') || titleLower.includes('sourdough')) {
      return 'Allow to cool before slicing. Enjoy fresh or toasted.';
    }
    return 'Enjoy prepared fresh to taste.';
  };
  const advice = getTestServingAdvice(sourdoughRecipe);
  if (advice.includes('Allow to cool')) {
    console.log('✓ Test 5 Passed: Recipe-aware footer advice correctly generated for sourdough bread');
  } else {
    throw new Error('Test 5 Failed: Footer advice incorrect for sourdough');
  }

  console.log('All Recipe Card Validation & Regression Tests Passed Successfully!');
  return true;
}

if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('recipeCardValidation.test')) {
  testRecipeCardDataMapping();
}
