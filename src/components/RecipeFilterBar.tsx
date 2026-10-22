import React from 'react';
import { X, Clock, Flame, Sparkles, Star, Tag, ChefHat, RotateCcw } from 'lucide-react';
import { FilterState } from '../types';

interface RecipeFilterBarProps {
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  availableTags: string[];
  availableCuisines: string[];
  availableCategories: string[];
  totalResults: number;
  onResetFilters: () => void;
}

export function RecipeFilterBar({
  filters,
  setFilters,
  availableTags,
  availableCuisines,
  availableCategories,
  totalResults,
  onResetFilters,
}: RecipeFilterBarProps) {
  return (
    <div
      id="recipe-filter-drawer"
      className="bg-[#0F0F0F] border-b border-white/5 p-4 sm:p-5 transition-all duration-200"
    >
      <div className="max-w-7xl mx-auto space-y-4">
        {/* Header & Reset */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              Filter Vault Notes
            </span>
            <span className="text-xs text-gray-400">
              ({totalResults} matching)
            </span>
          </div>

          <button
            id="reset-filters-btn"
            onClick={onResetFilters}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-amber-400 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset all filters</span>
          </button>
        </div>

        {/* Quick Tags Filter Pills */}
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-300 mb-2">
            <Tag className="w-3.5 h-3.5 text-amber-400" />
            <span>Obsidian Tags (#tag)</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {availableTags.slice(0, 14).map((tag) => {
              const isSelected = filters.tag === tag;
              return (
                <button
                  key={tag}
                  id={`filter-tag-${tag.replace(/[^a-zA-Z0-9]/g, '-')}`}
                  onClick={() =>
                    setFilters((prev) => ({
                      ...prev,
                      tag: isSelected ? null : tag,
                    }))
                  }
                  className={`px-2.5 py-1 rounded-md text-xs transition-all font-mono ${
                    isSelected
                      ? 'bg-amber-500 text-black font-semibold shadow-xs'
                      : 'bg-white/5 text-gray-300 border border-white/10 hover:border-amber-500/40 hover:bg-white/10'
                  }`}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        </div>

        {/* Filter Dropdowns Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {/* Cuisine Filter */}
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1">
              Cuisine
            </label>
            <select
              id="filter-cuisine-select"
              value={filters.cuisine || ''}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  cuisine: e.target.value || null,
                }))
              }
              className="w-full text-xs bg-[#141414] border border-white/10 rounded-lg p-1.5 text-gray-200 focus:border-amber-500/60 focus:outline-none"
            >
              <option value="" className="bg-[#141414] text-gray-300">All Cuisines</option>
              {availableCuisines.map((c) => (
                <option key={c} value={c} className="bg-[#141414] text-gray-300">
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Category Filter */}
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1">
              Category
            </label>
            <select
              id="filter-category-select"
              value={filters.category || ''}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  category: e.target.value || null,
                }))
              }
              className="w-full text-xs bg-[#141414] border border-white/10 rounded-lg p-1.5 text-gray-200 focus:border-amber-500/60 focus:outline-none"
            >
              <option value="" className="bg-[#141414] text-gray-300">All Categories</option>
              {availableCategories.map((cat) => (
                <option key={cat} value={cat} className="bg-[#141414] text-gray-300">
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* Max Cook Time */}
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1">
              Max Time
            </label>
            <select
              id="filter-time-select"
              value={filters.maxCookTime || ''}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  maxCookTime: e.target.value ? parseInt(e.target.value, 10) : null,
                }))
              }
              className="w-full text-xs bg-[#141414] border border-white/10 rounded-lg p-1.5 text-gray-200 focus:border-amber-500/60 focus:outline-none"
            >
              <option value="" className="bg-[#141414] text-gray-300">Any Duration</option>
              <option value="15" className="bg-[#141414] text-gray-300">≤ 15 mins (Super Fast)</option>
              <option value="30" className="bg-[#141414] text-gray-300">≤ 30 mins (Weeknight)</option>
              <option value="45" className="bg-[#141414] text-gray-300">≤ 45 mins</option>
              <option value="60" className="bg-[#141414] text-gray-300">≤ 60 mins</option>
            </select>
          </div>

          {/* Difficulty */}
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1">
              Difficulty
            </label>
            <select
              id="filter-difficulty-select"
              value={filters.difficulty || ''}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  difficulty: e.target.value || null,
                }))
              }
              className="w-full text-xs bg-[#141414] border border-white/10 rounded-lg p-1.5 text-gray-200 focus:border-amber-500/60 focus:outline-none"
            >
              <option value="" className="bg-[#141414] text-gray-300">All Difficulties</option>
              <option value="Easy" className="bg-[#141414] text-gray-300">Easy</option>
              <option value="Medium" className="bg-[#141414] text-gray-300">Medium</option>
              <option value="Hard" className="bg-[#141414] text-gray-300">Hard / Project</option>
            </select>
          </div>

          {/* Sort By */}
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1">
              Sort By
            </label>
            <select
              id="filter-sort-select"
              value={filters.sortBy}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  sortBy: e.target.value as any,
                }))
              }
              className="w-full text-xs bg-[#141414] border border-white/10 rounded-lg p-1.5 text-gray-200 focus:border-amber-500/60 focus:outline-none"
            >
              <option value="title" className="bg-[#141414] text-gray-300">Title (A - Z)</option>
              <option value="rating" className="bg-[#141414] text-gray-300">Rating (Highest)</option>
              <option value="cookTime" className="bg-[#141414] text-gray-300">Cook Time (Fastest)</option>
              <option value="recent" className="bg-[#141414] text-gray-300">Recently Added</option>
              <option value="servings" className="bg-[#141414] text-gray-300">Servings</option>
            </select>
          </div>

          {/* Favorites Toggle */}
          <div className="flex items-end">
            <button
              id="filter-favorite-toggle-btn"
              onClick={() =>
                setFilters((prev) => ({
                  ...prev,
                  onlyFavorites: !prev.onlyFavorites,
                }))
              }
              className={`w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-medium border transition-colors ${
                filters.onlyFavorites
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 font-semibold'
                  : 'bg-[#141414] border-white/10 text-gray-300 hover:bg-white/5'
              }`}
            >
              <Star className={`w-3.5 h-3.5 ${filters.onlyFavorites ? 'fill-amber-400 text-amber-400' : 'text-gray-500'}`} />
              <span>Favorites Only</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
