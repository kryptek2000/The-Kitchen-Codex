# Changelog

All notable changes to **The Kitchen Codex** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] - Production Hardening & Repository Hygiene

### 🔐 Security
- Added hardened Express security headers via `helmet`: `X-Content-Type-Options: nosniff`, clickjacking protection (`X-Frame-Options` + CSP `frame-ancestors`), a strict `Referrer-Policy`, and a production-only Content Security Policy.
- The server now binds to `127.0.0.1` (loopback) by default. Set `HOST=0.0.0.0` to expose it publicly; the port is configurable via `PORT`.
- AI endpoints (`/api/estimate-nutrition`, `/api/recover-metadata`, `/api/grab-recipe`) can be protected behind a shared bearer token via the optional `AI_ENDPOINT_TOKEN` environment variable. When unset (local dev) they remain open; when set for a public deployment, clients must send `Authorization: Bearer <token>` or receive `HTTP 401`.
- `GEMINI_API_KEY` continues to be used only server-side and is never exposed to the browser.

### 🔧 Maintenance
- Consolidated the Gemini model references to `gemini-3.7-flash` (primary), `gemini-3.1-flash-lite` (fallback), and `gemini-flash-latest`; removed the retired `gemini-3.6-flash` identifier from active code and documentation.
- Removed the deprecated `@types/html2canvas` stub (html2canvas ships its own TypeScript declarations).
- Added `helmet` and updated the `bun.lock`.
- Strengthened CI to run dependency install, TypeScript typechecking, the full Vitest suite, and the production build on every push and pull request.
- Added Dependabot configuration for the `bun` package ecosystem and GitHub Actions.
- Standardized product naming to **The Kitchen Codex** across `SECURITY.md`, `CONTRIBUTING.md`, the bug-report template, and the CI workflow name.

---

## [0.2.2] - 2026-08-23

### 🚀 Enhancements & Features
- **Vault Intelligence & Legacy Metadata Recovery**:
  - Added comprehensive vault health scanning to identify recipes with missing cook times, prep times, servings yields, or legacy unstructured metadata.
  - Implemented multi-tier metadata recovery: AI intelligence estimation powered by `gemini-3.7-flash` (primary) and `gemini-3.1-flash-lite` (secondary), backed by heuristic algorithmic extraction.
  - Non-destructive YAML frontmatter merging preserves all existing custom properties, author fields, external URLs, Dataview tags, and note body Markdown.
- **Shared Ingredient Markdown Rendering**:
  - Unified ingredient Markdown generation via `renderIngredientLine` across the entire codebase, eliminating duplicated logic and preventing formatting drifts between UI authoring and disk serialization.
- **Centralized Gemini Model Architecture**:
  - Established centralized model configuration in `server/modelConfig.ts` with explicit type safety across recipe scraping, nutrition analysis, and vault intelligence recovery.

### 🐛 Bug Fixes & Reliability
- **Recipe Importer Wikilink Preservation**:
  - Fixed recipe scraper and generator to retain bidirectional ingredient wikilinks (`[[Target]]` and `[[Target|Alias]]`) without double-wrapping or stripping user-curated links.
- **Production Server & Static Asset Bundling**:
  - Resolved production serving regression by properly injecting `NODE_ENV='production'` at build time via `esbuild` and serving static client assets from `dist/` with robust SPA fallback routing.
- **Multi-Timer Audio & State Resumption**:
  - Enhanced timer notification stability with Web Audio API context auto-resumption and independent alert channels across concurrent cooking timers.
- **Obsidian Markdown & Frontmatter Preservation**:
  - Verified 100% fidelity for Obsidian callouts (`> [!tip]`), instruction countdown timers, Dataview tag arrays, and shopping checklist states across iterative read/write cycles.

### 🔒 Security & Hardening
- **Reverse Proxy & Rate-Limiter Hardening**:
  - Hardened Express `trust proxy` configuration to correctly parse `X-Forwarded-For` headers and prevent IP spoofing or rate-limiter bypass attempts.

---

## [0.2.1] - 2026-08-22

### 🐛 Bug Fixes & Reliability
- **Nutrition Model Availability & Multi-Tier Cascade**:
  - Configured `gemini-3.6-flash` as the primary nutritional estimation model.
  - Added seamless secondary fallback to `gemini-3.1-flash-lite`.
  - Added an offline algorithmic culinary nutrition estimator as the final fallback when external AI models or API quotas are unavailable.
- **Graceful Quota & Rate-Limit Handling**:
  - Improved handling of Gemini quota (HTTP 429), model availability (HTTP 404), and transient API errors (HTTP 503).
  - Eliminated the misleading error message that incorrectly blamed ingredient measurements for upstream server/API connectivity issues.
- **Obsidian Wikilink Cleansing**:
  - Automatically sanitizes Obsidian wikilink syntax (`[[Ingredient|Alias]]` → `Alias`, `[[Ingredient]]` → `Ingredient`) in ingredient strings before sending to AI models, preventing prompt confusion while preserving note syntax on disk.
- **Frontmatter Validation & Serialization**:
  - Validates all macro and micronutrient values (`calories`, `protein`, `carbohydrates`, `fat`, `fiber`, `sodium`) prior to writing to YAML frontmatter.
  - Guarantees 100% preservation of existing recipe metadata, tags, callout blocks, wikilinks, instructions, and custom YAML frontmatter fields.

---

## [0.2.0] - 2026-08-15

### Added
- **Interactive Wikilink Intelligence**: Full support for wikilinks (`[[Ingredient]]`, `[[Target|Alias]]`) with contextual modal previews, backlink recipe exploration, and direct Markdown note creation in the vault.
- **AI Nutrition Estimation**: Server-side macro analysis powered by Gemini AI, calculating calories, protein, carbs, fat, fiber, and sodium per serving with YAML frontmatter persistence.
- **Obsidian Theme System**: Support for Obsidian Dark, Warm Parchment, and Nordic Sage themes with responsive contrast.
- **Official Rebranding**: Fully rebranded to **The Kitchen Codex** with modernized vault navigation and metadata.

---

## [0.1.1] - 2026-08-01

### Added
- **Fractional & Unicode Scaling**: Enhanced portion scaling engine with full unicode fraction support (`½`, `⅓`, `⅔`, `¼`, `¾`, `⅛`, `⅜`, `⅝`, `⅞`) and mixed-fraction parsing across recipes.
- **Recipe Editor Continuity**: Preserved note IDs and file system handles seamlessly when toggling between visual form and raw Markdown editor tabs.
- **Audio Chime Reliability**: Added Web Audio API context auto-resumption for timer alerts on mobile devices and background tabs.

### Security
- **SSRF Hardening**: Implemented comprehensive hex-encoded IPv6 and IPv4-mapped IPv6 validation for the recipe importer backend.

---

## [0.1.0] - 2026-07-15

### Added
- Native Obsidian vault synchronization using the browser File System Access API.
- Distraction-free interactive cooking mode with automatic multi-step timer detection and audio chimes.
- AI web recipe grabber and structured schema parser.
- 7-day weekly meal planner and synchronized categorized grocery shopping list.
- Dataview-inspired table view and rich recipe card grid.
