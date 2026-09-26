/**
 * The Kitchen Codex — AI Advanced Nutrition: separate benchmark accounting
 * (AI-0).
 *
 * PURE, offline, measurement-only. The DETERMINISTIC benchmark denominator and
 * scores stay unchanged (expanded `46/97`; legacy subset `42/91`). This module
 * adds the architectural ability to report future AI-Advanced performance in
 * SEPARATE buckets:
 *
 *   Deterministic:              x / N
 *   AI-assisted authenticated:  y / N
 *   AI-assisted bounded estimate: z / N
 *   Still review:               r / N
 *
 * CRITICAL ACCOUNTING RULE: an AI interpretation ALONE is never "resolved". A
 * line counts as resolved only when the DETERMINISTIC core accepted a
 * resolution. An estimate-class resolution is never counted as authenticated,
 * and an unresolved AI-assisted line lands in `still_review`.
 */

export const AI_ADVANCED_BENCHMARK_BUCKETS = Object.freeze([
  'deterministic',
  'ai_assisted_authenticated',
  'ai_assisted_bounded_estimate',
  'still_review',
  'unresolved',
] as const);
export type AiAdvancedBenchmarkBucket = (typeof AI_ADVANCED_BENCHMARK_BUCKETS)[number];

export interface AiAdvancedBenchmarkEntry {
  /** True ONLY when the deterministic core accepted a resolution. */
  readonly resolved: boolean;
  /** The deterministic mass source, when resolved. */
  readonly mass_source?:
    | 'direct_mass'
    | 'source_portion'
    | 'count_portion'
    | 'household_portion'
    | 'ai_estimate'
    | string;
  /** The deterministic authority class, when resolved. */
  readonly authority_class?: 'usda_derived' | 'vetted_standard' | 'bounded_estimate' | 'ai_estimate' | string;
  /** Display-only marker: an AI interpretation contributed. */
  readonly ai_assisted?: boolean;
  /** True when the line is intentionally left for explicit user review. */
  readonly review_required?: boolean;
}

function isEstimateResolution(entry: AiAdvancedBenchmarkEntry): boolean {
  return (
    entry.mass_source === 'ai_estimate' ||
    entry.authority_class === 'ai_estimate' ||
    entry.authority_class === 'bounded_estimate'
  );
}

function isAuthenticatedResolution(entry: AiAdvancedBenchmarkEntry): boolean {
  if (isEstimateResolution(entry)) return false;
  return (
    entry.mass_source === 'direct_mass' ||
    entry.mass_source === 'source_portion' ||
    entry.mass_source === 'count_portion' ||
    entry.mass_source === 'household_portion' ||
    entry.authority_class === 'usda_derived' ||
    entry.authority_class === 'vetted_standard'
  );
}

/**
 * Classifies one benchmark line. Conservative by construction:
 *  - anything not deterministically resolved is `still_review`/`unresolved`,
 *    even when an AI interpretation was present;
 *  - anything estimate-class is never counted as authenticated;
 *  - a "resolved" line with no provable deterministic mass source gets NO
 *    resolution credit (it falls back to review/unresolved).
 */
export function classifyAiAdvancedBenchmarkOutcome(
  entry: AiAdvancedBenchmarkEntry
): AiAdvancedBenchmarkBucket {
  if (entry.resolved !== true) {
    return entry.review_required === true ? 'still_review' : 'unresolved';
  }
  if (isEstimateResolution(entry)) return 'ai_assisted_bounded_estimate';
  if (!isAuthenticatedResolution(entry)) {
    return entry.review_required === true ? 'still_review' : 'unresolved';
  }
  return entry.ai_assisted === true ? 'ai_assisted_authenticated' : 'deterministic';
}

export interface AiAdvancedBenchmarkSummary {
  readonly total: number;
  readonly deterministic: number;
  readonly ai_assisted_authenticated: number;
  readonly ai_assisted_bounded_estimate: number;
  readonly still_review: number;
  readonly unresolved: number;
  /** Deterministic + AI-assisted authenticated (estimate is NEVER included). */
  readonly resolved_authenticated: number;
}

/**
 * Aggregates the separate buckets. `deterministic + ai_assisted_authenticated`
 * is the authenticated resolution count; bounded estimates are reported
 * separately and never inflate it.
 */
export function summarizeAiAdvancedBenchmark(
  entries: ReadonlyArray<AiAdvancedBenchmarkEntry>
): AiAdvancedBenchmarkSummary {
  const counts: Record<AiAdvancedBenchmarkBucket, number> = {
    deterministic: 0,
    ai_assisted_authenticated: 0,
    ai_assisted_bounded_estimate: 0,
    still_review: 0,
    unresolved: 0,
  };
  for (const entry of entries) {
    counts[classifyAiAdvancedBenchmarkOutcome(entry)] += 1;
  }
  return Object.freeze({
    total: entries.length,
    deterministic: counts.deterministic,
    ai_assisted_authenticated: counts.ai_assisted_authenticated,
    ai_assisted_bounded_estimate: counts.ai_assisted_bounded_estimate,
    still_review: counts.still_review,
    unresolved: counts.unresolved,
    resolved_authenticated: counts.deterministic + counts.ai_assisted_authenticated,
  });
}

/** Human-readable report mirroring the future reporting contract. */
export function formatAiAdvancedBenchmarkReport(summary: AiAdvancedBenchmarkSummary): string {
  return [
    `total: ${summary.total}`,
    `Deterministic: ${summary.deterministic} / ${summary.total}`,
    `AI-assisted authenticated: ${summary.ai_assisted_authenticated} / ${summary.total}`,
    `AI-assisted bounded estimate: ${summary.ai_assisted_bounded_estimate} / ${summary.total}`,
    `Still review: ${summary.still_review} / ${summary.total}`,
    `Unresolved: ${summary.unresolved} / ${summary.total}`,
  ].join('\n');
}
