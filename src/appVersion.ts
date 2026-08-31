/**
 * The single canonical application release version.
 *
 * This is the plain, side-effect-free source of truth shared by BOTH the
 * Vite client (via `src/version.ts`, which layers a build/runtime
 * `VITE_APP_VERSION` override on top) and the server (e.g. `/api/health`).
 *
 * It intentionally does not import `import.meta` or `package.json` so it remains
 * safe to bundle for the CommonJS server build without warnings.
 */
export const RELEASE_VERSION = "v0.2.6";
