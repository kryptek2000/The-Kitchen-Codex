// @vitest-environment jsdom
/**
 * SHISO-C1.7 S3–S5 — history UI, Stop, Retry and honest progress.
 *
 * The provider is stubbed at the NetworkAdapter; no live model call, no real
 * Vault, no personal data. The rail is presentation-only and the engine under
 * test is the SAME ShisoModal used by the compact chat and full-page workspace.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { ShisoModal, type ShisoModalProps } from '../../src/components/ShisoModal';
import { ShisoHistoryRail, type ShisoHistoryRailProps } from '../../src/components/ShisoHistoryRail';
import { ShisoEntryProvider } from '../../src/application-ui/shisoEntryPoints';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import {
  clearShisoConversation,
  loadShisoConversation,
  saveShisoConversation,
} from '../../src/application/shisoConversationPersistence';
import type { ShisoConversationMeta } from '../../src/application/shisoConversationIndex';

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => null } as never);
});

afterEach(() => cleanup());

function memorySettings(): SettingsAdapter {
  const data = new Map<string, unknown>();
  return {
    get: async <T,>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
    set: async <T,>(key: string, value: T): Promise<void> => { data.set(key, value); },
    remove: async (key: string): Promise<void> => { data.delete(key); },
    keys: () => [...data.keys()],
  } as SettingsAdapter & { keys: () => string[] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type PostOptions = { readonly signal?: AbortSignal } | undefined;
function networkWith(handler: (options: PostOptions) => Promise<unknown>): NetworkAdapter {
  return {
    post: async (_url: string, _body: unknown, options?: { signal?: AbortSignal }) => handler(options),
    get: async () => ({ status: 404, ok: false, data: {} }),
    request: async () => ({ status: 404, ok: false, data: {} }),
  } as unknown as NetworkAdapter;
}

function reply(text: string) {
  return {
    status: 200,
    ok: true,
    data: { ok: true, kind: 'reply', text, proposals: [], model_invocations_used: 1, tool_calls_used: 0 },
  };
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

const meta = (key: string, title: string): ShisoConversationMeta => ({
  key,
  title,
  source: 'named',
  recipeIdentity: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  preview: 'an earlier message',
});

function railProps(overrides: Partial<ShisoHistoryRailProps> = {}): ShisoHistoryRailProps {
  return {
    conversations: [meta('global:a', 'Sunday noodles'), meta('global:b', 'Birthday cake')],
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

describe('S3/S4 — history rail actions', () => {
  it('exposes New and Resume without owning any engine', () => {
    const calls: string[] = [];
    render(<ShisoHistoryRail {...railProps({
      onNew: () => calls.push('new'),
      onResume: (key) => calls.push(`resume:${key}`),
    })} />);

    fireEvent.click(screen.getByLabelText('New conversation'));
    fireEvent.click(screen.getByLabelText('Resume Birthday cake'));
    expect(calls).toEqual(['new', 'resume:global:b']);
  });

  it('renames through an inline editor', () => {
    const calls: string[] = [];
    render(<ShisoHistoryRail {...railProps({
      onRename: (key, title) => calls.push(`${key}:${title}`),
    })} />);

    fireEvent.click(screen.getByLabelText('Rename Sunday noodles'));
    const input = screen.getByTestId('shiso-history-rename-input');
    fireEvent.change(input, { target: { value: 'Weeknight noodles' } });
    fireEvent.click(screen.getByLabelText('Save title'));
    expect(calls).toEqual(['global:a:Weeknight noodles']);
  });

  it('requires confirmation before delete', () => {
    const calls: string[] = [];
    render(<ShisoHistoryRail {...railProps({
      onDelete: (key) => calls.push(key),
    })} />);

    fireEvent.click(screen.getByLabelText('Delete Birthday cake'));
    expect(screen.getByTestId('shiso-history-confirm')).toBeTruthy();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByTestId('shiso-history-delete-confirm'));
    expect(calls).toEqual(['global:b']);
  });

  it('search delegates query changes and renders bounded results', () => {
    const calls: string[] = [];
    function SearchingRail() {
      const [query, setQuery] = useState('');
      return <ShisoHistoryRail {...railProps({
        searchQuery: query,
        searchResults: query ? [{ key: 'global:b', title: 'Birthday cake', snippet: 'with candles', matchedIn: 'message' }] : [],
        onSearchChange: (value) => { calls.push(value); setQuery(value); },
      })} />;
    }
    render(<SearchingRail />);

    fireEvent.change(screen.getByTestId('shiso-history-search'), { target: { value: 'cake' } });
    expect(calls).toEqual(['cake']);
    const result = screen.getByTestId('shiso-history-result');
    expect(result.textContent).toContain('Birthday cake');
    expect(result.textContent).toContain('Message match');
  });
});

describe('S4/S5 — visible Stop, Retry, and honest progress', () => {
  it('only shows the history rail in the full-page presentation', () => {
    const history = railProps();
    const { unmount } = render(<Probe network={networkWith(async () => reply('hi'))} conversationHistory={history} presentation="fullpage" />);
    expect(screen.getByTestId('shiso-history-rail')).toBeTruthy();
    unmount();

    render(<Probe network={networkWith(async () => reply('hi'))} conversationHistory={history} />);
    expect(screen.queryByTestId('shiso-history-rail')).toBeNull();
  });

  it('resumes another stored conversation into the SAME engine', async () => {
    const settings = memorySettings();
    await saveShisoConversation(settings, 'recipe:One', {
      messages: [{ role: 'user', text: 'one-off question' }],
      entries: [{ key: 'u1', role: 'user', text: 'one-off question', tools: [] }],
      findings: [], nextSeq: 1,
    });
    await saveShisoConversation(settings, 'recipe:Two', {
      messages: [{ role: 'user', text: 'resumed question' }],
      entries: [{ key: 'u1', role: 'user', text: 'resumed question', tools: [] }],
      findings: [], nextSeq: 1,
    });
    const stored = await loadShisoConversation(settings, 'recipe:Two');
    expect(stored?.entries[0].text).toBe('resumed question');

    render(<Probe network={networkWith(async () => reply('hi'))} settings={settings} activeConversationKeyOverride="recipe:Two" />);
    expect(await screen.findByText('resumed question')).toBeTruthy();
    expect(screen.queryByText('one-off question')).toBeNull();
  });

  it('Stop aborts the in-flight turn through the existing controller', async () => {
    let captured: AbortSignal | undefined;
    const pending = deferred<unknown>();
    const network = networkWith(async (options) => {
      captured = options?.signal;
      options?.signal?.addEventListener('abort', () => pending.resolve({ status: 499, ok: false, data: {} }));
      return pending.promise;
    });

    render(<Probe network={network} />);
    fireEvent.change(screen.getByPlaceholderText('Ask Shiso…'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    const stop = await screen.findByTestId('shiso-stop');
    fireEvent.click(stop);

    await waitFor(() => expect(captured?.aborted).toBe(true));
    expect(await screen.findByText(/This turn was stopped/)).toBeTruthy();
  });

  it('Retry re-sends the retained message after a provider failure', async () => {
    let call = 0;
    const network = networkWith(async () => {
      call += 1;
      if (call === 1) return { status: 503, ok: false, data: { ok: false, message: 'Temporary failure' } };
      return reply('Recovered answer');
    });

    render(<Probe network={network} />);
    fireEvent.change(screen.getByPlaceholderText('Ask Shiso…'), { target: { value: 'try again' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    const retry = await screen.findByTestId('shiso-retry');
    fireEvent.click(retry);
    expect(await screen.findByText('Recovered answer')).toBeTruthy();
    expect(call).toBe(2);
  });

  it('renders real provider steps without token-stream claims', async () => {
    const pending = deferred<unknown>();
    render(<Probe network={networkWith(async () => pending.promise)} />);
    fireEvent.change(screen.getByPlaceholderText('Ask Shiso…'), { target: { value: 'steps' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    const steps = await screen.findByTestId('shiso-progress-steps');
    expect(steps.textContent).toContain('Provider request');
    expect(steps.textContent).not.toMatch(/token|stream/i);
    pending.resolve(reply('done'));
  });

  it('tombstones deleted keys while allowing a new conversation to persist', async () => {
    const settings = memorySettings();
    await saveShisoConversation(settings, 'global:deleted', {
      messages: [{ role: 'user', text: 'old message' }],
      entries: [{ key: 'u1', role: 'user', text: 'old message', tools: [] }],
      findings: [],
      nextSeq: 1,
    });

    await clearShisoConversation(settings, 'global:deleted');
    // This represents a late React persistence effect from the deleted surface.
    await saveShisoConversation(settings, 'global:deleted', {
      messages: [{ role: 'user', text: 'stale late write' }],
      entries: [{ key: 'u2', role: 'user', text: 'stale late write', tools: [] }],
      findings: [],
      nextSeq: 2,
    });
    expect(await loadShisoConversation(settings, 'global:deleted')).toBeNull();

    await saveShisoConversation(settings, 'global:new', {
      messages: [{ role: 'user', text: 'new message' }],
      entries: [{ key: 'u1', role: 'user', text: 'new message', tools: [] }],
      findings: [],
      nextSeq: 1,
    });
    expect((await loadShisoConversation(settings, 'global:new'))?.messages[0]?.text).toBe('new message');
  });
});
