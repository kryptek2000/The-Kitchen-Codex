// @vitest-environment jsdom
/**
 * SHISO-C1.7 S0 — baseline characterization of the EXISTING engine.
 *
 * These tests lock in behavior that S1/S2 must NOT change: bounded local
 * conversation state, abort-on-close cancellation, and the save-authority
 * boundary. The provider is stubbed at the NetworkAdapter; no live model call,
 * no real Vault, no personal data.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { ShisoModal } from '../../src/components/ShisoModal';
import { ShisoEntryProvider } from '../../src/application-ui/shisoEntryPoints';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import {
  loadShisoConversation,
  saveShisoConversation,
  shisoConversationStorageKey,
  SHISO_CONVERSATION_STORAGE_PREFIX,
  MAX_STORED_TRANSCRIPT_ENTRIES,
  MAX_STORED_CONVERSATION_BYTES,
} from '../../src/application/shisoConversationPersistence';
import { classifySaveIntent } from '../../src/core/shiso/saveAuthorization';
import { hydrateAiSelections } from '../../src/application/aiSelection';

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => null } as never);
});

afterEach(() => cleanup());

function memorySettings(): SettingsAdapter & { values: () => Record<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    get: async <T,>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
    set: async <T,>(key: string, value: T): Promise<void> => { data.set(key, value); },
    remove: async (key: string): Promise<void> => { data.delete(key); },
    values: () => Object.fromEntries(data),
  };
}

function replyNetwork(text: string): NetworkAdapter {
  return {
    post: async () => ({
      status: 200,
      ok: true,
      data: { ok: true, kind: 'reply', text, proposals: [], model_invocations_used: 1, tool_calls_used: 0 },
    }),
    get: async () => ({ status: 404, ok: false, data: {} }),
    request: async () => ({ status: 404, ok: false, data: {} }),
  } as unknown as NetworkAdapter;
}

function Modal(props: { network: NetworkAdapter; settings?: SettingsAdapter; onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <ShisoEntryProvider>
      <ShisoModal
        isOpen={open}
        onClose={() => { setOpen(false); props.onClose?.(); }}
        network={props.network}
        recipe={null}
        nutritionSession={null}
        nutritionRows={[]}
        nutritionReviewRows={[]}
        nutritionSummary={null}
        nutritionUnsaved={false}
        settings={props.settings}
      />
    </ShisoEntryProvider>
  );
}

describe('S0 — conversation state baseline', () => {
  it('uses a versioned, namespaced device-local key and bounded retention', () => {
    expect(SHISO_CONVERSATION_STORAGE_PREFIX).toBe('tkc_shiso_conversation_v1');
    expect(shisoConversationStorageKey('global')).toBe('tkc_shiso_conversation_v1:global');
    expect(MAX_STORED_TRANSCRIPT_ENTRIES).toBe(120);
    expect(MAX_STORED_CONVERSATION_BYTES).toBe(256 * 1024);
  });

  it('round-trips a conversation without storing credentials, grants, or proposals', async () => {
    const settings = memorySettings();
    await saveShisoConversation(settings, 'global', {
      messages: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }] as never,
      entries: [{ key: 'u1', role: 'user', text: 'hello', tools: [] }] as never,
      findings: [],
      nextSeq: 1,
    });
    const raw = JSON.stringify(settings.values());
    for (const forbidden of ['authorization', 'apiKey', 'token', 'proposal', 'saveGrant']) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    const loaded = await loadShisoConversation(settings, 'global');
    expect(loaded).not.toBeNull();
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.nextSeq).toBe(1);
  });

  it('keeps the compact modal flow working with no secret input and persists locally', async () => {
    const settings = memorySettings();
    render(<Modal network={replyNetwork('Verified local baseline reply.')} settings={settings} />);
    await waitFor(() => expect(screen.queryByTestId('shiso-conversation-restoring')).toBeNull());
    const box = screen.getByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'What can you tell me about braising?' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(document.body.textContent).toContain('Verified local baseline reply.'));
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await waitFor(() => expect(Object.keys(settings.values())).toContain('tkc_shiso_conversation_v1:global'));
  });
});

describe('S0 — cancellation baseline', () => {
  it('aborts an in-flight turn when the surface closes', async () => {
    let seenSignal: AbortSignal | undefined;
    const network = {
      post: (_path: string, _body: unknown, options?: { signal?: AbortSignal }) => {
        seenSignal = options?.signal;
        return new Promise(() => {});
      },
      get: async () => ({ status: 404, ok: false, data: {} }),
      request: async () => ({ status: 404, ok: false, data: {} }),
    } as unknown as NetworkAdapter;
    const onClose = () => {};
    render(<Modal network={network} onClose={onClose} />);
    await waitFor(() => expect(screen.queryByTestId('shiso-conversation-restoring')).toBeNull());
    fireEvent.change(screen.getByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement, { target: { value: 'Still working?' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(seenSignal).toBeDefined());
    expect(seenSignal?.aborted).toBe(false);
    fireEvent.click(screen.getByLabelText('Close Shiso'));
    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
    expect(screen.queryByTestId('shiso-progress')).toBeNull();
  });
});

describe('S0 — save-authority baseline', () => {
  it('classifies save intent deterministically and never treats questions as grants', () => {
    expect(classifySaveIntent('Save the recipe.').authorized).toBe(true);
    expect(classifySaveIntent('Please save.').authorized).toBe(true);
    expect(classifySaveIntent('Can you save this recipe?').authorized).toBe(false);
    expect(classifySaveIntent('Do not save this recipe.').authorized).toBe(false);
  });

  it('retains the structural pins in the shared chat surface', () => {
    const root = join(__dirname, '../..');
    const modal = readFileSync(join(root, 'src/components/ShisoModal.tsx'), 'utf8');
    for (const pin of [
      'classifySaveIntent(message)',
      'issueSaveAuthorization',
      'clearSaveAuthorization',
      'activeTurnControllerRef.current?.abort()',
      'data-testid="shiso-working-save"',
      "saveWorkingRecipe({ via: 'ui' })",
      "saveWorkingRecipe({ via: 'assistant' })",
    ]) {
      expect(modal).toContain(pin);
    }
    expect(modal).not.toMatch(/localStorage/);
    expect(modal).not.toMatch(/writeText/);
  });
});
