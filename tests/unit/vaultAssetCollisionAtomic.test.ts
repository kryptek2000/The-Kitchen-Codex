import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveImageToVaultAssetsCollisionSafe,
  resetVaultAssetAllocationForTests,
  isVaultAssetPathReservedForTests,
} from '../../src/utils/vaultAssets';
import { AssetPathCollisionError, type AssetAdapter } from '../../src/application/adapters/AssetAdapter';

/**
 * B1 (re-clearance) — collision-safe Asset allocation + creation is ATOMIC
 * across independent editor instances. Two concurrent transactions that both
 * observe the original filename absent must produce DISTINCT final paths and
 * must never overwrite one another. The shared, module-level reservation is
 * held across the existence recheck and the write and released on every path.
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function blob(...values: number[]): Blob {
  return new Blob([bytes(...values) as unknown as BlobPart], { type: 'image/png' });
}

interface GatedStore {
  asset: AssetAdapter;
  files: Map<string, Uint8Array>;
  releaseFirstWrite: () => void;
}

/** In-memory AssetAdapter whose FIRST write can be paused mid-creation. */
function makeGatedStore(initial: Record<string, Uint8Array> = {}): GatedStore {
  const files = new Map<string, Uint8Array>(Object.entries(initial));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writeCount = 0;
  const asset = {
    exists: vi.fn(async (path: string) => files.has(path)),
    write: vi.fn(async (path: string, data: Uint8Array) => {
      writeCount += 1;
      if (writeCount === 1) await gate;
      files.set(path, data.slice());
    }),
    read: vi.fn(async (path: string) => files.get(path) ?? new Uint8Array()),
    delete: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  } as unknown as AssetAdapter;
  return { asset, files, releaseFirstWrite: release };
}

/** Plain in-memory AssetAdapter (no write gate). */
function makeStore(initial: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(initial));
  const asset = {
    exists: vi.fn(async (path: string) => files.has(path)),
    write: vi.fn(async (path: string, data: Uint8Array) => {
      files.set(path, data.slice());
    }),
    read: vi.fn(async (path: string) => files.get(path) ?? new Uint8Array()),
    delete: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  } as unknown as AssetAdapter;
  return { asset, files };
}

beforeEach(() => {
  resetVaultAssetAllocationForTests();
});

describe('atomic collision-safe allocation (AssetAdapter)', () => {
  it('1-6. two concurrent saves to the same title never share or overwrite a path', async () => {
    const { asset, files, releaseFirstWrite } = makeGatedStore();
    const deps = { asset };

    const first = saveImageToVaultAssetsCollisionSafe(deps, 'Shared Title', blob(1, 1, 1), 'png');
    const second = saveImageToVaultAssetsCollisionSafe(deps, 'Shared Title', blob(2, 2, 2), 'png');
    // Let the first transaction claim a path and enter its paused write.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstWrite();

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.success && r2.success).toBe(true);
    expect(r1.createdNew && r2.createdNew).toBe(true);
    // 5. distinct final Asset paths.
    expect(r1.relativePath).not.toBe(r2.relativePath);
    expect(new Set([r1.relativePath, r2.relativePath]).size).toBe(2);
    expect(r1.relativePath).toMatch(/^Assets\/Shared Title( \(\d+\))?\.png$/);
    expect(r2.relativePath).toMatch(/^Assets\/Shared Title( \(\d+\))?\.png$/);
    // 6. neither byte payload overwrote the other.
    expect(Array.from(files.get(r1.relativePath)!)).toEqual([1, 1, 1]);
    expect(Array.from(files.get(r2.relativePath)!)).toEqual([2, 2, 2]);
  });

  it('never overwrites a pre-existing Asset and preserves the deterministic suffix', async () => {
    const { asset, files } = makeStore({ 'Assets/Shared Title.png': bytes(9, 9, 9) });
    const result = await saveImageToVaultAssetsCollisionSafe({ asset }, 'Shared Title', blob(7, 7), 'png');
    expect(result.success).toBe(true);
    expect(result.relativePath).toBe('Assets/Shared Title (1).png');
    expect(Array.from(files.get('Assets/Shared Title.png')!)).toEqual([9, 9, 9]);
    expect(Array.from(files.get(result.relativePath)!)).toEqual([7, 7]);
  });

  it('prefers a genuinely exclusive create when the adapter provides one', async () => {
    const files = new Map<string, Uint8Array>([['Assets/Exclusive.png', bytes(9)]]);
    const asset = {
      exists: vi.fn(async (path: string) => files.has(path)),
      write: vi.fn(async (path: string, data: Uint8Array) => {
        files.set(path, data.slice());
      }),
      writeExclusive: vi.fn(async (path: string, data: Uint8Array) => {
        if (files.has(path)) throw new AssetPathCollisionError(path);
        files.set(path, data.slice());
      }),
      read: vi.fn(async () => new Uint8Array()),
      delete: vi.fn(async (path: string) => {
        files.delete(path);
      }),
    } as unknown as AssetAdapter;
    const result = await saveImageToVaultAssetsCollisionSafe({ asset }, 'Exclusive', blob(7, 7), 'png');
    expect(result.success).toBe(true);
    expect(result.relativePath).toBe('Assets/Exclusive (1).png');
    expect(asset.writeExclusive).toHaveBeenCalledWith('Assets/Exclusive (1).png', expect.anything(), 'image/png');
    expect(asset.write).not.toHaveBeenCalled();
    expect(Array.from(files.get('Assets/Exclusive.png')!)).toEqual([9]);
  });

  it('a benign exclusive-create collision advances to the next suffix (never overwrites)', async () => {
    const files = new Map<string, Uint8Array>();
    let attempts = 0;
    const asset = {
      // Simulate a race: existence reports absent, but the exclusive create
      // discovers a just-created file and reports a collision.
      exists: vi.fn(async () => false),
      write: vi.fn(async (path: string, data: Uint8Array) => {
        files.set(path, data.slice());
      }),
      writeExclusive: vi.fn(async (path: string, data: Uint8Array) => {
        attempts += 1;
        if (attempts === 1) throw new AssetPathCollisionError(path);
        files.set(path, data.slice());
      }),
      read: vi.fn(async () => new Uint8Array()),
      delete: vi.fn(async (path: string) => {
        files.delete(path);
      }),
    } as unknown as AssetAdapter;
    const result = await saveImageToVaultAssetsCollisionSafe({ asset }, 'Race', blob(3, 3), 'png');
    expect(result.success).toBe(true);
    expect(result.relativePath).toBe('Assets/Race (1).png');
    expect(asset.write).not.toHaveBeenCalled();
  });

  it('7+9+10. a failed write releases the reservation and a later retry succeeds (no stale claim)', async () => {
    const files = new Map<string, Uint8Array>();
    let fail = true;
    const asset = {
      exists: vi.fn(async (path: string) => files.has(path)),
      write: vi.fn(async (path: string, data: Uint8Array) => {
        if (fail) throw new Error('disk failure');
        files.set(path, data.slice());
      }),
      read: vi.fn(async () => new Uint8Array()),
      delete: vi.fn(async (path: string) => {
        files.delete(path);
      }),
    } as unknown as AssetAdapter;

    const first = await saveImageToVaultAssetsCollisionSafe({ asset }, 'Retry', blob(1), 'png');
    expect(first.success).toBe(false);
    expect(isVaultAssetPathReservedForTests('Assets/Retry.png')).toBe(false);

    fail = false;
    const second = await saveImageToVaultAssetsCollisionSafe({ asset }, 'Retry', blob(2), 'png');
    expect(second.success).toBe(true);
    expect(second.relativePath).toBe('Assets/Retry.png');
    expect(Array.from(files.get('Assets/Retry.png')!)).toEqual([2]);
    expect(isVaultAssetPathReservedForTests('Assets/Retry.png')).toBe(false);
  });

  it('10. no reservation remains after concurrent completion', async () => {
    const { asset, releaseFirstWrite } = makeGatedStore();
    const deps = { asset };
    const first = saveImageToVaultAssetsCollisionSafe(deps, 'Cleanup', blob(1), 'png');
    const second = saveImageToVaultAssetsCollisionSafe(deps, 'Cleanup', blob(2), 'png');
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstWrite();
    const [r1, r2] = await Promise.all([first, second]);
    expect(isVaultAssetPathReservedForTests(r1.relativePath)).toBe(false);
    expect(isVaultAssetPathReservedForTests(r2.relativePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Legacy FSA folderHandle path — a materially different production Asset path.
// ---------------------------------------------------------------------------

class FakeFile {
  content: Uint8Array;
  constructor(public readonly path: string, content: Uint8Array) {
    this.content = content;
  }
  async getFile() {
    return { arrayBuffer: async () => this.content.buffer.slice(0, this.content.byteLength) as ArrayBuffer };
  }
  async createWritable() {
    return {
      write: async (data: Uint8Array | Blob) => {
        this.content =
          data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(await (data as Blob).arrayBuffer());
      },
      close: async () => {},
      abort: async () => {},
    };
  }
}

class FakeDirHandle {
  constructor(public readonly prefix: string, private readonly files: Map<string, FakeFile>, private readonly folders: Set<string>) {}
  private key(name: string): string {
    return this.prefix ? `${this.prefix}/${name}` : name;
  }
  async getDirectoryHandle(name: string, opts: { create?: boolean }): Promise<FakeDirHandle> {
    const key = this.key(name);
    if (this.folders.has(key) || opts.create) {
      this.folders.add(key);
      return new FakeDirHandle(key, this.files, this.folders);
    }
    throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
  }
  async getFileHandle(name: string, opts: { create?: boolean }): Promise<FakeFile> {
    const key = this.key(name);
    const file = this.files.get(key);
    if (file) return file;
    if (opts.create) {
      const created = new FakeFile(key, new Uint8Array(0));
      this.files.set(key, created);
      return created;
    }
    throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
  }
  async removeEntry(name: string): Promise<void> {
    this.files.delete(this.key(name));
  }
}

function makeFolderHandle() {
  const files = new Map<string, FakeFile>();
  const folders = new Set<string>();
  return { folderHandle: new FakeDirHandle('', files, folders), files };
}

describe('atomic collision-safe allocation (legacy folderHandle path)', () => {
  it('11. two concurrent legacy-FSA saves never share or overwrite a path', async () => {
    const { folderHandle, files } = makeFolderHandle();
    const deps = { folderHandle };

    const first = saveImageToVaultAssetsCollisionSafe(deps, 'Legacy', blob(4, 4), 'png');
    const second = saveImageToVaultAssetsCollisionSafe(deps, 'Legacy', blob(5, 5), 'png');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.success && r2.success).toBe(true);
    expect(r1.relativePath).not.toBe(r2.relativePath);
    expect(new Set([r1.relativePath, r2.relativePath]).size).toBe(2);
    expect(Array.from(files.get(r1.relativePath)!.content)).toEqual([4, 4]);
    expect(Array.from(files.get(r2.relativePath)!.content)).toEqual([5, 5]);
  });

  it('11. a failed legacy-FSA write releases the reservation and a retry succeeds', async () => {
    const { folderHandle, files } = makeFolderHandle();
    const original = folderHandle.getDirectoryHandle.bind(folderHandle);
    let fail = true;
    (folderHandle as any).getDirectoryHandle = async (name: string, opts: { create?: boolean }) => {
      if (opts?.create && fail) throw new Error('permission denied');
      return original(name, opts);
    };
    const first = await saveImageToVaultAssetsCollisionSafe({ folderHandle }, 'Legacy Retry', blob(1), 'png');
    expect(first.success).toBe(false);
    expect(isVaultAssetPathReservedForTests('Assets/Legacy Retry.png')).toBe(false);

    fail = false;
    const second = await saveImageToVaultAssetsCollisionSafe({ folderHandle }, 'Legacy Retry', blob(2), 'png');
    expect(second.success).toBe(true);
    expect(second.relativePath).toBe('Assets/Legacy Retry.png');
    expect(Array.from(files.get('Assets/Legacy Retry.png')!.content)).toEqual([2]);
  });
});
