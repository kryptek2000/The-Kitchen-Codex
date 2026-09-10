import { describe, it, expect, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import {
  SessionKeyPanelView,
  sessionExpiryText,
  type SessionKeyProviderOption,
} from "../../src/application-ui/SessionKeyPanel.js";
import {
  fetchSessionKeyStatus,
  normalizeSessionKeyStatus,
  revokeSessionKey,
  saveSessionKey,
  testProviderConnection,
  SESSION_KEY_API_PATH,
  SESSION_KEY_STATUS_API_PATH,
  PROVIDER_TEST_CONNECTION_API_PATH,
} from "../../src/application-ui/sessionKey.js";
import type { NetworkAdapter } from "../../src/application/adapters/NetworkAdapter.js";
import { buildAiSelectionHeaders, saveAiSelection } from "../../src/application/aiSelection.js";

const SENTINEL = "sk-or-v1-SUPER_SECRET_BYOK5E_SENTINEL";

const PROVIDERS: SessionKeyProviderOption[] = [
  { providerId: "openrouter", name: "OpenRouter", kind: "text", models: [{ id: "openai/gpt-4o-mini", default: true }] },
  { providerId: "openrouter-image", name: "OpenRouter Image", kind: "image", models: [{ id: "google/gemini-2.5-flash-image", default: true }] },
];

function baseProps(overrides: Partial<React.ComponentProps<typeof SessionKeyPanelView>> = {}) {
  return {
    sessionByokSupported: true,
    providers: PROVIDERS,
    selectedProviderId: "openrouter",
    selectedModelId: "openai/gpt-4o-mini",
    apiKey: "",
    status: "not-configured" as const,
    saveState: "idle" as const,
    revokeState: "idle" as const,
    testState: "idle" as const,
    onSelectProvider: () => {},
    onSelectModel: () => {},
    onChangeApiKey: () => {},
    onSave: () => {},
    onRevoke: () => {},
    onTest: () => {},
    ...overrides,
  };
}

function render(el: React.ReactElement): string {
  return renderToString(el);
}

afterEach(() => {
  // no shared state
});

describe("BYOK-5E — SessionKeyPanelView (presentational)", () => {
  it("renders a password-style key input with no autocomplete and a neutral placeholder", () => {
    const html = render(<SessionKeyPanelView {...baseProps()} />);
    expect(html).toContain('type="password"');
    expect(html.toLowerCase()).toContain('autocomplete="new-password"');
    expect(html).toContain('placeholder="Enter API key"');
    expect(html).toContain("Save session key");
    // No fake masked-key preview.
    expect(html).not.toContain("••");
    expect(html).not.toContain("sk-");
  });

  it("labels the save button 'Update session key' when configured, and offers Revoke", () => {
    const html = render(<SessionKeyPanelView {...baseProps({ status: "configured" })} />);
    expect(html).toContain("Update session key");
    expect(html).toContain("Revoke session key");
    expect(html).toContain("Configured for this session");
  });

  it("shows 'Not configured' and disables Test when no key is configured", () => {
    const html = render(<SessionKeyPanelView {...baseProps({ status: "not-configured" })} />);
    expect(html).toContain("Not configured");
    expect(html).toMatch(/data-session-test="true"[^>]*disabled/);
    expect(html).toContain("Save a session key before testing the connection.");
  });

  it("enables Test when configured and shows bounded success/failure results", () => {
    const ok = render(
      <SessionKeyPanelView
        {...baseProps({
          status: "configured",
          testResult: { ok: true, model: "openai/gpt-4o-mini", latencyMs: 42, credentialSource: "session_only" },
        })}
      />
    );
    expect(ok).toContain('data-session-test-result="success"');
    expect(ok).toContain("Credential check passed");

    const bad = render(
      <SessionKeyPanelView
        {...baseProps({
          status: "configured",
          testResult: { ok: false, code: "AUTH", message: "Authentication failed." },
        })}
      />
    );
    expect(bad).toContain('data-session-test-result="failure"');
    expect(bad).toContain("Authentication failed.");
  });

  it("shows the deployment-unavailable state and disables session controls", () => {
    const html = render(<SessionKeyPanelView {...baseProps({ sessionByokSupported: false })} />);
    expect(html).toContain('data-session-unavailable="true"');
    expect(html).toContain("Session-only BYOK is available only in local, single-user deployments.");
    expect(html).toMatch(/data-session-key-input="true"[^>]*disabled/);
  });

  it("truthfully notes that image session generation is not enabled yet", () => {
    const html = render(
      <SessionKeyPanelView {...baseProps({ selectedProviderId: "openrouter-image", selectedModelId: "google/gemini-2.5-flash-image" })} />
    );
    expect(html).toContain("Session-key image generation is not enabled yet");
  });

  it("accessibly associates the Session API key label with the password input and marks async regions", () => {
    const html = render(
      <SessionKeyPanelView
        {...baseProps({ status: "configured", notice: { kind: "error", text: "bounded error" } })}
      />
    );
    expect(html).toContain('for="session-api-key-input"');
    expect(html).toContain('id="session-api-key-input"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
  });

  it("shows a safe relative expiry and never a key fragment", () => {
    expect(sessionExpiryText(new Date(Date.now() + 24 * 60000).toISOString())).toMatch(/Expires in 2[34] min/);
    expect(sessionExpiryText(new Date(Date.now() - 1000).toISOString())).toBe("Expired");
    expect(sessionExpiryText(undefined)).toBeUndefined();
    const html = render(
      <SessionKeyPanelView
        {...baseProps({ status: "configured", expiresAt: new Date(Date.now() + 24 * 60000).toISOString() })}
      />
    );
    expect(html).toContain("Expires in");
  });
});

// ---------------------------------------------------------------------------
// Client API helpers — fixed paths, no secret echo, key only in POST body.
// ---------------------------------------------------------------------------

function stubNetwork(handlers: {
  get?: (path: string) => Promise<any>;
  post?: (path: string, body: any) => Promise<any>;
  request?: (req: any) => Promise<any>;
}) {
  const calls: any[] = [];
  const network = {
    calls,
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return handlers.get ? handlers.get(path) : { status: 200, ok: true, data: {} };
    },
    post: async (path: string, body: any) => {
      calls.push({ method: "POST", path, body });
      return handlers.post ? handlers.post(path, body) : { status: 200, ok: true, data: {} };
    },
    request: async (req: any) => {
      calls.push(req);
      return handlers.request ? handlers.request(req) : { status: 200, ok: true, data: {} };
    },
  };
  return network as unknown as NetworkAdapter & { calls: any[] };
}

describe("BYOK-5E — session-key client helpers", () => {
  it("saveSessionKey POSTs only to the fixed path with the key in the body", async () => {
    const network = stubNetwork({
      post: async () => ({
        status: 200,
        ok: true,
        data: { providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "2026-01-01T00:30:00.000Z", version: "v1" },
      }),
    });
    const res = await saveSessionKey(network, "openrouter", SENTINEL);
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0].method).toBe("POST");
    expect(network.calls[0].path).toBe(SESSION_KEY_API_PATH);
    expect(network.calls[0].body).toEqual({ providerId: "openrouter", apiKey: SENTINEL });
    // The result NEVER contains the key.
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    expect(res.session).toEqual({
      providerId: "openrouter",
      storageScope: "session_only",
      configured: true,
      expiresAt: "2026-01-01T00:30:00.000Z",
      version: "v1",
    });
  });

  it("saveSessionKey passes expectedVersion for rotation and maps VERSION_CONFLICT", async () => {
    const network = stubNetwork({
      post: async () => ({ status: 409, ok: false, data: { code: "VERSION_CONFLICT", error: "The session key changed; refresh and try again." } }),
    });
    const res = await saveSessionKey(network, "openrouter", SENTINEL, "v1");
    expect(network.calls[0].body).toEqual({ providerId: "openrouter", apiKey: SENTINEL, expectedVersion: "v1" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("VERSION_CONFLICT");
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it("revokeSessionKey DELETEs the exact provider path", async () => {
    const network = stubNetwork({ request: async () => ({ status: 200, ok: true, data: { providerId: "openrouter", configured: false } }) });
    const res = await revokeSessionKey(network, "openrouter");
    expect(res.ok).toBe(true);
    expect(network.calls[0].method).toBe("DELETE");
    expect(network.calls[0].path).toBe(`${SESSION_KEY_API_PATH}/openrouter`);
  });

  it("fetchSessionKeyStatus reads the fixed status path and normalizes non-secret rows", async () => {
    const network = stubNetwork({
      get: async () => ({
        status: 200,
        ok: true,
        data: { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "x", version: "v1", secret: SENTINEL }] },
      }),
    });
    const res = await fetchSessionKeyStatus(network);
    expect(network.calls[0].path).toBe(SESSION_KEY_STATUS_API_PATH);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.providers[0]).toEqual({ providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "x", version: "v1" });
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
    }
  });

  it("fetchSessionKeyStatus maps a 503 to a bounded deployment-unavailable result", async () => {
    const network = stubNetwork({
      get: async () => ({ status: 503, ok: false, data: { code: "BYOK_SESSION_UNAVAILABLE", error: "Session-only BYOK is not available in this deployment." } }),
    });
    const res = await fetchSessionKeyStatus(network);
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.status).toBe(503);
  });

  it("testProviderConnection sends credentialSource and NEVER an apiKey", async () => {
    const network = stubNetwork({
      post: async () => ({ status: 200, ok: true, data: { ok: true, providerId: "openrouter", model: "openai/gpt-4o-mini", credentialSource: "session_only", latencyMs: 10 } }),
    });
    const res = await testProviderConnection(network, {
      providerId: "openrouter",
      kind: "text",
      modelId: "openai/gpt-4o-mini",
      credentialSource: "session_only",
    });
    expect(network.calls[0].path).toBe(PROVIDER_TEST_CONNECTION_API_PATH);
    expect(network.calls[0].body).toEqual({
      providerId: "openrouter",
      kind: "text",
      modelId: "openai/gpt-4o-mini",
      credentialSource: "session_only",
    });
    expect("apiKey" in network.calls[0].body).toBe(false);
    expect(res.ok).toBe(true);
  });

  it("revokeSessionKey rejects an overlong/empty provider id locally with NO network call", async () => {
    const network = stubNetwork({});
    const overlong = await revokeSessionKey(network, "p".repeat(65));
    expect(overlong.ok).toBe(false);
    expect(overlong.code).toBe("INVALID_REQUEST");
    const empty = await revokeSessionKey(network, "");
    expect(empty.ok).toBe(false);
    expect(network.calls).toHaveLength(0);
  });

  it("revokeSessionKey preserves the exact provider id and URL-encodes it", async () => {
    const network = stubNetwork({ request: async () => ({ status: 200, ok: true, data: {} }) });
    await revokeSessionKey(network, "a/b");
    expect(network.calls[0].path).toBe(`${SESSION_KEY_API_PATH}/a%2Fb`);
  });

  it("saveSessionKey / testProviderConnection also reject an invalid provider id locally", async () => {
    const network = stubNetwork({});
    expect((await saveSessionKey(network, "", SENTINEL)).ok).toBe(false);
    expect((await testProviderConnection(network, { providerId: "", kind: "text" })).ok).toBe(false);
    expect(network.calls).toHaveLength(0);
  });

  it("normalizeSessionKeyStatus drops non-session_only / malformed rows", () => {
    expect(
      normalizeSessionKeyStatus({
        providers: [
          { providerId: "a", storageScope: "session_only", configured: true },
          { providerId: "b", storageScope: "server_environment", configured: true },
          { providerId: "c", storageScope: "session_only", configured: "yes" },
        ],
      })
    ).toEqual([{ providerId: "a", storageScope: "session_only", configured: true }]);
  });
});

// ---------------------------------------------------------------------------
// Secret non-persistence.
// ---------------------------------------------------------------------------

describe("BYOK-5E — session key is never persisted client-side", () => {
  it("saveAiSelection persists credentialSource but never a key", async () => {
    let persisted: unknown;
    const settings = { set: async (_k: string, v: unknown) => { persisted = v; }, get: async () => undefined, remove: async () => {} };
    await saveAiSelection(settings, "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    expect(JSON.stringify(persisted)).not.toContain(SENTINEL);
    expect(JSON.stringify(persisted)).toContain("session_only");
  });

  it("AI selection request headers never contain a session key", () => {
    const headers = buildAiSelectionHeaders({
      textAi: { mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" },
      imageAi: { mode: "server_default" },
    });
    const serialized = JSON.stringify(headers);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).toContain("session_only");
  });
});
