import {
  ObsidianRecipe,
  MetadataHealthReport,
  MetadataHealthStatus,
  VaultHealthSummary,
  RecoveredRecipeMetadata,
  RecipeNutrition,
} from '../types';
import { serializeRecipeToObsidianMarkdown, parseObsidianRecipeMarkdown } from './markdownParser';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

/**
 * Normalizes varied time formats (e.g., "PT20M", "20m", "1 hr 15 min", "90 minutes") into clean standard display strings.
 */
export function normalizeTimeString(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // ISO 8601 Duration (e.g., PT1H30M, PT45M, PT2H)
  const isoMatch = trimmed.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (isoMatch) {
    const hrs = parseInt(isoMatch[1] || '0', 10);
    const mins = parseInt(isoMatch[2] || '0', 10);
    if (hrs > 0 && mins > 0) return `${hrs} hr ${mins} mins`;
    if (hrs > 0) return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'}`;
    if (mins > 0) return `${mins} mins`;
  }

  // Handle "1h 30m" or "1h30m" or "2h"
  const hmMatch = trimmed.match(/^(\d+)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*m(?:in(?:ute)?s?)?)?$/i);
  if (hmMatch) {
    const hrs = parseInt(hmMatch[1], 10);
    const mins = hmMatch[2] ? parseInt(hmMatch[2], 10) : 0;
    if (hrs > 0 && mins > 0) return `${hrs} hr ${mins} mins`;
    if (hrs > 0) return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'}`;
  }

  // Handle minutes only: "45m", "45 mins", "45 minutes", "45 min"
  const mMatch = trimmed.match(/^(\d+)\s*(?:m|mins?|minutes?)$/i);
  if (mMatch) {
    const mins = parseInt(mMatch[1], 10);
    if (mins >= 60 && mins % 60 === 0) {
      const hrs = mins / 60;
      return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'}`;
    } else if (mins > 60) {
      const hrs = Math.floor(mins / 60);
      const rem = mins % 60;
      return `${hrs} hr ${rem} mins`;
    }
    return `${mins} mins`;
  }

  // Simple number without unit -> assume minutes
  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    return `${num} mins`;
  }

  return trimmed;
}

/**
 * Assesses the metadata health and completeness of a single recipe.
 */
export function assessRecipeHealth(recipe: ObsidianRecipe): MetadataHealthReport {
  const missingFields: string[] = [];
  const presentFields: string[] = [];
  const legacyMarkers: string[] = [];

  // 1. Timings Check (Weight: 25)
  const hasPrep = Boolean(recipe.prepTime && recipe.prepTime.trim());
  const hasCook = Boolean(recipe.cookTime && recipe.cookTime.trim());
  const hasTotal = Boolean(recipe.totalTime && recipe.totalTime.trim());

  if (hasPrep) presentFields.push('prepTime');
  else missingFields.push('prepTime');

  if (hasCook) presentFields.push('cookTime');
  else missingFields.push('cookTime');

  if (hasTotal) presentFields.push('totalTime');

  if (!hasPrep && !hasCook && !hasTotal) {
    legacyMarkers.push('No timing metadata (missing prep_time, cook_time, total_time)');
  }

  // 2. Servings / Yield Check (Weight: 20)
  const hasServings = typeof recipe.servings === 'number' && recipe.servings > 0;
  if (hasServings) {
    presentFields.push('servings');
  } else {
    missingFields.push('servings');
    legacyMarkers.push('Missing servings / yield metadata');
  }

  // 3. Nutrition Check (Weight: 20)
  const hasCalories = Boolean(recipe.calories !== undefined && recipe.calories !== null && String(recipe.calories).trim());
  const hasNutritionObj = Boolean(
    recipe.nutrition &&
    (recipe.nutrition.protein !== undefined ||
     recipe.nutrition.carbohydrates !== undefined ||
     recipe.nutrition.fat !== undefined)
  );

  if (hasCalories) presentFields.push('calories');
  else missingFields.push('calories');

  if (hasNutritionObj) presentFields.push('nutrition');
  else missingFields.push('nutrition');

  if (!hasCalories && !hasNutritionObj) {
    legacyMarkers.push('Missing nutritional information and calorie estimates');
  }

  // 4. Categorization Check (Weight: 15)
  const hasCategory = Boolean(recipe.category && recipe.category.trim() && recipe.category !== 'General');
  const hasCuisine = Boolean(recipe.cuisine && recipe.cuisine.trim() && recipe.cuisine !== 'General');

  if (hasCategory) presentFields.push('category');
  else missingFields.push('category');

  if (hasCuisine) presentFields.push('cuisine');
  else missingFields.push('cuisine');

  // 5. Difficulty & Rating & Tags Check (Weight: 10)
  if (recipe.difficulty) presentFields.push('difficulty');
  else missingFields.push('difficulty');

  if (recipe.rating) presentFields.push('rating');
  else missingFields.push('rating');

  const hasSpecificTags = recipe.tags && recipe.tags.length > 0 && !(recipe.tags.length === 1 && recipe.tags[0] === 'food/recipes');
  if (hasSpecificTags) presentFields.push('tags');
  else missingFields.push('tags');

  // 6. Recipe Core Completeness Check
  const hasIngredients = recipe.ingredients && recipe.ingredients.length > 0;
  const hasInstructions = recipe.instructions && recipe.instructions.length > 0;

  if (hasIngredients) presentFields.push('ingredients');
  if (hasInstructions) presentFields.push('instructions');

  // Calculate weighted score out of 100
  let score = 0;

  // Timings: up to 25 pts
  if (hasPrep && hasCook) score += 25;
  else if (hasPrep || hasCook || hasTotal) score += 15;

  // Servings: 20 pts
  if (hasServings) score += 20;

  // Nutrition: up to 20 pts
  if (hasCalories && hasNutritionObj) score += 20;
  else if (hasCalories || hasNutritionObj) score += 10;

  // Categorization: up to 15 pts
  if (hasCategory && hasCuisine) score += 15;
  else if (hasCategory || hasCuisine) score += 8;

  // Difficulty & Rating & Tags: up to 10 pts
  if (recipe.difficulty) score += 3;
  if (recipe.rating) score += 3;
  if (hasSpecificTags) score += 4;

  // Core structure: up to 10 pts
  if (hasIngredients) score += 5;
  if (hasInstructions) score += 5;

  // Determine health status
  let status: MetadataHealthStatus = 'complete';
  if (score >= 85) {
    status = 'complete';
  } else if (score >= 60) {
    status = 'mostly_complete';
  } else if (score >= 30) {
    status = 'incomplete';
  } else {
    status = 'legacy';
  }

  // If a recipe has minimal frontmatter (missing both timing and servings), classify as legacy
  if (!hasPrep && !hasCook && !hasTotal && !hasServings) {
    status = 'legacy';
    if (!legacyMarkers.includes('Legacy frontmatter format detected')) {
      legacyMarkers.push('Legacy frontmatter format detected');
    }
  }

  return {
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    fileName: recipe.fileName,
    status,
    healthScore: Math.min(100, Math.max(0, score)),
    missingFields,
    presentFields,
    legacyMarkers,
    totalFieldsCount: presentFields.length + missingFields.length,
  };
}

/**
 * Generates an aggregated summary of the metadata health across the entire recipe vault.
 */
export function summarizeVaultHealth(recipes: ObsidianRecipe[]): VaultHealthSummary {
  const reports = recipes.map(assessRecipeHealth);
  let completeCount = 0;
  let mostlyCompleteCount = 0;
  let incompleteCount = 0;
  let legacyCount = 0;
  let totalScore = 0;

  reports.forEach((report) => {
    totalScore += report.healthScore;
    if (report.status === 'complete') completeCount++;
    else if (report.status === 'mostly_complete') mostlyCompleteCount++;
    else if (report.status === 'incomplete') incompleteCount++;
    else if (report.status === 'legacy') legacyCount++;
  });

  const averageHealthScore = recipes.length > 0 ? Math.round(totalScore / recipes.length) : 100;

  return {
    totalRecipes: recipes.length,
    completeCount,
    mostlyCompleteCount,
    incompleteCount,
    legacyCount,
    averageHealthScore,
    reports,
  };
}

/**
 * Safely merges recovered metadata into an existing ObsidianRecipe note.
 * Crucially preserves unmanaged frontmatter (author, source, url, custom keys),
 * wikilinks, callouts, and body text.
 */
export function mergeRecoveredMetadata(
  original: ObsidianRecipe,
  recovered: RecoveredRecipeMetadata,
  acceptedFields: (keyof RecoveredRecipeMetadata)[]
): ObsidianRecipe {
  const updated: ObsidianRecipe = {
    ...original,
  };

  // Preserve and update existing frontmatter dictionary
  let frontmatter: Record<string, any> = {};
  let bodyContent = original.rawMarkdown;

  const fmMatch = original.rawMarkdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fmMatch) {
    try {
      const parsed = yamlLoad(fmMatch[1]);
      if (parsed && typeof parsed === 'object') {
        frontmatter = { ...parsed };
      }
    } catch (e) {
      console.warn('Failed to parse existing frontmatter during merge:', e);
    }
    bodyContent = original.rawMarkdown.slice(fmMatch[0].length);
  }

  // Merge selected fields
  for (const field of acceptedFields) {
    const item = recovered[field];
    if (!item || item.value === undefined || item.value === null) continue;

    switch (field) {
      case 'prepTime':
        if (typeof item.value === 'string' && item.value.trim()) {
          const norm = normalizeTimeString(item.value);
          updated.prepTime = norm;
          frontmatter.prep_time = norm;
        }
        break;

      case 'cookTime':
        if (typeof item.value === 'string' && item.value.trim()) {
          const norm = normalizeTimeString(item.value);
          updated.cookTime = norm;
          frontmatter.cook_time = norm;
        }
        break;

      case 'totalTime':
        if (typeof item.value === 'string' && item.value.trim()) {
          const norm = normalizeTimeString(item.value);
          updated.totalTime = norm;
          frontmatter.total_time = norm;
        }
        break;

      case 'servings':
        if (typeof item.value === 'number' && item.value > 0) {
          updated.servings = item.value;
          frontmatter.servings = item.value;
        }
        break;

      case 'calories':
        if (typeof item.value === 'number' && item.value > 0) {
          updated.calories = item.value;
          frontmatter.calories = item.value;
        }
        break;

      case 'nutrition':
        if (item.value && typeof item.value === 'object' && !Array.isArray(item.value)) {
          const nutr = item.value as RecipeNutrition;
          updated.nutrition = nutr;
          frontmatter.nutrition = nutr;
          if (nutr.calories && !frontmatter.calories) {
            frontmatter.calories = nutr.calories;
            updated.calories = nutr.calories;
          }
        }
        break;

      case 'category':
        if (typeof item.value === 'string' && item.value.trim()) {
          updated.category = item.value.trim();
          frontmatter.category = item.value.trim();
        }
        break;

      case 'cuisine':
        if (typeof item.value === 'string' && item.value.trim()) {
          updated.cuisine = item.value.trim();
          frontmatter.cuisine = item.value.trim();
        }
        break;

      case 'difficulty':
        if (typeof item.value === 'string' && ['Easy', 'Medium', 'Hard'].includes(item.value)) {
          updated.difficulty = item.value as 'Easy' | 'Medium' | 'Hard';
          frontmatter.difficulty = item.value;
        }
        break;

      case 'suggestedTags':
        if (Array.isArray(item.value) && item.value.length > 0) {
          const existingTags = Array.isArray(frontmatter.tags)
            ? frontmatter.tags
            : typeof frontmatter.tags === 'string'
            ? frontmatter.tags.split(',').map((t: string) => t.trim())
            : updated.tags || [];
          const mergedTags = Array.from(new Set([...existingTags, ...item.value]));
          updated.tags = mergedTags;
          frontmatter.tags = mergedTags;
        }
        break;
    }
  }

  // Ensure title is present in frontmatter
  if (!frontmatter.title) {
    frontmatter.title = updated.title;
  }

  // Serialize updated frontmatter
  const newYaml = yamlDump(frontmatter, { indent: 2, lineWidth: -1 }).trim();
  updated.rawMarkdown = `---\n${newYaml}\n---\n${bodyContent}`;

  return updated;
}
