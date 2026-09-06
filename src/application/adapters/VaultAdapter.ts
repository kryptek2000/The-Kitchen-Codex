/**
 * The Kitchen Codex — VaultAdapter contract (Phase 4C1).
 *
 * Application-facing port for recipe/vault file access. It is deliberately
 * SCOPED TO CURRENT NEEDS: listing, reading, writing, deleting and checking
 * Markdown recipe/note files in the user's vault. It is implementation-agnostic
 * (no File System Access API, no Obsidian Vault API, no Node fs, no IndexedDB) —
 * concrete platform adapters (browser FSA / Obsidian / PWA storage) implement it
 * later.
 *
 * This is a CONTRACT ONLY. No concrete implementation exists in this phase.
 *
 * Out of scope (deferred, do not add here):
 *   - sync / CRDT / conflict engine / cloud / collaboration / permissions matrix
 *   - watch()/change-notification (not required by the first seam)
 *   - media/asset byte handling (image resolution + saving currently lives in the
 *     browser-specific `vaultAssets` registry and will be a separate AssetAdapter
 *     or a later VaultAdapter extension; not included here to keep the first seam
 *     small and avoid a god interface).
 */

/** A Markdown file discovered in the vault. */
export interface VaultMarkdownFile {
  /** Vault-relative path (e.g. "Recipes/Japanese/Tonkotsu Ramen.md"). */
  path: string;
  /** File name with extension (e.g. "Tonkotsu Ramen.md"). */
  name: string;
}

/**
 * The minimal vault-access port. All methods are Promise-based because cross-
 * platform implementations (browser File System Access API, Obsidian Vault API,
 * PWA storage) are inherently async.
 */
export interface VaultAdapter {
  /** Lists every Markdown file in the vault (recipes + notes). */
  listMarkdownFiles(): Promise<VaultMarkdownFile[]>;
  /** Reads the raw Markdown text of a vault file by path. */
  readText(path: string): Promise<string>;
  /** Writes raw Markdown text to a vault file, creating or overwriting it. */
  writeText(path: string, content: string): Promise<void>;
  /** Deletes a vault file by path. */
  delete(path: string): Promise<void>;
  /** Returns whether a vault file exists at the given path. */
  exists(path: string): Promise<boolean>;
}
