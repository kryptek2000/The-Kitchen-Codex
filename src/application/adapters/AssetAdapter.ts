/**
 * The Kitchen Codex — AssetAdapter / Binary-Image Download Contracts (Phase 4D3D).
 *
 * APPLICATION-facing ports for asset-byte storage and for sourcing remote image
 * bytes. They establish the asset boundary that the browser/obsidian shells
 * implement, so shared utility/application code NEVER imports a concrete
 * platform asset implementation.
 *
 * PLATFORM-NEUTRAL TYPES ONLY:
 *   - bytes are `Uint8Array` (NOT the browser `Blob`, NOT a `File`,
 *     NOT an `ArrayBuffer`-typed platform value);
 *   - NO object URLs, NO `URL.createObjectURL`/`revokeObjectURL`;
 *   - NO network capability on `AssetAdapter` (no fetch / no URL).
 *
 * The browser shell owns the Blob ↔ object-URL conversion for rendering, kept
 * strictly in browser/platform/rendering code.
 *
 * SECURITY:
 *   - `RemoteImageDownloader` performs a FIXED-PURPOSE download: it MUST send the
 *     remote image URL to the server SSRF-protected proxy (`/api/download-image`)
 *     as request-body data; it MUST NOT fetch the remote host directly and MUST
 *     NOT accept an arbitrary caller-controlled endpoint.
 */

/** Remote image bytes returned by the fixed-purpose downloader. */
export interface AssetBytes {
  /** Raw image bytes. */
  bytes: Uint8Array;
  /** Media type (e.g. "image/jpeg"). */
  contentType: string;
}

/**
 * Minimal binary asset storage boundary. Vault-root-relative forward-slash
 * paths. Implementations must never expose platform handles (FileSystem*), never
 * return a Blob/object URL, and never touch the network.
 */
export interface AssetAdapter {
  /** Reads raw bytes of an asset by vault-relative path. */
  read(path: string): Promise<Uint8Array>;
  /** Writes raw bytes to an asset, creating/overwriting it (parents created). */
  write(path: string, data: Uint8Array, contentType?: string): Promise<void>;
  /** Returns whether an asset exists at the given path. */
  exists(path: string): Promise<boolean>;
  /** Deletes an asset by path. */
  delete(path: string): Promise<void>;
}

/**
 * Fixed-purpose remote image download port. Implementations target ONLY the
 * backend SSRF proxy and return raw bytes. No arbitrary-URL capability.
 */
export interface RemoteImageDownloader {
  /** Downloads a remote image via the server-side proxy and returns raw bytes. */
  downloadRemoteImage(
    imageUrl: string,
    options?: { signal?: AbortSignal }
  ): Promise<AssetBytes>;
}
