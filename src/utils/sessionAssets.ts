/**
 * The Kitchen Codex — session-bound composite Asset + recipe operations.
 *
 * An image save is not one operation: it may write a binary Asset and then
 * persist a recipe that references it. Both halves MUST belong to the same
 * originating Vault session. This factory acquires one write lease before the
 * first Asset mutation and holds it through the recipe persistence performed by
 * the callback. A transition either cannot start the operation or waits for it
 * to settle.
 */

import type { SaveImageDeps, SessionAssetRunner, VaultAssetScope } from './vaultAssets';
import type { VaultSession, VaultSessionAuthority } from '../core/vaultSession';

export interface ActiveVaultBinding {
  readonly session: VaultSession;
  readonly adapter: unknown;
  readonly handle: any;
  readonly assetScope: VaultAssetScope;
}

function supersededError(): Error {
  const error = new Error(
    'The active Vault changed before the image could be saved. No asset or recipe was written.'
  );
  Object.defineProperty(error, 'name', { value: 'VaultSessionSupersededError' });
  return error;
}

export function createSessionAssetRunner(input: {
  readonly authority: VaultSessionAuthority;
  readonly getActive: () => ActiveVaultBinding;
  readonly createDeps: (handle: any, assetScope: VaultAssetScope) => SaveImageDeps;
  readonly isUnavailable?: () => boolean;
}): SessionAssetRunner {
  const { authority, getActive, createDeps, isUnavailable } = input;
  return async function run<T>(operation: (deps: SaveImageDeps) => Promise<T>): Promise<T> {
    const active = getActive();
    const session = active.session;
    if (
      isUnavailable?.() ||
      session.kind !== 'filesystem' ||
      !active.handle ||
      !active.adapter ||
      !authority.isCurrent(session) ||
      authority.writesBlocked()
    ) {
      throw supersededError();
    }
    const lease = authority.beginWrite(session);
    if (!lease) throw supersededError();
    try {
      return await operation(createDeps(active.handle, active.assetScope));
    } finally {
      lease.release();
    }
  };
}
