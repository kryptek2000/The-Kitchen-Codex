/**
 * Compact Session Provider Binding — regression coverage.
 *
 * Root cause: the compact contextual SessionKeyPanel received the COMPLETE
 * surface provider list and SessionKeyController initialized from `providers[0]`.
 * A card showing OpenRouter could therefore save/test/revoke/status against
 * Gemini (element zero), risking a cross-provider credential write.
 *
 * This suite proves compact mode is HARD-LOCKED to exactly one provider and one
 * model, that provider switches rebind cleanly, that late old-provider status
 * cannot overwrite the new provider, and that legacy/full behavior is preserved.
 */

import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  SessionKeyController,
  type SessionKeyProviderOption,
} from "../../src/application-ui/sessionKeyController.js";
import { SessionKeyPanel } from "../../src/application-ui/SessionKeyPanel.js";
import {
  SelectionControlCard,
  resolveSessionConfigured,
} from "../../src/application-ui/ProviderSettings.js";
import {
  SESSION_KEY_API_PATH,
  PROVIDER_TEST_CONNECTION_API_PATH,
} from "../../src/application-ui/sessionKey.js";
import type { NetworkAdapter } from "../../src/application/adapters/NetworkAdapter.js";
import type { SettingsAdapter } from "../../src/application/adapters/SettingsAdapter.js";

const SENTINEL = "sk-or-v1-COMPACT_BINDING_SENTINEL";

interface Pending {
  method: string;
  path: string;
  body?: any;
  resolved: boolean;
  resolve: (value: any) => void;
}

function makeNetwork() {
  const pending: Pending[] = [];
  const network = {
    get: (path: string) => {
      let resolve!: (v: any) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      pending.push({ method: "GET", path, resolved: false, resolve });
      return promise;
    },
    post: (path: string, body: any) => {
      let resolve!: (v: any) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      pending.push({ method: "POST", path, body, resolved: false, resolve });
      return promise;
    },
    request: (req: any) => {
      let resolve!: (v: any) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      pending.push({ method: req.method, path: req.path, body: req.body, resolved: false, resolve });
      return promise;
    },
  };
  return { network: network as unknown as NetworkAdapter, pending };
}

function settle(pending: Pending[], method: string, pathPart: string, data: unknown, status = 200, ok = true) {
  const entry = pending.find((p) => !p.resolved && p.method === method && p.path.includes(pathPart));
  if (!entry) throw new Error(`no pending ${method} ${pathPart}`);
  entry.resolved = true;
  entry.resolve({ status, ok, data });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Gemini is FIRST so a providers[0] regression would visibly target it. */
const TEXT_PROVIDERS: SessionKeyProviderOption[] = [
  { providerId: "gemini", name: "Google Gemini", kind: "text", models: [{ id: "gemini-3.7-flash", default: true }] },
  { providerId: "openrouter", name: "OpenRouter", kind: "text", models: [{ id: "openai/gpt-4o-mini", default: true }] },
];

/** Gemini Image is FIRST so a providers[0] regression would visibly target it. */
const IMAGE_PROVIDERS: SessionKeyProviderOption[] = [
  { providerId: "gemini-image", name: "Google Gemini Image", kind: "image", models: [{ id: "gemini-2.5-flash-image", default: true }] },
  { providerId: "openrouter-image", name: "OpenRouter Image", kind: "image", models: [{ id: "google/gemini-2.5-flash-image", default: true }] },
];

const STATUS_BOTH = {
  providers: [
    { providerId: "gemini", storageScope: "session_only", configured: true, expiresAt: "G-EXP", version: "G-VER" },
    { providerId: "openrouter", storageScope: "session_only", configured: false },
    { providerId: "gemini-image", storageScope: "session_only", configured: true, expiresAt: "GI-EXP", version: "GI-VER" },
    { providerId: "openrouter-image", storageScope: "session_only", configured: false },
  ],
};

function stubSettings(): SettingsAdapter {
  return { get: async () => undefined, set: async () => {}, remove: async () => {} };
}

function stubNetwork(): NetworkAdapter {
  return {
    request: async () => ({ status: 200, ok: true, data: undefined }),
    get: async () => ({ status: 200, ok: true, data: undefined }),
    post: async () => ({ status: 200, ok: true, data: undefined }),
  };
}

describe("Compact binding — controller initializes from the EXPLICIT locked provider, never providers[0]", () => {
  it("text: OpenRouter lock wins even though Gemini is element zero", () => {
    const { network } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, {
      providerId: "openrouter",
      modelId: "openai/gpt-4o-mini",
    });
    expect(c.getState().selectedProviderId).toBe("openrouter");
    expect(c.getState().selectedModelId).toBe("openai/gpt-4o-mini");
  });

  it("image: openrouter-image lock wins even though gemini-image is element zero", () => {
    const { network } = makeNetwork();
    const c = new SessionKeyController(network, IMAGE_PROVIDERS, {
      providerId: "openrouter-image",
      modelId: "google/gemini-2.5-flash-image",
    });
    expect(c.getState().selectedProviderId).toBe("openrouter-image");
    expect(c.getState().selectedModelId).toBe("google/gemini-2.5-flash-image");
  });

  it("gemini / gemini-image locks resolve to their exact ids", () => {
    const { network } = makeNetwork();
    const g = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "gemini", modelId: "gemini-3.7-flash" });
    const gi = new SessionKeyController(network, IMAGE_PROVIDERS, { providerId: "gemini-image", modelId: "gemini-2.5-flash-image" });
    expect(g.getState().selectedProviderId).toBe("gemini");
    expect(gi.getState().selectedProviderId).toBe("gemini-image");
  });

  it("a locked controller CANNOT drift to another provider via selectProvider", () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "openrouter" });
    c.selectProvider("gemini");
    expect(c.getState().selectedProviderId).toBe("openrouter");
    // No status refresh was triggered by the rejected switch.
    expect(pending.filter((p) => p.method === "GET")).toHaveLength(0);
  });

  it("a locked controller's model is owned by the card (selectModel is inert, syncLockedModel applies)", () => {
    const { network } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, {
      providerId: "openrouter",
      modelId: "openai/gpt-4o-mini",
    });
    c.selectModel("gemini-3.7-flash");
    expect(c.getState().selectedModelId).toBe("openai/gpt-4o-mini");
    c.syncLockedModel("some/explicit-model");
    expect(c.getState().selectedModelId).toBe("some/explicit-model");
    // Clearing the card model falls back to the LOCKED provider's default.
    c.syncLockedModel(undefined);
    expect(c.getState().selectedModelId).toBe("openai/gpt-4o-mini");
  });
});

describe("Compact binding — Save key exact-ID proof", () => {
  it("A. Text OpenRouter Save -> providerId=openrouter", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "openrouter", modelId: "openai/gpt-4o-mini" });
    c.setApiKey(SENTINEL);
    const p = c.save();
    const post = pending.find((x) => x.method === "POST" && x.path === SESSION_KEY_API_PATH);
    expect(post!.body).toEqual({ providerId: "openrouter", apiKey: SENTINEL });
    settle(pending, "POST", SESSION_KEY_API_PATH, { providerId: "openrouter", storageScope: "session_only", configured: true, version: "v1" });
    await flush();
    settle(pending, "GET", "status", { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "OR-EXP", version: "v1" }] });
    await p;
    expect(c.getState().status).toBe("configured");
  });

  it("B. Text Gemini Save -> providerId=gemini", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "gemini", modelId: "gemini-3.7-flash" });
    c.setApiKey(SENTINEL);
    const p = c.save();
    const post = pending.find((x) => x.method === "POST" && x.path === SESSION_KEY_API_PATH);
    expect(post!.body.providerId).toBe("gemini");
    settle(pending, "POST", SESSION_KEY_API_PATH, { providerId: "gemini", storageScope: "session_only", configured: true, version: "g1" });
    await flush();
    settle(pending, "GET", "status", STATUS_BOTH);
    await p;
    expect(c.getState().status).toBe("configured");
  });

  it("E. Image OpenRouter Image Save -> providerId=openrouter-image", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, IMAGE_PROVIDERS, { providerId: "openrouter-image", modelId: "google/gemini-2.5-flash-image" });
    c.setApiKey(SENTINEL);
    const p = c.save();
    const post = pending.find((x) => x.method === "POST" && x.path === SESSION_KEY_API_PATH);
    expect(post!.body.providerId).toBe("openrouter-image");
    settle(pending, "POST", SESSION_KEY_API_PATH, { providerId: "openrouter-image", storageScope: "session_only", configured: true, version: "oi1" });
    await flush();
    settle(pending, "GET", "status", { providers: [{ providerId: "openrouter-image", storageScope: "session_only", configured: true, expiresAt: "OI-EXP", version: "oi1" }] });
    await p;
    expect(c.getState().status).toBe("configured");
  });

  it("I. Image Gemini Image Save -> providerId=gemini-image", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, IMAGE_PROVIDERS, { providerId: "gemini-image", modelId: "gemini-2.5-flash-image" });
    c.setApiKey(SENTINEL);
    const p = c.save();
    const post = pending.find((x) => x.method === "POST" && x.path === SESSION_KEY_API_PATH);
    expect(post!.body.providerId).toBe("gemini-image");
    settle(pending, "POST", SESSION_KEY_API_PATH, { providerId: "gemini-image", storageScope: "session_only", configured: true, version: "gi1" });
    await flush();
    settle(pending, "GET", "status", STATUS_BOTH);
    await p;
    expect(c.getState().status).toBe("configured");
  });
});

describe("Compact binding — Test Connection exact-ID proof", () => {
  it("B. Text OpenRouter Test -> openrouter + session_only + selected model", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "openrouter", modelId: "openai/gpt-4o-mini" });
    const p = c.test();
    const post = pending.find((x) => x.method === "POST" && x.path === PROVIDER_TEST_CONNECTION_API_PATH);
    expect(post!.body).toEqual({
      providerId: "openrouter",
      kind: "text",
      modelId: "openai/gpt-4o-mini",
      credentialSource: "session_only",
    });
    expect("apiKey" in post!.body).toBe(false);
    settle(pending, "POST", "test-connection", { ok: true, providerId: "openrouter", model: "openai/gpt-4o-mini", credentialSource: "session_only" });
    await p;
    expect(c.getState().testResult?.providerId).toBe("openrouter");
    expect(c.getState().testResult?.credentialSource).toBe("session_only");
  });

  it("F. Image OpenRouter Image Test -> openrouter-image + session_only", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, IMAGE_PROVIDERS, { providerId: "openrouter-image", modelId: "google/gemini-2.5-flash-image" });
    const p = c.test();
    const post = pending.find((x) => x.method === "POST" && x.path === PROVIDER_TEST_CONNECTION_API_PATH);
    expect(post!.body).toEqual({
      providerId: "openrouter-image",
      kind: "image",
      modelId: "google/gemini-2.5-flash-image",
      credentialSource: "session_only",
    });
    settle(pending, "POST", "test-connection", { ok: true, providerId: "openrouter-image", credentialSource: "session_only" });
    await p;
    expect(c.getState().testResult?.providerId).toBe("openrouter-image");
  });

  it("I. Gemini / Gemini Image Test target their exact ids", async () => {
    const { network, pending } = makeNetwork();
    const g = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "gemini", modelId: "gemini-3.7-flash" });
    const gp = g.test();
    const gPost = pending.find((x) => x.method === "POST" && x.path === PROVIDER_TEST_CONNECTION_API_PATH);
    expect(gPost!.body.providerId).toBe("gemini");
    settle(pending, "POST", "test-connection", { ok: true, providerId: "gemini", credentialSource: "session_only" });
    await gp;

    const { network: n2, pending: p2 } = makeNetwork();
    const gi = new SessionKeyController(n2, IMAGE_PROVIDERS, { providerId: "gemini-image", modelId: "gemini-2.5-flash-image" });
    const gip = gi.test();
    const giPost = p2.find((x) => x.method === "POST" && x.path === PROVIDER_TEST_CONNECTION_API_PATH);
    expect(giPost!.body.providerId).toBe("gemini-image");
    settle(p2, "POST", "test-connection", { ok: true, providerId: "gemini-image", credentialSource: "session_only" });
    await gip;
    expect(gi.getState().testResult?.providerId).toBe("gemini-image");
  });

  it("syncLockedModel drives Test Connection to the card's currently selected model", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "openrouter", modelId: "openai/gpt-4o-mini" });
    c.syncLockedModel("openai/gpt-4o");
    const p = c.test();
    const post = pending.find((x) => x.method === "POST" && x.path === PROVIDER_TEST_CONNECTION_API_PATH);
    expect(post!.body.modelId).toBe("openai/gpt-4o");
    settle(pending, "POST", "test-connection", { ok: true, providerId: "openrouter", credentialSource: "session_only" });
    await p;
  });
});

describe("Compact binding — Revoke exact-ID proof", () => {
  it("C. Text OpenRouter Revoke -> DELETE /openrouter only", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "openrouter" });
    const p = c.revoke();
    const del = pending.find((x) => x.method === "DELETE");
    expect(del!.path).toBe(`${SESSION_KEY_API_PATH}/openrouter`);
    settle(pending, "DELETE", SESSION_KEY_API_PATH, { providerId: "openrouter", configured: false });
    await flush();
    settle(pending, "GET", "status", STATUS_BOTH);
    await p;
    expect(c.getState().status).toBe("not-configured");
  });

  it("G. Image OpenRouter Image Revoke -> DELETE /openrouter-image only", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, IMAGE_PROVIDERS, { providerId: "openrouter-image" });
    const p = c.revoke();
    const del = pending.find((x) => x.method === "DELETE");
    expect(del!.path).toBe(`${SESSION_KEY_API_PATH}/openrouter-image`);
    settle(pending, "DELETE", SESSION_KEY_API_PATH, { providerId: "openrouter-image", configured: false });
    await flush();
    settle(pending, "GET", "status", STATUS_BOTH);
    await p;
  });

  it("I. Gemini / Gemini Image Revoke target their exact paths", async () => {
    const { network, pending } = makeNetwork();
    const g = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "gemini" });
    void g.revoke();
    expect(pending.find((x) => x.method === "DELETE")!.path).toBe(`${SESSION_KEY_API_PATH}/gemini`);

    const { network: n2, pending: p2 } = makeNetwork();
    const gi = new SessionKeyController(n2, IMAGE_PROVIDERS, { providerId: "gemini-image" });
    void gi.revoke();
    expect(p2.find((x) => x.method === "DELETE")!.path).toBe(`${SESSION_KEY_API_PATH}/gemini-image`);
  });
});

describe("Compact binding — Status refresh exact-ID proof", () => {
  it("D. Text OpenRouter status reflects the openrouter row, not gemini", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "openrouter" });
    const p = c.refreshStatus();
    settle(pending, "GET", "status", STATUS_BOTH);
    await p;
    // Gemini is configured=true in the same payload; OpenRouter is false.
    expect(c.getState().status).toBe("not-configured");
    expect(c.getState().expiresAt).toBeUndefined();
  });

  it("H. Image OpenRouter Image status reflects the openrouter-image row", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, IMAGE_PROVIDERS, { providerId: "openrouter-image" });
    const p = c.refreshStatus();
    settle(pending, "GET", "status", STATUS_BOTH);
    await p;
    expect(c.getState().status).toBe("not-configured");
  });

  it("I. Gemini / Gemini Image status reflects their exact configured rows", async () => {
    const { network, pending } = makeNetwork();
    const g = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "gemini" });
    const gp = g.refreshStatus();
    settle(pending, "GET", "status", STATUS_BOTH);
    await gp;
    expect(g.getState().status).toBe("configured");
    expect(g.getState().expiresAt).toBe("G-EXP");

    const { network: n2, pending: p2 } = makeNetwork();
    const gi = new SessionKeyController(n2, IMAGE_PROVIDERS, { providerId: "gemini-image" });
    const gip = gi.refreshStatus();
    settle(p2, "GET", "status", STATUS_BOTH);
    await gip;
    expect(gi.getState().status).toBe("configured");
    expect(gi.getState().expiresAt).toBe("GI-EXP");
  });
});

describe("Compact binding — provider switch safety", () => {
  it("J. switching Gemini -> OpenRouter rebinds and does not migrate a secret", async () => {
    const { network, pending } = makeNetwork();
    const gemini = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "gemini" });
    gemini.setApiKey(SENTINEL);
    const geminiStatus = gemini.refreshStatus();
    // The card remounts for the new provider: the old controller is disposed.
    gemini.dispose();

    const openrouter = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "openrouter" });
    const openrouterStatus = openrouter.refreshStatus();

    // Late Gemini response arrives AFTER the switch.
    settle(pending, "GET", "status", STATUS_BOTH); // gemini (now stale)
    settle(pending, "GET", "status", STATUS_BOTH); // openrouter
    await geminiStatus;
    await openrouterStatus;

    expect(gemini.getState().apiKey).toBe("");
    expect(openrouter.getState().selectedProviderId).toBe("openrouter");
    expect(openrouter.getState().apiKey).toBe("");
    // No paid provider call is triggered by changing the selection.
    expect(pending.filter((x) => x.method === "POST" && x.path.includes("test-connection"))).toHaveLength(0);
  });

  it("K. a late old-provider status cannot overwrite the new provider's status", async () => {
    // Card-level resolver: a Gemini signal never counts for an OpenRouter card.
    expect(resolveSessionConfigured({ providerId: "gemini", configured: true }, "openrouter")).toBe(false);
    expect(resolveSessionConfigured({ providerId: "gemini", configured: false }, "openrouter")).toBe(false);
    expect(resolveSessionConfigured({ providerId: "openrouter", configured: true }, "openrouter")).toBe(true);
    expect(resolveSessionConfigured(null, "openrouter")).toBe(false);
    expect(resolveSessionConfigured({ providerId: "openrouter", configured: true }, undefined)).toBe(false);

    // Controller-level: the disposed Gemini controller drops the late response.
    const { network, pending } = makeNetwork();
    const gemini = new SessionKeyController(network, TEXT_PROVIDERS, { providerId: "gemini" });
    const geminiStatus = gemini.refreshStatus();
    gemini.dispose();
    settle(pending, "GET", "status", STATUS_BOTH);
    await geminiStatus;
    expect(gemini.getState().status).toBe("loading");

    const { network: n2, pending: p2 } = makeNetwork();
    const openrouter = new SessionKeyController(n2, TEXT_PROVIDERS, { providerId: "openrouter" });
    const openrouterStatus = openrouter.refreshStatus();
    settle(p2, "GET", "status", STATUS_BOTH);
    await openrouterStatus;
    expect(openrouter.getState().status).toBe("not-configured");
  });
});

describe("Compact binding — card wiring (SSR)", () => {
  const FULL_TEXT_PROVIDERS = [
    { providerId: "gemini", name: "Google Gemini", models: [{ id: "gemini-3.7-flash", default: true }] },
    { providerId: "openrouter", name: "OpenRouter", models: [{ id: "openai/gpt-4o-mini", default: true }] },
  ];
  const FULL_IMAGE_PROVIDERS = [
    { providerId: "gemini-image", name: "Google Gemini Image", models: [{ id: "gemini-2.5-flash-image", default: true }] },
    { providerId: "openrouter-image", name: "OpenRouter Image", models: [{ id: "google/gemini-2.5-flash-image", default: true }] },
  ];

  function renderCard(
    kind: "text" | "image",
    providerId: string,
    modelId: string,
    providers: { providerId: string; name: string; models: { id: string; default: boolean }[] }[]
  ): string {
    const selection = {
      mode: "user_selected" as const,
      providerId,
      modelId,
      credentialSource: "session_only" as const,
    };
    return renderToString(
      <SelectionControlCard
        kind={kind}
        label={kind === "text" ? "Text AI" : "Image AI"}
        allowed
        effective={selection}
        draft={selection}
        providers={providers}
        sessionByokSupported
        network={stubNetwork()}
        onChangeDraft={() => {}}
        onReset={() => {}}
        onTestServerEnvironment={() => {}}
      />
    );
  }

  it("binds the compact Text panel to the SELECTED provider (OpenRouter), never providers[0] (Gemini)", () => {
    const html = renderCard("text", "openrouter", "openai/gpt-4o-mini", FULL_TEXT_PROVIDERS);
    expect(html).toContain('data-session-bound-provider="openrouter"');
    expect(html).toContain('data-session-bound-model="openai/gpt-4o-mini"');
    expect(html).not.toContain('data-session-bound-provider="gemini"');
  });

  it("binds the compact Image panel to openrouter-image, never providers[0] (gemini-image)", () => {
    const html = renderCard("image", "openrouter-image", "google/gemini-2.5-flash-image", FULL_IMAGE_PROVIDERS);
    expect(html).toContain('data-session-bound-provider="openrouter-image"');
    expect(html).toContain('data-session-bound-model="google/gemini-2.5-flash-image"');
    expect(html).not.toContain('data-session-bound-provider="gemini-image"');
  });

  it("binds Gemini / Gemini Image cards to their exact ids", () => {
    const text = renderCard("text", "gemini", "gemini-3.7-flash", FULL_TEXT_PROVIDERS);
    expect(text).toContain('data-session-bound-provider="gemini"');
    const image = renderCard("image", "gemini-image", "gemini-2.5-flash-image", FULL_IMAGE_PROVIDERS);
    expect(image).toContain('data-session-bound-provider="gemini-image"');
  });

  it("L. never renders a secret and the key input value is always empty", () => {
    const html = renderCard("text", "openrouter", "openai/gpt-4o-mini", FULL_TEXT_PROVIDERS);
    expect(html).toContain('type="password"');
    expect(html).toMatch(/data-session-key-input="true"[^>]*value=""/);
    expect(html).not.toContain(SENTINEL);
    expect(html).not.toContain("apiKey");
  });
});

describe("Compact binding — legacy / full SessionKeyPanel behavior preserved", () => {
  it("M. an UNLOCKED controller still initializes from providers[0] and can switch providers", () => {
    const { network } = makeNetwork();
    const c = new SessionKeyController(network, TEXT_PROVIDERS);
    expect(c.getState().selectedProviderId).toBe("gemini");
    expect(c.getState().selectedModelId).toBe("gemini-3.7-flash");
    c.selectProvider("openrouter");
    expect(c.getState().selectedProviderId).toBe("openrouter");
    c.selectModel("openai/gpt-4o-mini");
    expect(c.getState().selectedModelId).toBe("openai/gpt-4o-mini");
  });

  it("M. full (non-compact) panel still renders the provider selector", () => {
    const html = renderToString(
      <SessionKeyPanel
        network={stubNetwork()}
        sessionByokSupported
        providers={TEXT_PROVIDERS}
      />
    );
    expect(html).toContain('data-session-provider-select="true"');
    expect(html).toContain("Session API Keys");
  });

  it("M. a locked compact panel hides the provider selector but keeps the key input", () => {
    const html = renderToString(
      <SessionKeyPanel
        network={stubNetwork()}
        sessionByokSupported
        providers={[TEXT_PROVIDERS[1]]}
        compact
        lockedProviderId="openrouter"
        lockedModelId="openai/gpt-4o-mini"
      />
    );
    expect(html).not.toContain('data-session-provider-select="true"');
    expect(html).toContain('data-session-key-input="true"');
    expect(html).toContain('data-session-bound-provider="openrouter"');
  });
});

// Keep the SettingsAdapter import used (parity with the rest of the suite).
void stubSettings;
