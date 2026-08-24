# 🍳 The Kitchen Codex `v0.2.3`

[![Version](https://img.shields.io/badge/version-0.2.3-amber.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A markdown-native recipe manager, meal planner, culinary knowledge base, and interactive cooking companion built specifically for **Obsidian** vaults. Read, edit, sync, and cook directly from your Obsidian `.md` recipe collection with YAML frontmatter, Dataview tags, wikilinks (`[[Ingredient]]`, `[[Target|Alias]]`), AI nutrition estimation, dynamic portion scaling, multi-step cooking timers, and AI-powered web recipe scraping.

<p align="center">
  <img src="./src/assets/images/app_screenshot_1787266053153.jpg" alt="The Kitchen Codex UI Screenshot" width="100%" />
</p>

---

## ✨ Features

### 📂 Native Obsidian Vault Synchronization
- **Direct Vault Connection**: Connect local Obsidian vault folders using the File System Access API (`showDirectoryPicker`) for direct reading and writing.
- **Drag-and-Drop Vault Importer**: Drag individual `.md` notes or entire vault folders to import and parse recipes instantly.
- **Bi-directional Compatibility**: Export, download, or copy standardized Obsidian Markdown files with YAML frontmatter, wikilinks (`[[Garlic]]`), Dataview tags, and callouts (`> [!tip]`).

### 🧠 Interactive Wikilink Intelligence & Note Knowledge Base
- **Live Wikilink Previews**: Click any `[[Ingredient Note]]` or `[[Target|Alias]]` across recipe cards, ingredient lists, instructions, or callouts to preview contextual notes.
- **Backlink Discovery**: Explore all recipes in your vault that share the same ingredient or technique.
- **Direct Note Authoring**: Create new Markdown knowledge notes directly into your Obsidian `Notes/` folder with YAML frontmatter from the preview modal.

### 🥗 AI Nutritional Estimation
- **Multi-Tiered Nutritional Analysis**: High-precision nutritional estimation with a resilient multi-model fallback cascade: `gemini-3.6-flash` (primary), `gemini-3.1-flash-lite` (secondary fallback), and an offline culinary algorithmic estimator.
- **Wikilink & Measurement Normalization**: Obsidian wikilinks (`[[Ingredient|Alias]]`) and Unicode/ASCII fractions are cleaned and parsed for consistent analysis.
- **YAML Frontmatter Persistence**: Validates and serializes calories, protein, carbohydrates, fat, dietary fiber, and sodium per serving directly into note frontmatter for Dataview interoperability.
- **Portion Scaling Compatibility**: Dynamically calculates and displays macro values scaled to current portions.

### 🌐 AI Web Recipe Grabber
- **URL & Text Importer**: Paste any recipe website URL, raw HTML, or recipe text to convert it into a structured Obsidian markdown note.
- **Structured Schema & AI Parsing**: Extracts recipe metadata, ingredient amounts, wikilink entities, cooking step durations, and tips using Gemini AI and Schema.org JSON-LD extraction.

### 🍳 Distraction-Free Interactive Cooking Mode & Recipe Cards
- **Step-by-Step Focus**: Fullscreen hands-free cooking assistant with high-contrast typography.
- **Automatic Timer Detection**: Detects durations in instruction steps (e.g., *"Simmer for 15 minutes"*) with one-click countdown timers, background alerts, and celebration audio chimes.
- **Markdown-Enabled Instruction Steps**: Instruction steps support clean inline Markdown rendering for bold, italic, and inline code formatting.
- **Publication-Quality Recipe Cards & PDF Export**: Export standalone printable recipe cards with customizable Obsidian themes, clean layout wrapping, and strict print pagination.

### ⚖️ Dynamic Portion & Serving Scaling
- Scale recipes seamlessly from **0.5× to 4×** with intelligent fraction and measurement arithmetic (e.g., `1 1/2 cups` scales accurately to `3 cups`).
- Metric and Imperial unit support.

### 📊 Dual Layouts: Visual Grid & Dataview Table
- **Recipe Grid**: Rich card view displaying cook time, difficulty, calorie counts, and tag pills.
- **Dataview Table View**: Structured tabular view inspired by the Obsidian Dataview plugin, supporting multi-column sorting and filtering by cuisine, difficulty, total time, and tags.

### 📅 Weekly Meal Planner & Synchronized Grocery List
- **7-Day Meal Scheduler**: Organize Breakfast, Lunch, and Dinner slots across the week.
- **Smart Grocery List**: Automatically syncs ingredients from scheduled meals into categorized shopping checklists (Produce, Pantry, Dairy, Meat, etc.). When the meal plan is empty, the grocery list stays clean.
- **Obsidian Checklist Export**: One-click copy formatted Markdown task checklists (`- [ ]`) ready to paste into your Obsidian daily notes.

### 🎨 Obsidian Community Themes
- Switch between custom Obsidian themes:
  - **Obsidian Default Dark** (Classic Obsidian aesthetic)
  - **Warm Parchment** (Warm editorial parchment paper aesthetic)
  - **Nordic Sage** (Calm Scandinavian herbal & pine aesthetic)

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Motion (`motion/react`), Lucide React, Canvas Confetti
- **Markdown & Frontmatter**: `js-yaml`, `react-markdown`, `remark-gfm`
- **Backend API**: Express.js, TypeScript (`tsx`), Node.js
- **AI Integration**: Google Gen AI SDK (`@google/genai`) with Gemini 3.7 Flash for recipe extraction
- **Build System**: Vite 6, `esbuild`

---

## 🚀 Local Installation & Setup (Standalone)

This app is a self-contained full-stack Node.js + React application that runs locally on your machine (macOS, Windows, or Linux) with **no cloud platform, container service, or AI Studio requirement**.

### Prerequisites

Ensure you have the following installed on your machine:
- **Node.js** (v18.0.0 or higher): [Download Node.js](https://nodejs.org/)
- **npm** (bundled with Node.js) or **pnpm** / **yarn** / **bun**
- **Git**: [Download Git](https://git-scm.com/)
- *(Optional)* **Obsidian**: [Download Obsidian](https://obsidian.md/) to connect your existing recipe vaults.
- *(Optional)* **Gemini API Key**: If you want to use the AI-powered web recipe scraping feature, get a free key from [Google AI Studio](https://aistudio.google.com/). The rest of the app (vault sync, cooking mode, timers, meal planning, offline recipe editing) works 100% locally with zero external API dependencies.

---

### Step-by-Step Local Setup

#### 1. Clone the repository
```bash
git clone https://github.com/kryptek2000/The-Kitchen-Codex.git
cd The-Kitchen-Codex
```

#### 2. Install dependencies
```bash
npm install
```
*(or `bun install` / `pnpm install`)*

#### 3. Set up environment variables
Copy the template configuration file:
```bash
cp .env.example .env
```

Open `.env` in any text editor and add your API key (optional, only needed for AI web recipe scraping):
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

#### 4. Run the local development server
```bash
npm run dev
```

The application will start on **`http://localhost:3000`**. Open this URL in Chrome, Edge, Brave, or Safari.

---

### 📦 Production Build & Local Hosting

To build an optimized production bundle and run it as a lightweight background service or home server (e.g., Raspberry Pi, Unraid, Home Assistant, or local desktop):

```bash
# 1. Build frontend assets and server bundle
npm run build

# 2. Start the production server
npm run start
```
The production server will listen on `http://localhost:3000`.

---

### 💡 Connecting Your Local Obsidian Vault

When running locally in a Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Opera, Arc):
1. Click **Connect Vault** in the top navigation bar.
2. Choose **Select Vault Directory** (uses the native browser File System Access API).
3. Select your local Obsidian vault folder (or a `Recipes/` subfolder).
4. Grant read/write permission when prompted.
5. All recipe edits, new recipes, and web-scraped recipes will write directly to your local `.md` files on disk!

---

## 📝 Obsidian Recipe Markdown Format

Recipes in this manager follow standard Obsidian Markdown with YAML frontmatter:

```markdown
---
title: Creamy Tuscan Garlic Chicken
tags:
  - recipe
  - dinner
  - italian
  - high-protein
cuisine: Italian
category: Dinner
servings: 4
prep_time: 15 mins
cook_time: 25 mins
difficulty: Medium
calories: 520
source: "https://example.com/tuscan-chicken"
rating: 5
favorite: true
---

# Creamy Tuscan Garlic Chicken

> [!summary] Rich, restaurant-quality pan-seared chicken bathed in a velvety sun-dried tomato garlic sauce.

## 🛒 Ingredients

- [ ] 2 large [[Chicken Breast|chicken breasts]], sliced horizontally
- [ ] 1 tbsp [[Olive Oil]]
- [ ] 4 cloves [[Garlic]], minced
- [ ] 1/2 cup [[Heavy Cream]]
- [ ] 1/2 cup [[Chicken Broth]]
- [ ] 1/2 cup [[Sun-Dried Tomatoes]], chopped
- [ ] 2 cups [[Baby Spinach]]
- [ ] 1/2 cup [[Parmesan Cheese]], freshly grated

## 🔪 Instructions

1. Season chicken with salt, pepper, and Italian seasoning.
2. Heat olive oil in a skillet over medium-high heat. Sear chicken for 5 minutes per side until golden. Remove and set aside.
3. Add minced garlic to the pan and saute for 1 minute until fragrant.
4. Pour in chicken broth, heavy cream, and sun-dried tomatoes. Simmer for 3 minutes.
5. Add baby spinach and parmesan cheese; stir for 2 minutes until wilted.
6. Return chicken to skillet and simmer for 5 minutes until sauce thickens and chicken reaches 165°F.

> [!tip] Serve over warm fettuccine pasta or roasted garlic mashed potatoes.
```

---

## 📜 Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Starts the Express backend and Vite development server on port 3000 |
| `npm run build` | Builds the React frontend and bundles the Node server with `esbuild` |
| `npm run start` | Runs the production-bundled server (`dist/server.cjs`) |
| `npm run lint` | Runs TypeScript type checking (`tsc --noEmit`) |
| `npm run clean` | Cleans up the `dist` build directory |

---

## 📌 Changelog

### `v0.2.3` (Current Release)
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

