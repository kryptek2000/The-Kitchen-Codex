// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import React from 'react';

import { MealPlannerView } from '../../src/components/MealPlannerView';
import { ObsidianRecipe, MealPlanDay } from '../../src/types';

afterEach(() => cleanup());

function makeDay(name: string, breakfast?: string, lunch?: string, dinner?: string): MealPlanDay {
  return {
    dayName: name,
    breakfast: breakfast ? { recipeId: `${breakfast}-id`, recipeTitle: breakfast } : undefined,
    lunch: lunch ? { recipeId: `${lunch}-id`, recipeTitle: lunch } : undefined,
    dinner: dinner ? { recipeId: `${dinner}-id`, recipeTitle: dinner } : undefined,
  };
}

const recipes: ObsidianRecipe[] = [
  { id: 'r1', title: 'Alpha Soup' } as any,
  { id: 'r2', title: 'Beta Salad' } as any,
  { id: 'r3', title: 'Gamma Pasta' } as any,
  { id: 'r4', title: 'Delta Cake' } as any,
  { id: 'r5', title: 'Epsilon Pie' } as any,
  { id: 'r6', title: 'Zeta Bread' } as any,
];

const mealPlan: MealPlanDay[] = [
  makeDay('Monday'),
  makeDay('Tuesday', 'Alpha Soup'),
  makeDay('Wednesday'),
  makeDay('Thursday'),
  makeDay('Friday'),
  makeDay('Saturday'),
  makeDay('Sunday'),
];

describe('MealPlannerView', () => {
  it('renders seven day cards', () => {
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={() => {}}
      />
    );
    for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      expect(screen.getByText(d)).toBeTruthy();
    }
  });

  it('empty slot opens the recipe selector modal', () => {
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={() => {}}
      />
    );
    const addBtns = screen.getAllByText(/Add Breakfast/i);
    fireEvent.click(addBtns[0]);
    expect(screen.getByText(/Select Recipe for Monday/i)).toBeTruthy();
  });

  it('selecting a recipe invokes onSelectSlotRecipe with correct args', () => {
    const onSelect = vi.fn();
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={onSelect}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={() => {}}
      />
    );
    fireEvent.click(screen.getAllByText(/Add Breakfast/i)[0]);
    fireEvent.click(screen.getByRole('heading', { name: 'Alpha Soup' }));
    expect(onSelect).toHaveBeenCalledWith(0, 'breakfast', expect.objectContaining({ id: 'r1', title: 'Alpha Soup' }));
  });

  it('removing a recipe invokes onRemoveSlotRecipe', () => {
    const onRemove = vi.fn();
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={onRemove}
        onResetMealPlan={() => {}}
      />
    );
    const removeBtn = screen.getByLabelText(/Remove Alpha Soup from Tuesday breakfast/i);
    fireEvent.click(removeBtn);
    expect(onRemove).toHaveBeenCalledWith(1, 'breakfast');
  });

  it('day and weekly shopping actions invoke distinct callbacks', () => {
    const onDay = vi.fn();
    const onWeek = vi.fn();
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={onDay}
        onGenerateWeeklyShoppingList={onWeek}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={() => {}}
      />
    );
    const dayBtn = screen.getByTitle(/Generate shopping list for Tuesday/i);
    fireEvent.click(dayBtn);
    expect(onDay).toHaveBeenCalled();
    const weekBtn = screen.getByText(/Weekly Shopping List/i).closest('button')!;
    fireEvent.click(weekBtn);
    expect(onWeek).toHaveBeenCalled();
  });

  it('reset week invokes onResetMealPlan', () => {
    const onReset = vi.fn();
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={onReset}
      />
    );
    fireEvent.click(screen.getByText('Reset Week').closest('button')!);
    expect(onReset).toHaveBeenCalled();
  });

  it('recipe search filters the modal list', () => {
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={() => {}}
      />
    );
    fireEvent.click(screen.getAllByText(/Add Breakfast/i)[0]);
    const input = screen.getByPlaceholderText(/Filter recipes by title/i);
    fireEvent.change(input, { target: { value: 'Beta' } });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Beta Salad')).toBeTruthy();
    expect(within(dialog).queryByText('Alpha Soup')).toBeNull();
  });

  it('modal closes via close button', () => {
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={() => {}}
      />
    );
    fireEvent.click(screen.getAllByText(/Add Breakfast/i)[0]);
    expect(screen.getByText(/Select Recipe for Monday/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close recipe selector'));
    expect(screen.queryByText(/Select Recipe for Monday/i)).toBeNull();
  });

  it('filled-slot remove control is always visible with 44px target', () => {
    const { container } = render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={() => {}}
      />
    );
    const btn = container.querySelector('button[aria-label*="Remove Alpha Soup"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.className).not.toMatch(/opacity-0/);
    expect(btn.className).toMatch(/w-11 h-11/);
  });

  it('clicking remove does not open the recipe', () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={onOpen}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={onRemove}
        onResetMealPlan={() => {}}
      />
    );
    const btn = screen.getByLabelText(/Remove Alpha Soup from Tuesday breakfast/i);
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('empty slot buttons have at least 44px min height class', () => {
    const { container } = render(
      <MealPlannerView
        recipes={recipes}
        mealPlan={mealPlan}
        onOpenRecipe={() => {}}
        onGenerateDayShoppingList={() => {}}
        onGenerateWeeklyShoppingList={() => {}}
        onSelectSlotRecipe={() => {}}
        onRemoveSlotRecipe={() => {}}
        onResetMealPlan={() => {}}
      />
    );
    const btn = container.querySelector('button[class*="min-h-[44px]"]');
    expect(btn).toBeTruthy();
  });
});
