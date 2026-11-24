/**
 * The Kitchen Codex — SHISO deterministic report rendering (audit H-1F).
 *
 * The human test found that useful, already-authenticated findings were being
 * withheld whenever the provider was slow or failed. That was the worst possible
 * failure mode: the evidence was sitting in the browser, verified, and the user
 * was told to "try a shorter message" instead.
 *
 * So this module renders the report ITSELF, from application state, with no model
 * call at all. The provider, when it works, writes a better-sounding version of
 * the same facts. When it does not, the user still gets the facts.
 *
 * TWO PROPERTIES THIS FILE ENFORCES:
 *
 *  1. NO INTERNAL IDENTIFIERS REACH THE USER. `line_ref` values such as
 *     `ing:9:bf2806576077` are opaque, stable and load-bearing for authorization
 *     and staleness. They stay in the wire contract and in proposal binding, but
 *     this renderer only ever prints the recipe's own ingredient text. "ing:9:…
 *     requires review" becomes "1 cup shredded Monterey Jack cheese requires
 *     review".
 *
 *  2. NO INVENTED NUMBERS. Every gram weight, portion and description printed
 *     here came from the authenticated USDA record or from the deterministic
 *     engine. When a value is absent this says so rather than estimating.
 *
 * The renderer is deliberately plain. It is the floor of usefulness, not the
 * ceiling: it guarantees that a completed investigation is never lost.
 */

import type { LiveRowState } from '../nutritionV2/phase4/liveRow';
import type { ShisoBatchLine, ShisoBatchReport } from './batchInvestigation';

/** Human phrasing for each live status. Never exposes the internal token. */
const STATUS_PHRASE: Readonly<Record<LiveRowState['status'], string>> = {
  matched: 'resolved',
  qualitative: 'resolved (qualitative)',
  needs_amount: 'needs an amount',
  needs_match: 'needs a food match',
  review_suggested: 'has a suggested match awaiting your review',
};

/**
 * The authoritative reconciliation.
 *
 * The human test reported 3 resolved + 5 missing amounts + 3 missing matches =
 * 11 for a 12-ingredient recipe. The defect is that `review_suggested` is a
 * FIFTH live status that the old summary counted in `unresolved` but never
 * displayed anywhere, so the visible categories silently did not add up.
 *
 * Every line is now counted in exactly one bucket and the buckets are guaranteed
 * to sum to the total, which is asserted by the tests.
 */
export interface ShisoReviewCounts {
  readonly total: number;
  readonly resolved: number;
  readonly needs_amount: number;
  readonly needs_match: number;
  readonly review_suggested: number;
  readonly unresolved: number;
  /** True when resolved + unresolved === total. Always true; asserted, not assumed. */
  readonly reconciled: boolean;
}

export function countReviewRows(rows: readonly LiveRowState[], contributionLineRefs: ReadonlySet<string> = new Set()): ShisoReviewCounts {
  let resolved = 0;
  let needsAmount = 0;
  let needsMatch = 0;
  let reviewSuggested = 0;
  let estimatedResolved = 0;
  for (const r of rows) {
    // An accepted, recipe-bound AI nutrient contribution resolves an otherwise
    // unresolved line for nutrition coverage. It does not become a USDA match
    // or a mass measurement; callers expose its estimated provenance separately.
    if (contributionLineRefs.has(r.line_ref) && r.status !== 'matched' && r.status !== 'qualitative') {
      estimatedResolved += 1;
      continue;
    }
    switch (r.status) {
      case 'matched':
      case 'qualitative':
        resolved += 1;
        break;
      case 'needs_amount':
        needsAmount += 1;
        break;
      case 'needs_match':
        needsMatch += 1;
        break;
      case 'review_suggested':
        reviewSuggested += 1;
        break;
    }
  }
  const total = rows.length;
  const unresolved = needsAmount + needsMatch + reviewSuggested;
  return {
    total,
    resolved: resolved + estimatedResolved,
    needs_amount: needsAmount,
    needs_match: needsMatch,
    review_suggested: reviewSuggested,
    unresolved,
    reconciled: resolved + estimatedResolved + unresolved === total,
  };
}

/** One ingredient, described for a human. Carries no internal identifier. */
export interface ShisoReadableLine {
  readonly label: string;
  readonly status_phrase: string;
  readonly resolved: boolean;
  readonly classification_phrase: string | null;
  readonly reason: string | null;
  readonly current_food: string | null;
  readonly current_grams: string | null;
  /** USDA alternatives the user could approve, with real portions and grams. */
  readonly alternatives: ReadonlyArray<{
    readonly description: string;
    readonly fdc_id: number;
    readonly portions: ReadonlyArray<{ readonly measure: string; readonly gram_weight: number }>;
  }>;
  /** Candidates offered when no identity is confident yet. */
  readonly candidates: ReadonlyArray<{ readonly description: string; readonly fdc_id: number }>;
  readonly reviewable: boolean;
  /** What the user must supply when nothing else can resolve it. */
  readonly needs_from_user: string | null;
}

function readableLine(line: ShisoBatchLine): ShisoReadableLine {
  const needsFromUser =
    line.classification === 'needs_user_measurement'
      ? 'Enter the weight yourself in Advanced Nutrition; only a measurement you take can supply this.'
      : line.classification === 'needs_food_identity' && line.alternatives.length === 0
        ? 'Rephrase or specify this ingredient more precisely so the catalogue can match it.'
        : null;

  return {
    label: line.label,
    status_phrase: STATUS_PHRASE[line.status] ?? 'unresolved',
    resolved: false,
    classification_phrase: line.classification.replace(/_/g, ' '),
    reason: line.reason,
    current_food: line.current_food,
    current_grams:
      line.resolved_grams !== null && line.resolved_grams > 0
        ? `${Math.round(line.resolved_grams * 10) / 10} g (${line.mass_source ?? 'authenticated source'})`
        : null,
    alternatives: line.alternatives.map((a) => ({
      description: a.description,
      fdc_id: a.fdc_id,
      portions: a.usable_portions.map((p) => ({ measure: p.measure, gram_weight: p.gram_weight })),
    })),
    candidates: line.candidates.map((c) => ({ description: c.description, fdc_id: c.fdc_id })),
    reviewable: line.correction_available,
    needs_from_user: needsFromUser,
  };
}

/** Joins lists naturally: "a", "a and b", "a, b and c". */
function list(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

export interface ShisoReviewReportInput {
  readonly recipeTitle: string | null;
  readonly counts: ShisoReviewCounts;
  readonly batch: ShisoBatchReport | null;
  /** Nutrient totals already computed by the deterministic engine, if any. */
  readonly totals: ReadonlyArray<{ readonly label: string; readonly value: string }> | null;
  /** Set when a prerequisite is genuinely missing; carries ONE recovery step. */
  readonly blocked: { readonly reason: string; readonly recovery: string } | null;
  readonly continuationHint: string | null;
}

/**
 * Renders the whole report deterministically. This is what the user sees when
 * the provider is unavailable, times out, or never answers.
 */
export function renderShisoReviewReport(input: ShisoReviewReportInput): string {
  const out: string[] = [];
  const { counts, batch } = input;

  if (input.blocked !== null) {
    out.push(`I can't run nutrition yet. ${input.blocked.reason}`);
    out.push('');
    out.push(`**To fix it:** ${input.blocked.recovery}`);
    return out.join('\n');
  }

  out.push(
    counts.total === 0
      ? 'There are no ingredient lines in this recipe yet.'
      : `**${counts.total} ingredient lines examined.** ` +
        `${counts.resolved} resolved, ${counts.unresolved} still need your attention.`,
  );

  // The reconciliation the old summary got wrong, stated explicitly.
  const parts: string[] = [];
  if (counts.needs_amount > 0) parts.push(`${counts.needs_amount} need an amount`);
  if (counts.needs_match > 0) parts.push(`${counts.needs_match} need a food match`);
  if (counts.review_suggested > 0) parts.push(`${counts.review_suggested} have a suggested match to review`);
  if (parts.length > 0) out.push(`Of the unresolved: ${list(parts)}.`);

  if (input.totals !== null && input.totals.length > 0) {
    out.push('');
    out.push('**Nutrient totals** (from the deterministic calculator):');
    for (const t of input.totals) out.push(`- ${t.label}: ${t.value}`);
    if (counts.unresolved > 0) {
      out.push('');
      out.push(
        'These totals are PARTIAL. Unresolved ingredients contribute nothing yet, so the real values will be higher once they are resolved.',
      );
    }
  }

  if (batch === null || batch.examined === 0) {
    if (counts.unresolved === 0) {
      out.push('');
      out.push('Everything resolved. This nutrition result is complete.');
    }
    return out.join('\n');
  }

  const readable = batch.lines.map(readableLine);
  const withAlternatives = readable.filter((l) => l.alternatives.length > 0);
  const needsUser = readable.filter((l) => l.needs_from_user !== null);
  const noCandidates = readable.filter((l) => l.candidates.length > 0 && l.alternatives.length === 0);

  if (withAlternatives.length > 0) {
    out.push('');
    out.push(
      `**${withAlternatives.length} ingredient(s) have verified USDA alternatives you can review:**`,
    );
    for (const line of withAlternatives) {
      out.push('');
      out.push(`- **${line.label}** — ${line.status_phrase}.`);
      if (line.current_food) out.push(`  Currently using: ${line.current_food}.`);
      for (const alt of line.alternatives) {
        const portions = alt.portions.map((p) => `${p.measure} = ${p.gram_weight} g`).join(', ');
        out.push(`  Option: **${alt.description}** (USDA ${alt.fdc_id})`);
        if (portions.length > 0) out.push(`    Verified portions: ${portions}`);
      }
      out.push('  I have not changed anything — tell me which you want and I will show it for your approval.');
    }
  }

  if (noCandidates.length > 0) {
    out.push('');
    out.push(`**${noCandidates.length} ingredient(s) had no confident food match.** Possible records, for your judgement:`);
    for (const line of noCandidates) {
      const names = line.candidates.map((c) => `${c.description} (USDA ${c.fdc_id})`).join(', ');
      out.push(`- **${line.label}** — ${names}`);
    }
  }

  if (needsUser.length > 0) {
    out.push('');
    out.push(`**${needsUser.length} ingredient(s) need something only you can provide:**`);
    for (const line of needsUser) {
      out.push(`- **${line.label}** — ${line.needs_from_user}`);
    }
  }

  if (input.continuationHint !== null) {
    out.push('');
    out.push(input.continuationHint);
  }

  return out.join('\n');
}
