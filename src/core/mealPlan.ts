import type { MealPlanDay, MealPlanSlot } from '../types';

export const MEAL_PLAN_DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export type MealPlanRecipeRef = { id: string; title: string };

const CANONICAL_DAY_BY_LOWER = new Map(
  MEAL_PLAN_DAY_NAMES.map((dayName) => [dayName.toLowerCase(), dayName])
);

function cloneSlot(value: unknown): MealPlanSlot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return { ...(value as MealPlanSlot) };
}

function cloneSnacks(value: unknown): MealPlanSlot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const snacks = value.map(cloneSlot).filter((slot): slot is MealPlanSlot => Boolean(slot));
  return snacks.length > 0 ? snacks : undefined;
}

function cloneDay(dayName: string, value: Record<string, unknown>): MealPlanDay {
  const day: MealPlanDay = { dayName };
  if (typeof value.dateStr === 'string') day.dateStr = value.dateStr;
  const breakfast = cloneSlot(value.breakfast);
  const lunch = cloneSlot(value.lunch);
  const dinner = cloneSlot(value.dinner);
  const snacks = cloneSnacks(value.snacks);
  if (breakfast) day.breakfast = breakfast;
  if (lunch) day.lunch = lunch;
  if (dinner) day.dinner = dinner;
  if (snacks) day.snacks = snacks;
  return day;
}

/**
 * Returns a complete Monday–Sunday plan without discarding any valid saved
 * content. Empty, missing, partial, duplicate, and malformed input is safe.
 * The first occurrence of a canonical day wins; unknown entries are ignored.
 */
export function normalizeMealPlanDays(value: unknown): MealPlanDay[] {
  const byDay = new Map<string, MealPlanDay>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const rawName = typeof record.dayName === 'string' ? record.dayName.trim().toLowerCase() : '';
      const dayName = CANONICAL_DAY_BY_LOWER.get(rawName);
      if (!dayName || byDay.has(dayName)) continue;
      byDay.set(dayName, cloneDay(dayName, record));
    }
  }
  return MEAL_PLAN_DAY_NAMES.map(
    (dayName) => byDay.get(dayName) ?? { dayName }
  );
}

/**
 * Adds one recipe using the existing first-empty-slot behavior:
 * first day without dinner, otherwise first day without lunch, otherwise
 * Monday breakfast. Input is never mutated.
 */
export function addRecipeToMealPlan(
  value: unknown,
  recipe: MealPlanRecipeRef
): MealPlanDay[] {
  const next = normalizeMealPlanDays(value);
  const firstEmptyDinner = next.find((day) => !day.dinner?.recipeTitle);
  if (firstEmptyDinner) {
    firstEmptyDinner.dinner = { recipeId: recipe.id, recipeTitle: recipe.title };
    return next;
  }
  const firstEmptyLunch = next.find((day) => !day.lunch?.recipeTitle);
  if (firstEmptyLunch) {
    firstEmptyLunch.lunch = { recipeId: recipe.id, recipeTitle: recipe.title };
    return next;
  }
  next[0].breakfast = { recipeId: recipe.id, recipeTitle: recipe.title };
  return next;
}
