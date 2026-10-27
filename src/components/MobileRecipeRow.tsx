import React, { useState, useCallback } from 'react';
import { CalendarPlus, Clock, Flame, Heart, ImageOff, Play, Users } from 'lucide-react';
import { ObsidianRecipe } from '../types';
import { getRecipeImage, LOCAL_RECIPE_IMAGE_PLACEHOLDER } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';
import { visibleRecipeTags } from '../utils/recipePresentation';

interface MobileRecipeRowProps {
  recipe: ObsidianRecipe;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
  onStartCooking: (recipe: ObsidianRecipe) => void;
  onToggleFavorite: (recipeId: string) => void;
  onAddToMealPlan: (recipe: ObsidianRecipe) => void;
}

/**
 * Compact Signature Edition shelf row for phones. The photograph keeps a
 * portrait crop, the Fraunces title wraps rather than truncating, and the
 * actions remain quiet text/icon controls with 44px targets.
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
  const imageUrl = imageError ? null : reactiveVaultImage || defaultImg;

  const hasExplicitImage =
    Boolean(recipe.image) ||
    /!\[\[?[^\]]*\.(?:jpg|jpeg|png|webp|avif|gif|svg)\]\]?/i.test(recipe.rawMarkdown || '') ||
    /!\[[^\]]*\]\([^\)]*\.(?:jpg|jpeg|png|webp|avif|gif|svg)\)/i.test(recipe.rawMarkdown || '');

  const showPhoto =
    hasExplicitImage &&
    !!imageUrl &&
    imageUrl !== LOCAL_RECIPE_IMAGE_PLACEHOLDER &&
    !imageError;
  const { tags, remaining } = visibleRecipeTags(recipe.tags, 2);

  const handleToggleFavorite = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onToggleFavorite(recipe.id);
      setAnnouncement(isFavorite ? 'Removed from favorites' : 'Added to favorites');
    },
    [isFavorite, onToggleFavorite, recipe.id]
  );

  return (
    <article
      id={`recipe-row-${recipe.id}`}
      onClick={() => onSelectRecipe(recipe)}
      className="group flex cursor-pointer gap-4"
    >
      <div className="kc-vault-row-photo relative shrink-0 overflow-hidden rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)]">
        {showPhoto ? (
          <img
            src={imageUrl as string}
            alt={recipe.title}
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => setImageError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-center">
            <ImageOff
              className="h-4 w-4 text-[var(--text-secondary,#9CA3AF)]"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="text-[11px] leading-tight text-[var(--text-secondary,#9CA3AF)]">
              No photo added.
            </span>
          </div>
        )}
        <button
          onClick={handleToggleFavorite}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          className="kc-favorite-control kc-photo-control absolute right-1.5 top-1.5 flex h-11 w-11 items-center justify-center rounded-full"
        >
          <Heart className={`h-5 w-5 ${isFavorite ? 'fill-current' : ''}`} />
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <p className="kc-eyebrow leading-[1.5] break-words">
          {recipe.cuisine} · {recipe.category}
        </p>
        <h3 className="kc-vault-row-title mt-1.5 font-serif font-medium text-[var(--text-primary,#F3F4F6)]">
          <button
            type="button"
            onClick={() => onSelectRecipe(recipe)}
            className="min-h-[44px] break-words text-left transition-colors duration-[140ms] group-hover:text-[var(--accent-text,#F59E0B)]"
          >
            {recipe.title}
          </button>
        </h3>
        {tags.length > 0 && (
          <ul
            className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary,#9CA3AF)]"
            aria-label="Recipe tags"
          >
            {tags.map((tag) => (
              <li key={tag}>#{tag}</li>
            ))}
            {remaining > 0 ? <li>+{remaining}</li> : null}
          </ul>
        )}
        <dl className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-[12px] text-[var(--text-secondary,#9CA3AF)]">
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Prep time</dt>
            <Clock className="h-4 w-4 text-[var(--text-secondary,#9CA3AF)]" strokeWidth={1.75} aria-hidden="true" />
            <dd>{recipe.prepTime || '—'}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Cook time</dt>
            <Flame className="h-4 w-4 text-[var(--text-secondary,#9CA3AF)]" strokeWidth={1.75} aria-hidden="true" />
            <dd>{recipe.cookTime || '—'}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Servings</dt>
            <Users className="h-4 w-4 text-[var(--text-secondary,#9CA3AF)]" strokeWidth={1.75} aria-hidden="true" />
            <dd>{recipe.servings ? recipe.servings : '—'}</dd>
          </div>
        </dl>

        <div className="mt-2 flex items-center gap-1 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-1">
          <button
            onClick={(event) => {
              event.stopPropagation();
              onAddToMealPlan(recipe);
            }}
            aria-label="Add to weekly meal plan"
            className="flex h-11 w-11 items-center justify-center rounded-sm text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:text-[var(--accent-text,#F59E0B)]"
            title="Add to Weekly Meal Plan"
          >
            <CalendarPlus className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelectRecipe(recipe);
            }}
            className="min-h-[44px] rounded-sm px-2 text-sm font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:text-[var(--text-primary,#F3F4F6)]"
          >
            Details
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onStartCooking(recipe);
            }}
            className="ml-auto inline-flex min-h-[44px] items-center gap-1.5 px-1 text-sm font-semibold text-[var(--accent-text,#F59E0B)] transition-colors duration-[140ms] hover:text-[var(--text-primary,#F3F4F6)]"
            title="Open Cooking Mode"
          >
            <Play className="h-4 w-4 fill-current" aria-hidden="true" />
            Cook
          </button>
        </div>
      </div>
    </article>
  );
}
