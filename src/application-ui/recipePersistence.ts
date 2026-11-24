/**
 * R6 — shared validated recipe persistence for application-UI shells.
 *
 * The platform-neutral application writer (`saveRecipeWithVaultAdapter`) owns
 * serialization and the non-destructive Vault write. This UI-layer wrapper adds
 * the asset destination validator and an optional session/authority recheck.
 * Browser App and Obsidian plugin both use their respective equivalent
 * boundaries; no shell writes recipe Markdown without one.
 */

import type { VaultAdapter } from '../application/adapters/VaultAdapter';
import type { AssetAdapter } from '../application/adapters/AssetAdapter';
import { validateRecipeAssetReferences } from '../utils/assetReferences';
import { saveRecipeWithVaultAdapter } from '../application/vaultRecipe';
import { serializeRecipePreservingContent } from '../utils/markdownParser';
import { resolveRecipeVaultPath } from '../core/vaultPath';
import type { ObsidianRecipe } from '../types';

interface BlobOwnerScope {
  isActive(): boolean;
  ownsUrl(url?: string): boolean;
}

export interface ValidatedRecipePersistenceOptions {
  asset?: AssetAdapter;
  folderHandle?: any;
  assetScope?: BlobOwnerScope | null;
  /** Session/authority recheck immediately before the write. */
  isCurrent?: () => boolean;
  /**
   * Exact Markdown observed when the editor opened. When supplied, an existing
   * file must still match it; an existing file without this expectation is
   * refused rather than silently overwritten.
   */
  expectedMarkdown?: string;
}

export async function saveValidatedRecipeWithVaultAdapter(
  vault: VaultAdapter,
  recipe: ObsidianRecipe,
  options: ValidatedRecipePersistenceOptions
): Promise<void> {
  if (options.isCurrent && !options.isCurrent()) {
    throw new Error('The Vault session changed before the recipe could be saved. Nothing was written.');
  }
  const path = resolveRecipeVaultPath(recipe);
  const exists = await vault.exists(path);
  if (exists) {
    if (options.expectedMarkdown === undefined) {
      throw new Error('A recipe already exists at this path. Refusing to overwrite it without an explicit edit.');
    }
    const current = await vault.readText(path);
    if (current !== options.expectedMarkdown) {
      throw new Error('The recipe changed on disk since it was opened. The save was not applied.');
    }
  } else if (options.expectedMarkdown !== undefined) {
    throw new Error('The recipe no longer exists at its original path. The save was not applied.');
  }

  const result = await validateRecipeAssetReferences(options, recipe);
  if (!result.ok) {
    throw new Error(
      result.reason || 'The recipe contains an image reference that is not valid in the active Vault.'
    );
  }

  const existsNow = await vault.exists(path);
  if (existsNow) {
    if (options.expectedMarkdown === undefined) {
      throw new Error('A recipe already exists at this path. Refusing to overwrite it without an explicit edit.');
    }
    const currentNow = await vault.readText(path);
    if (currentNow !== options.expectedMarkdown) {
      throw new Error('The recipe changed on disk since it was opened. The save was not applied.');
    }
    if (typeof vault.writeTextIfUnchanged !== 'function') {
      throw new Error('Conditional recipe writes are unavailable for this storage adapter.');
    }
    const markdown = serializeRecipePreservingContent(recipe);
    await vault.writeTextIfUnchanged(path, markdown, options.expectedMarkdown);
  } else {
    if (options.expectedMarkdown !== undefined) {
      throw new Error('The recipe no longer exists at its original path. The save was not applied.');
    }
    await saveRecipeWithVaultAdapter(vault, recipe);
  }
}
