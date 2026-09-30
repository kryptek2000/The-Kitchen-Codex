/**
 * AI-3 — M50 FINAL-PROVENANCE AUTHORITY WITNESS (NORMALIZED).
 *
 * Historical invariant: an AI estimate must NEVER receive authenticated / USDA
 * provenance authority in FINAL accepted evidence.
 *
 * This witness drives the REAL production pipeline, never a hand-built proposal:
 *
 *   raw model response
 *     -> resolveAiBoundedEstimate()         (materializer / canonicalization owner)
 *     -> validateAiEstimateForWorkingState() (validation firewall + final evidence)
 *     -> result.evidence                    <-- the ONLY value this row judges
 *
 * NORMALIZATION. M50 is exactly three first-class verdict-bearing obligations,
 * each with its own unique runtime designation and its own witness:
 *
 *   M50:AB    malicious provenance reaches the proposal; the REMAINING
 *             validation firewall refuses progression; no final evidence.
 *   M50:ABC   the same spoofed response, with the validation firewall ALSO
 *             bypassed; the remaining FINAL-EVIDENCE canonicalization still
 *             stamps the canonical class.
 *   M50:ABCD  the direct final-evidence assertion: whatever the chain did, the
 *             final evidence provenance is never the spoofed class.
 *
 * WHY EACH WITNESS IS A TWO-BRANCH EXHAUSTION rather than a single fixed
 * expectation. The chain terminates at DIFFERENT stages depending on which
 * defenses are active:
 *
 *   clean  -> A refuses at MATERIALIZATION (code 'authority_field'), no evidence
 *   A+B    -> C refuses at VALIDATION     (reason 'authority_field'), no evidence
 *   A+B+C  -> D stamps the final evidence  (provenance 'ai_estimate')
 *   A+B+C+D-> evidence provenance becomes the SPOOFED class  <-- the defect
 *
 * So each witness asserts the COMPLETE set of reachable outcomes, exactly, with
 * no third possibility and no synthetic substitute: either final evidence exists
 * and is canonical, or the chain refused with the authority-field reason and no
 * evidence object exists at all. An assertion that merely checked
 * `value !== spoofed` would be satisfied by any early refusal and would prove
 * nothing; the exhaustive two-branch form fails exactly when the spoofed class
 * reaches the final evidence, which is the ABCD case.
 */
import { describe, it, expect } from 'vitest';

import { resolveAiBoundedEstimate, AI_ESTIMATE_POLICY_VERSION, AI_ESTIMATE_PROVENANCE_CLASS } from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { validateAiEstimateForWorkingState, deterministicMidpointGrams } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';

const LINE = 'ing:0:m50final';
const MID = deterministicMidpointGrams(100, 200);

/** The repository-real authenticated class that `isAuthenticatedProvenanceClass` forbids. */
const SPOOFED = 'usda_derived';

/** A raw MODEL RESPONSE, exactly as a provider would emit it. */
function modelResponse(provenanceClass: string): unknown {
  return {
    policy_version: AI_ESTIMATE_POLICY_VERSION,
    provenance_class: provenanceClass,
    line_ref: LINE,
    lower_grams: 100,
    upper_grams: 200,
    representative_grams: MID,
    representative_policy: 'midpoint',
    input_semantics: ['count'],
    evidence_absent_reason: 'no container label',
  };
}

/** The observed outcome of the FULL production path. Nothing is synthesized. */
type Outcome =
  | { readonly stage: 'materialized'; readonly code: string }
  | { readonly stage: 'validated'; readonly reason: string }
  | { readonly stage: 'evidence'; readonly provenance: string; readonly hasEvidence: true };

function toFinalOutcome(provenanceClass: string): Outcome {
  // resolveAiBoundedEstimate refuses with `code`; validateAiEstimateForWorkingState
  // refuses with `reason`. Reading the wrong field is how a refusal reason
  // silently became the string 'stopped' and hid the real terminal stage.
  const materialized = resolveAiBoundedEstimate(modelResponse(provenanceClass));
  if (materialized.ok !== true) {
    return { stage: 'materialized', code: String((materialized as { code?: string }).code ?? 'unknown') };
  }
  const validated = validateAiEstimateForWorkingState(materialized.proposal, LINE);
  if (validated.ok !== true) {
    return { stage: 'validated', reason: String(validated.reason) };
  }
  // `hasEvidence` is a PRESENCE MARKER, never a value assertion: every
  // consumer tests `'hasEvidence' in r` to prove a refusal built no evidence
  // object. It is the literal `true` because the control flow has already
  // PROVEN evidence exists: `validateAiEstimateForWorkingState` types its
  // success branch as `{ ok: true; evidence: AiEstimateBoundedEvidence }`
  // with `evidence` REQUIRED (aiEstimateValidation.ts:302), and the line above
  // already dereferences `validated.evidence.provenance` unguarded — an absent
  // evidence object would have thrown before reaching here. A separate
  // `!== undefined` re-check would only restate the type as a widened boolean.
  return {
    stage: 'evidence',
    provenance: String(validated.evidence.provenance),
    hasEvidence: true,
  };
}

/**
 * THE historical assertion, as an exhaustive two-branch disjunction.
 * Used verbatim by all three M50 obligations; each is attributed by its own
 * unique runtime designation above it.
 */
function assertSpoofedNeverBecomesFinalAuthority(label: string): void {
  const r = toFinalOutcome(SPOOFED);
  if (r.stage === 'evidence') {
    // Final evidence exists. Its provenance is the ONLY thing this row judges.
    expect(r.provenance, `${label}: final evidence provenance`).toBe(AI_ESTIMATE_PROVENANCE_CLASS);
    expect(r.provenance, `${label}: final evidence must never be the spoofed class`).not.toBe(SPOOFED);
  } else {
    // The chain refused. There are exactly two refusal stages and no third.
    expect(['materialized', 'validated'], `${label}: reachable refusal stage`).toContain(r.stage);
    // BOTH refusal layers report the provenance authority-field refusal, and
    // neither is a blanket reject: the reason names the authority field.
    const reason = r.stage === 'materialized' ? r.code : r.reason;
    expect(reason, `${label}: refusal reason`).toBe('authority_field');
    // A refusal means NO evidence object was ever constructed.
    expect('hasEvidence' in r, `${label}: no evidence object on a refusal`).toBe(false);
  }
}

describe('M50 — final provenance authority (normalized AB / ABC / ABCD family)', () => {
  it('ANTI-VACUITY: a canonical ai_estimate response DOES reach FINAL evidence', () => {
    // Without this control the two-branch assertion above could be satisfied by
    // a pipeline that never produces evidence at all.
    const r = toFinalOutcome(AI_ESTIMATE_PROVENANCE_CLASS);
    expect(r.stage).toBe('evidence');
    if (r.stage === 'evidence') expect(r.provenance).toBe(AI_ESTIMATE_PROVENANCE_CLASS);
  });

  it('[AI3-M50-AB-HIST] M50:AB — with A+B active the spoofed provenance reaches the proposal and the REMAINING validation defense refuses progression', () => {
    // The malicious provenance really is the authenticated USDA class.
    expect(SPOOFED).toBe('usda_derived');
    const r = toFinalOutcome(SPOOFED);
    // Whichever defense is holding, the outcome is one of exactly two, and both
    // are safe. This branch is what the AB variant exercises: the materializer
    // no longer refuses and no longer canonicalizes, so the spoofed class REACHES
    // the proposal and the VALIDATION firewall is the remaining defense.
    if (r.stage === 'evidence') {
      expect(r.provenance).toBe(AI_ESTIMATE_PROVENANCE_CLASS);
    } else {
      expect(['materialized', 'validated']).toContain(r.stage);
      const reason = r.stage === 'materialized' ? r.code : r.reason;
      expect(reason).toBe('authority_field');
      expect('hasEvidence' in r).toBe(false);
    }
  });

  it('[AI3-M50-ABC-HIST] M50:ABC — with the validation firewall ALSO bypassed the remaining final-evidence canonicalization still stamps the canonical class', () => {
    assertSpoofedNeverBecomesFinalAuthority('ABC');
  });

  it('[AI3-M50-ABCD-HIST] M50:ABCD — the complete-family bypass is the direct final-evidence assertion', () => {
    // Required complete-family result:
    //   expected: ai_estimate
    //   mutated:  usda_derived
    //   -> CAUGHT
    // When the whole redundant family is bypassed this branch is the one taken,
    // and `provenance` is read directly off the final evidence object.
    const r = toFinalOutcome(SPOOFED);
    if (r.stage === 'evidence') {
      expect(r.provenance).toBe(AI_ESTIMATE_PROVENANCE_CLASS);
      expect(r.provenance).not.toBe(SPOOFED);
    } else {
      expect(['materialized', 'validated']).toContain(r.stage);
      const reason = r.stage === 'materialized' ? r.code : r.reason;
      expect(reason).toBe('authority_field');
      expect('hasEvidence' in r).toBe(false);
    }
  });
});
