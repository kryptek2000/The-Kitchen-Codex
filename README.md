# The Kitchen Codex

**The recipes you love deserve a home.**

[![Version](https://img.shields.io/badge/version-0.9.0-amber.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**The Kitchen Codex** is a **standalone, local-first recipe and cooking workspace**. Save the recipes you love, keep them together in **My Recipe Vault**, plan meals, build shopping lists, cook step by step, and understand your recipes' nutrition.

**Obsidian is optional.** The Kitchen Codex works as its own application. Its Markdown-based recipe format also makes it friendly to Obsidian users, but you do not need Obsidian to use it.

[**Official website**](https://kitchencodex.app) · [**Get started locally**](#-run-it-locally) · [**Current release**](#-whats-available-now) · [**Roadmap**](#-where-were-heading) · [**Issues & feedback**](https://github.com/kryptek2000/The-Kitchen-Codex/issues)

<p align="center">
  <img src="./public/images/kitchen-codex-ui.png" alt="The Kitchen Codex recipe library interface" width="100%" />
</p>

> **Release status — v0.9.0:** This README distinguishes features in the published version from development work and future product direction. SHISO's H-2 editing workflow is **uncommitted and awaiting independent audit and real-browser acceptance**. It is **not part of v0.9.0**. Advanced Nutrition is also **not included in v0.9.0**. No paid tier, subscription, hosted Kitchen Codex Cloud, or mobile app is being offered by this release.

---

## 🍃 The idea: one home for your cooking

The Kitchen Codex is built around a simple flow:

**Save → Protect in My Recipe Vault → Organize → Plan → Shop → Cook → Understand nutrition**

Your Recipe Vault is the home for your recipe collection, not another company's product name. Today the application can work with local recipe files, including Obsidian-compatible Markdown. Different storage providers, hosted Vaults, and richer sync options are **future directions**, not current integrations.

You can start with your existing recipes or create new ones. Keep your collection yours, and choose when to use optional AI services.

## ✨ What's available now

The following describes the **published v0.9.0 application**, not every experiment in the development worktree.

| Your kitchen workflow | What The Kitchen Codex offers |
| --- | --- |
| **My Recipe Vault** | Browse, search, filter, favorite, create, and edit recipes with local-file workflows. |
| **Save recipes from elsewhere** | Import recipes from supported web pages, structured recipe data, or supplied text, with a preview before saving. |
| **Create recipes** | Write recipes manually or use the existing **Create for Me** AI draft feature where a configured, verified provider is available. Generated drafts are not saved automatically. |
| **Organize and rediscover** | Explore related recipes, recipes using an ingredient, useful tags, and culinary similarity. |
| **Plan meals** | Plan breakfast, lunch, and dinner across a seven-day calendar. |
| **Shop from your plan** | Build a grocery checklist from planned recipes and copy a shopping list. |
| **Cook with focus** | Use recipe cards, step-by-step Cooking Mode, ingredient scaling, and recipe timers. |
| **Keep and share recipe information** | Print/export recipe cards and preserve supported recipe metadata, notes, images, and Markdown formatting. |
| **Work with recipe images** | Find licensed representative images or explicitly request AI generation using supported providers; check provider pricing before making paid image requests. |
| **View existing nutrition** | Display, edit, scale, and preserve usable saved or imported nutrition data. Automated untrusted nutrition values are not silently treated as verified. |

**AI functionality is conditional.** Provider/model availability, credentials, verification, product gates, and possible charges affect which AI actions can run. Core recipe editing, planning, shopping, and cooking do not depend on having an AI account.

### The Kitchen Codex Vault and Obsidian

**Obsidian is an integration, not a requirement or parent product.** If you already use Obsidian, The Kitchen Codex supports local recipe folders and compatible Markdown/YAML frontmatter, including wikilinks such as \`[[Garlic]]\` and \`[[Chicken Breast|chicken]]\`. It can read and save local recipe files through supported browser directory access.

If you have never heard of Markdown or Obsidian, that's fine: the goal is a recipe organizer first, with technical file compatibility available when you want it.

An **official Obsidian plugin**, additional storage-provider integrations, hosted Vault options, and richer cross-device sync remain part of the **multi-surface roadmap**; do not assume they are included with v0.9.0.

## 🌿 Meet SHISO — Your AI Kitchen Companion

**One companion. One conversation. Different places to start.**

**SHISO** is the planned unified AI kitchen companion for The Kitchen Codex. The direction is to talk naturally with one assistant whether you're in your Recipe Vault, looking at a recipe, planning a meal, or reviewing nutrition. Future entry points use names such as **Chat with SHISO**, **Ask SHISO**, and **Create with SHISO**, not separate recipe and nutrition chatbots.

The intended workflow is practical: ask SHISO to make a recipe, change ingredients, investigate nutrition issues, plan with your own recipes, or help while cooking. **SHISO interprets and coordinates; The Kitchen Codex's existing application systems validate and perform the work.**

### SHISO development status — not a released feature

Current internal H-2 development has **reported** implementation of authorized working-copy ingredient edits, USDA-backed nutrition corrections, deterministic recalculation, undo/discard, and explicit user-authorized saving via the existing Vault writer. These claims still require independent audit and real-user browser testing; the work is **uncommitted and unavailable in the published v0.9.0 release**.

The intended trust model:

- SHISO can help carry out **user-requested** changes through application-controlled tools, not through unrestricted access to local files.
- The application—not a language model—selects authenticated food data, derives weights, and calculates nutrition.
- Changes should be visible and undoable, and **saving to the Vault requires an explicit user instruction or trusted save action**.
- Ambiguous ingredient identities or measurements stay reviewable; missing facts are not invented.
- A successful conversational response alone is not proof that data was changed or saved.

Earlier features named **Ask My Kitchen**, **Ask This Recipe**, and **Create for Me** are historical/shipped capabilities, **not separate assistant brands in the forward plan**. Existing features will not be removed or renamed merely by this README; the unification is a staged development program.

## 🥗 Nutrition: useful basics, verified depth

The long-term nutrition strategy has two complementary levels:

| | Basic Nutrition | Advanced Nutrition |
| --- | --- | --- |
| **Product direction** | Free everyday nutrition functionality, including usable nutrition already present in recipes. | Premium AI-assisted interpretation of difficult ingredient and portion wording. |
| **Calculation trust** | Preserve the distinction between known, unknown, and manually edited data. | Authenticate food identities/USDA source portions, calculate deterministically, disclose incomplete coverage, and retain review/provenance. |
| **v0.9.0 availability** | Existing and imported nutrition display/edit/scale workflows. | **Not included in v0.9.0.** In development and testing. |

**SHISO understands. The Kitchen Codex verifies. You stay in control.**

Advanced Nutrition is designed to use AI for interpretation, not as a source of invented calories, grams, food identities, or nutrient totals. Genuine gaps stay unresolved until supported evidence or user input is available. Nutrition outputs are estimates, not individualized medical advice.

The free/premium distinction is a **product strategy**; this repository does not currently provide a hosted subscription or billing service.

## 🧭 Where we're heading

The Kitchen Codex is intended to grow into **one product core across several ways to cook and manage recipes**. These items are **plans, not shipping claims or timelines**.

| Direction | Planned experience |
| --- | --- |
| **SHISO everywhere** | One conversational companion for creation, editing, Vault search, nutrition, planning, shopping, and cooking assistance. |
| **Advanced Nutrition** | Wider real-world ingredient understanding using authenticated USDA evidence and the existing deterministic engine. |
| **Collections** | Organize recipes into named groups, dietary collections, and cuisines. |
| **Spice Rack** | Manage spices and seasonings and connect them to recipes. |
| **Ingredient substitutions** | Show appropriate substitutions through a verified application workflow. |
| **Smarter planning and cooking** | Leftover-aware suggestions, linked cooking timer chains, and more useful meal workflows. |
| **More places to use your Vault** | Standalone desktop distribution, an official Obsidian plugin, and a mobile/PWA companion as each surface is completed and verified. |
| **More ways to capture and store recipes** | Additional import sources, social recipe capture where supported, and optional future storage/cloud integrations. |
| **Nutrition diary** | Possible later recipe-aware food logging and nutrient tracking, conditional on Advanced Nutrition accuracy and release gates. |

**Not currently offered:** Kitchen Codex Cloud, Google Drive/Notion sync, social-network connectors, paid subscriptions, nutrient tracking, or a released mobile companion. Specific integrations will be announced only when real and supportable.

For the product architecture and long-term direction, see the [SHISO architecture roadmap](docs/Shiso-Architecture-and-Roadmap.md) and the [official website's product/brand planning](https://github.com/kryptek2000/The-Kitchen-Codex-Website/blob/main/docs/Website-Master-Plan.md). These are living planning documents: some older implementation-status statements predate the current development work.

## 🚀 Run it locally

The Kitchen Codex is currently a local full-stack React + Node application. **Obsidian is not required.** The repository's reproducible dependency path uses [Bun](https://bun.sh/) and its committed \`bun.lock\` file.

**Requirements:** Git, Bun, a supported desktop browser, and a local Node-compatible runtime. AI provider credentials are optional for non-AI features.

\`\`\`bash
git clone https://github.com/kryptek2000/The-Kitchen-Codex.git
cd The-Kitchen-Codex
bun install --frozen-lockfile
cp .env.example .env
bun run dev
\`\`\`

Open **http://localhost:3000**.

To connect local files in a compatible Chromium-based browser, use **Connect Vault → Select Vault Directory**, choose your recipe folder, and grant access. The browser File System Access API manages local directory permissions. You can also use the supported importer workflows.

### Optional AI setup

Some features require a supported AI provider, model, and credentials. Start with [\`.env.example\`](.env.example) and the in-app AI settings where available. **Do not commit credentials to GitHub.** Provider requests may use paid credits, depending on your selection and account.

The environment variable \`KITCHEN_CODEX_NUTRITION_PRODUCT_TIER=ai_advanced\` is a **development/product-access gate**, not a subscription, not a way to unlock unreleased Advanced Nutrition in v0.9.0, and not a substitute for valid provider access.

### Build and test

\`\`\`bash
bun run lint         # TypeScript type checking
bun run build        # Frontend + bundled server
bun run start        # Start the production build locally
bun run test         # Automated test suite
\`\`\`

For a production/LAN/public deployment, review the included security configuration carefully. The app binds to loopback by default; exposing AI endpoints requires appropriate authentication (including \`AI_ENDPOINT_TOKEN\` when applicable), rate limiting, reverse-proxy settings, and a deliberate deployment security review. **The repo is not a ready-made hosted multi-user service.**

## 🧰 Under the hood

The application uses **React 19**, **TypeScript**, **Vite**, an **Express/Node** API, and a local-first recipe/Markdown data model. It supports Obsidian-compatible Markdown and YAML frontmatter without requiring Obsidian.

AI operations go through guarded provider infrastructure rather than granting models direct file or nutrition authority. The developing Advanced Nutrition system is grounded in USDA FoodData Central with authenticated records, review states, and deterministic calculations. See [Advanced Nutrition Architecture](docs/Advanced-Nutrition-Architecture.md) for implementation-level detail; that document includes historical phase records and should not be read as a v0.9.0 shipping checklist.

## 🔐 Data ownership and product trust

- **Local-first:** the current desktop-browser workflow keeps your recipe files under your chosen local file access. External AI services are separate, optional capabilities.
- **Your confirmation matters:** imported/generated recipe drafts are reviewed before saving. Uncommitted SHISO editing is being designed around application-authorized changes and explicit saves.
- **Nutrition transparency:** a missing amount or unsupported match must not become a fabricated nutrient result.
- **No invented integrations:** desktop/mobile apps, cloud storage, social importers, and paid tiers are only called available once verified and released.
- **Your own provider costs:** AI or image-generation providers may charge independently of The Kitchen Codex.

## 🤝 Contributing and feedback

This project is open source and developed in public. Bugs, feature ideas, and contributions are welcome through [GitHub Issues](https://github.com/kryptek2000/The-Kitchen-Codex/issues).

**Release authority:** New versions and major deployment decisions are approved by the project owner. An implementation report or passing tests alone does not mean SHISO or Advanced Nutrition has shipped.

## 📄 License

[MIT License](LICENSE).

---

## 📌 Release history

### `v0.9.0` (Current Release)
- **Verified-free recipe generation**: separate structured-text and recipe-generation capability verification so a model must be verified for the recipe task itself, not merely for text. Current verified-free OpenRouter recipe models can generate editable drafts, and verified dynamic generation is single-attempt and terminal — no silent paid/provider fallback, no model fallback, and no retries.
- **Fail-closed credentials & capability**: credentials and capability authorization fail closed on replacement, revocation, expiry, source mismatch, or catalog changes; generated recipes remain unsaved drafts until an explicit Save.
- **Nutrition safety repair**: removed fabricated algorithmic nutrition authority and disabled automatic application/saving of untrusted machine nutrition. Existing manual and legacy nutrition stays readable, editable, scalable, and round-trip safe; Advanced Nutrition remains deferred.
- **Licensed representative recipe images**: explicit Openverse / Wikimedia Commons search with a closed reusable-license allowlist (CC0, Public Domain, CC BY, CC BY-SA), preserved attribution/provenance, app-local protected thumbnails (no browser hotlinking), and deferred `Assets/` creation until explicit recipe Save. Representative images may resemble the recipe but are not guaranteed to depict the exact dish.
- **Explicit AI recipe image generation**: Licensed Search remains the free default and AI generation is never automatic. The exact provider/model and truthful pricing classification are disclosed; paid or variable generation requires confirmation each time; one confirmation permits exactly one provider call with no retries or provider/model fallback. The preview stays transient until `Use This Image` and recipe Save, with collision-safe Asset creation, transaction-owned rollback, provenance separation, capacity reservations, and requester-bound previews. Browser and Obsidian binary preview transport use authenticated app-local requests.

**Live acceptance**: a biscuit image was generated with OpenRouter Image using `google/gemini-2.5-flash-image` at a disclosed cost of approximately $0.03; it required explicit acceptance and recipe Save, persisted into the vault `Assets/` folder, and loaded after reopening — with no automatic generation.

**Limitations**: AI image pricing may be paid or variable and depends on the selected provider account; a configured image-provider API key is required for AI generation (licensed search does not require one); `AI_ENDPOINT_TOKEN`-protected browser/plugin deployments remain unsupported/fail-closed until a repository-owned secure Unlock/bootstrap token source exists; File System Access collision protection covers concurrent transactions within the active application realm and does not claim universal cross-tab/process atomicity; representative images are licensed matches, not guaranteed exact depictions; Advanced Nutrition is not included in v0.9.0.

### `v0.8.0` (Previous Release)
- **Session-only BYOK for Text AI and Image AI**: enter a provider API key that is stored only in server process memory, expires automatically, is revocable, and is never written to the browser, vault, or settings. Exact provider-scoped credential isolation is preserved (`openrouter` ≠ `openrouter-image`; `gemini` ≠ `gemini-image`).
- **Simplified two-card AI Settings UX**: Text AI and Image AI each get a compact card with provider, model, credential source, session-key controls, and a stable footer — Advanced / Server Diagnostics stays collapsed by default.
- **Dynamic OpenRouter model discovery**: a server-owned, cached, fail-safe catalog discovers OpenRouter models and classifies **Free / Budget / Paid / Variable** pricing, with a searchable free-first model picker.
- **Cost-aware FREE → PAID protection**: a model selected while FREE that later becomes paid (or whose price can no longer be verified) is blocked with an explicit `MODEL_PRICING_CHANGED` / `MODEL_PRICING_UNVERIFIED` error — zero provider calls, no silent charge, no automatic re-selection.
- **Stale-pricing fail-closed**: expired/refreshed-failed catalog pricing never permits a FREE-acknowledged selection to execute.
- **Safe server-owned model validation**: only server-verified strict-structured text models and transport-allowlisted image models are executable; unknown client model IDs fail closed.
- **Ask My Kitchen generic ingredient matching**: generic queries like "chicken" now match their normalized variants ("chicken breast", "rotisserie chicken") while remaining whole-token safe ("chickpea" does not match).
- **OpenRouter image generation**: live-smoke verified through the explicit, session-key-aware image path; image preview remains explicit-save only (no automatic image generation).

**Limitation**: dynamic OpenRouter models that are discovered but not yet verified for the Kitchen Codex strict structured-output runtime are shown informationally but are **not executable**. Dynamic image-output models are likewise discovery-only unless explicitly verified for the current image transport. Not every discovered free model is currently usable, and there is **no free image-generation model** at this time (free image-provider support is planned separately).

### `v0.7.0` (Previous Release)
- **Create for Me**: a guided recipe-creation assistant with canonical vault-integrity hardening (recipe/vault stale-conflict protection, lock-key normalization, liveness-guarded Save so no operation can silently run behind a closed window or stale session).
- **Vault Intelligence image recovery**: missing/broken-image detection, explicit Gemini image generation, AI preview before save, and Save / Regenerate / Cancel controls with collision-safe local `Assets/` writes and generated-image provenance.
- **Provider/error resilience groundwork**: an `ImageProvider` abstraction for Gemini image generation with an exact failure taxonomy (quota / rate-limit / timeout / unavailable / blocked / no-image / auth) — bounded messages, no auto-retries, no automatic image generation, and a pre-decode base64 memory guard.

### `v0.6.0` (Previous Release)
- **AI provider abstraction**: every live AI consumer (interpret, rank, discover, metadata recovery, nutrition, Grab Recipe) now routes through a provider-neutral `AiProvider` abstraction; the Gemini SDK is confined to infrastructure (`server/geminiClient.ts` + `server/ai/geminiProvider.ts`), with no application-level direct-Gemini consumer remaining.
- **Redacted provider diagnostics**: all AI consumers log failed model attempts through a shared, bounded, secret-redacted helper — no raw provider errors reach clients.
- **Nutrition hardening**: AI-estimated non-finite numbers (`Infinity`, `NaN`) now coerce to `0`; finite rounding/clamping and deterministic-first behavior unchanged.
- **Legacy cleanup**: removed the dead `server/kitchenAnswer.ts` adapter, the orphaned `POST /api/kitchen/answer` route + rate limiter + tests, and the dead `buildAnswerRequest`/`isAnswerResponse` UI helpers.
- **Testing**: 926/926 Vitest tests across 41 files; 84/84 security tests across 8 files; typecheck and production build clean.

### `v0.5.1` (Previous Release)
- **Ask My Kitchen reliability hotfix**: Ask My Kitchen no longer hard-fails when the primary Gemini model is unavailable — the interpreter falls back to another model and then to deterministic parsing, ranking falls back to deterministic ranking, and web discovery tries a fallback grounding-capable model before reporting unavailable. Provider failures now produce safe server-side diagnostics. No change to trust boundaries; web discovery still depends on at least one deployed model supporting Google Search grounding.
- **Testing**: 877/877 Vitest tests across 41 files; typecheck and production build clean; no client secret exposure.

### `v0.5.0` (Previous Release)
- **Ask My Kitchen Intelligence & Web Discovery**: Ask My Kitchen now understands richer cooking intent (a structured `KitchenIntent`) and gives grounded, preference-aware recommendations over the recipes already in your vault. It can do explicit web discovery when you ask (or when vault-first results are weak and you tap "Search the web"), keeps "FROM MY VAULT" and "FROM THE WEB" results strictly separate, and sends a selected web result into the existing Web Recipe Grabber for a preview before saving.
- **Grounded candidate reasoning & ranking**: a deterministic engine stays authoritative for vault membership; an optional AI layer re-ranks only trusted candidate evidence and degrades gracefully when unavailable. AI never invents recipe IDs, never decides vault membership, and never creates candidates.
- **Explicit, provider-grounded web discovery**: result URLs come only from real search grounding, never from model-generated text. Discovered URLs are not fetched by Ask My Kitchen and go through the hardened importer (SSRF/private-IP/redirect/content-type protections), with preview + explicit confirmation before any save.
- **Trust, privacy & security**: no auto-import, no silent web escalation, no vault dump/raw Markdown to ranking or discovery AI, no direct save from Ask My Kitchen.
- **Testing**: 851/851 Vitest tests across 40 files; typecheck and production build clean; release hardening complete (0 blocking, 0 important findings).

### `v0.4.1` (Previous Release)
- **Ask My Kitchen Reliability**: hardened the deterministic fallback interpretation — conversational false positives fixed (reference phrases, generic/meta nouns, and dangling conjunctions are no longer mistaken for ingredients), compound ingredient+time intent preserved ("chicken recipes under 30 minutes" keeps both), hour parsing fixed ("under 1 hour" = 60 minutes), and unsupported dish-family subjects ("salad recipes under 30 minutes") now fail safely instead of silently returning a time-only query.
- **Distinct failure signalling**: genuine "could not understand" (HTTP 422) is now separated from AI/service failure (HTTP 503), with safe fixed UI error messages and no raw provider/server error leakage.
- **Culinary Similar Recipes**: Similar Recipes and Ask My Kitchen "similar to this" now share one deterministic culinary-relevance authority — dish-family/type-first ranking, related-family support, cuisine/course/tag signals, and ingredient overlap reduced to a capped secondary signal; generic pantry ingredients and generic tags can no longer establish similarity on their own.
- **Testing**: 675/675 Vitest tests across 34 files; typecheck and production build clean.

### `v0.4.0` (Previous Release)
- **Ask My Kitchen**: ask natural-language questions about the recipes already in your Obsidian vault. Deterministic, vault-only retrieval via `searchKitchenRecipes`; natural-language interpretation into a structured `KitchenQuery`; a grounded conversational answer layer; a minimal Ask My Kitchen UI; trusted "similar to this recipe" context; and local recipe-membership authority.
- **Privacy-first evidence flow**: only compact retrieved evidence is sent to the server; no vault data, raw Markdown, notes, or unrelated recipes ever leave the client. Read-only; no web search; no recipe fabrication; grounded no-match/fallback behavior.
- **Testing**: 593/593 Vitest tests across 33 files; typecheck and production build clean.

### `v0.3.1` (Previous Release)
- **Serving-Calorie Display Fix**: Recipe Detail Quick Metrics calories now scale correctly when the selected serving count changes. Header calories and the RecipeNutritionCard now share the same persisted-nutrition serving-scaling path, and nutrition serving denominators continue to respect `nutrition.servings` to prevent double-scaling.
- **Testing**: 424/424 Vitest tests across 27 files; typecheck, production build, and GitHub Actions green on the hotfix commit.

### `v0.3.0` (Previous Release)
- **Trustworthy Data Layer**: deterministic measurement normalization, a curated local food reference, provenance/confidence metadata, deterministic whole-recipe nutrition estimation (used when coverage is fully resolvable), and a bounded deterministic nutrition cache. Requested serving count never changes the deterministic total.
- **Recipe Relationships**: an ingredient relationship index, "Recipes Using This Ingredient", and "Similar Recipes" — all derived locally (no network/AI), with conservative exact ingredient identity and wikilink target authority; no auto-generated ingredient wikilinks.
- **Testing**: 415/415 Vitest tests across 27 files; typecheck and production build clean.

### `v0.2.7` (Previous Release)
- **Consolidation & Reliability**: made the release version a single source of truth (`scripts/bump_version.ts`), centralized the Gemini client (`server/geminiClient.ts`) and the Express app (`server/app.ts`), added safe JSON/API error handling (`server/errorHandler.ts`), improved metadata-recovery and recipe-card zero-fabrication, and consolidated fraction parsing.
- **Ingredient Scaling UX**: fixed missing spacing when scaling no-unit quantities and added conservative singularization of known units.
- **Testing**: 153/153 Vitest tests across 20 files; typecheck, production build, production/security/E2E verification, and `bun audit` all green.

### `v0.2.6` (Previous Release)
- **Deterministic Nutrition Serving Math**: Fixed incorrect nutrition scaling when changing recipe serving counts. Nutrition is now estimated once for the recipe's complete ingredient batch; serving changes are pure deterministic arithmetic (never a new AI estimate), with a persistent serving denominator for self-describing, re-scalable totals.
- **Backward Compatibility**: Legacy per-serving nutrition (no stored denominator) is preserved and interpreted under the legacy per-serving contract, with no re-estimation and no rewrite.
- **Shared Gemini Client & API Consolidation** (v0.2.7-in-progress foundation): centralized the Gemini client, added a global malformed-JSON/error handler, made the version a single source of truth, and expanded regression coverage.

### `v0.2.5` (Previous Release)
- **AI & Nutrition Reliability**: Fixed Gemini `504 DEADLINE_EXCEEDED` timeouts affecting nutrition and macro calculations by reducing Gemini thinking to `MINIMAL` for fast structured JSON extraction and raising the request timeout from 15s to 25s.
- **Dynamic Gemini Client Refresh**: The Gemini client now re-initializes when `GEMINI_API_KEY` changes, keeping the AI pipeline in sync with key rotation.
- **Multi-Tier Fallback Preserved**: Retained the robust cascade — `gemini-3.7-flash` (primary) → `gemini-3.1-flash-lite` (fallback) → offline algorithmic estimator.
- **CI & Lockfile Integrity**: Added Bun lockfile consistency verification to `build.yml`, synchronized `bun.lock` with the actual dependency tree, and kept `--frozen-lockfile` enforcement in CI.

### `v0.2.4`
- **Nutrition, Scaling & Macro Accuracy**: Refactored algorithmic nutrition estimation in `server/nutritionEstimator.ts` to ensure strict thermodynamic Atwater energy balance ($4 \times \text{Protein} + 4 \times \text{Carbs} + 9 \times \text{Fat} \approx \text{Calories}$, ratio $0.96\text{--}1.01$).
- **Expanded Nutritional Ingredient Database**: Added nutrient density curves for whole grains (oats, barley, quinoa), legumes/tofu, seeds and nuts (walnuts, chia, almonds), dairy/milks, and fresh fruits.
- **Serving Size Scaling Verification**: Audited multi-serving batch estimation (1, 2, 4, 6, 8, 12 servings) with linear nutrient scaling, integer rounding variance $\le 4\,\text{kcal}$, and lossless Obsidian YAML frontmatter serialization.
- **Express 5 Full-Stack Backend**: Upgraded to `express ^5.2.1` and `@types/express ^5.0.6` with updated path-to-regexp v8 SPA fallback routing (`/{*splat}`).
- **Configurable CSP Frame Ancestors**: Added dynamic support for `CSP_FRAME_ANCESTORS` in `server/securityHeaders.ts` and `.env.example`, enabling flexible iframe embedding in Obsidian webviews and preview environments while keeping strict clickjacking protection by default.
- **Tooling & Dependency Updates**: Upgraded `@google/genai` to `^2.19.0`, `esbuild` to `^0.28.2`, and CI checkout to `actions/checkout@v7`.
- **Hermetic Offline Testing**: Refactored `recipeGrabber.ts` and test suite to run hermetically without external network latency or API rate limits.

### `v0.2.3`
- **Inline Markdown Instruction Rendering**: Instruction steps now correctly parse and render inline Markdown (bold `**`, italics `*`, code `\``) for clean typographic emphasis.
- **Clean Metadata Display**: Removed redundant duplicate servings sub-headers under ingredients, keeping primary serving counts in the top metadata panel.
- **Recipe-Aware Footer Recommendations**: Replaced hardcoded universal serving advice with smart, category-aware recommendations (e.g., cooling instructions for sourdough bread, warm serving notes for soups).
- **Strict Food Display Metadata Compliance**: Configured the Food Display panel to render strictly when actual presentation/food-display metadata exists, omitting the panel entirely when absent to prevent fabrication.
- **Robust Print & PDF Pagination**: Enhanced print media styles with page-break protection (`break-inside: avoid`) across ingredients, instructions, and cards for publication-quality PDF exports.

### `v0.2.2`
- **Vault Intelligence & Metadata Recovery**: Health assessment engine for legacy recipes with missing prep/cook times or servings yields, powered by multi-tier AI recovery (`gemini-3.7-flash` / `gemini-3.1-flash-lite`) and offline heuristic calculations.
- **Shared Markdown Ingredient Rendering**: Centralized `renderIngredientLine` across import, editing, and note generation pipelines to guarantee uniform ingredient formatting.
- **Centralized Model Configuration**: Strict type safety and model identification in `server/modelConfig.ts` for web scraping, nutrition analysis, and vault intelligence recovery.
- **Production Server & Asset Bundling**: Resolved production static file serving and client asset resolution in `dist/server.cjs`.
- **Obsidian Markdown & Wikilink Preservation**: Enhanced fidelity tests verifying that bidirectional wikilinks (`[[Entity]]`, `[[Target|Alias]]`), custom YAML properties, callouts, and timers remain intact across all operations.
- **Reverse Proxy Hardening**: Configured Express `trust proxy` and IP validation to protect against rate-limiter bypass.

### `v0.2.1`
- **Resilient Nutrition Estimation Cascade**: Implemented primary model `gemini-3.6-flash` with automatic fallback to `gemini-3.1-flash-lite`, and a final offline algorithmic culinary estimator when external AI services or quotas are unavailable.
- **Obsidian Wikilink Cleansing**: Stripped `[[Entity|Alias]]` and `[[Entity]]` syntax prior to AI nutritional analysis, preventing prompt confusion while preserving note syntax.
- **Error Handling & Quota Resilience**: Replaced misleading measurement validation errors with transparent AI availability handling and graceful fallback calculations.
- **Frontmatter Validation**: Strict validation of nutrition macro fields (`calories`, `protein`, `carbohydrates`, `fat`, `fiber`, `sodium`) before serializing to YAML.
- **Metadata & Note Integrity**: Full preservation of recipe tags, callouts, instructions, notes, and custom frontmatter properties.

### `v0.2.0`
- **Interactive Wikilink Intelligence**: Full support for wikilinks (`[[Ingredient]]`, `[[Target|Alias]]`) with contextual modal previews, backlink recipe exploration, and direct Markdown note creation in the vault.
- **AI Nutrition Estimation**: Server-side macro analysis powered by Gemini 3.7 Flash, calculating calories, protein, carbs, fat, fiber, and sodium per serving with YAML frontmatter persistence.
- **Obsidian Theme System**: Support for Obsidian Dark, Warm Parchment, and Nordic Sage themes with responsive contrast.
- **Official Rebranding**: Fully rebranded to **The Kitchen Codex** with modernized vault navigation and metadata.

### `v0.1.1`
- **Fractional & Unicode Scaling**: Enhanced portion scaling engine with full unicode fraction support (`½`, `⅓`, `⅔`, `¼`, `¾`, `⅛`, `⅜`, `⅝`, `⅞`) and mixed-fraction parsing across recipes.
- **Recipe Editor Continuity**: Preserved note IDs and file system handles seamlessly when toggling between visual form and raw Markdown editor tabs.
- **Audio Chime Reliability**: Added Web Audio API context auto-resumption for timer alerts on mobile devices and background tabs.
- **Security & SSRF Hardening**: Implemented comprehensive hex-encoded IPv6 and IPv4-mapped IPv6 validation for the recipe importer backend.

### `v0.1.0`
- Initial release featuring native Obsidian vault synchronization, interactive cooking mode, AI web recipe grabber, weekly meal planning, and smart grocery list generation.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/kryptek2000/The-Kitchen-Codex/issues).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

