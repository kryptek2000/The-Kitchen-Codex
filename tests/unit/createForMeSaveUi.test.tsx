// @vitest-environment jsdom
/**
 * SHISO-C1.6-F1 — edited draft fields survive the explicit Save path.
 * The onSaveRecipe adapter is a stub; no Vault or provider is touched.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CreateForMeModal } from '../../src/components/CreateForMeModal';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { ObsidianRecipe } from '../../src/types';

const DRAFT = {
  title: 'Traditional Southern Cornbread Dressing',
  description: 'Savory holiday dressing.',
  servings: 8,
  prepTime: '20 mins',
  cookTime: '45 mins',
  totalTime: '65 mins',
  cuisine: 'Southern',
  course: 'Side',
  tags: ['holiday', 'side'],
  ingredients: [
    {
      amount: 4,
      unit: 'cup',
      name: 'crumbled cornbread',
      preparation: 'day-old',
      optional: true,
    },
    { name: 'salt' },
  ],
  steps: [
    { text: 'Combine the cornbread and aromatics.', timerMinutes: 10 },
    { text: 'Bake until golden.' },
  ],
};

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => undefined });
});

afterEach(cleanup);

function network(): NetworkAdapter {
  return {
    post: async () => ({
      status: 200,
      ok: true,
      data: { draft: DRAFT, provenance: { generated: true, providerId: 'chatgpt-plan', model: 'gpt-test' } },
    }),
    get: async () => ({ status: 404, ok: false, data: {} }),
    request: async () => ({ status: 404, ok: false, data: {} }),
  } as unknown as NetworkAdapter;
}

describe('Create for Me save integration', () => {
  it('shows trustworthy in-progress feedback before the validated draft exists', async () => {
    let resolvePost!: (value: { status: number; ok: boolean; data: unknown }) => void;
    const pending = new Promise<{ status: number; ok: boolean; data: unknown }>((resolve) => {
      resolvePost = resolve;
    });
    const deferredNetwork = {
      post: async () => pending,
      get: async () => ({ status: 404, ok: false, data: {} }),
      request: async () => ({ status: 404, ok: false, data: {} }),
    } as unknown as NetworkAdapter;
    render(
      <CreateForMeModal
        isOpen
        network={deferredNetwork}
        onClose={() => {}}
        onSaveRecipe={async () => {}}
      />
    );
    fireEvent.change(document.getElementById('create-me-prompt') as HTMLTextAreaElement, {
      target: { value: 'Create a simple dinner.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await screen.findByText(/Generating recipe/i);
    expect(screen.getByText(/Waiting for a validated draft/i)).toBeTruthy();
    expect(screen.queryByLabelText('Recipe title')).toBeNull();
    resolvePost({
      status: 200,
      ok: true,
      data: { draft: DRAFT, provenance: { generated: true, providerId: 'chatgpt-plan', model: 'gpt-test' } },
    });
    // Validated drafts open as a read-only Signature Recipe Card.
    await screen.findByText('Traditional Southern Cornbread Dressing');
    expect(screen.queryByLabelText('Recipe title')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Edit Recipe$/i }));
    await screen.findByLabelText('Recipe title');
  });

  it('saves the edited draft with preparation, optional, timer, and metadata preserved', async () => {
    const onSave = vi.fn(async (_recipe: ObsidianRecipe) => {});
    const onClose = vi.fn();
    render(
      <CreateForMeModal
        isOpen
        network={network()}
        onClose={onClose}
        onSaveRecipe={onSave}
      />
    );

    fireEvent.change(document.getElementById('create-me-prompt') as HTMLTextAreaElement, {
      target: { value: 'Create a Southern cornbread dressing for eight people.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await screen.findByText('Traditional Southern Cornbread Dressing');
    fireEvent.click(screen.getByRole('button', { name: /^Edit Recipe$/i }));
    await screen.findByLabelText('Recipe title');

    fireEvent.change(screen.getByLabelText('Recipe title'), {
      target: { value: 'Edited Cornbread Dressing' },
    });
    fireEvent.change(screen.getByLabelText('Ingredient 1 preparation'), {
      target: { value: 'toasted' },
    });
    fireEvent.change(screen.getByLabelText('Step 1 timer minutes'), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByLabelText('Recipe description'), {
      target: { value: 'Edited description.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save to Vault/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const recipe = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(recipe.title).toBe('Edited Cornbread Dressing');
    expect(recipe.description).toBe('Edited description.');
    expect(recipe.servings).toBe(8);
    expect(recipe.prepTime).toBe('20 mins');
    expect(recipe.cookTime).toBe('45 mins');
    expect(recipe.ingredients[0].note).toBe('toasted');
    expect(recipe.instructions[0].timerMinutes).toBe(12);
    expect(recipe.rawMarkdown).toContain('(optional)');
    expect(recipe.rawMarkdown).toContain('toasted');
    expect(recipe.rawMarkdown).toMatch(/12\s*(?:minutes|mins|min)/i);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps edits through card → edit → card → edit and saves only on explicit Save', async () => {
    const onSave = vi.fn(async (_recipe: ObsidianRecipe) => {});
    const onClose = vi.fn();
    render(
      <CreateForMeModal
        isOpen
        network={network()}
        onClose={onClose}
        onSaveRecipe={onSave}
      />
    );
    fireEvent.change(document.getElementById('create-me-prompt') as HTMLTextAreaElement, {
      target: { value: 'Create a Southern cornbread dressing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await screen.findByText('Traditional Southern Cornbread Dressing');
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Edit Recipe$/i }));
    fireEvent.change(screen.getByLabelText('Recipe title'), {
      target: { value: 'Edited Round Trip Dressing' },
    });
    fireEvent.change(screen.getByLabelText('Ingredient 1 preparation'), {
      target: { value: 'toasted lightly' },
    });

    // Back to the read-only card: the edited content is shown, nothing is saved yet.
    fireEvent.click(screen.getByRole('button', { name: /View recipe/i }));
    expect(screen.getByText('Edited Round Trip Dressing')).toBeTruthy();
    expect(screen.getByText('toasted lightly')).toBeTruthy();
    expect(screen.queryByLabelText('Recipe title')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();

    // Re-entering the editor preserves the same edits.
    fireEvent.click(screen.getByRole('button', { name: /^Edit Recipe$/i }));
    expect((screen.getByLabelText('Recipe title') as HTMLTextAreaElement).value).toBe('Edited Round Trip Dressing');
    expect((screen.getByLabelText('Ingredient 1 preparation') as HTMLInputElement).value).toBe('toasted lightly');

    fireEvent.click(screen.getByRole('button', { name: /Save to Vault/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const recipe = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(recipe.title).toBe('Edited Round Trip Dressing');
    expect(recipe.ingredients[0].note).toBe('toasted lightly');
    expect(recipe.instructions[0].timerMinutes).toBe(10);
    expect(recipe.rawMarkdown).toContain('(optional)');
  });

  it('keeps the original numeric quantity through friendly display, editing, and save', async () => {
    const fractional = {
      ...DRAFT,
      title: 'Fraction Dressing',
      ingredients: [{ amount: 1.25, unit: 'cup', name: 'crumbled cornbread' }],
      steps: [{ text: 'Combine.' }],
    };
    const fractionalNetwork = {
      ...network(),
      post: async () => ({
        status: 200,
        ok: true,
        data: { draft: fractional, provenance: { generated: true, providerId: 'chatgpt-plan', model: 'gpt-test' } },
      }),
    } as unknown as NetworkAdapter;
    const onSave = vi.fn(async (_recipe: ObsidianRecipe) => {});
    render(
      <CreateForMeModal isOpen network={fractionalNetwork} onClose={() => {}} onSaveRecipe={onSave} />
    );
    fireEvent.change(document.getElementById('create-me-prompt') as HTMLTextAreaElement, {
      target: { value: 'Create a dressing with 1.25 cups of cornbread.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await screen.findByText('1¼');
    expect(screen.queryByLabelText('Ingredient 1 amount')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Edit Recipe$/i }));
    expect((screen.getByLabelText('Ingredient 1 amount') as HTMLInputElement).value).toBe('1.25');
    fireEvent.click(screen.getByRole('button', { name: /Save to Vault/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const recipe = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(recipe.ingredients[0].amount).toBe(1.25);
    expect(recipe.rawMarkdown).toContain('1.25');
  });
});
