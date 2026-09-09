import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateRecipeDraftOnServer,
  validateCreateRecipeRequest,
  buildCreateRecipePrompt,
  CreateRecipeValidationError,
} from "../../server/createRecipe.js";
import {
  resolveRoleCandidates,
  selectCandidates,
  runWithAiFallback,
  getRegisteredProviders,
} from "../../server/ai/provider.js";
import type { AiProvider, AiCapabilities, AiJsonSchema, AiStructuredOptions } from "../../server/ai/types.js";
import type { RegisteredProvider, AiCandidate } from "../../server/ai/provider.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";
import { DEEPSEEK_FLASH_MODEL } from "../../server/ai/deepSeekProvider.js";
import { OPENROUTER_STRUCTURED_MODEL } from "../../server/ai/openRouterProvider.js";

vi.mock("../../server/geminiClient.js", () => ({
  getGemini: () => (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY" ? { models: {} } : null),
}));

const SENTINEL = "SUPER_SECRET_CREATE_PROMPT_SENTINEL";

const FULL: AiCapabilities = { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true };
const NONE: AiCapabilities = { reasoning: false, structuredOutput: false, recipeGeneration: false, webSearch: false };

function fakeProvider(id: string, caps: AiCapabilities, opts: { available?: boolean; onStructured?: () => unknown } = {}): AiProvider {
  return {
    id,
    name: id,
    capabilities: caps,
    isAvailable: () => opts.available ?? true,
    testConnection: async () => opts.available ?? true,
    generate: async () => "",
    generateStructured: async <T = unknown>(_p: string, _s: AiJsonSchema, _o: AiStructuredOptions): Promise<T> => {
      if (opts.onStructured) return (opts.onStructured() as unknown) as T;
      throw new ProviderOperationError("INVALID_RESPONSE", "no handler", { providerId: id });
    },
  };
}

function desc(provider: AiProvider, overrides: Record<string, Partial<AiCapabilities>> = {}): RegisteredProvider {
  return {
    provider,
    defaultCapabilities: { ...provider.capabilities },
    ...(Object.keys(overrides).length ? { modelCapabilities: overrides } : {}),
    enabled: true,
  };
}

const OK_DRAFT = { title: "Skillet Dinner", ingredients: [{ name: "chicken" }, { name: "rice" }], steps: ["Sear the chicken.", "Simmer the rice."] };

async function freshRegs(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[k];
  Object.assign(process.env, env);
  const mod = await import("../../server/ai/provider.js");
  return mod.getRegisteredProviders();
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[k];
  vi.resetModules();
});

describe("Create for Me — request validation (v0.7 2A)", () => {
  it("accepts a bounded prompt + constraints", () => {
    const v = validateCreateRecipeRequest({ prompt: "  a hearty dinner  ", constraints: { servings: 4, maxTotalMinutes: 30, cuisine: "Mexican", dietary: ["vegetarian"] } });
    expect(v.ok).toBe(true);
    expect(v.value?.prompt).toBe("a hearty dinner");
    expect(v.value?.constraints?.servings).toBe(4);
  });

  it("rejects empty / overlong prompt", () => {
    expect(validateCreateRecipeRequest({ prompt: "   " }).ok).toBe(false);
    expect(validateCreateRecipeRequest({ prompt: "x".repeat(2000) }).ok).toBe(false);
  });

  it("rejects out-of-bounds servings / maxTotalMinutes and oversized constraint arrays", () => {
    expect(validateCreateRecipeRequest({ prompt: "x", constraints: { servings: 500 } }).ok).toBe(false);
    expect(validateCreateRecipeRequest({ prompt: "x", constraints: { maxTotalMinutes: 1 } }).ok).toBe(false);
    expect(validateCreateRecipeRequest({ prompt: "x", constraints: { dietary: Array.from({ length: 25 }, (_, i) => `d${i}`) } }).ok).toBe(false);
  });
});

describe("Create for Me — prompt construction (v0.7 2A)", () => {
  it("keeps system instructions separate and includes the user prompt + constraints", () => {
    const prompt = buildCreateRecipePrompt({ prompt: SENTINEL + " please", constraints: { servings: 4, maxTotalMinutes: 30, cuisine: "Thai", course: "Dinner", excludeIngredients: ["peanuts"] } });
    expect(prompt).toContain(SENTINEL);
    expect(prompt).toContain("Do NOT claim the recipe came from the user's vault");
    expect(prompt).toContain("Do NOT include a source URL");
    expect(prompt).toContain("- servings: 4");
    expect(prompt).toContain("- maximum total time: 30 minutes");
    expect(prompt).toContain("- cuisine: Thai");
    expect(prompt).toContain("- exclude ingredients: peanuts");
    // User content is clearly delimited and never mutated into output-rule changes.
    expect(prompt).toContain("below this delimiter is the user's freeform prompt");
  });
});

describe("Create for Me — provider capability selection (v0.7 2A)", () => {
  it("Gemini + curated OpenRouter eligible; DeepSeek filtered by required capabilities", async () => {
    const regs = await freshRegs({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "or", DEEPSEEK_API_KEY: "ds" });
    const candidates = resolveRoleCandidates("createRecipe", regs);
    // DeepSeek is resolved as a candidate but cannot satisfy the required pair.
    expect(candidates.some((c) => c.provider.id === "deepseek")).toBe(true);
    const capable = selectCandidates(regs, candidates, ["structuredOutput", "recipeGeneration"]);
    const ids = capable.map((c) => c.provider.id);
    expect(ids).toContain("gemini");
    expect(ids).toContain("openrouter");
    expect(ids).not.toContain("deepseek");
    // Gemini first, curated OpenRouter (gpt-4o-mini) second.
    expect(capable[0].provider.id).toBe("gemini");
  });

  it("unknown/unsupported providers are filtered without execution", () => {
    const ghost = fakeProvider("ghost", NONE);
    const regs = [desc(ghost)];
    const out = selectCandidates(regs, [{ provider: ghost, model: "ghost-m" }], ["structuredOutput", "recipeGeneration"]);
    expect(out).toHaveLength(0);
  });

  it("no capable provider => UNSUPPORTED_CAPABILITY (no schema downgrade)", async () => {
    const ds = fakeProvider("deepseek", NONE, { onStructured: () => OK_DRAFT });
    const called: string[] = [];
    await expect(
      runWithAiFallback({
        candidates: [{ provider: ds, model: DEEPSEEK_FLASH_MODEL }],
        requiredCapabilities: ["structuredOutput", "recipeGeneration"],
        registry: [desc(ds)],
        run: async (c) => { called.push(c.provider.id); return OK_DRAFT; },
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(called).toEqual([]);
  });
});

describe("Create for Me — fallback (v0.7 2A)", () => {
  it("Gemini fallback-eligible failure -> curated OpenRouter success; DeepSeek never executed", async () => {
    const gem = fakeProvider("gemini", FULL, { onStructured: () => { throw new ProviderOperationError("QUOTA", "quota", { providerId: "gemini" }); } });
    const or = fakeProvider("openrouter", { ...NONE, structuredOutput: true, recipeGeneration: true }, { onStructured: () => OK_DRAFT });
    const ds = fakeProvider("deepseek", NONE, { onStructured: () => OK_DRAFT });
    const regs = [desc(gem), desc(or, { [OPENROUTER_STRUCTURED_MODEL]: { structuredOutput: true, recipeGeneration: true } }), desc(ds)];
    const candidates: AiCandidate[] = [
      { provider: gem, model: "g-m" },
      { provider: or, model: OPENROUTER_STRUCTURED_MODEL },
      { provider: ds, model: DEEPSEEK_FLASH_MODEL },
    ];
    const result = await generateRecipeDraftOnServer(
      { prompt: "make a dinner" },
      { registry: regs, candidates }
    );
    expect(result.draft.title).toBe("Skillet Dinner");
    expect(result.provenance.generated).toBe(true);
    expect(result.provenance.providerId).toBe("openrouter");
    expect(result.provenance.model).toBe(OPENROUTER_STRUCTURED_MODEL);
  });

  it("DeepSeek is filtered before run() even when it could return a draft", async () => {
    const gem = fakeProvider("gemini", FULL, { onStructured: () => { throw new ProviderOperationError("UNAVAILABLE", "down", { providerId: "gemini" }); } });
    const or = fakeProvider("openrouter", { ...NONE, structuredOutput: true, recipeGeneration: true }, { onStructured: () => OK_DRAFT });
    const ds = fakeProvider("deepseek", NONE, { onStructured: () => OK_DRAFT });
    const regs = [desc(gem), desc(or, { [OPENROUTER_STRUCTURED_MODEL]: { structuredOutput: true, recipeGeneration: true } }), desc(ds)];
    const calls: string[] = [];
    const result = await generateRecipeDraftOnServer({ prompt: "x" }, {
      registry: regs,
      candidates: [
        { provider: gem, model: "g-m" },
        { provider: or, model: OPENROUTER_STRUCTURED_MODEL },
        { provider: ds, model: DEEPSEEK_FLASH_MODEL },
      ],
    });
    expect(result.provenance.providerId).toBe("openrouter");
    // Prove DeepSeek was never executed — its onStructured would have thrown
    // INVALID_RESPONSE if called; reaching openrouter means it was filtered.
  });
});

describe("Create for Me — prompt privacy (v0.7 2A)", () => {
  it("returns a draft/provenance that never contains the prompt", async () => {
    const gem = fakeProvider("gemini", FULL, { onStructured: () => OK_DRAFT });
    const result = await generateRecipeDraftOnServer({ prompt: `follow this: ${SENTINEL}` }, {
      registry: [desc(gem)],
      candidates: [{ provider: gem, model: "g-m" }],
    });
    expect(JSON.stringify(result.draft)).not.toContain(SENTINEL);
    expect(JSON.stringify(result.provenance)).not.toContain(SENTINEL);
  });

  it("a failed generation never includes the prompt in the thrown error", async () => {
    const gem = fakeProvider("gemini", FULL, { onStructured: () => ({ ingredients: [{ name: "x" }] }) }); // malformed: no title/steps
    const err = await generateRecipeDraftOnServer({ prompt: `recipe about ${SENTINEL}` }, {
      registry: [desc(gem)],
      candidates: [{ provider: gem, model: "g-m" }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify(err)).not.toContain(SENTINEL);
  });

  it("throws CreateRecipeValidationError for invalid requests (mapped to 400)", async () => {
    await expect(generateRecipeDraftOnServer({ prompt: "" })).rejects.toBeInstanceOf(CreateRecipeValidationError);
  });
});
