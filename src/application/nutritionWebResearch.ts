/**
 * The Kitchen Codex — application transport for bounded external nutrition
 * research (AN-WEB-1).
 *
 * The server owns provider selection, grounded search, SSRF-safe retrieval,
 * extraction, and deterministic scaling. The browser re-validates every returned
 * contribution against the EXACT requested line refs/authorship before it can be
 * offered to the user. Nothing is auto-applied.
 */

import type { NetworkAdapter, NetworkRequestOptions } from './adapters/NetworkAdapter';
import { buildAiSelectionRequestOptions } from './aiSelection';
import {
  AI_RESEARCH_REQUEST_VERSION,
  type ResearchTarget,
} from '../core/nutritionV2/aiResearch';
import {
  validateAiNutrientContributions,
  type AiNutrientContribution,
} from '../core/nutritionV2/aiContribution';

export const NUTRITION_RESEARCH_ENDPOINT = '/api/nutrition/research-ingredients';

const MAX_RESPONSE_BYTES = 96 * 1024;

export interface ResearchEvidenceOffer {
  readonly line_ref: string;
  readonly source_title: string;
  readonly source_url: string;
  readonly food_identity: string;
  readonly quantity_basis: string;
  readonly classification: 'source_backed';
  readonly nutrients: Readonly<Record<string, { readonly amount: number; readonly unit: string }>>;
  readonly assumptions: ReadonlyArray<string>;
  readonly limitations: ReadonlyArray<string>;
}

export interface ResearchSkippedLine {
  readonly line_ref: string;
  readonly reason: 'identity_ambiguous' | 'no_source' | 'unsupported_quantity_basis' | 'invalid_evidence';
}

export interface NutritionResearchRequestArgs {
  readonly network: NetworkAdapter;
  readonly targets: ReadonlyArray<ResearchTarget>;
  readonly lineRefs: ReadonlyArray<string>;
  readonly lineTextByRef: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export type NutritionResearchResult =
  | {
      readonly ok: true;
      readonly contributions: ReadonlyArray<AiNutrientContribution>;
      readonly evidence: ReadonlyArray<ResearchEvidenceOffer>;
      readonly skipped: ReadonlyArray<ResearchSkippedLine>;
      readonly sources: ReadonlyArray<{ readonly title: string; readonly url: string }>;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly skipped: ReadonlyArray<ResearchSkippedLine>;
    };

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function readSkipped(raw: unknown, allowed: ReadonlySet<string>): ResearchSkippedLine[] {
  if (!Array.isArray(raw)) return [];
  const out: ResearchSkippedLine[] = [];
  for (const item of raw) {
    if (out.length >= 10) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const lineRef = bounded(row.line_ref, 200);
    const reason = row.reason;
    if (!lineRef || !allowed.has(lineRef)) continue;
    if (reason !== 'identity_ambiguous' && reason !== 'no_source' && reason !== 'unsupported_quantity_basis' && reason !== 'invalid_evidence') continue;
    out.push(Object.freeze({ line_ref: lineRef, reason }));
  }
  return out;
}

function readEvidence(raw: unknown, allowed: ReadonlySet<string>): ResearchEvidenceOffer[] {
  if (!Array.isArray(raw)) return [];
  const out: ResearchEvidenceOffer[] = [];
  for (const item of raw) {
    if (out.length >= 3) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const lineRef = bounded(row.line_ref, 200);
    const sourceTitle = bounded(row.source_title, 200);
    const sourceUrl = bounded(row.source_url, 1000);
    const foodIdentity = bounded(row.food_identity, 200);
    const quantityBasis = bounded(row.quantity_basis, 200);
    if (!lineRef || !allowed.has(lineRef) || !sourceTitle || !sourceUrl || !foodIdentity || !quantityBasis) continue;
    let url: URL;
    try {
      url = new URL(sourceUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    if (!row.nutrients || typeof row.nutrients !== 'object' || Array.isArray(row.nutrients)) continue;
    const nutrients: Record<string, { amount: number; unit: string }> = {};
    for (const [id, value] of Object.entries(row.nutrients as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const nutrient = value as Record<string, unknown>;
      if (typeof nutrient.amount !== 'number' || !Number.isFinite(nutrient.amount) || nutrient.amount < 0) continue;
      if (typeof nutrient.unit !== 'string') continue;
      nutrients[id] = { amount: nutrient.amount, unit: nutrient.unit };
    }
    const assumptions = Array.isArray(row.assumptions)
      ? row.assumptions.map((entry) => bounded(entry, 300)).filter((entry): entry is string => entry !== undefined).slice(0, 12)
      : [];
    const limitations = Array.isArray(row.limitations)
      ? row.limitations.map((entry) => bounded(entry, 300)).filter((entry): entry is string => entry !== undefined).slice(0, 6)
      : [];
    out.push(Object.freeze({
      line_ref: lineRef,
      source_title: sourceTitle,
      source_url: url.toString(),
      food_identity: foodIdentity,
      quantity_basis: quantityBasis,
      classification: 'source_backed' as const,
      nutrients: Object.freeze(nutrients),
      assumptions: Object.freeze(assumptions),
      limitations: Object.freeze(limitations),
    }));
  }
  return out;
}

export async function requestNutritionWebResearch(
  args: NutritionResearchRequestArgs
): Promise<NutritionResearchResult> {
  if (args.targets.length === 0) {
    return { ok: false, code: 'empty', message: 'No unresolved ingredients are eligible for research.', skipped: [] };
  }
  const allowed = new Set(args.lineRefs);
  let response;
  try {
    const options: NetworkRequestOptions = await buildAiSelectionRequestOptions(
      args.signal !== undefined ? { signal: args.signal } : undefined
    );
    response = await args.network.post<Record<string, unknown>>(
      NUTRITION_RESEARCH_ENDPOINT,
      {
        request_version: AI_RESEARCH_REQUEST_VERSION,
        targets: args.targets,
      },
      options
    );
  } catch {
    return {
      ok: false,
      code: 'unavailable',
      message: 'Nutrition research is unavailable. The deterministic review and manual USDA search remain available.',
      skipped: [],
    };
  }
  if (!response || response.ok !== true) {
    const code = typeof response?.data?.['code'] === 'string' ? response.data['code'] : 'unavailable';
    const skipped = readSkipped(response?.data?.['skipped'], allowed);
    return {
      ok: false,
      code,
      message: code === 'WEB_RESEARCH_UNAVAILABLE'
        ? 'The selected AI provider does not support grounded web research.'
        : code === 'NO_SUPPORTED_RESEARCH_EVIDENCE'
          ? 'No reliable external nutrition evidence could be verified for the unresolved ingredients.'
          : 'Nutrition research is unavailable. The deterministic review and manual USDA search remain available.',
      skipped,
    };
  }
  const rawBytes = JSON.stringify(response.data ?? null);
  if (rawBytes.length > MAX_RESPONSE_BYTES) {
    return { ok: false, code: 'invalid_response', message: 'Nutrition research returned an unusable response.', skipped: [] };
  }
  const digest = bounded(response.data?.['recipe_digest'], 128);
  if (!digest) {
    return { ok: false, code: 'invalid_response', message: 'Nutrition research returned an unusable response.', skipped: [] };
  }
  if (response.data?.['request_version'] !== AI_RESEARCH_REQUEST_VERSION) {
    return { ok: false, code: 'invalid_response', message: 'Nutrition research returned an unusable response.', skipped: [] };
  }
  const checked = validateAiNutrientContributions(response.data?.['contributions'], {
    recipe_digest: digest,
    line_refs: args.lineRefs,
    line_text_by_ref: args.lineTextByRef,
    requireExclusionContext: true,
  });
  if (!checked.ok) {
    return { ok: false, code: 'invalid_response', message: 'Nutrition research returned an unusable response.', skipped: [] };
  }
  const evidence = readEvidence(response.data?.['evidence'], allowed);
  const skipped = readSkipped(response.data?.['skipped'], allowed);
  const sourcesRaw = response.data?.['sources'];
  const sources: Array<{ title: string; url: string }> = [];
  if (Array.isArray(sourcesRaw)) {
    for (const entry of sourcesRaw.slice(0, 3)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const title = bounded(row.title, 200);
      const rawUrl = bounded(row.url, 1000);
      if (!title || !rawUrl) continue;
      try {
        const url = new URL(rawUrl);
        if (url.protocol !== 'https:') continue;
        sources.push(Object.freeze({ title, url: url.toString() }));
      } catch {
        continue;
      }
    }
  }
  if (checked.contributions.length === 0) {
    return {
      ok: false,
      code: 'no_supported_evidence',
      message: 'No reliable external nutrition evidence could be verified for the unresolved ingredients.',
      skipped,
    };
  }
  return {
    ok: true,
    contributions: checked.contributions,
    evidence: Object.freeze(evidence),
    skipped: Object.freeze(skipped),
    sources: Object.freeze(sources),
    message: `Researched ${checked.contributions.length} unresolved ingredient${checked.contributions.length === 1 ? '' : 's'} from ${sources.length} external source${sources.length === 1 ? '' : 's'}. Review the evidence before using it.`,
  };
}
