/**
 * The Kitchen Codex — Vault connection state (UD-2A.2).
 *
 * A PURE, platform-neutral helper that decides what the application should do
 * with a REMEMBERED Vault when the application boots.
 *
 * Why this exists
 * ---------------
 * The File System Access API persists the directory HANDLE in IndexedDB, but the
 * browser's PERMISSION for that handle is session-scoped by default. After the
 * browser is closed and reopened, the handle is still there and still valid,
 * but `queryPermission()` reports 'prompt' instead of 'granted'. The browser
 * will only re-grant that permission from a USER GESTURE, via
 * `requestPermission()`.
 *
 * The previous implementation treated anything other than 'granted' as "no
 * vault", so the application silently fell back to the starter Vault with no
 * explanation and no way back: the user could not tell that their Vault was
 * still remembered, and the only recovery was to re-pick the folder from
 * scratch. This helper makes the four real situations explicit and keeps the
 * starter-Vault fallback from masquerading as the user's own data.
 *
 * It performs NO IndexedDB, handle, window, React or filesystem work.
 */

import type { VaultConnectionState } from '../types';

/** The permission states a File System Access handle can report. */
export type VaultPermissionStatus = 'granted' | 'denied' | 'prompt';

/** What the application must do about a remembered Vault. */
export type VaultRestoreAction =
  /** Nothing is remembered — stay on the starter Vault. */
  | { kind: 'none' }
  /** Permission is live — reconnect silently. */
  | { kind: 'reconnect' }
  /** The Vault is remembered but the browser needs a user gesture. */
  | { kind: 'request-authorization' }
  /** The Vault is remembered and the browser refused access. */
  | { kind: 'authorization-denied' };

/**
 * Decides the restore action for a remembered Vault handle.
 *
 * @param handlePresent  whether a handle was found in persistence at all
 * @param permission     the permission status reported by the handle
 */
export function resolveVaultRestoreAction(
  handlePresent: boolean,
  permission: VaultPermissionStatus | null | undefined
): VaultRestoreAction {
  if (!handlePresent) return { kind: 'none' };
  // A stored handle that cannot report permission is not a File System Access
  // handle (it cannot be re-authorised either), so there is nothing to offer.
  if (permission === null || permission === undefined) return { kind: 'none' };
  if (permission === 'granted') return { kind: 'reconnect' };
  if (permission === 'denied') return { kind: 'authorization-denied' };
  // 'prompt' is the normal state after a browser restart.
  return { kind: 'request-authorization' };
}

/**
 * The outcome of a user-gesture reconnect attempt.
 *
 * A STRING discriminant is used (rather than a boolean) so the union narrows
 * reliably in this project's non-strict TypeScript configuration.
 */
export type VaultReconnectResult<T> =
  | { status: 'reconnected'; data: T }
  | { status: 'denied' }
  | { status: 'no-handle' }
  | { status: 'unsupported' }
  | { status: 'error' };

/**
 * Re-authorises a REMEMBERED Vault and reconnects it.
 *
 * `requestPermission()` is a browser API that only succeeds from a USER
 * GESTURE, so this function must be called directly from a click handler. The
 * browser remains the sole authority: this helper never fabricates a granted
 * permission, never writes to the Vault, and never clears the remembered
 * handle — if the user declines, the Vault stays remembered and the starter
 * Vault is never presented as their data.
 *
 * All platform access is injected, so the decision logic is testable without
 * a browser, a handle, or IndexedDB.
 */
export async function reconnectRememberedVault<T>(deps: {
  /** Returns the remembered handle, or null when nothing is remembered. */
  getHandle: () => Promise<any | null>;
  /** Requests read/write permission for the handle. */
  requestPermission: (handle: any) => Promise<VaultPermissionStatus>;
  /** Loads the canonical vault snapshot from the handle. */
  load: (handle: any) => Promise<T>;
}): Promise<VaultReconnectResult<T>> {
  let handle: any;
  try {
    handle = await deps.getHandle();
  } catch {
    return { status: 'no-handle' };
  }
  if (!handle) return { status: 'no-handle' };
  if (typeof handle.requestPermission !== 'function') return { status: 'unsupported' };

  let status: VaultPermissionStatus;
  try {
    status = await deps.requestPermission(handle);
  } catch {
    return { status: 'error' };
  }
  if (status !== 'granted') return { status: 'denied' };

  try {
    const data = await deps.load(handle);
    return { status: 'reconnected', data };
  } catch {
    return { status: 'error' };
  }
}

/**
 * The connection state to publish for a restore action.
 *
 * The starter Vault is NEVER presented as the user's connected Vault: a
 * remembered-but-unauthorised Vault is reported as such, so the interface can
 * offer the reconnect action instead of silently swapping the user's data for
 * sample data.
 */
export function connectionStateForRestoreAction(action: VaultRestoreAction): VaultConnectionState {
  switch (action.kind) {
    case 'reconnect':
      return 'connected';
    case 'request-authorization':
      return 'reauthorization_required';
    case 'authorization-denied':
      return 'permission_denied';
    case 'none':
    default:
      return 'starter';
  }
}

/**
 * Whether the interface should offer an explicit "Reconnect Vault" action for
 * a connection state. Only a remembered Vault needs one; a starter Vault needs
 * the ordinary "Connect Vault" flow, and a live Vault needs neither.
 */
export function needsReconnectAction(state: VaultConnectionState): boolean {
  return state === 'reauthorization_required' || state === 'permission_denied';
}

/**
 * The human-readable status of a connection state, used by the header chip and
 * the sidebar status line. The quantity shown is always the RECIPE count; the
 * note count is reported separately and only when it is non-zero, so the two
 * are never conflated.
 */
export function describeVaultConnection(input: {
  state: VaultConnectionState;
  recipeCount: number;
  noteCount: number;
  rememberedVaultName?: string;
}): { label: string; detail: string; tone: 'connected' | 'starter' | 'attention' } {
  const { state, recipeCount, noteCount, rememberedVaultName } = input;
  const recipes = `${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'}`;
  const notes = noteCount > 0 ? ` · ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : '';
  const name = rememberedVaultName ? `“${rememberedVaultName}”` : 'your Vault';

  switch (state) {
    case 'connected':
      return { label: `Vault linked · ${recipes}${notes}`, detail: 'Vault connected', tone: 'connected' };
    case 'reauthorization_required':
      return {
        label: `Reconnect ${name} · ${recipes}`,
        detail: `Your Vault is remembered but the browser needs permission to reopen ${name}.`,
        tone: 'attention',
      };
    case 'permission_denied':
      return {
        label: `Vault access denied · ${recipes}`,
        detail: `The browser refused access to ${name}. Reconnect, or pick the folder again.`,
        tone: 'attention',
      };
    case 'starter':
    default:
      return {
        label: `Starter vault · ${recipes}`,
        detail: 'Sample recipes — connect your own Vault to see your recipes.',
        tone: 'starter',
      };
  }
}
