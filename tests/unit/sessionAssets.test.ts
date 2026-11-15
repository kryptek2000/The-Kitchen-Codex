import { describe, expect, it, vi } from 'vitest';
import { createVaultSessionAuthority } from '../../src/core/vaultSession';
import { createSessionAssetRunner } from '../../src/utils/sessionAssets';
import type { SaveImageDeps } from '../../src/utils/vaultAssets';
import { createVaultAssetScope } from '../../src/utils/vaultAssets';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function establishedFilesystemSession(authority: ReturnType<typeof createVaultSessionAuthority>) {
  const transition = authority.beginTransition('filesystem');
  return (await authority.commitTransition(transition, () => {})).session!;
}

describe('session-bound composite asset operations', () => {
  it('runs a normal same-Vault asset+recipe operation and releases the lease', async () => {
    const authority = createVaultSessionAuthority();
    const session = await establishedFilesystemSession(authority);
    const deps: SaveImageDeps = { asset: { write: vi.fn() } as any, folderHandle: { name: 'Vault A' } };
    const runner = createSessionAssetRunner({
      authority,
      getActive: () => ({ session, adapter: {}, handle: { name: 'Vault A' }, assetScope: createVaultAssetScope(session.id, { active: true }) }),
      createDeps: () => deps,
    });

    const result = await runner(async (boundDeps) => {
      expect(boundDeps).toBe(deps);
      expect(authority.activeWriteCount(session)).toBe(1);
      return 'saved';
    });
    expect(result).toBe('saved');
    expect(authority.activeWriteCount(session)).toBe(0);
  });

  it('holds one lease across asset and recipe work so a transition waits, then cannot start a new A write', async () => {
    const authority = createVaultSessionAuthority();
    const session = await establishedFilesystemSession(authority);
    const operationStarted = deferred();
    const releaseOperation = deferred();
    const runner = createSessionAssetRunner({
      authority,
      getActive: () => ({ session, adapter: {}, handle: { name: 'Vault A' }, assetScope: createVaultAssetScope(session.id, { active: true }) }),
      createDeps: () => ({ folderHandle: { name: 'Vault A' } }),
    });

    const runPromise = runner(async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      // The outer operation is still in A. A transition is pending, so a
      // nested recipe write must not begin.
      expect(authority.beginWrite(session)).toBeNull();
      return 'asset+recipe';
    });

    await operationStarted.promise;
    const transition = authority.beginTransition('uploaded');
    let committed = false;
    const commitPromise = authority.commitTransition(transition, () => { committed = true; })
      .then((result) => { committed = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).toBe(false);

    releaseOperation.resolve();
    await expect(runPromise).resolves.toBe('asset+recipe');
    const outcome = await commitPromise;
    expect(outcome.accepted).toBe(true);
    expect(outcome.session?.kind).toBe('uploaded');
    expect(authority.isCurrent(session)).toBe(false);
  });

  it('refuses to start after the session is superseded', async () => {
    const authority = createVaultSessionAuthority();
    const session = await establishedFilesystemSession(authority);
    const transition = authority.beginTransition('uploaded');
    await authority.commitTransition(transition, () => {});
    const operation = vi.fn(async () => 'never');
    const runner = createSessionAssetRunner({
      authority,
      getActive: () => ({ session, adapter: {}, handle: { name: 'Vault A' }, assetScope: createVaultAssetScope(session.id, { active: true }) }),
      createDeps: () => ({}),
    });

    await expect(runner(operation)).rejects.toMatchObject({ name: 'VaultSessionSupersededError' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('refuses when the shell is unmounted or a transition is already pending', async () => {
    const authority = createVaultSessionAuthority();
    const session = await establishedFilesystemSession(authority);
    const runner = createSessionAssetRunner({
      authority,
      getActive: () => ({ session, adapter: {}, handle: { name: 'Vault A' }, assetScope: createVaultAssetScope(session.id, { active: true }) }),
      createDeps: () => ({}),
      isUnavailable: () => true,
    });
    await expect(runner(async () => 'never')).rejects.toMatchObject({ name: 'VaultSessionSupersededError' });

    const transition = authority.beginTransition('uploaded');
    const runner2 = createSessionAssetRunner({
      authority,
      getActive: () => ({ session, adapter: {}, handle: { name: 'Vault A' }, assetScope: createVaultAssetScope(session.id, { active: true }) }),
      createDeps: () => ({}),
    });
    await expect(runner2(async () => 'never')).rejects.toMatchObject({ name: 'VaultSessionSupersededError' });
    authority.cancelTransition(transition);
  });

  it('releases the lease when the operation throws (asset error/abort)', async () => {
    const authority = createVaultSessionAuthority();
    const session = await establishedFilesystemSession(authority);
    const runner = createSessionAssetRunner({
      authority,
      getActive: () => ({ session, adapter: {}, handle: { name: 'Vault A' }, assetScope: createVaultAssetScope(session.id, { active: true }) }),
      createDeps: () => ({}),
    });

    await expect(runner(async () => { throw new Error('asset write failed'); })).rejects.toThrow('asset write failed');
    expect(authority.activeWriteCount(session)).toBe(0);
    // No deadlock: the next transition settles immediately.
    const transition = authority.beginTransition('uploaded');
    await expect(authority.commitTransition(transition, () => {})).resolves.toMatchObject({ accepted: true, writesSettled: true });
  });
});
