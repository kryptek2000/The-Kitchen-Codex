import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ProviderSettings,
  ProviderStatusError,
  ProviderStatusLoading,
  ProviderStatusPanel,
} from "../../src/application-ui/ProviderSettings.js";
import type { ProviderStatusView } from "../../src/application-ui/providerStatus.js";
import type { NetworkAdapter } from "../../src/application/adapters/NetworkAdapter.js";

const SENTINEL = "SUPER_SECRET_PHASE1E_SENTINEL";

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

const ALL_THREE: ProviderStatusView[] = [
  status({
    providerId: "gemini",
    name: "Google Gemini",
    configured: true,
    enabled: true,
    available: true,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true },
  }),
  // Provider capabilities are the backend's truthful union (baseline + curated
  // model overrides). OpenRouter's curated GPT-4o-mini grants structured output +
  // recipe generation; DeepSeek's curated models grant reasoning. No invented
  // webSearch. Display exactly the endpoint's union truth.
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

function render(el: React.ReactElement): string {
  return renderToString(el);
}

describe("ProviderStatusPanel (v0.7 1E)", () => {
  it("renders all three providers in order", () => {
    const html = render(<ProviderStatusPanel statuses={ALL_THREE} onRefresh={() => {}} />);
    expect(html).toContain("Google Gemini");
    expect(html).toContain("OpenRouter");
    expect(html).toContain("DeepSeek");
    const gemini = html.indexOf("Google Gemini");
    const openrouter = html.indexOf("OpenRouter");
    const deepseek = html.indexOf("DeepSeek");
    expect(gemini).toBeGreaterThan(-1);
    expect(gemini).toBeLessThan(openrouter);
    expect(openrouter).toBeLessThan(deepseek);
  });

  it("renders configured / enabled / available states distinctly", () => {
    const html = render(<ProviderStatusPanel statuses={ALL_THREE} onRefresh={() => {}} />);
    expect(html).toContain("Configured");
    expect(html).toContain("Not configured");
    expect(html).toContain("Enabled");
    expect(html).toContain("Disabled");
    expect(html).toContain("Available");
    expect(html).toContain("Unavailable");
  });

  it("renders truthful storage scope and server-operator wording", () => {
    const html = render(<ProviderStatusPanel statuses={ALL_THREE} onRefresh={() => {}} />);
    expect(html).toContain("Server environment");
    expect(html).toContain("server operator");
    expect(html).toContain("API keys are not stored in your browser or vault");
  });

  it("renders truthful capability chips (Gemini full; OpenRouter structured; DeepSeek reasoning)", () => {
    const html = render(<ProviderStatusPanel statuses={ALL_THREE} onRefresh={() => {}} />);
    // Gemini card: all four provider-level caps.
    expect(html).toContain("Reasoning");
    expect(html).toContain("Structured Output");
    expect(html).toContain("Recipe Generation");
    expect(html).toContain("Grounded Web Search");
    // DeepSeek: curated reasoning chip present; no invented structured/webSearch.
    expect(html).toContain("DeepSeek");
    expect(html).toContain("Reasoning");
    // The card text claims nothing it should not: the chips are read from the
    // union view-model only. No all-false empty state is rendered for these three.
    expect(html).not.toContain("No provider-backed capabilities for this provider.");
  });

  it("does NOT claim Grounded Web Search for OpenRouter or DeepSeek", () => {
    const html = render(<ProviderStatusPanel statuses={ALL_THREE} onRefresh={() => {}} />);
    // Grounded Web Search appears once (Gemini only), never for OR/DS.
    expect((html.match(/Grounded Web Search/g) || []).length).toBe(1);
    const expectChipsFor = (providerId: string, chips: string[]) => {
      const start = html.indexOf(`data-provider-id="${providerId}"`);
      const end = html.indexOf("data-provider-id=", start + 1);
      const card = start >= 0 ? html.slice(start, end > 0 ? end : undefined) : "";
      for (const chip of chips) expect(card).toContain(chip);
    };
    expectChipsFor("openrouter", ["Structured Output", "Recipe Generation"]);
    expectChipsFor("deepseek", ["Reasoning"]);
  });

  it("renders the empty capability state ONLY when the provider union is entirely false", () => {
    const emptyProvider = status({
      providerId: "ghost",
      name: "Ghost Provider",
      configured: true,
      enabled: true,
      available: true,
      capabilities: { reasoning: false, structuredOutput: false, recipeGeneration: false, webSearch: false },
    });
    const html = render(<ProviderStatusPanel statuses={[emptyProvider]} onRefresh={() => {}} />);
    expect(html).toContain("No provider-backed capabilities for this provider.");
  });

  it("does NOT render a secret value or a masked substring", () => {
    const statuses = ALL_THREE.map((s) => ({ ...s, name: s.name, providerId: s.providerId }));
    const html = render(<ProviderStatusPanel statuses={statuses} onRefresh={() => {}} />);
    expect(html).not.toContain("sk-");
    expect(html).not.toContain(SENTINEL);
  });

  it("never renders a secret-shaped prop even if one is smuggled into a status object", () => {
    // Belt-and-braces: the presentational component only reads allowlisted fields,
    // so even an injected secret-shaped property is never rendered.
    const smuggled = {
      ...ALL_THREE[0],
      secret: SENTINEL,
      apiKey: SENTINEL,
      maskedKey: "abcd1234",
    } as unknown as ProviderStatusView;
    const html = render(<ProviderStatusPanel statuses={[smuggled]} onRefresh={() => {}} />);
    expect(html).not.toContain(SENTINEL);
    expect(html).not.toContain("abcd1234");
  });

  it("renders a Refresh action with accessible text", () => {
    const html = render(<ProviderStatusPanel statuses={ALL_THREE} onRefresh={() => {}} />);
    expect(html).toContain("Refresh");
  });
});

describe("ProviderSettings states (v0.7 1E)", () => {
  it("initial render is the loading state (no fabricated provider data)", () => {
    const network = {} as unknown as NetworkAdapter;
    const html = render(<ProviderSettings network={network} />);
    expect(html).toContain("Loading provider status");
    expect(html).not.toContain("Google Gemini");
    expect(html).not.toContain("OpenRouter");
    expect(html).not.toContain("DeepSeek");
  });

  it("renders the fail-closed error state (does not fabricate provider states)", () => {
    const html = render(<ProviderStatusError onRefresh={() => {}} />);
    expect(html).toContain("Provider status unavailable.");
    expect(html).not.toContain("Google Gemini");
    expect(html).not.toContain("OpenRouter");
    expect(html).not.toContain("DeepSeek");
  });

  it("renders the loading state via its presentational component", () => {
    expect(render(<ProviderStatusLoading />)).toContain("Loading provider status");
  });
});

describe("no key-entry / no secret-input guard (v0.7 1E)", () => {
  it("renders no password/input/key controls in any rendered state", () => {
    const readyHtml = render(<ProviderStatusPanel statuses={ALL_THREE} onRefresh={() => {}} />);
    const errHtml = render(<ProviderStatusError onRefresh={() => {}} />);
    const loadHtml = render(<ProviderStatusLoading />);
    for (const html of [readyHtml, errHtml, loadHtml]) {
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain("type=\"password\"");
      expect(html).not.toContain("Save key");
      expect(html).not.toContain("Delete key");
      expect(html).not.toContain("Reveal key");
      expect(html).not.toContain("Add key");
      expect(html).not.toContain("GEMINI_API_KEY");
      expect(html).not.toContain("OPENROUTER_API_KEY");
      expect(html).not.toContain("DEEPSEEK_API_KEY");
      expect(html).not.toContain(SENTINEL);
    }
  });
});
