/**
 * Obsidian Vault Local Assets Manager & Image Resolver
 * Provides comprehensive handling for local vault images (e.g. Assets/Breakfast Burritos.jpg,
 * [[Assets/Breakfast Burritos.jpg]], attachments/, etc.) and supports downloading web images
 * directly into the Obsidian vault's Assets/ folder.
 *
 * SECURITY (Phase 4D3C/4D3D): remote image download goes ONLY through the
 * server-side SSRF-protected proxy (`/api/download-image`). This shared module
 * performs NO direct arbitrary remote fetch and NO direct CORS fallback — the
 * binary downloader is INJECTED from the shell (never imported from a platform
 * module), keeping shared code free of platform imports.
 */

import {
  isAssetPathCollisionError,
  type AssetAdapter,
  type RemoteImageDownloader,
} from '../application/adapters/AssetAdapter';
import type { VaultCollectionIntent } from '../core/vaultSession';
import {
  classifyAssetReference,
  getReferenceScheme,
  isBlobReference,
  isDisplayableBlobUrl,
  isPersistableAssetReference,
  type BlobOwnerScope,
} from './assetProvenance';

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
  'svg',
  'bmp',
  'ico',
  'tiff',
]);

export interface VaultAssetItem {
  path: string; // e.g. "Assets/Breakfast Burritos.jpg"
  fileName: string; // e.g. "Breakfast Burritos.jpg"
  blobUrl?: string; // e.g. "blob:http://..."
  fileHandle?: any; // FileSystemFileHandle
  file?: File | Blob; // File / Blob bytes (owned by the scope)
  lastModified?: number;
}

/**
 * Strips wikilink brackets, quotes, query parameters, leading slashes, and decodes URI strings.
 */
export function cleanImageReference(
  ref?: string,
  options?: { decode?: boolean }
): string {
  if (!ref || typeof ref !== 'string') return '';
  let clean = ref.trim();

  // Strip markdown image embed ![alt](url) -> url
  const mdMatch = clean.match(/^!\[.*?\]\((.+?)\)$/);
  if (mdMatch) clean = mdMatch[1].trim();

  // Strip wikilink embed ![[Path/Image.jpg]] or [[Path/Image.jpg]]
  clean = clean.replace(/^!\[\[(.*)\]\]$/, '$1');
  clean = clean.replace(/^\[\[(.*)\]\]$/, '$1');

  // Strip quotes
  clean = clean.replace(/^["']+|["']+$/g, '');

  // Strip leading ./ or /
  clean = clean.replace(/^(\.\/|\/)+/, '');

  // Decode URI components exactly once at the appropriate boundary. Callers
  // that already normalized an extracted path pass decode:false to avoid
  // double-decoding into an unintended destination.
  if (options?.decode !== false) {
    try {
      clean = decodeURIComponent(clean);
    } catch (e) {
      // Ignore URI decode errors on weird characters
    }
  }

  return clean;
}

/**
 * Normalizes a path or reference string into a unified lookup key.
 */
export function normalizeAssetKey(pathOrRef: string): string {
  const cleaned = cleanImageReference(pathOrRef);
  return cleaned.toLowerCase().replace(/\\/g, '/').trim();
}

/**
 * Checks if a given file name or path has an image extension
 */
export function isImageFile(fileNameOrPath: string): boolean {
  if (!fileNameOrPath) return false;
  const clean = cleanImageReference(fileNameOrPath);
  const parts = clean.split('.');
  if (parts.length < 2) return false;
  const ext = parts.pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * One Vault-scoped asset registry. A scope is either:
 *  - active: visible to lookups/subscribers for the current session;
 *  - provisional: accepting registrations for a pending transition, but not
 *    visible until the transition commits;
 *  - inactive: no registrations, no lookups, and all owned object URLs revoked.
 *
 * A provisional scope lets scans/imports populate the destination without
 * exposing it to the current UI. A stale scan can only ever touch its captured
 * (later inactive) scope; it can never repopulate the active session.
 */
export interface VaultAssetScope {
  readonly ownerSessionId: number | null;
  isActive(): boolean;
  isAccepting(): boolean;
  activate(sessionId: number): void;
  deactivate(): void;
  clear(): void;
  registerAsset(
    relativePath: string,
    fileOrHandle: File | Blob | any,
    blobUrl?: string
  ): VaultAssetItem | null;
  removeAsset(relativePath: string): boolean;
  get(ref?: string): VaultAssetItem | undefined;
  getAll(): VaultAssetItem[];
  ownsUrl(url?: string): boolean;
  subscribe(listener: () => void): () => void;
}

class ScopedVaultAssetRegistry implements VaultAssetScope {
  /** Exact, case-preserving full Vault-relative path → item. */
  private pathMap = new Map<string, VaultAssetItem>();
  /** Case-insensitive short/name aliases; null means ambiguous. */
  private aliasMap = new Map<string, VaultAssetItem | null>();
  private itemsList: VaultAssetItem[] = [];
  private listeners = new Set<() => void>();
  private ownedBlobUrls = new Set<string>();
  private active: boolean;
  private accepting: boolean;
  public ownerSessionId: number | null;

  constructor(sessionId: number | null, options?: { active?: boolean }) {
    this.ownerSessionId = sessionId;
    this.active = options?.active !== false;
    this.accepting = true;
  }

  public isActive(): boolean {
    return this.active;
  }

  public isAccepting(): boolean {
    return this.accepting;
  }

  public activate(sessionId: number): void {
    this.ownerSessionId = sessionId;
    this.active = true;
    this.accepting = true;
    this.notify();
  }

  public deactivate(): void {
    this.active = false;
    this.accepting = false;
    this.clear();
    // Notify any still-mounted consumer so it can drop a stale blob URL and
    // render its fallback. `getAll`/`get` are already empty/inactive.
    this.notify();
  }

  public subscribe(listener: () => void): () => void {
    if (!this.active) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.warn('Error in asset registry listener:', e);
      }
    }
  }

  private ownBlobUrl(blob: Blob): string | null {
    if (!this.accepting || typeof URL === 'undefined') return null;
    try {
      const url = URL.createObjectURL(blob);
      this.ownedBlobUrls.add(url);
      return url;
    } catch {
      return null;
    }
  }

  private revokeOwned(url?: string): void {
    if (!url || !this.ownedBlobUrls.has(url)) return;
    this.ownedBlobUrls.delete(url);
    if (typeof URL === 'undefined') return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // best effort
    }
  }

  /**
   * Registers a vault asset file/handle under normalized keys. Returns null when
   * the scope is no longer accepting registrations (superseded/failed).
   */
  public registerAsset(
    relativePath: string,
    fileOrHandle: File | Blob | any,
    blobUrl?: string
  ): VaultAssetItem | null {
    if (!this.accepting) return null;
    const cleanPath = cleanImageReference(relativePath);
    if (!cleanPath) return null;
    const fileName = cleanPath.split('/').pop() || cleanPath;

    // Asset identity is the EXACT full Vault-relative path. A shared basename
    // is never an identity match (two nested assets may share a filename).
    let existing = this.pathMap.get(cleanPath);

    let effectiveBlobUrl = blobUrl;
    let fileObj: File | Blob | undefined;
    let fileHandle: any | undefined;

    if (typeof File !== 'undefined' && fileOrHandle instanceof File) {
      fileObj = fileOrHandle;
    } else if (typeof Blob !== 'undefined' && fileOrHandle instanceof Blob) {
      fileObj = fileOrHandle;
    } else if (fileOrHandle && typeof fileOrHandle.getFile === 'function') {
      fileHandle = fileOrHandle;
    } else if (
      fileOrHandle &&
      typeof fileOrHandle.arrayBuffer === 'function'
    ) {
      fileObj = fileOrHandle as Blob;
    }

    if (fileObj && !effectiveBlobUrl) {
      effectiveBlobUrl = this.ownBlobUrl(fileObj) ?? undefined;
    }

    if (existing) {
      if (fileObj) existing.file = fileObj;
      if (fileHandle) existing.fileHandle = fileHandle;
      if (effectiveBlobUrl) {
        if (
          existing.blobUrl &&
          existing.blobUrl !== effectiveBlobUrl &&
          this.ownedBlobUrls.has(existing.blobUrl)
        ) {
          this.revokeOwned(existing.blobUrl);
        }
        existing.blobUrl = effectiveBlobUrl;
      }
    } else {
      existing = {
        path: cleanPath,
        fileName,
        blobUrl: effectiveBlobUrl,
        fileHandle,
        file: fileObj,
      };
      this.itemsList.push(existing);
    }

    this.rebuildIndex();

    if (this.active) this.notify();
    return existing;
  }

  /**
   * Rebuilds the exact-path map and the short-name/case-insensitive alias map.
   * Aliases are exposed only when they identify exactly one item; two
   * `photo.png` assets in different folders make the basename ambiguous.
   * Exact path identity is always case-sensitive and unambiguous.
   */
  private rebuildIndex(): void {
    this.pathMap.clear();
    this.aliasMap.clear();
    const addAlias = (rawKey: string, item: VaultAssetItem) => {
      const key = normalizeAssetKey(rawKey);
      if (!key) return;
      const existing = this.aliasMap.get(key);
      if (existing === undefined) {
        this.aliasMap.set(key, item);
      } else if (existing !== item) {
        this.aliasMap.set(key, null);
      }
    };

    for (const item of this.itemsList) {
      this.pathMap.set(item.path, item);
      const fileName = item.fileName;
      const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
      const normPath = normalizeAssetKey(item.path);
      addAlias(item.path, item);
      addAlias(fileName, item);
      addAlias(nameWithoutExt, item);
      if (normPath.startsWith('assets/')) {
        addAlias(normPath.substring(7), item);
      } else {
        addAlias(`assets/${normPath}`, item);
        addAlias(`assets/${fileName}`, item);
      }
      if (normPath.startsWith('attachments/')) {
        addAlias(normPath.substring(12), item);
      } else {
        addAlias(`attachments/${fileName}`, item);
      }
    }
  }

  /** Removes one exact path and revokes its owned URL (rollback cleanup). */
  public removeAsset(relativePath: string): boolean {
    if (!this.accepting && !this.active) return false;
    const cleanPath = cleanImageReference(relativePath);
    const item = this.pathMap.get(cleanPath);
    if (!item) return false;
    if (item.blobUrl) this.revokeOwned(item.blobUrl);
    this.itemsList = this.itemsList.filter((entry) => entry !== item);
    this.rebuildIndex();
    if (this.active) this.notify();
    return true;
  }

  public get(ref?: string): VaultAssetItem | undefined {
    if (!this.active || !ref) return undefined;
    const clean = cleanImageReference(ref);
    if (!clean) return undefined;
    // Exact path identity first (case-sensitive). This is the only identity
    // that may be used for distinct same-basename/case-distinct assets.
    const exact = this.pathMap.get(clean);
    if (exact) return exact;
    // Short-name/case-insensitive compatibility only when unambiguous.
    return this.aliasMap.get(normalizeAssetKey(clean)) ?? undefined;
  }

  public getAll(): VaultAssetItem[] {
    return this.active ? [...this.itemsList] : [];
  }

  /**
   * True only while this scope is active and currently owns the object URL.
   * Deactivation/clear revokes the URL and drops ownership, so a retired URL
   * can never be presented as current.
   */
  public ownsUrl(url?: string): boolean {
    return !!url && this.active && this.ownedBlobUrls.has(url);
  }

  /**
   * Clears entries and revokes ONLY URLs owned by this scope. Keeps the scope's
   * active/accepting flags unchanged (used by explicit clear and deactivate).
   */
  public clear(): void {
    for (const url of [...this.ownedBlobUrls]) this.revokeOwned(url);
    this.ownedBlobUrls.clear();
    this.pathMap.clear();
    this.aliasMap.clear();
    this.itemsList = [];
    if (this.active) this.notify();
  }
}

export function createVaultAssetScope(
  sessionId: number | null,
  options?: { active?: boolean }
): VaultAssetScope {
  return new ScopedVaultAssetRegistry(sessionId, options);
}

/**
 * Legacy/test-only registry instance. Production components must use the active
 * VaultAssetScope from the provider; no production lookup falls back here.
 */
export const vaultAssets = createVaultAssetScope(null, { active: true });

/**
 * Synchronously resolves an image path or reference against the vault asset cache.
 * Returns the Blob Object URL if cached, or undefined/null.
 */
export function syncResolveVaultAssetUrl(
  imageRef?: string,
  assetScope?: VaultAssetScope | null
): string | null {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const trimmed = imageRef.trim();

  // Remote/data references are session-independent. A blob URL is displayable
  // only when the active scope owns it or it is a live temporary preview; an
  // unknown/foreign/deactivated blob must not be rendered.
  const scheme = getReferenceScheme(trimmed);
  if (scheme === 'http' || scheme === 'https' || scheme === 'data') {
    return trimmed;
  }
  if (scheme === 'blob') {
    return isDisplayableBlobUrl(trimmed, assetScope) ? trimmed : null;
  }

  // Vault-local references REQUIRE an explicit active scope. There is no global
  // fallback that could leak bytes from a previous Vault.
  const asset = assetScope?.get(trimmed);
  if (asset?.blobUrl) {
    return asset.blobUrl;
  }

  return null;
}

/**
 * Asynchronously resolves an image reference, loading and generating a Blob URL from
 * the FileSystemFileHandle or File object if needed.
 */
export async function resolveVaultAssetUrl(
  imageRef?: string,
  folderHandle?: any,
  assetScope?: VaultAssetScope | null
): Promise<string | null> {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const cleanRef = cleanImageReference(imageRef);

  const scheme = getReferenceScheme(cleanRef);
  if (scheme === 'http' || scheme === 'https' || scheme === 'data') {
    return cleanRef;
  }
  if (scheme === 'blob') {
    return isDisplayableBlobUrl(cleanRef, assetScope) ? cleanRef : null;
  }

  // Vault-local resolution requires the explicit destination scope. This is the
  // security boundary: a lookup can never fall through to another Vault.
  if (!assetScope || !assetScope.isAccepting()) return null;

  // 1. Check the scoped in-memory registry.
  const asset = assetScope.get(cleanRef);
  if (asset) {
    if (asset.blobUrl) return asset.blobUrl;
    if (asset.file) {
      const registered = assetScope.registerAsset(asset.path, asset.file);
      return registered?.blobUrl ?? null;
    }
    if (asset.fileHandle && typeof asset.fileHandle.getFile === 'function') {
      try {
        const file = await asset.fileHandle.getFile();
        if (!assetScope.isAccepting()) return null;
        const registered = assetScope.registerAsset(asset.path, file);
        asset.file = file;
        return registered?.blobUrl ?? null;
      } catch (err) {
        console.warn('Could not read file from handle:', err);
      }
    }
  }

  // 2. Not yet registered: read from THIS session's directory handle.
  if (folderHandle && typeof folderHandle.getFileHandle === 'function') {
    const fileName = cleanRef.split('/').pop() || cleanRef;
    const searchDirs = ['Assets', 'assets', 'attachments', 'Attachments', 'images', ''];

    for (const dirName of searchDirs) {
      try {
        let dir = folderHandle;
        if (dirName) {
          dir = await folderHandle.getDirectoryHandle(dirName, { create: false });
        }
        const fileHandle = await dir.getFileHandle(fileName, { create: false });
        const file = await fileHandle.getFile();
        if (!assetScope.isAccepting()) return null;
        const relPath = dirName ? `${dirName}/${fileName}` : fileName;
        const registered = assetScope.registerAsset(relPath, file);
        if (registered?.blobUrl) return registered.blobUrl;
      } catch {
        // Continue searching other candidate directories.
      }
    }
  }

  return null;
}

/**
 * Recursively scans a FileSystemDirectoryHandle for all image assets and registers them
 */
export async function scanVaultAssetsFromHandle(
  dirHandle: any,
  assetScope: VaultAssetScope,
  currentPath: string = ''
): Promise<VaultAssetItem[]> {
  const discovered: VaultAssetItem[] = [];
  if (!assetScope.isAccepting()) return discovered;

  async function walk(handle: any, path: string) {
    if (!assetScope.isAccepting()) return;
    try {
      // @ts-ignore
      for await (const entry of handle.values()) {
        if (!assetScope.isAccepting()) return;
        const entryPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === 'file' && isImageFile(entry.name)) {
          try {
            const file = await entry.getFile();
            if (!assetScope.isAccepting()) return;
            const item = assetScope.registerAsset(entryPath, file);
            if (item) {
              item.file = file;
              discovered.push(item);
            }
          } catch (e) {
            console.warn('Failed to load asset file:', entry.name, e);
          }
        } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
          await walk(entry, entryPath);
        }
      }
    } catch (e) {
      console.warn('Error walking directory for assets:', e);
    }
  }

  await walk(dirHandle, currentPath || '');
  return discovered;
}

/**
 * Deterministically decodes a `data:` URL into raw bytes (no network fetch).
 * `;base64` detection is case-insensitive; intra-base64 whitespace is stripped;
 * percent-encoded UTF-8 payloads are decoded. Malformed input throws.
 */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; dataUrl: string; contentType: string } {
  const trimmed = String(dataUrl ?? '').trim();
  if (!/^data:/i.test(trimmed)) throw new Error('Invalid data: URL.');

  const comma = trimmed.indexOf(',');
  if (comma < 0) throw new Error('Invalid data: URL.');
  const meta = trimmed.slice(5, comma).trim();
  const payload = trimmed.slice(comma + 1);

  // `;base64` detection is case-insensitive and tolerant of trailing whitespace.
  const base64Match = /;base64\s*$/i.exec(meta);
  const isBase64 = Boolean(base64Match);
  const mime = isBase64 ? meta.slice(0, base64Match!.index).trim() : meta;
  const contentType = mime || 'text/plain';

  let bytes: Uint8Array;
  if (isBase64) {
    // Strip intra-base64 whitespace (browsers reject it) then validate the charset.
    const clean = payload.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('Invalid base64 in data: URL.');
    const binary = atob(clean);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }

  return { bytes, dataUrl: trimmed, contentType };
}

/** Converts raw bytes to a browser `Blob` (rendering/object-URL scope only). */
export function bytesToBlob(bytes: Uint8Array, contentType: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: contentType || 'image/jpeg' });
}

/** Injected dependencies for the asset save flow (supplied by the browser shell). */
export interface SaveImageDeps {
  /** Optional binary storage boundary (BrowserAssetAdapter) — preferred write path. */
  asset?: AssetAdapter;
  /** Legacy browser vault handle fallback. */
  folderHandle?: any;
  /** Injected fixed-purpose remote image downloader (browser shell implementation). */
  downloadRemoteImage?: RemoteImageDownloader;
  /** The exact Vault asset scope for this operation. No global fallback. */
  assetScope?: VaultAssetScope;
}

/**
 * Runs a composite Asset + recipe operation under ONE originating Vault
 * session lease. The callback receives deps bound to that exact session; the
 * caller must use them (never a newer rendered imageService) for both the asset
 * write and any recipe persistence inside the callback.
 */
export type SessionAssetRunner = <T>(
  operation: (deps: SaveImageDeps) => Promise<T>
) => Promise<T>;

/** The intent plus its provisional destination scope for a folder import. */
export interface VaultCollectionImportStart {
  readonly intent: VaultCollectionIntent;
  readonly assetScope: VaultAssetScope;
}

/** Derives the extension from content-type, honoring an explicit preferredExtension. */
function imageExtension(preferredExtension: string | undefined, contentType: string): string {
  if (preferredExtension) return preferredExtension.replace(/^\./, '').toLowerCase();
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('svg')) return 'svg';
  if (contentType.includes('avif')) return 'avif';
  return 'jpg';
}

/**
 * Resolves a `Blob` source or a string (`data:`/remote URL) into raw image bytes
 * + contentType. Remote URLs require an injected downloader (never imported from
 * a platform module); there is NO direct arbitrary remote fetch.
 */
async function resolveImageBytes(
  source: string | Blob,
  deps: SaveImageDeps
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (typeof source === 'string') {
    const trimmed = source.trim();
    const scheme = getReferenceScheme(trimmed);
    if (scheme === 'data') {
      const { bytes, contentType } = dataUrlToBytes(trimmed);
      return { bytes, contentType };
    }
    if (scheme === 'blob') {
      // A blob URL is a rendering handle, not an image byte source. Callers
      // must pass the Blob itself so it can be materialized through the
      // authorized AssetAdapter write path.
      throw new Error('Temporary image previews must be materialized from their Blob before saving.');
    }
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error('Only remote http(s), data, or materialized image bytes can be saved to Assets.');
    }
    if (!deps.downloadRemoteImage) {
      throw new Error('Remote image download requires a configured downloader.');
    }
    const result = await deps.downloadRemoteImage.downloadRemoteImage(trimmed);
    return { bytes: result.bytes, contentType: result.contentType };
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  return { bytes, contentType: source.type || 'image/jpeg' };
}

/** Hard bound on collision-suffix attempts (mirrors the canonical save flow). */
export const MAX_VAULT_ASSET_COLLISION_ATTEMPTS = 100;

/** Sanitizes a recipe title into a safe asset basename (single authority). */
export function sanitizeVaultAssetTitle(recipeTitle: string): string {
  return recipeTitle.replace(/[\/\\?%*:|"<>]/g, '-').trim() || 'Recipe Photo';
}

/**
 * Shared, module-level collision-safe allocation reservations. Independent
 * Recipe Editor component instances (and direct concurrent callers) share this
 * ONE set — it is NOT a per-component ref. A path is claimed SYNCHRONOUSLY
 * before its existence is rechecked and before bytes are written, and released
 * in a `finally` on success, failure, cancellation, and thrown exception, so
 * the set never grows unbounded.
 *
 * KEY: the normalized vault-relative target path (`<directory>/<filename>`),
 * e.g. `Assets/Recipe (2).png`. This encodes the target directory and filename;
 * a shell instance targets ONE connected vault, so this is effectively scoped
 * to that vault identity. Across distinct vaults the worst case is harmless
 * over-serialization, never a missed collision.
 *
 * TRUTHFUL SCOPE: JavaScript is single-threaded, so the synchronous claim is
 * atomic WITHIN this realm. It does NOT provide cross-process/cross-tab
 * exclusivity; adapters with a genuine exclusive-create primitive
 * (`AssetAdapter.writeExclusive`) additionally close that gap where the
 * underlying API supports it.
 */
const reservedAssetPaths = new Set<string>();

/** Synchronous claim; false when another in-flight transaction owns the path. */
function reserveAssetPath(path: string): boolean {
  if (reservedAssetPaths.has(path)) return false;
  reservedAssetPaths.add(path);
  return true;
}

/** Releases a claim (idempotent) on every terminal path. */
function releaseAssetPath(path: string): void {
  reservedAssetPaths.delete(path);
}

/** Test-only: clears shared reservations between tests (never used in prod). */
export function resetVaultAssetAllocationForTests(): void {
  reservedAssetPaths.clear();
}

/** Test-only: whether a path is currently reserved (never used in prod). */
export function isVaultAssetPathReservedForTests(path: string): boolean {
  return reservedAssetPaths.has(path);
}

/** Deterministic collision candidate: `Foo.ext`, then `Foo (n).ext`. */
function collisionCandidate(safeTitle: string, ext: string, attempt: number): string {
  return attempt === 0 ? `Assets/${safeTitle}.${ext}` : `Assets/${safeTitle} (${attempt}).${ext}`;
}

/** Legacy FSA probe: `getFileHandle` WITHOUT create throws when absent. */
async function legacyFolderAssetExists(folderHandle: any, candidate: string): Promise<boolean> {
  let assetsDir: any;
  try {
    assetsDir = await folderHandle.getDirectoryHandle('Assets', { create: false });
  } catch (e) {
    try {
      assetsDir = await folderHandle.getDirectoryHandle('assets', { create: false });
    } catch (e2) {
      return false; // no Assets dir yet: the fixed name is free
    }
  }
  try {
    await assetsDir.getFileHandle(candidate.split('/').pop() || candidate, { create: false });
    return true;
  } catch (e) {
    return false; // absent: free
  }
}

/** Existence probe for the active asset boundary (AssetAdapter or legacy FSA). */
async function assetPathExists(deps: SaveImageDeps, candidate: string): Promise<boolean> {
  if (deps.asset) return deps.asset.exists(candidate);
  if (deps.folderHandle && typeof deps.folderHandle.getDirectoryHandle === 'function') {
    return legacyFolderAssetExists(deps.folderHandle, candidate);
  }
  throw new Error('No vault asset boundary is available.');
}

/**
 * Writes bytes to a SPECIFIC path through the active boundary. Prefers a
 * genuinely exclusive create (`writeExclusive`) when the adapter provides one;
 * otherwise uses the normal (overwriting) `write`, safe here because the path
 * is reserved and existence was just rechecked.
 */
async function writeAssetAtPath(
  deps: SaveImageDeps,
  relativePath: string,
  bytes: Uint8Array,
  contentType: string
): Promise<void> {
  if (deps.asset) {
    if (typeof deps.asset.writeExclusive === 'function') {
      await deps.asset.writeExclusive(relativePath, bytes, contentType);
      return;
    }
    // No exclusive primitive: the shared reservation + immediate existence
    // recheck provides the strongest in-realm guarantee. Cross-process
    // atomicity is not claimed by the AssetAdapter contract.
    await deps.asset.write(relativePath, bytes, contentType);
    return;
  }
  if (deps.folderHandle && typeof deps.folderHandle.getDirectoryHandle === 'function') {
    // Legacy browser FSA write (preserve existing 'Assets'/'assets' preference).
    const fileName = relativePath.split('/').pop() || relativePath;
    let assetsDir: any;
    try {
      assetsDir = await deps.folderHandle.getDirectoryHandle('Assets', { create: true });
    } catch (e) {
      assetsDir = await deps.folderHandle.getDirectoryHandle('assets', { create: true });
    }
    const fileHandle = await assetsDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytesToBlob(bytes, contentType));
    await writable.close();
    return;
  }
  throw new Error('No vault asset boundary is available.');
}

/**
 * Collision-safe create: claims a deterministic free path SYNCHRONOUSLY (the
 * shared reservation), rechecks existence INSIDE the claim, then creates the
 * asset while the claim is held, releasing it on every exit. A waiting
 * transaction sees the claim (or the now-existing file) and selects the next
 * deterministic ` (n)` suffix. An existing asset is NEVER overwritten.
 */
export async function createCollisionSafeAsset(
  deps: SaveImageDeps,
  safeTitle: string,
  ext: string,
  bytes: Uint8Array,
  contentType: string
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_VAULT_ASSET_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = collisionCandidate(safeTitle, ext, attempt);
    // Synchronous claim: another in-flight transaction cannot claim this path.
    if (!reserveAssetPath(candidate)) continue;
    try {
      // Recheck existence INSIDE the claim, immediately before writing.
      if (await assetPathExists(deps, candidate)) continue;
      let wrote = false;
      try {
        await writeAssetAtPath(deps, candidate, bytes, contentType);
        wrote = true;
        // Verify the exact bytes for adapters that can read back. A partially
        // written/mismatched asset must fail the transaction, not be published.
        if (deps.asset && typeof deps.asset.read === 'function') {
          const written = await deps.asset.read(candidate);
          if (
            !written ||
            written.length !== bytes.length ||
            !written.every((byte, index) => byte === bytes[index])
          ) {            throw new Error('The image could not be verified after writing to the active Vault.');
          }
        }
      } catch (error) {
        if (wrote && deps.asset && typeof deps.asset.delete === 'function') {
          try {
            await deps.asset.delete(candidate);
          } catch {
            // Preserve the primary verification/write error.
          }
        }
        throw error;
      }
      return candidate;
    } catch (error) {
      // A genuine exclusive create reports a benign collision: try next suffix.
      if (isAssetPathCollisionError(error)) continue;
      throw error;
    } finally {
      releaseAssetPath(candidate);
    }
  }
  throw new Error('Could not find a free image file name.');
}

/**
 * Resolves a collision-safe vault Asset path WITHOUT writing: the fixed name
 * when free, otherwise a deterministic ` (n)` suffix. NEVER returns the path
 * of an existing asset, so a later write cannot overwrite user data. Throws
 * when the asset boundary is unavailable or no free name exists.
 *
 * NOTE: this is a PROBE only. It does not reserve the returned path, so callers
 * that go on to create the asset MUST use `saveImageToVaultAssetsCollisionSafe`
 * (which allocates and creates under the shared reservation) instead of a
 * probe-then-write sequence.
 */
export async function resolveCollisionSafeAssetPath(
  deps: SaveImageDeps,
  recipeTitle: string,
  ext: string
): Promise<string> {
  const safeTitle = sanitizeVaultAssetTitle(recipeTitle);
  for (let attempt = 0; attempt <= MAX_VAULT_ASSET_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = collisionCandidate(safeTitle, ext, attempt);
    if (!(await assetPathExists(deps, candidate))) return candidate;
    if (attempt === MAX_VAULT_ASSET_COLLISION_ATTEMPTS) {
      throw new Error('Could not find a free image file name.');
    }
  }
  throw new Error('Could not find a free image file name.');
}

/**
 * Protects recipe persistence: a Vault-local image reference is valid only if
 * the asset exists in the DESTINATION session's AssetAdapter. Remote/data
 * references remain allowed under existing policy. Blob URLs are rendering
 * handles, never durable references: scope-owned, temporary-preview and unknown
 * blobs are all rejected until explicitly materialized into the destination
 * Vault through the authorized asset-write path.
 */
export interface AssetReferenceValidationDeps {
  asset?: AssetAdapter;
  folderHandle?: any;
  assetScope?: BlobOwnerScope | null;
}

export async function validateVaultAssetReference(
  deps: AssetReferenceValidationDeps,
  imageRef?: string,
  options?: { alreadyDecoded?: boolean }
): Promise<{ ok: boolean; reason?: string; kind?: string }> {
  if (!imageRef || typeof imageRef !== 'string') return { ok: true };
  const clean = cleanImageReference(imageRef, { decode: !options?.alreadyDecoded });
  if (!clean || clean === 'undefined' || clean === 'null') {
    return { ok: false, reason: 'The image reference is empty or invalid.' };
  }
  const classified = classifyAssetReference(clean, deps.assetScope ?? null);
  if (classified.kind === 'scope-owned-blob' || classified.kind === 'temporary-preview-blob') {
    return {
      ok: false,
      kind: classified.kind,
      reason: 'This image is a temporary preview, not a saved Vault asset. Save the image to the active Vault first, then save the recipe.',
    };
  }
  if (classified.kind === 'unknown-blob') {
    return {
      ok: false,
      kind: classified.kind,
      reason: 'This image preview is not owned by the active Vault. It cannot be saved as a recipe reference. Save the image to the active Vault first.',
    };
  }
  if (!isPersistableAssetReference(classified.kind)) {
    return {
      ok: false,
      kind: classified.kind,
      reason:
        classified.kind === 'malformed'
          ? 'This image reference is malformed or uses an unsupported scheme. Use a Vault-local asset path or a supported http(s)/data image.'
          : 'This image reference cannot be persisted. Use a Vault-local asset path or a supported remote image.',
    };
  }
  if (classified.kind !== 'vault-local') {
    return { ok: true, kind: classified.kind };
  }

  // Vault-relative identity must not contain empty, current-directory or parent
  // traversal segments. Reject before the adapter is asked to resolve it.
  const segments = clean.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return {
      ok: false,
      kind: 'malformed',
      reason: 'This image reference contains an unsafe Vault path. The recipe was not saved.',
    };
  }

  // Only the destination adapter can prove the asset exists in B. Without that
  // boundary (legacy/test composition), do not invent a cross-session verdict.
  if (!deps.asset || typeof deps.asset.exists !== 'function') return { ok: true, kind: classified.kind };
  try {
    const exists = await deps.asset.exists(clean);
    if (!exists) {
      return {
        ok: false,
        kind: classified.kind,
        reason: 'This image is not present in the active Vault. It may belong to a different Vault. Choose an image from this Vault or remove the reference.',
      };
    }
  } catch {
    return {
      ok: false,
      kind: classified.kind,
      reason: 'The active Vault could not verify this image reference. The recipe was not saved.',
    };
  }
  return { ok: true, kind: classified.kind };
}

/**
 * Saves an image into the connected vault's Assets folder through the injected
 * AssetAdapter (preferred) or the legacy folderHandle path (fallback), then
 * registers it in the local object-URL cache. The binary downloader is injected,
 * so this shared module NEVER imports a browser/platform module.
 *
 * NOTE: this fixed-name writer may overwrite an existing asset. Deferred
 * preview Saves MUST use `saveImageToVaultAssetsCollisionSafe` instead.
 */
export async function saveImageToVaultAssets(
  deps: SaveImageDeps,
  recipeTitle: string,
  source: string | Blob,
  preferredExtension?: string
): Promise<{ success: boolean; relativePath: string; blobUrl?: string; error?: string }> {
  try {
    const { bytes, contentType } = await resolveImageBytes(source, deps);
    const ext = imageExtension(preferredExtension, contentType);

    const safeTitle = recipeTitle.replace(/[\/\\?%*:|"<>]/g, '-').trim() || 'Recipe Photo';
    const fileName = `${safeTitle}.${ext}`;
    const relativePath = `Assets/${fileName}`;

    // Preferred: the application binary storage boundary.
    if (deps.asset) {
      await deps.asset.write(relativePath, bytes, contentType);
    } else if (deps.folderHandle && typeof deps.folderHandle.getDirectoryHandle === 'function') {
      // Legacy browser FSA write (preserve existing 'Assets'/'assets' preference).
      let assetsDir: any;
      try {
        assetsDir = await deps.folderHandle.getDirectoryHandle('Assets', { create: true });
      } catch (e) {
        assetsDir = await deps.folderHandle.getDirectoryHandle('assets', { create: true });
      }
      const fileHandle = await assetsDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(bytesToBlob(bytes, contentType));
      await writable.close();
    }

    // Browser rendering cache is owned by the EXACT originating session scope.
    const blob = bytesToBlob(bytes, contentType);
    const registered = deps.assetScope?.registerAsset(relativePath, blob);
    return { success: true, relativePath, blobUrl: registered?.blobUrl };
  } catch (err: any) {
    console.error('Failed to save image to vault Assets folder:', err);
    return {
      success: false,
      relativePath: typeof source === 'string' ? source : '',
      error: err?.message || 'Could not save image to Assets folder.',
    };
  }
}

/**
 * Collision-safe deferred-preview writer (B1). Allocates a FREE asset path AND
 * creates it atomically under the shared module-level reservation (never
 * overwriting an existing vault asset), and reports `createdNew: true` ONLY
 * when this call created the asset — the transaction-ownership proof a rollback
 * needs. Independent Recipe Editor instances therefore cannot both observe the
 * same free path and overwrite one another: a waiting transaction observes the
 * claim and selects the next deterministic ` (n)` suffix. A pre-existing user
 * asset is never modified, and rollback MUST delete only a path with
 * `createdNew`. Used identically for AI-generated and selected representative
 * images. See `createCollisionSafeAsset` for the precise atomicity boundary.
 */
export async function saveImageToVaultAssetsCollisionSafe(
  deps: SaveImageDeps,
  recipeTitle: string,
  source: string | Blob,
  preferredExtension?: string
): Promise<{ success: boolean; relativePath: string; createdNew: boolean; blobUrl?: string; error?: string }> {
  try {
    const { bytes, contentType } = await resolveImageBytes(source, deps);
    const ext = imageExtension(preferredExtension, contentType);
    const safeTitle = sanitizeVaultAssetTitle(recipeTitle);
    // Allocate AND create atomically under the shared reservation: the chosen
    // path is claimed before the existence recheck and held through the write.
    const relativePath = await createCollisionSafeAsset(deps, safeTitle, ext, bytes, contentType);

    // Browser rendering cache is owned by the EXACT originating session scope.
    const blob = bytesToBlob(bytes, contentType);
    const registered = deps.assetScope?.registerAsset(relativePath, blob);
    return { success: true, relativePath, createdNew: true, blobUrl: registered?.blobUrl };
  } catch (err: any) {
    console.error('Failed to save image to vault Assets folder:', err);
    return {
      success: false,
      relativePath: typeof source === 'string' ? source : '',
      createdNew: false,
      error: err?.message || 'Could not save image to Assets folder.',
    };
  }
}
