/**
 * The Kitchen Codex — AI Advanced Nutrition: DETERMINISTIC recipe context
 * extraction (AI-4B, PHASE 2 — evidence only).
 *
 * AI-4A defined the SHAPE of a recipe-context envelope. AI-4B produces that
 * shape from the recipe itself, using nothing but local string rules. It is the
 * EVIDENCE layer that a future AI interpretation may later be shown, and it is
 * the ONLY thing AI-4B is.
 *
 * WHAT AI-4B IS
 *  A closed, bounded, offline phrase matcher over AUTHORED TEXT. It reads
 *  instruction steps, inspects ingredient references, and emits:
 *    1. a `RecipeContextEnvelope` (the existing AI-4A contract type, built
 *       explicitly through the existing production sanitizer), and
 *    2. bounded, local-only evidence records naming WHAT deterministic phrase
 *       fired, the exact authored clause it fired on, and which ingredient lines
 *       that instruction deterministically names.
 *
 * WHAT AI-4B IS NOT — READ THIS BEFORE CHANGING ANYTHING
 *  - It is NOT a mass estimator. It writes no grams, no fractions, no portions,
 *    no counts of food, no nutrients, no FDC ids and no yield. There is
 *    deliberately no field in this module capable of expressing a quantity.
 *  - It is NOT an identity authority. It never matches a food, never reads a
 *    match result, never reads a catalog, a record digest, a bundle release or a
 *    candidate set. Ingredient identity, USDA matching and FDC identity remain
 *    owned entirely by the deterministic matcher.
 *  - It is NOT an interpretation. It emits its OWN closed signal vocabulary and
 *    NEVER the AI-4A interpretation vocabulary (`role`, `relations`,
 *    `preparation_hints`, `confidence`, `abstain_reason`). A deterministic
 *    signal can therefore never be mistaken for, merged into, or silently
 *    upgraded into a model-proposed role or preparation hint.
 *  - It is NOT nutrition authority of any kind. An emitted signal can never
 *    change a resolved gram, an FDC id, a nutrient total, an effective-mass
 *    decision, an AI-3 eligibility verdict, an Apply verdict or a persistence
 *    payload. See `tests/unit/advancedNutritionAi4bAuthorityDifferential.test.ts`,
 *    which drives the REAL production pipeline with a REAL extraction in
 *    existence and observes that no nutrition truth moves.
 *  - It is NOT persistence, NOT a request, NOT a route, NOT a limiter, NOT UI,
 *    NOT a state mutation and NOT a reducer event. Nothing here is reachable
 *    from the live Advanced Nutrition workflow; the module is deliberately not
 *    exported from any barrel.
 *  - It performs NO AI inference of any kind. No provider, no model, no network,
 *    no clock, no randomness. Two runs over the same authored text produce
 *    byte-identical output.
 *
 * INSTRUCTION TEXT IS EVIDENCE, NEVER AUTHORITY
 *  A phrase this module recognizes is a statement about what the AUTHOR WROTE,
 *  not a statement about how much of an ingredient is eaten. "Reserve half for
 *  sauce" proves that the author wrote words about reserving; it says NOTHING
 *  about the consumed mass, and this module has no way to express one.
 *
 * THE MEASUREMENT-TEXT RULE (why ingredient lines are never phrase-scanned)
 *  Phrase rules run over INSTRUCTION TEXT ONLY. An ingredient line is read
 *  strictly as: an opaque line ref, its bounded authored text, and its authored
 *  food name. An ingredient line's amount/unit text is MEASUREMENT AUTHORITY
 *  owned by the Phase 2 parser, so "half teaspoon salt", "1/2 cup oil" and
 *  "2 portions chicken" are never scanned for context phrases and can never
 *  become a division, a reserved portion, or a serving count.
 *
 * HONEST LIMITS OF A DETERMINISTIC MATCHER (stated, not hidden)
 *  - It is conservative, not complete: an unusual paraphrase produces no signal,
 *    and absence of a signal NEVER means "this ingredient is fully consumed".
 *  - A verb can be the surface form of more than one intent. "Top with whipped
 *    cream" yields garnish evidence even where a human might read a main
 *    component. That is acceptable ONLY because the signal is bounded advisory
 *    evidence: a later user or a later accepted AI interpretation may disagree
 *    with it, and nothing downstream is bound to it.
 *  - A quantity cue in the matched clause VETOES the signal entirely (see
 *    `QUANTITY_CUE_GROUPS`). "Season to taste" and "add oil until coated" are
 *    unbounded instructions, and this module will not encode unbounded
 *    instructions as context claims.
 */

import { isPlainObject } from '../schema';
import { sha256Hex } from '../usda/digest';
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
  MAX_RECIPE_CONTEXT_FOOD_SEMANTICS_LENGTH,
  MAX_RECIPE_CONTEXT_LINE_REF_LENGTH,
  MAX_RECIPE_CONTEXT_SLOTS,
  MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH,
  MAX_RECIPE_CONTEXT_TARGETS,
  MAX_RECIPE_CONTEXT_TITLE_LENGTH,
  sanitizeRecipeContextEnvelope,
  type RecipeContextEnvelope,
} from './recipeContextContract';
import {
  hasDangerousOwnKey,
  hasSymbolKeys,
  materializeNarrow,
  readOwnDataField,
} from './materialize';
import { MAX_PHASE4_INGREDIENTS } from './types';

// ---------------------------------------------------------------------------
// Deterministic extractor identity
// ---------------------------------------------------------------------------

/**
 * The ONE deterministic extractor identity. It is a LOCAL provenance label for
 * the rule set below: it states which code produced the evidence, and it is
 * deliberately NOT a nutrition provenance class. Nothing authenticated can be
 * derived from it, and it is not one of `usda_derived` / `vetted_standard`.
 */
export const AI_RECIPE_CONTEXT_EXTRACTOR = 'nutrition_ai_recipe_context_deterministic_v1' as const;

// ---------------------------------------------------------------------------
// Closed deterministic signal vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed, finite set of context signals this deterministic extractor can
 * emit. It is DELIBERATELY DISJOINT from the AI-4A interpretation vocabulary
 * (`AI_RECIPE_CONTEXT_ROLES`, `AI_RECIPE_CONTEXT_RELATIONS`,
 * `AI_RECIPE_CONTEXT_PREPARATION_HINTS`): those describe a MODEL's reading,
 * these describe a PHRASE that was literally matched.
 *
 *  partial_use      — authored disposition that part of a line is set aside
 *  not_consumed     — authored disposition that a line/preparation is discarded
 *  preparation_only — authored preparation step on a part, not on the edible
 *  garnish_only     — authored finishing/garnish mention
 *  transformation   — authored coating/marinating/seasoning step
 *  division         — authored split/division step
 */
export const AI_RECIPE_CONTEXT_SIGNALS = Object.freeze([
  'partial_use',
  'not_consumed',
  'preparation_only',
  'garnish_only',
  'transformation',
  'division',
] as const);
export type AiRecipeContextSignal = (typeof AI_RECIPE_CONTEXT_SIGNALS)[number];

/** How the subject of a signal was identified. Never a food match. */
export const AI_RECIPE_CONTEXT_SUBJECT_KINDS = Object.freeze([
  /** The instruction literally names the ingredient line (token containment). */
  'named_ingredient',
  /** No ingredient line is deterministically named; evidence is line-level. */
  'unlinked',
] as const);
export type AiRecipeContextSubjectKind = (typeof AI_RECIPE_CONTEXT_SUBJECT_KINDS)[number];

// ---------------------------------------------------------------------------
// Bounds (every local dimension is closed and counted)
// ---------------------------------------------------------------------------

/** Bounded verbatim evidence clause. Shorter than the contract's text bound. */
export const MAX_RECIPE_CONTEXT_EVIDENCE_LENGTH = 120;
/** Authored instruction steps considered, in authored order. */
export const MAX_RECIPE_CONTEXT_INSTRUCTION_LINES = 40;
/** Signals per line. Equal to the contract's per-target slot budget. */
export const MAX_RECIPE_CONTEXT_SIGNALS_PER_LINE = MAX_RECIPE_CONTEXT_SLOTS;
/** Ingredient line refs a single signal may name. */
export const MAX_RECIPE_CONTEXT_SIGNAL_SUBJECTS = 3;
/** Rule-match attempts per rule per line, so a vetoed clause cannot hide a later one. */
export const MAX_RECIPE_CONTEXT_RULE_ATTEMPTS = 4;
/** Longest authored instruction text that may become a target. */
export const MAX_RECIPE_CONTEXT_INSTRUCTION_TEXT = MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH;

/**
 * Token-length floor for an ingredient NAME token to be usable as a
 * deterministic subject reference.
 */
export const MIN_RECIPE_CONTEXT_SUBJECT_TOKEN_LENGTH = 2;

/**
 * A tiny, closed, deliberately conservative stop list. It contains ONLY
 * grammatical and role markers that can never be a food's identity, so a name
 * is still required to be matched by ALL of its remaining content tokens
 * (containment, not similarity). Preparation/role tails are dropped on purpose:
 * the deterministic parser keeps them in the query ("parsley, for garnish"), and
 * a role word must never be required to appear in the instruction.
 */
export const RECIPE_CONTEXT_NAME_STOP_TOKENS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'boneless',
  'divided',
  'dried',
  'for',
  'fresh',
  'garnish',
  'large',
  'medium',
  'more',
  'of',
  'optional',
  'or',
  'plus',
  'serving',
  'skinless',
  'small',
  'the',
  'to',
  'whole',
]);

// ---------------------------------------------------------------------------
// The rule table (finite, data-only, no code generation)
// ---------------------------------------------------------------------------

/**
 * One closed phrase rule.
 *
 *  trigger    — a CONTIGUOUS token sequence that must appear literally.
 *  completion — REQUIRED companion cue. Any listed token GROUP appearing
 *               anywhere in the same clause satisfies the rule. An EMPTY list
 *               means the trigger alone is sufficient.
 */
interface SignalRule {
  readonly signal: AiRecipeContextSignal;
  readonly trigger: ReadonlyArray<string>;
  readonly completion: ReadonlyArray<ReadonlyArray<string>>;
}

const WITH_CUE: ReadonlyArray<ReadonlyArray<string>> = [
  ['with'],
  ['onto'],
  ['over'],
  ['in'],
];
const COAT_CUE: ReadonlyArray<ReadonlyArray<string>> = [['with'], ['in']];
const DRIZZLE_CUE: ReadonlyArray<ReadonlyArray<string>> = [['with'], ['over']];
const TOSS_CUE: ReadonlyArray<ReadonlyArray<string>> = [['with']];
/** A division verb alone is never enough: it must divide something somewhere. */
const DIVIDE_CUE: ReadonlyArray<ReadonlyArray<string>> = [
  ['into'],
  ['in'],
  ['evenly'],
  ['equally'],
];
const SPLIT_CUE: ReadonlyArray<ReadonlyArray<string>> = [
  ['into'],
  ['in'],
  ['evenly'],
  ['equally'],
  ['down'],
];
const SEPARATE_CUE: ReadonlyArray<ReadonlyArray<string>> = [['into']];
/** Preparation needs a BODY PART to act on; "remove the lid" is not a food fact. */
const BODY_PART_CUE: ReadonlyArray<ReadonlyArray<string>> = [
  ['bone'],
  ['bones'],
  ['skin'],
  ['seed'],
  ['seeds'],
  ['pit'],
  ['pits'],
  ['stalk'],
  ['stalks'],
  ['rind'],
  ['peel'],
  ['gristle'],
  ['tail'],
  ['head'],
  ['vein'],
  ['veins'],
  ['leaf'],
  ['leaves'],
];

/**
 * The closed, ordered rule set. Evaluation order is load-bearing: it makes
 * per-line signal order deterministic and therefore snapshot-stable.
 */
export const AI_RECIPE_CONTEXT_SIGNAL_RULES: ReadonlyArray<SignalRule> = Object.freeze([
  // --- ingredient disposition: part of the line is set aside -------------
  { signal: 'partial_use', trigger: ['reserve'], completion: [] },
  { signal: 'partial_use', trigger: ['reserves'], completion: [] },
  { signal: 'partial_use', trigger: ['reserving'], completion: [] },
  { signal: 'partial_use', trigger: ['set', 'aside'], completion: [] },
  { signal: 'partial_use', trigger: ['hold', 'back'], completion: [] },
  { signal: 'partial_use', trigger: ['put', 'aside'], completion: [] },
  { signal: 'partial_use', trigger: ['save'], completion: [] },
  { signal: 'partial_use', trigger: ['saves'], completion: [] },
  { signal: 'partial_use', trigger: ['saving'], completion: [] },
  // --- ingredient disposition: the line is not consumed -------------------
  { signal: 'not_consumed', trigger: ['discard'], completion: [] },
  { signal: 'not_consumed', trigger: ['discards'], completion: [] },
  { signal: 'not_consumed', trigger: ['discarding'], completion: [] },
  { signal: 'not_consumed', trigger: ['dispose', 'of'], completion: [] },
  { signal: 'not_consumed', trigger: ['pour', 'off'], completion: [] },
  { signal: 'not_consumed', trigger: ['throw', 'away'], completion: [] },
  { signal: 'not_consumed', trigger: ['toss', 'out'], completion: [] },
  { signal: 'not_consumed', trigger: ['not', 'eaten'], completion: [] },
  { signal: 'not_consumed', trigger: ['do', 'not', 'eat'], completion: [] },
  // --- preparation on a part, not on the edible --------------------------
  { signal: 'preparation_only', trigger: ['remove'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['removes'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['removing'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['trim'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['trims'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['trimming'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['debone'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['debones'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['deboning'], completion: BODY_PART_CUE },
  { signal: 'preparation_only', trigger: ['de', 'seed'], completion: BODY_PART_CUE },
  // --- garnish / finishing mention ---------------------------------------
  { signal: 'garnish_only', trigger: ['garnish'], completion: [] },
  { signal: 'garnish_only', trigger: ['garnishes'], completion: [] },
  { signal: 'garnish_only', trigger: ['garnishing'], completion: [] },
  { signal: 'garnish_only', trigger: ['top', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['tops', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['topped', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['finish', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['finishes', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['finished', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['finishing', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['decorate', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['decorates', 'with'], completion: [] },
  { signal: 'garnish_only', trigger: ['decorated', 'with'], completion: [] },
  // --- preparation transformation (no absorbed amount is ever inferred) ---
  { signal: 'transformation', trigger: ['brush'], completion: WITH_CUE },
  { signal: 'transformation', trigger: ['brushes'], completion: WITH_CUE },
  { signal: 'transformation', trigger: ['brushing'], completion: WITH_CUE },
  { signal: 'transformation', trigger: ['coat'], completion: COAT_CUE },
  { signal: 'transformation', trigger: ['coats'], completion: COAT_CUE },
  // Deliberately cue-free: the quantity-cue veto is what refuses "add oil
  // until coated", and a bare `coated` must stay observable.
  { signal: 'transformation', trigger: ['coated'], completion: [] },
  { signal: 'transformation', trigger: ['drizzle'], completion: DRIZZLE_CUE },
  { signal: 'transformation', trigger: ['drizzles'], completion: DRIZZLE_CUE },
  { signal: 'transformation', trigger: ['drizzled'], completion: [] },
  { signal: 'transformation', trigger: ['toss'], completion: TOSS_CUE },
  { signal: 'transformation', trigger: ['tossed'], completion: TOSS_CUE },
  { signal: 'transformation', trigger: ['tossing'], completion: TOSS_CUE },
  { signal: 'transformation', trigger: ['marinate'], completion: [] },
  { signal: 'transformation', trigger: ['marinates'], completion: [] },
  { signal: 'transformation', trigger: ['marinated'], completion: [] },
  { signal: 'transformation', trigger: ['marinating'], completion: [] },
  { signal: 'transformation', trigger: ['season'], completion: [] },
  { signal: 'transformation', trigger: ['seasons'], completion: [] },
  { signal: 'transformation', trigger: ['seasoned'], completion: [] },
  { signal: 'transformation', trigger: ['seasoning'], completion: [] },
  // --- division language (never a serving calculation) -------------------
  { signal: 'division', trigger: ['divide'], completion: DIVIDE_CUE },
  { signal: 'division', trigger: ['divides'], completion: DIVIDE_CUE },
  { signal: 'division', trigger: ['dividing'], completion: DIVIDE_CUE },
  { signal: 'division', trigger: ['divided'], completion: DIVIDE_CUE },
  { signal: 'division', trigger: ['split'], completion: SPLIT_CUE },
  { signal: 'division', trigger: ['splits'], completion: SPLIT_CUE },
  { signal: 'division', trigger: ['splitting'], completion: SPLIT_CUE },
  { signal: 'division', trigger: ['separate'], completion: SEPARATE_CUE },
  { signal: 'division', trigger: ['separates'], completion: SEPARATE_CUE },
  { signal: 'division', trigger: ['separating'], completion: SEPARATE_CUE },
  // NOTE: `portion` is deliberately NOT a trigger. It is the canonical authored
  // MEASUREMENT word ("2 portions chicken"), and a rule must never be able to
  // fire on a unit. `divide` / `split` / `separate` already cover division
  // language without touching a measurement.
]);

/**
 * Unbounded-quantity cues. A matched clause containing ANY of these is refused
 * outright: an instruction whose amount is open-ended ("to taste", "until
 * coated", "as needed") is not context this module will encode, because there
 * is no bounded truth to report about it.
 */
export const QUANTITY_CUE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = Object.freeze([
  ['to', 'taste'],
  ['as', 'needed'],
  ['as', 'desired'],
  ['as', 'required'],
  ['as', 'much'],
  ['as', 'many'],
  ['if', 'needed'],
  ['if', 'desired'],
  ['until'],
  ['enough'],
  ['plenty'],
  ['any'],
  ['approximately'],
  ['about'],
  ['or', 'more'],
  ['or', 'less'],
  ['for', 'serving'],
  ['for', 'dusting'],
  ['for', 'drizzling'],
  ['for', 'frying'],
  ['for', 'greasing'],
  ['to', 'finish'],
  ['optional'],
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * ONE bounded, local, non-authoritative piece of deterministic evidence.
 *
 * It carries NO grams, NO fraction, NO nutrient, NO FDC id, NO portion, NO
 * serving count, NO conversion basis, NO persistence field and NO confidence
 * claim. A rule firing is not a confidence claim: a deterministic rule is
 * certain that its phrase matched and silent about everything else, and
 * abstention is expressed by emitting nothing at all.
 */
export interface RecipeContextSignalEvidence {
  /** The closed deterministic signal token that fired. */
  readonly signal: AiRecipeContextSignal;
  /** The deterministic instruction line ref the evidence belongs to. */
  readonly instruction_line_ref: string;
  /** The verbatim authored clause the rule matched, bounded. */
  readonly evidence: string;
  /** Ingredient line refs this instruction deterministically names, bounded. */
  readonly subjects: ReadonlyArray<string>;
  /** Whether a deterministic subject was identified. Never a food match. */
  readonly subject_kind: AiRecipeContextSubjectKind;
}

/**
 * The complete AI-4B result: the AI-4A envelope plus the deterministic evidence
 * that produced it.
 *
 * INVARIANT: every `line_ref` mentioned anywhere in an extraction is present in
 * `envelope.targets`. Evidence can therefore never describe a line the envelope
 * does not carry.
 */
export interface RecipeContextExtraction {
  /** The deterministic extractor identity (local provenance label only). */
  readonly extractor: typeof AI_RECIPE_CONTEXT_EXTRACTOR;
  /** The AI-4A contract envelope, built through the production sanitizer. */
  readonly envelope: RecipeContextEnvelope;
  /** Bounded deterministic evidence, in deterministic order. */
  readonly signals: ReadonlyArray<RecipeContextSignalEvidence>;
  /** Selected envelope target count (structural, non-nutritional). */
  readonly target_count: number;
  /** Emitted evidence count (structural, non-nutritional). */
  readonly signal_count: number;
  /** Authored lines dropped by the deterministic target cap. */
  readonly omitted_target_count: number;
  /** Detected signals on lines dropped by that same cap. */
  readonly omitted_signal_count: number;
  /** Authored lines never read (unbounded text, over cap, non-conforming ref). */
  readonly skipped_line_count: number;
}

export type RecipeContextExtractionFailure =
  /** Hostile or unmaterializable input (accessor, symbol, dangerous key, …). */
  | 'unsafe_context'
  /** Structurally unusable input (not an object, ingredients not an array, …). */
  | 'invalid_context'
  /** No line survived the bounded, deterministic selection. */
  | 'no_context_targets'
  /** The AI-4A production sanitizer refused the built envelope (defense in depth). */
  | 'context_envelope_refused';

export type RecipeContextExtractionResult =
  | { readonly ok: true; readonly extraction: RecipeContextExtraction }
  | { readonly ok: false; readonly code: RecipeContextExtractionFailure };

// ---------------------------------------------------------------------------
// Local bounded helpers
// ---------------------------------------------------------------------------

const CLAUSE_BOUNDARIES = ',;:!?.';

interface Token {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Whitespace-normalizes authored text. Normalization (runs of whitespace become
 * a single space) is what makes the evidence clause an EXACT substring of the
 * target's `source_text`, and it removes the possibility of a newline or tab
 * reaching a bounded contract field.
 */
function normalizeAuthoredText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): ReadonlyArray<Token> {
  const out: Token[] = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out.push({ token: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  }
  return out;
}

/** First index at or after `from` where the contiguous `phrase` appears. */
function findPhrase(
  tokens: ReadonlyArray<Token>,
  phrase: ReadonlyArray<string>,
  from: number
): number {
  if (phrase.length === 0 || tokens.length < phrase.length) return -1;
  for (let start = from; start + phrase.length <= tokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[start + offset].token !== phrase[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/** True when any listed group appears as a CONTIGUOUS sequence in the tokens. */
function hasGroup(
  tokens: ReadonlyArray<Token>,
  groups: ReadonlyArray<ReadonlyArray<string>>
): boolean {
  for (const group of groups) {
    if (findPhrase(tokens, group, 0) !== -1) return true;
  }
  return false;
}

/**
 * The authored clause surrounding `anchor`: from the last clause boundary before
 * the trigger to the next boundary after it. Bounded and trimmed.
 */
function clauseAround(text: string, tokens: ReadonlyArray<Token>, anchor: number): string {
  const start = tokens[anchor].start;
  const end = tokens[anchor].end;
  let from = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (CLAUSE_BOUNDARIES.indexOf(text.charAt(index)) !== -1) {
      from = index + 1;
      break;
    }
  }
  let to = text.length;
  for (let index = end; index < text.length; index += 1) {
    if (CLAUSE_BOUNDARIES.indexOf(text.charAt(index)) !== -1) {
      to = index;
      break;
    }
  }
  return text.slice(from, to).trim();
}

/**
 * Bounds an evidence clause at a word boundary. A clause whose FIRST word alone
 * exceeds the bound carries no usable evidence, so it is refused (the caller
 * drops the signal) rather than truncated into a misleading claim.
 */
function boundEvidence(clause: string): string | undefined {
  if (clause.length === 0) return undefined;
  if (clause.length <= MAX_RECIPE_CONTEXT_EVIDENCE_LENGTH) return clause;
  const head = clause.slice(0, MAX_RECIPE_CONTEXT_EVIDENCE_LENGTH);
  const cut = head.lastIndexOf(' ');
  if (cut <= 0) return undefined;
  return head.slice(0, cut);
}

/** Content tokens of an authored ingredient NAME, used for subject reference. */
function nameTokens(name: string | undefined): ReadonlyArray<string> {
  if (name === undefined) return [];
  const out: string[] = [];
  for (const token of tokenize(name)) {
    if (token.token.length < MIN_RECIPE_CONTEXT_SUBJECT_TOKEN_LENGTH) continue;
    if (RECIPE_CONTEXT_NAME_STOP_TOKENS.has(token.token)) continue;
    out.push(token.token);
  }
  return out;
}

/**
 * The ingredient line refs an instruction deterministically NAMES. Containment
 * only: EVERY content token of the ingredient name must appear in the
 * instruction. This is not similarity, not a match, not a food lookup, and it
 * can never produce an identity.
 */
function subjectsNamedBy(
  tokens: ReadonlyArray<Token>,
  ingredients: ReadonlyArray<IngredientLine>
): ReadonlyArray<string> {
  if (tokens.length === 0 || ingredients.length === 0) return [];
  const present = new Set<string>();
  for (const token of tokens) present.add(token.token);
  const refs: string[] = [];
  for (const ingredient of ingredients) {
    if (ingredient.nameTokens.length === 0) continue;
    let contained = true;
    for (const token of ingredient.nameTokens) {
      if (!present.has(token)) {
        contained = false;
        break;
      }
    }
    if (contained) refs.push(ingredient.line_ref);
    if (refs.length >= MAX_RECIPE_CONTEXT_SIGNAL_SUBJECTS) break;
  }
  return refs;
}

/**
 * A deterministic, opaque instruction line ref. It mirrors the ESTABLISHED
 * `adapt.ts` line-ref convention (`<kind>:<index>:<content digest>`) so an
 * instruction ref can never be confused with an ingredient ref and a rename can
 * never masquerade as identity. The prefix is `ins:`, never `ing:`.
 */
function instructionLineRef(index: number, text: string): string {
  return `ins:${index}:${sha256Hex(text).slice(0, 12)}`;
}

/**
 * A local, opaque, deterministic instruction-evidence slot token.
 *
 * The signal kind and the evidence text go IN, never OUT: the token is a digest,
 * so a slot can never be read as a claim about the food, the amount or the
 * context. It is a change-detector for AI-4A snapshot binding and nothing else.
 */
function slotToken(parts: ReadonlyArray<string>): string {
  // Bounded far below the contract's slot length.
  return `rc1:${sha256Hex(parts.join('|')).slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Input reading (narrow, hostile-tolerant, never reading before materializing)
// ---------------------------------------------------------------------------

interface IngredientLine {
  readonly line_ref: string;
  readonly source_text: string;
  readonly food_semantics?: string;
  readonly nameTokens: ReadonlyArray<string>;
}

interface DetectedSignal {
  readonly signal: AiRecipeContextSignal;
  readonly evidence: string;
  readonly anchor: number;
  readonly subjects: ReadonlyArray<string>;
}

interface CandidateLine {
  readonly index: number;
  readonly kind: 'ingredient' | 'instruction';
  readonly line_ref: string;
  readonly source_text: string;
  readonly food_semantics?: string;
  readonly signals: ReadonlyArray<DetectedSignal>;
}

interface ReadContext {
  readonly lines: ReadonlyArray<CandidateLine>;
  readonly ingredients: ReadonlyArray<IngredientLine>;
  readonly title?: string;
  readonly baseServings?: number;
  readonly skippedLineCount: number;
}

type ReadResult =
  | { readonly ok: true; readonly context: ReadContext }
  | { readonly ok: false; readonly code: RecipeContextExtractionFailure };

function fail(code: RecipeContextExtractionFailure): { ok: false; code: RecipeContextExtractionFailure } {
  return { ok: false, code };
}

/** Deterministic phrase detection over ONE authored instruction line. */
function detectSignals(
  text: string,
  ingredients: ReadonlyArray<IngredientLine>
): ReadonlyArray<DetectedSignal> {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  const detected: DetectedSignal[] = [];
  const seen = new Set<string>();

  for (const rule of AI_RECIPE_CONTEXT_SIGNAL_RULES) {
    let from = 0;
    for (let attempt = 0; attempt < MAX_RECIPE_CONTEXT_RULE_ATTEMPTS; attempt += 1) {
      const anchor = findPhrase(tokens, rule.trigger, from);
      if (anchor === -1) break;
      from = anchor + 1;
      const clause = clauseAround(text, tokens, anchor);
      const evidence = boundEvidence(clause);
      if (evidence === undefined) continue;
      const clauseTokens = tokenize(clause);
      // An unbounded-quantity clause is refused, never encoded.
      if (hasGroup(clauseTokens, QUANTITY_CUE_GROUPS)) continue;
      if (rule.completion.length > 0 && !hasGroup(clauseTokens, rule.completion)) continue;
      const key = `${rule.signal}|${evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      detected.push(
        Object.freeze({
          signal: rule.signal,
          evidence,
          anchor: tokens[anchor].start,
          subjects: subjectsNamedBy(tokens, ingredients),
        })
      );
      break;
    }
  }

  // Authored order, then rule order: a deterministic, snapshot-stable order.
  detected.sort((left, right) => left.anchor - right.anchor);
  return detected.slice(0, MAX_RECIPE_CONTEXT_SIGNALS_PER_LINE);
}

/**
 * Reads ONE ingredient entry out of an already-materialized adapted entry.
 * Returns undefined when the entry cannot be represented inside the contract
 * bounds (it is then skipped and counted, never coerced).
 */
function readIngredientLine(entry: Record<string, unknown>): IngredientLine | undefined {
  const lineRef = boundedText(entry['line_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
  if (lineRef === undefined) return undefined;
  const ingredient = entry['ingredient'];
  if (!isPlainObject(ingredient)) return undefined;
  const record = ingredient as Record<string, unknown>;
  const original = typeof record['original'] === 'string' ? record['original'] : '';
  const name = typeof record['name'] === 'string' ? record['name'] : undefined;
  // Authored text, whitespace-normalized, bounded. An over-long authored line is
  // skipped, never truncated into a statement the author did not write.
  const sourceText = boundedText(
    normalizeAuthoredText(original) || (name === undefined ? '' : normalizeAuthoredText(name)),
    MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH
  );
  if (sourceText === undefined) return undefined;
  const semantics = boundedText(
    name === undefined ? undefined : normalizeAuthoredText(name),
    MAX_RECIPE_CONTEXT_FOOD_SEMANTICS_LENGTH
  );
  return Object.freeze({
    line_ref: lineRef,
    source_text: sourceText,
    ...(semantics === undefined ? {} : { food_semantics: semantics }),
    nameTokens: nameTokens(semantics),
  });
}

/**
 * The one narrow, hostile-tolerant read. Nothing is read before it has been
 * materialized once into inert data, and every authored field is BOUNDED and
 * OPTIONAL: an out-of-contract title or serving count is OMITTED (absence), never
 * coerced into a value the recipe never stated.
 */
function readContext(input: unknown): ReadResult {
  if (!isPlainObject(input)) return fail('invalid_context');
  if (hasSymbolKeys(input) || hasDangerousOwnKey(input)) return fail('unsafe_context');

  const recipeField = readOwnDataField(input, 'recipe');
  if (!recipeField.ok) return fail('unsafe_context');
  if (!recipeField.present) return fail('invalid_context');
  const recipeMaterialized = materializeNarrow(recipeField.value);
  if (!recipeMaterialized.ok) {
    return fail(recipeMaterialized.unsafe ? 'unsafe_context' : 'invalid_context');
  }
  const recipe = recipeMaterialized.value;
  if (!isPlainObject(recipe)) return fail('invalid_context');

  const instructionsField = readOwnDataField(input, 'instructions');
  if (!instructionsField.ok) return fail('unsafe_context');
  const instructionsMaterialized = materializeNarrow(instructionsField.value ?? []);
  if (!instructionsMaterialized.ok) {
    return fail(instructionsMaterialized.unsafe ? 'unsafe_context' : 'invalid_context');
  }
  const instructionValues = instructionsMaterialized.value;
  if (!Array.isArray(instructionValues)) return fail('invalid_context');

  let skipped = 0;

  // --- ingredient lines ----------------------------------------------------
  const adaptedField = readOwnDataField(recipe, 'adapted');
  if (!adaptedField.ok) return fail('unsafe_context');
  if (!adaptedField.present) return fail('invalid_context');
  const adaptedMaterialized = materializeNarrow(adaptedField.value);
  if (!adaptedMaterialized.ok) {
    return fail(adaptedMaterialized.unsafe ? 'unsafe_context' : 'invalid_context');
  }
  const adaptedValues = adaptedMaterialized.value;
  if (!Array.isArray(adaptedValues)) return fail('invalid_context');

  const ingredients: IngredientLine[] = [];
  const seenRefs = new Set<string>();
  for (let index = 0; index < adaptedValues.length; index += 1) {
    if (index >= MAX_PHASE4_INGREDIENTS) {
      skipped += 1;
      continue;
    }
    if (!isPlainObject(adaptedValues[index])) {
      skipped += 1;
      continue;
    }
    const line = readIngredientLine(adaptedValues[index] as Record<string, unknown>);
    if (line === undefined || seenRefs.has(line.line_ref)) {
      skipped += 1;
      continue;
    }
    seenRefs.add(line.line_ref);
    ingredients.push(line);
  }

  // --- instruction lines ---------------------------------------------------
  const instructionLines: Array<{ index: number; ref: string; text: string }> = [];
  for (let index = 0; index < instructionValues.length; index += 1) {
    if (instructionLines.length >= MAX_RECIPE_CONTEXT_INSTRUCTION_LINES) {
      skipped += 1;
      continue;
    }
    if (!isPlainObject(instructionValues[index])) {
      skipped += 1;
      continue;
    }
    const textField = readOwnDataField(instructionValues[index] as object, 'text');
    if (!textField.ok) return fail('unsafe_context');
    if (!textField.present || typeof textField.value !== 'string') {
      skipped += 1;
      continue;
    }
    const text = normalizeAuthoredText(textField.value);
    if (text.length === 0 || text.length > MAX_RECIPE_CONTEXT_INSTRUCTION_TEXT) {
      // A step that cannot fit the contract's text bound is SKIPPED, never
      // truncated into a statement the author did not write.
      skipped += 1;
      continue;
    }
    const ref = instructionLineRef(index, text);
    if (seenRefs.has(ref)) {
      skipped += 1;
      continue;
    }
    seenRefs.add(ref);
    instructionLines.push({ index, ref, text });
  }

  // --- candidate lines, in one deterministic document order ----------------
  const lines: CandidateLine[] = [];
  for (let index = 0; index < ingredients.length; index += 1) {
    const line = ingredients[index];
    lines.push(
      Object.freeze({
        index,
        kind: 'ingredient' as const,
        line_ref: line.line_ref,
        source_text: line.source_text,
        ...(line.food_semantics === undefined ? {} : { food_semantics: line.food_semantics }),
        signals: Object.freeze([]),
      })
    );
  }
  for (const step of instructionLines) {
    lines.push(
      Object.freeze({
        index: ingredients.length + step.index,
        kind: 'instruction' as const,
        line_ref: step.ref,
        source_text: step.text,
        signals: detectSignals(step.text, ingredients),
      })
    );
  }

  // --- optional, verbatim, non-coerced envelope context --------------------
  const titleField = readOwnDataField(recipe, 'title');
  if (!titleField.ok) return fail('unsafe_context');
  const title = boundedText(titleField.value, MAX_RECIPE_CONTEXT_TITLE_LENGTH);

  const servingsField = readOwnDataField(recipe, 'base_servings');
  if (!servingsField.ok) return fail('unsafe_context');
  const baseServings =
    typeof servingsField.value === 'number' &&
    Number.isFinite(servingsField.value) &&
    servingsField.value > 0 &&
    servingsField.value <= 1000 &&
    !Object.is(servingsField.value, -0)
      ? servingsField.value
      : undefined;

  return {
    ok: true,
    context: Object.freeze({
      lines: Object.freeze(lines),
      ingredients: Object.freeze(ingredients),
      ...(title === undefined ? {} : { title }),
      ...(baseServings === undefined ? {} : { baseServings }),
      skippedLineCount: skipped,
    }),
  };
}

// ---------------------------------------------------------------------------
// The ONE public extractor
// ---------------------------------------------------------------------------

/**
 * Extracts deterministic recipe-context evidence and the AI-4A envelope.
 *
 * Input shape (both fields are read narrowly and never before materializing):
 *   recipe       — the Phase 4 narrow `AdaptedRecipe`
 *                  (`{ adapted, title, base_servings }`)
 *   instructions — the authored step array; each element is read for its own
 *                  `text` data property only
 *
 * SELECTION (deterministic, bounded, and never severing evidence from its subject)
 *  1. each instruction line that carries at least one detected signal,
 *     IMMEDIATELY followed by the ingredient lines its signals name;
 *  2. the remaining ingredient lines in authored order;
 *  3. the remaining instruction lines in authored order.
 * Keeping a signal and its subject adjacent means the target budget can only ever
 * drop a whole evidence group, never leave an instruction pointing at an
 * ingredient the envelope does not carry. Anything dropped by that budget is
 * COUNTED, never silently discarded.
 *
 * The returned envelope is the output of the REAL AI-4A production sanitizer, so
 * an AI-4B extraction can never carry a field the contract does not define.
 */
export function extractRecipeContext(input: unknown): RecipeContextExtractionResult {
  try {
    const read = readContext(input);
    // (Under this project's non-strict null-checking, a boolean `ok` discriminant
    // narrows reliably only in the truthy direction, so the failure branch is
    // re-wrapped explicitly — the same discipline `adapt.ts` uses.)
    if (!read.ok) return fail((read as { ok: false; code: RecipeContextExtractionFailure }).code);
    const context = read.context;
    if (context.lines.length === 0) return fail('no_context_targets');

    const selected: CandidateLine[] = [];
    const selectedRefs = new Set<string>();
    const take = (line: CandidateLine): void => {
      if (selected.length >= MAX_RECIPE_CONTEXT_TARGETS) return;
      if (selectedRefs.has(line.line_ref)) return;
      selectedRefs.add(line.line_ref);
      selected.push(line);
    };

    // --- pass 1: each signal line, then the ingredients IT names ----------
    for (const line of context.lines) {
      if (line.kind !== 'instruction' || line.signals.length === 0) continue;
      take(line);
      const named = new Set<string>();
      for (const signal of line.signals) {
        for (const ref of signal.subjects) named.add(ref);
      }
      for (const other of context.lines) {
        if (other.kind === 'ingredient' && named.has(other.line_ref)) take(other);
      }
    }
    // --- pass 2: the remaining ingredient lines, in authored order ---------
    for (const line of context.lines) {
      if (line.kind === 'ingredient') take(line);
    }
    // --- pass 3: the remaining instruction lines, in authored order -------
    for (const line of context.lines) {
      if (line.kind === 'instruction') take(line);
    }

    if (selected.length === 0) return fail('no_context_targets');

    // --- the AI-4A envelope, built EXPLICITLY through the production gate ---
    const built = sanitizeRecipeContextEnvelope({
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      ...(context.title === undefined ? {} : { title: context.title }),
      ...(context.baseServings === undefined ? {} : { base_servings: context.baseServings }),
      targets: selected.map((line) => {
        const slots: string[] = [];
        if (line.kind === 'instruction') {
          for (const signal of line.signals) {
            if (slots.length >= MAX_RECIPE_CONTEXT_SLOTS) break;
            slots.push(slotToken([signal.signal, line.line_ref, signal.evidence]));
          }
        } else {
          for (const other of context.lines) {
            if (slots.length >= MAX_RECIPE_CONTEXT_SLOTS) break;
            for (const signal of other.signals) {
              if (slots.length >= MAX_RECIPE_CONTEXT_SLOTS) break;
              if (signal.subjects.indexOf(line.line_ref) === -1) continue;
              slots.push(slotToken([signal.signal, other.line_ref, signal.evidence, line.line_ref]));
            }
          }
        }
        return {
          line_ref: line.line_ref,
          source_text: line.source_text,
          ...(line.food_semantics === undefined ? {} : { food_semantics: line.food_semantics }),
          ...(slots.length === 0 ? {} : { instruction_slots: slots }),
        };
      }),
    });
    if (!built.ok) return fail('context_envelope_refused');

    // --- evidence, bound to the SANITIZED envelope's own target set --------
    const envelopeRefs = new Set<string>();
    for (const target of built.envelope.targets) envelopeRefs.add(target.line_ref);

    const signals: RecipeContextSignalEvidence[] = [];
    let omittedSignalCount = 0;
    for (const line of context.lines) {
      if (line.signals.length === 0) continue;
      if (!envelopeRefs.has(line.line_ref)) {
        omittedSignalCount += line.signals.length;
        continue;
      }
      for (const signal of line.signals) {
        // A subject is reported only when the envelope actually carries it, so
        // every ref in an extraction is a real, present envelope target.
        const subjects = signal.subjects.filter((ref) => envelopeRefs.has(ref));
        signals.push(
          Object.freeze({
            signal: signal.signal,
            instruction_line_ref: line.line_ref,
            evidence: signal.evidence,
            subjects: Object.freeze(subjects.slice(0, MAX_RECIPE_CONTEXT_SIGNAL_SUBJECTS)),
            subject_kind: subjects.length === 0 ? 'unlinked' : 'named_ingredient',
          })
        );
      }
    }

    return {
      ok: true,
      extraction: Object.freeze({
        extractor: AI_RECIPE_CONTEXT_EXTRACTOR,
        envelope: built.envelope,
        signals: Object.freeze(signals),
        target_count: built.envelope.targets.length,
        signal_count: signals.length,
        omitted_target_count: context.lines.length - built.envelope.targets.length,
        omitted_signal_count: omittedSignalCount,
        skipped_line_count: context.skippedLineCount,
      }),
    };
  } catch {
    // Never converts a hostile input into an empty SUCCESSFUL extraction.
    return fail('unsafe_context');
  }
}
