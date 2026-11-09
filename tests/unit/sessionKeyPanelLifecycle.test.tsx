// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React, { StrictMode } from 'react';
import { SessionKeyPanel } from '../../src/application-ui/SessionKeyPanel';

const SENTINEL = 'sk-or-v1-STRICT_MODE_SENTINEL';

/**
 * Test-environment-only jsdom storage repair.
 *
 * Node 26 can expose an experimental global `localStorage` accessor that shadows
 * jsdom's real Storage and returns undefined without --localstorage-file. Bun's
 * jsdom runner can also leave the bare global unavailable. Re-point the
 * configurable accessor at jsdom's own backing Storage so the test inspects real
 * browser storage without requiring CI-specific NODE_OPTIONS.
 */
(function repairJsdomLocalStorage() {
  if (window.localStorage) return;
  const jsdomOwned = (window as unknown as { _localStorage?: Storage })._localStorage;
  if (jsdomOwned) {
    Object.defineProperty(window, 'localStorage', {
      value: jsdomOwned,
      configurable: true,
      writable: true,
    });
  }
  if (!window.localStorage) {
    throw new Error(
      'sessionKeyPanelLifecycle: jsdom window storage is unavailable — refusing to inspect a missing storage object'
    );
  }
})();

function storageDump(): string {
  let out = '';
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i) || '';
      out += `${key}=${storage.getItem(key) || ''};`;
    }
  }
  return out;
}
const providers = [
  { providerId: 'openrouter', name: 'OpenRouter', kind: 'text' as const, models: [{ id: 'openai/gpt-4o-mini', default: true }] },
  { providerId: 'deepseek', name: 'DeepSeek', kind: 'text' as const, models: [{ id: 'deepseek-v4-flash', default: true }] },
];

function status(configured: boolean, providerId = 'openrouter') {
  return { status: 200, ok: true, data: { providers: [{ providerId, storageScope: 'session_only', configured, version: configured ? 'v1' : undefined }] } };
}

function makeNetwork(overrides: any = {}) {
  let configured = false;
  const network: any = {
    get: vi.fn(async (path: string) => {
      if (overrides.get) return overrides.get(path, configured);
      return status(configured, 'openrouter');
    }),
    post: vi.fn(async (path: string, body: any) => {
      if (overrides.post) return overrides.post(path, body, configured);
      if (path.includes('session-key')) {
        configured = true;
        return { status: 200, ok: true, data: { providerId: 'openrouter', storageScope: 'session_only', configured: true, version: 'v1' } };
      }
      return { status: 200, ok: true, data: { ok: true, providerId: 'openrouter', model: 'openai/gpt-4o-mini', credentialSource: 'session_only' } };
    }),
    request: vi.fn(async () => ({ status: 200, ok: true, data: { providerId: 'openrouter', configured: false } })),
    ...overrides,
  };
  return network;
}

function renderPanel(network: any, props: any = {}) {
  return render(
    <StrictMode>
      <SessionKeyPanel network={network} sessionByokSupported={true} providers={providers} {...props} />
    </StrictMode>
  );
}

async function saveKey(key = SENTINEL) {
  const input = screen.getByLabelText('Session API key');
  fireEvent.change(input, { target: { value: key } });
  fireEvent.click(screen.getByText(/Save session key|Update session key/));
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('SessionKeyPanel StrictMode lifecycle', () => {
  it('exits Saving after a successful save and enables Test Connection', async () => {
    const network = makeNetwork();
    renderPanel(network);
    await waitFor(() => expect(screen.getByText('Not configured')).toBeTruthy());
    await saveKey();
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
    expect(screen.getByText('Configured for this session')).toBeTruthy();
    const testButton = screen.getByText('Test Connection').closest('button') as HTMLButtonElement;
    expect(testButton.disabled).toBe(false);
  });

  it('exits Saving and shows a bounded error when the save request is rejected', async () => {
    const network = makeNetwork({
      post: async () => ({ status: 500, ok: false, data: { error: 'Save failed safely.' } }),
    });
    renderPanel(network);
    await waitFor(() => expect(screen.getByText('Not configured')).toBeTruthy());
    await saveKey();
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
    expect(screen.getByText('Save failed safely.')).toBeTruthy();
  });

  it('exits Saving when the save succeeds but status confirmation fails', async () => {
    let saveCalled = false;
    const network = makeNetwork({
      get: async () => {
        if (saveCalled) throw new Error('status transport failed');
        return status(false);
      },
      post: async () => {
        saveCalled = true;
        return { status: 200, ok: true, data: { providerId: 'openrouter', storageScope: 'session_only', configured: true, version: 'v1' } };
      },
    });
    renderPanel(network);
    await waitFor(() => expect(screen.getByText('Not configured')).toBeTruthy());
    await saveKey();
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
    expect(screen.getByText(/session status could not be confirmed/i)).toBeTruthy();
  });

  it('recovers the Test Connection control after a transport failure', async () => {
    const network = makeNetwork({
      get: async () => status(true),
      post: async (path: string) => {
        if (path.includes('test-connection')) throw new Error('test transport failed');
        return { status: 200, ok: true, data: {} };
      },
    });
    renderPanel(network);
    await waitFor(() => expect(screen.getByText('Configured for this session')).toBeTruthy());
    fireEvent.click(screen.getByText('Test Connection'));
    await waitFor(() => expect(screen.queryByText('Testing…')).toBeNull());
    expect(screen.getByText(/Connection test could not be completed/i)).toBeTruthy();
  });

  it('does not persist or render the typed key after save', async () => {
    const network = makeNetwork();
    renderPanel(network);
    await waitFor(() => expect(screen.getByText('Not configured')).toBeTruthy());
    await saveKey();
    await waitFor(() => expect(screen.getByText('Configured for this session')).toBeTruthy());
    expect(document.body.textContent).not.toContain(SENTINEL);
    expect(storageDump()).not.toContain(SENTINEL);
  });
});
