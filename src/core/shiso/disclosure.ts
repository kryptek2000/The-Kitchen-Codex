/**
 * The Kitchen Codex — SHISO identity disclosure (audit I-2).
 *
 * A food-identity change is the most consequential thing SHISO can ask a user to
 * approve, because the replacement record's nutrient profile IS the recipe's
 * nutrition. The user must see WHICH USDA record they are approving BEFORE they
 * click "Use this" — never the model's paraphrase of it.
 *
 * Therefore every description in this module is read from the AUTHENTICATED
 * review row, never from proposal prose. A proposal that cannot be matched back
 * to a real candidate is not disclosed at all.
 *
 * The dangerous, generalizable case this guards is a QUALIFIER DROPPING: the
 * recipe says "unsalted butter", the current record says "unsalted", and the
 * best alternative that happens to carry a usable tablespoon portion says only
 * "Butter, NFS". Approving that silently substitutes a different food — and its
 * sodium is not the same food's sodium.
 *
 * This module never computes a nutrient delta from anything but authenticated
 * data, and where no authenticated comparison is available it says so instead of
 * estimating.
 */

import type { Phase4Row } from '../nutritionV2/phase4';

export interface ShisoIdentityDisclosure {
  readonly ok: true;
  readonly authoredOriginal: string;
  readonly currentDescription: string | null;
  readonly proposedDescription: string;
  /** Authored qualifiers the replacement record does not establish. */
  readonly droppedQualifiers: readonly string[];
  /** True when the replacement silently loses a property the user specified. */
  readonly qualifierWarning: string | null;
  /** Honest statement about nutrient comparison, never an estimate. */
  readonly nutrientNote: string;
}

export interface ShisoIdentityDisclosureFailure {
  readonly ok: false;
  readonly reason: 'candidate_not_in_authenticated_review';
  readonly message: string;
}

export type ShisoIdentityDisclosureResult = ShisoIdentityDisclosure | ShisoIdentityDisclosureFailure;

/**
 * Property words whose absence from a replacement description materially changes
 * what the food IS. This is a closed, generalizable list of culinary qualifiers
 * — not an egg/butter special case.
 */
const QUALIFIER_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bun\s*salted\b|\bno salt\b/i, 'unsalted'],
  [/\bsalted\b/i, 'salted'],
  [/\bwhole\s+milk\b|\bskim\s+milk\b|\b2%\s*milk\b/i, 'milk type'],
  [/\bwhole\b/i, 'whole'],
  [/\bdark\s+roast\b|\blight\s+roast\b/i, 'roast level'],
  [/\braw\b|\broasted\b|\bcooked\b|\bboiled\b|\bbaked\b|\bfried\b/i, 'preparation form'],
  [/\bfresh\b|\bdried\b|\bfrozen\b|\bcanned\b/i, 'freshness/form'],
  [/\blean\b|\bboneless\b|\bskinless\b/i, 'cut'],
  [/\bseedless\b|\bwith pit\b|\bwith seed/i, 'seed state'],
  [/\blow\s+sodium\b|\bno\s+salt\s+added\b/i, 'sodium level'],
  [/\bwhole\s+wheat\b|\bwhite\b/i, 'variety'],
  [/\bghee\b|\bclarified\b/i, 'processing form'],
];

/**
 * Derives the disclosure for a proposed food identity from the AUTHENTICATED row.
 * `proposedDescription` always comes from the row's own candidate list, which is
 * the same set `confirmAdvancedNutritionMatch` will verify against.
 */
export function buildIdentityDisclosure(
  row: Phase4Row,
  authoredOriginal: string,
  proposedFdcId: number,
  /** The CURRENT identity from the live-row projection (authoritative). */
  current: { readonly fdc_id: number | undefined; readonly description: string | undefined } | null,
): ShisoIdentityDisclosureResult {
  const candidate = row.candidates.find((c) => c.fdc_id === proposedFdcId);
  if (candidate === undefined) {
    return {
      ok: false,
      reason: 'candidate_not_in_authenticated_review',
      message:
        'Shiso suggested a food that is not in this ingredient\u2019s authenticated candidate set, so it cannot be shown or applied.',
    };
  }

  const proposedDescription = candidate.description;
  // The CURRENT record comes from the live-row projection, which is the ONE
  // authority for what the working review has actually selected. A `needs_amount`
  // row carries its identity in the working match choice, NOT in
  // `row.selected_fdc_id` (that is only set for `matched_exact`).
  const currentDescription =
    current !== null && current.fdc_id !== undefined
      ? (current.description ??
        (row.candidates.find((c) => c.fdc_id === current.fdc_id)?.description ?? null))
      : null;

  // Qualifiers the AUTHORED line explicitly specified that the replacement record
  // does not establish. Compared against the AUTHORED text, not the model's prose.
  const authored = authoredOriginal.toLowerCase();
  const proposed = proposedDescription.toLowerCase();
  const dropped: string[] = [];
  for (const [pattern, label] of QUALIFIER_WORDS) {
    if (!pattern.test(authored)) continue;
    if (pattern.test(proposed)) continue;
    if (!dropped.includes(label)) dropped.push(label);
  }

  let qualifierWarning: string | null = null;
  if (dropped.length > 0) {
    const list = dropped.join(', ');
    qualifierWarning =
      `Careful: the suggested record does not establish "${list}" that your recipe states. ` +
      `Approving it replaces the food identity, and the nutrients that come with it.`;
  }

  return {
    ok: true,
    authoredOriginal,
    currentDescription,
    proposedDescription,
    droppedQualifiers: dropped,
    qualifierWarning,
    // Honest: no authenticated nutrient comparison is computed here. Saying so
    // is required; estimating one would be exactly the fabrication this feature
    // must never perform.
    nutrientNote:
      'Nutrient values change with the record. This panel does not estimate the difference — ' +
      'the deterministic calculator recomputes from the record you approve.',
  };
}