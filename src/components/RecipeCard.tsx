import React, { useState, useCallback } from 'react';
import {
  Clock,
  Users,
  Flame,
  Star,
  Play,
  CalendarPlus,
} from 'lucide-react';
import { ObsidianRecipe } from '../types';
import { getRecipeImage, LOCAL_RECIPE_IMAGE_PLACEHOLDER } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';

interface RecipeCardProps {
  recipe: ObsidianRecipe;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
  onStartCooking: (recipe: ObsidianRecipe) => void;
  onToggleFavorite: (recipeId: string) => void;
  onAddToMealPlan: (recipe: ObsidianRecipe) => void;
  /** When true, the card spans two tracks (featured). */
  featured?: boolean;
}

/**
 * RV-2 editorial recipe card.
 *
 * - Unobscured photography: the photo is a clean image with no text overlays.
 * - Honest no-photo treatment: when a recipe has no explicit image, a neutral
 *   note surface with "No photo added." is shown instead of a stock photo.
 * - Titles wrap naturally (no truncation / fixed title height).
 * - Prep + cook + explicit servings are shown.
 * - Favorites are accessible: 44px target, aria-pressed, live announcement.
 * - Strong keyboard focus: visible outer ring, Enter/Space activates.
 */
export function RecipeCard({
  recipe,
  onSelectRecipe,
  onStartCooking,
  onToggleFavorite,
  onAddToMealPlan,
  featured = false,
}: RecipeCardProps) {
  const isFavorite = !!recipe.isFavorite;
  const [imageError, setImageError] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const defaultImg = getRecipeImage(recipe);
  const reactiveVaultImage = useVaultImage(recipe.image, defaultImg);
  const imageUrl = imageError ? null : (reactiveVaultImage || defaultImg);

  const hasExplicitImage =
    Boolean(recipe.image) ||
    /!\[\[?[^\]]*\.(?:jpg|jpeg|png|webp|avif|gif|svg)\]\]?/i.test(recipe.rawMarkdown || '') ||
    /!\[[^\]]*\]\([^\)]*\.(?:jpg|jpeg|png|webp|avif|gif|svg)\)/i.test(recipe.rawMarkdown || '');

  const showPhoto = hasExplicitImage && !!imageUrl && imageUrl !== LOCAL_RECIPE_IMAGE_PLACEHOLDER && !imageError;

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFavorite(recipe.id);
      setAnnouncement(isFavorite ? 'Removed from favorites' : 'Added to favorites');
    },
    [isFavorite, onToggleFavorite, recipe.id]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectRecipe(recipe);
      }
    },
    [onSelectRecipe, recipe]
  );

  const difficultyColors = {
    Easy: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60',
    Medium: 'bg-amber-950/80 text-amber-300 border-amber-700/60',
    Hard: 'bg-rose-950/80 text-rose-300 border-rose-700/60',
  };

  return (
    <article
      id={`recipe-card-${recipe.id}`}
      onClick={() => onSelectRecipe(recipe)}
      className={`group bg-[#141414] rounded-xl border border-white/5 hover:border-amber-500/40 shadow-md hover:bg-[#181818] transition-all duration-200 flex flex-col justify-between overflow-hidden cursor-pointer motion-reduce:transition-none ${
        featured ? 'md:col-span-2 lg:col-span-1 xl:col-span-2' : ''
      }`}
    >
      <div>
        {/* Photo — clean, unobscured */}
        <div
          className={`relative w-full overflow-hidden bg-[#0C0C0C] ${
            featured ? 'h-44 md:h-56' : 'h-56'
          }`}
        >
          {showPhoto ? (
            <img
              src={imageUrl as string}
              alt={recipe.title}
              referrerPolicy="no-referrer"
              onError={() => setImageError(true)}
              className="w-full h-full object-cover group-hover:scale-[1.018] transition-transform duration-200 motion-reduce:transition-none motion-reduce:transform-none"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-[var(--bg-elevated,#1E1E1E)] text-gray-400">
              <span className="text-sm font-medium">No photo added.</span>
            </div>
          )}

          {/* Favorite control overlaid on photo corner (44px target) */}
          <button
            id={`favorite-btn-${recipe.id}`}
            onClick={handleToggleFavorite}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center rounded-full bg-black/60 backdrop-blur-sm hover:bg-black/80 text-gray-300 hover:text-amber-400 border border-white/15 transition-all shadow-sm focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            <Star className={`w-4 h-4 ${isFavorite ? 'fill-amber-400 text-amber-400' : ''}`} />
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>
        </div>

        {/* Caption */}
        <div className="p-4 sm:p-5 space-y-2">
          <p className="text-sm text-gray-400">
            {recipe.cuisine} • {recipe.category}
          </p>

          <h3 className="font-serif text-xl sm:text-2xl font-semibold leading-tight break-words">
            <button
              type="button"
              onClick={() => onSelectRecipe(recipe)}
              className="text-left text-white group-hover:text-amber-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
            >
              {recipe.title}
            </button>
          </h3>

          {recipe.tags && recipe.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {recipe.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="text-xs font-mono px-2 py-0.5 rounded bg-white/5 text-amber-300 border border-white/10"
                >
                  #{tag}
                </span>
              ))}
              {recipe.tags.length > 3 && (
                <span className="text-xs px-1 py-0.5 text-gray-500">+{recipe.tags.length - 3}</span>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 py-2 px-3 rounded-xl bg-[#0C0C0C] border border-white/5 text-xs text-gray-300">
            <div className="flex flex-col">
              <span className="text-xs text-gray-500 flex items-center gap-1">
                <Clock className="w-3 h-3 text-gray-400" /> Prep
              </span>
              <span className="font-medium text-gray-200 text-xs">
                {recipe.prepTime || '—'}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-gray-500 flex items-center gap-1">
                <Flame className="w-3 h-3 text-amber-400" /> Cook
              </span>
              <span className="font-medium text-gray-200 text-xs">
                {recipe.cookTime || '—'}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-gray-500 flex items-center gap-1">
                <Users className="w-3 h-3 text-gray-400" /> Serves
              </span>
              <span className="font-medium text-gray-200 text-xs">
                {recipe.servings ? recipe.servings : '—'}
              </span>
            </div>
          </div>

        </div>
      </div>

      {/* Footer */}
      <div className="px-4 sm:px-5 py-3 bg-[#0F0F0F] border-t border-white/5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            id={`mealplan-btn-${recipe.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onAddToMealPlan(recipe);
            }}
            className="p-2 rounded-lg text-gray-400 hover:text-amber-300 hover:bg-white/5 transition-colors focus-visible:ring-2 focus-visible:ring-amber-400"
            title="Add to Weekly Meal Plan"
            aria-label="Add to meal plan"
          >
            <CalendarPlus className="w-4 h-4" />
          </button>
          <button
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
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-amber-400"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          <span>Cook Mode</span>
        </button>
      </div>
    </article>
  );
}
