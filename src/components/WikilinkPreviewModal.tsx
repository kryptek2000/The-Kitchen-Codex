import React, { useState, useMemo } from 'react';
import {
  X,
  ExternalLink,
  BookOpen,
  Sparkles,
  Utensils,
  Tag,
  Clock,
  Flame,
  FileText,
  Plus,
  Compass,
  CheckCircle2,
  Info,
  Layers,
  Search,
} from 'lucide-react';
import { ObsidianRecipe, VaultNote } from '../types';
import { getRecipeImage } from '../utils/imageHelper';

interface WikilinkPreviewModalProps {
  target: string | null;
  alias?: string | null;
  isOpen: boolean;
  onClose: () => void;
  recipes: ObsidianRecipe[];
  notes: VaultNote[];
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
  onFilterByWikilink?: (wikilink: string) => void;
  onSaveNoteToVault?: (note: VaultNote) => Promise<boolean | void>;
}

export const WikilinkPreviewModal: React.FC<WikilinkPreviewModalProps> = ({
  target,
  alias,
  isOpen,
  onClose,
  recipes,
  notes,
  onSelectRecipe,
  onFilterByWikilink,
  onSaveNoteToVault,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'recipes' | 'raw'>('preview');
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [createdFeedback, setCreatedFeedback] = useState(false);

  // Clean target (e.g. remove path prefixes or .md extension)
  const cleanTarget = (target || '').trim().replace(/^Notes\//i, '').replace(/^Recipes\//i, '').replace(/\.md$/i, '');
  const lowerTarget = cleanTarget.toLowerCase();

  // 1. Look for matching Vault Note
  const matchedNote = notes.find((n) => {
    const noteTitle = (n.title || '').toLowerCase();
    const noteFile = n.fileName.replace(/\.md$/i, '').toLowerCase();
    return noteTitle === lowerTarget || noteFile === lowerTarget;
  });

  // 2. Look for matching Recipe
  const matchedRecipe = recipes.find((r) => {
    const recTitle = (r.title || '').toLowerCase();
    const recFile = r.fileName.replace(/\.md$/i, '').toLowerCase();
    return recTitle === lowerTarget || recFile === lowerTarget;
  });

  // 3. Find recipes referencing this target or containing the ingredient name
  const relatedRecipes = useMemo(() => {
    return recipes.filter((r) => {
      // Don't include the recipe itself if it's a match
      if (matchedRecipe && r.id === matchedRecipe.id) return false;

      // Check ingredient wikilinks
      const hasWikilink = r.ingredients.some(
        (ing) =>
          (ing.wikilink && ing.wikilink.toLowerCase().includes(lowerTarget)) ||
          (ing.wikilinkTarget && ing.wikilinkTarget.toLowerCase().includes(lowerTarget)) ||
          (ing.wikilinkAlias && ing.wikilinkAlias.toLowerCase().includes(lowerTarget)) ||
          ing.name.toLowerCase().includes(lowerTarget)
      );

      // Check raw markdown
      const hasInMarkdown = r.rawMarkdown.toLowerCase().includes(`[[${lowerTarget}`) ||
        r.rawMarkdown.toLowerCase().includes(`[[notes/${lowerTarget}`);

      return hasWikilink || hasInMarkdown;
    });
  }, [recipes, matchedRecipe, lowerTarget]);

  if (!isOpen || !target) return null;

  // Handle Quick Create Note in Vault
  const handleQuickCreateNote = async () => {
    setIsCreatingNote(true);
    const newNoteName = `${cleanTarget}.md`;
    const newNoteContent = `---
title: ${cleanTarget}
tags:
  - ingredients/pantry
  - kitchen/staple
category: Ingredient Guide
created: ${new Date().toISOString().split('T')[0]}
---

# ${cleanTarget}

> [!tip] Culinary Note
> Add your personal flavor pairings, sourcing notes, and storage recommendations for ${cleanTarget} here.

## 🥘 Culinary Uses & Pairings
- Used in ${relatedRecipes.length} recipes in your Kitchen Codex vault.
`;

    const newNote: VaultNote = {
      id: `notes-${cleanTarget.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      fileName: newNoteName,
      filePath: `Notes/${newNoteName}`,
      rawMarkdown: newNoteContent,
      title: cleanTarget,
      tags: ['ingredients/pantry', 'kitchen/staple'],
      frontmatter: {
        title: cleanTarget,
        tags: ['ingredients/pantry', 'kitchen/staple'],
        category: 'Ingredient Guide',
      },
      content: newNoteContent,
    };

    if (onSaveNoteToVault) {
      await onSaveNoteToVault(newNote);
    }
    setIsCreatingNote(false);
    setCreatedFeedback(true);
    setTimeout(() => setCreatedFeedback(false), 3000);
  };

  return (
    <div
      id="wikilink-preview-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[85vh] bg-[#141414] border border-white/15 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#171717]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
              {matchedRecipe ? (
                <Utensils className="w-4 h-4" />
              ) : matchedNote ? (
                <BookOpen className="w-4 h-4" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
            </div>
            <div className="truncate">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-amber-400 font-semibold">
                  [[{cleanTarget}]]
                </span>
                {alias && alias !== cleanTarget && (
                  <span className="text-xs text-gray-400 font-normal">
                    (alias: <span className="text-gray-200 font-medium">"{alias}"</span>)
                  </span>
                )}
              </div>
              <h2 className="text-base font-serif font-bold text-white truncate">
                {matchedNote ? matchedNote.title : matchedRecipe ? matchedRecipe.title : cleanTarget}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Filter by wikilink button */}
            {onFilterByWikilink && (
              <button
                onClick={() => {
                  onFilterByWikilink(cleanTarget);
                  onClose();
                }}
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors"
                title="Filter vault by this wikilink"
              >
                <Search className="w-3.5 h-3.5" />
                <span>Find Recipes</span>
              </button>
            )}

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 px-6 py-2 border-b border-white/5 bg-[#121212] text-xs">
          <button
            onClick={() => setActiveTab('preview')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              activeTab === 'preview'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            Intelligence Preview
          </button>
          <button
            onClick={() => setActiveTab('recipes')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all ${
              activeTab === 'recipes'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <span>Linked Recipes</span>
            <span className="px-1.5 py-0.2 rounded-full bg-white/10 text-[10px] font-mono">
              {relatedRecipes.length}
            </span>
          </button>
          {(matchedNote || matchedRecipe) && (
            <button
              onClick={() => setActiveTab('raw')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                activeTab === 'raw'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`}
            >
              Obsidian Markdown
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === 'preview' && (
            <>
              {/* CASE 1: Matched Vault Note */}
              {matchedNote && (
                <div className="space-y-4">
                  {/* Note Tags */}
                  {matchedNote.tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {matchedNote.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs font-mono px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/20 flex items-center gap-1"
                        >
                          <Tag className="w-3 h-3" />
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Frontmatter metadata chips */}
                  {matchedNote.frontmatter && Object.keys(matchedNote.frontmatter).length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3.5 rounded-xl bg-[#0F0F0F] border border-white/5 text-xs">
                      {matchedNote.frontmatter.origin && (
                        <div>
                          <span className="text-gray-500 font-mono block text-[10px] uppercase">Origin</span>
                          <span className="text-gray-200 font-medium">{matchedNote.frontmatter.origin}</span>
                        </div>
                      )}
                      {matchedNote.frontmatter.flavor_profile && (
                        <div>
                          <span className="text-gray-500 font-mono block text-[10px] uppercase">Flavor Profile</span>
                          <span className="text-gray-200 font-medium">{matchedNote.frontmatter.flavor_profile}</span>
                        </div>
                      )}
                      {matchedNote.frontmatter.aging && (
                        <div>
                          <span className="text-gray-500 font-mono block text-[10px] uppercase">Aging</span>
                          <span className="text-gray-200 font-medium">{matchedNote.frontmatter.aging}</span>
                        </div>
                      )}
                      {matchedNote.frontmatter.storage && (
                        <div>
                          <span className="text-gray-500 font-mono block text-[10px] uppercase">Storage</span>
                          <span className="text-gray-200 font-medium">{matchedNote.frontmatter.storage}</span>
                        </div>
                      )}
                      {matchedNote.frontmatter.hydration && (
                        <div>
                          <span className="text-gray-500 font-mono block text-[10px] uppercase">Hydration</span>
                          <span className="text-gray-200 font-medium">{matchedNote.frontmatter.hydration}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Note Body Content */}
                  <div className="prose prose-invert max-w-none text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                    {matchedNote.content.replace(/^#\s+.+$/m, '').trim()}
                  </div>
                </div>
              )}

              {/* CASE 2: Matched Recipe Note */}
              {matchedRecipe && !matchedNote && (
                <div className="space-y-4">
                  <div className="flex gap-4 p-4 rounded-xl bg-[#0F0F0F] border border-white/5 items-center">
                    <img
                      src={getRecipeImage(matchedRecipe)}
                      alt={matchedRecipe.title}
                      referrerPolicy="no-referrer"
                      className="w-20 h-20 rounded-lg object-cover border border-white/10 shrink-0"
                    />
                    <div className="space-y-1 min-w-0">
                      <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                        {matchedRecipe.cuisine} • {matchedRecipe.category}
                      </span>
                      <h3 className="text-base font-serif font-bold text-white truncate">
                        {matchedRecipe.title}
                      </h3>
                      <div className="flex items-center gap-3 text-xs text-gray-400">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-amber-400" />
                          {matchedRecipe.totalTime || matchedRecipe.cookTime || '25 mins'}
                        </span>
                        <span className="flex items-center gap-1">
                          <Flame className="w-3.5 h-3.5 text-amber-400" />
                          {matchedRecipe.difficulty}
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      onSelectRecipe(matchedRecipe);
                      onClose();
                    }}
                    className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-md"
                  >
                    <Utensils className="w-4 h-4" />
                    <span>Open Full Recipe in Codex</span>
                  </button>
                </div>
              )}

              {/* CASE 3: Note Not Created Yet in Vault */}
              {!matchedNote && !matchedRecipe && (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-[#171717] border border-white/10 text-center space-y-3">
                    <div className="w-12 h-12 mx-auto rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-amber-400">
                      <Compass className="w-6 h-6" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-white">Unlinked Vault Note</h4>
                      <p className="text-xs text-gray-400 mt-1">
                        No standalone note named <span className="font-mono text-amber-300">[[{cleanTarget}]]</span> currently exists in your Obsidian vault.
                      </p>
                    </div>

                    <button
                      onClick={handleQuickCreateNote}
                      disabled={isCreatingNote}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition-colors shadow-sm disabled:opacity-50"
                    >
                      <Plus className="w-4 h-4" />
                      <span>{isCreatingNote ? 'Creating Note...' : `Create [[${cleanTarget}]] Note in Vault`}</span>
                    </button>

                    {createdFeedback && (
                      <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-400 font-medium animate-in fade-in">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Created {cleanTarget}.md in your vault!</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Connected Recipes Section */}
              {relatedRecipes.length > 0 && (
                <div className="pt-4 border-t border-white/10 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-serif font-bold text-white flex items-center gap-1.5">
                      <Utensils className="w-3.5 h-3.5 text-amber-400" />
                      <span>Vault Recipes Using [[{cleanTarget}]] ({relatedRecipes.length})</span>
                    </h4>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {relatedRecipes.map((rec) => (
                      <div
                        key={rec.id}
                        onClick={() => {
                          onSelectRecipe(rec);
                          onClose();
                        }}
                        className="flex items-center gap-2.5 p-2.5 rounded-xl bg-[#171717] hover:bg-[#1C1C1C] border border-white/5 hover:border-amber-500/30 cursor-pointer transition-all group"
                      >
                        <img
                          src={getRecipeImage(rec)}
                          alt={rec.title}
                          referrerPolicy="no-referrer"
                          className="w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <span className="text-[10px] text-amber-400/80 font-mono block truncate">
                            {rec.cuisine}
                          </span>
                          <h5 className="text-xs font-medium text-white group-hover:text-amber-300 transition-colors truncate">
                            {rec.title}
                          </h5>
                          <span className="text-[10px] text-gray-500">
                            {rec.cookTime || rec.totalTime || '20 mins'}
                          </span>
                        </div>
                        <ExternalLink className="w-3.5 h-3.5 text-gray-500 group-hover:text-amber-400 shrink-0 transition-colors" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === 'recipes' && (
            <div className="space-y-3">
              {relatedRecipes.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-xs">
                  No recipes in your vault currently mention [[{cleanTarget}]].
                </div>
              ) : (
                <div className="space-y-2">
                  {relatedRecipes.map((rec) => (
                    <div
                      key={rec.id}
                      onClick={() => {
                        onSelectRecipe(rec);
                        onClose();
                      }}
                      className="flex items-center justify-between p-3 rounded-xl bg-[#171717] hover:bg-[#1F1F1F] border border-white/5 hover:border-amber-500/30 cursor-pointer transition-all group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <img
                          src={getRecipeImage(rec)}
                          alt={rec.title}
                          referrerPolicy="no-referrer"
                          className="w-14 h-14 rounded-lg object-cover border border-white/10 shrink-0"
                        />
                        <div className="min-w-0">
                          <h4 className="text-xs sm:text-sm font-semibold text-white group-hover:text-amber-300 truncate">
                            {rec.title}
                          </h4>
                          <p className="text-[11px] text-gray-400 mt-0.5">
                            {rec.cuisine} • {rec.category} • {rec.servings ? `${rec.servings} servings` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs text-amber-400 font-medium hidden sm:inline">View Recipe</span>
                        <ExternalLink className="w-4 h-4 text-gray-400 group-hover:text-amber-400" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'raw' && (
            <div>
              <pre className="p-4 rounded-xl bg-[#0C0C0C] border border-white/5 text-[11px] font-mono text-amber-200/90 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                {matchedNote ? matchedNote.rawMarkdown : matchedRecipe ? matchedRecipe.rawMarkdown : ''}
              </pre>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-white/10 bg-[#171717] flex items-center justify-between text-xs text-gray-400">
          <span className="font-mono text-[11px]">
            {matchedNote
              ? `Vault Path: ${matchedNote.filePath}`
              : matchedRecipe
              ? `Recipe File: ${matchedRecipe.fileName}`
              : 'Obsidian Wikilink Intelligence'}
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-200 font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
