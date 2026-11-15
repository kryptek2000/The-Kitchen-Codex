import { ObsidianRecipe, MealPlanDay, ShoppingCategoryGroup, VaultNote } from '../types';
import {
  serializeRecipeToObsidianMarkdown,
  serializeMealPlanToMarkdown,
  serializeShoppingListToMarkdown,
} from './markdownParser';
import {
  isImageFile,
  saveImageToVaultAssets,
  scanVaultAssetsFromHandle,
  type VaultAssetScope,
} from './vaultAssets';
import { classifyVaultMarkdown } from '../core/vaultClassification';
import { toVaultRelativePath } from '../core/vaultPath';

export { saveImageToVaultAssets, scanVaultAssetsFromHandle };

const IDB_NAME = 'ObsidianRecipeVaultDB';
const IDB_STORE = 'vault_handles';
const IDB_KEY = 'active_vault_dir_handle';

/**
 * Checks if Native File System Access API is supported
 */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * Helper to open IndexedDB
 */
function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported'));
    }
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Monotonic epoch for the ONE persisted Vault handle. Every explicit clear
 * advances it, so an older save that opens IndexedDB after the clear cannot
 * resurrect the handle it was meant to replace.
 */
let handlePersistenceEpoch = 0;
let handlePersistenceSequence = 0;
let latestHandleSaveSequence = 0;
let latestHandleClearSequence = 0;

/**
 * Persists the directory handle in IndexedDB.
 *
 * Returns true only when the write transaction completed. Sequence checks after
 * IndexedDB opens ensure an older save/save-clear pair cannot win merely
 * because its open resolved later. A caller that has superseded this save also
 * prevents the put.
 */
export async function saveDirectoryHandleToIDB(
  handle: any,
  options?: { readonly shouldPersist?: () => boolean }
): Promise<boolean> {
  const epochAtStart = handlePersistenceEpoch;
  const saveSequence = ++handlePersistenceSequence;
  latestHandleSaveSequence = saveSequence;
  try {
    const db = await openIDB();
    if (epochAtStart !== handlePersistenceEpoch) return false;
    if (latestHandleClearSequence > saveSequence) return false;
    if (latestHandleSaveSequence > saveSequence) return false;
    if (options?.shouldPersist && !options.shouldPersist()) return false;
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
    return await new Promise<boolean>((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch (err) {
    console.warn('Could not save directory handle to IndexedDB:', err);
    return false;
  }
}

/**
 * Retrieves the persisted directory handle from IndexedDB
 */
export async function getDirectoryHandleFromIDB(): Promise<any | null> {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('Could not read directory handle from IndexedDB:', err);
    return null;
  }
}

/**
 * Clears the persisted directory handle and invalidates every save that began
 * before this clear. Returns true only when the delete transaction completed;
 * callers must not claim the previous authorization was forgotten on false.
 */
export async function clearDirectoryHandleFromIDB(): Promise<boolean> {
  handlePersistenceEpoch += 1;
  const clearSequence = ++handlePersistenceSequence;
  latestHandleClearSequence = clearSequence;
  try {
    const db = await openIDB();
    // A newer save or clear was requested while IndexedDB was opening. The
    // newer operation owns the persisted handle; this older clear must not
    // delete it.
    if (latestHandleSaveSequence > clearSequence) return false;
    if (latestHandleClearSequence > clearSequence) return false;
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    return await new Promise<boolean>((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch (err) {
    console.warn('Could not delete handle from IndexedDB:', err);
    return false;
  }
}

/** Test-only: reads the epoch without changing persistence state. */
export function getVaultHandlePersistenceEpochForTests(): number {
  return handlePersistenceEpoch;
}

export interface VaultScanResult {
  recipes: ObsidianRecipe[];
  notes?: VaultNote[];
  mealPlan?: MealPlanDay[];
  shoppingList?: ShoppingCategoryGroup[];
  folderHandle?: any;
  folderName?: string;
}

/**
 * Scans an active FileSystemDirectoryHandle on disk for recipes, meal plans, and shopping lists
 */
export async function scanVaultDirectory(
  dirHandle: any,
  assetScope?: VaultAssetScope
): Promise<VaultScanResult> {
  const recipes: ObsidianRecipe[] = [];
  const notes: VaultNote[] = [];
  let foundMealPlan: MealPlanDay[] | undefined = undefined;
  let foundShoppingList: ShoppingCategoryGroup[] | undefined = undefined;

  async function scanDirectory(handle: any, currentPath: string = '') {
    // @ts-ignore
    for await (const entry of handle.values()) {
      const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      if (entry.kind === 'file') {
        if (entry.name.endsWith('.md')) {
          try {
            const file = await entry.getFile();
            const text = await file.text();

            const parsed = classifyVaultMarkdown({
              path: entryPath,
              name: entry.name,
              markdown: text,
            });
            if (parsed.kind === 'recipe') {
              parsed.recipe.fileHandle = entry;
              recipes.push(parsed.recipe);
            } else if (parsed.kind === 'note') {
              parsed.note.fileHandle = entry;
              notes.push(parsed.note);
            } else if (parsed.kind === 'mealPlan') {
              foundMealPlan = parsed.mealPlan;
            } else if (parsed.kind === 'shoppingList') {
              foundShoppingList = parsed.shoppingList;
            }
          } catch (e) {
            console.warn('Failed to parse file:', entry.name, e);
          }
        } else if (isImageFile(entry.name)) {
          try {
            const file = await entry.getFile();
            if (assetScope?.isAccepting()) assetScope.registerAsset(entryPath, file);
          } catch (err) {
            console.warn('Failed to index vault image asset:', entry.name, err);
          }
        }
      } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
        await scanDirectory(entry, entryPath);
      }
    }
  }

  await scanDirectory(dirHandle, '');

  return {
    recipes,
    notes,
    mealPlan: foundMealPlan,
    shoppingList: foundShoppingList,
    folderHandle: dirHandle,
    folderName: dirHandle.name,
  };
}

/**
 * Prompts user to pick their Obsidian Vault directory. It returns ONLY the picked
 * handle; it does NOT persist it as the active vault. Persisting the handle as the
 * active vault is the application's job AFTER a successful accepted scan.
 *
 * Phase 4C3C: this returns ONLY the authoritative directory handle. Markdown
 * hydration is no longer performed here — the connect-time Markdown scan (and
 * the separate asset pass) is owned by the adapter-backed bootstrap edge
 * (`loadVaultFromHandle` in App.tsx), so the connected runtime has a single
 * Markdown scanner and no second non-adapter scanner on initial connect.
 */
export async function pickVaultDirectory(): Promise<{ folderHandle: any }> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Please use the Folder Upload button instead.');
  }

  // @ts-ignore
  const dirHandle = await window.showDirectoryPicker({
    mode: 'readwrite',
    startIn: 'documents',
  });

  return { folderHandle: dirHandle };
}

/**
 * Saves a recipe directly to the local Obsidian vault fileHandle or folderHandle
 */
export async function saveRecipeToVaultFile(
  recipe: ObsidianRecipe,
  folderHandle?: any
): Promise<boolean> {
  const markdown = serializeRecipeToObsidianMarkdown(recipe);

  // If we already have a direct file handle
  if (recipe.fileHandle && typeof recipe.fileHandle.createWritable === 'function') {
    try {
      const writable = await recipe.fileHandle.createWritable();
      await writable.write(markdown);
      await writable.close();
      return true;
    } catch (e) {
      console.warn('Direct file handle write failed, trying folder handle:', e);
    }
  }

  // If we have a folder handle, create/overwrite file
  if (folderHandle && typeof folderHandle.getFileHandle === 'function') {
    try {
      const safeFileName = recipe.fileName.endsWith('.md')
        ? recipe.fileName
        : `${recipe.title.replace(/[\/\\?%*:|"<>]/g, '-')}.md`;
      const fileHandle = await folderHandle.getFileHandle(safeFileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(markdown);
      await writable.close();
      recipe.fileHandle = fileHandle;
      return true;
    } catch (e) {
      console.error('Folder handle write failed:', e);
    }
  }

  // Fallback: Download file to user disk
  downloadMarkdownFile(recipe.fileName || `${recipe.title}.md`, markdown);
  return true;
}

/**
 * Deletes a recipe file from the vault disk
 */
export async function deleteRecipeFromVault(
  recipe: ObsidianRecipe,
  folderHandle?: any
): Promise<boolean> {
  if (folderHandle && typeof folderHandle.removeEntry === 'function' && recipe.fileName) {
    try {
      await folderHandle.removeEntry(recipe.fileName);
      return true;
    } catch (e) {
      console.warn('Could not remove file directly with removeEntry:', e);
    }
  }
  return false;
}

/**
 * Saves the Weekly Meal Plan note directly to disk in the vault
 */
export async function saveMealPlanToVault(
  mealPlan: MealPlanDay[],
  folderHandle?: any
): Promise<boolean> {
  const markdown = serializeMealPlanToMarkdown(mealPlan);
  const fileName = 'Meal Plan.md';

  if (folderHandle && typeof folderHandle.getFileHandle === 'function') {
    try {
      const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(markdown);
      await writable.close();
      return true;
    } catch (e) {
      console.warn('Failed to write Meal Plan.md to vault handle:', e);
    }
  }

  return false;
}

/**
 * Saves the Grocery Shopping List note directly to disk in the vault
 */
export async function saveShoppingListToVault(
  groups: ShoppingCategoryGroup[],
  folderHandle?: any
): Promise<boolean> {
  const markdown = serializeShoppingListToMarkdown(groups);
  const fileName = 'Shopping List.md';

  if (folderHandle && typeof folderHandle.getFileHandle === 'function') {
    try {
      const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(markdown);
      await writable.close();
      return true;
    } catch (e) {
      console.warn('Failed to write Shopping List.md to vault handle:', e);
    }
  }

  return false;
}

/**
 * Downloads a markdown file to the user's computer
 */
export function downloadMarkdownFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Reads uploaded files from <input type="file" webkitdirectory /> or File[]
 */
export async function parseUploadedFileList(
  fileList: FileList | File[],
  assetScope?: VaultAssetScope
): Promise<{
  recipes: ObsidianRecipe[];
  notes?: VaultNote[];
  mealPlan?: MealPlanDay[];
  shoppingList?: ShoppingCategoryGroup[];
}> {
  const recipes: ObsidianRecipe[] = [];
  const notes: VaultNote[] = [];
  let foundMealPlan: MealPlanDay[] | undefined = undefined;
  let foundShoppingList: ShoppingCategoryGroup[] | undefined = undefined;

  const count = 'length' in fileList ? fileList.length : 0;
  for (let i = 0; i < count; i++) {
    const file = fileList[i];
    const rawPath = (file as any).webkitRelativePath || file.name;
    // Normalize every ingested path to ONE vault-root-relative convention. The
    // selected folder name (first segment of `webkitRelativePath`) is the known
    // ingestion root and is stripped exactly once; a bare file name stays root-relative.
    const rootName = rawPath.includes('/') ? rawPath.split('/')[0] : undefined;
    const relativePath = toVaultRelativePath(rawPath, rootName);
    if (file.name.endsWith('.md') || file.name.endsWith('.markdown')) {
      if (!relativePath) continue;
      const text = await file.text();
      const parsed = classifyVaultMarkdown({
        path: relativePath,
        name: file.name,
        markdown: text,
      });
      if (parsed.kind === 'recipe') {
        recipes.push(parsed.recipe);
      } else if (parsed.kind === 'note') {
        notes.push(parsed.note);
      } else if (parsed.kind === 'mealPlan') {
        foundMealPlan = parsed.mealPlan;
      } else if (parsed.kind === 'shoppingList') {
        foundShoppingList = parsed.shoppingList;
      }
    } else if (isImageFile(file.name)) {
      if (!relativePath) continue;
      try {
        if (assetScope?.isAccepting()) assetScope.registerAsset(relativePath, file);
      } catch (err) {
        console.warn('Failed to index uploaded image file:', file.name, err);
      }
    }
  }
  return { recipes, notes, mealPlan: foundMealPlan, shoppingList: foundShoppingList };
}

/**
 * Parses files and folders from HTML5 drag and drop DataTransfer
 */
export async function parseDroppedFilesAndFolders(
  dataTransfer: DataTransfer,
  assetScope?: VaultAssetScope
): Promise<{
  recipes: ObsidianRecipe[];
  notes?: VaultNote[];
  mealPlan?: MealPlanDay[];
  shoppingList?: ShoppingCategoryGroup[];
}> {
  const recipes: ObsidianRecipe[] = [];
  const notes: VaultNote[] = [];
  let foundMealPlan: MealPlanDay[] | undefined = undefined;
  let foundShoppingList: ShoppingCategoryGroup[] | undefined = undefined;

  // Helper to read FileEntry
  async function readFileEntry(
    fileEntry: any,
    path: string = '',
    rootName?: string
  ): Promise<void> {
    return new Promise((resolve) => {
      fileEntry.file(
        async (file: File) => {
          const rawPath = path ? `${path}/${file.name}` : file.name;
          // Normalize to ONE vault-root-relative convention. The known dropped
          // folder root is passed explicitly so a legitimate first-level recipe
          // directory (e.g. `Recipes/Italian/...`) is never accidentally stripped
          // unless it IS the ingestion root.
          const filePath = toVaultRelativePath(rawPath, rootName);
          if (!filePath) {
            resolve();
            return;
          }
          if (file.name.endsWith('.md') || file.name.endsWith('.markdown')) {
            try {
              const text = await file.text();
              const parsed = classifyVaultMarkdown({
                path: filePath,
                name: file.name,
                markdown: text,
              });
              if (parsed.kind === 'recipe') {
                recipes.push(parsed.recipe);
              } else if (parsed.kind === 'note') {
                notes.push(parsed.note);
              } else if (parsed.kind === 'mealPlan') {
                foundMealPlan = parsed.mealPlan;
              } else if (parsed.kind === 'shoppingList') {
                foundShoppingList = parsed.shoppingList;
              }
            } catch (err) {
              console.warn('Failed to parse dropped file:', file.name, err);
            }
          } else if (isImageFile(file.name)) {
            try {
              if (assetScope?.isAccepting()) assetScope.registerAsset(filePath, file);
            } catch (err) {
              console.warn('Failed to index dropped image file:', file.name, err);
            }
          }
          resolve();
        },
        () => resolve()
      );
    });
  }

  // Helper to read DirectoryEntry
  async function readDirectoryEntry(
    dirEntry: any,
    path: string = '',
    rootName?: string
  ): Promise<void> {
    const dirReader = dirEntry.createReader();
    const currentPath = path ? `${path}/${dirEntry.name}` : dirEntry.name;
    const effectiveRoot = rootName ?? (path ? (path as string).split('/')[0] || dirEntry.name : dirEntry.name);

    return new Promise((resolve) => {
      const readEntries = () => {
        dirReader.readEntries(async (entries: any[]) => {
          if (!entries.length) {
            resolve();
            return;
          }
          for (const entry of entries) {
            if (entry.isFile) {
              await readFileEntry(entry, currentPath, effectiveRoot);
            } else if (entry.isDirectory && !entry.name.startsWith('.')) {
              await readDirectoryEntry(entry, currentPath, effectiveRoot);
            }
          }
          readEntries();
        }, () => resolve());
      };
      readEntries();
    });
  }

  // Check items with webkitGetAsEntry
  const items = dataTransfer.items;
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item.webkitGetAsEntry();
      if (entry) {
        if (entry.isFile) {
          await readFileEntry(entry);
        } else if (entry.isDirectory) {
          await readDirectoryEntry(entry);
        }
      }
    }
  } else if (dataTransfer.files && dataTransfer.files.length > 0) {
    const res = await parseUploadedFileList(dataTransfer.files, assetScope);
    recipes.push(...res.recipes);
    if (res.notes) notes.push(...res.notes);
    if (res.mealPlan) foundMealPlan = res.mealPlan;
    if (res.shoppingList) foundShoppingList = res.shoppingList;
  }

  return { recipes, notes, mealPlan: foundMealPlan, shoppingList: foundShoppingList };
}

