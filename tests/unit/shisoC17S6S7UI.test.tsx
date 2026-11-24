// @vitest-environment jsdom
/**
 * SHISO-C1.7 S6/S7 — safe Markdown in messages, Signature recipe result,
 * SHISO avatar states, and collapsible history. No live provider, no Vault.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';

import { hydrateAiSelections } from '../../src/application/aiSelection';
import { ShisoEntryProvider, useShiso } from '../../src/application-ui/shisoEntryPoints';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import { ShisoAvatar } from '../../src/components/ShisoAvatar';
import { ShisoHistoryRail, type ShisoHistoryRailProps } from '../../src/components/ShisoHistoryRail';
import { ShisoModal, type ShisoModalProps } from '../../src/components/ShisoModal';
import type { GeneratedRecipeDraft } from '../../src/schema/generatedRecipe';

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => null } as never);
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
});

const DRAFT: GeneratedRecipeDraft = {
  title: 'Signature Skillet Chicken',
  description: 'A bright one-pan supper.',
  servings: 4,
  ingredients: [{ amount: 2, unit: 'tbsp', name: 'olive oil' }, { name: 'chicken thighs' }],
  steps: [{ text: 'Sear the chicken.' }, { text: 'Finish with lemon.' }],
};

function networkWith(handler: (path: string) => Promise<unknown>): NetworkAdapter {
  return {
    post: async (path: string) => handler(path),
    get: async () => ({ status: 404, ok: false, data: {} }),
    request: async () => ({ status: 404, ok: false, data: {} }),
  } as unknown as NetworkAdapter;
}

function reply(text: string) {
  return { status: 200, ok: true, data: { ok: true, kind: 'reply', text, proposals: [], model_invocations_used: 1, tool_calls_used: 0 } };
}

function Probe(props: Partial<ShisoModalProps> & { network: NetworkAdapter }) {
  const [open, setOpen] = useState(true);
  return (
    <ShisoEntryProvider>
      <ShisoModal
        isOpen={open}
        onClose={() => setOpen(false)}
        recipe={null}
        nutritionSession={null}
        nutritionRows={[]}
        nutritionReviewRows={[]}
        nutritionSummary={null}
        nutritionUnsaved={false}
        {...props}
      />
    </ShisoEntryProvider>
  );
}

function railProps(overrides: Partial<ShisoHistoryRailProps> = {}): ShisoHistoryRailProps {
  return {
    conversations: [{
      key: 'global:a', title: 'Sunday noodles', source: 'named', recipeIdentity: null,
      updatedAt: '2026-01-01T00:00:00.000Z', preview: 'an earlier message',
    }],
    activeKey: 'global:a',
    searchQuery: '',
    searchResults: [],
    onSearchChange: () => {},
    onNew: () => {},
    onResume: () => {},
    onRename: () => {},
    onDelete: () => {},
    ...overrides,
  };
}

function CreateHost({ network }: { network: NetworkAdapter }) {
  return (
    <ShisoEntryProvider>
      <CreateHostInner network={network} />
    </ShisoEntryProvider>
  );
}
function CreateHostInner({ network }: { network: NetworkAdapter }) {
  const shiso = useShiso();
  return (
    <>
      <button onClick={() => shiso.open('create')}>open create</button>
      <ShisoModal
        isOpen={shiso.isOpen}
        onClose={shiso.close}
        network={network}
        recipe={null}
        nutritionSession={null}
        nutritionRows={[]}
        nutritionReviewRows={[]}
        nutritionSummary={null}
        nutritionUnsaved={false}
      />
    </>
  );
}

describe('S6 — safe Markdown in SHISO messages', () => {
  it('renders assistant text as Markdown and leaves user text literal', async () => {
    render(<Probe network={networkWith(async () => reply('**Checked** your vault.'))} />);
    fireEvent.change(screen.getByPlaceholderText('Ask Shiso…'), { target: { value: '**literal** question' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Checked')).toBeTruthy();
    const markdown = screen.getByTestId('shiso-markdown');
    expect(markdown.querySelector('strong')?.textContent).toBe('Checked');
    const userBubble = document.querySelector('[data-shiso-bubble="user"]');
    expect(userBubble?.textContent).toContain('**literal** question');
  });
});

describe('S6 — Signature recipe result', () => {
  it('uses the existing read-only card for a generated draft', async () => {
    const network = networkWith(async (path) => path === '/api/recipes/generate'
      ? { status: 200, ok: true, data: { draft: DRAFT, provenance: { generated: true, providerId: 'fixture', model: 'fixture-model' } } }
      : reply('done'));
    render(<CreateHost network={network} />);
    fireEvent.click(screen.getByText('open create'));
    fireEvent.change(screen.getByPlaceholderText(/Describe the recipe/), { target: { value: 'Create a skillet chicken supper' } });
    fireEvent.click(screen.getByText('Send'));

    const result = await screen.findByTestId('shiso-recipe-result');
    expect(result.querySelector('[data-signature-recipe-card]')).toBeTruthy();
    expect(result.textContent).toContain('Signature Skillet Chicken');
    expect(result.textContent).toContain('Not saved yet');
    // The existing review controls are preserved, not replaced.
    expect(screen.getByTestId('shiso-created-recipe-draft')).toBeTruthy();
    expect(screen.getByTestId('shiso-created-save')).toBeTruthy();
  });
});

describe('S7 — SHISO avatar', () => {
  it('has full and compact forms with accessible names and expressive states', () => {
    const { container, unmount } = render(<ShisoAvatar form="full" state="idle" />);
    const full = container.querySelector('[data-shiso-avatar="full"]');
    expect(full?.getAttribute('role')).toBe('img');
    expect(full?.getAttribute('aria-label')).toMatch(/SHISO/);
    expect(full?.querySelector('img')?.getAttribute('src')).toBe('/images/shiso-official-wave.png');
    expect(container.querySelector('.kc-shiso-avatar-halo')).toBeTruthy();
    unmount();

    const compact = render(<ShisoAvatar form="compact" state="working" />);
    const node = compact.container.querySelector('[data-shiso-avatar="compact"]');
    expect(node?.getAttribute('data-state')).toBe('working');
    expect(node?.querySelector('img')?.getAttribute('src')).toBe('/images/shiso-official-portrait.png');
    expect(compact.container.querySelector('.kc-shiso-avatar-steam')).toBeTruthy();
    compact.unmount();

    const thinking = render(<ShisoAvatar form="full" state="thinking" />);
    expect(thinking.container.querySelector('img')?.getAttribute('src')).toBe('/images/shiso-official-thinking.png');
  });

  it('replaces sparkle placeholders in the SHISO surfaces', async () => {
    render(<Probe network={networkWith(async () => reply('hi'))} presentation="fullpage" />);
    const avatars = document.querySelectorAll('[data-shiso-avatar]');
    expect(avatars.length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('.kc-shiso-workspace-mark svg')).toBeTruthy();
    expect(document.querySelector('.kc-shiso-workspace-mark')?.getAttribute('aria-hidden')).toBeNull();
  });

  it('shows the thinking state while a real turn is in flight', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    render(<Probe network={networkWith(async () => pending)} />);
    fireEvent.change(screen.getByPlaceholderText('Ask Shiso…'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(document.querySelector('[data-state="thinking"]')).toBeTruthy());
    release(reply('done'));
  });

  it('declares reduced-motion handling for every avatar animation', () => {
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('kc-shiso-avatar-halo')));
    expect(reduced).toContain('kc-shiso-avatar-halo');
    expect(reduced).toContain('kc-shiso-avatar-antenna');
    expect(reduced).toContain('animation: none');
  });
});

describe('Flagship workspace — conversational recipe creation entry', () => {
  it('switches the shared provider into creation mode and back', async () => {
    const network = networkWith(async () => reply('done'));
    render(<Probe network={network} presentation="fullpage" />);
    expect(screen.getByTestId('shiso-workspace-create-entry')).toBeTruthy();
    expect(screen.queryByTestId('shiso-workspace-chat-entry')).toBeNull();
    expect(document.querySelector('.kc-shiso-workspace-title')?.textContent).toBe('Chat with SHISO');

    fireEvent.click(screen.getByTestId('shiso-workspace-create-entry'));
    expect(await screen.findByText('Create with SHISO')).toBeTruthy();
    expect(screen.getByTestId('shiso-workspace-chat-entry')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Describe the recipe/)).toBeTruthy();
    // One engine: the full-page surface is still the single SHISO workspace.
    expect(document.querySelectorAll('.kc-shiso-workspace')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('shiso-workspace-chat-entry'));
    await waitFor(() => expect(screen.getByTestId('shiso-workspace-create-entry')).toBeTruthy());
    expect(screen.getByPlaceholderText('Ask Shiso…')).toBeTruthy();
  });
});

describe('S7 — collapsible history / accessibility', () => {
  it('exposes a labelled collapse toggle with a controlled region', () => {
    render(<ShisoHistoryRail {...railProps()} />);
    const toggle = screen.getByTestId('shiso-history-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('shiso-history-body');
    expect(document.getElementById('shiso-history-body')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect((document.getElementById('shiso-history-body') as HTMLElement).hidden).toBe(true);
    expect(screen.getByLabelText('New conversation')).toBeTruthy();
    fireEvent.click(toggle);
    expect((document.getElementById('shiso-history-body') as HTMLElement).hidden).toBe(false);
  });

  it('starts collapsed on mobile so chat is the primary focus', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    render(<ShisoHistoryRail {...railProps()} />);
    expect(screen.getByTestId('shiso-history-toggle').getAttribute('aria-expanded')).toBe('false');
    expect((document.getElementById('shiso-history-body') as HTMLElement).hidden).toBe(true);
    expect(document.querySelector('.kc-shiso-history.is-collapsed')).toBeTruthy();
  });

  it('keeps history controls keyboard-reachable and named', () => {
    render(<ShisoHistoryRail {...railProps()} />);
    const names = [...document.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
    );
    expect(names.every((name) => name.length > 0)).toBe(true);
    expect(screen.getByRole('heading', { name: 'Conversations' })).toBeTruthy();
  });
});
