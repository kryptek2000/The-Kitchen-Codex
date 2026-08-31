/**
 * Centralized application version.
 *
 * Resolves from an explicit `VITE_APP_VERSION` build/runtime override when
 * provided (e.g. via a `.env` file), otherwise falls back to the canonical
 * release version from `./appVersion` (the single source of truth shared with
 * the server). This module drives the version shown in the App header/footer
 * branding and the document title.
 *
 * Note: `package.json` is intentionally not consulted here. The release/tag
 * flow stamps the published version independently, so relying on the
 * (audit-locked, often stale) `package.json` version can drift the UI badge.
 */
import { RELEASE_VERSION } from './appVersion';

export const APP_VERSION: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_VERSION) || RELEASE_VERSION;
