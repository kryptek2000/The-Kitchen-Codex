/**
 * The Kitchen Codex — SHISO H-2 deterministic nutrition corrections.
 *
 * ONE bounded, offline, deterministic pass that turns the EXISTING
 * `runBatchInvestigation` evidence into reviewable working-state actions:
 *
 *   batch investigation (existing authority output)
 *     -> walk the authenticated ranked alternatives / count portions
 *     -> build each candidate through the EXISTING authorities
 *        (`prepareShisoProposalActions` -> `confirmAdvancedNutritionMatch`,
 *        `buildPortionChoice`) or the count-portion builder
 *     -> VERIFY the candidate against the SAME calculator the review uses
 *        (a bounded per-line dry run of the real state transition): a candidate
 *        that cannot actually resolve a mass is never proposed as a correction
 *     -> return the existing `Phase4Action`s for the application to dispatch
 *
 * WHAT IT IS NOT
 * --------------
 *   - NOT a matcher: every FDC id, record digest, review digest, portion index
 *     and gram weight comes from the authenticated session review.
 *   - NOT a model call: no AI is involved; the same inputs produce the same
 *     actions every time.
 *   - NOT a writer: it dispatches nothing, persists nothing, and never touches
 *     the recipe or the vault.
 *   - NOT a guesser: a line with no VERIFIED supported correction is reported
 *     unresolved rather than forced. Actions are per-line all-or-nothing, so a
 *     half-corrected line is never emitted.
 */

import { runBatchInvestigation } from './batchInvestigation';
import { prepareShisoProposalActions } from './proposalActions';
import {
  buildCalculationRequest,
  buildCountPortionChoice,
  phase4Reducer,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4Action,
  type Phase4Row,
  type Phase4State,
} from '../nutritionV2/phase4';
import type { LiveRowState } from '../nutritionV2/phase4/liveRow';
import type { ShisoNutritionCorrectionUnresolved } from './protocol';

export interface ShisoNutritionCorrection {
  readonly line_ref: string;
  readonly label: string;
  /** Authenticated evidence text: record description + portion + real grams. */
  readonly description: string;
  readonly actions: readonly Phase4Action[];
}

export interface ShisoCorrectionsBuildResult {
  readonly corrections: readonly ShisoNutritionCorrection[];
  readonly unresolved: readonly ShisoNutritionCorrectionUnresolved[];
  readonly examined: number;
  readonly complete: boolean;
}

export interface ShisoCorrectionsInput {
  readonly session: AdvancedNutritionSession;
  readonly liveRows: readonly LiveRowState[];
  readonly adapted: readonly AdaptedIngredient[];
  /** The CURRENT working review state (the authority for rows/keys/matches). */
  readonly workingState: Phase4State;
  /** Optional subset of lines. Absent = every actionable line in the pass. */
  readonly lineRefs?: readonly string[];
}

function unresolved(
  lineRef: string,
  label: string,
  reason: string,
): ShisoNutritionCorrectionUnresolved {
  return Object.freeze({ line_ref: lineRef, label, reason });
}

/**
 * The bounded per-candidate VERIFICATION.
 *
 * A candidate correction is accepted only when the REAL state transition —
 * applying the candidate's actions through the existing reducer and running the
 * existing calculator over the affected line — genuinely resolves a positive
 * mass. This is what makes "first usable portion" safe: a `count`-kind portion
 * selected through the source-portion path produces `no_mass`, and a portion
 * whose unit cannot relate to the authored quantity also produces `no_mass`;
 * both are rejected here instead of being written into the working review.
 */
function verifiesMass(
  session: AdvancedNutritionSession,
  adapted: readonly AdaptedIngredient[],
  baseState: Phase4State,
  lineRef: string,
  actions: readonly Phase4Action[],
): boolean {
  try {
    let next = baseState;
    for (const action of actions) next = phase4Reducer(next, action);
    const request = buildCalculationRequest(adapted, next) as {
      servings: number;
      nutrient_scope: ReadonlyArray<string>;
      ingredients: ReadonlyArray<Record<string, unknown>>;
    };
    const lineInput = request.ingredients.filter((entry) => entry['line_ref'] === lineRef);
    if (lineInput.length === 0) return false;
    const calculated = session.calculate({
      servings: request.servings,
      nutrient_scope: ['calories'],
      ingredients: lineInput,
    });
    if (!calculated.ok) return false;
    const evidence = calculated.preview.ingredients.find((entry) => entry.line_ref === lineRef);
    return evidence !== undefined && typeof evidence.resolved_grams === 'number' && evidence.resolved_grams > 0;
  } catch {
    return false;
  }
}

/** Renders the bounded authenticated evidence text for a correction. */
function describePortion(recordDescription: string, measure: string, gramWeight: number): string {
  return `${recordDescription} · ${measure} = ${gramWeight} g`;
}

/**
 * Builds every VERIFIED correction for the current working review.
 * Pure: it reads authorities and returns actions; the caller owns dispatch and
 * recalculation.
 */
export function buildSupportedNutritionCorrections(
  input: ShisoCorrectionsInput,
): ShisoCorrectionsBuildResult {
  const { session, workingState } = input;
  const recipeKey = workingState.recipeKey;
  const sessionIdentity = workingState.sessionIdentity;
  if (recipeKey === null || sessionIdentity === null) {
    return {
      corrections: Object.freeze([]),
      unresolved: Object.freeze([]),
      examined: 0,
      complete: false,
    };
  }
  const reviewRows = workingState.rows;
  const adaptedByRef = new Map(input.adapted.map((entry) => [entry.line_ref, entry]));

  const report = runBatchInvestigation({ session, rows: input.liveRows });
  const wanted = input.lineRefs !== undefined ? new Set(input.lineRefs) : null;

  const corrections: ShisoNutritionCorrection[] = [];
  const unresolvedEntries: ShisoNutritionCorrectionUnresolved[] = [];

  const bound = (proposal: Parameters<typeof prepareShisoProposalActions>[0]['bound']['proposal']) => ({
    proposal_id: `${recipeKey}:correction:${proposal.line_ref}`,
    proposal_version: 'shiso_nutrition_correction_v1',
    recipe_key: recipeKey,
    session_identity: sessionIdentity,
    catalog_digest: '',
    bundle_release: '',
    proposal,
  });

  /**
   * The VERIFIED count-portion correction for an ALREADY-SELECTED record.
   *
   * This is the deterministic engine's genuine count path (the same one the
   * review UI's count controls use): the line's own parsed requirement must
   * match an authenticated count measure on the selected record, and the
   * candidate must be confirmed by the real calculator. Returns the existing
   * `select_count_portion` action, or undefined when nothing verifies.
   */
  const verifiedCountOnSelected = (
    lineRef: string,
    label: string,
    foodDescription: string,
    fdcId: number,
    reviewRow: Phase4Row,
    entry: AdaptedIngredient,
    automatic: boolean,
  ): ShisoNutritionCorrection | undefined => {
    // The count review MUST receive the STRUCTURED ingredient (amount/unit/name),
    // exactly like the review UI: the count requirement is derived from the
    // authored quantity and unit, never from the raw line text.
    const counts = session.reviewCountPortions(entry.ingredient, fdcId);
    if (!counts.ok || counts.review.applicable !== true) return undefined;
    for (const candidate of counts.review.candidates) {
      if (!(candidate.gram_weight > 0)) continue;
      const hint = { unit: candidate.unit ?? null, size: candidate.size ?? null };
      const selection =
        reviewRow.outcome === 'review_required'
          ? { kind: 'candidate' as const, fdc_id: fdcId, review_digest: reviewRow.review_digest }
          : undefined;
      const built = buildCountPortionChoice(session, {
        lineRef,
        ingredient: entry.ingredient,
        ...(reviewRow.outcome === 'review_required' ? { review: reviewRow.review } : {}),
        ...(selection !== undefined ? { selection } : {}),
        automaticSelection: automatic,
        fdcId,
        portionIndex: candidate.index,
        countRequirementHint: hint,
      });
      if (built.ok !== true) continue;
      const actions = [{ type: 'select_count_portion', lineRef, choice: built.choice } as Phase4Action];
      if (!verifiesMass(session, input.adapted, workingState, lineRef, actions)) continue;
      return Object.freeze({
        line_ref: lineRef,
        label,
        description: describePortion(foodDescription, candidate.measure, candidate.gram_weight),
        actions: Object.freeze(actions),
      });
    }
    return undefined;
  };

  for (const line of report.lines) {
    if (wanted !== null && !wanted.has(line.line_ref)) continue;
    const reviewRow = reviewRows.find((row) => row.line_ref === line.line_ref);
    const entry = adaptedByRef.get(line.line_ref);
    if (reviewRow === undefined || entry === undefined) {
      unresolvedEntries.push(unresolved(line.line_ref, line.label, 'This ingredient is not part of the current review.'));
      continue;
    }

    let accepted: ShisoNutritionCorrection | undefined;

    // ---- authenticated alternative records (ranked, first VERIFIED wins) ----
    if (line.classification === 'alternative_portion_available') {
      for (const alternative of line.alternatives) {
        const matchPrepared = prepareShisoProposalActions({
          bound: bound({
            line_ref: line.line_ref,
            ingredient_label: line.label,
            outcome: 'verified_alternative_match',
            explanation: `Use ${alternative.description}.`,
            question: null,
            fdc_id: alternative.fdc_id,
            record_digest: alternative.record_digest,
            review_digest: alternative.review_digest ?? '',
          }),
          session,
          recipeKey,
          sessionIdentity,
          rows: reviewRows,
          adapted: input.adapted,
        });
        if (matchPrepared.ok !== true) continue;

        // 1. Source portions (volume / mass) — the record's own measurable units.
        const portions = session.reviewPortions(alternative.fdc_id);
        if (portions.ok) {
          for (const candidate of portions.review.candidates) {
            if (candidate.kind !== 'volume' && candidate.kind !== 'mass') continue;
            if (candidate.effective_amount === null || !(candidate.effective_amount > 0)) continue;
            if (!(candidate.gram_weight > 0) || candidate.gram_weight >= 100000) continue;
            const portionPrepared = prepareShisoProposalActions({
              bound: bound({
                line_ref: line.line_ref,
                ingredient_label: line.label,
                outcome: 'verified_available_portion',
                explanation: `Use ${candidate.measure} (${candidate.gram_weight} g).`,
                question: null,
                fdc_id: alternative.fdc_id,
                portion_index: candidate.index,
                gram_weight: candidate.gram_weight,
                measure: candidate.measure,
                record_digest: alternative.record_digest,
              }),
              session,
              recipeKey,
              sessionIdentity,
              rows: reviewRows,
              adapted: input.adapted,
            });
            if (portionPrepared.ok !== true) continue;
            const actions = [...matchPrepared.actions, ...portionPrepared.actions];
            if (!verifiesMass(session, input.adapted, workingState, line.line_ref, actions)) continue;
            accepted = Object.freeze({
              line_ref: line.line_ref,
              label: line.label,
              description: describePortion(alternative.description, candidate.measure, candidate.gram_weight),
              actions: Object.freeze(actions),
            });
            break;
          }
        }
        if (accepted !== undefined) break;

        // 2. Count portions — only when the line's OWN requirement is a count.
        const counts = session.reviewCountPortions(entry.ingredient, alternative.fdc_id);
        if (counts.ok && counts.review.applicable === true) {
          for (const candidate of counts.review.candidates) {
            if (!(candidate.gram_weight > 0)) continue;
            const hint = { unit: candidate.unit ?? null, size: candidate.size ?? null };
            const selection =
              reviewRow.outcome === 'review_required'
                ? { kind: 'candidate' as const, fdc_id: alternative.fdc_id, review_digest: reviewRow.review_digest }
                : undefined;
            const built = buildCountPortionChoice(session, {
              lineRef: line.line_ref,
              ingredient: entry.ingredient,
              ...(reviewRow.outcome === 'review_required' ? { review: reviewRow.review } : {}),
              ...(selection !== undefined ? { selection } : {}),
              automaticSelection: false,
              fdcId: alternative.fdc_id,
              portionIndex: candidate.index,
              countRequirementHint: hint,
            });
            if (built.ok !== true) continue;
            const actions = [
              ...matchPrepared.actions,
              { type: 'select_count_portion', lineRef: line.line_ref, choice: built.choice } as Phase4Action,
            ];
            if (!verifiesMass(session, input.adapted, workingState, line.line_ref, actions)) continue;
            accepted = Object.freeze({
              line_ref: line.line_ref,
              label: line.label,
              description: describePortion(alternative.description, candidate.measure, candidate.gram_weight),
              actions: Object.freeze(actions),
            });
            break;
          }
        }
        if (accepted !== undefined) break;
      }
      // Final fallback for an alternative-classified line: the SELECTED record's
      // own count path. `collectAlternatives` accepts count-kind portions as
      // "usable", so a line can be labelled `alternative_portion_available`
      // while the only genuinely resolvable route is the count measure on the
      // record the analyzer already selected. Trying it keeps the correction
      // GENERAL rather than food-specific.
      if (accepted === undefined && typeof line.current_fdc_id === 'number') {
        accepted = verifiedCountOnSelected(
          line.line_ref,
          line.label,
          line.current_food ?? 'selected record',
          line.current_fdc_id,
          reviewRow,
          entry,
          workingState.matches[line.line_ref]?.automatic === true,
        );
      }
      if (accepted === undefined) {
        unresolvedEntries.push(
          unresolved(line.line_ref, line.label, 'No authenticated alternative portion could resolve this ingredient.'),
        );
      }
      if (accepted !== undefined) corrections.push(accepted);
      continue;
    }

    // ---- authenticated count portion on the already-selected record --------
    if (line.classification === 'count_portion_available') {
      const fdcId = line.current_fdc_id;
      if (typeof fdcId !== 'number') {
        unresolvedEntries.push(
          unresolved(line.line_ref, line.label, 'The authenticated count portion could not be resolved.'),
        );
        continue;
      }
      accepted = verifiedCountOnSelected(
        line.line_ref,
        line.label,
        line.current_food ?? 'selected record',
        fdcId,
        reviewRow,
        entry,
        workingState.matches[line.line_ref]?.automatic === true,
      );
      if (accepted === undefined) {
        unresolvedEntries.push(
          unresolved(line.line_ref, line.label, 'No authenticated count portion could resolve this ingredient.'),
        );
      } else {
        corrections.push(accepted);
      }
      continue;
    }

    // ---- no supported correction ---------------------------------------------
    unresolvedEntries.push(unresolved(line.line_ref, line.label, line.reason));
  }

  // Requested lines that are not actionable at all are named rather than
  // silently dropped, so "apply these" can never claim more than it did.
  if (wanted !== null) {
    const known = new Set(report.lines.map((line) => line.line_ref));
    for (const lineRef of wanted) {
      if (known.has(lineRef)) continue;
      const reviewRow = reviewRows.find((row) => row.line_ref === lineRef);
      unresolvedEntries.push(
        unresolved(
          lineRef,
          reviewRow?.original_text.slice(0, 120) ?? 'ingredient',
          'That ingredient needs no correction (or is not part of the current review).',
        ),
      );
    }
  }

  return {
    corrections: Object.freeze(corrections),
    unresolved: Object.freeze(unresolvedEntries),
    examined: report.examined,
    complete: report.complete,
  };
}
