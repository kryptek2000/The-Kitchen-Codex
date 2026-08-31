import React, { useState, useRef } from 'react';
import { 
  X, Download, Printer, Copy, Check, Sparkles, 
  Clock, Users, Flame, ChefHat, FileText, Utensils 
} from 'lucide-react';
import { ObsidianRecipe } from '../types';
import { scaleIngredientText } from '../utils/markdownParser';
import { nutritionForServings, roundNutritionForDisplay, resolveNutritionBase } from '../utils/nutrition';
import { downloadMarkdownFile } from '../utils/vaultFileSystem';
import { getRecipeImage, DEFAULT_FOOD_IMAGES } from '../utils/imageHelper';
import { useVaultImage } from '../hooks/useVaultImage';
import { normalizeCardColors } from '../utils/cardExportColors';
import html2canvas from 'html2canvas';

interface RecipeCardExportModalProps {
  recipe: ObsidianRecipe;
  currentServings: number;
  onClose: () => void;
}

type CardTheme = 'classic' | 'modern' | 'obsidian' | 'kraft';

export function RecipeCardExportModal({ recipe, currentServings: initialServings, onClose }: RecipeCardExportModalProps) {
  const [servings, setServings] = useState<number>(initialServings || recipe.servings || 4);
  const [theme, setTheme] = useState<CardTheme>('classic');
  const [includeNutrition, setIncludeNutrition] = useState<boolean>(true);
  const [includeNotes, setIncludeNotes] = useState<boolean>(true);
  const [includeImage, setIncludeImage] = useState<boolean>(true);
  const [imageError, setImageError] = useState<boolean>(false);
  const [isExportingImage, setIsExportingImage] = useState<boolean>(false);
  const [copiedText, setCopiedText] = useState<boolean>(false);
  const [copiedHtml, setCopiedHtml] = useState<boolean>(false);

  const cardRef = useRef<HTMLDivElement>(null);

  const baseServings = recipe.servings || 4;
  // Nutrition displayed on the card is scaled deterministically to the selected
  // servings, matching the recipe-total / baseServings × requested contract.
  const cardNutrition = roundNutritionForDisplay(
    nutritionForServings(recipe.nutrition, resolveNutritionBase(recipe.nutrition), servings)
  );
  const defaultImg = getRecipeImage(recipe);
  const reactiveVaultImage = useVaultImage(recipe.image, defaultImg);
  const imageUrl = imageError ? DEFAULT_FOOD_IMAGES.default : (reactiveVaultImage || defaultImg);

  // Independent description mapping (never fallback to Chef's Notes)
  const recipeDescription = recipe.dataviewFields?.description || recipe.dataviewFields?.summary || (recipe as any).description || (recipe as any).summary || '';

  // Food Display detection (Strictly actual dataview fields, no fabrication)
  const foodDisplayText = recipe.dataviewFields?.foodDisplay || recipe.dataviewFields?.presentation;
  const hasFoodDisplay = Boolean(foodDisplayText);

  const categoryLabel = recipe.category || recipe.cuisine || 'Recipe';

  // Recipe-aware serving advice for left footer
  const getServingAdvice = () => {
    const titleLower = recipe.title.toLowerCase();
    const catLower = categoryLabel.toLowerCase();
    const notesLower = (recipe.notes || '').toLowerCase();
    
    if (notesLower.includes('cool') || notesLower.includes('slice') || catLower.includes('bread') || catLower.includes('baking') || titleLower.includes('bread') || titleLower.includes('sourdough')) {
      return 'Allow to cool before slicing. Enjoy fresh or toasted.';
    }
    if (catLower.includes('soup') || catLower.includes('curry') || catLower.includes('stew') || catLower.includes('noodles')) {
      return 'Serve warm and enjoy immediately.';
    }
    if (catLower.includes('salad') || catLower.includes('dessert') || catLower.includes('cake')) {
      return 'Serve chilled or at room temperature.';
    }
    return 'Enjoy prepared fresh to taste.';
  };

  // Helper to render markdown formatting in instruction text (bold, italic, code)
  const renderMarkdownText = (text: string) => {
    if (!text) return null;
    const parts: React.ReactNode[] = [];
    const regex = /(\*\*.*?\*\*|\*.*?\*|__.*?__|_[^_]+_|`.*?`)/g;
    const tokens = text.split(regex);

    tokens.forEach((token, index) => {
      if (!token) return;
      if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
        parts.push(<strong key={index} className="font-bold">{token.slice(2, -2)}</strong>);
      } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
        parts.push(<em key={index} className="italic">{token.slice(1, -1)}</em>);
      } else if (token.startsWith('`') && token.endsWith('`')) {
        parts.push(<code key={index} className="font-mono bg-black/10 px-1 rounded">{token.slice(1, -1)}</code>);
      } else {
        parts.push(<span key={index}>{token}</span>);
      }
    });

    return <>{parts}</>;
  };

  const handleDownloadImage = async () => {
    if (!cardRef.current) return;
    try {
      setIsExportingImage(true);
      const canvas = await html2canvas(cardRef.current, {
        scale: 3.5,
        useCORS: true,
        allowTaint: true,
        backgroundColor: null,
        logging: false,
        onclone: (clonedDoc) => {
          // Keep stylesheets intact so the Tailwind v4 layout & typography are
          // preserved. html2canvas 1.4.1 cannot parse the modern colour
          // functions (oklch/oklab/color-mix) Tailwind v4 emits, so resolve
          // only those to sRGB inline styles before capture.
          normalizeCardColors(clonedDoc);
        },
      });
      const image = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = image;
      a.download = `${recipe.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_recipe_card.png`;
      a.click();
    } catch (err) {
      console.error('Failed to generate recipe card image:', err);
    } finally {
      setIsExportingImage(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleCopyText = () => {
    const textLines = [
      recipe.title,
      recipe.source ? `Source: ${recipe.source}` : '',
      `Cuisine: ${recipe.cuisine || 'General'} | Category: ${recipe.category || 'Recipe'} | Servings: ${servings}`,
      recipe.prepTime ? `Prep: ${recipe.prepTime} | Cook: ${recipe.cookTime || 'N/A'}` : '',
      '',
      '### Ingredients',
      ...(recipe.ingredients || []).map(ing => `- ${ing.original || (ing.name ? `${ing.amount || ''} ${ing.unit || ''} ${ing.name}` : '')}`),
      '',
      '### Instructions',
      ...(recipe.instructions || []).map((step, idx) => `${idx + 1}. ${step.text}`),
      recipe.notes && includeNotes ? `\n### Notes\n${recipe.notes}` : ''
    ].filter(Boolean).join('\n');

    navigator.clipboard.writeText(textLines);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  const handleCopyHtml = () => {
    if (!cardRef.current) return;
    const htmlContent = cardRef.current.innerHTML;
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const clipboardItem = new ClipboardItem({ 'text/html': blob, 'text/plain': new Blob([cardRef.current.innerText], { type: 'text/plain' }) });
    navigator.clipboard.write([clipboardItem]).then(() => {
      setCopiedHtml(true);
      setTimeout(() => setCopiedHtml(false), 2000);
    }).catch(() => {
      navigator.clipboard.writeText(cardRef.current?.innerHTML || '');
      setCopiedHtml(true);
      setTimeout(() => setCopiedHtml(false), 2000);
    });
  };

  const themeConfigs = {
    classic: {
      bg: '#FFFDF9',
      color: '#2C2621',
      border: '#E6DEC9',
      accent: '#92400E',
      badgeBg: 'rgba(217, 119, 6, 0.1)',
      badgeBorder: 'rgba(217, 119, 6, 0.25)',
      boxBg: 'rgba(0, 0, 0, 0.03)',
      boxBorder: 'rgba(0, 0, 0, 0.08)',
      stepBg: 'rgba(217, 119, 6, 0.15)',
      bullet: '#D97706'
    },
    modern: {
      bg: '#FFFFFF',
      color: '#0F172A',
      border: '#E2E8F0',
      accent: '#4F46E5',
      badgeBg: 'rgba(79, 70, 229, 0.08)',
      badgeBorder: 'rgba(79, 70, 229, 0.25)',
      boxBg: 'rgba(0, 0, 0, 0.02)',
      boxBorder: 'rgba(0, 0, 0, 0.06)',
      stepBg: 'rgba(79, 70, 229, 0.12)',
      bullet: '#4F46E5'
    },
    obsidian: {
      bg: '#18181B',
      color: '#F4F4F5',
      border: 'rgba(255, 255, 255, 0.15)',
      accent: '#FBBF24',
      badgeBg: 'rgba(251, 191, 36, 0.12)',
      badgeBorder: 'rgba(251, 191, 36, 0.3)',
      boxBg: 'rgba(255, 255, 255, 0.04)',
      boxBorder: 'rgba(255, 255, 255, 0.08)',
      stepBg: 'rgba(251, 191, 36, 0.2)',
      bullet: '#FBBF24'
    },
    kraft: {
      bg: '#F4ECE1',
      color: '#3D3226',
      border: '#D9C8B2',
      accent: '#78350F',
      badgeBg: 'rgba(120, 53, 15, 0.1)',
      badgeBorder: 'rgba(120, 53, 15, 0.25)',
      boxBg: 'rgba(0, 0, 0, 0.03)',
      boxBorder: 'rgba(0, 0, 0, 0.08)',
      stepBg: 'rgba(120, 53, 15, 0.15)',
      bullet: '#92400E'
    }
  };

  const currentThemeConfig = themeConfigs[theme];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-6 overflow-y-auto">
      <style>{`
        @media print {
          body {
            background: white !important;
            color: black !important;
          }
          .fixed, header, nav, button, .modal-controls-bar, .modal-header, .modal-footer {
            display: none !important;
          }
          .overflow-y-auto {
            overflow: visible !important;
            max-height: none !important;
            padding: 0 !important;
          }
          .recipe-card-print-container {
            box-shadow: none !important;
            border: none !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          li, h3, h4, .break-inside-avoid {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
        }
      `}</style>
      <div className="relative w-full max-w-4xl bg-[#121214] border border-white/15 rounded-3xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">
        
        {/* Modal Header */}
        <div className="modal-header flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#18181B]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/30">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-serif font-bold text-white">Recipe Card & Export Studio</h2>
              <p className="text-xs text-gray-400">Design a stunning printable card matching culinary publications</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Studio Controls Bar */}
        <div className="modal-controls-bar flex flex-wrap items-center justify-between gap-4 px-6 py-3 bg-[#1A1A1E] border-b border-white/10 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            {/* Theme Selector */}
            <div className="flex items-center gap-1.5 bg-black/30 p-1 rounded-xl border border-white/10">
              <span className="text-gray-400 font-medium px-2">Theme:</span>
              {(['classic', 'modern', 'obsidian', 'kraft'] as CardTheme[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`px-2.5 py-1 rounded-lg font-medium capitalize transition-all ${
                    theme === t 
                      ? 'bg-amber-500 text-black shadow-sm font-bold' 
                      : 'text-gray-300 hover:text-white hover:bg-white/5'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Servings Adjuster */}
            <div className="flex items-center gap-2 bg-black/30 px-3 py-1 rounded-xl border border-white/10 text-gray-300">
              <Users className="w-3.5 h-3.5 text-amber-400" />
              <span>Servings:</span>
              <button 
                onClick={() => setServings(Math.max(1, servings - 1))}
                className="w-5 h-5 rounded bg-white/10 hover:bg-white/20 text-white font-bold flex items-center justify-center"
              >
                -
              </button>
              <span className="font-bold text-white w-4 text-center">{servings}</span>
              <button 
                onClick={() => setServings(servings + 1)}
                className="w-5 h-5 rounded bg-white/10 hover:bg-white/20 text-white font-bold flex items-center justify-center"
              >
                +
              </button>
            </div>
          </div>

          {/* Quick Toggles */}
          <div className="flex items-center gap-3 text-gray-300">
            <label className="flex items-center gap-1.5 cursor-pointer hover:text-white">
              <input 
                type="checkbox" 
                checked={includeImage} 
                onChange={(e) => setIncludeImage(e.target.checked)}
                className="rounded bg-black/40 border-white/20 text-amber-500 focus:ring-0"
              />
              <span>Photo</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer hover:text-white">
              <input 
                type="checkbox" 
                checked={includeNutrition} 
                onChange={(e) => setIncludeNutrition(e.target.checked)}
                className="rounded bg-black/40 border-white/20 text-amber-500 focus:ring-0"
              />
              <span>Nutrition</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer hover:text-white">
              <input 
                type="checkbox" 
                checked={includeNotes} 
                onChange={(e) => setIncludeNotes(e.target.checked)}
                className="rounded bg-black/40 border-white/20 text-amber-500 focus:ring-0"
              />
              <span>Notes</span>
            </label>
          </div>
        </div>

        {/* Scrollable Preview Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-8 bg-[#0B0B0E] flex items-center justify-center">
          <div className="w-full max-w-3xl recipe-card-print-container">
            
            {/* The Actual Rendered Recipe Card matching reference layout */}
            <div 
              ref={cardRef}
              style={{
                backgroundColor: currentThemeConfig.bg,
                color: currentThemeConfig.color,
                borderColor: currentThemeConfig.border,
              }}
              className="p-8 sm:p-10 rounded-2xl border-[1.5px] shadow-2xl transition-all duration-300 break-inside-auto"
            >
              
              {/* TOP HEADER SECTION (Grid: Left Title/Meta, Right Photo) */}
              <div style={{ borderColor: currentThemeConfig.border }} className="grid grid-cols-1 md:grid-cols-12 gap-6 pb-6 border-b break-inside-avoid">
                
                {/* Left Side: Category, Title, Description, Stats */}
                <div className={`flex flex-col justify-between ${includeImage && imageUrl ? 'md:col-span-7' : 'md:col-span-12'}`}>
                  <div>
                    {/* Cuisine & Category Badge */}
                    <div className="text-xs font-serif font-bold tracking-wide uppercase mb-3 opacity-80" style={{ color: currentThemeConfig.accent }}>
                      {recipe.cuisine || 'Global'} • {recipe.category || 'Recipe'}
                    </div>

                    {/* Recipe Title */}
                    <h1 className="text-3xl sm:text-4xl font-serif font-bold tracking-tight mb-3 leading-tight break-words">
                      {recipe.title}
                    </h1>

                    {/* Small Divider Icon */}
                    <div className="flex items-center gap-3 my-3">
                      <div className="h-px flex-1 opacity-25" style={{ backgroundColor: currentThemeConfig.color }} />
                      <ChefHat className="w-4 h-4 opacity-75" style={{ color: currentThemeConfig.accent }} />
                      <div className="h-px flex-1 opacity-25" style={{ backgroundColor: currentThemeConfig.color }} />
                    </div>

                    {/* Short Description / Summary (Mapped independently from Chef's Notes) */}
                    {recipeDescription && (
                      <p className="text-xs sm:text-sm opacity-85 leading-relaxed mb-4 break-words">
                        {recipeDescription}
                      </p>
                    )}
                  </div>

                  {/* Prep Time / Cook Time / Servings Metrics Bar */}
                  <div 
                    style={{ 
                      backgroundColor: currentThemeConfig.boxBg, 
                      borderColor: currentThemeConfig.boxBorder 
                    }} 
                    className="grid grid-cols-3 gap-2 p-3 rounded-xl border text-center mt-2"
                  >
                    <div className="flex flex-col items-center justify-center">
                      <Clock className="w-4 h-4 mb-1 opacity-75" style={{ color: currentThemeConfig.accent }} />
                      <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">Prep Time</span>
                      <span className="text-xs sm:text-sm font-serif font-bold mt-0.5">{recipe.prepTime || '15 mins'}</span>
                    </div>

                    <div className="flex flex-col items-center justify-center border-x" style={{ borderColor: currentThemeConfig.boxBorder }}>
                      <Flame className="w-4 h-4 mb-1 opacity-75" style={{ color: currentThemeConfig.accent }} />
                      <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">Cook Time</span>
                      <span className="text-xs sm:text-sm font-serif font-bold mt-0.5">{recipe.cookTime || '30 mins'}</span>
                    </div>

                    <div className="flex flex-col items-center justify-center">
                      <Users className="w-4 h-4 mb-1 opacity-75" style={{ color: currentThemeConfig.accent }} />
                      <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">Servings</span>
                      <span className="text-xs sm:text-sm font-serif font-bold mt-0.5">{servings}</span>
                    </div>
                  </div>
                </div>

                {/* Right Side: Food Display Photo */}
                {includeImage && imageUrl && (
                  <div className="md:col-span-5 flex items-center">
                    <div 
                      style={{ borderColor: currentThemeConfig.border }}
                      className="w-full aspect-[4/3] md:aspect-[4/3] rounded-xl overflow-hidden border shadow-md bg-black/5 relative"
                    >
                      <img
                        src={imageUrl}
                        alt={recipe.title}
                        crossOrigin="anonymous"
                        referrerPolicy="no-referrer"
                        onError={() => setImageError(true)}
                        className="w-full h-full object-cover object-center"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Nutrition Bar if enabled */}
              {includeNutrition && recipe.nutrition && (
                <div 
                  style={{
                    backgroundColor: currentThemeConfig.boxBg,
                    borderColor: currentThemeConfig.boxBorder
                  }}
                  className="my-5 p-3 rounded-xl border flex items-center justify-around text-xs font-medium break-inside-avoid"
                >
                  <div className="text-center">
                    <span className="block text-[10px] uppercase opacity-70">Calories</span>
                    <span className="font-bold">{cardNutrition.calories ?? recipe.calories ?? '—'} kcal</span>
                  </div>
                  <div className="w-px h-6 bg-current opacity-20" />
                  <div className="text-center">
                    <span className="block text-[10px] uppercase opacity-70">Protein</span>
                    <span className="font-bold">{cardNutrition.protein ? `${cardNutrition.protein}g` : '—'}</span>
                  </div>
                  <div className="w-px h-6 bg-current opacity-20" />
                  <div className="text-center">
                    <span className="block text-[10px] uppercase opacity-70">Carbs</span>
                    <span className="font-bold">{cardNutrition.carbohydrates ? `${cardNutrition.carbohydrates}g` : '—'}</span>
                  </div>
                  <div className="w-px h-6 bg-current opacity-20" />
                  <div className="text-center">
                    <span className="block text-[10px] uppercase opacity-70">Fat</span>
                    <span className="font-bold">{cardNutrition.fat ? `${cardNutrition.fat}g` : '—'}</span>
                  </div>
                </div>
              )}

              {/* MIDDLE SECTION: TWO COLUMNS (Ingredients & Instructions) */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-8 mt-6">
                
                {/* Left Column: Ingredients & Notes */}
                <div className="md:col-span-5 space-y-6">
                  
                  {/* Ingredients Header */}
                  <div className="break-inside-avoid">
                    <div style={{ borderColor: currentThemeConfig.border }} className="flex items-center justify-between border-b pb-2 mb-3">
                      <h3 className="font-serif font-bold text-sm tracking-wider uppercase flex items-center gap-2">
                        <ChefHat className="w-4 h-4" style={{ color: currentThemeConfig.accent }} />
                        Ingredients
                      </h3>
                    </div>

                    {/* Ingredients List */}
                    <ul className="space-y-2 text-xs leading-relaxed">
                      {(recipe.ingredients || []).map((ing, idx) => {
                        const scaledText = scaleIngredientText(ing.original, baseServings, servings);
                        return (
                          <li key={idx} className="flex items-start gap-2 break-inside-avoid">
                            <span 
                              style={{ backgroundColor: currentThemeConfig.bullet }}
                              className="inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" 
                            />
                            <span className="opacity-95 break-words">{scaledText}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  {/* Chef's Notes Box (Rendered ONLY here) */}
                  {includeNotes && recipe.notes && (
                    <div 
                      style={{ 
                        backgroundColor: currentThemeConfig.boxBg, 
                        borderColor: currentThemeConfig.boxBorder 
                      }} 
                      className="p-4 rounded-xl border text-xs space-y-2 break-inside-avoid"
                    >
                      <h4 className="font-serif font-bold uppercase tracking-wider text-[11px]" style={{ color: currentThemeConfig.accent }}>
                        Chef's Notes
                      </h4>
                      <p className="opacity-85 italic leading-relaxed whitespace-pre-line break-words">
                        {recipe.notes}
                      </p>
                    </div>
                  )}
                </div>

                {/* Right Column: Instructions */}
                <div className="md:col-span-7 space-y-4">
                  <div style={{ borderColor: currentThemeConfig.border }} className="border-b pb-2 mb-3 break-inside-avoid">
                    <h3 className="font-serif font-bold text-sm tracking-wider uppercase">
                      Instructions
                    </h3>
                  </div>

                  <ol className="space-y-4 text-xs leading-relaxed">
                    {(recipe.instructions || []).map((step, idx) => (
                      <li key={idx} className="flex items-start gap-3 break-inside-avoid">
                        <span 
                          style={{
                            backgroundColor: currentThemeConfig.stepBg,
                            color: currentThemeConfig.accent,
                            borderColor: currentThemeConfig.border
                          }}
                          className="w-5 h-5 rounded-full font-serif font-bold text-xs flex items-center justify-center shrink-0 border shadow-sm"
                        >
                          {idx + 1}
                        </span>
                        <div className="opacity-95 pt-0.5 break-words">{renderMarkdownText(step.text)}</div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              {/* CARD BOTTOM FOOTER CALLOUT BOXES */}
              <div className={`grid grid-cols-1 ${hasFoodDisplay ? 'sm:grid-cols-2' : 'sm:grid-cols-1'} gap-4 mt-8 pt-6 border-t break-inside-avoid`} style={{ borderColor: currentThemeConfig.border }}>
                
                {/* Left Footer Callout */}
                <div 
                  style={{ 
                    backgroundColor: currentThemeConfig.boxBg, 
                    borderColor: currentThemeConfig.boxBorder 
                  }} 
                  className="p-4 rounded-xl border flex items-center gap-3"
                >
                  <div className="p-2 rounded-lg bg-amber-500/10 text-amber-600 flex items-center justify-center">
                    <Utensils className="w-5 h-5" style={{ color: currentThemeConfig.accent }} />
                  </div>
                  <div>
                    <h5 className="font-serif font-bold text-xs italic" style={{ color: currentThemeConfig.accent }}>
                      Enjoy your {categoryLabel.toLowerCase()}!
                    </h5>
                    <p className="text-[11px] opacity-75 mt-0.5">{getServingAdvice()}</p>
                  </div>
                </div>

                {/* Right Food Display Callout (Rendered ONLY when actual food display / presentation info exists) */}
                {hasFoodDisplay && (
                  <div 
                    style={{ 
                      backgroundColor: currentThemeConfig.boxBg, 
                      borderColor: currentThemeConfig.boxBorder 
                    }} 
                    className="p-4 rounded-xl border space-y-1"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase" style={{ color: currentThemeConfig.accent }}>
                      <span>⭐</span>
                      <span>Food Display</span>
                    </div>
                    <p className="text-[11px] opacity-80 leading-relaxed">
                      {foodDisplayText}
                    </p>
                  </div>
                )}

              </div>

            </div>

          </div>
        </div>

        {/* Modal Footer Actions */}
        <div className="modal-footer px-6 py-4 bg-[#18181B] border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-gray-400 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>Ready for printing, blogging, or Obsidian vault sharing</span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Copy Text */}
            <button
              onClick={handleCopyText}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 text-xs font-medium transition-colors"
            >
              {copiedText ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              <span>{copiedText ? 'Copied Text!' : 'Copy Text'}</span>
            </button>

            {/* Copy HTML */}
            <button
              onClick={handleCopyHtml}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 text-xs font-medium transition-colors"
            >
              {copiedHtml ? <Check className="w-4 h-4 text-emerald-400" /> : <FileText className="w-4 h-4" />}
              <span>{copiedHtml ? 'Copied Rich Card!' : 'Copy Rich Card'}</span>
            </button>

            {/* Print */}
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 text-xs font-medium transition-colors"
            >
              <Printer className="w-4 h-4 text-amber-400" />
              <span>Print</span>
            </button>

            {/* Download Markdown */}
            <button
              onClick={() => downloadMarkdownFile(recipe.fileName, recipe.rawMarkdown)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 text-xs font-medium transition-colors"
            >
              <Download className="w-4 h-4" />
              <span>Download .md</span>
            </button>

            {/* Download PNG Image */}
            <button
              onClick={handleDownloadImage}
              disabled={isExportingImage}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold shadow-md transition-colors disabled:opacity-50"
            >
              <Download className="w-4 h-4 fill-current" />
              <span>{isExportingImage ? 'Rendering PNG...' : 'Download Image (PNG)'}</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

