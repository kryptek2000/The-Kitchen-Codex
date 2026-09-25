/**
 * The Kitchen Codex — Advanced Nutrition Phase 5B: explicit Apply coordinator.
 *
 * APPLICATION-LAYER, platform-neutral write/commit boundary. It is the ONLY
 * Advanced Nutrition surface permitted to persist `codex_nutrition`. It does NOT
 * calculate nutrition and does NOT construct the schema block: it consumes the
 * genuine Phase 5A authorization and writes the exact candidate it returns.
 *
 * TRUST RULE
 * ----------
 * A caller-supplied `codex_nutrition` object, Phase 5A candidate, or Phase 5A
 * identity is NEVER authoritative. Immediately before the write, this module
 * re-runs `authorizeNutritionPersistence` from the current genuine Phase 4
 * session + current recipe + current reviewed state + current existing block.
 * Only the candidate returned by that fresh authorization is written. Any
 * authority mutation between an earlier UI eligibility check and Apply fails
 * closed (`stale_authorization`), so the TOCTOU window cannot be exploited.
 *
 * WRITE PATH
 * ----------
 * The actual persistence is injected as a `write` port. In the browser shell it
 * is the SAME authoritative recipe write path used by the recipe editor
 * (`saveRecipeWithVaultAdapter` / the disconnected download fallback); this
 * module never touches File System Access, IndexedDB, or the vault directly.
 * An optional `readBack` port re-reads the persisted Markdown for post-write
 * verification.
 *
 * ATOMICITY
 * ---------
 * The updated recipe is serialized BEFORE the write, so a serialization failure
 * never reaches the writer. The in-memory recipe is committed by the injected
 * writer ONLY after the canonical write succeeds. No partial nutrient merge is
 * ever performed: the `codex_nutrition` slot is replaced as one whole block.
 *
 * It performs NO automatic/background write: it is invoked only by an explicit
 * user Apply action.
 */

import { isPlainObject } from '../core/nutritionV2/schema';
import { canonicalStringify, sha256Hex } from '../core/nutritionV2/usda/digest';
import { decodeCodexNutrition, encodeCodexNutrition } from '../core/nutritionV2/validate';
import { authorizeNutritionPersistence } from '../core/nutritionV2/phase5';
import { readOwnDataField } from '../core/nutritionV2/phase4/materialize';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../utils/markdownParser';
import type { ObsidianRecipe } from '../types';

export const ADVANCED_NUTRITION_APPLY_VERSION = 'advanced_nutrition_apply_v1';

// ---------------------------------------------------------------------------
// Closed failure taxonomy (fixed, bounded, input-redacted)
// ---------------------------------------------------------------------------

export type AdvancedNutritionApplyFailureCode =
  | 'not_authorized'
  | 'stale_authorization'
  | 'unknown_future_schema'
  | 'invalid_existing_block'
  | 'serialization_failed'
  | 'write_failed'
  | 'post_write_verification_failed'
  | 'unsafe_request'
  | 'unavailable_write_target';

export const ADVANCED_NUTRITION_APPLY_FAILURE_MESSAGE: Readonly<
  Record<AdvancedNutritionApplyFailureCode, string>
> = Object.freeze({
  not_authorized: 'advanced_nutrition_not_authorized',
  stale_authorization: 'advanced_nutrition_stale_authorization',
  unknown_future_schema: 'advanced_nutrition_unknown_future_schema',
  invalid_existing_block: 'advanced_nutrition_invalid_existing_block',
  serialization_failed: 'advanced_nutrition_serialization_failed',
  write_failed: 'advanced_nutrition_write_failed',
  post_write_verification_failed: 'advanced_nutrition_post_write_verification_failed',
  unsafe_request: 'advanced_nutrition_unsafe_request',
  unavailable_write_target: 'advanced_nutrition_unavailable_write_target',
});

/** Fixed, bounded, user-readable messages. Never echo caller/exception content. */
export const ADVANCED_NUTRITION_APPLY_UI_MESSAGE: Readonly<
  Record<AdvancedNutritionApplyFailureCode, string>
> = Object.freeze({
  not_authorized: 'This reviewed result cannot be applied right now. Recalculate and review it again.',
  stale_authorization: 'The recipe or review changed before Apply completed. Nothing was written.',
  unknown_future_schema:
    'This recipe uses a newer Advanced Nutrition format this version cannot safely replace. Nothing was written.',
  invalid_existing_block:
    'The existing Advanced Nutrition data is not valid and was not replaced. Nothing was written.',
  serialization_failed: 'The recipe could not be prepared for saving. Nothing was written.',
  write_failed: 'Saving the recipe failed. Nothing was changed in your vault.',
  post_write_verification_failed:
    'The recipe was written, but verification failed. Reopen the recipe to confirm.',
  unsafe_request: 'The apply request could not be processed safely. Nothing was written.',
  unavailable_write_target: 'No writable vault is connected, so Advanced Nutrition cannot be saved.',
});

export interface AdvancedNutritionApplyFailure {
  readonly code: AdvancedNutritionApplyFailureCode;
  readonly message: string;
}

export function advancedNutritionApplyFailure(
  code: AdvancedNutritionApplyFailureCode
): AdvancedNutritionApplyFailure {
  return Object.freeze({ code, message: ADVANCED_NUTRITION_APPLY_FAILURE_MESSAGE[code] });
}

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

/** The authoritative recipe writer (the SAME path the editor uses). */
export type AdvancedNutritionWritePort = (recipe: ObsidianRecipe) => Promise<void>;

/** Optional post-write re-read of the persisted Markdown text. */
export type AdvancedNutritionReadBackPort = (recipe: ObsidianRecipe) => Promise<string>;

export interface AdvancedNutritionApplyRequest {
  /** Genuine Phase 4 session (opaque authority). */
  readonly session: unknown;
  /** Current recipe (untrusted; re-authorized fresh). */
  readonly recipe: unknown;
  /** Current Phase 4 reviewed state (untrusted; re-authorized fresh). */
  readonly state: unknown;
  /** The existing authoritative recipe write path. */
  readonly write: AdvancedNutritionWritePort;
  /** Optional post-write verification re-read. */
  readonly readBack?: AdvancedNutritionReadBackPort;
  /**
   * The create/replace mode the UI showed the user at eligibility time. When
   * supplied, a change of the current stored block's mode before the write
   * fails closed (`stale_authorization`), so a create can never silently become
   * an unreviewed replace (or vice versa).
   */
  readonly expectedMode?: unknown;
  /**
   * TEST-ONLY timestamp seam forwarded to Phase 5A. The production UI NEVER
   * supplies this: Phase 5A owns the candidate `computed_at`.
   */
  readonly computedAt?: unknown;
}

export interface AdvancedNutritionApplySuccess {
  readonly mode: 'create' | 'replace';
  readonly candidate_digest: string;
  readonly authorization_version: string;
  readonly recipe_key: string;
}

export type AdvancedNutritionApplyResult =
  | { ok: true; result: AdvancedNutritionApplySuccess }
  | { ok: false; failure: AdvancedNutritionApplyFailure };

function fail(code: AdvancedNutritionApplyFailureCode): AdvancedNutritionApplyResult {
  return { ok: false, failure: advancedNutritionApplyFailure(code) };
}

// ---------------------------------------------------------------------------
// Defensive helpers
// ---------------------------------------------------------------------------

type FieldRead = { ok: true; present: boolean; value: unknown } | { ok: false };

function ownField(object: object, key: string): FieldRead {
  return readOwnDataField(object, key);
}

/**
 * Reads the recipe's current raw `codex_nutrition` block through guarded
 * own-data descriptors (preferring the raw frontmatter value, then the typed
 * decoded projection). Never invokes an accessor.
 */
function readExistingBlock(recipe: unknown): { ok: true; value: unknown } | { ok: false } {
  if (!isPlainObject(recipe)) return { ok: false };
  const frontmatter = ownField(recipe, 'frontmatter');
  if (!frontmatter.ok) return { ok: false };
  if (frontmatter.present && frontmatter.value !== null && frontmatter.value !== undefined) {
    if (!isPlainObject(frontmatter.value)) return { ok: false };
    const raw = ownField(frontmatter.value, 'codex_nutrition');
    if (!raw.ok) return { ok: false };
    if (raw.present && raw.value !== null && raw.value !== undefined) return { ok: true, value: raw.value };
  }
  const typed = ownField(recipe, 'codexNutrition');
  if (!typed.ok) return { ok: false };
  if (typed.present && typed.value !== null && typed.value !== undefined) return { ok: true, value: typed.value };
  return { ok: true, value: undefined };
}

/** Maps a fresh Phase 5A authorization failure onto the Phase 5B taxonomy. */
function mapAuthorizationFailure(code: string): AdvancedNutritionApplyFailureCode {
  switch (code) {
    case 'unknown_future_schema':
      return 'unknown_future_schema';
    case 'stale_preview':
    case 'calculation_mismatch':
      return 'stale_authorization';
    case 'unsafe_request':
      return 'unsafe_request';
    case 'schema_invalid':
      return 'invalid_existing_block';
    case 'unresolved_authority':
    case 'invalid_servings':
    case 'invalid_request':
    case 'validation_error':
    default:
      return 'not_authorized';
  }
}

/**
 * Verifies the persisted Markdown contains a recognized schema-v1 or schema-v2
 * block whose canonical encoding matches the just-authorized candidate digest.
 * Throws a fixed error on any mismatch (the caller maps it to a bounded
 * failure).
 */
function verifyPersistedBlock(
  markdown: string,
  recipe: ObsidianRecipe,
  candidateDigest: string
): void {
  const parsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
  const decoded = decodeCodexNutrition(parsed.codexNutrition);
  if (decoded.kind !== 'v1' && decoded.kind !== 'v2') throw new Error('advanced_nutrition_verify');
  const encoded = encodeCodexNutrition(decoded.value);
  const digest = `sha256:${sha256Hex(canonicalStringify(encoded))}`;
  if (digest !== candidateDigest) throw new Error('advanced_nutrition_verify');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Explicitly applies the current reviewed Advanced Nutrition result to the
 * recipe through the injected writer. Never throws; always returns a closed
 * result with bounded, input-redacted failures.
 */
export async function applyAdvancedNutrition(requestRaw: unknown): Promise<AdvancedNutritionApplyResult> {
  try {
    if (!isPlainObject(requestRaw)) return fail('unsafe_request');

    const sessionField = ownField(requestRaw, 'session');
    const recipeField = ownField(requestRaw, 'recipe');
    const stateField = ownField(requestRaw, 'state');
    const writeField = ownField(requestRaw, 'write');
    const readBackField = ownField(requestRaw, 'readBack');
    const computedAtField = ownField(requestRaw, 'computedAt');

    if (!sessionField.ok || !sessionField.present) return fail('unsafe_request');
    if (!recipeField.ok || !recipeField.present) return fail('unsafe_request');
    if (!stateField.ok || !stateField.present) return fail('unsafe_request');
    if (!writeField.ok || !writeField.present || typeof writeField.value !== 'function') {
      return fail('unavailable_write_target');
    }
    if (readBackField.ok && readBackField.present && typeof readBackField.value !== 'function') {
      return fail('unsafe_request');
    }

    const existing = readExistingBlock(recipeField.value);
    if (!existing.ok) return fail('unsafe_request');

    // Protect unknown future / malformed existing data BEFORE any authorization,
    // so the failure taxonomy is deterministic and no write is attempted.
    const decodedExisting = decodeCodexNutrition(existing.value);
    if (decodedExisting.kind === 'opaque') return fail('unknown_future_schema');
    if (decodedExisting.kind === 'malformed') return fail('invalid_existing_block');
    const currentMode: 'create' | 'replace' =
      decodedExisting.kind === 'v1' || decodedExisting.kind === 'v2' ? 'replace' : 'create';

    // The mode the UI showed must still match the current stored block.
    const expectedModeField = ownField(requestRaw, 'expectedMode');
    if (!expectedModeField.ok) return fail('unsafe_request');
    if (expectedModeField.present && expectedModeField.value !== undefined && expectedModeField.value !== null) {
      if (expectedModeField.value !== currentMode) return fail('stale_authorization');
    }

    // --- IMMEDIATE PRE-WRITE RE-PROOF --------------------------------------
    const authorization = authorizeNutritionPersistence({
      session: sessionField.value,
      recipe: recipeField.value,
      state: stateField.value,
      existingBlock: existing.value,
      ...(computedAtField.ok && computedAtField.present ? { computedAt: computedAtField.value } : {}),
    });
    if (!authorization.ok) {
      return fail(mapAuthorizationFailure((authorization as { ok: false; failure: { code: string } }).failure.code));
    }
    const candidate = authorization.candidate;

    // The freshly authorized mode MUST match the freshly decoded existing block.
    if (candidate.identity.mode !== currentMode) return fail('stale_authorization');

    // --- Whole-block update (never a piecemeal merge) ----------------------
    const base = recipeField.value as ObsidianRecipe;
    const priorFrontmatter = isPlainObject((base as { frontmatter?: unknown }).frontmatter)
      ? ((base as { frontmatter: Record<string, unknown> }).frontmatter)
      : {};
    const updated: ObsidianRecipe = {
      ...base,
      codexNutrition: candidate.block,
      frontmatter: { ...priorFrontmatter, codex_nutrition: candidate.encoded },
    };

    // Serialize BEFORE writing so a serialization failure never reaches the writer.
    try {
      serializeRecipeToObsidianMarkdown(updated);
    } catch {
      return fail('serialization_failed');
    }

    // --- Write through the existing authoritative path ---------------------
    try {
      await (writeField.value as AdvancedNutritionWritePort)(updated);
    } catch {
      return fail('write_failed');
    }

    // --- Optional post-write verification ----------------------------------
    if (readBackField.ok && readBackField.present && typeof readBackField.value === 'function') {
      try {
        const markdown = await (readBackField.value as AdvancedNutritionReadBackPort)(updated);
        verifyPersistedBlock(markdown, updated, candidate.identity.candidate_digest);
      } catch {
        return fail('post_write_verification_failed');
      }
    }

    return {
      ok: true,
      result: Object.freeze({
        mode: candidate.identity.mode,
        candidate_digest: candidate.identity.candidate_digest,
        authorization_version: candidate.identity.authorization_version,
        recipe_key: candidate.identity.recipe_key,
      }),
    };
  } catch {
    return fail('unsafe_request');
  }
}
