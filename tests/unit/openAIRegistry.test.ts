import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../server/geminiClient.js", () => ({
  getGemini: vi.fn(() => ({ models: {} })),
  getGeminiImage: vi.fn(() => null),
}));

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
  "HOST",
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
] as const;

const SENTINEL = "sk-openai-registry-sentinel";

async function fresh(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const provider = await import("../../server/ai/provider.js");
  const roles = await import("../../server/ai/roleModels.js");
  const effective = await import("../../server/ai/effectiveSelection.js");
  const catalog = await import("../../server/ai/providerCatalog.js");
  const connection = await import("../../server/ai/connectionTest.js");
  const selection = await import("../../server/ai/providerSelection.js");
  const session = await import("../../server/ai/sessionSecrets.js");
  return { provider, roles, effective, catalog, connection, selection, session };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

describe("OpenAI registry integration (P1)", () => {
  it("appends OpenAI last and keeps Gemini as the default provider", async () => {
    const { provider } = await fresh();
    const regs = provider.getRegisteredProviders();
    expect(regs.map((r) => r.provider.id)).toEqual(["gemini", "openrouter", "deepseek", "openai"]);
    expect(provider.getDefaultAiProvider().id).toBe("gemini");
    const openai = regs.find((r) => r.provider.id === "openai")!;
    expect(openai.defaultFallback).toBe(false);
    expect(openai.enabled).toBe(false); // no OPENAI_API_KEY
  });

  it("is enabled/configurable only with the operator key and remains opt-in", async () => {
    const { provider } = await fresh({ OPENAI_API_KEY: SENTINEL });
    const openai = provider.getRegisteredProviders().find((r) => r.provider.id === "openai")!;
    expect(openai.enabled).toBe(true);
    expect(openai.provider.isAvailable()).toBe(true);
    expect(openai.defaultFallback).toBe(false);
  });

  it("exposes exactly Terra and Luna as the curated OpenAI model truth", async () => {
    const { roles } = await fresh({ OPENAI_API_KEY: SENTINEL });
    expect(roles.curatedTextModels("openai")).toEqual(["gpt-6.1-terra", "gpt-6-luna"]);
    expect(roles.selectableTextModels("openai")).toEqual(["gpt-6.1-terra", "gpt-6-luna"]);
    for (const operation of [
      "kitchenInterpret",
      "kitchenRank",
      "kitchenDiscover",
      "shisoConversation",
      "nutrition",
      "metadataRecovery",
      "recipeGrabber",
      "createRecipe",
    ] as const) {
      expect(roles.roleModelsForProvider("openai", operation)).toEqual([
        "gpt-6.1-terra",
        "gpt-6-luna",
      ]);
    }
    expect(roles.roleModelsForProvider("openai", "unknown-operation" as never)).toEqual([]);
    expect(roles.curatedTextModels("ghost")).toEqual([]);
  });

  it("advertises structured recipe capability but NOT webSearch", async () => {
    const { provider } = await fresh({ OPENAI_API_KEY: SENTINEL });
    const regs = provider.getRegisteredProviders();
    const openai = regs.find((r) => r.provider.id === "openai")!;
    for (const model of ["gpt-6.1-terra", "gpt-6-luna"]) {
      expect(provider.effectiveCapabilities(openai, model)).toEqual({
        reasoning: true,
        structuredOutput: true,
        recipeGeneration: true,
        webSearch: false,
      });
    }
    expect(provider.effectiveCapabilities(openai, "gpt-6.1-sol")).toEqual({
      reasoning: false,
      structuredOutput: false,
      recipeGeneration: false,
      webSearch: false,
    });
  });

  it("excludes OpenAI from server-default candidates but honors an explicit selection", async () => {
    const { effective } = await fresh({ OPENAI_API_KEY: SENTINEL });
    const registry = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();

    const serverDefault = effective.resolveTextCandidateContext("createRecipe", registry, undefined);
    expect(serverDefault.source).toBe("server_default");
    expect(serverDefault.candidates.some((c) => c.provider.id === "openai")).toBe(false);

    const selected = effective.resolveTextCandidateContext("createRecipe", registry, {
      mode: "user_selected",
      providerId: "openai",
      modelId: "gpt-6.1-terra",
    });
    expect(selected.source).toBe("user_selected");
    expect(selected.candidates.map((c) => [c.provider.id, c.model])).toEqual([
      ["openai", "gpt-6.1-terra"],
    ]);
  });

  it("provider-only OpenAI selection uses Terra only; Luna requires an explicit model", async () => {
    const { effective } = await fresh({ OPENAI_API_KEY: SENTINEL });
    const registry = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();

    const providerOnly = effective.resolveTextCandidateContext("createRecipe", registry, {
      mode: "user_selected",
      providerId: "openai",
    });
    expect(providerOnly.candidates.map((c) => c.model)).toEqual(["gpt-6.1-terra"]);

    const explicitLuna = effective.resolveTextCandidateContext("createRecipe", registry, {
      mode: "user_selected",
      providerId: "openai",
      modelId: "gpt-6-luna",
    });
    expect(explicitLuna.candidates.map((c) => c.model)).toEqual(["gpt-6-luna"]);
  });

  it("fails closed for an uncurated OpenAI model and for webSearch selection", async () => {
    const { provider, effective } = await fresh({ OPENAI_API_KEY: SENTINEL });
    const registry = provider.getRegisteredProviders();

    const badModel = effective.resolveTextCandidateContext("nutrition", registry, {
      mode: "user_selected",
      providerId: "openai",
      modelId: "gpt-6.1-sol",
    });
    expect(badModel.candidates).toEqual([]);

    const capable = provider.selectCandidates(
      registry,
      [{ provider: provider.getAiProvider("openai")!, model: "gpt-6.1-terra" }],
      ["webSearch"]
    );
    expect(capable).toEqual([]);
  });

  it("supports exact-provider session-only selection without an env key", async () => {
    const { effective, session } = await fresh();
    // Session-only is local/loopback by default in this test environment.
    session.setSessionSecret("openai", "sk-session-openai");
    const registry = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();

    const selected = effective.resolveTextCandidateContext("createRecipe", registry, {
      mode: "user_selected",
      providerId: "openai",
      modelId: "gpt-6.1-terra",
      credentialSource: "session_only",
    });
    expect(selected.source).toBe("user_selected");
    expect(selected.credentialSource).toBe("session_only");
    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0].provider.id).toBe("openai");
    expect(selected.candidates[0].provider.isAvailable()).toBe(true);
    expect(selected.candidates[0].provider).not.toBe(
      registry.find((r) => r.provider.id === "openai")!.provider
    );
  });

  it("keeps openai and openrouter session credentials isolated", async () => {
    const { effective, session } = await fresh();
    session.setSessionSecret("openrouter", "sk-session-openrouter");
    const registry = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const selected = effective.resolveTextCandidateContext("createRecipe", registry, {
      mode: "user_selected",
      providerId: "openai",
      modelId: "gpt-6.1-terra",
      credentialSource: "session_only",
    });
    expect(selected.candidates).toEqual([]); // no cross-provider key reuse
  });

  it("fails closed after the OpenAI session credential is revoked", async () => {
    const { effective, session } = await fresh();
    session.setSessionSecret("openai", "sk-session-openai");
    session.revokeSessionSecret("openai");
    const registry = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const selected = effective.resolveTextCandidateContext("createRecipe", registry, {
      mode: "user_selected",
      providerId: "openai",
      modelId: "gpt-6.1-terra",
      credentialSource: "session_only",
    });
    expect(selected.candidates).toEqual([]);
  });

  it("validates an operator pin to OpenAI and rejects an uncurated pinned model", async () => {
    const { selection } = await fresh({
      OPENAI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "openai",
      KITCHEN_CODEX_TEXT_MODEL: "gpt-6.1-terra",
    });
    expect(selection.getTextSelection()).toMatchObject({
      selectionMode: "server_managed",
      selectedProviderId: "openai",
      selectedModelId: "gpt-6.1-terra",
      valid: true,
    });
    process.env.KITCHEN_CODEX_TEXT_MODEL = "gpt-6.1-sol";
    expect(selection.getTextSelection().valid).toBe(false);
  });

  it("an operator pin without a model resolves Terra only (no Luna substitution)", async () => {
    const { effective } = await fresh({
      OPENAI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "openai",
    });
    const registry = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const context = effective.resolveTextCandidateContext("createRecipe", registry, undefined);
    expect(context.source).toBe("server_managed");
    expect(context.candidates.map((c) => c.model)).toEqual(["gpt-6.1-terra"]);
  });

  it("includes OpenAI in the provider catalog and connection-test allowlist", async () => {
    const { catalog, connection } = await fresh({ OPENAI_API_KEY: SENTINEL });
    const view = catalog.buildProviderCatalog();
    const row = view.textProviders.find((p) => p.providerId === "openai")!;
    expect(row).toMatchObject({
      name: "OpenAI",
      configured: true,
      enabled: true,
      available: true,
      selectable: true,
      sessionKeySupported: true,
      connectionTest: "network_probe",
    });
    expect(row.models.map((m) => m.id)).toEqual(["gpt-6.1-terra", "gpt-6-luna"]);
    expect(row.models.map((m) => m.capabilities.structuredOutput)).toEqual([true, true]);
    expect(row.models.map((m) => m.capabilities.webSearch)).toEqual([false, false]);
    expect(connection.curatedConnectionTestModels("openai", "text")).toEqual([
      "gpt-6.1-terra",
      "gpt-6-luna",
    ]);
    expect(connection.connectionTestKindForProvider("openai", "text")).toBe("network_probe");
  });

  it("reports session-key capability in the catalog even without an operator key", async () => {
    const { catalog } = await fresh();
    const row = catalog.buildProviderCatalog().textProviders.find((p) => p.providerId === "openai")!;
    expect(row.configured).toBe(false);
    expect(row.enabled).toBe(false);
    expect(row.sessionKeySupported).toBe(true);
    expect(row.models.map((m) => m.id)).toEqual(["gpt-6.1-terra", "gpt-6-luna"]);
  });

  it("never serializes a key into the catalog/status shape", async () => {
    const { catalog } = await fresh({ OPENAI_API_KEY: SENTINEL });
    const json = JSON.stringify(catalog.buildProviderCatalog());
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toMatch(/apiKey|api_key|Bearer|sk-openai/i);
  });
});
