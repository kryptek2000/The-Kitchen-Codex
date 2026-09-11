import { describe, it, expect, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ProviderSelectionPanel,
  ProviderStatusPanel,
  SelectionControlCard,
  connectionTestSuccessLabel,
  shouldClearSessionKeyOnCredentialSource,
  buildServerEnvironmentTestBody,
  activeSelectionLabel,
  applyDraftSync,
  resetDraftSync,
  selectionPersistenceNotice,
  providerSelectionReducer,
  initialProviderSelectionControlState,
  PROVIDER_CATALOG_UNAVAILABLE_COPY,
} from "../../src/application-ui/ProviderSettings.js";
import type { ProviderCatalogView } from "../../src/application-ui/providerCatalog.js";
import type { NetworkAdapter } from "../../src/application/adapters/NetworkAdapter.js";
import type { SettingsAdapter } from "../../src/application/adapters/SettingsAdapter.js";
import {
  saveAiSelection,
  resetAiSelection,
  saveAiSelectionWithOutcome,
  resetAiSelectionWithOutcome,
  buildAiSelectionRequestOptions,
  TEXT_SELECTION_HEADER,
  IMAGE_SELECTION_HEADER,
  type SavedAiSelections,
} from "../../src/application/aiSelection.js";

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
describe("BYOK-5F — Provider Selection Apply/Reset control UX", () => {
  const SERVER_DEFAULT = { mode: "server_default" as const };
  const TEXT_SELECTED = {
    mode: "user_selected" as const,
    providerId: "openrouter",
    modelId: "openai/gpt-4o-mini",
    credentialSource: "session_only" as const,
  };
  const IMAGE_SELECTED = {
    mode: "user_selected" as const,
    providerId: "openrouter-image",
    modelId: "google/gemini-2.5-flash-image",
    credentialSource: "session_only" as const,
  };

  it("A. applyDraftSync updates ONLY the text draft to the applied selection; the label reflects it", () => {
    const drafts = { text: { ...SERVER_DEFAULT }, image: { ...SERVER_DEFAULT } };
    const next = applyDraftSync(drafts, "text", TEXT_SELECTED);
    expect(next.text).toEqual(TEXT_SELECTED);
    expect(next.image).toEqual(SERVER_DEFAULT);
    expect(activeSelectionLabel(next.text, [{ providerId: "openrouter", name: "OpenRouter" }])).toBe(
      "OpenRouter / openai/gpt-4o-mini / Session only"
    );
  });

  it("B. applyDraftSync updates ONLY the image draft to the applied selection", () => {
    const drafts = { text: { ...SERVER_DEFAULT }, image: { ...SERVER_DEFAULT } };
    const next = applyDraftSync(drafts, "image", IMAGE_SELECTED);
    expect(next.image).toEqual(IMAGE_SELECTED);
    expect(next.text).toEqual(SERVER_DEFAULT);
    expect(
      activeSelectionLabel(next.image, [{ providerId: "openrouter-image", name: "OpenRouter Image" }])
    ).toBe("OpenRouter Image / google/gemini-2.5-flash-image / Session only");
  });

  it("C. resetDraftSync resets ONLY the text draft to server_default", () => {
    const drafts = { text: { ...TEXT_SELECTED }, image: { ...IMAGE_SELECTED } };
    const next = resetDraftSync(drafts, "text");
    expect(next.text).toEqual({
      mode: "server_default",
      providerId: undefined,
      modelId: undefined,
      credentialSource: undefined,
    });
    expect(next.image).toEqual(IMAGE_SELECTED);
    expect(activeSelectionLabel(next.text)).toBe("Server default");
  });

  it("D. resetDraftSync resets ONLY the image draft to server_default", () => {
    const drafts = { text: { ...TEXT_SELECTED }, image: { ...IMAGE_SELECTED } };
    const next = resetDraftSync(drafts, "image");
    expect(next.image).toEqual({
      mode: "server_default",
      providerId: undefined,
      modelId: undefined,
      credentialSource: undefined,
    });
    expect(next.text).toEqual(TEXT_SELECTED);
  });

  it("E. applying text openrouter/session_only yields the EXACT text request metadata", async () => {
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    const opts = await buildAiSelectionRequestOptions(undefined, undefined, "text");
    expect(opts.headers![TEXT_SELECTION_HEADER]).toBe(
      JSON.stringify({
        mode: "user_selected",
        providerId: "openrouter",
        modelId: "openai/gpt-4o-mini",
        credentialSource: "session_only",
      })
    );
  });

  it("F. applying image openrouter-image/session_only yields the EXACT image request metadata", async () => {
    await saveAiSelection(
      stubSettings(),
      "image",
      "user_selected",
      "openrouter-image",
      "google/gemini-2.5-flash-image",
      "session_only"
    );
    const opts = await buildAiSelectionRequestOptions(undefined, undefined, "image");
    expect(opts.headers![IMAGE_SELECTION_HEADER]).toBe(
      JSON.stringify({
        mode: "user_selected",
        providerId: "openrouter-image",
        modelId: "google/gemini-2.5-flash-image",
        credentialSource: "session_only",
      })
    );
  });

  it("G. Reset removes the explicit header for that surface only", async () => {
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    await saveAiSelection(
      stubSettings(),
      "image",
      "user_selected",
      "openrouter-image",
      "google/gemini-2.5-flash-image",
      "session_only"
    );
    let text = await buildAiSelectionRequestOptions(undefined, undefined, "text");
    expect(text.headers?.[TEXT_SELECTION_HEADER]).toBeDefined();

    await resetAiSelection(stubSettings(), "text");
    text = await buildAiSelectionRequestOptions(undefined, undefined, "text");
    const image = await buildAiSelectionRequestOptions(undefined, undefined, "image");
    expect(text.headers?.[TEXT_SELECTION_HEADER]).toBeUndefined();
    // The image surface is untouched by the text reset.
    expect(image.headers?.[IMAGE_SELECTION_HEADER]).toBeDefined();
  });

  it("H. cross-surface isolation: reset image does not affect text (and vice versa)", async () => {
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    await saveAiSelection(
      stubSettings(),
      "image",
      "user_selected",
      "openrouter-image",
      "google/gemini-2.5-flash-image",
      "session_only"
    );
    await resetAiSelection(stubSettings(), "image");
    const text = await buildAiSelectionRequestOptions(undefined, undefined, "text");
    const image = await buildAiSelectionRequestOptions(undefined, undefined, "image");
    expect(text.headers?.[TEXT_SELECTION_HEADER]).toBeDefined();
    expect(image.headers?.[IMAGE_SELECTION_HEADER]).toBeUndefined();
  });

  it("I/J. Apply and Reset perform NO provider network call (no spend)", async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args);
      throw new Error("no provider network expected");
    }) as unknown as typeof globalThis.fetch;
    try {
      await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
      await resetAiSelection(stubSettings(), "text");
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([]);
  });

  it("persistence failure is operation-local, truthful, and never triggers fallback", async () => {
    const failing = {
      get: async () => undefined,
      set: async () => {
        throw new Error("quota exceeded");
      },
      remove: async () => {},
    } as unknown as SettingsAdapter;
    const { persistenceFailed } = await saveAiSelectionWithOutcome(
      failing,
      "text",
      "user_selected",
      "openrouter",
      "openai/gpt-4o-mini",
      "session_only"
    );
    expect(persistenceFailed).toBe(true);
    expect(selectionPersistenceNotice("Selection applied", persistenceFailed)).toContain(
      "could not be saved to this browser"
    );
    // The runtime selection is STILL active in memory (no fallback).
    const opts = await buildAiSelectionRequestOptions(undefined, undefined, "text");
    expect(opts.headers?.[TEXT_SELECTION_HEADER]).toBeDefined();
  });

  it("renders the USER active-selection label distinctly from the SERVER operator truth", async () => {
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    const html = render(
      <ProviderSelectionPanel catalog={sessionCapableCatalog()} settings={stubSettings()} network={stubNetwork()} />
    );
    expect(html).toContain('data-active-selection="text"');
    expect(html).toContain("Active selection:");
    expect(html).toContain("OpenRouter / openai/gpt-4o-mini / Session only");
    const imageStart = html.indexOf('data-active-selection="image"');
    expect(html.slice(imageStart, imageStart + 300)).toContain("Server default");

    const statusHtml = render(
      <ProviderStatusPanel statuses={[]} catalog={catalog({ text: true, image: true })} onRefresh={() => {}} />
    );
    expect(statusHtml).toContain("Server Text AI");
    expect(statusHtml).toContain("Server Image AI");
    expect(statusHtml).toContain("Operator/server truth (not your browser selection).");
  });
});

describe("BYOK-5F — operation-local persistence outcome (no cross-surface contamination)", () => {
  function deferredAdapter() {
    const calls: { resolve: () => void; reject: (e: unknown) => void }[] = [];
    const adapter = {
      get: async () => undefined,
      set: () =>
        new Promise<void>((resolve, reject) => {
          calls.push({ resolve, reject });
        }),
      remove: async () => {},
    } as unknown as SettingsAdapter;
    return { adapter, calls };
  }

  const TEXT = { kind: "text" as const, mode: "user_selected" as const, providerId: "openrouter", modelId: "openai/gpt-4o-mini", credentialSource: "session_only" as const };
  const IMAGE = { kind: "image" as const, mode: "user_selected" as const, providerId: "openrouter-image", modelId: "google/gemini-2.5-flash-image", credentialSource: "session_only" as const };

  it("CASE A: text persistence FAILS while image SUCCEEDS -> notices are per-operation", async () => {
    const { adapter, calls } = deferredAdapter();
    const textP = saveAiSelectionWithOutcome(adapter, TEXT.kind, TEXT.mode, TEXT.providerId, TEXT.modelId, TEXT.credentialSource);
    const imageP = saveAiSelectionWithOutcome(adapter, IMAGE.kind, IMAGE.mode, IMAGE.providerId, IMAGE.modelId, IMAGE.credentialSource);
    expect(calls).toHaveLength(2);
    calls[0].reject(new Error("text persist failed"));
    calls[1].resolve();
    const [textOutcome, imageOutcome] = await Promise.all([textP, imageP]);

    let state = initialProviderSelectionControlState();
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "text", opId: 1 });
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "image", opId: 1 });
    state = providerSelectionReducer(state, { type: "applied", kind: "text", opId: 1, selections: textOutcome.selections, persistenceFailed: textOutcome.persistenceFailed });
    state = providerSelectionReducer(state, { type: "applied", kind: "image", opId: 1, selections: imageOutcome.selections, persistenceFailed: imageOutcome.persistenceFailed });

    expect(textOutcome.persistenceFailed).toBe(true);
    expect(imageOutcome.persistenceFailed).toBe(false);
    expect(state.notices.text).toContain("could not be saved to this browser");
    expect(state.notices.image).toBe("Selection applied");
    expect(state.notices.image).not.toContain("could not be saved");
  });

  it("CASE B: image persistence FAILS while text SUCCEEDS -> inverse notices", async () => {
    const { adapter, calls } = deferredAdapter();
    const textP = saveAiSelectionWithOutcome(adapter, TEXT.kind, TEXT.mode, TEXT.providerId, TEXT.modelId, TEXT.credentialSource);
    const imageP = saveAiSelectionWithOutcome(adapter, IMAGE.kind, IMAGE.mode, IMAGE.providerId, IMAGE.modelId, IMAGE.credentialSource);
    calls[0].resolve();
    calls[1].reject(new Error("image persist failed"));
    const [textOutcome, imageOutcome] = await Promise.all([textP, imageP]);

    let state = initialProviderSelectionControlState();
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "text", opId: 1 });
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "image", opId: 1 });
    state = providerSelectionReducer(state, { type: "applied", kind: "text", opId: 1, selections: textOutcome.selections, persistenceFailed: textOutcome.persistenceFailed });
    state = providerSelectionReducer(state, { type: "applied", kind: "image", opId: 1, selections: imageOutcome.selections, persistenceFailed: imageOutcome.persistenceFailed });

    expect(textOutcome.persistenceFailed).toBe(false);
    expect(imageOutcome.persistenceFailed).toBe(true);
    expect(state.notices.text).toBe("Selection applied");
    expect(state.notices.image).toContain("could not be saved to this browser");
  });

  it("CASE C: Reset concurrency is also operation-local", async () => {
    await saveAiSelection(stubSettings(), "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    await saveAiSelection(stubSettings(), "image", "user_selected", "openrouter-image", "google/gemini-2.5-flash-image", "session_only");
    const { adapter, calls } = deferredAdapter();
    const textP = resetAiSelectionWithOutcome(adapter, "text");
    const imageP = resetAiSelectionWithOutcome(adapter, "image");
    calls[0].reject(new Error("text reset persist failed"));
    calls[1].resolve();
    const [textOutcome, imageOutcome] = await Promise.all([textP, imageP]);

    let state = initialProviderSelectionControlState();
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "text", opId: 1 });
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "image", opId: 1 });
    state = providerSelectionReducer(state, { type: "reset", kind: "text", opId: 1, selections: textOutcome.selections, persistenceFailed: textOutcome.persistenceFailed });
    state = providerSelectionReducer(state, { type: "reset", kind: "image", opId: 1, selections: imageOutcome.selections, persistenceFailed: imageOutcome.persistenceFailed });

    expect(textOutcome.persistenceFailed).toBe(true);
    expect(imageOutcome.persistenceFailed).toBe(false);
    expect(state.notices.text).toContain("could not be saved to this browser");
    expect(state.notices.image).toBe("Reset to server default");
    expect(state.drafts.text).toEqual({ mode: "server_default", providerId: undefined, modelId: undefined, credentialSource: undefined });
    expect(state.drafts.image).toEqual({ mode: "server_default", providerId: undefined, modelId: undefined, credentialSource: undefined });
  });

  it("CASE D: a later SUCCESS never inherits a previous operation's failure", async () => {
    const failing = {
      get: async () => undefined,
      set: async () => {
        throw new Error("x");
      },
      remove: async () => {},
    } as unknown as SettingsAdapter;
    const first = await saveAiSelectionWithOutcome(failing, "text", "user_selected", "openrouter", "openai/gpt-4o-mini", "session_only");
    expect(first.persistenceFailed).toBe(true);
    const second = await saveAiSelectionWithOutcome(
      stubSettings(),
      "image",
      "user_selected",
      "openrouter-image",
      "google/gemini-2.5-flash-image",
      "session_only"
    );
    expect(second.persistenceFailed).toBe(false);
    let state = initialProviderSelectionControlState();
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "image", opId: 1 });
    state = providerSelectionReducer(state, {
      type: "applied",
      kind: "image",
      opId: 1,
      selections: second.selections,
      persistenceFailed: second.persistenceFailed,
    });
    expect(state.notices.image).toBe("Selection applied");
  });
});

describe("BYOK-5F — ProviderSelectionPanel interaction (render + Apply + Reset)", () => {
  const PROVIDERS = [
    { providerId: "openrouter", name: "OpenRouter", models: [{ id: "openai/gpt-4o-mini", default: true }] },
  ];

  function renderCard(
    state: ReturnType<typeof initialProviderSelectionControlState>,
    kind: "text" | "image"
  ): string {
    return render(
      <SelectionControlCard
        kind={kind}
        label={kind === "text" ? "Text AI" : "Image AI"}
        allowed
        effective={kind === "text" ? state.saved.textAi : state.saved.imageAi}
        draft={kind === "text" ? state.drafts.text : state.drafts.image}
        providers={PROVIDERS}
        allowSessionCredential
        notice={kind === "text" ? state.notices.text : state.notices.image}
        onChangeDraft={() => {}}
        onApply={() => {}}
        onReset={() => {}}
      />
    );
  }

  it("change draft -> Apply -> observes the active selection; Reset -> observes Server default", async () => {
    let state = initialProviderSelectionControlState();

    // 1) User changes the Text draft to OpenRouter / session_only.
    state = providerSelectionReducer(state, {
      type: "draftChanged",
      kind: "text",
      patch: {
        mode: "user_selected",
        providerId: "openrouter",
        modelId: "openai/gpt-4o-mini",
        credentialSource: "session_only",
      },
    });
    let html = renderCard(state, "text");
    expect(html).toContain('data-selection-mode-select="text"');
    expect(html).toContain('data-selection-provider-select="text"');
    expect(html).toContain("Active selection:");
    // Not yet applied -> still server default.
    expect(html).toContain("Server default");

    // 2) "Click Apply" -> operation-local save, then the component dispatches it.
    const applied = await saveAiSelectionWithOutcome(
      stubSettings(),
      "text",
      "user_selected",
      "openrouter",
      "openai/gpt-4o-mini",
      "session_only"
    );
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "text", opId: 1 });
    state = providerSelectionReducer(state, {
      type: "applied",
      kind: "text",
      opId: 1,
      selections: applied.selections,
      persistenceFailed: applied.persistenceFailed,
    });
    html = renderCard(state, "text");
    expect(html).toContain("OpenRouter / openai/gpt-4o-mini / Session only");
    expect(html).toContain("Selection applied");

    // 3) "Click Reset" -> back to server default, reflected immediately.
    const reset = await resetAiSelectionWithOutcome(stubSettings(), "text");
    state = providerSelectionReducer(state, { type: "operationStarted", kind: "text", opId: 2 });
    state = providerSelectionReducer(state, {
      type: "reset",
      kind: "text",
      opId: 2,
      selections: reset.selections,
      persistenceFailed: reset.persistenceFailed,
    });
    html = renderCard(state, "text");
    expect(html).toContain("Server default");
    expect(html).toContain("Reset to server default");
    expect(state.drafts.text.mode).toBe("server_default");
  });
});

describe("BYOK-5F — same-surface operation ordering (stale completions discarded)", () => {
  const serverDefault = (): SavedAiSelections => ({
    textAi: { mode: "server_default" },
    imageAi: { mode: "server_default" },
  });
  const textSel = (model: string): SavedAiSelections => ({
    textAi: { mode: "user_selected", providerId: "openrouter", modelId: model, credentialSource: "session_only" },
    imageAi: { mode: "server_default" },
  });
  const imageSel = (model: string): SavedAiSelections => ({
    textAi: { mode: "server_default" },
    imageAi: { mode: "user_selected", providerId: "openrouter-image", modelId: model, credentialSource: "session_only" },
  });

  const start = (s: ReturnType<typeof initialProviderSelectionControlState>, kind: "text" | "image", opId: number) =>
    providerSelectionReducer(s, { type: "operationStarted", kind, opId });
  const apply = (s: ReturnType<typeof initialProviderSelectionControlState>, kind: "text" | "image", opId: number, selections: SavedAiSelections, persistenceFailed = false) =>
    providerSelectionReducer(s, { type: "applied", kind, opId, selections, persistenceFailed });
  const reset = (s: ReturnType<typeof initialProviderSelectionControlState>, kind: "text" | "image", opId: number, selections: SavedAiSelections, persistenceFailed = false) =>
    providerSelectionReducer(s, { type: "reset", kind, opId, selections, persistenceFailed });

  it("A. Text Apply A -> Apply B, B completes first: final state is B; A is ignored", () => {
    let s = initialProviderSelectionControlState();
    s = start(s, "text", 1); // A starts
    s = start(s, "text", 2); // B starts
    s = apply(s, "text", 2, textSel("model-b")); // B completes first
    s = apply(s, "text", 1, textSel("model-a")); // stale A completes later
    expect(s.saved.textAi).toEqual({ mode: "user_selected", providerId: "openrouter", modelId: "model-b", credentialSource: "session_only" });
    expect(s.drafts.text).toEqual({ mode: "user_selected", providerId: "openrouter", modelId: "model-b", credentialSource: "session_only" });
    expect(s.notices.text).toBe("Selection applied");
    // Image untouched.
    expect(s.saved.imageAi).toEqual({ mode: "server_default" });
    expect(s.drafts.image).toEqual({ mode: "server_default", providerId: undefined, modelId: undefined, credentialSource: undefined });
  });

  it("B. Text Reset -> Apply, Apply completes first: newer Apply survives; stale Reset ignored", () => {
    let s = initialProviderSelectionControlState();
    s = start(s, "text", 1); // Reset starts
    s = start(s, "text", 2); // Apply starts (newer)
    s = apply(s, "text", 2, textSel("model-b")); // Apply completes first
    s = reset(s, "text", 1, serverDefault()); // stale Reset completes later
    expect(s.saved.textAi).toEqual({ mode: "user_selected", providerId: "openrouter", modelId: "model-b", credentialSource: "session_only" });
    expect(s.drafts.text.modelId).toBe("model-b");
    expect(s.notices.text).toBe("Selection applied");
  });

  it("C. Text Apply -> Reset, Reset completes first: final state is server_default; stale Apply ignored", () => {
    let s = initialProviderSelectionControlState();
    s = start(s, "text", 1); // Apply starts
    s = start(s, "text", 2); // Reset starts (newer)
    s = reset(s, "text", 2, serverDefault()); // Reset completes first
    s = apply(s, "text", 1, textSel("model-a")); // stale Apply completes later
    expect(s.saved.textAi).toEqual({ mode: "server_default" });
    expect(s.drafts.text).toEqual({ mode: "server_default", providerId: undefined, modelId: undefined, credentialSource: undefined });
    expect(s.notices.text).toBe("Reset to server default");
  });

  it("D. Image same-surface stale completion is discarded (openrouter-image)", () => {
    let s = initialProviderSelectionControlState();
    s = start(s, "image", 1);
    s = start(s, "image", 2);
    s = apply(s, "image", 2, imageSel("google/gemini-2.5-flash-image"));
    s = apply(s, "image", 1, imageSel("stale/old-model"));
    expect(s.saved.imageAi).toEqual({ mode: "user_selected", providerId: "openrouter-image", modelId: "google/gemini-2.5-flash-image", credentialSource: "session_only" });
    expect(s.drafts.image.modelId).toBe("google/gemini-2.5-flash-image");
    // Text untouched.
    expect(s.saved.textAi).toEqual({ mode: "server_default" });
  });

  it("E. cross-surface operations are INDEPENDENT (a newer image op does not invalidate an in-flight text op)", () => {
    let s = initialProviderSelectionControlState();
    s = start(s, "text", 1);
    s = start(s, "image", 1); // independent counter
    s = apply(s, "text", 1, textSel("model-a")); // text op still valid
    s = apply(s, "image", 1, imageSel("google/gemini-2.5-flash-image"));
    expect(s.saved.textAi.modelId).toBe("model-a");
    expect(s.saved.imageAi.providerId).toBe("openrouter-image");
  });

  it("F/G/H. a stale completion cannot overwrite the newer notice, draft, or saved active selection", () => {
    let s = initialProviderSelectionControlState();
    s = start(s, "text", 1);
    s = start(s, "text", 2);
    // Newer B succeeds; older A failed persistence and would show a failure notice.
    s = apply(s, "text", 2, textSel("model-b"), false);
    s = apply(s, "text", 1, textSel("model-a"), true);
    expect(s.notices.text).toBe("Selection applied"); // F: notice not overwritten
    expect(s.drafts.text.modelId).toBe("model-b"); // G: draft not overwritten
    expect(s.saved.textAi.modelId).toBe("model-b"); // H: saved not overwritten
  });

  it("deferred-write end-to-end: older Text Apply failure cannot contaminate the newer success notice", async () => {
    const calls: { resolve: () => void; reject: (e: unknown) => void }[] = [];
    const adapter = {
      get: async () => undefined,
      set: () =>
        new Promise<void>((resolve, reject) => {
          calls.push({ resolve, reject });
        }),
      remove: async () => {},
    } as unknown as SettingsAdapter;

    const opA = saveAiSelectionWithOutcome(adapter, "text", "user_selected", "openrouter", "model-a", "session_only");
    const opB = saveAiSelectionWithOutcome(adapter, "text", "user_selected", "openrouter", "model-b", "session_only");
    expect(calls).toHaveLength(2);
    // B completes first (success), then stale A completes (failure).
    calls[1].resolve();
    const b = await opB;
    calls[0].reject(new Error("A persist failed"));
    const a = await opA;

    let s = initialProviderSelectionControlState();
    s = start(s, "text", 1); // A
    s = start(s, "text", 2); // B
    s = apply(s, "text", 2, b.selections, b.persistenceFailed);
    s = apply(s, "text", 1, a.selections, a.persistenceFailed);
    expect(b.persistenceFailed).toBe(false);
    expect(a.persistenceFailed).toBe(true);
    // The stale A failure must NOT appear; B's success notice stands.
    expect(s.notices.text).toBe("Selection applied");
  });
});
