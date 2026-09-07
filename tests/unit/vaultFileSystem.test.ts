/**
 * The Kitchen Codex — scanVaultDirectory behavior (Phase 4C3A).
 *
 * After refactoring scanVaultDirectory to reuse the shared pure classifier, verify
 * the BROWSER-only decoration still happens exactly as before:
 *   - recipes/notes still get `fileHandle` attached (logical identity is now owned
 *     by the pure classifier's filePath; the handle is added afterwards),
 *   - images are still indexed into the asset registry,
 *   - recipe/note/meal-plan/shopping-list counts and classification are unchanged.
 *
 * Uses an in-memory File-System-Access-shaped double (no real picker/browser DOM).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanVaultDirectory } from '../../src/utils/vaultFileSystem';
import { vaultAssets } from '../../src/utils/vaultAssets';

const RECIPE_MD = `---
title: "Lasagna"
cuisine: "Italian"
category: "Dinner"
tags:
  - food/recipes
---
# Lasagna
## 🥘 Ingredients
- 1 cup flour
## 🍳 Instructions
1. Bake.
`;

const NOTE_MD = `---
title: "Garlic Guide"
tags:
  - technique
---
# Garlic Guide
Reference note.
`;

const MEAL_PLAN_MD = `---\n---\n\n## Monday\n- **Dinner**: [[Lasagna]]\n`;
const SHOPPING_LIST_MD = `---\n---\n\n## Produce\n- [ ] tomatoes\n`;

class MockFile {
  readonly kind = 'file' as const;
  constructor(public readonly name: string, private readonly content: string | Blob) {}
  async getFile(): Promise<{ text(): Promise<string> } | Blob> {
    const content = this.content;
    if (typeof content === 'string') {
      return { text: async () => content };
    }
    return content;
  }
}

class MockDir {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MockFile | MockDir>();
  constructor(public readonly name: string) {}
  async *values(): AsyncGenerator<MockFile | MockDir> {
    for (const child of this.children.values()) yield child;
  }
}

function buildMock(files: Record<string, string | Blob>): MockDir {
  const root = new MockDir('Vault Root');
  for (const [rel, content] of Object.entries(files)) {
    const segments = rel.replace(/\\/g, '/').split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i];
      let next = dir.children.get(name);
      if (!(next instanceof MockDir)) {
        next = new MockDir(name);
        dir.children.set(name, next);
      }
      dir = next;
    }
    dir.children.set(segments[segments.length - 1], new MockFile(segments[segments.length - 1], content));
  }
  return root;
}

describe('scanVaultDirectory (refactored, Phase 4C3A)', () => {
  beforeEach(() => vaultAssets.clear());
  afterEach(() => vaultAssets.clear());

  it('still attaches fileHandle to recipes/notes, indexes images, and preserves counts', async () => {
    const imageBlob = new Blob(['img-bytes'], { type: 'image/png' });
    const root = buildMock({
      'Recipes/Italian/Lasagna.md': RECIPE_MD,
      'Notes/Garlic Guide.md': NOTE_MD,
      'Meal Plan.md': MEAL_PLAN_MD,
      'Shopping List.md': SHOPPING_LIST_MD,
      'Assets/photo.png': imageBlob,
    });

    const result = await scanVaultDirectory(root);

    expect(result.recipes).toHaveLength(1);
    // Phase 4C3B: filePath is now canonicalized to a vault-root-relative path
    // (no longer prefixed with the directory-handle name).
    expect(result.recipes[0].filePath).toBe('Recipes/Italian/Lasagna.md');
    expect(result.recipes[0].fileName).toBe('Lasagna.md');
    // Browser decoration is still attached AFTER classification (logical identity
    // is filePath; fileHandle is the platform optimization).
    expect(result.recipes[0].fileHandle).toBeTruthy();

    expect(result.notes).toHaveLength(1);
    expect(result.notes?.[0].fileHandle).toBeTruthy();

    expect(result.mealPlan?.[0].dayName).toBe('Monday');
    expect(result.mealPlan?.[0].dinner?.recipeTitle).toBe('Lasagna');
    expect(result.shoppingList?.[0].category).toBe('Produce');

    // Image indexing (browser responsibility) is unchanged.
    expect(vaultAssets.get('Assets/photo.png')).toBeTruthy();
  });
});
