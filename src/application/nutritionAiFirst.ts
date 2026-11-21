/**
 * The Kitchen Codex — AI-FIRST Advanced Nutrition: Generate orchestration.
 *
 * ONE explicit Generate action, at most TWO structured provider passes:
 *
 *   PASS 1  existing whole-recipe semantic operation
 *           (recipe + instructions -> bounded food meaning + search wording)
 *   LOCAL   deterministic FULL-CATALOG USDA discovery using the interpreted
 *           wording (no lexical confidence threshold, no automatic authority)
 *   PASS 2  bounded candidate evaluation over the ACTUAL discovered records
 *   LOCAL   deterministic verification: record authenticity + source
 *           constraints + authenticated portions + the existing calculator
 *
 * WHAT THE MODEL NEVER DOES
 *   It never supplies an FDC id, record digest, gram weight, portion, nutrient,
 *   calorie, Apply permission or persistence. Pass 2 sees opaque candidate refs
 *   and human-readable descriptions only. The browser maps a selected ref back to
 *   the exact record it discovered and re-authenticates it against the pinned
 *   session before the existing calculator can use it.
 *
 * FAILURE IS VISIBLE AND NON-DESTRUCTIVE
 *   There is no hidden retry, no third pass, and no fallback to the legacy AI
 *   resolver (which would spend an unrequested provider call). A failure returns
 *   the existing bounded user message, and the deterministic review remains
 *   exactly as it was.
 */

import type { NetworkAdapter } from './adapters/NetworkAdapter';
import { buildAiSelectionRequestOptions } from './aiSelection';
import type { AiResolutionRunResult } from './nutritionAiResolve';
import {
  AI_FIRST_CANDIDATE_EVALUATION_REQUEST_VERSION,
  MAX_AI_FIRST_CANDIDATE_DESCRIPTION_LENGTH,
  aiFirstAllowedCandidateRefs,
  sanitizeAiFirstEvaluationResponse,
  type AiFirstCandidateDecision,
  type AiFirstTargetCandidates,
} from '../core/nutritionV2/aiFirstCandidateEvaluation';
import {
  AI_ADVANCED_CONTRACT_VERSION,
  sanitizeAiAdvancedInterpretationResponse,
  type AiAdvancedIngredientInterpretation,
  type AiAdvancedWithheldInterpretation,
} from '../core/nutritionV2/aiAdvanced';
import {
  isAiInterpretationAvailable,
  type NutritionCapabilities,
} from '../core/nutritionV2/nutritionCapabilities';
import {
  verifyAiFirstCandidateDecisions,
  type AiFirstLocalCandidate,
  type AiFirstLocalCandidateSet,
} from '../core/nutritionV2/phase4/aiFirstVerify';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  Phase4Row,
} from '../core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../types';

/**
 * INTERNAL EXPERIMENTAL SWITCH.
 *
 * `true` wires the AI-first workflow into the automatic Generate pass only. The
 * released deterministic workflow and the manual legacy AI-help action remain
 * intact and unchanged, so the experiment can be disabled without touching the
 * existing Advanced Nutrition path.
 */
export const AI_FIRST_GENERATE_ENABLED = true;

/** The pass-2 provider route. Pass 1 reuses the released whole-recipe route. */
export const NUTRITION_AI_FIRST_EVALUATE_ENDPOINT = '/api/nutrition/evaluate-candidates';

/** The released whole-recipe interpretation route (pass 1). */
const WHOLE_RECIPE_INTERPRET_ENDPOINT = '/api/nutrition/interpret-whole-recipe';

const WHOLE_RECIPE_REQUEST_VERSION = 'nutrition_ai_whole_recipe_interpretation_request_v1';

const MAX_DISCOVERY_QUERIES_PER_TARGET = 4;
const MAX_DISCOVERY_HITS_PER_QUERY = 8;
const MAX_DISCOVERY_CANDIDATES_PER_TARGET = 6;

const AI_FIRST_UNAVAILABLE_MESSAGE =
  'AI assistance is unavailable. You can continue with USDA search manually.';
const AI_FIRST_INVALID_MESSAGE =
  'AI returned an unusable candidate evaluation. You can continue with USDA search manually.';

const EMPTY_OUTCOME = Object.freeze({
  candidates: Object.freeze([]),
  unresolved: Object.freeze([]),
  auto_count: 0,
});

const EMPTY_AMOUNTS = Object.freeze({
  resolved: Object.freeze([]),
  offers: Object.freeze([]),
  unresolved: Object.freeze([]),
  inconsistent: Object.freeze([]),
  auto_count: 0,
});

const EMPTY_HOUSEHOLDS = Object.freeze({
  resolved: Object.freeze([]),
  offers: Object.freeze([]),
  unresolved: Object.freeze([]),
  inconsistent: Object.freeze([]),
  auto_count: 0,
});

/** The authored whole-recipe source pass 1 and pass 2 both reason over. */
export interface AiFirstWholeRecipeSource {
  readonly recipe: { readonly ingredients: ReadonlyArray<{ readonly name: string }> };
  readonly instructions: ReadonlyArray<{ readonly text: string }>;
  readonly targets: ReadonlyArray<{ readonly line_ref: string }>;
}

export interface AiFirstRunArgs {
  readonly network: NetworkAdapter;
  readonly session: AdvancedNutritionSession;
  /** The actionable rows this explicit Generate pass may resolve. */
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly recipe?: ObsidianRecipe;
  /** The complete authored source, when the shell already built it. */
  readonly wholeRecipe?: AiFirstWholeRecipeSource;
  readonly capabilities?: NutritionCapabilities;
  /**
   * Caller cancellation from the UI/shell. Forwarded through BOTH transport
   * requests so the HTTP route can abort the actual provider call. It never
   * replaces the server-owned deadlines.
   */
  readonly signal?: AbortSignal;
}

interface PassOneResult {
  readonly ok: boolean;
  readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  readonly withheld: ReadonlyArray<AiAdvancedWithheldInterpretation>;
  readonly message?: string;
}

function sourceFromArgs(args: AiFirstRunArgs): AiFirstWholeRecipeSource | undefined {
  if (args.wholeRecipe !== undefined) return args.wholeRecipe;
  if (args.recipe === undefined) return undefined;
  const ingredients = args.recipe.ingredients
    .map((ingredient) => (ingredient as { original?: string; name?: string }).original ?? ingredient.name ?? '')
    .map((original) => original.trim())
    .filter((original) => original.length > 0);
  if (ingredients.length === 0 || args.rows.length === 0) return undefined;
  return {
    recipe: { ingredients: ingredients.map((name) => ({ name })) },
    instructions: args.recipe.instructions.map((step) => ({ text: step.text })),
    targets: args.rows.map((row) => ({ line_ref: row.line_ref })),
  };
}

async function requestWholeRecipeInterpretations(
  args: AiFirstRunArgs,
  source: AiFirstWholeRecipeSource
): Promise<PassOneResult> {
  const allowedLineRefs = source.targets.map((target) => target.line_ref);
  let response;
  try {
    response = await args.network.post<Record<string, unknown>>(
      WHOLE_RECIPE_INTERPRET_ENDPOINT,
      {
        request_version: WHOLE_RECIPE_REQUEST_VERSION,
        recipe: source.recipe,
        instructions: source.instructions,
        targets: source.targets,
      },
      await buildAiSelectionRequestOptions(
        args.signal !== undefined ? { signal: args.signal } : undefined
      )
    );
  } catch {
    return { ok: false, interpretations: [], withheld: [], message: AI_FIRST_UNAVAILABLE_MESSAGE };
  }
  if (!response || response.ok !== true) {
    return { ok: false, interpretations: [], withheld: [], message: AI_FIRST_UNAVAILABLE_MESSAGE };
  }

  const sanitized = sanitizeAiAdvancedInterpretationResponse(
    {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations: response.data?.['semantic_response'],
    },
    { allowedLineRefs }
  );
  if (sanitized.ok !== true) {
    return { ok: false, interpretations: [], withheld: [], message: AI_FIRST_INVALID_MESSAGE };
  }
  const interpretations = sanitized.interpretations as ReadonlyArray<AiAdvancedIngredientInterpretation>;

  // Explicit ambiguity / authored alternatives are withheld from selection: an
  // AI-first pass must never silently choose one reading for the user.
  const withheld: AiAdvancedWithheldInterpretation[] = [];
  for (const interpretation of interpretations) {
    if (interpretation.ambiguity.ambiguous === true) {
      withheld.push({ line_ref: interpretation.line_ref, reason: 'ambiguous' });
    } else if (interpretation.alternatives.length > 0) {
      withheld.push({ line_ref: interpretation.line_ref, reason: 'alternatives' });
    }
  }
  return { ok: true, interpretations, withheld };
}

function discoveryQueries(interpretation: AiAdvancedIngredientInterpretation): string[] {
  const queries: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (queries.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) return;
    queries.push(trimmed);
  };
  add(interpretation.semantic_food.normalized_name);
  for (const phrase of interpretation.search_phrases) add(phrase);
  return queries.slice(0, MAX_DISCOVERY_QUERIES_PER_TARGET);
}

/**
 * Deterministic full-catalog discovery. There is NO confidence threshold here:
 * the user is explicitly asking AI to evaluate real records, so discovery may
 * return records the lexical automatic matcher would never accept. The result is
 * still only discovery data; pass 2 + local verification decide usefulness.
 */
function discoverCandidates(
  session: AdvancedNutritionSession,
  interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>,
  withheldRefs: ReadonlySet<string>
): ReadonlyArray<AiFirstLocalCandidateSet> {
  const sets: AiFirstLocalCandidateSet[] = [];
  for (const interpretation of interpretations) {
    const lineRef = interpretation.line_ref;
    if (withheldRefs.has(lineRef)) {
      sets.push(Object.freeze({ line_ref: lineRef, candidates: Object.freeze([]) }));
      continue;
    }
    const byFdc = new Map<number, AiFirstLocalCandidate>();
    const collect = (queries: ReadonlyArray<string>): void => {
      for (const query of queries) {
        if (byFdc.size >= MAX_DISCOVERY_CANDIDATES_PER_TARGET) break;
        let result;
        try {
          result = session.searchFoods(query, MAX_DISCOVERY_HITS_PER_QUERY);
        } catch {
          continue;
        }
        if (!result.ok) continue;
        for (const hit of result.results) {
          if (byFdc.size >= MAX_DISCOVERY_CANDIDATES_PER_TARGET) break;
          if (byFdc.has(hit.fdc_id)) continue;
          const description = hit.description.slice(0, MAX_AI_FIRST_CANDIDATE_DESCRIPTION_LENGTH);
          if (description.length === 0) continue;
          const dataType = typeof hit.data_type === 'string' ? hit.data_type : '';
          if (dataType !== 'foundation' && dataType !== 'sr_legacy' && dataType !== 'fndds') continue;
          const portionSummary =
            typeof hit.portion_summary === 'string' && hit.portion_summary.trim().length > 0
              ? hit.portion_summary.trim().slice(0, 80)
              : undefined;
          byFdc.set(
            hit.fdc_id,
            Object.freeze({
              candidate_ref: `c${byFdc.size + 1}`,
              fdc_id: hit.fdc_id,
              description,
              record_digest: hit.record_digest,
              data_type: dataType,
              ...(portionSummary !== undefined ? { portion_summary: portionSummary } : {}),
            })
          );
        }
      }
    };

    const primaryQueries = discoveryQueries(interpretation);
    collect(primaryQueries);

    // GENERIC DISCOVERY FALLBACK. The model may declare a food-family/composition
    // qualifier (for example `tomato` or `dairy`) that is broader than the
    // authored name. When the authored wording finds nothing in the catalog, try
    // ONE additional bounded hypothesis built from those MODEL-DECLARED
    // qualifiers. This is not an ingredient-specific synonym map and it grants no
    // authority: every returned record is still compared by pass 2 and verified
    // locally against the authored source. Without this, a correct interpretation
    // using regional terminology can produce an empty candidate set even when the
    // catalog contains the broader food family.
    if (byFdc.size === 0) {
      const qualifierQuery = interpretation.semantic_food.qualifiers
        .map((qualifier) => qualifier.trim())
        .filter((qualifier) => qualifier.length > 0)
        .join(' ')
        .slice(0, 120);
      if (
        qualifierQuery.length > 0 &&
        !primaryQueries.some((query) => query.toLowerCase() === qualifierQuery.toLowerCase())
      ) {
        collect([qualifierQuery]);
      }
    }

    // PREPARATION-TOKEN RELAXATION. A model-declared preparation adjective (for
    // example `strained`) may not appear in any USDA description even when the
    // underlying food family does. When every primary/qualifier query is empty,
    // try at most TWO formulations with the model-declared PREPARATION tokens
    // removed. This is not a synonym table: it only reuses the model's own
    // wording, drops words the model itself classified as preparation, and keeps
    // the remaining food-identity tokens. Pass 2 still compares the actual
    // records, and local source constraints still decide what may be used.
    if (byFdc.size === 0) {
      const preparationTokens = new Set(
        interpretation.semantic_food.preparation
          .flatMap((preparation) => preparation.toLowerCase().split(/[^a-z0-9]+/))
          .filter((token) => token.length > 0)
      );
      if (preparationTokens.size > 0) {
        const relaxed: string[] = [];
        for (const phrase of interpretation.search_phrases) {
          const tokens = phrase.split(/\s+/).filter(Boolean);
          const kept = tokens.filter((token) => !preparationTokens.has(token.toLowerCase()));
          if (kept.length < 2 || kept.length === tokens.length) continue;
          const query = kept.join(' ').slice(0, 120);
          if (
            !primaryQueries.some((entry) => entry.toLowerCase() === query.toLowerCase()) &&
            !relaxed.some((entry) => entry.toLowerCase() === query.toLowerCase())
          ) {
            relaxed.push(query);
          }
          if (relaxed.length >= 2) break;
        }
        if (relaxed.length > 0) collect(relaxed);
      }
    }
    sets.push(
      Object.freeze({
        line_ref: lineRef,
        candidates: Object.freeze([...byFdc.values()]),
      })
    );
  }
  return Object.freeze(sets);
}

function toEvaluationTargets(
  sets: ReadonlyArray<AiFirstLocalCandidateSet>
): ReadonlyArray<AiFirstTargetCandidates> {
  return sets.map((set) =>
    Object.freeze({
      line_ref: set.line_ref,
      candidates: Object.freeze(
        set.candidates.map((candidate) =>
          Object.freeze({
            candidate_ref: candidate.candidate_ref,
            description: candidate.description,
            data_type: candidate.data_type,
            ...(candidate.portion_summary !== undefined
              ? { portion_summary: candidate.portion_summary }
              : {}),
          })
        )
      ),
    })
  );
}

interface PassTwoResult {
  readonly ok: boolean;
  readonly decisions: ReadonlyArray<AiFirstCandidateDecision>;
  readonly message?: string;
}

async function requestCandidateEvaluation(
  args: AiFirstRunArgs,
  source: AiFirstWholeRecipeSource,
  sets: ReadonlyArray<AiFirstLocalCandidateSet>
): Promise<PassTwoResult> {
  const targets = toEvaluationTargets(sets);
  let response;
  try {
    response = await args.network.post<Record<string, unknown>>(
      NUTRITION_AI_FIRST_EVALUATE_ENDPOINT,
      {
        request_version: AI_FIRST_CANDIDATE_EVALUATION_REQUEST_VERSION,
        recipe: source.recipe,
        instructions: source.instructions,
        targets: source.targets,
        candidate_sets: targets,
      },
      await buildAiSelectionRequestOptions(
        args.signal !== undefined ? { signal: args.signal } : undefined
      )
    );
  } catch {
    return { ok: false, decisions: [], message: AI_FIRST_UNAVAILABLE_MESSAGE };
  }
  if (!response || response.ok !== true) {
    return { ok: false, decisions: [], message: AI_FIRST_UNAVAILABLE_MESSAGE };
  }
  const sanitized = sanitizeAiFirstEvaluationResponse(
    {
      contract_version: response.data?.['contract_version'],
      decisions: response.data?.['decisions'],
    },
    aiFirstAllowedCandidateRefs(targets)
  );
  if (sanitized.ok !== true) {
    return { ok: false, decisions: [], message: AI_FIRST_INVALID_MESSAGE };
  }
  return { ok: true, decisions: sanitized.decisions };
}

/**
 * Runs the complete AI-first Generate pass against the genuine local session.
 *
 * Returns the released `AiResolutionRunResult` shape so the existing card merge,
 * working-state helper and Apply boundary remain the ONLY mutation path.
 */
export async function resolveWithAiFirst(
  args: AiFirstRunArgs
): Promise<AiResolutionRunResult> {
  if (args.capabilities !== undefined && !isAiInterpretationAvailable(args.capabilities)) {
    return {
      ok: false,
      message: AI_FIRST_UNAVAILABLE_MESSAGE,
      aiAttempted: false,
      interpretedCount: 0,
      semanticInterpretedCount: 0,
      withheld: Object.freeze([]),
      contradicted: Object.freeze([]),
      inadaptable: Object.freeze([]),
      outcome: EMPTY_OUTCOME,
      amounts: EMPTY_AMOUNTS,
      households: EMPTY_HOUSEHOLDS,
    };
  }

  const source = sourceFromArgs(args);
  if (source === undefined || args.rows.length === 0) {
    return {
      ok: true,
      message: 'No remaining ingredients need AI assistance.',
      aiAttempted: false,
      interpretedCount: 0,
      semanticInterpretedCount: 0,
      withheld: Object.freeze([]),
      contradicted: Object.freeze([]),
      inadaptable: Object.freeze([]),
      outcome: EMPTY_OUTCOME,
      amounts: EMPTY_AMOUNTS,
      households: EMPTY_HOUSEHOLDS,
    };
  }

  // PASS 1 — the released whole-recipe semantic operation. Exactly ONE provider
  // chain. A failure is returned visibly; pass 2 is never attempted.
  const passOne = await requestWholeRecipeInterpretations(args, source);
  if (passOne.ok !== true) {
    return {
      ok: false,
      message: passOne.message ?? AI_FIRST_UNAVAILABLE_MESSAGE,
      aiAttempted: true,
      interpretedCount: 0,
      semanticInterpretedCount: 0,
      withheld: Object.freeze([]),
      contradicted: Object.freeze([]),
      inadaptable: Object.freeze([]),
      outcome: EMPTY_OUTCOME,
      amounts: EMPTY_AMOUNTS,
      households: EMPTY_HOUSEHOLDS,
    };
  }

  const withheldRefs = new Set(passOne.withheld.map((entry) => entry.line_ref));
  const sets = discoverCandidates(args.session, passOne.interpretations, withheldRefs);
  const totalCandidates = sets.reduce((sum, set) => sum + set.candidates.length, 0);
  if (totalCandidates === 0) {
    return {
      ok: true,
      message:
        'AI understood the recipe, but the pinned USDA catalog contains no candidate records for the interpreted wording. The existing review is unchanged.',
      aiAttempted: true,
      interpretedCount: 0,
      semanticInterpretedCount: passOne.interpretations.length,
      withheld: Object.freeze(passOne.withheld),
      contradicted: Object.freeze([]),
      inadaptable: Object.freeze([]),
      outcome: Object.freeze({
        candidates: Object.freeze([]),
        unresolved: Object.freeze(passOne.interpretations.map((entry) => entry.line_ref)),
        auto_count: 0,
      }),
      amounts: EMPTY_AMOUNTS,
      households: EMPTY_HOUSEHOLDS,
    };
  }

  // PASS 2 — ONE structured candidate evaluation over the ACTUAL local records.
  const passTwo = await requestCandidateEvaluation(args, source, sets);
  if (passTwo.ok !== true) {
    return {
      ok: false,
      message: passTwo.message ?? AI_FIRST_UNAVAILABLE_MESSAGE,
      aiAttempted: true,
      interpretedCount: 0,
      semanticInterpretedCount: passOne.interpretations.length,
      withheld: Object.freeze(passOne.withheld),
      contradicted: Object.freeze([]),
      inadaptable: Object.freeze([]),
      outcome: EMPTY_OUTCOME,
      amounts: EMPTY_AMOUNTS,
      households: EMPTY_HOUSEHOLDS,
    };
  }

  // LOCAL VERIFICATION — the only place a proposal can become a working choice.
  const verified = verifyAiFirstCandidateDecisions({
    session: args.session,
    rows: args.rows,
    adapted: args.adapted,
    candidateSets: sets,
    decisions: passTwo.decisions,
  });
  const proposed = verified.candidates.length;
  const noMatch = verified.no_match.length;
  const needsReview = verified.needs_review.length;
  const rejected = verified.rejected.length;
  const remaining = verified.unresolved.length;

  const message =
    `AI interpreted ${passOne.interpretations.length} ingredient${
      passOne.interpretations.length === 1 ? '' : 's'
    } and evaluated ${totalCandidates} real USDA candidate record${
      totalCandidates === 1 ? '' : 's'
    }. ${proposed} selection${proposed === 1 ? '' : 's'} passed local USDA verification. ` +
    `${needsReview} need review, ${noMatch} had no defensible match, and ${rejected} failed deterministic verification. ` +
    `${remaining} line${remaining === 1 ? '' : 's'} still ${remaining === 1 ? 'needs' : 'need'} review.`;

  return {
    ok: true,
    message,
    aiAttempted: true,
    interpretedCount: passTwo.decisions.length,
    semanticInterpretedCount: passOne.interpretations.length,
    withheld: Object.freeze(passOne.withheld),
    contradicted: Object.freeze([]),
    inadaptable: Object.freeze([]),
    outcome: Object.freeze({
      candidates: verified.candidates,
      unresolved: verified.unresolved,
      auto_count: verified.candidates.length,
    }),
    amounts: EMPTY_AMOUNTS,
    households: EMPTY_HOUSEHOLDS,
    aiFirstReviews: verified.reviews,
  };
}
