// @vitest-environment jsdom
/**
 * SHISO-C1.5 — ChatGPT plan as Default Text AI (renderer UI).
 *
 * Deterministic bridge, settings, and catalog mocks. No OAuth or live request.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ChatGptSubscriptionPanel } from '../../src/components/ChatGptSubscriptionPanel';
import {
  AI_SELECTION_SETTINGS_KEY,
  hydrateAiSelections,
  resetAiSelection,
  saveAiSelectionWithOutcome,
  buildAiSelectionRequestOptions,
  TEXT_SELECTION_HEADER,
  type SavedAiSelections,
} from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';

const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const MODEL = 'gpt-plan-test';

function memorySettings(initial?: SavedAiSelections): SettingsAdapter & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  if (initial) values.set(AI_SELECTION_SETTINGS_KEY, initial);
  return {
    values,
    get: async (key) => values.get(key) as never,
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    secureStorage: true,
    sessionOnly: true,
    signInRequiredAfterRestart: true,
    legacyCredentials: 'none',
    connected: true,
    accounts: [
      { accountKey: ACCOUNT, email: 'tester@example.com', planEnabled: true, signedOut: false, active: true },
    ],
    activeAccount: {
      accountKey: ACCOUNT,
      email: 'tester@example.com',
      planEnabled: true,
      scopes: ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      signedOut: false,
      expiresAt: Date.now() + 3600_000,
    },
    models: [{ id: MODEL, name: 'ChatGPT Plan Test' }],
    error: null,
    ...overrides,
  };
}

function mockBridge(initialStatus = status()) {
  const bridge = {
    status: vi.fn(async () => initialStatus),
    models: vi.fn(async () => ({ ok: true, value: [{ id: MODEL, name: 'ChatGPT Plan Test' }] })),
    connect: vi.fn(),
    cancelConnect: vi.fn(),
    reconnect: vi.fn(),
    selectAccount: vi.fn(),
    disconnect: vi.fn(),
    infer: vi.fn(),
    cancel: vi.fn(),
    manageUsage: vi.fn(),
  };
  (window as unknown as { kitchenCodexDesktop: unknown }).kitchenCodexDesktop = {
    isDesktop: true,
    platform: 'linux',
    chatgpt: bridge,
  };
  return bridge;
}

function catalog(userSelectionAllowed = true) {
  return {
    textProviders: [
      {
        providerId: 'gemini',
        name: 'Google Gemini',
        configured: true,
        enabled: true,
        available: true,
        storageScope: 'server_environment',
        supportsSecretWrites: false,
        connectionTest: 'network_probe',
        selectable: true,
        sessionKeySupported: true,
        models: [
          {
            id: 'gemini-3.7-flash',
            default: true,
            capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true },
          },
        ],
      },
      {
        providerId: 'chatgpt-plan',
        name: 'ChatGPT plan',
        configured: true,
        enabled: true,
        available: true,
        storageScope: 'session_only',
        supportsSecretWrites: false,
        connectionTest: 'unavailable',
        selectable: false,
        sessionKeySupported: false,
        models: [
          {
            id: MODEL,
            default: true,
            capabilities: {
              reasoning: true,
              structuredOutput: false,
              recipeGeneration: false,
              webSearch: false,
            },
          },
        ],
      },
    ],
    imageProviders: [],
    selection: {
      text: { selectionMode: 'server_default', valid: true },
      image: { selectionMode: 'server_default', valid: true },
      userSelectionAllowed: { text: userSelectionAllowed, image: true },
      executable: { text: true, image: true },
    },
    sessionByokSupported: true,
  };
}

function network(userSelectionAllowed = true): NetworkAdapter {
  return {
    request: async () => ({ status: 200, ok: true, data: { catalog: catalog(userSelectionAllowed) } }),
    get: async () => ({ status: 200, ok: true, data: { catalog: catalog(userSelectionAllowed) } }),
    post: async () => ({ status: 200, ok: true, data: {} }),
  } as unknown as NetworkAdapter;
}

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => null });
});

afterEach(async () => {
  cleanup();
  delete (window as unknown as { kitchenCodexDesktop?: unknown }).kitchenCodexDesktop;
  await resetAiSelection(memorySettings(), 'text');
  await resetAiSelection(memorySettings(), 'image');
});

describe('ChatGPT plan Default Text AI', () => {
  it('saves the connected account and model as the default without credentials', async () => {
    mockBridge();
    const settings = memorySettings();
    render(<ChatGptSubscriptionPanel settings={settings} network={network()} />);

    await screen.findByText('Default Text AI');
    await waitFor(() =>
      expect((screen.getByText('Use as Default Text AI') as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(screen.getByText('Use as Default Text AI'));

    await waitFor(() => {
      const stored = settings.values.get(AI_SELECTION_SETTINGS_KEY) as SavedAiSelections;
      expect(stored.textAi).toMatchObject({
        mode: 'user_selected',
        providerId: 'chatgpt-plan',
        modelId: MODEL,
        credentialSource: 'native_plan',
        accountKey: ACCOUNT,
      });
    });
    expect(screen.getByText('ChatGPT plan / ChatGPT Plan Test')).toBeTruthy();
    const requestOptions = await buildAiSelectionRequestOptions();
    expect(JSON.parse(requestOptions.headers?.[TEXT_SELECTION_HEADER] || '{}')).toEqual({
      mode: 'user_selected',
      providerId: 'chatgpt-plan',
      modelId: MODEL,
      credentialSource: 'native_plan',
      accountKey: ACCOUNT,
    });
    expect(JSON.stringify(settings.values.get(AI_SELECTION_SETTINGS_KEY))).not.toMatch(
      /accessToken|refreshToken|idToken|secret|password/i
    );
  });

  it('switches back to the configured server provider', async () => {
    mockBridge();
    const settings = memorySettings();
    await saveAiSelectionWithOutcome(
      settings,
      'text',
      'user_selected',
      'chatgpt-plan',
      MODEL,
      'native_plan',
      undefined,
      ACCOUNT
    );
    render(<ChatGptSubscriptionPanel settings={settings} network={network()} />);

    await screen.findByText('ChatGPT plan / ChatGPT Plan Test');
    fireEvent.click(screen.getByText('Use configured server provider'));

    await waitFor(() => {
      const stored = settings.values.get(AI_SELECTION_SETTINGS_KEY) as SavedAiSelections;
      expect(stored.textAi).toEqual({ mode: 'server_default' });
    });
    expect(screen.getByText('Server provider')).toBeTruthy();
  });

  it('shows a reconnect state after restart without falling back', async () => {
    mockBridge(
      status({
        connected: false,
        accounts: [],
        activeAccount: null,
        models: [],
      })
    );
    const settings = memorySettings();
    await saveAiSelectionWithOutcome(
      settings,
      'text',
      'user_selected',
      'chatgpt-plan',
      MODEL,
      'native_plan',
      undefined,
      ACCOUNT
    );
    render(<ChatGptSubscriptionPanel settings={settings} network={network()} />);

    await screen.findByText('ChatGPT plan / gpt-plan-test');
    expect(
      screen.getByText(/Saved, but ChatGPT plan is not connected/i)
    ).toBeTruthy();
    expect(screen.getByText(/no other provider will be used automatically/i)).toBeTruthy();
  });

  it('does not offer a local default when the server has no native bridge', async () => {
    mockBridge();
    const settings = memorySettings();
    const base = catalog();
    const withoutNative = {
      ...base,
      textProviders: base.textProviders.filter((p) => p.providerId !== 'chatgpt-plan'),
    };
    const bridgeMissingNetwork: NetworkAdapter = {
      request: async () => ({ status: 200, ok: true, data: { catalog: withoutNative } }),
      get: async () => ({ status: 200, ok: true, data: { catalog: withoutNative } }),
      post: async () => ({ status: 200, ok: true, data: {} }),
    } as unknown as NetworkAdapter;
    const { container } = render(
      <ChatGptSubscriptionPanel settings={settings} network={bridgeMissingNetwork} />
    );

    const panel = within(container);
    await panel.findByText('Default Text AI');
    await waitFor(() =>
      expect(panel.getByText(/does not expose the native ChatGPT plan bridge/i)).toBeTruthy()
    );
    expect((panel.getByText('Use as Default Text AI') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not offer a local override when Text AI is server-managed', async () => {
    mockBridge();
    const settings = memorySettings();
    render(<ChatGptSubscriptionPanel settings={settings} network={network(false)} />);

    await screen.findByText('Default Text AI');
    await waitFor(() =>
      expect(screen.getByText(/Text AI is server-managed/i)).toBeTruthy()
    );
    expect((screen.getByText('Use as Default Text AI') as HTMLButtonElement).disabled).toBe(true);
  });
});
