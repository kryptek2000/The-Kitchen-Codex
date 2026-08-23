import React, { useState } from 'react';
import {
  Clock,
  Users,
  Flame,
  Star,
  Play,
  FileText,
  CalendarPlus,
  Sparkles,
} from 'lucide-react';
import { ObsidianRecipe } from '../types';
import { getRecipeImage, DEFAULT_FOOD_IMAGES } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';

interface RecipeCardProps {
  recipe: ObsidianRecipe;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
  onStartCooking: (recipe: ObsidianRecipe) => void;
  onToggleFavorite: (recipeId: string) => void;
  onAddToMealPlan: (recipe: ObsidianRecipe) => void;
}

export function RecipeCard({
  recipe,
  onSelectRecipe,
  onStartCooking,
  onToggleFavorite,
  onAddToMealPlan,
}: RecipeCardProps) {
  const isFavorite = !!recipe.isFavorite;
  const [imageError, setImageError] = useState(false);

  const difficultyColors = {
    Easy: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60',
    Medium: 'bg-amber-950/80 text-amber-300 border-amber-700/60',
    Hard: 'bg-rose-950/80 text-rose-300 border-rose-700/60',
  };

  const defaultImg = getRecipeImage(recipe);
  const reactiveVaultImage = useVaultImage(recipe.image, defaultImg);
  const imageUrl = imageError ? DEFAULT_FOOD_IMAGES.default : (reactiveVaultImage || defaultImg);
  const firstCallout = recipe.callouts && recipe.callouts.length > 0 ? recipe.callouts[0] : null;

  return (
    <div
      id={`recipe-card-${recipe.id}`}
      onClick={() => onSelectRecipe(recipe)}
      className="group bg-[#141414] rounded-2xl border border-white/5 hover:border-amber-500/40 shadow-md hover:bg-[#181818] transition-all duration-200 flex flex-col justify-between overflow-hidden cursor-pointer"
    >
      <div>
        {/* Photo Banner Header */}
        <div className="relative h-44 w-full overflow-hidden bg-[#0C0C0C]">
          <img
            src={imageUrl}
            alt={recipe.title}
            referrerPolicy="no-referrer"
            onError={() => setImageError(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          />

          {/* Top Gradient Overlay for readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/60 pointer-events-none" />

          {/* Top Badges: Category & Favorite Button */}
          <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-black/70 backdrop-blur-md text-amber-300 border border-white/15 truncate max-w-[70%]">
              <span>{recipe.cuisine} • {recipe.category}</span>
            </span>

            <button
              id={`favorite-btn-${recipe.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(recipe.id);
              }}
              className="p-2 rounded-full bg-black/70 backdrop-blur-md hover:bg-black/90 text-gray-400 hover:text-amber-400 border border-white/15 transition-all shadow-sm"
              title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Star
                className={`w-3.5 h-3.5 ${isFavorite ? 'fill-amber-400 text-amber-400' : ''}`}
              />
            </button>
          </div>

          {/* Bottom Badges on Image: Difficulty & Rating */}
          <div className="absolute bottom-3 right-3 flex items-center gap-1.5 bg-black/75 backdrop-blur-md px-2.5 py-1 rounded-full border border-white/15">
            <span
              className={`text-[10px] font-bold px-1.5 py-0.2 rounded border ${
                difficultyColors[recipe.difficulty] || difficultyColors.Medium
              }`}
            >
              {recipe.difficulty}
            </span>
            <div className="flex items-center text-amber-400 text-[10px]">
              <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              <span className="ml-0.5 font-bold">{recipe.rating}</span>
            </div>
          </div>
        </div>

        {/* Card Body */}
        <div className="p-4 sm:p-5">
          {/* Title: Pure Recipe Name, No Hyperlinks */}
          <h3 className="text-base font-serif font-semibold text-white group-hover:text-amber-300 transition-colors line-clamp-1 mb-2 tracking-tight">
            {recipe.title}
          </h3>

          {/* Obsidian Tags */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {recipe.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-amber-300 border border-white/10"
              >
                #{tag}
              </span>
            ))}
            {recipe.tags.length > 3 && (
              <span className="text-[10px] px-1 py-0.5 text-gray-500">
                +{recipe.tags.length - 3}
              </span>
            )}
          </div>

          {/* Timing & Servings info */}
          <div className="grid grid-cols-3 gap-2 py-2 px-3 rounded-xl bg-[#0C0C0C] border border-white/5 text-xs text-gray-300 mb-3">
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-500 flex items-center gap-1">
                <Clock className="w-2.5 h-2.5 text-gray-400" /> Prep
              </span>
              <span className="font-medium text-gray-200 text-xs truncate">
                {recipe.prepTime || '—'}
              </span>
            </div>

            <div className="flex flex-col">
              <span className="text-[10px] text-gray-500 flex items-center gap-1">
                <Flame className="w-2.5 h-2.5 text-amber-400" /> Cook
              </span>
              <span className="font-medium text-gray-200 text-xs truncate">
                {recipe.cookTime || '—'}
              </span>
            </div>

            <div className="flex flex-col">
              <span className="text-[10px] text-gray-500 flex items-center gap-1">
                <Users className="w-2.5 h-2.5 text-gray-400" /> Yield
              </span>
              <span className="font-medium text-gray-200 text-xs truncate">
                {recipe.servings ? `${recipe.servings} srv` : '—'}
              </span>
            </div>
          </div>

          {/* Callout Preview if available */}
          {firstCallout && (
            <div className="text-xs p-2.5 rounded-xl bg-amber-500/5 border border-amber-500/20 text-gray-300 mb-3 line-clamp-2">
              <span className="font-semibold text-amber-400 block text-[11px] mb-0.5">
                💡 {firstCallout.title || "Chef's Tip"}:
              </span>
              <span className="text-gray-400 italic">{firstCallout.content.replace(/\n/g, ' ')}</span>
            </div>
          )}

          {/* Wikilink Preview tags */}
          {recipe.wikilinks && recipe.wikilinks.length > 0 && (
            <div className="flex items-center gap-1 text-[11px] text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap">
              <span className="text-amber-400 font-semibold text-[10px]">[[links]]:</span>
              {recipe.wikilinks.slice(0, 3).map((wl, i) => (
                <span key={wl} className="text-gray-400 font-mono text-[10px]">
                  [[{wl}]]{i < Math.min(recipe.wikilinks.length, 3) - 1 ? ',' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Card Footer Actions */}
      <div className="px-4 sm:px-5 py-3 bg-[#0F0F0F] border-t border-white/5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            id={`mealplan-btn-${recipe.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onAddToMealPlan(recipe);
            }}
            className="p-1.5 rounded-lg text-gray-400 hover:text-amber-300 hover:bg-white/5 transition-colors"
            title="Add to Weekly Meal Plan"
          >
            <CalendarPlus className="w-4 h-4" />
          </button>

          <button
            id={`open-detail-btn-${recipe.id}`}
            onClick={() => onSelectRecipe(recipe)}
            className="text-xs font-medium text-gray-400 hover:text-gray-100 px-2 py-1 rounded hover:bg-white/5 transition-colors"
          >
            Details
          </button>
        </div>

        <button
          id={`start-cooking-btn-${recipe.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onStartCooking(recipe);
          }}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold shadow-xs transition-colors"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          <span>Cook Mode</span>
        </button>
      </div>
    </div>
  );
}
