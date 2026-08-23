/**
 * Obsidian Vault Local Assets Manager & Image Resolver
 * Provides comprehensive handling for local vault images (e.g. Assets/Breakfast Burritos.jpg,
 * [[Assets/Breakfast Burritos.jpg]], attachments/, etc.) and supports downloading web images
 * directly into the Obsidian vault's Assets/ folder.
 */

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
 * Downloads an external image safely via our server-side SSRF-protected proxy
 */
export async function downloadImageViaProxy(
  imageUrl: string
): Promise<{ blob: Blob; contentType: string }> {
  const trimmed = imageUrl.trim();

  // If it's a data URL, convert to Blob directly
  if (trimmed.startsWith('data:')) {
    const res = await fetch(trimmed);
    const blob = await res.blob();
    return { blob, contentType: blob.type || 'image/jpeg' };
  }

  // Try server proxy download first to bypass CORS and ensure safety
  try {
    const res = await fetch('/api/download-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: trimmed }),
    });

    if (res.ok) {
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const blob = await res.blob();
      return { blob, contentType };
    }
  } catch (proxyErr) {
    console.warn('Server image download proxy error, attempting direct fetch:', proxyErr);
  }

  // Fallback to direct fetch (works if remote server has CORS open)
  const directRes = await fetch(trimmed, { mode: 'cors' });
  if (!directRes.ok) {
    throw new Error(`Failed to fetch image: HTTP ${directRes.status}`);
  }
  const contentType = directRes.headers.get('content-type') || 'image/jpeg';
  const blob = await directRes.blob();
  return { blob, contentType };
}

/**
 * Saves an image blob directly into the Obsidian vault's Assets/ folder
 * and registers it in the local asset cache.
 */
export async function saveImageToVaultAssets(
  folderHandle: any,
  recipeTitle: string,
  source: string | Blob,
  preferredExtension?: string
): Promise<{ success: boolean; relativePath: string; blobUrl?: string; error?: string }> {
  try {
    let blob: Blob;
    let contentType = 'image/jpeg';

    if (typeof source === 'string') {
      const downloaded = await downloadImageViaProxy(source);
      blob = downloaded.blob;
      contentType = downloaded.contentType;
    } else {
      blob = source;
      contentType = blob.type || 'image/jpeg';
    }

    // Determine extension from content-type or preferredExtension
    let ext = 'jpg';
    if (preferredExtension) {
      ext = preferredExtension.replace(/^\./, '').toLowerCase();
    } else if (contentType.includes('png')) {
      ext = 'png';
    } else if (contentType.includes('webp')) {
      ext = 'webp';
    } else if (contentType.includes('gif')) {
      ext = 'gif';
    } else if (contentType.includes('svg')) {
      ext = 'svg';
    } else if (contentType.includes('avif')) {
      ext = 'avif';
    }

    const safeTitle = recipeTitle.replace(/[\/\\?%*:|"<>]/g, '-').trim() || 'Recipe Photo';
    const fileName = `${safeTitle}.${ext}`;

    if (folderHandle && typeof folderHandle.getDirectoryHandle === 'function') {
      // Find or create Assets folder (preserve existing 'assets' or 'Assets')
      let assetsDir: any;
      try {
        assetsDir = await folderHandle.getDirectoryHandle('Assets', { create: true });
      } catch (e) {
        assetsDir = await folderHandle.getDirectoryHandle('assets', { create: true });
      }

      const fileHandle = await assetsDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      const blobUrl = URL.createObjectURL(blob);
      const relativePath = `Assets/${fileName}`;

      // Register immediately in our cache
      vaultAssets.registerAsset(relativePath, fileHandle, blobUrl);

      return {
        success: true,
        relativePath,
        blobUrl,
      };
    }

    // Fallback: create Blob URL and register even if direct directory handle is unavailable
    const blobUrl = URL.createObjectURL(blob);
    const relativePath = `Assets/${fileName}`;
    vaultAssets.registerAsset(relativePath, blob, blobUrl);

    return {
      success: true,
      relativePath,
      blobUrl,
    };
  } catch (err: any) {
    console.error('Failed to save image to vault Assets folder:', err);
    return {
      success: false,
      relativePath: typeof source === 'string' ? source : '',
      error: err?.message || 'Could not save image to Assets folder.',
    };
  }
}
