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
  file?: File; // File object
  lastModified?: number;
}

/**
 * Strips wikilink brackets, quotes, query parameters, leading slashes, and decodes URI strings.
 */
export function cleanImageReference(ref?: string): string {
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

  // Decode URI components (e.g. %20 -> space)
  try {
    clean = decodeURIComponent(clean);
  } catch (e) {
    // Ignore URI decode errors on weird characters
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

// In-Memory Vault Assets Registry
class VaultAssetRegistry {
  private keyMap = new Map<string, VaultAssetItem>();
  private itemsList: VaultAssetItem[] = [];
  private listeners = new Set<() => void>();

  public subscribe(listener: () => void): () => void {
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

  /**
   * Registers a vault asset file or handle under multiple normalized keys
   */
  public registerAsset(
    relativePath: string,
    fileOrHandle: File | any,
    blobUrl?: string
  ): VaultAssetItem {
    const cleanPath = cleanImageReference(relativePath);
    const fileName = cleanPath.split('/').pop() || cleanPath;

    let existing = this.itemsList.find(
      (item) => item.path === cleanPath || item.fileName === fileName
    );

    let effectiveBlobUrl = blobUrl;
    let fileObj: File | undefined;
    let fileHandle: any | undefined;

    if (fileOrHandle instanceof File) {
      fileObj = fileOrHandle;
      if (!effectiveBlobUrl && typeof URL !== 'undefined') {
        try {
          effectiveBlobUrl = URL.createObjectURL(fileOrHandle);
        } catch (e) {}
      }
    } else if (fileOrHandle && typeof fileOrHandle.getFile === 'function') {
      fileHandle = fileOrHandle;
    }

    if (existing) {
      if (fileObj) existing.file = fileObj;
      if (fileHandle) existing.fileHandle = fileHandle;
      if (effectiveBlobUrl) existing.blobUrl = effectiveBlobUrl;
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

    // Index under multiple lookup keys for ultra-resilient matching
    const keysToIndex = new Set<string>();

    const normPath = normalizeAssetKey(cleanPath);
    const normFile = normalizeAssetKey(fileName);
    const nameWithoutExt = normFile.replace(/\.[^/.]+$/, '');

    keysToIndex.add(normPath);
    keysToIndex.add(normFile);
    keysToIndex.add(nameWithoutExt);

    // If starts with assets/ or Assets/, also index without prefix
    if (normPath.startsWith('assets/')) {
      keysToIndex.add(normPath.substring(7));
    } else {
      keysToIndex.add(`assets/${normPath}`);
      keysToIndex.add(`assets/${normFile}`);
    }

    // Attachments variants
    if (normPath.startsWith('attachments/')) {
      keysToIndex.add(normPath.substring(12));
    } else {
      keysToIndex.add(`attachments/${normFile}`);
    }

    for (const k of keysToIndex) {
      if (k) this.keyMap.set(k, existing);
    }

    this.notify();
    return existing;
  }

  /**
   * Fast synchronous lookup in the cache
   */
  public get(ref?: string): VaultAssetItem | undefined {
    if (!ref) return undefined;
    const key = normalizeAssetKey(ref);
    return this.keyMap.get(key);
  }

  /**
   * Returns all indexed asset items
   */
  public getAll(): VaultAssetItem[] {
    return [...this.itemsList];
  }

  /**
   * Clears the registry (and revokes existing object URLs to prevent leaks)
   */
  public clear(): void {
    for (const item of this.itemsList) {
      if (item.blobUrl && typeof URL !== 'undefined') {
        try {
          URL.revokeObjectURL(item.blobUrl);
        } catch (e) {}
      }
    }
    this.keyMap.clear();
    this.itemsList = [];
    this.notify();
  }
}

export const vaultAssets = new VaultAssetRegistry();

/**
 * Synchronously resolves an image path or reference against the vault asset cache.
 * Returns the Blob Object URL if cached, or undefined/null.
 */
export function syncResolveVaultAssetUrl(imageRef?: string): string | null {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const trimmed = imageRef.trim();

  // If already an absolute web URL or data URL, return it directly
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:')
  ) {
    return trimmed;
  }

  const asset = vaultAssets.get(trimmed);
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
  folderHandle?: any
): Promise<string | null> {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const cleanRef = cleanImageReference(imageRef);

  if (
    cleanRef.startsWith('http://') ||
    cleanRef.startsWith('https://') ||
    cleanRef.startsWith('data:') ||
    cleanRef.startsWith('blob:')
  ) {
    return cleanRef;
  }

  // 1. Check in-memory registry
  let asset = vaultAssets.get(cleanRef);
  if (asset) {
    if (asset.blobUrl) return asset.blobUrl;
    if (asset.file) {
      asset.blobUrl = URL.createObjectURL(asset.file);
      return asset.blobUrl;
    }
    if (asset.fileHandle && typeof asset.fileHandle.getFile === 'function') {
      try {
        const file = await asset.fileHandle.getFile();
        asset.file = file;
        asset.blobUrl = URL.createObjectURL(file);
        return asset.blobUrl;
      } catch (err) {
        console.warn('Could not read file from handle:', err);
      }
    }
  }

  // 2. If not yet in registry, but we have a directory handle, look for the file on disk
  if (folderHandle && typeof folderHandle.getFileHandle === 'function') {
    const fileName = cleanRef.split('/').pop() || cleanRef;

    // Candidate directories to search: Assets, assets, attachments, Attachments, images, root
    const searchDirs = ['Assets', 'assets', 'attachments', 'Attachments', 'images', ''];

    for (const dirName of searchDirs) {
      try {
        let dir = folderHandle;
        if (dirName) {
          dir = await folderHandle.getDirectoryHandle(dirName, { create: false });
        }
        const fileHandle = await dir.getFileHandle(fileName, { create: false });
        const file = await fileHandle.getFile();
        const blobUrl = URL.createObjectURL(file);
        const relPath = dirName ? `${dirName}/${fileName}` : fileName;
        vaultAssets.registerAsset(relPath, fileHandle, blobUrl);
        return blobUrl;
      } catch (e) {
        // Continue searching other candidate directories
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
  currentPath: string = ''
): Promise<VaultAssetItem[]> {
  const discovered: VaultAssetItem[] = [];

  async function walk(handle: any, path: string) {
    try {
      // @ts-ignore
      for await (const entry of handle.values()) {
        const entryPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === 'file' && isImageFile(entry.name)) {
          try {
            const file = await entry.getFile();
            const blobUrl = URL.createObjectURL(file);
            const item = vaultAssets.registerAsset(entryPath, entry, blobUrl);
            item.file = file;
            discovered.push(item);
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
    if (trimmed.startsWith('data:')) {
      const { bytes, contentType } = dataUrlToBytes(trimmed);
      return { bytes, contentType };
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
async function createCollisionSafeAsset(
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
      await writeAssetAtPath(deps, candidate, bytes, contentType);
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

    // Browser rendering cache: bytes -> Blob -> object URL.
    const blobUrl = URL.createObjectURL(bytesToBlob(bytes, contentType));
    vaultAssets.registerAsset(relativePath, bytesToBlob(bytes, contentType), blobUrl);

    return { success: true, relativePath, blobUrl };
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

    // Browser rendering cache: bytes -> Blob -> object URL.
    const blobUrl = URL.createObjectURL(bytesToBlob(bytes, contentType));
    vaultAssets.registerAsset(relativePath, bytesToBlob(bytes, contentType), blobUrl);

    return { success: true, relativePath, createdNew: true, blobUrl };
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
