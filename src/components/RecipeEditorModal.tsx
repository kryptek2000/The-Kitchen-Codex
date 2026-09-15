import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Save,
  FileCode,
  FileText,
  Plus,
  Trash2,
  Download,
  Check,
  Sparkles,
  Tag,
  Clock,
  Flame,
  Users,
  FolderDown,
  Upload,
  Folder,
  Image as ImageIcon,
  BrainCircuit,
} from 'lucide-react';
import { ObsidianRecipe, ParsedIngredient, RecipeStep, RecipeNutrition, RecoveredRecipeMetadata } from '../types';
import {
  parseObsidianRecipeMarkdown,
  serializeRecipeToObsidianMarkdown,
} from '../utils/markdownParser';
import { saveImageToVaultAssets, saveImageToVaultAssetsCollisionSafe, vaultAssets, type SaveImageDeps } from '../utils/vaultAssets';
import { resolveNewRecipeVaultPath } from '../core/vaultPath';
import { validateGeneratedImage } from '../core/recipeImage';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import { buildAiSelectionRequestOptions } from '../application/aiSelection';
import { useVaultImage } from '../hooks/useVaultImage';
import {
  canApplyNutritionEstimate,
  evaluateMachineNutritionApplicability,
  type NutritionAssessment,
} from '../core/nutritionSanity';
import {
  NUTRITION_INCOMPLETE_MESSAGE,
  NUTRITION_AUTOSAVE_DISABLED_MESSAGE,
} from '../utils/nutrition';
import { RecipeImageChooser, type AiImagePanelState, type RecipeImageChooserMode } from './RecipeImageChooser';
import {
  buildRepresentativeSearchInput,
  findRepresentativeImages,
  mapRepresentativeImageError,
  selectRepresentativeImage,
} from '../application/representativeImage';
import {
  recipeImagePreviewPath,
  requestImageGenerationQuote,
  requestGeneratedRecipeImage,
  fetchGeneratedPreviewBytes,
  mapRecipeImageRecoveryError,
  RecipeImageProviderClientError,
  type RecipeImageGenerationQuote,
} from '../application/recipeImageRecovery';
import { fetchProviderCatalog } from '../application-ui/providerCatalog';
import type {
  RepresentativeImageCandidate,
  RepresentativeImageProvenance,
} from '../core/representativeImage';
import {
  buildRepresentativeImageQuery,
  buildRepresentativeImageSuggestions,
  isRepresentativeImageProvenance,
} from '../core/representativeImage';

interface RecipeEditorModalProps {
  initialRecipe?: ObsidianRecipe | null;
  folderHandle?: any;
  /** Injected asset save dependencies (asset boundary + binary downloader) from the shell. */
  imageService?: SaveImageDeps;
  onSave: (recipe: ObsidianRecipe) => Promise<void> | void;
  /** App-backend API transport (injected by the bootstrap). */
  network: NetworkAdapter;
  onClose: () => void;
  /** Opens AI Settings (used when no image provider is configured). */
  onOpenAiSettings?: () => void;
}

/**
 * Determines the provenance attached to a nutrition block on save.
 *
 * - When the user directly edited a nutrition value (`nutritionDirty`), the
 *   block becomes `user_defined` (a deliberate human action; confidence medium).
 * - Otherwise the existing provenance is preserved verbatim (including the
 *   `undefined` absence for legacy recipes). Opening/editing unrelated metadata
 *   never relabels an existing AI/database/source block.
 */
export function deriveNutritionProvenance(
  nutritionDirty: boolean,
  current: Pick<RecipeNutrition, 'source' | 'confidence' | 'confidenceNote'> | undefined
): Pick<RecipeNutrition, 'source' | 'confidence' | 'confidenceNote'> {
  if (nutritionDirty) {
    // Fresh manual values: drop the old note because it described prior provenance.
    return { source: 'user_defined', confidence: 'medium', confidenceNote: undefined };
  }
  return {
    source: current?.source,
    confidence: current?.confidence,
    confidenceNote: current?.confidenceNote,
  };
}

/** Safe non-nutrition editor fields a metadata recovery may populate. */
export interface RecoveredEditorFieldUpdates {
  prepTime?: string;
  cookTime?: string;
  servings?: number;
  category?: string;
  cuisine?: string;
  difficulty?: 'Easy' | 'Medium' | 'Hard';
}

/** The exact plan the Auto Recover handler applies to editor state. */
export interface RecoveredMetadataApplicationPlan {
  /** Non-nutrition field updates (only when the current value is empty). */
  updates: RecoveredEditorFieldUpdates;
  /** Number of non-nutrition fields that will be applied. */
  recoveredCount: number;
  /** True when the recovery provided machine nutrition and/or calories. */
  hasRecoveredNutrition: boolean;
  /** True ONLY when the centralized contract authorized applying nutrition. */
  nutritionApplicable: boolean;
  /** The authorized whole-recipe nutrition block, or null when omitted. */
  nutrition: RecipeNutrition | null;
  /** True when recovered nutrition/calories were present but omitted. */
  nutritionOmitted: boolean;
}

/**
 * Pure planner for the Auto Recover Metadata handler.
 *
 * Safe non-nutrition metadata is always planned. MACHINE-GENERATED nutrition is
 * passed through the SAME authoritative applicability contract used by the
 * dedicated estimator (`canApplyNutritionEstimate`), NOT through a
 * client-supplied boolean. Because automated machine-nutrition application is
 * intentionally disabled, recovered nutrition is currently omitted entirely and
 * no nutrition field is ever partially written. Existing values are never
 * overwritten (non-nutrition updates are gated on an empty current value).
 */
export function planRecoveredMetadataApplication(
  rec: RecoveredRecipeMetadata,
  current: {
    prepTime?: string;
    cookTime?: string;
    servings?: string | number;
    calories?: string;
    category?: string;
    cuisine?: string;
    difficulty?: string;
  },
  baseServings: number
): RecoveredMetadataApplicationPlan {
  const updates: RecoveredEditorFieldUpdates = {};
  let recoveredCount = 0;

  if (rec.prepTime?.value && !current.prepTime) {
    updates.prepTime = rec.prepTime.value;
    recoveredCount++;
  }
  if (rec.cookTime?.value && !current.cookTime) {
    updates.cookTime = rec.cookTime.value;
    recoveredCount++;
  }
  if (rec.servings?.value && (!current.servings || current.servings === '')) {
    updates.servings = rec.servings.value;
    recoveredCount++;
  }
  if (rec.category?.value && !current.category) {
    updates.category = rec.category.value;
    recoveredCount++;
  }
  if (rec.cuisine?.value && !current.cuisine) {
    updates.cuisine = rec.cuisine.value;
    recoveredCount++;
  }
  if (rec.difficulty?.value && (!current.difficulty || current.difficulty === 'Easy')) {
    updates.difficulty = rec.difficulty.value;
    recoveredCount++;
  }

  const nutritionValue = rec.nutrition?.value as
    | (RecipeNutrition & { assessment?: NutritionAssessment })
    | undefined;
  const hasRecoveredCalories =
    typeof rec.calories?.value === 'number' && Number.isFinite(rec.calories.value);
  const hasRecoveredNutrition = Boolean(nutritionValue) || hasRecoveredCalories;

  let nutritionApplicable = false;
  let nutrition: RecipeNutrition | null = null;
  if (nutritionValue) {
    const nutritionBase =
      typeof nutritionValue.servings === 'number' &&
      Number.isFinite(nutritionValue.servings) &&
      nutritionValue.servings > 0
        ? nutritionValue.servings
        : baseServings;
    nutritionApplicable = canApplyNutritionEstimate(
      nutritionValue,
      nutritionValue.assessment,
      nutritionBase
    ).ok;
    if (nutritionApplicable) {
      nutrition = { ...nutritionValue, servings: nutritionBase };
    }
  }

  return {
    updates,
    recoveredCount,
    hasRecoveredNutrition,
    nutritionApplicable,
    nutrition,
    // A top-level calories-only recovery is part of the same machine nutrition
    // result; it is authorized only together with the nutrition block.
    nutritionOmitted: hasRecoveredNutrition && !nutritionApplicable,
  };
}

export function RecipeEditorModal({
  initialRecipe,
  folderHandle,
  imageService,
  network,
  onSave,
  onClose,
  onOpenAiSettings,
}: RecipeEditorModalProps) {
  const [activeTab, setActiveTab] = useState<'visual' | 'markdown'>('visual');

  // Form State
  const [title, setTitle] = useState(initialRecipe?.title || '');
  const [fileName, setFileName] = useState(initialRecipe?.fileName || 'New Recipe.md');
  const [tagsInput, setTagsInput] = useState(initialRecipe?.tags?.join(', ') || 'food/recipes, dinner');
  const [cuisine, setCuisine] = useState(initialRecipe?.cuisine || '');
  const [category, setCategory] = useState(initialRecipe?.category || '');
  const [prepTime, setPrepTime] = useState(initialRecipe?.prepTime || '');
  const [cookTime, setCookTime] = useState(initialRecipe?.cookTime || '');
  const [servings, setServings] = useState<string | number>(
    initialRecipe?.servings !== undefined ? initialRecipe.servings : ''
  );
  const [difficulty, setDifficulty] = useState<'Easy' | 'Medium' | 'Hard'>(
    initialRecipe?.difficulty || 'Easy'
  );
  const [rating, setRating] = useState(initialRecipe?.rating || 5);
  const [calories, setCalories] = useState(initialRecipe?.calories?.toString() || '');
  const [protein, setProtein] = useState<string>(initialRecipe?.nutrition?.protein?.toString() || '');
  const [carbs, setCarbs] = useState<string>(initialRecipe?.nutrition?.carbohydrates?.toString() || '');
  const [fat, setFat] = useState<string>(initialRecipe?.nutrition?.fat?.toString() || '');
  const [fiber, setFiber] = useState<string>(initialRecipe?.nutrition?.fiber?.toString() || '');
  const [sodium, setSodium] = useState<string>(initialRecipe?.nutrition?.sodium?.toString() || '');
  const [image, setImage] = useState(initialRecipe?.image || '');
  const [isEstimatingNutrition, setIsEstimatingNutrition] = useState(false);
  const [nutritionError, setNutritionError] = useState<string | null>(null);
  const [nutritionSuccess, setNutritionSuccess] = useState(false);
  const [nutritionFromEstimate, setNutritionFromEstimate] = useState(false);
  const [nutritionDirty, setNutritionDirty] = useState(false);
  const [nutritionProvenance, setNutritionProvenance] = useState<
    Pick<RecipeNutrition, 'source' | 'confidence' | 'confidenceNote'>
  >(() => ({
    source: initialRecipe?.nutrition?.source,
    confidence: initialRecipe?.nutrition?.confidence,
    confidenceNote: initialRecipe?.nutrition?.confidenceNote,
  }));
  const [isSavingImageAsset, setIsSavingImageAsset] = useState(false);
  const [isAssetPickerOpen, setIsAssetPickerOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Two-mode image chooser (Phase 2): Licensed Search (default, free) and
  // Generate with AI (explicit). Opening/switching/typing make ZERO provider calls.
  const [imageChooserMode, setImageChooserMode] = useState<RecipeImageChooserMode>('licensed');
  const [representativeOpen, setRepresentativeOpen] = useState(false);
  const [representativeCandidates, setRepresentativeCandidates] = useState<RepresentativeImageCandidate[]>([]);
  const [representativeQuery, setRepresentativeQuery] = useState('');
  const [representativeSearchTerms, setRepresentativeSearchTerms] = useState('');
  const [representativeSuggestions, setRepresentativeSuggestions] = useState<string[]>([]);
  const [representativeBusy, setRepresentativeBusy] = useState(false);
  const [representativeMessage, setRepresentativeMessage] = useState<string | null>(null);
  const [representativeError, setRepresentativeError] = useState<string | null>(null);
  // Monotonic search generation: a NEW search immediately invalidates any prior
  // candidate/preview selection, and a SLOW older response can never overwrite
  // or reauthorize results from a newer search.
  const [representativeSearchGeneration, setRepresentativeSearchGeneration] = useState(0);
  const representativeSearchGenRef = useRef(0);
  // Provenance of the CURRENT image. Initialized from the recipe's frontmatter
  // (a representative image already saved on this recipe).
  const [representativeProvenance, setRepresentativeProvenance] = useState<RepresentativeImageProvenance | null>(() => {
    const existing = initialRecipe?.frontmatter?.['codex_representative_image'];
    return isRepresentativeImageProvenance(existing) ? existing : null;
  });
  // True once the image has been changed through a NON-representative path, so
  // stale representative/generated provenance is removed on save.
  const [imageProvenanceCleared, setImageProvenanceCleared] = useState(false);
  // A selected representative OR AI-generated image whose Asset write is
  // DEFERRED until Save. The discriminator selects the truthful provenance.
  type PendingImage =
    | { kind: 'representative'; blob: Blob; ext: string; provenance: RepresentativeImageProvenance }
    | { kind: 'generated'; blob: Blob; ext: string; provider: string; model: string };
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  // Object URLs created by THIS flow. They are revoked only after React has
  // switched away from them (or on unmount) — never while still active.
  const representativePreviewUrlsRef = useRef<Set<string>>(new Set());
  // Synchronous Save-transaction lock (I1): two clicks can never enter the
  // Asset writer twice. Released on every success and failure path.
  const saveTransactionRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  // Mount liveness (I2): false after unmount so late async completions never
  // create untracked object URLs or touch state.
  const mountedRef = useRef(true);
  // Monotonic preview-operation generation shared by the representative
  // select path (I2): close/replace bumps it so a late selection result is
  // dropped (and any late-created object URL immediately revoked).
  const previewRunRef = useRef(0);
  // Image/provenance state BEFORE the pending representative selection, so a
  // failed Save can restore the original recipe/image state.
  const preRepresentativeRef = useRef<{
    image: string;
    provenance: RepresentativeImageProvenance | null;
    cleared: boolean;
  } | null>(null);

  // ---- Generate with AI (Phase 2) -----------------------------------------
  const [aiPhase, setAiPhase] = useState<AiImagePanelState['phase']>('idle');
  const [aiQuote, setAiQuote] = useState<RecipeImageGenerationQuote | null>(null);
  const [aiPreview, setAiPreview] = useState<{ provider: string; model: string; previewUrl: string } | null>(null);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [aiMessageKind, setAiMessageKind] = useState<'info' | 'error'>('info');
  // undefined = unknown (show the Generate action; the server fails closed).
  const [aiProviderConfigured, setAiProviderConfigured] = useState<boolean | undefined>(undefined);
  const [aiBusy, setAiBusy] = useState(false);
  const aiProviderCheckedRef = useRef(false);
  // Monotonic AI-run generation. Cancel/close/replace bumps it so a late async
  // quote/generation result can never repopulate the panel after the dialog was
  // dismissed (the same liveness pattern as the licensed search).
  const aiRunRef = useRef(0);
  const invalidateAiRun = (): void => {
    aiRunRef.current += 1;
  };
  // The accepted generated preview whose Asset write is DEFERRED until Save.
  const aiPreviewRef = useRef<{
    token: string;
    blob: Blob;
    ext: string;
    provider: string;
    model: string;
    previewUrl: string;
  } | null>(null);
  // Truthful generated-image provenance initialized from the recipe frontmatter.
  const [generatedProvenance, setGeneratedProvenance] = useState<Record<string, unknown> | null>(() => {
    const existing = initialRecipe?.frontmatter?.['codex_generated_image'];
    return existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : null;
  });

  useEffect(() => {
    for (const url of representativePreviewUrlsRef.current) {
      if (url !== image) {
        URL.revokeObjectURL(url);
        representativePreviewUrlsRef.current.delete(url);
      }
    }
  }, [image]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      // Advance every async generation so late quote/generation/byte results
      // can never repopulate a dismissed dialog (I2).
      aiRunRef.current += 1;
      previewRunRef.current += 1;
      representativeSearchGenRef.current += 1;
      for (const url of representativePreviewUrlsRef.current) URL.revokeObjectURL(url);
      representativePreviewUrlsRef.current.clear();
    },
    []
  );

  /**
   * Any NON-representative image change (manual URL, vault picker, upload,
   * Remove Image, AI generation) MUST clear representative provenance so a
   * different image never keeps stale licensing/attribution.
   */
  const setImageManually = (value: string): void => {
    setImage(value);
    setRepresentativeProvenance(null);
    setGeneratedProvenance(null);
    setImageProvenanceCleared(true);
    setPendingImage(null);
    aiPreviewRef.current = null;
    setAiPreview(null);
  };

  const previewImageUrl = useVaultImage(image, folderHandle);

  // Callout
  const [calloutTitle, setCalloutTitle] = useState(
    initialRecipe?.callouts?.[0]?.title || "Chef's Tip"
  );
  const [calloutContent, setCalloutContent] = useState(
    initialRecipe?.callouts?.[0]?.content || ''
  );

  // Ingredients text (line by line)
  const [ingredientsText, setIngredientsText] = useState(
    initialRecipe?.ingredients
      ?.map((i) => i.original)
      .join('\n') || ''
  );

  // Instructions text (numbered or step by step)
  const [instructionsText, setInstructionsText] = useState(
    initialRecipe?.instructions
      ?.map((step) => `${step.stepNumber}. ${step.text}`)
      .join('\n') || ''
  );

  const [notes, setNotes] = useState(initialRecipe?.notes || '');

  // Raw Markdown buffer
  const [rawMarkdown, setRawMarkdown] = useState(initialRecipe?.rawMarkdown || '');

  // Keep markdown synced when switching to markdown tab
  useEffect(() => {
    if (activeTab === 'markdown') {
      const generated = generateCurrentMarkdown();
      setRawMarkdown(generated);
    }
  }, [activeTab]);

  const generateCurrentMarkdown = (
    imageOverride?: string,
    provenanceOverride: RepresentativeImageProvenance | null = representativeProvenance,
    generatedOverride: Record<string, unknown> | null = generatedProvenance
  ): string => {
    const tags = tagsInput.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
    const parsedIngs: ParsedIngredient[] = ingredientsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({
        original: l,
        name: l.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, ''),
      }));

    const parsedSteps: RecipeStep[] = instructionsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l, idx) => ({
        stepNumber: idx + 1,
        text: l.replace(/^\d+\.\s*/, ''),
      }));

    const parsedServings = typeof servings === 'number' ? servings : parseInt(String(servings), 10);
    // Only a total-mode nutrition block carries a serving denominator. Legacy
    // per-serving blocks (no explicit servings from the source) are preserved
    // untouched. New estimates (or blocks that already declare servings) store
    // the editor's current serving count as the denominator.
    const nutritionUsesServings =
      nutritionFromEstimate || typeof initialRecipe?.nutrition?.servings === 'number';
    const nutritionServings =
      nutritionUsesServings && !isNaN(parsedServings) && parsedServings > 0
        ? parsedServings
        : typeof initialRecipe?.nutrition?.servings === 'number'
        ? initialRecipe.nutrition.servings
        : undefined;

    const parsedProtein = protein.trim() ? parseFloat(protein.trim()) : undefined;
    const parsedCarbs = carbs.trim() ? parseFloat(carbs.trim()) : undefined;
    const parsedFat = fat.trim() ? parseFloat(fat.trim()) : undefined;
    const parsedFiber = fiber.trim() ? parseFloat(fiber.trim()) : undefined;
    const parsedSodium = sodium.trim() ? parseFloat(sodium.trim()) : undefined;
    const parsedCalNum = calories.trim() ? parseInt(calories.trim().replace(/\D/g, ''), 10) : undefined;

    const hasNutrition = parsedCalNum || parsedProtein || parsedCarbs || parsedFat || parsedFiber || parsedSodium;

    const partial: Partial<ObsidianRecipe> = {
      title: title || 'Untitled Recipe',
      tags: tags.length > 0 ? tags : ['food/recipes'],
      cuisine: cuisine || 'General',
      category: category || 'Main Course',
      prepTime: prepTime.trim() || undefined,
      cookTime: cookTime.trim() || undefined,
      servings: !isNaN(parsedServings) && parsedServings > 0 ? parsedServings : undefined,
      difficulty,
      rating,
      calories: calories.trim() || (parsedCalNum ? parsedCalNum.toString() : undefined),
      nutrition: hasNutrition
        ? (() => {
            const prov = deriveNutritionProvenance(nutritionDirty, nutritionProvenance);
            return {
              calories: parsedCalNum,
              protein: parsedProtein,
              carbohydrates: parsedCarbs,
              fat: parsedFat,
              fiber: parsedFiber,
              sodium: parsedSodium,
              servings: nutritionServings,
              source: prov.source,
              confidence: prov.confidence,
              confidenceNote: prov.confidenceNote,
            };
          })()
        : undefined,
      image: (imageOverride ?? image) || undefined,
      callouts: calloutContent ? [{ type: 'tip', title: calloutTitle, content: calloutContent }] : [],
      ingredients: parsedIngs,
      instructions: parsedSteps,
      notes: notes || undefined,
      frontmatter: (() => {
        const fm: Record<string, unknown> = { ...(initialRecipe?.frontmatter || {}) };
        if (generatedOverride) {
          // An AI-generated image must not retain stale representative provenance.
          delete fm['codex_representative_image'];
          fm['codex_generated_image'] = generatedOverride;
        } else if (provenanceOverride) {
          // A representative image must not retain stale generated provenance.
          delete fm['codex_generated_image'];
          fm['codex_representative_image'] = provenanceOverride;
        } else if (imageProvenanceCleared) {
          // A non-representative image change clears stale representative AND
          // generated provenance (a different image must not keep stale licensing).
          delete fm['codex_representative_image'];
          delete fm['codex_generated_image'];
        }
        return fm;
      })(),
    };

    return serializeRecipeToObsidianMarkdown(partial);
  };

  const handleEstimateNutrition = async () => {
    setIsEstimatingNutrition(true);
    setNutritionError(null);
    setNutritionSuccess(false);

    try {
      const lines = ingredientsText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      if (lines.length === 0) {
        throw new Error('Please add ingredients before estimating nutrition.');
      }

      const numServings = typeof servings === 'number' ? servings : parseInt(String(servings), 10) || 4;

      const res = await network.post<{ success: boolean; nutrition?: any; error?: string }>(
        '/api/estimate-nutrition',
        {
          title: title || 'Recipe',
          servings: numServings,
          ingredients: lines,
        },
        await buildAiSelectionRequestOptions()
      );

      const data = res.data;
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to estimate nutrition.');
      }

      if (data.nutrition) {
        // FAIL CLOSED: never populate the editor from a machine-generated
        // estimate unless the centralized applicability contract authorizes it.
        const assessment = data.nutrition.assessment;
        const rules = evaluateMachineNutritionApplicability(data.nutrition, assessment, numServings);
        const gate = canApplyNutritionEstimate(data.nutrition, assessment, numServings);
        if (!gate.ok) {
          setNutritionError(rules.ok ? NUTRITION_AUTOSAVE_DISABLED_MESSAGE : NUTRITION_INCOMPLETE_MESSAGE);
          return;
        }
        if (data.nutrition.calories !== undefined) setCalories(data.nutrition.calories.toString());
        if (data.nutrition.protein !== undefined) setProtein(data.nutrition.protein.toString());
        if (data.nutrition.carbohydrates !== undefined) setCarbs(data.nutrition.carbohydrates.toString());
        if (data.nutrition.fat !== undefined) setFat(data.nutrition.fat.toString());
        if (data.nutrition.fiber !== undefined) setFiber(data.nutrition.fiber.toString());
        if (data.nutrition.sodium !== undefined) setSodium(data.nutrition.sodium.toString());
        setNutritionFromEstimate(true);
        setNutritionDirty(false);
        setNutritionProvenance({
          source: data.nutrition.source,
          confidence: data.nutrition.confidence,
          confidenceNote: data.nutrition.confidenceNote,
        });
        setNutritionSuccess(true);
        setTimeout(() => setNutritionSuccess(false), 3000);
      }
    } catch (err: any) {
      setNutritionError(err.message || 'Error estimating nutrition.');
    } finally {
      setIsEstimatingNutrition(false);
    }
  };

  const [isRecoveringMetadata, setIsRecoveringMetadata] = useState(false);
  const [metadataRecoverySuccess, setMetadataRecoverySuccess] = useState<string | null>(null);

  const handleAutoRecoverMetadata = async () => {
    setIsRecoveringMetadata(true);
    setMetadataRecoverySuccess(null);
    setNutritionError(null);

    try {
      const ingList = ingredientsText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((raw) => ({
          original: raw,
          item: raw.replace(/^[-*•\d.]+\s*/, ''),
          amount: 1,
          unit: '',
        }));

      const stepList = instructionsText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((text, idx) => ({
          stepNumber: idx + 1,
          instruction: text.replace(/^\d+[.)]\s*/, ''),
        }));

      const payload = {
        title: title || 'Untitled Recipe',
        rawMarkdown: activeTab === 'markdown' ? rawMarkdown : generateCurrentMarkdown(),
        ingredients: ingList,
        instructions: stepList,
        existingMetadata: {
          prepTime,
          cookTime,
          servings: servings !== '' ? Number(servings) : undefined,
          calories: calories ? Number(calories) : undefined,
          category,
          cuisine,
          difficulty,
        },
      };

      const res = await network.post<{ recovered?: any; error?: string }>(
        '/api/recover-metadata',
        payload,
        await buildAiSelectionRequestOptions()
      );

      if (!res.ok) {
        const d = res.data as { error?: string } | undefined;
        throw new Error(d?.error || `Server error (${res.status})`);
      }

      const data = res.data;
      if (data?.recovered) {
        const rec = data.recovered;
        const recoverBaseServings =
          typeof servings === 'number' ? servings : parseInt(String(servings), 10) || 4;

        // The planner routes recovered nutrition through the SAME centralized
        // applicability contract used by the estimator. Non-nutrition metadata
        // is planned normally; generated nutrition is omitted entirely (never
        // partially written) when the contract does not authorize it.
        const plan = planRecoveredMetadataApplication(
          rec,
          { prepTime, cookTime, servings, calories, category, cuisine, difficulty },
          recoverBaseServings
        );

        if (plan.updates.prepTime !== undefined) setPrepTime(plan.updates.prepTime);
        if (plan.updates.cookTime !== undefined) setCookTime(plan.updates.cookTime);
        if (plan.updates.servings !== undefined) setServings(plan.updates.servings);
        if (plan.updates.category !== undefined) setCategory(plan.updates.category);
        if (plan.updates.cuisine !== undefined) setCuisine(plan.updates.cuisine);
        if (plan.updates.difficulty !== undefined) setDifficulty(plan.updates.difficulty);

        // Only a contract-authorized nutrition block may touch nutrition state.
        if (plan.nutritionApplicable && plan.nutrition) {
          if (plan.nutrition.calories !== undefined) setCalories(plan.nutrition.calories.toString());
          if (plan.nutrition.protein !== undefined) setProtein(plan.nutrition.protein.toString());
          if (plan.nutrition.carbohydrates !== undefined) setCarbs(plan.nutrition.carbohydrates.toString());
          if (plan.nutrition.fat !== undefined) setFat(plan.nutrition.fat.toString());
          if (plan.nutrition.fiber !== undefined) setFiber(plan.nutrition.fiber.toString());
          if (plan.nutrition.sodium !== undefined) setSodium(plan.nutrition.sodium.toString());
          setNutritionFromEstimate(true);
          setNutritionDirty(false);
          setNutritionProvenance({
            source: plan.nutrition.source,
            confidence: plan.nutrition.confidence,
            confidenceNote: plan.nutrition.confidenceNote,
          });
        }

        const omittedNote = plan.nutritionOmitted
          ? ' Generated nutrition was omitted (automatic application disabled).'
          : '';
        setMetadataRecoverySuccess(
          `Recovered ${plan.recoveredCount} metadata fields from recipe text!${omittedNote}`
        );
        setTimeout(() => setMetadataRecoverySuccess(null), 4000);
      }
    } catch (err: any) {
      console.error('Editor metadata recovery error:', err);
      setNutritionError(`Metadata recovery error: ${err.message}`);
    } finally {
      setIsRecoveringMetadata(false);
    }
  };

  /**
   * Runs exactly ONE explicit search for the given terms (server re-sanitizes).
   * Never called on keystroke; only from the initial action or the Search
   * button/Enter in the chooser.
   */
  const runRepresentativeSearch = async (terms: string) => {
    // New generation: immediately drop the OLD result set + any prior selection
    // authority, so nothing from a previous search remains confirmable while
    // this one is in flight (success, no-results, unsafe, or failure alike).
    const generation = representativeSearchGenRef.current + 1;
    representativeSearchGenRef.current = generation;
    setRepresentativeSearchGeneration(generation);
    setRepresentativeCandidates([]);
    setRepresentativeBusy(true);
    setRepresentativeError(null);
    setRepresentativeMessage(null);
    try {
      const result = await findRepresentativeImages(network, { query: terms });
      // A slow OLDER response must never overwrite a NEWER search.
      if (generation !== representativeSearchGenRef.current) return;
      setRepresentativeCandidates(result.candidates);
      setRepresentativeQuery(result.query);
      // Reflect the server-sanitized terms in the editable input.
      setRepresentativeSearchTerms(result.query || terms);
    } catch (err) {
      if (generation !== representativeSearchGenRef.current) return;
      // A failure is NOT a no-results state; keep the user's terms for retry.
      setRepresentativeError(mapRepresentativeImageError(err));
    } finally {
      if (generation === representativeSearchGenRef.current) setRepresentativeBusy(false);
    }
  };

  const handleFindRepresentativeImage = async () => {
    const ingredientLines = ingredientsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const input = buildRepresentativeSearchInput({
      ...(initialRecipe ?? {}),
      title: title || initialRecipe?.title || '',
      cuisine,
      category,
      ingredients: ingredientLines.map((original) => ({ original, name: original })),
    } as ObsidianRecipe);
    if (!input.title) {
      setRepresentativeError('Add a recipe title before searching for a representative image.');
      return;
    }
    // Concise, deterministic, dish-first default query (e.g. "blue cheese
    // smashburger") plus bounded broader suggestions (display only).
    const defaultQuery = buildRepresentativeImageQuery(input);
    setRepresentativeCandidates([]);
    setRepresentativeQuery(defaultQuery);
    setRepresentativeSearchTerms(defaultQuery);
    setRepresentativeSuggestions(buildRepresentativeImageSuggestions(input));
    setRepresentativeError(null);
    setRepresentativeMessage(null);
    setImageChooserMode('licensed');
    setRepresentativeOpen(true);
    await runRepresentativeSearch(defaultQuery);
  };

  /**
   * Opens the chooser in AI mode. Makes ZERO provider calls: the only work is a
   * read-only provider-catalog check (to show the truthful "not configured"
   * state), never an inference request.
   */
  const handleOpenAiImageMode = async () => {
    setImageChooserMode('ai');
    setRepresentativeOpen(true);
    setAiMessage(null);
    if (!aiProviderCheckedRef.current) {
      aiProviderCheckedRef.current = true;
      try {
        const catalog = await fetchProviderCatalog(network);
        const usable = catalog.imageProviders.some(
          (p) => p.selectable || (p.sessionKeySupported && catalog.sessionByokSupported === true)
        );
        setAiProviderConfigured(usable);
      } catch {
        // Unknown -> leave undefined (the server still fails closed).
        setAiProviderConfigured(undefined);
      }
    }
  };

  const handleUseRepresentativeImage = async (candidate: RepresentativeImageCandidate) => {
    // Liveness-guarded (I2): a close/replace during the awaits drops the late
    // result instead of creating an untracked object URL or touching state.
    const run = ++previewRunRef.current;
    setRepresentativeBusy(true);
    setRepresentativeError(null);
    try {
      const selected = await selectRepresentativeImage(network, candidate.id);
      if (run !== previewRunRef.current || !mountedRef.current) return;
      // Capture the pre-selection image/provenance so a failed Save can restore
      // the original recipe/image state.
      preRepresentativeRef.current = { image, provenance: representativeProvenance, cleared: imageProvenanceCleared };
      // The selected representative preview travels the SAME authenticated
      // application binary transport as AI previews (`network.getBytes` with the
      // current in-memory endpoint-access header). An adapter without a binary
      // path FAILS CLOSED with IMAGE_PREVIEW_UNAVAILABLE — there is NO
      // unauthenticated direct-fetch fallback. The vault Asset write is DEFERRED
      // until the user explicitly Saves.
      const viaAdapter = await fetchGeneratedPreviewBytes(network, selected.token);
      if (run !== previewRunRef.current || !mountedRef.current) return;
      if (!viaAdapter) {
        throw new RecipeImageProviderClientError(
          0,
          'The image preview could not be loaded.',
          'IMAGE_PREVIEW_UNAVAILABLE'
        );
      }
      const validated = validateGeneratedImage({ bytes: viaAdapter.bytes, contentType: viaAdapter.contentType });
      if (!validated.valid || !validated.detectedMime) {
        throw new RecipeImageProviderClientError(0, 'The image preview is not a usable image.');
      }
      const blob = new Blob([viaAdapter.bytes.slice()], { type: validated.detectedMime });
      const ext = validated.detectedMime.includes('png')
        ? 'png'
        : selected.contentType.includes('webp')
        ? 'webp'
        : selected.contentType.includes('avif')
        ? 'avif'
        : 'jpg';
      // Local preview only; NO vault write happens here. Track the object URL so
      // it can be revoked after React stops using it (or on unmount). A late
      // (cancelled/unmounted) completion revokes its URL immediately instead of
      // leaking an untracked one.
      const previewUrl = URL.createObjectURL(blob);
      if (run !== previewRunRef.current || !mountedRef.current) {
        URL.revokeObjectURL(previewUrl);
        return;
      }
      setPendingImage({ kind: 'representative', blob, ext, provenance: selected.provenance });
      setRepresentativeProvenance(selected.provenance);
      // A representative image replaces any prior image/provenance on save.
      setImageProvenanceCleared(true);
      representativePreviewUrlsRef.current.add(previewUrl);
      setImage(previewUrl);
      setRepresentativeOpen(false);
      setRepresentativeMessage('Representative image selected. It will be saved when you save the recipe.');
    } catch (err) {
      if (run !== previewRunRef.current || !mountedRef.current) return;
      // Failure preserves the current image; no asset/Markdown change.
      setRepresentativeError(mapRepresentativeImageError(err));
    } finally {
      if (run === previewRunRef.current && mountedRef.current) setRepresentativeBusy(false);
    }
  };

  // ---- Generate with AI handlers (Phase 2) --------------------------------
  const buildAiImageRequest = (): Record<string, unknown> => {
    const ingredientLines = ingredientsText.split('\n').map((l) => l.trim()).filter(Boolean);
    const clean = (value: string, max: number): string => value.trim().slice(0, max);
    const titleValue = clean(title || initialRecipe?.title || 'Recipe', 200);
    const cuisineValue = clean(cuisine, 60);
    const categoryValue = clean(category, 60);
    return {
      title: titleValue,
      ...(ingredientLines.length
        ? { ingredients: ingredientLines.map((l) => l.slice(0, 80)).slice(0, 60) }
        : {}),
      ...(cuisineValue ? { cuisine: cuisineValue } : {}),
      ...(categoryValue ? { course: categoryValue } : {}),
    };
  };

  const extFromContentType = (contentType: string): string =>
    contentType.includes('png')
      ? 'png'
      : contentType.includes('webp')
        ? 'webp'
        : contentType.includes('avif')
          ? 'avif'
          : 'jpg';

  const fetchAiPreviewBlob = async (token: string): Promise<{ blob: Blob; ext: string } | null> => {
    // The generated preview MUST travel the authenticated application binary
    // transport. An adapter without a binary path FAILS CLOSED — there is NO
    // unauthenticated direct-fetch fallback (which would 401 on protected
    // deployments and leak an unauthenticated request otherwise).
    const viaAdapter = await fetchGeneratedPreviewBytes(network, token);
    if (!viaAdapter) return null;
    // Defense-in-depth: revalidate MIME/signature/size before creating an
    // object URL or writing the Asset.
    const validation = validateGeneratedImage({ bytes: viaAdapter.bytes, contentType: viaAdapter.contentType });
    if (!validation.valid || !validation.detectedMime) {
      throw new RecipeImageProviderClientError(0, 'The image preview is not a usable image.');
    }
    return {
      // Copy into a fresh ArrayBuffer-backed view (BlobPart typing).
      blob: new Blob([viaAdapter.bytes.slice()], { type: validation.detectedMime }),
      ext: extFromContentType(validation.detectedMime),
    };
  };

  /** Revokes the transient preview object URL + invalidates its server token. */
  const invalidateAiPreview = (): void => {
    const current = aiPreviewRef.current;
    aiPreviewRef.current = null;
    if (!current) return;
    if (representativePreviewUrlsRef.current.has(current.previewUrl)) {
      URL.revokeObjectURL(current.previewUrl);
      representativePreviewUrlsRef.current.delete(current.previewUrl);
    }
    void network
      .request({ method: 'DELETE', path: recipeImagePreviewPath(current.token) })
      .catch(() => {
        /* best-effort: the token still expires by TTL */
      });
  };

  const runAiGeneration = async (quote: RecipeImageGenerationQuote, run: number): Promise<void> => {
    setAiPhase('generating');
    setAiMessage(null);
    try {
      const body = buildAiImageRequest();
      const generated = await requestGeneratedRecipeImage(
        network,
        body,
        quote.requiresConfirmation ? quote.confirmationToken : undefined
      );
      if (run !== aiRunRef.current || !mountedRef.current) return; // dialog dismissed: drop late result
      const fetched = await fetchAiPreviewBlob(generated.token);
      if (run !== aiRunRef.current || !mountedRef.current) return;
      if (!fetched) {
        throw new RecipeImageProviderClientError(
          0,
          'The image preview could not be loaded.',
          'IMAGE_PREVIEW_UNAVAILABLE'
        );
      }
      const previewUrl = URL.createObjectURL(fetched.blob);
      if (run !== aiRunRef.current || !mountedRef.current) {
        // Late (cancelled/unmounted) completion: never leak an untracked URL.
        URL.revokeObjectURL(previewUrl);
        return;
      }
      representativePreviewUrlsRef.current.add(previewUrl);
      aiPreviewRef.current = {
        token: generated.token,
        blob: fetched.blob,
        ext: fetched.ext,
        provider: generated.provider,
        model: generated.model,
        previewUrl,
      };
      setAiPreview({ provider: generated.provider, model: generated.model, previewUrl });
      setAiPhase('preview');
      setAiBusy(false);
    } catch (err) {
      if (run !== aiRunRef.current || !mountedRef.current) return;
      setAiBusy(false);
      const mapped = mapRecipeImageRecoveryError(err);
      setAiMessage(mapped.message);
      setAiMessageKind('error');
      setAiPhase('error');
      // A consumed/forged token can never authorize a retry: clear the quote.
      setAiQuote(null);
    }
  };

  const handleAiGenerate = async (): Promise<void> => {
    if (aiBusy) return;
    const run = ++aiRunRef.current;
    setAiBusy(true);
    setAiMessage(null);
    setAiPhase('quoting');
    try {
      // The quote carries the SAME canonical generation inputs the generate
      // call will send, so the server can bind the authorization to this exact
      // recipe request (I4). Draft flow: no vault session (explicit no-vault
      // scope server-side).
      const quote = await requestImageGenerationQuote(network, buildAiImageRequest());
      if (run !== aiRunRef.current || !mountedRef.current) return; // dialog dismissed: drop late quote
      setAiQuote(quote);
      if (quote.requiresConfirmation) {
        setAiPhase('confirming');
        setAiBusy(false);
        return;
      }
      await runAiGeneration(quote, run);
    } catch (err) {
      if (run !== aiRunRef.current || !mountedRef.current) return;
      setAiBusy(false);
      const mapped = mapRecipeImageRecoveryError(err);
      setAiMessage(mapped.message);
      setAiMessageKind('error');
      setAiPhase('error');
      if (err instanceof RecipeImageProviderClientError && err.code === 'IMAGE_PROVIDER_NOT_CONFIGURED') {
        setAiProviderConfigured(false);
      }
    }
  };

  const handleAiConfirm = async (): Promise<void> => {
    if (aiBusy || !aiQuote) return;
    const run = ++aiRunRef.current;
    setAiBusy(true);
    await runAiGeneration(aiQuote, run);
  };

  const handleAiRegenerate = async (): Promise<void> => {
    if (aiBusy) return;
    invalidateAiPreview();
    await handleAiGenerate();
  };

  const handleAiCancelPreview = (): void => {
    invalidateAiRun();
    invalidateAiPreview();
    setAiQuote(null);
    setAiMessage(null);
    setAiPhase('idle');
  };

  const handleAiAccept = (): void => {
    const current = aiPreviewRef.current;
    if (!current) return;
    preRepresentativeRef.current = {
      image,
      provenance: representativeProvenance,
      cleared: imageProvenanceCleared,
    };
    setPendingImage({
      kind: 'generated',
      blob: current.blob,
      ext: current.ext,
      provider: current.provider,
      model: current.model,
    });
    setRepresentativeProvenance(null);
    setImageProvenanceCleared(true);
    // The object URL becomes the editor's ACTIVE image; it must NOT be revoked
    // while displayed. It stays tracked so replace/unmount/Save revokes it.
    setImage(current.previewUrl);
    // The server preview token is no longer needed (bytes are local); free it.
    void network
      .request({ method: 'DELETE', path: recipeImagePreviewPath(current.token) })
      .catch(() => {
        /* best-effort */
      });
    aiPreviewRef.current = null;
    setAiPreview(null);
    setAiQuote(null);
    setAiPhase('idle');
    setRepresentativeOpen(false);
  };
  // -------------------------------------------------------------------------

  /** True for a transient preview reference that must never be persisted. */
  const isTransientImageRef = (value: unknown): boolean => {
    if (typeof value !== 'string' || !value) return false;
    return (
      value.startsWith('blob:') ||
      value.startsWith('data:') ||
      value.includes('/api/recipes/image/preview/')
    );
  };

  // Modal-level close (I2): invalidate every in-flight image run BEFORE the
  // parent unmounts, so late quote/generation/selection results cannot change
  // UI state. Object-URL revocation happens in the unmount cleanup; server
  // preview tokens remain TTL-backed.
  const handleCloseModal = (): void => {
    invalidateAiRun();
    previewRunRef.current += 1;
    representativeSearchGenRef.current += 1;
    onClose();
  };

  const handleSave = async () => {
    // Synchronous transaction lock (I1): two clicks can never enter the Asset
    // writer twice. Retry stays available: the lock releases on every path.
    if (saveTransactionRef.current) return;
    saveTransactionRef.current = true;
    setIsSaving(true);
    try {
      return await handleSaveTransaction();
    } finally {
      saveTransactionRef.current = false;
      if (mountedRef.current) setIsSaving(false);
    }
  };

  const handleSaveTransaction = async () => {
    let finalRecipe: ObsidianRecipe;
    let imagePathOverride: string | undefined;
    // Set ONLY when THIS transaction created a new asset (B1 ownership proof).
    // Rollback deletes nothing else — a pre-existing user asset is never
    // modified or removed.
    let createdAssetPath: string | undefined;
    let provenanceOverride: RepresentativeImageProvenance | null = representativeProvenance;
    let generatedOverride: Record<string, unknown> | null = generatedProvenance;

    // Complete pre-save snapshot (B3): restored verbatim if the Asset or recipe
    // Save fails, so a later successful retry can never label the restored
    // original image as newly generated.
    const preSaveSnapshot = {
      image,
      generatedProvenance,
      representativeProvenance,
      imageProvenanceCleared,
      pendingImage,
    };

    // Fail closed BEFORE any write: a transient preview reference must never
    // reach saved Markdown when no pending image will resolve it.
    if (!pendingImage && isTransientImageRef(image)) {
      setSaveError('The image preview is not ready to be saved. Please accept or regenerate the image first.');
      return;
    }

    // Parse + validate the Raw Markdown branch BEFORE writing any Asset: an
    // unparseable raw buffer fails closed with no recipe or Asset write.
    let rawParsed: ObsidianRecipe | null = null;
    if (activeTab === 'markdown') {
      try {
        rawParsed = parseObsidianRecipeMarkdown(
          rawMarkdown,
          fileName.endsWith('.md') ? fileName : `${fileName}.md`,
          // Existing recipe: keep authoritative filePath. New recipe: connected root.
          initialRecipe?.filePath || resolveNewRecipeVaultPath(fileName)
        );
      } catch {
        rawParsed = null;
      }
      if (!rawParsed) {
        setSaveError('The Raw Markdown could not be parsed. Nothing was saved.');
        return;
      }
    }

    // DEFERRED asset write (representative OR AI-generated): only during explicit
    // Save, through the collision-safe writer (B1: never overwrites an existing
    // vault Asset — a deterministic ` (n)` suffix is used instead). The SAME
    // writer and rules apply to AI-generated and representative images.
    if (pendingImage) {
      try {
        // Defense in depth (FLAG): revalidate the exact bytes about to be
        // written before the vault Asset write, even though they were validated
        // at selection time.
        const pendingBytes = new Uint8Array(await pendingImage.blob.arrayBuffer());
        const revalidation = validateGeneratedImage({
          bytes: pendingBytes,
          contentType: pendingImage.blob.type || 'image/jpeg',
        });
        if (!revalidation.valid || !revalidation.detectedMime) {
          throw new Error('invalid-preview-bytes');
        }
        const saved = await saveImageToVaultAssetsCollisionSafe(
          imageService ?? { folderHandle },
          title || 'Recipe',
          pendingImage.blob,
          pendingImage.ext
        );
        if (!saved.success) throw new Error(saved.error || 'save');
        imagePathOverride = saved.relativePath;
        if (saved.createdNew) createdAssetPath = saved.relativePath;
        if (pendingImage.kind === 'representative') {
          provenanceOverride = { ...pendingImage.provenance, localAssetPath: saved.relativePath };
          generatedOverride = null;
          setRepresentativeProvenance(provenanceOverride);
          setGeneratedProvenance(null);
        } else {
          generatedOverride = {
            generated: true,
            provider: pendingImage.provider,
            model: pendingImage.model,
            generated_at: new Date().toISOString(),
          };
          provenanceOverride = null;
          setGeneratedProvenance(generatedOverride);
          setRepresentativeProvenance(null);
        }
        setImage(saved.relativePath);
        setPendingImage(null);
      } catch {
        setSaveError(
          pendingImage.kind === 'representative'
            ? 'The representative image could not be saved. Your current image was kept.'
            : 'The AI-generated image could not be saved. Your current image was kept.'
        );
        return;
      }
    }

    if (activeTab === 'markdown') {
      // Raw `.md` save (B2): the pre-validated parse receives the SAME final
      // image/provenance resolution as the visual path — no blob:/data:/
      // preview-token reference and no stale provenance may enter Markdown.
      const parsed = rawParsed as ObsidianRecipe;
      if (imagePathOverride !== undefined) parsed.image = imagePathOverride;
      const fm: Record<string, unknown> = { ...(parsed.frontmatter || {}) };
      if (generatedOverride) {
        delete fm['codex_representative_image'];
        fm['codex_generated_image'] = generatedOverride;
      } else if (provenanceOverride) {
        delete fm['codex_generated_image'];
        fm['codex_representative_image'] = provenanceOverride;
      } else if (imageProvenanceCleared) {
        delete fm['codex_representative_image'];
        delete fm['codex_generated_image'];
      }
      parsed.frontmatter = fm;
      parsed.rawMarkdown = serializeRecipeToObsidianMarkdown(parsed);
      finalRecipe = parsed;
    } else {
      const md = generateCurrentMarkdown(imagePathOverride, provenanceOverride, generatedOverride);
      const safeName = fileName.endsWith('.md') ? fileName : `${(title || 'New Recipe').replace(/[\/\\?%*:|"<>]/g, '-')}.md`;
      finalRecipe = parseObsidianRecipeMarkdown(
        md,
        safeName,
        // Existing recipe: keep authoritative filePath. New recipe: connected root.
        initialRecipe?.filePath || resolveNewRecipeVaultPath(safeName)
      );
    }

    if (initialRecipe?.id) {
      finalRecipe.id = initialRecipe.id;
    }
    if (initialRecipe?.fileHandle) {
      finalRecipe.fileHandle = initialRecipe.fileHandle;
    }

    setSaveError(null);
    try {
      await onSave(finalRecipe);
    } catch (err: any) {
      let message: string = err?.message || 'Failed to save recipe to the vault.';
      if (createdAssetPath) {
        // Roll back ONLY the asset proven to be created by THIS Save transaction
        // (B1). A pre-existing user asset is never deleted or modified.
        const del = imageService?.asset?.delete;
        if (typeof del === 'function') {
          try {
            await del.call(imageService!.asset, createdAssetPath);
          } catch {
            message =
              'Recipe save failed. A newly created image asset may remain in Assets and may need to be removed manually.';
          }
        } else {
          message =
            'Recipe save failed. A newly created image asset may remain in Assets and may need to be removed manually.';
        }
      }
      // Restore the COMPLETE pre-save snapshot (B3): image, both provenances,
      // cleared flags, and the pending preview. The vault was not changed, and
      // a later successful retry serializes the restored original — never a
      // false generated label on it.
      setImage(preSaveSnapshot.image);
      setGeneratedProvenance(preSaveSnapshot.generatedProvenance);
      setRepresentativeProvenance(preSaveSnapshot.representativeProvenance);
      setImageProvenanceCleared(preSaveSnapshot.imageProvenanceCleared);
      setPendingImage(preSaveSnapshot.pendingImage);
      preRepresentativeRef.current = null;
      setSaveError(message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-[#141414] rounded-2xl border border-white/10 max-w-3xl w-full p-5 sm:p-6 shadow-2xl space-y-5 my-auto max-h-[92vh] flex flex-col text-gray-200">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center font-bold">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-serif font-bold text-white">
                {initialRecipe ? `Edit: ${initialRecipe.title}` : 'Create New Obsidian Recipe Note'}
              </h2>
              <span className="text-xs text-gray-500 font-mono">
                {initialRecipe ? initialRecipe.filePath : fileName}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Tab switch */}
            <div className="flex bg-[#0C0C0C] p-1 rounded-lg border border-white/5 text-xs">
              <button
                onClick={() => setActiveTab('visual')}
                className={`px-2.5 py-1 rounded-md transition-all ${
                  activeTab === 'visual'
                    ? 'bg-white/10 text-amber-400 border border-white/10 shadow-xs font-semibold'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Visual Editor
              </button>
              <button
                onClick={() => setActiveTab('markdown')}
                className={`px-2.5 py-1 rounded-md transition-all ${
                  activeTab === 'markdown'
                    ? 'bg-white/10 text-amber-400 border border-white/10 shadow-xs font-semibold'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Raw .md
              </button>
            </div>

            <button
              onClick={handleCloseModal}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body Content */}
        <div className="overflow-y-auto flex-1 pr-1 space-y-4">
          {activeTab === 'markdown' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>Direct Obsidian Markdown &amp; Frontmatter</span>
                <span className="font-mono text-[11px] text-amber-400">YAML + Wikilinks [[...]]</span>
              </div>
              <textarea
                id="raw-markdown-editor"
                value={rawMarkdown}
                onChange={(e) => setRawMarkdown(e.target.value)}
                rows={18}
                className="w-full font-mono text-xs p-3.5 bg-[#0C0C0C] text-gray-200 rounded-xl border border-white/10 focus:outline-none focus:border-amber-500 selection:bg-amber-500/30 selection:text-amber-200"
                placeholder="---\ntitle: ...\n---\n# Recipe Title..."
              />
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              {/* Quick AI Metadata Recovery Toolbar Button */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-purple-950/20 border border-purple-500/30 text-purple-200">
                <div className="flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-purple-400 shrink-0" />
                  <span className="text-[11px]">
                    Vault Intelligence: Auto-estimate prep/cook times, servings, and macros from ingredients and steps.
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleAutoRecoverMetadata}
                  disabled={isRecoveringMetadata || (!ingredientsText && !instructionsText)}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-lg bg-purple-500 hover:bg-purple-400 text-black disabled:opacity-40 transition-all shadow-xs cursor-pointer"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${isRecoveringMetadata ? 'animate-spin' : ''}`} />
                  <span>{isRecoveringMetadata ? 'Analyzing...' : 'Auto-Fill Missing Fields'}</span>
                </button>
              </div>

              {metadataRecoverySuccess && (
                <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span>{metadataRecoverySuccess}</span>
                </div>
              )}

              {/* Title & File Name */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-gray-300 mb-1">
                    Recipe Title
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      if (!initialRecipe) {
                        setFileName(`${e.target.value.replace(/[\/\\?%*:|"<>]/g, '-')}.md`);
                      }
                    }}
                    placeholder="e.g. Sourdough Rosemary Focaccia"
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-white font-medium focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-medium text-gray-300 mb-1">
                    Obsidian File Name
                  </label>
                  <input
                    type="text"
                    value={fileName}
                    onChange={(e) => setFileName(e.target.value)}
                    placeholder="e.g. Sourdough Focaccia.md"
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 font-mono text-gray-300 focus:border-amber-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Frontmatter row 1: Tags, Cuisine, Category */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-gray-300 mb-1">
                    Tags (comma separated)
                  </label>
                  <input
                    type="text"
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    placeholder="food/recipes, dinner, italian"
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 font-mono text-gray-300 focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-medium text-gray-300 mb-1">
                    Cuisine
                  </label>
                  <input
                    type="text"
                    value={cuisine}
                    onChange={(e) => setCuisine(e.target.value)}
                    placeholder="Italian, Japanese, etc."
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-medium text-gray-300 mb-1">
                    Category
                  </label>
                  <input
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="Main Course, Baking, Soup"
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 focus:border-amber-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Frontmatter row 2: Prep, Cook, Servings, Calories, Difficulty */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div>
                  <label className="block font-medium text-gray-300 mb-1">Prep Time</label>
                  <input
                    type="text"
                    value={prepTime}
                    onChange={(e) => setPrepTime(e.target.value)}
                    placeholder="e.g. 15 mins"
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 font-mono focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-medium text-gray-300 mb-1">Cook Time</label>
                  <input
                    type="text"
                    value={cookTime}
                    onChange={(e) => setCookTime(e.target.value)}
                    placeholder="e.g. 30 mins"
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 font-mono focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-medium text-gray-300 mb-1">Servings</label>
                  <input
                    type="number"
                    value={servings}
                    onChange={(e) => setServings(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                    min={1}
                    placeholder="e.g. 4"
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 font-mono focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-medium text-gray-300 mb-1">Calories (kcal)</label>
                  <input
                    type="text"
                    value={calories}
                    onChange={(e) => { setCalories(e.target.value); setNutritionDirty(true); }}
                    placeholder="e.g. 520"
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 font-mono focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-medium text-gray-300 mb-1">Difficulty</label>
                  <select
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value as any)}
                    className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 focus:border-amber-500 focus:outline-none"
                  >
                    <option value="Easy">Easy</option>
                    <option value="Medium">Medium</option>
                    <option value="Hard">Hard</option>
                  </select>
                </div>
              </div>

              {/* Nutrition & Macros Breakdown Box */}
              <div className="p-3.5 rounded-xl bg-[#0F0F0F] border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-white">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    <span>Nutrition &amp; Macros (per serving)</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleEstimateNutrition}
                    disabled={isEstimatingNutrition}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition-colors disabled:opacity-50"
                  >
                    <Sparkles className={`w-3.5 h-3.5 ${isEstimatingNutrition ? 'animate-spin' : ''}`} />
                    <span>{isEstimatingNutrition ? 'Analyzing Ingredients...' : 'Estimate Nutrition (AI)'}</span>
                  </button>
                </div>

                {nutritionError && (
                  <p className="text-[11px] text-rose-300 bg-rose-950/40 p-2 rounded-lg border border-rose-800/40">
                    {nutritionError}
                  </p>
                )}
                {nutritionSuccess && (
                  <p className="text-[11px] text-emerald-300 bg-emerald-950/40 p-2 rounded-lg border border-emerald-800/40">
                    Nutrition &amp; macros successfully estimated and populated!
                  </p>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">Protein (g)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={protein}
                      onChange={(e) => { setProtein(e.target.value); setNutritionDirty(true); }}
                      placeholder="e.g. 32"
                      className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-emerald-400 font-mono focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">Carbs (g)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={carbs}
                      onChange={(e) => { setCarbs(e.target.value); setNutritionDirty(true); }}
                      placeholder="e.g. 45"
                      className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-blue-400 font-mono focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">Fat (g)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={fat}
                      onChange={(e) => { setFat(e.target.value); setNutritionDirty(true); }}
                      placeholder="e.g. 18"
                      className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-amber-400 font-mono focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">Fiber (g)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={fiber}
                      onChange={(e) => { setFiber(e.target.value); setNutritionDirty(true); }}
                      placeholder="e.g. 6"
                      className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-purple-400 font-mono focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">Sodium (mg)</label>
                    <input
                      type="number"
                      value={sodium}
                      onChange={(e) => { setSodium(e.target.value); setNutritionDirty(true); }}
                      placeholder="e.g. 580"
                      className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-orange-400 font-mono focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Recipe Cover Image URL or Vault Asset */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block font-medium text-gray-300">
                    Recipe Food Image (Vault Asset or Web URL)
                  </label>
                  <div className="flex items-center gap-1.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setIsAssetPickerOpen(!isAssetPickerOpen)}
                      className="px-2 py-1 bg-white/5 hover:bg-white/10 text-amber-300 border border-white/10 rounded-md flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <Folder className="w-3 h-3 text-amber-400" />
                      <span>Vault Assets ({vaultAssets.getAll().length})</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="px-2 py-1 bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 rounded-md flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <Upload className="w-3 h-3 text-amber-400" />
                      <span>Upload to Assets/</span>
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          try {
                            setIsSavingImageAsset(true);
                            const saved = await saveImageToVaultAssets(imageService ?? { folderHandle }, title || 'Recipe', file);
                            setImageManually(saved.relativePath);
                          } catch (err: any) {
                            console.error('Failed to upload image to vault Assets/:', err);
                          } finally {
                            setIsSavingImageAsset(false);
                            if (fileInputRef.current) fileInputRef.current.value = '';
                          }
                        }
                      }}
                    />
                  </div>
                </div>

                {isAssetPickerOpen && (
                  <div className="p-3 bg-[#0A0A0A] border border-amber-500/30 rounded-xl space-y-2 max-h-48 overflow-y-auto">
                    <div className="flex items-center justify-between text-xs text-amber-400 font-semibold pb-1 border-b border-white/5">
                      <span>Select Image from Obsidian Assets</span>
                      <button
                        type="button"
                        onClick={() => setIsAssetPickerOpen(false)}
                        className="text-gray-400 hover:text-white"
                      >
                        ✕
                      </button>
                    </div>
                    {vaultAssets.getAll().length === 0 ? (
                      <p className="text-xs text-gray-500 py-2 text-center">
                        No image assets currently cached in vault. Upload an image or add files to your vault's Assets/ folder.
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                        {vaultAssets.getAll().map((item) => (
                          <button
                            key={item.path}
                            type="button"
                            onClick={() => {
                              setImageManually(item.path);
                              setIsAssetPickerOpen(false);
                            }}
                            className={`group text-left p-1.5 rounded-lg border transition-all flex flex-col gap-1 items-center bg-[#141414] ${
                              image === item.path ? 'border-amber-500 bg-amber-500/10' : 'border-white/5 hover:border-white/20'
                            }`}
                          >
                            <div className="w-full h-16 rounded bg-black/60 overflow-hidden">
                              <img
                                src={item.blobUrl}
                                alt={item.fileName}
                                className="w-full h-full object-cover"
                              />
                            </div>
                            <span className="text-[10px] text-gray-300 truncate w-full font-mono text-center group-hover:text-amber-300">
                              {item.fileName}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={image}
                    onChange={(e) => setImageManually(e.target.value)}
                    placeholder="Assets/filename.jpg or https://... food photo URL"
                    className="flex-1 bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 font-mono text-xs focus:border-amber-500 focus:outline-none"
                  />
                  {image && (image.startsWith('http://') || image.startsWith('https://')) && (
                    <button
                      type="button"
                      disabled={isSavingImageAsset}
                      onClick={async () => {
                        try {
                          setIsSavingImageAsset(true);
                          const saved = await saveImageToVaultAssets(imageService ?? { folderHandle }, title || 'Recipe', image);
                          setImageManually(saved.relativePath);
                        } catch (err: any) {
                          console.error('Failed to download image to Assets/:', err);
                        } finally {
                          setIsSavingImageAsset(false);
                        }
                      }}
                      className="px-2.5 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors shrink-0 disabled:opacity-50 cursor-pointer"
                      title="Save remote image permanently to vault Assets/ folder"
                    >
                      <FolderDown className="w-3.5 h-3.5" />
                      <span>{isSavingImageAsset ? 'Saving...' : 'Save to Assets/'}</span>
                    </button>
                  )}
                  {previewImageUrl && (
                    <div className="w-10 h-10 rounded-lg overflow-hidden border border-white/15 shrink-0 bg-black">
                      <img
                        src={previewImageUrl}
                        alt="Preview"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                </div>

                {/* Explicit image-source actions (Phase 2): licensed search is the
                    free default; Generate with AI is an explicit opt-in. Opening
                    either makes ZERO provider calls. */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    data-testid="find-representative-image"
                    onClick={handleFindRepresentativeImage}
                    disabled={representativeBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/30 transition-colors disabled:opacity-50"
                  >
                    <ImageIcon className="w-3.5 h-3.5" />
                    <span>{representativeBusy ? 'Searching…' : 'Find Representative Image'}</span>
                  </button>
                  <button
                    type="button"
                    data-testid="generate-image-ai"
                    onClick={handleOpenAiImageMode}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Generate with AI</span>
                  </button>
                  {representativeMessage && (
                    <span className="text-[11px] text-gray-400">{representativeMessage}</span>
                  )}
                </div>

                {/* Truthful image provenance (never a copyright/accuracy claim). */}
                {generatedProvenance && !imageProvenanceCleared && (
                  <p className="text-[10px] text-purple-300" data-testid="generated-image-provenance">
                    AI-generated · {String(generatedProvenance['provider'] ?? 'unknown')} ·{' '}
                    {String(generatedProvenance['model'] ?? 'unknown')}
                    {generatedProvenance['generated_at'] ? ` · ${String(generatedProvenance['generated_at'])}` : ''}
                  </p>
                )}
                {representativeProvenance && !imageProvenanceCleared && (
                  <p className="text-[10px] text-emerald-300" data-testid="representative-image-provenance">
                    Representative image · {representativeProvenance.source}
                    {representativeProvenance.creator ? ` · ${representativeProvenance.creator}` : ''} ·{' '}
                    {representativeProvenance.license}
                  </p>
                )}
              </div>

              {/* Obsidian Callout Box */}
              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-amber-300">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>Obsidian Callout &gt; [!tip]</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input
                    type="text"
                    value={calloutTitle}
                    onChange={(e) => setCalloutTitle(e.target.value)}
                    placeholder="Callout Title (e.g. Chef's Tip)"
                    className="bg-[#0C0C0C] border border-white/10 rounded-lg p-1.5 text-white font-medium focus:border-amber-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    value={calloutContent}
                    onChange={(e) => setCalloutContent(e.target.value)}
                    placeholder="Callout content or secret..."
                    className="sm:col-span-2 bg-[#0C0C0C] border border-white/10 rounded-lg p-1.5 text-gray-300 focus:border-amber-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Ingredients Textarea with Wikilink support */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium text-gray-300">
                    Ingredients (one per line, supports [[Wikilinks]])
                  </label>
                  <span className="text-[11px] text-amber-400 font-mono">
                    - [ ] amount unit [[Ingredient]]
                  </span>
                </div>
                <textarea
                  value={ingredientsText}
                  onChange={(e) => setIngredientsText(e.target.value)}
                  rows={5}
                  className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2.5 font-mono text-gray-300 focus:border-amber-500 focus:outline-none"
                  placeholder="- [ ] 2 tbsp [[Olive Oil]]\n- [ ] 3 cloves [[Garlic]]"
                />
              </div>

              {/* Instructions Textarea */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium text-gray-300">
                    Instructions (one step per line)
                  </label>
                  <span className="text-[11px] text-gray-500">
                    Mention durations like &quot;bake for 20 mins&quot; for auto-timers
                  </span>
                </div>
                <textarea
                  value={instructionsText}
                  onChange={(e) => setInstructionsText(e.target.value)}
                  rows={5}
                  className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2.5 text-gray-300 focus:border-amber-500 focus:outline-none"
                  placeholder="1. Prep ingredients.\n2. Sauté for 5 minutes."
                />
              </div>

              {/* Notes */}
              <div>
                <label className="block font-medium text-gray-300 mb-1">
                  Notes, Pairings &amp; Variations
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full bg-[#0C0C0C] border border-white/10 rounded-lg p-2 text-gray-300 focus:border-amber-500 focus:outline-none"
                  placeholder="Storage tips, wine pairings..."
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        {saveError && (
          <div className="mx-4 px-3 py-2 rounded-xl bg-rose-950/40 border border-rose-500/40 text-rose-200 text-xs flex items-center gap-2">
            <span>⚠️</span>
            <span className="flex-1">{saveError}</span>
            <button
              type="button"
              onClick={() => setSaveError(null)}
              className="text-rose-300 hover:text-white text-[11px] underline"
            >
              Dismiss
            </button>
          </div>
        )}
        <div className="pt-3 border-t border-white/5 flex items-center justify-between gap-2">
          <button
            onClick={handleCloseModal}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>

          <button
            id="save-recipe-modal-btn"
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold shadow-md shadow-amber-500/20 transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? 'Saving…' : 'Save Obsidian Note'}</span>
          </button>
        </div>
      </div>

      {representativeOpen && (
        <RecipeImageChooser
          defaultMode={imageChooserMode}
          licensed={{
            candidates: representativeCandidates,
            query: representativeQuery,
            searchTerms: representativeSearchTerms,
            suggestions: representativeSuggestions,
            searchGeneration: representativeSearchGeneration,
            busy: representativeBusy,
            message: representativeError ?? representativeMessage,
            messageKind: representativeError ? 'error' : 'info',
            onSearch: runRepresentativeSearch,
            onSelect: handleUseRepresentativeImage,
            network,
            onCancel: () => {
              setRepresentativeOpen(false);
              setRepresentativeError(null);
            },
          }}
          ai={{
            phase: aiPhase,
            quote: aiQuote,
            preview: aiPreview,
            message: aiMessage,
            messageKind: aiMessageKind,
            providerConfigured: aiProviderConfigured,
          }}
          onAiGenerate={handleAiGenerate}
          onAiConfirm={handleAiConfirm}
          onAiAccept={handleAiAccept}
          onAiRegenerate={handleAiRegenerate}
          onAiCancelPreview={handleAiCancelPreview}
          onOpenAiSettings={onOpenAiSettings}
          onCancel={() => {
            invalidateAiRun();
            invalidateAiPreview();
            setAiQuote(null);
            setAiMessage(null);
            setAiPhase('idle');
            setRepresentativeOpen(false);
            setRepresentativeError(null);
          }}
        />
      )}
    </div>
  );
}
