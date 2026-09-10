import { describe, it, expect, afterEach, vi } from "vitest";
import { DEFAULT_GEMINI_IMAGE_MODEL } from "../../server/ai/geminiImageProvider.js";

interface SelectionModule {
  getTextSelection: () => import("../../server/ai/providerSelection.js").ProviderSelectionState;
  getImageSelection: () => import("../../server/ai/providerSelection.js").ProviderSelectionState;
  resolveSelectedImagePair: () => { provider: import("../../server/ai/imageProvider.js").ImageProvider; model: string } | null;
}

let sel: SelectionModule;

const SENTINEL = "SUPER_SECRET_BYOK2_SENTINEL";
const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
] as const;

async function freshSelection(env: Record<string, string>): Promise<SelectionModule> {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const mod = await import("../../server/ai/providerSelection.js");
  return {
    getTextSelection: mod.getTextSelection,
    getImageSelection: mod.getImageSelection,
    resolveSelectedImagePair: mod.resolveSelectedImagePair,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

describe("server-managed text selection (BYOK-2)", () => {
  it("unset env => server_default, valid", async () => {
    sel = await freshSelection({});
    expect(sel.getTextSelection()).toEqual({ selectionMode: "server_default", valid: true });
  });

  it("provider env does NOT flip to server_managed (only the 4 canonical names select)", async () => {
    sel = await freshSelection({ GEMINI_API_KEY: SENTINEL });
    expect(sel.getTextSelection()).toEqual({ selectionMode: "server_default", valid: true });
  });

  it("registered enabled provider pin => valid, model optional", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "gemini" });
    expect(sel.getTextSelection()).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "gemini",
      valid: true,
    });
  });

  it("provider+model pin => valid only when model is curated", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "gemini", KITCHEN_CODEX_TEXT_MODEL: "gemini-3.7-flash" });
    expect(sel.getTextSelection().valid).toBe(true);
    expect(sel.getTextSelection().selectedModelId).toBe("gemini-3.7-flash");

    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "gemini", KITCHEN_CODEX_TEXT_MODEL: "not-a-curated-model" });
    expect(sel.getTextSelection()).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "gemini",
      selectedModelId: "not-a-curated-model",
      valid: false,
    });
  });

  it("unknown provider pin => invalid, reported truthfully", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "ghost" });
    expect(sel.getTextSelection()).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "ghost",
      valid: false,
    });
  });

  it("OpenRouter/DeepSeek pins require their operator key (enabled gate), Gemini never requires it", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "openrouter" });
    expect(sel.getTextSelection().valid).toBe(false);
    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "openrouter", OPENROUTER_API_KEY: SENTINEL });
    expect(sel.getTextSelection().valid).toBe(true);
    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: SENTINEL });
    expect(sel.getTextSelection().valid).toBe(true);
  });

  it("trimmed/whitespace-only env pins are ignored (server_default)", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "   " });
    expect(sel.getTextSelection()).toEqual({ selectionMode: "server_default", valid: true });
    sel = await freshSelection({ KITCHEN_CODEX_TEXT_PROVIDER: "  gemini  " });
    expect(sel.getTextSelection()).toMatchObject({ selectionMode: "server_managed", selectedProviderId: "gemini", valid: true });
  });
});

describe("server-managed image selection + runtime pair resolution (BYOK-2)", () => {
  it("unset image env => server_default + real Gemini default pair (deterministic seam never a default)", async () => {
    sel = await freshSelection({});
    expect(sel.getImageSelection()).toEqual({ selectionMode: "server_default", valid: true });
    const pair = sel.resolveSelectedImagePair();
    // Class identity is module-cache-fresh after vi.resetModules; assert by id.
    expect(pair.provider.id).toBe("gemini-image");
    expect(pair.provider.name).toBe("Google Gemini Image");
    expect(pair.model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
  });

  it("valid image provider pin resolves to the registry provider + pinned model", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_IMAGE_PROVIDER: "gemini-image", KITCHEN_CODEX_IMAGE_MODEL: DEFAULT_GEMINI_IMAGE_MODEL });
    expect(sel.getImageSelection()).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "gemini-image",
      selectedModelId: DEFAULT_GEMINI_IMAGE_MODEL,
      valid: true,
    });
    const pair = sel.resolveSelectedImagePair();
    expect(pair.provider.id).toBe("gemini-image");
    expect(pair.model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
  });

  it("valid provider pin with NO model => default model, still valid", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_IMAGE_PROVIDER: "gemini-image" });
    expect(sel.getImageSelection().valid).toBe(true);
    const pair = sel.resolveSelectedImagePair();
    expect(pair.model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
  });

  it("unknown image provider pin => invalid and runtime FAILS CLOSED (null, zero provider execution, never Gemini)", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_IMAGE_PROVIDER: "deterministic-image", KITCHEN_CODEX_IMAGE_MODEL: "x" });
    const state = sel.getImageSelection();
    expect(state.selectionMode).toBe("server_managed");
    expect(state.selectedProviderId).toBe("deterministic-image");
    expect(state.valid).toBe(false);
    // Explicit invalid pin -> NO provider (fail closed). Notably this is the
    // deterministic seam: it must NEVER execute, and Gemini must NOT be its
    // silent replacement either.
    expect(sel.resolveSelectedImagePair()).toBeNull();
  });

  it("uncurated image model pin => invalid + FAIL CLOSED (null, never a silent Gemini default)", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_IMAGE_PROVIDER: "gemini-image", KITCHEN_CODEX_IMAGE_MODEL: "not-a-model" });
    const state = sel.getImageSelection();
    expect(state.valid).toBe(false);
    expect(state.selectedModelId).toBe("not-a-model");
    // Even though the pinned PROVIDER is Gemini itself, an invalid explicit pin
    // must fail closed (no surprise provider execution on an invalid pin).
    expect(sel.resolveSelectedImagePair()).toBeNull();
  });

  it("OpenRouter Image pinned without its operator key => invalid and FAIL CLOSED (no Gemini fallback)", async () => {
    sel = await freshSelection({ KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image" });
    expect(sel.getImageSelection()).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "openrouter-image",
      valid: false,
    });
    // Explicit pin + disabled provider -> null (zero execution, zero cost).
    expect(sel.resolveSelectedImagePair()).toBeNull();
  });

  it("OpenRouter Image pin requires its operator key + a CURATED image model (BYOK-3)", async () => {
    // No key -> provider disabled -> invalid.
    sel = await freshSelection({ KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image" });
    expect(sel.getImageSelection()).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "openrouter-image",
      valid: false,
    });

    // Key + curated default model -> valid, runtime resolves OpenRouter Image.
    sel = await freshSelection({
      KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image",
      KITCHEN_CODEX_IMAGE_MODEL: "google/gemini-2.5-flash-image",
      OPENROUTER_API_KEY: SENTINEL,
    });
    const state = sel.getImageSelection();
    expect(state.selectionMode).toBe("server_managed");
    expect(state.selectedProviderId).toBe("openrouter-image");
    expect(state.selectedModelId).toBe("google/gemini-2.5-flash-image");
    expect(state.valid).toBe(true);
    const pair = sel.resolveSelectedImagePair();
    expect(pair.provider.id).toBe("openrouter-image");
    expect(pair.provider.name).toBe("OpenRouter Image");
    expect(pair.model).toBe("google/gemini-2.5-flash-image");
  });

  it("openrouter-image with a non-default CURATED model is valid too (curated set, not just default)", async () => {
    sel = await freshSelection({
      KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image",
      KITCHEN_CODEX_IMAGE_MODEL: "bytedance-seed/seedream-4.5",
      OPENROUTER_API_KEY: SENTINEL,
    });
    expect(sel.getImageSelection()).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "openrouter-image",
      selectedModelId: "bytedance-seed/seedream-4.5",
      valid: true,
    });
    expect(sel.resolveSelectedImagePair().provider.id).toBe("openrouter-image");
  });

  it("openrouter-image with an UNKNOWN/uncurated model => invalid + FAIL CLOSED (null, never an unknown model AND never Gemini)", async () => {
    sel = await freshSelection({
      KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image",
      KITCHEN_CODEX_IMAGE_MODEL: "totally/not-curated",
      OPENROUTER_API_KEY: SENTINEL,
    });
    const state = sel.getImageSelection();
    expect(state.valid).toBe(false);
    expect(sel.resolveSelectedImagePair()).toBeNull(); // fail closed: no provider at all
  });

  it("UNSET image selection preserves the exact Gemini default (fail-closed does not touch the unset path)", async () => {
    sel = await freshSelection({});
    expect(sel.getImageSelection()).toEqual({ selectionMode: "server_default", valid: true });
    const pair = sel.resolveSelectedImagePair();
    expect(pair).not.toBeNull();
    expect(pair!.provider.id).toBe("gemini-image");
    expect(pair!.model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
  });
});