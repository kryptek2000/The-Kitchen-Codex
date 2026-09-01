# Release Notes — The Kitchen Codex v0.2.7

**Release Date:** September 1, 2026  
**Tag / Version:** `v0.2.7`  
**License:** MIT

---

## 🌟 Overview

The Kitchen Codex `v0.2.7` is a **Consolidation & Reliability** release. It removes
structural duplication that made the upcoming v0.3+ intelligence work riskier,
makes the release version a single source of truth, hardens API error handling,
and includes a focused ingredient-scaling UX fix. No new user-facing features
were added; this is the reliability foundation for everything that follows.

---

## 🚀 Key Highlights & Changes

### 1. 🧹 Consolidation & Reliability

- **Single-source release version**: the runtime version now lives only in
  `src/appVersion.ts`, shared by the client (`src/version.ts`) and the server
  (`/api/health`). Added `scripts/bump_version.ts` so `package.json`, the runtime
  constant, and the README can never drift, and removed the `VITE_APP_VERSION`
  build override that could silently pin an old release.
- **Shared Gemini client**: extracted the duplicated bootstrap/key-rotation logic
  into `server/geminiClient.ts` (used by nutrition, metadata recovery, and the
  recipe grabber), with identical timeout and key-rotation behavior.
- **Centralized Express app factory**: `server/app.ts` (`createApp`) owns headers,
  JSON parsing, all `/api` routes, and the final error handler, making the API
  hermetically testable. `server.ts` is now a thin entrypoint that attaches asset
  serving and binds the port.
- **Safe JSON/API error handling**: `server/errorHandler.ts` returns JSON for
  malformed JSON (`400`) and oversized payloads (`413`) instead of an HTML error
  page, returns JSON `404` for unknown `/api` routes, and never leaks filesystem
  paths or stack traces. Existing route-level errors are preserved unchanged.
- **Metadata recovery zero-fabrication**: the offline algorithmic fallback no
  longer invents `cookTime`/`totalTime`/`servings` when there is no evidence;
  inference remains clearly labelled and still requires explicit user approval.
- **Recipe card timing zero-fabrication**: the exported recipe card shows a
  neutral dash instead of fabricated "15 mins"/"30 mins".
- **Fraction parsing consolidation**: `parseFractionToDecimal` now delegates to a
  single canonical parser (`schema/recipeValidator.parseFraction`), fixing a
  latent `1-1/2` parsing bug.
- **Expanded test coverage**: new Vitest suites for versioning, the shared Gemini
  client, Express wiring, rate limiting, metadata recovery, and ingredient scaling.

### 2. 🥄 Ingredient Scaling UX

- **Fixed missing spacing** when scaling quantities that have no recognized unit
  (e.g. `2 eggs` → `1 eggs`, `4 chicken breasts` → `2 chicken breasts`).
- **Conservative singularization** of known cooking units when the scaled amount
  is exactly one (e.g. `2 cups` → `1 cup`, `2 tablespoons` → `1 tablespoon`). Unit
  nouns are deliberately not aggressively singularized.
- **Preserved fractions, unicode fractions, and wikilinks** during scaling. Recipe
  Markdown serialization is unchanged — it always writes the original ingredient line.

---

## 🧪 Verification & Test Results

- **Vitest Suite**: 153 / 153 tests passing across 20 test files (`100% green`).
- **TypeScript Typecheck**: `tsc --noEmit` passed with 0 errors.
- **Production Build**: `vite build` + `esbuild` server bundle generated cleanly into `dist/server.cjs`.
- **Production Tests**: 6 / 6 production-serve regression checks passing.
- **Security Verification**: 33 / 33 checks passing.
- **SSRF Rebinding Verification**: 48 / 48 checks passing.
- **Image Content-Type Security**: 38 / 38 checks passing.
- **Vault Lifecycle E2E**: 49 / 49 checks passing.
- **`bun audit`**: No known vulnerabilities.

---

## 🔧 Technical

The release version is now a single source of truth:

```
src/appVersion.ts  →  RELEASE_VERSION
        │
        ├── src/version.ts (client)  → APP_VERSION  → UI header/title
        └── server/app.ts (server)   → /api/health
```

To cut a future release, run `bun x tsx scripts/bump_version.ts vX.Y.Z`, which updates
`src/appVersion.ts`, `package.json`, and `README.md` in lockstep (the version is not
stored in `bun.lock`, so no lockfile regeneration is required).

---

## 📦 Release

`v0.2.7` is a consolidation release. Both `v0.2.6` and `v0.2.5` remain unchanged.
