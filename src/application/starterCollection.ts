/**
 * Signature Starter Collection — explicit Save-to-Vault service.
 *
 * Option A only:
 *  - the built-in originals are read-only and never written;
 *  - one user-initiated action copies one recipe into the connected Vault;
 *  - an existing personal copy is detected before any write;
 *  - the copy carries durable `starter_id` provenance and a private Vault path;
 *  - future collection changes never overwrite a customized copy because there
 *    is no automatic update or background copy path.
 *
 * No UI, React, or platform/FileSystemHandle code lives here. All vault access
 * goes through the existing VaultAdapter contract.
 */

import type { VaultAdapter } from './adapters/VaultAdapter';
import type { ObsidianRecipe } from '../types';
import { resolveNewRecipeVaultPath } from '../core/vaultPath';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../utils/markdownParser';
import { withGeneratedSaveLock } from './createForMe';
import {
  SIGNATURE_STARTER_COLLECTION_SOURCE,
  SIGNATURE_STARTER_SAVE_FOLDER,
} from '../data/signatureStarterCollection';

export type StarterSaveStatus =
  | 'saved'
  | 'already_saved'
  | 'path_conflict'
  | 'unavailable'
  | 'not_builtin'
  | 'error';

export interface StarterSaveResult {
  readonly status: StarterSaveStatus;
  readonly message: string;
  /** The saved or already-existing personal copy, when one is known. */
  readonly recipe?: ObsidianRecipe;
}

const SAVE_FOLDER = SIGNATURE_STARTER_SAVE_FOLDER;

/** Canonical private-Vault path for a saved built-in recipe copy. */
export function starterRecipeSavePath(recipe: ObsidianRecipe): string {
  const leaf = resolveNewRecipeVaultPath(recipe.fileName || `${recipe.title || 'recipe'}.md`);
  return `${SAVE_FOLDER}/${leaf}`;
}

/**
 * Finds an existing personal copy. Identity is checked by durable provenance
 * first, then by the exact authored title so a manual copy is not duplicated by
 * a second Save action.
 */
export function findSavedStarterCopy(
  personalRecipes: ReadonlyArray<ObsidianRecipe>,
  builtIn: ObsidianRecipe
): ObsidianRecipe | undefined {
  const starterId = builtIn.builtInId || builtIn.starterId;
  const title = builtIn.title.trim().toLowerCase();
  return personalRecipes.find((recipe) => {
    if (recipe.isBuiltIn) return false;
    if (starterId && recipe.starterId === starterId) return true;
    return recipe.title.trim().toLowerCase() === title;
  });
}

/**
 * Builds the personal copy WITHOUT writing it. The canonical serializer is used
 * so the copied Markdown is the same shape the rest of the Vault uses, and the
 * built-in provenance fields survive a reload.
 */
export function buildSavedStarterCopy(
  builtIn: ObsidianRecipe,
  targetPath: string = starterRecipeSavePath(builtIn)
): ObsidianRecipe {
  const starterId = builtIn.builtInId || builtIn.starterId || builtIn.id;
  const fileName = targetPath.split('/').pop() || builtIn.fileName;
  const frontmatter = {
    ...(builtIn.frontmatter || {}),
    starter_id: starterId,
    starter_version: builtIn.starterVersion ?? 1,
    starter_collection: SIGNATURE_STARTER_COLLECTION_SOURCE,
  };
  const copy: ObsidianRecipe = {
    ...builtIn,
    id: targetPath,
    filePath: targetPath,
    fileName,
    rawMarkdown: '',
    isBuiltIn: false,
    builtInId: undefined,
    starterId,
    starterVersion: builtIn.starterVersion ?? 1,
    frontmatter,
  };
  copy.rawMarkdown = serializeRecipeToObsidianMarkdown(copy);
  const saved = parseObsidianRecipeMarkdown(copy.rawMarkdown, fileName, targetPath);
  saved.isBuiltIn = false;
  return saved;
}

/**
 * Explicitly copy ONE built-in recipe into the connected Vault.
 *
 * Writes are serialized per canonical target path and re-check existence inside
 * the lock, so two overlapping Save clicks cannot both pass the duplicate gate.
 * The application-local lock does not claim filesystem atomicity against an
 * external writer (the VaultAdapter has no create-if-absent primitive).
 */
export async function saveStarterRecipeToVault(input: {
  readonly vault: VaultAdapter | null;
  readonly builtIn: ObsidianRecipe;
  readonly personalRecipes: ReadonlyArray<ObsidianRecipe>;
}): Promise<StarterSaveResult> {
  const { vault, builtIn, personalRecipes } = input;
  if (!builtIn.isBuiltIn) {
    return {
      status: 'not_builtin',
      message: 'Only a built-in Signature Collection recipe can be saved this way.',
    };
  }

  const existing = findSavedStarterCopy(personalRecipes, builtIn);
  if (existing) {
    return {
      status: 'already_saved',
      message: `“${builtIn.title}” is already saved in My Vault. Open the saved copy to edit it.`,
      recipe: existing,
    };
  }

  if (!vault) {
    return {
      status: 'unavailable',
      message: 'Connect a writable Vault to save this Signature Collection recipe to My Vault.',
    };
  }

  const targetPath = starterRecipeSavePath(builtIn);
  let copy: ObsidianRecipe;
  try {
    copy = buildSavedStarterCopy(builtIn, targetPath);
  } catch {
    return {
      status: 'error',
      message: 'The recipe could not be prepared for saving. The built-in original is unchanged.',
    };
  }

  try {
    return await withGeneratedSaveLock(targetPath, async () => {
      if (await vault.exists(targetPath)) {
        return {
          status: 'path_conflict' as const,
          message: `A file already exists at “${targetPath}” in your Vault. Rename or remove it before saving this built-in recipe.`,
        };
      }
      await vault.writeText(targetPath, copy.rawMarkdown);
      return {
        status: 'saved' as const,
        message: `“${builtIn.title}” was saved to My Vault at “${targetPath}”.`,
        recipe: copy,
      };
    });
  } catch {
    return {
      status: 'error',
      message: 'The recipe could not be written to the Vault. Nothing was changed in the built-in collection.',
    };
  }
}
