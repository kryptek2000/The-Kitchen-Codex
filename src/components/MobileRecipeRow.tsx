import React, { useState, useCallback } from 'react';
import { Clock, Users, Flame, Heart, Play, CalendarPlus } from 'lucide-react';
import { ObsidianRecipe } from '../types';
import { getRecipeImage, LOCAL_RECIPE_IMAGE_PLACEHOLDER } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';

interface MobileRecipeRowProps {
  recipe: ObsidianRecipe;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
  onStartCooking: (recipe: ObsidianRecipe) => void;
  onToggleFavorite: (recipeId: string) => void;
  onAddToMealPlan: (recipe: ObsidianRecipe) => void;
}

/**
 * RV-2 mobile photo-and-text row: a compact 112px (104px narrow) photo beside
 * the full title, category, prep/cook and servings. Used beneath the featured
 * recipe on small screens.
 */
export function MobileRecipeRow({
  recipe,
  onSelectRecipe,
  onStartCooking,
  onToggleFavorite,
  onAddToMealPlan,
}: MobileRecipeRowProps) {
  const isFavorite = !!recipe.isFavorite;
  const [imageError, setImageError] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const defaultImg = getRecipeImage(recipe);
  const reactiveVaultImage = useVaultImage(recipe.image, defaultImg);
  const imageUrl = imageError ? null : (reactiveVaultImage || defaultImg);

  const hasExplicitImage =
    Boolean(recipe.image) ||
    /!\[\[?[^\]]*\.(?:jpg|jpeg|png|webp|avif|gif|svg)\]\]?/i.test(recipe.rawMarkdown || '');

  const showPhoto = hasExplicitImage && !!imageUrl && imageUrl !== LOCAL_RECIPE_IMAGE_PLACEHOLDER && !imageError;

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFavorite(recipe.id);
      setAnnouncement(isFavorite ? 'Removed from favorites' : 'Added to favorites');
    },
    [isFavorite, onToggleFavorite, recipe.id]
  );

  return (
    <article
      id={`recipe-row-${recipe.id}`}
      onClick={() => onSelectRecipe(recipe)}
      className="group flex gap-4 cursor-pointer"
    >
      <div className="kc-vault-row-photo shrink-0 rounded-xl overflow-hidden bg-[#1b1b1b] relative">
        {showPhoto ? (
          <img
            src={imageUrl as string}
            alt={recipe.title}
            referrerPolicy="no-referrer"
            onError={() => setImageError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm text-gray-400 px-2 text-center bg-[var(--bg-elevated,#1E1E1E)]">
            No photo added.
          </div>
        )}
        <button
          onClick={handleToggleFavorite}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          className="kc-favorite-control absolute top-1.5 right-1.5 w-11 h-11 flex items-center justify-center rounded-full bg-black/60 border border-white/15 transition-colors duration-[140ms] motion-reduce:transition-none"
        >
          <Heart className={`w-5 h-5 ${isFavorite ? 'fill-current' : ''}`} />
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="text-sm text-gray-400">
          {recipe.cuisine} • {recipe.category}
        </p>
        <h3 className="kc-vault-row-title font-serif font-semibold leading-tight break-words">
          <button
            type="button"
            onClick={() => onSelectRecipe(recipe)}
            className="text-left text-white rounded"
          >
            {recipe.title}
          </button>
        </h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-300 pt-0.5">
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-gray-400" /> {recipe.prepTime || '—'}
          </span>
          <span className="flex items-center gap-1">
            <Flame className="w-3.5 h-3.5 text-amber-400" /> {recipe.cookTime || '—'}
          </span>
          <span className="flex items-center gap-1">
            <Users className="w-3.5 h-3.5 text-gray-400" /> {recipe.servings ? recipe.servings : '—'} serves
          </span>
        </div>
        <div className="pt-1.5 flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAddToMealPlan(recipe);
            }}
            aria-label="Add to weekly meal plan"
            className="w-11 h-11 flex items-center justify-center rounded-lg text-gray-400 hover:text-amber-300 hover:bg-white/5 transition-colors duration-[140ms]"
            title="Add to Weekly Meal Plan"
          >
            <CalendarPlus className="w-5 h-5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStartCooking(recipe);
            }}
            className="min-h-[44px] text-sm px-4 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-semibold transition-colors duration-[140ms]"
          >
            <Play className="w-4 h-4 fill-current inline mr-1.5" />
            Cook
          </button>
        </div>
      </div>
    </article>
  );
}
