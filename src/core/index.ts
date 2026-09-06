/**
 * The Kitchen Codex — Shared Core Export Contract (Phase 4A).
 *
 * This is a TYPES/EXPORT boundary, NOT a relocation of implementation files.
 * It re-exports only modules confirmed platform-neutral: pure TypeScript that
 * depends only on the JS/TS standard library (`console`, `Date`, `URL`, etc.)
 * and never on:
 *   - DOM / browser APIs (window, document, navigator, localStorage,
 *     sessionStorage, indexedDB, File System Access API, Blob, URL.createObjectURL)
 *   - React / React DOM / src/components
 *   - Node built-ins (fs, path, process, Buffer) or Express
 *   - the Gemini SDK (@google/genai) or any other provider SDK
 *   - the vault filesystem/asset layer (vaultFileSystem, vaultAssets,
 *     imageHelper, audioAlert, cardExportColors)
 *
 * Future surfaces (standalone, Obsidian plugin, mobile/PWA) may `import` from
 * this path (e.g. `src/core`) without pulling in browser/platform modules.
 *
 * Existing import paths (src/utils/*, src/schema/*, src/data/*) are unchanged;
 * this barrel is additive and requires no import churn to existing callers.
 *
 * NOTE on `RecipeMetadata`: `src/schema/recipeSchema.ts` and
 * `src/utils/recipeRelationships.ts` each declare a distinct type named
 * `RecipeMetadata` (canonical v1 metadata vs. culinary-similarity metadata).
 * The schema's canonical v1 `RecipeMetadata` is re-exported explicitly here so
 * the binding is unambiguous; the relationship layer's same-named type remains
 * reachable via `src/utils/recipeRelationships` and is intentionally NOT
 * surfaced from the core barrel.
 */

// Canonical Schema v1 (recipeSchema, recipeValidator, legacyAdapter) via barrel.
export * from '../schema';

// Canonical v1 metadata is authoritative for the `RecipeMetadata` name.
// Order matters: after this explicit export, the relationship layer's same-named
// star-export is skipped, so the core barrel resolves `RecipeMetadata` to the
// canonical schema type.
export type { RecipeMetadata } from '../schema/recipeSchema';

// Deterministic measurement & nutrition math.
export * from '../utils/measurements';
export * from '../utils/nutrition';

// Deterministic food-aware whole-recipe nutrition engine (was server-owned).
export * from './deterministicNutrition';

// Provider-neutral AI contracts (AiProvider, AiCapabilities, AiJsonSchema, ...).
// These are pure contracts only; provider SDKs/registries stay server-side.
export * from './ai/types';

// Markdown parsing/serialization + Obsidian note/meal-plan/shopping codecs.
export * from '../utils/markdownParser';

// Derived relationship / culinary-similarity foundation.
export * from '../utils/recipeRelationships';

// Ask My Kitchen deterministic stack.
export * from '../utils/kitchenSearch';
export * from '../utils/kitchenIntent';
export * from '../utils/kitchenIntentPolicy';
export * from '../utils/kitchenQueryInterpreter';
export * from '../utils/kitchenAnswer';
export * from '../utils/kitchenRanking';
export * from '../utils/kitchenDiscovery';
export * from '../utils/askMyKitchenUi';

// Vault Intelligence deterministic logic (health assessment / metadata merge).
export * from '../utils/vaultIntelligence';

// Curated food reference.
export * from '../data/foodReference';
