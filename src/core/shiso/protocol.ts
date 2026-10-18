/**
 * The Kitchen Codex — SHISO conversational protocol.
 *
 * ONE brain, multiple entry points. This module is the shared, closed contract
 * between the browser (which holds the authenticated USDA session and the recipe
 * / nutrition working state) and the server (which holds provider credentials).
 *
 * WHY THE SPLIT
 * -------------
 * The pinned USDA bundle is authenticated and composed in the BROWSER; no server
 * module imports it, so a server-side tool could not read authenticated food
 * evidence. Conversely the provider API key is server-only and must never reach
 * the browser. So:
 *
 *   - the SERVER decides what to ask for (model, entitlement, pricing, limits);
 *   - the BROWSER executes every capability against the real authority.
 *
 * The model therefore never sees a credential, never names a database identity it
 * invented, and never asserts grams. It can only ask the application to run an
 * approved capability and then explain what the application actually returned.
 *
 * CLOSED VOCABULARY. A model response can only be a bounded reply or a request
 * for one of the tools enumerated here. There is no path from model output to
 * JavaScript, a shell command, a filesystem path, a database query, or an
 * external URL.
 *
 * Recipe and nutrition content reaches the model as UNTRUSTED DATA inside a
 * delimited block. It is never instructions.
 */

export const SHISO_CONVERSATION_VERSION = 'shiso_conversation_v1' as const;
export const SHISO_TURN_CONTRACT_VERSION = 'shiso_turn_request_v1' as const;
export const SHISO_TOOL_SCHEMA_VERSION = 'shiso_tool_call_v1' as const;
export const SHISO_PROPOSAL_VERSION = 'shiso_nutrition_correction_v1' as const;
export const SHISO_ENDPOINT = '/api/shiso/turn';

// ---------------------------------------------------------------------------
// Hard budgets. A turn can never exceed these, whatever the model asks for.
// ---------------------------------------------------------------------------

export const SHISO_LIMITS = Object.freeze({
  /** Model invocations allowed for one user turn (tool steps + final reply). */
  maxModelInvocationsPerTurn: 6,
  /**
   * Tool executions allowed for one user turn.
   *
   * Raised 4 -> 8 at audit H-1. The evidence was that a 12-ingredient recipe has
   * more unresolved lines than four per-ingredient probes could ever cover, so
   * the budget was exhausted before any finding existed to report. 8 is still a
   * HARD per-turn ceiling enforced identically on both sides, and the two new
   * batch capabilities do the bulk of the work in ONE step, so this is headroom
   * for mixed investigations rather than a licence for unbounded exploration.
   */
  maxToolCallsPerTurn: 8,
  /** Retained conversation messages (older ones are dropped, oldest first). */
  maxHistoryMessages: 24,
  /** Maximum user message length, in characters. */
  maxUserMessageChars: 4000,
  /** Maximum assistant reply length, in characters. */
  maxAssistantMessageChars: 8000,
  /** Maximum characters of recipe/nutrition context sent per turn. */
  maxContextChars: 12000,
  /** USDA catalog search result ceiling (the authority's own max is 100). */
  maxSearchResults: 20,
  /** Portion candidates returned per inspected record. */
  maxPortionCandidates: 25,
  /** Count-portion candidates returned per inspected record. */
  maxCountPortionCandidates: 10,
  /**
   * Ingredient lines examined by ONE `investigate_unresolved_ingredients` step.
   *
   * The batch capability is deterministic and local — it reuses the authorities
   * the application already owns and makes no model call — so a bound here is a
   * response-size bound, not a cost bound. A recipe larger than this is resumed
   * with an explicit continuation cursor rather than silently truncated.
   */
  maxBatchIngredients: 12,
  /** Alternatives reported per unresolved line by the batch capability. */
  maxBatchAlternativesPerLine: 3,
  /**
   * Ingredient edits accepted by ONE `apply_ingredient_edits` call (H-2).
   *
   * A bound here is a change-size bound, not a spend bound: the application
   * applies the edits deterministically and makes no model call for them.
   */
  maxIngredientEditsPerCall: 12,
  /** Ingredient-name bound for one structured edit (H-2). */
  maxIngredientEditNameChars: 160,
  /** Measurement-unit bound for one structured edit (H-2). */
  maxIngredientEditUnitChars: 24,
  /** Preparation-text bound for one structured edit (H-2). */
  maxIngredientEditPreparationChars: 160,
  /** Line refs accepted by ONE `apply_nutrition_corrections` call (H-2). */
  maxCorrectionLineRefs: 24,
  /** Request body ceiling in bytes. */
  maxRequestBytes: 64 * 1024,
});

// ---------------------------------------------------------------------------
// Context. Model-visible, server-received, and always derived by the application.
// ---------------------------------------------------------------------------

export interface ShisoRecipeContext {
  readonly title: string;
  readonly servings: number | null;
  readonly ingredientCount: number;
  readonly stepCount: number;
}

export interface ShisoNutritionContext {
  /** True when Advanced Nutrition is currently open with a live review. */
  readonly available: boolean;
  readonly summary: string | null;
  readonly unresolvedCount: number;
  readonly needsAmountCount: number;
  readonly needsMatchCount: number;
  /** True when the working review differs from the last applied saved result. */
  readonly unsavedWorkingReview: boolean;
}

/**
 * What the model is told about where the user is. The RECIPE BODY itself is never
 * re-sent in the context envelope: it is fetched by the model through the
 * `get_current_recipe` capability, so the application decides what a given
 * capability may see rather than the context block leaking everything.
 */
export interface ShisoConversationContext {
  readonly recipe: ShisoRecipeContext | null;
  readonly nutrition: ShisoNutritionContext;
  /**
   * The identity the working state is currently bound to. A proposal raised
   * against a different identity is refused downstream.
   */
  readonly recipeKey: string | null;
  readonly sessionIdentity: string | null;
}

export interface ShisoConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** Set on assistant messages that ended a turn which produced proposals. */
  readonly proposalCount?: number;
}

// ---------------------------------------------------------------------------
// The closed tool vocabulary
// ---------------------------------------------------------------------------

export const SHISO_TOOL_NAMES = Object.freeze([
  'get_current_recipe',
  'get_nutrition_review',
  'search_usda_foods',
  'inspect_usda_food',
  'investigate_ingredient_amount',
  'investigate_unresolved_ingredients',
  'run_nutrition_analysis',
  'get_capability_status',
  // H-2 AUTHORIZED EDITING. These are the FIRST capabilities that can change
  // application state. They change only the UNSAVED working copy (recipe edits,
  // working nutrition review) or persist an explicitly user-authorized save
  // through the EXISTING application save path. They can never write to the
  // vault directly and never carry nutrient/gram authority.
  'apply_ingredient_edits',
  'apply_nutrition_corrections',
  'save_working_recipe',
] as const);

export type ShisoToolName = (typeof SHISO_TOOL_NAMES)[number];

const TOOL_NAME_SET: ReadonlySet<string> = new Set(SHISO_TOOL_NAMES);

export function isShisoToolName(value: unknown): value is ShisoToolName {
  return typeof value === 'string' && TOOL_NAME_SET.has(value);
}

/** Arguments are a closed per-tool union; unknown keys are refused whole. */
export type ShisoToolArgs =
  | { readonly tool: 'get_current_recipe' }
  | { readonly tool: 'get_nutrition_review'; readonly include_ingredients?: boolean }
  | { readonly tool: 'search_usda_foods'; readonly query: string; readonly limit?: number }
  | { readonly tool: 'inspect_usda_food'; readonly fdc_id: number }
  | {
      readonly tool: 'investigate_ingredient_amount';
      readonly line_ref: string;
    }
  | {
      /**
       * Bounded DETERMINISTIC batch investigation. It re-reads the live review,
       * classifies every unresolved line, and asks the SAME authorities the
       * per-ingredient probe asks, for every line in one step. One tool call
       * replaces one model+tool cycle per ingredient.
       */
      readonly tool: 'investigate_unresolved_ingredients';
      /** Resume point from a previous truncated batch. Absent = start at the first unresolved line. */
      readonly cursor?: string;
      /** Restrict to these statuses. Absent = every unresolved status. */
      readonly statuses?: readonly ('needs_amount' | 'needs_match')[];
    }
  | {
      /**
       * Requests the EXISTING deterministic Advanced Nutrition analysis through
       * the component that owns it. It starts nothing new and bypasses nothing:
       * the owner runs the same matcher, the same portion authority and the same
       * calculator the Calculate button runs.
       */
      readonly tool: 'run_nutrition_analysis';
    }
  | {
      /**
       * H-1F. Reports WHICH prerequisite is missing and the ONE action that
       * supplies it.
       *
       * The human test's worst failure was Shiso calling three nutrition
       * capabilities in a row, each reporting "Advanced Nutrition is not open",
       * until it exhausted its budget and told the user nothing actionable. The
       * user could not tell that the whole cause was a single missing bundle.
       * This capability answers that question in one call.
       */
      readonly tool: 'get_capability_status';
    }
  | {
      /**
       * H-2. Applies structured INGREDIENT edits to the UNSAVED working copy of
       * the recipe, through the application's own editor/state authority.
       *
       * Each edit changes only the fields the caller names; any field it does
       * not name is preserved from the authored line. A quantity the user did
       * not ask to change is therefore never touched — the authored
       * "2 lb chicken thighs" cannot silently become one USDA portion.
       */
      readonly tool: 'apply_ingredient_edits';
      readonly edits: ReadonlyArray<ShisoIngredientEditArgs>;
    }
  | {
      /**
       * H-2. Applies every adequately supported, AUTHENTICATED nutrition
       * correction to the working review in ONE deterministic operation
       * (record alternatives + authenticated portions), then recalculates
       * through the existing engine. It never invents a match, a portion or a
       * gram; a line with no supported correction is reported unresolved.
       */
      readonly tool: 'apply_nutrition_corrections';
      /** Optional subset of ingredient lines. Absent = every actionable line. */
      readonly line_refs?: readonly string[];
    }
  | {
      /**
       * H-2. Persists the UNSAVED working recipe through the EXISTING
       * Kitchen Codex save path. Only ever called after the user explicitly
       * authorizes saving; it fails closed when nothing is unsaved.
       */
      readonly tool: 'save_working_recipe';
    };

// ---------------------------------------------------------------------------
// H-2 — authorized ingredient editing (structured, line-scoped)
// ---------------------------------------------------------------------------

/**
 * ONE structured ingredient edit.
 *
 * The shape is deliberately FIELD-SCOPED, never a whole replacement line: the
 * application merges the named fields into the AUTHORED line and re-renders it
 * deterministically. An unnamed field (amount, unit, name, preparation) is
 * preserved exactly as authored, so a quantity the user did not ask to change
 * can never be silently replaced.
 */
export interface ShisoIngredientEditArgs {
  /** Stable handle from `get_current_recipe`; revalidated against live state. */
  readonly line_ref: string;
  /** Full replacement of the ingredient NAME (preparation excluded). */
  readonly new_name?: string;
  /** Replacement AMOUNT. Never inferred; only what the user asked for. */
  readonly new_amount?: number;
  /** Replacement measurement unit (lowercased canonically by the app). */
  readonly new_unit?: string;
  /** Replacement PREPARATION text (the part after the first comma). */
  readonly new_preparation?: string;
}

/** One successfully applied edit, as reported back to the model. */
export interface ShisoRecipeEditApplied {
  readonly line_ref: string;
  /** The authored text before the change. */
  readonly before: string;
  /** The authored text after the change. */
  readonly after: string;
  /** Per-field bullet points, e.g. `name: "chicken breast" → "turkey breast"`. */
  readonly changes: readonly string[];
}

/** One refused edit. Never applied; the recipe is untouched for that line. */
export interface ShisoRecipeEditRefused {
  readonly line_ref: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * The application's bounded answer to an edit request. `working_unsaved` is
 * always true while edits exist in the working copy: recipe edits are NEVER
 * persisted by this capability.
 */
export interface ShisoRecipeEditOutcome {
  readonly ok: boolean;
  readonly applied: readonly ShisoRecipeEditApplied[];
  readonly refused: readonly ShisoRecipeEditRefused[];
  readonly summary: string;
  readonly working_unsaved: boolean;
  readonly note: string;
}

/** The application's bounded answer to an explicit save request. */
export interface ShisoRecipeSaveOutcome {
  readonly ok: boolean;
  readonly saved: boolean;
  readonly message: string;
  /**
   * H-2 SECURITY. Why a save did not happen, in the closed vocabulary the tool
   * layer maps to failure codes. `not_authorized` / `stale_recipe` mean the USER
   * did not authorize saving THIS recipe in the CURRENT turn; the vault was NOT
   * written. Optional for compatibility with earlier bounded outcomes.
   */
  readonly reason_code?:
    | 'not_authorized'
    | 'stale_recipe'
    | 'nothing_unsaved'
    | 'no_owner'
    | 'write_failed';
}

/** One line corrected by the deterministic nutrition-correction operation. */
export interface ShisoNutritionCorrectionApplied {
  readonly line_ref: string;
  readonly label: string;
  /** Authenticated evidence, e.g. `Chicken breast, … · 1 cup, diced = 135 g`. */
  readonly description: string;
}

/** One line the correction operation could not resolve, with the reason. */
export interface ShisoNutritionCorrectionUnresolved {
  readonly line_ref: string;
  readonly label: string;
  readonly reason: string;
}

export interface ShisoNutritionCorrectionsOutcome {
  readonly ok: boolean;
  /**
   * H-2N: corrections whose line was VERIFIED resolved in the authoritative
   * post-operation projection. A correction is never listed here merely because
   * its action executed.
   */
  readonly applied: readonly ShisoNutritionCorrectionApplied[];
  /** Corrections that did NOT resolve; never reported as applied. */
  readonly failed?: readonly ShisoNutritionCorrectionUnresolved[];
  /** Previously resolved lines the operation would have regressed (refused). */
  readonly regressed?: readonly {
    readonly line_ref: string;
    readonly label: string;
    readonly reason: string;
  }[];
  /** Line-level changes between the before and after authoritative states. */
  readonly changes?: readonly {
    readonly line_ref: string;
    readonly label: string;
    readonly change: string;
    readonly before_status: string;
    readonly after_status: string;
  }[];
  readonly unresolved: readonly ShisoNutritionCorrectionUnresolved[];
  readonly summary: string;
  /** Authoritative BEFORE counts (the state the user was looking at). */
  readonly before_resolved_count?: number;
  readonly before_total_count?: number;
  /** Post-operation deterministic coverage of the working review. */
  readonly resolved_count: number;
  readonly total_count: number;
  readonly recalculation: 'complete' | 'partial' | 'absent';
  readonly working_unsaved: boolean;
}

// ---------------------------------------------------------------------------
// Observations returned to the model. Bounded, verified, and free of authority.
// ---------------------------------------------------------------------------

export interface ShisoObservationOk {
  readonly ok: true;
  readonly tool: ShisoToolName;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ShisoObservationFail {
  readonly ok: false;
  readonly tool: ShisoToolName;
  readonly code: ShisoObservationFailureCode;
  readonly message: string;
}

export type ShisoObservation = ShisoObservationOk | ShisoObservationFail;

export type ShisoObservationFailureCode =
  | 'invalid_arguments'
  | 'no_active_recipe'
  | 'no_nutrition_review'
  | 'unknown_line_ref'
  | 'catalog_search_empty'
  | 'record_not_found'
  | 'no_usable_portion'
  | 'budget_exhausted'
  | 'no_analysis_owner'
  | 'analysis_unavailable'
  | 'review_not_initialized'
  | 'stale_recipe'
  // H-2 editing capabilities. `no_edit_owner` / `no_save_owner` mean the
  // application surface that owns the working state is not mounted, so Shiso
  // must say so rather than pretend a change happened.
  | 'no_edit_owner'
  | 'edit_rejected'
  | 'no_save_owner'
  | 'save_unavailable'
  // H-2 SECURITY: the user did not authorize saving the current recipe in the
  // current turn (or the authorization belonged to a different recipe). No
  // vault write occurred; Shiso must ask for the explicit instruction.
  | 'save_not_authorized'
  | 'unsupported';

// ---------------------------------------------------------------------------
// Nutrition correction proposals
//
// A proposal is a REQUEST. It is never an acceptance, and the model can never
// author one that the application will accept: `validateShisoProposal` re-checks
// every referenced identity against live state before confirmation is offered.
// ---------------------------------------------------------------------------

/**
 * The ACTIONABLE outcome vocabulary.
 *
 * `verified_household_conversion` was previously listed here, but no producer
 * creates it and the server parser drops it: advertising an executable proposal
 * that can never be produced or confirmed is a false capability claim (audit
 * F-1). Household evidence is still INSPECTABLE and EXPLAINABLE through
 * `investigate_ingredient_amount`, which reports authenticated household and
 * count-portion evidence without claiming to apply it.
 */
export type ShisoProposalOutcome =
  | 'verified_alternative_match'
  | 'verified_available_portion'
  | 'clarification_required'
  | 'user_weight_recommended'
  | 'no_trustworthy_resolution';

export interface ShisoProposalBase {
  readonly line_ref: string;
  readonly ingredient_label: string;
  readonly outcome: ShisoProposalOutcome;
  /** Plain-language reasoning shown to the user. Never asserted as fact. */
  readonly explanation: string;
  /** What SHISO needs from the user when the outcome needs input. */
  readonly question: string | null;
}

export interface ShisoMatchProposal extends ShisoProposalBase {
  readonly outcome: 'verified_alternative_match';
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly review_digest: string;
}

export interface ShisoPortionProposal extends ShisoProposalBase {
  readonly outcome: 'verified_available_portion';
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly portion_index: number;
  readonly gram_weight: number;
  readonly measure: string;
}

export interface ShisoUserWeightProposal extends ShisoProposalBase {
  readonly outcome: 'user_weight_recommended';
}

export type ShisoProposal =
  | ShisoMatchProposal
  | ShisoPortionProposal
  | ShisoUserWeightProposal
  | (ShisoProposalBase & { readonly outcome: 'clarification_required' | 'no_trustworthy_resolution' });

/**
 * A proposal as the UI holds it: the model's content plus the identities it was
 * raised under. Confirmation revalidates EVERY identity here against live state,
 * so switching recipes or re-analyzing makes it fail closed.
 */
export interface ShisoBoundProposal {
  readonly proposal_id: string;
  readonly proposal_version: string;
  readonly recipe_key: string;
  readonly session_identity: string;
  readonly catalog_digest: string;
  readonly bundle_release: string;
  readonly proposal: ShisoProposal;
}

// ---------------------------------------------------------------------------
// The model-facing response schema
// ---------------------------------------------------------------------------

export type ShisoModelDecision =
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'tool_request'; readonly tool: ShisoToolName; readonly args: ShisoToolArgs };

/** Closed JSON schema handed to the provider for its structured decision. */
export const SHISO_DECISION_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['reply', 'tool_request'] },
    text: { type: 'string' },
    tool: {
      type: 'string',
      enum: [...SHISO_TOOL_NAMES],
    },
    args: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        fdc_id: { type: 'integer' },
        line_ref: { type: 'string' },
        cursor: { type: 'string' },
        include_ingredients: { type: 'boolean' },
        statuses: { type: 'array', items: { type: 'string', enum: ['needs_amount', 'needs_match'] } },
        // H-2: structured, field-scoped ingredient edits. Each edit names only
        // the fields it changes; unnamed fields are preserved from the authored
        // line. There is deliberately NO free-text "replacement line" field.
        edits: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['line_ref'],
            properties: {
              line_ref: { type: 'string' },
              new_name: { type: 'string' },
              new_amount: { type: 'number' },
              new_unit: { type: 'string' },
              new_preparation: { type: 'string' },
            },
          },
        },
        line_refs: { type: 'array', items: { type: 'string' } },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Wire contracts
// ---------------------------------------------------------------------------

/**
 * One verified capability result retained for the rest of the conversation.
 *
 * Audit H-1: the turn loop used to keep a SINGLE observation slot, so each new
 * tool result erased the previous one and a budget-exhausted turn reported "here
 * is what I found so far" with nothing found. Findings are now ACCUMULATED,
 * bounded, and carried forward so a turn can finish on real evidence and a later
 * turn can genuinely continue instead of restarting.
 *
 * Only the bounded `summary` is retained — never a whole payload — so this stays
 * small, and every entry is a string the APPLICATION produced, never model prose.
 */
export interface ShisoCollectedFinding {
  readonly tool: ShisoToolName;
  readonly ok: boolean;
  readonly summary: string;
}

export interface ShisoTurnRequestBody {
  readonly turn_version: string;
  readonly user_message: string;
  readonly history: readonly ShisoConversationMessage[];
  readonly context: ShisoConversationContext;
  /** Present only when answering a previous tool request. */
  readonly observation?: ShisoObservation;
  /**
   * Bounded, already-collected findings the model may report from without
   * spending another tool call. Application-produced strings only.
   */
  readonly collected?: readonly ShisoCollectedFinding[];
  /**
   * Set by the client on the last request of a turn, once no further tool call
   * is affordable. The model MUST answer with what it has; requesting another
   * tool is refused rather than looping.
   */
  readonly finalize?: boolean;
  readonly model_invocations_used: number;
  readonly tool_calls_used: number;
}

/**
 * The result the Advanced Nutrition OWNER reports back after running its own
 * deterministic analysis.
 *
 * It lives in the CORE contract, not in the application layer, because it is a
 * port: the UI registers the implementation and the capability reads the result.
 * Keeping it here means the Advanced Nutrition UI depends only on core, which is
 * the dependency direction the isolation tests enforce.
 *
 * Every number is produced by the existing analyzer and calculator. Shiso never
 * computes or estimates any of them.
 */
export interface ShisoAnalysisOutcome {
  readonly ok: boolean;
  /** True when the owner ran the analysis; false when it could not. */
  readonly analyzed: boolean;
  readonly summary: string;
  readonly matched: number;
  readonly needs_amount: number;
  readonly needs_match: number;
  readonly total_lines: number;
  /** The line references still unresolved after the analysis ran. */
  readonly unresolved_line_refs: readonly string[];
  /** True when the deterministic preview is complete, partial, or absent. */
  readonly preview_state: 'complete' | 'partial' | 'absent';
  readonly message?: string;
}

/**
 * Why a turn could not complete. Audit H-1: every provider failure previously
 * collapsed into one "provider unavailable" string, which told Sid nothing and
 * hid the fact that his failure was a TIMEOUT rather than a quota or a
 * credential problem.
 *
 * These are deliberately coarse and non-sensitive. No status code, provider
 * name, model id, key, token or raw provider body is ever carried to the client.
 */
export type ShisoTurnFailureCode =
  | 'invalid_request'
  | 'budget_exhausted'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_network_error'
  | 'provider_error'
  | 'credentials_missing'
  | 'no_capability_available'
  | 'provider_invalid_response'
  | 'internal_error';

export type ShisoTurnResponse =
  | {
      readonly ok: true;
      readonly kind: 'reply';
      readonly text: string;
      readonly proposals: readonly ShisoProposal[];
      readonly model_invocations_used: number;
      readonly tool_calls_used: number;
    }
  | {
      readonly ok: true;
      readonly kind: 'tool_request';
      readonly tool: ShisoToolName;
      readonly args: ShisoToolArgs;
      readonly model_invocations_used: number;
      readonly tool_calls_used: number;
    }
  | {
      readonly ok: false;
      readonly code: ShisoTurnFailureCode;
      readonly message: string;
      /** True when a provider request was actually attempted. */
      readonly aiAttempted: boolean;
    };
