/**
 * The Kitchen Codex — Recipe Validation & Normalization Engine
 */

import {
  CanonicalRecipe,
  CURRENT_RECIPE_SCHEMA_VERSION,
  RecipeDifficulty,
  StructuredIngredient,
  StructuredStep,
  RecipeTimings,
  RecipeMetadata,
  RecipeIdentity,
} from './recipeSchema';

export interface ValidationIssue {
  field: string;
  message: string;
  critical: boolean;
}

export interface ValidationResult<T> {
  isValid: boolean;
  data?: T;
  issues: ValidationIssue[];
}

/**
 * Standard culinary unit mapping
 */
const KNOWN_UNITS: Record<string, string> = {
  tbsp: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  tbs: 'tbsp',
  t: 'tsp',
  tsp: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  cup: 'cup',
  cups: 'cup',
  c: 'cup',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  fl_oz: 'fl oz',
  'fl oz': 'fl oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',
  pinch: 'pinch',
  pinches: 'pinch',
  dash: 'dash',
  dashes: 'dash',
  clove: 'clove',
  cloves: 'clove',
  slice: 'slice',
  slices: 'slice',
  can: 'can',
  cans: 'can',
  package: 'package',
  pkg: 'package',
  bunch: 'bunch',
  bunches: 'bunch',
  stalk: 'stalk',
  stalks: 'stalk',
  sprig: 'sprig',
  sprigs: 'sprig',
  handful: 'handful',
  handfuls: 'handful',
  piece: 'piece',
  pieces: 'piece',
  portion: 'portion',
  portions: 'portion',
};

/**
 * Parses unicode or ASCII fraction string into a decimal float.
 */
export function parseFraction(str: string): number | null {
  if (!str || typeof str !== 'string') return null;
  const clean = str.trim();
  if (!clean) return null;

  // Unicode fraction map
  const unicodeMap: Record<string, number> = {
    '½': 0.5,
    '⅓': 1 / 3,
    '⅔': 2 / 3,
    '¼': 0.25,
    '¾': 0.75,
    '⅛': 0.125,
    '⅜': 0.375,
    '⅝': 0.625,
    '⅞': 0.875,
  };

  // Mixed integer with unicode fraction (e.g. "1 ½")
  const mixedUnicode = clean.match(/^(\d+)\s*([½⅓⅔¼¾⅛⅜⅝⅞])$/);
  if (mixedUnicode) {
    const whole = parseInt(mixedUnicode[1], 10);
    const frac = unicodeMap[mixedUnicode[2]] || 0;
    return whole + frac;
  }

  // Pure unicode fraction (e.g. "½")
  if (unicodeMap[clean] !== undefined) {
    return unicodeMap[clean];
  }

  // Mixed ASCII fraction (e.g. "1 1/2" or "1-1/2")
  const mixedAscii = clean.match(/^(\d+)[\s-]+(\d+)\/(\d+)$/);
  if (mixedAscii) {
    const whole = parseInt(mixedAscii[1], 10);
    const num = parseInt(mixedAscii[2], 10);
    const den = parseInt(mixedAscii[3], 10);
    return den !== 0 ? whole + num / den : null;
  }

  // Standard fraction (e.g. "3/4")
  const standardAscii = clean.match(/^(\d+)\/(\d+)$/);
  if (standardAscii) {
    const num = parseInt(standardAscii[1], 10);
    const den = parseInt(standardAscii[2], 10);
    return den !== 0 ? num / den : null;
  }

  // Simple float or integer
  const num = parseFloat(clean);
  return !isNaN(num) && isFinite(num) ? num : null;
}

/**
 * Parses duration strings into integer minutes.
 * Handles: "1 hr 30 mins", "45 mins", "1.5 hours", "90", "15-20 min"
 */
export function parseDurationToMinutes(duration: string | number | null | undefined): number | null {
  if (duration === null || duration === undefined) return null;
  if (typeof duration === 'number') {
    return isNaN(duration) || duration < 0 ? null : Math.round(duration);
  }

  const clean = duration.trim().toLowerCase();
  if (!clean) return null;

  // Pure numeric string
  if (/^\d+$/.test(clean)) {
    return parseInt(clean, 10);
  }

  let totalMinutes = 0;
  let matched = false;

  // Hours and minutes (e.g. "1 hr 30 mins", "2 hours 15 min", "1h30m", "1h 30m")
  const hoursMinutesMatch = clean.match(
    /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?![a-z])(?:\s*(?:and\s*)?(\d+)\s*(?:minutes?|mins?|m)?(?![a-z]))?/i
  );
  if (hoursMinutesMatch && hoursMinutesMatch[1]) {
    const hours = parseFloat(hoursMinutesMatch[1]);
    const mins = hoursMinutesMatch[2] ? parseInt(hoursMinutesMatch[2], 10) : 0;
    if (!isNaN(hours)) {
      totalMinutes += Math.round(hours * 60) + (isNaN(mins) ? 0 : mins);
      matched = true;
    }
  } else {
    // Only minutes (e.g. "45 mins", "30m", "15-20 minutes")
    const minutesRangeMatch = clean.match(/(\d+)(?:\s*-\s*\d+)?\s*(?:minutes?|mins?|m)\b/i);
    if (minutesRangeMatch) {
      const mins = parseInt(minutesRangeMatch[1], 10);
      if (!isNaN(mins)) {
        totalMinutes += mins;
        matched = true;
      }
    }
  }

  if (!matched) {
    // Check if simple decimal hours like "1.5 hrs"
    const simpleHours = clean.match(/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)$/i);
    if (simpleHours) {
      const h = parseFloat(simpleHours[1]);
      if (!isNaN(h)) return Math.round(h * 60);
    }
  }

  return matched && totalMinutes >= 0 ? totalMinutes : null;
}

/**
 * Formats integer minutes into standard human-readable display string.
 */
export function formatMinutesToDisplay(minutes: number | null | undefined): string | undefined {
  if (minutes === null || minutes === undefined || isNaN(minutes) || minutes <= 0) {
    return undefined;
  }

  if (minutes < 60) {
    return `${minutes} mins`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;

  if (remainingMins === 0) {
    return hours === 1 ? '1 hr' : `${hours} hrs`;
  }

  return `${hours} hr${hours > 1 ? 's' : ''} ${remainingMins} min${remainingMins > 1 ? 's' : ''}`;
}

/**
 * Normalizes raw string tags into a clean array of lowercase tags.
 */
export function normalizeTags(tags: unknown): string[] {
  if (!tags) return [];
  const rawList: string[] = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,;\s]+/) : [];

  const resultSet = new Set<string>();
  for (const item of rawList) {
    if (typeof item !== 'string') continue;
    const clean = item.replace(/^#+/, '').trim().toLowerCase();
    if (clean.length > 0) {
      resultSet.add(clean);
    }
  }

  return Array.from(resultSet);
}

/**
 * Normalizes cooking difficulty level.
 */
export function normalizeDifficulty(diff: unknown): RecipeDifficulty {
  if (typeof diff !== 'string') return 'Unspecified';
  const clean = diff.trim().toLowerCase();
  if (clean === 'easy' || clean === 'beginner') return 'Easy';
  if (clean === 'medium' || clean === 'intermediate' || clean === 'moderate') return 'Medium';
  if (clean === 'hard' || clean === 'advanced' || clean === 'expert') return 'Hard';
  return 'Unspecified';
}

/**
 * Normalizes user rating to 0-5 integer.
 */
export function normalizeRating(rating: unknown): number {
  if (typeof rating === 'number') {
    return Math.max(0, Math.min(5, Math.round(rating)));
  }
  if (typeof rating === 'string') {
    const parsed = parseInt(rating, 10);
    return isNaN(parsed) ? 0 : Math.max(0, Math.min(5, parsed));
  }
  return 0;
}

/**
 * Normalizes an ingredient into the structured format.
 */
export function normalizeIngredient(
  input: string | Partial<StructuredIngredient>
): StructuredIngredient {
  if (typeof input === 'object' && input !== null && 'raw' in input && input.raw) {
    const raw = String(input.raw);
    const amount = input.amount !== undefined ? input.amount : null;
    return {
      raw,
      amount,
      amountDisplay: input.amountDisplay || (amount !== null ? String(amount) : undefined),
      unit: input.unit ? input.unit.toLowerCase() : undefined,
      name: input.name || raw,
      preparation: input.preparation,
      wikilink: input.wikilink,
      wikilinkTarget: input.wikilinkTarget,
      wikilinkAlias: input.wikilinkAlias,
      optional: Boolean(input.optional),
      isChecked: Boolean(input.isChecked),
    };
  }

  const rawLine = typeof input === 'string' ? input : String((input as any)?.original || (input as any)?.name || '');
  const cleanLine = rawLine.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();

  // Extract wikilink if present
  let wikilink: string | undefined;
  let wikilinkTarget: string | undefined;
  let wikilinkAlias: string | undefined;

  const linkMatch = cleanLine.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (linkMatch) {
    wikilink = linkMatch[0];
    wikilinkTarget = linkMatch[1].trim();
    wikilinkAlias = linkMatch[2] ? linkMatch[2].trim() : undefined;
  }

  // Parse amount, unit, and name
  let amount: number | null = null;
  let amountDisplay: string | undefined;
  let unit: string | undefined;
  let name = cleanLine;
  let preparation: string | undefined;

  // Check optional
  const optional = /\(optional\)/i.test(cleanLine);
  let workingLine = cleanLine.replace(/\(optional\)/gi, '').trim();

  // Extract amount pattern (fractions, mixed numbers, decimals, ranges)
  const amountMatch = workingLine.match(/^([\d½⅓⅔¼¾⅛⅜⅝⅞]+(?:\s*[\d/½⅓⅔¼¾⅛⅜⅝⅞]+)?(?:\s*-\s*[\d/½⅓⅔¼¾⅛⅜⅝⅞]+)?)\s*/);
  if (amountMatch) {
    const rawAmount = amountMatch[1].trim();
    amount = parseFraction(rawAmount);
    amountDisplay = rawAmount;
    workingLine = workingLine.slice(amountMatch[0].length).trim();
  }

  // Check unit
  const words = workingLine.split(/\s+/);
  if (words.length > 0) {
    const potentialUnit = words[0].toLowerCase().replace(/[.,]$/, '');
    if (KNOWN_UNITS[potentialUnit]) {
      unit = KNOWN_UNITS[potentialUnit];
      workingLine = words.slice(1).join(' ').trim();
    }
  }

  // Extract preparation modifier after comma (e.g. "yellow onion, diced")
  const prepIndex = workingLine.indexOf(',');
  if (prepIndex !== -1) {
    preparation = workingLine.slice(prepIndex + 1).trim();
    workingLine = workingLine.slice(0, prepIndex).trim();
  }

  name = workingLine || cleanLine;

  return {
    raw: rawLine,
    amount,
    amountDisplay,
    unit,
    name,
    preparation,
    wikilink,
    wikilinkTarget,
    wikilinkAlias,
    optional,
    isChecked: /^[-*+]\s*\[[xX]\]/.test(rawLine),
  };
}

/**
 * Validates a CanonicalRecipe object against Schema v1.
 */
export function validateCanonicalRecipe(data: unknown): ValidationResult<CanonicalRecipe> {
  const issues: ValidationIssue[] = [];

  if (!data || typeof data !== 'object') {
    return {
      isValid: false,
      issues: [{ field: 'root', message: 'Recipe must be a non-null object', critical: true }],
    };
  }

  const r = data as Partial<CanonicalRecipe>;

  if (!r.identity?.id) {
    issues.push({ field: 'identity.id', message: 'Recipe ID is required', critical: true });
  }

  if (!r.identity?.title || !r.identity.title.trim()) {
    issues.push({ field: 'identity.title', message: 'Recipe title is required', critical: true });
  }

  if (!r.identity?.fileName) {
    issues.push({ field: 'identity.fileName', message: 'Recipe fileName is required', critical: false });
  }

  if (!Array.isArray(r.ingredients)) {
    issues.push({ field: 'ingredients', message: 'Ingredients must be an array', critical: true });
  }

  if (!Array.isArray(r.instructions)) {
    issues.push({ field: 'instructions', message: 'Instructions must be an array', critical: true });
  }

  const criticalIssues = issues.filter((i) => i.critical);

  return {
    isValid: criticalIssues.length === 0,
    data: criticalIssues.length === 0 ? (r as CanonicalRecipe) : undefined,
    issues,
  };
}

export type NormalizeRecipeInput = Omit<Partial<CanonicalRecipe>, 'ingredients' | 'instructions'> & {
  title?: string;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  category?: string;
  cuisine?: string;
  servings?: number | null;
  difficulty?: string;
  rating?: number;
  ingredients?: Array<string | Partial<StructuredIngredient> | any>;
  instructions?: Array<string | Partial<StructuredStep> | any>;
};

/**
 * Normalizes any recipe-like object into a complete, conforming CanonicalRecipe.
 */
export function normalizeCanonicalRecipe(
  input: NormalizeRecipeInput
): CanonicalRecipe {
  const title = (input.identity?.title || input.title || 'Untitled Recipe').trim();
  const fileName = input.identity?.fileName || `${title.replace(/[/\\?%*:|"<>]/g, '') || 'recipe'}.md`;
  const filePath = input.identity?.filePath || fileName;
  const id = input.identity?.id || `recipe-${fileName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  // Timings normalization
  const prepMinutes = input.timings?.prepMinutes ?? parseDurationToMinutes(input.prepTime);
  const cookMinutes = input.timings?.cookMinutes ?? parseDurationToMinutes(input.cookTime);
  const totalMinutes =
    input.timings?.totalMinutes ??
    parseDurationToMinutes(input.totalTime) ??
    (prepMinutes !== null || cookMinutes !== null ? (prepMinutes || 0) + (cookMinutes || 0) : null);

  const timings: RecipeTimings = {
    prepMinutes,
    cookMinutes,
    totalMinutes,
    prepTimeDisplay: input.timings?.prepTimeDisplay || formatMinutesToDisplay(prepMinutes),
    cookTimeDisplay: input.timings?.cookTimeDisplay || formatMinutesToDisplay(cookMinutes),
    totalTimeDisplay: input.timings?.totalTimeDisplay || formatMinutesToDisplay(totalMinutes),
  };

  // Metadata normalization
  const metadata: RecipeMetadata = {
    tags: normalizeTags(input.metadata?.tags ?? (input as any).tags),
    category: input.metadata?.category || input.category || 'General',
    cuisine: input.metadata?.cuisine || input.cuisine || 'International',
    course: input.metadata?.course || (input as any).course,
    difficulty: normalizeDifficulty(input.metadata?.difficulty || input.difficulty),
    rating: normalizeRating(input.metadata?.rating ?? input.rating),
    isFavorite: Boolean(input.metadata?.isFavorite ?? (input as any).isFavorite),
    servings: typeof input.metadata?.servings === 'number' ? input.metadata.servings : typeof input.servings === 'number' ? input.servings : null,
    yieldUnit: input.metadata?.yieldUnit || 'servings',
    image: input.metadata?.image || (input as any).image,
  };

  const identity: RecipeIdentity = {
    id,
    title,
    fileName,
    filePath,
    sourceUrl: input.identity?.sourceUrl || (input as any).source,
    author: input.identity?.author || (input as any).author,
    createdAt: input.identity?.createdAt,
    updatedAt: input.identity?.updatedAt || (input as any).lastModified,
  };

  // Ingredients normalization
  const rawIngredients = input.ingredients || [];
  const ingredients: StructuredIngredient[] = rawIngredients.map((ing) => normalizeIngredient(ing));

  // Instructions normalization
  const rawInstructions = input.instructions || [];
  const instructions: StructuredStep[] = rawInstructions.map((step, idx) => {
    if (typeof step === 'string') {
      return {
        stepNumber: idx + 1,
        text: step,
        isCompleted: false,
      };
    }
    return {
      stepNumber: typeof step?.stepNumber === 'number' ? step.stepNumber : idx + 1,
      text: step?.text || String(step || ''),
      timerMinutes: step?.timerMinutes ?? null,
      timerLabel: step?.timerLabel,
      callouts: step?.callouts || [],
      isCompleted: Boolean(step?.isCompleted),
    };
  });

  return {
    schemaVersion: CURRENT_RECIPE_SCHEMA_VERSION,
    identity,
    metadata,
    timings,
    ingredients,
    instructions,
    nutrition: input.nutrition,
    notes: input.notes || '',
    callouts: input.callouts || [],
    dataviewFields: input.dataviewFields || {},
    wikilinks: input.wikilinks || [],
    rawMarkdown: input.rawMarkdown || '',
  };
}
