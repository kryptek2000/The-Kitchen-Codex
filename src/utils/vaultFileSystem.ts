import { ObsidianRecipe, MealPlanDay, ShoppingCategoryGroup, VaultNote } from '../types';
import {
  parseObsidianRecipeMarkdown,
  serializeRecipeToObsidianMarkdown,
  parseMealPlanFromMarkdown,
  serializeMealPlanToMarkdown,
  parseShoppingListFromMarkdown,
  serializeShoppingListToMarkdown,
  parseVaultNoteMarkdown,
} from './markdownParser';
import {
  vaultAssets,
  isImageFile,
  saveImageToVaultAssets,
  scanVaultAssetsFromHandle,
} from './vaultAssets';

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
 * Persists the directory handle in IndexedDB
 */
export async function saveDirectoryHandleToIDB(handle: any): Promise<void> {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Could not save directory handle to IndexedDB:', err);
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
 * Clears directory handle from IndexedDB
 */
export async function clearDirectoryHandleFromIDB(): Promise<void> {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (err) {
    console.warn('Could not delete handle from IndexedDB:', err);
  }
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
export async function scanVaultDirectory(dirHandle: any): Promise<VaultScanResult> {
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

            const lowerName = entry.name.toLowerCase();
            if (lowerName === 'meal plan.md' || lowerName === 'meal-plan.md' || lowerName === 'mealplan.md') {
              foundMealPlan = parseMealPlanFromMarkdown(text);
            } else if (
              lowerName === 'shopping list.md' ||
              lowerName === 'shopping-list.md' ||
              lowerName === 'grocery list.md' ||
              lowerName === 'shoppinglist.md'
            ) {
              foundShoppingList = parseShoppingListFromMarkdown(text);
            } else {
              const parsed = parseObsidianRecipeMarkdown(text, entry.name, entryPath);
              parsed.fileHandle = entry;
              // Check if it's a recipe or general reference note
              if (parsed.ingredients.length > 0 || parsed.instructions.length > 0 || parsed.tags.some(t => t.toLowerCase().includes('recipe') || t.toLowerCase().includes('food'))) {
                recipes.push(parsed);
              } else {
                const genericNote = parseVaultNoteMarkdown(text, entry.name, entryPath);
                genericNote.fileHandle = entry;
                notes.push(genericNote);
              }
            }
          } catch (e) {
            console.warn('Failed to parse file:', entry.name, e);
          }
        } else if (isImageFile(entry.name)) {
          try {
            const file = await entry.getFile();
            const blobUrl = URL.createObjectURL(file);
            vaultAssets.registerAsset(entryPath, entry, blobUrl);
          } catch (err) {
            console.warn('Failed to index vault image asset:', entry.name, err);
          }
        }
      } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
        await scanDirectory(entry, entryPath);
      }
    }
  }

  await scanDirectory(dirHandle, dirHandle.name);

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
 * Prompts user to pick their Obsidian Vault directory
 */
export async function pickVaultDirectory(): Promise<VaultScanResult> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Please use the Folder Upload button instead.');
  }

  // @ts-ignore
  const dirHandle = await window.showDirectoryPicker({
    mode: 'readwrite',
    startIn: 'documents',
  });

  await saveDirectoryHandleToIDB(dirHandle);
  return await scanVaultDirectory(dirHandle);
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
export async function parseUploadedFileList(fileList: FileList | File[]): Promise<{
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
    const relativePath = (file as any).webkitRelativePath || file.name;
    if (file.name.endsWith('.md') || file.name.endsWith('.markdown')) {
      const text = await file.text();
      const lowerName = file.name.toLowerCase();

      if (lowerName === 'meal plan.md' || lowerName === 'meal-plan.md' || lowerName === 'mealplan.md') {
        foundMealPlan = parseMealPlanFromMarkdown(text);
      } else if (
        lowerName === 'shopping list.md' ||
        lowerName === 'shopping-list.md' ||
        lowerName === 'grocery list.md' ||
        lowerName === 'shoppinglist.md'
      ) {
        foundShoppingList = parseShoppingListFromMarkdown(text);
      } else {
        const parsed = parseObsidianRecipeMarkdown(text, file.name, relativePath);
        if (parsed.ingredients.length > 0 || parsed.instructions.length > 0 || parsed.tags.some(t => t.toLowerCase().includes('recipe') || t.toLowerCase().includes('food'))) {
          recipes.push(parsed);
        } else {
          notes.push(parseVaultNoteMarkdown(text, file.name, relativePath));
        }
      }
    } else if (isImageFile(file.name)) {
      try {
        const blobUrl = URL.createObjectURL(file);
        vaultAssets.registerAsset(relativePath, file, blobUrl);
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
export async function parseDroppedFilesAndFolders(dataTransfer: DataTransfer): Promise<{
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
  async function readFileEntry(fileEntry: any, path: string = ''): Promise<void> {
    return new Promise((resolve) => {
      fileEntry.file(
        async (file: File) => {
          const filePath = path ? `${path}/${file.name}` : file.name;
          if (file.name.endsWith('.md') || file.name.endsWith('.markdown')) {
            try {
              const text = await file.text();
              const lowerName = file.name.toLowerCase();
              if (lowerName === 'meal plan.md' || lowerName === 'meal-plan.md') {
                foundMealPlan = parseMealPlanFromMarkdown(text);
              } else if (lowerName === 'shopping list.md' || lowerName === 'shopping-list.md' || lowerName === 'grocery list.md') {
                foundShoppingList = parseShoppingListFromMarkdown(text);
              } else {
                const parsed = parseObsidianRecipeMarkdown(text, file.name, filePath);
                if (parsed.ingredients.length > 0 || parsed.instructions.length > 0 || parsed.tags.some(t => t.toLowerCase().includes('recipe') || t.toLowerCase().includes('food'))) {
                  recipes.push(parsed);
                } else {
                  notes.push(parseVaultNoteMarkdown(text, file.name, filePath));
                }
              }
            } catch (err) {
              console.warn('Failed to parse dropped file:', file.name, err);
            }
          } else if (isImageFile(file.name)) {
            try {
              const blobUrl = URL.createObjectURL(file);
              vaultAssets.registerAsset(filePath, file, blobUrl);
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
  async function readDirectoryEntry(dirEntry: any, path: string = ''): Promise<void> {
    const dirReader = dirEntry.createReader();
    const currentPath = path ? `${path}/${dirEntry.name}` : dirEntry.name;

    return new Promise((resolve) => {
      const readEntries = () => {
        dirReader.readEntries(async (entries: any[]) => {
          if (!entries.length) {
            resolve();
            return;
          }
          for (const entry of entries) {
            if (entry.isFile) {
              await readFileEntry(entry, currentPath);
            } else if (entry.isDirectory && !entry.name.startsWith('.')) {
              await readDirectoryEntry(entry, currentPath);
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
    const res = await parseUploadedFileList(dataTransfer.files);
    recipes.push(...res.recipes);
    if (res.notes) notes.push(...res.notes);
    if (res.mealPlan) foundMealPlan = res.mealPlan;
    if (res.shoppingList) foundShoppingList = res.shoppingList;
  }

  return { recipes, notes, mealPlan: foundMealPlan, shoppingList: foundShoppingList };
}

