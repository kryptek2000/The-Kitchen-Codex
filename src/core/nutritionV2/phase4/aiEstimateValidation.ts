/**
 * The Kitchen Codex — Advanced Nutrition: AI-3 bounded-estimate eligibility and
 * deterministic validation.
 *
 * PURE, offline, deterministic. This module owns ONE question: given the
 * current deterministic parse and the current working state, may a bounded AI
 * MASS ESTIMATE be requested for a line at all -- and if the model answered,
 * what bounded, locally-derived evidence may enter working state?
 *
 * It deliberately does NOT re-implement the frozen estimate contract: the
 * structural sanitizer, forbidden authority keys, proposal keys, gram bounds
 * and provenance class all live in `aiAdvancedEstimate.ts` and are consumed
 * through `validateAiBoundedEstimateProposal` / `resolveAiBoundedEstimate`.
 *
 * WHAT AI-3 MAY DO: return a bounded mass RANGE for a line whose food identity
 * is already authenticated and whose deterministic mass sources are exhausted.
 *
 * WHAT AI-3 MAY NEVER DO: author identity, author nutrients, author a portion,
 * spend user authority, or persist anything.
 */

import {
  AI_ESTIMATE_PROVENANCE_CLASS,
  MAX_AI_ESTIMATE_BOUND_GRAMS,
  isAuthenticatedProvenanceClass,
  resolveAiBoundedEstimate,
  type AiBoundedEstimateProposal,
} from '../aiAdvancedEstimate';
import { MAX_AI_ESTIMATE_RANGE_RATIO } from '../aiEstimateBounds';
import { parseIngredient } from '../matching/parse';
import { workingChoiceFingerprint } from './aiMidFlight';
import { isWithinCanonicalBound } from '../calculation/numeric';
import { resolveEffectiveMassDecision, type EffectiveMassDecision } from '../calculation/effectiveMass';
import { stableChoiceKey } from './aiMidFlight';
import type { AiEstimateChoice, AiEstimateRangeEvidence, MatchChoice, Phase4State } from './types';
// The ONE identity-evidence type. Imported as a TYPE only: this module never
// derives evidence, it consumes what the Phase-4/session owner proved.
import type { AiEstimateIdentityEvidence } from './aiEstimateIdentityEvidence';

// The range-width bound is owned centrally in `../aiEstimateBounds` so the
// Phase 3 calculator and this Phase 4 layer enforce the identical value
// without either importing the other. Re-exported here for convenience.
export { MAX_AI_ESTIMATE_RANGE_RATIO };

/** Maximum estimate lines per request (AI-2B precedent: 12 plan lines). */
export const MAX_AI_ESTIMATE_LINES = 12;

/**
 * The only deterministic abstention vocabulary AI-3 v1 needs. Both classes are
 * derived from the DETERMINISTIC parse state, never from model prose and never
 * from a speculative token-regex grammar.
 */
export const AI_ESTIMATE_ABSTENTION_REASONS = Object.freeze([
  'no_usable_quantity',
  'parsed_container',
] as const);
export type AiEstimateAbstentionReason = (typeof AI_ESTIMATE_ABSTENTION_REASONS)[number];

/** The closed eligibility refusal vocabulary (all deterministic). */
export const AI_ESTIMATE_INELIGIBLE_REASONS = Object.freeze([
  'capability_unavailable',
  'line_missing',
  'not_actionable',
  'identity_unresolved',
  'direct_mass_authority',
  'stronger_mass_source',
  'no_usable_quantity',
  'parsed_container',
  'request_too_large',
] as const);
export type AiEstimateIneligibleReason = (typeof AI_ESTIMATE_INELIGIBLE_REASONS)[number];

/** The closed per-line result refusal vocabulary (post-response). */
export const AI_ESTIMATE_REJECTION_REASONS = Object.freeze([
  'invalid_proposal',
  'unsafe_proposal',
  'authority_field',
  'unsupported_policy',
  'midpoint_mismatch',
  'range_ratio_exceeded',
  'out_of_bounds',
] as const);
export type AiEstimateRejectionReason = (typeof AI_ESTIMATE_REJECTION_REASONS)[number];

/** The ONLY live-row status AI-3 may operate on. */
export const AI_ESTIMATE_ROW_ACTIONABLE = 'needs_amount' as const;

// ---------------------------------------------------------------------------
// Deterministic eligibility
// ---------------------------------------------------------------------------

/** The deterministic parse facts AI-3 eligibility may read. */
export interface AiEstimateParseFacts {
  /**
   * The deterministic parse already established AUTHORED MASS for this line.
   * This is ABSOLUTE AI-3 ineligibility: AI-3 must never estimate mass for a
   * line the parser has already weighed. It covers a scalar metric/imperial
   * mass, a written mass RANGE, and secondary mass the parser recognises as
   * authoritative.
   */
  readonly hasDirectMass: boolean;
  /**
   * The authoritative parsed grams for that authored mass, when the parser
   * genuinely produced them. Never a placeholder: this is forwarded to the
   * shared mass resolver so `direct_mass` authority is real, not decorative.
   */
  readonly directMassGrams?: number | null;
  /** A scalar authored amount. */
  readonly amount: number | null;
  /** An authored quantity range (a range IS usable quantity). */
  readonly quantityRange: { readonly lower: number; readonly upper: number } | null;
  /** A parsed container/package/can noun -> AI-3 v1 abstains. */
  readonly container: string | null;
}

/**
 * The CURRENT deterministic actionability of a line, straight from the live
 * Phase-4 projection. Only the values the live row can actually produce are
 * accepted; anything else is refused. This is the authoritative fact — AI-3
 * never reconstructs it from free text or from benchmark category strings.
 */
export type AiEstimateRowActionability = 'needs_amount';

export interface AiEstimateEligibilityInput {
  readonly state: Phase4State;
  readonly lineRef: string;
  readonly parse: AiEstimateParseFacts;
  /**
   * The CURRENT live-row status for this line. AI-3 operates only on a line the
   * live pipeline still reports as an actionable amount exception. A line that
   * is already resolved (`matched`), awaiting identity (`needs_match` /
   * `review_suggested`), or non-nutritional (`qualitative`) is forbidden.
   */
  readonly rowStatus: string;
  /** Retained for the identity diagnostic only; never an eligibility gate. */
  readonly issueKind?: string;
  readonly capabilityAvailable: boolean;
}

export type AiEstimateEligibility =
  | { readonly eligible: true; readonly match: MatchChoice }
  | { readonly eligible: false; readonly reason: AiEstimateIneligibleReason };

/**
 * Deterministic pre-network eligibility. Every refusal here happens BEFORE any
 * provider work, so an ineligible line never spends a provider call.
 */
export function evaluateAiEstimateEligibility(
  input: AiEstimateEligibilityInput
): AiEstimateEligibility {
  if (!input.capabilityAvailable) return { eligible: false, reason: 'capability_unavailable' };
  // 1. the line must still exist
  if (!input.state.rows.some((row) => row.line_ref === input.lineRef)) {
    return { eligible: false, reason: 'line_missing' };
  }
  // 2. the line must be a CURRENT actionable amount exception. An
  //    already-resolved, review-suggested, qualitative or identity-blocked row
  //    can never enter AI-3, whatever any secondary helper reconstructs.
  if (input.rowStatus !== AI_ESTIMATE_ROW_ACTIONABLE) {
    return { eligible: false, reason: 'not_actionable' };
  }
  // 3. the identity must already be authenticated (AI-1 / AI-2C own identity).
  const match = input.state.matches?.[input.lineRef];
  if (match === undefined || typeof match.fdc_id !== 'number' || match.fdc_id <= 0) {
    return { eligible: false, reason: 'identity_unresolved' };
  }
  // 4. AUTHORED MASS IS ABSOLUTE INELIGIBILITY. Checked before the mass
  //    resolver so a scalar, a written mass range and authoritative secondary
  //    mass can never be estimated over.
  if (input.parse.hasDirectMass) {
    return { eligible: false, reason: 'direct_mass_authority' };
  }
  // 5-9. the stronger-source firewall: ANY existing mass authority forbids AI-3.
  const decision = effectiveMassDecisionFor(input.state, input.lineRef, input.parse);
  if (decision.kind !== 'none') return { eligible: false, reason: 'stronger_mass_source' };
  // 10. usable deterministic quantity semantics (a written RANGE counts).
  if (!hasUsableQuantity(input.parse)) return { eligible: false, reason: 'no_usable_quantity' };
  // 11. a container/package/can line is never estimated in AI-3 v1.
  if (input.parse.container !== null && input.parse.container !== undefined) {
    return { eligible: false, reason: 'parsed_container' };
  }
  return { eligible: true, match };
}

/**
 * True when the deterministic parse carries ANY usable quantity semantics. A
 * written range counts: the frozen contract is range-first precisely for this.
 */
export function hasUsableQuantity(parse: AiEstimateParseFacts): boolean {
  // NOTE: authored mass is deliberately NOT counted as "usable quantity" for
  // estimation -- it is absolute ineligibility, checked earlier.
  if (typeof parse.amount === 'number' && Number.isFinite(parse.amount) && parse.amount > 0) {
    return true;
  }
  const range = parse.quantityRange;
  if (
    range !== null &&
    range !== undefined &&
    Number.isFinite(range.lower) &&
    Number.isFinite(range.upper) &&
    range.lower > 0 &&
    range.upper >= range.lower
  ) {
    return true;
  }
  return false;
}

/** Reads the CURRENT effective mass decision straight from the shared resolver. */
export function effectiveMassDecisionFor(
  state: Phase4State,
  lineRef: string,
  parse: Pick<AiEstimateParseFacts, 'hasDirectMass' | 'directMassGrams'>
): EffectiveMassDecision {
  return resolveEffectiveMassDecision({
    // Only a REAL parsed gram value is forwarded. When the parser established
    // authored mass but produced no grams, the value is deliberately absent
    // rather than a placeholder -- `evaluateAiEstimateEligibility` refuses that
    // line on `hasDirectMass` before this resolver is ever consulted.
    directMassGrams: parse.hasDirectMass
      ? typeof parse.directMassGrams === 'number' && parse.directMassGrams > 0
        ? parse.directMassGrams
        : undefined
      : undefined,
    hasUserMass: state.userMasses?.[lineRef] !== undefined,
    hasSourcePortion: state.portions?.[lineRef] !== undefined,
    hasCountPortion: state.countPortions?.[lineRef] !== undefined,
    hasHouseholdPortion: state.householdPortions?.[lineRef] !== undefined,
    hasAiEstimate: state.aiEstimates?.[lineRef] !== undefined,
  });
}

// ---------------------------------------------------------------------------
// LOCAL snapshot binding (never leaves the process)
// ---------------------------------------------------------------------------

/**
 * The semantic inputs an estimate was derived from. A change to any of them
 * makes the estimate stale. The digest is LOCAL: it never enters the model
 * payload, the transport body, persistence or Apply.
 */
export interface AiEstimateSnapshotInput {
  readonly lineRef: string;
  readonly sourceText: string;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly countNoun: string | null;
  readonly fdcId: number;
  readonly recordDigest: string;
  readonly reviewDigest: string;
  readonly bundleRelease: string | null;
  readonly catalogDigest: string | null;
  readonly recipeKey: string | null;
  readonly sessionIdentity: string | null;
}

/** Deterministic local snapshot binding for one estimate. */
export function aiEstimateSnapshotBinding(input: AiEstimateSnapshotInput): string {
  return stableChoiceKey({
    line: input.lineRef,
    text: input.sourceText,
    amount: input.amount,
    unit: input.unit,
    count: input.countNoun,
    fdc: input.fdcId,
    record: input.recordDigest,
    review: input.reviewDigest,
    bundle: input.bundleRelease,
    catalog: input.catalogDigest,
    recipe: input.recipeKey,
    session: input.sessionIdentity,
  });
}

// ---------------------------------------------------------------------------
// Deterministic midpoint + bounds
// ---------------------------------------------------------------------------

/** The deterministic midpoint of a sanitized range. Never a model value. */
export function deterministicMidpointGrams(lower: number, upper: number): number {
  return (lower + upper) / 2;
}

/**
 * The model representative must AGREE with the locally derived midpoint. The
 * tolerance reuses the existing AI-1 quantity tolerance constants, so AI-3
 * introduces no new numeric fudge factor.
 */
const MIDPOINT_TOLERANCE_FLOOR = 0.01;
const MIDPOINT_TOLERANCE_RATIO = 0.05;

function midpointAgrees(lower: number, upper: number, claimed: number): boolean {
  const expected = deterministicMidpointGrams(lower, upper);
  const tolerance = Math.max(MIDPOINT_TOLERANCE_FLOOR, expected * MIDPOINT_TOLERANCE_RATIO);
  return Math.abs(claimed - expected) <= tolerance;
}

/** The bounded evidence a validated estimate contributes, before binding. */
export type AiEstimateBoundedEvidence = AiEstimateRangeEvidence;

export type AiEstimateValidation =
  | { readonly ok: true; readonly evidence: AiEstimateBoundedEvidence }
  | { readonly ok: false; readonly reason: AiEstimateRejectionReason };

/**
 * Validates ONE raw model response for one line and produces the ONLY bounded
 * evidence AI-3 may place in working state.
 *
 * Order is deliberate and fail-closed: the frozen structural sanitizer runs
 * first (it owns the forbidden authority keys, the closed key set, the gram
 * bounds and the range ordering), then the AI-3 v1 product policy (midpoint
 * only), then the locally recomputed midpoint, then the model-agreement check,
 * then the range ratio, then the canonical numeric bound.
 */
export function validateAiEstimateForWorkingState(
  raw: unknown,
  expectedLineRef: string
): AiEstimateValidation {
  const resolved = resolveAiBoundedEstimate(raw);
  if (resolved.ok !== true) {
    const code = resolved.code;
    if (code === 'unsafe_proposal') return { ok: false, reason: 'unsafe_proposal' };
    if (code === 'authority_field') return { ok: false, reason: 'authority_field' };
    if (code === 'estimation_disabled') return { ok: false, reason: 'invalid_proposal' };
    return { ok: false, reason: 'invalid_proposal' };
  }
  const proposal: AiBoundedEstimateProposal = resolved.proposal;

  // The proposal must be FOR THIS LINE. A cross-line or unknown ref is refused.
  if (proposal.line_ref !== expectedLineRef) return { ok: false, reason: 'invalid_proposal' };

  // AI-3 v1 grants product authority to the deterministic midpoint ONLY. The
  // frozen sanitizer keeps recognising its other historic policy literals, but
  // accepting one here would let the model choose the calculation value.
  if (proposal.representative_policy !== 'midpoint') {
    return { ok: false, reason: 'unsupported_policy' };
  }
  if (isAuthenticatedProvenanceClass(proposal.provenance_class)) {
    return { ok: false, reason: 'authority_field' };
  }
  if (proposal.provenance_class !== AI_ESTIMATE_PROVENANCE_CLASS) {
    return { ok: false, reason: 'authority_field' };
  }

  const { lower_grams: lower, upper_grams: upper } = proposal;

  // The 4x range-width bound. Wider => REFUSE the line. Never clamp.
  if (!(lower > 0) || !(upper > 0) || upper / lower > MAX_AI_ESTIMATE_RANGE_RATIO) {
    return { ok: false, reason: 'range_ratio_exceeded' };
  }
  if (lower > MAX_AI_ESTIMATE_BOUND_GRAMS || upper > MAX_AI_ESTIMATE_BOUND_GRAMS) {
    return { ok: false, reason: 'out_of_bounds' };
  }
  if (!isWithinCanonicalBound(lower) || !isWithinCanonicalBound(upper)) {
    return { ok: false, reason: 'out_of_bounds' };
  }

  // The calculation value is ALWAYS locally derived. A model representative
  // that disagrees with the deterministic midpoint refuses the line rather than
  // being clamped or silently replaced.
  const localMidpoint = deterministicMidpointGrams(lower, upper);
  if (!midpointAgrees(lower, upper, proposal.representative_grams)) {
    return { ok: false, reason: 'midpoint_mismatch' };
  }
  if (!isWithinCanonicalBound(localMidpoint) || localMidpoint <= 0) {
    return { ok: false, reason: 'out_of_bounds' };
  }

  return {
    ok: true,
    evidence: {
      lower_grams: lower,
      upper_grams: upper,
      representative_grams: localMidpoint,
      representative_policy: 'midpoint' as const,
      provenance: 'ai_estimate' as const,
    },
  };
}

/** The literal, truthful UI/display label for an estimated mass. */
export const AI_ESTIMATE_MASS_DISPLAY_LABEL = 'AI estimate (not USDA-authenticated)';


/**
 * PRODUCTION COMPOSITION INPUT DERIVATION (AI-3).
 *
 * The UI is injection-only: it never parses an ingredient, never computes a
 * fingerprint and never builds a snapshot. Everything the AI-3 orchestration
 * needs is derived HERE, in the Phase-4 review/display boundary that is already
 * the only module permitted to reach the Phase-2 production parser.
 *
 * The production parent (App) therefore imports only the application boundary
 * and passes the raw line text through.
 */
export interface AiEstimateProductionInput {
  readonly parse: AiEstimateParseFacts;
  readonly snapshot: AiEstimateSnapshotInput | null;
  readonly fingerprint: string | null;
  /** The eligibility input for this line, with capability resolved by the caller. */
  readonly eligibility: AiEstimateEligibilityInput;
}

/** Re-derive the deterministic parse facts for one authored line. */
export function deriveAiEstimateParseFacts(sourceText: string): AiEstimateParseFacts {
  const parsed = parseIngredient(sourceText);
  if (!parsed.ok) {
    return { hasDirectMass: false, directMassGrams: null, amount: null, quantityRange: null, container: null };
  }
  const p = parsed.parsed;
  const grams = typeof p.grams === 'number' ? p.grams : null;
  return {
    // Authored metric/imperial mass is absolute ineligibility, including a
    // written mass range. Only genuinely parsed grams are carried.
    hasDirectMass: p.measurement_kind === 'mass' && grams !== null,
    directMassGrams: grams,
    amount: p.amount,
    quantityRange: p.quantity_range ? { lower: p.quantity_range.lower, upper: p.quantity_range.upper } : null,
    container: p.container ?? null,
  };
}

/** Build the deterministic snapshot binding input for one line, or null. */
export function deriveAiEstimateSnapshotInput(
  state: Phase4State,
  lineRef: string,
  sourceText: string,
  /**
   * The CANONICAL identity evidence for this line, from the ONE Phase-4/session
   * evidence owner. It is the authority for the pinned record digest and the
   * bundle release, because Phase-4 `MatchChoice` carries NEITHER -- reading
   * the match record field here would always be `undefined` in production and
   * would fail closed on EVERY line. Passing `null`/omitting it fails closed,
   * exactly as before.
   */
  evidence?: AiEstimateIdentityEvidence | null,
): AiEstimateSnapshotInput | null {
  const match = state.matches[lineRef] as
    | { fdc_id?: number; record_digest?: string; review_digest?: string; bundle_release?: string; catalog_digest?: string }
    | undefined;
  if (match === undefined || typeof match.fdc_id !== 'number') return null;
  // Fail closed unless the canonical owner proved the pinned record authority.
  if (evidence === undefined || evidence === null) return null;
  if (evidence.fdc_id !== match.fdc_id) return null;
  const parse = deriveAiEstimateParseFacts(sourceText);
  const parsed = parseIngredient(sourceText);
  return {
    lineRef,
    sourceText,
    amount: parse.amount,
    unit: parsed.ok ? (parsed.parsed.raw_unit ?? null) : null,
    countNoun: parsed.ok ? (parsed.parsed.count_noun ?? parsed.parsed.query ?? null) : null,
    fdcId: evidence.fdc_id,
    // Canonical: the pinned record digest from the session's bounded record.
    recordDigest: evidence.record_digest,
    reviewDigest: typeof match.review_digest === 'string' ? match.review_digest : evidence.record_digest,
    // Canonical: the session's own bundle release.
    bundleRelease: evidence.bundle_release,
    catalogDigest: typeof match.catalog_digest === 'string' ? match.catalog_digest : null,
    recipeKey: state.recipeKey,
    sessionIdentity: state.sessionIdentity,
  };
}

/**
 * Derive EVERYTHING the AI-3 orchestration needs for one line, in one place.
 * The production composition adapter is then a thin map over this.
 */
export function deriveAiEstimateProductionInput(input: {
  readonly state: Phase4State;
  readonly lineRef: string;
  readonly sourceText: string;
  /** The AUTHORITATIVE current live-row status from the live projection. */
  readonly rowStatus: string;
  readonly capabilityAvailable: boolean;
  /**
   * The CANONICAL five-field identity evidence for this line. The snapshot is
   * built FROM it, so identity authority has exactly one owner and the
   * snapshot cannot diverge from the evidence attached to the offer.
   */
  readonly evidence?: AiEstimateIdentityEvidence | null;
}): AiEstimateProductionInput {
  const parse = deriveAiEstimateParseFacts(input.sourceText);
  return {
    parse,
    snapshot: deriveAiEstimateSnapshotInput(
      input.state,
      input.lineRef,
      input.sourceText,
      input.evidence,
    ),
    fingerprint: workingChoiceFingerprint(input.state, input.lineRef),
    eligibility: {
      state: input.state,
      lineRef: input.lineRef,
      parse,
      rowStatus: input.rowStatus,
      capabilityAvailable: input.capabilityAvailable,
    },
  };
}
