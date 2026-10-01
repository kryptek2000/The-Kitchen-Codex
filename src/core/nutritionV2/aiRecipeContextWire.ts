/**
 * The Kitchen Codex — Advanced Nutrition AI-4C: canonical recipe-context WIRE
 * shape.
 *
 * PURE, platform-neutral, provider-free. ONE owner for the AI-4 transport
 * RESPONSE representation, shared by the server adapter and any future
 * application-side consumer (AI-4D) so the two sides cannot drift.
 *
 * WHAT THE WIRE CARRIES
 *   - `request_version` / `request_id` — transport identity, echoed from the
 *     SERVER-VALIDATED request and never a model-produced value.
 *   - `context_binding` — the AI-4C DETERMINISTIC CONTEXT BINDING of the exact
 *     provider-facing semantic payload that was sent (line refs, authored text,
 *     food phrases, target order, contract version, recipe-instance identity).
 *     It is a freshness/equality binding for AI-4D, computed locally by
 *     deterministic code. It is NOT authenticated nutrition provenance and can
 *     never make `ai_recipe_context` an authenticated class.
 *     It is ONE value with ONE owner (`aiRecipeContextModelInputBinding`): AI-4A's
 *     separate envelope snapshot binding is deliberately not shipped here,
 *     because it does not cover every model-visible field and two competing
 *     "context bindings" would be ambiguous.
 *   - `proposal` — the AI-4A canonical proposal, rebuilt entry-by-entry.
 *
 * WHAT THE WIRE CANNOT CARRY
 *   No grams, fraction, nutrient, FDC id, portion, serving, digest, release or
 *   catalog pin, credential, persistence, Apply, suppression or effective-mass
 *   field. Those are refused by AI-4A's proposal sanitizer before this module
 *   ever runs, and re-checked by the strict reader below.
 *
 * The builder reconstructs every interpretation FIELD-BY-FIELD from an explicit
 * key list rather than spreading, so a future property added to an internal
 * interpretation type can never silently reach the wire. The reader re-validates
 * the closed key sets, the closed vocabularies and the opaque line-ref set, so
 * an untrusted wire payload cannot be mistaken for a validated one.
 */

import { isPlainObject } from './schema';
import {
  AI_RECIPE_CONTEXT_ABSTAIN_REASONS,
  AI_RECIPE_CONTEXT_CONFIDENCE_VALUES,
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
  AI_RECIPE_CONTEXT_RELATIONS,
  AI_RECIPE_CONTEXT_ROLES,
  AI_RECIPE_CONTEXT_PREPARATION_HINTS,
  MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH,
  MAX_RECIPE_CONTEXT_LINE_REF_LENGTH,
  MAX_RECIPE_CONTEXT_PREPARATION_HINT_LENGTH,
  MAX_RECIPE_CONTEXT_RELATIONS,
  MAX_RECIPE_CONTEXT_RELATION_TARGETS,
  MAX_RECIPE_CONTEXT_TARGETS,
  type AiRecipeContextInterpretation,
  type AiRecipeContextProposal,
  type AiRecipeContextRelation,
  type AiRecipeContextRelationKind,
} from './phase4/recipeContextContract';
import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from './aiRecipeContextRequest';

/** Envelope keys of the AI-4 transport response. */
export const AI_RECIPE_CONTEXT_WIRE_ENVELOPE_KEYS = Object.freeze([
  'request_version',
  'request_id',
  'context_binding',
  'proposal',
] as const);

/** Wire keys of one interpretation entry. */
export const AI_RECIPE_CONTEXT_WIRE_INTERPRETATION_KEYS = Object.freeze([
  'line_ref',
  'role',
  'relations',
  'preparation_hints',
  'confidence',
  'abstain_reason',
  'explanation',
] as const);

/** Wire keys of one relation. */
export const AI_RECIPE_CONTEXT_WIRE_RELATION_KEYS = Object.freeze(['kind', 'target_ref'] as const);

/** Wire keys of the embedded proposal envelope. */
export const AI_RECIPE_CONTEXT_WIRE_PROPOSAL_KEYS = Object.freeze([
  'contract_version',
  'provenance_class',
] as const);

export interface AiRecipeContextWireRelation {
  readonly kind: AiRecipeContextRelationKind;
  readonly target_ref: string;
}

export interface AiRecipeContextWireInterpretation {
  readonly line_ref: string;
  readonly role: (typeof AI_RECIPE_CONTEXT_ROLES)[number];
  readonly relations: ReadonlyArray<AiRecipeContextWireRelation>;
  readonly preparation_hints: ReadonlyArray<string>;
  readonly confidence?: (typeof AI_RECIPE_CONTEXT_CONFIDENCE_VALUES)[number];
  readonly abstain_reason?: (typeof AI_RECIPE_CONTEXT_ABSTAIN_REASONS)[number];
  readonly explanation?: string;
}

export interface AiRecipeContextWireProposal {
  readonly contract_version: typeof AI_RECIPE_CONTEXT_CONTRACT_VERSION;
  readonly provenance_class: typeof AI_RECIPE_CONTEXT_PROVENANCE_CLASS;
  readonly interpretations: ReadonlyArray<AiRecipeContextWireInterpretation>;
}

/**
 * The AI-4 transport response. INERT: it is a proposal plus its binding, and it
 * grants no identity, mass, nutrient, eligibility, persistence or Apply authority.
 */
export interface AiRecipeContextWirePayload {
  readonly request_version: typeof AI_RECIPE_CONTEXT_REQUEST_VERSION;
  readonly request_id: string;
  /**
   * The AI-4C deterministic context binding of the SENT model input. Local,
   * never model-produced, never a nutrition provenance claim.
   */
  readonly context_binding: string;
  readonly proposal: AiRecipeContextWireProposal;
}

export type AiRecipeContextWireFailureCode =
  | 'invalid_response'
  | 'unsupported_request_version'
  | 'unknown_line_ref';

export type AiRecipeContextWireReadResult =
  | { readonly ok: true; readonly payload: AiRecipeContextWirePayload }
  | { readonly ok: false; readonly code: AiRecipeContextWireFailureCode };

const REQUEST_ID_MAX_LENGTH = 120;
const CONTEXT_BINDING_MAX_LENGTH = 80;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function oneOf(value: unknown, vocabulary: ReadonlyArray<string>): string | undefined {
  const text = boundedText(value, MAX_RECIPE_CONTEXT_PREPARATION_HINT_LENGTH);
  if (text === undefined) return undefined;
  return (vocabulary as ReadonlyArray<string>).includes(text) ? text : undefined;
}

/**
 * Rebuilds an AI-4A canonical proposal into the wire proposal, field-by-field.
 * Optional fields are copied only when present, so no `undefined` is serialized
 * and no unlisted property can appear.
 */
export function toAiRecipeContextWireProposal(
  proposal: AiRecipeContextProposal
): AiRecipeContextWireProposal {
  const interpretations: AiRecipeContextWireInterpretation[] = proposal.interpretations.map(
    (entry: AiRecipeContextInterpretation) =>
      Object.freeze({
        line_ref: entry.line_ref,
        role: entry.role,
        relations: Object.freeze(
          entry.relations.map((relation: AiRecipeContextRelation) =>
            Object.freeze({ kind: relation.kind, target_ref: relation.target_ref })
          )
        ),
        preparation_hints: Object.freeze([...entry.preparation_hints]),
        ...(entry.confidence === undefined ? {} : { confidence: entry.confidence }),
        ...(entry.abstain_reason === undefined ? {} : { abstain_reason: entry.abstain_reason }),
        ...(entry.explanation === undefined ? {} : { explanation: entry.explanation }),
      })
  );
  return Object.freeze({
    contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
    provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
    interpretations: Object.freeze(interpretations),
  });
}

/** Builds the complete transport response from a validated proposal + local ids. */
export function toAiRecipeContextWirePayload(input: {
  readonly requestId: string;
  readonly contextBinding: string;
  readonly proposal: AiRecipeContextProposal;
}): AiRecipeContextWirePayload {
  return Object.freeze({
    request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    request_id: input.requestId,
    context_binding: input.contextBinding,
    proposal: toAiRecipeContextWireProposal(input.proposal),
  });
}

/**
 * Strict reader for an untrusted AI-4 transport response. Never throws.
 *
 * When `allowedLineRefs` is supplied, every `line_ref` AND every relation
 * `target_ref` must be inside it, so a payload that names an invented target
 * fails closed even if it was produced by a trusted-looking caller.
 */
export function readAiRecipeContextWirePayload(
  raw: unknown,
  options: { readonly allowedLineRefs?: ReadonlyArray<string> } = {}
): AiRecipeContextWireReadResult {
  if (!isPlainObject(raw)) return { ok: false, code: 'invalid_response' };
  for (const key of Object.keys(raw)) {
    if (!(AI_RECIPE_CONTEXT_WIRE_ENVELOPE_KEYS as ReadonlyArray<string>).includes(key)) {
      return { ok: false, code: 'invalid_response' };
    }
  }
  if (raw['request_version'] !== AI_RECIPE_CONTEXT_REQUEST_VERSION) {
    return { ok: false, code: 'unsupported_request_version' };
  }
  const requestId = boundedText(raw['request_id'], REQUEST_ID_MAX_LENGTH);
  if (requestId === undefined) return { ok: false, code: 'invalid_response' };
  const contextBinding = boundedText(raw['context_binding'], CONTEXT_BINDING_MAX_LENGTH);
  if (contextBinding === undefined) return { ok: false, code: 'invalid_response' };

  const allowed = new Set<string>();
  if (Array.isArray(options.allowedLineRefs)) {
    for (const ref of options.allowedLineRefs) {
      if (typeof ref === 'string' && ref.length > 0) allowed.add(ref);
    }
  }

  const proposalRaw = raw['proposal'];
  if (!isPlainObject(proposalRaw)) return { ok: false, code: 'invalid_response' };
  for (const key of Object.keys(proposalRaw)) {
    if (
      key !== 'interpretations' &&
      !(AI_RECIPE_CONTEXT_WIRE_PROPOSAL_KEYS as ReadonlyArray<string>).includes(key)
    ) {
      return { ok: false, code: 'invalid_response' };
    }
  }
  if (proposalRaw['contract_version'] !== AI_RECIPE_CONTEXT_CONTRACT_VERSION) {
    return { ok: false, code: 'invalid_response' };
  }
  // A forged stronger provenance class is an authority forgery, not a typo.
  if (proposalRaw['provenance_class'] !== AI_RECIPE_CONTEXT_PROVENANCE_CLASS) {
    return { ok: false, code: 'invalid_response' };
  }

  const rawInterpretations = proposalRaw['interpretations'];
  if (!Array.isArray(rawInterpretations)) return { ok: false, code: 'invalid_response' };
  if (rawInterpretations.length > MAX_RECIPE_CONTEXT_TARGETS) {
    return { ok: false, code: 'invalid_response' };
  }

  const seen = new Set<string>();
  const interpretations: AiRecipeContextWireInterpretation[] = [];
  for (const entry of rawInterpretations) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_response' };
    for (const key of Object.keys(entry)) {
      if (
        !(AI_RECIPE_CONTEXT_WIRE_INTERPRETATION_KEYS as ReadonlyArray<string>).includes(key)
      ) {
        return { ok: false, code: 'invalid_response' };
      }
    }
    const lineRef = boundedText(entry['line_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
    if (lineRef === undefined) return { ok: false, code: 'invalid_response' };
    if (allowed.size > 0 && !allowed.has(lineRef)) {
      return { ok: false, code: 'unknown_line_ref' };
    }
    if (seen.has(lineRef)) return { ok: false, code: 'invalid_response' };
    seen.add(lineRef);

    const role = oneOf(entry['role'], AI_RECIPE_CONTEXT_ROLES);
    if (role === undefined) return { ok: false, code: 'invalid_response' };

    const rawRelations = entry['relations'];
    if (!Array.isArray(rawRelations) || rawRelations.length > MAX_RECIPE_CONTEXT_RELATIONS) {
      return { ok: false, code: 'invalid_response' };
    }
    const relations: AiRecipeContextWireRelation[] = [];
    for (const rawRelation of rawRelations) {
      if (!isPlainObject(rawRelation)) return { ok: false, code: 'invalid_response' };
      for (const key of Object.keys(rawRelation)) {
        if (!(AI_RECIPE_CONTEXT_WIRE_RELATION_KEYS as ReadonlyArray<string>).includes(key)) {
          return { ok: false, code: 'invalid_response' };
        }
      }
      const kind = oneOf(rawRelation['kind'], AI_RECIPE_CONTEXT_RELATIONS);
      if (kind === undefined) return { ok: false, code: 'invalid_response' };
      const targetRef = boundedText(
        rawRelation['target_ref'],
        MAX_RECIPE_CONTEXT_LINE_REF_LENGTH
      );
      if (targetRef === undefined) return { ok: false, code: 'invalid_response' };
      if (allowed.size > 0 && !allowed.has(targetRef)) {
        return { ok: false, code: 'unknown_line_ref' };
      }
      if (relations.length >= MAX_RECIPE_CONTEXT_RELATION_TARGETS) {
        return { ok: false, code: 'invalid_response' };
      }
      relations.push(Object.freeze({ kind: kind as AiRecipeContextRelationKind, target_ref: targetRef }));
    }

    const rawHints = entry['preparation_hints'];
    if (!Array.isArray(rawHints)) return { ok: false, code: 'invalid_response' };
    const preparationHints: string[] = [];
    for (const hint of rawHints) {
      const bounded = boundedText(hint, MAX_RECIPE_CONTEXT_PREPARATION_HINT_LENGTH);
      if (bounded === undefined) return { ok: false, code: 'invalid_response' };
      if (!(AI_RECIPE_CONTEXT_PREPARATION_HINTS as ReadonlyArray<string>).includes(bounded)) {
        return { ok: false, code: 'invalid_response' };
      }
      preparationHints.push(bounded);
    }

    let confidence: string | undefined;
    if (entry['confidence'] !== undefined && entry['confidence'] !== null) {
      confidence = oneOf(entry['confidence'], AI_RECIPE_CONTEXT_CONFIDENCE_VALUES);
      if (confidence === undefined) return { ok: false, code: 'invalid_response' };
    }
    let abstainReason: string | undefined;
    if (entry['abstain_reason'] !== undefined && entry['abstain_reason'] !== null) {
      abstainReason = oneOf(entry['abstain_reason'], AI_RECIPE_CONTEXT_ABSTAIN_REASONS);
      if (abstainReason === undefined) return { ok: false, code: 'invalid_response' };
    }
    let explanation: string | undefined;
    if (entry['explanation'] !== undefined && entry['explanation'] !== null) {
      explanation = boundedText(entry['explanation'], MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH);
      if (explanation === undefined) return { ok: false, code: 'invalid_response' };
    }

    interpretations.push(
      Object.freeze({
        line_ref: lineRef,
        role: role as (typeof AI_RECIPE_CONTEXT_ROLES)[number],
        relations: Object.freeze(relations),
        preparation_hints: Object.freeze(preparationHints),
        ...(confidence === undefined ? {} : { confidence: confidence as (typeof AI_RECIPE_CONTEXT_CONFIDENCE_VALUES)[number] }),
        ...(abstainReason === undefined
          ? {}
          : { abstain_reason: abstainReason as (typeof AI_RECIPE_CONTEXT_ABSTAIN_REASONS)[number] }),
        ...(explanation === undefined ? {} : { explanation }),
      })
    );
  }

  return {
    ok: true,
    payload: Object.freeze({
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: requestId,
      context_binding: contextBinding,
      proposal: Object.freeze({
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations: Object.freeze(interpretations),
      }),
    }),
  };
}
