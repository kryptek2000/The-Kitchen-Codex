import { describe, it, expect, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ProviderSelectionPanel,
  ProviderStatusPanel,
  connectionTestSuccessLabel,
  shouldClearSessionKeyOnCredentialSource,
  buildServerEnvironmentTestBody,
  PROVIDER_CATALOG_UNAVAILABLE_COPY,
} from "../../src/application-ui/ProviderSettings.js";
import type { ProviderCatalogView } from "../../src/application-ui/providerCatalog.js";
import type { NetworkAdapter } from "../../src/application/adapters/NetworkAdapter.js";
import type { SettingsAdapter } from "../../src/application/adapters/SettingsAdapter.js";
import { saveAiSelection, resetAiSelection } from "../../src/application/aiSelection.js";

const SENTINEL = "SUPER_SECRET_BYOK4_SENTINEL";

function stubSettings(): SettingsAdapter {
  return { get: async () => undefined, set: async () => {}, remove: async () => {} };
}

afterEach(async () => {
  // Restore the in-memory cache so a preserved stale selection never leaks into
  // later tests.
  await resetAiSelection(stubSettings(), "text");
  await resetAiSelection(stubSettings(), "image");
});

function stubNetwork(): NetworkAdapter {
  return {
    request: async () => ({ status: 200, ok: true, data: undefined }),
    get: async () => ({ status: 200, ok: true, data: undefined }),
    post: async () => ({ status: 200, ok: true, data: undefined }),
  };
}

function catalog(allowed: { text: boolean; image: boolean }): ProviderCatalogView {
  return {
    textProviders: [
      {
        providerId: "gemini",
        name: "Google Gemini",
        configured: true,
        enabled: true,
        available: true,
        storageScope: "server_environment",
        supportsSecretWrites: false,
        connectionTest: "network_probe",
        selectable: true,
        sessionKeySupported: true,
        models: [
          { id: "gemini-3.7-flash", default: true, capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true } },
        ],
      },
    ],
    imageProviders: [
      {
        providerId: "gemini-image",
        name: "Google Gemini Image",
        configured: true,
        enabled: true,
        available: true,
        imageGeneration: true,
        connectionTest: "credential_check",
        selectable: true,
        sessionKeySupported: true,
        formats: ["image/png"],
        maxBytes: 4 * 1024 * 1024,
        models: [{ id: "gemini-2.5-flash-image", default: true }],
      },
    ],
    selection: {
      text: { selectionMode: "server_default", valid: true },
      image: { selectionMode: "server_default", valid: true },
      userSelectionAllowed: allowed,
      executable: { text: allowed.text, image: allowed.image },
    },
    sessionByokSupported: true,
  };
}

/**
 * BYOK-5F: a catalog where OpenRouter text/image are env-UNAVAILABLE (no operator
 * key) but server-declared session-capable, with session BYOK supported.
 */
function sessionCapableCatalog(): ProviderCatalogView {
  const c = catalog({ text: true, image: true });
  c.sessionByokSupported = true;
  c.textProviders.push({
    providerId: "openrouter",
    name: "OpenRouter",
    configured: false,
    enabled: false,
    available: false,
    storageScope: "server_environment",
    supportsSecretWrites: false,
    connectionTest: "unavailable",
    selectable: false,
    sessionKeySupported: true,
    models: [
      { id: "openai/gpt-4o-mini", default: true, capabilities: { reasoning: false, structuredOutput: true, recipeGeneration: true, webSearch: false } },
    ],
  });
  c.imageProviders.push({
    providerId: "openrouter-image",
    name: "OpenRouter Image",
    configured: false,
    enabled: false,
    available: false,
    imageGeneration: true,
    connectionTest: "unavailable",
    selectable: false,
    sessionKeySupported: true,
    formats: ["image/png"],
    maxBytes: 4 * 1024 * 1024,
    models: [{ id: "google/gemini-2.5-flash-image", default: true }],
  });
  return c;
}

function render(el: React.ReactElement): string {
  return renderToString(el);
}

describe("BYOK-4 — ProviderSelectionPanel (interactive selection)", () => {
  it("renders interactive mode/provider/model controls when user selection is allowed", () => {
    const html = render(
      <ProviderSelectionPanel catalog={catalog({ text: true, image: true })} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain("Your AI Provider Selection");
    expect(html).toContain('data-selection-control-kind="text"');
    expect(html).toContain('data-selection-control-kind="image"');
    expect(html).toContain('data-selection-mode-select="text"');
    expect(html).toContain('data-selection-mode-select="image"');
    expect(html).toContain("Server default");
    expect(html).toContain("Use my selection");
    expect(html).toContain("Apply selection");
    expect(html).not.toContain("Server locked");
  });

  it("locks a surface (read-only) when a server pin blocks user selection", () => {
    const html = render(
      <ProviderSelectionPanel catalog={catalog({ text: false, image: true })} settings={stubSettings()} network={stubNetwork()} />
    );
    // Text surface is locked: no interactive controls, "Server locked" badge.
    expect(html).toContain("Server locked");
    expect(html).not.toContain('data-selection-mode-select="text"');
    // Image surface remains interactive.
    expect(html).toContain('data-selection-mode-select="image"');
  });

  it("shows the pinned provider read-only when locked (fail-closed messaging, no selection controls)", () => {
    const c = catalog({ text: false, image: true });
    c.selection.text = { selectionMode: "server_managed", selectedProviderId: "openrouter", selectedModelId: "openai/gpt-4o-mini", valid: true };
    const html = render(<ProviderSelectionPanel catalog={c} settings={stubSettings()} network={stubNetwork()} />);
    const lockedCard = html.slice(html.indexOf('data-selection-control-kind="text"'), html.indexOf('data-selection-control-kind="image"'));
    expect(lockedCard).toContain("openrouter");
    expect(lockedCard).toContain("openai/gpt-4o-mini");
    expect(lockedCard).not.toContain("<select");
  });

  it("renders a Test Connection button per provider (text + image) with bounded labels", () => {
    const html = render(
      <ProviderSelectionPanel catalog={catalog({ text: true, image: true })} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-connection-test-provider="gemini"');
    expect(html).toContain('data-connection-test-provider="gemini-image"');
    expect((html.match(/Test Connection/g) || []).length).toBe(2);
  });

  it("renders the truthful connection-test kind labels in the read-only catalog cards", () => {
    const html = render(
      <ProviderStatusPanel statuses={[]} catalog={catalog({ text: true, image: true })} onRefresh={() => {}} />
    );
    expect(html).toContain("Network probe");
    expect(html).toContain("Credential check");
  });

  it("never renders a secret value, secret-shaped input, or key-entry control anywhere", () => {
    // Belt-and-braces: even if secret-shaped props were smuggled into the view
    // model, the presentational panel only reads allowlisted fields.
    const c = catalog({ text: true, image: true });
    const smuggled = {
      ...c,
      textProviders: [{ ...c.textProviders[0], ...({ apiKey: SENTINEL, token: SENTINEL } as Record<string, unknown>) }] as unknown as ProviderCatalogView["textProviders"],
    };
    const html = render(<ProviderSelectionPanel catalog={smuggled} settings={stubSettings()} network={stubNetwork()} />);
    expect(html).not.toContain(SENTINEL);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Save key");
    expect(html).not.toContain("Add key");
    expect(html).not.toContain("Delete key");
    expect(html).not.toContain("Reveal key");
    expect(html).not.toContain("GEMINI_API_KEY");
    expect(html).not.toContain("OPENROUTER_API_KEY");
    expect(html).not.toContain("DEEPSEEK_API_KEY");
  });

  it("BYOK-5E/5F: BOTH surfaces offer a credential-source selector (Server environment / Session only)", async () => {
    const c = catalog({ text: true, image: true });
    await saveAiSelection(stubSettings(), "text", "user_selected", "gemini", "gemini-3.7-flash", "server_environment");
    await saveAiSelection(stubSettings(), "image", "user_selected", "gemini-image", "gemini-2.5-flash-image", "server_environment");
    const html = render(
      <ProviderSelectionPanel catalog={c} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-selection-credential-source-select="text"');
    expect(html).toContain('data-selection-credential-source-select="image"');
    expect(html).toContain("Server environment");
    expect(html).toContain("Session only");
    // The selection metadata never carries a key.
    expect(html).not.toContain("apiKey");
    expect(html).not.toContain("Session-key image generation is not enabled yet");
  });

  it("BYOK-5E: reset to server_default (and any non-session source) clears the typed session key", () => {
    // The Reset-to-default path emits `undefined`, which must clear the key.
    expect(shouldClearSessionKeyOnCredentialSource(undefined)).toBe(true);
    expect(shouldClearSessionKeyOnCredentialSource("server_environment")).toBe(true);
    expect(shouldClearSessionKeyOnCredentialSource("session_only")).toBe(false);
  });

  it("warns (and preserves) an explicit selection whose provider is now UNAVAILABLE", async () => {
    const c = catalog({ text: true, image: true });
    c.textProviders[0].available = false;
    c.textProviders[0].selectable = false;
    await saveAiSelection(stubSettings(), "text", "user_selected", "gemini", "gemini-3.7-flash");
    const html = render(
      <ProviderSelectionPanel catalog={c} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-selection-invalid="text"');
    expect(html).toContain("Your saved selection is no longer available");
  });

  it("warns (and preserves) an explicit selection whose provider is now UNSELECTABLE", async () => {
    const c = catalog({ text: true, image: true });
    c.textProviders[0].selectable = false;
    await saveAiSelection(stubSettings(), "text", "user_selected", "gemini", "gemini-3.7-flash");
    const html = render(
      <ProviderSelectionPanel catalog={c} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-selection-invalid="text"');
    expect(html).toContain("Your saved selection is no longer available");
  });

  it("warns for a stale model that is no longer curated", async () => {
    const c = catalog({ text: true, image: true });
    c.textProviders[0].models = [];
    await saveAiSelection(stubSettings(), "text", "user_selected", "gemini", "gemini-removed-model");
    const html = render(
      <ProviderSelectionPanel catalog={c} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-selection-invalid="text"');
  });

  it("labels an image credential check truthfully (never 'Connected · model')", () => {
    expect(connectionTestSuccessLabel("credential_check", "gemini-2.5-flash-image")).toBe("Credential check passed");
    expect(connectionTestSuccessLabel("network_probe", "gemini-3.7-flash")).toBe("Connected · gemini-3.7-flash");
    expect(connectionTestSuccessLabel("network_probe")).toBe("Connected");
  });

  it("catalog-unavailable copy never promises a server-default fallback", () => {
    expect(PROVIDER_CATALOG_UNAVAILABLE_COPY.toLowerCase()).not.toContain("server default");
    expect(PROVIDER_CATALOG_UNAVAILABLE_COPY.toLowerCase()).not.toContain("will use the server");
    expect(PROVIDER_CATALOG_UNAVAILABLE_COPY).toContain("fails closed");
  });

  it("surfaces the server runtime PROVIDER-AVAILABILITY truth (selection.executable), not an operation claim", () => {
    const c = catalog({ text: true, image: true });
    c.selection.executable = { text: false, image: true };
    const html = render(<ProviderStatusPanel statuses={[]} catalog={c} onRefresh={() => {}} />);
    expect(html).toContain('data-selection-executable="text"');
    expect(html).toContain('data-selection-executable="image"');
    expect(html).toMatch(/Runtime provider:.*Unavailable/);
    expect(html).toMatch(/Runtime provider:.*Available/);
    // Never overstate as a generic operation-readiness claim.
    expect(html).not.toContain("Runtime: Executable");
    expect(html).not.toContain(">Executable<");
  });

  it("does not label an availability-only provider (e.g. DeepSeek) as generically 'Executable'", () => {
    const c = catalog({ text: true, image: true });
    // A configured/available provider that cannot satisfy any current app AI
    // operation (no schema-constrained structured output / no webSearch) is
    // still "available" — the UI must NOT claim operation readiness.
    c.selection.executable = { text: true, image: false };
    const html = render(<ProviderStatusPanel statuses={[]} catalog={c} onRefresh={() => {}} />);
    expect(html).toMatch(/Runtime provider:.*Available/);
    expect(html).not.toContain("Runtime: Executable");
  });

  it("disables Test Connection for a provider whose connectionTest is unavailable", () => {
    const c = catalog({ text: true, image: true });
    c.textProviders[0].connectionTest = "unavailable";
    c.textProviders[0].available = false;
    const html = render(
      <ProviderSelectionPanel catalog={c} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-connection-test-provider="gemini"');
    expect(html).toMatch(/<button[^>]*data-connection-test-run="text:gemini"[^>]*disabled=""/);
    // The available provider's button remains enabled.
    expect(html).not.toMatch(/<button[^>]*data-connection-test-run="image:gemini-image"[^>]*disabled=""/);
  });
});

describe("BYOK-5F — credential-source-aware provider selection", () => {
  it("A. a session-capable provider with NO operator key is offered when session BYOK is supported", async () => {
    // Open the interactive (user_selected) controls for both surfaces first.
    await saveAiSelection(stubSettings(), "text", "user_selected", "gemini", "gemini-3.7-flash", "server_environment");
    await saveAiSelection(stubSettings(), "image", "user_selected", "gemini-image", "gemini-2.5-flash-image", "server_environment");
    const html = render(
      <ProviderSelectionPanel catalog={sessionCapableCatalog()} settings={stubSettings()} network={stubNetwork()} />
    );
    const textCard = html.slice(
      html.indexOf('data-selection-control-kind="text"'),
      html.indexOf('data-selection-control-kind="image"')
    );
    expect(textCard).toContain('value="openrouter"');
    const imageCard = html.slice(html.indexOf('data-selection-control-kind="image"'));
    expect(imageCard).toContain('value="openrouter-image"');
  });

  it("B. the SAME env-unavailable provider under server_environment stays INVALID (fail closed)", async () => {
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "server_environment");
    const html = render(
      <ProviderSelectionPanel catalog={sessionCapableCatalog()} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-selection-invalid="text"');
  });

  it("C. a saved session_only selection is VALID even when the operator env key is absent", async () => {
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    const html = render(
      <ProviderSelectionPanel catalog={sessionCapableCatalog()} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).not.toContain('data-selection-invalid="text"');
  });

  it("G. image parity: session_only openrouter-image is offered and valid with no operator key", async () => {
    await saveAiSelection(stubSettings(), "image", "user_selected", "openrouter-image", "google/gemini-2.5-flash-image", "session_only");
    const html = render(
      <ProviderSelectionPanel catalog={sessionCapableCatalog()} settings={stubSettings()} network={stubNetwork()} />
    );
    const imageCard = html.slice(html.indexOf('data-selection-control-kind="image"'));
    expect(imageCard).toContain('value="openrouter-image"');
    expect(html).not.toContain('data-selection-invalid="image"');
  });

  it("H. exact-ID isolation: openrouter != openrouter-image (cross-surface ids are invalid)", async () => {
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter-image", undefined, "session_only");
    await saveAiSelection(stubSettings(), "image", "user_selected", "openrouter", undefined, "session_only");
    const html = render(
      <ProviderSelectionPanel catalog={sessionCapableCatalog()} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-selection-invalid="text"');
    expect(html).toContain('data-selection-invalid="image"');
  });

  it("session_only is INVALID when the deployment does not support session BYOK", async () => {
    const c = sessionCapableCatalog();
    c.sessionByokSupported = false;
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    const html = render(<ProviderSelectionPanel catalog={c} settings={stubSettings()} network={stubNetwork()} />);
    expect(html).toContain('data-selection-invalid="text"');
  });

  it("F. the upper Server Environment test body is ALWAYS server_environment and never carries a key", () => {
    expect(buildServerEnvironmentTestBody("openrouter", "text", "openai/gpt-4o-mini")).toEqual({
      providerId: "openrouter",
      kind: "text",
      modelId: "openai/gpt-4o-mini",
      credentialSource: "server_environment",
    });
    expect(buildServerEnvironmentTestBody("openrouter-image", "image").credentialSource).toBe("server_environment");
    expect(JSON.stringify(buildServerEnvironmentTestBody("openrouter", "text"))).not.toContain("apiKey");
  });

  it("renames the upper section and explains env vs session testing truthfully", () => {
    const html = render(
      <ProviderSelectionPanel catalog={sessionCapableCatalog()} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain("Server Environment Connection Tests");
    expect(html).toContain("Session API Keys below");
    // A session-capable provider with no env key is NOT generically "unavailable".
    expect(html).toContain("Environment credential unavailable. This provider is session-capable");
  });
});