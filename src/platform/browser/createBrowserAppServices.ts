/**
 * The Kitchen Codex — Browser Composition Bootstrap (Phase 4D3C).
 *
 * The SINGLE place that constructs concrete browser platform adapters, so the
 * concrete `new BrowserX(...)` calls live here and nowhere else in the
 * application. Browser-shell code (e.g. App.tsx) should use these factories, and
 * `createAppServices` (the application DI seam) stays the composition point for
 * the resulting contract instances.
 *
 * This is browser/platform construction detail. It is NOT a service locator,
 * NOT a global registry, NOT a singleton container. Each factory returns a fresh
 * adapter instance the caller owns.
 *
 * DESIGN:
 *   - `vault` is only constructible from a connected directory handle; before a
 *     vault is connected there is no vault adapter to build.
 *   - The settings/network adapters are independent of a vault connection and are
 *     built once by the shell.
 *
 * Dependency direction: platform/browser -> application contracts (allowed).
 */

import { BrowserFsaVaultAdapter } from './BrowserFsaVaultAdapter';
import type { FsaDirectoryHandleLike } from './BrowserFsaVaultAdapter';
import { BrowserSettingsAdapter } from './BrowserSettingsAdapter';
import { BrowserNetworkAdapter } from './BrowserNetworkAdapter';
import { BrowserAssetAdapter } from './BrowserAssetAdapter';
import { BrowserSecretAdapter } from './BrowserSecretAdapter';

/** Builds a browser localStorage-backed settings adapter. */
export function createBrowserSettingsAdapter(): BrowserSettingsAdapter {
  return new BrowserSettingsAdapter();
}

/** Builds a browser app-backend JSON transport adapter. */
export function createBrowserNetworkAdapter(): BrowserNetworkAdapter {
  return new BrowserNetworkAdapter();
}

/** Builds the truthful browser "no provider secret storage" adapter (unavailable). */
export function createBrowserSecretAdapter(): BrowserSecretAdapter {
  return new BrowserSecretAdapter();
}

/** Builds a browser File System Access vault adapter from a connected directory handle. */
export function createBrowserVaultAdapter(folderHandle: unknown): BrowserFsaVaultAdapter {
  return new BrowserFsaVaultAdapter(folderHandle as FsaDirectoryHandleLike);
}

/** Builds a browser File System Access asset adapter from a connected directory handle. */
export function createBrowserAssetAdapter(folderHandle: unknown): BrowserAssetAdapter {
  return new BrowserAssetAdapter(folderHandle as FsaDirectoryHandleLike);
}

/**
 * Fetches transient generated-image preview BYTES for a token via the
 * authenticated preview endpoint. Binary-only transport: no base64/data-URL
 * channel, no arbitrary URL (fixed application API path). Returns undefined for
 * unknown/expired tokens or transport failure.
 */
export async function fetchRecipeImagePreviewBytes(token: string): Promise<Uint8Array | undefined> {
  if (typeof token !== 'string' || !token || token.length > 512) return undefined;
  try {
    const res = await fetch(`/api/recipes/image/preview/${encodeURIComponent(token)}`);
    if (!res.ok) return undefined;
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return undefined;
  }
}
