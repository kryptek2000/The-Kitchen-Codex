// @vitest-environment jsdom
/**
 * PR #66 B1–B3 — real App composition regressions.
 *
 * These tests mount the application shell and its real ShisoEntryProvider.
 * The network boundary is a deterministic disposable fixture; no provider,
 * Vault, or personal profile is contacted.
 */
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import App from '../../src/App';
import { ShisoEntryProvider, useShiso } from '../../src/application-ui/shisoEntryPoints';
import { getStarterVaultRecipes } from '../../src/data/starterVault';
import { recipeIdentityOf } from '../../src/core/shiso/saveAuthorization';
import {
  SHISO_CONVERSATION_STORAGE_VERSION,
  shisoConversationStorageKey,
} from '../../src/application/shisoConversationPersistence';

function OpenShiso({ source = 'global' }: { readonly source?: 'global' | 'recipe' | 'create' }) {
  const shiso = useShiso();
  useEffect(() => {
    shiso.open(source);
  }, [shiso, source]);
  return null;
}

function renderApp(openGlobal = true, source: 'global' | 'recipe' | 'create' = 'global') {
  return render(
    <ShisoEntryProvider>
      {openGlobal && <OpenShiso source={source} />}
      <App />
    </ShisoEntryProvider>,
  );
}

async function send(message: string) {
  const composer = await waitFor(() => {
    const globalComposer = screen.queryByPlaceholderText('Ask Shiso…');
    const createComposer = screen.queryByPlaceholderText('Describe the recipe, or request a change to this draft…');
    if (globalComposer !== null) return globalComposer as HTMLTextAreaElement;
    if (createComposer !== null) return createComposer as HTMLTextAreaElement;
    throw new Error('SHISO composer is not mounted');
  });
  fireEvent.change(composer, { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(`Reply: ${message}`);
}

async function sendCreate(message: string) {
  const composer = await screen.findByPlaceholderText('Describe the recipe, or request a change to this draft…') as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByTestId('shiso-created-recipe-draft');
}

function seedRecipeConversation(recipe: ReturnType<typeof getStarterVaultRecipes>[number], question: string, answer: string) {
  const key = `recipe:${recipeIdentityOf(recipe)}`;
  window.localStorage.setItem(shisoConversationStorageKey(key), JSON.stringify({
    version: SHISO_CONVERSATION_STORAGE_VERSION,
    conversationKey: key,
    messages: [
      { role: 'user', text: question },
      { role: 'assistant', text: answer },
    ],
    entries: [
      { key: 'u1', role: 'user', text: question, tools: [] },
      { key: 'a1', role: 'assistant', text: answer, tools: [] },
    ],
    findings: [],
    nextSeq: 2,
    updatedAt: '2026-11-24T00:00:00.000Z',
  }));
}

async function openRecipe(recipe: ReturnType<typeof getStarterVaultRecipes>[number]) {
  if (screen.queryByRole('heading', { level: 1, name: recipe.title }) === null) {
    const cardHeading = (await screen.findAllByRole('heading', { name: recipe.title }))
      .find((heading) => heading.tagName.toLowerCase() === 'h3');
    const recipeButton = cardHeading?.querySelector('button')
      ?? screen.getByRole('button', { name: recipe.title });
    fireEvent.click(recipeButton);
  }
  fireEvent.click(await screen.findByTestId('recipe-shiso-entry'));
  await screen.findByText(new RegExp(`Context: ${recipe.title}`));
}

async function openFullWorkspace() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open full SHISO workspace' }));
  await screen.findByRole('heading', { level: 1, name: /SHISO/ });
}

describe('PR #66 conversation integrity at the App composition boundary', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '#/');
    vi.spyOn(window, 'fetch').mockImplementation(async (_input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { user_message?: string } : {};
      if (String(_input).includes('/api/recipes/generate')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            draft: {
              title: 'Disposable fixture recipe',
              description: 'A deterministic test draft.',
              ingredients: [{ name: 'water', amount: 1, unit: 'cup' }],
              steps: [{ text: 'Stir and serve.' }],
            },
            provenance: { generated: true, providerId: 'fixture', model: 'fixture-model' },
          }),
        } as unknown as Response;
      }
      const message = body.user_message ?? 'message';
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          ok: true,
          kind: 'reply',
          text: `Reply: ${message}`,
          proposals: [],
          model_invocations_used: 1,
          tool_calls_used: 0,
        }),
      } as unknown as Response;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('B1: alternates compact/full presentations without splitting or clobbering the transcript', async () => {
    const first = renderApp();
    await send('message A');

    fireEvent.click(await screen.findByRole('button', { name: 'Open full SHISO workspace' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Chat with SHISO' })).toBeTruthy();
    expect(screen.getByText('message A')).toBeTruthy();
    expect(screen.getByText('Reply: message A')).toBeTruthy();
    await send('message B');

    fireEvent.click(screen.getByRole('button', { name: 'Return to compact chat' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Chat with Shiso' })).toBeTruthy();
    expect(screen.getByText('Reply: message B')).toBeTruthy();
    await send('message C');
    expect(screen.getByText('Reply: message A')).toBeTruthy();
    expect(screen.getByText('Reply: message B')).toBeTruthy();
    expect(screen.getByText('Reply: message C')).toBeTruthy();

    first.unmount();
    renderApp();
    await waitFor(() => {
      expect(screen.getByText('Reply: message A')).toBeTruthy();
      expect(screen.getByText('Reply: message B')).toBeTruthy();
      expect(screen.getByText('Reply: message C')).toBeTruthy();
    });
    const transcript = [...document.querySelectorAll('[data-shiso-bubble]')].map((node) => node.textContent?.trim());
    expect(transcript).toEqual([
      'message A', 'Reply: message A',
      'message B', 'Reply: message B',
      'message C', 'Reply: message C',
    ]);
    expect(document.querySelectorAll('.kc-shiso-workspace, .fixed.inset-0.z-50').length).toBe(1);
  }, 30000);

  it('B2: deleting the active transcript does not suppress the next conversation after reload', async () => {
    const first = renderApp();
    await send('message to delete');
    fireEvent.click(await screen.findByRole('button', { name: 'Open full SHISO workspace' }));
    const deleteButton = await screen.findByRole('button', { name: 'Delete General conversation' });
    fireEvent.click(deleteButton);
    fireEvent.click(await screen.findByTestId('shiso-history-delete-confirm'));

    await waitFor(() => expect(screen.queryByText('message to delete')).toBeNull());
    await send('message after deletion');
    expect(screen.getByText('Reply: message after deletion')).toBeTruthy();

    first.unmount();
    renderApp();
    await waitFor(() => {
      expect(screen.getByText('Reply: message after deletion')).toBeTruthy();
      expect(screen.queryByText('Reply: message to delete')).toBeNull();
    });
  }, 30000);

  it('B2: deleting an active recipe transcript creates a persistable recipe instance', async () => {
    const recipe = getStarterVaultRecipes().find((item) => item.title === 'Classic Roman Carbonara');
    expect(recipe).toBeTruthy();
    seedRecipeConversation(recipe!, 'old recipe question', 'old recipe answer');

    const first = renderApp(false);
    await openRecipe(recipe!);
    await openFullWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /Delete .*Carbonara/ }));
    fireEvent.click(await screen.findByTestId('shiso-history-delete-confirm'));
    await waitFor(() => expect(screen.queryByText('old recipe question')).toBeNull());
    await send('new recipe question');

    first.unmount();
    renderApp(false);
    await openRecipe(recipe!);
    await openFullWorkspace();
    expect(await screen.findByText('new recipe question')).toBeTruthy();
    expect(screen.getByText('Reply: new recipe question')).toBeTruthy();
    expect(screen.queryByText('old recipe question')).toBeNull();
  }, 30000);

  it('B2: deleting an active create-context transcript creates a persistable create instance', async () => {
    const first = renderApp(true, 'create');
    await openFullWorkspace();
    expect(await screen.findByRole('heading', { level: 1, name: 'Create with SHISO' })).toBeTruthy();
    await sendCreate('old create question');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Recipe creation' }));
    fireEvent.click(await screen.findByTestId('shiso-history-delete-confirm'));
    await waitFor(() => expect(screen.queryByText('old create question')).toBeNull());
    await sendCreate('new create question');

    first.unmount();
    renderApp(true, 'create');
    await openFullWorkspace();
    expect(await screen.findByText('new create question')).toBeTruthy();
    await waitFor(() => expect(document.body.textContent ?? '').toContain('Disposable fixture recipe draft'));
    expect(screen.queryByText('old create question')).toBeNull();
  }, 30000);

  it('B2: preserves a fresh global instance across recipe navigation and reload', async () => {
    const recipe = getStarterVaultRecipes().find((item) => item.title === 'Classic Roman Carbonara');
    expect(recipe).toBeTruthy();

    const first = renderApp();
    await send('global before delete');
    await openFullWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete General conversation' }));
    fireEvent.click(await screen.findByTestId('shiso-history-delete-confirm'));
    await waitFor(() => expect(screen.queryByText('global before delete')).toBeNull());
    await send('global fresh instance');
    fireEvent.click(screen.getByRole('button', { name: 'Back to My Recipe Vault' }));
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: /SHISO/ })).toBeNull());

    await openRecipe(recipe!);
    await openFullWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Back to My Recipe Vault' }));
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: /SHISO/ })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Chat with SHISO' }));
    await screen.findByRole('heading', { level: 1, name: /SHISO/ });
    await send('global after roundtrip');

    first.unmount();
    renderApp();
    await openFullWorkspace();
    expect(await screen.findByText('global fresh instance')).toBeTruthy();
    expect(screen.getByText('Reply: global after roundtrip')).toBeTruthy();
  }, 30000);

  it('B2: New conversation clears the displayed recipe transcript and persists in that recipe context', async () => {
    const recipe = getStarterVaultRecipes().find((item) => item.title === 'Classic Roman Carbonara');
    expect(recipe).toBeTruthy();
    seedRecipeConversation(recipe!, 'existing recipe question', 'existing recipe answer');

    const first = renderApp(false);
    await openRecipe(recipe!);
    await openFullWorkspace();
    expect(await screen.findByText('existing recipe question')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(screen.queryByText('existing recipe question')).toBeNull());
    await send('fresh recipe session');

    first.unmount();
    renderApp(false);
    await openRecipe(recipe!);
    await openFullWorkspace();
    expect(await screen.findByText('fresh recipe session')).toBeTruthy();
    expect(screen.getByText('Reply: fresh recipe session')).toBeTruthy();
    expect(screen.queryByText('existing recipe question')).toBeNull();
  }, 30000);

  it('B3: a recipe-scoped resume is released when the App context changes recipes', async () => {
    const a = getStarterVaultRecipes().find((recipe) => recipe.title === 'Classic Roman Carbonara');
    const b = getStarterVaultRecipes().find((recipe) => recipe.title === 'Artisan Sourdough Boule');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    const stored = (question: string, answer: string) => JSON.stringify({
      version: SHISO_CONVERSATION_STORAGE_VERSION,
      conversationKey: '',
      messages: [
        { role: 'user', text: question },
        { role: 'assistant', text: answer },
      ],
      entries: [
        { key: 'u1', role: 'user', text: question, tools: [] },
        { key: 'a1', role: 'assistant', text: answer, tools: [] },
      ],
      findings: [],
      nextSeq: 1,
      updatedAt: '2026-11-24T00:00:00.000Z',
    });
    const aKey = `recipe:${recipeIdentityOf(a!)}`;
    const bKey = `recipe:${recipeIdentityOf(b!)}`;
    const aStored = JSON.parse(stored('Question from recipe A', 'Answer from recipe A')) as Record<string, unknown>;
    const bStored = JSON.parse(stored('Question from recipe B', 'Answer from recipe B')) as Record<string, unknown>;
    aStored.conversationKey = aKey;
    bStored.conversationKey = bKey;
    window.localStorage.setItem(shisoConversationStorageKey(aKey), JSON.stringify(aStored));
    window.localStorage.setItem(shisoConversationStorageKey(bKey), JSON.stringify(bStored));

    renderApp(false);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(screen.getByRole('button', { name: 'Classic Roman Carbonara' }));
    fireEvent.click(await screen.findByTestId('recipe-shiso-entry'));
    expect(await screen.findByText(/Context: Classic Roman Carbonara/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Open full SHISO workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /Resume .*Carbonara/ }));
    expect(await screen.findByText('Question from recipe A')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to My Recipe Vault' }));
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: 'Chat with SHISO' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Artisan Sourdough Boule' }));
    fireEvent.click(await screen.findByTestId('recipe-shiso-entry'));
    expect(await screen.findByText(/Context: Artisan Sourdough Boule/)).toBeTruthy();
    expect(screen.getByText('Question from recipe B')).toBeTruthy();
    expect(screen.queryByText('Question from recipe A')).toBeNull();
  }, 30000);
});
