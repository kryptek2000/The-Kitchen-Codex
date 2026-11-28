/**
 * Phase 4 — culinary ingredient investigation.
 *
 * Pure, offline projection helpers used by SHISO to separate food identity from
 * preparation, quantity, authored alternatives, and flexible mixtures BEFORE a
 * catalogue search is shown to the model. This module owns no matching,
 * nutrition, or persistence authority:
 *
 *   - identity/projection reuse the canonical Phase 2 parser/projector through
 *     the Phase 4 boundary;
 *   - every candidate still comes from the authenticated session's own review;
 *   - compatibility is only a bounded relevance filter over that ranked set;
 *   - selection, portions, grams, and nutrients remain the existing Phase 4/5
 *     authorities.
 */

import { parseIngredient } from '../matching/parse';
import {
  projectIngredientAlternatives,
  projectQueryText,
} from '../matching/query';

export type CulinaryMeasurementKind =
  | 'mass'
  | 'volume'
  | 'count'
  | 'unknown';

export interface CulinaryAlternative {
  readonly label: string;
  readonly primary: boolean;
}

export interface CulinaryIngredientProjection {
  readonly original: string;
  /** The food identity used for catalogue discovery. */
  readonly identity: string;
  /** Every identity branch that may be investigated (primary/equal/mixture). */
  readonly identities: readonly string[];
  readonly amount: number | null;
  readonly unit: string | null;
  readonly measurement_kind: CulinaryMeasurementKind;
  readonly alternatives: readonly CulinaryAlternative[];
  readonly primary_index: number | null;
  /** Authored flexible mixture such as `(such as red onion, pepper or broccoli)`. */
  readonly flexible_mixture: boolean;
  /** True when the user must choose a branch/composition before a definitive result. */
  readonly choice_required: boolean;
  /** True only for equal authored alternatives (`a or b`), not a primary + alternate. */
  readonly equal_choice: boolean;
  /** Present when the authored measure cannot be converted without invention. */
  readonly measurement_note: string | null;
}

export interface CandidateIdentityVerdict {
  readonly compatible: boolean;
  readonly reason: string | null;
}

const COMPOSITE_DISH_TOKENS: ReadonlySet<string> = new Set([
  'biscuit',
  'burger',
  'burrito',
  'casserole',
  'curry',
  'entree',
  'meal',
  'mix',
  'nacho',
  'noodle',
  'pasta',
  'pizza',
  'platter',
  'prepared',
  'quesadilla',
  'restaurant',
  'salad',
  'sandwich',
  'soup',
  'stew',
  'taco',
  'wrap',
]);

const VAGUE_MEASURES: ReadonlySet<string> = new Set([
  'pinch',
  'pinches',
  'dash',
  'dashes',
  'handful',
  'handfuls',
  'sprinkle',
  'sprinkles',
  'smidgen',
  'smidgens',
]);

function normalTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token);
}

function tokenSet(value: string): ReadonlySet<string> {
  return new Set(normalTokens(value));
}

function splitFlexibleMixture(text: string): readonly string[] {
  const match = /\(\s*such as\s+([^)]+)\)/i.exec(text) ?? /\bsuch as\s+(.+)$/i.exec(text);
  if (!match) return [];
  return (match[1] ?? '')
    .split(/\s*,\s*|\s+or\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * Projects one authored ingredient line into bounded culinary facts. It never
 * chooses an alternative or invents a composition.
 */
export function projectCulinaryIngredient(text: string): CulinaryIngredientProjection {
  const original = String(text).normalize('NFKC').trim().slice(0, 500);
  const parsed = parseIngredient(original);
  const identitySource = parsed.ok ? parsed.parsed.query : original;
  const projected = projectQueryText(identitySource);
  const identity = projected.food_identity.trim() || identitySource.trim();
  const alternativesProjection = projectIngredientAlternatives(original);
  const flexibleOptions = splitFlexibleMixture(original);
  const flexibleMixture = flexibleOptions.length > 1;

  let alternatives: CulinaryAlternative[];
  let primaryIndex: number | null = null;
  let equalChoice = false;
  if (flexibleMixture) {
    alternatives = flexibleOptions.map((label) => ({ label, primary: false }));
    equalChoice = false;
  } else if (alternativesProjection !== null) {
    primaryIndex = alternativesProjection.primary_index;
    equalChoice = primaryIndex === null;
    alternatives = alternativesProjection.alternatives.map((label, index) => ({
      label,
      primary: primaryIndex === index,
    }));
  } else {
    alternatives = [];
  }

  const identities = flexibleMixture
    ? flexibleOptions
    : alternatives.length > 0
      ? equalChoice
        ? alternatives.map((entry) => entry.label)
        : [alternatives.find((entry) => entry.primary)?.label ?? identity]
      : [identity];

  const amount = parsed.ok ? parsed.parsed.amount : null;
  const unit = parsed.ok ? parsed.parsed.raw_unit ?? null : null;
  const measurementKind: CulinaryMeasurementKind = parsed.ok
    ? parsed.parsed.measurement_kind === 'mass'
      ? 'mass'
      : parsed.parsed.measurement_kind === 'volume'
        ? 'volume'
        : parsed.parsed.measurement_kind === 'count'
          ? 'count'
          : 'unknown'
    : 'unknown';
  const vagueMeasure = unit !== null && VAGUE_MEASURES.has(unit.toLowerCase());
  const measurementNote = vagueMeasure
    ? `“${unit}” has no documented exact mass conversion. Use a measured amount or a clearly labeled estimate; do not treat a pinch as a verified weight.`
    : !parsed.ok
      ? 'The authored quantity could not be parsed safely.'
      : null;

  return Object.freeze({
    original,
    identity,
    identities: Object.freeze(identities.filter((entry) => entry.length > 0)),
    amount,
    unit,
    measurement_kind: measurementKind,
    alternatives: Object.freeze(alternatives),
    primary_index: primaryIndex,
    flexible_mixture: flexibleMixture,
    choice_required: flexibleMixture || equalChoice || vagueMeasure,
    equal_choice: equalChoice,
    measurement_note: measurementNote,
  });
}

/**
 * Bounded relevance check over the session's already-ranked candidates.
 *
 * It rejects a candidate whose primary head is a different food (sunflower seed
 * butter for butter), and prepared/composite dishes when the query did not ask
 * for one. It does not score, select, or authenticate anything.
 */
export function candidateIdentityVerdict(
  identity: string,
  description: string,
): CandidateIdentityVerdict {
  const queryTokens = normalTokens(projectQueryText(identity).food_identity || identity);
  const candidateTokens = normalTokens(description);
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return { compatible: false, reason: 'empty_identity' };
  }
  const querySet = new Set(queryTokens);
  const candidateSet = new Set(candidateTokens);
  const primaryToken = queryTokens[queryTokens.length - 1]!;
  const headTokens = normalTokens(description.split(',')[0] ?? '');
  const headSet = new Set(headTokens);
  const headMatchesPrimary = headSet.has(primaryToken);

  const composite = candidateTokens.find(
    (token) => COMPOSITE_DISH_TOKENS.has(token) && !querySet.has(token),
  );
  if (composite !== undefined) {
    return { compatible: false, reason: `prepared_or_composite:${composite}` };
  }

  if (headMatchesPrimary) return { compatible: true, reason: null };
  // USDA descriptions frequently put the specific food after a broad category
  // (`Nuts, pecans`; `Cheese, monterey jack`). A complete comma segment equal to
  // the identity is much stronger evidence than mere token overlap.
  const segments = description.split(',').map((segment) => normalTokens(segment));
  if (segments.some((segment) =>
    segment.length === queryTokens.length &&
    queryTokens.every((token) => segment.includes(token))
  )) {
    return { compatible: true, reason: null };
  }
  if (queryTokens.length === 1) {
    return { compatible: false, reason: 'different_food_head' };
  }
  if (queryTokens.every((token) => candidateSet.has(token))) {
    return { compatible: true, reason: null };
  }
  return { compatible: false, reason: 'missing_query_identity' };
}

/** True when a candidate description should be shown as the authored primary. */
export function candidateMatchesAnyIdentity(
  identities: readonly string[],
  description: string,
): boolean {
  return identities.some((identity) => candidateIdentityVerdict(identity, description).compatible);
}
