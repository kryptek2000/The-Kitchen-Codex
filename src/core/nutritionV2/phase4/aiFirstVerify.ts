/**
 * The Kitchen Codex — AI-FIRST Advanced Nutrition: local deterministic
 * verification of pass-2 candidate decisions.
 *
 * PURE, offline, side-effect free. This is the authority boundary between an AI
 * PROPOSAL and the existing deterministic nutrition system:
 *
 *   opaque candidate_ref -> browser-owned discovered USDA record
 *     -> record authenticity re-check (same pinned session)
 *     -> Phase-2 source-constraint veto (the SAME closed counters the released
 *        AI resolver uses)
 *     -> existing manual `MatchChoice` binding
 *     -> existing authenticated volume-portion rule (when provable)
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   - It does not run the automatic confidence matcher: an AI-proposed record is
 *     allowed to be useful even when the lexical threshold would have rejected
 *     it. That threshold is no longer the final judge of identity.
 *   - It does not invent an FDC id, record digest, gram value, portion index or
 *     nutrient value. Every one comes from the local authenticated session.
 *   - It does not Apply or persist anything. The caller merges these working
 *     choices and the user must still Apply.
 *   - It does not remove source-contradiction protections. Explicit state, form,
 *     variety, qualifier and numeric constraints still veto a candidate.
 */

import { normalizeQuery } from '../matching/normalize';
import { buildPortionChoice, selectDeterministicVolumePortionIndex } from './portion';
import { ingredientMeasurement, selectionFromMatchChoice } from './rows';
import { candidateContradictsSource, sourceProjectionFor } from './aiResolve';
import type { AiFirstCandidateDecision } from '../aiFirstCandidateEvaluation';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  MatchChoice,
  Phase4Row,
} from './types';
import type { AiResolveCandidate } from './aiResolve';

/** One candidate the browser actually discovered in its pinned catalog. */
export interface AiFirstLocalCandidate {
  readonly candidate_ref: string;
  readonly fdc_id: number;
  readonly description: string;
  readonly record_digest: string;
  readonly data_type: string;
  /** Display-only authenticated portion hint (e.g. `1 cup = 242 g`). */
  readonly portion_summary?: string;
}

/** One target plus the exact local records its refs point at. */
export interface AiFirstLocalCandidateSet {
  readonly line_ref: string;
  readonly candidates: ReadonlyArray<AiFirstLocalCandidate>;
}

export interface AiFirstVerificationParams {
  readonly session: AdvancedNutritionSession;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly candidateSets: ReadonlyArray<AiFirstLocalCandidateSet>;
  readonly decisions: ReadonlyArray<AiFirstCandidateDecision>;
}

/** One accepted AI-first proposal with its bounded reasoning, for display. */
export interface AiFirstVerifiedProposal {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly description: string;
  readonly justification: string;
  readonly uncertainty: string;
}

export interface AiFirstVerificationOutcome {
  /** Verified selections, shaped exactly like the released AI resolver output. */
  readonly candidates: ReadonlyArray<AiResolveCandidate>;
  /** Every line that still needs the user (no decision, rejected, review, no match). */
  readonly unresolved: ReadonlyArray<string>;
  /** Lines whose model-selected record failed deterministic verification. */
  readonly rejected: ReadonlyArray<string>;
  readonly no_match: ReadonlyArray<string>;
  readonly needs_review: ReadonlyArray<string>;
  /** Display provenance for accepted proposals (never authority). */
  readonly proposed: ReadonlyArray<AiFirstVerifiedProposal>;
}

function finitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0);
}

/**
 * Verifies every sanitized decision against the genuine local catalog.
 *
 * Never throws. A record that cannot be re-authenticated, or that contradicts an
 * explicit authored constraint, yields NO candidate for that line and is
 * reported as rejected. The line remains available for manual review.
 */
export function verifyAiFirstCandidateDecisions(
  params: AiFirstVerificationParams
): AiFirstVerificationOutcome {
  const rowByRef = new Map(params.rows.map((row) => [row.line_ref, row]));
  const entryByRef = new Map(params.adapted.map((entry) => [entry.line_ref, entry]));
  const localByRef = new Map(
    params.candidateSets.map((set) => [set.line_ref, new Map(set.candidates.map((candidate) => [candidate.candidate_ref, candidate]))])
  );
  const catalogDigest = params.session.metadata().catalog_digest;

  const candidates: AiResolveCandidate[] = [];
  const unresolved: string[] = [];
  const rejected: string[] = [];
  const noMatch: string[] = [];
  const needsReview: string[] = [];
  const proposed: AiFirstVerifiedProposal[] = [];

  for (const decision of params.decisions) {
    const lineRef = decision.line_ref;
    const row = rowByRef.get(lineRef);
    if (row === undefined) {
      unresolved.push(lineRef);
      continue;
    }
    if (decision.decision === 'no_match') {
      noMatch.push(lineRef);
      unresolved.push(lineRef);
      continue;
    }
    if (decision.decision === 'needs_review') {
      needsReview.push(lineRef);
      unresolved.push(lineRef);
      continue;
    }
    if (decision.decision !== 'select' || decision.candidate_ref === null) {
      unresolved.push(lineRef);
      continue;
    }

    const local = localByRef.get(lineRef)?.get(decision.candidate_ref);
    if (local === undefined) {
      // The shared response sanitizer already enforces this, but verification is
      // independent defense in depth: a proposal with no LOCAL record is never
      // promoted to a selection.
      rejected.push(lineRef);
      unresolved.push(lineRef);
      continue;
    }
    if (!finitePositiveInteger(local.fdc_id)) {
      rejected.push(lineRef);
      unresolved.push(lineRef);
      continue;
    }

    // RECORD AUTHENTICITY. The explicit-FDC-id search is local and deterministic;
    // it must return the exact record digest the discovery pass saw. This makes a
    // forged/stale/tampered candidate object fail closed before any selection is
    // constructed.
    let authentic = false;
    try {
      const lookup = params.session.searchFoods(String(local.fdc_id), 1);
      if (lookup.ok) {
        authentic = lookup.results.some(
          (hit) => hit.fdc_id === local.fdc_id && hit.record_digest === local.record_digest
        );
      }
    } catch {
      authentic = false;
    }
    if (!authentic) {
      rejected.push(lineRef);
      unresolved.push(lineRef);
      continue;
    }

    // SOURCE-CONSTRAINT VETO. Candidate wording may not erase an authored state,
    // form, variety, qualifier or numeric constraint. This reuses the SAME closed
    // Phase-2 projection counters as the released AI resolver.
    let normalizedDescription = '';
    try {
      normalizedDescription = normalizeQuery(local.description).text;
    } catch {
      normalizedDescription = '';
    }
    const candidateTokens = normalizedDescription.split(/\s+/).filter(Boolean);
    if (
      candidateContradictsSource(
        candidateTokens,
        sourceProjectionFor(row),
        row.candidates.length > 0
      )
    ) {
      rejected.push(lineRef);
      unresolved.push(lineRef);
      continue;
    }

    const choice: MatchChoice = Object.freeze({
      kind: 'manual' as const,
      fdc_id: local.fdc_id,
      review_digest: row.review_digest ?? '',
      record_digest: local.record_digest,
      catalog_digest: catalogDigest,
      description: local.description,
      // Automatic (not human-confirmed) provenance. `aiFirst` is display-only.
      aiAssisted: true,
      aiAccepted: true,
      aiFirst: true,
      ...(decision.justification.length > 0
        ? { aiFirstJustification: decision.justification }
        : {}),
      ...(decision.uncertainty.length > 0
        ? { aiFirstUncertainty: decision.uncertainty }
        : {}),
    });

    // AUTHENTICATED VOLUME MASS COMPLETION. When the deterministic source-portion
    // rule proves ONE mass for this volume, use it; otherwise leave the line at
    // NEEDS AMOUNT rather than inventing a density or gram value.
    let portion;
    const entry = entryByRef.get(lineRef);
    const measurement = entry ? ingredientMeasurement(entry) : undefined;
    if (
      entry !== undefined &&
      measurement !== undefined &&
      measurement.measurement_kind === 'volume' &&
      typeof measurement.milliliters === 'number'
    ) {
      const portionIndex = selectDeterministicVolumePortionIndex(
        params.session,
        local.fdc_id,
        measurement.milliliters,
        measurement.raw_unit,
        row.query
      );
      if (portionIndex !== undefined) {
        const built = buildPortionChoice(params.session, {
          lineRef,
          ingredient: entry.ingredient,
          review: row.review,
          selection: selectionFromMatchChoice(choice, lineRef),
          fdcId: local.fdc_id,
          portionIndex,
        });
        if (built.ok) portion = built.choice;
      }
    }

    candidates.push(
      Object.freeze({
        line_ref: lineRef,
        query: local.description,
        fdc_id: local.fdc_id,
        description: local.description,
        record_digest: local.record_digest,
        auto: true,
        choice,
        ...(portion !== undefined ? { portion } : {}),
      })
    );
    proposed.push(
      Object.freeze({
        line_ref: lineRef,
        fdc_id: local.fdc_id,
        description: local.description,
        justification: decision.justification,
        uncertainty: decision.uncertainty,
      })
    );
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    unresolved: Object.freeze(unresolved),
    rejected: Object.freeze(rejected),
    no_match: Object.freeze(noMatch),
    needs_review: Object.freeze(needsReview),
    proposed: Object.freeze(proposed),
  });
}
