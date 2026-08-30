# Release Notes — The Kitchen Codex v0.2.4

**Release Date:** August 30, 2026  
**Tag / Version:** `v0.2.4`  
**License:** MIT

---

## 🌟 Overview

The Kitchen Codex `v0.2.4` brings comprehensive enhancements to nutrition and macronutrient estimation accuracy across scalable servings, modernizes the backend to **Express 5**, hardens Content Security Policy configuration for iframe embedding in Obsidian and external webviews, updates core AI & build dependencies, and guarantees hermetic offline testing.

---

## 🚀 Key Highlights & Changes

### 1. 🥗 Nutrition & Macronutrient Estimation Audit & Accuracy
- **Thermodynamic Atwater Equilibrium**: Refactored the algorithmic nutrition estimator in `server/nutritionEstimator.ts` to ensure consistent macronutrient-to-calorie balance ($4\text{P} + 4\text{C} + 9\text{F} \approx \text{Calories}$, yielding a $0.96\text{--}1.01$ ratio across recipe archetypes).
- **Expanded Culinary Database**: Enriched heuristic density tables for:
  - **Whole grains & cereals**: Rolled oats, steel-cut oats, barley, quinoa, couscous.
  - **Legumes & plant proteins**: Chickpeas, black beans, lentils, tofu, edamame.
  - **Nuts & seeds**: Walnuts, chia seeds, flaxseed, almonds, pecans, cashews.
  - **Dairy & plant milks**: Whole milk, Greek yogurt, non-dairy alternatives.
  - **Fresh fruits & berries**: Blueberries, strawberries, apples, bananas.
- **Serving Scale Audit**: Verified multi-serving batches (1, 2, 4, 6, 8, and 12 servings). Nutrient values scale linearly with $<4\,\text{kcal}$ integer rounding variance across total batch totals.
- **Canonical Frontmatter Round-Trip**: Validated that `serializeRecipeToObsidianMarkdown` and `parseObsidianRecipeMarkdown` preserve the structured `nutrition` object losslessly in note YAML frontmatter.

---

### 2. ⚡ Full-Stack Modernization & Express 5
- **Express 5 Upgrade**: Updated dependencies to `express ^5.2.1` and `@types/express ^5.0.6`.
- **Path-to-RegExp v8 SPA Routing**: Converted SPA fallback routing from `*` to `/{*splat}` to support root, nested client routes, and production static assets seamlessly while preserving all `/api` endpoints.

---

### 3. 🔐 Security & Embedding Flexibility
- **Configurable CSP Frame Ancestors**: Added `CSP_FRAME_ANCESTORS` support in `server/securityHeaders.ts` and documented it in `.env.example`. Allows secure embedding inside Obsidian webview panes and container iframes (e.g. `'self' https://ai.studio`) while defaulting to strict `'none'` clickjacking protection when unset.
- **Image & Content Security**: Added cross-origin resource policy support and verified image proxy boundaries.

---

### 4. 🛠️ Build, CI & Dependency Updates
- **Google Gen AI SDK**: Upgraded `@google/genai` to `^2.19.0`.
- **esbuild**: Upgraded `esbuild` to `^0.28.2`.
- **GitHub Actions**: Upgraded checkout workflow to `actions/checkout@v7`.
- **Hermetic Testing**: Decoupled unit tests in `recipeGrabber.test.ts` from external network latency to ensure fast, deterministic CI runs.
- **Social Metadata**: Updated `og:image` and `twitter:image` tags in `index.html` referencing `/images/app_screenshot_1787266053153.jpg`.

---

## 🧪 Verification & Test Results

- **Vitest Suite**: 92 / 92 tests passing across 12 test files (`100% green`).
- **TypeScript Typecheck**: `tsc --noEmit` passed with 0 errors.
- **Production Build**: `vite build` + `esbuild` server bundle generated cleanly into `dist/server.cjs`.
- **Security Invariants**: 33 / 33 automated security verification checks passing.
