import { describe, it, expect, afterEach, vi } from "vitest";
import { sanitizeKitchenIntent } from "../../src/utils/kitchenIntent.js";
import type { AiSearchResult } from "../../server/ai/provider.js";

const INTENT = sanitizeKitchenIntent({
  version: 1,
  intent: "find_recipes",
  source: "web",
  constraints: { includeIngredients: ["gumbo"] },
});
if (!INTENT) throw new Error("expected a valid intent");

type DiscoverFn = typeof import("../../server/kitchenDiscover.js").discoverKitchenRecipesOnServer;

let discover: DiscoverFn;

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
] as const;

async function freshDiscover(env: Record<string, string>): Promise<void> {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const discoverMod = await import("../../server/kitchenDiscover.js");
  discover = discoverMod.discoverKitchenRecipesOnServer;
}

async function geminiSearchSpy(): Promise<ReturnType<typeof vi.spyOn>> {
  const { GeminiProvider } = await import("../../server/ai/geminiProvider.js");
  return vi.spyOn(GeminiProvider.prototype, "searchWeb");
}

function request() {
  return { question: "find a gumbo recipe", intent: INTENT!, maxResults: 3 };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("kitchen discovery (BYOK-2) — selection-aware, webSearch-gated, no provider bypass", () => {
  it("free mode: webSearch-capable providers only; Gemini is the sole candidate set", async () => {
    await freshDiscover({
      GEMINI_API_KEY: "fake-not-placeholder",
      OPENROUTER_API_KEY: "sk-or",
      DEEPSEEK_API_KEY: "sk-ds",
    });
    const mod = await import("../../server/ai/provider.js");
    const all = mod.resolveRoleCandidates("kitchenDiscover");
    expect(all.length).toBeGreaterThan(0);
    const capable = mod.selectAiCandidates(all, ["webSearch"]);
    expect(capable.length).toBeGreaterThan(0);
    expect(capable.every((c) => c.provider.id === "gemini")).toBe(true);
  });

  it("free mode: no key configured => no candidates => discovery unavailable (hermetic)", async () => {
    await freshDiscover({});
    const mod = await import("../../server/ai/provider.js");
    const capable = mod.selectAiCandidates(mod.resolveRoleCandidates("kitchenDiscover"), ["webSearch"]);
    expect(capable.length).toBe(0);
    const result = await discover(request());
    expect(result.ok).toBe(false);
  });

  it("DE-BYPASS: pinned webSearch-incapable provider => discovery unavailable; Gemini NEVER runs", async () => {
    await freshDiscover({ OPENROUTER_API_KEY: "sk-or", KITCHEN_CODEX_TEXT_PROVIDER: "openrouter" });
    const probe = await geminiSearchSpy();
    probe.mockImplementation(async (): Promise<AiSearchResult[]> => []);
    const result = await discover(request());
    expect(result.ok).toBe(false);
    expect(probe.mock.calls.length).toBe(0);
  });

  it("DE-BYPASS: pinned unknown provider => discovery unavailable; Gemini NEVER runs", async () => {
    await freshDiscover({ GEMINI_API_KEY: "fake-not-placeholder", KITCHEN_CODEX_TEXT_PROVIDER: "ghost" });
    const probe = await geminiSearchSpy();
    probe.mockImplementation(async (): Promise<AiSearchResult[]> => []);
    const result = await discover(request());
    expect(result.ok).toBe(false);
    expect(probe.mock.calls.length).toBe(0);
  });

  it("capability-incompatible pinned candidate resolves to NO usable candidates and never cross-provider falls back", async () => {
    await freshDiscover({ OPENROUTER_API_KEY: "sk-or", KITCHEN_CODEX_TEXT_PROVIDER: "deepseek" });
    const mod = await import("../../server/ai/provider.js");
    const candidates = mod.resolveRoleCandidates("kitchenDiscover");
    expect(candidates.length).toBeGreaterThan(0); // pin is valid -> its models resolve
    expect(candidates.every((c) => c.provider.id === "deepseek")).toBe(true);
    const capable = mod.selectAiCandidates(candidates, ["webSearch"]);
    expect(capable).toEqual([]); // deepseek has no webSearch -> filtered out, nothing executes
    const result = await discover(request());
    expect(result.ok).toBe(false);
  });

  it("pinned Gemini discovers normally (valid pin, webSearch-capable, exact pinned model used)", async () => {
    await freshDiscover({
      GEMINI_API_KEY: "fake-not-placeholder",
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
      KITCHEN_CODEX_TEXT_MODEL: "gemini-3.7-flash",
    });
    let lastModel = "";
    const probe = await geminiSearchSpy();
    probe.mockImplementation(async (_prompt: string, options: { model: string }): Promise<AiSearchResult[]> => {
      lastModel = options.model;
      return [{ url: "https://example.com/gumbo", title: "Gumbo", sourceName: "Example" }];
    });
    const result = await discover(request());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[0].url).toBe("https://example.com/gumbo");
      expect(result.results[0].title).toBe("Gumbo");
    }
    expect(probe.mock.calls.length).toBe(1);
    expect(lastModel).toBe("gemini-3.7-flash");
  });

  it("pinned Gemini: no grounding on primary => falls to the configured fallback model, still source=web", async () => {
    await freshDiscover({ GEMINI_API_KEY: "fake-not-placeholder", KITCHEN_CODEX_TEXT_PROVIDER: "gemini" });
    const probe = await geminiSearchSpy();
    probe.mockImplementation(
      async (_prompt: string, options: { model: string }): Promise<AiSearchResult[]> =>
        options.model === "gemini-3.7-flash"
          ? []
          : [{ url: "https://example.com/gumbo", title: "Gumbo", sourceName: "Example" }]
    );
    const result = await discover(request());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[0].url).toBe("https://example.com/gumbo");
    }
    expect(probe.mock.calls.length).toBe(2);
  });
});