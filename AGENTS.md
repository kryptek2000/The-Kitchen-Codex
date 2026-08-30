# The Kitchen Codex — Project Guide for AI Agents

Markdown-native culinary vault, recipe manager, and interactive cooking
companion built for Obsidian vaults. Full-stack: React 19 + Vite + TypeScript
frontend, Express + TypeScript backend, Gemini AI integration, Obsidian
markdown/vault sync.

## Package manager & lockfile

- **Bun** is canonical (`bun.lock`). CI installs with `bun install --frozen-lockfile`.
- **Do NOT introduce a competing lockfile** (e.g. `package-lock.json`). npm is
  tolerated for convenience but Bun is the source of truth.
- Keep `vite` in `devDependencies` only (it was de-duplicated out of
  `dependencies`). Avoid re-adding type-only packages (`@types/*`) to `dependencies`.

## Commands

```bash
bun install --frozen-lockfile   # dry check that lockfile matches package.json
bun run dev                     # tsx server.ts (Vite dev middleware, port 3000)
bun run lint                    # tsc --noEmit  (this is the "typecheck" step)
bun run test                    # vitest run — expect 92/92 (12 files)
bun run build                   # vite build && esbuild server.ts -> dist/server.cjs
bun run test:prod               # needs server running on :3000 (see note)
bun x tsx scripts/security_verification.ts   # needs server running on :3000
bun audit                       # dependency vulnerability check
```

- `test:prod` and `security_verification.ts` do **not** start the server; run
  `PORT=3000 node dist/server.cjs &` first, then run them.
- There is no ESLint config. `lint` = `tsc --noEmit`. Do not invent a lint migration.

## TypeScript baseline (important)

- `typescript` is pinned to **7.0.2**. `tsconfig.json` sets `"strict": false`.
- TS7 enables strict null checks **by default**; `strict: false` preserves the
  project's historical non-strict typechecking. The codebase is deliberately
  NOT strict-mode. Migrating to strict is a separate, non-required effort.
- `src/vite-env.d.ts` (`/// <reference types="vite/client" />`) is required —
  TS7 errors on `*.css`/asset imports without it. Do not remove it.
- Loosening `strict` is applied via `tsconfig.json`, never by mass-editing
  source to satisfy strictness.

## Security invariants (do NOT regress)

- **SSRF guard**: `server/ssrfGuard.ts` (DNS pinning, loopback/private/metadata
  blocking, image MIME + size limits). Never weaken it.
- **AI key containment**: `GEMINI_API_KEY` is server-side only. Never expose it
  to the browser (no `VITE_*` key). Verify with `security_verification.ts`.
- **AI endpoint auth**: `/api/estimate-nutrition`, `/api/recover-metadata`,
  `/api/grab-recipe`, `/api/download-image` are gated by optional
  `AI_ENDPOINT_TOKEN` (bearer). When unset (local) they are open; when set for a
  public host, unauthenticated calls get 401. Uses constant-time compare; never
  log/echo the token.
- **Do NOT weaken**: WAF (402/403/429) handling, zero-fabrication behavior,
  Canonical Schema v1 boundary, or rate limiting.

## Recipe grabber / zero-fabrication

- Recipe Grabber supports `{ url }`, `{ html }`, `{ rawText }`.
- Zero-fabrication invariant: never invent servings, prep/cook/total time,
  calories, image, ingredients, or instructions when source data is absent.
- Recipe grabber's `getGemini()` is keyed to key rotation (recreates the client
  when `GEMINI_API_KEY` changes); offline fallback returns when key is unset.
- No automatic ingredient wikilinks. Do not re-introduce them.

## Canonical Schema v1

Production load path (in `src/utils/markdownParser.ts`):

```
parseObsidianRecipeMarkdown -> obsidianToCanonicalRecipe (normalizes)
  -> canonicalToObsidianRecipe -> UI
```

Production save path:

```
serializeRecipeToObsidianMarkdown -> obsidianToCanonicalRecipe -> canonicalToObsidianRecipe -> markdown
```

`validateCanonicalRecipe`/`normalizeCanonicalRecipe` live in
`src/schema/recipeValidator.ts`. The canonical boundary is active; keep it.

## Server binding & deployment

- Binds to **`127.0.0.1`** locally by default; auto-detects Cloud Run / AI Studio
  via `K_SERVICE` / `K_REVISION` / `K_CONFIGURATION` and binds **`0.0.0.0`**.
- `PORT` (default 3000), `HOST` (override), `TRUST_PROXY`, `AI_ENDPOINT_TOKEN`,
  `CSP_FRAME_ANCESTORS` are documented in `.env.example`.

## Security headers

`server/securityHeaders.ts` (helmet): `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`,
production CSP (`default-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
`frame-ancestors` from `CSP_FRAME_ANCESTORS`, default `'none'`). CSP is disabled
in dev (Vite HMR). `frame-ancestors` is configurable via `CSP_FRAME_ANCESTORS`.

## Current state / open items

- `main` HEAD is clean and pushed (see `git log`). It includes the Express 5
  migration (merged via PR #7), GenAI 2.19.0, esbuild 0.28.2, actions/checkout
  v7, TS7 baseline, security hardening, deps cleanup, and this doc.
- **Express 5 is merged into `main`** (`express ^5.2.1`, `@types/express ^5.0.6`).
  The SPA fallback uses `app.get('/{*splat}')` (Express 5 / path-to-regexp v8
  rejects the bare `*`). Because this was a major bump, a manual browser
  smoke-test after deploy is still worthwhile.
- **Vite 8** (6.4.3 -> 8.2.2) was evaluated but **not merged**: it passes
  automated checks but the repo has no browser E2E. Treat as optional; if adopted,
  do a manual in-browser smoke-test first.
- Tests: **92/92 (12 files)**. `bun audit`: clean. `security_verification.ts`:
  33/33.

## Notes

- `dist/`, `node_modules/`, `.env` are gitignored.
- There is no browser test setup (no Playwright/DOM) — lazy-loaded modals
  (`CookingModeModal`, `RecipeEditorModal`, `RecipeCardExportModal`) are
  verified via build chunk-splitting + typecheck, not browser automation.
