import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import {
  ObsidianRecipe,
  ParsedIngredient,
  RecipeStep,
  ObsidianCallout,
  MealPlanDay,
  ShoppingCategoryGroup,
  RecipeNutrition,
  VaultNote,
} from '../types';
import { getRecipeImage } from './imageHelper';
import { obsidianToCanonicalRecipe, canonicalToObsidianRecipe } from '../schema/legacyAdapter';
import { parseFraction } from '../schema/recipeValidator';

/**
 * Parses fraction strings (e.g., "1 1/2", "3/4", "0.5", "½", "1 ½") into decimal numbers.
 *
 * This is a shared, single implementation of fraction parsing. The real parser
 * lives in `schema/recipeValidator.ts` (`parseFraction`), which already handles
 * unicode fractions, mixed numbers, hyphenated mixed numbers ("1-1/2"), and
 * finite-number guards. It is a strict superset of the historical local logic,
 * so delegating here removes a duplicated parser without changing behavior for
 * any already-correct input (and fixes "1-1/2", which previously degraded to 1).
 */
export function parseFractionToDecimal(str: string): number | null {
  return parseFraction(str);
}

/**
 * Converts decimal number into nice fraction or rounded decimal for display
 */
export function formatAmount(val: number): string {
  if (val <= 0) return '';
  
  const whole = Math.floor(val);
  const frac = val - whole;
  
  // Test common cooking fractions with tolerance
  const fractions: [number, string][] = [
    [1 / 8, '1/8'],
    [1 / 4, '1/4'],
    [1 / 3, '1/3'],
    [3 / 8, '3/8'],
    [1 / 2, '1/2'],
    [5 / 8, '5/8'],
    [2 / 3, '2/3'],
    [3 / 4, '3/4'],
    [7 / 8, '7/8'],
  ];

  // Close to integer
  if (Math.abs(frac) < 0.025) {
    return whole.toString();
  }
  if (Math.abs(frac - 1) < 0.025) {
    return (whole + 1).toString();
  }

  for (const [fracVal, str] of fractions) {
    if (Math.abs(frac - fracVal) < 0.035) {
      return whole > 0 ? `${whole} ${str}` : str;
    }
  }

  const rounded = Math.round(val * 100) / 100;
  return rounded.toString();
}

/**
 * Strips any hyperlinks, wikilinks [[...]], markdown tags, or URL formatting
 * so that only the clean recipe title name is returned.
 */
export function cleanRecipeTitle(raw: any, fileName?: string): string {
  let title = typeof raw === 'string' ? raw.trim() : '';
  if (!title && fileName) {
    title = fileName.replace(/\.md$/i, '').trim();
  }
  if (!title) {
    return 'Untitled Recipe';
  }

  // 1. Strip Markdown links: [Recipe Name](https://...) -> Recipe Name
  title = title.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 2. Strip Wikilinks: [[Recipe Name|Alias]] -> Alias or [[Recipe Name]] -> Recipe Name
  title = title.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => (alias || target).trim());

  // 3. Strip standalone brackets if any remain
  title = title.replace(/[\[\]]/g, '');

  // 4. Strip HTML tags
  title = title.replace(/<[^>]+>/g, '');

  // 5. Strip raw URLs if title is just a URL
  title = title.replace(/^https?:\/\/[^\s]+$/i, (url) => {
    try {
      const parsed = new URL(url);
      const lastSeg = parsed.pathname.split('/').filter(Boolean).pop();
      return lastSeg ? decodeURIComponent(lastSeg).replace(/[-_]/g, ' ') : 'Recipe';
    } catch {
      return 'Recipe';
    }
  });

  // 6. Strip markdown headings (# Title -> Title) or formatting (*Title* -> Title)
  title = title.replace(/^#+\s*/, '');
  title = title.replace(/[*_~`]/g, '');

  // 7. Strip trailing .md
  title = title.replace(/\.md$/i, '');

  return title.trim() || 'Untitled Recipe';
}

/**
 * Helper to find field value across multiple potential keys in an object (case-insensitive, ignoring underscores and hyphens)
 */
function findFlexibleKey(obj: Record<string, any>, candidateKeys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  
  const normalizedCandidateKeys = candidateKeys.map((k) => k.toLowerCase().replace(/[-_\s]/g, ''));
  
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') {
      const normalizedKey = key.toLowerCase().replace(/[-_\s]/g, '');
      if (normalizedCandidateKeys.includes(normalizedKey)) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Deletes alternate/redundant frontmatter keys that match alias variants of a canonical key,
 * preventing duplicate frontmatter fields (e.g. `prepTime:` and `prep_time:`).
 */
function cleanAlternateFrontmatterKeys(obj: Record<string, any>, canonicalKey: string, aliasKeys: string[]): void {
  if (!obj || typeof obj !== 'object') return;
  const normalizedAliases = aliasKeys.map((k) => k.toLowerCase().replace(/[-_\s]/g, ''));
  for (const key of Object.keys(obj)) {
    const normalizedKey = key.toLowerCase().replace(/[-_\s]/g, '');
    if (normalizedAliases.includes(normalizedKey) && key !== canonicalKey) {
      delete obj[key];
    }
  }
}

/**
 * Extracts a metadata string or number from Markdown body lines like:
 * - **Prep time:** 15 mins
 * - Cook: 30 minutes
 * - Yield: 4 servings
 */
function extractFromBodyRegex(content: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const val = match[1].trim().replace(/^[:\-–]\s*/, '').trim();
      if (val) return val;
    }
  }
  return undefined;
}

/**
 * Generates regexes that match Markdown-formatted timing lines with optional
 * markdown emphasis (bold/italic), optional list markers, optional colon inside/outside
 * emphasis, and optional spacing before/after colon.
 */
function buildTimingRegex(labelPattern: string): RegExp[] {
  return [
    // Variant 1: Colon inside bold/italic e.g. `**Prep:** 15 mins` or `- **Prep time:** 15 mins`
    new RegExp(
      `(?:^|\\n)\\s*(?:[-*•+]\\s+)?(?:\\*{1,2}|_{1,2})\\s*(?:${labelPattern})\\s*[:\\-–]\\s*(?:\\*{1,2}|_{1,2})\\s*([0-9]+[^\\n\\r,;|]+)`,
      'i'
    ),
    // Variant 2: Colon outside bold/italic or plain e.g. `Prep: 15 mins`, `**Prep**: 15 mins`, `**Prep** : 15 mins`, `- **Prep time** : 15 mins`
    new RegExp(
      `(?:^|\\n)\\s*(?:[-*•+]\\s+)?(?:\\*{1,2}|_{1,2})?\\s*(?:${labelPattern})\\s*(?:\\*{1,2}|_{1,2})?\\s*[:\\-–]\\s*([0-9]+[^\\n\\r,;|]+)`,
      'i'
    ),
  ];
}

/**
 * Extracts prep time accurately from frontmatter, dataview fields, or body text
 */
export function extractPrepTime(
  frontmatter: Record<string, any>,
  dataview: Record<string, string>,
  content: string
): string | undefined {
  const fmVal = findFlexibleKey(frontmatter, [
    'prep_time', 'prepTime', 'prep-time', 'prep', 'preptime',
    'preparation_time', 'preparation', 'prep_duration', 'preparationTime'
  ]);
  if (fmVal !== undefined) return String(fmVal).trim();

  const dvVal = findFlexibleKey(dataview, [
    'prep_time', 'prepTime', 'prep-time', 'prep', 'preptime',
    'preparation_time', 'preparation', 'prep_duration'
  ]);
  if (dvVal !== undefined) return String(dvVal).trim();

  const bodyVal = extractFromBodyRegex(
    content,
    buildTimingRegex('prep(?:\\s*time|\\s*duration)?|preparation(?:\\s*time)?')
  );
  if (bodyVal) return bodyVal;

  return undefined;
}

/**
 * Extracts cook time accurately from frontmatter, dataview fields, or body text
 */
export function extractCookTime(
  frontmatter: Record<string, any>,
  dataview: Record<string, string>,
  content: string
): string | undefined {
  const fmVal = findFlexibleKey(frontmatter, [
    'cook_time', 'cookTime', 'cook-time', 'cook', 'cooktime',
    'cooking_time', 'cooking', 'bake_time', 'bakeTime', 'bake-time', 'bake', 'cookingTime'
  ]);
  if (fmVal !== undefined) return String(fmVal).trim();

  const dvVal = findFlexibleKey(dataview, [
    'cook_time', 'cookTime', 'cook-time', 'cook', 'cooktime',
    'cooking_time', 'cooking', 'bake_time', 'bakeTime', 'bake'
  ]);
  if (dvVal !== undefined) return String(dvVal).trim();

  const bodyVal = extractFromBodyRegex(
    content,
    buildTimingRegex('cook(?:\\s*time|\\s*duration)?|cooking(?:\\s*time)?|bake(?:\\s*time)?')
  );
  if (bodyVal) return bodyVal;

  return undefined;
}

/**
 * Extracts total time accurately
 */
export function extractTotalTime(
  frontmatter: Record<string, any>,
  dataview: Record<string, string>,
  content: string
): string | undefined {
  const fmVal = findFlexibleKey(frontmatter, [
    'total_time', 'totalTime', 'total-time', 'total', 'time', 'ready_in', 'readyIn'
  ]);
  if (fmVal !== undefined) return String(fmVal).trim();

  const dvVal = findFlexibleKey(dataview, [
    'total_time', 'totalTime', 'total-time', 'total', 'time', 'ready_in'
  ]);
  if (dvVal !== undefined) return String(dvVal).trim();

  const bodyVal = extractFromBodyRegex(
    content,
    buildTimingRegex('total(?:\\s*time)?|ready\\s*in')
  );
  if (bodyVal) return bodyVal;

  return undefined;
}

/**
 * Extracts servings/yield accurately as a parsed integer
 */
export function extractServings(
  frontmatter: Record<string, any>,
  dataview: Record<string, string>,
  content: string
): number | undefined {
  const rawVal =
    findFlexibleKey(frontmatter, [
      'servings', 'serving', 'serves', 'yield', 'yields', 'portion', 'portions', 'makes'
    ]) ??
    findFlexibleKey(dataview, [
      'servings', 'serving', 'serves', 'yield', 'yields', 'portion', 'portions', 'makes'
    ]) ??
    extractFromBodyRegex(content, [
      /(?:^|\n)\s*[-*•]?\s*(?:\*{1,2}|_{1,2})?(?:servings?|yields?|serves|makes|portions?)\s*(?:\*{1,2}|_{1,2})?[:\-–]\s*([^\n\r,;|]+)/i
    ]);

  if (rawVal !== undefined && rawVal !== null && rawVal !== '') {
    if (typeof rawVal === 'number' && !isNaN(rawVal) && rawVal > 0) {
      return Math.round(rawVal);
    }
    const str = String(rawVal);
    const numMatch = str.match(/(\d+)/);
    if (numMatch) {
      const parsed = parseInt(numMatch[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }

  return undefined;
}

/**
 * Extracts calories accurately (number or string) without inventing values
 */
export function extractCalories(
  frontmatter: Record<string, any>,
  dataview: Record<string, string>,
  content: string
): string | number | undefined {
  const rawVal =
    findFlexibleKey(frontmatter, [
      'calories', 'calorie', 'kcal', 'energy', 'nutrition_calories', 'cal', 'calories_per_serving'
    ]) ??
    findFlexibleKey(dataview, [
      'calories', 'calorie', 'kcal', 'energy', 'cal'
    ]) ??
    extractFromBodyRegex(content, [
      /(?:^|\n)\s*[-*•]?\s*(?:\*{1,2}|_{1,2})?(?:calories?|kcal|energy)\s*(?:\*{1,2}|_{1,2})?[:\-–]\s*([^\n\r,;|]+)/i
    ]);

  if (rawVal !== undefined && rawVal !== null && rawVal !== '') {
    if (typeof rawVal === 'number' && !isNaN(rawVal)) {
      return rawVal;
    }
    const cleanStr = String(rawVal).replace(/kcal|cal/gi, '').trim();
    const num = parseInt(cleanStr, 10);
    if (!isNaN(num) && num > 0) {
      return num;
    }
    return String(rawVal).trim();
  }

  return undefined;
}

/**
 * Detects and parses an ingredient line
 */
export function parseIngredientLine(line: string): ParsedIngredient {
  const isChecked = /^[-*+]\s*\[[xX]\]/.test(line);
  const cleanLine = line.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();

  // Wikilink extraction: [[Ingredient Name]] or [[Ingredient/Path|Alias]]
  const wikilinkMatch = cleanLine.match(/\[\[(.*?)\]\]/);
  const wikilink = wikilinkMatch ? wikilinkMatch[1].trim() : undefined;
  let wikilinkTarget: string | undefined = undefined;
  let wikilinkAlias: string | undefined = undefined;

  if (wikilink) {
    if (wikilink.includes('|')) {
      const parts = wikilink.split('|');
      wikilinkTarget = parts[0].trim();
      const alias = parts.slice(1).join('|').trim();
      wikilinkAlias = alias && alias !== wikilinkTarget ? alias : undefined;
    } else {
      wikilinkTarget = wikilink;
      wikilinkAlias = undefined;
    }
  }

  // Common units regex
  const units = '(?:tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|cup|cups|oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|kilogram|kilograms|ml|milliliter|milliliters|l|liter|liters|clove|cloves|pinch|pinches|dash|dashes|slice|slices|can|cans|stalk|stalks|bunch|bunches|sprig|sprigs|piece|pieces|head|heads|handful|handfuls)';
  
  // Regex to capture (amount) (unit)? (name)
  const regex = new RegExp(`^(?:(\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+\\s*[½⅓⅔¼¾⅛⅜⅝⅞]|[½⅓⅔¼¾⅛⅜⅝⅞]|\\d+(?:\\.\\d+)?))\\s*(${units})?\\s*(?:of\\s+)?(.*)$`, 'i');
  const match = cleanLine.match(regex);

  if (match) {
    const rawAmount = match[1];
    const unit = match[2] || '';
    const name = match[3].trim();
    const amountDec = parseFractionToDecimal(rawAmount);

    return {
      original: cleanLine,
      amount: amountDec,
      unit: unit.toLowerCase(),
      name: name || cleanLine,
      wikilink,
      wikilinkTarget,
      wikilinkAlias,
      isChecked,
    };
  }

  return {
    original: cleanLine,
    amount: null,
    unit: '',
    name: cleanLine,
    wikilink,
    wikilinkTarget,
    wikilinkAlias,
    isChecked,
  };
}

/**
 * Conservative singularization for KNOWN cooking units only. This is applied
 * only when the scaled amount is exactly 1 and the token is a recognized unit,
 * so it can never alter the meaning of an ingredient noun (e.g. we deliberately
 * do not touch "eggs", "oats", "greens", etc.).
 */
const SINGULAR_UNIT: Record<string, string> = {
  tablespoons: 'tablespoon',
  teaspoons: 'teaspoon',
  cups: 'cup',
  ounces: 'ounce',
  pounds: 'pound',
  grams: 'gram',
  kilograms: 'kilogram',
  milliliters: 'milliliter',
  liters: 'liter',
  cloves: 'clove',
  pinches: 'pinch',
  dashes: 'dash',
  slices: 'slice',
  cans: 'can',
  stalks: 'stalk',
  bunches: 'bunch',
  sprigs: 'sprig',
  pieces: 'piece',
  heads: 'head',
  handfuls: 'handful',
};

/**
 * Rescales an ingredient string by ratio (targetServings / currentServings)
 */
export function scaleIngredientText(
  originalText: string,
  currentServings: number,
  targetServings: number
): string {
  if (!currentServings || !targetServings || currentServings === targetServings) {
    return originalText;
  }

  const ratio = targetServings / currentServings;

  // Replace quantities in the beginning or middle.
  // The unit is matched with a REQUIRED leading whitespace so that when there is
  // no unit (e.g. "2 eggs", "4 chicken breasts") the trailing space is left in
  // the remaining text, preserving correct spacing. Previously this consumed the
  // space and produced "1eggs" / "2chicken breasts".
  const units = '(?:tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|cup|cups|oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|kilogram|kilograms|ml|milliliter|milliliters|l|liter|liters|clove|cloves|pinch|pinches|dash|dashes|slice|slices|can|cans|stalk|stalks|bunch|bunches|sprig|sprigs|piece|pieces|head|heads|handful|handfuls)';
  // A trailing \b after the unit prevents the alternation from matching only a
  // singular prefix of a plural unit (e.g. "cup" inside "cups"), which would
  // otherwise leave a stray "s" and defeat singularization.
  const regex = new RegExp(`(\\b\\d+\\s+\\d+\\/\\d+|\\b\\d+\\/\\d+|\\b\\d+\\s*[½⅓⅔¼¾⅛⅜⅝⅞]|[½⅓⅔¼¾⅛⅜⅝⅞]|\\b\\d+(?:\\.\\d+)?)(?:\\s+(${units})\\b)?`, 'gi');

  const scaled = originalText.replace(regex, (match, amountStr, unitStr) => {
    const dec = parseFractionToDecimal(amountStr);
    if (dec !== null && dec > 0) {
      const newAmount = dec * ratio;
      const formatted = formatAmount(newAmount);
      // Singularize a known unit only when the result is exactly "1".
      const unit =
        unitStr && formatted === '1' && SINGULAR_UNIT[unitStr.toLowerCase()]
          ? SINGULAR_UNIT[unitStr.toLowerCase()]
          : unitStr;
      return unit ? `${formatted} ${unit}` : formatted;
    }
    return match;
  });

  return scaled;
}

/**
 * Extracts cooking timer minutes from instruction text
 * E.g., "Simmer for 20 minutes", "Bake for 1 hour", "Rest for 10-15 mins"
 */
export function extractTimerMinutes(text: string): number | null {
  // Matches "20 minutes", "1.5 hours", "45 mins", "1 hour 30 minutes", "15-20 min"
  const hourMinMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)\s*(?:and\s*)?(\d+)?\s*(?:minutes|minute|mins|min)?/i);
  if (hourMinMatch) {
    const hrs = parseFloat(hourMinMatch[1]) || 0;
    const mins = hourMinMatch[2] ? parseInt(hourMinMatch[2], 10) : 0;
    const total = Math.round(hrs * 60 + mins);
    if (total > 0 && total <= 600) return total;
  }

  const rangeMatch = text.match(/(?:for|about|approx\.?|cook|bake|simmer|roast|fry|rest|boil|chill)\s*(?:about\s*)?(\d+)\s*(?:-|to)\s*(\d+)\s*(?:minutes|minute|mins|min)/i);
  if (rangeMatch) {
    return parseInt(rangeMatch[2], 10); // pick the upper range or average
  }

  const minMatch = text.match(/(\d+)\s*(?:minutes|minute|mins|min)\b/i);
  if (minMatch) {
    const mins = parseInt(minMatch[1], 10);
    if (mins > 0 && mins <= 480) return mins;
  }

  return null;
}

/**
 * Parses full Obsidian Markdown Recipe note into structured ObsidianRecipe
 */
export function parseObsidianRecipeMarkdown(
  rawMarkdown: string,
  fileName: string = 'Untitled Recipe.md',
  filePath: string = '6 - Full Notes/Food/Recipes/Untitled Recipe.md',
  fileHandle?: any
): ObsidianRecipe {
  let frontmatter: Record<string, any> = {};
  let content = rawMarkdown;

  // 1. Extract YAML Frontmatter
  const fmMatch = rawMarkdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fmMatch) {
    try {
      const parsedYaml = yamlLoad(fmMatch[1]);
      if (typeof parsedYaml === 'object' && parsedYaml !== null) {
        frontmatter = parsedYaml as Record<string, any>;
      }
    } catch (e) {
      console.warn('YAML parsing error in recipe note:', e);
    }
    content = rawMarkdown.slice(fmMatch[0].length);
  }

  // 2. Extract Dataview inline fields like `[prep_time:: 15m]` or `cook_time:: 20 mins`
  const dataviewFields: Record<string, string> = {};
  const dvRegex = /\[?([a-zA-Z0-9_-]+)::\s*([^\]\n]+)\]?/g;
  let dvMatch;
  while ((dvMatch = dvRegex.exec(content)) !== null) {
    const key = dvMatch[1].trim();
    const val = dvMatch[2].trim();
    dataviewFields[key] = val;
  }

  // 3. Extract Wikilinks
  const wikilinks: string[] = [];
  const wlRegex = /\[\[(.*?)\]\]/g;
  let wlMatch;
  while ((wlMatch = wlRegex.exec(rawMarkdown)) !== null) {
    const link = wlMatch[1].split('|')[0].trim();
    if (link && !wikilinks.includes(link)) {
      wikilinks.push(link);
    }
  }

  // 4. Extract Callouts `> [!tip] Title\n> Content`
  const callouts: ObsidianCallout[] = [];
  const calloutRegex = /^>\s*\[!([a-zA-Z]+)\]\s*([^\n]*)\n((?:>[^\n]*\n?)*)/gm;
  let coMatch;
  while ((coMatch = calloutRegex.exec(content)) !== null) {
    const type = (coMatch[1].toLowerCase() as any) || 'note';
    const title = coMatch[2].trim();
    const body = coMatch[3]
      .split('\n')
      .map((l) => l.replace(/^>\s?/, ''))
      .join('\n')
      .trim();
    callouts.push({
      type: ['tip', 'warning', 'info', 'note', 'quote', 'important'].includes(type) ? type : 'tip',
      title: title || undefined,
      content: body,
    });
  }

  // 5. Title Extraction (Show strictly the clean recipe name, no hyperlinks or wikilinks)
  let rawTitle = frontmatter.title || frontmatter.name;
  if (!rawTitle) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      rawTitle = h1Match[1].trim();
    } else {
      rawTitle = fileName;
    }
  }
  const title = cleanRecipeTitle(rawTitle, fileName);

  // 6. Tags Extraction
  let rawTags: any[] = [];
  if (Array.isArray(frontmatter.tags)) {
    rawTags = frontmatter.tags;
  } else if (typeof frontmatter.tags === 'string') {
    rawTags = frontmatter.tags.split(',').map((t) => t.trim());
  } else if (frontmatter.tag) {
    rawTags = Array.isArray(frontmatter.tag) ? frontmatter.tag : [frontmatter.tag];
  }
  // Also find inline hashtags `#food/recipes` or `#italian`
  const hashtagRegex = /(?:^|\s)#([a-zA-Z0-9_\-\/]+)/g;
  let htMatch;
  while ((htMatch = hashtagRegex.exec(content)) !== null) {
    const tag = htMatch[1];
    if (tag && !rawTags.includes(tag)) {
      rawTags.push(tag);
    }
  }
  const tags = Array.from(new Set(rawTags.map((t) => String(t).replace(/^#/, '').trim()))).filter(Boolean);

  // 7. Cuisine & Category (Case-insensitive lookup across frontmatter and dataview inline fields)
  const cuisine = findFlexibleKey(frontmatter, ['cuisine']) || findFlexibleKey(dataviewFields, ['cuisine']) || 'General';
  const category = findFlexibleKey(frontmatter, ['category', 'course']) || findFlexibleKey(dataviewFields, ['category', 'course']) || 'Main Course';

  // 8. Timings, Servings & Calories (Strict extraction without fake fallback values)
  const prepTime = extractPrepTime(frontmatter, dataviewFields, content);
  const cookTime = extractCookTime(frontmatter, dataviewFields, content);
  const totalTime = extractTotalTime(frontmatter, dataviewFields, content);
  const servings = extractServings(frontmatter, dataviewFields, content);
  const calories = extractCalories(frontmatter, dataviewFields, content);

  // Nutrition parsing (frontmatter.nutrition or top-level macro fields)
  let nutrition: RecipeNutrition | undefined = undefined;
  if (frontmatter.nutrition && typeof frontmatter.nutrition === 'object') {
    const fn = frontmatter.nutrition;
    const numCal = typeof fn.calories === 'number' ? fn.calories : typeof fn.calories === 'string' ? parseFloat(fn.calories) : undefined;
    const numProt = typeof fn.protein === 'number' ? fn.protein : typeof fn.protein === 'string' ? parseFloat(fn.protein) : undefined;
    const numCarb = typeof fn.carbohydrates === 'number' ? fn.carbohydrates : typeof fn.carbs === 'number' ? fn.carbs : typeof fn.carbohydrates === 'string' ? parseFloat(fn.carbohydrates) : typeof fn.carbs === 'string' ? parseFloat(fn.carbs) : undefined;
    const numFat = typeof fn.fat === 'number' ? fn.fat : typeof fn.fat === 'string' ? parseFloat(fn.fat) : undefined;
    const numFiber = typeof fn.fiber === 'number' ? fn.fiber : typeof fn.fiber === 'string' ? parseFloat(fn.fiber) : undefined;
    const numSodium = typeof fn.sodium === 'number' ? fn.sodium : typeof fn.sodium === 'string' ? parseFloat(fn.sodium) : undefined;
    const numServings = typeof fn.servings === 'number' ? fn.servings : typeof fn.servings === 'string' ? parseFloat(fn.servings) : undefined;
    const confNote = typeof fn.confidenceNote === 'string' ? fn.confidenceNote : undefined;

    if (numCal !== undefined || numProt !== undefined || numCarb !== undefined || numFat !== undefined || numFiber !== undefined || numSodium !== undefined) {
      nutrition = {
        calories: numCal ?? (typeof calories === 'number' ? calories : typeof calories === 'string' ? parseFloat(calories) : undefined),
        protein: numProt,
        carbohydrates: numCarb,
        fat: numFat,
        fiber: numFiber,
        sodium: numSodium,
        servings: numServings,
        confidenceNote: confNote,
      };
    }
  } else if (frontmatter.protein || frontmatter.carbs || frontmatter.carbohydrates || frontmatter.fat || frontmatter.fiber || frontmatter.sodium) {
    nutrition = {
      calories: typeof calories === 'number' ? calories : typeof calories === 'string' ? parseFloat(calories) : undefined,
      protein: typeof frontmatter.protein === 'number' ? frontmatter.protein : typeof frontmatter.protein === 'string' ? parseFloat(frontmatter.protein) : undefined,
      carbohydrates: typeof frontmatter.carbohydrates === 'number' ? frontmatter.carbohydrates : typeof frontmatter.carbs === 'number' ? frontmatter.carbs : typeof frontmatter.carbs === 'string' ? parseFloat(frontmatter.carbs) : undefined,
      fat: typeof frontmatter.fat === 'number' ? frontmatter.fat : typeof frontmatter.fat === 'string' ? parseFloat(frontmatter.fat) : undefined,
      fiber: typeof frontmatter.fiber === 'number' ? frontmatter.fiber : typeof frontmatter.fiber === 'string' ? parseFloat(frontmatter.fiber) : undefined,
      sodium: typeof frontmatter.sodium === 'number' ? frontmatter.sodium : typeof frontmatter.sodium === 'string' ? parseFloat(frontmatter.sodium) : undefined,
    };
  }

  // 9. Difficulty & Rating & Source & Image (Case-insensitive lookup across frontmatter and dataview inline fields)
  const rawDifficulty = findFlexibleKey(frontmatter, ['difficulty']) || findFlexibleKey(dataviewFields, ['difficulty']);
  const difficulty = (rawDifficulty || 'Medium') as 'Easy' | 'Medium' | 'Hard';
  const rawRating = findFlexibleKey(frontmatter, ['rating']) ?? findFlexibleKey(dataviewFields, ['rating']);
  const rating =
    typeof rawRating === 'number'
      ? Math.min(5, Math.max(1, rawRating))
      : typeof rawRating === 'string'
      ? Math.min(5, Math.max(1, parseFloat(rawRating) || 5))
      : 5;
  const source = findFlexibleKey(frontmatter, ['source', 'url']) || findFlexibleKey(dataviewFields, ['source', 'url']);
  const rawImage =
    findFlexibleKey(frontmatter, ['image', 'cover', 'thumbnail', 'photo', 'heroImage', 'banner']) ||
    findFlexibleKey(dataviewFields, ['image', 'cover', 'thumbnail', 'photo', 'heroImage', 'banner']);

  let image: string | undefined = undefined;
  if (typeof rawImage === 'string' && rawImage.trim() && rawImage.trim() !== 'undefined' && rawImage.trim() !== 'null') {
    image = rawImage.trim();
  }

  // 10. Parse Ingredients & Instructions Sections & Freeform Intro Prose
  const ingredients: ParsedIngredient[] = [];
  const instructions: RecipeStep[] = [];
  let notes = '';
  const introLines: string[] = [];

  const lines = content.split('\n');
  let currentSection: 'header' | 'ingredients' | 'instructions' | 'notes' | 'other' = 'header';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^#{2,4}\s+(.+)$/);

    if (headerMatch) {
      const headerText = headerMatch[1].toLowerCase();
      if (headerText.includes('ingredient')) {
        currentSection = 'ingredients';
        continue;
      } else if (headerText.includes('instruction') || headerText.includes('direction') || headerText.includes('method') || headerText.includes('step')) {
        currentSection = 'instructions';
        continue;
      } else if (headerText.includes('note') || headerText.includes('variation') || headerText.includes('tip') || headerText.includes('storage')) {
        currentSection = 'notes';
        continue;
      }
    }

    if (currentSection === 'header') {
      // Skip H1 title line
      if (line.match(/^#\s+/)) continue;
      // Skip callout lines
      if (line.match(/^>\s*/)) continue;
      // Skip dataview inline field lines like `Key:: Value` or `[Key:: Value]`
      if (line.match(/^\s*\[?[a-zA-Z0-9_\-\s]+::\s*[^\]\n]+\]?\s*$/)) continue;
      // Skip standalone timing or metadata lines in body
      if (
        line.match(
          /^\s*[-*•+]?\s*(?:\*{1,2}|_{1,2})?\s*(?:prep|cook|total|ready\s*in|servings?|yields?|serves|makes|calories|difficulty|cuisine|category|rating)(?:\s*time|\s*duration)?\s*[:\-–]?\s*(?:\*{1,2}|_{1,2})?\s*[:\-–]/i
        )
      ) {
        continue;
      }
      // Skip markdown thematic breaks (horizontal rules)
      if (line.match(/^\s*[-*_]{3,}\s*$/)) continue;

      introLines.push(line);
    } else if (currentSection === 'ingredients') {
      if (line.match(/^[-*+]\s+/)) {
        ingredients.push(parseIngredientLine(line));
      }
    } else if (currentSection === 'instructions') {
      const stepMatch = line.match(/^(\d+)\.\s+(.+)$/);
      if (stepMatch) {
        const stepNum = parseInt(stepMatch[1], 10);
        const stepText = stepMatch[2].trim();
        const timerMinutes = extractTimerMinutes(stepText);
        instructions.push({
          stepNumber: stepNum,
          text: stepText,
          timerMinutes,
          isCompleted: false,
        });
      } else if (line.match(/^[-*+]\s+(.+)$/)) {
        const stepText = line.replace(/^[-*+]\s+/, '').trim();
        if (stepText) {
          instructions.push({
            stepNumber: instructions.length + 1,
            text: stepText,
            timerMinutes: extractTimerMinutes(stepText),
            isCompleted: false,
          });
        }
      }
    } else if (currentSection === 'notes') {
      if (!line.startsWith('> [!')) {
        notes += (notes ? '\n' : '') + line;
      }
    }
  }

  // Fallbacks if sections were not marked with explicit headers
  if (ingredients.length === 0) {
    const listLines = lines.filter((l) => l.match(/^[-*]\s+(\[[ xX]\]\s*)?\d/));
    listLines.forEach((l) => ingredients.push(parseIngredientLine(l)));
  }

  const id = filePath || fileName.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const rawParsedRecipe: ObsidianRecipe = {
    id,
    fileName,
    filePath,
    rawMarkdown,
    title,
    tags: tags.length > 0 ? tags : ['food/recipes'],
    category,
    cuisine,
    prepTime,
    cookTime,
    totalTime,
    servings,
    difficulty,
    rating,
    calories,
    nutrition,
    source,
    image,
    ingredients,
    instructions,
    description: introLines.join('\n').trim() || frontmatter.description || undefined,
    notes: notes.trim(),
    callouts,
    dataviewFields,
    wikilinks,
    frontmatter,
    lastModified: frontmatter.created || frontmatter.updated || frontmatter.date || undefined,
    fileHandle,
  };

  // Production Canonical Boundary (Load Path):
  // Convert through CanonicalRecipe to enforce Schema v1 normalization & validation
  // before delivering to the UI as an ObsidianRecipe.
  const canonical = obsidianToCanonicalRecipe(rawParsedRecipe);
  return canonicalToObsidianRecipe(canonical, fileHandle);
}

/**
 * Renders a single ingredient as a checklist line, preserving an intended Obsidian
 * wikilink when present (e.g. `[[Garlic]]` or `[[Garlic|Fresh Garlic]]`).
 * NOTE: Automatic wikilink generation is intentionally disabled. Plain ingredients remain plain.
 *
 * @param ing parsed ingredient with optional amount/unit/name/wikilink metadata
 * @param check `[ ]` or `[x]` checklist marker
 */
export function renderIngredientLine(
  ing: {
    original?: string;
    amount?: number | null;
    unit?: string;
    name?: string;
    wikilink?: string;
    wikilinkTarget?: string;
    wikilinkAlias?: string;
    isChecked?: boolean;
  },
  check: string = '[ ]'
): string {
  if (check === '[ ]' && ing.isChecked) {
    check = '[x]';
  }

  const original = (ing.original || '').trim();

  // If text has existing content, strip the checkbox marker prefix cleanly but PRESERVE wikilinks!
  if (original) {
    const text = original.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();
    if (text) {
      return `- ${check} ${text}`.trim();
    }
  }

  // Fall back to reconstructing from structured fields when original is empty.
  const amt = ing.amount != null ? `${formatAmount(ing.amount)} ` : '';
  const unit = ing.unit ? `${ing.unit} ` : '';
  let name = (ing.name || '').trim();

  // If structured wikilink properties exist and name does not already contain brackets, preserve them
  if (!name.includes('[[')) {
    if (ing.wikilinkTarget) {
      if (ing.wikilinkAlias && ing.wikilinkAlias !== ing.wikilinkTarget) {
        name = `[[${ing.wikilinkTarget}|${ing.wikilinkAlias}]]`;
      } else {
        name = `[[${ing.wikilinkTarget}]]`;
      }
    } else if (ing.wikilink) {
      name = ing.wikilink.startsWith('[[') ? ing.wikilink : `[[${ing.wikilink}]]`;
    }
  }

  return `- ${check} ${amt}${unit}${name}`.trim();
}

/**
 * Serializes an ObsidianRecipe into pristine Obsidian Markdown with YAML frontmatter.
 * Preserves custom/unknown frontmatter fields, Dataview inline fields, and exact wikilinks.
 */
export function serializeRecipeToObsidianMarkdown(recipe: Partial<ObsidianRecipe>): string {
  // Production Canonical Boundary (Save Path):
  // If the recipe has sufficient structure, normalize through Canonical Schema
  // before converting back to the Obsidian format for serialization.
  let recipeToSerialize = recipe;
  if (recipe.title || (recipe.ingredients && recipe.ingredients.length > 0)) {
    try {
      const canonical = obsidianToCanonicalRecipe(recipe as ObsidianRecipe);
      recipeToSerialize = canonicalToObsidianRecipe(canonical, recipe.fileHandle);
    } catch {
      recipeToSerialize = recipe;
    }
  }

  // Start with existing frontmatter if present to preserve user-authored custom fields
  const frontmatterObj: Record<string, any> = {};
  if (recipeToSerialize.frontmatter && typeof recipeToSerialize.frontmatter === 'object') {
    for (const [k, v] of Object.entries(recipeToSerialize.frontmatter)) {
      if (v !== undefined && v !== null) {
        frontmatterObj[k] = v;
      }
    }
  }

  if (recipeToSerialize.title) {
    frontmatterObj.title = recipeToSerialize.title;
  } else if (!frontmatterObj.title) {
    frontmatterObj.title = 'Untitled Recipe';
  }

  if (recipeToSerialize.tags && recipeToSerialize.tags.length > 0) {
    frontmatterObj.tags = recipeToSerialize.tags;
  } else if (!frontmatterObj.tags) {
    frontmatterObj.tags = ['food/recipes'];
  }

  // Only assign defaults if no frontmatter existed or field was present
  if (recipeToSerialize.cuisine && (recipeToSerialize.frontmatter?.cuisine !== undefined || !recipeToSerialize.frontmatter)) {
    frontmatterObj.cuisine = recipeToSerialize.cuisine;
  }
  if (recipeToSerialize.category && (recipeToSerialize.frontmatter?.category !== undefined || !recipeToSerialize.frontmatter)) {
    frontmatterObj.category = recipeToSerialize.category;
  }
  if (recipeToSerialize.difficulty && (recipeToSerialize.frontmatter?.difficulty !== undefined || !recipeToSerialize.frontmatter)) {
    frontmatterObj.difficulty = recipeToSerialize.difficulty;
  }
  if (recipeToSerialize.rating !== undefined && (recipeToSerialize.frontmatter?.rating !== undefined || !recipeToSerialize.frontmatter)) {
    frontmatterObj.rating = recipeToSerialize.rating;
  }

  // Timings: Persist prep_time, cook_time, total_time when present and clean alternate alias keys to avoid duplicate frontmatter fields
  if (recipeToSerialize.prepTime && recipeToSerialize.prepTime.trim()) {
    cleanAlternateFrontmatterKeys(frontmatterObj, 'prep_time', ['prep_time', 'prepTime', 'prep-time', 'prep', 'preptime']);
    frontmatterObj.prep_time = recipeToSerialize.prepTime.trim();
  }
  if (recipeToSerialize.cookTime && recipeToSerialize.cookTime.trim()) {
    cleanAlternateFrontmatterKeys(frontmatterObj, 'cook_time', ['cook_time', 'cookTime', 'cook-time', 'cook', 'cooktime']);
    frontmatterObj.cook_time = recipeToSerialize.cookTime.trim();
  }
  if (recipeToSerialize.totalTime && recipeToSerialize.totalTime.trim()) {
    cleanAlternateFrontmatterKeys(frontmatterObj, 'total_time', ['total_time', 'totalTime', 'total-time', 'total', 'totaltime']);
    frontmatterObj.total_time = recipeToSerialize.totalTime.trim();
  }
  if (recipeToSerialize.servings !== undefined && recipeToSerialize.servings !== null) {
    frontmatterObj.servings = recipeToSerialize.servings;
  }
  if (
    recipeToSerialize.calories !== undefined &&
    recipeToSerialize.calories !== null &&
    String(recipeToSerialize.calories).trim()
  ) {
    frontmatterObj.calories = recipeToSerialize.calories;
  }

  if (recipeToSerialize.nutrition && typeof recipeToSerialize.nutrition === 'object') {
    const nut: Record<string, any> = {};
    if (recipeToSerialize.nutrition.calories !== undefined && recipeToSerialize.nutrition.calories !== null) {
      nut.calories = recipeToSerialize.nutrition.calories;
    }
    if (recipeToSerialize.nutrition.protein !== undefined && recipeToSerialize.nutrition.protein !== null) {
      nut.protein = recipeToSerialize.nutrition.protein;
    }
    if (recipeToSerialize.nutrition.carbohydrates !== undefined && recipeToSerialize.nutrition.carbohydrates !== null) {
      nut.carbohydrates = recipeToSerialize.nutrition.carbohydrates;
    }
    if (recipeToSerialize.nutrition.fat !== undefined && recipeToSerialize.nutrition.fat !== null) {
      nut.fat = recipeToSerialize.nutrition.fat;
    }
    if (recipeToSerialize.nutrition.fiber !== undefined && recipeToSerialize.nutrition.fiber !== null) {
      nut.fiber = recipeToSerialize.nutrition.fiber;
    }
    if (recipeToSerialize.nutrition.sodium !== undefined && recipeToSerialize.nutrition.sodium !== null) {
      nut.sodium = recipeToSerialize.nutrition.sodium;
    }
    if (recipeToSerialize.nutrition.servings !== undefined && recipeToSerialize.nutrition.servings !== null) {
      nut.servings = recipeToSerialize.nutrition.servings;
    }
    if (recipeToSerialize.nutrition.confidenceNote && recipeToSerialize.nutrition.confidenceNote.trim()) {
      nut.confidenceNote = recipeToSerialize.nutrition.confidenceNote.trim();
    }

    if (Object.keys(nut).length > 0) {
      frontmatterObj.nutrition = nut;
      if (!frontmatterObj.calories && nut.calories) {
        frontmatterObj.calories = nut.calories;
      }
    }
  }

  if (recipeToSerialize.source && recipeToSerialize.source.trim()) {
    frontmatterObj.source = recipeToSerialize.source.trim();
  }
  // Only persist image if explicitly present (do not write empty or generated placeholders)
  if (recipeToSerialize.image && recipeToSerialize.image.trim()) {
    frontmatterObj.image = recipeToSerialize.image.trim();
  }
  if (recipeToSerialize.lastModified && recipeToSerialize.frontmatter?.created) {
    frontmatterObj.created = recipeToSerialize.lastModified;
  }

  const yamlStr = yamlDump(frontmatterObj, { indent: 2, lineWidth: -1 }).trim();

  let md = `---\n${yamlStr}\n---\n\n`;
  md += `# ${recipeToSerialize.title || 'Untitled Recipe'}\n\n`;

  // Dataview inline fields (preserve all user-authored key:: value pairs in their original casing)
  if (recipeToSerialize.dataviewFields && Object.keys(recipeToSerialize.dataviewFields).length > 0) {
    for (const [k, v] of Object.entries(recipeToSerialize.dataviewFields)) {
      if (v !== undefined && v !== null && String(v).trim()) {
        md += `${k}:: ${v}\n`;
      }
    }
    md += '\n';
  }

  // Freeform body prose / description (preserved before callouts and ingredients)
  if (recipeToSerialize.description && recipeToSerialize.description.trim()) {
    md += `${recipeToSerialize.description.trim()}\n\n`;
  }

  // Callouts
  if (recipeToSerialize.callouts && recipeToSerialize.callouts.length > 0) {
    recipeToSerialize.callouts.forEach((co) => {
      md += `> [!${co.type || 'tip'}] ${co.title || "Chef's Note"}\n`;
      const coLines = co.content.split('\n');
      coLines.forEach((cl) => {
        md += `> ${cl}\n`;
      });
      md += '\n';
    });
  }

  // Ingredients (ZERO-FABRICATION: only emit when real ingredients exist)
  if (recipeToSerialize.ingredients && recipeToSerialize.ingredients.length > 0) {
    md += `## 🥘 Ingredients\n`;
    recipeToSerialize.ingredients.forEach((ing) => {
      const check = ing.isChecked ? '[x]' : '[ ]';
      md += `${renderIngredientLine(ing, check)}\n`;
    });
    md += '\n';
  }

  // Instructions (ZERO-FABRICATION: only emit when real instructions exist)
  if (recipeToSerialize.instructions && recipeToSerialize.instructions.length > 0) {
    md += `## 🍳 Instructions\n`;
    recipeToSerialize.instructions.forEach((step, idx) => {
      md += `${idx + 1}. ${step.text}\n`;
    });
    md += '\n';
  }

  // Notes & Variations
  if (recipeToSerialize.notes) {
    md += `## 💡 Notes & Variations\n${recipeToSerialize.notes}\n\n`;
  }

  return md;
}

/**
 * Parses generic Obsidian Markdown notes (e.g. ingredient guides, kitchen references)
 */
export function parseVaultNoteMarkdown(
  rawMarkdown: string,
  fileName: string = 'Untitled Note.md',
  filePath: string = ''
): VaultNote {
  let frontmatter: Record<string, any> = {};
  let content = rawMarkdown;

  const fmMatch = rawMarkdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fmMatch) {
    try {
      const parsedYaml = yamlLoad(fmMatch[1]);
      if (typeof parsedYaml === 'object' && parsedYaml !== null) {
        frontmatter = parsedYaml as Record<string, any>;
      }
    } catch (e) {
      // silent fallback
    }
    content = rawMarkdown.slice(fmMatch[0].length);
  }

  let title = frontmatter.title;
  if (!title) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
    } else {
      title = fileName.replace(/\.md$/i, '');
    }
  }

  let rawTags: any[] = [];
  if (Array.isArray(frontmatter.tags)) {
    rawTags = frontmatter.tags;
  } else if (typeof frontmatter.tags === 'string') {
    rawTags = frontmatter.tags.split(',').map((t) => t.trim());
  } else if (frontmatter.tag) {
    rawTags = Array.isArray(frontmatter.tag) ? frontmatter.tag : [frontmatter.tag];
  }

  const tags = Array.from(new Set(rawTags.map((t) => String(t).replace(/^#/, '').trim()))).filter(Boolean);
  const id = filePath || fileName.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return {
    id,
    fileName,
    filePath: filePath || fileName,
    rawMarkdown,
    title,
    tags,
    frontmatter,
    content: content.trim(),
  };
}

/**
 * Serializes Weekly Meal Plan into an Obsidian Markdown note
 */
export function serializeMealPlanToMarkdown(mealPlan: MealPlanDay[]): string {
  const frontmatterObj = {
    type: 'meal-plan',
    updated: new Date().toISOString().split('T')[0],
  };

  const yamlStr = yamlDump(frontmatterObj, { indent: 2 }).trim();
  let md = `---\n${yamlStr}\n---\n\n# 📅 Weekly Meal Plan\n\n`;

  mealPlan.forEach((day) => {
    md += `## ${day.dayName}\n`;
    if (day.breakfast?.recipeTitle) {
      md += `- **Breakfast**: [[${day.breakfast.recipeTitle}]]\n`;
    }
    if (day.lunch?.recipeTitle) {
      md += `- **Lunch**: [[${day.lunch.recipeTitle}]]\n`;
    }
    if (day.dinner?.recipeTitle) {
      md += `- **Dinner**: [[${day.dinner.recipeTitle}]]\n`;
    }
    if (!day.breakfast?.recipeTitle && !day.lunch?.recipeTitle && !day.dinner?.recipeTitle) {
      md += `*No meals planned*\n`;
    }
    md += '\n';
  });

  return md;
}

/**
 * Parses an Obsidian Meal Plan markdown note back into MealPlanDay[]
 */
export function parseMealPlanFromMarkdown(text: string): MealPlanDay[] {
  const days: MealPlanDay[] = [
    { dayName: 'Monday' },
    { dayName: 'Tuesday' },
    { dayName: 'Wednesday' },
    { dayName: 'Thursday' },
    { dayName: 'Friday' },
    { dayName: 'Saturday' },
    { dayName: 'Sunday' },
  ];

  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const lines = text.split('\n');
  let currentDayIndex = -1;

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('## ')) {
      const headingName = line.replace(/^##\s+/, '').trim();
      const matchedIdx = dayNames.findIndex(
        (d) => d.toLowerCase() === headingName.toLowerCase()
      );
      if (matchedIdx >= 0) {
        currentDayIndex = matchedIdx;
      }
    } else if (currentDayIndex >= 0 && line.startsWith('- **')) {
      const match = line.match(/^-\s*\*\*([A-Za-z]+)\*\*:\s*(.*)$/);
      if (match) {
        const slotType = match[1].toLowerCase() as 'breakfast' | 'lunch' | 'dinner';
        const rawContent = match[2].trim();
        // Extract wikilink title [[Recipe Name]]
        const titleMatch = rawContent.match(/\[\[([^\]]+)\]\]/);
        const recipeTitle = titleMatch ? titleMatch[1].trim() : rawContent.replace(/^[-\s*]+/, '').trim();

        if (recipeTitle && ['breakfast', 'lunch', 'dinner'].includes(slotType)) {
          days[currentDayIndex][slotType] = {
            recipeTitle,
          };
        }
      }
    }
  }

  return days;
}

/**
 * Serializes Shopping List into an Obsidian Markdown task checklist note
 */
export function serializeShoppingListToMarkdown(groups: ShoppingCategoryGroup[]): string {
  const frontmatterObj = {
    type: 'shopping-list',
    updated: new Date().toISOString().split('T')[0],
  };

  const yamlStr = yamlDump(frontmatterObj, { indent: 2 }).trim();
  let md = `---\n${yamlStr}\n---\n\n# 🛒 Grocery Shopping List\n\n`;

  groups.forEach((group) => {
    if (group.items && group.items.length > 0) {
      md += `## ${group.category}\n`;
      group.items.forEach((item) => {
        const check = item.isChecked ? '[x]' : '[ ]';
        md += `- ${check} ${item.text}\n`;
      });
      md += '\n';
    }
  });

  return md;
}

/**
 * Parses an Obsidian Shopping List markdown note into ShoppingCategoryGroup[]
 */
export function parseShoppingListFromMarkdown(text: string): ShoppingCategoryGroup[] {
  const groups: ShoppingCategoryGroup[] = [];
  const lines = text.split('\n');
  let currentCategory = 'General';
  let currentGroup: ShoppingCategoryGroup | null = null;

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('## ') || line.startsWith('### ')) {
      currentCategory = line.replace(/^#{2,3}\s+/, '').trim();
      currentGroup = groups.find((g) => g.category === currentCategory) || null;
      if (!currentGroup) {
        currentGroup = {
          category: currentCategory,
          items: [],
        };
        groups.push(currentGroup);
      }
    } else if (line.startsWith('- [') || line.startsWith('* [')) {
      const isChecked = line.startsWith('- [x]') || line.startsWith('- [X]') || line.startsWith('* [x]') || line.startsWith('* [X]');
      const cleanText = line.replace(/^[-*]\s*\[[ xX]\]\s*/, '').trim();

      if (cleanText) {
        if (!currentGroup) {
          currentGroup = {
            category: currentCategory,
            items: [],
          };
          groups.push(currentGroup);
        }
        currentGroup.items.push({
          id: `item-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          text: cleanText,
          recipeSources: [],
          isChecked,
        });
      }
    }
  }

  return groups;
}
