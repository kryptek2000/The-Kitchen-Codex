export interface ParsedIngredient {
  original: string;
  amount?: number | null;
  unit?: string;
  name: string;
  wikilink?: string;
  wikilinkTarget?: string;
  wikilinkAlias?: string;
  note?: string;
  isChecked?: boolean;
}

export interface RecipeNutrition {
  calories?: number;
  protein?: number; // in grams
  carbohydrates?: number; // in grams
  fat?: number; // in grams
  fiber?: number; // in grams
  sodium?: number; // in milligrams
  confidenceNote?: string;
}

export interface RecipeStep {
  stepNumber: number;
  text: string;
  timerMinutes?: number | null;
  isCompleted?: boolean;
}

export interface ObsidianCallout {
  type: 'tip' | 'warning' | 'info' | 'note' | 'quote' | 'important';
  title?: string;
  content: string;
}

export interface ObsidianRecipe {
  id: string;
  fileName: string;
  filePath: string;
  rawMarkdown: string;
  title: string;
  tags: string[];
  category: string;
  cuisine: string;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  servings?: number;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  rating: number; // 1-5
  calories?: string | number;
  nutrition?: RecipeNutrition;
  source?: string;
  image?: string;
  ingredients: ParsedIngredient[];
  instructions: RecipeStep[];
  notes?: string;
  callouts: ObsidianCallout[];
  dataviewFields: Record<string, string>;
  wikilinks: string[];
  frontmatter?: Record<string, any>;
  lastModified?: string;
  fileHandle?: any; // Native FileSystemFileHandle if connected
  isFavorite?: boolean;
}

export interface VaultNote {
  id: string;
  fileName: string;
  filePath: string;
  rawMarkdown: string;
  title: string;
  tags: string[];
  frontmatter?: Record<string, any>;
  content: string;
  fileHandle?: any;
}

export interface MealPlanSlot {
  recipeId?: string;
  recipeTitle?: string;
  customText?: string;
}

export interface MealPlanDay {
  dayName: string; // 'Monday', 'Tuesday', etc.
  dateStr?: string;
  breakfast?: MealPlanSlot;
  lunch?: MealPlanSlot;
  dinner?: MealPlanSlot;
  snacks?: MealPlanSlot[];
}

export interface VaultSyncStatus {
  isConnected: boolean;
  vaultPath: string;
  fileCount: number;
  lastSynced?: string;
  accessType: 'filesystem_api' | 'drag_drop' | 'uploaded_folder' | 'starter_vault';
  folderHandle?: any;
}

export interface FilterState {
  search: string;
  tag: string | null;
  category: string | null;
  cuisine: string | null;
  difficulty: string | null;
  maxCookTime: number | null;
  minRating: number | null;
  ingredientSearch: string;
  onlyFavorites: boolean;
  sortBy: 'title' | 'rating' | 'cookTime' | 'recent' | 'servings';
  sortOrder: 'asc' | 'desc';
}

export interface ActiveTimer {
  id: string;
  recipeTitle: string;
  label: string;
  totalSeconds: number;
  remainingSeconds: number;
  isRunning: boolean;
  createdAt: number;
}

export interface ShoppingCategoryGroup {
  category: string;
  items: {
    id: string;
    text: string;
    recipeSources: string[];
    isChecked: boolean;
  }[];
}

export type ThemeId = 'obsidian' | 'parchment' | 'nordic';

export interface AppThemeConfig {
  id: ThemeId;
  name: string;
  subtitle: string;
  description: string;
  mode: 'dark' | 'light';
  palette: {
    bgRoot: string;
    bgSurface: string;
    bgElevated: string;
    accent: string;
    accentSecondary: string;
    textPrimary: string;
    textSecondary: string;
    border: string;
  };
  highlights: string[];
  vibe: string;
}

export type MetadataHealthStatus = 'complete' | 'mostly_complete' | 'incomplete' | 'legacy';

export interface MetadataHealthReport {
  recipeId: string;
  recipeTitle: string;
  fileName: string;
  status: MetadataHealthStatus;
  healthScore: number; // 0 to 100
  missingFields: string[]; // e.g. ['prepTime', 'cookTime', 'servings', 'calories', 'nutrition']
  presentFields: string[];
  legacyMarkers: string[];
  totalFieldsCount: number;
}

export interface VaultHealthSummary {
  totalRecipes: number;
  completeCount: number;
  mostlyCompleteCount: number;
  incompleteCount: number;
  legacyCount: number;
  averageHealthScore: number;
  reports: MetadataHealthReport[];
}

export type RecoveryConfidence = 'high' | 'medium' | 'low';
export type RecoverySource = 'instructions_explicit' | 'body_parsed' | 'culinary_inference';

export interface RecoveredField<T = any> {
  value: T;
  confidence: RecoveryConfidence;
  source: RecoverySource;
  explanation: string;
}

export interface RecoveredRecipeMetadata {
  prepTime?: RecoveredField<string>;
  cookTime?: RecoveredField<string>;
  totalTime?: RecoveredField<string>;
  servings?: RecoveredField<number>;
  calories?: RecoveredField<number>;
  nutrition?: RecoveredField<RecipeNutrition>;
  category?: RecoveredField<string>;
  cuisine?: RecoveredField<string>;
  difficulty?: RecoveredField<'Easy' | 'Medium' | 'Hard'>;
  suggestedTags?: RecoveredField<string[]>;
}
