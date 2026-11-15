import { describe, expect, it } from 'vitest';
import {
  MEAL_PLAN_DAY_NAMES,
  addRecipeToMealPlan,
  normalizeMealPlanDays,
} from '../../src/core/mealPlan';

const recipe = { id: 'r1', title: 'Alpha Soup' };

describe('normalizeMealPlanDays', () => {
  it.each([undefined, null, [], {}, 'not-a-plan'])(
    'returns Monday-Sunday for empty or malformed input: %s',
    (value) => {
      const days = normalizeMealPlanDays(value);
      expect(days.map((day) => day.dayName)).toEqual([...MEAL_PLAN_DAY_NAMES]);
      expect(days.every((day) => !day.breakfast && !day.lunch && !day.dinner)).toBe(true);
    }
  );

  it('preserves populated days and fills every missing day', () => {
    const days = normalizeMealPlanDays([
      { dayName: 'Wednesday', dinner: { recipeId: 'r2', recipeTitle: 'Gamma Pasta' } },
      { dayName: 'Monday', lunch: { recipeId: 'r3', recipeTitle: 'Beta Salad' } },
    ]);

    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({
      dayName: 'Monday',
      lunch: { recipeId: 'r3', recipeTitle: 'Beta Salad' },
    });
    expect(days[2]).toMatchObject({
      dayName: 'Wednesday',
      dinner: { recipeId: 'r2', recipeTitle: 'Gamma Pasta' },
    });
    expect(days[1]).toEqual({ dayName: 'Tuesday' });
    expect(days[6]).toEqual({ dayName: 'Sunday' });
  });

  it('ignores malformed entries without dropping valid content', () => {
    const days = normalizeMealPlanDays([
      null,
      'bad',
      { dayName: 'Funday', dinner: { recipeTitle: 'Nope' } },
      { dayName: 'monday', dinner: { recipeTitle: 'Valid Dinner' } },
      { dayName: 'Tuesday', dinner: null },
    ]);

    expect(days.map((day) => day.dayName)).toEqual([...MEAL_PLAN_DAY_NAMES]);
    expect(days[0].dinner?.recipeTitle).toBe('Valid Dinner');
    expect(days[1].dinner).toBeUndefined();
  });

  it('does not mutate the input plan', () => {
    const input = [{ dayName: 'Monday', dinner: { recipeTitle: 'Original' } }];
    const days = normalizeMealPlanDays(input);
    days[0].dinner!.recipeTitle = 'Changed';
    expect(input[0].dinner?.recipeTitle).toBe('Original');
  });
});

describe('addRecipeToMealPlan', () => {
  it('adds to Monday dinner when the plan is empty', () => {
    const days = addRecipeToMealPlan([], recipe);
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({
      dayName: 'Monday',
      dinner: { recipeId: 'r1', recipeTitle: 'Alpha Soup' },
    });
  });

  it('uses the existing first-empty-dinner behavior', () => {
    const days = addRecipeToMealPlan(
      [{ dayName: 'Monday', dinner: { recipeTitle: 'Occupied' } }],
      recipe
    );
    expect(days[0].dinner?.recipeTitle).toBe('Occupied');
    expect(days[1].dinner?.recipeTitle).toBe('Alpha Soup');
  });

  it('falls back to the first empty lunch when all dinners are filled', () => {
    const fullDinners = MEAL_PLAN_DAY_NAMES.map((dayName) => ({
      dayName,
      dinner: { recipeTitle: `${dayName} Dinner` },
      lunch: dayName === 'Sunday' ? undefined : { recipeTitle: `${dayName} Lunch` },
    }));
    const days = addRecipeToMealPlan(fullDinners, recipe);
    expect(days[6].lunch?.recipeTitle).toBe('Alpha Soup');
    expect(days[0].breakfast).toBeUndefined();
  });

  it('falls back to Monday breakfast only when every dinner and lunch is filled', () => {
    const full = MEAL_PLAN_DAY_NAMES.map((dayName) => ({
      dayName,
      dinner: { recipeTitle: `${dayName} Dinner` },
      lunch: { recipeTitle: `${dayName} Lunch` },
    }));
    const days = addRecipeToMealPlan(full, recipe);
    expect(days[0].breakfast?.recipeTitle).toBe('Alpha Soup');
    expect(days[0].dinner?.recipeTitle).toBe('Monday Dinner');
  });

  it('does not crash on malformed plan values', () => {
    expect(() => addRecipeToMealPlan(undefined, recipe)).not.toThrow();
    expect(() => addRecipeToMealPlan({ days: [] }, recipe)).not.toThrow();
  });
});
