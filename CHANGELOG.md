# Changelog

All notable changes to **The Kitchen Codex** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
