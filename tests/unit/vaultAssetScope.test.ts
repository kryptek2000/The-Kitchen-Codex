import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVaultAssetScope,
  scanVaultAssetsFromHandle,
  validateVaultAssetReference,
  type VaultAssetScope,
} from '../../src/utils/vaultAssets';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function bytes(blob: Blob | undefined): Promise<Uint8Array> {
  if (!blob) return Promise.resolve(new Uint8Array());
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

let createdObjectUrls: string[] = [];
let revokedObjectUrls: string[] = [];

beforeEach(() => {
  createdObjectUrls = [];
  revokedObjectUrls = [];
  let n = 0;
  (URL as any).createObjectURL = vi.fn(() => {
    const url = `blob:vault-asset-${++n}`;
    createdObjectUrls.push(url);
    return url;
  });
  (URL as any).revokeObjectURL = vi.fn((url: string) => {
    revokedObjectUrls.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function register(scope: VaultAssetScope, path: string, content: string) {
  return scope.registerAsset(path, new Blob([content], { type: 'image/png' }));
}

describe('R4 — Vault asset scope isolation', () => {
  it('T1: an asset registered in A is not resolvable or listed in empty B', () => {
    const a = createVaultAssetScope(1, { active: true });
    const b = createVaultAssetScope(2, { active: true });
    register(a, 'Assets/only-a.png', 'A bytes');

    expect(a.get('Assets/only-a.png')?.blobUrl).toMatch(/^blob:/);
    expect(b.get('Assets/only-a.png')).toBeUndefined();
    expect(b.getAll()).toEqual([]);
    a.deactivate();
    b.deactivate();
  });

  it('T2: identical relative paths in A and B resolve to each Vault’s own bytes and URL', async () => {
    const a = createVaultAssetScope(1, { active: true });
    const b = createVaultAssetScope(2, { active: true });
    register(a, 'Assets/photo.png', 'A bytes');
    register(b, 'Assets/photo.png', 'B bytes');

    const aItem = a.get('Assets/photo.png')!;
    const bItem = b.get('Assets/photo.png')!;
    expect(aItem.blobUrl).not.toBe(bItem.blobUrl);
    expect(new TextDecoder().decode(await bytes(aItem.file))).toBe('A bytes');
    expect(new TextDecoder().decode(await bytes(bItem.file))).toBe('B bytes');
    a.deactivate();
    b.deactivate();
  });

  it('T3: a late registration into a deactivated scope is refused and creates no URL', () => {
    const a = createVaultAssetScope(1, { active: true });
    a.deactivate();
    const before = createdObjectUrls.length;
    const item = register(a, 'Assets/late.png', 'late bytes');
    expect(item).toBeNull();
    expect(a.get('Assets/late.png')).toBeUndefined();
    expect(a.getAll()).toEqual([]);
    expect(createdObjectUrls.length).toBe(before);
  });

  it('T4: A → B → A keeps scopes isolated and allows a clean A reload', async () => {
    const a = createVaultAssetScope(1, { active: true });
    register(a, 'Assets/photo.png', 'A first');
    a.deactivate();

    const b = createVaultAssetScope(2, { active: true });
    expect(b.get('Assets/photo.png')).toBeUndefined();
    register(b, 'Assets/photo.png', 'B bytes');

    const aReloaded = createVaultAssetScope(3, { active: true });
    register(aReloaded, 'Assets/photo.png', 'A second');
    expect(new TextDecoder().decode(await bytes(aReloaded.get('Assets/photo.png')!.file))).toBe('A second');
    expect(new TextDecoder().decode(await bytes(b.get('Assets/photo.png')!.file))).toBe('B bytes');
    b.deactivate();
    aReloaded.deactivate();
  });

  it('T5: deactivating a failed provisional B does not disturb active A assets', async () => {
    const a = createVaultAssetScope(1, { active: true });
    register(a, 'Assets/photo.png', 'A bytes');
    const provisionalB = createVaultAssetScope(null, { active: false });
    register(provisionalB, 'Assets/photo.png', 'B bytes');
    expect(provisionalB.getAll()).toEqual([]); // provisional is not visible

    provisionalB.deactivate(); // failed transition
    expect(new TextDecoder().decode(await bytes(a.get('Assets/photo.png')!.file))).toBe('A bytes');
    expect(a.getAll()).toHaveLength(1);
    a.deactivate();
  });

  it('T8: each scope revokes only its own URLs, safely and once', () => {
    const a = createVaultAssetScope(1, { active: true });
    const b = createVaultAssetScope(2, { active: true });
    register(a, 'Assets/a1.png', 'a1');
    register(a, 'Assets/a2.png', 'a2');
    register(b, 'Assets/b1.png', 'b1');
    const aUrls = createdObjectUrls.slice(0, 2);
    const bUrl = createdObjectUrls[2];

    a.deactivate();
    expect(revokedObjectUrls.sort()).toEqual([...aUrls].sort());
    expect(revokedObjectUrls).not.toContain(bUrl);
    a.deactivate(); // idempotent
    expect(revokedObjectUrls.filter((url) => url === aUrls[0])).toHaveLength(1);
    b.deactivate();
    expect(revokedObjectUrls).toContain(bUrl);
  });

  it('T9: starter/uploaded/filesystem-style scopes cannot see each other’s assets', () => {
    const starter = createVaultAssetScope(0, { active: true });
    const uploaded = createVaultAssetScope(4, { active: true });
    const filesystem = createVaultAssetScope(5, { active: true });
    register(uploaded, 'Assets/shared.png', 'uploaded bytes');
    register(filesystem, 'Assets/shared.png', 'filesystem bytes');
    expect(starter.getAll()).toEqual([]);
    expect(uploaded.get('Assets/shared.png')?.blobUrl).not.toBe(filesystem.get('Assets/shared.png')?.blobUrl);
    starter.deactivate();
    uploaded.deactivate();
    filesystem.deactivate();
  });

  it('T10: a scan held by an old scope cannot register after deactivation', async () => {
    const gate = deferred<void>();
    const file = new Blob(['late bytes'], { type: 'image/png' });
    const entry = {
      kind: 'file',
      name: 'late.png',
      async getFile() {
        await gate.promise;
        return file;
      },
    };
    const root = {
      async *values() { yield entry; },
    };
    const oldScope = createVaultAssetScope(1, { active: true });
    const scanPromise = scanVaultAssetsFromHandle(root, oldScope);
    oldScope.deactivate();
    gate.resolve();
    await scanPromise;

    expect(oldScope.getAll()).toEqual([]);
    expect(createdObjectUrls).toHaveLength(0);
  });

  it('validates a Vault-local recipe image against the destination adapter', async () => {
    const destination = {
      exists: vi.fn(async (path: string) => path === 'Assets/present-in-b.png'),
    } as any;
    await expect(validateVaultAssetReference({ asset: destination }, 'Assets/only-a.png'))
      .resolves.toMatchObject({ ok: false });
    await expect(validateVaultAssetReference({ asset: destination }, 'Assets/present-in-b.png'))
      .resolves.toMatchObject({ ok: true });
    await expect(validateVaultAssetReference({ asset: destination }, 'https://example.com/photo.jpg'))
      .resolves.toMatchObject({ ok: true });
  });
});

  it('removes one exact asset and revokes only its owned URL', () => {
    const scope = createVaultAssetScope(1, { active: true });
    register(scope, 'Assets/remove.png', 'remove');
    register(scope, 'Assets/keep.png', 'keep');
    const removedUrl = scope.get('Assets/remove.png')!.blobUrl!;
    const keepUrl = scope.get('Assets/keep.png')!.blobUrl!;
    expect(scope.removeAsset('Assets/remove.png')).toBe(true);
    expect(scope.get('Assets/remove.png')).toBeUndefined();
    expect(scope.get('Assets/keep.png')?.blobUrl).toBe(keepUrl);
    expect(revokedObjectUrls).toContain(removedUrl);
    expect(revokedObjectUrls).not.toContain(keepUrl);
    expect(scope.removeAsset('Assets/remove.png')).toBe(false);
    scope.deactivate();
  });

describe('R6 — asset identity uses full path, not basename', () => {
  it('keeps same-basename assets in different directories distinct', async () => {
    const scope = createVaultAssetScope(1, { active: true });
    register(scope, 'Assets/Dinner/photo.png', 'dinner bytes');
    register(scope, 'Assets/Dessert/photo.png', 'dessert bytes');

    expect(scope.getAll()).toHaveLength(2);
    const dinner = scope.get('Assets/Dinner/photo.png')!;
    const dessert = scope.get('Assets/Dessert/photo.png')!;
    expect(dinner).not.toBe(dessert);
    expect(dinner.blobUrl).not.toBe(dessert.blobUrl);
    expect(new TextDecoder().decode(await bytes(dinner.file))).toBe('dinner bytes');
    expect(new TextDecoder().decode(await bytes(dessert.file))).toBe('dessert bytes');
    // The short basename is ambiguous and must not silently select one.
    expect(scope.get('photo.png')).toBeUndefined();
    scope.deactivate();
  });

  it('keeps case-distinct full paths distinct on a case-sensitive Vault', () => {
    const scope = createVaultAssetScope(1, { active: true });
    register(scope, 'Assets/Photo.png', 'upper');
    register(scope, 'Assets/photo.png', 'lower');

    expect(scope.getAll()).toHaveLength(2);
    expect(scope.get('Assets/Photo.png')?.fileName).toBe('Photo.png');
    expect(scope.get('Assets/photo.png')?.fileName).toBe('photo.png');
    // Case-insensitive alias is ambiguous once both paths exist.
    expect(scope.get('assets/PHOTO.PNG')).toBeUndefined();
    scope.deactivate();
  });

  it('resolves a case-insensitive alias only when unambiguous', () => {
    const scope = createVaultAssetScope(1, { active: true });
    register(scope, 'Assets/OnlyPhoto.png', 'only');
    expect(scope.get('assets/onlyphoto.png')?.path).toBe('Assets/OnlyPhoto.png');
    scope.deactivate();
  });

  it('repeated registration of the same exact path updates rather than duplicates', () => {
    const scope = createVaultAssetScope(1, { active: true });
    register(scope, 'Assets/repeat.png', 'first');
    const firstUrl = scope.get('Assets/repeat.png')!.blobUrl!;
    register(scope, 'Assets/repeat.png', 'second');
    expect(scope.getAll()).toHaveLength(1);
    expect(scope.get('Assets/repeat.png')!.blobUrl).not.toBe(firstUrl);
    expect(revokedObjectUrls).toContain(firstUrl);
    scope.deactivate();
  });
});
