/**
 * Signature Starter Collection — explicit, verified copying into a personal Vault.
 *
 * Product contract (owner clarification):
 *  - the nine recipes are application-owned templates;
 *  - brand-new users may browse them in My Recipe Vault before connecting a Vault;
 *  - after a Vault is connected, importing them is an explicit opt-in;
 *  - no background write, no bulk overwrite, no download fallback;
 *  - a successful write must be read back and verified before state is reconciled.
 *
 * All platform access goes through the existing VaultAdapter contract.
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
  | 'permission_required'
  | 'not_builtin'
  | 'verification_failed'
  | 'cancelled'
  | 'error';

/** Result of a guarded write; `executed: false` means no write was attempted. */
export interface VaultWriteRun<T> {
  readonly executed: boolean;
  readonly value?: T;
}

export type VaultWriteRunner = <T>(operation: () => Promise<T>) => Promise<VaultWriteRun<T>>;

export interface StarterSaveResult {
  readonly status: StarterSaveStatus;
  readonly message: string;
  /** The verified saved or already-existing personal copy, when one is known. */
  readonly recipe?: ObsidianRecipe;
}

export type SignatureImportEntryStatus =
  | 'added'
  | 'already_present'
  | 'path_conflict'
  | 'permission_required'
  | 'verification_failed'
  | 'cancelled'
  | 'failed';

export interface SignatureImportEntry {
  readonly starterId: string;
  readonly title: string;
  readonly status: SignatureImportEntryStatus;
  readonly path?: string;
  readonly message?: string;
}

export interface SignatureImportSummary {
  readonly total: number;
  readonly added: number;
  readonly alreadyPresent: number;
  readonly pathConflicts: number;
  readonly permissionRequired: number;
  readonly verificationFailed: number;
  readonly cancelled: number;
  readonly failed: number;
  readonly entries: ReadonlyArray<SignatureImportEntry>;
  /** Verified copies that should be reconciled into personal React state. */
  readonly recipes: ReadonlyArray<ObsidianRecipe>;
  readonly message: string;
  /** Present when the import stopped because its session/write grant changed. */
  readonly cancelReason?: string;
}

const SAVE_FOLDER = SIGNATURE_STARTER_SAVE_FOLDER;

/** Canonical private-Vault path for a built-in recipe copy. */
export function starterRecipeSavePath(recipe: ObsidianRecipe): string {
  const leaf = resolveNewRecipeVaultPath(recipe.fileName || `${recipe.title || 'recipe'}.md`);
  return `${SAVE_FOLDER}/${leaf}`;
}

/**
 * Finds an existing personal copy. Identity is checked by durable provenance
 * first, then by the exact authored title so a manual/retried copy is not
 * duplicated by a second Save action.
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

/** Read back the exact target and verify identity/title/content/provenance. */
export async function verifySavedStarterCopy(
  vault: VaultAdapter,
  targetPath: string,
  builtIn: ObsidianRecipe
): Promise<ObsidianRecipe> {
  const markdown = await vault.readText(targetPath);
  const fileName = targetPath.split('/').pop() || builtIn.fileName;
  const persisted = parseObsidianRecipeMarkdown(markdown, fileName, targetPath);
  const starterId = builtIn.builtInId || builtIn.starterId;
  persistenceIdentityError(persisted, builtIn, starterId, markdown);
  persisted.isBuiltIn = false;
  return persisted;
}

function persistenceIdentityError(
  persisted: ObsidianRecipe,
  builtIn: ObsidianRecipe,
  starterId: string | undefined,
  markdown: string
): void {
  if (persisted.title.trim() !== builtIn.title.trim()) {
    throw new Error('Readback title did not match the expected recipe.');
  }
  if (!starterId || persisted.starterId !== starterId) {
    throw new Error('Readback provenance did not match the expected starter_id.');
  }
  if (persisted.ingredients.length !== builtIn.ingredients.length) {
    throw new Error('Readback ingredient count did not match the expected recipe.');
  }
  if (persisted.instructions.length !== builtIn.instructions.length) {
    throw new Error('Readback instruction count did not match the expected recipe.');
  }
  if (!markdown.includes(`starter_id: ${starterId}`)) {
    throw new Error('Readback Markdown is missing starter provenance.');
  }
}

function isPermissionError(error: unknown): boolean {
  const name = (error as any)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

function saveFailureMessage(error: unknown): string {
  return isPermissionError(error)
    ? 'Vault permission is required to save this recipe.'
    : 'The recipe could not be written to the Vault.';
}

/**
 * Explicitly copy ONE built-in recipe into the connected Vault, with readback
 * verification before returning success. Writes are serialized per canonical
 * target path and existing targets are never overwritten.
 */
export async function saveStarterRecipeToVault(input: {
  readonly vault: VaultAdapter | null;
  readonly builtIn: ObsidianRecipe;
  readonly personalRecipes: ReadonlyArray<ObsidianRecipe>;
  /** Live session check; false stops any not-yet-started write. */
  readonly isCurrent?: () => boolean;
  /** Wraps the irreversible write + readback in the session write barrier. */
  readonly runWrite?: VaultWriteRunner;
  /** Destination asset-reference validation, run inside the write barrier. */
  readonly validateRecipe?: (recipe: ObsidianRecipe) => Promise<{ ok: boolean; reason?: string }>;
}): Promise<StarterSaveResult> {
  const { vault, builtIn, personalRecipes, isCurrent, runWrite, validateRecipe } = input;
  if (!builtIn.isBuiltIn) {
    return {
      status: 'not_builtin',
      message: 'Only a built-in Signature recipe can be saved this way.',
    };
  }

  if (isCurrent && !isCurrent()) {
    return {
      status: 'cancelled',
      message: 'The Vault changed before this save began. Nothing was written.',
    };
  }

  const existing = findSavedStarterCopy(personalRecipes, builtIn);
  if (existing) {
    return {
      status: 'already_saved',
      message: `“${builtIn.title}” is already in your Vault. Opening the saved copy.`,
      recipe: existing,
    };
  }

  if (!vault) {
    return {
      status: 'unavailable',
      message: 'Connect a writable Vault before saving this recipe. No files were changed.',
    };
  }

  const targetPath = starterRecipeSavePath(builtIn);
  let copy: ObsidianRecipe;
  try {
    copy = buildSavedStarterCopy(builtIn, targetPath);
  } catch {
    return {
      status: 'error',
      message: 'The recipe could not be prepared for saving. The built-in template is unchanged.',
    };
  }

  try {
    return await withGeneratedSaveLock(targetPath, async () => {
      // Re-check AFTER acquiring the per-path lock: a transition may have begun
      // while this save was queued.
      if (isCurrent && !isCurrent()) {
        return {
          status: 'cancelled' as const,
          message: 'The Vault changed before this save could write. Nothing was written.',
        };
      }
      if (await vault.exists(targetPath)) {
        try {
          const persisted = await verifySavedStarterCopy(vault, targetPath, builtIn);
          return {
            status: 'already_saved' as const,
            message: `“${builtIn.title}” is already in your Vault. Opening the saved copy.`,
            recipe: persisted,
          };
        } catch {
          return {
            status: 'path_conflict' as const,
            message: `A different file already exists at “${targetPath}”. It was not overwritten.`,
          };
        }
      }
      const performWrite = async () => {
        if (validateRecipe) {
          const validation = await validateRecipe(copy);
          if (!validation.ok) {
            return {
              status: 'error' as const,
              message: validation.reason || 'The recipe contains an image reference that is not valid in the active Vault. Nothing was written.',
            };
          }
        }
        await vault.writeText(targetPath, copy.rawMarkdown);
        try {
          const persisted = await verifySavedStarterCopy(vault, targetPath, builtIn);
          return {
            status: 'saved' as const,
            message: `Saved and verified: “${builtIn.title}” is now in your Vault.`,
            recipe: persisted,
          };
        } catch {
          return {
            status: 'verification_failed' as const,
            message: `The file was written, but readback verification failed for “${builtIn.title}”. It was not added to My Recipe Vault.`,
          };
        }
      };
      if (runWrite) {
        const outcome = await runWrite(performWrite);
        if (!outcome.executed) {
          return {
            status: 'cancelled' as const,
            message: 'The Vault changed before this save could write. Nothing was written.',
          };
        }
        return outcome.value!;
      }
      return performWrite();
    });
  } catch (error) {
    return {
      status: isPermissionError(error) ? 'permission_required' : 'error',
      message: saveFailureMessage(error),
    };
  }
}

function summaryMessage(input: Omit<SignatureImportSummary, 'message'>): string {
  const parts = [
    `${input.added} ${input.added === 1 ? 'recipe' : 'recipes'} added`,
    `${input.alreadyPresent} already in your Vault`,
  ];
  if (input.pathConflicts > 0) parts.push(`${input.pathConflicts} path conflicts`);
  if (input.permissionRequired > 0) parts.push(`${input.permissionRequired} permission errors`);
  if (input.verificationFailed > 0) parts.push(`${input.verificationFailed} verification failures`);
  if (input.cancelled > 0) parts.push(`${input.cancelled} cancelled before writing`);
  if (input.failed > 0) parts.push(`${input.failed} failed`);
  return `${parts.join('. ')}. No existing recipes were changed.`;
}

/**
 * Optional bulk import of the Signature Nine.
 *
 * Each recipe is independent: existing copies, target collisions, permission
 * failures, write failures, and readback failures are reported separately.
 * Successful writes are read back and verified before they enter React state.
 */
export async function importSignatureStarterCollection(input: {
  readonly vault: VaultAdapter | null;
  readonly builtIns: ReadonlyArray<ObsidianRecipe>;
  readonly personalRecipes: ReadonlyArray<ObsidianRecipe>;
  readonly onProgress?: (completed: number, total: number, entry: SignatureImportEntry) => void;
  /** Live check before every recipe operation. */
  readonly isCurrent?: () => boolean;
  /** Wraps the irreversible write + readback in the session write barrier. */
  readonly runWrite?: VaultWriteRunner;
  /** Human-readable reason for the current cancellation, if known. */
  readonly getCancelReason?: () => string | undefined;
  /** Destination asset-reference validation, run inside each write barrier. */
  readonly validateRecipe?: (recipe: ObsidianRecipe) => Promise<{ ok: boolean; reason?: string }>;
}): Promise<SignatureImportSummary> {
  const { vault, builtIns, personalRecipes, onProgress, isCurrent, runWrite, getCancelReason, validateRecipe } = input;
  const entries: SignatureImportEntry[] = [];
  const recipes: ObsidianRecipe[] = [];
  const workingPersonal = [...personalRecipes];
  let added = 0;
  let alreadyPresent = 0;
  let pathConflicts = 0;
  let permissionRequired = 0;
  let verificationFailed = 0;
  let cancelled = 0;
  let failed = 0;
  let cancelReason: string | undefined;

  const record = (entry: SignatureImportEntry) => {
    entries.push(entry);
    onProgress?.(entries.length, builtIns.length, entry);
    switch (entry.status) {
      case 'added': added += 1; break;
      case 'already_present': alreadyPresent += 1; break;
      case 'path_conflict': pathConflicts += 1; break;
      case 'permission_required': permissionRequired += 1; break;
      case 'verification_failed': verificationFailed += 1; break;
      case 'cancelled': cancelled += 1; break;
      default: failed += 1; break;
    }
  };

  const cancelRemaining = (remaining: ReadonlyArray<ObsidianRecipe>, reason: string) => {
    cancelReason = reason;
    for (const builtIn of remaining) {
      record({
        starterId: builtIn.builtInId || builtIn.starterId || builtIn.id,
        title: builtIn.title,
        status: 'cancelled',
        message: reason,
      });
    }
  };

  if (!vault) {
    // Every entry is genuinely permission-required. The summary must reconcile
    // with the entries instead of reporting a misleading 0 permission errors.
    return {
      total: builtIns.length,
      added: 0,
      alreadyPresent: 0,
      pathConflicts: 0,
      permissionRequired: builtIns.length,
      verificationFailed: 0,
      cancelled: 0,
      failed: 0,
      entries: builtIns.map((builtIn) => ({
        starterId: builtIn.builtInId || builtIn.starterId || builtIn.id,
        title: builtIn.title,
        status: 'permission_required' as const,
        message: 'A writable Vault connection is required.',
      })),
      recipes: [],
      message: 'A writable Vault connection is required. No files were changed.',
    };
  }

  const cancellationMessage = () =>
    getCancelReason?.() ?? 'The active Vault changed before the next recipe could be written.';

  for (let index = 0; index < builtIns.length; index += 1) {
    const builtIn = builtIns[index];
    const starterId = builtIn.builtInId || builtIn.starterId || builtIn.id;

    // Check before EVERY recipe operation. A transition may have started while
    // the preceding write/readback was settling.
    if (isCurrent && !isCurrent()) {
      cancelRemaining(builtIns.slice(index), cancellationMessage());
      break;
    }

    const existing = findSavedStarterCopy(workingPersonal, builtIn);
    if (existing) {
      record({ starterId, title: builtIn.title, status: 'already_present', path: existing.filePath });
      continue;
    }

    const targetPath = starterRecipeSavePath(builtIn);
    try {
      const result = await withGeneratedSaveLock(targetPath, async () => {
        // Re-check after acquiring the lock: queued writes must not begin after
        // the transition barrier is active.
        if (isCurrent && !isCurrent()) {
          return { status: 'cancelled' as const };
        }
        if (await vault.exists(targetPath)) {
          try {
            const persisted = await verifySavedStarterCopy(vault, targetPath, builtIn);
            return { status: 'already_present' as const, recipe: persisted };
          } catch {
            return { status: 'path_conflict' as const };
          }
        }

        const copy = buildSavedStarterCopy(builtIn, targetPath);
        const performWrite = async () => {
          if (validateRecipe) {
            const validation = await validateRecipe(copy);
            if (!validation.ok) {
              return { status: 'failed' as const, message: validation.reason };
            }
          }
          await vault.writeText(targetPath, copy.rawMarkdown);
          try {
            const persisted = await verifySavedStarterCopy(vault, targetPath, builtIn);
            return { status: 'added' as const, recipe: persisted };
          } catch {
            return { status: 'verification_failed' as const };
          }
        };

        if (runWrite) {
          const outcome = await runWrite(performWrite);
          if (!outcome.executed) return { status: 'cancelled' as const };
          return outcome.value!;
        }
        return performWrite();
      });

      if (result.status === 'added' && result.recipe) {
        workingPersonal.push(result.recipe);
        recipes.push(result.recipe);
        record({ starterId, title: builtIn.title, status: 'added', path: targetPath });
      } else if (result.status === 'already_present') {
        if (result.recipe) workingPersonal.push(result.recipe);
        record({ starterId, title: builtIn.title, status: 'already_present', path: targetPath });
      } else if (result.status === 'verification_failed') {
        record({
          starterId,
          title: builtIn.title,
          status: 'verification_failed',
          path: targetPath,
          message: 'The file could not be verified after writing.',
        });
      } else if (result.status === 'cancelled') {
        cancelRemaining(builtIns.slice(index), cancellationMessage());
        break;
      } else {
        record({
          starterId,
          title: builtIn.title,
          status: 'path_conflict',
          path: targetPath,
          message: 'A different file already exists at this path.',
        });
      }
    } catch (error) {
      if (isCurrent && !isCurrent()) {
        cancelRemaining(builtIns.slice(index), cancellationMessage());
        break;
      }
      const status: SignatureImportEntryStatus = isPermissionError(error) ? 'permission_required' : 'failed';
      record({
        starterId,
        title: builtIn.title,
        status,
        path: targetPath,
        message: saveFailureMessage(error),
      });
    }
  }

  const base = {
    total: builtIns.length,
    added,
    alreadyPresent,
    pathConflicts,
    permissionRequired,
    verificationFailed,
    cancelled,
    failed,
    entries,
    recipes,
  };
  return {
    ...base,
    message: summaryMessage(base),
    ...(cancelReason ? { cancelReason } : {}),
  };
}
