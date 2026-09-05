/**
 * The single canonical application release version.
 *
 * This is the plain, side-effect-free source of truth shared by BOTH the
 * Vite client (via `src/version.ts`) and the server (e.g. `/api/health`). It
 * intentionally does not import `import.meta` or `package.json` so it remains
 * safe to bundle for the CommonJS server build without warnings.
 *
 * To bump the release, run `bun x tsx scripts/bump_version.ts vX.Y.Z` (see that
 * script for the full release-bump process). Do not edit this constant and
 * `package.json` independently — they drive the same release.
 */
export const RELEASE_VERSION = "v0.4.1";
