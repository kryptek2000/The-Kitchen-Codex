# Release Notes — The Kitchen Codex v0.3.0

**Release Date:** September 2, 2026  
**Tag / Version:** `v0.3.0`  
**License:** MIT

---

## 🌟 Overview

The Kitchen Codex `v0.3.0` — **Trustworthy Data & Recipe Relationships** — turns
nutrition into a deterministic, auditable, local-first capability and adds a
derived ingredient relationship layer. It introduces a curated food reference,
deterministic whole-recipe nutrition estimation with provenance/confidence
metadata and a bounded cache, plus an ingredient relationship index that powers
"Similar Recipes" and "Recipes Using This Ingredient" — all computed locally
with no network or AI.

This is a **foundation and data-quality** release. Semantic search, embeddings,
full knowledge-graph, USDA API integration, Ask My Kitchen, smart meal planning
and smart shopping aggregation remain future milestones.

---

## 🚀 Key Highlights & Changes

### 1. 🧬 Nutrition Intelligence (Trustworthy Data Layer)

- **Provenance & confidence**: every nutrition block now records a provenance
  `source` and an application-assigned `confidence`, so deterministic, AI, and
  offline-heuristic results are never conflated as nutrition truth.
- **Deterministic measurement normalization** (`src/utils/measurements.ts`):
  exact mass / volume / count / unknown classification with only
  mathematically valid conversions. No invented ingredient densities.
- **Curated local food reference** (`src/data/foodReference.ts`): an explicit,
  deeply-frozen, representative-per-100g reference for a curated set of foods,
  where densities and count weights each carry a confidence and note. Unknown
  foods remain unknown rather than being guessed.
- **Deterministic food-aware nutrition estimation**: a pure engine computes
  whole-recipe nutrition from the curated reference when coverage is fully
  resolvable — it is selected only when *every* measurable ingredient resolves.
  Otherwise the existing AI → offline cascade runs untouched (zero-fabrication
  preserved).
- **Deterministic nutrition cache**: a bounded, in-memory LRU cache memoizes an
  eligible deterministic whole-recipe result keyed only on nutrition-relevant
  inputs (never the requested serving count). A cache hit is a performance
  optimization only — non-authoritative, preserves `source = database` and
  confidence, never caches a partial/heuristic result, and is immutable.
- **Serving invariance**: the requested serving display count never changes the
  cached deterministic total; per-serving arithmetic stays in the existing
  `nutritionForServings` contract.

### 2. 🔗 Recipe Relationships

- **Ingredient relationship index** (`src/utils/recipeRelationships.ts`): a pure,
  deterministic derived-data layer exposing ingredient → recipes, recipe →
  ingredient profile, shared ingredients, and a transparent Jaccard similarity
  score. No AI, embeddings, or TF-IDF — an auditable foundation.
- **Recipes Using This Ingredient**: tap any ingredient on a recipe to see the
  other recipes that use the exact same ingredient identity.
- **Similar Recipes**: a compact panel ranks recipes by shared-ingredient
  similarity (score descending, deterministic tie-break), excluding the current
  recipe and zero-overlap results.
- **Conservative, exact identity**: no substring/fuzzy matching, so `egg` never
  matches `eggplant`, `butter` ≠ `peanut butter`, `cream` ≠ `cream cheese`,
  `garlic` ≠ `garlic powder`, `chicken breast` ≠ `chicken thigh`, `all-purpose
  flour` ≠ `almond flour`.
- **Wikilink target authority**: an ingredient link's identity derives from its
  target (`[[Chicken Breast|chicken]]` ≠ `[[Chicken Thigh|chicken]]`), while
  alias/display text is preserved for display only.
- **No auto-generated ingredient wikilinks**: relationship derivation never
  creates, edits, or rewrites wikilinks, aliases, ingredient text, or Markdown.
  All relationship queries are local (no network / no AI).

---

## 🧪 Verification & Test Results

- **Vitest Suite**: 415 / 415 tests passing across 27 test files (`100% green`).
- **TypeScript Typecheck**: `tsc --noEmit` passed with 0 errors.
- **Production Build**: `vite build` + `esbuild` clean into `dist/server.cjs`.
- Relationship layer and UI verified: index lifecycle, similar-recipe selection,
  ingredient lookup (including the egg/eggplant false-positive and wikilink
  target-authority cases), immutability, and local/no-AI behavior.

---

## ⚠️ Known Limitations

- The **offline culinary heuristic** fallback still emits estimated numbers with
  `source = offline_heuristic` and `confidence = low`; it is clearly labelled and
  is never cached as a deterministic result. Deterministic (`database`) output is
  produced only when every measurable ingredient is fully resolvable.
- Descriptor/size and singular/plural ingredient variants are intentionally kept
  distinct (e.g. `large eggs` vs `eggs`, `egg` vs `eggs`) to favour safety over
  recall. No plural stemming or adjective collapsing.
- No semantic search, embeddings, full knowledge-graph, USDA database API
  integration, browser E2E suite, Ask My Kitchen, smart meal planning, or smart
  shopping aggregation yet — those remain future milestones.

---

## 📦 Release

`v0.3.0` is a data-layer + relationships release. `v0.2.7` (and all earlier
releases) remain unchanged.
