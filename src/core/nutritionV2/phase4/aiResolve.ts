/**
 * The Kitchen Codex — Advanced Nutrition: AI-assisted USDA resolution (local).
 *
 * PURE, offline, advisory-only. This is the phase-4 boundary helper that turns
 * SANITIZED AI interpretation suggestions into genuine LOCAL USDA candidates:
 *
 *   AI search phrase -> session.reviewIngredient (pinned catalog) ->
 *   selectAutomaticMatch / selectBestEffortMatch (the SAME deterministic
 *   confidence contract as the one-click analyzer) -> a manual selection bound to
 *   the ORIGINAL row's review digest.
 *
 * SOURCE-CONSTRAINT PARITY (Phase 2)
 * ----------------------------------
 * AI may reinterpret food wording, but it may NEVER weaken or erase explicit
 * constraints already present in the authenticated source line. Before a strict
 * or best-effort candidate is accepted for an AI suggestion, its explicit
 * wording is re-checked against the source line's container-implied state,
 * physical state, and preparation/product form (the SAME closed Phase 2
 * projection helpers the deterministic pipeline uses). The source context is
 * reconstructed LOCALLY from the session-bound row text through the canonical
 * Phase 1 parser — it is never taken from the provider response.
 *
 * The AI never grants authority. A candidate is only offered (or auto-selected)
 * when the deterministic matcher independently accepts it against the pinned
 * catalog AND it does not contradict the authenticated source constraints;
 * otherwise the row stays for user review / manual search.
 */

import { selectAutomaticMatch, selectBestEffortMatch } from '../matching/confidence';
import { normalizeQuery } from '../matching/normalize';
import { parseIngredient } from '../matching/parse';
import {
  impliedStateCompatibilityMismatchCount,
  preparationFormContradictionCount,
  projectQueryText,
  stateContradictionCount,
  type IngredientQueryProjection,
} from '../matching/query';
import type { MatchChoice, Phase4Row } from './types';
import type { AdvancedNutritionSession, AdaptedIngredient } from './types';
import type { AiResolutionSuggestion } from '../aiResolution';

export interface AiResolveCandidate {
  readonly line_ref: string;
  /** The AI search phrase that produced the candidate. */
  readonly query: string;
  readonly fdc_id: number;
  readonly description: string;
  readonly record_digest: string;
  /**
   * True when the deterministic confidence contract accepts the candidate as an
   * automatic/best-effort selection; false means the user must review it.
   */
  readonly auto: boolean;
  /** Bound manual selection for the ORIGINAL row (no mass; never authoritative). */
  readonly choice: MatchChoice;
}

export interface AiResolveOutcome {
  readonly candidates: ReadonlyArray<AiResolveCandidate>;
  /** Line refs for which no deterministic candidate was found. */
  readonly unresolved: ReadonlyArray<string>;
  /** Number of candidates the deterministic contract accepts automatically. */
  readonly auto_count: number;
}

export interface AiResolveParams {
  readonly session: AdvancedNutritionSession;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly suggestions: ReadonlyArray<AiResolutionSuggestion>;
}

/**
 * Converts an OFFERED (below-threshold) AI suggestion into the genuine
 * user-confirmed choice produced by an explicit "Use this match" click.
 *
 * EXPLICIT CLICK = USER CONFIRMED. Every automatic-authority marker is stripped:
 * the deterministic calculator re-authenticates the manual selection against the
 * pinned bundle and reports `user_confirmed` (never `auto_confirmed`). The
 * display-only `aiAssisted` provenance is retained so the UI can still say the
 * suggestion originated from AI; it carries no authority.
 */
export function userConfirmedChoiceFromAiSuggestion(choice: MatchChoice): MatchChoice {
  const candidate: MatchChoice = { ...choice };
  delete (candidate as { aiAccepted?: boolean }).aiAccepted;
  delete (candidate as { automatic?: boolean }).automatic;
  return Object.freeze({ ...candidate, aiAssisted: true });
}

/** Working rows eligible for AI assistance: those the analyzer did not resolve. */
export function aiResolutionEligibleRows(
  rows: ReadonlyArray<Phase4Row>
): ReadonlyArray<Phase4Row> {
  return rows.filter((row) => row.outcome === 'unmatched' || row.outcome === 'invalid');
}

/**
 * Rebuilds the AUTHENTICATED source line's negative identity constraints from
 * the session-bound row text through the SAME canonical Phase 1 parse + query
 * projection the deterministic pipeline uses. Returns undefined when the source
 * cannot be reconstructed (the candidate is then judged on the suggestion's own
 * deterministic review only). Never throws.
 */
function sourceProjectionFor(row: Phase4Row): IngredientQueryProjection | undefined {
  const text = typeof row.original_text === 'string' ? row.original_text.trim() : '';
  if (text.length === 0) return undefined;
  try {
    const parsed = parseIngredient(text);
    if (!parsed.ok) return undefined;
    const query = normalizeQuery(parsed.parsed.query).text;
    if (query.length === 0) return undefined;
    return projectQueryText(query, {
      count_noun: parsed.parsed.count_noun,
      container: parsed.parsed.container,
    });
  } catch {
    return undefined;
  }
}

/**
 * True when the candidate's explicit wording contradicts a NEGATIVE constraint
 * of the authenticated source line: container-implied canned state, explicit
 * physical state, or explicit preparation/product form. Candidate silence is
 * neutral, source agreement never grants authority, and only the three closed
 * Phase 2 counters are used (no parallel state/form grammar).
 */
function candidateContradictsSource(
  candidateTokens: ReadonlyArray<string>,
  source: IngredientQueryProjection | undefined
): boolean {
  if (!source) return false;
  if (stateContradictionCount(candidateTokens, source) > 0) return true;
  if (impliedStateCompatibilityMismatchCount(candidateTokens, source) > 0) return true;
  if (preparationFormContradictionCount(candidateTokens, source) > 0) return true;
  return false;
}

/**
 * Resolves sanitized AI suggestions against the genuine pinned catalog. Never
 * throws; malformed/absent inputs yield no candidates for that line.
 */
export function resolveFoodsFromAiSuggestions(params: AiResolveParams): AiResolveOutcome {
  const { session, rows, suggestions } = params;
  const rowByRef = new Map(rows.map((row) => [row.line_ref, row]));
  // Authenticated source fingerprint cross-check: the adapted canonical input for
  // a line must name the SAME original text as the current row. A mismatch is a
  // stale/inconsistent source and fails CLOSED (no AI binding for that line).
  const originalByRef = new Map(
    (Array.isArray(params.adapted) ? params.adapted : []).map((entry) => [
      entry.line_ref,
      entry.ingredient.original,
    ])
  );
  const catalogDigest = session.metadata().catalog_digest;
  const candidates: AiResolveCandidate[] = [];
  const unresolved: string[] = [];

  for (const suggestion of suggestions) {
    const row = rowByRef.get(suggestion.line_ref);
    if (!row) continue;
    const adaptedOriginal = originalByRef.get(row.line_ref);
    if (adaptedOriginal !== undefined && adaptedOriginal !== row.original_text) continue;
    const sourceProjection = sourceProjectionFor(row);
    const queries: string[] = [];
    for (const query of suggestion.suggested_usda_queries) {
      const trimmed = query.trim();
      if (trimmed.length > 0 && !queries.includes(trimmed)) queries.push(trimmed);
    }
    const interpreted = suggestion.interpreted_food_name.trim();
    if (interpreted.length > 0 && !queries.includes(interpreted)) queries.push(interpreted);

    let found: AiResolveCandidate | undefined;
    let reviewCandidate: AiResolveCandidate | undefined;
    for (const query of queries) {
      let review;
      try {
        review = session.reviewIngredient({ name: query });
      } catch {
        continue;
      }
      if (!review || review.outcome === 'invalid' || review.outcome === 'unmatched') continue;
      const automatic = selectBestEffortMatch(review);
      const strict = selectAutomaticMatch(review);
      const chosen = automatic ?? strict;
      if (!chosen) continue;
      const candidate = review.candidates.find((entry) => entry.fdc_id === chosen.fdc_id);
      if (!candidate) continue;
      // NEGATIVE SOURCE VETO: provider wording may never erase an authenticated
      // source constraint (container-implied state, explicit state, or form).
      const candidateTokens = candidate.normalized_description.split(' ').filter(Boolean);
      if (candidateContradictsSource(candidateTokens, sourceProjection)) continue;
      const autoAccepted = automatic !== undefined;
      const bound = Object.freeze({
        line_ref: suggestion.line_ref,
        query,
        fdc_id: chosen.fdc_id,
        description: candidate.description,
        record_digest: candidate.record_digest,
        auto: autoAccepted,
        choice: Object.freeze({
          kind: 'manual' as const,
          fdc_id: chosen.fdc_id,
          review_digest: row.review_digest ?? '',
          record_digest: candidate.record_digest,
          catalog_digest: catalogDigest,
          description: candidate.description,
          // AI-assisted provenance is DISPLAY-only. `aiAccepted` marks a
          // deterministic acceptance (automatic authority, NOT user-confirmed);
          // an offered (below-threshold) candidate omits it so an explicit
          // "Use this match" becomes a genuine user confirmation.
          aiAssisted: true,
          ...(autoAccepted ? { aiAccepted: true } : {}),
        }),
      });
      if (autoAccepted) {
        found = bound;
        break;
      }
      if (!reviewCandidate) reviewCandidate = bound;
    }

    const picked = found ?? reviewCandidate;
    if (picked) candidates.push(picked);
    else unresolved.push(suggestion.line_ref);
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    unresolved: Object.freeze(unresolved),
    auto_count: candidates.filter((candidate) => candidate.auto).length,
  });
}
