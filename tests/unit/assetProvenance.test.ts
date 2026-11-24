import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVaultAssetScope,
  saveImageToVaultAssets,
  validateVaultAssetReference,
} from '../../src/utils/vaultAssets';
import {
  createTemporaryPreviewUrl,
  releaseTemporaryPreviewUrl,
} from '../../src/utils/assetProvenance';
import { getRecipeImage, LOCAL_RECIPE_IMAGE_PLACEHOLDER } from '../../src/utils/imageHelper';
import { validateRecipeAssetReferences } from '../../src/utils/assetReferences';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';

function makeAsset(initial: Record<string, Uint8Array> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    asset: {
      read: vi.fn(async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error('ENOENT');
        return bytes;
      }),
      write: vi.fn(async (path: string, bytes: Uint8Array) => {
        files.set(path, bytes.slice());
      }),
      exists: vi.fn(async (path: string) => files.has(path)),
      delete: vi.fn(async (path: string) => {
        files.delete(path);
      }),
    } as unknown as AssetAdapter,
  };
}

let created: string[] = [];
let revoked: string[] = [];
let counter = 0;

beforeEach(() => {
  created = [];
  revoked = [];
  counter = 0;
  (URL as any).createObjectURL = vi.fn(() => {
    const url = `blob:r5-provenance-${++counter}`;
    created.push(url);
    return url;
  });
  (URL as any).revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R5 asset provenance — display and persistence', () => {
  it('does not display an A-owned blob under B and rejects it for persistence', async () => {
    const a = createVaultAssetScope(1, { active: true });
    const b = createVaultAssetScope(2, { active: true });
    a.registerAsset('Assets/a.png', new Blob(['A'], { type: 'image/png' }));
    const aUrl = a.get('Assets/a.png')!.blobUrl!;

    expect(getRecipeImage({ image: aUrl }, a)).toBe(aUrl);
    expect(getRecipeImage({ image: aUrl }, b)).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);

    const { asset, files } = makeAsset();
    const result = await validateVaultAssetReference({ asset, assetScope: b }, aUrl);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('unknown-blob');
    expect(files.size).toBe(0);

    a.deactivate();
    b.deactivate();
  });

  it('displays live temporary previews but rejects persisting them', async () => {
    const preview = createTemporaryPreviewUrl(new Blob(['preview'], { type: 'image/png' }), 'r5-preview');
    const scope = createVaultAssetScope(1, { active: true });
    const { asset } = makeAsset();

    expect(getRecipeImage({ image: preview }, scope)).toBe(preview);
    const before = await validateVaultAssetReference({ asset, assetScope: scope }, preview);
    expect(before.ok).toBe(false);
    expect(before.kind).toBe('temporary-preview-blob');

    releaseTemporaryPreviewUrl(preview);
    expect(revoked).toContain(preview);
    expect(getRecipeImage({ image: preview }, scope)).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
    const after = await validateVaultAssetReference({ asset, assetScope: scope }, preview);
    expect(after.ok).toBe(false);
    expect(after.kind).toBe('unknown-blob');

    scope.deactivate();
  });

  it('rejects unknown blobs but keeps remote/data references working', async () => {
    const { asset } = makeAsset();
    expect(await validateVaultAssetReference({ asset }, 'blob:unknown')).toMatchObject({
      ok: false,
      kind: 'unknown-blob',
    });
    expect(
      getRecipeImage({ image: 'blob:unknown' }, null)
    ).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);

    expect(
      await validateVaultAssetReference({ asset }, 'https://example.com/photo.jpg')
    ).toMatchObject({ ok: true, kind: 'remote' });
    expect(
      await validateVaultAssetReference({ asset }, 'data:image/png;base64,aGVsbG8=')
    ).toMatchObject({ ok: true, kind: 'data' });
    expect(getRecipeImage({ image: 'https://example.com/photo.jpg' }, null)).toBe(
      'https://example.com/photo.jpg'
    );
  });

  it('rejects every case/encoding/control variant of a blob scheme', async () => {
    const { asset, files } = makeAsset();
    const variants = [
      'blob:unknown',
      'Blob:unknown',
      'BLOB:unknown',
      'bLoB:unknown',
      '  BLOB:unknown  ',
      'BLOB:http://example.test/a',
      '%62lob:unknown',
      '\u0000blob:unknown',
    ];
    for (const ref of variants) {
      const result = await validateVaultAssetReference({ asset }, ref);
      expect(result.ok, ref).toBe(false);
      expect(
        result.kind === 'unknown-blob' || result.kind === 'malformed',
        ref
      ).toBe(true);
      expect(getRecipeImage({ image: ref }, null), ref).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
    }
    expect(files.size).toBe(0);
  });

  it('rejects a mixed-case blob at the recipe persistence boundary without exists()', async () => {
    const { asset, files } = makeAsset();
    const exists = vi.spyOn(asset, 'exists');
    const result = await validateRecipeAssetReferences(
      { asset },
      { title: 'Case blob', image: 'BLOB:unknown' }
    );
    expect(result.ok).toBe(false);
    expect(result.kinds).toContain('unknown-blob');
    expect(exists).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it('rejects traversal, unsupported schemes and malformed local references', async () => {
    const { asset } = makeAsset();
    for (const ref of [
      'Assets/../only-a.png',
      'Assets/./only-a.png',
      'jlob:unknown',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'Assets//only-a.png',
    ]) {
      const result = await validateVaultAssetReference({ asset }, ref);
      expect(result.ok, ref).toBe(false);
      expect(result.kind, ref).toBe('malformed');
    }
  });

  it('keeps uppercase remote/data schemes working', async () => {
    const { asset } = makeAsset();
    expect(await validateVaultAssetReference({ asset }, 'HTTPS://example.com/photo.jpg')).toMatchObject({
      ok: true,
      kind: 'remote',
    });
    expect(await validateVaultAssetReference({ asset }, 'DATA:image/png;base64,aGVsbG8=')).toMatchObject({
      ok: true,
      kind: 'data',
    });
    expect(getRecipeImage({ image: 'HTTPS://example.com/photo.jpg' }, null)).toBe(
      'HTTPS://example.com/photo.jpg'
    );
  });

  it('materializes a preview into the destination Vault and accepts the verified path', async () => {
    const b = createVaultAssetScope(2, { active: true });
    const { asset, files } = makeAsset();
    const previewBytes = new Uint8Array([1, 2, 3, 4]);

    const saved = await saveImageToVaultAssets(
      { asset, assetScope: b },
      'Recovered Dish',
      new Blob([previewBytes], { type: 'image/png' })
    );
    expect(saved.success).toBe(true);
    expect(saved.relativePath).toMatch(/^Assets\/Recovered Dish\.png$/);
    expect(files.has(saved.relativePath)).toBe(true);
    expect(b.get(saved.relativePath)?.blobUrl).toBeTruthy();

    const validation = await validateVaultAssetReference(
      { asset, assetScope: b },
      saved.relativePath
    );
    expect(validation.ok).toBe(true);
    expect(validation.kind).toBe('vault-local');

    b.deactivate();
  });

  it('blocks a preview created before a session switch from crossing into B', async () => {
    const a = createVaultAssetScope(1, { active: true });
    const preview = createTemporaryPreviewUrl(new Blob(['A preview'], { type: 'image/png' }), 'r5-session-preview');
    const { asset } = makeAsset();

    // Session switch: A retired; B is now the destination.
    a.deactivate();
    const b = createVaultAssetScope(2, { active: true });

    const rejected = await validateVaultAssetReference({ asset, assetScope: b }, preview);
    expect(rejected.ok).toBe(false);

    // Explicit conversion through the B-bound authorized write path is allowed.
    const saved = await saveImageToVaultAssets(
      { asset, assetScope: b },
      'Converted',
      new Blob(['A preview'], { type: 'image/png' })
    );
    expect(saved.success).toBe(true);
    expect(
      await validateVaultAssetReference({ asset, assetScope: b }, saved.relativePath)
    ).toMatchObject({ ok: true, kind: 'vault-local' });

    releaseTemporaryPreviewUrl(preview);
    b.deactivate();
  });
});
