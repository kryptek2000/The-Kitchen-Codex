import React, { useState } from 'react';
import {
  Table as TableIcon,
  Star,
  Clock,
  Flame,
  Users,
  Play,
  FileCode,
  ArrowUpDown,
  ExternalLink,
} from 'lucide-react';
import { ObsidianRecipe } from '../types';
import { getRecipeImage, DEFAULT_FOOD_IMAGES } from '../utils/imageHelper';

interface DataviewTableViewProps {
  recipes: ObsidianRecipe[];
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
  onStartCooking: (recipe: ObsidianRecipe) => void;
}

type SortField = 'title' | 'cuisine' | 'category' | 'prepTime' | 'cookTime' | 'servings' | 'rating' | 'calories';

export function DataviewTableView({
  recipes,
  onSelectRecipe,
  onStartCooking,
}: DataviewTableViewProps) {
  const [sortField, setSortField] = useState<SortField>('title');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const sortedRecipes = [...recipes].sort((a, b) => {
    let valA: any = a[sortField] ?? '';
    let valB: any = b[sortField] ?? '';

    if (sortField === 'rating' || sortField === 'servings') {
      valA = Number(valA) || 0;
      valB = Number(valB) || 0;
    } else {
      valA = String(valA).toLowerCase();
      valB = String(valB).toLowerCase();
    }

    if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
    if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  return (
    <div id="obsidian-dataview-table-view" className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      {/* Dataview Query Code Header */}
      <div className="bg-[#0C0C0C] text-amber-400/90 rounded-xl p-3 font-mono text-xs border border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileCode className="w-4 h-4 text-amber-400" />
          <span className="text-gray-500">```dataview</span>
          <span className="text-emerald-400 font-bold">TABLE</span>
          <span className="text-gray-300">cuisine, category, prep_time, cook_time, servings, rating, tags</span>
          <span className="text-amber-400 font-bold">FROM</span>
          <span className="text-amber-300">#food/recipes</span>
        </div>
        <span className="text-gray-500 text-[11px]">
          {recipes.length} recipes returned
        </span>
      </div>

      {/* Table Container */}
      <div className="bg-[#141414] rounded-2xl border border-white/10 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0C0C0C] border-b border-white/10 text-gray-400 font-bold">
              <tr>
                <th
                  onClick={() => handleSort('title')}
                  className="py-3 px-4 cursor-pointer hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Recipe Title (File)</span>
                    <ArrowUpDown className="w-3 h-3 text-gray-500" />
                  </div>
                </th>
                <th
                  onClick={() => handleSort('cuisine')}
                  className="py-3 px-3 cursor-pointer hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Cuisine</span>
                    <ArrowUpDown className="w-3 h-3 text-gray-500" />
                  </div>
                </th>
                <th
                  onClick={() => handleSort('category')}
                  className="py-3 px-3 cursor-pointer hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Category</span>
                    <ArrowUpDown className="w-3 h-3 text-gray-500" />
                  </div>
                </th>
                <th
                  onClick={() => handleSort('prepTime')}
                  className="py-3 px-3 cursor-pointer hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Prep</span>
                    <ArrowUpDown className="w-3 h-3 text-gray-500" />
                  </div>
                </th>
                <th
                  onClick={() => handleSort('cookTime')}
                  className="py-3 px-3 cursor-pointer hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Cook</span>
                    <ArrowUpDown className="w-3 h-3 text-gray-500" />
                  </div>
                </th>
                <th
                  onClick={() => handleSort('servings')}
                  className="py-3 px-3 cursor-pointer hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Servings</span>
                    <ArrowUpDown className="w-3 h-3 text-gray-500" />
                  </div>
                </th>
                <th
                  onClick={() => handleSort('rating')}
                  className="py-3 px-3 cursor-pointer hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Rating</span>
                    <ArrowUpDown className="w-3 h-3 text-gray-500" />
                  </div>
                </th>
                <th className="py-3 px-4">Tags</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-white/5">
              {sortedRecipes.map((recipe) => (
                <tr
                  key={recipe.id}
                  id={`dataview-row-${recipe.id}`}
                  onClick={() => onSelectRecipe(recipe)}
                  className="hover:bg-white/5 cursor-pointer transition-colors group"
                >
                  {/* Title & File with Image Thumbnail */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-lg overflow-hidden shrink-0 border border-white/10 bg-black">
                        <img
                          src={getRecipeImage(recipe)}
                          alt={recipe.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            if (target.src !== DEFAULT_FOOD_IMAGES.default) {
                              target.src = DEFAULT_FOOD_IMAGES.default;
                            }
                          }}
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="font-serif font-bold text-white group-hover:text-amber-400 transition-colors truncate">
                          {recipe.title}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Cuisine */}
                  <td className="py-3 px-3 font-medium text-gray-300">
                    {recipe.cuisine}
                  </td>

                  {/* Category */}
                  <td className="py-3 px-3 text-gray-400">
                    {recipe.category}
                  </td>

                  {/* Prep Time */}
                  <td className="py-3 px-3 text-gray-400 font-mono">
                    {recipe.prepTime || '—'}
                  </td>

                  {/* Cook Time */}
                  <td className="py-3 px-3 text-gray-400 font-mono">
                    {recipe.cookTime || '—'}
                  </td>

                  {/* Servings */}
                  <td className="py-3 px-3 text-gray-300 font-semibold font-mono">
                    {recipe.servings ? recipe.servings : '—'}
                  </td>

                  {/* Rating */}
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-0.5 text-amber-500">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`w-3 h-3 ${i < recipe.rating ? 'fill-amber-400 text-amber-400' : 'text-zinc-700'}`}
                        />
                      ))}
                    </div>
                  </td>

                  {/* Tags */}
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {recipe.tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/5 text-gray-400"
                        >
                          #{tag}
                        </span>
                      ))}
                      {recipe.tags.length > 2 && (
                        <span className="text-[10px] text-gray-500">
                          +{recipe.tags.length - 2}
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Actions */}
                  <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                    <button
                      id={`dataview-cook-btn-${recipe.id}`}
                      onClick={() => onStartCooking(recipe)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs shadow-md shadow-amber-500/20 transition-colors"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>Cook</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
