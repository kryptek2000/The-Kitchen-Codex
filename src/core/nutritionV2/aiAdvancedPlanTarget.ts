/**
 * The Kitchen Codex — Advanced Nutrition AI-2B: PLANNING TARGET.
 *
 * PURE, platform-neutral, provider-free, side-effect free.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * AI-2A's provider request carries candidate AUTHORITY only: a `line_ref` and a
 * bounded, opaque candidate set. It deliberately carries NO semantics, so a model
 * given only that request can choose an ALLOWED candidate but cannot choose a
 * MEANINGFUL one — with
 *   c1 = Cream, fluid, heavy whipping / c2 = Cream cheese / c3 = Sour cream
 * it has no way to know whether the line being resolved is "heavy cream",
 * "cream cheese" or "sour cream".
 *
 * AI-2B therefore adds a separate, narrow PLANNING TARGET: the bounded semantic
 * description of WHAT the candidates are being compared against. The two concepts
 * stay deliberately separate (AI-2A owns candidate authority; AI-2B owns the
 * planning target), and AI-2C later decides whether a target came from authored
 * ingredient text or from a sanitized AI-1 semantic query. This module supports
 * BOTH without making that integration decision itself:
 *
 *   buildAiAdvancedPlanTarget({ lineRef, sourceText })                       // authored
 *   buildAiAdvancedPlanTarget({ lineRef, sourceText, interpretation })       // AI-1-backed
 *
 * AUTHORITY. A target is bounded semantic INFORMATION, never authority. It carries
 * no FDC id, no digest, no grams/mass/density, no nutrient, no portion, no
 * confirmation/Apply, no persistence, no schema/provenance and no confidence —
 * the closed key sets below reject any such key, at any depth. The target cannot
 * widen a candidate set, cannot authorize a selection, and cannot bypass the
 * amount/unit or state/preparation authority of the deterministic core: it only
 * tells the model which food the line is about.
 *
 * BOUNDS. Every bound is imported from the canonical AI-1 contract
 * (`./aiAdvanced`) so there is exactly ONE owner of the semantic vocabulary
 * limits. Bound violations FAIL CLOSED (no silent truncation, no silent
 * normalisation of content that would have to be dropped): a broken target must
 * never silently become a weaker-but-plausible one.
 */

import { isPlainObject } from './schema';
import { MAX_AI_ADVANCED_FINGERPRINT_LENGTH } from './aiAdvancedPlanSource';
import {
  AI_ADVANCED_CONTRACT_VERSION,
  sanitizeAiAdvancedInterpretationResponse,
} from './aiAdvanced';
import {
  MAX_AI_ADVANCED_ALTERNATIVES,
  MAX_AI_ADVANCED_AMBIGUITY_REASONS,
  MAX_AI_ADVANCED_DOCUMENT_TEXT,
  MAX_AI_ADVANCED_LINE_REF_LENGTH,
  MAX_AI_ADVANCED_NAME_LENGTH,
  MAX_AI_ADVANCED_NOTE_LENGTH,
  MAX_AI_ADVANCED_PHRASE_LENGTH,
  MAX_AI_ADVANCED_SEARCH_PHRASES,
  MAX_AI_ADVANCED_TOKENS,
  MAX_AI_ADVANCED_TOKEN_LENGTH,
} from './aiAdvanced';

/** Version tag for a canonical planning target. */
export const AI_ADVANCED_PLAN_TARGET_VERSION = 'nutrition_ai_advanced_plan_target_v1';

/** Closed key set of a planning target. */
export const AI_ADVANCED_PLAN_TARGET_KEYS = Object.freeze([
  'line_ref',
  'source_text',
  'semantic_food',
  'search_phrases',
  'ambiguity',
  'alternatives',
] as const);

/** Closed key set of the canonical semantic food block. */
export const AI_ADVANCED_PLAN_TARGET_SEMANTIC_KEYS = Object.freeze([
  'normalized_name',
  'modifiers',
  'preparation',
  'state',
  'qualifiers',
] as const);

export interface AiAdvancedPlanTargetSemanticFood {
  readonly normalized_name?: string;
  readonly modifiers: ReadonlyArray<string>;
  readonly preparation: ReadonlyArray<string>;
  readonly state: ReadonlyArray<string>;
  readonly qualifiers: ReadonlyArray<string>;
}

export interface AiAdvancedPlanTargetAmbiguity {
  readonly ambiguous: boolean;
  readonly reasons: ReadonlyArray<string>;
}

export interface AiAdvancedPlanTargetAlternative {
  readonly normalized_name: string;
  readonly notes?: string;
}

/**
 * A bounded semantic planning target. `source_text` is the authored (or sanitized
 * AI-1-query) wording the candidates are compared against; the optional blocks are
 * the canonical semantic reading of that wording. Nothing here grants authority.
 */
export interface AiAdvancedPlanTarget {
  readonly line_ref: string;
  readonly source_text: string;
  readonly semantic_food?: AiAdvancedPlanTargetSemanticFood;
  readonly search_phrases?: ReadonlyArray<string>;
  readonly ambiguity?: AiAdvancedPlanTargetAmbiguity;
  readonly alternatives?: ReadonlyArray<AiAdvancedPlanTargetAlternative>;
}

export type AiAdvancedPlanTargetFailureCode =
  | 'invalid_line_ref'
  | 'invalid_source_text'
  | 'invalid_semantic_food'
  | 'invalid_search_phrases'
  | 'invalid_ambiguity'
  | 'invalid_alternatives'
  | 'unknown_target_key'
  | 'unusable_interpretation'
  | 'duplicate_target'
  | 'missing_target'
  | 'unknown_target_line_ref'
  | 'invalid_fingerprint'
  | 'unknown_binding_key';

export type AiAdvancedPlanTargetResult =
  | { readonly ok: true; readonly target: AiAdvancedPlanTarget }
  | { readonly ok: false; readonly code: AiAdvancedPlanTargetFailureCode };

export type AiAdvancedPlanTargetsResult =
  | { readonly ok: true; readonly targets: ReadonlyArray<AiAdvancedPlanTarget> }
  | { readonly ok: false; readonly code: AiAdvancedPlanTargetFailureCode };

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/** Strict bounded token list: absent/malformed → undefined, never truncated. */
function readTokens(
  raw: unknown,
  maxCount: number,
  maxLength: number
): string[] | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return 'invalid';
  if (raw.length > maxCount) return 'invalid';
  const out: string[] = [];
  for (const value of raw) {
    const bounded = boundedText(value, maxLength);
    if (bounded === undefined) return 'invalid';
    out.push(bounded);
  }
  return out.length > 0 ? out : undefined;
}

/** Extracts the canonical semantic subset of an AI-1 interpretation (duck-typed). */
function semanticFromInterpretation(
  interpretation: Record<string, unknown>
): AiAdvancedPlanTargetSemanticFood | undefined | 'invalid' {
  const raw = interpretation['semantic_food'];
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) return 'invalid';

  let normalizedName: string | undefined;
  if (raw['normalized_name'] !== undefined && raw['normalized_name'] !== null) {
    normalizedName = boundedText(raw['normalized_name'], MAX_AI_ADVANCED_NAME_LENGTH);
    if (normalizedName === undefined) return 'invalid';
  }
  const modifiers = readTokens(raw['modifiers'], MAX_AI_ADVANCED_TOKENS, MAX_AI_ADVANCED_TOKEN_LENGTH);
  const preparation = readTokens(raw['preparation'], MAX_AI_ADVANCED_TOKENS, MAX_AI_ADVANCED_TOKEN_LENGTH);
  const state = readTokens(raw['state'], MAX_AI_ADVANCED_TOKENS, MAX_AI_ADVANCED_TOKEN_LENGTH);
  const qualifiers = readTokens(raw['qualifiers'], MAX_AI_ADVANCED_TOKENS, MAX_AI_ADVANCED_TOKEN_LENGTH);
  // Explicit narrowing (a loop over the four values does not narrow them).
  if (
    modifiers === 'invalid' ||
    preparation === 'invalid' ||
    state === 'invalid' ||
    qualifiers === 'invalid'
  ) {
    return 'invalid';
  }
  return Object.freeze({
    ...(normalizedName !== undefined ? { normalized_name: normalizedName } : {}),
    modifiers: Object.freeze(modifiers === undefined ? [] : modifiers),
    preparation: Object.freeze(preparation === undefined ? [] : preparation),
    state: Object.freeze(state === undefined ? [] : state),
    qualifiers: Object.freeze(qualifiers === undefined ? [] : qualifiers),
  });
}

function searchPhrasesFromInterpretation(
  interpretation: Record<string, unknown>
): ReadonlyArray<string> | undefined | 'invalid' {
  const raw = interpretation['search_phrases'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_AI_ADVANCED_SEARCH_PHRASES) return 'invalid';
  const out: string[] = [];
  for (const phrase of raw) {
    const bounded = boundedText(phrase, MAX_AI_ADVANCED_PHRASE_LENGTH);
    if (bounded === undefined) return 'invalid';
    out.push(bounded);
  }
  return out.length > 0 ? Object.freeze(out) : undefined;
}

function ambiguityFromInterpretation(
  interpretation: Record<string, unknown>
): AiAdvancedPlanTargetAmbiguity | undefined | 'invalid' {
  const raw = interpretation['ambiguity'];
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) return 'invalid';
  const ambiguous = raw['ambiguous'];
  if (typeof ambiguous !== 'boolean') return 'invalid';
  const rawReasons = raw['reasons'];
  const reasons: string[] = [];
  if (rawReasons !== undefined && rawReasons !== null) {
    if (!Array.isArray(rawReasons) || rawReasons.length > MAX_AI_ADVANCED_AMBIGUITY_REASONS) {
      return 'invalid';
    }
    for (const reason of rawReasons) {
      const bounded = boundedText(reason, MAX_AI_ADVANCED_TOKEN_LENGTH);
      if (bounded === undefined) return 'invalid';
      reasons.push(bounded);
    }
  }
  return Object.freeze({ ambiguous, reasons: Object.freeze(reasons) });
}

function alternativesFromInterpretation(
  interpretation: Record<string, unknown>
): ReadonlyArray<AiAdvancedPlanTargetAlternative> | undefined | 'invalid' {
  const raw = interpretation['alternatives'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_AI_ADVANCED_ALTERNATIVES) return 'invalid';
  const out: AiAdvancedPlanTargetAlternative[] = [];
  for (const alternative of raw) {
    if (!isPlainObject(alternative)) return 'invalid';
    // Closed shape at THIS depth too: an authority field nested inside an
    // alternative must not ride along (`fdc_id`, digests, grams, …).
    for (const key of Object.keys(alternative)) {
      if (key !== 'normalized_name' && key !== 'notes') return 'invalid';
    }
    const normalizedName = boundedText(alternative['normalized_name'], MAX_AI_ADVANCED_NAME_LENGTH);
    if (normalizedName === undefined) return 'invalid';
    let notes: string | undefined;
    if (alternative['notes'] !== undefined && alternative['notes'] !== null) {
      notes = boundedText(alternative['notes'], MAX_AI_ADVANCED_NOTE_LENGTH);
      if (notes === undefined) return 'invalid';
    }
    out.push(Object.freeze({ normalized_name: normalizedName, ...(notes ? { notes } : {}) }));
  }
  return out.length > 0 ? Object.freeze(out) : undefined;
}

/**
 * Builds ONE canonical planning target.
 *
 * `sourceText` is the wording the candidates are compared against (authored
 * ingredient text, or a sanitized AI-1 query — this module does not care which).
 * `interpretation`, when supplied, must be a SANITIZED AI-1 interpretation: only
 * its canonical semantic subset is copied, and any malformed subset fails the
 * whole target closed. Never throws.
 */
/**
 * CLOSURE 4 — CANONICAL AI-1 RE-SANITIZATION (no duck typing).
 *
 * A caller-supplied interpretation is NOT trusted by shape. It is passed through the
 * EXISTING canonical AI-1 sanitizer (`sanitizeAiAdvancedInterpretationResponse`) with
 * the EXACT expected `line_ref`, and only its canonical output is projected. This:
 *   - reuses the single canonical sanitizer (no second one is created);
 *   - makes the line binding canonical (`unknown_line_ref` for a foreign line_ref)
 *     rather than a hand-rolled string comparison;
 *   - rejects anything the AI-1 contract rejects — unknown keys, forbidden authority
 *     keys (`fdc_id`, digests, grams, nutrients, portion, Apply, persistence), a
 *     mismatched per-entry contract version, malformed semantic blocks, over-bound
 *     values, and every other canonical rule — BEFORE any field is projected.
 * An interpretation that merely LOOKS usable by duck typing therefore cannot reach a
 * target: canonical acceptance is the gate.
 */
function canonicalInterpretationFor(
  lineRef: string,
  raw: unknown
): { readonly ok: true; readonly interpretation: Record<string, unknown> } | { readonly ok: false } {
  const sanitized = sanitizeAiAdvancedInterpretationResponse(
    { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: [raw] },
    { allowedLineRefs: [lineRef] }
  );
  if (sanitized.ok !== true) return { ok: false };
  const interpretations = sanitized.interpretations;
  if (interpretations.length !== 1) return { ok: false };
  const interpretation = interpretations[0];
  if (interpretation === undefined) return { ok: false };
  return { ok: true, interpretation: interpretation as unknown as Record<string, unknown> };
}
export function buildAiAdvancedPlanTarget(input: {
  readonly lineRef: unknown;
  readonly sourceText: unknown;
  readonly interpretation?: unknown;
}): AiAdvancedPlanTargetResult {
  const lineRef = boundedText(input.lineRef, MAX_AI_ADVANCED_LINE_REF_LENGTH);
  if (lineRef === undefined) return { ok: false, code: 'invalid_line_ref' };
  const sourceText = boundedText(input.sourceText, MAX_AI_ADVANCED_DOCUMENT_TEXT);
  if (sourceText === undefined) return { ok: false, code: 'invalid_source_text' };

  if (input.interpretation === undefined || input.interpretation === null) {
    return { ok: true, target: Object.freeze({ line_ref: lineRef, source_text: sourceText }) };
  }
  // Closure 4: canonical AI-1 acceptance is the gate. Nothing is projected from the
  // raw input — and nothing is projected from the canonical output either, except the
  // semantic fields below (no amount/unit/count semantics, no confidence, no
  // grams/nutrients/portions, no database identity, no persistence, no Apply).
  const canonical = canonicalInterpretationFor(lineRef, input.interpretation);
  if (canonical.ok !== true) return { ok: false, code: 'unusable_interpretation' };
  const interpretation = canonical.interpretation;

  const semantic = semanticFromInterpretation(interpretation);
  if (semantic === 'invalid') return { ok: false, code: 'invalid_semantic_food' };
  const searchPhrases = searchPhrasesFromInterpretation(interpretation);
  if (searchPhrases === 'invalid') return { ok: false, code: 'invalid_search_phrases' };
  const ambiguity = ambiguityFromInterpretation(interpretation);
  if (ambiguity === 'invalid') return { ok: false, code: 'invalid_ambiguity' };
  const alternatives = alternativesFromInterpretation(interpretation);
  if (alternatives === 'invalid') return { ok: false, code: 'invalid_alternatives' };

  const hasSemantic =
    semantic !== undefined &&
    (semantic.normalized_name !== undefined ||
      semantic.modifiers.length > 0 ||
      semantic.preparation.length > 0 ||
      semantic.state.length > 0 ||
      semantic.qualifiers.length > 0);

  return {
    ok: true,
    target: Object.freeze({
      line_ref: lineRef,
      source_text: sourceText,
      ...(hasSemantic ? { semantic_food: semantic } : {}),
      ...(searchPhrases !== undefined ? { search_phrases: searchPhrases } : {}),
      ...(ambiguity !== undefined ? { ambiguity } : {}),
      ...(alternatives !== undefined ? { alternatives } : {}),
    }),
  };
}

/**
 * Strict reader for an ALREADY-BUILT target (transport / cross-boundary input):
 * closed keys at every level, canonical bounds, no authority field. Never throws.
 */
export function readAiAdvancedPlanTarget(raw: unknown): AiAdvancedPlanTargetResult {
  if (!isPlainObject(raw)) return { ok: false, code: 'unknown_target_key' };
  for (const key of Object.keys(raw)) {
    if (!(AI_ADVANCED_PLAN_TARGET_KEYS as ReadonlyArray<string>).includes(key)) {
      return { ok: false, code: 'unknown_target_key' };
    }
  }
  const lineRef = boundedText(raw['line_ref'], MAX_AI_ADVANCED_LINE_REF_LENGTH);
  if (lineRef === undefined) return { ok: false, code: 'invalid_line_ref' };
  const sourceText = boundedText(raw['source_text'], MAX_AI_ADVANCED_DOCUMENT_TEXT);
  if (sourceText === undefined) return { ok: false, code: 'invalid_source_text' };

  let semantic: AiAdvancedPlanTargetSemanticFood | undefined;
  if (raw['semantic_food'] !== undefined && raw['semantic_food'] !== null) {
    if (!isPlainObject(raw['semantic_food'])) return { ok: false, code: 'invalid_semantic_food' };
    const semanticRaw = raw['semantic_food'];
    for (const key of Object.keys(semanticRaw)) {
      if (!(AI_ADVANCED_PLAN_TARGET_SEMANTIC_KEYS as ReadonlyArray<string>).includes(key)) {
        return { ok: false, code: 'unknown_target_key' };
      }
    }
    let normalizedName: string | undefined;
    if (semanticRaw['normalized_name'] !== undefined && semanticRaw['normalized_name'] !== null) {
      normalizedName = boundedText(semanticRaw['normalized_name'], MAX_AI_ADVANCED_NAME_LENGTH);
      if (normalizedName === undefined) return { ok: false, code: 'invalid_semantic_food' };
    }
    const parsed: string[][] = [];
    for (const key of ['modifiers', 'preparation', 'state', 'qualifiers']) {
      const tokens = readTokens(semanticRaw[key], MAX_AI_ADVANCED_TOKENS, MAX_AI_ADVANCED_TOKEN_LENGTH);
      if (tokens === 'invalid') return { ok: false, code: 'invalid_semantic_food' };
      parsed.push(tokens === undefined ? [] : tokens);
    }
    semantic = Object.freeze({
      ...(normalizedName !== undefined ? { normalized_name: normalizedName } : {}),
      modifiers: Object.freeze(parsed[0]!),
      preparation: Object.freeze(parsed[1]!),
      state: Object.freeze(parsed[2]!),
      qualifiers: Object.freeze(parsed[3]!),
    });
  }

  let searchPhrases: ReadonlyArray<string> | undefined;
  if (raw['search_phrases'] !== undefined && raw['search_phrases'] !== null) {
    const parsed = searchPhrasesFromInterpretation({ search_phrases: raw['search_phrases'] });
    if (parsed === 'invalid') return { ok: false, code: 'invalid_search_phrases' };
    searchPhrases = parsed;
  }

  let ambiguity: AiAdvancedPlanTargetAmbiguity | undefined;
  if (raw['ambiguity'] !== undefined && raw['ambiguity'] !== null) {
    if (!isPlainObject(raw['ambiguity'])) return { ok: false, code: 'invalid_ambiguity' };
    for (const key of Object.keys(raw['ambiguity'])) {
      if (key !== 'ambiguous' && key !== 'reasons') return { ok: false, code: 'unknown_target_key' };
    }
    const parsed = ambiguityFromInterpretation({ ambiguity: raw['ambiguity'] });
    if (parsed === 'invalid') return { ok: false, code: 'invalid_ambiguity' };
    ambiguity = parsed;
  }

  let alternatives: ReadonlyArray<AiAdvancedPlanTargetAlternative> | undefined;
  if (raw['alternatives'] !== undefined && raw['alternatives'] !== null) {
    const parsed = alternativesFromInterpretation({ alternatives: raw['alternatives'] });
    if (parsed === 'invalid') return { ok: false, code: 'invalid_alternatives' };
    alternatives = parsed;
  }

  return {
    ok: true,
    target: Object.freeze({
      line_ref: lineRef,
      source_text: sourceText,
      ...(semantic !== undefined ? { semantic_food: semantic } : {}),
      ...(searchPhrases !== undefined ? { search_phrases: searchPhrases } : {}),
      ...(ambiguity !== undefined ? { ambiguity } : {}),
      ...(alternatives !== undefined ? { alternatives } : {}),
    }),
  };
}

/**
 * Builds MANY targets from caller input (`{ lineRef, sourceText, interpretation? }`
 * rows) with duplicate detection. Used by the application to construct the
 * planning targets for a request context.
 */
export function buildAiAdvancedPlanTargets(rawInputs: unknown): AiAdvancedPlanTargetsResult {
  if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
    return { ok: false, code: 'missing_target' };
  }
  const targets: AiAdvancedPlanTarget[] = [];
  const seen = new Set<string>();
  for (const entry of rawInputs) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_source_text' };
    for (const key of Object.keys(entry)) {
      if (key !== 'lineRef' && key !== 'sourceText' && key !== 'interpretation') {
        return { ok: false, code: 'unknown_target_key' };
      }
    }
    const built = buildAiAdvancedPlanTarget({
      lineRef: entry['lineRef'],
      sourceText: entry['sourceText'],
      ...(entry['interpretation'] !== undefined ? { interpretation: entry['interpretation'] } : {}),
    });
    if (built.ok !== true) return { ok: false, code: built.code };
    if (seen.has(built.target.line_ref)) return { ok: false, code: 'duplicate_target' };
    seen.add(built.target.line_ref);
    targets.push(built.target);
  }
  return { ok: true, targets: Object.freeze(targets) };
}

/**
 * Sanitizes a target ARRAY against the EXACT line refs of a request. The model must
 * never be asked to select for a line whose target is missing, duplicated, or
 * unknown, so coverage is exact and the returned order is deterministic.
 */
export function sanitizeAiAdvancedPlanTargets(
  raw: unknown,
  allowedLineRefs: ReadonlyArray<string>
): AiAdvancedPlanTargetsResult {
  if (!Array.isArray(raw)) return { ok: false, code: 'missing_target' };
  const byLine = new Map<string, AiAdvancedPlanTarget>();
  for (const entry of raw) {
    const read = readAiAdvancedPlanTarget(entry);
    if (read.ok !== true) return { ok: false, code: read.code };
    if (byLine.has(read.target.line_ref)) return { ok: false, code: 'duplicate_target' };
    byLine.set(read.target.line_ref, read.target);
  }
  const targets: AiAdvancedPlanTarget[] = [];
  for (const lineRef of allowedLineRefs) {
    const target = byLine.get(lineRef);
    if (target === undefined) return { ok: false, code: 'missing_target' };
    byLine.delete(lineRef);
    targets.push(target);
  }
  if (byLine.size > 0) return { ok: false, code: 'unknown_target_line_ref' };
  return { ok: true, targets: Object.freeze(targets) };
}

/**
 * CLOSURE 2 — LOCAL INTERPRETATION FINGERPRINT BINDING.
 *
 * A target derived from an AI-1 interpretation must be able to RETAIN that
 * interpretation's fingerprint, because the fingerprint is the only thing that binds
 * a plan back to the interpretation it was built against: AI-2A's acceptance port
 * refuses a source whose `interpretation_fingerprint` no longer matches the current
 * interpretation (`stale_interpretation`). Without retention, that binding is lost on
 * the target path and AI-2C would have nothing to compare.
 *
 * LOCAL means local: the fingerprint is metadata ABOUT the target, never part of it.
 * It therefore lives beside the target and is not reachable from the provider-facing
 * payload — `interpretation_fingerprint` is not a target key, so the transport and the
 * prompt (both built from `target` alone) cannot carry it. The value itself is
 * caller-supplied and bounded exactly as AI-2A bounds it (the fingerprint is a
 * contract-computed value; AI-2B never invents or recomputes one).
 *
 * Closed key set, so a binding cannot smuggle an authority field either.
 */
export const AI_ADVANCED_PLAN_TARGET_BINDING_KEYS = Object.freeze([
  'target',
  'interpretation_fingerprint',
]);

export interface AiAdvancedPlanTargetBinding {
  readonly target: AiAdvancedPlanTarget;
  /** Fingerprint of the AI-1 interpretation the target came from, when there is one. */
  readonly interpretation_fingerprint?: string;
}

export type AiAdvancedPlanTargetBindingResult =
  | { readonly ok: true; readonly binding: AiAdvancedPlanTargetBinding }
  | { readonly ok: false; readonly code: AiAdvancedPlanTargetFailureCode };

/**
 * Builds a target and locally binds it to the AI-1 interpretation fingerprint it came
 * from (omitted for an authored-wording target: there is no interpretation to bind).
 */
export function buildAiAdvancedPlanTargetBinding(input: {
  readonly lineRef: unknown;
  readonly sourceText: unknown;
  readonly interpretation?: unknown;
  readonly interpretationFingerprint?: unknown;
}): AiAdvancedPlanTargetBindingResult {
  const built = buildAiAdvancedPlanTarget({
    lineRef: input.lineRef,
    sourceText: input.sourceText,
    ...(input.interpretation !== undefined ? { interpretation: input.interpretation } : {}),
  });
  if (built.ok !== true) return { ok: false, code: built.code };

  let fingerprint: string | undefined;
  if (input.interpretationFingerprint !== undefined && input.interpretationFingerprint !== null) {
    const bounded = boundedText(input.interpretationFingerprint, MAX_AI_ADVANCED_FINGERPRINT_LENGTH);
    if (bounded === undefined) return { ok: false, code: 'invalid_fingerprint' };
    fingerprint = bounded;
  }

  return {
    ok: true,
    binding: Object.freeze({
      target: built.target,
      ...(fingerprint !== undefined ? { interpretation_fingerprint: fingerprint } : {}),
    }),
  };
}

/**
 * Strict reader for a binding: closed keys, a canonical target, a bounded fingerprint.
 * Never recomputes a fingerprint — a bound value is echoed or the whole binding is
 * rejected.
 */
export function readAiAdvancedPlanTargetBinding(value: unknown): AiAdvancedPlanTargetBindingResult {
  if (!isPlainObject(value)) return { ok: false, code: 'unknown_binding_key' };
  for (const key of Object.keys(value)) {
    if (!(AI_ADVANCED_PLAN_TARGET_BINDING_KEYS as ReadonlyArray<string>).includes(key)) {
      return { ok: false, code: 'unknown_binding_key' };
    }
  }
  const target = readAiAdvancedPlanTarget(value['target']);
  if (target.ok !== true) return { ok: false, code: target.code };

  let fingerprint: string | undefined;
  const raw = value['interpretation_fingerprint'];
  if (raw !== undefined && raw !== null) {
    const bounded = boundedText(raw, MAX_AI_ADVANCED_FINGERPRINT_LENGTH);
    if (bounded === undefined) return { ok: false, code: 'invalid_fingerprint' };
    fingerprint = bounded;
  }
  return {
    ok: true,
    binding: Object.freeze({
      target: target.target,
      ...(fingerprint !== undefined ? { interpretation_fingerprint: fingerprint } : {}),
    }),
  };
}
