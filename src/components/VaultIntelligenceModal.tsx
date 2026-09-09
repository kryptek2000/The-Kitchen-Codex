import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  BrainCircuit,
  X,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  FileQuestion,
  Layers,
  ArrowRight,
  RefreshCw,
  Check,
  ShieldCheck,
  Zap,
  Info,
  Sliders,
  Clock,
  Flame,
  Users,
  Tag,
  ChefHat,
  ChevronRight,
  BookOpen,
  Filter,
  CheckSquare,
  Square,
  Search,
  Image,
  ImageOff,
} from 'lucide-react';
import {
  ObsidianRecipe,
  MetadataHealthReport,
  VaultHealthSummary,
  RecoveredRecipeMetadata,
  MetadataHealthStatus,
  RecoveryConfidence,
} from '../types';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import {
  assessRecipeHealth,
  summarizeVaultHealth,
  mergeRecoveredMetadata,
  normalizeTimeString,
} from '../utils/vaultIntelligence';
import {
  assessRecipeImageHealth,
  type RecipeImageHealth,
} from '../core/recipeImage';
import {
  RecipeImageRecoveryController,
  recipeImagePreviewPath,
  isImageRecoverySupported,
  type RecipeImageRecoverySupport,
  type RecipeImageRecoveryState,
} from '../application/recipeImageRecovery';

interface VaultIntelligenceModalProps {
  isOpen: boolean;
  onClose: () => void;
  recipes: ObsidianRecipe[];
  onSaveRecipe: (updated: ObsidianRecipe) => Promise<void> | void;
  onBatchSaveRecipes?: (updatedList: ObsidianRecipe[]) => Promise<void> | void;
  initialSelectedRecipeId?: string | null;
  network: NetworkAdapter;
  /**
   * Vault Intelligence Image Recovery (v0.7 2B): shell-provided support object.
   * PRESENT only when every capability is real (writable vault + AssetAdapter +
   * generation wiring + vault session id). Never fake support.
   */
  imageRecovery?: RecipeImageRecoverySupport;
  /** Truthful reason shown when image recovery is unavailable on this surface. */
  imageRecoveryUnavailableReason?: string;
  /** In-memory canonical update after a successful image save (no re-write). */
  onRecipeImageSaved?: (recipeId: string, imagePath: string) => void;
}

export interface RecipeImageFindingViewProps {
  /** Live image-health finding (null = still checking). */
  health: RecipeImageHealth | null;
  /** True only when every image-recovery capability is present on this surface. */
  canGenerate: boolean;
  /** Truthful unavailability reason (shown instead of any Generate action). */
  unavailableReason?: string;
  /** Controller state (phases: idle/generating/preview/saving/saved). */
  recoveryState: RecipeImageRecoveryState;
  busy: boolean;
  onGenerate: () => void;
  onSave: () => void;
  onRegenerate: () => void;
  onCancel: () => void;
}

/**
 * Per-recipe image-issue surface (presentational; exported for tests).
 * Uses `assessRecipeImageHealth` findings DIRECTLY — never `getRecipeImage()`.
 * Recovery actions are offered ONLY for `missing` / `broken_local`, and the
 * Generate action ONLY when the surface truly supports it. `valid_local` and
 * `remote_present` get NO recovery action (never replace a valid image);
 * `invalid_remote` / `unverifiable_local` are informational only.
 */
export function RecipeImageFindingView({
  health,
  canGenerate,
  unavailableReason,
  recoveryState,
  busy,
  onGenerate,
  onSave,
  onRegenerate,
  onCancel,
}: RecipeImageFindingViewProps) {
  const { phase, preview, message, messageKind } = recoveryState;

  const finding = (() => {
    if (!health) {
      return (
        <div className="text-[11px] text-gray-500 flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          <span>Checking image status...</span>
        </div>
      );
    }
    switch (health.kind) {
      case 'missing':
        return (
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <ImageOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-xs font-bold text-amber-300">No image</div>
                <p className="text-[11px] text-gray-400 mt-0.5">{health.reason}</p>
              </div>
            </div>
            {canGenerate ? (
              <button
                onClick={onGenerate}
                disabled={busy}
                data-testid="generate-image"
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-purple-500 hover:bg-purple-400 text-black disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                <Sparkles className={`w-3.5 h-3.5 ${phase === 'generating' ? 'animate-spin' : ''}`} />
                <span>{phase === 'generating' ? 'Generating...' : 'Generate Image'}</span>
              </button>
            ) : (
              unavailableReason && (
                <span className="shrink-0 text-[10px] text-gray-500 italic max-w-[220px] text-right">{unavailableReason}</span>
              )
            )}
          </div>
        );
      case 'broken_local':
        return (
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <ImageOff className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-xs font-bold text-rose-300">Broken local image</div>
                <p className="text-[11px] text-gray-400 mt-0.5 break-all">{health.reason}</p>
                <p className="text-[10px] text-gray-500 mt-1 font-mono break-all">{health.imageRef}</p>
                {canGenerate && (
                  <p className="text-[10px] text-gray-500 mt-1">A generated replacement can repair the image field. The old broken file is not deleted.</p>
                )}
              </div>
            </div>
            {canGenerate ? (
              <button
                onClick={onGenerate}
                disabled={busy}
                data-testid="generate-image"
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-purple-500 hover:bg-purple-400 text-black disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                <Sparkles className={`w-3.5 h-3.5 ${phase === 'generating' ? 'animate-spin' : ''}`} />
                <span>{phase === 'generating' ? 'Generating...' : 'Generate Image'}</span>
              </button>
            ) : (
              unavailableReason && (
                <span className="shrink-0 text-[10px] text-gray-500 italic max-w-[220px] text-right">{unavailableReason}</span>
              )
            )}
          </div>
        );
      case 'invalid_remote':
        return (
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-xs font-bold text-amber-300">Invalid remote image reference</div>
              <p className="text-[11px] text-gray-400 mt-0.5">{health.reason}</p>
              <p className="text-[10px] text-gray-500 mt-1 font-mono break-all">{health.imageRef}</p>
            </div>
          </div>
        );
      case 'unverifiable_local':
        return (
          <div className="flex items-start gap-2.5">
            <Info className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-xs font-bold text-gray-300">Local image could not be verified</div>
              <p className="text-[11px] text-gray-400 mt-0.5">{health.reason}</p>
            </div>
          </div>
        );
      case 'valid_local':
      case 'remote_present':
      default:
        return (
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-xs font-bold text-emerald-300">Image looks healthy</div>
              <p className="text-[11px] text-gray-400 mt-0.5">{health.reason}</p>
            </div>
          </div>
        );
    }
  })();

  return (
    <div className="p-4 rounded-2xl bg-[#141414] border border-white/10 space-y-3" data-testid="recipe-image-section">
      <div className="flex items-center gap-2 pb-2 border-b border-white/5">
        <Image className="w-4 h-4 text-purple-400" />
        <span className="text-xs font-bold text-white">Recipe Image</span>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider ml-auto">Image Recovery</span>
      </div>

      {finding}

      {/* Message banner (bounded, user-facing only) */}
      {message && (
        <div
          className={`p-2.5 rounded-xl text-xs flex items-start gap-2 ${
            messageKind === 'success'
              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
              : messageKind === 'error'
                ? 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
                : 'bg-blue-500/10 border border-blue-500/30 text-blue-300'
          }`}
        >
          {messageKind === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span>{message}</span>
        </div>
      )}

      {/* Preview: AI-generated, transient, nothing saved yet. Renders via the
          authenticated preview endpoint — never base64/data URL. */}
      {preview && (
        <div className="space-y-2.5 p-3 rounded-xl bg-[#0C0C0C] border border-purple-500/20">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300">AI-generated preview</span>
            <span className="text-[10px] text-gray-500">nothing saved yet</span>
          </div>
          <img
            src={recipeImagePreviewPath(preview.token)}
            alt="AI-generated recipe preview"
            data-testid="recipe-image-preview"
            className="max-h-56 rounded-lg border border-white/10 w-full object-contain bg-black/40"
          />
          <div className="text-[10px] text-gray-500 font-mono">
            {preview.provider} · {preview.model}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onCancel}
              disabled={busy}
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-white rounded-lg disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={onRegenerate}
              disabled={busy}
              data-testid="regenerate-image"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-white/10 hover:bg-white/15 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${phase === 'generating' ? 'animate-spin' : ''}`} />
              <span>{phase === 'generating' ? 'Generating...' : 'Regenerate'}</span>
            </button>
            <button
              onClick={onSave}
              disabled={busy}
              data-testid="save-image"
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-md shadow-emerald-500/20"
            >
              <Check className="w-4 h-4" />
              <span>{phase === 'saving' ? 'Saving...' : 'Save Image'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function VaultIntelligenceModal({
  isOpen,
  onClose,
  recipes,
  onSaveRecipe,
  onBatchSaveRecipes,
  initialSelectedRecipeId,
  network,
  imageRecovery,
  imageRecoveryUnavailableReason,
  onRecipeImageSaved,
}: VaultIntelligenceModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'queue'>('overview');
  const [healthFilter, setHealthFilter] = useState<'all' | 'legacy' | 'incomplete' | 'mostly_complete' | 'complete'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);

  // Recovery state for currently selected recipe
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveredData, setRecoveredData] = useState<RecoveredRecipeMetadata | null>(null);
  const [acceptedFields, setAcceptedFields] = useState<Record<string, boolean>>({
    prepTime: true,
    cookTime: true,
    totalTime: true,
    servings: true,
    calories: true,
    nutrition: true,
    category: true,
    cuisine: true,
    difficulty: true,
    suggestedTags: true,
  });

  // Batch recovery state
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; success: number }>({ current: 0, total: 0, success: 0 });
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<string | null>(null);

  // Calculate vault health summary dynamically
  const vaultHealth = useMemo(() => {
    return summarizeVaultHealth(recipes);
  }, [recipes]);

  // Set initial selected recipe if passed
  useEffect(() => {
    if (initialSelectedRecipeId) {
      setSelectedRecipeId(initialSelectedRecipeId);
      setActiveTab('queue');
    } else if (recipes.length > 0 && !selectedRecipeId) {
      // Find first legacy or incomplete recipe
      const firstLegacy = recipes.find((r) => assessRecipeHealth(r).status === 'legacy');
      const firstIncomplete = recipes.find((r) => assessRecipeHealth(r).status === 'incomplete');
      setSelectedRecipeId(firstLegacy?.id || firstIncomplete?.id || recipes[0].id);
    }
  }, [initialSelectedRecipeId, recipes]);

  const selectedRecipe = useMemo(() => {
    return recipes.find((r) => r.id === selectedRecipeId) || null;
  }, [recipes, selectedRecipeId]);

  const selectedHealthReport = useMemo(() => {
    if (!selectedRecipe) return null;
    return assessRecipeHealth(selectedRecipe);
  }, [selectedRecipe]);

  // Reset recovered data when selected recipe changes
  useEffect(() => {
    setRecoveredData(null);
    setRecoveryError(null);
    setSaveSuccessNotice(null);
  }, [selectedRecipeId]);

  // ---- Vault Intelligence Image Recovery (v0.7 2B) -------------------------
  // Controller lifecycle: a fresh session per open/support change. close() on
  // unmount/close advances the epoch so late generation/save results can never
  // repopulate the UI (same liveness pattern as Create for Me).
  const [imageRecoveryState, setImageRecoveryState] = useState<RecipeImageRecoveryState>({ phase: 'idle' });
  const imageControllerRef = useRef<RecipeImageRecoveryController | null>(null);
  const selectedRecipeIdRef = useRef<string | null>(selectedRecipeId);
  useEffect(() => {
    selectedRecipeIdRef.current = selectedRecipeId;
  }, [selectedRecipeId]);

  useEffect(() => {
    if (!isOpen || !imageRecovery || !isImageRecoverySupported(imageRecovery)) {
      imageControllerRef.current?.close();
      imageControllerRef.current = null;
      setImageRecoveryState({ phase: 'idle' });
      return;
    }
    const controller = new RecipeImageRecoveryController({
      network,
      support: imageRecovery,
      onState: setImageRecoveryState,
      onSaved: (result) => {
        const recipeId = selectedRecipeIdRef.current;
        if (recipeId) onRecipeImageSaved?.(recipeId, result.imagePath);
      },
    });
    imageControllerRef.current = controller;
    setImageRecoveryState(controller.getState());
    return () => {
      controller.close();
      imageControllerRef.current = null;
    };
  }, [isOpen, network, imageRecovery, onRecipeImageSaved]);

  // Live image-health finding via assessRecipeImageHealth (canonical truth is
  // the recipe.image field + the asset boundary — NEVER getRecipeImage()).
  const [imageHealth, setImageHealth] = useState<RecipeImageHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    setImageHealth(null);
    if (!selectedRecipe) return;
    assessRecipeImageHealth({ image: selectedRecipe.image }, { asset: imageRecovery?.asset }).then((h) => {
      if (!cancelled) setImageHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRecipe, imageRecovery]);

  const canGenerateImage = isImageRecoverySupported(imageRecovery);
  const handleImageGenerate = useCallback(() => {
    if (selectedRecipe && imageControllerRef.current) void imageControllerRef.current.generate(selectedRecipe);
  }, [selectedRecipe]);
  const handleImageSave = useCallback(() => {
    if (selectedRecipe && imageControllerRef.current) void imageControllerRef.current.save(selectedRecipe);
  }, [selectedRecipe]);
  const handleImageRegenerate = useCallback(() => {
    if (selectedRecipe && imageControllerRef.current) void imageControllerRef.current.regenerate(selectedRecipe);
  }, [selectedRecipe]);
  const handleImageCancel = useCallback(() => {
    void imageControllerRef.current?.cancel();
  }, []);
  const handleCloseModal = useCallback(() => {
    imageControllerRef.current?.close();
    onClose();
  }, [onClose]);
  // -------------------------------------------------------------------------

  // Filtered reports for queue
  const filteredReports = useMemo(() => {
    return vaultHealth.reports.filter((report) => {
      if (healthFilter !== 'all' && report.status !== healthFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          report.recipeTitle.toLowerCase().includes(q) ||
          report.fileName.toLowerCase().includes(q) ||
          report.missingFields.some((f) => f.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [vaultHealth, healthFilter, searchQuery]);

  if (!isOpen) return null;

  const handleTriggerRecovery = async (recipe: ObsidianRecipe) => {
    setIsRecovering(true);
    setRecoveryError(null);
    setSaveSuccessNotice(null);

    try {
      const payload = {
        title: recipe.title,
        rawMarkdown: recipe.rawMarkdown,
        ingredients: recipe.ingredients,
        instructions: recipe.instructions,
        existingMetadata: {
          prepTime: recipe.prepTime,
          cookTime: recipe.cookTime,
          totalTime: recipe.totalTime,
          servings: recipe.servings,
          calories: recipe.calories,
          category: recipe.category,
          cuisine: recipe.cuisine,
          difficulty: recipe.difficulty,
          tags: recipe.tags,
        },
      };

        const res = await network.post<{ recovered?: any; error?: string }>('/api/recover-metadata', payload);

      if (!res.ok) {
        throw new Error((res.data as { error?: string } | undefined)?.error || `Server returned error (${res.status})`);
      }

      const data = res.data;
      if (data?.recovered) {
        setRecoveredData(data.recovered);
        // Default only missing fields to true, present fields to false to avoid overwriting unless user opts in
        const newAccepted: Record<string, boolean> = {};
        const missing = assessRecipeHealth(recipe).missingFields;

        (Object.keys(data.recovered) as (keyof RecoveredRecipeMetadata)[]).forEach((field) => {
          // If field is in missingFields or was empty, accept it by default
          newAccepted[field] = missing.includes(field) || field === 'suggestedTags' || field === 'nutrition';
        });
        setAcceptedFields(newAccepted);
      } else {
        throw new Error('No metadata recovery payload returned from server.');
      }
    } catch (err: any) {
      console.error('Metadata recovery failed:', err);
      setRecoveryError(err.message || 'Failed to recover recipe metadata.');
    } finally {
      setIsRecovering(false);
    }
  };

  const handleSaveRecoveredFields = async () => {
    if (!selectedRecipe || !recoveredData) return;

    const acceptedKeys = (Object.keys(acceptedFields) as (keyof RecoveredRecipeMetadata)[]).filter(
      (key) => acceptedFields[key] && recoveredData[key]
    );

    if (acceptedKeys.length === 0) {
      setRecoveryError('Please check at least one recovered field to save.');
      return;
    }

    try {
      const merged = mergeRecoveredMetadata(selectedRecipe, recoveredData, acceptedKeys);
      await onSaveRecipe(merged);
      setSaveSuccessNotice(`Successfully saved ${acceptedKeys.length} recovered metadata fields to "${selectedRecipe.title}".`);
      setRecoveredData(null);
    } catch (err: any) {
      setRecoveryError(`Failed to save to vault: ${err.message}`);
    }
  };

  const handleBulkRecoverAll = async () => {
    const targetRecipes = recipes.filter((r) => {
      const status = assessRecipeHealth(r).status;
      return status === 'legacy' || status === 'incomplete';
    });

    if (targetRecipes.length === 0) {
      alert('All recipes in your vault already have complete or mostly complete metadata!');
      return;
    }

    const confirmMsg = `Recover metadata for ${targetRecipes.length} legacy/incomplete recipes using AI and culinary inference?`;
    if (!window.confirm(confirmMsg)) return;

    setIsBatchRunning(true);
    setBatchProgress({ current: 0, total: targetRecipes.length, success: 0 });

    const updatedRecipes: ObsidianRecipe[] = [];

    for (let i = 0; i < targetRecipes.length; i++) {
      const rec = targetRecipes[i];
      setBatchProgress({ current: i + 1, total: targetRecipes.length, success: updatedRecipes.length });

      try {
        const payload = {
          title: rec.title,
          rawMarkdown: rec.rawMarkdown,
          ingredients: rec.ingredients,
          instructions: rec.instructions,
          existingMetadata: {
            prepTime: rec.prepTime,
            cookTime: rec.cookTime,
            totalTime: rec.totalTime,
            servings: rec.servings,
            calories: rec.calories,
            category: rec.category,
            cuisine: rec.cuisine,
            difficulty: rec.difficulty,
            tags: rec.tags,
          },
        };

      const res = await network.post<{ recovered?: any; error?: string }>('/api/recover-metadata', payload);

        if (res.ok) {
          const data = res.data;
          if (data?.recovered) {
            const missing = assessRecipeHealth(rec).missingFields;
            const fieldsToAccept = (Object.keys(data.recovered) as (keyof RecoveredRecipeMetadata)[]).filter(
              (f) => missing.includes(f) || f === 'suggestedTags'
            );
            const merged = mergeRecoveredMetadata(rec, data.recovered, fieldsToAccept);
            updatedRecipes.push(merged);
            await onSaveRecipe(merged);
          }
        }
      } catch (err) {
        console.warn(`Batch recovery error on ${rec.title}:`, err);
      }
    }

    setIsBatchRunning(false);
    setSaveSuccessNotice(`Batch recovery finished! Updated ${updatedRecipes.length} recipe notes in your Obsidian vault.`);
  };

  const getStatusBadge = (status: MetadataHealthStatus) => {
    switch (status) {
      case 'complete':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-3 h-3" />
            <span>Complete</span>
          </span>
        );
      case 'mostly_complete':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Check className="w-3 h-3" />
            <span>Mostly Complete</span>
          </span>
        );
      case 'incomplete':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <AlertTriangle className="w-3 h-3" />
            <span>Incomplete</span>
          </span>
        );
      case 'legacy':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/20">
            <FileQuestion className="w-3 h-3" />
            <span>Legacy Format</span>
          </span>
        );
    }
  };

  const getConfidenceBadge = (confidence: RecoveryConfidence) => {
    switch (confidence) {
      case 'high':
        return (
          <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            High Confidence
          </span>
        );
      case 'medium':
        return (
          <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
            Medium Confidence
          </span>
        );
      case 'low':
        return (
          <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-zinc-700/50 text-gray-300 border border-zinc-600/30">
            Estimated
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200">
      <div className="bg-[#121212] border border-white/10 rounded-2xl max-w-5xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-gray-200">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-white/10 bg-[#161616] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/15 border border-purple-500/30 text-purple-400 flex items-center justify-center shrink-0">
              <BrainCircuit className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-serif font-bold text-white tracking-tight">
                  Obsidian Vault Intelligence
                </h2>
                <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
                  Legacy &amp; Metadata Recovery
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                Detect recipes with missing or legacy frontmatter, inspect confidence rationales, and safely enrich your markdown notes.
              </p>
            </div>
          </div>

          <button
            onClick={handleCloseModal}
            className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
            title="Close Vault Intelligence"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="px-5 py-2.5 bg-[#141414] border-b border-white/5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'overview'
                  ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30 shadow-xs'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Vault Health Dashboard</span>
            </button>

            <button
              onClick={() => setActiveTab('queue')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'queue'
                  ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30 shadow-xs'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Review &amp; Recovery Queue</span>
              {(vaultHealth.legacyCount > 0 || vaultHealth.incompleteCount > 0) && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-purple-500 text-black font-bold">
                  {vaultHealth.legacyCount + vaultHealth.incompleteCount}
                </span>
              )}
            </button>
          </div>

          {/* Quick Bulk Action */}
          <button
            onClick={handleBulkRecoverAll}
            disabled={isBatchRunning || (vaultHealth.legacyCount === 0 && vaultHealth.incompleteCount === 0)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-lg bg-purple-500 hover:bg-purple-400 text-black disabled:opacity-40 disabled:hover:bg-purple-500 disabled:cursor-not-allowed transition-all shadow-xs"
            title="Scan and recover all legacy & incomplete recipe notes"
          >
            {isBatchRunning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            <span>{isBatchRunning ? `Processing ${batchProgress.current}/${batchProgress.total}...` : 'Auto-Recover Missing'}</span>
          </button>
        </div>

        {/* Global Success / Notice Banner */}
        {saveSuccessNotice && (
          <div className="mx-5 mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{saveSuccessNotice}</span>
            </div>
            <button onClick={() => setSaveSuccessNotice(null)} className="text-emerald-400 hover:text-emerald-200 text-xs font-bold">
              Dismiss
            </button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-6">
          {activeTab === 'overview' && (
            <div className="space-y-6 animate-in fade-in duration-150">
              {/* Vault Health Meter */}
              <div className="p-5 rounded-2xl bg-gradient-to-r from-purple-950/20 via-[#161616] to-[#161616] border border-purple-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
                <div className="space-y-1.5 max-w-lg">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-purple-400" />
                    <h3 className="font-serif font-bold text-base text-white">Overall Vault Metadata Health</h3>
                  </div>
                  <p className="text-xs text-gray-400">
                    A high metadata health score powers instant cook-time filtering, automatic serving conversions, macro nutrition badges, and dynamic Dataview queries.
                  </p>
                </div>

                <div className="flex items-center gap-4 bg-[#0C0C0C] p-4 rounded-xl border border-white/5 self-stretch sm:self-auto justify-center">
                  <div className="text-right">
                    <div className="text-3xl font-mono font-black text-purple-400">{vaultHealth.averageHealthScore}%</div>
                    <div className="text-[10px] uppercase font-bold text-gray-500 tracking-wider">Health Score</div>
                  </div>
                  <div className="w-12 h-12 rounded-full border-4 border-purple-500/30 flex items-center justify-center relative">
                    <div
                      className="absolute inset-0 rounded-full border-4 border-purple-400 transition-all"
                      style={{
                        clipPath: `polygon(0 0, 100% 0, 100% ${vaultHealth.averageHealthScore}%, 0 ${vaultHealth.averageHealthScore}%)`,
                      }}
                    />
                    <BrainCircuit className="w-5 h-5 text-purple-300" />
                  </div>
                </div>
              </div>

              {/* Status Breakdown 4-Card Grid */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
                {/* Complete */}
                <div
                  onClick={() => {
                    setHealthFilter('complete');
                    setActiveTab('queue');
                  }}
                  className="p-4 rounded-xl bg-[#161616] border border-white/5 hover:border-emerald-500/30 cursor-pointer transition-all space-y-2 group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-400 group-hover:text-emerald-400 transition-colors">Complete</span>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div className="text-2xl font-mono font-bold text-white">{vaultHealth.completeCount}</div>
                  <p className="text-[11px] text-gray-500">Timings, servings, tags &amp; nutrition fully defined.</p>
                </div>

                {/* Mostly Complete */}
                <div
                  onClick={() => {
                    setHealthFilter('mostly_complete');
                    setActiveTab('queue');
                  }}
                  className="p-4 rounded-xl bg-[#161616] border border-white/5 hover:border-blue-500/30 cursor-pointer transition-all space-y-2 group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-400 group-hover:text-blue-400 transition-colors">Mostly Complete</span>
                    <Check className="w-4 h-4 text-blue-400" />
                  </div>
                  <div className="text-2xl font-mono font-bold text-white">{vaultHealth.mostlyCompleteCount}</div>
                  <p className="text-[11px] text-gray-500">Core timings present; missing nutrition or tags.</p>
                </div>

                {/* Incomplete */}
                <div
                  onClick={() => {
                    setHealthFilter('incomplete');
                    setActiveTab('queue');
                  }}
                  className="p-4 rounded-xl bg-[#161616] border border-white/5 hover:border-amber-500/30 cursor-pointer transition-all space-y-2 group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-400 group-hover:text-amber-400 transition-colors">Incomplete</span>
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                  </div>
                  <div className="text-2xl font-mono font-bold text-white">{vaultHealth.incompleteCount}</div>
                  <p className="text-[11px] text-gray-500">Missing prep/cook timings or servings yield.</p>
                </div>

                {/* Legacy */}
                <div
                  onClick={() => {
                    setHealthFilter('legacy');
                    setActiveTab('queue');
                  }}
                  className="p-4 rounded-xl bg-[#161616] border border-white/5 hover:border-purple-500/30 cursor-pointer transition-all space-y-2 group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-400 group-hover:text-purple-400 transition-colors">Legacy Format</span>
                    <FileQuestion className="w-4 h-4 text-purple-400" />
                  </div>
                  <div className="text-2xl font-mono font-bold text-white">{vaultHealth.legacyCount}</div>
                  <p className="text-[11px] text-gray-500">Created before modern metadata structure existed.</p>
                </div>
              </div>

              {/* Action Banner to go to Queue */}
              <div className="p-4 rounded-xl bg-[#141414] border border-white/5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
                    <Info className="w-4 h-4" />
                  </div>
                  <div className="text-xs text-gray-400">
                    <span className="text-white font-medium">Obsidian Safe-Write Guarantee:</span> Metadata recovery only touches frontmatter keys you review and accept. Wikilinks, callouts, and raw note markdown are preserved with 100% fidelity.
                  </div>
                </div>

                <button
                  onClick={() => setActiveTab('queue')}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg bg-white/10 hover:bg-white/15 text-white transition-colors shrink-0"
                >
                  <span>Open Review Queue</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {activeTab === 'queue' && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-5 animate-in fade-in duration-150 h-full">
              {/* Left Column: Recipe List / Queue */}
              <div className="md:col-span-5 flex flex-col space-y-3">
                {/* Filters and Search */}
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter recipes in queue..."
                      className="w-full pl-8 pr-3 py-1.5 text-xs bg-[#0C0C0C] border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                    />
                  </div>

                  <div className="flex items-center gap-1 overflow-x-auto pb-1">
                    {(['all', 'legacy', 'incomplete', 'mostly_complete', 'complete'] as const).map((filterVal) => (
                      <button
                        key={filterVal}
                        onClick={() => setHealthFilter(filterVal)}
                        className={`text-[10px] font-semibold px-2.5 py-1 rounded-md capitalize whitespace-nowrap transition-colors ${
                          healthFilter === filterVal
                            ? 'bg-purple-500 text-black font-bold'
                            : 'bg-[#161616] text-gray-400 hover:text-white border border-white/5'
                        }`}
                      >
                        {filterVal.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </div>

                {/* List of Recipe Reports */}
                <div className="overflow-y-auto space-y-2 max-h-[500px] pr-1">
                  {filteredReports.length === 0 ? (
                    <div className="text-center py-10 text-gray-500 text-xs">
                      No recipes matching this filter.
                    </div>
                  ) : (
                    filteredReports.map((report) => {
                      const isSelected = selectedRecipeId === report.recipeId;
                      return (
                        <div
                          key={report.recipeId}
                          onClick={() => setSelectedRecipeId(report.recipeId)}
                          className={`p-3 rounded-xl border cursor-pointer transition-all ${
                            isSelected
                              ? 'bg-purple-950/30 border-purple-500/50 shadow-xs'
                              : 'bg-[#161616] border-white/5 hover:border-white/20 hover:bg-[#1a1a1a]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <h4 className="font-serif font-bold text-xs text-white truncate">
                                {report.recipeTitle}
                              </h4>
                              <p className="text-[10px] text-gray-500 font-mono truncate mt-0.5">
                                {report.fileName}
                              </p>
                            </div>
                            {getStatusBadge(report.status)}
                          </div>

                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5 text-[10px] text-gray-400">
                            <span>Score: {report.healthScore}%</span>
                            <span>
                              {report.missingFields.length > 0
                                ? `${report.missingFields.length} missing fields`
                                : 'All metadata complete'}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Side-by-Side Diff Inspector & Recovery Action */}
              <div className="md:col-span-7 flex flex-col space-y-4 bg-[#161616] p-4 sm:p-5 rounded-2xl border border-white/10">
                {selectedRecipe && selectedHealthReport ? (
                  <div className="space-y-4">
                    {/* Header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-white/5">
                      <div>
                        <h3 className="font-serif font-bold text-sm text-white">
                          {selectedRecipe.title}
                        </h3>
                        <div className="flex items-center gap-2 mt-1">
                          {getStatusBadge(selectedHealthReport.status)}
                          <span className="text-[10px] text-gray-400">
                            Health Score: <span className="font-mono text-purple-400 font-bold">{selectedHealthReport.healthScore}%</span>
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={() => handleTriggerRecovery(selectedRecipe)}
                        disabled={isRecovering}
                        className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-purple-500 hover:bg-purple-400 text-black disabled:opacity-40 transition-all self-start sm:self-auto shadow-xs"
                      >
                        <Sparkles className={`w-3.5 h-3.5 ${isRecovering ? 'animate-spin' : ''}`} />
                        <span>{isRecovering ? 'Analyzing Recipe...' : 'Analyze & Recover'}</span>
                      </button>
                    </div>

                    {/* Legacy Markers / Missing Badges */}
                    {selectedHealthReport.legacyMarkers.length > 0 && (
                      <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-300 text-xs space-y-1">
                        <div className="font-bold flex items-center gap-1.5 text-[11px]">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Detected Legacy Patterns:</span>
                        </div>
                        <ul className="list-disc list-inside space-y-0.5 text-[10px] text-gray-300">
                          {selectedHealthReport.legacyMarkers.map((marker, i) => (
                            <li key={i}>{marker}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Recovery Error Message */}
                    {recoveryError && (
                      <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                        <span>{recoveryError}</span>
                      </div>
                    )}

                    {/* Diff Inspection View */}
                    {recoveredData ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-xs font-semibold text-gray-300 pb-1 border-b border-white/5">
                          <span>Recovered Metadata Fields</span>
                          <span className="text-[10px] text-gray-500">Check fields to accept into note</span>
                        </div>

                        <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
                          {/* Prep Time */}
                          {recoveredData.prepTime && (
                            <div className="p-3 rounded-xl bg-[#0C0C0C] border border-white/5 flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5">
                                <button
                                  onClick={() => setAcceptedFields((p) => ({ ...p, prepTime: !p.prepTime }))}
                                  className="mt-0.5 text-purple-400"
                                >
                                  {acceptedFields.prepTime ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-gray-600" />}
                                </button>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-300">Prep Time</span>
                                    {getConfidenceBadge(recoveredData.prepTime.confidence)}
                                  </div>
                                  <div className="text-xs font-mono font-bold text-purple-300 mt-0.5">
                                    {recoveredData.prepTime.value}
                                    {selectedRecipe.prepTime && (
                                      <span className="text-[10px] text-gray-500 font-sans font-normal ml-2 line-through">
                                        (was: {selectedRecipe.prepTime})
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-gray-400 mt-1">{recoveredData.prepTime.explanation}</p>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Cook Time */}
                          {recoveredData.cookTime && (
                            <div className="p-3 rounded-xl bg-[#0C0C0C] border border-white/5 flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5">
                                <button
                                  onClick={() => setAcceptedFields((p) => ({ ...p, cookTime: !p.cookTime }))}
                                  className="mt-0.5 text-purple-400"
                                >
                                  {acceptedFields.cookTime ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-gray-600" />}
                                </button>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-300">Cook Time</span>
                                    {getConfidenceBadge(recoveredData.cookTime.confidence)}
                                  </div>
                                  <div className="text-xs font-mono font-bold text-purple-300 mt-0.5">
                                    {recoveredData.cookTime.value}
                                    {selectedRecipe.cookTime && (
                                      <span className="text-[10px] text-gray-500 font-sans font-normal ml-2 line-through">
                                        (was: {selectedRecipe.cookTime})
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-gray-400 mt-1">{recoveredData.cookTime.explanation}</p>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Servings */}
                          {recoveredData.servings && (
                            <div className="p-3 rounded-xl bg-[#0C0C0C] border border-white/5 flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5">
                                <button
                                  onClick={() => setAcceptedFields((p) => ({ ...p, servings: !p.servings }))}
                                  className="mt-0.5 text-purple-400"
                                >
                                  {acceptedFields.servings ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-gray-600" />}
                                </button>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-300">Yield / Servings</span>
                                    {getConfidenceBadge(recoveredData.servings.confidence)}
                                  </div>
                                  <div className="text-xs font-mono font-bold text-purple-300 mt-0.5">
                                    {recoveredData.servings.value} servings
                                    {selectedRecipe.servings && (
                                      <span className="text-[10px] text-gray-500 font-sans font-normal ml-2 line-through">
                                        (was: {selectedRecipe.servings})
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-gray-400 mt-1">{recoveredData.servings.explanation}</p>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Calories & Nutrition */}
                          {recoveredData.calories && (
                            <div className="p-3 rounded-xl bg-[#0C0C0C] border border-white/5 flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5">
                                <button
                                  onClick={() => setAcceptedFields((p) => ({ ...p, calories: !p.calories, nutrition: !p.nutrition }))}
                                  className="mt-0.5 text-purple-400"
                                >
                                  {acceptedFields.calories ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-gray-600" />}
                                </button>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-300">Nutrition &amp; Calories</span>
                                    {getConfidenceBadge(recoveredData.calories.confidence)}
                                  </div>
                                  <div className="text-xs font-mono font-bold text-purple-300 mt-0.5">
                                    ~{recoveredData.calories.value} kcal / serving
                                    {recoveredData.nutrition?.value && (
                                      <span className="text-[10px] text-gray-400 font-sans font-normal ml-2">
                                        (P: {recoveredData.nutrition.value.protein}g | C: {recoveredData.nutrition.value.carbohydrates}g | F: {recoveredData.nutrition.value.fat}g)
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-gray-400 mt-1">{recoveredData.calories.explanation}</p>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Category & Cuisine */}
                          {recoveredData.cuisine && (
                            <div className="p-3 rounded-xl bg-[#0C0C0C] border border-white/5 flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5">
                                <button
                                  onClick={() => setAcceptedFields((p) => ({ ...p, cuisine: !p.cuisine, category: !p.category }))}
                                  className="mt-0.5 text-purple-400"
                                >
                                  {acceptedFields.cuisine ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-gray-600" />}
                                </button>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-300">Cuisine &amp; Category</span>
                                    {getConfidenceBadge(recoveredData.cuisine.confidence)}
                                  </div>
                                  <div className="text-xs font-bold text-purple-300 mt-0.5">
                                    {recoveredData.cuisine.value} • {recoveredData.category?.value || 'General'}
                                  </div>
                                  <p className="text-[10px] text-gray-400 mt-1">{recoveredData.cuisine.explanation}</p>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Suggested Tags */}
                          {recoveredData.suggestedTags && recoveredData.suggestedTags.value.length > 0 && (
                            <div className="p-3 rounded-xl bg-[#0C0C0C] border border-white/5 flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5">
                                <button
                                  onClick={() => setAcceptedFields((p) => ({ ...p, suggestedTags: !p.suggestedTags }))}
                                  className="mt-0.5 text-purple-400"
                                >
                                  {acceptedFields.suggestedTags ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-gray-600" />}
                                </button>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-gray-300">Obsidian Tags</span>
                                    {getConfidenceBadge(recoveredData.suggestedTags.confidence)}
                                  </div>
                                  <div className="flex flex-wrap gap-1.5 mt-1">
                                    {recoveredData.suggestedTags.value.map((t) => (
                                      <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-purple-300 font-mono">
                                        #{t}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Save Selected Fields Button */}
                        <div className="pt-2 flex items-center justify-end gap-2 border-t border-white/5">
                          <button
                            onClick={() => setRecoveredData(null)}
                            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white rounded-lg"
                          >
                            Discard
                          </button>

                          <button
                            onClick={handleSaveRecoveredFields}
                            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black shadow-md shadow-emerald-500/20 transition-all"
                          >
                            <Check className="w-4 h-4" />
                            <span>Save Accepted Fields to Note</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-12 px-4 rounded-xl border border-dashed border-white/10 bg-[#0C0C0C] space-y-3">
                        <Sparkles className="w-8 h-8 mx-auto text-purple-400/60" />
                        <div className="space-y-1">
                          <h4 className="text-xs font-bold text-white">Ready to Analyze Recipe</h4>
                          <p className="text-[11px] text-gray-400 max-w-sm mx-auto">
                            Click <strong className="text-purple-400 font-semibold">"Analyze &amp; Recover"</strong> to parse ingredient amounts and cooking steps for estimated timings, servings, and nutrition.
                          </p>
                        </div>
                        <button
                          onClick={() => handleTriggerRecovery(selectedRecipe)}
                          disabled={isRecovering}
                          className="px-4 py-1.5 text-xs font-bold rounded-lg bg-purple-500 hover:bg-purple-400 text-black transition-all shadow-xs"
                        >
                          Start Analysis
                        </button>
                      </div>
                    )}

                    {/* Image Recovery: finding + Generate/preview/Save flow (2B) */}
                    <RecipeImageFindingView
                      health={imageHealth}
                      canGenerate={canGenerateImage}
                      unavailableReason={imageRecoveryUnavailableReason}
                      recoveryState={imageRecoveryState}
                      busy={imageRecoveryState.phase === 'generating' || imageRecoveryState.phase === 'saving'}
                      onGenerate={handleImageGenerate}
                      onSave={handleImageSave}
                      onRegenerate={handleImageRegenerate}
                      onCancel={handleImageCancel}
                    />
                  </div>
                ) : (
                  <div className="text-center py-16 text-gray-500 text-xs">
                    Select a recipe from the queue to view metadata health and recovery suggestions.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
