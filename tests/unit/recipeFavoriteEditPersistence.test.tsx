// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import { rebaseRecipeOntoLatest } from '../../src/application/recipeWriteCoordination';
import { saveRecipeWithVaultAdapter, scanVaultMarkdown } from '../../src/application/vaultRecipe';
import { createVaultSessionAuthority } from '../../src/core/vaultSession';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { ObsidianRecipe } from '../../src/types';
import { parseObsidianRecipeMarkdown, serializeRecipePreservingContent } from '../../src/utils/markdownParser';

const FAVORITE_MD = `---
title: Favorite Test Stew
tags:
  - test
  - stew
isFavorite: true
rating: 4
rating_source: personal
custom_flag: keep-me
prep_time: 5 mins
cook_time: 10 mins
servings: 2
---
# Favorite Test Stew

Intro prose that should survive.

## Ingredients
- 1 cup stock

## Instructions
1. Simmer gently.

## Notes & Variations
Original notes.

## Secret Section
Custom body content that must survive.
`;

const NON_FAVORITE_MD = FAVORITE_MD.replace('isFavorite: true', 'isFavorite: false');

function recipeFrom(markdown: string): ObsidianRecipe {
  return parseObsidianRecipeMarkdown(markdown, 'Favorite Test Stew.md', 'Recipes/Favorite Test Stew.md');
}

function makeNetwork(): NetworkAdapter {
  return {
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    getBytes: vi.fn(),
  } as unknown as NetworkAdapter;
}

function fakeVault(files: Record<string, string> = {}) {
  const writes: { path: string; content: string }[] = [];
  const store = { ...files };
  const vault: VaultAdapter = {
    async listMarkdownFiles() {
      return Object.keys(store).map((p) => ({ path: p, name: p.split('/').pop() as string }));
    },
    async readText(path: string) {
      const content = store[path];
      if (content === undefined) {
        const error = new Error(`Vault file not found: ${path}`);
        Object.defineProperty(error, 'name', { value: 'NotFoundError' });
        throw error;
      }
      return content;
    },
    async writeText(path: string, content: string) {
      writes.push({ path, content });
      store[path] = content;
    },
    async delete(path: string) {
      delete store[path];
    },
    async exists(path: string) {
      return Object.prototype.hasOwnProperty.call(store, path);
    },
  };
  return { vault, writes, store };
}

async function editAndSave(
  initial: ObsidianRecipe,
  field: 'ingredients' | 'instructions' | 'notes',
  value: string
): Promise<ObsidianRecipe> {
  const onSave = vi.fn(async () => {});
  const { container } = render(
    <RecipeEditorModal
      initialRecipe={initial}
      network={makeNetwork()}
      onSave={onSave}
      onClose={() => {}}
    />
  );
  const selector =
    field === 'ingredients'
      ? 'textarea[placeholder*="2 tbsp"]'
      : field === 'instructions'
        ? 'textarea[placeholder*="Prep ingredients"]'
        : 'textarea[placeholder*="Storage tips"]';
  const textarea = container.querySelector(selector) as HTMLTextAreaElement | null;
  expect(textarea).toBeTruthy();
  fireEvent.change(textarea!, { target: { value } });
  fireEvent.click(screen.getByText('Save Obsidian Note'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return (onSave.mock.calls[0] as unknown[])[0] as ObsidianRecipe;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Favorite persistence across structured recipe edits', () => {
  it('1. favorite survives editing notes', async () => {
    const saved = await editAndSave(recipeFrom(FAVORITE_MD), 'notes', 'Updated notes.');
    expect(saved.isFavorite).toBe(true);
    const serialized = serializeRecipePreservingContent(saved);
    expect(serialized).toContain('isFavorite: true');
    expect(parseObsidianRecipeMarkdown(serialized, saved.fileName, saved.filePath).isFavorite).toBe(true);
  });

  it('2. favorite survives editing ingredients', async () => {
    const saved = await editAndSave(recipeFrom(FAVORITE_MD), 'ingredients', '- 2 cups stock\n- 1 carrot');
    expect(saved.isFavorite).toBe(true);
    expect(serializeRecipePreservingContent(saved)).toContain('isFavorite: true');
  });

  it('3. favorite survives editing instructions', async () => {
    const saved = await editAndSave(recipeFrom(FAVORITE_MD), 'instructions', '1. Simmer for twenty minutes.');
    expect(saved.isFavorite).toBe(true);
    expect(serializeRecipePreservingContent(saved)).toContain('isFavorite: true');
  });

  it('4. favorite and rating both survive saving', async () => {
    const saved = await editAndSave(recipeFrom(FAVORITE_MD), 'notes', 'Updated notes.');
    expect(saved.isFavorite).toBe(true);
    expect(saved.rating).toBe(4);
    const serialized = serializeRecipePreservingContent(saved);
    expect(serialized).toContain('isFavorite: true');
    expect(serialized).toContain('rating: 4');
    const reloaded = parseObsidianRecipeMarkdown(serialized, saved.fileName, saved.filePath);
    expect(reloaded.isFavorite).toBe(true);
    expect(reloaded.rating).toBe(4);
  });

  it('5. favorite survives save, reload, and a fresh parse (restart equivalent)', async () => {
    const saved = await editAndSave(recipeFrom(FAVORITE_MD), 'notes', 'Restart persistence.');
    const { vault } = fakeVault();
    await saveRecipeWithVaultAdapter(vault, saved);
    const reloaded = await scanVaultMarkdown(vault);
    expect(reloaded.recipes).toHaveLength(1);
    expect(reloaded.recipes[0].isFavorite).toBe(true);
    expect(reloaded.recipes[0].rating).toBe(4);
    const reparsed = parseObsidianRecipeMarkdown(
      reloaded.recipes[0].rawMarkdown,
      reloaded.recipes[0].fileName,
      reloaded.recipes[0].filePath
    );
    expect(reparsed.isFavorite).toBe(true);
  });

  it('6. explicit favorite removal still persists', async () => {
    const latest = recipeFrom(FAVORITE_MD);
    const base = recipeFrom(FAVORITE_MD);
    const desired = { ...base, isFavorite: false };
    const rebased = rebaseRecipeOntoLatest(latest, base, desired);
    expect(rebased.isFavorite).toBe(false);

    const { vault } = fakeVault();
    await saveRecipeWithVaultAdapter(vault, rebased);
    const reloaded = await scanVaultMarkdown(vault);
    expect(reloaded.recipes[0].isFavorite).toBe(false);
  });

  it('7. a non-favorite remains a non-favorite after an unrelated edit', async () => {
    const saved = await editAndSave(recipeFrom(NON_FAVORITE_MD), 'notes', 'Still not favorite.');
    expect(saved.isFavorite).toBe(false);
    expect(serializeRecipePreservingContent(saved)).toContain('isFavorite: false');
  });

  it('8. unrelated frontmatter and custom Markdown body content survive', async () => {
    const initial = recipeFrom(FAVORITE_MD);
    expect(initial.rawMarkdown).toContain('## Secret Section');
    const saved = await editAndSave(initial, 'notes', 'Updated notes.');
    expect(saved.rawMarkdown).toContain('## Secret Section');
    const serialized = serializeRecipePreservingContent(saved);
    expect(serialized).toContain('custom_flag: keep-me');
    expect(serialized).toContain('## Secret Section');
    expect(serialized).toContain('Custom body content that must survive.');
    expect(serialized).toContain('Intro prose that should survive.');
    expect(serialized).toContain('Updated notes.');
  });

  it('9. an editor save cannot overwrite a newer favorite change using stale state', async () => {
    const initial = recipeFrom(NON_FAVORITE_MD);
    const saved = await editAndSave(initial, 'notes', 'Editor save from stale state.');
    // A newer favorite toggle landed while the editor was open.
    const latest = { ...initial, isFavorite: true };
    const rebased = rebaseRecipeOntoLatest(latest, initial, saved);
    expect(rebased.isFavorite).toBe(true);
  });

  it('10. the Vault write authority refuses an inactive/superseded session', async () => {
    const authority = createVaultSessionAuthority();
    const first = await authority.commitTransition(authority.beginTransition('filesystem'), () => {});
    const sessionA = first.session!;
    const lease = authority.beginWrite(sessionA);
    expect(lease).not.toBeNull();
    lease!.release();

    const transitionToB = authority.beginTransition('filesystem');
    expect(authority.beginWrite(sessionA)).toBeNull();

    const second = await authority.commitTransition(transitionToB, () => {});
    expect(second.accepted).toBe(true);
    expect(authority.isCurrent(sessionA)).toBe(false);
    expect(authority.beginWrite(sessionA)).toBeNull();
    expect(authority.beginWrite(second.session!)).not.toBeNull();
  });

  it('11. an explicit Raw Markdown favorite change remains authoritative', async () => {
    const initial = recipeFrom(FAVORITE_MD);
    const onSave = vi.fn(async () => {});
    render(
      <RecipeEditorModal
        initialRecipe={initial}
        network={makeNetwork()}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByText('Raw .md'));
    const raw = await waitFor(() => {
      const area = document.getElementById('raw-markdown-editor') as HTMLTextAreaElement | null;
      expect(area).toBeTruthy();
      expect(area!.value).toContain('isFavorite: true');
      return area!;
    });
    fireEvent.change(raw, { target: { value: raw.value.replace('isFavorite: true', 'isFavorite: false') } });
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = (onSave.mock.calls[0] as unknown[])[0] as ObsidianRecipe;
    expect(saved.isFavorite).toBe(false);
  });

  it('12. an editor save cannot re-favorite a newer removal using stale state', async () => {
    const initial = recipeFrom(FAVORITE_MD);
    const saved = await editAndSave(initial, 'notes', 'Editor save from an initially-favorite state.');
    // A newer removal landed while the editor was open.
    const latest = { ...initial, isFavorite: false };
    const rebased = rebaseRecipeOntoLatest(latest, initial, saved);
    expect(rebased.isFavorite).toBe(false);
  });
});
