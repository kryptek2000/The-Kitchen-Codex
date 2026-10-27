import React, { useCallback, useState } from 'react';
import {
  CalendarPlus,
  Clock,
  Flame,
  Heart,
  ImageOff,
  Play,
  Users,
} from 'lucide-react';
import { ObsidianRecipe } from '../types';
import { getRecipeImage, LOCAL_RECIPE_IMAGE_PLACEHOLDER } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';
import { visibleRecipeTags } from '../utils/recipePresentation';

interface RecipeCardProps {
  recipe: ObsidianRecipe;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
  onStartCooking: (recipe: ObsidianRecipe) => void;
  onToggleFavorite: (recipeId: string) => void;
  onAddToMealPlan: (recipe: ObsidianRecipe) => void;
}

/**
 * Signature Edition shelf card.
 *
 * Photography and the recipe name lead. Metadata is quiet and consistent, tags
 * lose their solid pill treatment, and the actions are a restrained text row
 * rather than competing filled buttons. Every interaction and accessible name
 * from the previous card is preserved, and every target is at least 44px.
 */
export function RecipeCard({
  recipe,
  onSelectRecipe,
  onStartCooking,
  onToggleFavorite,
  onAddToMealPlan,
}: RecipeCardProps) {
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
  const { tags, remaining } = visibleRecipeTags(recipe.tags, 3);

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
      id={`recipe-card-${recipe.id}`}
      onClick={() => onSelectRecipe(recipe)}
      className="group flex cursor-pointer flex-col"
    >
      <div className="kc-vault-photo relative overflow-hidden rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)]">
        {showPhoto ? (
          <img
            src={imageUrl as string}
            alt={recipe.title}
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => setImageError(true)}
            className="h-full w-full object-cover transition-transform duration-[400ms] ease-out group-hover:scale-[1.025] motion-reduce:transform-none motion-reduce:transition-none"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
            <ImageOff
              className="h-5 w-5 text-[var(--text-secondary,#9CA3AF)]"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="text-sm text-[var(--text-secondary,#9CA3AF)]">No photo added.</span>
          </div>
        )}

        <button
          id={`favorite-btn-${recipe.id}`}
          onClick={handleToggleFavorite}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          className="kc-favorite-control kc-photo-control absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full"
        >
          <Heart className={`h-5 w-5 ${isFavorite ? 'fill-current' : ''}`} />
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>

      <div className="flex flex-1 flex-col pt-4">
        <p className="kc-eyebrow leading-[1.5] break-words">
          {recipe.cuisine} · {recipe.category}
        </p>

        <h3 className="kc-vault-title mt-2 font-serif font-medium text-[var(--text-primary,#F3F4F6)]">
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
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary,#9CA3AF)]"
            aria-label="Recipe tags"
          >
            {tags.map((tag) => (
              <li key={tag}>#{tag}</li>
            ))}
            {remaining > 0 ? <li>+{remaining}</li> : null}
          </ul>
        )}

        <div className="mt-auto pt-5">
          <dl className="grid grid-cols-3 gap-2 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-3 pb-1 text-[var(--text-secondary,#9CA3AF)]">
            <div>
              <dt className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary,#9CA3AF)]">
                <Clock className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Prep
              </dt>
              <dd className="mt-1 text-[13px] font-medium text-[var(--text-primary,#F3F4F6)]">
                {recipe.prepTime || '—'}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary,#9CA3AF)]">
                <Flame className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Cook
              </dt>
              <dd className="mt-1 text-[13px] font-medium text-[var(--text-primary,#F3F4F6)]">
                {recipe.cookTime || '—'}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary,#9CA3AF)]">
                <Users className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Serves
              </dt>
              <dd className="mt-1 text-[13px] font-medium text-[var(--text-primary,#F3F4F6)]">
                {recipe.servings ? recipe.servings : '—'}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))]">
        <div className="flex items-center">
          <button
            id={`mealplan-btn-${recipe.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onAddToMealPlan(recipe);
            }}
            className="flex h-11 w-11 items-center justify-center rounded-sm text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:text-[var(--accent-text,#F59E0B)]"
            title="Add to Weekly Meal Plan"
            aria-label="Add to meal plan"
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
        </div>
        <button
          id={`start-cooking-btn-${recipe.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onStartCooking(recipe);
          }}
          className="inline-flex min-h-[44px] items-center gap-1.5 px-1 text-sm font-semibold text-[var(--accent-text,#F59E0B)] transition-colors duration-[140ms] hover:text-[var(--text-primary,#F3F4F6)]"
        >
          <Play className="h-4 w-4 fill-current" aria-hidden="true" />
          <span>Cook Mode</span>
        </button>
      </div>
    </article>
  );
}
