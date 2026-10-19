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
 * No tool can write to disk, hit the network, or reach the Vault.
 */

import {
  SHISO_LIMITS,
  type ShisoAnalysisOutcome,
  type ShisoNutritionCorrectionsOutcome,
  type ShisoObservation,
  type ShisoRecipeEditOutcome,
  type ShisoRecipeSaveOutcome,
  type ShisoToolArgs,
  type ShisoIngredientEditArgs,
} from '../core/shiso/protocol';
import { runBatchInvestigation } from '../core/shiso/batchInvestigation';

import type { AdvancedNutritionSession } from '../core/nutritionV2/phase4';
import type { LiveRowState } from '../core/nutritionV2/phase4/liveRow';
import type { AiNutrientContribution } from '../core/nutritionV2/aiContribution';
import { deriveNutritionCoverage, nutritionCoverageSummary } from '../core/shiso/nutritionCoverage';

/** Everything a capability may read. Supplied by the application, never the model. */
export interface ShisoToolContext {
  readonly session: AdvancedNutritionSession | null;
  readonly recipe: {
    readonly title: string;
    readonly servings: number | null;
    readonly ingredients: ReadonlyArray<{
      readonly text: string;
      readonly name: string;
      /** H-2 stable handle for edits; null when the recipe cannot be adapted. */
      readonly line_ref?: string | null;
    }>;
    readonly instructions: ReadonlyArray<{ readonly text: string }>;
  } | null;
  readonly nutrition: {
    readonly rows: ReadonlyArray<LiveRowState>;
    readonly aiContributions?: ReadonlyArray<AiNutrientContribution>;
    readonly summary: string | null;
    readonly unsaved: boolean;
  } | null;
  /**
   * Runs the EXISTING Advanced Nutrition analysis through the component that
   * owns it. Registered by that owner; absent means Advanced Nutrition is not
   * open, and SHISO says so instead of simulating a result.
   */
  readonly runAnalysis?: ((signal?: AbortSignal) => Promise<ShisoAnalysisOutcome>) | undefined;
  /** Structured whole-recipe AI contribution pass, independently validated by the application. */
  readonly runAiNutrition?: ((signal?: AbortSignal) => Promise<{ readonly ok: boolean; readonly contributions?: readonly AiNutrientContribution[]; readonly totals?: Readonly<Record<string, unknown>>; readonly message?: string }>) | undefined;
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
  readonly loadBundle?: (() => Promise<void>) | undefined;
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
  /**
   * H-2. Persists the UNSAVED working recipe through the EXISTING application
   * save path. Registered by the application shell; it fails closed when there
   * is nothing unsaved. Explicit user save authorization is required before the
   * model is allowed to call this.
   */
  readonly saveWorkingRecipe?: (() => Promise<ShisoRecipeSaveOutcome>) | undefined;
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

function getCurrentRecipe(ctx: ShisoToolContext): ShisoObservation {
  if (ctx.recipe === null) {
    return fail('get_current_recipe', 'no_active_recipe', 'No recipe is currently open.');
  }
  return ok('get_current_recipe', `${ctx.recipe.title} — ${ctx.recipe.ingredients.length} ingredients`, {
    title: ctx.recipe.title,
    servings: ctx.recipe.servings,
    ingredients: ctx.recipe.ingredients.slice(0, 60).map((i) => ({
      text: i.text.slice(0, 200),
      name: i.name.slice(0, 120),
      // H-2: the stable handle an edit is addressed by. It is INTERNAL plumbing
      // (like the review line_ref) and is revalidated against live recipe state
      // before any edit is applied; it is never shown to the user.
      line_ref: typeof i.line_ref === 'string' ? i.line_ref : null,
    })),
    instructions: ctx.recipe.instructions.slice(0, 40).map((s) => ({ text: s.text.slice(0, 400) })),
  });
}

/** Refuse to answer from a review whose stable ingredient handles no longer match the open recipe. */
function nutritionMatchesActiveRecipe(ctx: ShisoToolContext): boolean {
  if (ctx.recipe === null || ctx.nutrition === null) return false;
  const recipeRefs = ctx.recipe.ingredients.map((line) => line.line_ref);
  if (recipeRefs.length !== ctx.nutrition.rows.length || recipeRefs.some((ref) => typeof ref !== 'string')) return false;
  const recipeSet = new Set(recipeRefs as string[]);
  return recipeSet.size === recipeRefs.length && ctx.nutrition.rows.every((row) => recipeSet.has(row.line_ref));
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
  const result = ctx.session.searchFoods(query, Math.min(limit, SHISO_LIMITS.maxSearchResults));
  if (!result.ok) {
    return fail('search_usda_foods', 'catalog_search_empty', 'No matching USDA record was found.');
  }
  const rows = result.results.slice(0, SHISO_LIMITS.maxSearchResults);
  return ok('search_usda_foods', `${rows.length} matching USDA record(s)`, {
    query,
    total_matches: result.total,
    results: rows.map((r) => ({
      fdc_id: r.fdc_id,
      description: r.description.slice(0, 160),
      data_type: r.data_type,
      match_class: r.match_class,
      has_portion: r.has_portion,
      portion_summary: r.portion_summary ?? null,
      record_digest: r.record_digest,
    })),
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
    lines: report.lines.map((l) => ({
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
    })),
    continuation_hint: report.complete
      ? null
      : `${report.remaining} ingredient(s) remain. Ask me to continue and I will investigate the rest without repeating this work.`,
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
      // fall through to the honest "still not available" report below
    }
    return ok(
      'run_nutrition_analysis',
      'The USDA catalogue was not loaded, so I have started loading it for you.',
      {
        started_bundle_load: true,
        analysis_ran: false,
        next_step:
          'Open Advanced Nutrition for this recipe — loading the catalogue creates the review — ' +
          'then ask me again and I will run the analysis and investigate everything unresolved.',
        honesty_note:
          'No nutrition has been calculated yet. Do not claim any totals until the analysis has actually run.',
      },
    );
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
  const recipeOpen = ctx.recipe !== null;
  const bundleLoaded = ctx.session !== null;
  const reviewOpen = ctx.nutrition !== null;
  const analysisAvailable = ctx.runAnalysis !== undefined;

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
        review_open: true,
        analysis_available: analysisAvailable,
        blocked: [],
        recovery: null,
      },
    );
  }

  // Exactly ONE recovery step, ordered by dependency, so the user is never told
  // to do three things when one unlocks the rest.
  const canLoadItself = !bundleLoaded && ctx.loadBundle !== undefined;
  const recovery =
    !recipeOpen
      ? 'Open a recipe first, then ask me again.'
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
      review_open: reviewOpen,
      analysis_available: analysisAvailable,
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
        return getCurrentRecipe(ctx);
      case 'get_nutrition_review':
        return getNutritionReview(ctx, args.include_ingredients === true);
      case 'search_usda_foods':
        return searchUsdaFoods(ctx, args.query, args.limit ?? SHISO_LIMITS.maxSearchResults);
      case 'inspect_usda_food':
        return inspectUsdaFood(ctx, args.fdc_id);
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
      case 'get_capability_status':
        return getCapabilityStatus(ctx);
      case 'apply_ingredient_edits':
        return applyIngredientEdits(ctx, args.edits);
      case 'apply_nutrition_corrections':
        return applyNutritionCorrections(ctx, args.line_refs);
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
