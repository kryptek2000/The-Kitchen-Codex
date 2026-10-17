// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShisoEntryProvider, useShiso } from '../../src/application-ui/shisoEntryPoints';
import { explicitServingCount, ShisoModal } from '../../src/components/ShisoModal';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from '../../src/schema/generatedRecipe';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';
import { generatedDraftToObsidianRecipe, saveGeneratedRecipeToVault } from '../../src/application/createForMe';
import { parseObsidianRecipeMarkdown } from '../../src/utils/markdownParser';

beforeAll(async () => {
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
});
afterEach(() => cleanup());

const FIRST: GeneratedRecipeDraft = {
  title: 'Spicy Mexican Chicken Casserole',
  description: 'A baked, spicy casserole.',
  servings: 6,
  ingredients: [{ amount: 2, unit: 'lb', name: 'chicken', preparation: 'cubed' }, { amount: 1, unit: 'cup', name: 'cheese' }],
  steps: [{ text: 'Season and brown the chicken.' }, { text: 'Bake until cooked through.' }],
  cuisine: 'Mexican',
};
const SECOND: GeneratedRecipeDraft = {
  ...FIRST,
  servings: 8,
  ingredients: [{ amount: 3, unit: 'lb', name: 'chicken', preparation: 'cubed' }, { amount: 1, unit: 'cup', name: 'black beans' }],
  steps: [{ text: 'Season and brown the chicken with beans.' }, { text: 'Bake until cooked through.' }],
};

function Host({ network, save }: { network: NetworkAdapter; save: (draft: GeneratedRecipeDraft, provenance: GeneratedRecipeProvenance) => Promise<void> }) {
  return <ShisoEntryProvider><HostInner network={network} save={save} /></ShisoEntryProvider>;
}
function HostInner({ network, save }: { network: NetworkAdapter; save: (draft: GeneratedRecipeDraft, provenance: GeneratedRecipeProvenance) => Promise<void> }) {
  const shiso = useShiso();
  return <>
    <button onClick={() => shiso.open('create')}>open create</button>
    <ShisoModal isOpen={shiso.isOpen} onClose={shiso.close} network={network} recipe={null} nutritionSession={null} nutritionRows={[]} nutritionReviewRows={[]} nutritionSummary={null} nutritionUnsaved={false} onSaveCreatedDraft={save} />
  </>;
}

function generatedNetwork() {
  const bodies: unknown[] = [];
  let call = 0;
  const network = {
    post: async (path: string, body: unknown) => {
      if (path !== '/api/recipes/generate') return { status: 404, ok: false, data: {} };
      bodies.push(body);
      const draft = call++ === 0 ? FIRST : SECOND;
      return { status: 200, ok: true, data: { draft, provenance: { generated: true, providerId: 'openrouter', model: 'selected-model' } } };
    },
    get: async () => ({ status: 404, ok: false, data: undefined }),
    request: async () => ({ status: 404, ok: false, data: undefined }),
  } as unknown as NetworkAdapter;
  return { network, bodies };
}

async function send(text: string) {
  await waitFor(() => expect(screen.queryByTestId('shiso-progress')).toBeNull());
  fireEvent.change(screen.getByPlaceholderText(/Describe the recipe/), { target: { value: text } });
  fireEvent.click(screen.getByText('Send'));
}

describe('Create with Shiso', () => {
  it('extracts only explicit bounded serving counts from natural language', () => {
    expect(explicitServingCount('Create a casserole for six people.')).toBe(6);
    expect(explicitServingCount('Change it to eight servings.')).toBe(8);
    expect(explicitServingCount('Make it spicier.')).toBeUndefined();
    expect(explicitServingCount('Serve 120.')).toBeUndefined();
  });

  it('creates and refines the same validated draft, then saves only on explicit action', async () => {
    const { network, bodies } = generatedNetwork();
    const files = new Map<string, string>();
    const vault = {
      listMarkdownFiles: async () => Array.from(files.keys()).map((path) => ({ path, name: path.split('/').pop()! })),
      readText: async (path: string) => files.get(path) ?? '',
      writeText: async (path: string, content: string) => { files.set(path, content); },
      delete: async (path: string) => { files.delete(path); },
      exists: async (path: string) => files.has(path),
    } as unknown as VaultAdapter;
    const save = vi.fn(async (draft: GeneratedRecipeDraft, provenance: GeneratedRecipeProvenance) => {
      await saveGeneratedRecipeToVault(vault, generatedDraftToObsidianRecipe({ draft, provenance }));
    });
    render(<Host network={network} save={save} />);
    fireEvent.click(screen.getByText('open create'));
    expect(screen.getByText('Create with Shiso')).toBeTruthy();

    await send('Create a spicy Mexican chicken casserole for six people.');
    await screen.findByTestId('shiso-created-recipe-draft');
    expect(save).not.toHaveBeenCalled();
    expect((bodies[0] as { constraints?: { servings?: number } }).constraints?.servings).toBe(6);
    expect(screen.getByDisplayValue('Spicy Mexican Chicken Casserole')).toBeTruthy();

    await send('Make it dairy-free, add black beans, and change it to eight servings.');
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect((bodies[1] as { currentDraft?: GeneratedRecipeDraft }).currentDraft).toMatchObject({ title: FIRST.title, servings: 6 });
    expect((bodies[1] as { prompt?: string }).prompt).toContain('eight servings');
    expect((bodies[1] as { constraints?: { servings?: number } }).constraints?.servings).toBe(8);
    await screen.findAllByText(/I updated the existing/);
    expect((screen.getByLabelText(/Ingredients · one per line/) as HTMLTextAreaElement).value).toContain('black beans');
    expect(screen.getByDisplayValue('8')).toBeTruthy();
    expect(await screen.findAllByText(/nothing has been saved/i)).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.queryByTestId('shiso-progress')).toBeNull());
    fireEvent.click(screen.getByTestId('shiso-created-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ servings: 8, ingredients: expect.arrayContaining([expect.objectContaining({ name: 'black beans' })]) }), expect.objectContaining({ providerId: 'openrouter', model: 'selected-model' }));
    expect(files.size).toBe(1);
    const [savedPath, savedMarkdown] = Array.from(files.entries())[0];
    const reopened = parseObsidianRecipeMarkdown(savedMarkdown, savedPath.split('/').pop()!, savedPath);
    expect(reopened.title).toBe('Spicy Mexican Chicken Casserole');
    expect(reopened.ingredients.some((ingredient) => ingredient.name.includes('black beans'))).toBe(true);
    expect(reopened.instructions.some((step) => step.text.includes('beans'))).toBe(true);
    expect(reopened.servings).toBe(8);
    expect(await screen.findByText(/saved successfully to the Vault/i)).toBeTruthy();
  });

  it('keeps the draft after failed save and supports undo and discard without writing', async () => {
    const { network } = generatedNetwork();
    const save = vi.fn(async () => { throw new Error('collision'); });
    render(<Host network={network} save={save} />);
    fireEvent.click(screen.getByText('open create'));
    await send('Create a spicy chicken casserole for six.');
    await screen.findByTestId('shiso-created-recipe-draft');
    await send('Add black beans and use eight servings.');
    await screen.findAllByText(/I updated the existing/);
    expect((screen.getByLabelText(/Ingredients · one per line/) as HTMLTextAreaElement).value).toContain('black beans');
    await waitFor(() => expect(screen.queryByTestId('shiso-progress')).toBeNull());
    fireEvent.click(screen.getByText('Undo refinement'));
    await waitFor(() => expect((screen.getByLabelText(/Ingredients · one per line/) as HTMLTextAreaElement).value).not.toContain('black beans'));
    expect(screen.getByDisplayValue('6')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('shiso-progress')).toBeNull());
    fireEvent.click(screen.getByTestId('shiso-created-save'));
    await screen.findByRole('alert');
    expect(screen.getByTestId('shiso-created-recipe-draft')).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Discard draft'));
    expect(screen.queryByTestId('shiso-created-recipe-draft')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
