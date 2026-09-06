/**
 * The Kitchen Codex — Browser Platform (Phase 4C2).
 *
 * Concrete browser/platform integrations implementing the application adapter
 * contracts. Contains ONLY browser File System Access implementation detail.
 *
 * Dependency direction: platform/browser -> application/adapters (contracts).
 * The application and core layers must never import this platform module.
 */
export { BrowserFsaVaultAdapter } from './BrowserFsaVaultAdapter';
export type {
  FsaEntryLike,
  FsaFileHandleLike,
  FsaDirectoryHandleLike,
  FsaWritableLike,
} from './BrowserFsaVaultAdapter';
