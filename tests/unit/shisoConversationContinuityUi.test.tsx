// @vitest-environment jsdom
/**
 * SHISO-C1 — durable conversation UI: close/reopen, app-restart restoration,
 * recipe A → B → A navigation, and explicit retry without duplicate messages.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { ShisoModal } from '../../src/components/ShisoModal';
import { ShisoEntryProvider, useShiso } from '../../src/application-ui/shisoEntryPoints';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => null });
});

afterEach(cleanup);

function memorySettings(): SettingsAdapter {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key) as never,
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
}

interface TestRecipe {
  readonly title: string;
  readonly id: string;
  readonly filePath: string;
  readonly fileName: string;
}

const RECIPE_A: TestRecipe = { title: 'Recipe A', id: 'a', filePath: 'Recipes/A.md', fileName: 'A.md' };
const RECIPE_B: TestRecipe = { title: 'Recipe B', id: 'b', filePath: 'Recipes/B.md', fileName: 'B.md' };

function reply(text: string) {
  return {
    status: 200,
    ok: true,
    data: {
      ok: true,
      kind: 'reply',
      text,
      proposals: [],
      model_invocations_used: 1,
      tool_calls_used: 0,
    },
  };
}

function replyNetwork(texts: string[]): { adapter: NetworkAdapter; calls: () => number } {
  let index = 0;
  let count = 0;
  const adapter = {
    post: vi.fn(async () => {
      count += 1;
      return reply(texts[Math.min(index++, texts.length - 1)] ?? 'Okay.');
    }),
    get: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
    request: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
  } as unknown as NetworkAdapter;
  return { adapter, calls: () => count };
}

function Host(props: {
  readonly settings: SettingsAdapter;
  readonly network: NetworkAdapter;
  readonly initialRecipe?: TestRecipe;
}) {
  return (
    <ShisoEntryProvider>
      <HostInner {...props} />
    </ShisoEntryProvider>
  );
}

function HostInner({ settings, network, initialRecipe }: {
  readonly settings: SettingsAdapter;
  readonly network: NetworkAdapter;
  readonly initialRecipe?: TestRecipe;
}) {
  const shiso = useShiso();
  const [recipe, setRecipe] = useState<TestRecipe | null>(initialRecipe ?? RECIPE_A);
  return (
    <>
      <button onClick={() => shiso.open('recipe')}>open shiso</button>
      <button onClick={shiso.close}>close shiso</button>
      {initialRecipe === undefined && (
        <>
          <button onClick={() => setRecipe(RECIPE_A)}>recipe A</button>
          <button onClick={() => setRecipe(RECIPE_B)}>recipe B</button>
        </>
      )}
      <ShisoModal
        isOpen={shiso.isOpen}
        onClose={shiso.close}
        network={network}
        recipe={recipe === null ? null : {
          title: recipe.title,
          id: recipe.id,
          filePath: recipe.filePath,
          fileName: recipe.fileName,
          servings: 4,
          ingredients: [{ name: 'Salt' }],
          instructions: [{ text: 'Cook.' }],
        }}
        nutritionSession={null}
        nutritionRows={[]}
        nutritionReviewRows={[]}
        nutritionSummary={null}
        nutritionUnsaved={false}
        settings={settings}
      />
    </>
  );
}

async function openAndWait() {
  fireEvent.click(screen.getByText('open shiso'));
  await waitFor(() => expect(screen.queryByTestId('shiso-conversation-restoring')).toBeNull());
  await waitFor(() => expect(screen.getByPlaceholderText('Ask Shiso…')).toBeTruthy());
}

async function send(message: string) {
  const box = screen.getByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: message } });
  fireEvent.click(screen.getByText('Send'));
}

async function waitForText(text: string | RegExp) {
  await waitFor(() => expect(document.body.textContent ?? '').toMatch(
    typeof text === 'string' ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : text,
  ), { timeout: 15000 });
}

describe('SHISO-C1 — durable conversations', () => {
  it('keeps the transcript across close/reopen and an application restart', async () => {
    const settings = memorySettings();
    const network = replyNetwork(['First durable answer.']);
    const first = render(<Host settings={settings} network={network.adapter} />);
    await openAndWait();
    await send('First durable question.');
    await waitForText('First durable answer.');

    fireEvent.click(screen.getByText('close shiso'));
    await openAndWait();
    expect(document.body.textContent).toContain('First durable answer.');

    first.unmount();
    render(<Host settings={settings} network={network.adapter} />);
    await openAndWait();
    await waitForText('First durable answer.');
    expect(document.body.textContent).toContain('First durable question.');
    // Restoring a conversation never performs work automatically.
    expect(network.calls()).toBe(1);
  });

  it('restores Recipe A after navigating to Recipe B and back', async () => {
    const settings = memorySettings();
    const network = replyNetwork(['Answer from A.', 'Answer from B.']);
    render(<Host settings={settings} network={network.adapter} />);
    await openAndWait();
    await send('Question A.');
    await waitForText('Answer from A.');

    fireEvent.click(screen.getByText('recipe B'));
    await waitFor(() => expect(document.body.textContent).not.toContain('Answer from A.'));
    await send('Question B.');
    await waitForText('Answer from B.');

    fireEvent.click(screen.getByText('recipe A'));
    await waitForText('Answer from A.');
    expect(document.body.textContent).not.toContain('Answer from B.');
  });

  it('preserves the user message and retries after a provider failure without duplicating it', async () => {
    const settings = memorySettings();
    let calls = 0;
    const adapter = {
      post: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 200,
            ok: true,
            data: {
              ok: false,
              code: 'provider_timeout',
              message: 'The AI provider took too long to answer this message.',
              aiAttempted: true,
            },
          };
        }
        return reply('Recovered after retry.');
      }),
      get: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
      request: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
    } as unknown as NetworkAdapter;

    render(<Host settings={settings} network={adapter} />);
    await openAndWait();
    await send('Please keep this message.');
    await waitFor(() => expect(screen.getByTestId('shiso-retry')).toBeTruthy());
    expect((document.body.textContent ?? '').match(/Please keep this message\./g) ?? []).toHaveLength(1);

    fireEvent.click(screen.getByTestId('shiso-retry'));
    await waitForText('Recovered after retry.');
    expect((document.body.textContent ?? '').match(/Please keep this message\./g) ?? []).toHaveLength(1);
    expect(screen.queryByTestId('shiso-retry')).toBeNull();
  });
});
