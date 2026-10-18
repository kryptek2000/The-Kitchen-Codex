/**
 * The Kitchen Codex — SHISO H-2 save authorization (core).
 *
 * PURE, OFFLINE, deterministic. This module is the TRUST anchor for the ONE
 * operation that can reach the user's Vault from a conversation: saving an
 * unsaved working recipe.
 *
 * WHY THIS EXISTS (the adversarial case)
 * --------------------------------------
 * The system prompt tells the model never to save spontaneously, and the model
 * is the component that decides WHEN to call `save_working_recipe`. A model fed
 * hostile recipe text or hostile tool output can be induced to call that tool
 * regardless of the prompt. Prompt text is therefore NOT an authority boundary:
 * the application itself must refuse a save that the USER did not authorize.
 *
 * The authorization model:
 *
 *   1. At the moment a user message is SENT, the application classifies THAT
 *      message's save intent with `classifySaveIntent` (deterministic, bounded,
 *      negation-aware). The model never sees or influences the stored verdict:
 *      it is derived from the raw user input before the model runs.
 *   2. The verdict is bound to the ACTIVE RECIPE identity and the CURRENT turn.
 *   3. `save_working_recipe` may only consume a CURRENT, UNCONSUMED, recipe-bound
 *      authorization. A missing authorization (the user did not ask to save, or
 *      asked in a previous turn) is refused before any write.
 *   4. The grant is verified AGAIN at the persistence owner (`verifySaveGrant`)
 *      against the recipe actually being saved, so a stale (recipe switched)
 *      authorization fails closed even if a caller bypassed the port.
 *
 * An explicit UI Save button is its own authorization (a genuine trusted user
 * event) and does not require a natural-language grant.
 */

/** The classified save intent of ONE raw user message. */
export interface ShisoSaveIntent {
  readonly authorized: boolean;
  /** Why the classification decided so. Bounded, never a raw message echo. */
  readonly reason: string;
}

/**
 * Messages longer than this are NEVER treated as a save command. A genuine
 * save instruction is short; a long paste that merely CONTAINS "save" (for
 * example an entire recipe or an injected instruction block) is not an
 * authorization.
 */
export const SHISO_SAVE_COMMAND_MAX_CHARS = 300;

/**
 * Injection-shaped content is never treated as a save command even when it
 * contains the word "save": untrusted text pasted into the composer must not
 * become an authorization by accident.
 */
const INJECTION_SHAPE = /(\bignore\s+(all\s+|the\s+)?(previous|prior|above)\b)|(\b(system|assistant|developer|tool)\s*[:\-–>])|(\byou\s+are\s+now\b)|(\bnew\s+instructions?\b)|(\bdisregard\s+(all\s+|the\s+)?instructions?\b)/i;

/** Explicit negation of a save. Checked BEFORE any positive pattern. */
const SAVE_NEGATION = /(\b(do\s+not|don'?t|does\s+not|doesn'?t|never|no)\s+(?:you\s+)?(?:yet\s+|actually\s+|really\s+)?save\b)|(\bsave\s+(?:it\s+|this\s+|them\s+)?(?:later|for\s+later)\b)|(\bwithout\s+saving\b)|(\bhold\s+off\s+on\s+sav(?:e|ing)\b)|(\bwait\s+to\s+save\b)|(\bnot\s+save\b)/i;

/** Questions never authorize a write, including polite questions with no `?`. */
const SAVE_QUESTION = /\?|\b(?:can|could|would|will|should|do|does|is|are)\s+(?:i|you|we|it|this|that)\b/i;
/** Requests for instructions or explanations mention saving but do not authorize it. */
const SAVE_INFORMATION_REQUEST = /\b(?:how\s+(?:do|can|should|would)\s+(?:i|you|we)|how\s+to\s+save|explain|describe|teach\s+me|tell\s+me|show\s+me|want\s+to\s+know|wonder(?:ing)?)\b/i;
/** Covers negation/uncertainty with intervening words, e.g. "do not want to save". */
const SAVE_WANT_NEGATION = /\b(?:do\s+not|don't|does\s+not|doesn't)\s+(?:want|wish|need)\s+to\s+save\b|\bno\s+need\s+to\s+save\b|\b(?:maybe|perhaps|possibly|might|may|not\s+sure|uncertain)\b[\s\S]{0,50}\b(?:save|saving)\b/i;

/**
 * The closed, conservative command vocabulary. Every pattern requires an
 * explicit imperative save directed at the application, e.g.:
 *   "Save my changes."       "Save it."          "Save the recipe."
 *   "Save changes now"       "Yes, save."        "Please save."
 *   "Go ahead and save."     "Save to the vault" "Save everything."
 * A statement that merely MENTIONS saving ("the recipe saves well", "save time")
 * does not match an imperative form.
 */
const SAVE_COMMANDS: ReadonlyArray<RegExp> = [
  // "save" + optional determiner + a direct object of the deferred work/recipe.
  /\bsave\s+(?:my\s+|the\s+|these\s+|those\s+|all\s+|your\s+)?(?:changes|change|edits|edit|corrections|correction|recipe|version|copy|work|it|this|them|everything|all)\b/i,
  // "save to the vault" / "save it to my vault" / "save now".
  /\bsave\s+(?:it\s+|this\s+|them\s+|everything\s+)?(?:now|to\s+(?:the|my)\s+vault)\b/i,
  // Affirmative continuations of a pending save question.
  /^\s*(?:yes|yep|yeah|ok|okay|sure)[,.\s]+(?:please\s+)?save\b/i,
  /\bplease\s+save\b/i,
  /\bgo\s+ahead\s+and\s+save\b/i,
  /\bsave\s+(?:the\s+)?(?:working\s+)?(?:copy|version)\b/i,
];

/**
 * Classifies ONE raw user message. Fails CLOSED: anything ambiguous (negation,
 * injection shape, over-long content, no imperative pattern) is NOT an
 * authorization. False negatives merely cost one extra natural-language turn;
 * false positives would write the Vault without the user asking.
 */
export function classifySaveIntent(message: string): ShisoSaveIntent {
  const text = typeof message === 'string' ? message.trim() : '';
  if (text.length === 0) return Object.freeze({ authorized: false, reason: 'empty_message' });
  if (text.length > SHISO_SAVE_COMMAND_MAX_CHARS) {
    return Object.freeze({ authorized: false, reason: 'message_too_long_for_save_command' });
  }
  if (SAVE_QUESTION.test(text)) {
    return Object.freeze({ authorized: false, reason: 'save_question' });
  }
  if (SAVE_NEGATION.test(text)) {
    return Object.freeze({ authorized: false, reason: 'save_negated' });
  }
  if (SAVE_WANT_NEGATION.test(text)) {
    return Object.freeze({ authorized: false, reason: 'save_negated' });
  }
  if (SAVE_INFORMATION_REQUEST.test(text)) {
    return Object.freeze({ authorized: false, reason: 'save_information_request' });
  }
  if (INJECTION_SHAPE.test(text)) {
    return Object.freeze({ authorized: false, reason: 'injection_shaped_content' });
  }
  for (const pattern of SAVE_COMMANDS) {
    if (pattern.test(text)) return Object.freeze({ authorized: true, reason: 'explicit_save_command' });
  }
  return Object.freeze({ authorized: false, reason: 'no_save_command' });
}

/**
 * The canonical recipe identity an authorization is bound to. The SAME
 * derivation is used where the authorization is issued (the conversation
 * surface) and where it is verified (the persistence owner), so a mismatch can
 * only mean the active recipe really changed.
 */
export function recipeIdentityOf(
  recipe: { readonly filePath?: unknown; readonly id?: unknown; readonly fileName?: unknown; readonly title?: unknown } | null,
): string {
  if (recipe === null || typeof recipe !== 'object') return '';
  for (const key of ['filePath', 'id', 'fileName', 'title'] as const) {
    const value = recipe[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/**
 * A verified save authorization handed to the persistence owner.
 *
 * It is produced ONLY by the application entry surface (the trusted UI layer):
 * the model has no path to construct one. `authorized` is a literal `true` so a
 * structurally forged `{ authorized: false }` can never type-check as a grant.
 */
export interface ShisoSaveGrant {
  readonly authorized: true;
  /** 'ui' = a genuine Save control; 'assistant' = a natural-language command. */
  readonly via: 'ui' | 'assistant';
  /** Bound at issuance; the recipe being saved must match for 'assistant'. */
  readonly recipe_identity: string;
  /** The user turn that issued the authorization (0 for a UI action). */
  readonly turn: number;
}

export type ShisoSaveGrantRejection = 'not_authorized' | 'stale_recipe';

/**
 * INDEPENDENT re-verification at the persistence owner. A grant that is absent,
 * not authorized, or bound to a DIFFERENT recipe than the one being saved is
 * refused before any write. The UI path is its own authorization, so its
 * identity binding is not required.
 */
export function verifySaveGrant(
  grant: unknown,
  currentRecipeIdentity: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: ShisoSaveGrantRejection } {
  if (grant === null || typeof grant !== 'object') return { ok: false, reason: 'not_authorized' };
  const record = grant as Record<string, unknown>;
  if (record['authorized'] !== true) return { ok: false, reason: 'not_authorized' };
  const via = record['via'];
  if (via !== 'ui' && via !== 'assistant') return { ok: false, reason: 'not_authorized' };
  if (via === 'ui') return { ok: true };
  const boundIdentity = record['recipe_identity'];
  if (typeof boundIdentity !== 'string' || boundIdentity.length === 0) {
    return { ok: false, reason: 'not_authorized' };
  }
  if (boundIdentity !== currentRecipeIdentity) return { ok: false, reason: 'stale_recipe' };
  return { ok: true };
}

/**
 * The single-slot, per-turn authorization authority.
 *
 * ONE slot per conversation surface. Every user turn REPLACES the slot — a new
 * message that does not ask to save therefore invalidates the previous turn's
 * authorization, which is what makes stale replay impossible. The slot is
 * consumed on a SUCCESSFUL save; a failed or empty save does not burn the
 * user's authorization within the same turn.
 */
export interface ShisoSaveAuthorizationSlot {
  readonly recipe_identity: string;
  readonly turn: number;
  readonly used: boolean;
}

export interface ShisoSaveAuthorizationState {
  readonly slot: ShisoSaveAuthorizationSlot | null;
  /** True while a save call is executing, so a concurrent duplicate is refused. */
  readonly inFlight: boolean;
}

export const INITIAL_SAVE_AUTHORIZATION_STATE: ShisoSaveAuthorizationState = Object.freeze({
  slot: null,
  inFlight: false,
});

export type ShisoSaveAuthorizationDecision =
  | { readonly ok: true; readonly grant: ShisoSaveGrant; readonly state: ShisoSaveAuthorizationState }
  | { readonly ok: false; readonly reason: 'not_authorized' | 'in_flight'; readonly state: ShisoSaveAuthorizationState };

/** Issues (or replaces) the authorization for the CURRENT user turn. */
export function issueSaveAuthorization(input: {
  readonly state: ShisoSaveAuthorizationState;
  readonly authorized: boolean;
  readonly recipe_identity: string;
  readonly turn: number;
}): ShisoSaveAuthorizationState {
  if (!input.authorized) {
    // A turn that did not ask to save clears any previous authorization.
    return { slot: null, inFlight: input.state.inFlight };
  }
  return {
    slot: { recipe_identity: input.recipe_identity, turn: input.turn, used: false },
    inFlight: input.state.inFlight,
  };
}

/** Clears the slot (recipe switch, close, or explicit invalidation). */
export function clearSaveAuthorization(state: ShisoSaveAuthorizationState): ShisoSaveAuthorizationState {
  return { slot: null, inFlight: state.inFlight };
}

/**
 * Decides whether an ASSISTANT-initiated save may proceed right now.
 *
 * `consumed` is called with the state to apply after a SUCCESSFUL save; the
 * caller performs the actual save between `beginSaveAuthorization` and
 * `completeSaveAuthorization`.
 */
export function beginSaveAuthorization(
  state: ShisoSaveAuthorizationState,
): ShisoSaveAuthorizationDecision {
  if (state.inFlight) return { ok: false, reason: 'in_flight', state };
  const slot = state.slot;
  if (slot === null || slot.used) return { ok: false, reason: 'not_authorized', state };
  return {
    ok: true,
    grant: {
      authorized: true,
      via: 'assistant',
      recipe_identity: slot.recipe_identity,
      turn: slot.turn,
    },
    state: { ...state, inFlight: true },
  };
}

/** Marks a save attempt finished. A SUCCESSFUL save consumes the slot. */
export function completeSaveAuthorization(
  state: ShisoSaveAuthorizationState,
  saved: boolean,
): ShisoSaveAuthorizationState {
  const slot = state.slot;
  return {
    slot: saved && slot !== null ? { ...slot, used: true } : slot,
    inFlight: false,
  };
}
