/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-1.
 * Whole-Recipe AI Semantic Interpretation REQUEST contract.
 *
 * WHY THIS MODULE EXISTS (D1, RESOLVED)
 *   AI-1's historical request was a FLAT ARRAY of ingredient rows, and
 *   `AI_ADVANCED_CONTRACT_VERSION` named both the request and the response
 *   semantics. Phase 9B changes the REQUEST shape substantially — authored
 *   recipe source plus instructions plus server-derived whole-recipe context —
 *   while the RESPONSE semantics are unchanged and remain
 *   `nutrition_ai_advanced_interpretation_v1`.
 *
 *   Request versioning is therefore SPLIT from response contract versioning.
 *   The RESPONSE contract is NOT bumped, because its meaning did not change.
 *   The REQUEST gets its own explicit identity below. Neither wire was
 *   silently redefined.
 *
 * WHY THIS IS NOT A SECOND FOOD-SEMANTIC AUTHORITY
 *   This module describes what the model may be ASKED. It grants nothing.
 *   - It defines no food semantics.
 *   - It carries no FDC id, no candidate, no grams, no nutrient value.
 *   - The deterministic USDA matcher remains the sole food-identity authority.
 *   - It does not reinterpret AI-4's inert recipe-context contract, and it does
 *     NOT reuse AI-4's request wire or origin receipt. The derivation
 *     MACHINERY (adaptRecipe -> extractRecipeContext) is reused; the AI-4
 *     materialization is deliberately not.
 *
 * TRUST POSTURE (D2, RESOLVED)
 *   The client submits the CURRENT AUTHORED RECIPE SOURCE DATA for an explicit,
 *   user-initiated AI resolve action. That source is NOT trusted and is NOT
 *   semantic authority: it is request input that the server re-validates,
 *   re-derives from scratch, and re-binds. The client cannot supply food
 *   identity, food semantics, a context binding, a context envelope, target
 *   source text, an FDC id, a USDA candidate, grams, nutrient values, authority
 *   flags, origin verification, or persistence state. Those names are refused.
 *
 * PRIVACY (D3, RESOLVED)
 *   Recipe title and base servings are WITHHELD in this slice. They are not
 *   required for the semantic problem being solved, and provider-visible data
 *   must not be broadened without demonstrated need.
 *
 * PURE, OFFLINE, PROVIDER-FREE. No network, no clock, no randomness, no
 * persistence, no UI, no state mutation.
 */

import { canonicalStringify, sha256Hex } from './usda/digest';
import {
  AI_RESOLUTION_ISSUE_KINDS,
  type AiResolutionIssueKind,
} from './aiResolution';

// ---------------------------------------------------------------------------
// Request-wire identity (D1)
// ---------------------------------------------------------------------------

/**
 * The DISTINCT whole-recipe semantic REQUEST-wire version.
 *
 * This is intentionally NOT `AI_ADVANCED_CONTRACT_VERSION`. The response
 * contract keeps its own identity and meaning; this names the new request shape.
 */
export const WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION =
  'nutrition_ai_whole_recipe_interpretation_request_v1' as const;

/**
 * Local provenance label for server-derived context. A label only — it is not
 * authority, not a digest, and not a model output.
 */
export const WHOLE_RECIPE_CONTEXT_PROVENANCE_CLASS = 'ai_whole_recipe_interpretation_context' as const;

// ---------------------------------------------------------------------------
// Bounds (closed, mirroring the sibling AI-1 / AI-4 contracts)
// ---------------------------------------------------------------------------

export const MAX_WHOLE_RECIPE_SOURCE_INGREDIENTS = 60;
export const MAX_WHOLE_RECIPE_INSTRUCTIONS = 40;
export const MAX_WHOLE_RECIPE_INGREDIENT_NAME = 300;
export const MAX_WHOLE_RECIPE_INSTRUCTION_TEXT = 300;
export const MAX_WHOLE_RECIPE_TARGETS = 25;
export const MAX_WHOLE_RECIPE_REQUEST_ID_LENGTH = 120;
export const MAX_WHOLE_RECIPE_TARGET_REF_LENGTH = 200;
export const MAX_WHOLE_RECIPE_CONTEXT_BYTES = 32 * 1024;
export const MAX_WHOLE_RECIPE_UNIT_LENGTH = 60;
export const MAX_WHOLE_RECIPE_QUANTITY = 1_000_000;
/** Bounded deep-read limits for untrusted request input. */
const MAX_INERT_DEPTH = 6;
const MAX_INERT_NODES = 512;

// ---------------------------------------------------------------------------
// Request types (what the client may send — untrusted source data only)
// ---------------------------------------------------------------------------

/**
 * One authored ingredient line, exactly as the user authored it.
 *
 * The client sends SOURCE TEXT ONLY. It is deliberately NOT allowed to attach
 * a resolved food identity, a quantity the server did not read, or any
 * semantic field. This is the single source of truth for the ingredient text;
 * there is no parallel "client says X / recipe says Y" pair to reconcile.
 */
export interface WholeRecipeAuthoredIngredientSource {
  readonly name: string;
  readonly amount?: number;
  readonly unit?: string;
}

/** The authored recipe SOURCE the server is asked to interpret. */
export interface WholeRecipeAuthoredRecipeSource {
  readonly ingredients: ReadonlyArray<WholeRecipeAuthoredIngredientSource>;
}

/** One authored instruction step, verbatim and bounded. */
export interface WholeRecipeAuthoredInstruction {
  readonly text: string;
}

/**
 * An actionable target. The client may say WHICH rows are being resolved, using
 * an OPAQUE line ref only.
 *
 * The client never sends the row's text: the server re-derives it. A target
 * therefore cannot smuggle a replacement ingredient behind an existing ref.
 */
export interface WholeRecipeInterpretationTargetRef {
  readonly line_ref: string;
  /** Existing application-owned closed vocabulary. Never free-form. */
  readonly issue_kind?: AiResolutionIssueKind;
}

/** The whole-recipe semantic interpretation REQUEST envelope. */
export interface WholeRecipeInterpretationRequest {
  readonly request_version: typeof WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION;
  readonly request_id?: string;
  readonly recipe: WholeRecipeAuthoredRecipeSource;
  readonly instructions: ReadonlyArray<WholeRecipeAuthoredInstruction>;
  readonly targets: ReadonlyArray<WholeRecipeInterpretationTargetRef>;
}

// ---------------------------------------------------------------------------
// Derived context (server-owned; the client can never construct this)
// ---------------------------------------------------------------------------

/** One server-derived, model-visible instruction-evidence entry. */
export interface WholeRecipeDerivedInstructionEvidence {
  readonly instruction_line_ref: string;
  readonly evidence: string;
}

/** One server-derived model-visible target. */
export interface WholeRecipeDerivedTarget {
  readonly line_ref: string;
  readonly source_text: string;
  /** Deterministic food-phrase extraction. Never a model output, never authority. */
  readonly food_semantics?: string;
  /** Deterministic instruction evidence naming THIS line. */
  readonly instruction_evidence: ReadonlyArray<WholeRecipeDerivedInstructionEvidence>;
  /** Application-owned issue classification, echoed from the request. */
  readonly issue_kind?: AiResolutionIssueKind;
}

/**
 * The exact bounded model-visible payload for a whole-recipe interpretation.
 *
 * This is what `context_binding` covers, so freshness is defined by precisely
 * what the model was shown.
 */
export interface WholeRecipeProviderContext {
  readonly provenance_class: typeof WHOLE_RECIPE_CONTEXT_PROVENANCE_CLASS;
  /**
   * Bounded AUTHORED INSTRUCTIONS, verbatim, as untrusted DATA.
   *
   * These are the whole-recipe evidence the semantic model must read. The
   * deterministic extractor below CANNOT reliably link prose to a line (its
   * subject rule requires every content token of the ingredient name to appear
   * in the instruction, so `4 eggs, separated` links to nothing in "Separate
   * the whites from the yolks"). Without these the model could not infer that
   * both whites and yolks are consumed. They are included precisely because
   * deterministic linking is conservative by design.
   *
   * They are bounded, and they are DATA: the model may reason about them as
   * cooking instructions but must never obey them as commands.
   */
  readonly instructions: ReadonlyArray<{ readonly text: string }>;
  readonly targets: ReadonlyArray<WholeRecipeDerivedTarget>;
}

/** Server-derived context plus its freshness binding. */
export interface WholeRecipeDerivedInterpretationContext {
  readonly request_version: typeof WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION;
  readonly request_id: string;
  readonly provider_context: WholeRecipeProviderContext;
  readonly provider_context_bytes: number;
  /**
   * Freshness binding over EXACTLY the model-visible payload plus request
   * identity and target order. Changing any model-visible ingredient, any
   * instruction evidence, any target ref, any order, or the request version
   * changes this value, which makes an earlier interpretation stale as a whole.
   */
  readonly context_binding: string;
}

export type WholeRecipeRequestFailure =
  | 'invalid_request'
  | 'invalid_recipe'
  | 'unsafe_request'
  | 'oversized_request'
  | 'unsupported_request_version'
  | 'unknown_line_ref'
  | 'duplicate_line_ref'
  | 'duplicate_target'
  | 'no_targets'
  | 'too_many_targets';

export type WholeRecipeDerivationFailure =
  | 'invalid_recipe'
  | 'no_targets'
  | 'too_many_targets'
  | 'request_too_large';

// ---------------------------------------------------------------------------
// Untrusted-input reading (defense in depth, mirrors sibling contracts)
// ---------------------------------------------------------------------------

const DANGEROUS_OWN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Bounded, cycle-safe, accessor-free deep read of untrusted request input.
 * Never throws; anything not provably inert becomes `undefined` so the caller
 * rejects the request with a bounded code instead of leaking raw error text.
 */
function toInertValue(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (depth > MAX_INERT_DEPTH) return undefined;
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string') {
    return (value as string).length <= 4096 ? value : undefined;
  }
  if (kind === 'number') return Number.isFinite(value) ? value : undefined;
  if (kind === 'boolean') return value;
  if (kind !== 'object') return undefined; // undefined, bigint, symbol, function
  const object = value as object;
  if (seen.has(object)) return undefined; // cycle / shared alias
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const out: unknown[] = [];
      for (const entry of object) {
        if (out.length >= MAX_INERT_NODES) return undefined;
        out.push(toInertValue(entry, depth + 1, seen) ?? null);
      }
      return out;
    }
    if (!isPlainObject(object)) return undefined;
    if (Object.getOwnPropertySymbols(object).length > 0) return undefined;
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(object)) {
      if (DANGEROUS_OWN_KEYS.has(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) return undefined; // accessor
      if (++count > MAX_INERT_NODES) return undefined;
      out[key] = toInertValue(descriptor.value, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

function isIssueKind(value: unknown): value is AiResolutionIssueKind {
  return (
    typeof value === 'string' &&
    (AI_RESOLUTION_ISSUE_KINDS as ReadonlyArray<string>).includes(value)
  );
}

function readBoundedString(
  value: unknown,
  max: number
): { ok: true; value: string } | { ok: false } {
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return { ok: false };
  return { ok: true, value: trimmed };
}

const REQUEST_KEYS = new Set(['request_version', 'request_id', 'recipe', 'instructions', 'targets']);
const RECIPE_SOURCE_KEYS = new Set(['ingredients']);
const INGREDIENT_SOURCE_KEYS = new Set(['name', 'amount', 'unit']);
const INSTRUCTION_KEYS = new Set(['text']);
const TARGET_KEYS = new Set(['line_ref', 'issue_kind']);

/**
 * Trust-boundary REFUSALS. These names must never be accepted on this wire:
 * they are semantic or authoritative fields, not authored source data.
 */
const REFUSED_AUTHORITATIVE_KEYS: ReadonlySet<string> = new Set([
  'title',
  'base_servings',
  'servings',
  'recipe_key',
  'file_path',
  'filePath',
  'file_name',
  'raw_markdown',
  'rawMarkdown',
  'frontmatter',
  'food_semantics',
  'foodSemantics',
  'food_identity',
  'foodIdentity',
  'semantic_food',
  'normalized_name',
  'search_phrases',
  'context_binding',
  'context',
  'envelope',
  'provenance_class',
  'fdc_id',
  'fdcId',
  'candidate',
  'candidates',
  'grams',
  'mass',
  'nutrients',
  'calories',
  'authority',
  'origin_verified',
  'origin_receipt',
  'persist',
  'nutrition_block',
  'instructions_evidence',
]);

/** Recursively refuses refused keys anywhere in the request. */
function containsRefusedKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_INERT_DEPTH) return true; // too deep to prove clean -> refuse
  if (Array.isArray(value)) return value.some((entry) => containsRefusedKey(entry, depth + 1));
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (REFUSED_AUTHORITATIVE_KEYS.has(key)) return true;
    if (containsRefusedKey(value[key], depth + 1)) return true;
  }
  return false;
}

/**
 * Sanitizes the whole-recipe interpretation request.
 *
 * CLOSED key sets at every level: an unknown key rejects the WHOLE request.
 * Never throws; always returns a bounded failure code.
 */
export function sanitizeWholeRecipeInterpretationRequest(
  raw: unknown
): { readonly ok: true; readonly request: WholeRecipeInterpretationRequest } | { readonly ok: false; readonly code: WholeRecipeRequestFailure } {
  const inert = toInertValue(raw);
  if (inert === undefined) return { ok: false, code: 'unsafe_request' };
  if (!isPlainObject(inert)) return { ok: false, code: 'invalid_request' };
  if (containsRefusedKey(inert)) return { ok: false, code: 'unsafe_request' };

  for (const key of Object.keys(inert)) {
    if (!REQUEST_KEYS.has(key)) return { ok: false, code: 'invalid_request' };
  }
  if (inert.request_version !== WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION) {
    return { ok: false, code: 'unsupported_request_version' };
  }

  let requestId: string | undefined;
  if (inert.request_id !== undefined) {
    const parsed = readBoundedString(inert.request_id, MAX_WHOLE_RECIPE_REQUEST_ID_LENGTH);
    if (!parsed.ok) return { ok: false, code: 'invalid_request' };
    requestId = parsed.value;
  }

  // --- authored recipe source -------------------------------------------------
  if (!isPlainObject(inert.recipe)) return { ok: false, code: 'invalid_recipe' };
  const recipeRaw = inert.recipe;
  for (const key of Object.keys(recipeRaw)) {
    if (!RECIPE_SOURCE_KEYS.has(key)) return { ok: false, code: 'invalid_request' };
  }
  const ingredientsRaw = recipeRaw.ingredients;
  if (!Array.isArray(ingredientsRaw)) return { ok: false, code: 'invalid_recipe' };
  if (ingredientsRaw.length === 0) return { ok: false, code: 'invalid_recipe' };
  if (ingredientsRaw.length > MAX_WHOLE_RECIPE_SOURCE_INGREDIENTS) {
    return { ok: false, code: 'oversized_request' };
  }
  const ingredients: WholeRecipeAuthoredIngredientSource[] = [];
  for (const entry of ingredientsRaw) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_recipe' };
    for (const key of Object.keys(entry)) {
      if (!INGREDIENT_SOURCE_KEYS.has(key)) return { ok: false, code: 'invalid_request' };
    }
    const name = readBoundedString(entry.name, MAX_WHOLE_RECIPE_INGREDIENT_NAME);
    if (!name.ok) return { ok: false, code: 'invalid_recipe' };
    let amount: number | undefined;
    if (entry.amount !== undefined && entry.amount !== null) {
      if (
        typeof entry.amount !== 'number' ||
        !Number.isFinite(entry.amount) ||
        entry.amount <= 0 ||
        entry.amount > MAX_WHOLE_RECIPE_QUANTITY
      ) {
        return { ok: false, code: 'invalid_recipe' };
      }
      amount = entry.amount;
    }
    let unit: string | undefined;
    if (entry.unit !== undefined && entry.unit !== null) {
      const parsed = readBoundedString(entry.unit, MAX_WHOLE_RECIPE_UNIT_LENGTH);
      if (!parsed.ok) return { ok: false, code: 'invalid_recipe' };
      unit = parsed.value;
    }
    ingredients.push(Object.freeze({ name: name.value, ...(amount !== undefined ? { amount } : {}), ...(unit !== undefined ? { unit } : {}) }));
  }

  // --- authored instructions --------------------------------------------------
  if (!Array.isArray(inert.instructions)) return { ok: false, code: 'invalid_request' };
  if (inert.instructions.length > MAX_WHOLE_RECIPE_INSTRUCTIONS) {
    return { ok: false, code: 'oversized_request' };
  }
  const instructions: WholeRecipeAuthoredInstruction[] = [];
  for (const entry of inert.instructions) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_request' };
    for (const key of Object.keys(entry)) {
      if (!INSTRUCTION_KEYS.has(key)) return { ok: false, code: 'invalid_request' };
    }
    const text = readBoundedString(entry.text, MAX_WHOLE_RECIPE_INSTRUCTION_TEXT);
    if (!text.ok) return { ok: false, code: 'invalid_request' };
    instructions.push(Object.freeze({ text: text.value }));
  }

  // --- actionable targets -----------------------------------------------------
  if (!Array.isArray(inert.targets)) return { ok: false, code: 'invalid_request' };
  if (inert.targets.length === 0) return { ok: false, code: 'no_targets' };
  if (inert.targets.length > MAX_WHOLE_RECIPE_TARGETS) return { ok: false, code: 'too_many_targets' };
  const targets: WholeRecipeInterpretationTargetRef[] = [];
  const seenTargets = new Set<string>();
  for (const entry of inert.targets) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_request' };
    for (const key of Object.keys(entry)) {
      if (!TARGET_KEYS.has(key)) return { ok: false, code: 'invalid_request' };
    }
    const lineRef = readBoundedString(entry.line_ref, MAX_WHOLE_RECIPE_TARGET_REF_LENGTH);
    if (!lineRef.ok) return { ok: false, code: 'invalid_request' };
    if (seenTargets.has(lineRef.value)) return { ok: false, code: 'duplicate_target' };
    seenTargets.add(lineRef.value);
    let issueKind: AiResolutionIssueKind | undefined;
    if (entry.issue_kind !== undefined && entry.issue_kind !== null) {
      if (!isIssueKind(entry.issue_kind)) return { ok: false, code: 'invalid_request' };
      issueKind = entry.issue_kind;
    }
    targets.push(Object.freeze({ line_ref: lineRef.value, ...(issueKind !== undefined ? { issue_kind: issueKind } : {}) }));
  }

  return {
    ok: true,
    request: Object.freeze({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
      recipe: Object.freeze({ ingredients: Object.freeze(ingredients) }),
      instructions: Object.freeze(instructions),
      targets: Object.freeze(targets),
    }),
  };
}

// ---------------------------------------------------------------------------
// Server-derived context + freshness binding
// ---------------------------------------------------------------------------

/**
 * The exact payload the binding covers. Deliberately includes request identity
 * and target order alongside the model-visible content, so ANY change to what
 * the model was shown — or to what was asked — invalidates the interpretation.
 */
function wholeRecipeBindingPayload(
  requestId: string,
  request: WholeRecipeInterpretationRequest,
  providerContext: WholeRecipeProviderContext
): unknown {
  return {
    binding: 'nutrition_ai_whole_recipe_interpretation_binding_v1',
    request_version: request.request_version,
    request_id: requestId,
    target_order: request.targets.map((target) => target.line_ref),
    provider_context: providerContext,
  };
}

/**
 * Builds the bounded model-visible provider context from ALREADY
 * server-derived material, then binds it.
 *
 * Inputs are server-derived rows and deterministic instruction evidence. The
 * caller cannot influence the binding except through the authored source, which
 * is exactly the freshness relationship we want.
 */
export function buildWholeRecipeDerivedContext(input: {
  readonly request: WholeRecipeInterpretationRequest;
  readonly requestId: string;
  readonly derivedRows: ReadonlyArray<{
    readonly line_ref: string;
    readonly source_text: string;
    readonly food_semantics?: string;
    readonly instruction_evidence: ReadonlyArray<WholeRecipeDerivedInstructionEvidence>;
    readonly issue_kind?: AiResolutionIssueKind;
  }>;
  /** Bounded authored instruction text to expose as model-visible data. */
  readonly instructions: ReadonlyArray<{ readonly text: string }>;
}): { readonly ok: true; readonly context: WholeRecipeDerivedInterpretationContext } | { readonly ok: false; readonly code: WholeRecipeDerivationFailure } {
  const providerContext: WholeRecipeProviderContext = Object.freeze({
    provenance_class: WHOLE_RECIPE_CONTEXT_PROVENANCE_CLASS,
    instructions: Object.freeze(input.instructions.map((instruction) => Object.freeze({ text: instruction.text }))),
    targets: Object.freeze(
      input.derivedRows.map((row) =>
        Object.freeze({
          line_ref: row.line_ref,
          source_text: row.source_text,
          ...(row.food_semantics !== undefined ? { food_semantics: row.food_semantics } : {}),
          instruction_evidence: Object.freeze(
            row.instruction_evidence.map((evidence) => Object.freeze({ ...evidence })),
          ),
          ...(row.issue_kind !== undefined ? { issue_kind: row.issue_kind } : {}),
        })
      ),
    ),
  });

  const providerContextBytes = canonicalStringify(providerContext).length;
  if (providerContextBytes > MAX_WHOLE_RECIPE_CONTEXT_BYTES) {
    return { ok: false, code: 'request_too_large' };
  }

  const context_binding = `sha256:${sha256Hex(
    canonicalStringify(wholeRecipeBindingPayload(input.requestId, input.request, providerContext))
  )}`;

  return {
    ok: true,
    context: Object.freeze({
      request_version: input.request.request_version,
      request_id: input.requestId,
      provider_context: providerContext,
      provider_context_bytes: providerContextBytes,
      context_binding,
    }),
  };
}