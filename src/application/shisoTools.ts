/**
 * The Kitchen Codex — SHISO capabilities (browser side).
 *
 * Every capability SHISO can request is executed HERE, in the browser, against
 * the genuine authorities:
 *
 *   - the current recipe and Advanced Nutrition working state, which the
 *     application already owns;
 *   - the authenticated pinned USDA bundle, which is composed and verified in
 *     the browser and which no server module can read.
 *
 * This split is the whole safety story. The model asks; this module does. It
 * returns BOUNDED, VERIFIED observations and never invents one. In particular:
 *
 *   - a food identity always comes from `session.searchFoods` /
 *     `session.reviewIngredient`, never from the model;
 *   - a gram weight always comes from an authenticated portion record, never
 *     from a model number;
 *   - a record that has no usable portion is reported as exactly that, so SHISO
 *     can explain the limitation instead of inventing a number.
 *
 * Every network/analysis call is delegated through an application port owned by
 * the surface that holds the live review. No tool can write to disk or reach the
 * Vault; `complete_nutrition` only prepares proposals in the UNSAVED review.
 */

import {
  SHISO_LIMITS,
  type ShisoAnalysisOutcome,
  type ShisoNutritionCorrectionsOutcome,
  type ShisoNutritionSourceSelectionOutcome,
  type ShisoObservation,
  type ShisoObservationFailureCode,
  type ShisoRecipeEditOutcome,
  type ShisoRecipeSaveOutcome,
  type ShisoToolArgs,
  type ShisoIngredientEditArgs,
} from '../core/shiso/protocol';
import { runBatchInvestigation } from '../core/shiso/batchInvestigation';

import {
  adaptRecipe,
  analyzeRecipe,
  candidateIdentityVerdict,
  projectCulinaryIngredient,
  projectIngredientAlternatives,
  selectDeterministicVolumePortionIndex,
  type AdvancedNutritionSession,
} from '../core/nutritionV2/phase4';
import { buildPortionChoice } from '../core/nutritionV2/phase4/portion';
import {
  buildBrandedContribution,
  type BrandedLookupTarget,
  type UsdaBrandedFoodCandidate,
} from '../core/nutritionV2/brandedFoods';
import type { LiveRowState } from '../core/nutritionV2/phase4/liveRow';
import { bestEffortDiscoveryCandidates, completionLookupTarget } from '../core/nutritionV2/phase4/rows';
import { sumNutrientSupplements, validateAiNutrientSupplements, type AiNutrientContribution, type AiNutrientSupplement } from '../core/nutritionV2/aiContribution';
import { NUTRIENT_REGISTRY, type NutrientId } from '../core/nutritionV2/nutrients';
import { deriveNutritionCoverage, nutritionCoverageSummary, type EffectiveNutritionLine, type NutritionCoverage, type ShisoNutrientCoverageEntry } from '../core/shiso/nutritionCoverage';
import type { ResearchTarget } from '../core/nutritionV2/aiResearch';
import type { ShisoVaultCapability } from './shisoVaultCapabilities';

export interface ShisoBrandedSearchOutcome {
  readonly ok: boolean;
  readonly candidates?: ReadonlyArray<UsdaBrandedFoodCandidate>;
  readonly message?: string;
  readonly code?: string;
}

export interface ShisoNutrientGapFocus {
  readonly line_ref: string;
  readonly unknown_nutrients: readonly string[];
}

export interface ShisoAiNutritionOptions {
  /** Default true. Gap-fill passes set false and let completeNutrition merge once. */
  readonly apply?: boolean;
  readonly nutrientGapFocus?: readonly ShisoNutrientGapFocus[];
}

export interface ShisoExternalResearchOutcome {
  readonly ok: boolean;
  readonly contributions?: ReadonlyArray<AiNutrientContribution>;
  readonly sources?: ReadonlyArray<{ readonly title: string; readonly url: string }>;
  readonly skipped?: ReadonlyArray<{ readonly line_ref: string; readonly reason: string }>;
  readonly message?: string;
  readonly code?: string;
}

/** Everything a capability may read. Supplied by the application, never the model. */
export interface ShisoToolContext {
  /** Application-owned, read-only Vault capabilities. Absent fails closed. */
  readonly vault?: ShisoVaultCapability;
  /** App-shell handoff that binds a selected capability recipe to the normal
   * recipe/review owner. The capability itself remains read-only. */
  readonly onVaultRecipeSelected?: ((recipeId: string) => void) | undefined;
  /** Live status of the existing authenticated USDA bundle controller. */
  readonly catalogueStatus?: 'idle' | 'loading' | 'ready' | 'failed' | 'unsupported';
  readonly session: AdvancedNutritionSession | null;
  readonly recipe: {
    readonly title: string;
    readonly description?: string;
    readonly servings: number | null;
    readonly category?: string;
    readonly cuisine?: string;
    readonly difficulty?: string;
    readonly tags?: readonly string[];
    readonly prepTime?: string;
    readonly cookTime?: string;
    readonly totalTime?: string;
    readonly ingredients: ReadonlyArray<{
      readonly text: string;
      readonly name: string;
      readonly amount?: number | null;
      readonly unit?: string;
      readonly preparation?: string;
      /** H-2 stable handle for edits; null when the recipe cannot be adapted. */
      readonly line_ref?: string | null;
    }>;
    readonly instructions: ReadonlyArray<{ readonly text: string; readonly step_ref?: string }>;
  } | null;
  readonly nutrition: {
    readonly rows: ReadonlyArray<LiveRowState>;
    /** The current Phase 4 review rows, including authenticated review digests. */
    readonly reviewRows?: ReadonlyArray<import('../core/nutritionV2/phase4').Phase4Row>;
    readonly aiContributions?: ReadonlyArray<AiNutrientContribution>;
    readonly summary: string | null;
    readonly unsaved: boolean;
    /** Canonical ingredient digest of the open review, when available. */
    readonly recipeDigest?: string | null;
    /** Current review/session identity (same canonical binding as Apply). */
    readonly reviewIdentity?: string;
    /** Whole-recipe 34-nutrient coverage from the existing calculated preview. */
    readonly nutrientCoverage?: ReadonlyArray<ShisoNutrientCoverageEntry>;
    /** Accepted supplemental AI estimates for source-backed nutrient gaps. */
    readonly nutrientSupplements?: ReadonlyArray<AiNutrientSupplement>;
  } | null;
  /**
   * SINC-3 ports. They are supplied by the surface that owns the live review
   * and the existing Advanced Nutrition transports. Absent means the
   * corresponding source is unavailable; Shiso reports that honestly and
   * continues with the next stage instead of inventing evidence.
   */
  readonly searchBrandedFoods?: ((args: {
    readonly lineRef: string;
    readonly query: string;
    readonly signal?: AbortSignal;
  }) => Promise<ShisoBrandedSearchOutcome>) | undefined;
  readonly researchNutrition?: ((args: {
    readonly targets: ReadonlyArray<ResearchTarget>;
    readonly lineRefs: ReadonlyArray<string>;
    readonly lineTextByRef: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }) => Promise<ShisoExternalResearchOutcome>) | undefined;
  /** Accepts prepared contributions into the UNSAVED working review. */
  readonly acceptNutritionContributions?:
    | ((contributions: ReadonlyArray<AiNutrientContribution>, supplements?: ReadonlyArray<AiNutrientSupplement>) => boolean)
    | undefined;
  /** Current eligible line refs, owned by the Advanced Nutrition review. */
  readonly researchEligibleRefs?: ReadonlyArray<string> | undefined;
  readonly brandedEligibleRefs?: ReadonlyArray<string> | undefined;
  /**
   * Runs the EXISTING Advanced Nutrition analysis through the component that
   * owns it. Registered by that owner; absent means Advanced Nutrition is not
   * open, and SHISO says so instead of simulating a result.
   */
  readonly runAnalysis?: ((signal?: AbortSignal) => Promise<ShisoAnalysisOutcome>) | undefined;
  /** Structured whole-recipe or nutrient-gap AI contribution pass, independently validated by the application. */
  readonly runAiNutrition?: ((signal?: AbortSignal, options?: ShisoAiNutritionOptions) => Promise<{ readonly ok: boolean; readonly contributions?: readonly AiNutrientContribution[]; readonly totals?: Readonly<Record<string, unknown>>; readonly message?: string }>) | undefined;
  /**
   * H-1F. Loads the authenticated USDA bundle through the EXISTING application
   * controller (`useAdvancedNutritionBundle().load`).
   *
   * This is not a new authority and not a bypass: it is the very same button the
   * user would press. The application deliberately NEVER loads the catalogue at
   * startup, which is precisely why "generate nutrition" failed from the recipe
   * page. Offering this lets SHISO clear the one genuine prerequisite itself
   * instead of failing and telling the user to go and do it.
   */
  readonly loadBundle?: (() => Promise<AdvancedNutritionSession | null | void>) | undefined;
  /**
   * H-2. Applies structured ingredient edits to the UNSAVED working recipe
   * through the application's own editor/state owner. Registered by that owner;
   * absent means no recipe surface is mounted, and Shiso reports that honestly
   * instead of pretending a change happened.
   */
  readonly applyIngredientEdits?:
    | ((edits: readonly ShisoIngredientEditArgs[]) => Promise<ShisoRecipeEditOutcome>)
    | undefined;
  /**
   * H-2. Applies every supported AUTHENTICATED nutrition correction to the
   * working review through the component that owns the Phase 4 reducer, then
   * recalculates through the existing engine. Absent means the nutrition owner
   * is not mounted.
   */
  readonly applyNutritionCorrections?:
    | ((lineRefs: readonly string[] | undefined) => Promise<ShisoNutritionCorrectionsOutcome>)
    | undefined;
  /** Promotes one authenticated USDA food + portion through the Phase 4 owner. */
  readonly applyNutritionSourceSelection?:
    | ((input: { readonly lineRef: string; readonly fdcId: number; readonly portionIndex: number }) => Promise<ShisoNutritionSourceSelectionOutcome>)
    | undefined;
  /** F3. Applies the application-owned SHISO nutrition review to the unsaved recipe. */
  readonly applyNutritionReview?: (() => Promise<{
    readonly ok: boolean;
    readonly applied: boolean;
    readonly message: string;
  }>) | undefined;
  /**
   * H-2. Persists the UNSAVED working recipe through the EXISTING application
   * save path. Registered by the application shell; it fails closed when there
   * is nothing unsaved. Explicit user save authorization is required before the
   * model is allowed to call this.
   */
  readonly saveWorkingRecipe?: (() => Promise<ShisoRecipeSaveOutcome>) | undefined;
  /**
   * Trusted current-user directive for an equal authored alternative. The
   * model cannot set this; the conversation surface derives it from the user
   * message and the authenticated selected record label.
   */
  readonly isTrustedNutritionSourceSelection?: ((lineRef: string, description: string) => boolean) | undefined;
}

function ok(
  tool: ShisoObservation['tool'],
  summary: string,
  data: Record<string, unknown>,
): ShisoObservation {
  return { ok: true, tool, summary, data: Object.freeze(data) };
}

function fail(
  tool: ShisoObservation['tool'],
  code: Extract<ShisoObservation, { ok: false }>['code'],
  message: string,
): ShisoObservation {
  return { ok: false, tool, code, message };
}

// ---------------------------------------------------------------------------

function getCurrentRecipe(
  ctx: ShisoToolContext,
  instructionOffset = 0,
  instructionLimit = 12,
): ShisoObservation {
  const recipe = ctx.recipe ?? ctx.vault?.getSelectedRecipe();
  if (recipe === null || recipe === undefined) {
    return fail('get_current_recipe', 'no_active_recipe', 'No recipe is currently open.');
  }
  const totalSteps = recipe.instructions.length;
  const offset = Math.max(0, Math.min(totalSteps, Math.floor(instructionOffset)));
  const limit = Math.max(1, Math.min(SHISO_LIMITS.maxInstructionPage, Math.floor(instructionLimit)));
  const page = recipe.instructions.slice(offset, offset + limit).map((step, index) => ({
    index: offset + index,
    text: step.text.slice(0, SHISO_LIMITS.maxInstructionTextChars),
    step_ref: typeof step.step_ref === 'string' ? step.step_ref : `step:${offset + index}`,
    text_truncated: step.text.length > SHISO_LIMITS.maxInstructionTextChars,
  }));
  const returned = page.length;
  const nextOffset = offset + returned;
  const instructionsComplete = nextOffset >= totalSteps;
  return ok('get_current_recipe', `${recipe.title} — ${recipe.ingredients.length} ingredients, ${totalSteps} step(s)`, {
    title: recipe.title,
    ...(recipe.description !== undefined ? { description: recipe.description } : {}),
    servings: recipe.servings,
    ...(recipe.category !== undefined ? { category: recipe.category } : {}),
    ...(recipe.cuisine !== undefined ? { cuisine: recipe.cuisine } : {}),
    ...(recipe.difficulty !== undefined ? { difficulty: recipe.difficulty } : {}),
    ...(recipe.tags !== undefined ? { tags: recipe.tags } : {}),
    ...(recipe.prepTime !== undefined ? { prep_time: recipe.prepTime } : {}),
    ...(recipe.cookTime !== undefined ? { cook_time: recipe.cookTime } : {}),
    ...(recipe.totalTime !== undefined ? { total_time: recipe.totalTime } : {}),
    ingredients: recipe.ingredients.slice(0, 80).map((i) => ({
      text: i.text.slice(0, 300),
      name: i.name.slice(0, 160),
      ...(i.amount !== undefined ? { amount: i.amount } : {}),
      ...(i.unit !== undefined ? { unit: i.unit } : {}),
      ...(i.preparation !== undefined ? { preparation: i.preparation } : {}),
      // H-2: the stable handle an edit is addressed by. It is INTERNAL plumbing
      // (like the review line_ref) and is revalidated against live recipe state
      // before any edit is applied; it is never shown to the user.
      line_ref: typeof i.line_ref === 'string' ? i.line_ref : null,
    })),
    ingredients_total: recipe.ingredients.length,
    ingredients_truncated: recipe.ingredients.length > 80,
    instructions: page,
    instructions_total: totalSteps,
    instructions_offset: offset,
    instructions_returned: returned,
    instructions_complete: instructionsComplete,
    next_instruction_offset: instructionsComplete ? null : nextOffset,
    instructions_page_truncated: !instructionsComplete,
  });
}

function getVaultStatus(ctx: ShisoToolContext): ShisoObservation {
  if (ctx.vault === undefined) return fail('get_vault_status', 'vault_unavailable', 'The active Vault capability is not available.');
  const status = ctx.vault.getStatus();
  return ok(
    'get_vault_status',
    `${status.recipe_count} recipes are available in the ${status.source === 'personal' ? 'connected personal' : status.source === 'imported' ? 'read-only imported' : 'built-in starter'} Vault.`,
    status as unknown as Record<string, unknown>,
  );
}

function searchVaultRecipes(
  ctx: ShisoToolContext,
  query: string,
  field: 'all' | 'title' | 'ingredient' | 'category' | 'metadata',
  limit: number,
  signal?: AbortSignal,
): ShisoObservation {
  if (ctx.vault === undefined) return fail('search_vault_recipes', 'vault_unavailable', 'The active Vault capability is not available.');
  const result = ctx.vault.searchRecipes({ query, field, limit }, signal);
  if (result.results.length === 0) return fail('search_vault_recipes', 'record_not_found', `No recipes matched “${query.slice(0, 120)}”.`);
  return ok('search_vault_recipes', `${result.total_matches} recipe${result.total_matches === 1 ? '' : 's'} matched “${query.slice(0, 120)}”.`, result as unknown as Record<string, unknown>);
}

function getVaultRecipe(ctx: ShisoToolContext, recipeId: string): ShisoObservation {
  if (ctx.vault === undefined) return fail('get_vault_recipe', 'vault_unavailable', 'The active Vault capability is not available.');
  const recipe = ctx.vault.getRecipe(recipeId);
  if (recipe === null) return fail('get_vault_recipe', 'vault_recipe_not_found', 'That recipe is not present in the active Vault.');
  return ok('get_vault_recipe', `${recipe.title} — ${recipe.ingredients.length} ingredients`, recipe as unknown as Record<string, unknown>);
}

function selectVaultRecipe(ctx: ShisoToolContext, recipeId: string): ShisoObservation {
  if (ctx.vault === undefined) return fail('select_vault_recipe', 'vault_unavailable', 'The active Vault capability is not available.');
  const selection = ctx.vault.selectRecipe(recipeId);
  if (selection === null) return fail('select_vault_recipe', 'vault_selection_rejected', 'That recipe could not be selected from the active Vault.');
  ctx.onVaultRecipeSelected?.(selection.recipe_id);
  return ok('select_vault_recipe', `Selected ${selection.title} as the current SHISO recipe subject.`, selection as unknown as Record<string, unknown>);
}

async function loadUsdaCatalog(ctx: ShisoToolContext, signal?: AbortSignal): Promise<ShisoObservation> {
  if (ctx.session !== null) {
    return ok('load_usda_catalog', 'The authenticated USDA catalogue is already loaded and ready.', {
      catalogue_loaded: true,
      catalogue_status: 'ready',
    });
  }
  if (ctx.loadBundle === undefined) {
    return fail('load_usda_catalog', 'no_nutrition_review', 'The authenticated USDA catalogue loader is not available in this deployment.');
  }
  if (signal?.aborted) return fail('load_usda_catalog', 'analysis_unavailable', 'The USDA catalogue load was cancelled.');
  try {
    await ctx.loadBundle();
  } catch {
    return fail('load_usda_catalog', 'analysis_unavailable', 'The authenticated USDA catalogue could not be loaded.');
  }
  if (signal?.aborted) return fail('load_usda_catalog', 'analysis_unavailable', 'The USDA catalogue load was cancelled.');
  // Prefer the exact session returned by the authenticated loader over the
  // render-owned status. This keeps the next tool in the SAME conversation turn
  // on the newly installed session, even before React commits a new render.
  const currentSession = ctx.session;
  const status = currentSession !== null ? 'ready' : (ctx.catalogueStatus ?? 'loading');
  if (status === 'failed' || status === 'unsupported') {
    return fail('load_usda_catalog', 'analysis_unavailable', `The authenticated USDA catalogue is ${status}.`);
  }
  return ok(
    'load_usda_catalog',
    status === 'ready'
      ? 'The authenticated USDA catalogue is loaded and ready for food search.'
      : 'The application started loading the authenticated USDA catalogue. It is not ready to search yet; SHISO will check its status on the next step.',
    { catalogue_loaded: status === 'ready' || currentSession !== null, catalogue_status: status, load_started: true },
  );
}

/** Refuse to answer from a review whose stable ingredient handles no longer match the open recipe. */
function nutritionMatchesActiveRecipe(ctx: ShisoToolContext): boolean {
  if (ctx.recipe === null || ctx.nutrition === null) return false;
  const recipeRefs = ctx.recipe.ingredients.map((line) => line.line_ref);
  if (recipeRefs.length !== ctx.nutrition.rows.length || recipeRefs.some((ref) => typeof ref !== 'string')) return false;
  const recipeSet = new Set(recipeRefs as string[]);
  return recipeSet.size === recipeRefs.length && ctx.nutrition.rows.every((row) => recipeSet.has(row.line_ref));
}

function authenticatedAlternativeScenarios(ctx: ShisoToolContext): readonly Record<string, unknown>[] {
  if (ctx.session === null || ctx.recipe === null) return [];
  const scenarios: Record<string, unknown>[] = [];
  for (const line of ctx.recipe.ingredients) {
    if (typeof line.line_ref !== 'string') continue;
    const projected = projectIngredientAlternatives(line.text);
    if (projected === null) continue;
    const branches = projected.alternatives.slice(0, 4).map((name, index) => {
      const branchReview = ctx.session!.reviewIngredient({ name });
      const queryTokens = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((token) => token.replace(/s$/, '')));
      const requestedUnit = (line.unit ?? '').toLowerCase().replace(/s$/, '');
      const rankedSearch = ctx.session!.searchFoods(name, 12);
      const portionCompatible = (rankedSearch.ok ? rankedSearch.results : branchReview.candidates).find((candidate) => {
        const candidateTokens = candidate.description.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((token) => token.replace(/s$/, ''));
        if (candidateTokens.length > queryTokens.size + 1 || ![...queryTokens].every((token) => candidateTokens.includes(token))) return false;
        const portions = ctx.session!.reviewPortions(candidate.fdc_id);
        return portions.ok && portions.review.candidates.some((portion) =>
          portion.kind !== 'unusable' &&
          portion.gram_weight > 0 &&
          (requestedUnit.length === 0 || portion.unit?.replace(/s$/, '') === requestedUnit),
        );
      });
      // Once the bounded identity + requested-portion policy has selected a
      // genuine catalogue candidate, re-enter it through the existing exact
      // FDC lookup authority.  A `manual` selection would falsely describe an
      // autonomous choice as user-confirmed, while `ai_assisted` is reserved
      // for the base matcher's own unique deterministic acceptance.
      const scenarioQuery = portionCompatible === undefined
        ? name
        : String(portionCompatible.fdc_id);
      const ingredient = {
        original: `${line.amount ?? ''} ${line.unit ?? ''} ${name}`.trim(),
        amount: line.amount ?? null,
        unit: line.unit ?? '',
        name,
      };
      const review = ctx.session!.reviewIngredient(ingredient);
      const scenarioLineRef = `${line.line_ref}:alternative:${index}`;
      const exactPortions = portionCompatible === undefined
        ? []
        : ctx.session!.reviewPortions(portionCompatible.fdc_id);
      const portionIndex = exactPortions && 'ok' in exactPortions && exactPortions.ok
        ? exactPortions.review.candidates.find((portion) =>
            portion.kind !== 'unusable' &&
            portion.gram_weight > 0 &&
            (requestedUnit.length === 0 || portion.unit?.replace(/s$/, '') === requestedUnit),
          )?.index
        : undefined;
      const selection = portionCompatible === undefined
        ? undefined
        : {
            kind: 'manual' as const,
            fdc_id: portionCompatible.fdc_id,
            record_digest: portionCompatible.record_digest,
            catalog_digest: ctx.session!.metadata().catalog_digest,
            line_ref: scenarioLineRef,
            review_digest: review.review_digest,
            ai_assisted: true,
          };
      const portionChoice = selection !== undefined && portionIndex !== undefined
        ? buildPortionChoice(ctx.session!, {
            lineRef: scenarioLineRef,
            ingredient,
            review,
            selection,
            fdcId: portionCompatible!.fdc_id,
            portionIndex,
          })
        : null;
      const selectedCalculation = portionChoice?.ok
        ? ctx.session!.calculate({
            servings: ctx.recipe!.servings ?? 1,
            nutrient_scope: Object.keys(NUTRIENT_REGISTRY) as NutrientId[],
            ingredients: [{
              line_ref: scenarioLineRef,
              ingredient,
              selection,
              portion_selection: portionChoice.choice.selection,
            }],
          })
        : null;
      const adaptation = selectedCalculation?.ok ? null : adaptRecipe({
        title: `Alternative scenario: ${scenarioQuery}`,
        servings: ctx.recipe!.servings ?? 1,
        ingredients: [{ ...ingredient, name: scenarioQuery, original: `${line.amount ?? ''} ${line.unit ?? ''} ${scenarioQuery}`.trim() }],
      });
      const analysis = adaptation?.ok
        ? analyzeRecipe(ctx.session!, adaptation.recipe.adapted, adaptation.recipe.base_servings)
        : null;
      const preview = selectedCalculation?.ok ? selectedCalculation.preview : analysis?.preview;
      if (preview === undefined) {
        return {
          name,
          primary: projected.primary_index === index,
          resolved: false,
          reason: 'The authenticated calculator could not resolve this branch without an unsupported assumption.',
          diagnostic: portionChoice === null
            ? 'no_compatible_source_portion'
            : 'failure' in portionChoice
              ? portionChoice.failure.code
              : selectedCalculation !== null && 'failure' in selectedCalculation
                ? selectedCalculation.failure.code
                : 'analysis_unresolved',
          candidates: review.outcome === 'review_required'
            ? review.candidates.slice(0, 4).map((candidate) => ({ fdc_id: candidate.fdc_id, description: candidate.description }))
            : [],
        };
      }
      const evidence = preview.ingredients[0];
      const source = portionCompatible ?? (review.outcome === 'matched_exact'
        ? review.candidates.find((candidate) => candidate.fdc_id === review.selected_fdc_id)
        : undefined);
      const resolved = evidence?.outcome === 'calculated' && evidence.fdc_id !== undefined && evidence.resolved_grams !== undefined;
      return {
        name,
        primary: projected.primary_index === index,
        resolved,
        fdc_id: evidence?.fdc_id ?? null,
        source_description: source?.description ?? null,
        resolved_grams: evidence?.resolved_grams ?? null,
        mass_source: evidence?.mass_source ?? null,
        provenance: resolved ? 'authenticated_usda_scenario' : 'unresolved',
        totals: Object.fromEntries(Object.entries(preview.totals).map(([nutrient, total]) => [nutrient, total === undefined ? null : {
          amount: total.amount,
          unit: total.unit,
          status: total.status,
          coverage: total.coverage,
        }])),
        reason: resolved ? null : 'This branch remains unresolved; it is not included in a definitive recipe total.',
      };
    });
    scenarios.push({
      line_ref: line.line_ref,
      ingredient: line.text.slice(0, 200),
      mutually_exclusive: true,
      primary_index: projected.primary_index,
      definitive_choice_required: projected.primary_index === null,
      branches,
      note: projected.primary_index === null
        ? 'These alternatives are equal authored choices. Select one before saving definitive nutrition.'
        : 'The first branch is the as-written primary scenario; alternate totals remain separate.',
    });
  }
  return Object.freeze(scenarios.slice(0, 8));
}

function getNutritionReview(ctx: ShisoToolContext, includeIngredients: boolean): ShisoObservation {
  const n = ctx.nutrition;
  if (n === null) {
    return fail(
      'get_nutrition_review',
      'no_nutrition_review',
      'Advanced Nutrition is not currently open for this recipe.',
    );
  }
  if (!nutritionMatchesActiveRecipe(ctx)) {
    return fail('get_nutrition_review', 'stale_recipe', 'This nutrition review no longer matches the open recipe. Re-analyse the current recipe before reviewing coverage.');
  }
  // H-1F: the counts now reconcile. The previous summary counted
  // `review_suggested` inside `unresolved_count` but displayed it nowhere, so
  // the visible categories summed to one less than the total and the human test
  // reported 3 + 5 + 3 = 11 for a 12-ingredient recipe.
  const contributions = n.aiContributions ?? [];
  const coverage = deriveNutritionCoverage(n.rows, contributions);
  const linesByRef = new Map(coverage.lines.map((line) => [line.line_ref, line]));
  const data: Record<string, unknown> = {
    summary: nutritionCoverageSummary(coverage),
    unsaved_working_review: n.unsaved,
    total_ingredient_lines: coverage.total,
    resolved: coverage.resolved,
    unresolved_count: coverage.unresolved,
    source_backed: coverage.source_backed,
    ai_estimated: coverage.ai_estimated,
    source_backed_contributions: coverage.source_backed_contributions,
    excluded: coverage.excluded,
    partial_known: coverage.partial_known,
    needs_attention: coverage.unresolved,
    needs_amount: coverage.needs_amount,
    needs_match: coverage.needs_match,
    review_suggested: coverage.review_suggested,
    counts_reconcile: coverage.reconciled,
    coverage_summary: nutritionCoverageSummary(coverage),
    alternative_scenarios: authenticatedAlternativeScenarios(ctx),
  };
  if (includeIngredients) {
    data['ingredients'] = n.rows.slice(0, 60).map((r) => {
      const effective = linesByRef.get(r.line_ref);
      const contribution = effective?.contribution ?? effective?.candidate_contribution ??
        contributions.find((entry) => entry.line_ref === r.line_ref);
      return ({
      line_ref: r.line_ref,
      // The NAME is what may be shown to the user. `line_ref` is an internal
      // handle for binding and staleness only.
      label: r.original_text.slice(0, 120),
      status: effective?.status ?? r.status,
      source_status: r.status,
      contribution_used: effective?.contribution !== undefined,
      disposition: contribution?.disposition ?? 'edible',
      exclusion_role: contribution?.exclusion_role ?? 'none',
      exclusion_assumption: contribution?.exclusion_assumption ?? '',
      contribution_provenance: contribution?.classification ?? 'unknown',
      weight_provenance: contribution?.weight_grams !== undefined
        ? contribution.classification === 'source_backed' ? 'source_backed' : 'estimated_weight'
        : r.resolved_grams ? 'source_backed' : 'unknown',
      estimated_weight_grams: contribution?.weight_grams ?? null,
      nutrient_assumptions: contribution?.assumptions ?? [],
      known_nutrients: effective?.known_nutrients ?? [],
      unknown_nutrients: contribution?.unknown_nutrients ?? [],
      nutrient_contribution: contribution?.nutrients ?? {},
      food: r.selected_description ?? null,
      fdc_id: r.selected_fdc_id ?? null,
      food_authority: r.food_authority,
      mass_source: r.mass_source,
      resolved_grams: r.resolved_grams ?? null,
      });
    });
  }
  return ok(
    'get_nutrition_review',
    coverage.total === 0
      ? 'No ingredient lines in this recipe yet.'
      : nutritionCoverageSummary(coverage),
    data,
  );
}

/**
 * SINC-2: read-only summary of USDA Branded contributions already explicitly
 * accepted into the working review. SHISO can explain and compare this evidence,
 * but this tool cannot search USDA, create a candidate, or apply nutrition.
 */
function getBrandedEvidence(ctx: ShisoToolContext): ShisoObservation {
  const n = ctx.nutrition;
  if (n === null) {
    return fail(
      'get_branded_evidence',
      'no_nutrition_review',
      'Advanced Nutrition is not currently open for this recipe.',
    );
  }
  if (!nutritionMatchesActiveRecipe(ctx)) {
    return fail(
      'get_branded_evidence',
      'stale_recipe',
      'This nutrition review no longer matches the open recipe. Re-analyse the current recipe before reviewing branded evidence.',
    );
  }
  const branded = (n.aiContributions ?? []).filter(
    (entry) => entry.source_kind === 'usda_branded' && entry.usda_branded !== undefined
  );
  if (branded.length === 0) {
    return ok(
      'get_branded_evidence',
      'No USDA Branded product evidence has been accepted into this working review.',
      { count: 0, items: [] },
    );
  }
  const items = branded.slice(0, 10).map((entry) => ({
    line_ref: entry.line_ref,
    ingredient: entry.ingredient.slice(0, 200),
    fdc_id: entry.usda_branded?.fdc_id,
    product: entry.usda_branded?.description,
    brand: entry.usda_branded?.brand_owner ?? entry.usda_branded?.brand_name ?? null,
    basis: entry.usda_branded?.basis,
    quantity_basis: entry.quantity_basis,
    confidence: entry.confidence,
    assumptions: entry.assumptions.slice(0, 8),
    nutrients: entry.nutrients,
    limitations: entry.usda_branded?.publication_date !== undefined
      ? [`USDA publication date: ${entry.usda_branded.publication_date}`]
      : [],
  }));
  return ok(
    'get_branded_evidence',
    `${items.length} accepted USDA Branded contribution${items.length === 1 ? '' : 's'} in the working review.`,
    { count: items.length, items },
  );
}

/** Only accepted recipe-bound values on currently unresolved lines change coverage. */
function acceptedAiEstimatedLines(
  rows: ReadonlyArray<LiveRowState>,
  contributions: ReadonlyArray<AiNutrientContribution>,
): Set<string> {
  return acceptedNutritionLines(rows, contributions, 'ai_estimate');
}

function acceptedNutritionLines(
  rows: ReadonlyArray<LiveRowState>,
  contributions: ReadonlyArray<AiNutrientContribution>,
  classification?: AiNutrientContribution['classification'],
): Set<string> {
  return new Set(deriveNutritionCoverage(rows, contributions).lines
    .filter((line) => line.contribution && (classification === undefined || line.contribution.classification === classification))
    .map((line) => line.line_ref));
}

function searchUsdaFoods(ctx: ShisoToolContext, query: string, limit: number): ShisoObservation {
  if (ctx.session === null) {
    return fail('search_usda_foods', 'no_nutrition_review', 'The USDA catalogue is not loaded.');
  }

  const boundedLimit = Math.min(limit, SHISO_LIMITS.maxSearchResults);
  const numericId = /^\d+$/.test(query.trim());
  if (numericId) {
    const direct = ctx.session.searchFoods(query, boundedLimit);
    if (!direct.ok || direct.results.length === 0) {
      return fail('search_usda_foods', 'catalog_search_empty', 'No matching USDA record was found.');
    }
    return ok('search_usda_foods', `${direct.results.length} matching USDA record(s)`, {
      query,
      identity: query,
      total_matches: direct.total,
      results: direct.results.map((result) => ({
        fdc_id: result.fdc_id,
        description: result.description.slice(0, 160),
        data_type: result.data_type,
        match_class: result.match_class,
        has_portion: result.has_portion,
        portion_summary: result.portion_summary ?? null,
        record_digest: result.record_digest,
      })),
    });
  }

  // The model may pass an authored phrase or a whole ingredient line. Project
  // the culinary identity first so preparation/quantity words never become
  // mandatory search tokens. The authenticated review still ranks; this layer
  // only rejects a different food head or a composite dish before the model sees
  // it. Exact authority results are never filtered.
  const projection = projectCulinaryIngredient(query);
  const results: Array<Record<string, unknown>> = [];
  const seen = new Set<number>();
  let rejected = 0;
  for (const identity of projection.identities.slice(0, 4)) {
    const review = ctx.session.reviewIngredient({ name: identity });
    const exact = review.outcome === 'matched_exact';
    const candidates = exact
      ? review.candidates.filter((candidate) => candidate.fdc_id === review.selected_fdc_id)
      : review.outcome === 'review_required'
        ? bestEffortDiscoveryCandidates(review)
        : [];
    for (const candidate of candidates) {
      const verdict = exact ? { compatible: true, reason: null } : candidateIdentityVerdict(identity, candidate.description);
      if (!verdict.compatible) {
        rejected += 1;
        continue;
      }
      if (seen.has(candidate.fdc_id)) continue;
      seen.add(candidate.fdc_id);
      const portions = ctx.session.reviewPortions(candidate.fdc_id);
      const usable = portions.ok
        ? portions.review.candidates.filter((portion) => portion.kind !== 'unusable' && portion.gram_weight > 0)
        : [];
      results.push({
        fdc_id: candidate.fdc_id,
        description: candidate.description.slice(0, 160),
        data_type: candidate.data_type,
        match_class: candidate.match_class,
        has_portion: usable.length > 0,
        portion_summary: usable[0]?.display_label ?? null,
        record_digest: candidate.record_digest,
        branch: identity,
        authority_exact: exact,
        compatible: true,
      });
    }
  }
  if (results.length === 0) {
    return fail(
      'search_usda_foods',
      'catalog_search_empty',
      `No identity-compatible USDA record was found for “${projection.identity.slice(0, 100)}”. Do not substitute an unrelated record; ask for a more specific ingredient or use a measured amount.`,
    );
  }
  return ok('search_usda_foods', `${results.length} matching USDA record(s) — identity-compatible`, {
    query,
    identity: projection.identity,
    identities: projection.identities,
    alternatives: projection.alternatives,
    flexible_mixture: projection.flexible_mixture,
    equal_choice: projection.equal_choice,
    choice_required: projection.choice_required,
    measurement_note: projection.measurement_note,
    total_matches: results.length,
    rejected_matches: rejected,
    results: results.slice(0, boundedLimit),
  });
}

function inspectUsdaFood(ctx: ShisoToolContext, fdcId: number): ShisoObservation {
  if (ctx.session === null) {
    return fail('inspect_usda_food', 'no_nutrition_review', 'The USDA catalogue is not loaded.');
  }
  const portions = ctx.session.reviewPortions(fdcId);
  if (!portions.ok) {
    return fail('inspect_usda_food', 'record_not_found', 'That record is not in the authenticated catalogue.');
  }
  const review = portions.review;
  const candidates = review.candidates.slice(0, SHISO_LIMITS.maxPortionCandidates);
  const usable = candidates.filter(
    (c) => c.kind !== 'unusable' && c.gram_weight > 0 && c.gram_weight < 100000,
  );
  const label = candidates[0]?.measure ?? `record ${review.fdc_id}`;
  return ok(
    'inspect_usda_food',
    usable.length === 0
      ? `Record ${review.fdc_id} has no usable portion`
      : `Record ${review.fdc_id} — ${usable.length} usable portion(s)`,
    {
      fdc_id: review.fdc_id,
      first_measure: label.slice(0, 120),
      record_digest: review.record_digest,
      has_usable_portion: usable.length > 0,
      unusable_reason:
        usable.length === 0
          ? 'No portion in this record carries a usable gram weight.'
          : null,
      portions: candidates.map((c) => ({
        index: c.index,
        measure: c.measure.slice(0, 120),
        kind: c.kind,
        amount: c.amount ?? null,
        effective_amount: c.effective_amount,
        gram_weight: c.gram_weight,
        usable: c.kind !== 'unusable' && c.gram_weight > 0 && c.gram_weight < 100000,
      })),
    },
  );
}


/**
 * Scans the SAME deterministic ranked candidate set for records that carry a
 * usable authenticated portion. Purely read-only: it selects nothing, it only
 * reports what the authority already ranked.
 */
function compatiblePortionAlternatives(
  session: AdvancedNutritionSession,
  originalText: string,
  excludeFdcId: number,
): Array<Record<string, unknown>> {
  const review = session.reviewIngredient({ name: originalText });
  if (review.outcome !== 'review_required' && review.outcome !== 'matched_exact') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const candidate of review.candidates.slice(0, 10)) {
    if (candidate.fdc_id === excludeFdcId) continue;
    const portions = session.reviewPortions(candidate.fdc_id);
    if (!portions.ok) continue;
    const usable = portions.review.candidates.filter(
      (c) => c.kind !== 'unusable' && c.gram_weight > 0 && c.gram_weight < 100000,
    );
    if (usable.length === 0) continue;
    out.push({
      fdc_id: candidate.fdc_id,
      description: candidate.description.slice(0, 160),
      match_class: candidate.match_class,
      record_digest: candidate.record_digest,
      review_digest: review.review_digest ?? null,
      usable_portions: usable.slice(0, 6).map((c) => ({
        index: c.index,
        measure: c.measure.slice(0, 120),
        kind: c.kind,
        effective_amount: c.effective_amount,
        gram_weight: c.gram_weight,
      })),
    });
  }
  return out;
}

function findRow(ctx: ShisoToolContext, lineRef: string): LiveRowState | undefined {
  return (ctx.nutrition?.rows ?? []).find((r) => r.line_ref === lineRef);
}

function investigateIngredientAmount(ctx: ShisoToolContext, lineRef: string): ShisoObservation {
  if (!lineRef) return fail('investigate_ingredient_amount', 'unknown_line_ref', 'That ingredient is not part of the current recipe review.');
  if (ctx.nutrition === null) {
    return fail(
      'investigate_ingredient_amount',
      'no_nutrition_review',
      'Advanced Nutrition is not currently open.',
    );
  }
  if (!nutritionMatchesActiveRecipe(ctx)) {
    return fail('investigate_ingredient_amount', 'stale_recipe', 'The nutrition review changed with the recipe. Refresh the current review before investigating unresolved ingredients.');
  }
  const row = findRow(ctx, lineRef);
  if (row === undefined) {
    return fail(
      'investigate_ingredient_amount',
      'unknown_line_ref',
      'That ingredient is not part of the current recipe review.',
    );
  }
  if (ctx.session === null) {
    return fail(
      'investigate_ingredient_amount',
      'no_nutrition_review',
      'The USDA catalogue is not loaded.',
    );
  }

  const base: Record<string, unknown> = {
    line_ref: row.line_ref,
    label: row.original_text.slice(0, 120),
    original_text: row.original_text.slice(0, 200),
    status: row.status,
    food: row.selected_description ?? null,
    fdc_id: row.selected_fdc_id ?? null,
    food_authority: row.food_authority,
    mass_source: row.mass_source,
    resolved_grams: row.resolved_grams ?? null,
  };

  // Why is it unresolved, according to the deterministic engine itself?
  if (row.status === 'needs_match') {
    const review = ctx.session.reviewIngredient({ name: row.original_text });
    const reviewable =
      review.outcome === 'review_required' || review.outcome === 'matched_exact';
    const candidates = reviewable ? review.candidates.slice(0, 6) : [];
    return ok(
      'investigate_ingredient_amount',
      `${row.original_text.slice(0, 60)} has no confident food match`,
      {
        ...base,
        diagnosis: 'no_confident_food_match',
        compatible_candidates: candidates.map((c) => ({
          fdc_id: c.fdc_id,
          description: c.description.slice(0, 160),
          match_class: c.match_class,
          record_digest: c.record_digest,
        })),
      },
    );
  }

  // needs_amount: the food is known, the mass is not. Explain exactly why,
  // AND — this is the part that matters — whether a COMPATIBLE ALTERNATIVE
  // record carries authenticated portions the selected one does not.
  const fdcId = row.selected_fdc_id;
  const detail: Record<string, unknown> = { ...base, diagnosis: 'food_known_mass_unresolved' };
  detail['selected_record_portion_count'] = null;
  detail['compatible_alternatives_with_portions'] = [];
  if (typeof fdcId === 'number') {
    const portions = ctx.session.reviewPortions(fdcId);
    if (portions.ok) {
      const candidates = portions.review.candidates.slice(0, SHISO_LIMITS.maxPortionCandidates);
      const usable = candidates.filter((c) => c.kind !== 'unusable' && c.gram_weight > 0 && c.gram_weight < 100000);
      detail['selected_fdc_id'] = fdcId;
      detail['selected_record_digest'] = portions.review.record_digest;
      detail['selected_record_has_usable_portion'] = usable.length > 0;
      void 0;
      detail['selected_portion_count'] = candidates.length;
      detail['usable_portions'] = usable.slice(0, 10).map((c) => ({
        index: c.index,
        measure: c.measure.slice(0, 120),
        kind: c.kind,
        effective_amount: c.effective_amount,
        gram_weight: c.gram_weight,
      }));
      detail['selected_record_portion_count'] = candidates.length;
      if (usable.length === 0) {
        detail['limitation'] =
          'The currently selected USDA record carries no portion with a usable gram weight, so no authenticated mass can be derived for it.';
      }
    }

    // COMPATIBLE-ALTERNATIVE SCAN. The selected record may simply be the wrong
    // record: the ranked candidate set can contain a same-family record that
    // DOES carry authenticated portions. This is investigation, not selection —
    // Shiso reports the evidence and the existing application authority decides.
    const scan = compatiblePortionAlternatives(ctx.session, row.original_text, fdcId);
    detail['compatible_alternatives_with_portions'] = scan;
    if (scan.length > 0) {
      detail['limitation'] =
        'The selected record has no usable portion, but ' + scan.length +
        ' compatible alternative record(s) in the same ranked set DO carry authenticated portions.';
    }
    const counts = ctx.session.reviewCountPortions({ name: row.original_text }, fdcId);
    if (counts.ok) {
      const cr = counts.review;
      detail['count_portion_applicable'] = cr.applicable;
      detail['count_portion_candidates'] = cr.candidates
        .slice(0, SHISO_LIMITS.maxCountPortionCandidates)
        .map((c) => ({
          index: c.index,
          measure: c.measure.slice(0, 120),
          amount: c.amount,
          gram_weight: c.gram_weight,
          unit: c.unit,
          size: c.size,
        }));
    }
  }
  return ok(
    'investigate_ingredient_amount',
    `${row.original_text.slice(0, 60)} — food identified, mass unresolved`,
    detail,
  );
}

/**
 * ONE bounded deterministic pass over every unresolved line.
 *
 * Replaces the model+tool cycle per ingredient that exhausted the turn budget in
 * the human test. The report is grounded entirely in the live review and the
 * authenticated session; when it cannot cover every line it reports exactly how
 * many it examined and hands back a cursor so the user can continue.
 */

/**
 * One culinary investigation for an unresolved line. Pure/read-only; it
 * separates identity, quantity, authored alternatives, flexible composition,
 * and measurable evidence before the model sees candidates. It never selects a
 * source or returns a gram weight that is not an authenticated portion.
 */
function culinaryLineInvestigation(
  ctx: ShisoToolContext,
  row: LiveRowState,
): Record<string, unknown> {
  if (ctx.session === null) {
    return { identity: null, candidates: [], next_action: { kind: 'no_source', reason: 'catalogue_unavailable' } };
  }
  const authored = ctx.recipe?.ingredients.find((entry) => entry.line_ref === row.line_ref);
  const original = authored?.text ?? row.original_text;
  const projection = projectCulinaryIngredient(original);
  const candidates: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let rejected = 0;
  const branchReports: Array<Record<string, unknown>> = [];
  const branchIdentities = [...projection.identities];
  const searchBranch = (identity: string): void => {
    const review = ctx.session!.reviewIngredient({ name: identity });
    const exact = review.outcome === 'matched_exact';
    const ranked = exact
      ? review.candidates.filter((candidate) => candidate.fdc_id === review.selected_fdc_id)
      : review.outcome === 'review_required'
        ? bestEffortDiscoveryCandidates(review)
        : [];
    const branchCandidates: Array<Record<string, unknown>> = [];
    for (const candidate of ranked.slice(0, 12)) {
      const verdict = exact
        ? { compatible: true, reason: null }
        : candidateIdentityVerdict(identity, candidate.description);
      if (!verdict.compatible) {
        rejected += 1;
        continue;
      }
      const portions = ctx.session!.reviewPortions(candidate.fdc_id);
      const usable = portions.ok
        ? portions.review.candidates.filter((portion) => portion.kind !== 'unusable' && portion.gram_weight > 0 && portion.gram_weight < 100000)
        : [];
      // Match the authored measurement, not merely the first portion on the
      // record. Density makes any compatible volume portion equivalent for a
      // volume line and any mass portion equivalent for a mass line, but a
      // count must name the same thing ("tortilla" is not "slice" or "package").
      let preferred: (typeof usable)[number] | undefined;
      const singularTokens = (value: string): readonly string[] =>
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .split(/\s+/)
          .filter((token) => token.length >= 3)
          .map((token) => token.replace(/s$/, ''));
      if (projection.measurement_kind === 'volume' && projection.milliliters !== null) {
        const milliliters = projection.milliliters;
        const index = selectDeterministicVolumePortionIndex(
          ctx.session!,
          candidate.fdc_id,
          milliliters,
          projection.normalized_unit ?? projection.unit ?? undefined,
          identity,
        );
        const volumePortions = usable.filter((portion) => portion.kind === 'volume');
        const gramsFor = (portion: (typeof volumePortions)[number]): number | undefined => {
          if (portion.volume_ml === null || !(portion.volume_ml > 0) || !(portion.gram_weight > 0)) return undefined;
          const grams = (milliliters / portion.volume_ml) * portion.gram_weight;
          return Number.isFinite(grams) && grams > 0 ? grams : undefined;
        };
        const first = volumePortions[0];
        const firstGrams = first === undefined ? undefined : gramsFor(first);
        // Only use a different volume portion when every usable volume portion
        // resolves to the same weight within portion-rounding tolerance. This
        // keeps a tablespoon of butter honest while refusing to guess between
        // genuinely different preparations of the same food.
        const equivalent = firstGrams !== undefined && volumePortions.every((portion) => {
          const grams = gramsFor(portion);
          return grams !== undefined && Math.abs(grams - firstGrams) <= Math.max(0.1, firstGrams * 0.01);
        });
        preferred = index === undefined
          ? equivalent ? first : undefined
          : usable.find((portion) => portion.index === index) ?? (equivalent ? first : undefined);
      } else if (projection.measurement_kind === 'mass' && projection.grams !== null) {
        preferred = usable.find((portion) => portion.kind === 'mass');
      } else {
        // Count-like lines (including lines whose authored count unit did not
        // parse, such as "8 burrito-size tortillas") may use a count portion
        // only when its measure names the same item. The authored unit wins when
        // present, so "1 can tomatoes" can never fall through to "1 tomato".
        const unitTokens = projection.unit !== null ? singularTokens(projection.unit) : [];
        const nounTokens = singularTokens(projection.count_noun ?? projection.identity);
        const requested = new Set(unitTokens.length > 0 ? unitTokens : nounTokens);
        if (projection.amount !== null && requested.size > 0) {
          preferred = usable.find((portion) => {
            if (portion.kind !== 'count') return false;
            return singularTokens(portion.measure).some((token) => requested.has(token));
          });
        }
      }
      const record = {
        branch: identity,
        fdc_id: candidate.fdc_id,
        description: candidate.description.slice(0, 160),
        match_class: candidate.match_class,
        record_digest: candidate.record_digest,
        review_digest: review.review_digest ?? null,
        authority_exact: exact,
        usable_portions: usable.slice(0, 6).map((portion) => ({
          index: portion.index,
          measure: portion.display_label.slice(0, 120),
          gram_weight: portion.gram_weight,
        })),
        preferred_portion_index: preferred?.index ?? null,
        preferred_grams: preferred?.gram_weight ?? null,
      };
      const key = `${identity}:${candidate.fdc_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      branchCandidates.push(record);
      candidates.push(record);
    }
    branchReports.push({
      identity,
      authority_exact: exact,
      compatible_candidates: branchCandidates,
    });
  };

  for (const identity of branchIdentities.slice(0, 4)) searchBranch(identity);
  // Compound size/format descriptors can hide an otherwise exact food head
  // ("burrito tortillas" -> "tortillas"). Only try the head after the full
  // identity produced no candidate at all; never broaden a line that already
  // has evidence.
  if (candidates.length === 0 && branchIdentities.length === 1) {
    for (const identity of projection.fallback_identities) {
      if (!branchIdentities.includes(identity)) searchBranch(identity);
    }
  }

  const primaryIdentity = projection.identities[0] ?? projection.identity;
  const primaryCandidates = (projection.equal_choice || projection.flexible_mixture)
    ? candidates.filter((candidate) => candidate['branch'] === primaryIdentity)
    : candidates;
  const selectable = primaryCandidates.find((candidate) => candidate['preferred_portion_index'] !== null);
  let nextAction: Record<string, unknown>;
  let pendingChoice: Record<string, unknown> | null = null;
  if (projection.measurement_note !== null) {
    nextAction = {
      kind: 'needs_measurement',
      line_ref: row.line_ref,
      note: projection.measurement_note,
      candidates,
    };
    pendingChoice = {
      kind: 'measurement',
      line_ref: row.line_ref,
      label: original.slice(0, 160),
      note: projection.measurement_note,
    };
  } else if (projection.flexible_mixture) {
    nextAction = {
      kind: 'composition_choice',
      line_ref: row.line_ref,
      options: projection.identities,
      candidates,
      note: 'This line is a flexible mixture. A precise composition and proportions require the user’s choice; do not present an invented mixture as verified.',
    };
    pendingChoice = {
      kind: 'composition',
      line_ref: row.line_ref,
      label: original.slice(0, 160),
      options: projection.identities,
    };
  } else if (projection.equal_choice) {
    nextAction = {
      kind: 'ingredient_choice',
      line_ref: row.line_ref,
      options: projection.identities,
      candidates,
      note: 'These are equal authored alternatives. Ask which one was actually used; do not choose one silently.',
    };
    pendingChoice = {
      kind: 'ingredient',
      line_ref: row.line_ref,
      label: original.slice(0, 160),
      options: projection.identities,
    };
  } else if (selectable !== undefined) {
    nextAction = {
      kind: 'select_source',
      line_ref: row.line_ref,
      fdc_id: selectable['fdc_id'],
      portion_index: selectable['preferred_portion_index'],
      gram_weight: selectable['preferred_grams'],
      description: selectable['description'],
      note: 'Select this authenticated source through select_usda_nutrition_source, then continue the task.',
    };
  } else if (primaryCandidates.length > 0) {
    nextAction = {
      kind: 'choose_candidate',
      line_ref: row.line_ref,
      candidates: primaryCandidates.slice(0, 3),
      note: 'Compatible candidates exist, but none has an authenticated portion that matches the authored measurement without guessing. Ask for the measured weight actually used; do not substitute a package, slice, or different preparation.',
    };
    pendingChoice = {
      kind: 'measurement',
      line_ref: row.line_ref,
      label: original.slice(0, 160),
      note: 'A compatible authenticated record exists, but its portions do not match the authored measurement. Only a measured weight from the user can resolve it.',
    };
  } else {
    nextAction = {
      kind: 'no_compatible_source',
      line_ref: row.line_ref,
      note: 'No identity-compatible authenticated record was found. Do not substitute an unrelated food; ask for a more specific ingredient or a measured amount.',
    };
  }

  return {
    line_ref: row.line_ref,
    label: original.slice(0, 160),
    identity: projection.identity,
    identities: projection.identities,
    quantity: {
      amount: projection.amount,
      unit: projection.unit,
      measurement_kind: projection.measurement_kind,
    },
    preparation: authored?.preparation ?? null,
    alternatives: projection.alternatives,
    primary_index: projection.primary_index,
    flexible_mixture: projection.flexible_mixture,
    equal_choice: projection.equal_choice,
    choice_required: projection.choice_required,
    measurement_note: projection.measurement_note,
    current_food: row.selected_description ?? null,
    current_fdc_id: row.selected_fdc_id ?? null,
    resolved_grams: row.resolved_grams ?? null,
    status: row.status,
    compatible_candidates: candidates.slice(0, 8),
    rejected_candidates: rejected,
    branches: branchReports,
    next_action: nextAction,
    pending_choice: pendingChoice,
  };
}

function investigateUnresolvedIngredients(
  ctx: ShisoToolContext,
  cursor: string | undefined,
  statuses: readonly ('needs_amount' | 'needs_match')[] | undefined,
): ShisoObservation {
  if (ctx.nutrition === null) {
    return fail(
      'investigate_unresolved_ingredients',
      'no_nutrition_review',
      'Advanced Nutrition is not currently open for this recipe, so there is no review to investigate.',
    );
  }
  if (ctx.session === null) {
    return fail(
      'investigate_unresolved_ingredients',
      'no_nutrition_review',
      'The authenticated USDA catalogue is not loaded.',
    );
  }
  const coverage = deriveNutritionCoverage(ctx.nutrition.rows, ctx.nutrition.aiContributions ?? []);
  const effectiveByRef = new Map(coverage.lines.map((line) => [line.line_ref, line]));
  const acceptedAi = new Set(coverage.lines.filter((line) => line.contribution?.classification === 'ai_estimate').map((line) => line.line_ref));
  const acceptedSource = new Set(coverage.lines.filter((line) => line.contribution?.classification === 'source_backed').map((line) => line.line_ref));
  const actionableRows = ctx.nutrition.rows.filter((row) => {
    const effective = effectiveByRef.get(row.line_ref);
    return effective?.resolved !== true && effective?.status !== 'excluded';
  });
  const report = runBatchInvestigation({
    session: ctx.session,
    rows: actionableRows,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(statuses !== undefined ? { statuses } : {}),
  });

  const summary =
    report.total_unresolved === 0
      ? `No ingredient lines require more source investigation. ${coverage.ai_estimated} are covered by AI estimates, ${coverage.source_backed_contributions} by source-backed contributions, and ${coverage.partial_known} have remaining unknown nutrients.`
      : report.complete
        ? `Investigated all ${report.total_unresolved} unresolved ingredient(s): ` +
          `${report.counts.alternative_portion_available} can be corrected with an authenticated alternative, ` +
          `${report.counts.suggested_match_awaiting_review} have a suggested match awaiting review, ` +
          `${report.counts.count_portion_available} have a count measure, ` +
          `${report.counts.needs_user_measurement} need a measurement only you can supply, ` +
          `${report.counts.needs_food_identity} have no confident food match.`
        : `Investigated ${report.examined} of ${report.total_unresolved} unresolved ingredient(s) — ` +
          `${report.remaining} ingredient(s) are still to investigate.`;

  const lineReports = report.lines.map((l) => {
    const row = findRow(ctx, l.line_ref);
    // Culinary enrichment is additive. A minimal/injected surface that cannot
    // support it must still receive the existing authoritative batch report.
    let culinary: Record<string, unknown> | null = null;
    if (row !== undefined) {
      try {
        culinary = culinaryLineInvestigation(ctx, row);
      } catch {
        culinary = null;
      }
    }
    return {
      // Internal handle, for binding and staleness only. NEVER printed to the
      // user — `label` is the ingredient's own text and is what may be shown.
      line_ref: l.line_ref,
      label: l.label,
      status: l.status,
      classification: l.classification,
      reason: l.reason,
      current_food: l.current_food,
      current_fdc_id: l.current_fdc_id,
      resolved_grams: l.resolved_grams,
      correction_available: l.correction_available,
      needs_from_user:
        l.classification === 'needs_user_measurement'
          ? 'Enter the weight yourself in Advanced Nutrition; only a measurement you take can supply this.'
          : l.classification === 'needs_food_identity' && l.alternatives.length === 0
            ? 'Rephrase or specify this ingredient more precisely so the catalogue can match it.'
            : null,
      alternatives: l.alternatives.map((a) => ({
        fdc_id: a.fdc_id,
        description: a.description,
        match_class: a.match_class,
        record_digest: a.record_digest,
        review_digest: a.review_digest,
        usable_portions: a.usable_portions,
      })),
      candidates: l.candidates,
      // The model should reason from this culinary projection, not from raw
      // token-overlap candidates above.
      culinary,
      compatible_candidates: culinary?.['compatible_candidates'] ?? [],
      next_action: culinary?.['next_action'] ?? null,
      pending_choice: culinary?.['pending_choice'] ?? null,
    };
  });
  const pendingChoices = lineReports
    .map((line) => line.pending_choice)
    .filter((choice): choice is Record<string, unknown> => choice !== null && choice !== undefined);
  const nextActions = lineReports
    .map((line) => line.next_action)
    .filter((action): action is Record<string, unknown> => action !== null && action !== undefined);
  const questionParts = pendingChoices.slice(0, 6).map((choice, index) => {
    const label = typeof choice['label'] === 'string' ? choice['label'] : 'an ingredient';
    const options = Array.isArray(choice['options'])
      ? choice['options'].filter((option): option is string => typeof option === 'string')
      : [];
    if (choice['kind'] === 'measurement') {
      return `${index + 1}) For “${label}”, what measured amount was used?`;
    }
    if (choice['kind'] === 'composition') {
      return `${index + 1}) For “${label}”, which vegetables and roughly what proportions were used${options.length > 0 ? ` (for example ${options.slice(0, 4).join(', ')})` : ''}?`;
    }
    return `${index + 1}) For “${label}”, which did you actually use${options.length > 0 ? `: ${options.join(' or ')}` : ''}?`;
  });
  const consolidatedQuestion = questionParts.length === 0
    ? null
    : `I can finish more of the nutrition after one consolidated choice set: ${questionParts.join(' ')}`;

  return ok('investigate_unresolved_ingredients', summary, {
    ai_estimated: acceptedAi.size,
    source_backed_contributions: acceptedSource.size,
    partial_known: coverage.partial_known,
    source_backed: coverage.source_backed,
    needs_attention: report.total_unresolved,
    examined: report.examined,
    total_unresolved: report.total_unresolved,
    remaining: report.remaining,
    complete: report.complete,
    next_cursor: report.next_cursor,
    classification_counts: report.counts,
    lines: lineReports,
    next_actions: nextActions,
    pending_user_choices: pendingChoices,
    consolidated_question: consolidatedQuestion,
    continuation_hint: report.complete
      ? null
      : `${report.remaining} ingredient(s) remain. Ask me to continue and I will investigate the rest without repeating this work.`,
  });
}

const MAX_COMPLETION_BRANDED_SEARCHES = 4;
const MAX_COMPLETION_RESEARCH_TARGETS = 3;

interface CompletionRecipeSnapshot {
  readonly title: string;
  readonly servings: number | null;
  readonly ingredients: ReadonlyArray<{ readonly line_ref: string | null; readonly text: string; readonly name: string }>;
  readonly instructions: ReadonlyArray<string>;
}

function completionRecipeSnapshot(ctx: ShisoToolContext): CompletionRecipeSnapshot | null {
  if (ctx.recipe === null) return null;
  return Object.freeze({
    title: ctx.recipe.title,
    servings: ctx.recipe.servings,
    ingredients: Object.freeze(ctx.recipe.ingredients.map((entry) => Object.freeze({
      line_ref: typeof entry.line_ref === 'string' ? entry.line_ref : null,
      text: entry.text,
      name: entry.name,
    }))),
    instructions: Object.freeze(ctx.recipe.instructions.map((step) => step.text)),
  });
}

function completionSnapshotKey(snapshot: CompletionRecipeSnapshot | null): string {
  return snapshot === null ? '' : JSON.stringify(snapshot);
}

function completionTarget(line: { readonly line_ref: string; readonly text: string }): {
  readonly target: BrandedLookupTarget;
  readonly research: Omit<ResearchTarget, 'ambiguity'>;
} | null {
  const measurement = completionLookupTarget(line.text);
  if (!measurement) return null;
  const shared = {
    line_ref: line.line_ref,
    ingredient_text: line.text,
    query: measurement.query,
    amount: measurement.amount,
    unit: measurement.unit,
    measurement_kind: measurement.measurement_kind,
    ...(measurement.grams !== undefined ? { quantity_grams: measurement.grams } : {}),
    ...(measurement.milliliters !== undefined ? { quantity_ml: measurement.milliliters } : {}),
  };
  return Object.freeze({
    target: Object.freeze(shared) as BrandedLookupTarget,
    research: Object.freeze(shared) as Omit<ResearchTarget, 'ambiguity'>,
  });
}

/**
 * SINC-3 — bounded, source-first completion of the CURRENT unresolved review.
 *
 * The user's explicit "resolve/finish/complete the missing nutrition" request is
 * the authorization. The pipeline runs entirely through the EXISTING authorities:
 *
 *   1. deterministic generic USDA analysis + calculator (the Calculate button);
 *   2. USDA Branded manufacturer evidence (SINC-2), strong usable candidates only;
 *   3. bounded external nutrition research (AN-WEB-1), eligible identity lines only;
 *   4. validated AI estimates for whatever remains.
 *
 * It only prepares contributions in the UNSAVED working review. It never applies
 * a saved block, never writes to the Vault, and never promotes a branded proposal
 * to trusted provenance (Apply still performs the SINC-2 server verification).
 */
function nutrientGapLines(coverage: NutritionCoverage): ReadonlyArray<EffectiveNutritionLine> {
  return coverage.lines.filter((line) =>
    line.contribution !== undefined &&
    line.contribution.classification === 'ai_estimate' &&
    line.partial_known &&
    line.unknown_nutrients.length > 0
  );
}

function mergeGapContribution(
  existing: AiNutrientContribution,
  gap: AiNutrientContribution,
): { readonly contribution: AiNutrientContribution; readonly filled: ReadonlyArray<{ id: string; amount: number; unit: string }> } {
  if (existing.classification !== 'ai_estimate' || gap.line_ref !== existing.line_ref) {
    return { contribution: existing, filled: [] };
  }
  const nutrients = { ...existing.nutrients };
  const filled: Array<{ id: string; amount: number; unit: string }> = [];
  for (const [id, value] of Object.entries(gap.nutrients)) {
    if (value === undefined) continue;
    if (existing.nutrients[id as keyof typeof existing.nutrients] !== undefined) continue;
    if (!existing.unknown_nutrients.includes(id as never)) continue;
    (nutrients as Record<string, { amount: number; unit: string }>)[id] = { amount: value.amount, unit: value.unit };
    filled.push({ id, amount: value.amount, unit: value.unit });
  }
  if (filled.length === 0) return { contribution: existing, filled };
  const unknownNutrients = existing.unknown_nutrients.filter(
    (id) => (nutrients as Record<string, unknown>)[id] === undefined
  );
  const assumptions = [...new Set([
    ...existing.assumptions,
    ...gap.assumptions,
    'Additional nutrient values were estimated in a focused nutrient-gap pass.',
  ])].slice(0, 12);
  return {
    contribution: Object.freeze({
      ...existing,
      nutrients: Object.freeze(nutrients),
      unknown_nutrients: Object.freeze(unknownNutrients),
      assumptions: Object.freeze(assumptions),
    }),
    filled,
  };
}

function buildWholeRecipeNutrientReport(
  coverage: ReadonlyArray<ShisoNutrientCoverageEntry>,
  contributions: ReadonlyArray<AiNutrientContribution>,
  supplements: ReadonlyArray<AiNutrientSupplement>,
  filledByRef: ReadonlyMap<string, ReadonlyArray<{ id: string; amount: number; unit: string }>>,
) {
  const aiLines = contributions.filter(
    (entry) => entry.classification === 'ai_estimate' && entry.disposition !== 'excluded'
  );
  const supplementTotals = sumNutrientSupplements(supplements) as Record<string, {
    amount: number;
    covered_ingredient_count: number;
    lines: ReadonlySet<string>;
  }>;
  const nutrients = coverage.map((entry) => {
    const remainingAiLines = aiLines
      .filter((line) => line.nutrients[entry.id] === undefined && line.unknown_nutrients.includes(entry.id))
      .map((line) => ({ line_ref: line.line_ref, label: line.ingredient }));
    const filledAiLines = [...filledByRef.values()].filter((values) =>
      values.some((value) => value.id === entry.id)
    ).length;
    const supplementLines = supplementTotals[entry.id]?.lines ?? new Set<string>();
    const remainingSourceLines = entry.missing_source_lines.filter((line) => !supplementLines.has(line.line_ref));
    const supplementedSourceLines = [
      ...(entry.supplemented_lines ?? []),
      ...entry.missing_source_lines.filter((line) => supplementLines.has(line.line_ref)),
    ];
    const totalSupplementAmount = supplementTotals[entry.id]?.amount ?? 0;
    const existingSupplementAmount = entry.supplemental_estimated_amount ?? 0;
    const existingSupplementLines = entry.supplemented_lines?.length ?? 0;
    const totalSupplementLines = supplementTotals[entry.id]?.covered_ingredient_count ?? 0;
    const newSupplementAmount = Math.max(0, totalSupplementAmount - existingSupplementAmount);
    const newSupplementLines = Math.max(0, totalSupplementLines - existingSupplementLines);
    // The published coverage snapshot predates this pass. Add ONLY this pass's
    // supplemental amounts so existing supplements are never double-counted.
    const totalAmount = entry.total_amount === null
      ? totalSupplementAmount > 0 ? Math.round(totalSupplementAmount * 1e6) / 1e6 : null
      : Math.round((entry.total_amount + newSupplementAmount) * 1e6) / 1e6;
    const unknownTotal = totalAmount === null;
    const status = unknownTotal
      ? 'unknown' as const
      : remainingSourceLines.length + remainingAiLines.length > 0
        ? 'partial' as const
        : 'complete' as const;
    return Object.freeze({
      id: entry.id,
      label: entry.label,
      unit: entry.unit,
      status,
      total_amount: totalAmount,
      derived_source_subtotal: entry.derived_source_subtotal,
      ai_estimated_amount: entry.ai_estimated_amount,
      supplemental_estimated_amount: Math.round(totalSupplementAmount * 1e6) / 1e6,
      covered_ingredient_count: entry.covered_ingredient_count + newSupplementLines,
      measurable_ingredient_count: entry.measurable_ingredient_count,
      missing_source_count: remainingSourceLines.length,
      missing_source_line_refs: remainingSourceLines.map((line) => line.line_ref),
      supplemented_source_count: supplementedSourceLines.length,
      supplemented_source_line_refs: supplementedSourceLines.map((line) => line.line_ref),
      missing_ai_count: remainingAiLines.length,
      missing_ai_line_refs: remainingAiLines.map((line) => line.line_ref),
      filled_ai_lines: filledAiLines,
    });
  });
  const sourceGapNutrients = nutrients.filter((entry) => entry.missing_source_count > 0);
  const aiGapNutrients = nutrients.filter((entry) => entry.missing_ai_count > 0 || entry.filled_ai_lines > 0);
  const remainingSourceGapValues = nutrients.reduce((sum, entry) => sum + entry.missing_source_count, 0);
  const remainingAiGapValues = nutrients.reduce((sum, entry) => sum + entry.missing_ai_count, 0);
  const supplementedSourceValues = nutrients.reduce((sum, entry) => sum + entry.supplemented_source_count, 0);
  const reasons: string[] = [];
  if (remainingAiGapValues > 0) {
    reasons.push('AI-estimated line gaps can be retried with a working provider');
  }
  if (remainingSourceGapValues > 0) {
    reasons.push(
      'remaining source-backed gaps can be attempted with another bounded AI supplement pass; values without a defensible estimate remain unknown'
    );
  }
  if (reasons.length === 0) reasons.push('no remaining declared nutrient gaps');
  return Object.freeze({
    total_nutrients: nutrients.length,
    complete_nutrients: nutrients.filter((entry) => entry.status === 'complete').length,
    partial_nutrients: nutrients.filter((entry) => entry.status === 'partial').length,
    unknown_nutrients: nutrients.filter((entry) => entry.status === 'unknown').length,
    nutrients: Object.freeze(nutrients),
    source_gap_nutrients: Object.freeze(sourceGapNutrients),
    ai_gap_nutrients: Object.freeze(aiGapNutrients),
    remaining_source_gap_values: remainingSourceGapValues,
    remaining_ai_gap_values: remainingAiGapValues,
    supplemented_source_values: supplementedSourceValues,
    total_supplements: supplements.length,
    additional_completion: Object.freeze({
      possible: remainingAiGapValues > 0 || remainingSourceGapValues > 0,
      reason: `${reasons.join('; ')}.`,
    }),
  });
}

function wholeRecipeNutrientSummary(report: ReturnType<typeof buildWholeRecipeNutrientReport>): string {
  if (report.total_nutrients === 0) {
    return 'Whole-recipe nutrient coverage is unavailable from the current review snapshot.';
  }
  const priority = new Set(['niacin', 'added_sugars']);
  const orderedSourceGaps = [...report.source_gap_nutrients].sort((left, right) =>
    Number(priority.has(right.id)) - Number(priority.has(left.id))
  );
  const sourceNames = orderedSourceGaps.map((entry) => entry.label).join(', ');
  const supplementedNutrients = report.nutrients.filter((entry) => entry.supplemented_source_count > 0);
  const aiNames = report.ai_gap_nutrients
    .filter((entry) => entry.missing_ai_count > 0)
    .map((entry) => entry.label)
    .join(', ');
  return (
    `Whole-recipe nutrient coverage: ${report.complete_nutrients} of ${report.total_nutrients} nutrients complete, ` +
    `${report.partial_nutrients} partial, ${report.unknown_nutrients} unknown. ` +
    (report.supplemented_source_values > 0
      ? `Supplemental AI estimates cover ${report.supplemented_source_values} source-backed nutrient-line value(s)` +
        `${supplementedNutrients.length > 0 ? ` (${supplementedNutrients.map((entry) => entry.label).join(', ')})` : ''}. `
      : 'No source-backed nutrient value has been supplemented. ') +
    (report.remaining_source_gap_values > 0
      ? `USDA source-backed gaps remain for ${report.remaining_source_gap_values} nutrient-line value(s) across ` +
        `${report.source_gap_nutrients.length} nutrient(s)${sourceNames ? ` (${sourceNames})` : ''}; defensible values can be proposed only as separately labeled supplemental AI estimates, otherwise they remain unknown. `
      : 'No USDA source-backed nutrient-line gaps remain. ') +
    (report.remaining_ai_gap_values > 0
      ? `AI-estimated gaps remain for ${report.remaining_ai_gap_values} nutrient-line value(s)${aiNames ? ` (${aiNames})` : ''}. `
      : 'No AI-estimated nutrient gaps remain. ') +
    'Known source-backed subtotals and AI-estimated amounts remain separate; verified USDA values are never overwritten by AI estimates. ' +
    `Additional completion: ${report.additional_completion.reason}`
  );
}

const MAX_SOURCE_SUPPLEMENT_GAPS = 160;

interface SourceSupplementPlanLine {
  readonly line_ref: string;
  readonly label: string;
  readonly fdc_id?: number;
  readonly record_digest?: string;
  readonly weight_grams?: number;
  readonly source_release?: string;
  readonly nutrients: Set<string>;
}

/**
 * Plans a bounded set of source-backed line/nutrient gaps. Priority nutrients
 * (added sugars, niacin, fiber, fats, cholesterol, vitamins/minerals) are
 * considered first; at most MAX_SOURCE_SUPPLEMENT_GAPS pairs are sent to one AI
 * request. The full gap count is retained for truthful reporting.
 */
function planSourceSupplementGaps(nutrition: NonNullable<ShisoToolContext['nutrition']>): {
  readonly focus: ReadonlyArray<{ line_ref: string; unknown_nutrients: ReadonlyArray<string> }>;
  readonly lines: ReadonlyArray<SourceSupplementPlanLine>;
  readonly total: number;
  readonly sourcesByRef: ReadonlyMap<string, { nutrient_ids: ReadonlyArray<NutrientId>; source_food_id?: string; source_release?: string; weight_grams?: number }>;
} {
  const coverage = nutrition.nutrientCoverage ?? [];
  const priority = (id: string): number => {
    if (id === 'added_sugars') return 0;
    if (id === 'niacin') return 1;
    if (id === 'fiber') return 2;
    if (id === 'saturated_fat') return 3;
    if (id === 'trans_fat') return 4;
    if (id === 'cholesterol') return 5;
    if (id.startsWith('vitamin_') || ['thiamin', 'riboflavin', 'pantothenic_acid', 'vitamin_b6', 'biotin', 'folate', 'vitamin_b12', 'choline', 'manganese', 'selenium', 'potassium', 'calcium', 'iron', 'magnesium', 'phosphorus', 'zinc', 'copper'].includes(id)) return 6;
    return 10;
  };
  const entries = [...coverage].sort((left, right) => priority(left.id) - priority(right.id));
  // The set of nutrients each source line genuinely contributes, derived from
  // the authoritative coverage projection. A nutrient is present for a line
  // exactly when the line is NOT listed among that nutrient's missing lines.
  const missingByRef = new Map<string, Set<string>>();
  for (const entry of coverage) {
    for (const line of entry.missing_source_lines) {
      const ids = missingByRef.get(line.line_ref) ?? new Set<string>();
      ids.add(entry.id);
      missingByRef.set(line.line_ref, ids);
    }
  }
  const byRef = new Map<string, SourceSupplementPlanLine>();
  let total = 0;
  let plannedPairs = 0;
  for (const entry of entries) {
    for (const line of entry.missing_source_lines) {
      total += 1;
      if (plannedPairs >= MAX_SOURCE_SUPPLEMENT_GAPS) continue;
      let planned = byRef.get(line.line_ref);
      if (!planned) {
        planned = {
          line_ref: line.line_ref,
          label: line.label,
          ...(line.fdc_id !== undefined ? { fdc_id: line.fdc_id } : {}),
          ...(line.record_digest !== undefined ? { record_digest: line.record_digest } : {}),
          ...(line.weight_grams !== undefined ? { weight_grams: line.weight_grams } : {}),
          ...(line.source_release !== undefined ? { source_release: line.source_release } : {}),
          nutrients: new Set<string>(),
        };
        byRef.set(line.line_ref, planned);
      }
      planned.nutrients.add(entry.id);
      plannedPairs += 1;
    }
  }
  const lines = [...byRef.values()];
  const sourcesByRef = new Map<string, { nutrient_ids: ReadonlyArray<NutrientId>; source_food_id?: string; source_release?: string; weight_grams?: number }>();
  for (const line of lines) {
    const missing = missingByRef.get(line.line_ref) ?? new Set<string>();
    sourcesByRef.set(line.line_ref, {
      nutrient_ids: coverage.filter((entry) => !missing.has(entry.id)).map((entry) => entry.id as NutrientId),
      ...(line.fdc_id !== undefined ? { source_food_id: String(line.fdc_id) } : {}),
      ...(line.source_release !== undefined ? { source_release: line.source_release } : {}),
      ...(line.weight_grams !== undefined ? { weight_grams: line.weight_grams } : {}),
    });
  }
  return {
    focus: lines.map((line) => ({ line_ref: line.line_ref, unknown_nutrients: [...line.nutrients] })),
    lines,
    total,
    sourcesByRef,
  };
}

async function completeNutrientGaps(
  ctx: ShisoToolContext,
  nutrition: NonNullable<ShisoToolContext['nutrition']>,
  initialCoverage: NutritionCoverage,
  gaps: ReadonlyArray<EffectiveNutritionLine>,
  recipeTextByRef: ReadonlyMap<string, string>,
  unchanged: () => boolean,
  signal?: AbortSignal,
): Promise<ShisoObservation> {
  const steps: Array<Record<string, unknown>> = [];
  const notes: Array<{ line_ref?: string; stage: 'usda_branded' | 'external_research' | 'ai_estimate'; message: string }> = [];
  const existingByRef = new Map<string, AiNutrientContribution>();
  for (const contribution of nutrition.aiContributions ?? []) existingByRef.set(contribution.line_ref, contribution);
  const researchUpgrades = new Map<string, AiNutrientContribution>();
  const filledByRef = new Map<string, ReadonlyArray<{ id: string; amount: number; unit: string }>>();
  let researchAttempted = false;
  let aiAttempted = false;

  // Credible evidence first: the existing AN-WEB-1 research operation may upgrade
  // an AI-estimated line to source-backed evidence. It is bounded to the same
  // three-target request limit and never touches source-backed USDA lines.
  const researchTargets = gaps
    .slice(0, MAX_COMPLETION_RESEARCH_TARGETS)
    .flatMap((line) => {
      const lineText = recipeTextByRef.get(line.line_ref);
      if (lineText === undefined) return [];
      const targets = completionTarget({ line_ref: line.line_ref, text: lineText });
      if (!targets) return [];
      return [{ line: { ...line, text: lineText }, target: { ...targets.research, ambiguity: 'missing_information' as const } }];
    });

  if (ctx.researchNutrition === undefined) {
    steps.push({ stage: 'external_research', attempted: false, selected: 0, message: 'External nutrition research is not available in this deployment.' });
  } else if (researchTargets.length === 0) {
    steps.push({ stage: 'external_research', attempted: false, selected: 0, message: 'No nutrient-gap line is eligible for external research.' });
  } else {
    researchAttempted = true;
    const lineRefs = researchTargets.map((entry) => entry.line.line_ref);
    const lineTextByRef = Object.fromEntries(researchTargets.map((entry) => [entry.line.line_ref, entry.line.text]));
    let result: ShisoExternalResearchOutcome | undefined;
    try {
      result = await ctx.researchNutrition({
        targets: researchTargets.map((entry) => entry.target),
        lineRefs,
        lineTextByRef,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch {
      notes.push({ stage: 'external_research', message: 'External nutrition research failed.' });
    }
    if (signal?.aborted) return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
    if (!unchanged()) return fail('complete_nutrition', 'stale_recipe', 'The recipe changed during external research. No contribution was accepted.');
    if (result?.ok === true) {
      const allowed = new Set(lineRefs);
      for (const contribution of result.contributions ?? []) {
        if (!allowed.has(contribution.line_ref) || contribution.classification !== 'source_backed') continue;
        const existing = existingByRef.get(contribution.line_ref);
        if (!existing) continue;
        const existingKnown = Object.keys(existing.nutrients);
        const sourceCoversExisting = existingKnown.every(
          (id) => (contribution.nutrients as Record<string, unknown>)[id] !== undefined
        );
        if (!sourceCoversExisting) {
          notes.push({
            line_ref: contribution.line_ref,
            stage: 'external_research',
            message: 'Research evidence was less complete than the existing AI estimate and was not used.',
          });
          continue;
        }
        researchUpgrades.set(contribution.line_ref, contribution);
      }
      for (const skipped of result.skipped ?? []) {
        notes.push({ line_ref: skipped.line_ref, stage: 'external_research', message: `External research skipped (${skipped.reason}).` });
      }
      if (researchUpgrades.size === 0) {
        notes.push({ stage: 'external_research', message: 'External research returned no usable source-backed nutrient evidence.' });
      }
    } else if (result !== undefined) {
      notes.push({ stage: 'external_research', message: 'External nutrition research is unavailable.' });
    }
    steps.push({ stage: 'external_research', attempted: true, selected: researchUpgrades.size });
  }

  // One bounded AI request covers both:
  //   - declared unknown nutrients on EXISTING ai_estimate lines;
  //   - missing nutrients on source-backed lines, proposed as separate supplements.
  const sourcePlan = planSourceSupplementGaps(nutrition);
  const existingSupplements = [...(nutrition.nutrientSupplements ?? [])];
  const allSupplements = [...existingSupplements];
  const supplementSeen = new Set(existingSupplements.map((entry) => `${entry.line_ref}\u0000${entry.nutrient_id}`));
  const newSupplements: AiNutrientSupplement[] = [];
  const remainingGaps = gaps.filter((line) => !researchUpgrades.has(line.line_ref));
  const focusByRef = new Map<string, Set<string>>();
  for (const line of remainingGaps) {
    const ids = focusByRef.get(line.line_ref) ?? new Set<string>();
    for (const id of line.unknown_nutrients) ids.add(id);
    focusByRef.set(line.line_ref, ids);
  }
  for (const line of sourcePlan.focus) {
    const ids = focusByRef.get(line.line_ref) ?? new Set<string>();
    for (const id of line.unknown_nutrients) ids.add(id);
    focusByRef.set(line.line_ref, ids);
  }
  const combinedFocus = [...focusByRef.entries()].map(([lineRef, ids]) => ({
    line_ref: lineRef,
    unknown_nutrients: [...ids],
  }));

  if (ctx.runAiNutrition === undefined) {
    steps.push({ stage: 'ai_estimate', attempted: false, selected: 0, message: 'AI nutrition estimation is not available in this deployment.' });
    steps.push({ stage: 'source_supplements', attempted: false, selected: 0, examined: sourcePlan.total, message: 'AI supplemental estimation is not available in this deployment.' });
  } else if (combinedFocus.length === 0) {
    steps.push({ stage: 'ai_estimate', attempted: false, selected: 0, message: 'No AI-estimated or source-backed nutrient gaps remain.' });
    steps.push({ stage: 'source_supplements', attempted: false, selected: 0, examined: sourcePlan.total, message: 'No source-backed nutrient gaps remain.' });
  } else {
    aiAttempted = true;
    let aiResult: Awaited<ReturnType<NonNullable<ShisoToolContext['runAiNutrition']>>> | undefined;
    try {
      aiResult = await ctx.runAiNutrition(signal, { apply: false, nutrientGapFocus: combinedFocus });
    } catch {
      aiResult = { ok: false, message: 'The AI estimate service could not be reached.' };
    }
    if (signal?.aborted) return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
    if (!unchanged()) return fail('complete_nutrition', 'stale_recipe', 'The recipe changed during AI nutrient-gap estimation. No contribution was accepted.');
    if (aiResult?.ok === true) {
      const gapByRef = new Map(remainingGaps.map((line) => [line.line_ref, line]));
      for (const contribution of aiResult.contributions ?? []) {
        const line = gapByRef.get(contribution.line_ref);
        const existing = existingByRef.get(contribution.line_ref);
        if (!line || !existing) continue;
        const merged = mergeGapContribution(existing, contribution);
        if (merged.filled.length > 0) {
          existingByRef.set(contribution.line_ref, merged.contribution);
          filledByRef.set(contribution.line_ref, merged.filled);
        }
      }

      const sourceByRef = new Map(sourcePlan.lines.map((line) => [line.line_ref, line]));
      const recipeDigest = nutrition.recipeDigest;
      const reviewIdentity = nutrition.reviewIdentity;
      if (sourcePlan.lines.length > 0) {
        if (!recipeDigest || !reviewIdentity) {
          notes.push({ stage: 'ai_estimate', message: 'Source-backed supplements could not be bound to the current recipe/review identity.' });
        } else {
          const proposed: AiNutrientSupplement[] = [];
          for (const contribution of aiResult.contributions ?? []) {
            if (contribution.disposition === 'excluded') continue;
            const line = sourceByRef.get(contribution.line_ref);
            if (!line) continue;
            if (
              contribution.weight_grams !== undefined &&
              line.weight_grams !== undefined &&
              Math.abs(contribution.weight_grams - line.weight_grams) > 0.05
            ) {
              notes.push({
                line_ref: line.line_ref,
                stage: 'ai_estimate',
                message: 'The AI estimate used a different weight basis than the verified source line, so no supplement was proposed.',
              });
              continue;
            }
            const authoredLine = (recipeTextByRef.get(line.line_ref) ?? line.label).slice(0, 200);
            for (const nutrientId of line.nutrients) {
              const key = `${line.line_ref}\u0000${nutrientId}`;
              if (supplementSeen.has(key)) continue;
              const value = contribution.nutrients[nutrientId as NutrientId];
              if (!value || !Number.isFinite(value.amount) || value.amount <= 0) continue;
              const definition = NUTRIENT_REGISTRY[nutrientId as NutrientId];
              if (!definition || value.unit !== definition.unit) continue;
              if (line.fdc_id === undefined || line.weight_grams === undefined || line.source_release === undefined) {
                notes.push({ line_ref: line.line_ref, stage: 'ai_estimate', message: 'The source identity or resolved weight is unavailable, so no supplement was proposed.' });
                continue;
              }
              const assumptions = [...new Set([
                ...contribution.assumptions,
                'Supplemental AI estimate for a nutrient absent from the verified USDA record; the USDA values are unchanged.',
              ])].slice(0, 12);
              proposed.push({
                supplement_version: 'ai_nutrient_supplement_v1',
                line_ref: line.line_ref,
                ingredient: authoredLine,
                nutrient_id: nutrientId as NutrientId,
                amount: value.amount,
                unit: definition.unit,
                classification: 'ai_estimate',
                source_kind: 'ai_supplement',
                source_food_id: String(line.fdc_id),
                source_release: line.source_release,
                weight_grams: line.weight_grams,
                quantity_basis: `${line.label} — ${line.weight_grams} g resolved source weight`.slice(0, 200),
                assumptions,
                confidence: contribution.confidence,
                recipe_digest: recipeDigest,
                review_identity: reviewIdentity,
              });
            }
          }
          if (proposed.length > 0) {
            const validated = validateAiNutrientSupplements(proposed, {
              recipe_digest: recipeDigest,
              review_identity: reviewIdentity,
              line_text_by_ref: Object.fromEntries(recipeTextByRef),
              sources_by_ref: sourcePlan.sourcesByRef,
            });
            if (validated.ok) {
              for (const supplement of validated.supplements) {
                const key = `${supplement.line_ref}\u0000${supplement.nutrient_id}`;
                if (supplementSeen.has(key)) continue;
                supplementSeen.add(key);
                allSupplements.push(supplement);
                newSupplements.push(supplement);
              }
            } else {
              notes.push({ stage: 'ai_estimate', message: `Supplemental proposals were rejected (${(validated as { code?: string }).code ?? 'invalid'}).` });
            }
          }
        }
      }
      if (filledByRef.size === 0 && newSupplements.length === 0) {
        notes.push({ stage: 'ai_estimate', message: 'The AI estimate returned no additional defensible nutrient values.' });
      }
    } else {
      notes.push({ stage: 'ai_estimate', message: aiResult?.message ?? 'AI nutrition estimation did not return a usable contribution.' });
    }
    steps.push({ stage: 'ai_estimate', attempted: true, selected: filledByRef.size });
    steps.push({ stage: 'source_supplements', attempted: true, examined: sourcePlan.total, selected: newSupplements.length });
  }

  const merged = new Map(existingByRef);
  for (const [lineRef, contribution] of researchUpgrades) merged.set(lineRef, contribution);
  const contributions = [...merged.values()];
  if (!unchanged()) return fail('complete_nutrition', 'stale_recipe', 'The recipe changed before the review could be updated. No contribution was accepted.');
  let accepted = false;
  try {
    accepted = ctx.acceptNutritionContributions(contributions, allSupplements);
  } catch {
    accepted = false;
  }
  if (!accepted) return fail('complete_nutrition', 'no_nutrition_review', 'The Advanced Nutrition review is not open for this recipe revision, so the prepared contributions were not accepted.');

  const finalCoverage = deriveNutritionCoverage(nutrition.rows, contributions);
  const brandedLines = finalCoverage.lines.filter((line) => line.contribution?.source_kind === 'usda_branded');
  const researchLines = finalCoverage.lines.filter((line) => line.contribution !== undefined && line.contribution.classification === 'source_backed' && line.contribution.source_kind !== 'usda_branded');
  const aiLines = finalCoverage.lines.filter((line) => line.contribution?.classification === 'ai_estimate');
  const partialLines = finalCoverage.lines.filter((line) => line.partial_known);
  const filled = [...filledByRef.values()].reduce((sum, ids) => sum + ids.length, 0);
  const upgraded = researchUpgrades.size;
  const wholeReport = buildWholeRecipeNutrientReport(
    ctx.nutrition?.nutrientCoverage ?? [],
    contributions,
    allSupplements,
    filledByRef,
  );
  const summary =
    `Ingredient coverage is ${finalCoverage.resolved + finalCoverage.excluded} of ${finalCoverage.total} lines ` +
    `(${finalCoverage.source_backed} generic USDA, ${brandedLines.length} USDA Branded, ${researchLines.length} external research, ${aiLines.length} AI-estimated). ` +
    `I examined ${gaps.length} AI-estimated line(s) with missing nutrient values: ` +
    (filled > 0
      ? `filled ${filled} nutrient value(s) across ${filledByRef.size} line(s) with validated AI estimates`
      : 'no additional defensible nutrient values were returned') +
    `${upgraded > 0 ? `; ${upgraded} line(s) upgraded to source-backed external research` : ''}. ` +
    `I examined ${sourcePlan.total} source-backed nutrient gap(s); this bounded pass proposed ${newSupplements.length} supplemental AI estimate(s)` +
    `${Math.max(0, sourcePlan.total - newSupplements.length) > 0 ? `, leaving ${Math.max(0, sourcePlan.total - newSupplements.length)} unsupplemented` : ''}. ` +
    `${partialLines.length > 0
      ? `${partialLines.length} line(s) still have unknown nutrients. `
      : wholeReport.total_nutrients === 0 ? 'No AI-estimated nutrient gaps remain. ' : ''}` +
    `${wholeRecipeNutrientSummary(wholeReport)} ` +
    `Verified USDA contributions were preserved. Nothing was applied or saved.`;

  return ok('complete_nutrition', summary, {
    total_lines: finalCoverage.total,
    accounted: finalCoverage.resolved + finalCoverage.excluded,
    remaining: finalCoverage.unresolved,
    initial_unresolved: 0,
    resolved_new: 0,
    ingredient_coverage: {
      total_lines: finalCoverage.total,
      accounted: finalCoverage.resolved + finalCoverage.excluded,
      unresolved: finalCoverage.unresolved,
      generic_usda: finalCoverage.source_backed,
      usda_branded: brandedLines.length,
      external_research: researchLines.length,
      ai_estimated: aiLines.length,
      excluded: finalCoverage.excluded,
    },
    whole_recipe_nutrient_coverage: wholeReport,
    nutrient_coverage: {
      gap_lines_examined: gaps.length,
      filled_values: filled,
      filled_lines: filledByRef.size,
      upgraded_to_source: upgraded,
      source_gaps_examined: sourcePlan.total,
      source_gaps_focused: sourcePlan.focus.length,
      source_supplements_this_pass: newSupplements.length,
      total_supplements: allSupplements.length,
      remaining_source_gap_values: wholeReport.remaining_source_gap_values,
      additional_completion_possible: wholeReport.additional_completion.possible,
      remaining_partial_lines: partialLines.length,
      remaining_partial_line_refs: partialLines.map((line) => line.line_ref),
      remaining_unknown_nutrients: partialLines.map((line) => ({ line_ref: line.line_ref, unknown_nutrients: line.unknown_nutrients })),
      partial_known: finalCoverage.partial_known,
    },
    breakdown: {
      generic_usda: finalCoverage.source_backed,
      usda_branded: brandedLines.length,
      external_research: researchLines.length,
      ai_estimated: aiLines.length,
      excluded: finalCoverage.excluded,
      qualitative: finalCoverage.qualitative,
      partial_known: finalCoverage.partial_known,
    },
    filled_line_refs: [...filledByRef.keys()],
    research_upgrade_line_refs: [...researchUpgrades.keys()],
    supplemental_line_refs: [...new Set(newSupplements.map((entry) => entry.line_ref))],
    supplemental_nutrient_ids: [...new Set(newSupplements.map((entry) => entry.nutrient_id))],
    notes: notes.map((note) => note.line_ref === undefined ? note.message : `${note.line_ref}: ${note.message}`).slice(0, 12),
    steps,
    honesty_note:
      'Existing USDA contributions were preserved unchanged. Only previously unknown nutrients on AI-estimated lines were filled; source-backed lines retained their verified values and received separate AI supplemental estimates only for nutrients absent from the source. ' +
      'No verified value, explicit zero, weight, source identity, or source release was overwritten. Supplemental and filled values remain AI estimates, not verified source records. Apply and Save remain separate explicit actions.',
  });
}

function brandedLookupFailureMessage(search: ShisoBrandedSearchOutcome): string {
  switch (search.code) {
    case 'not_configured': return 'USDA Branded lookup is not configured.';
    case 'rate_limited': return 'USDA Branded lookup was rate limited.';
    case 'auth_failed': return 'USDA Branded lookup is not authorized.';
    case 'timeout': return 'USDA Branded lookup timed out.';
    case 'not_found': return 'No USDA Branded record was found.';
    default: return 'USDA Branded lookup was unavailable.';
  }
}

function nutritionCompletionAlreadyCurrent(
  nutrition: NonNullable<ShisoToolContext['nutrition']>,
  coverage: NutritionCoverage,
): ShisoObservation {
  const wholeReport = buildWholeRecipeNutrientReport(
    nutrition.nutrientCoverage ?? [],
    nutrition.aiContributions ?? [],
    nutrition.nutrientSupplements ?? [],
    new Map(),
  );
  return ok(
    'complete_nutrition',
    `Ingredient coverage is ${coverage.resolved + coverage.excluded} of ${coverage.total} lines. ` +
      `${wholeRecipeNutrientSummary(wholeReport)} ` +
      'No new source or estimate request was needed. Existing verified USDA contributions are unchanged. Nothing was applied or saved.',
    {
      total_lines: coverage.total,
      accounted: coverage.resolved + coverage.excluded,
      remaining: coverage.unresolved,
      initial_unresolved: 0,
      resolved_new: 0,
      ingredient_coverage: {
        total_lines: coverage.total,
        accounted: coverage.resolved + coverage.excluded,
        unresolved: coverage.unresolved,
        generic_usda: coverage.source_backed,
        usda_branded: coverage.lines.filter((line) => line.contribution?.source_kind === 'usda_branded').length,
        external_research: coverage.lines.filter((line) => line.contribution?.classification === 'source_backed' && line.contribution.source_kind !== 'usda_branded').length,
        ai_estimated: coverage.ai_estimated,
        excluded: coverage.excluded,
      },
      nutrient_coverage: {
        gap_lines_examined: 0,
        filled_values: 0,
        filled_lines: 0,
        upgraded_to_source: 0,
        remaining_partial_lines: 0,
        remaining_partial_line_refs: [],
        remaining_unknown_nutrients: [],
        partial_known: 0,
      },
      breakdown: {
        generic_usda: coverage.source_backed,
        usda_branded: coverage.lines.filter((line) => line.contribution?.source_kind === 'usda_branded').length,
        external_research: coverage.lines.filter((line) => line.contribution?.classification === 'source_backed' && line.contribution.source_kind !== 'usda_branded').length,
        ai_estimated: coverage.ai_estimated,
        excluded: coverage.excluded,
        qualitative: coverage.qualitative,
        partial_known: coverage.partial_known,
      },
      nutrition_status: 'partial',
      preview_state: 'partial',
      whole_recipe_nutrient_coverage: wholeReport,
      steps: [],
      notes: [],
      honesty_note: 'No new provider or source request was made. This confirms only the review-declared nutrient gaps; it does not claim analytically complete nutrition for every USDA record.',
    },
  );
}

async function completeNutrition(ctx: ShisoToolContext, signal?: AbortSignal): Promise<ShisoObservation> {
  const recipe = ctx.recipe;
  if (recipe === null) {
    return fail('complete_nutrition', 'no_active_recipe', 'No recipe is currently open, so there is no nutrition to complete.');
  }

  // H-3B: general SHISO is allowed to initialize the application-owned review
  // itself. The review remains the same Phase 4 owner used by the visible
  // Advanced Nutrition surface; this only removes the accidental dependency on
  // that surface having been mounted first.
  let nutrition = ctx.nutrition;
  let initializedAnalysis: ShisoAnalysisOutcome | undefined;
  if (nutrition === null) {
    if (ctx.session === null && ctx.loadBundle !== undefined) {
      try {
        await ctx.loadBundle();
      } catch {
        return fail('complete_nutrition', 'analysis_unavailable', 'The authenticated USDA catalogue could not be loaded, so nutrition completion did not run.');
      }
      if (signal?.aborted) return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
    }
    if (ctx.session === null) {
      return fail(
        'complete_nutrition',
        'no_nutrition_review',
        'The authenticated USDA catalogue is not available, so no nutrition review could be initialized.',
      );
    }
    if (ctx.runAnalysis === undefined) {
      return fail(
        'complete_nutrition',
        'no_analysis_owner',
        'The application-owned nutrition review is not available for this recipe.',
      );
    }
    try {
      initializedAnalysis = await ctx.runAnalysis(signal);
    } catch {
      return fail('complete_nutrition', 'analysis_unavailable', 'The source nutrition analysis could not be completed.');
    }
    if (signal?.aborted) return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
    if (!initializedAnalysis.ok) {
      return fail('complete_nutrition', 'analysis_unavailable', initializedAnalysis.message ?? 'The source nutrition analysis could not be completed.');
    }
    nutrition = ctx.nutrition;
    if (nutrition === null) {
      return fail(
        'complete_nutrition',
        'no_nutrition_review',
        'The application could not publish the initialized nutrition review, so no values were accepted.',
      );
    }
  }
  if (!nutritionMatchesActiveRecipe(ctx)) {
    return fail(
      'complete_nutrition',
      'stale_recipe',
      'This nutrition review no longer matches the open recipe. Re-analyse the current recipe before completing it.',
    );
  }
  if (ctx.runAnalysis === undefined) {
    return fail(
      'complete_nutrition',
      'no_analysis_owner',
      'Advanced Nutrition is not open for this recipe, so I cannot run the source analysis.',
    );
  }
  if (ctx.acceptNutritionContributions === undefined) {
    return fail(
      'complete_nutrition',
      'no_nutrition_review',
      'The current Advanced Nutrition review cannot accept prepared contributions.',
    );
  }

  const snapshot = completionRecipeSnapshot(ctx);
  const snapshotKey = completionSnapshotKey(snapshot);
  const digestAtStart = nutrition.recipeDigest ?? null;
  const unchanged = () =>
    completionSnapshotKey(completionRecipeSnapshot(ctx)) === snapshotKey &&
    (digestAtStart === null || (ctx.nutrition?.recipeDigest ?? null) === digestAtStart);
  let initialCoverage = deriveNutritionCoverage(nutrition.rows, nutrition.aiContributions ?? []);
  let initialUnresolved = initialCoverage.lines.filter((line) => !line.resolved && line.status !== 'excluded');
  const recipeTextByRef = new Map<string, string>();
  for (const ingredient of ctx.recipe.ingredients) {
    if (typeof ingredient.line_ref === 'string') recipeTextByRef.set(ingredient.line_ref, ingredient.text);
  }

  let initialGaps = nutrientGapLines(initialCoverage);
  if (initialUnresolved.length === 0 && nutrition.rows.length > 0) {
    // SINC-4: a fully resolved source-backed recipe can still have nutrient
    // gaps that are absent from the verified USDA records. Explicit completion
    // must investigate those as separately labeled supplements.
    const hasSourceBackedGaps = (nutrition.nutrientCoverage ?? []).some(
      (entry) => entry.missing_source_lines.length > 0
    );
    if (initialGaps.length > 0 || hasSourceBackedGaps) {
      return completeNutrientGaps(ctx, nutrition, initialCoverage, initialGaps, recipeTextByRef, unchanged, signal);
    }
    return nutritionCompletionAlreadyCurrent(nutrition, initialCoverage);
  }

  let analysis = initializedAnalysis;
  if (analysis === undefined) {
    try {
      analysis = await ctx.runAnalysis(signal);
    } catch {
      return fail('complete_nutrition', 'analysis_unavailable', 'The source nutrition analysis could not be completed.');
    }
  }
  if (signal?.aborted) {
    return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
  }
  if (!analysis.ok) {
    return fail('complete_nutrition', 'analysis_unavailable', analysis.message ?? 'The source nutrition analysis could not be completed.');
  }
  if (!unchanged()) {
    return fail('complete_nutrition', 'stale_recipe', 'The recipe changed while the source analysis was running. No contribution was accepted.');
  }

  // `runAnalysis` updates the application-owned review controller. Read that
  // owner again before deriving completion coverage; the context object that
  // was captured above may still describe the pre-analysis partial review.
  const refreshedNutrition = ctx.nutrition;
  if (refreshedNutrition !== null) nutrition = refreshedNutrition;
  if (!nutritionMatchesActiveRecipe(ctx)) {
    return fail(
      'complete_nutrition',
      'stale_recipe',
      'This nutrition review no longer matches the open recipe. No contribution was accepted.',
    );
  }
  initialCoverage = deriveNutritionCoverage(nutrition.rows, nutrition.aiContributions ?? []);
  initialUnresolved = initialCoverage.lines.filter((line) => !line.resolved && line.status !== 'excluded');
  initialGaps = nutrientGapLines(initialCoverage);

  // The fresh source analysis may have resolved every line that was unresolved
  // in the retained review. In that case, do not continue into branded/web/AI
  // fallbacks merely because the old snapshot was partial.
  if (initialUnresolved.length === 0 && nutrition.rows.length > 0) {
    const hasSourceBackedGaps = (nutrition.nutrientCoverage ?? []).some(
      (entry) => entry.missing_source_lines.length > 0
    );
    if (initialGaps.length > 0 || hasSourceBackedGaps) {
      return completeNutrientGaps(ctx, nutrition, initialCoverage, initialGaps, recipeTextByRef, unchanged, signal);
    }
    return nutritionCompletionAlreadyCurrent(nutrition, initialCoverage);
  }

  // The review snapshot can be empty when the catalogue has just been loaded.
  // The fresh analysis outcome is then the authoritative unresolved set.
  const unresolvedLines = initialUnresolved.length > 0
    ? initialUnresolved
    : analysis.unresolved_line_refs.map((ref) => ({
        line_ref: ref,
        source_status: 'needs_match' as const,
        status: 'needs_match' as const,
      } as unknown as (typeof initialUnresolved)[number]));

  const steps: Array<Record<string, unknown>> = [];
  const notes: Array<{ line_ref?: string; stage: 'usda_branded' | 'external_research' | 'ai_estimate'; message: string }> = [];
  const branded: AiNutrientContribution[] = [];
  const research: AiNutrientContribution[] = [];
  let ai: AiNutrientContribution[] = [];
  let brandedAttempted = false;
  let researchAttempted = false;
  let aiAttempted = false;

  const brandedEligible = ctx.brandedEligibleRefs !== undefined ? new Set(ctx.brandedEligibleRefs) : null;
  const brandedTargets = unresolvedLines
    .filter((line) => line.source_status === 'needs_match')
    .filter((line) => brandedEligible === null || brandedEligible.has(line.line_ref))
    .slice(0, MAX_COMPLETION_BRANDED_SEARCHES);

  if (ctx.searchBrandedFoods === undefined) {
    steps.push({ stage: 'usda_branded', attempted: false, selected: 0, message: 'USDA Branded lookup is not available in this deployment.' });
  } else if (brandedTargets.length === 0) {
    steps.push({ stage: 'usda_branded', attempted: false, selected: 0, message: 'No unresolved identity line is eligible for a branded lookup.' });
  } else {
    brandedAttempted = true;
    for (const line of brandedTargets) {
      if (signal?.aborted) return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
      const lineText = recipeTextByRef.get(line.line_ref);
      if (lineText === undefined) {
        notes.push({ line_ref: line.line_ref, stage: 'usda_branded', message: 'The authored ingredient text is unavailable for a branded lookup.' });
        continue;
      }
      const targets = completionTarget({ line_ref: line.line_ref, text: lineText });
      if (!targets) {
        notes.push({ line_ref: line.line_ref, stage: 'usda_branded', message: 'The ingredient text has no usable food name for a branded lookup.' });
        continue;
      }
      let search: ShisoBrandedSearchOutcome;
      try {
        search = await ctx.searchBrandedFoods({
          lineRef: line.line_ref,
          query: targets.target.query,
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch {
        notes.push({ line_ref: line.line_ref, stage: 'usda_branded', message: 'The USDA Branded lookup failed.' });
        continue;
      }
      if (signal?.aborted) return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
      if (!unchanged()) {
        return fail('complete_nutrition', 'stale_recipe', 'The recipe changed during the branded lookup. No contribution was accepted.');
      }
      if (!search.ok) {
        notes.push({ line_ref: line.line_ref, stage: 'usda_branded', message: brandedLookupFailureMessage(search) });
        continue;
      }
      const candidate = (search.candidates ?? []).find((entry) =>
        entry.usable === true &&
        entry.match_quality === 'strong' &&
        typeof entry.evidence_id === 'string' &&
        entry.evidence_id.length >= 8
      );
      if (!candidate) {
        notes.push({ line_ref: line.line_ref, stage: 'usda_branded', message: 'No strong, usable USDA Branded product was found.' });
        continue;
      }
      const built = buildBrandedContribution(candidate, targets.target);
      if (!built.ok) {
        notes.push({ line_ref: line.line_ref, stage: 'usda_branded', message: `The branded product could not be scaled safely (${(built as { reason?: string }).reason ?? 'unsupported'}).` });
        continue;
      }
      branded.push(built.contribution);
    }
    steps.push({ stage: 'usda_branded', attempted: true, selected: branded.length });
  }

  const researchEligible = ctx.researchEligibleRefs !== undefined ? new Set(ctx.researchEligibleRefs) : null;
  const brandedRefs = new Set(branded.map((entry) => entry.line_ref));
  const researchTargets = unresolvedLines
    .filter((line) => line.source_status === 'needs_match')
    .filter((line) => !brandedRefs.has(line.line_ref))
    .filter((line) => researchEligible === null || researchEligible.has(line.line_ref))
    .slice(0, MAX_COMPLETION_RESEARCH_TARGETS)
    .flatMap((line) => {
      const lineText = recipeTextByRef.get(line.line_ref);
      if (lineText === undefined) return [];
      const targets = completionTarget({ line_ref: line.line_ref, text: lineText });
      if (!targets) return [];
      return [{ line: { ...line, text: lineText }, target: { ...targets.research, ambiguity: 'missing_information' as const } }];
    });

  if (ctx.researchNutrition === undefined) {
    steps.push({ stage: 'external_research', attempted: false, selected: 0, message: 'External nutrition research is not available in this deployment.' });
  } else if (researchTargets.length === 0) {
    steps.push({ stage: 'external_research', attempted: false, selected: 0, message: 'No remaining identity line is eligible for external research.' });
  } else {
    researchAttempted = true;
    const lineRefs = researchTargets.map((entry) => entry.line.line_ref);
    const lineTextByRef = Object.fromEntries(researchTargets.map((entry) => [entry.line.line_ref, entry.line.text]));
    let result: ShisoExternalResearchOutcome | undefined;
    try {
      result = await ctx.researchNutrition({
        targets: researchTargets.map((entry) => entry.target),
        lineRefs,
        lineTextByRef,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch {
      notes.push({ stage: 'external_research', message: 'External nutrition research failed.' });
    }
    if (signal?.aborted) return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
    if (!unchanged()) {
      return fail('complete_nutrition', 'stale_recipe', 'The recipe changed during external research. No contribution was accepted.');
    }
    if (result?.ok === true) {
      const allowed = new Set(lineRefs);
      for (const contribution of result.contributions ?? []) {
        if (allowed.has(contribution.line_ref) && !brandedRefs.has(contribution.line_ref)) research.push(contribution);
      }
      for (const skipped of result.skipped ?? []) {
        notes.push({ line_ref: skipped.line_ref, stage: 'external_research', message: `External research skipped (${skipped.reason}).` });
      }
      if (research.length === 0) notes.push({ stage: 'external_research', message: 'External research returned no usable source-backed contribution.' });
    } else if (result !== undefined) {
      notes.push({ stage: 'external_research', message: result.message ?? 'External nutrition research did not return usable evidence.' });
    }
    steps.push({ stage: 'external_research', attempted: true, selected: research.length });
  }

  const coveredRefs = new Set([...branded, ...research].map((entry) => entry.line_ref));
  const remainingForAi = unresolvedLines.filter((line) => !coveredRefs.has(line.line_ref));
  if (ctx.runAiNutrition === undefined) {
    steps.push({ stage: 'ai_estimate', attempted: false, selected: 0, message: 'AI nutrition estimation is not available in this deployment.' });
  } else if (remainingForAi.length === 0) {
    steps.push({ stage: 'ai_estimate', attempted: false, selected: 0, message: 'Every remaining unresolved line was covered by verified source evidence.' });
  } else {
    aiAttempted = true;
    let aiResult: Awaited<ReturnType<NonNullable<ShisoToolContext['runAiNutrition']>>> | undefined;
    try {
      aiResult = await ctx.runAiNutrition(signal);
    } catch {
      aiResult = { ok: false, message: 'The AI estimate service could not be reached.' };
    }
    if (signal?.aborted) return fail('complete_nutrition', 'analysis_unavailable', 'The nutrition completion was cancelled.');
    if (!unchanged()) {
      return fail('complete_nutrition', 'stale_recipe', 'The recipe changed during AI estimation. No contribution was accepted.');
    }
    if (aiResult?.ok === true) {
      const remainingRefs = new Set(remainingForAi.map((line) => line.line_ref));
      ai = (aiResult.contributions ?? []).filter((entry) => remainingRefs.has(entry.line_ref));
      if (ai.length === 0) notes.push({ stage: 'ai_estimate', message: 'The AI estimate returned no usable contribution for the remaining lines.' });
    } else {
      notes.push({ stage: 'ai_estimate', message: aiResult?.message ?? 'AI nutrition estimation did not return a usable contribution.' });
    }
    steps.push({ stage: 'ai_estimate', attempted: true, selected: ai.length });
  }

  // One cumulative write to the UNSAVED review. Existing contributions are
  // preserved; branded and researched evidence outrank an AI estimate on the
  // same line. Source-resolved lines remain source-resolved because the existing
  // combiner never lets a contribution replace deterministic USDA evidence.
  const merged = new Map<string, AiNutrientContribution>();
  for (const entry of nutrition.aiContributions ?? []) merged.set(entry.line_ref, entry);
  for (const entry of ai) merged.set(entry.line_ref, entry);
  for (const entry of research) merged.set(entry.line_ref, entry);
  for (const entry of branded) merged.set(entry.line_ref, entry);
  const contributions = [...merged.values()];

  if (!unchanged()) {
    return fail('complete_nutrition', 'stale_recipe', 'The recipe changed before the review could be updated. No contribution was accepted.');
  }
  let accepted = false;
  try {
    accepted = ctx.acceptNutritionContributions(contributions);
  } catch {
    accepted = false;
  }
  if (!accepted) {
    return fail(
      'complete_nutrition',
      'no_nutrition_review',
      'The Advanced Nutrition review is not open for this recipe revision, so the prepared contributions were not accepted.',
    );
  }

  const finalCoverage = deriveNutritionCoverage(nutrition.rows, contributions);
  const brandedLines = finalCoverage.lines.filter((line) => line.contribution?.source_kind === 'usda_branded');
  const researchLines = finalCoverage.lines.filter((line) =>
    line.contribution !== undefined &&
    line.contribution.classification === 'source_backed' &&
    line.contribution.source_kind !== 'usda_branded'
  );
  const aiLines = finalCoverage.lines.filter((line) => line.contribution?.classification === 'ai_estimate');
  const remainingLines = finalCoverage.lines.filter((line) => !line.resolved && line.status !== 'excluded');
  const accounted = finalCoverage.resolved + finalCoverage.excluded;
  const resolvedNew = Math.max(0, unresolvedLines.length - remainingLines.length);
  const hasEstimatedOrRepresentativeSource =
    brandedLines.length > 0 || researchLines.length > 0 || aiLines.length > 0;
  const nutritionStatus =
    remainingLines.length === 0 && finalCoverage.partial_known === 0 && !hasEstimatedOrRepresentativeSource
      ? 'complete'
      : 'partial';
  const resolvedByAi = new Set(aiLines.map((line) => line.line_ref));
  const stillUnresolvedRefs = new Set(remainingLines.map((line) => line.line_ref));
  const displayNotes = notes.flatMap((note) => {
    if (note.line_ref === undefined) return [note.message];
    const label = recipeTextByRef.get(note.line_ref) ?? note.line_ref;
    if (stillUnresolvedRefs.has(note.line_ref)) {
      return [`${label}: ${note.message} It still needs attention.`];
    }
    if (resolvedByAi.has(note.line_ref)) {
      return [`${label}: ${note.message} Completed by a validated AI estimate.`];
    }
    return [];
  });
  const summary =
    `Completed a bounded source-first nutrition pass: ${resolvedNew} of ${unresolvedLines.length} previously unresolved line(s) resolved. ` +
    `${finalCoverage.source_backed} generic USDA, ${brandedLines.length} USDA Branded, ${researchLines.length} external research, ` +
    `${aiLines.length} AI-estimated; ${accounted} of ${finalCoverage.total} lines are now accounted for` +
    `${remainingLines.length > 0 ? `; ${remainingLines.length} still need attention` : ''}. ` +
    `${finalCoverage.partial_known > 0 ? `${finalCoverage.partial_known} line(s) retain unknown nutrients. ` : ''}Nothing was applied or saved.`;

  return ok('complete_nutrition', summary, {
    total_lines: finalCoverage.total,
    accounted,
    remaining: remainingLines.length,
    initial_unresolved: unresolvedLines.length,
    resolved_new: resolvedNew,
    breakdown: {
      generic_usda: finalCoverage.source_backed,
      usda_branded: brandedLines.length,
      external_research: researchLines.length,
      ai_estimated: aiLines.length,
      excluded: finalCoverage.excluded,
      qualitative: finalCoverage.qualitative,
      partial_known: finalCoverage.partial_known,
    },
    branded_line_refs: brandedLines.map((line) => line.line_ref),
    research_line_refs: researchLines.map((line) => line.line_ref),
    ai_line_refs: aiLines.map((line) => line.line_ref),
    remaining_line_refs: remainingLines.map((line) => line.line_ref),
    remaining_lines: remainingLines.slice(0, 20).map((line) => ({
      line_ref: line.line_ref,
      status: line.status,
      known_nutrients: line.known_nutrients,
      unknown_nutrients: line.unknown_nutrients,
    })),
    partial_lines: finalCoverage.lines
      .filter((line) => line.partial_known)
      .slice(0, 20)
      .map((line) => ({
        line_ref: line.line_ref,
        unknown_nutrients: line.unknown_nutrients,
      })),
    nutrition_status: nutritionStatus,
    preview_state: remainingLines.length === 0 ? nutritionStatus : 'partial',
    steps,
    notes: displayNotes.slice(0, 12),
    honesty_note:
      'Branded and researched contributions are proposals in the UNSAVED working review. ' +
      'Apply remains an explicit user action and performs the server-authenticated branded check; Save to Vault remains a separate explicit action. ' +
      (aiAttempted ? 'AI values are estimates, not authenticated source records. ' : '') +
      'Unknown nutrients are not treated as zero.',
  });
}

/**
 * Starts or refreshes the EXISTING Advanced Nutrition analysis through its
 * owner. It delegates entirely: the owner runs the same adaptation, the same
 * deterministic matcher, the same portion authority and the same calculator the
 * Calculate button runs. SHISO learns the outcome; it does not produce it.
 */
async function runNutritionAnalysis(ctx: ShisoToolContext, signal?: AbortSignal): Promise<ShisoObservation> {
  if (ctx.recipe === null) {
    return fail(
      'run_nutrition_analysis',
      'no_active_recipe',
      'No recipe is currently open, so there is nothing to analyse.',
    );
  }

  // H-1F, Test A: the catalogue is never loaded at startup, so on a recipe page
  // this was the single reason nutrition could not run. Clear it through the
  // existing controller instead of failing.
  if (ctx.session === null && ctx.loadBundle !== undefined) {
    try {
      await ctx.loadBundle();
    } catch {
    }
    if (signal?.aborted) return fail('run_nutrition_analysis', 'analysis_unavailable', 'The nutrition analysis was cancelled.');
    if (ctx.session === null) {
      return fail(
        'run_nutrition_analysis',
        'analysis_unavailable',
        'The authenticated USDA catalogue could not be loaded, so nutrition analysis did not run.',
      );
    }
  }

  if (ctx.runAnalysis === undefined) {
    return fail(
      'run_nutrition_analysis',
      'no_analysis_owner',
      'Advanced Nutrition is not open for this recipe. Open Advanced Nutrition for it and the analysis will run there.',
    );
  }
  let outcome: ShisoAnalysisOutcome;
  try {
    outcome = await ctx.runAnalysis(signal);
  } catch {
    return fail(
      'run_nutrition_analysis',
      'analysis_unavailable',
      'Advanced Nutrition could not complete the analysis.',
    );
  }
  if (!outcome.ok) {
    return fail(
      'run_nutrition_analysis',
      'analysis_unavailable',
      outcome.message ?? 'Advanced Nutrition could not complete the analysis.',
    );
  }
  if (signal?.aborted) {
    // Cancellation is represented by the turn-level outcome, not by the
    // capability observation vocabulary. The conversation checks the owning
    // signal immediately after this promise settles and discards the result.
    return fail('run_nutrition_analysis', 'analysis_unavailable', 'The nutrition analysis was cancelled.');
  }
  const beforeAiNutrition = ctx.nutrition;
  if (beforeAiNutrition && !nutritionMatchesActiveRecipe(ctx)) {
    return fail('run_nutrition_analysis', 'stale_recipe', 'The nutrition review belongs to an older recipe revision. Refresh Advanced Nutrition for the current recipe and retry.');
  }
  const beforeAiCoverage = beforeAiNutrition && nutritionMatchesActiveRecipe(ctx)
    ? deriveNutritionCoverage(beforeAiNutrition.rows, beforeAiNutrition.aiContributions ?? [])
    : null;
  let aiResult: Awaited<ReturnType<NonNullable<ShisoToolContext['runAiNutrition']>>> | undefined;
  // Avoid another provider request once every line already has usable nutrition.
  // Remaining unknown nutrients are reported for review instead of triggering
  // the same estimate pass repeatedly.
  if (ctx.runAiNutrition !== undefined && (beforeAiCoverage === null || beforeAiCoverage.unresolved > 0)) {
    try { aiResult = await ctx.runAiNutrition(signal); } catch { aiResult = { ok: false, message: 'The AI estimate service could not be reached.' }; }
  }
  const currentNutrition = ctx.nutrition;
  const freshAiContributions = aiResult?.ok ? aiResult.contributions ?? [] : [];
  const freshRefs = new Set(freshAiContributions.map((line) => line.line_ref));
  const allContributions = [
    ...freshAiContributions,
    ...(currentNutrition?.aiContributions ?? []).filter((line) => !freshRefs.has(line.line_ref)),
  ];
  const coverage = currentNutrition
    ? deriveNutritionCoverage(currentNutrition.rows, allContributions)
    : null;
  const acceptedAi = coverage
    ? new Set(coverage.lines.filter((line) => line.contribution?.classification === 'ai_estimate').map((line) => line.line_ref))
    : acceptedAiEstimatedLines([], freshAiContributions);
  const acceptedAiCount = acceptedAi.size;
  const unresolvedRefs = coverage
    ? coverage.lines.filter((line) => !line.resolved && line.status !== 'excluded').map((line) => line.line_ref)
    : outcome.unresolved_line_refs.filter((ref) => !acceptedAi.has(ref));
  const needsAmount = coverage?.needs_amount ?? outcome.needs_amount;
  const needsMatch = coverage?.needs_match ?? outcome.needs_match;
  const reviewSuggested = coverage?.review_suggested ?? 0;
  const aiUnknown = (coverage?.partial_known ?? 0) > 0;
  const previewState = unresolvedRefs.length === 0 && !aiUnknown ? 'complete' : 'partial';
  const resolvedCount = coverage?.resolved ?? (outcome.matched + acceptedAiCount);
  const totalCount = coverage?.total ?? outcome.total_lines;
  const aiCount = coverage?.ai_estimated ?? acceptedAiCount;
  const sourceContributions = coverage?.source_backed_contributions ?? 0;
  const partialKnown = coverage?.partial_known ?? 0;
  const excludedCount = coverage?.excluded ?? 0;
  const aiEstimateStatus = aiResult?.ok === true
    ? 'calculated'
    : beforeAiCoverage?.unresolved === 0 ? 'skipped_covered' : 'unavailable';
  return ok(
    'run_nutrition_analysis',
    `${resolvedCount} of ${totalCount} ingredient lines covered by nutrition: ${coverage?.source_backed ?? outcome.matched} source-backed, ` +
      `${aiCount} AI-estimated, ${sourceContributions} other source-backed contributions, ` +
      `${excludedCount} cooking wrapper(s) excluded, ${partialKnown} with partial known nutrients; ${unresolvedRefs.length} still require attention ` +
      `(${needsAmount} need an amount, ${needsMatch} need a match, ${reviewSuggested} need source review)`,
    {
      analyzed: outcome.analyzed,
      matched: resolvedCount,
      ai_estimated: aiCount,
      source_backed: coverage?.source_backed ?? outcome.matched,
      source_backed_contributions: sourceContributions,
      excluded: excludedCount,
      partial_known: partialKnown,
      needs_attention: unresolvedRefs.length,
      needs_amount: needsAmount,
      needs_match: needsMatch,
      review_suggested: reviewSuggested,
      total_lines: outcome.total_lines,
      unresolved_line_refs: unresolvedRefs,
      preview_state: previewState,
      ai_estimate_status: aiEstimateStatus,
      ...(aiResult?.ok === true ? { ai_contributions: aiResult.contributions, ai_totals: aiResult.totals } : {}),
      ...(aiResult?.ok !== true && aiResult?.message ? { ai_estimate_message: aiResult.message } : {}),
      honesty_note:
        aiResult?.ok === true
          ? 'Only contributions with at least one known nutrient value cover an ingredient line. Accepted estimates remain separate from USDA matches, weight is shown only when provided, and omitted nutrients remain unknown. Lines with unknown-only contributions still require attention.'
          : outcome.preview_state === 'complete'
            ? 'Every line resolved to an authenticated record, so the source nutrition preview is complete.'
            : 'The source preview is PARTIAL. Report it as partial and name unresolved ingredients; no AI contribution was confirmed.',
    },
  );
}

/**
 * H-2. Applies structured ingredient edits to the UNSAVED working recipe
 * through the application owner. The capability itself validates nothing about
 * authority: the OWNER re-derives every line reference against live recipe
 * state, applies the field-scoped edits deterministically, and reports exactly
 * what changed. Nothing is persisted here.
 */
async function applyIngredientEdits(
  ctx: ShisoToolContext,
  edits: readonly ShisoIngredientEditArgs[],
): Promise<ShisoObservation> {
  if (ctx.recipe === null) {
    return fail('apply_ingredient_edits', 'no_active_recipe', 'No recipe is currently open.');
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    return fail(
      'apply_ingredient_edits',
      'invalid_arguments',
      'No edits were supplied. Each edit needs: line_ref (copied exactly from get_current_recipe) plus at ' +
        'least one of new_name, new_amount, new_unit, new_preparation.',
    );
  }
  if (edits.length > SHISO_LIMITS.maxIngredientEditsPerCall) {
    return fail(
      'apply_ingredient_edits',
      'invalid_arguments',
      `At most ${SHISO_LIMITS.maxIngredientEditsPerCall} edits are allowed in one operation.`,
    );
  }
  if (ctx.applyIngredientEdits === undefined) {
    return fail(
      'apply_ingredient_edits',
      'no_edit_owner',
      'The recipe editor is not available right now, so no ingredient change could be applied.',
    );
  }
  let outcome: ShisoRecipeEditOutcome;
  try {
    outcome = await ctx.applyIngredientEdits(edits);
  } catch {
    return fail('apply_ingredient_edits', 'edit_rejected', 'The ingredient change could not be applied.');
  }
  if (!outcome.ok || outcome.applied.length === 0) {
    const refused = outcome.refused.length > 0 ? outcome.refused : [];
    return fail(
      'apply_ingredient_edits',
      'edit_rejected',
      refused.length > 0
        ? refused.map((entry) => entry.message).join(' ')
        : 'No ingredient change could be applied.',
    );
  }
  return ok('apply_ingredient_edits', outcome.summary, {
    applied: outcome.applied.map((entry) => ({
      line_ref: entry.line_ref,
      before: entry.before,
      after: entry.after,
      changes: entry.changes,
    })),
    refused: outcome.refused.map((entry) => ({
      line_ref: entry.line_ref,
      reason: entry.reason,
      message: entry.message,
    })),
    applied_count: outcome.applied.length,
    refused_count: outcome.refused.length,
    working_unsaved: outcome.working_unsaved,
    note: outcome.note,
    honesty_note:
      'These ingredient changes exist ONLY in the UNSAVED working copy. Nothing is written to the vault ' +
      'until the user explicitly saves. State plainly whether the change is saved or unsaved.',
  });
}

/**
 * H-2. Applies every supported authenticated nutrition correction to the
 * working review through the component that owns the Phase 4 reducer, then
 * recalculates through the EXISTING deterministic calculator. Every identity,
 * portion and gram comes from the authenticated session; unresolved lines are
 * reported, never forced.
 */
async function applyNutritionCorrections(
  ctx: ShisoToolContext,
  lineRefs: readonly string[] | undefined,
): Promise<ShisoObservation> {
  if (ctx.nutrition === null) {
    return fail(
      'apply_nutrition_corrections',
      'no_nutrition_review',
      'Advanced Nutrition is not currently open for this recipe, so there is nothing to correct.',
    );
  }
  if (ctx.session === null) {
    return fail(
      'apply_nutrition_corrections',
      'no_nutrition_review',
      'The authenticated USDA catalogue is not loaded.',
    );
  }
  if (ctx.applyNutritionCorrections === undefined) {
    return fail(
      'apply_nutrition_corrections',
      'no_analysis_owner',
      'The nutrition review owner is not available right now.',
    );
  }
  if (Array.isArray(lineRefs) && lineRefs.length > SHISO_LIMITS.maxCorrectionLineRefs) {
    return fail(
      'apply_nutrition_corrections',
      'invalid_arguments',
      `At most ${SHISO_LIMITS.maxCorrectionLineRefs} ingredient lines are allowed in one operation.`,
    );
  }
  let outcome: ShisoNutritionCorrectionsOutcome;
  try {
    outcome = await ctx.applyNutritionCorrections(lineRefs);
  } catch {
    return fail(
      'apply_nutrition_corrections',
      'analysis_unavailable',
      'The nutrition corrections could not be applied.',
    );
  }
  // H-2N: the observation carries the AUTHORITATIVE before/after account. Every
  // "applied" entry was verified resolved in the post-operation projection; a
  // refused operation reports zero applied and the exact refusal reason.
  return ok('apply_nutrition_corrections', outcome.summary, {
    applied: (outcome.applied ?? []).map((entry) => ({
      line_ref: entry.line_ref,
      label: entry.label,
      description: entry.description,
    })),
    applied_count: (outcome.applied ?? []).length,
    failed: (outcome.failed ?? []).map((entry) => ({
      line_ref: entry.line_ref,
      label: entry.label,
      reason: entry.reason,
    })),
    failed_count: (outcome.failed ?? []).length,
    regressed: (outcome.regressed ?? []).map((entry) => ({
      line_ref: entry.line_ref,
      label: entry.label,
      reason: entry.reason,
    })),
    changes: (outcome.changes ?? []).map((entry) => ({
      line_ref: entry.line_ref,
      label: entry.label,
      change: entry.change,
      before_status: entry.before_status,
      after_status: entry.after_status,
    })),
    unresolved: outcome.unresolved.map((entry) => ({
      line_ref: entry.line_ref,
      label: entry.label,
      reason: entry.reason,
    })),
    unresolved_count: outcome.unresolved.length,
    before_resolved_count: outcome.before_resolved_count ?? null,
    resolved_count: outcome.resolved_count,
    total_count: outcome.total_count,
    recalculation: outcome.recalculation,
    working_unsaved: outcome.working_unsaved,
    honesty_note:
      outcome.applied.length === 0
        ? 'NOTHING was corrected and the working review is unchanged. Say exactly why (see failed/regressed) and never claim any correction was applied.'
        : 'Only the entries in `applied` were verified resolved in the authoritative recalculation. ' +
          'Report the resolved count using before_resolved_count → resolved_count; name what remains unresolved; ' +
          (outcome.recalculation === 'complete'
            ? 'the review is now fully resolved but still UNSAVED.'
            : 'the recalculated review is PARTIAL — never claim complete nutrition.'),
  });
}

/**
 * Promotes one already-investigated USDA record and authenticated portion into
 * the live Phase 4 review. This is deliberately separate from the batch
 * correction pass: a source selection is a bounded identity decision, while
 * correction discovery remains deterministic and conservative.
 */
async function selectUsdaNutritionSource(
  ctx: ShisoToolContext,
  lineRef: string,
  fdcId: number,
  portionIndex: number,
): Promise<ShisoObservation> {
  const failSelection = (code: ShisoObservationFailureCode, message: string): ShisoObservation =>
    fail('select_usda_nutrition_source', code, message);
  if (!ctx.session || !ctx.recipe || !ctx.nutrition || ctx.applyNutritionSourceSelection === undefined) {
    return failSelection('no_nutrition_review', 'The authenticated nutrition review is not available for source selection.');
  }
  if (typeof lineRef !== 'string' || lineRef.length === 0 || lineRef.length > SHISO_LIMITS.maxSelectionLineRefChars) {
    return failSelection('invalid_request', 'That ingredient line reference is invalid.');
  }
  if (!Number.isSafeInteger(fdcId) || fdcId <= 0 || !Number.isSafeInteger(portionIndex) || portionIndex < 0) {
    return failSelection('invalid_request', 'The USDA food or portion selection is invalid.');
  }
  const row = ctx.nutrition.reviewRows?.find((candidate) => candidate.line_ref === lineRef);
  const ingredient = ctx.recipe.ingredients.find((candidate) => candidate.line_ref === lineRef);
  if (!row || !ingredient) {
    return failSelection('stale_recipe', 'That ingredient line is not part of the current authenticated nutrition review.');
  }

  // Re-authenticate the record and portion here before the owner is asked to
  // mutate state. The owner repeats the same checks, so this cannot become a
  // trust shortcut if the review changes between these two steps.
  const exact = ctx.session.searchFoods(String(fdcId), 5);
  if (!exact.ok || !exact.results.some((result) => result.fdc_id === fdcId && result.exact_fdc_id)) {
    return failSelection('invalid_selection', 'That USDA record is not present in the authenticated catalog.');
  }
  const portionReview = ctx.session.reviewPortions(fdcId);
  if (!portionReview.ok || !portionReview.review.candidates.some((candidate) => candidate.index === portionIndex && candidate.kind !== 'unusable' && candidate.effective_amount !== null && candidate.gram_weight > 0)) {
    return failSelection('invalid_selection', 'That USDA portion is not available for the authenticated food record.');
  }

  // Equal authored alternatives remain a hard boundary unless the trusted
  // current user message explicitly names the selected branch. A model cannot
  // manufacture that authorization through tool arguments.
  const alternatives = projectIngredientAlternatives(ingredient.text);
  const hit = exact.results.find((result) => result.fdc_id === fdcId && result.exact_fdc_id);
  if (alternatives?.primary_index === null &&
      (hit === undefined || ctx.isTrustedNutritionSourceSelection?.(lineRef, hit.description) !== true)) {
    return failSelection('explicit_choice_required', 'This ingredient has equal alternatives. Tell me which food was actually used before I select a definitive source.');
  }

  const outcome = await ctx.applyNutritionSourceSelection({ lineRef, fdcId, portionIndex });
  if (!outcome.ok) {
    return failSelection('selection_rejected', outcome.summary);
  }
  return ok('select_usda_nutrition_source', outcome.summary, {
    line_ref: outcome.line_ref,
    fdc_id: outcome.fdc_id ?? fdcId,
    ...(outcome.description ? { description: outcome.description } : {}),
    ...(outcome.portion ? { portion: outcome.portion } : {}),
    ...(outcome.resolved_grams !== undefined ? { resolved_grams: outcome.resolved_grams } : {}),
    recalculation: outcome.recalculation,
    working_unsaved: outcome.working_unsaved,
  });
}

/**
 * F3. Applies the complete general-chat nutrition review through the shell's
 * existing Phase 5B owner. The capability never persists a Vault write.
 */
async function applyNutritionReview(ctx: ShisoToolContext): Promise<ShisoObservation> {
  if (ctx.recipe === null) {
    return fail('apply_nutrition_review', 'no_active_recipe', 'No selected recipe is available for nutrition Apply.');
  }
  if (ctx.applyNutritionReview === undefined) {
    return fail(
      'apply_nutrition_review',
      'no_analysis_owner',
      'The application-owned nutrition review is not available for this recipe.',
    );
  }
  let outcome: { readonly ok: boolean; readonly applied: boolean; readonly message: string };
  try {
    outcome = await ctx.applyNutritionReview();
  } catch {
    return fail('apply_nutrition_review', 'analysis_unavailable', 'The nutrition review could not be applied.');
  }
  if (!outcome.ok || !outcome.applied) {
    return fail('apply_nutrition_review', 'analysis_unavailable', outcome.message);
  }
  return ok('apply_nutrition_review', outcome.message, {
    applied: true,
    working_unsaved: true,
    honesty_note: 'The nutrition review is applied to the UNSAVED working recipe. Nothing is persisted until a separate authorized save succeeds.',
  });
}

/**
 * H-2. Saves the UNSAVED working recipe through the EXISTING application save
 * path. This capability never writes anything itself: the application shell
 * owns persistence, and it fails closed when there is nothing unsaved. It is
 * only ever called after the user has explicitly authorized saving.
 */
async function saveWorkingRecipe(ctx: ShisoToolContext): Promise<ShisoObservation> {
  if (ctx.recipe === null) {
    return fail('save_working_recipe', 'no_active_recipe', 'No recipe is currently open.');
  }
  if (ctx.saveWorkingRecipe === undefined) {
    return fail(
      'save_working_recipe',
      'no_save_owner',
      'The recipe save path is not available right now.',
    );
  }
  let outcome: ShisoRecipeSaveOutcome;
  try {
    outcome = await ctx.saveWorkingRecipe();
  } catch {
    return fail('save_working_recipe', 'save_unavailable', 'The recipe could not be saved.');
  }
  if (!outcome.ok) {
    // H-2 SECURITY: an unauthorized (or wrong-recipe) save is its own failure
    // code so the model reports the truth: nothing was written and the user
    // must ask explicitly.
    const notAuthorized =
      outcome.reason_code === 'not_authorized' || outcome.reason_code === 'stale_recipe';
    return fail(
      'save_working_recipe',
      notAuthorized ? 'save_not_authorized' : 'save_unavailable',
      outcome.message,
    );
  }
  if (!outcome.saved) {
    // Honest non-error: there was nothing to save.
    return ok('save_working_recipe', outcome.message, {
      saved: false,
      message: outcome.message,
    });
  }
  return ok('save_working_recipe', outcome.message, {
    saved: true,
    message: outcome.message,
  });
}

/**
 * H-1F. Answers "what is actually missing, and what is the one thing I should
 * press?" in a SINGLE call.
 *
 * This exists because the human test burned ~30 seconds and the whole reasoning
 * budget rediscovering one fact — that the USDA bundle had never been loaded,
 * because the application deliberately never loads it at startup. Three
 * separate nutrition capabilities each reported the same prerequisite failure
 * and the user was left with no idea what to do.
 */
function getCapabilityStatus(ctx: ShisoToolContext): ShisoObservation {
  const recipeOpen = ctx.recipe !== null || ctx.vault?.getSelectedRecipe() !== null;
  const bundleLoaded = ctx.session !== null;
  const reviewOpen = ctx.nutrition !== null;
  const analysisAvailable = ctx.runAnalysis !== undefined;
  const vaultStatus = ctx.vault?.getStatus() ?? null;

  const blocked: string[] = [];
  if (!recipeOpen) blocked.push('no_recipe_open');
  if (!bundleLoaded) blocked.push('catalogue_not_loaded');
  if (bundleLoaded && !reviewOpen) blocked.push('review_not_initialized');

  if (blocked.length === 0) {
    return ok(
      'get_capability_status',
      'Everything Shiso needs is available: a recipe is open, the USDA bundle is loaded, and the nutrition review is live.',
      {
        ready: true,
        recipe_open: true,
        catalogue_loaded: true,
        catalogue_status: 'ready',
        review_open: true,
        analysis_available: analysisAvailable,
        vault_available: vaultStatus !== null,
        vault_source: vaultStatus?.source ?? null,
        vault_recipe_count: vaultStatus?.recipe_count ?? null,
        blocked: [],
        recovery: null,
      },
    );
  }

  // Exactly ONE recovery step, ordered by dependency, so the user is never told
  // to do three things when one unlocks the rest.
  const canLoadItself = !bundleLoaded && ctx.loadBundle !== undefined;
  const recipeRecovery = ctx.vault !== undefined
    ? 'search the active Vault and select the intended recipe with me; I do not need you to navigate to its recipe screen.'
    : 'open a recipe first, then ask me again.';
  const recovery =
    !recipeOpen
      ? recipeRecovery
      : !bundleLoaded
        ? canLoadItself
          ? 'say "generate nutrition" again and I will load the catalogue for you, then open Advanced Nutrition so the review initializes.'
          : 'Open Advanced Nutrition for this recipe and choose "Load USDA data" (it is not loaded automatically), then ask me again.'
        : 'Open Advanced Nutrition for this recipe so its review is initialized, then ask me again.';

  return ok(
    'get_capability_status',
    blocked.includes('catalogue_not_loaded')
      ? `BLOCKED: the USDA food catalogue is not loaded, so no food lookup or nutrition calculation can run. To fix it, ${recovery}`
      : blocked.includes('no_recipe_open')
        ? `BLOCKED: ${recovery}`
        : `BLOCKED: the nutrition review is not initialized. To fix it, ${recovery}`,
    {
      ready: false,
      recipe_open: recipeOpen,
      catalogue_loaded: bundleLoaded,
      catalogue_status: ctx.catalogueStatus ?? (bundleLoaded ? 'ready' : 'idle'),
      review_open: reviewOpen,
      analysis_available: analysisAvailable,
      vault_available: vaultStatus !== null,
      vault_source: vaultStatus?.source ?? null,
      vault_recipe_count: vaultStatus?.recipe_count ?? null,
      shiso_can_load_bundle: canLoadItself,
      blocked,
      recovery,
      // The single instruction to give the user, verbatim.
      instruction:
        'Tell the user this ONE action and stop. Do not call another nutrition capability ' +
        'until it is done — they will all report the same missing prerequisite.',
    },
  );
}

/**
 * The single capability dispatcher. Args are already structurally validated by
 * the server's closed schema, but they are RE-VALIDATED here: the browser is the
 * authority boundary and never trusts that the check happened upstream.
 */
export function executeShisoTool(
  args: ShisoToolArgs,
  ctx: ShisoToolContext,
  signal?: AbortSignal,
): ShisoObservation | Promise<ShisoObservation> {
  try {
    switch (args.tool) {
      case 'get_current_recipe':
        return getCurrentRecipe(ctx, args.instruction_offset ?? 0, args.instruction_limit ?? 12);
      case 'get_vault_status':
        return getVaultStatus(ctx);
      case 'search_vault_recipes':
        return searchVaultRecipes(ctx, args.query, args.field ?? 'all', args.limit ?? SHISO_LIMITS.maxVaultSearchResults, signal);
      case 'get_vault_recipe':
        return getVaultRecipe(ctx, args.recipe_id);
      case 'select_vault_recipe':
        return selectVaultRecipe(ctx, args.recipe_id);
      case 'load_usda_catalog':
        return loadUsdaCatalog(ctx, signal);
      case 'get_nutrition_review':
        return getNutritionReview(ctx, args.include_ingredients === true);
      case 'get_branded_evidence':
        return getBrandedEvidence(ctx);
      case 'search_usda_foods':
        return searchUsdaFoods(ctx, args.query, args.limit ?? SHISO_LIMITS.maxSearchResults);
      case 'inspect_usda_food':
        return inspectUsdaFood(ctx, args.fdc_id);
      case 'select_usda_nutrition_source':
        return selectUsdaNutritionSource(ctx, args.line_ref, args.fdc_id, args.portion_index);
      case 'investigate_ingredient_amount':
        return investigateIngredientAmount(ctx, args.line_ref);
      case 'investigate_unresolved_ingredients':
        return investigateUnresolvedIngredients(
          ctx,
          args.cursor,
          args.statuses as readonly ('needs_amount' | 'needs_match')[] | undefined,
        );
      case 'run_nutrition_analysis':
        return runNutritionAnalysis(ctx, signal);
      case 'complete_nutrition':
        return completeNutrition(ctx, signal).then((completed) => {
          if (!completed.ok) return completed;
          const alternativeScenarios = authenticatedAlternativeScenarios(ctx);
          if (alternativeScenarios.length === 0) return completed;
          return ok(
            'complete_nutrition',
            `${completed.summary} ${alternativeScenarios.length} mutually exclusive ingredient comparison(s) were calculated separately; alternatives were not combined.`,
            { ...completed.data, alternative_scenarios: alternativeScenarios },
          );
        });
      case 'get_capability_status':
        return getCapabilityStatus(ctx);
      case 'apply_ingredient_edits':
        return applyIngredientEdits(ctx, args.edits);
      case 'apply_nutrition_corrections':
        return applyNutritionCorrections(ctx, args.line_refs);
      case 'apply_nutrition_review':
        return applyNutritionReview(ctx);
      case 'save_working_recipe':
        return saveWorkingRecipe(ctx);
      default:
        return fail(
          (args as { tool: ShisoObservation['tool'] }).tool,
          'unsupported',
          'That capability is not available.',
        );
    }
  } catch {
    return fail(
      (args as { tool: ShisoObservation['tool'] }).tool,
      'unsupported',
      'That capability could not be completed.',
    );
  }
}
