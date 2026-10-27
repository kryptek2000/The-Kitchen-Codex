import React, { useCallback, useState } from 'react';
import {
  BookOpen,
  CalendarPlus,
  Clock,
  Flame,
  Heart,
  ImageOff,
  Play,
  Users,
} from 'lucide-react';
import type { ObsidianRecipe } from '../types';
import { getRecipeImage, LOCAL_RECIPE_IMAGE_PLACEHOLDER } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';
import { storedRecipeDescription, visibleRecipeTags } from '../utils/recipePresentation';

interface FeaturedRecipeProps {
  recipe: ObsidianRecipe;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
  onStartCooking: (recipe: ObsidianRecipe) => void;
  onToggleFavorite: (recipeId: string) => void;
  onAddToMealPlan: (recipe: ObsidianRecipe) => void;
  /** 1-based position in the current collection, for the editorial folio line. */
  index?: number;
  total?: number;
}

/**
 * Signature Edition featured recipe spread.
 *
 * At wide widths this is a two-page opening spread: the saved photograph on the
 * left, the recipe's real local metadata and actions on the right. It is not a
 * RecipeCard with a larger photograph. It uses only values already stored on
 * the recipe; missing descriptions and photographs get an honest, balanced
 * treatment rather than invented editorial copy.
 */
export function FeaturedRecipe({
  recipe,
  onSelectRecipe,
  onStartCooking,
  onToggleFavorite,
  onAddToMealPlan,
  index,
  total,
}: FeaturedRecipeProps) {
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

  const description = storedRecipeDescription(recipe);
  const { tags, remaining } = visibleRecipeTags(recipe.tags, 5);
  const cuisineLine = [recipe.cuisine, recipe.category]
    .filter((value) => value && value !== 'General')
    .join('  ·  ');

  const folio =
    typeof index === 'number' && typeof total === 'number'
      ? `No. ${String(index).padStart(2, '0')} / ${String(total).padStart(2, '0')}`
      : '';

  const handleToggleFavorite = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onToggleFavorite(recipe.id);
      setAnnouncement(isFavorite ? 'Removed from favorites' : 'Added to favorites');
    },
    [isFavorite, onToggleFavorite, recipe.id]
  );

  return (
    <section
      id="featured-recipe"
      aria-labelledby={`featured-title-${recipe.id}`}
      className="kc-featured"
    >
      <div className="kc-featured__kicker">
        <span>Featured recipe</span>
        {folio ? <span aria-label={`Featured recipe ${index} of ${total}`}>{folio}</span> : null}
      </div>

      <div className="kc-featured__grid">
        <div className="kc-featured__photo">
          {showPhoto ? (
            <img
              src={imageUrl as string}
              alt={recipe.title}
              referrerPolicy="no-referrer"
              loading="eager"
              fetchPriority="high"
              onError={() => setImageError(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
              <ImageOff
                className="h-7 w-7 text-[var(--text-secondary,#9CA3AF)]"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <p className="font-serif text-xl italic text-[var(--text-secondary,#9CA3AF)]">
                No photograph saved.
              </p>
              <p className="max-w-[24ch] text-xs leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                This note has no saved image. Its recipe is still complete below.
              </p>
            </div>
          )}

          <button
            id={`favorite-btn-${recipe.id}`}
            onClick={handleToggleFavorite}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            className="kc-favorite-control kc-photo-control absolute right-4 top-4 flex h-12 w-12 items-center justify-center rounded-full"
          >
            <Heart className={`h-5 w-5 ${isFavorite ? 'fill-current' : ''}`} />
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>
        </div>

        <div className="kc-featured__panel">
          <div>
            {cuisineLine ? <p className="kc-eyebrow">{cuisineLine}</p> : null}

            <h2
              id={`featured-title-${recipe.id}`}
              className="kc-featured__title mt-3 font-serif font-medium text-[var(--text-primary,#F3F4F6)]"
            >
              <button
                type="button"
                onClick={() => onSelectRecipe(recipe)}
                className="min-h-[44px] text-left transition-colors duration-[140ms] hover:text-[var(--accent-text,#F59E0B)]"
              >
                {recipe.title}
              </button>
            </h2>

            {description ? (
              <p
                data-testid="featured-description"
                className="mt-5 max-w-[46ch] whitespace-pre-line text-[15px] leading-[1.75] text-[var(--text-secondary,#9CA3AF)]"
              >
                {description}
              </p>
            ) : null}

            {tags.length > 0 ? (
              <ul
                data-testid="featured-tags"
                className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-secondary,#9CA3AF)]"
                aria-label="Recipe tags"
              >
                {tags.map((tag) => (
                  <li key={tag}>#{tag}</li>
                ))}
                {remaining > 0 ? <li>+{remaining} more</li> : null}
              </ul>
            ) : null}
          </div>

          <div>
            <dl className="grid grid-cols-3 gap-4 border-y border-[var(--border-subtle,rgba(255,255,255,0.08))] py-5">
              <div>
                <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary,#9CA3AF)]">
                  <Clock className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Prep
                </dt>
                <dd className="mt-1.5 font-serif text-[19px] leading-tight text-[var(--text-primary,#F3F4F6)]">
                  {recipe.prepTime || '—'}
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary,#9CA3AF)]">
                  <Flame className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Cook
                </dt>
                <dd className="mt-1.5 font-serif text-[19px] leading-tight text-[var(--text-primary,#F3F4F6)]">
                  {recipe.cookTime || '—'}
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary,#9CA3AF)]">
                  <Users className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Serves
                </dt>
                <dd className="mt-1.5 font-serif text-[19px] leading-tight text-[var(--text-primary,#F3F4F6)]">
                  {recipe.servings ? recipe.servings : '—'}
                </dd>
              </div>
            </dl>

            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onStartCooking(recipe);
                }}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-sm bg-[var(--accent,#F59E0B)] px-5 text-sm font-semibold text-[var(--accent-contrast,#0C0C0C)] transition-colors duration-[140ms] hover:bg-[var(--accent-hover,#D97706)]"
              >
                <Play className="h-4 w-4 fill-current" aria-hidden="true" /> Cook Mode
              </button>
              <button
                type="button"
                onClick={() => onSelectRecipe(recipe)}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-4 text-sm font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]"
              >
                <BookOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Details
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddToMealPlan(recipe);
                }}
                title="Add to Weekly Meal Plan"
                className="inline-flex min-h-[44px] items-center justify-center gap-2 px-1 text-sm font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:text-[var(--accent-text,#F59E0B)]"
              >
                <CalendarPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                Add to meal plan
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
