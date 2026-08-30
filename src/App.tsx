import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  ObsidianRecipe,
  VaultSyncStatus,
  FilterState,
  ActiveTimer,
  MealPlanDay,
  MealPlanSlot,
  ShoppingCategoryGroup,
  ThemeId,
  VaultNote,
  RecipeNutrition,
} from './types';
import { DEFAULT_VAULT_PATH, getStarterVaultRecipes, getStarterVaultNotes, STARTER_MEAL_PLAN, STARTER_SHOPPING_CATEGORIES } from './data/starterVault';
import { getRecipeImage } from './utils/imageHelper';
import { cleanRecipeTitle, parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from './utils/markdownParser';
import {
  pickVaultDirectory,
  saveRecipeToVaultFile,
  deleteRecipeFromVault,
  saveMealPlanToVault,
  saveShoppingListToVault,
  parseUploadedFileList,
  parseDroppedFilesAndFolders,
  scanVaultDirectory,
  getDirectoryHandleFromIDB,
  clearDirectoryHandleFromIDB,
  isFileSystemAccessSupported,
} from './utils/vaultFileSystem';
import { playTimerChime } from './utils/audioAlert';

import { VaultHeader } from './components/VaultHeader';
import { RecipeFilterBar } from './components/RecipeFilterBar';
import { RecipeCard } from './components/RecipeCard';
import { RecipeDetailView } from './components/RecipeDetailView';
import { DataviewTableView } from './components/DataviewTableView';
import { MealPlannerView } from './components/MealPlannerView';
import { ShoppingListView } from './components/ShoppingListView';
import { ThemesView } from './components/ThemesView';
import { ActiveTimersBar } from './components/ActiveTimersBar';
import { ConnectVaultModal } from './components/ConnectVaultModal';
import { RecipeGrabberModal } from './components/RecipeGrabberModal';
import { VaultIntelligenceModal } from './components/VaultIntelligenceModal';
import { summarizeVaultHealth } from './utils/vaultIntelligence';

// Cooking Mode and the Recipe Editor are modal-heavy views only opened on
// demand. Lazy-load them so their code ships in separate chunks and is fetched
// when the user actually enters cooking mode or edits a recipe.
const CookingModeModal = React.lazy(() =>
  import('./components/CookingModeModal').then((m) => ({ default: m.CookingModeModal }))
);
const RecipeEditorModal = React.lazy(() =>
  import('./components/RecipeEditorModal').then((m) => ({ default: m.RecipeEditorModal }))
);

const INITIAL_FILTERS: FilterState = {
  search: '',
  tag: null,
  category: null,
  cuisine: null,
  difficulty: null,
  maxCookTime: null,
  minRating: null,
  ingredientSearch: '',
  onlyFavorites: false,
  sortBy: 'title',
  sortOrder: 'asc',
};

export default function App() {
  // 1. Vault Recipes State (Canonical Source: In-Memory working state hydrated from Obsidian vault files)
  const [recipes, setRecipes] = useState<ObsidianRecipe[]>(() => {
    return getStarterVaultRecipes();
  });

  // Vault Notes State (Non-recipe notes in the Obsidian vault, like ingredients, techniques, wine guides)
  const [notes, setNotes] = useState<VaultNote[]>(() => {
    return [];
  });

  // Vault Sync Status
  const [vaultStatus, setVaultStatus] = useState<VaultSyncStatus>({
    isConnected: false,
    vaultPath: DEFAULT_VAULT_PATH,
    fileCount: 8,
    accessType: 'starter_vault',
  });

  // Theme State (LocalStorage for UI Preference)
  const [theme, setTheme] = useState<ThemeId>(() => {
    try {
      const saved = localStorage.getItem('obsidian_vault_theme') as ThemeId;
      if (saved === 'obsidian' || saved === 'parchment' || saved === 'nordic') return saved;
    } catch (e) {}
    return 'obsidian';
  });

  // Navigation & View State (LocalStorage for Ephemeral UI State)
  const [activeTab, setActiveTab] = useState<'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes'>(() => {
    try {
      const saved = localStorage.getItem('obsidian_active_tab') as any;
      if (['grid', 'dataview', 'mealplan', 'shopping', 'themes'].includes(saved)) return saved;
    } catch (e) {}
    return 'grid';
  });

  const [selectedRecipe, setSelectedRecipe] = useState<ObsidianRecipe | null>(null);
  const [cookingRecipe, setCookingRecipe] = useState<{ recipe: ObsidianRecipe; servings: number } | null>(null);

  // Modals
  const [isConnectVaultOpen, setIsConnectVaultOpen] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isGrabberOpen, setIsGrabberOpen] = useState(false);
  const [isVaultIntelligenceOpen, setIsVaultIntelligenceOpen] = useState(false);
  const [vaultIntelligenceRecipeId, setVaultIntelligenceRecipeId] = useState<string | null>(null);
  const [editingRecipe, setEditingRecipe] = useState<ObsidianRecipe | null>(null);
  const [isWindowDragging, setIsWindowDragging] = useState(false);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);

  // Active Timers (LocalStorage for active cooking timer timestamps)
  const [activeTimers, setActiveTimers] = useState<ActiveTimer[]>(() => {
    try {
      const saved = localStorage.getItem('obsidian_active_cooking_timers');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return [];
  });

  // Meal Plan & Shopping List (Canonical Source: Vault Notes `Meal Plan.md` & `Shopping List.md`)
  const [mealPlan, setMealPlan] = useState<MealPlanDay[]>(STARTER_MEAL_PLAN);
  const [shoppingCategories, setShoppingCategories] = useState<ShoppingCategoryGroup[]>(STARTER_SHOPPING_CATEGORIES);

  // 1. Reconnect to IndexedDB directory handle on mount if permission granted
  useEffect(() => {
    let isMounted = true;
    async function restoreVaultConnection() {
      try {
        const handle = await getDirectoryHandleFromIDB();
        if (handle && typeof handle.queryPermission === 'function') {
          const status = await handle.queryPermission({ mode: 'readwrite' });
          if (status === 'granted') {
            const scan = await scanVaultDirectory(handle);
            if (isMounted) {
              if (scan.recipes.length > 0) setRecipes(scan.recipes);
              if (scan.notes.length > 0) setNotes(scan.notes);
              if (scan.mealPlan) setMealPlan(scan.mealPlan);
              if (scan.shoppingList) setShoppingCategories(scan.shoppingList);

              setVaultStatus({
                isConnected: true,
                vaultPath: scan.folderName ? `Vault / ${scan.folderName}` : 'Obsidian Vault',
                fileCount: scan.recipes.length + scan.notes.length,
                accessType: 'filesystem_api',
                folderHandle: handle,
              });
            }
          }
        }
      } catch (err) {
        console.warn('Auto-reconnect vault check:', err);
      }
    }
    restoreVaultConnection();
    return () => {
      isMounted = false;
    };
  }, []);

  // 2. Background Re-Sync on Window Focus: Live updates from Obsidian desktop
  useEffect(() => {
    const handleWindowFocus = async () => {
      if (vaultStatus.isConnected && vaultStatus.folderHandle && vaultStatus.accessType === 'filesystem_api') {
        try {
          const scan = await scanVaultDirectory(vaultStatus.folderHandle);
          if (scan.recipes.length > 0) {
            setRecipes(scan.recipes);
          }
          if (scan.notes.length > 0) {
            setNotes(scan.notes);
          }
          setVaultStatus((prev) => ({ ...prev, fileCount: scan.recipes.length + scan.notes.length }));
          if (scan.mealPlan) setMealPlan(scan.mealPlan);
          if (scan.shoppingList) setShoppingCategories(scan.shoppingList);
        } catch (err) {
          console.warn('Background vault scan on focus failed:', err);
        }
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [vaultStatus]);

  // 3. UI Preferences to LocalStorage
  useEffect(() => {
    try {
      localStorage.setItem('obsidian_vault_theme', theme);
      document.documentElement.setAttribute('data-theme', theme);
    } catch (e) {}
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem('obsidian_active_tab', activeTab);
    } catch (e) {}
  }, [activeTab]);

  useEffect(() => {
    try {
      localStorage.setItem('obsidian_active_cooking_timers', JSON.stringify(activeTimers));
    } catch (e) {}
  }, [activeTimers]);

  // 4. Auto-save Meal Plan note directly to disk in the Obsidian vault if connected
  useEffect(() => {
    if (vaultStatus.isConnected && vaultStatus.folderHandle) {
      saveMealPlanToVault(mealPlan, vaultStatus.folderHandle).catch((e) =>
        console.warn('Auto-saving Meal Plan.md to vault failed:', e)
      );
    }
  }, [mealPlan, vaultStatus]);

  // 5. Auto-save Shopping List note directly to disk in the Obsidian vault if connected
  useEffect(() => {
    if (vaultStatus.isConnected && vaultStatus.folderHandle) {
      saveShoppingListToVault(shoppingCategories, vaultStatus.folderHandle).catch((e) =>
        console.warn('Auto-saving Shopping List.md to vault failed:', e)
      );
    }
  }, [shoppingCategories, vaultStatus]);

  // Timers Background Interval Engine
  useEffect(() => {
    const timerInterval = setInterval(() => {
      setActiveTimers((prevTimers) => {
        if (prevTimers.length === 0) return prevTimers;

        // Track every timer that reaches zero in this tick so each gets its
        // own completion notification (previously a single batch-wide flag
        // meant multiple simultaneous timers fired only one chime).
        let completedCount = 0;
        const updated = prevTimers.map((t) => {
          if (!t.isRunning || t.remainingSeconds <= 0) return t;
          const nextSec = t.remainingSeconds - 1;
          if (nextSec === 0) {
            completedCount += 1;
          }
          return { ...t, remainingSeconds: nextSec };
        });

        // A timer already at <= 0 is left unchanged on later ticks, so it will
        // never double-fire — we only chime for timers completed this tick.
        for (let i = 0; i < completedCount; i += 1) {
          playTimerChime();
        }

        return updated;
      });
    }, 1000);

    return () => clearInterval(timerInterval);
  }, []);

  // Connect local folder via File System Access API
  const handleConnectVault = async () => {
    try {
      const { recipes: loadedRecipes, notes: loadedNotes, folderHandle, folderName } = await pickVaultDirectory();
      if (loadedRecipes.length > 0 || loadedNotes.length > 0) {
        if (loadedRecipes.length > 0) setRecipes(loadedRecipes);
        if (loadedNotes.length > 0) setNotes(loadedNotes);
        setVaultStatus({
          isConnected: true,
          vaultPath: folderName ? `Vault / ${folderName}` : 'Obsidian Vault',
          fileCount: loadedRecipes.length + loadedNotes.length,
          accessType: 'filesystem_api',
          folderHandle,
        });
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        alert(err.message || 'Could not connect to Obsidian vault folder.');
      }
    }
  };

  // Upload folder fallback
  const handleUploadFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    try {
      const parsed = await parseUploadedFileList(e.target.files);
      if (parsed.recipes.length > 0) {
        setRecipes(parsed.recipes);
      }
      if (parsed.notes && parsed.notes.length > 0) {
        setNotes(parsed.notes);
      }
      if (parsed.mealPlan) setMealPlan(parsed.mealPlan);
      if (parsed.shoppingList) setShoppingCategories(parsed.shoppingList);

      if (parsed.recipes.length > 0 || parsed.mealPlan || parsed.shoppingList || (parsed.notes && parsed.notes.length > 0)) {
        setVaultStatus((prev) => ({
          ...prev,
          isConnected: true,
          fileCount: parsed.recipes.length + (parsed.notes?.length || 0),
          accessType: 'uploaded_folder',
        }));
      }
    } catch (err) {
      console.error('Failed to import files:', err);
    }
  };

  // Save / Update Recipe
  const handleSaveRecipe = async (savedRecipe: ObsidianRecipe) => {
    setRecipes((prev) => {
      const index = prev.findIndex((r) => r.id === savedRecipe.id || r.fileName === savedRecipe.fileName);
      if (index >= 0) {
        const next = [...prev];
        next[index] = savedRecipe;
        return next;
      }
      return [savedRecipe, ...prev];
    });

    if (selectedRecipe && (selectedRecipe.id === savedRecipe.id || selectedRecipe.fileName === savedRecipe.fileName)) {
      setSelectedRecipe(savedRecipe);
    }

    // Save directly to Obsidian vault disk note
    await saveRecipeToVaultFile(savedRecipe, vaultStatus.folderHandle);
    setIsEditorOpen(false);
    setEditingRecipe(null);
  };

  // Update Nutrition on a recipe and save to Obsidian Markdown frontmatter
  const handleUpdateNutrition = async (recipe: ObsidianRecipe, nutrition: RecipeNutrition) => {
    const updatedRecipe: ObsidianRecipe = {
      ...recipe,
      nutrition,
      calories: nutrition.calories !== undefined ? nutrition.calories.toString() : recipe.calories,
    };
    updatedRecipe.rawMarkdown = serializeRecipeToObsidianMarkdown(updatedRecipe);

    setRecipes((prev) => prev.map((r) => (r.id === updatedRecipe.id ? updatedRecipe : r)));
    if (selectedRecipe && selectedRecipe.id === updatedRecipe.id) {
      setSelectedRecipe(updatedRecipe);
    }

    if (vaultStatus.folderHandle) {
      await saveRecipeToVaultFile(updatedRecipe, vaultStatus.folderHandle);
    }
  };

  // Save or Create a Vault Note (e.g. ingredient or technique created from wikilink modal)
  const handleSaveNoteToVault = async (note: VaultNote) => {
    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === note.id || n.fileName.toLowerCase() === note.fileName.toLowerCase());
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = note;
        return next;
      }
      return [note, ...prev];
    });

    if (vaultStatus.folderHandle) {
      try {
        const fileName = note.fileName.endsWith('.md') ? note.fileName : `${note.fileName}.md`;
        let targetDir = vaultStatus.folderHandle;
        try {
          targetDir = await vaultStatus.folderHandle.getDirectoryHandle('Notes', { create: true });
        } catch (e) {
          targetDir = vaultStatus.folderHandle;
        }
        const fileHandle = await targetDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(note.rawMarkdown);
        await writable.close();
      } catch (err) {
        console.warn('Could not write note to vault filesystem:', err);
      }
    }
  };

  // Delete Recipe
  const handleDeleteRecipe = async (recipeToDelete: ObsidianRecipe) => {
    setRecipes((prev) => prev.filter((r) => r.id !== recipeToDelete.id && r.fileName !== recipeToDelete.fileName));
    if (selectedRecipe && (selectedRecipe.id === recipeToDelete.id || selectedRecipe.fileName === recipeToDelete.fileName)) {
      setSelectedRecipe(null);
    }
    if (vaultStatus.folderHandle) {
      await deleteRecipeFromVault(recipeToDelete, vaultStatus.folderHandle);
    }
  };

  // Start Cooking Mode
  const handleStartCooking = (recipe: ObsidianRecipe, servings?: number) => {
    setCookingRecipe({
      recipe,
      servings: servings || recipe.servings || 4,
    });
  };

  // Add Timer
  const handleStartTimer = (recipeTitle: string, minutes: number, label: string) => {
    const totalSecs = Math.round(minutes * 60);
    const newTimer: ActiveTimer = {
      id: `${Date.now()}-${Math.random()}`,
      recipeTitle,
      label,
      totalSeconds: totalSecs,
      remainingSeconds: totalSecs,
      isRunning: true,
      createdAt: Date.now(),
    };

    setActiveTimers((prev) => [newTimer, ...prev]);
  };

  const handleToggleTimer = (id: string) => {
    setActiveTimers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isRunning: !t.isRunning } : t))
    );
  };

  const handleDeleteTimer = (id: string) => {
    setActiveTimers((prev) => prev.filter((t) => t.id !== id));
  };

  const handleAddCustomTimer = () => {
    const minStr = prompt('Enter timer duration in minutes:', '10');
    if (!minStr) return;
    const mins = parseFloat(minStr);
    if (!isNaN(mins) && mins > 0) {
      handleStartTimer('Kitchen Timer', mins, `${mins} min timer`);
    }
  };

  // Toggle Favorite
  const handleToggleFavorite = (recipeId: string) => {
    setRecipes((prev) =>
      prev.map((r) => (r.id === recipeId ? { ...r, isFavorite: !r.isFavorite } : r))
    );
    if (selectedRecipe && selectedRecipe.id === recipeId) {
      setSelectedRecipe((prev) => (prev ? { ...prev, isFavorite: !prev.isFavorite } : null));
    }
  };

  // Filter by Wikilink
  const handleFilterByWikilink = (wikilink: string) => {
    setSearchQuery(wikilink);
    setSelectedRecipe(null);
    setActiveTab('grid');
  };

  // Shopping List & Meal Plan synchronization helper
  const generateShoppingFromMealPlan = (
    plan: MealPlanDay[],
    recipesList: ObsidianRecipe[],
    previousCategories: ShoppingCategoryGroup[] = []
  ): ShoppingCategoryGroup[] => {
    const totalMeals = plan.reduce(
      (acc, d) =>
        acc +
        (d.breakfast?.recipeTitle ? 1 : 0) +
        (d.lunch?.recipeTitle ? 1 : 0) +
        (d.dinner?.recipeTitle ? 1 : 0),
      0
    );

    // If meal plan is empty, shopping list is empty!
    if (totalMeals === 0) {
      return [];
    }

    // Preserve previously checked states
    const checkedMap = new Map<string, boolean>();
    previousCategories.forEach((group) => {
      group.items.forEach((item) => {
        if (item.isChecked) {
          checkedMap.set(`${group.category}::${item.text}`, true);
        }
      });
    });

    const groups: ShoppingCategoryGroup[] = [];

    plan.forEach((day) => {
      const slots: { type: 'Breakfast' | 'Lunch' | 'Dinner'; slot?: MealPlanSlot }[] = [
        { type: 'Breakfast', slot: day.breakfast },
        { type: 'Lunch', slot: day.lunch },
        { type: 'Dinner', slot: day.dinner },
      ];

      slots.forEach(({ type, slot }) => {
        if (!slot?.recipeTitle) return;

        const matchingRecipe = recipesList.find(
          (r) =>
            (slot.recipeId && r.id === slot.recipeId) ||
            r.title.toLowerCase() === slot.recipeTitle.toLowerCase()
        );

        if (matchingRecipe && matchingRecipe.ingredients.length > 0) {
          const categoryName = `${day.dayName} ${type}: ${matchingRecipe.title}`;
          groups.push({
            category: categoryName,
            items: matchingRecipe.ingredients.map((ing, idx) => {
              const cleanText = ing.original.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim() || ing.name;
              const key = `${categoryName}::${cleanText}`;
              return {
                id: `${day.dayName}-${type}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
                text: cleanText,
                recipeSources: [`${day.dayName} ${type}`],
                isChecked: !!checkedMap.get(key),
              };
            }),
          });
        }
      });
    });

    return groups;
  };

  // Meal Plan Handlers
  const handleSelectSlotRecipe = (
    dayIndex: number,
    mealType: 'breakfast' | 'lunch' | 'dinner',
    recipe: ObsidianRecipe
  ) => {
    setMealPlan((prev) => {
      const next = [...prev];
      next[dayIndex] = {
        ...next[dayIndex],
        [mealType]: {
          recipeId: recipe.id,
          recipeTitle: recipe.title,
        },
      };
      setShoppingCategories((prevShop) =>
        generateShoppingFromMealPlan(next, recipes, prevShop)
      );
      return next;
    });
  };

  const handleRemoveSlotRecipe = (
    dayIndex: number,
    mealType: 'breakfast' | 'lunch' | 'dinner'
  ) => {
    setMealPlan((prev) => {
      const next = [...prev];
      next[dayIndex] = {
        ...next[dayIndex],
        [mealType]: undefined,
      };
      setShoppingCategories((prevShop) =>
        generateShoppingFromMealPlan(next, recipes, prevShop)
      );
      return next;
    });
  };

  const handleResetMealPlan = () => {
    const emptyPlan: MealPlanDay[] = [
      { dayName: 'Monday' },
      { dayName: 'Tuesday' },
      { dayName: 'Wednesday' },
      { dayName: 'Thursday' },
      { dayName: 'Friday' },
      { dayName: 'Saturday' },
      { dayName: 'Sunday' },
    ];
    setMealPlan(emptyPlan);
    setShoppingCategories([]);
  };

  const handleAddToMealPlan = (r: ObsidianRecipe) => {
    setMealPlan((prev) => {
      const next = [...prev];
      const firstEmpty = next.find((d) => !d.dinner?.recipeTitle) || next.find((d) => !d.lunch?.recipeTitle) || next[0];
      if (!firstEmpty.dinner?.recipeTitle) {
        firstEmpty.dinner = { recipeId: r.id, recipeTitle: r.title };
      } else if (!firstEmpty.lunch?.recipeTitle) {
        firstEmpty.lunch = { recipeId: r.id, recipeTitle: r.title };
      } else {
        firstEmpty.breakfast = { recipeId: r.id, recipeTitle: r.title };
      }
      setShoppingCategories((prevShop) =>
        generateShoppingFromMealPlan(next, recipes, prevShop)
      );
      return next;
    });
    setActiveTab('mealplan');
  };

  const handleGenerateWeeklyShoppingList = () => {
    setShoppingCategories((prevShop) =>
      generateShoppingFromMealPlan(mealPlan, recipes, prevShop)
    );
    setActiveTab('shopping');
  };

  // Shopping List helpers
  const handleAddToShoppingList = (recipe: ObsidianRecipe, ingredientStrings: string[]) => {
    setShoppingCategories((prev) => {
      const categoryName = `Recipe: ${recipe.title}`;
      const newItems = ingredientStrings.map((text, idx) => {
        const cleanText = text.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();
        return {
          id: `${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
          text: cleanText || text,
          recipeSources: [recipe.title],
          isChecked: false,
        };
      });

      const existingIndex = prev.findIndex((g) => g.category === categoryName);
      if (existingIndex >= 0) {
        const next = [...prev];
        next[existingIndex] = {
          ...next[existingIndex],
          items: [...next[existingIndex].items, ...newItems],
        };
        return next;
      }

      return [
        ...prev,
        {
          category: categoryName,
          items: newItems,
        },
      ];
    });
  };

  const handleToggleShoppingItem = (category: string, itemId: string) => {
    setShoppingCategories((prev) =>
      prev.map((group) => {
        if (group.category === category) {
          return {
            ...group,
            items: group.items.map((i) =>
              i.id === itemId ? { ...i, isChecked: !i.isChecked } : i
            ),
          };
        }
        return group;
      })
    );
  };

  const handleAddShoppingItem = (category: string, text: string) => {
    setShoppingCategories((prev) => {
      const targetCategory = category || (prev[0]?.category || 'General');
      const existing = prev.find((g) => g.category === targetCategory);
      if (existing) {
        return prev.map((group) =>
          group.category === targetCategory
            ? {
                ...group,
                items: [
                  ...group.items,
                  { id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`, text, recipeSources: ['Custom'], isChecked: false },
                ],
              }
            : group
        );
      }
      return [
        ...prev,
        {
          category: targetCategory,
          items: [
            { id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`, text, recipeSources: ['Custom'], isChecked: false },
          ],
        },
      ];
    });
  };

  const handleDeleteShoppingItem = (category: string, itemId: string) => {
    setShoppingCategories((prev) =>
      prev.map((group) => {
        if (group.category === category) {
          return {
            ...group,
            items: group.items.filter((i) => i.id !== itemId),
          };
        }
        return group;
      })
    );
  };

  const handleClearDoneShopping = () => {
    setShoppingCategories((prev) =>
      prev.map((group) => ({
        ...group,
        items: group.items.filter((i) => !i.isChecked),
      }))
    );
  };

  const handleGenerateShoppingForDay = (day: MealPlanDay) => {
    const mealSlots: { mealType: string; recipeTitle: string; recipeId?: string }[] = [];
    if (day.breakfast?.recipeTitle) {
      mealSlots.push({
        mealType: 'Breakfast',
        recipeTitle: day.breakfast.recipeTitle,
        recipeId: day.breakfast.recipeId,
      });
    }
    if (day.lunch?.recipeTitle) {
      mealSlots.push({
        mealType: 'Lunch',
        recipeTitle: day.lunch.recipeTitle,
        recipeId: day.lunch.recipeId,
      });
    }
    if (day.dinner?.recipeTitle) {
      mealSlots.push({
        mealType: 'Dinner',
        recipeTitle: day.dinner.recipeTitle,
        recipeId: day.dinner.recipeId,
      });
    }

    if (mealSlots.length === 0) return;

    const dayCategoryGroups: ShoppingCategoryGroup[] = [];

    mealSlots.forEach((slot) => {
      const matchingRecipe = recipes.find(
        (r) =>
          (slot.recipeId && r.id === slot.recipeId) ||
          r.title.toLowerCase() === slot.recipeTitle.toLowerCase()
      );

      if (matchingRecipe && matchingRecipe.ingredients.length > 0) {
        dayCategoryGroups.push({
          category: `${day.dayName} ${slot.mealType}: ${matchingRecipe.title}`,
          items: matchingRecipe.ingredients.map((ing, idx) => {
            const cleanText = ing.original.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();
            return {
              id: `${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
              text: cleanText || ing.name,
              recipeSources: [`${day.dayName} ${slot.mealType}: ${matchingRecipe.title}`],
              isChecked: false,
            };
          }),
        });
      }
    });

    if (dayCategoryGroups.length > 0) {
      setShoppingCategories(dayCategoryGroups);
    }

    setActiveTab('shopping');
  };

  // Compute Tags, Cuisines, Categories
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    recipes.forEach((r) => r.tags.forEach((t) => set.add(t)));
    return Array.from(set);
  }, [recipes]);

  const availableCuisines = useMemo(() => {
    const set = new Set<string>();
    recipes.forEach((r) => r.cuisine && set.add(r.cuisine));
    return Array.from(set);
  }, [recipes]);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    recipes.forEach((r) => r.category && set.add(r.category));
    return Array.from(set);
  }, [recipes]);

  // Filtered & Sorted Recipes
  const filteredRecipes = useMemo(() => {
    return recipes.filter((recipe) => {
      // Search query (matches title, tags, ingredients, notes)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const inTitle = recipe.title.toLowerCase().includes(q);
        const inTags = recipe.tags.some((t) => t.toLowerCase().includes(q));
        const inIngs = recipe.ingredients.some((i) => i.original.toLowerCase().includes(q));
        const inNotes = (recipe.notes || '').toLowerCase().includes(q);
        const inWikilinks = (recipe.wikilinks || []).some((wl) => wl.toLowerCase().includes(q));
        if (!inTitle && !inTags && !inIngs && !inNotes && !inWikilinks) return false;
      }

      // Tag filter
      if (filters.tag && !recipe.tags.includes(filters.tag)) return false;

      // Cuisine filter
      if (filters.cuisine && recipe.cuisine !== filters.cuisine) return false;

      // Category filter
      if (filters.category && recipe.category !== filters.category) return false;

      // Difficulty
      if (filters.difficulty && recipe.difficulty !== filters.difficulty) return false;

      // Favorites
      if (filters.onlyFavorites && !recipe.isFavorite) return false;

      // Max Cook Time
      if (filters.maxCookTime) {
        const cookMin = parseInt(recipe.cookTime, 10) || 30;
        if (cookMin > filters.maxCookTime) return false;
      }

      return true;
    }).sort((a, b) => {
      if (filters.sortBy === 'title') {
        return a.title.localeCompare(b.title);
      } else if (filters.sortBy === 'rating') {
        return (b.rating || 0) - (a.rating || 0);
      } else if (filters.sortBy === 'cookTime') {
        const minA = parseInt(a.cookTime, 10) || 0;
        const minB = parseInt(b.cookTime, 10) || 0;
        return minA - minB;
      } else if (filters.sortBy === 'servings') {
        return (b.servings || 0) - (a.servings || 0);
      }
      return 0;
    });
  }, [recipes, searchQuery, filters]);

  const activeFilterCount =
    (filters.tag ? 1 : 0) +
    (filters.cuisine ? 1 : 0) +
    (filters.category ? 1 : 0) +
    (filters.difficulty ? 1 : 0) +
    (filters.maxCookTime ? 1 : 0) +
    (filters.onlyFavorites ? 1 : 0);

  const vaultHealthSummary = useMemo(() => {
    return summarizeVaultHealth(recipes);
  }, [recipes]);

  return (
    <div
      data-theme={theme}
      className="min-h-screen bg-[#0C0C0C] text-gray-200 flex flex-col font-sans selection:bg-amber-500/30 selection:text-amber-200 relative transition-colors duration-200"
      onDragOver={(e) => {
        e.preventDefault();
        setIsWindowDragging(true);
      }}
      onDragLeave={(e) => {
        // If leaving the window
        if (!e.relatedTarget) {
          setIsWindowDragging(false);
        }
      }}
      onDrop={async (e) => {
        e.preventDefault();
        setIsWindowDragging(false);
        try {
          const result = await parseDroppedFilesAndFolders(e.dataTransfer);
          if (result.recipes.length > 0) {
            setRecipes((prev) => {
              const map = new Map(prev.map((r) => [r.id, r]));
              result.recipes.forEach((r) => map.set(r.id, r));
              return Array.from(map.values());
            });
          }
          if (result.notes && result.notes.length > 0) {
            setNotes((prev) => {
              const map = new Map(prev.map((n) => [n.id, n]));
              result.notes.forEach((n) => map.set(n.id, n));
              return Array.from(map.values());
            });
          }
          if (result.mealPlan) setMealPlan(result.mealPlan);
          if (result.shoppingList) setShoppingCategories(result.shoppingList);

          if (result.recipes.length > 0 || result.mealPlan || result.shoppingList || (result.notes && result.notes.length > 0)) {
            setVaultStatus((prev) => ({
              ...prev,
              isConnected: true,
              fileCount: prev.fileCount + result.recipes.length + (result.notes?.length || 0),
            }));
          }
        } catch (err) {
          console.warn('Drop error:', err);
        }
      }}
    >
      {/* Global Drag and Drop Dropzone Indicator */}
      {isWindowDragging && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex flex-col items-center justify-center p-6 border-4 border-dashed border-amber-500 pointer-events-none">
          <div className="bg-[#141414] p-8 rounded-2xl border border-amber-500/40 text-center max-w-md shadow-2xl">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center mx-auto mb-4 border border-amber-500/30 animate-bounce">
              <span className="text-2xl font-bold">📂</span>
            </div>
            <h3 className="text-lg font-serif font-bold text-white mb-1">
              Drop Obsidian Recipe Files or Folder
            </h3>
            <p className="text-xs text-gray-400">
              Release to instantly parse recipes, notes, Meal Plan.md, and Shopping List.md into The Kitchen Codex.
            </p>
          </div>
        </div>
      )}

      {/* Top Header */}
      <VaultHeader
        vaultStatus={vaultStatus}
        activeTab={activeTab}
        setActiveTab={(tab) => {
          setActiveTab(tab);
          setSelectedRecipe(null);
        }}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        isFilterOpen={isFilterOpen}
        setIsFilterOpen={setIsFilterOpen}
        activeFilterCount={activeFilterCount}
        onOpenConnectVaultModal={() => setIsConnectVaultOpen(true)}
        onOpenNewRecipeModal={() => {
          setEditingRecipe(null);
          setIsEditorOpen(true);
        }}
        onOpenRecipeGrabber={() => setIsGrabberOpen(true)}
        onOpenVaultIntelligence={() => {
          setVaultIntelligenceRecipeId(null);
          setIsVaultIntelligenceOpen(true);
        }}
        legacyRecipeCount={vaultHealthSummary.legacyCount + vaultHealthSummary.incompleteCount}
        onRefreshVault={async () => {
          if (vaultStatus.isConnected && vaultStatus.folderHandle) {
            try {
              const scan = await scanVaultDirectory(vaultStatus.folderHandle);
              if (scan.recipes.length > 0) setRecipes(scan.recipes);
              if (scan.mealPlan) setMealPlan(scan.mealPlan);
              if (scan.shoppingList) setShoppingCategories(scan.shoppingList);
              setVaultStatus((prev) => ({ ...prev, fileCount: scan.recipes.length }));
            } catch (err) {
              console.warn('Re-scan failed:', err);
            }
          } else {
            setRecipes(getStarterVaultRecipes());
            setMealPlan(STARTER_MEAL_PLAN);
            setShoppingCategories(STARTER_SHOPPING_CATEGORIES);
          }
        }}
      />

      {/* Filter Drawer */}
      {isFilterOpen && (
        <RecipeFilterBar
          filters={filters}
          setFilters={setFilters}
          availableTags={availableTags}
          availableCuisines={availableCuisines}
          availableCategories={availableCategories}
          totalResults={filteredRecipes.length}
          onResetFilters={() => setFilters(INITIAL_FILTERS)}
        />
      )}

      {/* Main View Router */}
      <main className="flex-1">
        {selectedRecipe ? (
          <RecipeDetailView
            recipe={selectedRecipe}
            allRecipes={recipes}
            allNotes={notes}
            onBack={() => setSelectedRecipe(null)}
            onStartCooking={(recipe, servings) => handleStartCooking(recipe, servings)}
            onEditRecipe={(recipe) => {
              setEditingRecipe(recipe);
              setIsEditorOpen(true);
            }}
            onDeleteRecipe={handleDeleteRecipe}
            onAddToMealPlan={(recipe) => {
              handleAddToMealPlan(recipe);
              setSelectedRecipe(null);
            }}
            onAddToShoppingList={handleAddToShoppingList}
            onStartTimer={handleStartTimer}
            onFilterByWikilink={handleFilterByWikilink}
            onUpdateNutrition={handleUpdateNutrition}
            onSelectRecipe={(r) => setSelectedRecipe(r)}
            onSaveNoteToVault={handleSaveNoteToVault}
            onOpenVaultIntelligence={(recipeId) => {
              setVaultIntelligenceRecipeId(recipeId || null);
              setIsVaultIntelligenceOpen(true);
            }}
          />
        ) : activeTab === 'grid' ? (
          /* Recipe Gallery View */
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
            {/* Gallery Stats & Info */}
            <div className="flex items-center justify-between text-xs text-gray-400 pb-2 border-b border-white/5">
              <span>
                Showing <strong className="text-white">{filteredRecipes.length}</strong> of {recipes.length} recipes in vault
              </span>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-amber-400 font-semibold hover:underline"
                >
                  Clear search: &quot;{searchQuery}&quot;
                </button>
              )}
            </div>

            {filteredRecipes.length === 0 ? (
              <div className="bg-[#141414] rounded-2xl border border-dashed border-white/10 p-12 text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto">
                  <span className="text-xl">🔍</span>
                </div>
                <h3 className="font-serif font-bold text-base text-white">No matching recipes found</h3>
                <p className="text-xs text-gray-400 max-w-sm mx-auto">
                  Try adjusting your search terms, clearing active tag filters, or creating/importing new recipe markdown notes.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setFilters(INITIAL_FILTERS);
                    }}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black rounded-xl text-xs font-bold transition-colors cursor-pointer"
                  >
                    Reset All Filters
                  </button>
                  <button
                    onClick={() => setIsGrabberOpen(true)}
                    className="px-4 py-2 bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 rounded-xl text-xs font-bold transition-colors cursor-pointer"
                  >
                    🌐 Grab Recipe from Web
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                {filteredRecipes.map((recipe) => (
                  <RecipeCard
                    key={recipe.id}
                    recipe={recipe}
                    onSelectRecipe={(r) => setSelectedRecipe(r)}
                    onStartCooking={(r) => handleStartCooking(r)}
                    onToggleFavorite={handleToggleFavorite}
                    onAddToMealPlan={(r) => handleAddToMealPlan(r)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'dataview' ? (
          /* Dataview Table View */
          <DataviewTableView
            recipes={filteredRecipes}
            onSelectRecipe={(r) => setSelectedRecipe(r)}
            onStartCooking={(r) => handleStartCooking(r)}
          />
        ) : activeTab === 'mealplan' ? (
          /* Weekly Meal Planner View */
          <MealPlannerView
            recipes={recipes}
            mealPlan={mealPlan}
            onOpenRecipe={(id) => {
              const r = recipes.find((item) => item.id === id);
              if (r) setSelectedRecipe(r);
            }}
            onGenerateDayShoppingList={handleGenerateShoppingForDay}
            onGenerateWeeklyShoppingList={handleGenerateWeeklyShoppingList}
            onSelectSlotRecipe={handleSelectSlotRecipe}
            onRemoveSlotRecipe={handleRemoveSlotRecipe}
            onResetMealPlan={handleResetMealPlan}
          />
        ) : activeTab === 'shopping' ? (
          /* Shopping List View */
          <ShoppingListView
            categories={shoppingCategories}
            mealPlan={mealPlan}
            onToggleItem={handleToggleShoppingItem}
            onAddItem={handleAddShoppingItem}
            onDeleteItem={handleDeleteShoppingItem}
            onClearChecked={handleClearDoneShopping}
            onNavigateToMealPlan={() => setActiveTab('mealplan')}
          />
        ) : (
          /* Themes View */
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
            <ThemesView
              currentTheme={theme}
              onSelectTheme={(newTheme) => setTheme(newTheme)}
            />
          </div>
        )}
      </main>

      {/* Floating Active Timers Bar */}
      <ActiveTimersBar
        timers={activeTimers}
        onToggleTimer={handleToggleTimer}
        onDeleteTimer={handleDeleteTimer}
        onAddCustomTimer={handleAddCustomTimer}
      />

      {/* Fullscreen Cooking Mode Modal */}
      {cookingRecipe && (
        <React.Suspense fallback={null}>
          <CookingModeModal
            recipe={cookingRecipe.recipe}
            servings={cookingRecipe.servings}
            onClose={() => setCookingRecipe(null)}
            onStartTimer={handleStartTimer}
          />
        </React.Suspense>
      )}

      {/* Recipe Editor Modal */}
      {isEditorOpen && (
        <React.Suspense fallback={<div className="p-8 text-center text-gray-400">Loading editor…</div>}>
          <RecipeEditorModal
            initialRecipe={editingRecipe}
            folderHandle={vaultStatus.folderHandle}
            onSave={handleSaveRecipe}
            onClose={() => {
              setIsEditorOpen(false);
              setEditingRecipe(null);
            }}
          />
        </React.Suspense>
      )}

      {/* Connect Obsidian Vault Modal */}
      <ConnectVaultModal
        isOpen={isConnectVaultOpen}
        onClose={() => setIsConnectVaultOpen(false)}
        vaultStatus={vaultStatus}
        setVaultStatus={setVaultStatus}
        recipes={recipes}
        setRecipes={setRecipes}
        setMealPlan={setMealPlan}
        setShoppingCategories={setShoppingCategories}
        onOpenWebGrabber={() => setIsGrabberOpen(true)}
      />

      {/* Web Recipe Grabber Modal */}
      <RecipeGrabberModal
        isOpen={isGrabberOpen}
        folderHandle={vaultStatus.folderHandle}
        onClose={() => setIsGrabberOpen(false)}
        onSaveRecipe={async (savedRecipe) => {
          await handleSaveRecipe(savedRecipe);
          setSelectedRecipe(savedRecipe);
        }}
        onOpenInEditor={(recipe) => {
          setEditingRecipe(recipe);
          setIsEditorOpen(true);
        }}
      />

      {/* Vault Intelligence & Legacy Recovery Modal */}
      <VaultIntelligenceModal
        isOpen={isVaultIntelligenceOpen}
        onClose={() => {
          setIsVaultIntelligenceOpen(false);
          setVaultIntelligenceRecipeId(null);
        }}
        recipes={recipes}
        initialSelectedRecipeId={vaultIntelligenceRecipeId}
        onSaveRecipe={async (updatedRecipe) => {
          await handleSaveRecipe(updatedRecipe);
          if (selectedRecipe && selectedRecipe.id === updatedRecipe.id) {
            setSelectedRecipe(updatedRecipe);
          }
        }}
      />
    </div>
  );
}
