/**
 * The Kitchen Codex — AI Advanced Nutrition: whole-recipe context contract
 * (AI-4A, PHASE 1 — contract only).
 *
 * AI-4 is WHOLE-RECIPE INTELLIGENCE AS AN INPUT-SHAPING LAYER. This module owns
 * the SHAPE an AI recipe-context interpretation must take. It is NOT a mass
 * estimator, NOT an identity authority, NOT a nutrient authority, NOT a
 * persistence authority, and NOT a new rung on the effective-mass ladder.
 *
 * PURE, OFFLINE, INERT. AI-4A has ZERO provider calls, ZERO fetch, ZERO route,
 * ZERO limiter, ZERO UI, ZERO reducer/state mutation, ZERO persistence and ZERO
 * calculator behavior. This module is not reachable from the live Advanced
 * Nutrition workflow.
 *
 * PERMANENT RULE
 *  AI interprets. Deterministic code validates. Existing deterministic nutrition
 *  systems own authority. The user explicitly accepts interpretations before they
 *  may affect downstream AI behavior.
 *
 * ARCHITECT RULINGS HONORED HERE
 *  R1. `AdaptedRecipe` stays NARROW. `RecipeContextEnvelope` (below) is a
 *      SEPARATE, explicit, local-only structure — the sole future AI-4
 *      recipe-context channel. AI-4A defines it; AI-4B populates it.
 *  R2. RAW MODEL OUTPUT HAS ZERO SUPPRESSION AUTHORITY. Nothing in this contract
 *      can suppress, gate, or alter an AI-3 request. A future suppression path
 *      requires a user-accepted, SESSION-ONLY accepted interpretation.
 *  R3. NO `consumption_fraction` (or `consumed_fraction` / `yield_factor`) in the
 *      v1 executable contract. A fraction that can influence consumed mass is
 *      effectively a new mass authority. These keys are EXPLICITLY REJECTED as
 *      forbidden authority fields.
 *  R4. AI-3 undo UI, reducer behavior, estimate rendering, calculation and Apply
 *      gate are UNTOUCHED by AI-4A.
 *
 * NO NUMERIC AUTHORITY
 *  The contract carries bounded NON-NUTRITIONAL structural integers only
 *  (`base_servings`, array counts, target indexes). It has NO grams, NO fraction,
 *  NO nutrient quantity, NO serving weight and NO FDC numeric authority. There is
 *  deliberately no field capable of expressing a mass.
 */

import { isPlainObject, toInertValue } from '../schema';
import { AI_ADVANCED_FORBIDDEN_AUTHORITY_KEYS } from '../aiAdvanced';

// ---------------------------------------------------------------------------
// Contract identity
// ---------------------------------------------------------------------------

/** Closed contract-version token. Exact match is required; nothing is inferred. */
export const AI_RECIPE_CONTEXT_CONTRACT_VERSION = 'nutrition_ai_recipe_context_v1' as const;

/**
 * The AI-4 provenance class.
 *
 * It is DELIBERATELY NOT an authenticated provenance class. The only two
 * authenticated classes are `usda_derived` and `vetted_standard`
 * (`isAuthenticatedProvenanceClass` in `aiAdvancedEstimate.ts`). AI-4 context is
 * model interpretation only and can never claim either one — see
 * `AUTHENTICATED_PROVENANCE_CLAIMS` and `sanitizeAiRecipeContextProposal`.
 */
export const AI_RECIPE_CONTEXT_PROVENANCE_CLASS = 'ai_recipe_context' as const;

export const AI_RECIPE_CONTEXT_DISPLAY_LABEL =
  'AI recipe context (interpretation only, not USDA-authenticated)';

/** AI-4A availability of the CONTRACT itself (not of any future capability). */
export const AI_RECIPE_CONTEXT_CONTRACT_AVAILABILITY = 'declared' as const;

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/**
 * The ingredient's role in THIS recipe.
 *
 * `garnish` and `serving_component` are deliberately DISTINCT: `garnish` is a
 * decorative/finishing role, `serving_component` is an accompaniment served
 * alongside. Overloading one to cover every "for serving" case would make the
 * role less truthful, so they are separate.
 */
export const AI_RECIPE_CONTEXT_ROLES = Object.freeze([
  'main',
  'garnish',
  'cooking_medium',
  'serving_component',
  'reserved',
  'divided',
  'optional',
  'unknown',
] as const);
export type AiRecipeContextRole = (typeof AI_RECIPE_CONTEXT_ROLES)[number];

/**
 * Closed relation vocabulary. Every relation binds THIS interpretation's line to
 * one or more opaque target `line_ref`s that must exist in the allowed set.
 *
 *  divided_into  — this line is divided across the targets
 *  reserved_from — the targets are reserved portions taken from this line
 *  duplicate_of  — this line duplicates the target
 *  same_as       — this line names the same ingredient as the target
 */
export const AI_RECIPE_CONTEXT_RELATIONS = Object.freeze([
  'divided_into',
  'reserved_from',
  'duplicate_of',
  'same_as',
] as const);
export type AiRecipeContextRelationKind = (typeof AI_RECIPE_CONTEXT_RELATIONS)[number];

/**
 * Relations whose SEMANTICS require at most one parent per target line. A target
 * that is divided from two parents, or reserved from two parents, would imply a
 * double allocation and is refused rather than silently resolved.
 */
export const AI_RECIPE_CONTEXT_SINGLE_PARENT_RELATIONS: ReadonlySet<string> = new Set([
  'divided_into',
  'reserved_from',
]);

/** Closed abstention vocabulary. Abstaining is always correct when unsure. */
export const AI_RECIPE_CONTEXT_ABSTAIN_REASONS = Object.freeze([
  'no_recipe_context',
  'insufficient_evidence',
  'contradictory_context',
  'ambiguous_role',
  'already_deterministic',
  'untrusted_context',
] as const);
export type AiRecipeContextAbstainReason =
  (typeof AI_RECIPE_CONTEXT_ABSTAIN_REASONS)[number];

/** Advisory only. A confidence value NEVER grants authority. */
export const AI_RECIPE_CONTEXT_CONFIDENCE_VALUES = Object.freeze([
  'high',
  'medium',
  'low',
] as const);
export type AiRecipeContextConfidence =
  (typeof AI_RECIPE_CONTEXT_CONFIDENCE_VALUES)[number];

/**
 * CLOSED preparation/state hint vocabulary. No open-ended preparation string may
 * carry authority, so every hint must be one of these exact tokens.
 *
 * `bone_in`, `skin_on` and `skinless` are present because the deterministic
 * matcher has NO rule for them today, which is why whole-recipe reading is
 * useful here. They are ADVISORY FLAGS ONLY: they never change identity and never
 * change a mass.
 */
export const AI_RECIPE_CONTEXT_PREPARATION_HINTS = Object.freeze([
  'raw',
  'cooked',
  'canned',
  'fresh',
  'frozen',
  'dried',
  'drained',
  'undrained',
  'peeled',
  'packed',
  'bone_in',
  'boneless',
  'skin_on',
  'skinless',
  'divided',
  'reserved',
  'optional',
  'garnish',
] as const);
export type AiRecipeContextPreparationHint =
  (typeof AI_RECIPE_CONTEXT_PREPARATION_HINTS)[number];

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Target cap. Deliberately matches AI-3's transport line budget so a future
 * AI-4 request can never widen the established transport envelope. OWNED HERE
 * (not imported from the AI-3 wire) so AI-4A has no dependency on AI-3 modules.
 */
export const MAX_RECIPE_CONTEXT_TARGETS = 12;
export const MAX_RECIPE_CONTEXT_LINE_REF_LENGTH = 200;
export const MAX_RECIPE_CONTEXT_TITLE_LENGTH = 120;
export const MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH = 240;
export const MAX_RECIPE_CONTEXT_FOOD_SEMANTICS_LENGTH = 120;
export const MAX_RECIPE_CONTEXT_SLOT_LENGTH = 64;
export const MAX_RECIPE_CONTEXT_SLOTS = 4;
export const MAX_RECIPE_CONTEXT_RELATIONS = 4;
export const MAX_RECIPE_CONTEXT_RELATION_TARGETS = 4;
export const MAX_RECIPE_CONTEXT_PREPARATION_HINTS = 8;
export const MAX_RECIPE_CONTEXT_PREPARATION_HINT_LENGTH = 60;
export const MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH = 300;
/** Bounded graph walk depth, so a hostile graph cannot exhaust the stack. */
export const MAX_RECIPE_CONTEXT_RELATION_DEPTH = 8;
/** `base_servings` is a NON-NUTRITIONAL structural scalar, mirroring Phase 3. */
export const MAX_RECIPE_CONTEXT_SERVINGS = 1000;
export const MAX_RECIPE_CONTEXT_SERVING_DECIMAL_PLACES = 6;

// ---------------------------------------------------------------------------
// Forbidden authority keys
// ---------------------------------------------------------------------------

/**
 * The authenticated provenance claims an AI-4 payload may never assert. Claiming
 * one is an authority forgery (`authority_field`), never a structural error.
 */
export const AUTHENTICATED_PROVENANCE_CLAIMS: ReadonlySet<string> = new Set([
  'usda_derived',
  'vetted_standard',
]);

/** Keys an AI-4 payload may NEVER carry, on top of the AI-3/AI-1 authority set. */
const AI_4_SPECIFIC_FORBIDDEN_KEYS: ReadonlyArray<string> = Object.freeze([
  // R3 — fractions and yield factors are a future mass authority. FORBIDDEN.
  'consumption_fraction',
  'consumed_fraction',
  'yield_factor',
  // Grams under any name (the AI-3 vocabulary does not cover these).
  'lower_grams',
  'upper_grams',
  'consumed_grams',
  'effective_grams',
  'net_grams',
  'yield_grams',
  'edible_grams',
  'serving_weight',
  'serve_size',
  // Yield / serving authority.
  'yield',
  'yield_unit',
  'recipe_yield',
  // Nutrient totals.
  'nutrition',
  'nutrient_totals',
  'nutrition_totals',
  'macro',
  'macros',
  // Portion / candidate identity.
  'portion_ref',
  'portion_id',
  'candidate_ref',
  'candidate_fdc_id',
  'matched_fdc_id',
  'authenticated_portion',
  'authenticated_provenance',
  'record_identity',
  'food_name',
  // Mass-source authority.
  'direct_mass',
  'user_mass',
  'source_portion',
  'count_portion',
  'household_portion',
  'ai_estimate',
  'effective_mass',
  'resolved_mass',
  'mass_authority',
  'conversion_basis',
  // Suppression / automatic-application authority (R2).
  'suppress',
  'suppression',
  'suppress_ai3',
  'auto_apply',
  'auto_accept',
  'silent',
  // Override authority.
  'override',
  'title_override',
  'ingredient_override',
  // Apply / persistence authority.
  'apply_authority',
  'persistence',
  'persist_payload',
  'write_target',
  'ai_estimate_selection',
  'estimate_selection',
  // Authenticated provenance claims.
  'usda_derived',
  'vetted_standard',
]);

/**
 * The AI-4 authority-deny vocabulary.
 *
 * Derived from the broad `AI_ADVANCED_FORBIDDEN_AUTHORITY_KEYS` (the ONE owner of
 * that set) and extended with the AI-4-specific authority keys.
 *
 * `provenance_class` is deliberately ABSENT: it is this contract's own REQUIRED
 * field. Its VALUE is pinned separately — anything other than
 * `AI_RECIPE_CONTEXT_PROVENANCE_CLASS` is refused as `authority_field`, which is
 * exactly how AI-3 refuses a forged stronger class.
 */
export const AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  ...[...AI_ADVANCED_FORBIDDEN_AUTHORITY_KEYS].filter((key) => key !== 'provenance_class'),
  ...AI_4_SPECIFIC_FORBIDDEN_KEYS,
]);

/** True when a key is authority-shaped and may never appear on an AI-4 payload. */
export function isAiRecipeContextAuthorityKey(key: string): boolean {
  return AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS.has(key);
}

/**
 * AI-4 provenance is never authenticated. This mirrors — and is asserted
 * against — `isAuthenticatedProvenanceClass` from `aiAdvancedEstimate.ts`, whose
 * ONLY authenticated values are `usda_derived` and `vetted_standard`.
 */
export function isAiRecipeContextProvenanceClass(
  value: unknown
): value is typeof AI_RECIPE_CONTEXT_PROVENANCE_CLASS {
  return value === AI_RECIPE_CONTEXT_PROVENANCE_CLASS;
}

// ---------------------------------------------------------------------------
// Local bounded helpers (private — one contract owner, no shared mutable state)
// ---------------------------------------------------------------------------

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function boundedToken(
  value: unknown,
  vocabulary: ReadonlyArray<string>
): string | undefined {
  const text = boundedString(value, MAX_RECIPE_CONTEXT_PREPARATION_HINT_LENGTH);
  if (text === undefined) return undefined;
  return (vocabulary as ReadonlyArray<string>).includes(text) ? text : undefined;
}

function boundedServings(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value) || Object.is(value, -0)) return undefined;
  if (value <= 0 || value > MAX_RECIPE_CONTEXT_SERVINGS) return undefined;
  const text = String(value);
  const dot = text.indexOf('.');
  if (dot !== -1 && text.length - dot - 1 > MAX_RECIPE_CONTEXT_SERVING_DECIMAL_PLACES) {
    return undefined;
  }
  return value;
}

function hasForbiddenAuthorityKey(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => hasForbiddenAuthorityKey(entry, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (isAiRecipeContextAuthorityKey(key)) return true;
    if (hasForbiddenAuthorityKey(value[key], depth + 1)) return true;
  }
  return false;
}

function freezeLines(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.freeze(lines.slice());
}

// ---------------------------------------------------------------------------
// RecipeContextEnvelope (R1) — LOCAL ONLY, not a network payload
// ---------------------------------------------------------------------------

/**
 * One bounded target line inside a `RecipeContextEnvelope`.
 *
 * This is the ONLY shape in which authored recipe text may later reach an AI-4
 * request. It carries an OPAQUE `line_ref` (never a name, an index that could be
 * confused with a stable identity, or a file path) plus bounded authored text.
 */
export interface RecipeContextTarget {
  readonly line_ref: string;
  readonly source_text: string;
  readonly food_semantics?: string;
  /**
   * Deterministic instruction-evidence SLOTS. AI-4B populates these from local
   * code; the AI NEVER chooses which instructions it may read. Each entry is a
   * bounded OPAQUE LOCAL token used for snapshot binding — it is not an
   * authority digest, not a catalog digest, and not a model output.
   */
  readonly instruction_slots?: ReadonlyArray<string>;
}

/**
 * The SEPARATE, explicit AI-4 recipe-context envelope.
 *
 * `AdaptedRecipe` (R1) deliberately stays narrow: reading recipe instructions,
 * notes or any other private field there would breach an established privacy and
 * authority boundary. This envelope is AI-4's own channel, built independently
 * and read locally only.
 *
 * EXPLICITLY EXCLUDED, and enforced by `sanitizeRecipeContextEnvelope`:
 * filePath, recipe_key, sessionIdentity, request_id, rawMarkdown, frontmatter,
 * dataview fields, wikilinks, notes, description, tags, category, source URL,
 * image data, FDC ids, record/catalog digests, bundle releases, nutrient tables,
 * portion grams, household records, user-entered masses, API keys, credentials
 * and provider metadata.
 *
 * Builders must reconstruct these fields EXPLICITLY. Spreading a source recipe
 * object into this shape is a contract violation and is refused.
 */
export interface RecipeContextEnvelope {
  readonly contract_version: typeof AI_RECIPE_CONTEXT_CONTRACT_VERSION;
  readonly provenance_class: typeof AI_RECIPE_CONTEXT_PROVENANCE_CLASS;
  readonly title?: string;
  readonly base_servings?: number;
  readonly targets: ReadonlyArray<RecipeContextTarget>;
}

export type RecipeContextEnvelopeFailure =
  | 'invalid_envelope'
  | 'unsafe_envelope'
  | 'oversized_envelope'
  | 'authority_field'
  | 'unsupported_contract_version'
  | 'no_targets'
  | 'too_many_targets'
  | 'invalid_line_ref'
  | 'duplicate_line_ref'
  | 'invalid_targets';

export type RecipeContextEnvelopeResult =
  | { readonly ok: true; readonly envelope: RecipeContextEnvelope }
  | { readonly ok: false; readonly code: RecipeContextEnvelopeFailure };

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'contract_version',
  'provenance_class',
  'title',
  'base_servings',
  'targets',
]);
const TARGET_KEYS: ReadonlySet<string> = new Set([
  'line_ref',
  'source_text',
  'food_semantics',
  'instruction_slots',
]);

function canonicalizeTarget(raw: unknown): RecipeContextTarget | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) {
    if (isAiRecipeContextAuthorityKey(key)) return undefined;
    if (!TARGET_KEYS.has(key)) return undefined;
  }
  const lineRef = boundedString(raw['line_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
  if (lineRef === undefined) return undefined;
  const sourceText = boundedString(raw['source_text'], MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH);
  if (sourceText === undefined) return undefined;

  const semantics = raw['food_semantics'];
  const foodSemantics =
    semantics === undefined || semantics === null
      ? undefined
      : boundedString(semantics, MAX_RECIPE_CONTEXT_FOOD_SEMANTICS_LENGTH);
  if (semantics !== undefined && semantics !== null && foodSemantics === undefined) {
    return undefined;
  }

  const slotsRaw = raw['instruction_slots'];
  let slots: ReadonlyArray<string> | undefined;
  if (slotsRaw !== undefined && slotsRaw !== null) {
    if (!Array.isArray(slotsRaw) || slotsRaw.length > MAX_RECIPE_CONTEXT_SLOTS) return undefined;
    const collected: string[] = [];
    for (const entry of slotsRaw) {
      const slot = boundedString(entry, MAX_RECIPE_CONTEXT_SLOT_LENGTH);
      if (slot === undefined) return undefined;
      collected.push(slot);
    }
    slots = freezeLines(collected);
  }

  return Object.freeze({
    line_ref: lineRef,
    source_text: sourceText,
    ...(foodSemantics === undefined ? {} : { food_semantics: foodSemantics }),
    ...(slots === undefined ? {} : { instruction_slots: slots }),
  });
}

/**
 * Structural sanitizer for the local `RecipeContextEnvelope`. Fail-closed.
 *
 * This is a LOCAL, OFFLINE sanitizer. It performs no network access, no recipe
 * wiring (AI-4B owns that), and no state mutation.
 */
export function sanitizeRecipeContextEnvelope(raw: unknown): RecipeContextEnvelopeResult {
  const inert = toInertValue(raw);
  if (!inert.ok) {
    const reason = (inert as { ok: false; reason: string }).reason;
    return { ok: false, code: reason === 'oversized' ? 'oversized_envelope' : 'unsafe_envelope' };
  }
  try {
    if (!isPlainObject(raw)) return { ok: false, code: 'invalid_envelope' };

    for (const key of Object.keys(raw)) {
      if (isAiRecipeContextAuthorityKey(key)) return { ok: false, code: 'authority_field' };
      if (!ENVELOPE_KEYS.has(key)) return { ok: false, code: 'invalid_envelope' };
    }
    if (raw['contract_version'] !== AI_RECIPE_CONTEXT_CONTRACT_VERSION) {
      return { ok: false, code: 'unsupported_contract_version' };
    }
    if (raw['provenance_class'] !== AI_RECIPE_CONTEXT_PROVENANCE_CLASS) {
      return { ok: false, code: 'authority_field' };
    }

    const titleRaw = raw['title'];
    let title: string | undefined;
    if (titleRaw !== undefined && titleRaw !== null) {
      title = boundedString(titleRaw, MAX_RECIPE_CONTEXT_TITLE_LENGTH);
      if (title === undefined) return { ok: false, code: 'invalid_envelope' };
    }

    const servingsRaw = raw['base_servings'];
    let baseServings: number | undefined;
    if (servingsRaw !== undefined && servingsRaw !== null) {
      baseServings = boundedServings(servingsRaw);
      if (baseServings === undefined) return { ok: false, code: 'invalid_envelope' };
    }

    const targetsRaw = raw['targets'];
    if (!Array.isArray(targetsRaw)) return { ok: false, code: 'invalid_targets' };
    if (targetsRaw.length === 0) return { ok: false, code: 'no_targets' };
    if (targetsRaw.length > MAX_RECIPE_CONTEXT_TARGETS) {
      return { ok: false, code: 'too_many_targets' };
    }

    const seen = new Set<string>();
    const targets: RecipeContextTarget[] = [];
    for (const entry of targetsRaw) {
      const target = canonicalizeTarget(entry);
      if (target === undefined) {
        return { ok: false, code: hasForbiddenAuthorityKey(entry) ? 'authority_field' : 'invalid_targets' };
      }
      if (seen.has(target.line_ref)) return { ok: false, code: 'duplicate_line_ref' };
      seen.add(target.line_ref);
      targets.push(target);
    }

    return {
      ok: true,
      envelope: Object.freeze({
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        ...(title === undefined ? {} : { title }),
        ...(baseServings === undefined ? {} : { base_servings: baseServings }),
        targets: Object.freeze(targets),
      }),
    };
  } catch {
    return { ok: false, code: 'unsafe_envelope' };
  }
}

// ---------------------------------------------------------------------------
// AI-4 V1 interpretation proposal (model output shape)
// ---------------------------------------------------------------------------

/** One bounded relation to one opaque target line. */
export interface AiRecipeContextRelation {
  readonly kind: AiRecipeContextRelationKind;
  readonly target_ref: string;
}

/**
 * ONE inert, non-authoritative interpretation of ONE line.
 *
 * It carries NO grams, NO fraction, NO nutrient value, NO FDC id, NO portion
 * evidence, NO persistence field and NO conversion basis. There is deliberately
 * no field capable of expressing a mass or a fraction.
 *
 * RAW OUTPUT HAS ZERO SUPPRESSION AUTHORITY (R2). Nothing here can gate, alter
 * or suppress an AI-3 request. A future suppression path requires a
 * USER-ACCEPTED, SESSION-ONLY interpretation — an explicit user action, never a
 * raw model output and never a silent preview change.
 */
export interface AiRecipeContextInterpretation {
  readonly line_ref: string;
  readonly role: AiRecipeContextRole;
  readonly relations: ReadonlyArray<AiRecipeContextRelation>;
  readonly preparation_hints: ReadonlyArray<AiRecipeContextPreparationHint>;
  readonly confidence?: AiRecipeContextConfidence;
  readonly abstain_reason?: AiRecipeContextAbstainReason;
  readonly explanation?: string;
}

export interface AiRecipeContextProposal {
  readonly contract_version: typeof AI_RECIPE_CONTEXT_CONTRACT_VERSION;
  readonly provenance_class: typeof AI_RECIPE_CONTEXT_PROVENANCE_CLASS;
  readonly interpretations: ReadonlyArray<AiRecipeContextInterpretation>;
}

export type AiRecipeContextFailure =
  | 'invalid_response'
  | 'unsafe_response'
  | 'oversized_response'
  | 'unsupported_contract_version'
  | 'authority_field'
  | 'unknown_line_ref'
  | 'duplicate_line_ref'
  | 'too_many_rows'
  | 'invalid_relations';

export interface AiRecipeContextSanitizeOptions {
  /** The OPAQUE line refs this request actually issued. Nothing else is legal. */
  readonly allowedLineRefs: ReadonlyArray<string>;
  readonly maxRows?: number;
}

export type AiRecipeContextSanitizeResult =
  | { readonly ok: true; readonly proposal: AiRecipeContextProposal }
  | { readonly ok: false; readonly code: AiRecipeContextFailure };

const PROPOSAL_KEYS: ReadonlySet<string> = new Set([
  'contract_version',
  'provenance_class',
  'interpretations',
]);
const INTERPRETATION_KEYS: ReadonlySet<string> = new Set([
  'line_ref',
  'role',
  'relations',
  'preparation_hints',
  'confidence',
  'abstain_reason',
  'explanation',
]);
const RELATION_KEYS: ReadonlySet<string> = new Set(['kind', 'target_ref']);

function canonicalizeRelation(raw: unknown): AiRecipeContextRelation | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) {
    if (isAiRecipeContextAuthorityKey(key)) return undefined;
    if (!RELATION_KEYS.has(key)) return undefined;
  }
  const kind = boundedToken(raw['kind'], AI_RECIPE_CONTEXT_RELATIONS as ReadonlyArray<string>);
  if (kind === undefined) return undefined;
  const targetRef = boundedString(raw['target_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
  if (targetRef === undefined) return undefined;
  return Object.freeze({
    kind: kind as AiRecipeContextRelationKind,
    target_ref: targetRef,
  });
}

/**
 * Canonical structural sanitizer for AI-4 model output. Fail-closed, whole-response.
 *
 * Mirrors the AI-1 / AI-2C / AI-3 sanitizer discipline exactly: an inert
 * pre-pass, a closed envelope key set, a pinned contract version, a pinned
 * provenance class, opaque line-ref binding, and closed vocabularies throughout.
 *
 * A structural failure refuses the WHOLE response — never a per-line partial
 * acceptance.
 */
export function sanitizeAiRecipeContextProposal(
  raw: unknown,
  options: AiRecipeContextSanitizeOptions
): AiRecipeContextSanitizeResult {
  const inert = toInertValue(raw);
  if (!inert.ok) {
    const reason = (inert as { ok: false; reason: string }).reason;
    return {
      ok: false,
      code: reason === 'oversized' ? 'oversized_response' : 'unsafe_response',
    };
  }
  try {
    if (!isPlainObject(raw)) return { ok: false, code: 'invalid_response' };

    for (const key of Object.keys(raw)) {
      if (isAiRecipeContextAuthorityKey(key)) return { ok: false, code: 'authority_field' };
      if (!PROPOSAL_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
    }
    if (raw['contract_version'] !== AI_RECIPE_CONTEXT_CONTRACT_VERSION) {
      return { ok: false, code: 'unsupported_contract_version' };
    }
    if (raw['provenance_class'] !== AI_RECIPE_CONTEXT_PROVENANCE_CLASS) {
      // A forged stronger (e.g. `usda_derived`) class is an authority forgery.
      return { ok: false, code: 'authority_field' };
    }

    const allowed = new Set<string>();
    if (Array.isArray(options.allowedLineRefs)) {
      for (const ref of options.allowedLineRefs) {
        if (typeof ref === 'string' && ref.length > 0) allowed.add(ref);
      }
    }

    const rowsRaw = raw['interpretations'];
    if (!Array.isArray(rowsRaw)) return { ok: false, code: 'invalid_response' };
    const maxRows = Math.min(
      Number.isSafeInteger(options.maxRows) && (options.maxRows as number) > 0
        ? (options.maxRows as number)
        : MAX_RECIPE_CONTEXT_TARGETS,
      MAX_RECIPE_CONTEXT_TARGETS
    );
    if (rowsRaw.length > maxRows) return { ok: false, code: 'too_many_rows' };

    const seen = new Set<string>();
    const interpretations: AiRecipeContextInterpretation[] = [];

    for (const row of rowsRaw) {
      if (!isPlainObject(row)) return { ok: false, code: 'invalid_response' };
      if (hasForbiddenAuthorityKey(row)) return { ok: false, code: 'authority_field' };
      for (const key of Object.keys(row)) {
        if (!INTERPRETATION_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
      }

      const lineRef = boundedString(row['line_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
      if (lineRef === undefined) return { ok: false, code: 'invalid_response' };
      if (!allowed.has(lineRef)) return { ok: false, code: 'unknown_line_ref' };
      if (seen.has(lineRef)) return { ok: false, code: 'duplicate_line_ref' };
      seen.add(lineRef);

      const role = boundedToken(row['role'], AI_RECIPE_CONTEXT_ROLES as ReadonlyArray<string>);
      if (role === undefined) return { ok: false, code: 'invalid_response' };

      const relationsRaw = row['relations'];
      let relations: ReadonlyArray<AiRecipeContextRelation> = [];
      if (relationsRaw !== undefined && relationsRaw !== null) {
        if (!Array.isArray(relationsRaw) || relationsRaw.length > MAX_RECIPE_CONTEXT_RELATIONS) {
          return { ok: false, code: 'invalid_relations' };
        }
        const collected: AiRecipeContextRelation[] = [];
        for (const entry of relationsRaw) {
          const relation = canonicalizeRelation(entry);
          if (relation === undefined) return { ok: false, code: 'invalid_relations' };
          collected.push(relation);
        }
        relations = Object.freeze(collected);
      }

      const hintsRaw = row['preparation_hints'];
      let hints: ReadonlyArray<AiRecipeContextPreparationHint> = Object.freeze([]);
      if (hintsRaw !== undefined && hintsRaw !== null) {
        if (!Array.isArray(hintsRaw) || hintsRaw.length > MAX_RECIPE_CONTEXT_PREPARATION_HINTS) {
          return { ok: false, code: 'invalid_response' };
        }
        const collected: string[] = [];
        for (const entry of hintsRaw) {
          const hint = boundedToken(
            entry,
            AI_RECIPE_CONTEXT_PREPARATION_HINTS as ReadonlyArray<string>
          );
          if (hint === undefined) return { ok: false, code: 'invalid_response' };
          collected.push(hint);
        }
        hints = freezeLines(collected) as ReadonlyArray<AiRecipeContextPreparationHint>;
      }

      const confidenceRaw = row['confidence'];
      let confidence: AiRecipeContextConfidence | undefined;
      if (confidenceRaw !== undefined && confidenceRaw !== null) {
        const value = boundedToken(
          confidenceRaw,
          AI_RECIPE_CONTEXT_CONFIDENCE_VALUES as ReadonlyArray<string>
        );
        if (value === undefined) return { ok: false, code: 'invalid_response' };
        confidence = value as AiRecipeContextConfidence;
      }

      const abstainRaw = row['abstain_reason'];
      let abstainReason: AiRecipeContextAbstainReason | undefined;
      if (abstainRaw !== undefined && abstainRaw !== null) {
        const value = boundedToken(
          abstainRaw,
          AI_RECIPE_CONTEXT_ABSTAIN_REASONS as ReadonlyArray<string>
        );
        if (value === undefined) return { ok: false, code: 'invalid_response' };
        abstainReason = value as AiRecipeContextAbstainReason;
      }

      const explanationRaw = row['explanation'];
      let explanation: string | undefined;
      if (explanationRaw !== undefined && explanationRaw !== null) {
        explanation = boundedString(explanationRaw, MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH);
        if (explanation === undefined) return { ok: false, code: 'invalid_response' };
      }

      interpretations.push(
        Object.freeze({
          line_ref: lineRef,
          role: role as AiRecipeContextRole,
          relations,
          preparation_hints: hints,
          ...(confidence === undefined ? {} : { confidence }),
          ...(abstainReason === undefined ? {} : { abstain_reason: abstainReason }),
          ...(explanation === undefined ? {} : { explanation }),
        })
      );
    }

    return {
      ok: true,
      proposal: Object.freeze({
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations: Object.freeze(interpretations),
      }),
    };
  } catch {
    return { ok: false, code: 'unsafe_response' };
  }
}

// ---------------------------------------------------------------------------
// Relation graph validation (pure, deterministic, no state)
// ---------------------------------------------------------------------------

export type AiRecipeContextGraphFailure =
  | 'unknown_relation_target'
  | 'self_relation'
  | 'circular_relation'
  | 'relation_depth_exceeded'
  | 'multiple_parents'
  | 'duplicate_relation';

export type AiRecipeContextGraphResult =
  | { readonly ok: true; readonly lineCount: number }
  | { readonly ok: false; readonly code: AiRecipeContextGraphFailure };

/**
 * Deterministic relation-graph validation over ALREADY SANITIZED interpretations.
 *
 * This is a PURE validator. It mutates nothing, calls nothing, and can only ever
 * accept or refuse. It has no relationship to any nutrition authority: an
 * accepted graph still changes no gram, no identity, no nutrient and no
 * persistence field.
 *
 * Refuses, in order: an unknown target, a self-relation, a duplicate relation,
 * a target claimed by two single-parent relations, a cycle, and a graph deeper
 * than `MAX_RECIPE_CONTEXT_RELATION_DEPTH`.
 */
export function validateAiRecipeContextRelationGraph(
  interpretations: ReadonlyArray<AiRecipeContextInterpretation>,
  allowedLineRefs: ReadonlyArray<string>
): AiRecipeContextGraphResult {
  const allowed = new Set<string>();
  if (Array.isArray(allowedLineRefs)) {
    for (const ref of allowedLineRefs) {
      if (typeof ref === 'string' && ref.length > 0) allowed.add(ref);
    }
  }
  const sources = new Set<string>();
  if (Array.isArray(interpretations)) {
    for (const entry of interpretations) {
      if (isPlainObject(entry) && typeof entry.line_ref === 'string') sources.add(entry.line_ref);
    }
  }

  const edges = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const relationSeen = new Set<string>();

  for (const entry of interpretations) {
    const from = entry.line_ref;
    const list: string[] = edges.get(from) ?? [];
    for (const relation of entry.relations) {
      if (!allowed.has(relation.target_ref)) {
        return { ok: false, code: 'unknown_relation_target' };
      }
      if (relation.target_ref === from) return { ok: false, code: 'self_relation' };

      const key = `${from} ${relation.kind} ${relation.target_ref}`;
      if (relationSeen.has(key)) return { ok: false, code: 'duplicate_relation' };
      relationSeen.add(key);

      if (AI_RECIPE_CONTEXT_SINGLE_PARENT_RELATIONS.has(relation.kind)) {
        const existing = parentOf.get(relation.target_ref);
        if (existing !== undefined && existing !== from) {
          return { ok: false, code: 'multiple_parents' };
        }
        parentOf.set(relation.target_ref, from);
      }
      list.push(relation.target_ref);
    }
    edges.set(from, list);
  }

  // Acyclicity + bounded depth over the interpreted lines only.
  //
  // A post-order EXIT frame is pushed BEFORE the children, so the LIFO stack
  // fully processes every descendant before the node is marked finished. Marking
  // a node finished as soon as its children are PUSHED would hide any cycle that
  // runs back through an already-"finished" sibling branch.
  const state = new Map<string, 0 | 1 | 2>();
  const stack: Array<{ node: string; depth: number; exit: boolean }> = [];
  for (const start of sources) {
    if (state.get(start) !== undefined) continue;
    stack.push({ node: start, depth: 0, exit: false });
    while (stack.length > 0) {
      const frame = stack.pop() as { node: string; depth: number; exit: boolean };
      if (frame.exit) {
        state.set(frame.node, 2);
        continue;
      }
      const mark = state.get(frame.node) ?? 0;
      if (mark === 2) continue;
      if (mark === 1) return { ok: false, code: 'circular_relation' };
      if (frame.depth > MAX_RECIPE_CONTEXT_RELATION_DEPTH) {
        return { ok: false, code: 'relation_depth_exceeded' };
      }
      state.set(frame.node, 1);
      stack.push({ node: frame.node, depth: frame.depth, exit: true });
      for (const next of edges.get(frame.node) ?? []) {
        if (!sources.has(next)) continue;
        if ((state.get(next) ?? 0) === 1) return { ok: false, code: 'circular_relation' };
        stack.push({ node: next, depth: frame.depth + 1, exit: false });
      }
    }
  }

  return { ok: true, lineCount: sources.size };
}