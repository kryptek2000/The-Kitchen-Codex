/**
 * The Kitchen Codex — Advanced Nutrition AI-4C: bounded recipe-context
 * TRANSPORT REQUEST (provider-facing projection).
 *
 * PURE, platform-neutral, provider-free. This module owns ONE thing: the exact,
 * bounded payload an AI-4 whole-recipe interpretation is allowed to send. It
 * never calls a provider, never reads a recipe, never persists and never grants
 * authority.
 *
 * THE DETERMINISTIC SELECTION RULE (load-bearing)
 * ----------------------------------------------
 *  The MODEL DOES NOT CHOOSE WHICH RECIPE LINES IT RECEIVES. Deterministic code
 *  chooses the bounded context slice BEFORE any provider invocation: the only
 *  lines that can reach a provider are the lines already selected and sanitized
 *  by AI-4A's `RecipeContextEnvelope` (built by AI-4B's deterministic extractor).
 *  A provider can neither widen the slice nor see the original recipe object.
 *
 * DATA MINIMIZATION (the ONLY material that may leave the boundary)
 * ----------------------------------------------------------------
 *  `line_ref`, `source_text` and `food_semantics` — nothing else. Deliberately
 *  NOT sent, each for a stated reason:
 *    - `title`            — a whole-recipe identity claim is not needed for the
 *                           line-local semantic task, and the model may not
 *                           author a whole-recipe fact.
 *    - `base_servings`    — the model must never do serving arithmetic; sending a
 *                           serving count could only invite it.
 *    - `instruction_slots`— opaque local change-detector digests, meaningless to a
 *                           model and pure local bookkeeping.
 *    - `provenance_class` — an output-side label, not request input.
 *  There is no field anywhere on this payload for an FDC id, a USDA record, a
 *  nutrient value, a gram, a fraction, a portion, a digest, a release/catalog/
 *  nutrient-map/calculation pin, a credential, a session secret or any
 *  persistence/Apply/effective-mass/AI-3 state. The build is a field-by-field
 *  reconstruction from an explicit key list, never a spread, so no other
 *  property of the envelope can leak in.
 *
 * BOUNDS
 *  - At most `MAX_AI_RECIPE_CONTEXT_REQUEST_LINES` context lines. The value is
 *    NOT a second owner: it IS AI-4A's `MAX_RECIPE_CONTEXT_TARGETS`, so the
 *    transport can never widen the established contract envelope.
 *  - A hard 32 KiB UTF-8 cap on the serialized provider payload. Over the cap is
 *    `request_too_large` with ZERO provider calls: an oversized semantic payload
 *    is REFUSED, never silently truncated, because truncation could change what
 *    the model is being asked about.
 *  - A bounded, pattern-checked `request_id` (transport identity only, echoed
 *    back by the server and never sent to the model) and an optional opaque
 *    `recipe_instance` token for AI-4A snapshot binding (LOCAL ONLY, never sent).
 *
 * THE DETERMINISTIC CONTEXT BINDING (one owner, one claim)
 * ---------------------------------------------------------
 *  `aiRecipeContextModelInputBinding` binds the EXACT provider-facing semantic
 *  payload PLUS the local recipe-instance identity. If any model-visible datum
 *  changes — a line ref, the authored text, the food phrase, the target ORDER, the
 *  contract version, or the instance identity — the binding changes.
 *
 *  WHAT IT DOES AND DOES NOT AUTHENTICATE
 *   - It DOES bind equality/freshness of the DETERMINISTIC CONTEXT that was
 *     interpreted: "this interpretation is about exactly these targets, in this
 *     order, with these phrases, for this recipe instance".
 *   - It does NOT authenticate nutrition provenance, food identity, or any
 *     quantity. The AI-4 provenance class remains non-authenticated
 *     (`ai_recipe_context`), and no binding can ever make it `usda_derived` or
 *     `vetted_standard`.
 *   - It is NOT a signature over the recipe's truth: the recipe text is authored
 *     by the user and is untrusted DATA. The binding proves which derived context
 *     the model read, not that the words are objectively correct.
 *
 *  AI-4A's own envelope snapshot binding is deliberately NOT reused here: it binds
 *  the AI-4A envelope (`source_text` + `instruction_slots`) and does NOT include
 *  `food_semantics`, which IS visible to the model. Carrying both would create two
 *  competing claims about "the context that was interpreted", so this module is the
 *  single owner of the AI-4 context binding and AI-4C does not ship a second one.
 *
 * REQUEST VERSION
 *  `request_version` is a GENUINE protocol discriminator: the caller must supply
 *  the exact supported version, an absent or different version is refused, and the
 *  built context echoes the validated version. It is never accepted and ignored.
 */

import { utf8ByteLength } from './schema';
import { canonicalStringify, sha256Hex } from './usda/digest';
import {
  AI_RECIPE_CONTEXT_ABSTAIN_REASONS,
  AI_RECIPE_CONTEXT_CONFIDENCE_VALUES,
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PREPARATION_HINTS,
  AI_RECIPE_CONTEXT_RELATIONS,
  AI_RECIPE_CONTEXT_ROLES,
  MAX_RECIPE_CONTEXT_TARGETS,
  sanitizeRecipeContextEnvelope,
  type RecipeContextEnvelope,
} from './phase4/recipeContextContract';
import { MAX_RECIPE_CONTEXT_INSTANCES_TOKEN } from './phase4/recipeContextSnapshot';

/** Closed transport-request version token. Exact match required; a genuine
 * protocol discriminator, never an accepted-and-ignored field. */
export const AI_RECIPE_CONTEXT_REQUEST_VERSION = 'nutrition_ai_recipe_context_request_v1' as const;

/**
 * The closed version token of the deterministic CONTEXT BINDING payload shape.
 *
 * It is distinct from the AI-4A contract version and from the request version on
 * purpose: the binding's payload shape may evolve independently, and a binding
 * must never be silently reinterpreted under a different shape.
 */
export const AI_RECIPE_CONTEXT_BINDING_VERSION = 'nutrition_ai_recipe_context_binding_v1' as const;

/**
 * Maximum context lines one AI-4 request may carry. Deliberately the SAME
 * number AI-4A already bounds an envelope to: AI-4C cannot widen it.
 */
export const MAX_AI_RECIPE_CONTEXT_REQUEST_LINES = MAX_RECIPE_CONTEXT_TARGETS;

/** Hard UTF-8 serialized cap for the provider-facing request payload. */
export const MAX_AI_RECIPE_CONTEXT_REQUEST_BYTES = 32 * 1024;

/** Bounded transport request identity (local; never sent to the model). */
export const MAX_AI_RECIPE_CONTEXT_REQUEST_ID_LENGTH = 120;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** One bounded context line, in its MINIMAL provider-facing form. */
export interface AiRecipeContextProviderTarget {
  readonly line_ref: string;
  readonly source_text: string;
  readonly food_semantics?: string;
}

/**
 * The COMPLETE model-facing request. This object is byte-for-byte what the
 * provider receives as its data block, and it is the object the 32 KiB cap is
 * measured against.
 */
export interface AiRecipeContextProviderRequest {
  readonly contract_version: typeof AI_RECIPE_CONTEXT_CONTRACT_VERSION;
  readonly targets: ReadonlyArray<AiRecipeContextProviderTarget>;
}

export interface AiRecipeContextRequestContext {
  readonly request_version: typeof AI_RECIPE_CONTEXT_REQUEST_VERSION;
  /** Transport identity only. Never sent to the model, never model-produced. */
  readonly request_id: string;
  readonly provider_request: AiRecipeContextProviderRequest;
  /** Measured UTF-8 byte length of the serialized `provider_request`. */
  readonly provider_request_bytes: number;
  /**
   * The EXACT line refs this request issued. Nothing else is a legal reference
   * in a response, so an invented target cannot survive validation.
   */
  readonly allowed_line_refs: ReadonlyArray<string>;
  /** LOCAL ONLY. Opaque caller token; never a file name, never sent. */
  readonly recipe_instance: string | null;
  /**
   * The DETERMINISTIC CONTEXT BINDING (`sha256:<hex>`) over the exact
   * provider-facing semantic payload plus the local instance identity.
   *
   * It is a freshness/equality binding, NOT authenticated nutrition provenance.
   * AI-4C carries it; AI-4D compares it against the current re-derived context.
   */
  readonly model_input_binding: string;
}

/**
 * The canonical payload the context binding is derived from: the EXACT
 * provider-facing targets (in order, including `food_semantics`) plus the local
 * instance identity. Key order is load-bearing; nothing else may participate.
 */
export function aiRecipeContextModelInputPayload(input: {
  readonly providerRequest: AiRecipeContextProviderRequest;
  readonly recipeInstance: string | null;
}): Record<string, unknown> {
  return {
    binding: AI_RECIPE_CONTEXT_BINDING_VERSION,
    contract_version: input.providerRequest.contract_version,
    recipe_instance: input.recipeInstance,
    targets: input.providerRequest.targets.map((target) => ({
      line: target.line_ref,
      text: target.source_text,
      ...(target.food_semantics === undefined ? {} : { semantics: target.food_semantics }),
    })),
  };
}

/**
 * The ONE deterministic context binding for AI-4. Any change to a model-visible
 * datum — a line ref, the authored text, the food phrase, target ORDER, the
 * contract version or the instance identity — changes this value.
 */
export function aiRecipeContextModelInputBinding(input: {
  readonly providerRequest: AiRecipeContextProviderRequest;
  readonly recipeInstance: string | null;
}): string {
  return `sha256:${sha256Hex(canonicalStringify(aiRecipeContextModelInputPayload(input)))}`;
}

export type AiRecipeContextRequestFailureCode =
  | 'unsupported_request_version'
  | 'invalid_request_id'
  /** The AI-4A envelope sanitizer refused the supplied context. */
  | 'invalid_context'
  | 'no_targets'
  | 'too_many_targets'
  | 'request_too_large';

export type AiRecipeContextRequestResult =
  | { readonly ok: true; readonly context: AiRecipeContextRequestContext }
  | { readonly ok: false; readonly code: AiRecipeContextRequestFailureCode };

function boundedRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AI_RECIPE_CONTEXT_REQUEST_ID_LENGTH) return undefined;
  if (!REQUEST_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function boundedInstance(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_RECIPE_CONTEXT_INSTANCES_TOKEN) return undefined;
  return trimmed;
}

/**
 * Projects ONE sanitized envelope target into its minimal provider view. The
 * explicit key list is the whole minimization guarantee: no other property of the
 * target (and no property of the envelope) can appear in the request.
 */
function providerTargetFrom(
  target: RecipeContextEnvelope['targets'][number]
): AiRecipeContextProviderTarget {
  return Object.freeze({
    line_ref: target.line_ref,
    source_text: target.source_text,
    ...(target.food_semantics === undefined ? {} : { food_semantics: target.food_semantics }),
  });
}

/**
 * Builds the bounded, minimal AI-4 transport request from an UNTRUSTED context.
 *
 * The context is re-sanitized here through AI-4A's production
 * `sanitizeRecipeContextEnvelope` (defense in depth: the client, the network and
 * the AI-4B extractor are all untrusted from this module's point of view), so an
 * AI-4 request can never carry a shape the contract does not define.
 *
 * Never throws. Fails closed with a bounded code and, in every failure case,
 * implies ZERO provider calls.
 */
export function buildAiRecipeContextRequest(input: {
  readonly requestVersion: unknown;
  readonly requestId: unknown;
  readonly recipeInstance?: unknown;
  readonly context: unknown;
}): AiRecipeContextRequestResult {
  // A GENUINE discriminator: only the exact supported version is accepted, and it
  // is echoed on the built context. An absent, legacy or future version is
  // refused rather than accepted and ignored.
  if (input.requestVersion !== AI_RECIPE_CONTEXT_REQUEST_VERSION) {
    return { ok: false, code: 'unsupported_request_version' };
  }

  const requestId = boundedRequestId(input.requestId);
  if (requestId === undefined) return { ok: false, code: 'invalid_request_id' };

  const recipeInstance = boundedInstance(input.recipeInstance);
  if (recipeInstance === undefined) return { ok: false, code: 'invalid_request_id' };

  const sanitized = sanitizeRecipeContextEnvelope(input.context);
  if (!sanitized.ok) {
    const code = (sanitized as { readonly code: string }).code;
    if (code === 'no_targets') return { ok: false, code: 'no_targets' };
    if (code === 'too_many_targets') return { ok: false, code: 'too_many_targets' };
    return { ok: false, code: 'invalid_context' };
  }
  const envelope = sanitized.envelope;

  // The contract already bounds the target count; this is an explicit, additive
  // re-assertion at the transport edge so the transport can never be widened by
  // a future change to the request module alone.
  if (envelope.targets.length > MAX_AI_RECIPE_CONTEXT_REQUEST_LINES) {
    return { ok: false, code: 'too_many_targets' };
  }

  const providerRequest: AiRecipeContextProviderRequest = Object.freeze({
    contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
    targets: Object.freeze(envelope.targets.map(providerTargetFrom)),
  });

  // The cap covers the COMPLETE model-facing payload, measured on the exact
  // object the provider receives. Over the cap is REFUSED, never truncated.
  const providerRequestBytes = utf8ByteLength(JSON.stringify(providerRequest));
  if (providerRequestBytes > MAX_AI_RECIPE_CONTEXT_REQUEST_BYTES) {
    return { ok: false, code: 'request_too_large' };
  }

  return {
    ok: true,
    context: Object.freeze({
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: requestId,
      provider_request: providerRequest,
      provider_request_bytes: providerRequestBytes,
      allowed_line_refs: Object.freeze(envelope.targets.map((target) => target.line_ref)),
      recipe_instance: recipeInstance,
      model_input_binding: aiRecipeContextModelInputBinding({
        providerRequest,
        recipeInstance,
      }),
    }),
  };
}

/**
 * The EXACT data block embedded in the AI-4C prompt. Exported so tests can
 * inspect what a provider would receive (privacy + injection structure) without
 * re-deriving it, and so the byte cap and the payload can never disagree.
 */
export function buildAiRecipeContextPromptPayload(
  request: AiRecipeContextProviderRequest
): Record<string, unknown> {
  return {
    contract_version: request.contract_version,
    targets: request.targets.map((target) => ({
      line_ref: target.line_ref,
      source_text: target.source_text,
      ...(target.food_semantics === undefined ? {} : { food_semantics: target.food_semantics }),
    })),
  };
}

/**
 * The structured-output schema for the AI-4 semantic proposal. It is derived from
 * AI-4A's CLOSED vocabularies, so the provider is constrained to exactly the
 * fields and values the AI-4A sanitizer will later accept — and to nothing that
 * could express a mass, a fraction, an identity or a nutrient.
 */
export function buildAiRecipeContextProposalSchema(): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  return {
    type: 'object',
    properties: {
      contract_version: { type: 'string' },
      provenance_class: { type: 'string' },
      interpretations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_ref: { type: 'string' },
            role: { type: 'string', enum: [...AI_RECIPE_CONTEXT_ROLES] },
            relations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: [...AI_RECIPE_CONTEXT_RELATIONS] },
                  target_ref: { type: 'string' },
                },
                required: ['kind', 'target_ref'],
              },
            },
            preparation_hints: {
              type: 'array',
              items: { type: 'string', enum: [...AI_RECIPE_CONTEXT_PREPARATION_HINTS] },
            },
            confidence: { type: 'string', enum: [...AI_RECIPE_CONTEXT_CONFIDENCE_VALUES] },
            abstain_reason: { type: 'string', enum: [...AI_RECIPE_CONTEXT_ABSTAIN_REASONS] },
            explanation: { type: 'string' },
          },
          required: ['line_ref', 'role', 'relations', 'preparation_hints'],
        },
      },
    },
    required: ['contract_version', 'provenance_class', 'interpretations'],
  };
}
