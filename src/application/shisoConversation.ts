/**
 * The Kitchen Codex — SHISO conversation orchestration (browser side).
 *
 * This is the bounded turn loop. One user message becomes:
 *
 *   user message
 *     -> POST /api/shiso/turn
 *     -> server asks the selected model what to do
 *     -> tool_request?  execute the capability HERE, against real authority
 *     -> POST the observation back
 *     -> ...bounded... -> reply (+ proposals the user can inspect)
 *
 * Budgets are carried in the request and re-checked HERE as well as on the
 * server, because the browser is the authority boundary: a server that asked for
 * one more step than allowed still gets refused.
 *
 * A proposal is NEVER accepted here. It is bound to the recipe key, session
 * identity and catalog digest it was raised under, and confirmation revalidates
 * all three against live state before the existing authoritative transition runs.
 */

import {
  SHISO_CONVERSATION_VERSION,
  SHISO_ENDPOINT,
  SHISO_LIMITS,
  SHISO_PROPOSAL_VERSION,
  SHISO_TURN_CONTRACT_VERSION,
  type ShisoBoundProposal,
  type ShisoCollectedFinding,
  type ShisoConversationContext,
  type ShisoConversationMessage,
  type ShisoObservation,
  type ShisoProposal,
  type ShisoToolArgs,
  type ShisoToolName,
  type ShisoTurnRequestBody,
  type ShisoTurnResponse,
} from '../core/shiso/protocol';

import type { NetworkAdapter, NetworkResponse } from './adapters/NetworkAdapter';
import { buildAiSelectionRequestOptions } from './aiSelection';
import { executeShisoTool, type ShisoToolContext } from './shisoTools';
import { planDeterministicIngredientEdit } from '../core/shiso/deterministicEdit';
import { classifySaveIntent } from '../core/shiso/saveAuthorization';

/** How many verified findings survive across turns for continuation. */
const MAX_RETAINED_FINDINGS = 12;

/**
 * H-2S. Runs an UNAMBIGUOUS simple-edit command deterministically, with ZERO
 * provider calls, through the SAME application applier the model path uses.
 *
 * Returns null whenever the message is not a single unmistakable edit or the
 * application cannot complete it — the caller then runs the normal model turn.
 * It NEVER saves: a message that authorizes saving takes the normal flow, where
 * the trusted save-authorization boundary decides.
 */
async function tryDeterministicEdit(
  toolContext: ShisoToolContext,
  userMessage: string,
): Promise<{ readonly message: string; readonly summary: string } | null> {
  const recipe = toolContext.recipe;
  if (recipe === null || toolContext.applyIngredientEdits === undefined) return null;
  // A message that asks to save goes through the full conversation + the save
  // authorization gate; this path never writes to the Vault.
  if (classifySaveIntent(userMessage).authorized) return null;
  const planned = planDeterministicIngredientEdit({
    userMessage,
    ingredients: recipe.ingredients,
  });
  if (planned.ok !== true) return null;

  let outcome;
  try {
    outcome = await toolContext.applyIngredientEdits([planned.plan.edit]);
  } catch {
    return null;
  }
  if (outcome.ok !== true || outcome.applied.length !== 1) return null;
  const applied = outcome.applied[0] as { before: string; after: string };
  return Object.freeze({
    message:
      `Changed **${applied.before}** → **${applied.after}** in the unsaved working copy. ` +
      `Nothing has been saved.`,
    summary: outcome.summary,
  });
}

/** Estimate requests go to the nutrition owner directly, never the recipe-edit model path. */
function requestsEstimatedNutrition(message: string): boolean {
  const text = message.toLowerCase().replace(/[’']/g, '');
  return (
    /\bfix\b.{0,50}\bmissing ingredients?\b/.test(text) ||
    /\b(fix|resolve|finish|complete)\b.{0,90}\b(?:last|remaining|unresolved|missing)\b.{0,35}\b(?:ingredients?|ings?)\b/.test(text) ||
    /\b(?:estimate|guess|calculate|find)\b.{0,60}\b(?:weight|amount)\b/.test(text) ||
    /\b(?:onions?|tomatoes?|ingredients?)\b.{0,70}\b(?:doesnt|dont|does not|do not|has no|have no|is missing|are missing|without)\b.{0,30}\b(?:weight|amount)\b/.test(text) ||
    /\b(?:finish|complete|fix|resolve|estimate|calculate)\b.{0,70}\bnutrition\b.{0,90}\b(?:for|on|of)\b.{0,50}\b(?:ingredients?|onions?|tomatoes?)\b/.test(text) ||
    /\b(resolve|estimate|calculate)\b.{0,90}\b(estimated nutrition|nutrition estimates?|using estimates?|with estimates?|not exact|doesnt have to be exact)\b/.test(text) ||
    /\b(use|using)\b.{0,40}\bestimated nutrition\b/.test(text)
  );
}

/** Short nutrition-resolution language is routed to the live nutrition review,
 * never to recipe-edit intent classification. */
function requestsNutritionInvestigation(message: string): boolean {
  const text = message.toLowerCase().replace(/[’']/g, '');
  return /^\s*(?:please\s+)?(?:resolve|find|match|investigate|look up)\s+(?:(?:the|this|that)\s+)?[\p{L}\p{N}][\p{L}\p{N}\s,'-]{0,80}[\p{L}\p{N}]\s*[.!]?$/u.test(text) ||
    /\b(?:resolve|find|match|investigate|look up)\b.{0,70}\b(?:ingredient|food|usda|nutrition|match)\b/.test(text) ||
    /\b(?:use|choose|select)\b.{0,45}\bthis\s+(?:usda\s+)?(?:food|match|record)\b/.test(text);
}

function requestsManualUsdaChoice(message: string): boolean {
  return /\b(?:use|choose|select)\b.{0,45}\bthis\s+(?:usda\s+)?(?:food|match|record)\b/i.test(message);
}

export interface ShisoConversationState {
  readonly messages: readonly ShisoConversationMessage[];
  readonly proposals: readonly ShisoBoundProposal[];
  /**
   * Verified capability results retained for the whole conversation.
   *
   * Audit H-1: the turn loop used to hold ONE observation slot, so each tool
   * result erased the previous one and a later turn had no memory of earlier
   * verified work — "continue where you left off" restarted from nothing. These
   * are the APPLICATION's bounded summary strings, never model prose.
   */
  readonly findings: readonly ShisoCollectedFinding[];
}

export function initialShisoConversation(): ShisoConversationState {
  return {
    messages: Object.freeze([]),
    proposals: Object.freeze([]),
    findings: Object.freeze([]),
  };
}

/** Bounded, append-only, oldest-first-dropped conversation history. */
export function appendShisoMessage(
  state: ShisoConversationState,
  message: ShisoConversationMessage,
): ShisoConversationState {
  const messages = [...state.messages, message];
  return {
    messages: Object.freeze(
      messages.slice(Math.max(0, messages.length - SHISO_LIMITS.maxHistoryMessages)),
    ),
    proposals: state.proposals,
    findings: state.findings,
  };
}

/**
 * Retains a verified finding, de-duplicating an identical result so a repeated
 * capability cannot crowd out newer work.
 */
export function recordFinding(
  state: ShisoConversationState,
  finding: ShisoCollectedFinding,
): ShisoConversationState {
  const key = `${finding.tool}|${finding.ok}|${finding.summary}`;
  const already = state.findings.some(
    (f) => `${f.tool}|${f.ok}|${f.summary}` === key,
  );
  const findings = already
    ? state.findings
    : Object.freeze([...state.findings, finding].slice(-MAX_RETAINED_FINDINGS));
  return { messages: state.messages, proposals: state.proposals, findings };
}

export interface ShisoTurnDeps {
  readonly network: NetworkAdapter;
  readonly context: ShisoConversationContext;
  readonly toolContext: ShisoToolContext;
  readonly signal?: AbortSignal;
}

export interface ShisoTurnOutcome {
  readonly ok: boolean;
  /** True means this turn was explicitly cancelled; it is not an AI failure. */
  readonly cancelled?: boolean;
  readonly state: ShisoConversationState;
  /** The assistant's final message, when the turn completed. */
  readonly message: string | null;
  /** Bounded status for the UI. Never a raw provider exception. */
  readonly status: string | null;
  /** The capabilities actually executed, in order, for transparency. */
  readonly toolsUsed: readonly string[];
}

function boundContext(context: ShisoConversationContext): ShisoConversationContext {
  return {
    recipe: context.recipe,
    nutrition: context.nutrition,
    recipeKey: context.recipeKey,
    sessionIdentity: context.sessionIdentity,
  };
}

function bindProposals(
  proposals: readonly ShisoProposal[],
  context: ShisoConversationContext,
): ShisoBoundProposal[] {
  const recipeKey = context.recipeKey;
  const sessionIdentity = context.sessionIdentity;
  if (recipeKey === null || sessionIdentity === null) return [];
  return proposals.map((proposal, index) => ({
    proposal_id: `${recipeKey}:${index}:${proposal.line_ref}`,
    proposal_version: SHISO_PROPOSAL_VERSION,
    recipe_key: recipeKey,
    session_identity: sessionIdentity,
    catalog_digest: '',
    bundle_release: '',
    proposal,
  }));
}

/**
 * The bounded, application-produced one-line account of an observation. Uses
 * the failure message when the capability did not succeed, so a failure is still
 * reported as a finding rather than silently dropped.
 */
function observationSummary(observation: ShisoObservation): string {
  if (observation.ok) return observation.summary.slice(0, 400);
  const failure = observation as { readonly message?: unknown };
  const text = typeof failure.message === 'string' ? failure.message : 'That capability did not succeed.';
  return text.slice(0, 400);
}

/** Stable signature for a capability request, used to detect repeated work. */
function toolSignature(args: ShisoToolArgs): string {
  return `${args.tool}:${JSON.stringify(args)}`;
}

/**
 * A prerequisite that every dependent capability needs.
 *
 * H-1F: when the USDA bundle is not loaded, EVERY nutrition capability fails
 * with the same message. The old loop treated each as an independent step, so
 * one missing bundle cost three or four full model round-trips before the turn
 * died on its budget having told the user nothing. Recording the block here lets
 * the loop refuse dependent capabilities immediately and immediately render the
 * deterministic recovery instruction instead.
 */
export interface ShisoBlock {
  readonly reason: string;
  readonly recovery: string;
  /** Capabilities that cannot run until this is resolved. */
  readonly blocked: ReadonlyArray<ShisoToolName>;
}

/** Capabilities that all require a loaded USDA session. */
const USDA_DEPENDENT_TOOLS: ReadonlySet<string> = new Set([
  'search_usda_foods',
  'inspect_usda_food',
  'investigate_ingredient_amount',
  'investigate_unresolved_ingredients',
  'run_nutrition_analysis',
  'get_nutrition_review',
  // H-2: the deterministic correction pass reads the authenticated review, so it
  // shares the same prerequisite. Editing/saving the RECIPE does not.
  'apply_nutrition_corrections',
]);

/**
 * Runs ONE user turn to completion, executing every requested capability locally
 * and returning a final assistant message plus inspectable proposals.
 *
 * Audit H-1 changed three things about this loop:
 *
 *  1. FINDINGS ACCUMULATE. Every verified observation is retained for the turn
 *     and for the conversation. Previously only the latest observation survived,
 *     so each new tool result erased the last and nothing could ever be reported.
 *  2. A TURN ALWAYS ENDS IN A REPORT. When the model or the tool budget runs out,
 *     one final request is made with `finalize`, carrying the collected findings
 *     and instructing the model to answer with them. A turn can no longer end in
 *     "here is what I found so far" with nothing found.
 *  3. REPEATED WORK IS SERVED FROM CACHE. An identical capability request within
 *     the same turn returns the observation already obtained instead of consuming
 *     budget, which is what let the loop spin.
 *
 * H-1F changed two more:
 *
 *  4. PREREQUISITES SHORT-CIRCUIT. Once a blocking prerequisite is known, every
 *     capability that depends on it is refused locally without spending another
 *     model call. The human test lost ~30 seconds and its entire reasoning budget
 *     to three consecutive failures caused by one missing prerequisite.
 *
 *  5. DELIVERY NEVER DEPENDS ON THE PROVIDER. If the model cannot answer — it
 *     timed out, rate-limited, or the turn finalized with no reply — the report
 *     is rendered DETERMINISTICALLY from the findings already in hand. Real USDA
 *     records and real gram weights are never withheld because the provider was
 *     slow.
 *
 * On any failure the collected findings are RETAINED, so a later message can
 * genuinely continue from verified work instead of restarting.
 */
export async function runShisoConversationTurn(
  deps: ShisoTurnDeps,
  state: ShisoConversationState,
  userMessage: string,
): Promise<ShisoTurnOutcome> {
  const cancelled = (state: ShisoConversationState, toolsUsed: readonly string[] = []): ShisoTurnOutcome => ({
    ok: false, cancelled: true, state, message: null, status: null, toolsUsed,
  });
  if (deps.signal?.aborted) return cancelled(state);
  const trimmed = userMessage.trim().slice(0, SHISO_LIMITS.maxUserMessageChars);
  if (trimmed.length === 0) {
    return {
      ok: false,
      state,
      message: null,
      status: 'Type a question for Shiso.',
      toolsUsed: [],
    };
  }

  let working: ShisoConversationState = appendShisoMessage(state, { role: 'user', text: trimmed });
  const toolsUsed: string[] = [];
  /** Verified findings gathered during THIS turn. */
  const collected: ShisoCollectedFinding[] = [];
  /** tool signature -> observation already obtained this turn. */
  const cache = new Map<string, ShisoObservation>();
  /** H-2S: tool signature -> how many times an EQUIVALENT failure occurred. */
  const failureCounts = new Map<string, number>();
  let modelInvocations = 0;
  let toolCalls = 0;
  let observation: ShisoObservation | undefined;
  let finalizeSent = false;
  /** Set the moment a capability reports a missing prerequisite. */
  let block: ShisoBlock | null = null;

  // These phrases authorize preparing a nutrition estimate in the existing
  // unsaved Advanced Nutrition review. Route deterministically so they cannot
  // be misread as a recipe-edit command or spend an unnecessary chat turn.
  if (requestsEstimatedNutrition(trimmed) && !classifySaveIntent(trimmed).authorized) {
    if (deps.signal?.aborted) return cancelled(working, toolsUsed);
    let result: ShisoObservation;
    try {
      result = await executeShisoTool({ tool: 'run_nutrition_analysis' }, deps.toolContext, deps.signal);
    } catch {
      result = { ok: false, tool: 'run_nutrition_analysis', code: 'unsupported', message: 'Nutrition estimation could not be completed.' };
    }
    if (deps.signal?.aborted) return cancelled(working, toolsUsed);
    const summary = result.ok ? result.summary : (result as { readonly message: string }).message;
    const data = result.ok ? result.data : {};
    const aiEstimated = typeof data['ai_estimated'] === 'number' ? data['ai_estimated'] : 0;
    const aiStatus = data['ai_estimate_status'];
    const aiFailure = typeof data['ai_estimate_message'] === 'string' ? ` ${data['ai_estimate_message']}` : '';
    const message = result.ok
      ? aiEstimated > 0
        ? `${summary} Accepted estimates are in the unsaved Advanced Nutrition review; inspect assumptions and unknown values before Apply. Nothing was saved.`
        : `${summary} ${aiStatus === 'unavailable'
          ? `No AI nutrition estimate was confirmed.${aiFailure}`
          : aiStatus === 'skipped_covered'
            ? 'The current review already covers every ingredient; no repeated estimate request was needed.'
          : 'No usable AI nutrient contribution was confirmed; review the remaining source gaps and unknown nutrients.'} Nothing was saved.`
      : `${summary} No ingredient edits or saves were made.`;
    const nextState = result.ok
      ? recordFinding(appendShisoMessage(working, { role: 'assistant', text: message, proposalCount: 0 }), { tool: result.tool, ok: true, summary: result.summary })
      : appendShisoMessage(working, { role: 'assistant', text: message, proposalCount: 0 });
    return {
      ok: true,
      state: nextState,
      message,
      status: null,
      toolsUsed: Object.freeze(['run_nutrition_analysis']) as readonly string[],
    };
  }

  // USDA choices remain an explicit action in the open Advanced Nutrition
  // review. Explain the scoped control directly instead of sending a selection
  // request through recipe-edit interpretation or silently choosing a record.
  if (requestsManualUsdaChoice(trimmed)) {
    const message = deps.toolContext.nutrition === null
      ? 'Open Advanced Nutrition for this recipe, then choose the intended USDA record from that ingredient row. I cannot apply a food choice from chat without the review selection control. Nothing was changed or saved.'
      : 'In the open Advanced Nutrition review, use the “Use this match” control on the intended ingredient row. That explicit selection is bound to this recipe and its current USDA review. I will not choose or apply a USDA record from chat. Nothing was changed or saved.';
    return {
      ok: true,
      state: appendShisoMessage(working, { role: 'assistant', text: message, proposalCount: 0 }),
      message,
      status: null,
      toolsUsed: [],
    };
  }

  // “Resolve [ingredient]” is nutrition work, not an ingredient text edit.
  // Investigation is read-only and uses the current authenticated review; it
  // returns the real alternatives and leaves any choice to the established UI.
  if (
    requestsNutritionInvestigation(trimmed) &&
    (deps.toolContext.nutrition !== null || /\b(?:nutrition|usda|ingredient)\b/i.test(trimmed)) &&
    !classifySaveIntent(trimmed).authorized
  ) {
    if (deps.signal?.aborted) return cancelled(working, toolsUsed);
    let result: ShisoObservation;
    try {
      result = await executeShisoTool({ tool: 'investigate_unresolved_ingredients' }, deps.toolContext, deps.signal);
    } catch {
      result = { ok: false, tool: 'investigate_unresolved_ingredients', code: 'unsupported', message: 'The nutrition review could not be investigated.' };
    }
    if (deps.signal?.aborted) return cancelled(working, toolsUsed);
    const lineNotes = result.ok && Array.isArray(result.data['lines'])
      ? result.data['lines'].slice(0, 6).flatMap((rawLine) => {
          if (rawLine === null || typeof rawLine !== 'object' || Array.isArray(rawLine)) return [];
          const line = rawLine as Record<string, unknown>;
          if (typeof line['label'] !== 'string') return [];
          const label = line['label'].slice(0, 200);
          const reason = typeof line['reason'] === 'string' ? ` — ${line['reason'].slice(0, 180)}` : '';
          const alternatives = Array.isArray(line['alternatives'])
            ? line['alternatives'].slice(0, 2).flatMap((candidate) =>
                candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) && typeof (candidate as Record<string, unknown>)['description'] === 'string'
                  ? [(candidate as Record<string, string>)['description'].slice(0, 160)]
                  : [])
            : [];
          return [`${label}${reason}${alternatives.length ? ` · USDA options: ${alternatives.join('; ')}` : ''}`];
        }).join('\n')
      : '';
    const message = result.ok
      ? `${result.summary}${lineNotes ? `\n${lineNotes}` : ''} ${result.data['remaining'] ? 'Open Advanced Nutrition to review candidate records and choose “Use this match” where appropriate.' : 'No food was changed.'} Nothing was saved.`
      : `${(result as { message: string }).message} No recipe edit or save was made.`;
    let next = appendShisoMessage(working, { role: 'assistant', text: message, proposalCount: 0 });
    if (result.ok) next = recordFinding(next, { tool: result.tool, ok: true, summary: result.summary });
    return { ok: true, state: next, message, status: null, toolsUsed: Object.freeze(['investigate_unresolved_ingredients']) };
  }

  /**
   * H-2S — DETERMINISTIC SIMPLE EDITS RUN BEFORE THE MODEL.
   *
   * A single unmistakable edit command ("Change the 2 jalapeños to 3 jalapeños.
   * Do not save.") is planned and executed entirely in the application: zero
   * provider calls, one edit through the existing authority, one concise reply.
   * Anything unclear falls through to the normal conversation below.
   */
  const deterministic = await tryDeterministicEdit(deps.toolContext, trimmed);
  // The owner may have completed an already-started edit while this turn was
  // being cancelled. Preserve that underlying change, but never publish it as
  // the active turn's successful result after cancellation was observed.
  if (deps.signal?.aborted) return cancelled(working, toolsUsed);
  if (deterministic !== null) {
    const assistantMessage: ShisoConversationMessage = {
      role: 'assistant',
      text: deterministic.message,
      proposalCount: 0,
    };
    const nextState: ShisoConversationState = recordFinding(
      appendShisoMessage(working, assistantMessage),
      { tool: 'apply_ingredient_edits', ok: true, summary: deterministic.summary },
    );
    return {
      ok: true,
      state: nextState,
      message: deterministic.message,
      status: null,
      toolsUsed: Object.freeze(['apply_ingredient_edits']) as readonly string[],
    };
  }

  const retain = (next: ShisoObservation): void => {
    const summary = observationSummary(next);
    collected.push({ tool: next.tool, ok: next.ok, summary });
    working = recordFinding(working, { tool: next.tool, ok: next.ok, summary });
  };

  /**
   * H-2S — REPEATED EQUIVALENT FAILURES ARE TERMINAL.
   *
   * The human test showed the model repeating the same empty-argument edit
   * attempt until the budget died: two reads, two identical failures, no
   * result. A second identical failure now ends the turn immediately with a
   * truthful, actionable account instead of burning the remaining budget.
   */
  const noteFailure = (signature: string, next: ShisoObservation): ShisoTurnOutcome | null => {
    if (next.ok) return null;
    const count = (failureCounts.get(signature) ?? 0) + 1;
    failureCounts.set(signature, count);
    if (count < 2) return null;
    return {
      ok: true,
      state: working,
      message:
        'I stopped instead of repeating the same failing step, so nothing was changed.\n\n' +
        'If you meant to change an ingredient, tell me the exact change in one line — for example: ' +
        '"change 2 cups of flour to 3 cups".',
      status: null,
      toolsUsed,
    };
  };

  /**
   * Recognises the "prerequisite missing" family and records the block ONCE.
   *
   * A failure is not a finding. Before H-1F it was retained as one, so the final
   * report listed the same unavailable capability three times as though those
   * were three separate results.
   */
  const detectBlock = (next: ShisoObservation): void => {
    if (next.ok || block !== null) return;
    const code = (next as { code?: unknown }).code;
    const message = String((next as { message?: unknown }).message ?? '');
    const bundleMissing = /catalogue is not loaded|USDA catalogue is not loaded/i.test(message);
    if (
      code === 'no_nutrition_review' ||
      code === 'no_analysis_owner' ||
      code === 'review_not_initialized'
    ) {
      block = {
        reason: bundleMissing
          ? 'the USDA food catalogue has not been loaded in this browser yet, so no food lookup or nutrition calculation can run.'
          : 'this recipe has no initialized Advanced Nutrition review yet, so there is nothing to analyse or review.',
        recovery: bundleMissing
          ? 'open Advanced Nutrition for this recipe and choose "Load USDA data" — the catalogue is never loaded automatically — then ask me again.'
          : 'open Advanced Nutrition for this recipe so its review is initialized, then ask me again.',
        blocked: Object.freeze([...USDA_DEPENDENT_TOOLS] as ShisoToolName[]),
      };
    }
  };

  /**
   * Editing capabilities whose SUCCESS changes the working recipe or review.
   * Used ONLY to keep the deterministic fallback honest: if one of these ran
   * and nothing succeeded, the report must say so instead of letting a read-back
   * (for example get_current_recipe) imply an edit happened.
   */
  const EDITING_TOOLS: ReadonlySet<string> = new Set([
    'apply_ingredient_edits',
    'apply_nutrition_corrections',
    'save_working_recipe',
  ]);

  /**
   * Deterministic delivery of everything already known, with NO provider call.
   *
   * This is the H-1F answer to "provider timeout, so the user got nothing":
   * when the model cannot answer, the application still renders the findings it
   * already verified.
   *
   * H-2R: it also states plainly when NO edit succeeded. A recovered transcript
   * must never read as though retrieving recipe information had changed it.
   */
  const deterministicReport = (lead: string): string => {
    const body =
      collected.length === 0
        ? 'I did not gather any results before this stopped.'
        : collected.map((f, i) => `${i + 1}. **${f.tool}** — ${f.summary}`).join('\n');
    const editAttempted = toolsUsed.some((tool) => EDITING_TOOLS.has(tool));
    const editSucceeded = collected.some((f) => f.ok && EDITING_TOOLS.has(f.tool));
    const changeNote =
      editAttempted && !editSucceeded
        ? '\n\n**No recipe change was applied in this message.** No edit or save succeeded, so your working copy is exactly as it was.'
        : '';
    return `${lead}\n\n${body}${changeNote}`;
  };

  /**
   * The last resort when the turn cannot reach the model again. It reports the
   * REAL collected findings instead of a generic budget message.
   */
  const exhaustedReport = (reason: string): ShisoTurnOutcome => {
    if (collected.length === 0) {
      return {
        ok: false,
        state: working,
        message: null,
        status: `${reason} It did not gather any findings before stopping.`,
        toolsUsed,
      };
    }
    return {
      ok: true,
      state: working,
      message: deterministicReport(`${reason} Here is what it actually found before stopping:`),
      status: null,
      toolsUsed,
    };
  };

  /**
   * H-1F. A blocked prerequisite ends the turn IMMEDIATELY.
   *
   * There is no point asking the model to rediscover a fact the browser already
   * knows, and every extra attempt costs a real provider round-trip. The user
   * gets one precise instruction instead of a budget-exhausted transcript.
   */
  const blockedReport = (b: ShisoBlock): ShisoTurnOutcome => ({
    ok: true,
    state: working,
    message:
      `I can't run nutrition yet: ${b.reason}\n\n` +
      `**To fix it:** ${b.recovery}`,
    status: null,
    toolsUsed,
  });

  // Bounded by construction: every iteration either returns, increments a
  // counter the server also enforces, or exhausts the hard ceiling below.
  for (let step = 0; step <= SHISO_LIMITS.maxModelInvocationsPerTurn; step += 1) {
    if (deps.signal?.aborted) return cancelled(working, toolsUsed);
    const outOfModels = modelInvocations >= SHISO_LIMITS.maxModelInvocationsPerTurn;
    const outOfTools = toolCalls >= SHISO_LIMITS.maxToolCallsPerTurn;

    // Guarantee a report: the FIRST time either budget is spent, spend the next
    // request on finalizing rather than on more work.
    const mustFinalize = outOfModels || outOfTools;
    const sendFinalize = mustFinalize && !finalizeSent;
    if (mustFinalize && finalizeSent) {
      return exhaustedReport(
        outOfModels
          ? 'Shiso reached its reasoning budget for this message.'
          : 'Shiso reached its investigation budget for this message.',
      );
    }
    if (sendFinalize) finalizeSent = true;

    const body: ShisoTurnRequestBody = {
      turn_version: SHISO_TURN_CONTRACT_VERSION,
      user_message: trimmed,
      history: working.messages.slice(-SHISO_LIMITS.maxHistoryMessages),
      context: boundContext(deps.context),
      ...(observation !== undefined ? { observation } : {}),
      ...(collected.length > 0 ? { collected: Object.freeze([...collected]) } : {}),
      ...(sendFinalize ? { finalize: true } : {}),
      model_invocations_used: modelInvocations,
      tool_calls_used: toolCalls,
    };
    observation = undefined;

    let response: NetworkResponse<ShisoTurnResponse>;
    try {
      response = await deps.network.post<ShisoTurnResponse>(
        SHISO_ENDPOINT,
        body as unknown as Record<string, unknown>,
        { ...(await buildAiSelectionRequestOptions()), ...(deps.signal ? { signal: deps.signal } : {}) },
      );
    } catch {
      if (deps.signal?.aborted) return cancelled(working, toolsUsed);
      // H-1F: a transport failure must not withhold results already verified.
      return collected.length > 0
        ? {
            ok: true,
            state: working,
            message: deterministicReport('Shiso could not reach the assistant service.'),
            status: null,
            toolsUsed,
          }
        : { ok: false, state: working, message: null, status: 'Shiso could not reach the assistant service.', toolsUsed };
    }

    // A transport may resolve just as cancellation is requested. Discard that
    // response before interpreting it or starting a capability.
    if (deps.signal?.aborted) return cancelled(working, toolsUsed);

    const data: ShisoTurnResponse | undefined = response?.data;
    if (!response || response.ok !== true || data === undefined || data.ok !== true) {
      const failure = data as { code?: unknown; message?: unknown } | undefined;
      const message = typeof failure?.message === 'string' ? failure.message : null;
      const lead = message ?? 'Shiso is unavailable right now.';
      // H-1F: the provider failing is NOT a reason to throw away real USDA
      // evidence. This is the case that produced "try a shorter message" while
      // six verified records sat unused in the browser.
      if (collected.length > 0) {
        return {
          ok: true,
          state: working,
          message: deterministicReport(`${lead}\n\nThese results were already verified, so they are yours regardless:`),
          status: null,
          toolsUsed,
        };
      }
      return { ok: false, state: working, message: null, status: lead, toolsUsed };
    }

    const turn = data;
    if (turn.kind !== 'reply' && turn.kind !== 'tool_request') {
      return {
        ok: false, state: working, message: null,
        status: 'Shiso returned an unreadable response.', toolsUsed,
      };
    }
    modelInvocations =
      typeof turn.model_invocations_used === 'number' ? turn.model_invocations_used : modelInvocations + 1;
    toolCalls =
      typeof turn.tool_calls_used === 'number' ? turn.tool_calls_used : toolCalls;

    if (turn.kind === 'tool_request') {
      if (deps.signal?.aborted) return cancelled(working, toolsUsed);
      // H-1F: refuse a dependent capability the moment a prerequisite is known,
      // WITHOUT spending a model call on a guaranteed-identical failure.
      if (block !== null && block.blocked.includes(turn.tool)) {
        return blockedReport(block);
      }
      const signature = toolSignature(turn.args);
      const cached = cache.get(signature);
      if (cached !== undefined) {
        // Identical repeat: serve the verified result without spending budget,
        // and without claiming a capability ran that did not run again.
        // H-2S: a SECOND identical failure is terminal — no silent spinning.
        if (turn.tool === 'apply_nutrition_corrections') {
          const data = cached.ok ? cached.data : {};
          const resolved = typeof data['resolved_count'] === 'number' ? data['resolved_count'] : null;
          const total = typeof data['total_count'] === 'number' ? data['total_count'] : null;
          const complete = resolved !== null && total !== null && resolved >= total;
          return {
            ok: true,
            state: working,
            message: `I stopped because the same nutrition correction was requested again; it was not applied a second time. The last verified review showed ${resolved === null || total === null ? 'no new coverage count' : `${resolved} of ${total} ingredient lines resolved`}. ${complete ? 'The review already has complete ingredient coverage.' : 'Review the remaining lines in Advanced Nutrition.'} Earlier valid corrections remain in the unsaved review. Nothing was saved.`,
            status: null,
            toolsUsed,
          };
        }
        const terminal = noteFailure(signature, cached);
        if (terminal !== null) return terminal;
        retain(cached);
        observation = cached;
        continue;
      }
      toolCalls += 1;
      let executed: ShisoObservation;
      try {
        executed = await executeShisoTool(turn.args, deps.toolContext, deps.signal);
      } catch {
        executed = {
          ok: false,
          tool: turn.tool,
          code: 'unsupported',
          message: 'That capability could not be completed.',
        };
      }
      // An already-started operation is not rolled back. Do not retain a late
      // result as the current turn or begin another provider/tool iteration.
      if (deps.signal?.aborted) return cancelled(working, toolsUsed);
      cache.set(signature, executed);
      detectBlock(executed);
      // H-2S: a repeated EQUIVALENT failure ends the turn with a truthful
      // account instead of consuming the rest of the budget.
      {
        const terminal = noteFailure(signature, executed);
        if (terminal !== null) return terminal;
      }
      // A failure is never recorded as a finding — it is either a real result or
      // the one prerequisite that stops the turn.
      if (executed.ok) retain(executed);
      observation = executed;
      toolsUsed.push(turn.tool);
      if (turn.tool === 'apply_nutrition_corrections' && executed.ok) {
        const before = executed.data['before_resolved_count'];
        const after = executed.data['resolved_count'];
        const appliedCount = executed.data['applied_count'];
        const changes = executed.data['changes'];
        const total = executed.data['total_count'];
        const complete = typeof after === 'number' && typeof total === 'number' && after >= total;
        const meaningfulChange =
          (typeof appliedCount === 'number' && appliedCount > 0) ||
          (Array.isArray(changes) && changes.length > 0) ||
          (typeof before === 'number' && typeof after === 'number' && before !== after);
        if (
          typeof before === 'number' &&
          typeof after === 'number' &&
          after <= before &&
          !meaningfulChange &&
          !complete
        ) {
          return {
            ok: true,
            state: working,
            message: `I stopped because the nutrition correction made no coverage progress: ${after} of ${typeof total === 'number' ? total : 'an unknown number of'} ingredient lines are resolved. Earlier valid corrections remain in the unsaved review. Review the remaining lines in Advanced Nutrition. Nothing was saved.`,
            status: null,
            toolsUsed,
          };
        }
      }
      continue;
    }

    // A model cannot override the observed correction outcome with a success claim.
    const correction = [...cache.values()].reverse().find((item) => item.tool === 'apply_nutrition_corrections');
    const correctionOnly = correction && !toolsUsed.some((tool) => tool === 'apply_ingredient_edits' || tool === 'save_working_recipe');
    const applyConfirmationWithoutAction = /^(?:yes[, ]*|please )?apply(?: (?:it|them|those|all|the corrections|the estimates|the changes))?[.!]?$/i.test(trimmed) && !toolsUsed.some(tool => EDITING_TOOLS.has(tool));
    const text = applyConfirmationWithoutAction
      ? 'No changes were applied to the working recipe in this turn. Suggestions are still pending. Review the accepted nutrition and use Apply; Save to Vault remains a separate action.'
      : correctionOnly
      ? correction.ok
        ? `${correction.summary} ${correction.data['applied_count'] === 0 ? 'No additional source corrections were applied. Suggestions are not validated changes; accepted AI estimates already in the review remain available.' : 'These corrections are in the unsaved review. Use Apply to update the working recipe.'} Nothing was saved to Vault.`
        : `${(correction as { message: string }).message} No nutrition correction was confirmed and nothing was saved.`
      : typeof turn.text === 'string' ? turn.text : '';
    if (text.length === 0) {
      return exhaustedReport('Shiso returned an empty reply.');
    }

    const bound = bindProposals(
      Array.isArray(turn.proposals) ? (turn.proposals as ShisoProposal[]) : [],
      deps.context,
    );
    working = {
      messages: Object.freeze([
        ...working.messages,
        { role: 'assistant' as const, text, proposalCount: bound.length },
      ]).slice(-SHISO_LIMITS.maxHistoryMessages) as readonly ShisoConversationMessage[],
      proposals: Object.freeze([...working.proposals, ...bound]),
      findings: working.findings,
    };
    return {
      ok: true,
      state: working,
      message: text,
      status: null,
      toolsUsed,
    };
  }

  return exhaustedReport('Shiso could not finish this message within its budget.');
}

export { SHISO_CONVERSATION_VERSION };
