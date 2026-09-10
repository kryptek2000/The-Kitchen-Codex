import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { ProviderStatusPanel } from "../../src/application-ui/ProviderSettings.js";
import type { ProviderStatusView } from "../../src/application-ui/providerStatus.js";
import type { ProviderCatalogView } from "../../src/application-ui/providerCatalog.js";

const SENTINEL = "SUPER_SECRET_BYOK1_SENTINEL";

function status(partial: Partial<ProviderStatusView>): ProviderStatusView {
  return {
    providerId: "gemini",
    name: "Google Gemini",
    configured: true,
    enabled: true,
    available: true,
    storageScope: "server_environment",
    supportsSecretWrites: false,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true },
    ...partial,
  };
}

const STATUSES: ProviderStatusView[] = [
  status({
    providerId: "gemini",
    name: "Google Gemini",
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true },
  }),
  status({
    providerId: "openrouter",
    name: "OpenRouter",
    configured: false,
    enabled: false,
    available: false,
    capabilities: { reasoning: false, structuredOutput: true, recipeGeneration: true, webSearch: false },
  }),
  status({
    providerId: "deepseek",
    name: "DeepSeek",
    configured: false,
    enabled: false,
    available: false,
    capabilities: { reasoning: true, structuredOutput: false, recipeGeneration: false, webSearch: false },
  }),
];

const CATALOG: ProviderCatalogView = {
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
      models: [
        {
          id: "gemini-3.7-flash",
          default: true,
          capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true },
        },
        {
          id: "gemini-3.1-flash-lite",
          default: false,
          capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true },
        },
      ],
    },
    {
      providerId: "openrouter",
      name: "OpenRouter",
      configured: false,
      enabled: false,
      available: false,
      storageScope: "server_environment",
      supportsSecretWrites: false,
      connectionTest: "network_probe",
      selectable: false,
      models: [
        {
          id: "openai/gpt-4o-mini",
          default: true,
          capabilities: { reasoning: false, structuredOutput: true, recipeGeneration: true, webSearch: false },
        },
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
      formats: ["image/png"],
      maxBytes: 4 * 1024 * 1024,
      models: [{ id: "gemini-2.5-flash-image", default: true }],
    },
  ],
  selection: {
    text: {
      selectionMode: "server_managed",
      selectedProviderId: "openrouter",
      selectedModelId: "openai/gpt-4o-mini",
      valid: true,
    },
    image: { selectionMode: "server_default", valid: true },
    userSelectionAllowed: { text: false, image: true },
    executable: { text: true, image: true },
  },
};

function render(el: React.ReactElement): string {
  return renderToString(el);
}

function catalogCard(html: string, providerId: string): string {
  const start = html.indexOf(`data-catalog-provider-id="${providerId}"`);
  const end = html.indexOf("data-catalog-provider-id=", start + 1);
  return start >= 0 ? html.slice(start, end > 0 ? end : undefined) : "";
}

describe("ProviderStatusPanel catalog section (BYOK-1)", () => {
  it("renders the text AND image catalog sections when a catalog is provided", () => {
    const html = render(<ProviderStatusPanel statuses={STATUSES} catalog={CATALOG} onRefresh={() => {}} />);
    expect(html).toContain("Provider Model Catalog");
    expect(html).toContain('data-catalog-section="provider-model-catalog"');
    expect(html).toContain('data-catalog-kind="text"');
    expect(html).toContain('data-catalog-kind="image"');
    expect(html).toContain("Image Providers");
  });

  it("renders text provider models with ids, Default markers, and effective capability chips", () => {
    const html = render(<ProviderStatusPanel statuses={STATUSES} catalog={CATALOG} onRefresh={() => {}} />);
    expect(html).toContain("gemini-3.7-flash");
    expect(html).toContain("gemini-3.1-flash-lite");
    expect(html).toContain('data-model-id="gemini-3.7-flash"');
    expect((html.match(/Default/g) || []).length).toBeGreaterThanOrEqual(2);
    // Gemini model chips show all four capabilities.
    expect(html).toContain("Structured Output");
    expect(html).toContain("Grounded Web Search");
  });

  it("shows per-model capability truth (OpenRouter model never claims webSearch)", () => {
    const html = render(<ProviderStatusPanel statuses={STATUSES} catalog={CATALOG} onRefresh={() => {}} />);
    const openRouterCard = catalogCard(html, "openrouter");
    expect(openRouterCard).toContain("openai/gpt-4o-mini");
    expect(openRouterCard).toContain("Structured Output");
    expect(openRouterCard).toContain("Recipe Generation");
    expect(openRouterCard).not.toContain("Grounded Web Search");
  });

  it("renders the image provider with formats, max byte cap, and default model", () => {
    const html = render(<ProviderStatusPanel statuses={STATUSES} catalog={CATALOG} onRefresh={() => {}} />);
    const imageCard = catalogCard(html, "gemini-image");
    expect(imageCard).toContain("Google Gemini Image");
    expect(imageCard).toContain("image/png");
    expect(imageCard).toContain("4 MB");
    expect(imageCard).toContain("Enabled");
    expect(imageCard).toContain("gemini-2.5-flash-image");
    expect(imageCard).toContain("Default");
  });

  it("renders NO catalog section when the catalog is absent (status-only panel regression)", () => {
    const html = render(<ProviderStatusPanel statuses={STATUSES} onRefresh={() => {}} />);
    expect(html).not.toContain("Provider Model Catalog");
    expect(html).not.toContain('data-catalog-provider-id=');
    // Status cards still render.
    expect(html).toContain("Google Gemini");
    expect(html).toContain("OpenRouter");
  });

  it("never renders a secret-shaped field or an input/secret control anywhere", () => {
    const smuggled: ProviderCatalogView = {
      textProviders: [
        {
          ...CATALOG.textProviders[0],
          ...({ apiKey: SENTINEL, token: SENTINEL } as Record<string, unknown>),
        },
      ],
      imageProviders: CATALOG.imageProviders,
      selection: CATALOG.selection,
    };
    const html = render(<ProviderStatusPanel statuses={STATUSES} catalog={smuggled} onRefresh={() => {}} />);
    expect(html).not.toContain(SENTINEL);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("type=\"password\"");
    expect(html).not.toContain("Save key");
    expect(html).not.toContain("Test Connection");
  });
});

describe("ProviderStatusPanel catalog selection truth (BYOK-2)", () => {
  it("renders the read-only selection summary for text and image", () => {
    const html = render(<ProviderStatusPanel statuses={STATUSES} catalog={CATALOG} onRefresh={() => {}} />);
    expect(html).toContain('data-selection-kind="text"');
    expect(html).toContain('data-selection-kind="image"');
    expect(html).toContain("Server managed: openrouter / openai/gpt-4o-mini");
    expect(html).toContain("Server default");
  });

  it("renders the bounded invalid-pin warning exactly once when a pin is invalid", () => {
    const catalog: ProviderCatalogView = {
      ...CATALOG,
      selection: {
        text: { selectionMode: "server_managed", selectedProviderId: "nope", valid: false },
        image: { selectionMode: "server_default", valid: true },
        userSelectionAllowed: CATALOG.selection.userSelectionAllowed,
        executable: CATALOG.selection.executable,
      },
    };
    const html = render(<ProviderStatusPanel statuses={STATUSES} catalog={catalog} onRefresh={() => {}} />);
    expect(html).toContain("Server-managed provider selection is invalid; Kitchen Codex will not use another provider until the selection is fixed.");
    expect(html).not.toContain('class="error');
  });

  it("renders a server-managed provider with no model pin without a slash", () => {
    const catalog: ProviderCatalogView = {
      ...CATALOG,
      selection: {
        text: { selectionMode: "server_managed", selectedProviderId: "gemini", valid: true },
        image: CATALOG.selection.image,
        userSelectionAllowed: CATALOG.selection.userSelectionAllowed,
        executable: CATALOG.selection.executable,
      },
    };
    const html = render(<ProviderStatusPanel statuses={STATUSES} catalog={catalog} onRefresh={() => {}} />);
    expect(html).toContain("Server managed: gemini");
    expect(html).not.toContain("Server managed: gemini /");
  });
});