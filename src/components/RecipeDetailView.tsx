import React, { useState, useMemo, useLayoutEffect, useRef } from 'react';
import {
  ArrowLeft,
  Play,
  Edit3,
  Download,
  Copy,
  Check,
  ShoppingCart,
  CalendarPlus,
  Clock,
  Flame,
  Users,
  Star,
  Tag,
  FileCode,
  FileText,
  AlertTriangle,
  Lightbulb,
  Info,
  Quote,
  Timer,
  Plus,
  Minus,
  ExternalLink,
  Sparkles,
  Utensils,
  Share2,
  Trash2,
  BrainCircuit,
  Search,
  MessageCircle,
  Heart,
  ImageOff,
} from 'lucide-react';
import { ObsidianRecipe, ParsedIngredient, VaultNote, RecipeNutrition } from '../types';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import { scaleIngredientText } from '../utils/markdownParser';
import { downloadMarkdownFile } from '../utils/vaultFileSystem';
import { getRecipeImage, DEFAULT_FOOD_IMAGES, LOCAL_RECIPE_IMAGE_PLACEHOLDER } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';
import { assessRecipeHealth } from '../utils/vaultIntelligence';
import { buildRecipeRelationshipIndex, recipeIdentity } from '../utils/recipeRelationships';
import { storedRecipeDescription, visibleRecipeTags } from '../utils/recipePresentation';
import {
  type AdvancedNutritionAiResolveHandler,
  type AdvancedNutritionAiEstimateHandler,
  type AdvancedNutritionRecipeContextReviewHandler,
  type AdvancedNutritionApplyHandler,
  type AdvancedNutritionBundleUiStatus,
  type AdvancedNutritionAiAvailability,
} from './AdvancedNutritionCard';
import { useShiso } from '../application-ui/shisoEntryPoints';
import { RecipeNutritionSection } from './RecipeNutritionSection';
import type { AdvancedNutritionSession } from '../core/nutritionV2/phase4';
import {
  resolveNutritionDisplayCalories,
  resolveRecipeNutritionPresentation,
} from '../core/nutritionV2/phase5c';
import { WikilinkPreviewModal } from './WikilinkPreviewModal';
import { RecipeRelationshipsPanel } from './RecipeRelationshipsPanel';
import { IngredientUsageModal } from './IngredientUsageModal';

// The recipe-card export studio pulls in html2canvas, a heavy dependency
// (hundreds of kB) that is only needed when a user actually exports a card.
// Lazy-load it so it lives in its own chunk and is fetched on demand, keeping
// the initial application bundle smaller.
const RecipeCardExportModal = React.lazy(() =>
  import('./RecipeCardExportModal').then((m) => ({ default: m.RecipeCardExportModal }))
);

interface RecipeDetailViewProps {
  recipe: ObsidianRecipe;
  allRecipes?: ObsidianRecipe[];
  allNotes?: VaultNote[];
  onBack: () => void;
  onStartCooking: (recipe: ObsidianRecipe, servings: number) => void;
  onEditRecipe: (recipe: ObsidianRecipe) => void;
  onAddToMealPlan?: (recipe: ObsidianRecipe) => void;
  onToggleFavorite?: (recipeId: string) => void;
  onRateRecipe?: (recipeId: string, rating: number) => void | Promise<void>;
  onAddToShoppingList: (recipe: ObsidianRecipe, ingredients: string[]) => void;
  onStartTimer: (recipeTitle: string, minutes: number, label: string, semanticKey?: string) => void;
  onFilterByWikilink?: (wikilink: string) => void;
  onDeleteRecipe?: (recipe: ObsidianRecipe) => void;
  onUpdateNutrition?: (recipe: ObsidianRecipe, nutrition: RecipeNutrition) => Promise<boolean | void> | void;
  onSelectRecipe?: (recipe: ObsidianRecipe) => void;
  onSaveNoteToVault?: (note: VaultNote) => Promise<boolean | void>;
  onOpenVaultIntelligence?: (recipeId?: string) => void;
  network: NetworkAdapter;
  /**
   * Optional injected genuine Advanced Nutrition review session. Production
   * composition does NOT fabricate one; when absent the separate Advanced
   * Nutrition card honestly reports that no trusted local source data exist.
   */
  advancedNutritionSession?: AdvancedNutritionSession | null;
  /** Phase 4.5B lazy local-bundle state + explicit load (browser shell only). */
  advancedNutritionBundleStatus?: AdvancedNutritionBundleUiStatus;
  onLoadAdvancedNutritionBundle?: () => void;
  /**
   * AI-5C bounded AI presentation state, passed straight through to the Advanced
   * Nutrition card. Purely presentational: this view never interprets it, never
   * calls the product-status endpoint and never resolves entitlement.
   */
  advancedNutritionAiAvailability?: AdvancedNutritionAiAvailability;
  /** Explicit Phase 5B Apply handler (browser shell only). */
  onApplyAdvancedNutrition?: AdvancedNutritionApplyHandler;
  /** Optional AI-assisted USDA resolution port (browser shell only). */
  onResolveAdvancedNutritionAi?: AdvancedNutritionAiResolveHandler;
  /** Optional AI-3 bounded mass-estimate port (injected by the shell). */
  onEstimateMassesWithAi?: AdvancedNutritionAiEstimateHandler;
  /** Optional AI-4D2 recipe-context REVIEW port (injected by the shell). */
  onReviewRecipeContextWithAi?: AdvancedNutritionRecipeContextReviewHandler;
}

export function RecipeDetailView({
  recipe,
  allRecipes = [],
  allNotes = [],
  onBack,
  onStartCooking,
  onEditRecipe,
  onAddToMealPlan,
  onToggleFavorite,
  onRateRecipe,
  onAddToShoppingList,
  onStartTimer,
  onFilterByWikilink,
  onDeleteRecipe,
  onUpdateNutrition,
  onSelectRecipe,
  onSaveNoteToVault,
  onOpenVaultIntelligence,
  network,
  advancedNutritionSession = null,
  advancedNutritionBundleStatus,
  onLoadAdvancedNutritionBundle,
  advancedNutritionAiAvailability,
  onApplyAdvancedNutrition,
  onResolveAdvancedNutritionAi,
  onEstimateMassesWithAi,
  onReviewRecipeContextWithAi,
}: RecipeDetailViewProps) {
  React.useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    setCurrentServings(recipe.servings || 4);
    setCheckedIngredients({});
  }, [recipe.id]);

  // SHISO recipe entry point (see the button below).
  const shiso = useShiso();
  const [currentServings, setCurrentServings] = useState<number>(recipe.servings || 4);
  const [activeViewMode, setActiveViewMode] = useState<'visual' | 'markdown'>('visual');
  const [checkedIngredients, setCheckedIngredients] = useState<Record<number, boolean>>({});
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [isAddedToShop, setIsAddedToShop] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedWikilink, setSelectedWikilink] = useState<{ target: string; alias?: string } | null>(null);
  const [showCardStudio, setShowCardStudio] = useState(false);
  const [ingredientUsage, setIngredientUsage] = useState<{ query: string; display: string } | null>(null);
  const [favoriteAnnouncement, setFavoriteAnnouncement] = useState('');
  const [ratingPending, setRatingPending] = useState(false);
  const defaultImg = getRecipeImage(recipe);
  const reactiveVaultImage = useVaultImage(recipe.image, defaultImg);

  const hasExplicitImage =
    Boolean(recipe.image) ||
    /!\[\[?[^\]]*\.(?:jpg|jpeg|png|webp|avif|gif|svg)\]\]?/i.test(recipe.rawMarkdown || '') ||
    /!\[[^\]]*\]\([^\)]*\.(?:jpg|jpeg|png|webp|avif|gif|svg)\)/i.test(recipe.rawMarkdown || '');

  const imageUrl = reactiveVaultImage || defaultImg;
  const showPhoto =
    hasExplicitImage &&
    !!imageUrl &&
    imageUrl !== LOCAL_RECIPE_IMAGE_PLACEHOLDER;

  const heroImgRef = useRef<HTMLImageElement | null>(null);
  useLayoutEffect(() => {
    const el = heroImgRef.current;
    if (!el) return;
    if (imageUrl && /^(https?:|data:|blob:)/i.test(imageUrl)) {
      el.setAttribute('src', imageUrl);
    } else {
      el.removeAttribute('src');
    }
  }, [imageUrl]);

  const description = storedRecipeDescription(recipe);
  const { tags: visibleTags, remaining: remainingTags } = visibleRecipeTags(recipe.tags, 6);

  const baseServings = recipe.servings || 4;
  const recipeHealth = assessRecipeHealth(recipe);

  // Phase 5C: ONE pure precedence decision drives both the consolidated
  // Nutrition surface and the recipe-info Calories summary. A recognized saved
  // Advanced result is the preferred authority; legacy/simple nutrition is the
  // fallback only when no recognized Advanced block exists. Nothing is merged,
  // migrated, or written.
  const nutritionPresentation = useMemo(
    () => resolveRecipeNutritionPresentation(recipe),
    [recipe]
  );

  // The top recipe-info Calories summary tracks the CURRENT recipe serving count
  // using the SAME deterministic serving-scaled contract as the Nutrition
  // surface: canonical saved entire-recipe totals × (current / saved base).
  // `resolveNutritionDisplayCalories` is the SINGLE precedence authority.
  const displayedHeaderCalories: number | string | undefined =
    resolveNutritionDisplayCalories(nutritionPresentation, currentServings);

  // Derived relationship data (Step 6). Built from the currently loaded recipe
  // collection, memoized so it is not rebuilt on every render; it recomputes only
  // when `allRecipes` changes. Purely derived — never persisted, never written to
  // Markdown. `recipeByIdentity` maps the Step 6 stable identity to the live recipe.
  const relationshipIndex = useMemo(() => buildRecipeRelationshipIndex(allRecipes), [allRecipes]);
  const recipeByIdentity = useMemo(() => {
    const map = new Map<string, ObsidianRecipe>();
    for (const r of allRecipes) {
      const identity = recipeIdentity(r);
      if (identity) map.set(identity, r);
    }
    return map;
  }, [allRecipes]);
  const currentIdentity = recipeIdentity(recipe);

  const handleOpenIngredientUsage = (ingredient: ParsedIngredient) => {
    const query = (ingredient.original || ingredient.name || '').trim();
    if (!query) return;
    const display = (ingredient.name || ingredient.original || '').replace(
      /\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g,
      '$1'
    ).trim();
    setIngredientUsage({ query, display: display || query });
  };

  const toggleIngredientCheck = (idx: number) => {
    setCheckedIngredients((prev) => ({
      ...prev,
      [idx]: !prev[idx],
    }));
  };

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(recipe.rawMarkdown);
    setCopiedMarkdown(true);
    setTimeout(() => setCopiedMarkdown(false), 2000);
  };

  const handleAddAllToShopping = () => {
    const list = recipe.ingredients.map((ing) =>
      scaleIngredientText(ing.original, baseServings, currentServings)
    );
    onAddToShoppingList(recipe, list);
    setIsAddedToShop(true);
    setTimeout(() => setIsAddedToShop(false), 2500);
  };

  const handleToggleFavorite = (event?: React.MouseEvent) => {
    if (event) event.stopPropagation();
    if (!onToggleFavorite) return;
    onToggleFavorite(recipe.id);
    setFavoriteAnnouncement(recipe.isFavorite ? 'Removed from favorites' : 'Added to favorites');
  };

  const getCalloutIcon = (type: string) => {
    switch (type) {
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
      case 'tip':
        return <Lightbulb className="w-4 h-4 text-amber-400 shrink-0" />;
      case 'important':
        return <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />;
      case 'quote':
        return <Quote className="w-4 h-4 text-gray-400 shrink-0" />;
      default:
        return <Info className="w-4 h-4 text-blue-400 shrink-0" />;
    }
  };

  const getCalloutStyles = (type: string) => {
    switch (type) {
      case 'warning':
        return 'bg-amber-950/40 border-amber-800/40 text-amber-200';
      case 'tip':
        return 'bg-amber-500/10 border-amber-500/30 text-amber-200';
      case 'important':
        return 'bg-rose-950/40 border-rose-800/40 text-rose-200';
      case 'quote':
        return 'bg-[#141414] border-white/10 text-gray-300 italic';
      default:
        return 'bg-blue-950/40 border-blue-800/40 text-blue-200';
    }
  };

  const isFavorite = !!recipe.isFavorite;


  const renderInlineMarkdown = (text: string) => {
    return text.split(/(\[\[[^\]]+\]\]|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).map((part, index) => {
      if (part.startsWith('[[') && part.endsWith(']]') && part.length > 4) {
        const inner = part.slice(2, -2);
        const [rawTarget, rawAlias] = inner.split('|', 2);
        const target = rawTarget?.trim();
        const alias = rawAlias?.trim();
        if (!target) return part;
        return (
          <button
            type="button"
            key={index}
            onClick={() => setSelectedWikilink({ target, alias })}
            className="inline rounded-sm font-medium text-[var(--accent-text,#F59E0B)] underline decoration-[var(--accent-subtle,rgba(245,158,11,0.45))] underline-offset-2 transition-colors hover:text-[var(--accent-hover,#D97706)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-text,#F59E0B)]"
          >
            {alias || target}
          </button>
        );
      }
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return (
          <strong key={index} className="font-bold text-[var(--text-primary,#F3F4F6)]">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
        return <em key={index} className="italic">{part.slice(1, -1)}</em>;
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return (
          <code key={index} className="rounded bg-[var(--bg-elevated,#1E1E1E)] px-1 py-0.5 font-mono text-[0.95em]">
            {part.slice(1, -1)}
          </code>
        );
      }
      return part;
    });
  };

  /**
   * Safe, focused Notes Markdown renderer.
   *
   * Supports paragraphs, unordered/ordered lists, bold/italic/inline code,
   * explicit line breaks, and Obsidian wikilinks. It renders React text nodes
   * only (no dangerouslySetInnerHTML), so HTML in a note cannot execute.
   */
  type NoteBlock =
    | { type: 'paragraph'; lines: string[] }
    | { type: 'ul'; items: string[] }
    | { type: 'ol'; items: string[] };

  const parseNoteBlocks = (notes: string): NoteBlock[] => {
    const blocks: NoteBlock[] = [];
    let paragraph: string[] = [];
    let listType: 'ul' | 'ol' | null = null;
    let listItems: string[] = [];

    const flushParagraph = () => {
      if (paragraph.length > 0) {
        blocks.push({ type: 'paragraph', lines: paragraph });
        paragraph = [];
      }
    };
    const flushList = () => {
      if (listType && listItems.length > 0) {
        blocks.push({ type: listType, items: listItems });
      }
      listType = null;
      listItems = [];
    };

    for (const rawLine of notes.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (!trimmed) {
        flushParagraph();
        flushList();
        continue;
      }
      const unordered = trimmed.match(/^[-*+]\s+(.*)$/);
      if (unordered) {
        flushParagraph();
        if (listType !== 'ul') {
          flushList();
          listType = 'ul';
        }
        listItems.push(unordered[1]);
        continue;
      }
      const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (ordered) {
        flushParagraph();
        if (listType !== 'ol') {
          flushList();
          listType = 'ol';
        }
        listItems.push(ordered[1]);
        continue;
      }
      if (listType) {
        // Continuation of the current list item (soft-wrapped Markdown).
        listItems[listItems.length - 1] = `${listItems[listItems.length - 1]} ${trimmed}`;
        continue;
      }
      paragraph.push(trimmed);
    }
    flushParagraph();
    flushList();
    return blocks;
  };

  const renderNotes = (notes: string) => {
    const blocks = parseNoteBlocks(notes);
    return blocks.map((block, index) => {
      if (block.type === 'paragraph') {
        return (
          <p key={index} className="leading-relaxed">
            {block.lines.map((line, lineIndex) => (
              <React.Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInlineMarkdown(line)}
              </React.Fragment>
            ))}
          </p>
        );
      }
      const ListTag = block.type === 'ul' ? 'ul' : 'ol';
      return (
        <ListTag
          key={index}
          className={
            block.type === 'ul'
              ? 'list-disc space-y-1 pl-5 marker:text-[var(--accent-text,#F59E0B)]'
              : 'list-decimal space-y-1 pl-5 marker:text-[var(--accent-text,#F59E0B)]'
          }
        >
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex} className="pl-1">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ListTag>
      );
    });
  };

  return (
    <div id="recipe-detail-view" className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-6 pb-24 text-[var(--text-primary,#F3F4F6)]">
      {/* Navigation Top Bar */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-4">
        <button
          id="back-to-vault-btn"
          onClick={onBack}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)]"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Vault</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {/* Visual vs Markdown Tab */}
          <div className="flex items-center rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-1 text-xs">
            <button
              id="view-visual-mode-btn"
              onClick={() => setActiveViewMode('visual')}
              className={`inline-flex min-h-[36px] items-center gap-1 rounded-sm px-2.5 py-1 transition-all duration-[140ms] ${
                activeViewMode === 'visual'
                  ? 'bg-[var(--bg-surface,#141414)] text-[var(--accent-text,#F59E0B)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] font-semibold'
                  : 'text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Kitchen View</span>
            </button>
            <button
              id="view-markdown-mode-btn"
              onClick={() => setActiveViewMode('markdown')}
              className={`inline-flex min-h-[36px] items-center gap-1 rounded-sm px-2.5 py-1 transition-all duration-[140ms] ${
                activeViewMode === 'markdown'
                  ? 'bg-[var(--bg-surface,#141414)] text-[var(--accent-text,#F59E0B)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] font-semibold'
                  : 'text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]'
              }`}
            >
              <FileCode className="w-3.5 h-3.5 text-[var(--accent-text,#F59E0B)]" />
              <span>Raw Markdown</span>
            </button>
          </div>

          {/* Vault Intelligence Quick Button */}
          {onOpenVaultIntelligence && (
            <button
              id="recipe-detail-vault-intelligence-btn"
              onClick={() => onOpenVaultIntelligence(recipe.id)}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-sm border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-purple-500/20"
              title="Inspect metadata health & recover missing fields"
            >
              <BrainCircuit className="w-3.5 h-3.5 text-purple-400" />
              <span className="hidden sm:inline">Vault Intelligence</span>
            </button>
          )}

          {/* Edit in Markdown */}
          <button
            id="edit-recipe-btn"
            onClick={() => onEditRecipe(recipe)}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)]"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Edit</span>
          </button>

          {/* Delete Note */}
          {onDeleteRecipe && (
            <button
              id="delete-recipe-btn"
              onClick={() => {
                if (window.confirm(`Are you sure you want to delete "${recipe.title}" (${recipe.fileName}) from the vault?`)) {
                  onDeleteRecipe(recipe);
                }
              }}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-sm border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-rose-500/20"
              title="Delete recipe note from vault"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Delete</span>
            </button>
          )}

          {/* Export .md file */}
          <button
            id="export-md-file-btn"
            onClick={() => downloadMarkdownFile(recipe.fileName, recipe.rawMarkdown)}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)]"
            title="Download .md note"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export</span>
          </button>

          {/* Meal Plan */}
          {onAddToMealPlan && (
            <button
              id="add-to-meal-plan-btn"
              onClick={() => onAddToMealPlan(recipe)}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]"
              title="Add to Weekly Meal Plan"
            >
              <CalendarPlus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Meal Plan</span>
            </button>
          )}

          {/* SHISO recipe entry point */}
          <button
            id="recipe-shiso-btn"
            data-testid="recipe-shiso-entry"
            onClick={() => shiso.open('recipe')}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-sm border border-teal-500/30 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-teal-500/20"
            title="Ask Shiso about this recipe"
          >
            <MessageCircle className="w-3.5 h-3.5 text-teal-400" />
            <span className="hidden sm:inline">Ask Shiso</span>
          </button>

          {/* Recipe Card Studio Button */}
          <button
            id="recipe-card-studio-btn"
            onClick={() => setShowCardStudio(true)}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-amber-500/20"
            title="Design & export gorgeous recipe cards"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">Recipe Card</span>
          </button>

          {/* Start Cooking Mode Button */}
          <button
            id="launch-cooking-mode-btn"
            onClick={() => onStartCooking(recipe, currentServings)}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-sm bg-[var(--accent,#F59E0B)] px-4 py-1.5 text-xs font-bold text-[var(--accent-contrast,#0C0C0C)] shadow-sm transition-colors duration-[140ms] hover:bg-[var(--accent-hover,#D97706)]"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Start Cooking Mode</span>
          </button>
        </div>
      </div>

      {activeViewMode === 'markdown' ? (
        /* Raw Obsidian Markdown View */
        <div className="rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-5 font-mono text-xs text-[var(--text-primary,#F3F4F6)] shadow-lg">
          <div className="mb-3 flex items-center justify-between border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-3">
            <span className="flex items-center gap-2 font-semibold text-[var(--text-secondary,#9CA3AF)]">
              <FileCode className="w-4 h-4 text-[var(--accent-text,#F59E0B)]" />
              <span>{recipe.filePath || recipe.fileName}</span>
            </span>
            <button
              onClick={handleCopyMarkdown}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2.5 py-1 text-xs text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)]"
            >
              {copiedMarkdown ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedMarkdown ? 'Copied' : 'Copy All'}</span>
            </button>
          </div>
          <pre className="whitespace-pre-wrap leading-relaxed selection:bg-amber-500/30 selection:text-amber-200">
            {recipe.rawMarkdown}
          </pre>
        </div>
      ) : (
        /* Visual Kitchen View */
        <div className="space-y-6">
          {/* Editorial Hero */}
          <section className="overflow-hidden rounded-3xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] shadow-xl">
            <div className="relative h-64 sm:h-80 md:h-96">
              {showPhoto ? (
                <>
                  <img
                    ref={heroImgRef}
                    alt={recipe.title}
                    referrerPolicy="no-referrer"
                    loading="eager"
                    fetchPriority="high"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      if (target.src !== DEFAULT_FOOD_IMAGES.default) {
                        target.src = DEFAULT_FOOD_IMAGES.default;
                      }
                    }}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/40 to-transparent pointer-events-none" />

                </>
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

              {onToggleFavorite && (
                <button
                  id={`favorite-btn-${recipe.id}`}
                  onClick={handleToggleFavorite}
                  aria-pressed={isFavorite}
                  aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                  className="kc-favorite-control kc-photo-control absolute right-4 top-4 flex h-12 w-12 items-center justify-center rounded-full"
                >
                  <Heart className={`h-5 w-5 ${isFavorite ? 'fill-current' : ''}`} />
                </button>
              )}
              <span className="sr-only" role="status" aria-live="polite">
                {favoriteAnnouncement}
              </span>
            </div>
          </section>

          {/* Editorial title, compact rating, subtle metadata, and tags */}
          <div className="space-y-4">
            <h1 className="text-3xl font-serif font-bold tracking-tight text-[var(--text-primary,#F3F4F6)] sm:text-5xl break-words">
              {recipe.title}
            </h1>

            <div id="recipe-rating" className="flex flex-wrap items-center gap-3">
              <div
                role="group"
                aria-label="Personal recipe rating"
                className="flex items-center gap-1"
              >
                {Array.from({ length: 5 }).map((_, i) => {
                  const value = i + 1;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-label={`Rate ${value} out of 5 stars`}
                      aria-pressed={recipe.rating === value}
                      disabled={ratingPending || !onRateRecipe}
                      onClick={() => {
                        setRatingPending(true);
                        Promise.resolve(onRateRecipe?.(recipe.id, value)).finally(() =>
                          setRatingPending(false)
                        );
                      }}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm text-[var(--accent-text,#F59E0B)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-text,#F59E0B)] disabled:opacity-60"
                    >
                      <Star
                        className={`w-5 h-5 ${value <= recipe.rating ? 'fill-amber-400 text-amber-400' : 'text-gray-600'}`}
                      />
                    </button>
                  );
                })}
              </div>
              <span className="text-sm text-[var(--text-secondary,#9CA3AF)]" aria-live="polite">
                {recipe.rating > 0
                  ? `${recipe.ratingSource === 'imported' ? 'Imported rating' : 'Your rating'}: ${recipe.rating} out of 5`
                  : 'Not rated'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setRatingPending(true);
                  Promise.resolve(onRateRecipe?.(recipe.id, 0)).finally(() =>
                    setRatingPending(false)
                  );
                }}
                disabled={ratingPending || !onRateRecipe || recipe.rating === 0}
                className="inline-flex min-h-[44px] items-center justify-center rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)] disabled:opacity-50"
              >
                Clear Rating
              </button>
              <span className="text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                Personal rating. Not a community average.
              </span>
            </div>

            {(() => {
              const metaParts = [
                recipe.cuisine && recipe.cuisine !== 'General' ? recipe.cuisine : null,
                recipe.category && recipe.category !== 'General' ? recipe.category : null,
                recipe.difficulty || null,
              ].filter(Boolean) as string[];
              if (metaParts.length === 0) return null;
              return (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--text-secondary,#9CA3AF)]">
                  {metaParts.map((part, index) => (
                    <React.Fragment key={`${part}-${index}`}>
                      {index > 0 && <span aria-hidden="true">·</span>}
                      <span>{part}</span>
                    </React.Fragment>
                  ))}
                </div>
              );
            })()}

            {visibleTags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {visibleTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary,#9CA3AF)]"
                  >
                    #{tag}
                  </span>
                ))}
                {remainingTags > 0 && (
                  <span className="text-xs text-[var(--text-secondary,#9CA3AF)]">+{remainingTags}</span>
                )}
              </div>
            )}
          </div>

          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 gap-3 rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-4 shadow-xs sm:grid-cols-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--accent-subtle,rgba(245,158,11,0.2))] bg-[var(--accent-subtle,rgba(245,158,11,0.10))] text-[var(--accent-text,#F59E0B)]">
                <Clock className="w-5 h-5" />
              </div>
              <div>
                <span className="block text-[11px] font-medium text-[var(--text-secondary,#9CA3AF)]">Prep Time</span>
                <span className="text-sm font-bold text-[var(--text-primary,#F3F4F6)]">
                  {recipe.prepTime || '—'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--accent-subtle,rgba(245,158,11,0.2))] bg-[var(--accent-subtle,rgba(245,158,11,0.10))] text-[var(--accent-text,#F59E0B)]">
                <Flame className="w-5 h-5" />
              </div>
              <div>
                <span className="block text-[11px] font-medium text-[var(--text-secondary,#9CA3AF)]">Cook Time</span>
                <span className="text-sm font-bold text-[var(--text-primary,#F3F4F6)]">
                  {recipe.cookTime || '—'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--accent-subtle,rgba(245,158,11,0.2))] bg-[var(--accent-subtle,rgba(245,158,11,0.10))] text-[var(--accent-text,#F59E0B)]">
                <Users className="w-5 h-5" />
              </div>
              <div>
                <span className="block text-[11px] font-medium text-[var(--text-secondary,#9CA3AF)]">Servings</span>
                <span className="text-sm font-bold text-[var(--text-primary,#F3F4F6)]">
                  {recipe.servings ? `${currentServings} ${currentServings === 1 ? 'person' : 'people'}` : '—'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--accent-subtle,rgba(245,158,11,0.2))] bg-[var(--accent-subtle,rgba(245,158,11,0.10))] text-[var(--accent-text,#F59E0B)]">
                <Utensils className="w-5 h-5" />
              </div>
              <div>
                <span className="block text-[11px] font-medium text-[var(--text-secondary,#9CA3AF)]">Calories</span>
                <span className="text-sm font-bold text-[var(--text-primary,#F3F4F6)]">
                  {displayedHeaderCalories !== undefined && displayedHeaderCalories !== null && String(displayedHeaderCalories).trim()
                    ? `${displayedHeaderCalories}${String(displayedHeaderCalories).toLowerCase().includes('cal') ? '' : ' kcal'}`
                    : '—'}
                </span>
              </div>
            </div>
          </div>

          {description ? (
            <p
              data-testid="recipe-description"
              className="max-w-[52ch] text-[15px] leading-[1.75] text-[var(--text-secondary,#9CA3AF)]"
            >
              {description}
            </p>
          ) : null}

          {/* Legacy / Incomplete Metadata Recovery Alert Banner */}
          {(recipeHealth.status === 'legacy' || recipeHealth.status === 'incomplete') && onOpenVaultIntelligence && (
            <div className="rounded-2xl border border-purple-500/30 bg-purple-950/20 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 rounded-xl bg-purple-500/20 p-2 text-purple-300">
                    <BrainCircuit className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-primary,#F3F4F6)]">
                      <span>{recipeHealth.status === 'legacy' ? 'Legacy Recipe Format Detected' : 'Missing Structured Metadata'}</span>
                      <span className="rounded-full bg-purple-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-purple-300">
                        {recipeHealth.missingFields.length} missing fields
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--text-secondary,#9CA3AF)]">
                      This note is missing <span className="font-medium text-purple-300">{recipeHealth.missingFields.join(', ')}</span>. Use Vault Intelligence to analyze ingredients and instructions to recover timings and servings.
                    </p>
                  </div>
                </div>

                <button
                  id="recover-metadata-banner-btn"
                  onClick={() => onOpenVaultIntelligence(recipe.id)}
                  className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-sm bg-purple-500 px-3.5 py-1.5 text-xs font-bold text-black shadow-xs transition-colors duration-[140ms] hover:bg-purple-400"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Recover Metadata</span>
                </button>
              </div>
            </div>
          )}

          {/* Callouts */}
          {recipe.callouts.map((callout, index) => (
            <div
              key={index}
              className={`flex items-start gap-3 rounded-2xl border p-4 ${getCalloutStyles(callout.type)}`}
            >
              {getCalloutIcon(callout.type)}
              <div className="text-xs sm:text-sm">
                <h4 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[var(--text-primary,#F3F4F6)]">
                  {callout.title || `${callout.type.toUpperCase()}`}
                </h4>
                <p className="leading-relaxed whitespace-pre-wrap text-[var(--text-primary,#F3F4F6)]">{callout.content}</p>
              </div>
            </div>
          ))}

          {/* First content row: ingredients and nutrition share the width. */}
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
            {/* Ingredients Column (5 cols) */}
            <div className="rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-5 shadow-xs lg:col-span-5">
              <div className="mb-3 flex items-center justify-between border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-3">
                <h3 className="flex items-center gap-2 font-serif text-base font-bold text-[var(--text-primary,#F3F4F6)]">
                  <span>Ingredients</span>
                </h3>

                {/* Serving Scaler */}
                <div className="flex items-center gap-1.5 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2 py-1">
                  <button
                    id="decrease-servings-btn"
                    aria-label="Decrease servings"
                    onClick={() => setCurrentServings((prev) => Math.max(1, prev - 1))}
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm bg-[var(--bg-surface,#141414)] p-1 text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)]"
                    title="Decrease servings"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="px-1 font-mono text-xs font-bold text-[var(--accent-text,#F59E0B)]">
                    {currentServings}
                  </span>
                  <button
                    id="increase-servings-btn"
                    aria-label="Increase servings"
                    onClick={() => setCurrentServings((prev) => prev + 1)}
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm bg-[var(--bg-surface,#141414)] p-1 text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)]"
                    title="Increase servings"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {currentServings !== baseServings && (
                <div className="mb-3 flex items-center justify-between rounded-sm border border-[var(--accent-subtle,rgba(245,158,11,0.15))] bg-[var(--accent-subtle,rgba(245,158,11,0.10))] p-2 text-[11px] font-medium text-[var(--accent-text,#F59E0B)]">
                  <span>Scaled from {baseServings} to {currentServings} servings</span>
                  <button
                    onClick={() => setCurrentServings(baseServings)}
                    className="underline hover:text-[var(--accent-hover,#D97706)]"
                  >
                    Reset
                  </button>
                </div>
              )}

              {/* Ingredient Checkbox List */}
              <ul className="space-y-2 text-sm">
                {recipe.ingredients.map((ing, idx) => {
                  const isChecked = !!checkedIngredients[idx];
                  const rawClean = (ing.original || '').replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();
                  const cleanText = rawClean.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
                  const scaledText = scaleIngredientText(
                    cleanText,
                    baseServings,
                    currentServings
                  );

                  return (
                    <li
                      key={idx}
                      onClick={() => toggleIngredientCheck(idx)}
                      className={`flex cursor-pointer items-start gap-2.5 rounded-sm p-2 transition-colors duration-[140ms] ${
                        isChecked
                          ? 'bg-[var(--bg-elevated,#1E1E1E)]/60 text-[var(--text-muted,#6B7280)] line-through'
                          : 'text-[var(--text-primary,#F3F4F6)] hover:bg-[var(--bg-elevated,#1E1E1E)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="mt-0.5 cursor-pointer rounded border-[var(--border-subtle,rgba(255,255,255,0.2))] bg-[var(--bg-elevated,#1E1E1E)] text-[var(--accent,#F59E0B)]"
                      />
                      <span className="flex-1 leading-snug">
                        {scaledText}
                      </span>
                      <button
                        id={`ingredient-usage-btn-${idx}`}
                        type="button"
                        aria-label={`Find recipes using ${cleanText}`}
                        title="Find recipes using this ingredient"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenIngredientUsage(ing);
                        }}
                        className="shrink-0 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-1.5 text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]"
                      >
                        <Search className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* Add to Shopping List Button */}
              <div className="mt-4 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-3">
                <button
                  id="add-recipe-to-shopping-btn"
                  onClick={handleAddAllToShopping}
                  className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-xs font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-surface,#141414)]"
                >
                  <ShoppingCart className="w-4 h-4 text-[var(--accent-text,#F59E0B)]" />
                  <span>{isAddedToShop ? 'Added to Shopping List!' : 'Add Ingredients to Shopping List'}</span>
                </button>
              </div>
            </div>

            {/* Nutrition Column (7 cols) */}
            <div className="space-y-4 lg:col-span-7">
              {/* ONE consolidated Nutrition surface (Phase 5C). Precedence is
                  centralized in `resolveRecipeNutritionPresentation`: a saved
                  Advanced result is primary, legacy/simple nutrition is the
                  fallback, and the two are never shown as equivalent peers. */}
              <RecipeNutritionSection
                recipe={recipe}
                presentation={nutritionPresentation}
                servings={currentServings}
                network={network}
                onUpdateNutrition={onUpdateNutrition ? (nut) => onUpdateNutrition(recipe, nut) : undefined}
                advancedNutritionSession={advancedNutritionSession}
                advancedNutritionBundleStatus={advancedNutritionBundleStatus}
                onLoadAdvancedNutritionBundle={onLoadAdvancedNutritionBundle}
                onApplyAdvancedNutrition={onApplyAdvancedNutrition}
                onResolveAdvancedNutritionAi={onResolveAdvancedNutritionAi}
                onEstimateMassesWithAi={onEstimateMassesWithAi}
                onReviewRecipeContextWithAi={onReviewRecipeContextWithAi}
                advancedNutritionAiAvailability={advancedNutritionAiAvailability}
              />
            </div>
          </div>

          {/* Instructions Section */}
          <section className="rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-5 shadow-xs">
            <h3 className="mb-3 flex items-center justify-between border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-3 font-serif text-base font-bold text-[var(--text-primary,#F3F4F6)]">
              <span>Instructions & Timers</span>
              <span className="text-xs font-normal text-[var(--text-secondary,#9CA3AF)]">
                {recipe.instructions.length} steps
              </span>
            </h3>

            <ol className="max-w-3xl space-y-4">
              {recipe.instructions.map((step, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-3 transition-colors duration-[140ms] hover:border-[var(--border-subtle,rgba(255,255,255,0.16))]"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent,#F59E0B)] text-xs font-bold text-[var(--accent-contrast,#0C0C0C)]">
                    {step.stepNumber || idx + 1}
                  </span>
                  <div className="flex-1 space-y-2">
                    <p className="text-sm leading-relaxed text-[var(--text-primary,#F3F4F6)]">
                      {renderInlineMarkdown(step.text)}
                    </p>

                    {/* Interactive Timer Trigger Button if timer detected */}
                    {step.timerMinutes && (
                      <button
                        id={`step-timer-btn-${idx}`}
                        onClick={() =>
                          onStartTimer(
                            recipe.title,
                            step.timerMinutes!,
                            `Step ${step.stepNumber}: ${step.timerMinutes}m`
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--accent-subtle,rgba(245,158,11,0.3))] bg-[var(--accent-subtle,rgba(245,158,11,0.10))] px-2.5 py-1 text-xs font-semibold text-[var(--accent-text,#F59E0B)] transition-colors duration-[140ms] hover:bg-[var(--accent-subtle,rgba(245,158,11,0.20))]"
                      >
                        <Timer className="w-3.5 h-3.5 text-[var(--accent-text,#F59E0B)]" />
                        <span>Start {step.timerMinutes} min Timer</span>
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Notes & Variations */}
          {recipe.notes && (
            <div className="rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-5 shadow-xs">
              <h4 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-[var(--text-primary,#F3F4F6)]">
                <Sparkles className="w-4 h-4 text-[var(--accent-text,#F59E0B)]" />
                <span>Notes & Vault Cross-References</span>
              </h4>
              <div id="recipe-notes" className="space-y-2 text-sm leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                {renderNotes(recipe.notes)}
              </div>
            </div>
          )}

          {/* Similar Recipes (derived from the Step 6 relationship index) */}
          <RecipeRelationshipsPanel
            recipe={recipe}
            index={relationshipIndex}
            recipeByIdentity={recipeByIdentity}
            onSelectRecipe={(r) => onSelectRecipe?.(r)}
          />
        </div>
      )}

      {/* Ingredient Usage Modal (recipes using a tapped ingredient) */}
      <IngredientUsageModal
        isOpen={!!ingredientUsage}
        display={ingredientUsage?.display ?? ''}
        query={ingredientUsage?.query ?? ''}
        currentIdentity={currentIdentity}
        index={relationshipIndex}
        recipeByIdentity={recipeByIdentity}
        onClose={() => setIngredientUsage(null)}
        onSelectRecipe={(r) => onSelectRecipe?.(r)}
      />

      {/* Wikilink Intelligence Modal */}
      <WikilinkPreviewModal
        target={selectedWikilink?.target || null}
        alias={selectedWikilink?.alias || null}
        isOpen={!!selectedWikilink}
        onClose={() => setSelectedWikilink(null)}
        recipes={allRecipes}
        notes={allNotes}
        onSelectRecipe={(rec) => {
          setSelectedWikilink(null);
          onSelectRecipe?.(rec);
        }}
        onFilterByWikilink={onFilterByWikilink}
        onSaveNoteToVault={onSaveNoteToVault}
      />

      {/* Recipe Card & Export Studio Modal */}
      {showCardStudio && (
        <React.Suspense fallback={<div className="p-8 text-center text-[var(--text-secondary,#9CA3AF)]">Loading card studio…</div>}>
          <RecipeCardExportModal
            recipe={recipe}
            currentServings={currentServings}
            onClose={() => setShowCardStudio(false)}
          />
        </React.Suspense>
      )}
    </div>
  );
}
