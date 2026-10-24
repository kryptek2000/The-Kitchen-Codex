import React, { useState, useMemo } from 'react';
import {
  Calendar,
  Plus,
  Trash2,
  ShoppingCart,
  Sparkles,
  ChevronRight,
  Utensils,
  BookOpen,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { ObsidianRecipe, MealPlanDay } from '../types';
import { getRecipeImage } from '../utils/imageHelper';

interface MealPlannerViewProps {
  recipes: ObsidianRecipe[];
  mealPlan: MealPlanDay[];
  onOpenRecipe: (recipeId: string) => void;
  onGenerateDayShoppingList: (day: MealPlanDay) => void;
  onGenerateWeeklyShoppingList: () => void;
  onSelectSlotRecipe: (dayIndex: number, mealType: 'breakfast' | 'lunch' | 'dinner', recipe: ObsidianRecipe) => void;
  onRemoveSlotRecipe: (dayIndex: number, mealType: 'breakfast' | 'lunch' | 'dinner') => void;
  onResetMealPlan: () => void;
}

export function MealPlannerView({
  recipes,
  mealPlan,
  onOpenRecipe,
  onGenerateDayShoppingList,
  onGenerateWeeklyShoppingList,
  onSelectSlotRecipe,
  onRemoveSlotRecipe,
  onResetMealPlan,
}: MealPlannerViewProps) {
  const [selectingSlot, setSelectingSlot] = useState<{ dayIndex: number; mealType: 'breakfast' | 'lunch' | 'dinner' } | null>(null);
  const [modalSearchQuery, setModalSearchQuery] = useState('');

  const sortedRecipes = useMemo(() => {
    return [...recipes].sort((a, b) =>
      (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true })
    );
  }, [recipes]);

  const filteredModalRecipes = useMemo(() => {
    const query = modalSearchQuery.trim().toLowerCase();
    if (!query) return sortedRecipes;
    return sortedRecipes.filter((r) => {
      const matchTitle = (r.title || '').toLowerCase().includes(query);
      const matchCuisine = (r.cuisine || '').toLowerCase().includes(query);
      const matchCategory = (r.category || '').toLowerCase().includes(query);
      const matchTags = r.tags && r.tags.some((t) => t.toLowerCase().includes(query));
      return matchTitle || matchCuisine || matchCategory || matchTags;
    });
  }, [sortedRecipes, modalSearchQuery]);

  const totalPlannedMeals = mealPlan.reduce(
    (acc, d) =>
      acc +
      (d.breakfast?.recipeTitle ? 1 : 0) +
      (d.lunch?.recipeTitle ? 1 : 0) +
      (d.dinner?.recipeTitle ? 1 : 0),
    0
  );

  const handleSelectRecipeForSlot = (recipe: ObsidianRecipe) => {
    if (!selectingSlot) return;
    const { dayIndex, mealType } = selectingSlot;
    onSelectSlotRecipe(dayIndex, mealType, recipe);
    setSelectingSlot(null);
    setModalSearchQuery('');
  };

  const handleRemoveSlot = (dayIndex: number, mealType: 'breakfast' | 'lunch' | 'dinner') => {
    onRemoveSlotRecipe(dayIndex, mealType);
  };

  const SLOT_LABEL: Record<'breakfast' | 'lunch' | 'dinner', string> = {
    breakfast: 'Breakfast',
    lunch: 'Lunch',
    dinner: 'Dinner',
  };

  return (
    <div id="obsidian-meal-planner-view" className="max-w-7xl mx-auto kc-vault-surface py-6 space-y-6">
      {/* Editorial header */}
      <header className="space-y-2 pb-4 border-b border-[var(--color-rule,var(--bg-elevated))]">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold text-[var(--text-muted,#6B7280)]">
          <Calendar className="w-4 h-4" aria-hidden="true" />
          <span>Meal Planner</span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="font-serif text-[32px] sm:text-[40px] leading-[1.15] text-[var(--text-primary,#F3F4F6)]">
              Weekly Meal Plan
            </h1>
            <p className="text-[14px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)] max-w-2xl">
              Plan your favorite meals for the week, then bring everything you need into your shopping list.
            </p>
          </div>
          <span
            className={`inline-flex items-center px-3 py-1 rounded-full text-[12px] font-semibold border ${
              totalPlannedMeals > 0
                ? 'bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)] border-[var(--accent-text,#F59E0B)]'
                : 'bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-muted,#6B7280)] border-[var(--color-control-border,rgba(255,255,255,0.1))]'
            }`}
          >
            {totalPlannedMeals} {totalPlannedMeals === 1 ? 'meal planned' : 'meals planned'}
          </span>
        </div>
      </header>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          id="generate-full-week-shopping-btn"
          onClick={onGenerateWeeklyShoppingList}
          disabled={totalPlannedMeals === 0}
          title={totalPlannedMeals === 0 ? 'Add meals to generate shopping list' : 'View ingredients for all planned meals'}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold bg-[var(--accent,#F59E0B)] text-[var(--color-on-accent,#0C0C0C)] min-h-[44px] shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-[140ms]"
        >
          <ShoppingCart className="w-4 h-4" aria-hidden="true" />
          <span>Weekly Shopping List{totalPlannedMeals > 0 ? ` (${totalPlannedMeals})` : ''}</span>
        </button>

        <button
          id="reset-meal-plan-btn"
          onClick={onResetMealPlan}
          title="Reset meal plan and clear shopping list"
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px] hover:text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms]"
        >
          <RotateCcw className="w-4 h-4" aria-hidden="true" />
          <span>Reset Week</span>
        </button>
      </div>

      {/* 7-day grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 min-[1800px]:grid-cols-7 gap-4">
        {mealPlan.map((day, dayIndex) => {
          const dayRecipeCount =
            (day.breakfast?.recipeTitle ? 1 : 0) +
            (day.lunch?.recipeTitle ? 1 : 0) +
            (day.dinner?.recipeTitle ? 1 : 0);

          return (
            <div
              key={day.dayName}
              id={`meal-plan-day-${day.dayName.toLowerCase()}`}
              className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-4 flex flex-col gap-3"
            >
              <div className="pb-2 border-b border-[var(--color-rule,var(--bg-elevated))] flex items-center justify-between">
                <h3 className="font-serif text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)] uppercase tracking-wider">
                  {day.dayName}
                </h3>
                <span
                  className={`w-2 h-2 rounded-full ${dayRecipeCount > 0 ? 'bg-[var(--accent-text,#F59E0B)]' : 'bg-[var(--text-muted,#6B7280)]'}`}
                  aria-hidden="true"
                />
              </div>

              {(['breakfast', 'lunch', 'dinner'] as const).map((mealType) => {
                const slot = day[mealType];
                const filled = !!slot?.recipeTitle;
                return (
                  <div key={mealType} className="space-y-1">
                    <span className="text-[10px] font-semibold text-[var(--text-muted,#6B7280)] uppercase tracking-wide">
                      {SLOT_LABEL[mealType]}
                    </span>
                    {filled ? (
                      <div className="p-2.5 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] text-[12px] text-[var(--text-primary,#F3F4F6)] flex items-start justify-between gap-2 group">
                        <span
                          onClick={() => slot?.recipeId && onOpenRecipe(slot.recipeId)}
                          className="font-medium cursor-pointer hover:text-[var(--accent-text,#F59E0B)] leading-tight line-clamp-2 transition-colors"
                        >
                          {slot!.recipeTitle}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveSlot(dayIndex, mealType);
                          }}
                          aria-label={`Remove ${slot!.recipeTitle} from ${day.dayName} ${mealType}`}
                          title={`Remove ${slot!.recipeTitle}`}
                          className="shrink-0 w-11 h-11 flex items-center justify-center rounded-lg text-[var(--text-muted,#6B7280)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors duration-[140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring,#F59E0B)]"
                        >
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setSelectingSlot({ dayIndex, mealType })}
                        className="w-full py-2 px-2 rounded-xl border border-dashed border-[var(--color-control-border,rgba(255,255,255,0.1))] hover:border-[var(--accent-text,#F59E0B)] hover:bg-[var(--accent-subtle,rgba(245,158,11,0.1))] text-[var(--text-muted,#6B7280)] hover:text-[var(--text-primary,#F3F4F6)] text-[11px] flex items-center justify-center gap-1 transition-colors duration-[140ms] min-h-[44px]"
                      >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Add {SLOT_LABEL[mealType]}</span>
                      </button>
                    )}
                  </div>
                );
              })}

              <div className="pt-2 border-t border-[var(--color-rule,var(--bg-elevated))]">
                <button
                  id={`generate-shopping-${day.dayName.toLowerCase()}-btn`}
                  onClick={() => onGenerateDayShoppingList(day)}
                  disabled={dayRecipeCount === 0}
                  title={dayRecipeCount === 0 ? `No meals planned for ${day.dayName}` : `Generate shopping list for ${day.dayName}`}
                  className="w-full flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] hover:bg-[var(--bg-surface,#141414)] disabled:opacity-30 disabled:cursor-not-allowed text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)] text-xs font-semibold transition-colors duration-[140ms] border border-[var(--color-control-border,rgba(255,255,255,0.1))]"
                >
                  <ShoppingCart className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Shopping List{dayRecipeCount > 0 ? ` (${dayRecipeCount})` : ''}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Recipe Selection Modal */}
      {selectingSlot && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="meal-select-title">
          <div className="bg-[var(--bg-surface,#141414)] rounded-2xl border border-[var(--color-control-border,rgba(255,255,255,0.1))] max-w-lg w-full p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col text-[var(--text-primary,#F3F4F6)]">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--color-rule,var(--bg-elevated))]">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <h3 id="meal-select-title" className="font-serif font-bold text-sm text-[var(--text-primary,#F3F4F6)]">
                    Select Recipe for {mealPlan[selectingSlot.dayIndex]?.dayName}
                  </h3>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)] border border-[var(--accent-text,#F59E0B)] capitalize">
                    {selectingSlot.mealType}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--text-muted,#6B7280)]">
                  Sorted alphabetically ({filteredModalRecipes.length} of {recipes.length} {recipes.length === 1 ? 'recipe' : 'recipes'})
                </p>
              </div>
              <button
                onClick={() => {
                  setSelectingSlot(null);
                  setModalSearchQuery('');
                }}
                aria-label="Close recipe selector"
                className="p-1 text-[var(--text-muted,#6B7280)] hover:text-[var(--text-primary,#F3F4F6)] rounded-lg hover:bg-[var(--bg-elevated,#1E1E1E)] transition-colors"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {recipes.length > 5 && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted,#6B7280)]" aria-hidden="true" />
                <input
                  type="text"
                  value={modalSearchQuery}
                  onChange={(e) => setModalSearchQuery(e.target.value)}
                  placeholder="Filter recipes by title, cuisine, or tag..."
                  autoFocus
                  aria-label="Filter recipes"
                  className="w-full pl-8 pr-8 py-2 bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-xl text-xs text-[var(--text-primary,#F3F4F6)] placeholder:text-[var(--text-muted,#6B7280)] focus:outline-none focus:border-[var(--accent-text,#F59E0B)] min-h-[44px]"
                />
                {modalSearchQuery && (
                  <button
                    onClick={() => setModalSearchQuery('')}
                    aria-label="Clear search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted,#6B7280)] hover:text-[var(--text-primary,#F3F4F6)] p-0.5"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            <div className="overflow-y-auto space-y-2 flex-1 pr-1">
              {filteredModalRecipes.length === 0 ? (
                <div className="text-center py-8 text-[var(--text-muted,#6B7280)] space-y-1.5">
                  <Utensils className="w-7 h-7 mx-auto opacity-40 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                  <p className="text-xs font-medium text-[var(--text-secondary,#9CA3AF)]">
                    {modalSearchQuery ? `No recipes matching "${modalSearchQuery}"` : 'No recipes available in your vault.'}
                  </p>
                  {modalSearchQuery && (
                    <button
                      onClick={() => setModalSearchQuery('')}
                      className="text-[11px] text-[var(--accent-text,#F59E0B)] hover:underline"
                    >
                      Clear search filter
                    </button>
                  )}
                </div>
              ) : (
                filteredModalRecipes.map((recipe) => {
                  const thumb = getRecipeImage(recipe);
                  return (
                    <div
                      key={recipe.id}
                      onClick={() => handleSelectRecipeForSlot(recipe)}
                      className="p-2.5 rounded-xl border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] hover:border-[var(--accent-text,#F59E0B)] hover:bg-[var(--bg-surface,#141414)] cursor-pointer transition-all flex items-center justify-between gap-3 group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {thumb && (
                          <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-black/50">
                            <img
                              src={thumb}
                              alt={recipe.title}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                            />
                          </div>
                        )}
                        <div className="min-w-0">
                          <h4 className="font-serif font-bold text-xs text-[var(--text-primary,#F3F4F6)] group-hover:text-[var(--accent-text,#F59E0B)] transition-colors truncate">
                            {recipe.title}
                          </h4>
                          <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted,#6B7280)] mt-0.5">
                            {recipe.cuisine && <span>{recipe.cuisine}</span>}
                            {recipe.cookTime && <span>• {recipe.cookTime}</span>}
                            {recipe.difficulty && <span>• {recipe.difficulty}</span>}
                          </div>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-[var(--text-muted,#6B7280)] group-hover:text-[var(--accent-text,#F59E0B)] group-hover:translate-x-0.5 transition-all shrink-0" aria-hidden="true" />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
