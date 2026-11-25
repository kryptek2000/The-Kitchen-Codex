/**
 * Asset provenance — R5.
 *
 * Vault-owned object URLs belong to exactly one `VaultAssetScope`. Temporary
 * editor/Grabber preview URLs are application-owned but are NOT Vault assets:
 * they may be displayed while their lifecycle is live, but they must never be
 * persisted as recipe references. Unknown blob URLs are neither displayable nor
 * persistable.
 *
 * This module deliberately has NO runtime dependency on `vaultAssets.ts`; the
 * scope is passed as an interface so both the registry and rendering helpers can
 * share one classification without a cycle.
 */

export interface BlobOwnerScope {
  isActive(): boolean;
  ownsUrl(url?: string): boolean;
}

export type AssetReferenceKind =
  | 'remote'
  | 'data'
  | 'vault-local'
  | 'scope-owned-blob'
  | 'temporary-preview-blob'
  | 'unknown-blob'
  | 'malformed'
  | 'other';

export interface ClassifiedAssetReference {
  kind: AssetReferenceKind;
  clean: string;
}

const temporaryPreviewUrls = new Map<string, { purpose: string; createdAt: number }>();
const previewListeners = new Set<() => void>();

function notifyPreviewListeners(): void {
  for (const listener of [...previewListeners]) {
    try {
      listener();
    } catch {
      // Listener failures must never break URL release.
    }
  }
}

/**
 * Creates an application-owned temporary image preview URL. The URL is
 * displayable through the image helpers while registered, and is rejected by
 * persistence validation until explicitly materialized into a Vault.
 */
export function createTemporaryPreviewUrl(blob: Blob, purpose: string): string {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Object URLs are not available in this environment.');
  }
  const url = URL.createObjectURL(blob);
  temporaryPreviewUrls.set(url, { purpose, createdAt: Date.now() });
  notifyPreviewListeners();
  return url;
}

export function isTemporaryPreviewUrl(url?: string): boolean {
  return !!url && temporaryPreviewUrls.has(url);
}

/**
 * Releases a temporary preview URL exactly once. URLs owned by another
 * subsystem (including Vault scopes) are never revoked here.
 */
export function releaseTemporaryPreviewUrl(url?: string): void {
  if (!url || !temporaryPreviewUrls.delete(url)) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // best effort
  }
  notifyPreviewListeners();
}

/** Releases every temporary preview URL (optionally for one purpose). */
export function releaseTemporaryPreviewUrls(purpose?: string): void {
  for (const [url, meta] of [...temporaryPreviewUrls]) {
    if (purpose === undefined || meta.purpose === purpose) {
      temporaryPreviewUrls.delete(url);
      try {
        URL.revokeObjectURL(url);
      } catch {
        // best effort
      }
    }
  }
  notifyPreviewListeners();
}

/** Subscribe to temporary-preview URL creation/release. */
export function subscribeTemporaryPreviewUrls(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => previewListeners.delete(listener);
}

/**
 * Extracts the URI scheme case-insensitively. URL schemes are case-insensitive
 * by URL semantics; a colon after a path segment is not a scheme because `/`
 * is not permitted in the scheme grammar.
 */
export function getReferenceScheme(clean: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(clean.trim());
  return match ? match[1].toLowerCase() : null;
}

/** C0/C1 control characters are never valid in a persisted asset reference. */
export function hasReferenceControlCharacters(clean: string): boolean {
  return /[\u0000-\u001F\u007F-\u009F]/.test(clean);
}

export function isRemoteOrDataReference(clean: string): boolean {
  const scheme = getReferenceScheme(clean);
  return scheme === 'http' || scheme === 'https' || scheme === 'data';
}

export function isDataReference(clean: string): boolean {
  return getReferenceScheme(clean) === 'data';
}

export function isBlobReference(clean: string): boolean {
  return getReferenceScheme(clean) === 'blob';
}

// Mirrors the supported image extensions in vaultAssets. Kept local so this
// provenance module stays free of a runtime registry dependency.
const LOCAL_IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'svg', 'bmp', 'ico', 'tiff',
]);

export function isVaultLocalImageReference(clean: string): boolean {
  if (!clean) return false;
  const lower = clean.toLowerCase().replace(/\\/g, '/');
  if (lower.startsWith('assets/') || lower.startsWith('attachments/')) return true;
  const cleanNoQuery = lower.split(/[?#]/, 1)[0];
  const dot = cleanNoQuery.lastIndexOf('.');
  if (dot < 0) return false;
  return LOCAL_IMAGE_EXTENSIONS.has(cleanNoQuery.slice(dot + 1));
}

/**
 * Display rule: a blob URL is displayable only when it is currently owned by
 * the active Vault scope OR it is a live application temporary preview. A
 * deactivated/foreign/unknown blob is not displayable.
 */
export function isDisplayableBlobUrl(
  clean: string,
  assetScope?: BlobOwnerScope | null
): boolean {
  if (!isBlobReference(clean)) return false;
  if (assetScope && assetScope.isActive() && assetScope.ownsUrl(clean)) return true;
  return isTemporaryPreviewUrl(clean);
}

/**
 * Persistence rule: blob URLs are never durable Vault references. They must be
 * materialized through the authorized asset-write path first. This applies even
 * to a blob currently owned by the active scope: the object URL is a rendering
 * handle, not a canonical path.
 */
export function isPersistableAssetReference(kind: AssetReferenceKind): boolean {
  return kind === 'remote' || kind === 'data' || kind === 'vault-local';
}

export function classifyAssetReference(
  clean: string,
  assetScope?: BlobOwnerScope | null
): ClassifiedAssetReference {
  if (!clean || hasReferenceControlCharacters(clean)) {
    return { kind: 'malformed', clean };
  }
  const scheme = getReferenceScheme(clean);
  if (scheme === 'http' || scheme === 'https') {
    return { kind: 'remote', clean };
  }
  if (scheme === 'data') {
    return { kind: 'data', clean };
  }
  if (scheme === 'blob') {
    if (assetScope && assetScope.isActive() && assetScope.ownsUrl(clean)) {
      return { kind: 'scope-owned-blob', clean };
    }
    if (isTemporaryPreviewUrl(clean)) {
      return { kind: 'temporary-preview-blob', clean };
    }
    return { kind: 'unknown-blob', clean };
  }
  // A non-URL scheme (file:, javascript:, c:, unknown:) is ambiguous for a
  // Vault-local asset and must never be trusted as a local path.
  if (scheme !== null) {
    return { kind: 'malformed', clean };
  }
  if (isVaultLocalImageReference(clean)) {
    return { kind: 'vault-local', clean };
  }
  return { kind: 'other', clean };
}
