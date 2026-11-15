import { describe, expect, it } from 'vitest';
import {
  parseObsidianRecipeMarkdown,
  serializeRecipePreservingContent,
} from '../../src/utils/markdownParser';
import type { ObsidianRecipe } from '../../src/types';
import { saveRecipeWithVaultAdapter } from '../../src/application/vaultRecipe';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';

const CUSTOM = `---
title: Custom Stew
cuisine: Test
custom_flag: keep-me
multiline: |
  line one
  line two
cover: Assets/cover.png
rating: 3
---
# Custom Stew

Intro prose with an [ordinary link](https://example.com) and ![intro](Assets/intro.png).

> [!tip] Chef's Tip
> Keep the lid on.

## Ingredients
- 1 cup stock
- 2 carrots

## Equipment
- Dutch oven
- ![Equipment photo](Assets/gear.png)

## Instructions
1. Simmer gently.

## Storage Notes
Keeps for 3 days.

## Custom Footer
Arbitrary **rich** content that must survive.
`;

function parse(markdown: string): ObsidianRecipe {
  return parseObsidianRecipeMarkdown(markdown, 'Custom Stew.md', 'Custom Stew.md');
}

function expectPreserved(markdown: string): void {
  expect(markdown).toContain('custom_flag: keep-me');
  expect(markdown).toContain('multiline: |');
  expect(markdown).toContain('line one');
  expect(markdown).toContain('line two');
  expect(markdown).toContain('cover: Assets/cover.png');
  expect(markdown).toContain('Intro prose with an [ordinary link](https://example.com) and ![intro](Assets/intro.png).');
  expect(markdown).toContain("> [!tip] Chef's Tip");
  expect(markdown).toContain('> Keep the lid on.');
  expect(markdown).toContain('## Equipment');
  expect(markdown).toContain('![Equipment photo](Assets/gear.png)');
  expect(markdown).toContain('## Storage Notes');
  expect(markdown).toContain('Keeps for 3 days.');
  expect(markdown).toContain('## Custom Footer');
  expect(markdown).toContain('Arbitrary **rich** content that must survive.');
  expect(markdown).toContain('1 cup stock');
  expect(markdown).toContain('Simmer gently.');
}

describe('R6 canonical content preservation', () => {
  it('preserves unknown headings, prose, metadata, embeds and formatting across a title/rating/favorite/servings save', () => {
    const recipe = parse(CUSTOM);
    const saved = serializeRecipePreservingContent({
      ...recipe,
      title: 'Renamed Stew',
      rating: 5,
      isFavorite: true,
      servings: 6,
    });
    expectPreserved(saved);
    expect(saved).toContain('title: Renamed Stew');
    expect(saved).toContain('# Renamed Stew');
    expect(saved).toContain('rating: 5');
    expect(saved).toContain('isFavorite: true');
    expect(saved).toContain('servings: 6');
    expect(saved).not.toContain('# Custom Stew');
  });

  it('preserves unknown content after editing supported ingredients/instructions/notes', () => {
    const recipe = parse(CUSTOM);
    const saved = serializeRecipePreservingContent({
      ...recipe,
      ingredients: [{ name: 'stock', original: '3 cups stock', amount: 3, unit: 'cups' }],
      instructions: [{ stepNumber: 1, text: 'Simmer for twenty minutes.' }],
      notes: 'Updated notes.',
    });
    expect(saved).toContain('3 cups stock');
    expect(saved).toContain('Simmer for twenty minutes.');
    expect(saved).toContain('Updated notes.');
    expect(saved).toContain('## Equipment');
    expect(saved).toContain('![Equipment photo](Assets/gear.png)');
    expect(saved).toContain('## Custom Footer');
    expect(saved).toContain('Arbitrary **rich** content that must survive.');
    expect(saved).toContain('![intro](Assets/intro.png)');
  });

  it('patches an intentionally edited callout without dropping custom body content', () => {
    const recipe = parse(CUSTOM);
    const saved = serializeRecipePreservingContent({
      ...recipe,
      callouts: [{ type: 'warning', title: 'Updated Tip', content: 'Use low heat.' }],
    });
    expect(saved).toContain('> [!warning] Updated Tip');
    expect(saved).toContain('> Use low heat.');
    expect(saved).not.toContain("> [!tip] Chef's Tip");
    expect(saved).toContain('## Equipment');
    expect(saved).toContain('## Custom Footer');
    expect(saved).toContain('Arbitrary **rich** content that must survive.');
    expect(saved).toContain('![intro](Assets/intro.png)');
  });

  it('preserves unknown content across a second parse/save round trip', () => {
    const first = serializeRecipePreservingContent({ ...parse(CUSTOM), rating: 4 });
    const second = serializeRecipePreservingContent({ ...parse(first), rating: 2 });
    expectPreserved(second);
    expect(second).toContain('rating: 2');
  });

  it('preserves CRLF newline style in the retained body and frontmatter', () => {
    const crlf = CUSTOM.replace(/\n/g, '\r\n');
    const saved = serializeRecipePreservingContent({ ...parse(crlf), rating: 1 });
    expect(saved).toContain('\r\n');
    expect(saved).not.toMatch(/(?<!\r)\n/);
    expect(saved).toContain('## Equipment');
    expect(saved).toContain('Arbitrary **rich** content that must survive.');
  });

  it('does not preserve a stale image when the structured image is explicitly changed', () => {
    const recipe = parse(CUSTOM);
    const saved = serializeRecipePreservingContent({ ...recipe, image: 'Assets/new-cover.png' });
    expect(saved).toContain('image: Assets/new-cover.png');
    expect(saved).not.toContain('image: Assets/cover.png');
    // The custom cover alias is retained as custom metadata; the primary image
    // field is the one that changed.
    expect(saved).toContain('cover: Assets/cover.png');
  });
});

describe('R6 failed persistence safety', () => {
  it('leaves the original recipe byte-identical when the Vault write fails', async () => {
    const files = new Map([['Custom Stew.md', CUSTOM]]);
    const vault = {
      readText: async (path: string) => files.get(path) as string,
      writeText: async () => {
        throw new Error('simulated Vault write failure');
      },
      exists: async (path: string) => files.has(path),
      listMarkdownFiles: async () => [{ path: 'Custom Stew.md', name: 'Custom Stew.md' }],
      delete: async () => {},
    } as unknown as VaultAdapter;
    const recipe = { ...parse(CUSTOM), title: 'Changed Title' };
    await expect(saveRecipeWithVaultAdapter(vault, recipe)).rejects.toThrow(/simulated Vault write failure/i);
    expect(files.get('Custom Stew.md')).toBe(CUSTOM);
  });
});
