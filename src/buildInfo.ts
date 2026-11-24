import { APP_VERSION } from './version';

export const BUILD_VERSION: string = APP_VERSION;

// Immutable build metadata captured at build time. Falls back to "unknown" so an
// unverified build is never reported as current.
export const BUILD_COMMIT: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_TKC_BUILD_COMMIT) || 'unknown';

export const BUILD_TIME: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_TKC_BUILD_TIME) || '';
