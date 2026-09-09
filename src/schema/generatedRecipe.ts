/**
 * The Kitchen Codex — GeneratedRecipeDraft (v0.7 Phase 2A).
 *
 * The restricted, INVENTION-mode recipe draft produced by "Create for Me". It is
 * deliberately NOT a `CanonicalRecipe`: it carries only the fields the generator
 * may  invent, and NONE of the application-owned identity/persistence fields
 * (id, fileName, filePath, createdAt, updatedAt, sourceUrl, existingRecipeId).
 * The application assigns identity/path/timestamps ONLY at explicit save time.
 *
 * CREATE FOR ME = EXPLICIT INVENTION MODE.
 *   - generated content is allowed to be invented here,
 *   - but generation is explicit, schema-constrained, clearly labeled generated,
 *     previewed + editable before save, and saved only by the user.
 *
 * TRUTH / PRIVACY:
 *   - NO fake source URL / author URL / website origin / imported-from metadata.
 *   - NO ingredient wikilinks (auto-linking is an established product rule).
 *   - The generation prompt is transient and is NEVER in a draft, frontmatter,
 *     settings, logs, diagnostics, or persisted anywhere.
 *
 * This module is shared (server operation + client UI) and platform-neutral: it
 * imports only the shared AiJsonSchema type and has no Node/browser dependency.
 */

import type { AiJsonSchema } from '../core/ai/types';

/** Max ingredient count a generated recipe may carry (bounded, prevents drift). */
export const MAX_GENERATED_INGREDIENTS = 60;
/** Max instruction step count. */
export const MAX_GENERATED_STEPS = 60;
/** Max tag count. */
export const MAX_GENERATED_TAGS = 30;
/** Max prompt length accepted at the request boundary. */
export const MAX_CREATE_PROMPT_LENGTH = 1200;
/** Max constraint-list item count (e.g. dietary / exclude ingredients). */
export const MAX_CONSTRAINT_ITEMS = 20;

/** A single generated ingredient. Deliberately wikilink-free (no auto-linking). */
export interface GeneratedIngredient {
  /** Normalized numeric amount (or null when a freeform quantity). */
  amount?: number | null;
  /** Standardized unit abbreviation (e.g. "tbsp", "cup", "g"). */
  unit?: string;
  /** Normalized clean ingredient name. */
  name: string;
  /** Preparation note/modifier (e.g. "diced", "sifted"). */
  preparation?: string;
  /** Whether the ingredient is explicitly optional. */
  optional?: boolean;
}

/** A single generated instruction step. */
export interface GeneratedStep {
  /** Step instruction markdown text. */
  text: string;
  /** Extracted timer duration in minutes (optional). */
  timerMinutes?: number | null;
}

/**
 * The restricted generated-recipe draft. Only invention-safe fields; never the
 * application-owned identity or source fields.
 */
export interface GeneratedRecipeDraft {
  title: string;
  description?: string;
  servings?: number;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  ingredients: GeneratedIngredient[];
  steps: GeneratedStep[];
  tags?: string[];
  cuisine?: string;
  course?: string;
  difficulty?: 'Easy' | 'Medium' | 'Hard';
  notes?: string;
}

/** Explicit user constraints (a small, bounded preference set — never whole-vault). */
export interface CreateRecipeConstraints {
  servings?: number;
  maxTotalMinutes?: number;
  dietary?: string[];
  excludeIngredients?: string[];
  cuisine?: string;
  course?: string;
}

/** The bounded generation request the client sends. */
export interface CreateRecipeRequest {
  prompt: string;
  constraints?: CreateRecipeConstraints;
}

/** Truthful generation provenance returned with a draft. */
export interface GeneratedRecipeProvenance {
  generated: true;
  providerId: string;
  model: string;
}

// ---- Normalization / validation -------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function trimString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t || undefined;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (!isFiniteNumber(v)) return undefined;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function normalizeIngredient(raw: unknown): GeneratedIngredient | null {
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { name } : null;
  }
  if (!isPlainObject(raw)) return null;
  const name = trimString(raw['name'], 80);
  if (!name) return null;
  return {
    name,
    ...(isFiniteNumber(raw['amount']) ? { amount: raw['amount'] as number } : {}),
    ...(raw['unit'] !== undefined ? { unit: trimString(raw['unit'], 20) } : {}),
    ...(raw['preparation'] !== undefined ? { preparation: trimString(raw['preparation'], 80) } : {}),
    ...(raw['optional'] === true ? { optional: true } : {}),
  };
}

function normalizeStep(raw: unknown, index: number): GeneratedStep | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? { text } : null;
  }
  if (!isPlainObject(raw)) return null;
  const text = trimString(raw['text'], 2000);
  if (!text) return null;
  return {
    text,
    ...(isFiniteNumber(raw['timerMinutes']) ? { timerMinutes: raw['timerMinutes'] as number } : {}),
  };
}

/**
 * Normalizes raw provider output into a GeneratedRecipeDraft. Trims strings, drops
 * empty array entries, clamps numbers, and REJECTS when any required field is
 * absent/invalid (no silent synthesis of missing required data). Throws on an
 * invalid draft.
 */
export function normalizeGeneratedRecipeDraft(raw: unknown): GeneratedRecipeDraft {
  const issues = validateGeneratedRecipeDraft(raw);
  if (!issues.passed) {
    throw new Error(`Generated recipe draft is invalid: ${issues.errors.join('; ')}`);
  }
  const r = (raw as Record<string, unknown>);
  const title = trimString(r['title'], 120) as string;
  const ingredientsRaw = Array.isArray(r['ingredients']) ? r['ingredients'] : [];
  const stepsRaw = Array.isArray(r['steps']) ? r['steps'] : [];
  const ingredients = ingredientsRaw.map(normalizeIngredient).filter((x): x is GeneratedIngredient => x !== null);
  const steps = stepsRaw.map(normalizeStep).filter((x): x is GeneratedStep => x !== null);
  let tags: string[] | undefined;
  if (Array.isArray(r['tags'])) {
    tags = r['tags'].map((t) => trimString(t, 40)).filter((t): t is string => !!t).slice(0, MAX_GENERATED_TAGS);
  }
  const draft: GeneratedRecipeDraft = {
    title,
    ingredients,
    steps,
  };
  if (r['description']) draft.description = trimString(r['description'], 500);
  if (isFiniteNumber(r['servings'])) draft.servings = clampInt(r['servings'], 1, 100);
  if (r['prepTime']) draft.prepTime = trimString(r['prepTime'], 40);
  if (r['cookTime']) draft.cookTime = trimString(r['cookTime'], 40);
  if (r['totalTime']) draft.totalTime = trimString(r['totalTime'], 40);
  if (tags && tags.length) draft.tags = tags;
  if (r['cuisine']) draft.cuisine = trimString(r['cuisine'], 60);
  if (r['course']) draft.course = trimString(r['course'], 60);
  if (r['difficulty']) {
    const d = trimString(r['difficulty'], 10);
    if (d === 'Easy' || d === 'Medium' || d === 'Hard') draft.difficulty = d;
  }
  if (r['notes']) draft.notes = trimString(r['notes'], 2000);
  return draft;
}

export interface GeneratedRecipeValidation {
  passed: boolean;
  errors: string[];
}

/**
 * Validates raw provider output shape. Extra/unrecognized properties are rejected
 * (no shape drift), and required fields must be present and non-empty.
 */
export function validateGeneratedRecipeDraft(raw: unknown): GeneratedRecipeValidation {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { passed: false, errors: ['Draft must be an object'] };
  }
  const r = raw;
  const allowed = new Set([
    'title', 'description', 'servings', 'prepTime', 'cookTime', 'totalTime',
    'ingredients', 'steps', 'tags', 'cuisine', 'course', 'difficulty', 'notes',
  ]);
  for (const key of Object.keys(r)) {
    if (!allowed.has(key)) errors.push(`Unexpected field "${key}"`);
  }
  const title = trimString(r['title'], 120) ?? '';
  if (!title) errors.push('"title" is required');
  if (!Array.isArray(r['ingredients']) || r['ingredients'].length === 0) {
    errors.push('"ingredients" must be a non-empty array');
  } else if (r['ingredients'].length > MAX_GENERATED_INGREDIENTS) {
    errors.push(`"ingredients" exceeds ${MAX_GENERATED_INGREDIENTS}`);
  }
  if (!Array.isArray(r['steps']) || r['steps'].length === 0) {
    errors.push('"steps" must be a non-empty array');
  } else if (r['steps'].length > MAX_GENERATED_STEPS) {
    errors.push(`"steps" exceeds ${MAX_GENERATED_STEPS}`);
  }
  if (Array.isArray(r['tags']) && r['tags'].length > MAX_GENERATED_TAGS) {
    errors.push(`"tags" exceeds ${MAX_GENERATED_TAGS}`);
  }
  if (r['servings'] !== undefined && !(isFiniteNumber(r['servings']) && r['servings'] >= 1 && r['servings'] <= 100)) {
    errors.push('"servings" must be an integer between 1 and 100');
  }
  // Validate every ingredient entry.
  if (Array.isArray(r['ingredients'])) {
    r['ingredients'].forEach((ing, i) => {
      if (typeof ing !== 'string' && !isPlainObject(ing)) {
        errors.push(`ingredients[${i}] must be an object`);
        return;
      }
      if (isPlainObject(ing)) {
        if (!isString(ing['name']) || !(ing['name'] as string).trim()) {
          errors.push(`ingredients[${i}].name is required`);
        }
        if (ing['optional'] !== undefined && typeof ing['optional'] !== 'boolean') {
          errors.push(`ingredients[${i}].optional must be a boolean`);
        }
      }
    });
  }
  // Validate every step entry.
  if (Array.isArray(r['steps'])) {
    r['steps'].forEach((step, i) => {
      if (typeof step !== 'string' && !isPlainObject(step)) {
        errors.push(`steps[${i}] must be a string or object`);
        return;
      }
      if (isPlainObject(step) && (!isString(step['text']) || !(step['text'] as string).trim())) {
        errors.push(`steps[${i}].text is required`);
      }
    });
  }
  return { passed: errors.length === 0, errors };
}

/**
 * The provider-neutral AiJsonSchema for a GeneratedRecipeDraft. Closed objects
 * (the OpenRouter path sets additionalProperties:false), typed properties, and
 * required title/ingredients/steps. Bounds are enforced at validation
 * (normalizeGeneratedRecipeDraft) since the shared schema type is intentionally
 * minimal; the schema is strict enough to prevent shape drift.
 */
export function buildGeneratedRecipeSchema(): AiJsonSchema {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Recipe title (2-120 chars)' },
      description: { type: 'string', description: 'Short recipe summary' },
      servings: { type: 'number', description: 'Number of servings (integer 1-100)' },
      prepTime: { type: 'string', description: 'Prep time string e.g. "15 mins"' },
      cookTime: { type: 'string', description: 'Cook time string e.g. "30 mins"' },
      totalTime: { type: 'string', description: 'Total time string e.g. "45 mins"' },
      ingredients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            unit: { type: 'string', description: 'Standardized unit, e.g. tbsp, cup, g, ml' },
            name: { type: 'string', description: 'Ingredient name' },
            preparation: { type: 'string', description: 'Preparation modifier, e.g. diced' },
            optional: { type: 'boolean' },
          },
          required: ['name'],
        },
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Instruction text' },
            timerMinutes: { type: 'number' },
          },
          required: ['text'],
        },
      },
      tags: { type: 'array', items: { type: 'string' } },
      cuisine: { type: 'string' },
      course: { type: 'string' },
      difficulty: { type: 'string', enum: ['Easy', 'Medium', 'Hard'] },
      notes: { type: 'string' },
    },
    required: ['title', 'ingredients', 'steps'],
  };
}
