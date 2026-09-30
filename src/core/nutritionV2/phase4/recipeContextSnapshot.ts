/**
 * The Kitchen Codex — AI Advanced Nutrition: whole-recipe context snapshot
 * binding (AI-4A, PHASE 1 — local only).
 *
 * PURE, OFFLINE, LOCAL ONLY. This binding:
 *  - NEVER crosses the wire (no transport module owns or forwards it);
 *  - NEVER persists (AI-4 interpretations are SESSION-ONLY);
 *  - NEVER exposes a secret, a credential, a provider identifier or a path.
 *
 * Its single purpose is to detect a STALE recipe-context interpretation: a
 * context analysis captured for one recipe state must not be reused after the
 * title, the target line set, the authored text, the servings or the
 * deterministic instruction evidence has changed.
 *
 * IDENTITY RULE
 *  Recipe file names and paths are deliberately NOT part of this payload. The
 *  recipe-instance binding is an OPAQUE, locally supplied token, never a file
 *  name or path, so a file rename can never masquerade as recipe identity and a
 *  path can never become model-visible identity.
 *
 * DIGEST CONVENTION
 *  `recipeContextSnapshotBinding` reuses the ESTABLISHED `stableChoiceKey`
 *  convention (the same primitive `aiEstimateSnapshotBinding` uses) so a
 *  recreated-but-identical binding is never a false conflict.
 *  `recipeContextSnapshotDigest` reuses the ESTABLISHED `sha256:<hex>`
 *  convention (`canonicalStringify` + `sha256Hex`, as `digestOf` in
 *  `calculation/identityEvidence.ts` uses). Neither invents a second digest
 *  convention.
 *
 *  Both are derived from ONE canonical payload, so they can never disagree.
 *
 * NOT PART OF THE BINDING, BY DESIGN
 *  Unrelated private recipe metadata (notes, description, tags, category,
 *  cuisine, image, source), file paths, provider/model state, credentials and
 *  nutrition catalog internals (FDC ids, record/catalog digests, bundle
 *  release) MUST NOT participate. If any of them ever appears in a
 *  `RecipeContextSnapshotInput`, that is a contract violation and is refused.
 */

import { isPlainObject, toInertValue } from '../schema';
import { canonicalStringify, sha256Hex } from '../usda/digest';
import { stableChoiceKey } from './aiMidFlight';
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
  AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS,
  isAiRecipeContextAuthorityKey,
  MAX_RECIPE_CONTEXT_LINE_REF_LENGTH,
  MAX_RECIPE_CONTEXT_SERVINGS,
  MAX_RECIPE_CONTEXT_SLOTS,
  MAX_RECIPE_CONTEXT_SLOT_LENGTH,
  MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH,
  MAX_RECIPE_CONTEXT_TARGETS,
  MAX_RECIPE_CONTEXT_TITLE_LENGTH,
  type RecipeContextEnvelope,
} from './recipeContextContract';

/**
 * Opaque local recipe-instance token. NEVER a file name, never a path.
 * Bounded so a caller cannot smuggle a whole document into the binding.
 */
export const MAX_RECIPE_CONTEXT_INSTANCES_TOKEN = 200;

const SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
  'title',
  'targets',
  'base_servings',
  'recipe_instance',
]);
const SNAPSHOT_TARGET_KEYS: ReadonlySet<string> = new Set([
  'line_ref',
  'source_text',
  'instruction_slots',
]);

export type RecipeContextSnapshotFailure =
  | 'invalid_snapshot'
  | 'unsafe_snapshot'
  | 'oversized_snapshot'
  | 'authority_field'
  | 'invalid_line_ref'
  | 'duplicate_line_ref'
  | 'too_many_targets'
  | 'no_targets';

export type RecipeContextSnapshotResult =
  | { readonly ok: true; readonly snapshot: RecipeContextSnapshotInput }
  | { readonly ok: false; readonly code: RecipeContextSnapshotFailure };

/** One bounded target line participating in the recipe-context binding. */
export interface RecipeContextSnapshotTarget {
  readonly line_ref: string;
  readonly source_text: string;
  readonly instruction_slots: ReadonlyArray<string>;
}

/**
 * The canonical snapshot input. Every field participates in the binding; every
 * field is bounded; nothing else is accepted.
 */
export interface RecipeContextSnapshotInput {
  readonly title: string | null;
  readonly targets: ReadonlyArray<RecipeContextSnapshotTarget>;
  readonly base_servings: number | null;
  readonly recipe_instance: string | null;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function boundedServings(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value) || Object.is(value, -0)) return undefined;
  if (value <= 0 || value > MAX_RECIPE_CONTEXT_SERVINGS) return undefined;
  const text = String(value);
  const dot = text.indexOf('.');
  if (dot !== -1 && text.length - dot - 1 > 6) return undefined;
  return value;
}

function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenKey(entry, depth + 1));
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (isAiRecipeContextAuthorityKey(key)) return true;
    if (hasForbiddenKey(value[key], depth + 1)) return true;
  }
  return false;
}

function canonicalizeSnapshotTarget(
  raw: unknown
): RecipeContextSnapshotTarget | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) {
    if (isAiRecipeContextAuthorityKey(key)) return undefined;
    if (!SNAPSHOT_TARGET_KEYS.has(key)) return undefined;
  }
  const lineRef = boundedText(raw['line_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
  if (lineRef === undefined) return undefined;
  const sourceText = boundedText(raw['source_text'], MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH);
  if (sourceText === undefined) return undefined;

  const slotsRaw = raw['instruction_slots'];
  const slots: string[] = [];
  if (slotsRaw !== undefined && slotsRaw !== null) {
    if (!Array.isArray(slotsRaw) || slotsRaw.length > MAX_RECIPE_CONTEXT_SLOTS) return undefined;
    for (const entry of slotsRaw) {
      const slot = boundedText(entry, MAX_RECIPE_CONTEXT_SLOT_LENGTH);
      if (slot === undefined) return undefined;
      slots.push(slot);
    }
  }

  return Object.freeze({
    line_ref: lineRef,
    source_text: sourceText,
    instruction_slots: Object.freeze(slots),
  });
}

/**
 * Structural sanitizer for a locally-built recipe-context snapshot input.
 * Fail-closed. Pure. Performs no wiring (AI-4B owns that), no I/O and no mutation.
 */
export function sanitizeRecipeContextSnapshotInput(
  raw: unknown
): RecipeContextSnapshotResult {
  const inert = toInertValue(raw);
  if (!inert.ok) {
    const reason = (inert as { ok: false; reason: string }).reason;
    return {
      ok: false,
      code: reason === 'oversized' ? 'oversized_snapshot' : 'unsafe_snapshot',
    };
  }
  try {
    if (!isPlainObject(raw)) return { ok: false, code: 'invalid_snapshot' };
    for (const key of Object.keys(raw)) {
      if (isAiRecipeContextAuthorityKey(key)) return { ok: false, code: 'authority_field' };
      if (!SNAPSHOT_KEYS.has(key)) return { ok: false, code: 'invalid_snapshot' };
    }

    const titleRaw = raw['title'];
    let title: string | null = null;
    if (titleRaw !== undefined && titleRaw !== null) {
      const bounded = boundedText(titleRaw, MAX_RECIPE_CONTEXT_TITLE_LENGTH);
      if (bounded === undefined) return { ok: false, code: 'invalid_snapshot' };
      title = bounded;
    }

    const servingsRaw = raw['base_servings'];
    let baseServings: number | null = null;
    if (servingsRaw !== undefined && servingsRaw !== null) {
      const bounded = boundedServings(servingsRaw);
      if (bounded === undefined) return { ok: false, code: 'invalid_snapshot' };
      baseServings = bounded;
    }

    const instanceRaw = raw['recipe_instance'];
    let recipeInstance: string | null = null;
    if (instanceRaw !== undefined && instanceRaw !== null) {
      const bounded = boundedText(instanceRaw, MAX_RECIPE_CONTEXT_INSTANCES_TOKEN);
      if (bounded === undefined) return { ok: false, code: 'invalid_snapshot' };
      recipeInstance = bounded;
    }

    const targetsRaw = raw['targets'];
    if (!Array.isArray(targetsRaw)) return { ok: false, code: 'invalid_snapshot' };
    if (targetsRaw.length === 0) return { ok: false, code: 'no_targets' };
    if (targetsRaw.length > MAX_RECIPE_CONTEXT_TARGETS) {
      return { ok: false, code: 'too_many_targets' };
    }

    const seen = new Set<string>();
    const targets: RecipeContextSnapshotTarget[] = [];
    for (const entry of targetsRaw) {
      const target = canonicalizeSnapshotTarget(entry);
      if (target === undefined) {
        return {
          ok: false,
          code: hasForbiddenKey(entry) ? 'authority_field' : 'invalid_snapshot',
        };
      }
      if (seen.has(target.line_ref)) return { ok: false, code: 'duplicate_line_ref' };
      seen.add(target.line_ref);
      targets.push(target);
    }

    return {
      ok: true,
      snapshot: Object.freeze({
        title,
        targets: Object.freeze(targets),
        base_servings: baseServings,
        recipe_instance: recipeInstance,
      }),
    };
  } catch {
    return { ok: false, code: 'unsafe_snapshot' };
  }
}

/**
 * Derives a snapshot input from a SANITIZED envelope plus a locally supplied
 * opaque recipe-instance token.
 *
 * AI-4A owns no recipe wiring: the caller supplies the instance token and the
 * already-sanitized envelope. Nothing is read from `ObsidianRecipe` here.
 */
export function recipeContextSnapshotInputFromEnvelope(
  envelope: RecipeContextEnvelope,
  recipeInstance: string | null = null
): RecipeContextSnapshotResult {
  try {
    if (!isPlainObject(envelope)) return { ok: false, code: 'invalid_snapshot' };
    const targets = (envelope as { targets?: unknown }).targets;
    if (!Array.isArray(targets)) return { ok: false, code: 'invalid_snapshot' };
    const mapped = targets.map((target) => {
      const record = isPlainObject(target)
        ? (target as Record<string, unknown>)
        : ({} as Record<string, unknown>);
      const slots = record['instruction_slots'];
      return {
        line_ref: record['line_ref'],
        source_text: record['source_text'],
        instruction_slots: Array.isArray(slots) ? slots : [],
      };
    });
    return sanitizeRecipeContextSnapshotInput({
      title: (envelope as { title?: unknown }).title ?? null,
      targets: mapped,
      base_servings: (envelope as { base_servings?: unknown }).base_servings ?? null,
      recipe_instance: recipeInstance,
    });
  } catch {
    return { ok: false, code: 'invalid_snapshot' };
  }
}

/**
 * The ONE canonical payload both the binding and the digest are derived from.
 * Key order is load-bearing and matches the established local snapshot style
 * (short, positional keys) — never a spread of a caller object.
 */
export function recipeContextSnapshotPayload(
  input: RecipeContextSnapshotInput
): Record<string, unknown> {
  return {
    contract: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
    provenance: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
    title: input.title,
    base_servings: input.base_servings,
    recipe_instance: input.recipe_instance,
    targets: input.targets.map((target) => ({
      line: target.line_ref,
      text: target.source_text,
      slots: target.instruction_slots,
    })),
  };
}

/**
 * Deterministic LOCAL snapshot binding, in the established `stableChoiceKey`
 * convention. NEVER sent to a model. NEVER persisted.
 */
export function recipeContextSnapshotBinding(input: RecipeContextSnapshotInput): string {
  return stableChoiceKey(recipeContextSnapshotPayload(input));
}

/**
 * Deterministic LOCAL snapshot digest, in the established `sha256:<hex>`
 * convention. Derived from the SAME canonical payload as the binding.
 */
export function recipeContextSnapshotDigest(input: RecipeContextSnapshotInput): string {
  return `sha256:${sha256Hex(canonicalStringify(recipeContextSnapshotPayload(input)))}`;
}

/**
 * Snapshot CURRENTNESS. An unchanged binding means the recipe context the
 * interpretation was captured against is still the recipe context in hand.
 *
 * Fails CLOSED on a non-string or malformed captured binding: anything that is
 * not a non-empty string is NOT current.
 */
export function isRecipeContextSnapshotCurrent(
  captured: unknown,
  current: unknown
): boolean {
  if (typeof captured !== 'string' || captured.length === 0) return false;
  if (typeof current !== 'string' || current.length === 0) return false;
  return captured === current;
}

/** The bound fields, exposed for tests and for a future currentness report. */
export const RECIPE_CONTEXT_SNAPSHOT_FIELDS = Object.freeze([
  'contract',
  'provenance',
  'title',
  'base_servings',
  'recipe_instance',
  'targets',
] as const);

/** Re-exported so a future builder never re-derives the deny vocabulary. */
export { AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS };