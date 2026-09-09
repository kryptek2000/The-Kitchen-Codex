/**
 * The Kitchen Codex — Canonical Generated-Image Save (v0.7 Phase 2B).
 *
 * A platform-neutral APPLICATION flow that turns an existing transient preview
 * (opaque token from the generation pass) into a canonical vault change:
 *
 *   validated transient preview bytes
 *     -> explicit approval gate
 *     -> conflict validation (recipe hash / vault session / current image field)
 *     -> per-recipe-path lock (REUSES the Create-for-Me per-path lock map)
 *     -> collision-free asset path chosen INSIDE the critical section
 *     -> AssetAdapter.write(bytes)
 *     -> canonical Markdown update (image field + codex_generated_image provenance)
 *     -> VaultAdapter.writeText
 *     -> best-effort asset rollback on Markdown failure
 *     -> preview-token invalidation
 *
 * HARD RULES:
 *   - LOCAL-FIRST: the browser/platform shell owns the vault (VaultAdapter) and
 *     binary storage (AssetAdapter). The server NEVER writes the user's vault;
 *     it only owns generation + transient preview bytes. There is NO server-side
 *     arbitrary vault-filesystem write endpoint.
 *   - NO TRUSTED CLIENT BYTES: the preview record is resolved through the trusted
 *     preview source (authenticated preview GET / trusted store record). Fetched
 *     bytes are REVALIDATED at the save boundary (container/MIME agreement, size
 *     bounds) before the AssetAdapter write. Provider/model metadata originate
 *     from the validated preview record and are sanitized (bounded, single-line)
 *     before being written to frontmatter.
 *   - NEVER silently replaces a valid image. Missing or BROKEN-LOCAL image
 *     references are eligible for repair (the old broken asset file is never
 *     deleted in this phase). Remote/data references are rejected (no remote
 *     probing exists in this phase).
 *   - NO optimistic state: the caller receives success ONLY after both the asset
 *     and the canonical Markdown writes have succeeded.
 *   - The raw generation prompt is never known here and never persisted.
 */

import type { AssetAdapter } from './adapters/AssetAdapter';
import type { VaultAdapter } from './adapters/VaultAdapter';
import {
  validateGeneratedImage,
  sniffGeneratedImageMime,
  RECIPE_CONTENT_HASH_ALGORITHM,
  isValidRecipeContentHash,
  isValidVaultSessionId,
} from '../core/recipeImage';
import { assessRecipeImageHealth } from '../core/recipeImage';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../utils/markdownParser';
import { withGeneratedSaveLock } from './createForMe';

/** SHA-256 hex of the FULL canonical Markdown text (platform-neutral WebCrypto). */
export async function hashCanonicalMarkdown(markdown: string): Promise<string> {
  // WebCrypto requires the exact JSA name "SHA-256"; the canonical constant is
  // the lowercase algorithm id ('sha256'). Explicit mapping, no guessing.
  const webCryptoName = RECIPE_CONTENT_HASH_ALGORITHM === 'sha256' ? 'SHA-256' : RECIPE_CONTENT_HASH_ALGORITHM;
  const data = new TextEncoder().encode(markdown);
  const digest = await globalThis.crypto.subtle.digest(webCryptoName, data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A resolved transient preview record. ALL fields originate from the trusted
 * preview pipeline (server generation response + authenticated preview GET) —
 * never from arbitrary client input. Bytes are still REVALIDATED at the save
 * boundary before any write.
 */
export interface RecipeImagePreviewRecord {
  /** Opaque preview token (safe: embeds nothing). */
  token: string;
  /** Validated-at-generation preview bytes (revalidated here before writing). */
  bytes: Uint8Array;
  /** Declared content type from the trusted preview record. */
  contentType: string;
  /** Server-originated provider id of the generation. */
  provider: string;
  /** Server-originated model id of the generation. */
  model: string;
  /** Opaque SHA-256 of the canonical Markdown captured at preview time. */
  recipeContentHash: string;
  /** Opaque active vault session id captured at preview time. */
  vaultSessionId: string;
}

/**
 * Trusted preview-source port implemented by the shell: resolves a token via the
 * authenticated preview path (never base64-in-JSON of arbitrary client data) and
 * invalidates the token after a successful save.
 */
export interface RecipeImagePreviewSource {
  /** Resolves the trusted preview record, or undefined when unknown/expired. */
  resolvePreview(token: string): Promise<RecipeImagePreviewRecord | undefined>;
  /** Best-effort token invalidation (delete on the preview store). */
  invalidatePreview?(token: string): Promise<void>;
}

export interface GeneratedImageSaveDeps {
  vault: VaultAdapter;
  asset: AssetAdapter;
  previewSource: RecipeImagePreviewSource;
  /** Injectable clock for provenance timestamps (tests). */
  now?: () => Date;
}

export interface GeneratedImageSaveInput {
  /** The recipe's vault-relative canonical Markdown path. */
  recipePath: string;
  /** Recipe title used for asset naming (sanitized with the existing convention). */
  recipeTitle: string;
  /** Existing transient preview token from the generation pass. */
  token: string;
  /**
   * The EXPLICIT active vault session id (opaque, established by the caller).
   * Never an adapter object reference: session identity is compared by value.
   */
  activeVaultSessionId: string;
  /**
   * EXPLICIT approval gate: the flow refuses to run without it. The caller (UI)
   * sets this only after the user approves the save.
   */
  approved: boolean;
}

export interface GeneratedImageSaveResult {
  /** Canonical `image:` value written to the recipe (vault-relative asset path). */
  imagePath: string;
  provider: string;
  model: string;
  generatedAt: string;
}

/** Conflict/rejection reasons (stable, safe to surface; no secrets/prompt). */
export type RecipeImageSaveConflictReason =
  | 'NOT_APPROVED'
  | 'PREVIEW_UNAVAILABLE'
  | 'PREVIEW_INVALID'
  | 'VAULT_CHANGED'
  | 'RECIPE_CHANGED'
  | 'IMAGE_ALREADY_PRESENT'
  | 'ASSET_PATH_EXHAUSTED';

/**
 * A save rejection. Thrown BEFORE any vault mutation. Carries only a stable
 * reason and a safe message — never a prompt, secret, token bytes, or raw
 * provider data.
 */
export class RecipeImageSaveConflictError extends Error {
  readonly reason: RecipeImageSaveConflictReason;
  constructor(reason: RecipeImageSaveConflictReason, message: string) {
    super(message);
    this.name = 'RecipeImageSaveConflictError';
    this.reason = reason;
  }
}

/** Bounded collision search: Foo.ext, Foo (1).ext, ... Foo (100).ext. */
const MAX_ASSET_COLLISION_ATTEMPTS = 100;

/** Derives the asset extension from the VALIDATED preview content type (existing Assets/ conventions). */
function assetExtension(contentType: string): string {
  const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/avif') return 'avif';
  return 'jpg'; // image/jpeg (existing convention: .jpg)
}

/** Same title sanitization convention as `saveImageToVaultAssets` (unchanged). */
function sanitizeAssetTitle(title: string): string {
  return String(title ?? '').replace(/[/\\?%*:|"<>]/g, '-').trim() || 'Recipe Photo';
}

/** Bounded, single-line provenance values (provider/model from the preview record). */
function sanitizeProvenanceValue(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 100);
}

/**
 * Validity check for an EXISTING local image asset. Deliberately broader than
 * the GENERATED-image allowlist (includes GIF) so a legit existing GIF image is
 * never misclassified as broken and silently replaced.
 */
function sniffMime(bytes: Uint8Array): string | undefined {
  const shared = sniffGeneratedImageMime(bytes);
  if (shared) return shared;
  // GIF (existing images only; GIF is still rejected for GENERATED output).
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return undefined;
}

/**
 * Canonical generated-image save. See module header for the transaction order
 * and rules. On rejection NO canonical mutation has occurred. On asset-write
 * success followed by Markdown failure, the newly-created asset is best-effort
 * deleted (orphan rollback) and the PRIMARY Markdown error is rethrown.
 */
export async function saveGeneratedRecipeImageToVault(
  deps: GeneratedImageSaveDeps,
  input: GeneratedImageSaveInput
): Promise<GeneratedImageSaveResult> {
  // 0. Explicit approval gate.
  if (input.approved !== true) {
    throw new RecipeImageSaveConflictError('NOT_APPROVED', 'Image save was not approved.');
  }
  const { vault, asset, previewSource } = deps;
  if (!input.recipePath || !input.recipeTitle || !input.token) {
    throw new RecipeImageSaveConflictError('PREVIEW_INVALID', 'Image save is missing its target recipe or preview.');
  }

  // (a) Verify the preview token is still valid (trusted resolution, no client bytes).
  const preview = await previewSource.resolvePreview(input.token);
  if (!preview || !preview.bytes || preview.bytes.length === 0) {
    throw new RecipeImageSaveConflictError('PREVIEW_UNAVAILABLE', 'The image preview has expired. Please generate it again.');
  }

  // Revalidate the fetched bytes at the save boundary (untrusted until proven).
  const byteValidation = validateGeneratedImage({ bytes: preview.bytes, contentType: preview.contentType });
  if (!byteValidation.valid || !byteValidation.detectedMime) {
    throw new RecipeImageSaveConflictError('PREVIEW_INVALID', 'The image preview is not a usable image. Please generate it again.');
  }

  // (b) Explicit vault-session identity match (value comparison, not reference).
  if (
    !input.activeVaultSessionId ||
    !isValidVaultSessionId(input.activeVaultSessionId) ||
    !preview.vaultSessionId ||
    !isValidVaultSessionId(preview.vaultSessionId) ||
    preview.vaultSessionId !== input.activeVaultSessionId
  ) {
    throw new RecipeImageSaveConflictError('VAULT_CHANGED', 'The vault has changed since this image was generated. Please try again.');
  }

  // Preview-time hash must exist and be well-formed (fail-safe, never skip).
  if (!isValidRecipeContentHash(preview.recipeContentHash)) {
    throw new RecipeImageSaveConflictError('RECIPE_CHANGED', 'The recipe has changed since this image was generated. Please regenerate.');
  }

  const conflictCheck = async (): Promise<void> => {
    // (c) Re-read the FULL canonical recipe Markdown.
    const markdown = await vault.readText(input.recipePath);
    // (d) SHA-256 of the FULL canonical Markdown text (not selected fields).
    const currentHash = await hashCanonicalMarkdown(markdown);
    // (e) Compare with the preview-time hash: recipe changed => reject.
    if (currentHash !== preview.recipeContentHash) {
      throw new RecipeImageSaveConflictError(
        'RECIPE_CHANGED',
        'The recipe has changed since this image was generated. Please regenerate.'
      );
    }
    // (f) Re-check the CURRENT canonical image field (never silently replace).
    const fileName = input.recipePath.split('/').pop() || input.recipePath;
    const current = parseObsidianRecipeMarkdown(markdown, fileName, input.recipePath);
    const health = await assessRecipeImageHealth({ image: current.image }, {
      asset,
      // Existing local assets accept the broader existing-image signature set.
      validateLocalBytes: (bytes) => sniffMime(bytes) !== undefined,
    });
    // Eligible: no image at all, or a BROKEN LOCAL reference (repair). Remote /
    // data references and valid local images are NEVER silently replaced.
    if (health.kind !== 'missing' && health.kind !== 'broken_local') {
      throw new RecipeImageSaveConflictError(
        'IMAGE_ALREADY_PRESENT',
        'This recipe already has a valid image. Remove it first if you want to replace it.'
      );
    }
    return undefined;
  };

  // Pre-lock conflict pass: rejects the common conflicts without serializing.
  await conflictCheck();

  // (g) Per-recipe-path lock: REUSES the Create-for-Me per-path lock map so the
  // same recipe's saves serialize across BOTH flows; different recipes proceed
  // concurrently; no global lock. The authoritative conflict re-check runs
  // INSIDE the critical section.
  return withGeneratedSaveLock(input.recipePath, async () => {
    await conflictCheck();

    // (h) Choose a safe, collision-free asset path INSIDE the critical section
    // (exists() -> suffix -> re-check loop; never overwrite an existing asset).
    const safeTitle = sanitizeAssetTitle(input.recipeTitle);
    const ext = assetExtension(preview.contentType);
    let assetPath: string | undefined;
    for (let attempt = 0; attempt <= MAX_ASSET_COLLISION_ATTEMPTS; attempt++) {
      const candidate = attempt === 0 ? `Assets/${safeTitle}.${ext}` : `Assets/${safeTitle} (${attempt}).${ext}`;
      if (!(await asset.exists(candidate))) {
        assetPath = candidate;
        break;
      }
      if (attempt === MAX_ASSET_COLLISION_ATTEMPTS) {
        throw new RecipeImageSaveConflictError('ASSET_PATH_EXHAUSTED', 'Could not find a free image file name.');
      }
    }
    const chosenAssetPath = assetPath as string;
    let savedGeneratedAt = (deps.now ?? (() => new Date()))().toISOString();

    // (i) Write image bytes through the AssetAdapter (create-only; path is free).
    await asset.write(chosenAssetPath, preview.bytes, byteValidation.detectedMime);

    // (j) Update the canonical Markdown: image field + namespaced provenance.
    try {
      const markdown = await vault.readText(input.recipePath);
      const fileName = input.recipePath.split('/').pop() || input.recipePath;
      const recipe = parseObsidianRecipeMarkdown(markdown, fileName, input.recipePath);
      const generatedAt = (deps.now ?? (() => new Date()))().toISOString();
      recipe.image = chosenAssetPath;
      // Dedicated namespaced frontmatter (nested YAML round-trip is proven safe:
      // parse -> canonical normalize -> serialize preserves nested mappings, and
      // unknown/custom keys pass through untouched). No raw prompt, ever.
      recipe.frontmatter = {
        ...(recipe.frontmatter || {}),
        codex_generated_image: {
          generated: true,
          provider: sanitizeProvenanceValue(preview.provider) || 'unknown',
          model: sanitizeProvenanceValue(preview.model) || 'unknown',
          generated_at: generatedAt,
        },
      };
      const updatedMarkdown = serializeRecipeToObsidianMarkdown(recipe);
      // (k) Write the Markdown through the canonical VaultAdapter path.
      await vault.writeText(input.recipePath, updatedMarkdown);
      savedGeneratedAt = generatedAt;
    } catch (markdownError) {
      // (l) Orphan rollback: best-effort delete of the NEW asset only. Cleanup
      // failure is logged safely and NEVER replaces the primary Markdown error.
      try {
        await asset.delete(chosenAssetPath);
      } catch (cleanupError) {
        console.warn('Image asset cleanup after failed Markdown save did not complete.', cleanupError instanceof Error ? cleanupError.name : '');
      }
      throw markdownError;
    }

    // Preview-token lifecycle: after a SUCCESSFUL save the token is invalidated
    // (best-effort). After any failure the token above may remain valid until
    // its TTL so the user can retry without regenerating.
    if (previewSource.invalidatePreview) {
      try {
        await previewSource.invalidatePreview(input.token);
      } catch {
        // Non-fatal: the token still expires by TTL; never masks success.
      }
    }

    // (m) Success ONLY after both canonical writes succeeded; the caller commits
    // UI/recipe state from this result.
    return {
      imagePath: chosenAssetPath,
      provider: sanitizeProvenanceValue(preview.provider) || 'unknown',
      model: sanitizeProvenanceValue(preview.model) || 'unknown',
      generatedAt: savedGeneratedAt,
    };
  });
}
