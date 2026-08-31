# Changelog

All notable changes to **The Kitchen Codex** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.6] - 2026-08-31

### 🎯 Deterministic Nutrition Serving Math
- **Fixed incorrect nutrition scaling when changing recipe serving counts** — the serving selector could previously cause displayed nutrition to decrease as the requested count increased, and estimation was repeated per count leading to AI variance.
- **Estimate nutrition once** for the recipe's complete ingredient batch; serving changes now perform pure local arithmetic.
- **Deterministic per-serving scaling** applied uniformly to calories, protein, carbohydrates, fat, fiber, and sodium.
- **No re-estimation on serving change** — changing 1 → 2 → 4 → 8 servings no longer calls Gemini or reinterprets the recipe.
- **Persistent serving denominator** — saved nutrition now stores total recipe nutrition plus the original/base serving count so it is self-describing and re-scalable.
- **Backward compatibility** — existing recipes with legacy per-serving nutrition (without a stored serving denominator) are preserved and interpreted under the legacy per-serving contract, with no re-estimation.
- **Unified display & export scaling** — the nutrition card, editor, and exported recipe cards use the same deterministic serving calculations.

### 🧪 Testing & Verification
- **107 / 107 Vitest tests passing**, including **15 new nutrition serving-math regression tests**.
- Production build, production regression (6/6), security verification (33/33), SSRF rebinding (48/48), image content-type (38/38), and vault lifecycle E2E (49/49) all passing.
- `bun audit` reports **no known vulnerabilities**.
- TypeScript typecheck (`tsc --noEmit`) passing and lockfile/frozen-install verification passing.

---

## [0.2.5] - 2026-08-30

### 🧠 AI & Nutrition Reliability
- **Fixed Gemini `504 DEADLINE_EXCEEDED` timeouts** affecting nutrition and macro calculations.
- **Reduced Gemini thinking to `MINIMAL`** for fast, deterministic structured JSON extraction across nutrition estimation, metadata recovery, and recipe grabbing.
- **Increased the Gemini request timeout** from 15 seconds to 25 seconds in `server/modelConfig.ts`.
- **Dynamic Gemini client refresh** when `GEMINI_API_KEY` changes, keeping the AI pipeline in sync with key rotation.
- **Preserved the multi-tier Gemini fallback architecture**: `gemini-3.7-flash` (primary) → `gemini-3.1-flash-lite` (fallback) → offline algorithmic estimator.

### 🔧 CI & Build Reliability
- **Added Bun lockfile consistency verification** to `.github/workflows/build.yml`.
- **Synchronized `bun.lock`** with the actual dependency tree and kept `--frozen-lockfile` enforcement in CI.

---

## [0.2.4] - 2026-08-30

### 🥗 Nutrition, Scaling & Macro Accuracy
- **Audited & Expanded Heuristic Nutrition Engine**: Refactored `server/nutritionEstimator.ts` to ensure strict thermodynamic Atwater energy balance ($4 \times \text{Protein} + 4 \times \text{Carbs} + 9 \times \text{Fat} \approx \text{Calories}$, ratio $0.96\text{--}1.01$).
- **Expanded Ingredient Coverage**: Added robust nutrient density data for whole grains (oats, barley, quinoa), legumes/tofu, nuts and seeds (walnuts, chia, almonds), dairy/milks, and fresh fruits.
- **Linear Serving Scaling**: Verified multi-serving batch estimation (1, 2, 4, 6, 8, 12 servings) with sub-4 kcal rounding variance and lossless round-trip serialization into Obsidian YAML frontmatter.

### 🔐 Security & Infrastructure
- **Express 5 Migration**: Upgraded backend to `express ^5.2.1` and `@types/express ^5.0.6` with updated path-to-regexp v8 SPA fallback (`app.get('/{*splat}')`).
- **Configurable CSP Frame Ancestors**: Added dynamic support for `CSP_FRAME_ANCESTORS` in `server/securityHeaders.ts` and `.env.example`, allowing flexible embedding inside Obsidian webviews and preview containers while maintaining strict clickjacking protection by default.
- **Dependency & SDK Updates**: Upgraded `@google/genai` to `^2.19.0`, `esbuild` to `^0.28.2`, and CI checkout to `actions/checkout@v7`.
- **Offline Deterministic Unit Testing**: Refactored `recipeGrabber.ts` and test suite to run hermetically without hanging on external network latency or upstream API load spikes.
- **Social Media & SEO Metadata**: Updated `og:image` and `twitter:image` tags in `index.html` referencing `/images/app_screenshot_1787266053153.jpg`.

---

## [0.2.3] - 2026-08-27

### 🚀 Enhancements & Features
- **Inline Markdown Instruction Rendering**: Instruction steps now correctly parse and render inline Markdown (bold `**`, italics `*`, code `\``) for clean typographic emphasis.
- **Clean Metadata Display**: Removed redundant duplicate servings sub-headers under ingredients, keeping primary serving counts in the top metadata panel.
- **Recipe-Aware Footer Recommendations**: Replaced hardcoded universal serving advice with smart, category-aware recommendations (e.g., cooling instructions for sourdough bread, warm serving notes for soups).
- **Strict Food Display Metadata Compliance**: Configured the Food Display panel to render strictly when actual presentation/food-display metadata exists, omitting the panel entirely when absent to prevent fabrication.
- **Robust Print & PDF Pagination**: Enhanced print media styles with page-break protection (`break-inside: avoid`) across ingredients, instructions, and cards for publication-quality PDF exports.

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

