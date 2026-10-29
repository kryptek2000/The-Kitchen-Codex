import type { NutritionSource, NutritionConfidence } from './schema/recipeSchema';
import type { AdvancedNutritionBlock } from './core/nutritionV2';

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
  /**
   * Original/base serving count this nutrition block applies to.
   *
   * When present, the numeric fields represent TOTAL nutrition for the entire
   * recipe batch across `servings` servings. When absent (legacy), the numeric
   * fields are treated as PER-SERVING values (see src/utils/nutrition.ts).
   */
  servings?: number;
  confidenceNote?: string;
  /**
   * Where the nutrition numbers came from (see NutritionSource). Optional and
   * additive; absence means the provenance is unknown, never inferred.
   */
  source?: NutritionSource;
  /** Application-assigned confidence (never model-self-rated). */
  confidence?: NutritionConfidence;
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
  rating: number; // 1-5 (0 = unrated/cleared)
  /**
   * Whether the rating was explicitly provided by the user or imported from
   * recipe metadata. Absence means "no explicit rating" (legacy/unrated).
   * Internal UI/persistence hint; never serialized to YAML.
   */
  ratingExplicit?: boolean;
  /**
   * Provenance of the recorded rating. `imported` means it came from source
   * metadata; `personal` means the user chose it. Absence means unrated or
   * legacy numeric rating.
   */
  ratingSource?: 'imported' | 'personal';
  calories?: string | number;
  nutrition?: RecipeNutrition;
  source?: string;
  image?: string;
  ingredients: ParsedIngredient[];
  instructions: RecipeStep[];
  description?: string;
  notes?: string;
  callouts: ObsidianCallout[];
  dataviewFields: Record<string, string>;
  wikilinks: string[];
  frontmatter?: Record<string, any>;
  /**
   * Validated advanced-nutrition view decoded from the namespaced
   * `codex_nutrition` frontmatter block (Phase 0, read-only). The raw block is
   * always preserved in `frontmatter`; this is the parsed/validated projection.
   * Machine application of advanced nutrition remains disabled.
   */
  codexNutrition?: AdvancedNutritionBlock;
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

/**
 * The explicit state of the Vault connection (UD-2A.2).
 *
 * The starter Vault is NEVER presented as the user's connected Vault. A Vault
 * that is remembered but still needs the browser's permission is reported as
 * such, so the interface can offer an explicit reconnect action instead of
 * silently swapping the user's data for sample data.
 */
export type VaultConnectionState =
  /** No Vault is connected; the application is showing the starter sample data. */
  | 'starter'
  /** A live Vault is connected and authorised. */
  | 'connected'
  /** A Vault is remembered, but the browser requires a user gesture to re-authorise it. */
  | 'reauthorization_required'
  /** A Vault is remembered, but the browser refused access. */
  | 'permission_denied';

export interface VaultSyncStatus {
  isConnected: boolean;
  vaultPath: string;
  lastSynced?: string;
  accessType: 'filesystem_api' | 'drag_drop' | 'uploaded_folder' | 'starter_vault';
  folderHandle?: any;
  /**
   * Explicit connection state. When absent it is derived from `isConnected`
   * (connected when `isConnected` is true, starter otherwise).
   */
  connectionState?: VaultConnectionState;
  /**
   * Display name of a Vault that is remembered but not yet authorised. Shown
   * in the reconnect prompt so the user can tell WHICH Vault needs attention.
   */
  rememberedVaultName?: string;
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
  /**
   * Epoch milliseconds when a RUNNING timer should complete. When present, the
   * countdown is derived from this absolute target (wall-clock correct), so time
   * that passes while the app/browser is closed (or a tab is throttled/suspended)
   * is correctly deducted. Absent/undefined for a paused timer (frozen) and for
   * legacy persisted timers until migrated on first hydration.
   */
  endsAt?: number;
  /**
   * Stable semantic identity used to dedupe/replace a timer for the SAME surface
   * (e.g. a Cooking Mode step timer keyed by recipe + step number), so starting
   * it again restarts it rather than creating a duplicate. Absent for one-shot
   * Recipe Detail / custom timers.
   */
  semanticKey?: string;
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

/**
 * Stable theme identifiers. This array is the single source of truth for which
 * theme IDs are valid — used by the picker, the CSS `data-theme` boundary, and
 * persisted-preference hydration. Order is NOT a default; see DEFAULT_THEME_ID.
 */
export const THEME_IDS = ['obsidian', 'parchment', 'nordic', 'blood-moon'] as const;

export type ThemeId = (typeof THEME_IDS)[number];

/** The default theme. Blood Moon must never become the default. */
export const DEFAULT_THEME_ID: ThemeId = 'obsidian';

/** Narrowing guard for persisted/unknown values (e.g. legacy localStorage). */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

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
  /**
   * Optional short descriptor rendered as smaller secondary copy on the theme
   * card (e.g. "Developer's Edition"). Purely descriptive branding — it must
   * never gate features or behavior.
   */
  badge?: string;
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
