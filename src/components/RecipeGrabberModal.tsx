import React, { useState } from 'react';
import {
  Globe,
  Download,
  Sparkles,
  Link as LinkIcon,
  FileText,
  Clock,
  Users,
  Utensils,
  ChefHat,
  CheckCircle2,
  AlertCircle,
  X,
  FileCode,
  ArrowRight,
  ExternalLink,
  Edit3,
  Flame,
  BookOpen,
  Image as ImageIcon,
  FolderDown,
} from 'lucide-react';
import { ObsidianRecipe, ParsedIngredient, RecipeStep, ObsidianCallout } from '../types';
import { serializeRecipeToObsidianMarkdown, parseObsidianRecipeMarkdown } from '../utils/markdownParser';
import { saveImageToVaultAssets, syncResolveVaultAssetUrl } from '../utils/vaultAssets';

interface RecipeGrabberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveRecipe: (recipe: ObsidianRecipe) => Promise<void> | void;
  onOpenInEditor?: (recipe: ObsidianRecipe) => void;
  folderHandle?: any;
}

interface GrabbedRecipeData {
  title: string;
  description: string;
  cuisine: string;
  category: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  prepTime: string;
  cookTime: string;
  totalTime: string;
  servings: number;
  calories?: string | number;
  rating: number;
  source: string;
  sourceUrl?: string;
  image?: string;
  tags: string[];
  ingredients: ParsedIngredient[];
  instructions: RecipeStep[];
  callouts: ObsidianCallout[];
  notes?: string;
  rawMarkdown: string;
}

const SAMPLE_RECIPES = [
  {
    label: 'Serious Eats Crispy Potatoes',
    icon: '🥔',
    url: 'https://www.seriouseats.com/the-best-crispy-roast-potatoes-recipe',
  },
  {
    label: "Sally's Chocolate Chip Cookies",
    icon: '🍪',
    url: 'https://sallysbakingaddiction.com/chewy-chocolate-chip-cookies/',
  },
  {
    label: 'BBC Good Food Carbonara',
    icon: '🍝',
    url: 'https://www.bbcgoodfood.com/recipes/ultimate-spaghetti-carbonara',
  },
  {
    label: 'Authentic Pad Thai',
    icon: '🍜',
    url: 'https://hot-thai-kitchen.com/best-pad-thai/',
  },
];

export function RecipeGrabberModal({
  isOpen,
  onClose,
  onSaveRecipe,
  onOpenInEditor,
  folderHandle,
}: RecipeGrabberModalProps) {
  const [inputMode, setInputMode] = useState<'url' | 'text'>('url');
  const [urlInput, setUrlInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Extracted Result State
  const [grabbedData, setGrabbedData] = useState<GrabbedRecipeData | null>(null);
  const [previewTab, setPreviewTab] = useState<'visual' | 'markdown'>('visual');

  // Editable Form fields on grabbed data
  const [editTitle, setEditTitle] = useState('');
  const [editCuisine, setEditCuisine] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editServings, setEditServings] = useState<number>(4);
  const [editPrepTime, setEditPrepTime] = useState('');
  const [editCookTime, setEditCookTime] = useState('');
  const [editDifficulty, setEditDifficulty] = useState<'Easy' | 'Medium' | 'Hard'>('Medium');
  const [editImage, setEditImage] = useState('');
  const [saveImageToAssets, setSaveImageToAssets] = useState(true);

  if (!isOpen) return null;

  const handleGrabRecipe = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorMsg(null);

    const trimmedUrl = urlInput.trim();
    const trimmedText = textInput.trim();

    if (inputMode === 'url' && !trimmedUrl) {
      setErrorMsg('Please enter a valid recipe website URL.');
      return;
    }

    if (inputMode === 'text' && !trimmedText) {
      setErrorMsg('Please paste recipe text or HTML content.');
      return;
    }

    setIsLoading(true);
    setLoadingStep('Connecting to website source & extracting recipe data...');

    try {
      const response = await fetch('/api/grab-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inputMode === 'url' ? trimmedUrl : undefined,
          rawText: inputMode === 'text' ? trimmedText : undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to extract recipe from website.');
      }

      const recipe: GrabbedRecipeData = data.recipe;
      setGrabbedData(recipe);
      setEditTitle(recipe.title || 'Untitled Recipe');
      setEditCuisine(recipe.cuisine || 'General');
      setEditCategory(recipe.category || 'Main Course');
      setEditServings(recipe.servings || 4);
      setEditPrepTime(recipe.prepTime || '');
      setEditCookTime(recipe.cookTime || '');
      setEditDifficulty(recipe.difficulty || 'Medium');
      setEditImage(recipe.image || '');
      setSaveImageToAssets(true);
    } catch (err: any) {
      console.error('Recipe grab error:', err);
      setErrorMsg(err.message || 'An error occurred while grabbing the recipe. Check the URL and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplySample = (sampleUrl: string) => {
    setInputMode('url');
    setUrlInput(sampleUrl);
    setErrorMsg(null);
  };

  const processImageSave = async (titleToUse: string, imageSrc: string): Promise<string> => {
    if (!saveImageToAssets || !imageSrc || !imageSrc.trim()) {
      return imageSrc;
    }
    // If it's already an Assets/ path, keep it
    if (imageSrc.startsWith('Assets/') || imageSrc.startsWith('assets/')) {
      return imageSrc;
    }
    try {
      setLoadingStep('Saving food image to Assets/ folder in Obsidian vault...');
      const saved = await saveImageToVaultAssets(folderHandle, titleToUse, imageSrc);
      return saved.relativePath;
    } catch (err) {
      console.warn('Failed to save image to Assets/ folder, falling back to original URL:', err);
      return imageSrc;
    }
  };

  const constructFinalRecipe = (finalImagePath?: string): ObsidianRecipe => {
    if (!grabbedData) throw new Error('No grabbed recipe available');

    const cleanTitle = editTitle.trim() || 'Untitled Recipe';
    const fileName = `${cleanTitle.replace(/[/\\?%*:|"<>]/g, '').trim()}.md`;
    const resolvedImage = finalImagePath !== undefined ? finalImagePath : editImage;

    const updatedRecipeData: Partial<ObsidianRecipe> = {
      title: cleanTitle,
      fileName,
      filePath: `Food/Recipes/${fileName}`,
      cuisine: editCuisine.trim() || 'General',
      category: editCategory.trim() || 'Main Course',
      difficulty: editDifficulty,
      servings: editServings || 4,
      prepTime: editPrepTime.trim() || undefined,
      cookTime: editCookTime.trim() || undefined,
      totalTime: grabbedData.totalTime,
      rating: grabbedData.rating || 5,
      calories: grabbedData.calories,
      source: grabbedData.source || urlInput || 'Web Grabber',
      image: resolvedImage,
      tags: grabbedData.tags.length > 0 ? grabbedData.tags : ['food/recipes'],
      ingredients: grabbedData.ingredients,
      instructions: grabbedData.instructions,
      callouts: grabbedData.callouts,
      notes: grabbedData.notes,
      lastModified: new Date().toISOString().split('T')[0],
    };

    const finalMarkdown = serializeRecipeToObsidianMarkdown(updatedRecipeData);
    const parsed = parseObsidianRecipeMarkdown(finalMarkdown, fileName, updatedRecipeData.filePath);
    return parsed;
  };

  const handleSaveToVault = async () => {
    try {
      setIsLoading(true);
      const cleanTitle = editTitle.trim() || 'Untitled Recipe';
      const finalImage = await processImageSave(cleanTitle, editImage);
      const finalRecipe = constructFinalRecipe(finalImage);
      await onSaveRecipe(finalRecipe);
      handleReset();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save recipe to vault.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenEditor = async () => {
    try {
      setIsLoading(true);
      const cleanTitle = editTitle.trim() || 'Untitled Recipe';
      const finalImage = await processImageSave(cleanTitle, editImage);
      const finalRecipe = constructFinalRecipe(finalImage);
      if (onOpenInEditor) {
        onOpenInEditor(finalRecipe);
      }
      handleReset();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to open recipe in editor.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setGrabbedData(null);
    setUrlInput('');
    setTextInput('');
    setEditImage('');
    setSaveImageToAssets(true);
    setErrorMsg(null);
    setIsLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div
        id="recipe-grabber-modal"
        className="bg-[#141414] border border-white/10 rounded-2xl max-w-3xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-gray-200"
      >
        {/* Modal Header */}
        <div className="p-5 border-b border-white/5 flex items-center justify-between bg-[#191919]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-serif font-bold text-base text-white">
                  Web Recipe Grabber
                </h2>
                <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 font-semibold border border-amber-500/20">
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  AI &amp; Schema.org
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                Import and convert recipe websites directly into Obsidian Markdown notes
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {!grabbedData ? (
            /* Input View */
            <div className="space-y-5">
              {/* Input Mode Selector */}
              <div className="flex items-center gap-2 border-b border-white/5 pb-3">
                <button
                  type="button"
                  onClick={() => setInputMode('url')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    inputMode === 'url'
                      ? 'bg-amber-500 text-black'
                      : 'bg-white/5 text-gray-400 hover:text-white'
                  }`}
                >
                  <LinkIcon className="w-3.5 h-3.5" />
                  <span>Website URL</span>
                </button>

                <button
                  type="button"
                  onClick={() => setInputMode('text')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    inputMode === 'text'
                      ? 'bg-amber-500 text-black'
                      : 'bg-white/5 text-gray-400 hover:text-white'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Paste Recipe Text / HTML</span>
                </button>
              </div>

              {/* Form Input */}
              {inputMode === 'url' ? (
                <form onSubmit={handleGrabRecipe} className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-gray-300">
                      Recipe Webpage Link
                    </label>
                    <div className="relative">
                      <LinkIcon className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
                      <input
                        id="recipe-url-input"
                        type="url"
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="https://www.seriouseats.com/... or https://cooking.nytimes.com/..."
                        disabled={isLoading}
                        className="w-full pl-10 pr-4 py-2.5 text-xs bg-[#0C0C0C] border border-white/10 rounded-xl text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500 transition-colors shadow-inner"
                      />
                    </div>
                  </div>

                  {/* Sample Test Links */}
                  <div className="space-y-2">
                    <span className="text-[11px] font-medium text-gray-500 block">
                      Or try with a popular sample recipe:
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {SAMPLE_RECIPES.map((sample) => (
                        <button
                          key={sample.label}
                          type="button"
                          onClick={() => handleApplySample(sample.url)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 hover:text-amber-300 transition-colors"
                        >
                          <span>{sample.icon}</span>
                          <span>{sample.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Submit Button */}
                  <button
                    id="grab-recipe-submit-btn"
                    type="submit"
                    disabled={isLoading || !urlInput.trim()}
                    className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:hover:bg-amber-500 text-black font-bold text-xs flex items-center justify-center gap-2 shadow-md shadow-amber-500/20 transition-all cursor-pointer"
                  >
                    {isLoading ? (
                      <>
                        <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                        <span>Extracting Recipe...</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        <span>Grab &amp; Import Recipe</span>
                      </>
                    )}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleGrabRecipe} className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-gray-300">
                      Paste Raw Recipe Text or HTML
                    </label>
                    <textarea
                      id="recipe-text-input"
                      rows={8}
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      placeholder="Paste recipe ingredients, cooking steps, and notes here..."
                      disabled={isLoading}
                      className="w-full p-3.5 text-xs bg-[#0C0C0C] border border-white/10 rounded-xl text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500 font-mono transition-colors shadow-inner"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isLoading || !textInput.trim()}
                    className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:hover:bg-amber-500 text-black font-bold text-xs flex items-center justify-center gap-2 shadow-md shadow-amber-500/20 transition-all cursor-pointer"
                  >
                    {isLoading ? (
                      <>
                        <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                        <span>Extracting Recipe...</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        <span>Parse &amp; Import Recipe</span>
                      </>
                    )}
                  </button>
                </form>
              )}

              {/* Loading State Animation */}
              {isLoading && (
                <div className="bg-[#191919] p-4 rounded-xl border border-amber-500/20 flex items-center gap-3">
                  <div className="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin shrink-0" />
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold text-amber-300">
                      {loadingStep || 'Processing recipe website...'}
                    </p>
                    <p className="text-[11px] text-gray-400">
                      Parsing JSON-LD schema, ingredient measurements, cooking timers, and Obsidian wikilinks...
                    </p>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {errorMsg && (
                <div className="p-3.5 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start gap-2.5 text-rose-300 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-semibold">Extraction Error</p>
                    <p className="text-rose-400/90">{errorMsg}</p>
                    <p className="text-[11px] text-gray-400">
                      Tip: If the website is blocked or behind a paywall, switch to the <strong>&quot;Paste Recipe Text&quot;</strong> tab to import directly.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Extracted Preview & Adjust View */
            <div className="space-y-6">
              {/* Success Banner */}
              <div className="bg-emerald-950/40 border border-emerald-800/40 rounded-xl p-3.5 flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>
                    Successfully grabbed recipe from <strong>{grabbedData.source || 'Web'}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-gray-400 hover:text-white text-xs underline"
                >
                  Grab another
                </button>
              </div>

              {/* Quick Editable Metadata Fields */}
              <div className="bg-[#191919] p-4 rounded-xl border border-white/5 space-y-3">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Edit3 className="w-3.5 h-3.5 text-amber-400" />
                  <span>Review &amp; Edit Note Metadata</span>
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="space-y-1">
                    <label className="text-gray-400 font-medium">Recipe Title</label>
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full px-3 py-1.5 bg-[#0C0C0C] border border-white/10 rounded-lg text-white font-semibold focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-gray-400 font-medium">Cuisine</label>
                    <input
                      type="text"
                      value={editCuisine}
                      onChange={(e) => setEditCuisine(e.target.value)}
                      className="w-full px-3 py-1.5 bg-[#0C0C0C] border border-white/10 rounded-lg text-gray-200 focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-gray-400 font-medium">Category</label>
                    <input
                      type="text"
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value)}
                      className="w-full px-3 py-1.5 bg-[#0C0C0C] border border-white/10 rounded-lg text-gray-200 focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <label className="text-gray-400 font-medium">Servings</label>
                      <input
                        type="number"
                        min={1}
                        value={editServings}
                        onChange={(e) => setEditServings(parseInt(e.target.value, 10) || 1)}
                        className="w-full px-2.5 py-1.5 bg-[#0C0C0C] border border-white/10 rounded-lg text-gray-200 focus:outline-none focus:border-amber-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-gray-400 font-medium">Prep Time</label>
                      <input
                        type="text"
                        value={editPrepTime}
                        onChange={(e) => setEditPrepTime(e.target.value)}
                        placeholder="15 mins"
                        className="w-full px-2.5 py-1.5 bg-[#0C0C0C] border border-white/10 rounded-lg text-gray-200 focus:outline-none focus:border-amber-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-gray-400 font-medium">Cook Time</label>
                      <input
                        type="text"
                        value={editCookTime}
                        onChange={(e) => setEditCookTime(e.target.value)}
                        placeholder="30 mins"
                        className="w-full px-2.5 py-1.5 bg-[#0C0C0C] border border-white/10 rounded-lg text-gray-200 focus:outline-none focus:border-amber-500"
                      />
                    </div>
                  </div>
                </div>

                {/* Food Photography & Vault Assets Folder Settings */}
                {editImage && (
                  <div className="p-3 bg-[#0C0C0C] border border-white/10 rounded-xl space-y-2 text-xs">
                    <div className="flex items-start gap-3">
                      <div className="w-16 h-16 rounded-lg overflow-hidden bg-black/50 border border-white/10 shrink-0 relative">
                        <img
                          src={editImage.startsWith('Assets/') || editImage.startsWith('assets/') ? syncResolveVaultAssetUrl(editImage) || editImage : editImage}
                          alt={editTitle || 'Recipe preview'}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-semibold text-white flex items-center gap-1.5">
                            <ImageIcon className="w-3.5 h-3.5 text-amber-400" />
                            <span>Recipe Photography</span>
                          </label>
                        </div>
                        <input
                          type="text"
                          value={editImage}
                          onChange={(e) => setEditImage(e.target.value)}
                          placeholder="Image URL or Assets/filename.jpg"
                          className="w-full px-2.5 py-1 bg-[#141414] border border-white/10 rounded-lg text-xs font-mono text-gray-300 focus:outline-none focus:border-amber-500"
                        />
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={saveImageToAssets}
                            onChange={(e) => setSaveImageToAssets(e.target.checked)}
                            className="rounded border-white/20 bg-[#141414] text-amber-500 focus:ring-amber-400 focus:ring-offset-0 w-3.5 h-3.5"
                          />
                          <span className="text-[11px] text-amber-300 font-medium flex items-center gap-1">
                            <FolderDown className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            Download &amp; store image in vault <code className="text-white font-mono bg-white/10 px-1 py-0.5 rounded text-[10px]">Assets/</code> folder
                          </span>
                        </label>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* View Switcher: Visual Preview vs Markdown Source */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPreviewTab('visual')}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                        previewTab === 'visual'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      Visual Recipe Note
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewTab('markdown')}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                        previewTab === 'markdown'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      Obsidian Markdown (.md)
                    </button>
                  </div>

                  <span className="text-xs text-gray-500 font-mono">
                    {grabbedData.ingredients.length} ingredients • {grabbedData.instructions.length} steps
                  </span>
                </div>

                {previewTab === 'visual' ? (
                  <div className="space-y-4 bg-[#0C0C0C] p-4 rounded-xl border border-white/5">
                    {/* Ingredients */}
                    <div>
                      <h4 className="font-bold text-xs text-amber-400 uppercase tracking-wider mb-2">
                        🥘 Ingredients ({grabbedData.ingredients.length})
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {grabbedData.ingredients.map((ing, i) => (
                          <div
                            key={i}
                            className="text-xs p-2 rounded-lg bg-white/5 border border-white/5 flex items-center justify-between gap-2"
                          >
                            <span className="text-gray-200">{ing.original}</span>
                            {ing.wikilink && (
                              <span className="text-[10px] font-mono text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 shrink-0">
                                [[{ing.wikilink}]]
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Instructions */}
                    <div>
                      <h4 className="font-bold text-xs text-amber-400 uppercase tracking-wider mb-2">
                        🍳 Instructions ({grabbedData.instructions.length} steps)
                      </h4>
                      <div className="space-y-2">
                        {grabbedData.instructions.map((inst, i) => (
                          <div
                            key={i}
                            className="text-xs p-2.5 rounded-lg bg-white/5 border border-white/5 flex items-start gap-2.5"
                          >
                            <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-400 font-bold text-[11px] flex items-center justify-center shrink-0 mt-0.5">
                              {i + 1}
                            </span>
                            <span className="text-gray-300 leading-relaxed">{inst.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Notes & Callouts */}
                    {grabbedData.callouts && grabbedData.callouts.length > 0 && (
                      <div>
                        {grabbedData.callouts.map((c, i) => (
                          <div
                            key={i}
                            className="text-xs p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-amber-200"
                          >
                            <strong className="block font-semibold mb-0.5">
                              &gt; [!{c.type.toUpperCase()}] {c.title || "Chef's Tip"}
                            </strong>
                            <p className="text-gray-300">{c.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="bg-[#0A0A0A] p-4 rounded-xl border border-white/10 font-mono text-xs text-gray-300 whitespace-pre-wrap overflow-x-auto max-h-96">
                    {serializeRecipeToObsidianMarkdown({
                      title: editTitle,
                      cuisine: editCuisine,
                      category: editCategory,
                      difficulty: editDifficulty,
                      servings: editServings,
                      prepTime: editPrepTime,
                      cookTime: editCookTime,
                      totalTime: grabbedData.totalTime,
                      rating: grabbedData.rating,
                      source: grabbedData.source || urlInput,
                      image: grabbedData.image,
                      tags: grabbedData.tags,
                      ingredients: grabbedData.ingredients,
                      instructions: grabbedData.instructions,
                      callouts: grabbedData.callouts,
                      notes: grabbedData.notes,
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-white/5 bg-[#191919] flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white rounded-xl hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>

          {grabbedData && (
            <div className="flex items-center gap-2">
              {onOpenInEditor && (
                <button
                  type="button"
                  onClick={handleOpenEditor}
                  className="px-3.5 py-2 text-xs font-semibold bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 rounded-xl transition-colors flex items-center gap-1.5"
                >
                  <Edit3 className="w-3.5 h-3.5 text-amber-400" />
                  <span>Open in Editor</span>
                </button>
              )}

              <button
                id="save-grabbed-recipe-btn"
                type="button"
                onClick={handleSaveToVault}
                className="px-4 py-2 text-xs font-bold bg-amber-500 hover:bg-amber-400 text-black rounded-xl shadow-md shadow-amber-500/20 transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Save Note to Vault</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
