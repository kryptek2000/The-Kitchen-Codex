/**
 * Centralized application version (client entry point).
 *
 * The single canonical release constant lives in `./appVersion` (`RELEASE_VERSION`)
 * and is imported here so the client and the server (via `/api/health`) always
 * read the SAME source. Substituting `import.meta.env.VITE_APP_VERSION` here was
 * removed deliberately: a build-time env override could silently pin an old
 * version and let the UI drift from the released build. There is exactly one
 * runtime release constant now.
 */
import { RELEASE_VERSION } from './appVersion';

export const APP_VERSION: string = RELEASE_VERSION;
