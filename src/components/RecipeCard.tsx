import React, { useState, useCallback } from 'react';
import {
  Clock,
  Users,
  Flame,
  Star,
  Heart,
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
      className={`group bg-[#141414] rounded-xl border border-white/5 hover:border-amber-500/40 hover:bg-[#181818] transition-colors duration-[140ms] flex flex-col overflow-hidden cursor-pointer motion-reduce:transition-none ${
        featured ? 'kc-vault-card--featured' : ''
      }`}
    >
      <div className="flex-1 flex flex-col">
        {/* Photo — clean, unobscured */}
        <div
          className={`relative w-full overflow-hidden bg-[#0C0C0C] ${
            featured ? 'kc-vault-photo--featured' : 'kc-vault-photo'
          }`}
        >
          {showPhoto ? (
            <img
              src={imageUrl as string}
              alt={recipe.title}
              referrerPolicy="no-referrer"
              onError={() => setImageError(true)}
              className="w-full h-full object-cover group-hover:scale-[1.018] transition-transform duration-[220ms] motion-reduce:transition-none motion-reduce:transform-none"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-[var(--bg-elevated,#1E1E1E)] text-gray-400">
              <span className="text-sm font-medium">No photo added.</span>
            </div>
          )}

          {/* Favorite control overlaid on photo corner (44px target).
              Colour comes from the active theme's semantic roles — idle heart
              uses the secondary text colour, the selected heart uses
              accent-text and fills the glyph. */}
          <button
            id={`favorite-btn-${recipe.id}`}
            onClick={handleToggleFavorite}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            className="kc-favorite-control absolute top-2 right-2 w-11 h-11 flex items-center justify-center rounded-full bg-black/60 backdrop-blur-sm hover:bg-black/80 border border-white/15 transition-colors duration-[140ms] motion-reduce:transition-none"
          >
            <Heart className={`w-5 h-5 ${isFavorite ? 'fill-current' : ''}`} />
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>
        </div>

        {/* Caption — open editorial surface, no widget panel. The caption
            stretches so metadata aligns across a shelf row. */}
        <div className="p-4 sm:p-5 space-y-2 flex-1 flex flex-col">
          <p className="text-sm text-gray-400">
            {recipe.cuisine} • {recipe.category}
          </p>

          <h3
            className={`font-serif font-semibold leading-tight break-words ${
              featured ? 'kc-vault-title--featured' : 'kc-vault-title'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelectRecipe(recipe)}
              className="text-left text-white group-hover:text-amber-300 transition-colors duration-[140ms] rounded min-h-[44px]"
            >
              {recipe.title}
            </button>
          </h3>

          {recipe.tags && recipe.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {recipe.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="text-sm font-mono px-2 py-0.5 rounded bg-white/5 text-amber-300 border border-white/10"
                >
                  #{tag}
                </span>
              ))}
              {recipe.tags.length > 3 && (
                <span className="text-sm text-gray-400">+{recipe.tags.length - 3}</span>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3 py-2 text-sm text-gray-400 mt-auto">
            <div className="flex flex-col">
              <span className="flex items-center gap-1 text-sm uppercase tracking-wide">
                <Clock className="w-3.5 h-3.5" /> Prep
              </span>
              <span className="font-medium text-gray-200 text-sm mt-0.5">
                {recipe.prepTime || '—'}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="flex items-center gap-1 text-sm uppercase tracking-wide">
                <Flame className="w-3.5 h-3.5 text-amber-400" /> Cook
              </span>
              <span className="font-medium text-gray-200 text-sm mt-0.5">
                {recipe.cookTime || '—'}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="flex items-center gap-1 text-sm uppercase tracking-wide">
                <Users className="w-3.5 h-3.5" /> Serves
              </span>
              <span className="font-medium text-gray-200 text-sm mt-0.5">
                {recipe.servings ? recipe.servings : '—'}
              </span>
            </div>
          </div>

        </div>
      </div>

      {/* Footer */}
      <div className="px-4 sm:px-5 py-2.5 border-t border-white/5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            id={`mealplan-btn-${recipe.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onAddToMealPlan(recipe);
            }}
            className="w-11 h-11 flex items-center justify-center rounded-lg text-gray-400 hover:text-amber-300 hover:bg-white/5 transition-colors duration-[140ms]"
            title="Add to Weekly Meal Plan"
            aria-label="Add to meal plan"
          >
            <CalendarPlus className="w-5 h-5" />
          </button>
          <button
            onClick={() => onSelectRecipe(recipe)}
            className="min-h-[44px] text-sm font-medium text-gray-400 hover:text-gray-100 px-3 rounded hover:bg-white/5 transition-colors duration-[140ms]"
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
          className="flex items-center gap-1.5 min-h-[44px] px-4 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-black text-sm font-semibold transition-colors duration-[140ms]"
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Cook Mode</span>
        </button>
      </div>
    </article>
  );
}
