// @vitest-environment node
/**
 * R2 — persisted Vault handle authority.
 *
 * A save that began before an explicit clear must never resurrect the old
 * handle, even when IndexedDB opens in a different order. The epoch is checked
 * after opening and before the put; the clear's delete transaction wins.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  saveDirectoryHandleToIDB,
  clearDirectoryHandleFromIDB,
  getVaultHandlePersistenceEpochForTests,
} from '../../src/utils/vaultFileSystem';

type PendingOpen = {
  request: any;
  succeed: () => void;
  fail: () => void;
};

let opens: PendingOpen[] = [];
let puts: Array<{ value: any; key: string }> = [];
let deletes: string[] = [];
let originalIndexedDB: any;

function installFakeIndexedDB() {
  opens = [];
  puts = [];
  deletes = [];
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: (_name: string, _mode: string) => {
      const tx: any = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = () => ({
        put: (value: any, key: string) => {
          puts.push({ value, key });
          queueMicrotask(() => tx.oncomplete?.());
        },
        delete: (key: string) => {
          deletes.push(key);
          queueMicrotask(() => tx.oncomplete?.());
        },
        get: () => {},
      });
      return tx;
    },
  };
  originalIndexedDB = (globalThis as any).indexedDB;
  (globalThis as any).indexedDB = {
    open: () => {
      const request: any = {};
      const entry: PendingOpen = {
        request,
        succeed: () => {
          request.result = db;
          request.onsuccess?.();
        },
        fail: () => request.onerror?.(),
      };
      opens.push(entry);
      return request;
    },
  };
  return db;
}

beforeEach(() => {
  installFakeIndexedDB();
});

afterEach(() => {
  (globalThis as any).indexedDB = originalIndexedDB;
});

describe('persisted handle epoch', () => {
  it('prevents a save that began before an explicit clear from writing the old handle', async () => {
    const epochBefore = getVaultHandlePersistenceEpochForTests();
    const save = saveDirectoryHandleToIDB({ name: 'Vault A' });
    const clear = clearDirectoryHandleFromIDB();
    expect(opens).toHaveLength(2);
    expect(getVaultHandlePersistenceEpochForTests()).toBe(epochBefore + 1);

    // Clear's IndexedDB open resolves first.
    opens[1].succeed();
    await expect(clear).resolves.toBe(true);
    expect(deletes).toHaveLength(1);

    // The old save opens afterwards; the epoch check must reject the put.
    opens[0].succeed();
    await expect(save).resolves.toBe(false);
    expect(puts).toHaveLength(0);
  });

  it('lets the newest save win even when an older save opens IndexedDB later', async () => {
    const older = saveDirectoryHandleToIDB({ name: 'Vault A' });
    const newer = saveDirectoryHandleToIDB({ name: 'Vault B' });
    opens[1].succeed(); // newer save completes first
    await expect(newer).resolves.toBe(true);
    opens[0].succeed(); // older save opens later and must not resurrect A
    await expect(older).resolves.toBe(false);
    expect(puts).toHaveLength(1);
    expect(puts[0].value).toEqual({ name: 'Vault B' });
  });

  it('does not let an older clear delete a newer save that opened first', async () => {
    const clear = clearDirectoryHandleFromIDB();
    const newerSave = saveDirectoryHandleToIDB({ name: 'Vault B' });
    opens[1].succeed(); // newer save wins first
    await expect(newerSave).resolves.toBe(true);
    opens[0].succeed(); // older clear opens later
    await expect(clear).resolves.toBe(false);
    expect(deletes).toHaveLength(0);
    expect(puts).toHaveLength(1);
  });

  it('honours the live shouldPersist guard after IndexedDB opens', async () => {
    let current = true;
    const save = saveDirectoryHandleToIDB({ name: 'Vault B' }, { shouldPersist: () => current });
    current = false;
    opens[0].succeed();
    await expect(save).resolves.toBe(false);
    expect(puts).toHaveLength(0);
  });

  it('commits a current save and allows a later save after a clear', async () => {
    const first = saveDirectoryHandleToIDB({ name: 'Vault A' });
    opens[0].succeed();
    await expect(first).resolves.toBe(true);
    expect(puts).toHaveLength(1);

    const clear = clearDirectoryHandleFromIDB();
    opens[1].succeed();
    await expect(clear).resolves.toBe(true);
    expect(deletes).toHaveLength(1);

    const second = saveDirectoryHandleToIDB({ name: 'Vault B' });
    opens[2].succeed();
    await expect(second).resolves.toBe(true);
    expect(puts).toHaveLength(2);
    expect(puts[1].value).toEqual({ name: 'Vault B' });
  });

  it('reports false when IndexedDB cannot open, instead of claiming the clear succeeded', async () => {
    const clear = clearDirectoryHandleFromIDB();
    opens[0].fail();
    await expect(clear).resolves.toBe(false);
  });
});
