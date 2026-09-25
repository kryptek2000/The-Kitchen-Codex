/**
 * The Kitchen Codex — Advanced Nutrition Phase 4/7: mid-flight user-authority
 * merge helpers.
 *
 * PURE, offline, display/review only. An AI exception-resolution request can be
 * in flight while the user edits a targeted row. These helpers are the ONE
 * implementation of the two independent protection layers the working review
 * uses when a response returns:
 *
 *   1. the PER-LINE working-choice fingerprint (captured when the request
 *      starts, re-read immediately before application), which covers every
 *      working selection that can resolve or alter one row — the food match,
 *      the authenticated source portion, the authenticated count portion, an
 *      explicit user-entered mass, and a verified household portion (including
 *      its user Clear);
 *   2. the independent household merge guard, which refuses to add an AI
 *      household choice over a line that already carries one (or any stored
 *      higher-authority mass source).
 *
 * A row whose fingerprint changed belongs to the user; its stale AI result is
 * discarded and the newer explicit decision is preserved exactly. Both layers
 * remain; neither is redundant for the other's mutation surface.
 */

import type {
  CountPortionChoice,
  HouseholdPortionChoice,
  Phase4State,
} from './types';

/**
 * Order-independent SEMANTIC key for one arbitrary working-choice value. Keys
 * are sorted recursively so a choice that is re-created with the same fields is
 * `===`-key-equal (never a false conflict), while any field the user actually
 * changed — food/FDC, review or record digest, portion index, selection digest,
 * automatic/AI provenance, mass — produces a different key. Never relies on
 * object identity. Bounded depth/keys keep it safe for frozen choice objects.
 */
export function stableChoiceKey(value: unknown, depth = 0): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number' || type === 'boolean') return String(value);
  if (type !== 'object') return 'x';
  if (depth >= 8) return 'd';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableChoiceKey(entry, depth + 1)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableChoiceKey(record[key], depth + 1)}`)
    .join(',')}}`;
}

/**
 * The PER-LINE working-choice fingerprint used to preserve mid-flight user
 * edits. It covers every working selection that can resolve or alter one row:
 * the food match (authority + provenance), the authenticated source portion,
 * the authenticated count portion, an explicit user-entered mass, and a
 * verified household portion (including its user Clear). Captured for each
 * AI-targeted row when the request starts and re-read immediately before
 * application; a changed fingerprint means the user edited that row after the
 * AI request began and the stale AI result must NOT overwrite it.
 */
export function workingChoiceFingerprint(state: Phase4State, lineRef: string): string {
  return [
    stableChoiceKey(state.matches[lineRef]),
    stableChoiceKey(state.countPortions[lineRef]),
    stableChoiceKey(state.portions[lineRef]),
    stableChoiceKey(state.userMasses[lineRef]),
    stableChoiceKey(state.householdPortions?.[lineRef]),
  ].join('\u0000');
}

/**
 * The targeted lines whose working choice changed since the request started.
 * Those rows belong to the user now: their stale AI results are discarded
 * per-line (without aborting the rest of the response).
 */
export function conflictedWorkingLineRefs(
  base: Phase4State,
  captured: ReadonlyMap<string, string>
): ReadonlySet<string> {
  const conflicted = new Set<string>();
  for (const [lineRef, fingerprint] of captured) {
    if (workingChoiceFingerprint(base, lineRef) !== fingerprint) conflicted.add(lineRef);
  }
  return conflicted;
}

export interface MergeAiHouseholdPortionsInput {
  /** The authoritative working state immediately before application. */
  readonly base: Phase4State;
  /**
   * The response-merged count-portion map (base count portions plus any count
   * choice the SAME AI response resolved). A household choice is never added
   * over the count resolution from the same response.
   */
  readonly countPortions: Readonly<Record<string, CountPortionChoice>>;
  /** The AI response's verified household resolutions. */
  readonly resolved: ReadonlyArray<{
    readonly line_ref: string;
    readonly choice: HouseholdPortionChoice;
  }>;
  readonly conflicted: ReadonlySet<string>;
}

/**
 * Merges the AI response's verified household resolutions into a fresh working
 * household map. The LOWEST mass authority is never added over:
 *   - a mid-flight-conflicted row (the user's newer decision is final);
 *   - a line that already carries a verified household choice;
 *   - a line that carries any stored higher-authority mass source (a USDA
 *     source portion, a count portion, or a user-entered total weight).
 */
export function mergeAiHouseholdPortions(
  input: MergeAiHouseholdPortionsInput
): Record<string, HouseholdPortionChoice> {
  const { base, countPortions, resolved, conflicted } = input;
  const householdPortions: Record<string, HouseholdPortionChoice> = {
    ...(base.householdPortions ?? {}),
  };
  for (const household of resolved) {
    if (conflicted.has(household.line_ref)) continue;
    if (householdPortions[household.line_ref] !== undefined) continue;
    if (
      countPortions[household.line_ref] !== undefined ||
      base.portions[household.line_ref] !== undefined ||
      base.userMasses[household.line_ref] !== undefined
    ) {
      continue;
    }
    householdPortions[household.line_ref] = Object.freeze({ ...household.choice });
  }
  return householdPortions;
}
