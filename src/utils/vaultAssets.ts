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

import type { AssetAdapter, RemoteImageDownloader } from '../application/adapters/AssetAdapter';

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

/**
 * Saves an image into the connected vault's Assets folder through the injected
 * AssetAdapter (preferred) or the legacy folderHandle path (fallback), then
 * registers it in the local object-URL cache. The binary downloader is injected,
 * so this shared module NEVER imports a browser/platform module.
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
