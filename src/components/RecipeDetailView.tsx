import React, { useState } from 'react';
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
} from 'lucide-react';
import { ObsidianRecipe, ParsedIngredient, VaultNote, RecipeNutrition } from '../types';
import { scaleIngredientText } from '../utils/markdownParser';
import { downloadMarkdownFile } from '../utils/vaultFileSystem';
import { getRecipeImage, DEFAULT_FOOD_IMAGES } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';
import { assessRecipeHealth } from '../utils/vaultIntelligence';
import { RecipeNutritionCard } from './RecipeNutritionCard';
import { WikilinkPreviewModal } from './WikilinkPreviewModal';

interface RecipeDetailViewProps {
  recipe: ObsidianRecipe;
  allRecipes?: ObsidianRecipe[];
  allNotes?: VaultNote[];
  onBack: () => void;
  onStartCooking: (recipe: ObsidianRecipe, servings: number) => void;
  onEditRecipe: (recipe: ObsidianRecipe) => void;
  onAddToMealPlan: (recipe: ObsidianRecipe) => void;
  onAddToShoppingList: (recipe: ObsidianRecipe, ingredients: string[]) => void;
  onStartTimer: (recipeTitle: string, minutes: number, label: string) => void;
  onFilterByWikilink?: (wikilink: string) => void;
  onDeleteRecipe?: (recipe: ObsidianRecipe) => void;
  onUpdateNutrition?: (recipe: ObsidianRecipe, nutrition: RecipeNutrition) => Promise<boolean | void> | void;
  onSelectRecipe?: (recipe: ObsidianRecipe) => void;
  onSaveNoteToVault?: (note: VaultNote) => Promise<boolean | void>;
  onOpenVaultIntelligence?: (recipeId?: string) => void;
}

export function RecipeDetailView({
  recipe,
  allRecipes = [],
  allNotes = [],
  onBack,
  onStartCooking,
  onEditRecipe,
  onAddToMealPlan,
  onAddToShoppingList,
  onStartTimer,
  onFilterByWikilink,
  onDeleteRecipe,
  onUpdateNutrition,
  onSelectRecipe,
  onSaveNoteToVault,
  onOpenVaultIntelligence,
}: RecipeDetailViewProps) {
  const [currentServings, setCurrentServings] = useState<number>(recipe.servings || 4);
  const [activeViewMode, setActiveViewMode] = useState<'visual' | 'markdown'>('visual');
  const [checkedIngredients, setCheckedIngredients] = useState<Record<number, boolean>>({});
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [isAddedToShop, setIsAddedToShop] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedWikilink, setSelectedWikilink] = useState<{ target: string; alias?: string } | null>(null);

  const defaultImg = getRecipeImage(recipe);
  const reactiveVaultImage = useVaultImage(recipe.image, defaultImg);

  const baseServings = recipe.servings || 4;
  const recipeHealth = assessRecipeHealth(recipe);

  const toggleIngredientCheck = (idx: number) => {
    setCheckedIngredients((prev) => ({
      ...prev,
      [idx]: !prev[idx],
    }));
  };

  const handleCopyWikilink = () => {
    navigator.clipboard.writeText(`[[${recipe.title}]]`);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
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

  return (
    <div id="recipe-detail-view" className="max-w-4xl mx-auto px-4 sm:px-6 py-6 pb-24 text-gray-200">
      {/* Navigation Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6 pb-4 border-b border-white/5">
        <button
          id="back-to-vault-btn"
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-200 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Vault</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {/* Visual vs Markdown Tab */}
          <div className="flex items-center bg-[#0C0C0C] p-1 rounded-lg border border-white/5 text-xs">
            <button
              id="view-visual-mode-btn"
              onClick={() => setActiveViewMode('visual')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-all ${
                activeViewMode === 'visual'
                  ? 'bg-white/10 text-amber-400 border border-white/10 font-semibold shadow-xs'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Kitchen View</span>
            </button>
            <button
              id="view-markdown-mode-btn"
              onClick={() => setActiveViewMode('markdown')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-all ${
                activeViewMode === 'markdown'
                  ? 'bg-white/10 text-amber-400 border border-white/10 font-semibold shadow-xs'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <FileCode className="w-3.5 h-3.5 text-amber-400" />
              <span>Raw Markdown</span>
            </button>
          </div>

          {/* Copy Wikilink */}
          <button
            id="copy-wikilink-btn"
            onClick={handleCopyWikilink}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 text-xs font-medium transition-colors"
            title="Copy [[Wikilink]] for Obsidian"
          >
            {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedLink ? 'Copied [[Link]]!' : '[[Wikilink]]'}</span>
          </button>

          {/* Vault Intelligence Quick Button */}
          {onOpenVaultIntelligence && (
            <button
              id="recipe-detail-vault-intelligence-btn"
              onClick={() => onOpenVaultIntelligence(recipe.id)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 text-xs font-medium transition-colors"
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
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 text-xs font-medium transition-colors"
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
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 text-xs font-medium transition-colors"
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
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 text-xs font-medium transition-colors"
            title="Download .md note"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export</span>
          </button>

          {/* Start Cooking Mode Button */}
          <button
            id="launch-cooking-mode-btn"
            onClick={() => onStartCooking(recipe, currentServings)}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold shadow-sm transition-colors"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Start Cooking Mode</span>
          </button>
        </div>
      </div>

      {activeViewMode === 'markdown' ? (
        /* Raw Obsidian Markdown View */
        <div className="bg-[#0C0C0C] text-gray-200 rounded-2xl border border-white/10 p-5 font-mono text-xs overflow-x-auto shadow-lg">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/10">
            <span className="text-gray-400 font-semibold flex items-center gap-2">
              <FileCode className="w-4 h-4 text-amber-400" />
              <span>{recipe.filePath || recipe.fileName}</span>
            </span>
            <button
              onClick={handleCopyMarkdown}
              className="flex items-center gap-1 px-2.5 py-1 bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 rounded text-xs transition-colors"
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
          {/* Hero Image Showcase */}
          <div className="relative w-full h-64 sm:h-80 md:h-96 rounded-3xl overflow-hidden border border-white/10 shadow-xl bg-[#141414]">
            <img
              src={reactiveVaultImage || defaultImg}
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
            <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/40 to-transparent pointer-events-none" />

            {/* Content overlay inside hero image */}
            <div className="absolute bottom-0 inset-x-0 p-6 sm:p-8 flex flex-col justify-end">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-mono text-xs px-2.5 py-1 rounded-md bg-black/70 backdrop-blur-md text-amber-300 border border-amber-500/30">
                  {recipe.cuisine} • {recipe.category}
                </span>
                <span className="text-xs px-2.5 py-1 rounded-md bg-black/70 backdrop-blur-md text-emerald-300 font-semibold border border-emerald-500/30">
                  {recipe.difficulty}
                </span>
                <div className="flex items-center gap-1 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-md border border-white/10 text-amber-400 text-xs">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      className={`w-3.5 h-3.5 ${i < recipe.rating ? 'fill-amber-400 text-amber-400' : 'text-gray-600'}`}
                    />
                  ))}
                  <span className="ml-1 text-white font-bold">{recipe.rating}.0</span>
                </div>
              </div>

              <h1 className="text-2xl sm:text-4xl font-serif font-bold text-white tracking-tight drop-shadow-md">
                {recipe.title}
              </h1>

              {/* Obsidian Tags in Hero */}
              <div className="flex flex-wrap items-center gap-1.5 mt-3">
                {recipe.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-xs font-mono px-2.5 py-0.5 rounded-md bg-black/60 backdrop-blur-md text-amber-300 border border-white/15"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Legacy / Incomplete Metadata Recovery Alert Banner */}
          {(recipeHealth.status === 'legacy' || recipeHealth.status === 'incomplete') && onOpenVaultIntelligence && (
            <div className="p-4 rounded-2xl bg-purple-950/20 border border-purple-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-purple-200 shadow-sm">
              <div className="flex items-start sm:items-center gap-3">
                <div className="p-2 rounded-xl bg-purple-500/20 text-purple-300 shrink-0">
                  <BrainCircuit className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    <span>{recipeHealth.status === 'legacy' ? 'Legacy Recipe Format Detected' : 'Missing Structured Metadata'}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-mono font-bold">
                      {recipeHealth.missingFields.length} missing fields
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    This note is missing <span className="text-purple-300 font-medium">{recipeHealth.missingFields.join(', ')}</span>. Use Vault Intelligence to analyze ingredients and instructions to recover timings and servings.
                  </p>
                </div>
              </div>

              <button
                id="recover-metadata-banner-btn"
                onClick={() => onOpenVaultIntelligence(recipe.id)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-purple-500 hover:bg-purple-400 text-black shadow-xs transition-colors shrink-0 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Recover Metadata</span>
              </button>
            </div>
          )}

          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[#141414] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
                <Clock className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[11px] text-gray-500 block font-medium">Prep Time</span>
                <span className="text-sm font-bold text-white">
                  {recipe.prepTime || '—'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
                <Flame className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[11px] text-gray-500 block font-medium">Cook Time</span>
                <span className="text-sm font-bold text-white">
                  {recipe.cookTime || '—'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
                <Users className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[11px] text-gray-500 block font-medium">Servings</span>
                <span className="text-sm font-bold text-white">
                  {recipe.servings ? `${currentServings} ${currentServings === 1 ? 'person' : 'people'}` : '—'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
                <Utensils className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[11px] text-gray-500 block font-medium">Calories</span>
                <span className="text-sm font-bold text-white">
                  {recipe.calories !== undefined && recipe.calories !== null && String(recipe.calories).trim()
                    ? `${recipe.calories}${String(recipe.calories).toLowerCase().includes('cal') ? '' : ' kcal'}`
                    : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Obsidian Callouts */}
          {recipe.callouts.map((callout, index) => (
            <div
              key={index}
              className={`p-4 rounded-2xl border ${getCalloutStyles(callout.type)} flex items-start gap-3`}
            >
              {getCalloutIcon(callout.type)}
              <div className="text-xs sm:text-sm">
                <h4 className="font-bold mb-1 uppercase tracking-wide text-[11px]">
                  {callout.title || `${callout.type.toUpperCase()}`}
                </h4>
                <p className="leading-relaxed whitespace-pre-wrap">{callout.content}</p>
              </div>
            </div>
          ))}

          {/* Main 2-Column Section: Ingredients & Instructions */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Ingredients Column (5 cols) */}
            <div className="lg:col-span-5 bg-[#141414] rounded-2xl border border-white/5 p-5 shadow-xs">
              <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/5">
                <h3 className="text-base font-serif font-bold text-white flex items-center gap-2">
                  <span>🥘 Ingredients</span>
                </h3>

                {/* Serving Scaler */}
                <div className="flex items-center gap-1.5 bg-[#0C0C0C] px-2 py-1 rounded-lg border border-white/5">
                  <button
                    id="decrease-servings-btn"
                    onClick={() => setCurrentServings((prev) => Math.max(1, prev - 1))}
                    className="p-1 rounded bg-white/5 text-gray-200 hover:bg-white/10 transition-colors"
                    title="Decrease servings"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="font-mono text-xs font-bold px-1 text-amber-400">
                    {currentServings}
                  </span>
                  <button
                    id="increase-servings-btn"
                    onClick={() => setCurrentServings((prev) => prev + 1)}
                    className="p-1 rounded bg-white/5 text-gray-200 hover:bg-white/10 transition-colors"
                    title="Increase servings"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {currentServings !== baseServings && (
                <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 p-2 rounded-lg mb-3 font-medium flex items-center justify-between">
                  <span>Scaled from {baseServings} to {currentServings} servings</span>
                  <button
                    onClick={() => setCurrentServings(baseServings)}
                    className="underline hover:text-amber-200"
                  >
                    Reset
                  </button>
                </div>
              )}

              {/* Ingredient Checkbox List */}
              <ul className="space-y-2 text-xs sm:text-sm">
                {recipe.ingredients.map((ing, idx) => {
                  const isChecked = !!checkedIngredients[idx];
                  const scaledText = scaleIngredientText(
                    ing.original,
                    baseServings,
                    currentServings
                  );

                  const linkTarget = ing.wikilinkTarget || ing.wikilink;
                  const linkAlias = ing.wikilinkAlias;

                  return (
                    <li
                      key={idx}
                      onClick={() => toggleIngredientCheck(idx)}
                      className={`flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${
                        isChecked ? 'bg-[#0C0C0C]/60 text-gray-600 line-through' : 'hover:bg-white/5 text-gray-200'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="mt-0.5 rounded text-amber-500 focus:ring-amber-400 bg-[#0C0C0C] border-white/20 cursor-pointer"
                      />
                      <span className="flex-1 leading-snug">
                        {linkTarget ? (
                          <span>
                            {scaledText.replace(/\[\[(.*?)\]\]/, '')}
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedWikilink({
                                  target: linkTarget,
                                  alias: linkAlias,
                                });
                              }}
                              className="font-mono font-medium text-amber-300 bg-amber-500/10 border border-amber-500/20 px-1 py-0.5 rounded hover:bg-amber-500/20 ml-1 inline-flex items-center gap-0.5 transition-colors cursor-pointer"
                              title={`Preview intelligence for [[${linkTarget}]]`}
                            >
                              [[{linkAlias ? `${linkTarget}|${linkAlias}` : linkTarget}]]
                            </span>
                          </span>
                        ) : (
                          scaledText
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {/* Add to Shopping List Button */}
              <div className="mt-4 pt-3 border-t border-white/5">
                <button
                  id="add-recipe-to-shopping-btn"
                  onClick={handleAddAllToShopping}
                  className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 text-xs font-semibold transition-colors"
                >
                  <ShoppingCart className="w-4 h-4 text-amber-400" />
                  <span>{isAddedToShop ? 'Added to Shopping List!' : 'Add Ingredients to Shopping List'}</span>
                </button>
              </div>
            </div>

            {/* Instructions Column (7 cols) */}
            <div className="lg:col-span-7 space-y-4">
              {/* Nutrition & Macros Card */}
              {onUpdateNutrition && (
                <RecipeNutritionCard
                  recipe={recipe}
                  servings={currentServings}
                  onUpdateNutrition={(nut) => onUpdateNutrition(recipe, nut)}
                />
              )}

              <div className="bg-[#141414] rounded-2xl border border-white/5 p-5 shadow-xs">
                <h3 className="text-base font-serif font-bold text-white pb-3 mb-3 border-b border-white/5 flex items-center justify-between">
                  <span>🍳 Instructions & Timers</span>
                  <span className="text-xs font-normal text-gray-500">
                    {recipe.instructions.length} steps
                  </span>
                </h3>

                <ol className="space-y-4">
                  {recipe.instructions.map((step, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-3 p-3 rounded-xl bg-[#0C0C0C] border border-white/5 hover:border-white/10 transition-colors"
                    >
                      <span className="w-6 h-6 rounded-full bg-amber-500 text-black text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                        {step.stepNumber || idx + 1}
                      </span>
                      <div className="flex-1 space-y-2">
                        <p className="text-xs sm:text-sm text-gray-200 leading-relaxed">
                          {step.text}
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
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-semibold transition-colors"
                          >
                            <Timer className="w-3.5 h-3.5 text-amber-400" />
                            <span>Start {step.timerMinutes} min Timer</span>
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              {/* Notes & Variations */}
              {recipe.notes && (
                <div className="bg-[#141414] rounded-2xl border border-white/5 p-5 shadow-xs">
                  <h4 className="text-sm font-bold text-white mb-2 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    <span>Notes & Vault Cross-References</span>
                  </h4>
                  <div className="text-xs sm:text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                    {recipe.notes}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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
    </div>
  );
}
