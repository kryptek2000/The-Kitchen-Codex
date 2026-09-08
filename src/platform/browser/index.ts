/**
 * The Kitchen Codex — Browser Platform (Phase 4C2 / 4D2A).
 *
 * Concrete browser/platform integrations implementing the application adapter
 * contracts. Contains browser File System Access implementation detail, the
 * localStorage-backed settings store, and the app-backend fetch transport.
 *
 * Dependency direction: platform/browser -> application/adapters (contracts).
 * The application and core layers must never import this platform module.
 */
export { BrowserFsaVaultAdapter } from './BrowserFsaVaultAdapter';
export { BrowserSettingsAdapter } from './BrowserSettingsAdapter';
export type { StorageLike } from './BrowserSettingsAdapter';
export { BrowserNetworkAdapter, NetworkRequestError } from './BrowserNetworkAdapter';
export type { FetcherLike } from './BrowserNetworkAdapter';
export { createBrowserSettingsAdapter, createBrowserNetworkAdapter, createBrowserVaultAdapter } from './createBrowserAppServices';
export { downloadImageViaBackend, BackendImageDownloadError, BACKEND_IMAGE_DOWNLOAD_ENDPOINT } from './downloadImageViaBackend';
export type { BackendImageResult, DownloadImageOptions, BackendFetchLike, BackendResponseLike } from './downloadImageViaBackend';
export type {
  FsaEntryLike,
  FsaFileHandleLike,
  FsaDirectoryHandleLike,
  FsaWritableLike,
} from './BrowserFsaVaultAdapter';
