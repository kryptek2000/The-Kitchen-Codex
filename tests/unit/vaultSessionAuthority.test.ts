import { describe, expect, it, vi } from 'vitest';
import { createVaultSessionAuthority } from '../../src/core/vaultSession';

describe('Vault session authority — automatic reconnect arbitration', () => {
  it('does not begin automatic reconnect after any user intent', () => {
    const authority = createVaultSessionAuthority();
    expect(authority.beginAutomaticTransition('filesystem')).not.toBeNull();
    authority.cancelTransition(authority.pendingTransition()!);

    authority.beginCollectionIntent(); // user opened/started a folder import
    expect(authority.beginAutomaticTransition('filesystem')).toBeNull();
  });

  it('aborts an automatic transition if a user intent appears while it is pending', async () => {
    const authority = createVaultSessionAuthority();
    const automatic = authority.beginAutomaticTransition('filesystem')!;
    authority.beginCollectionIntent(); // user B parse begins before A resolves

    const apply = vi.fn();
    const outcome = await authority.commitTransition(automatic, apply);
    expect(outcome.accepted).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(authority.current().kind).toBe('starter');
  });

  it('lets a user transition supersede a pending automatic transition', async () => {
    const authority = createVaultSessionAuthority();
    const automatic = authority.beginAutomaticTransition('filesystem')!;
    const user = authority.beginTransition('uploaded');
    expect(authority.isTransitionCurrent(automatic)).toBe(false);
    expect(authority.isTransitionCurrent(user)).toBe(true);

    const outcome = await authority.commitTransition(user, () => {});
    expect(outcome.accepted).toBe(true);
    expect(outcome.session?.kind).toBe('uploaded');
  });

  it('keeps manual user reconnect functional when no automatic pending exists', async () => {
    const authority = createVaultSessionAuthority();
    const user = authority.beginTransition('filesystem');
    const outcome = await authority.commitTransition(user, () => {});
    expect(outcome.accepted).toBe(true);
    expect(outcome.session?.kind).toBe('filesystem');
  });
});

describe('Vault session authority — latest collection intent ordering', () => {
  it('lets only the newest folder intent begin a replacement transition', () => {
    const authority = createVaultSessionAuthority();
    const first = authority.beginCollectionIntent();
    const second = authority.beginCollectionIntent();
    expect(authority.isCollectionIntentCurrent(first)).toBe(false);
    expect(authority.isCollectionIntentCurrent(second)).toBe(true);
    expect(authority.beginCollectionTransition(first, 'uploaded')).toBeNull();
    expect(authority.beginCollectionTransition(second, 'uploaded')).not.toBeNull();
  });

  it('aborts a collection transition if a newer intent begins during the write barrier', async () => {
    const authority = createVaultSessionAuthority();
    const established = await authority.commitTransition(authority.beginTransition('filesystem'), () => {});
    const session = established.session!;
    const lease = authority.beginWrite(session)!;
    const intent = authority.beginCollectionIntent();
    const transition = authority.beginCollectionTransition(intent, 'uploaded')!;

    const outcomePromise = authority.commitTransition(transition, () => {});
    authority.beginCollectionIntent(); // newer user intent while waiting
    lease.release();
    const outcome = await outcomePromise;
    expect(outcome.accepted).toBe(false);
    expect(authority.writesBlocked()).toBe(false);
    expect(authority.current().id).toBe(session.id); // previous session preserved
  });

  it('aborts an older user transition when a newer folder intent begins before it commits', async () => {
    const authority = createVaultSessionAuthority();
    const userTransition = authority.beginTransition('filesystem');
    const apply = vi.fn();
    const commitPromise = authority.commitTransition(userTransition, apply);
    authority.beginCollectionIntent(); // newer user intent wins
    const outcome = await commitPromise;
    expect(outcome.accepted).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(authority.writesBlocked()).toBe(false);
  });

  it('invalidates a pending folder intent when an explicit user transition begins', () => {
    const authority = createVaultSessionAuthority();
    const intent = authority.beginCollectionIntent();
    authority.beginTransition('filesystem');
    expect(authority.isCollectionIntentCurrent(intent)).toBe(false);
    expect(authority.beginCollectionTransition(intent, 'uploaded')).toBeNull();
  });

  it('shutdown barriers do not alter user intent ordering', () => {
    const authority = createVaultSessionAuthority();
    const before = authority.userIntentCount();
    const shutdown = authority.beginShutdownTransition('uploaded');
    expect(authority.isTransitionCurrent(shutdown)).toBe(true);
    expect(authority.userIntentCount()).toBe(before);
  });
});

describe('Vault session authority — identity and write barrier', () => {
  it('blocks new writes immediately and waits for an already-started write before committing', async () => {
    const authority = createVaultSessionAuthority();
    const starter = authority.current();
    const transition = authority.beginTransition('filesystem');
    expect(authority.writesBlocked()).toBe(true);
    expect(authority.beginWrite(starter)).toBeNull();

    // A write that started before the next transition is already leased.
    const first = await authority.commitTransition(transition, () => {});
    expect(first.accepted).toBe(true);
    const writable = first.session!;
    const lease = authority.beginWrite(writable);
    expect(lease).not.toBeNull();

    const nextTransition = authority.beginTransition('uploaded');
    expect(authority.beginWrite(writable)).toBeNull();
    let committed = false;
    const commitPromise = authority.commitTransition(nextTransition, () => { committed = true; }).then((result) => {
      committed = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).toBe(false); // still waiting for the active write

    lease!.release();
    const outcome = await commitPromise;
    expect(outcome.accepted).toBe(true);
    expect(outcome.writesSettled).toBe(true);
    expect(outcome.session?.kind).toBe('uploaded');
    expect(authority.isCurrent(writable)).toBe(false);
    expect(authority.beginWrite(writable)).toBeNull();
    expect(authority.beginWrite(outcome.session)).toBeNull(); // uploaded is not writable
  });

  it('lets only the newest transition commit (B loses to C)', async () => {
    const authority = createVaultSessionAuthority();
    const b = authority.beginTransition('filesystem');
    const c = authority.beginTransition('uploaded');
    const bOutcome = await authority.commitTransition(b, () => {});
    expect(bOutcome.accepted).toBe(false);
    const cOutcome = await authority.commitTransition(c, () => {});
    expect(cOutcome.accepted).toBe(true);
    expect(cOutcome.session?.kind).toBe('uploaded');
  });

  it('cancelling a transition reopens writes for the previous valid session', async () => {
    const authority = createVaultSessionAuthority();
    const t = authority.beginTransition('filesystem');
    const session = (await authority.commitTransition(t, () => {})).session!;
    const failed = authority.beginTransition('filesystem');
    expect(authority.beginWrite(session)).toBeNull();
    expect(authority.cancelTransition(failed)).toBe(true);
    expect(authority.writesBlocked()).toBe(false);
    const lease = authority.beginWrite(session);
    expect(lease).not.toBeNull();
    lease!.release();
  });

  it('keeps rapid A -> B -> C transitions deterministic', async () => {
    const authority = createVaultSessionAuthority();
    const first = await authority.commitTransition(authority.beginTransition('filesystem'), () => {});
    const a = first.session!;
    const bTransition = authority.beginTransition('filesystem');
    const cTransition = authority.beginTransition('uploaded');
    expect((await authority.commitTransition(bTransition, () => {})).accepted).toBe(false);
    const c = await authority.commitTransition(cTransition, () => {});
    expect(c.accepted).toBe(true);
    expect(c.session?.kind).toBe('uploaded');
    expect(authority.isCurrent(a)).toBe(false);
    expect(authority.isCurrent(c.session)).toBe(true);
  });

  it('invalidates scan tokens on a collection write and on a session transition', async () => {
    const authority = createVaultSessionAuthority();
    const session = (await authority.commitTransition(authority.beginTransition('filesystem'), () => {})).session!;
    const scan = authority.beginScan(session);
    expect(scan).not.toBeNull();
    expect(authority.isScanCurrent(scan)).toBe(true);
    authority.markCollectionChanged(session);
    expect(authority.isScanCurrent(scan)).toBe(false);

    const scan2 = authority.beginScan(session);
    expect(scan2).not.toBeNull();
    const t = authority.beginTransition('uploaded');
    expect(authority.beginScan(session)).toBeNull();
    const next = await authority.commitTransition(t, () => {});
    expect(next.accepted).toBe(true);
    expect(authority.isScanCurrent(scan2)).toBe(false);
  });

  it('serializes scans against active writes and invalidates a pre-recovery scan on commit', async () => {
    const authority = createVaultSessionAuthority();
    const session = (await authority.commitTransition(authority.beginTransition('filesystem'), () => {})).session!;

    // A scan that starts before recovery captures the old revision.
    const preRecoveryScan = authority.beginScan(session)!;
    expect(authority.isScanCurrent(preRecoveryScan)).toBe(true);

    // Recovery holds a write lease while the scan is in flight.
    const lease = authority.beginWrite(session)!;
    expect(authority.beginScan(session)).toBeNull();

    // Recovery commits its asset + Markdown, then advances the revision.
    lease.release();
    authority.markCollectionChanged(session);
    expect(authority.isScanCurrent(preRecoveryScan)).toBe(false);

    // A fresh scan can now observe the committed recovery.
    const fresh = authority.beginScan(session)!;
    expect(authority.isScanCurrent(fresh)).toBe(true);
  });

  it('exposes a session-bound collection revision for recovery/refresh reconciliation', async () => {
    const authority = createVaultSessionAuthority();
    const session = (await authority.commitTransition(authority.beginTransition('filesystem'), () => {})).session!;
    const first = authority.collectionRevision(session)!;
    authority.markCollectionChanged(session);
    expect(authority.collectionRevision(session)).toBe(first + 1);
    const other = (await authority.commitTransition(authority.beginTransition('filesystem'), () => {})).session!;
    expect(authority.collectionRevision(session)).toBeNull();
    expect(authority.collectionRevision(other)).not.toBeNull();
  });

  it('reports a timeout without claiming the write settled, but still isolates the new session', async () => {
    const authority = createVaultSessionAuthority();
    const session = (await authority.commitTransition(authority.beginTransition('filesystem'), () => {})).session!;
    const lease = authority.beginWrite(session)!;
    const t = authority.beginTransition('uploaded');
    const outcome = await authority.commitTransition(t, () => {}, { timeoutMs: 10 });
    expect(outcome.accepted).toBe(true);
    expect(outcome.writesSettled).toBe(false);
    expect(authority.isCurrent(session)).toBe(false);
    expect(authority.beginWrite(session)).toBeNull();
    lease.release();
  });

  it('restores the previous identity if the synchronous apply throws', async () => {
    const authority = createVaultSessionAuthority();
    const previous = authority.current();
    const t = authority.beginTransition('filesystem');
    await expect(authority.commitTransition(t, () => { throw new Error('apply failed'); })).rejects.toThrow('apply failed');
    expect(authority.isCurrent(previous)).toBe(true);
    expect(authority.writesBlocked()).toBe(false);
    expect(authority.current().kind).toBe('starter');
  });

  it('tracks every active lease and resolves waiters when the last one releases', async () => {
    const authority = createVaultSessionAuthority();
    const session = (await authority.commitTransition(authority.beginTransition('filesystem'), () => {})).session!;
    const a = authority.beginWrite(session)!;
    const b = authority.beginWrite(session)!;
    expect(authority.activeWriteCount(session)).toBe(2);
    const wait = authority.waitForSessionWrites(session, 1000);
    a.release();
    expect(authority.activeWriteCount(session)).toBe(1);
    b.release();
    await expect(wait).resolves.toBe(true);
    expect(authority.activeWriteCount(session)).toBe(0);
  });
});
