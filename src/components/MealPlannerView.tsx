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
  ChefHat,
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

  // Always sort recipes in alphabetical order (A-Z) by title
  const sortedRecipes = useMemo(() => {
    return [...recipes].sort((a, b) =>
      (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true })
    );
  }, [recipes]);

  // Filter sorted recipes if a search query is entered
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

  return (
    <div id="obsidian-meal-planner-view" className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Top Banner with Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#141414] p-5 rounded-2xl border border-white/10 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-serif font-bold text-white flex items-center gap-2">
              <Calendar className="w-5 h-5 text-amber-400" />
              <span>Weekly Obsidian Meal Plan</span>
            </h2>
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${
              totalPlannedMeals > 0
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-white/5 text-gray-500 border-white/5'
            }`}>
              {totalPlannedMeals} {totalPlannedMeals === 1 ? 'meal planned' : 'meals planned'}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {totalPlannedMeals === 0
              ? 'Plan meals across your week to automatically populate your grocery shopping checklist.'
              : 'Ingredients from planned meals are synced directly to your weekly shopping list.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Generate Full Week Shopping List */}
          <button
            id="generate-full-week-shopping-btn"
            onClick={onGenerateWeeklyShoppingList}
            disabled={totalPlannedMeals === 0}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-400 text-black shadow-md shadow-amber-500/20 transition-all disabled:opacity-40 disabled:hover:bg-amber-500 disabled:cursor-not-allowed cursor-pointer"
            title={totalPlannedMeals === 0 ? 'Add meals to generate shopping list' : 'View ingredients for all planned meals'}
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            <span>Weekly Shopping List {totalPlannedMeals > 0 ? `(${totalPlannedMeals})` : ''}</span>
          </button>

          {/* Reset Week Button */}
          <button
            id="reset-meal-plan-btn"
            onClick={onResetMealPlan}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors cursor-pointer"
            title="Reset meal plan and clear shopping list"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Week</span>
          </button>
        </div>
      </div>

      {/* 7-Day Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-4">
        {mealPlan.map((day, dayIndex) => {
          const dayRecipeCount =
            (day.breakfast?.recipeTitle ? 1 : 0) +
            (day.lunch?.recipeTitle ? 1 : 0) +
            (day.dinner?.recipeTitle ? 1 : 0);

          return (
            <div
              key={day.dayName}
              id={`meal-plan-day-${day.dayName.toLowerCase()}`}
              className="bg-[#141414] rounded-2xl border border-white/10 p-3.5 flex flex-col justify-between shadow-xs space-y-3"
            >
              <div className="space-y-3">
                <div className="pb-2 border-b border-white/5 flex items-center justify-between">
                  <h3 className="font-bold text-xs text-white uppercase tracking-wider">
                    {day.dayName}
                  </h3>
                  <span
                    className={`w-2 h-2 rounded-full ${
                      dayRecipeCount > 0 ? 'bg-amber-500' : 'bg-zinc-700'
                    }`}
                  />
                </div>

                {/* Breakfast Slot */}
                <div className="space-y-1">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase">
                    Breakfast
                  </span>
                  {day.breakfast?.recipeTitle ? (
                    <div className="p-2 rounded-xl bg-white/5 border border-white/10 text-xs text-gray-200 flex items-start justify-between gap-1 group">
                      <span
                        onClick={() => day.breakfast?.recipeId && onOpenRecipe(day.breakfast.recipeId)}
                        className="font-medium cursor-pointer hover:text-amber-400 leading-tight line-clamp-2 transition-colors"
                      >
                        {day.breakfast.recipeTitle}
                      </span>
                      <button
                        onClick={() => handleRemoveSlot(dayIndex, 'breakfast')}
                        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-rose-400 transition-opacity"
                        title="Remove breakfast"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSelectingSlot({ dayIndex, mealType: 'breakfast' })}
                      className="w-full py-1.5 px-2 rounded-lg border border-dashed border-white/10 hover:border-amber-500/50 hover:bg-amber-500/5 text-gray-400 hover:text-gray-200 text-[11px] flex items-center justify-center gap-1 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Add Breakfast</span>
                    </button>
                  )}
                </div>

                {/* Lunch Slot */}
                <div className="space-y-1">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase">
                    Lunch
                  </span>
                  {day.lunch?.recipeTitle ? (
                    <div className="p-2 rounded-xl bg-white/5 border border-white/10 text-xs text-gray-200 flex items-start justify-between gap-1 group">
                      <span
                        onClick={() => day.lunch?.recipeId && onOpenRecipe(day.lunch.recipeId)}
                        className="font-medium cursor-pointer hover:text-amber-400 leading-tight line-clamp-2 transition-colors"
                      >
                        {day.lunch.recipeTitle}
                      </span>
                      <button
                        onClick={() => handleRemoveSlot(dayIndex, 'lunch')}
                        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-rose-400 transition-opacity"
                        title="Remove lunch"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSelectingSlot({ dayIndex, mealType: 'lunch' })}
                      className="w-full py-1.5 px-2 rounded-lg border border-dashed border-white/10 hover:border-amber-500/50 hover:bg-amber-500/5 text-gray-400 hover:text-gray-200 text-[11px] flex items-center justify-center gap-1 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Add Lunch</span>
                    </button>
                  )}
                </div>

                {/* Dinner Slot */}
                <div className="space-y-1">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase">
                    Dinner
                  </span>
                  {day.dinner?.recipeTitle ? (
                    <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 flex items-start justify-between gap-1 group">
                      <span
                        onClick={() => day.dinner?.recipeId && onOpenRecipe(day.dinner.recipeId)}
                        className="font-medium cursor-pointer hover:text-amber-200 leading-tight line-clamp-2 transition-colors"
                      >
                        {day.dinner.recipeTitle}
                      </span>
                      <button
                        onClick={() => handleRemoveSlot(dayIndex, 'dinner')}
                        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-rose-400 transition-opacity"
                        title="Remove dinner"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSelectingSlot({ dayIndex, mealType: 'dinner' })}
                      className="w-full py-1.5 px-2 rounded-lg border border-dashed border-white/10 hover:border-amber-500/50 hover:bg-amber-500/5 text-gray-400 hover:text-gray-200 text-[11px] flex items-center justify-center gap-1 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Add Dinner</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Per-Day Generate Shopping List Button */}
              <div className="pt-2 border-t border-white/5">
                <button
                  id={`generate-shopping-${day.dayName.toLowerCase()}-btn`}
                  onClick={() => onGenerateDayShoppingList(day)}
                  disabled={dayRecipeCount === 0}
                  title={
                    dayRecipeCount === 0
                      ? `No meals planned for ${day.dayName}`
                      : `Generate shopping list for ${day.dayName}`
                  }
                  className="w-full flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-30 disabled:hover:bg-amber-500 disabled:cursor-not-allowed text-black text-xs font-bold transition-all shadow-xs"
                >
                  <ShoppingCart className="w-3.5 h-3.5" />
                  <span>Shopping List {dayRecipeCount > 0 ? `(${dayRecipeCount})` : ''}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Recipe Selection Modal */}
      {selectingSlot && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[#141414] rounded-2xl border border-white/10 max-w-lg w-full p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col text-gray-200">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <h3 className="font-serif font-bold text-sm text-white">
                    Select Recipe for {mealPlan[selectingSlot.dayIndex]?.dayName}
                  </h3>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 capitalize">
                    {selectingSlot.mealType}
                  </span>
                </div>
                <p className="text-[11px] text-gray-400">
                  Sorted alphabetically ({filteredModalRecipes.length} of {recipes.length} {recipes.length === 1 ? 'recipe' : 'recipes'})
                </p>
              </div>
              <button
                onClick={() => {
                  setSelectingSlot(null);
                  setModalSearchQuery('');
                }}
                className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search Input for fast lookup */}
            {recipes.length > 5 && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="text"
                  value={modalSearchQuery}
                  onChange={(e) => setModalSearchQuery(e.target.value)}
                  placeholder="Filter recipes by title, cuisine, or tag..."
                  autoFocus
                  className="w-full pl-8 pr-8 py-2 bg-[#0C0C0C] border border-white/10 rounded-xl text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                />
                {modalSearchQuery && (
                  <button
                    onClick={() => setModalSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white p-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            {/* Alphabetical Recipe List */}
            <div className="overflow-y-auto space-y-2 flex-1 pr-1">
              {filteredModalRecipes.length === 0 ? (
                <div className="text-center py-8 text-gray-500 space-y-1.5">
                  <Utensils className="w-7 h-7 mx-auto opacity-40 text-amber-400" />
                  <p className="text-xs font-medium text-gray-400">
                    {modalSearchQuery ? `No recipes matching "${modalSearchQuery}"` : 'No recipes available in your vault.'}
                  </p>
                  {modalSearchQuery && (
                    <button
                      onClick={() => setModalSearchQuery('')}
                      className="text-[11px] text-amber-400 hover:underline"
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
                      className="p-2.5 rounded-xl border border-white/5 bg-[#0C0C0C] hover:border-amber-500/40 hover:bg-white/5 cursor-pointer transition-all flex items-center justify-between gap-3 group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {thumb && (
                          <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 border border-white/10 bg-black/50">
                            <img
                              src={thumb}
                              alt={recipe.title}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                            />
                          </div>
                        )}
                        <div className="min-w-0">
                          <h4 className="font-serif font-bold text-xs text-white group-hover:text-amber-400 transition-colors truncate">
                            {recipe.title}
                          </h4>
                          <div className="flex items-center gap-2 text-[10px] text-gray-400 mt-0.5">
                            {recipe.cuisine && <span>{recipe.cuisine}</span>}
                            {recipe.cookTime && <span>• {recipe.cookTime}</span>}
                            {recipe.difficulty && <span>• {recipe.difficulty}</span>}
                          </div>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-500 group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all shrink-0" />
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
