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
bun run test                    # vitest run — expect 415/415 (27 files)
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
- Recipe grabber's Gemini client comes from `server/geminiClient.ts`, which is
  keyed to key rotation (recreates the client when `GEMINI_API_KEY` changes);
  offline fallback returns when key is unset. The nutrition estimator and
  metadata recovery use the same shared client.
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

The canonical fraction parser is `parseFraction` in `src/schema/recipeValidator.ts`.
`parseFractionToDecimal` in `src/utils/markdownParser.ts` now delegates to it —
there is a SINGLE fraction/quantity parser, not two.

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
- **v0.3.0** is the current release. `RELEASE_VERSION` in `src/appVersion.ts`
  is the single runtime source of truth for BOTH the client (`src/version.ts`)
  and the server (`/api/health`). `package.json`/`README.md` reference the same
  release. To bump, run `bun x tsx scripts/bump_version.ts vX.Y.Z`.
- **v0.3.0 shipped the trustworthy data layer**: deterministic measurement
  normalization, a curated local food reference, provenance/confidence
  metadata, deterministic whole-recipe nutrition estimation (used when coverage
  is fully resolvable), a bounded deterministic nutrition cache, and an
  ingredient relationship index. The Recipe detail now exposes a derived
  "Similar Recipes" panel and a "Recipes using this ingredient" modal. The
  relationship layer is DERIVED DATA ONLY — no auto-generated ingredient
  wikilinks, no graph data written to Markdown, and relationship queries are
  entirely local (no network/AI).
- **Express 5 is merged into `main`** (`express ^5.2.1`, `@types/express ^5.0.6`).
  The SPA fallback uses `app.get('/{*splat}')` (Express 5 / path-to-regexp v8
  rejects the bare `*`). Because this was a major bump, a manual browser
  smoke-test after deploy is still worthwhile.
- **Vite 8** (6.4.3 -> 8.2.2) was evaluated but **not merged**: it passes
  automated checks but the repo has no browser E2E. Treat as optional; if adopted,
  do a manual in-browser smoke-test first.
- **Server app is now built by `server/app.ts`** (`createApp({ isProduction })`),
  which owns headers, JSON parsing, all `/api` routes, and the centralized error
  handler (`server/errorHandler.ts`). `server.ts` is the entrypoint: it attaches
  Vite (dev) / static + SPA fallback (prod) and binds the port. The API is
  therefore hermetic-testable via the `serverWiring` suite without booting Vite.
- **Zero-fabrication in algorithmic metadata recovery**: the offline fallback in
  `server/metadataRecovery.ts` only emits `cookTime`/`totalTime`/`servings` when
  there is real evidence; otherwise those fields are absent (prefer absence over
  a baked-in "20 mins"/"4 servings").
- Tests: **415/415 (27 files)**. `bun audit`: clean. `security_verification.ts`:
  33/33.

## Notes

- `dist/`, `node_modules/`, `.env` are gitignored.
- There is no browser test setup (no Playwright/DOM) — lazy-loaded modals
  (`CookingModeModal`, `RecipeEditorModal`, `RecipeCardExportModal`) are
  verified via build chunk-splitting + typecheck, not browser automation.

---

## Product Vision & Roadmap (The Kitchen Codex 3.0 Game Plan)

Source: `Obsidian Vault/The Kitchen Codex Game Plan/The-Kitchen-Codex-3.0-Game-Plan.md`.

### Vision

Turn a collection of recipes into an **intelligent personal cooking system**.
Evolve from an Obsidian recipe manager into a complete, **local-first** cooking
platform. Core loop: `Discover -> Import -> Organize -> Plan -> Shop -> Cook ->
Learn -> Improve`. **Obsidian remains the canonical source of truth**; The
Kitchen Codex is the polished interface/automation layer on top of the user's
own Markdown knowledge base.

### Phases

1. **Stabilize the Foundation** — automated testing + CI (typecheck/tests/
   integration/security/build) and a versioned formal recipe schema.
2. **Make AI Actually Useful** — "Ask My Kitchen" (query the user's own vault,
   grounded answers): "What can I make with chicken thighs, rice and broccoli?"
   Principle: *personal recipe intelligence > generic AI generation.*
3. **Intelligent Meal Planning** — plan N days from vault recipes, servings,
   inventory, leftovers, time, dietary, budget, variety (e.g. reuse leftovers).
4. **Smart Shopping** — merge/aggregate quantities by item, categorize
   (Meat/Produce/Dairy/Pantry/Frozen), plus a **pantry system** (staples,
   quantities, freezer, expirations) linked to planning/shopping.
5. **Cooking Mode 2.0** — large-screen step UI with timers, plus voice commands
   ("what's next?", "start a 10 minute timer").
6. **Recipe Intelligence** — import from images, screenshots, PDFs,
   handwritten/scanned cards. Preserve the original source; never silently
   overwrite.
7. **Recipe Relationships** — a lightweight knowledge graph (recipe <-> cuisine/
   ingredient/time/sauce) enabling "show similar recipes", "recipes using this
   sauce", etc.
8. **Cooking History** — log with rating + change notes ("more pepper"),
   enabling "make the pot pie again but apply my changes" (personal intelligence).
9. **Recipe Card Studio 3.0** — templates (Classic/Modern/Rustic/Cookbook/
   Minimal/Dark/Vintage), font/color/layout/QR/source control, PNG/PDF/print,
   and a **Cookbook Generator** (select 30 recipes -> generate cookbook).
10. **Mobile / PWA** — installable, offline recipes, mobile cooking mode.
    (Phone + tablet > desktop for kitchen use.)
11. **Privacy** — recipes stay in the vault; local-first; AI only on necessary
    data; no centralized recipe database; users own their Markdown.
12. **Optional Monetization** — free (core) vs pro (AI assistant, advanced
    planning, cookbook, premium templates, OCR, voice); keep core open source.

### Feature priority

- **Must-have:** automated test suite, formal schema/versioning, improved recipe
  search, AI "Ask My Kitchen", smart meal planning, smart shopping lists,
  mobile/PWA, offline cooking mode.
- **Major:** pantry/inventory, cooking history, recommendations, recipe
  relationships, OCR/image import, voice, cookbook generator.
- **Polish:** Recipe Card Studio 3.0, themes/templates, accessibility,
  performance, docs/API cleanup.

### Recommended roadmap (milestones)

`v0.2.6 -> v0.2.7 (consolidation: shared Gemini client, centralized error
handler, version single-source-of-truth, zero-fabrication + regression
coverage) [shipped] -> v0.3.0 (trustworthy data layer: deterministic nutrition,
curated food reference, nutrition cache, ingredient relationship index + UI)
[shipped] -> v0.4 (AI assistant, semantic search, Ask My Kitchen, meal planning
intelligence) -> v0.5 (smart meal planner, pantry, shopping) -> v0.6 (cooking
mode 2.0, voice, history) -> v0.7 (OCR/PDF/recipe intelligence) -> v0.8
(cookbook, card studio 3.0, print/PDF) -> v0.9 (mobile/PWA, offline,
accessibility, perf) -> v3.0 (intelligent cooking platform)`.

### Product rules

- Every feature must answer: **"Does this make it easier to manage, plan, shop
  for, cook, or learn from recipes?"** If yes it belongs; if not, question it.
- Avoid "feature soup" — do not add tech merely because it's possible.
- Prioritize: practical cooking utility, reliability, local-first ownership,
  Obsidian compatibility, intelligent automation, UX, security, maintainability.

### Core architecture

**Obsidian = canonical source of truth.** The Kitchen Codex is a cooking
intelligence layer (AI + cooking UX + planning/shopping/cookbook) on top of the
user's Markdown knowledge base.

### 3.0 end goal

From "I have chicken thighs, rice, broccoli, half an onion and some cream":
search the vault, understand what's on hand, pick recipes, account for servings,
optimize leftovers, generate + categorize a shopping list, build the meal plan,
guide cooking, record what happened, and learn from feedback — a **personal
cooking system**, not just a recipe database.

### Guiding principle

> **Make the user's recipes more useful without taking ownership of them.**
> Obsidian stores the knowledge; The Kitchen Codex organizes it; AI understands
> it; the planner uses it; the shopping list makes it actionable; Cooking Mode
> brings it to the kitchen; cooking history makes it smarter over time.
