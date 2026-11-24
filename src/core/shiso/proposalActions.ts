/**
 * The Kitchen Codex — SHISO proposal application (the user-authorized path).
 *
 * This is the piece that turns a CONVERSATION into a VERIFIED ACTION without
 * ever giving SHISO authority of its own.
 *
 * The division of power, restated:
 *   - SHISO (the model) may only SUGGEST which record or portion to use.
 *   - This module re-derives every identity from LIVE state and asks the EXISTING
 *     authorities whether that suggestion is actually acceptable:
 *       `confirmAdvancedNutritionMatch` for a food identity,
 *       `buildPortionChoice` / `buildCountPortionChoice` for a portion,
 *   - It then PREPARES the existing reducer actions. It never dispatches them and
 *     never touches the reducer, the calculator, or the Vault. The component that
 *     owns the working state dispatches them, so the existing state machine stays
 *     the single owner of transitions.
 *
 * Consequently a model cannot forge: an FDC id that is not in the deterministic
 * ranked candidate set, a record digest that does not match the authenticated
 * record, a portion index the record does not have, a gram weight the record does
 * not state, or an application to a different recipe.
 *
 * NOTHING HERE PERSISTS. Every result is an unsaved working-review change. The
 * user must still press the existing final Apply control.
 */

import {
  buildCountPortionChoice,
  buildPortionChoice,
  confirmAdvancedNutritionMatch,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4Action,
  type Phase4Row,
} from '../nutritionV2/phase4';

import type { ShisoBoundProposal } from './protocol';

export type ShisoApplyRejection =
  | 'no_active_review'
  | 'stale_recipe'
  | 'stale_session'
  | 'unknown_line_ref'
  | 'stale_proposal'
  | 'candidate_not_authentic'
  | 'portion_not_authentic'
  | 'nothing_to_apply';

export interface ShisoApplySuccess {
  readonly ok: true;
  readonly actions: readonly Phase4Action[];
  /** Plain-language account of exactly what was changed. */
  readonly summary: string;
  /** What will STILL be unresolved after this change, so nothing is oversold. */
  readonly remaining: string;
}

export interface ShisoApplyFailure {
  readonly ok: false;
  readonly reason: ShisoApplyRejection;
  readonly message: string;
}

export type ShisoApplyResult = ShisoApplySuccess | ShisoApplyFailure;

function fail(reason: ShisoApplyRejection, message: string): ShisoApplyFailure {
  return { ok: false, reason, message };
}

export interface PrepareShisoProposalParams {
  readonly bound: ShisoBoundProposal;
  readonly session: AdvancedNutritionSession | null;
  readonly recipeKey: string | null;
  readonly sessionIdentity: string | null;
  readonly rows: readonly Phase4Row[];
  readonly adapted: readonly AdaptedIngredient[];
}

/**
 * Validates one bound proposal against LIVE state and prepares the existing
 * authoritative actions. Returns a rejection — never a partial application — when
 * anything is stale, forged, or unsupported.
 */
export function prepareShisoProposalActions(
  params: PrepareShisoProposalParams,
): ShisoApplyResult {
  const { bound, session } = params;

  if (session === null) return fail('no_active_review', 'The USDA catalogue is not loaded.');
  if (params.recipeKey === null || bound.recipe_key !== params.recipeKey) {
    return fail('stale_recipe', 'This suggestion belongs to a different recipe. Ask Shiso again.');
  }
  if (params.sessionIdentity === null || bound.session_identity !== params.sessionIdentity) {
    return fail('stale_session', 'The nutrition session changed since this suggestion was made.');
  }

  const proposal = bound.proposal;
  const row = params.rows.find((r) => r.line_ref === proposal.line_ref);
  if (row === undefined) {
    return fail('unknown_line_ref', 'That ingredient is no longer part of this recipe.');
  }
  const entry = params.adapted.find((a) => a.line_ref === proposal.line_ref);

  const catalogDigest = session.metadata().catalog_digest;

  // ---- clarification / explanation outcomes carry no action -----------------
  if (proposal.outcome === 'clarification_required' || proposal.outcome === 'no_trustworthy_resolution') {
    return fail('nothing_to_apply', 'Shiso needs more information before anything can be changed.');
  }

  // ---- user-entered weight: GUIDANCE ONLY (B-1) ----------------------------
  //
  // SHISO may RECOMMEND that the user weigh an ingredient. It may never
  // SUPPLY the number. There is deliberately no code here that reads a weight
  // out of model prose and builds a UserMassChoice: that would convert an
  // AI suggestion into `user_mass` provenance, which is exactly the authority
  // the review pipeline reserves for a measurement the HUMAN actually entered.
  //
  // The genuine human path is the existing Advanced Nutrition manual-weight
  // control, which keeps its authority. This path only points the user at it.
  if (proposal.outcome === 'user_weight_recommended') {
    return fail(
      'nothing_to_apply',
      'Shiso can suggest weighing this ingredient, but only you can enter the weight. ' +
        'Use the existing manual-weight control in Advanced Nutrition, then the ' +
        'deterministic engine will recalculate from YOUR measurement.',
    );
  }

  // ---- alternative food identity -------------------------------------------
  if (proposal.outcome === 'verified_alternative_match') {
    // The ROW's own review snapshot, not a freshly derived one: it is the object
    // that carries this line's real `line_ref` and `review_digest`, which is what
    // the confirmation authority verifies against.
    if (row.outcome !== 'review_required' || typeof row.review_digest !== 'string') {
      return fail('candidate_not_authentic', 'That ingredient has no reviewable match set right now.');
    }
    // The selection is built from LIVE row state, never from the proposal: the
    // model supplies only the CANDIDATE it wants, and this authority decides
    // whether that candidate is genuinely in the deterministic ranked set.
    // A model-invented FDC id cannot pass.
    const confirmed = confirmAdvancedNutritionMatch(session, row.review, {
      kind: 'candidate',
      fdc_id: proposal.fdc_id,
      review_digest: row.review_digest,
    });
    if (confirmed.outcome !== 'confirmed') {
      return fail('candidate_not_authentic', 'Shiso suggested a record that is not a valid candidate here.');
    }
    const candidate = row.candidates.find((c) => c.fdc_id === proposal.fdc_id);
    const action: Phase4Action = {
      type: 'select_match',
      lineRef: row.line_ref,
      choice: {
        kind: 'manual',
        fdc_id: proposal.fdc_id,
        review_digest: confirmed.review_digest,
        record_digest: (candidate as unknown as { record_digest?: string })?.record_digest ?? proposal.record_digest,
        catalog_digest: catalogDigest,
        description: candidate?.description ?? '',
        // Explicit human approval is recorded as such; Shiso assistance is not
        // authority and never claims to be.
        automatic: false,
        user_confirmed: true,
      } as never,
    };
    return {
      ok: true,
      actions: Object.freeze([action]),
      summary: `Matched ${proposal.ingredient_label} to ${candidate?.description ?? 'the suggested record'}.`,
      remaining:
        'The ingredient may still need a portion for grams — choose one in Advanced Nutrition, or ask Shiso to investigate again.',
    };
  }

  // ---- portion on an existing (or newly suggested) identity ------------------
  if (proposal.outcome === 'verified_available_portion') {
    if (entry === undefined) return fail('unknown_line_ref', 'That ingredient line is unavailable.');
    const fdcId = row.selected_fdc_id ?? proposal.fdc_id;
    if (typeof fdcId !== 'number') {
      return fail('portion_not_authentic', 'Choose a food identity first.');
    }
    const portions = session.reviewPortions(fdcId);
    if (!portions.ok) return fail('portion_not_authentic', 'That record has no portion data.');
    const candidate = portions.review.candidates.find((c) => c.index === proposal.portion_index);
    if (candidate === undefined) {
      return fail('portion_not_authentic', 'That portion does not exist in the authenticated record.');
    }
    // The gram weight must be the RECORD's, not the model's.
    if (candidate.gram_weight !== proposal.gram_weight) {
      return fail('portion_not_authentic', 'The recorded portion weight does not match the USDA record.');
    }
    const selection =
      row.outcome === 'review_required'
        ? { kind: 'candidate' as const, fdc_id: fdcId, review_digest: row.review_digest }
        : row.outcome === 'matched_exact'
          ? { kind: 'none' as const, review_digest: row.review_digest }
          : undefined;
    const built = buildPortionChoice(session, {
      lineRef: row.line_ref,
      ingredient: entry.ingredient,
      review: row.outcome === 'review_required' ? row.review : undefined,
      selection,
      automaticSelection: false,
      fdcId,
      portionIndex: proposal.portion_index,
    } as never);
    if (!built.ok) {
      return fail('portion_not_authentic', 'That portion cannot be applied to this ingredient.');
    }
    return {
      ok: true,
      actions: Object.freeze([{ type: 'select_portion', lineRef: row.line_ref, choice: built.choice } as Phase4Action]),
      summary: `Used ${proposal.measure} (${proposal.gram_weight} g) for ${proposal.ingredient_label}.`,
      remaining: 'Nutrients recalculate from the reviewed selection. Nothing is saved until you press Apply.',
    };
  }

  // NOTE (audit F-1): there is deliberately no `verified_household_conversion`
  // branch. It was advertised as actionable but could never be produced or
  // confirmed. Household evidence is EXPLAINED via `investigate_ingredient_amount`
  // instead of being claimed as an executable conversion.

  return fail('nothing_to_apply', 'Shiso has no applicable change to make here.');
}
