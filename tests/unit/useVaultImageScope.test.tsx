// @vitest-environment jsdom
/**
 * R5-B1 — useVaultImage scope identity, URL lifecycle and late-result rejection.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useVaultImage } from '../../src/hooks/useVaultImage';
import { VaultAssetScopeProvider } from '../../src/hooks/VaultAssetScopeContext';
import { createVaultAssetScope, type VaultAssetScope } from '../../src/utils/vaultAssets';
import {
  createTemporaryPreviewUrl,
  releaseTemporaryPreviewUrl,
} from '../../src/utils/assetProvenance';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Probe({ imageRef, fallback, folderHandle }: { imageRef: string; fallback: string; folderHandle?: any }) {
  const url = useVaultImage(imageRef, fallback, folderHandle);
  return <span data-testid="resolved-url">{url}</span>;
}

function renderWithScope(scope: VaultAssetScope, imageRef: string, fallback = 'fallback://default') {
  return render(
    <VaultAssetScopeProvider scope={scope}>
      <Probe imageRef={imageRef} fallback={fallback} />
    </VaultAssetScopeProvider>
  );
}

function urlText(): string {
  return screen.getByTestId('resolved-url').textContent || '';
}

let created: string[] = [];
let revoked: string[] = [];
let counter = 0;

beforeEach(() => {
  created = [];
  revoked = [];
  counter = 0;
  (URL as any).createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:r5-hook-${++counter}`;
    created.push(url);
    return url;
  });
  (URL as any).revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R5 useVaultImage scope lifecycle', () => {
  it('drops the A URL when the same component is reused under B and never shows it as B', async () => {
    const a = createVaultAssetScope(1, { active: true });
    const b = createVaultAssetScope(2, { active: true });
    a.registerAsset('Assets/a.png', new Blob(['A bytes'], { type: 'image/png' }));
    const aUrl = a.get('Assets/a.png')!.blobUrl!;

    const view = renderWithScope(a, 'Assets/a.png');
    expect(urlText()).toBe(aUrl);

    a.deactivate(); // collection replacement revokes A
    view.rerender(
      <VaultAssetScopeProvider scope={b}>
        <Probe imageRef="Assets/missing.png" fallback="fallback://b" />
      </VaultAssetScopeProvider>
    );

    // The first render after the scope change must not present A's URL.
    expect(urlText()).toBe('fallback://b');
    await waitFor(() => expect(urlText()).toBe('fallback://b'));
    expect(revoked).toContain(aUrl);

    b.registerAsset('Assets/missing.png', new Blob(['B bytes'], { type: 'image/png' }));
    const bUrl = b.get('Assets/missing.png')!.blobUrl!;
    await waitFor(() => expect(urlText()).toBe(bUrl));
    expect(bUrl).not.toBe(aUrl);

    b.deactivate();
  });

  it('updates a connected consumer when the same path is replaced in one scope', async () => {
    const a = createVaultAssetScope(1, { active: true });
    a.registerAsset('Assets/photo.png', new Blob(['old'], { type: 'image/png' }));
    const oldUrl = a.get('Assets/photo.png')!.blobUrl!;
    renderWithScope(a, 'Assets/photo.png');
    expect(urlText()).toBe(oldUrl);

    a.registerAsset('Assets/photo.png', new Blob(['new'], { type: 'image/png' }));
    const newUrl = a.get('Assets/photo.png')!.blobUrl!;
    await waitFor(() => expect(urlText()).toBe(newUrl));
    expect(newUrl).not.toBe(oldUrl);
    expect(revoked).toContain(oldUrl);

    a.deactivate();
  });

  it('synchronous resolution followed by scope invalidation falls back safely', async () => {
    const a = createVaultAssetScope(1, { active: true });
    a.registerAsset('Assets/a.png', new Blob(['A'], { type: 'image/png' }));
    const aUrl = a.get('Assets/a.png')!.blobUrl!;
    renderWithScope(a, 'Assets/a.png', 'fallback://a');
    expect(urlText()).toBe(aUrl);

    act(() => a.deactivate());
    await waitFor(() => expect(urlText()).toBe('fallback://a'));
    expect(revoked).toContain(aUrl);
  });

  it('rejects a delayed file-handle resolution after the scope is deactivated', async () => {
    const gate = deferred<Blob>();
    const handle = {
      getFile: async () => gate.promise,
    };
    const a = createVaultAssetScope(1, { active: true });
    const view = render(
      <VaultAssetScopeProvider scope={a}>
        <Probe imageRef="Assets/late.png" fallback="fallback://late" folderHandle={handle} />
      </VaultAssetScopeProvider>
    );
    expect(urlText()).toBe('fallback://late');

    // The async read is pending; the collection is replaced before it resolves.
    a.deactivate();
    gate.resolve(new Blob(['late'], { type: 'image/png' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urlText()).toBe('fallback://late');
    expect(created).toHaveLength(0);
    expect(a.get('Assets/late.png')).toBeUndefined();
    view.unmount();
  });

  it('renders a live temporary preview and drops it on release', async () => {
    const preview = createTemporaryPreviewUrl(new Blob(['preview'], { type: 'image/png' }), 'r5-test');
    const scope = createVaultAssetScope(1, { active: true });
    renderWithScope(scope, preview, 'fallback://preview');
    expect(urlText()).toBe(preview);

    act(() => releaseTemporaryPreviewUrl(preview));
    await waitFor(() => expect(urlText()).toBe('fallback://preview'));
    scope.deactivate();
  });

  it('never renders an unknown or foreign blob URL', async () => {
    const a = createVaultAssetScope(1, { active: true });
    a.registerAsset('Assets/a.png', new Blob(['A'], { type: 'image/png' }));
    const aUrl = a.get('Assets/a.png')!.blobUrl!;
    const b = createVaultAssetScope(2, { active: true });

    renderWithScope(b, aUrl, 'fallback://b');
    expect(urlText()).toBe('fallback://b');

    const unknown = 'blob:not-owned-by-any-scope';
    renderWithScope(b, unknown, 'fallback://unknown');
    const rendered = screen.getAllByTestId('resolved-url');
    expect(rendered[rendered.length - 1]?.textContent).toBe('fallback://unknown');

    a.deactivate();
    b.deactivate();
  });

  it('revokes one shared scope URL exactly once for multiple consumers', async () => {
    const a = createVaultAssetScope(1, { active: true });
    a.registerAsset('Assets/shared.png', new Blob(['shared'], { type: 'image/png' }));
    const sharedUrl = a.get('Assets/shared.png')!.blobUrl!;
    render(
      <VaultAssetScopeProvider scope={a}>
        <Probe imageRef="Assets/shared.png" fallback="fallback://1" />
        <Probe imageRef="Assets/shared.png" fallback="fallback://2" />
      </VaultAssetScopeProvider>
    );
    expect(screen.getAllByTestId('resolved-url').map((node) => node.textContent)).toEqual([
      sharedUrl,
      sharedUrl,
    ]);

    act(() => a.deactivate());
    await waitFor(() =>
      expect(screen.getAllByTestId('resolved-url').map((node) => node.textContent)).toEqual([
        'fallback://1',
        'fallback://2',
      ])
    );
    expect(revoked.filter((url) => url === sharedUrl)).toHaveLength(1);
  });
});
