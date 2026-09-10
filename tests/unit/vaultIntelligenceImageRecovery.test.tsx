/**
 * The Kitchen Codex — Vault Intelligence Image Recovery UI tests (v0.7 Phase 2B).
 *
 * Two layers, matching the repo's UI-test conventions (renderToString for
 * presentational gating/labels; platform-neutral controller tests for flow
 * liveness, busy guards, and conflict messaging — no DOM interaction needed).
 */

import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { RecipeImageFindingView } from "../../src/components/VaultIntelligenceModal.js";
import {
  RecipeImageRecoveryController,
  isImageRecoverySupported,
  mapRecipeImageRecoveryError,
  RecipeImageProviderClientError,
  recipeImagePreviewPath,
  type RecipeImageRecoverySupport,
  type RecipeImageRecoveryState,
} from "../../src/application/recipeImageRecovery.js";
import { RecipeImageSaveConflictError } from "../../src/application/recipeImageSave.js";
import type { NetworkAdapter, NetworkResponse } from "../../src/application/adapters/NetworkAdapter.js";
import type { AssetAdapter } from "../../src/application/adapters/AssetAdapter.js";
import type { ObsidianRecipe } from "../../src/types.js";

const PNG_PREVIEW_TOKEN = "tok-preview-1";

function recipeFixture(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: "r-1",
    fileName: "Test Soup.md",
    filePath: "Test Soup.md",
    rawMarkdown: "---\ntitle: Test Soup\n---\n\n# Test Soup\n",
    title: "Test Soup",
    category: "Soup",
    cuisine: "French",
    ingredients: [{ name: "potato" }, { name: "leek" }],
    instructions: [],
    ...overrides,
  } as unknown as ObsidianRecipe;
}

function fakeSupport(overrides: Partial<RecipeImageRecoverySupport> = {}): RecipeImageRecoverySupport {
  return {
    vaultSessionId: "vault-session-abc",
    asset: { write: async () => {}, exists: async () => false } as unknown as AssetAdapter,
    computeContentHash: async () => "a".repeat(64),
    saveImage: async () => ({ imagePath: "Assets/Test Soup.png", provider: "gemini-image", model: "m", generatedAt: "2026-09-09T12:00:00.000Z" }),
    ...overrides,
  };
}

function fakeNetwork(postImpl?: (path: string, body: unknown) => Promise<NetworkResponse<unknown>>, requestImpl?: (req: { method: string; path: string }) => Promise<NetworkResponse<unknown>>): NetworkAdapter & { posts: { path: string; body: unknown }[]; deletes: string[] } {
  const posts: { path: string; body: unknown }[] = [];
  const deletes: string[] = [];
  return {
    posts,
    deletes,
    request: async (req: { method: string; path: string }) => {
      if (req.method === "DELETE") deletes.push(req.path);
      if (requestImpl) return requestImpl(req);
      return { status: 200, ok: true, data: { ok: true } };
    },
    get: async () => ({ status: 200, ok: true }),
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      if (postImpl) return postImpl(path, body);
      return {
        status: 200,
        ok: true,
        data: { token: PNG_PREVIEW_TOKEN, contentType: "image/png", provider: "gemini-image", model: "gemini-2.5-flash-image", recipeContentHash: "b".repeat(64), vaultSessionId: "vault-session-abc", expiresAt: Date.now() + 300000 },
      };
    },
  } as unknown as NetworkAdapter & { posts: { path: string; body: unknown }[]; deletes: string[] };
}

function makeController(
  support: RecipeImageRecoverySupport | undefined,
  network: NetworkAdapter,
  options: { saveImpl?: (input: unknown) => Promise<unknown>; generateImpl?: (path: string, body: unknown) => Promise<NetworkResponse<unknown>> } = {}
) {
  const states: RecipeImageRecoveryState[] = [];
  const saved: { imagePath: string }[] = [];
  const effectiveSupport = support;
  const controller = new RecipeImageRecoveryController({
    network,
    support: effectiveSupport as RecipeImageRecoverySupport,
    onState: (s) => states.push(s),
    onSaved: (result) => saved.push(result),
  });
  if (options.saveImpl && effectiveSupport) {
    effectiveSupport.saveImage = options.saveImpl as RecipeImageRecoverySupport["saveImage"];
  }
  return { controller, states, saved };
}

const until = async (cond: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

function render(ui: ReactElement): string {
  return renderToString(ui);
}

describe("RecipeImageFindingView — capability gating + findings (rendered)", () => {
  const base = {
    health: null,
    canGenerate: true,
    recoveryState: { phase: "idle" as const },
    busy: false,
    onGenerate: () => {},
    onSave: () => {},
    onRegenerate: () => {},
    onCancel: () => {},
  };

  it("shows the MISSING image finding with a Generate action when capable", () => {
    const html = render(
      <RecipeImageFindingView
        {...base}
        health={{ kind: "missing", deterministic: true, reason: "No image is assigned to this recipe." }}
      />
    );
    expect(html).toContain("No image");
    expect(html).toContain("Generate Image");
  });

  it("shows the BROKEN-LOCAL finding (repair candidate) with a Generate action", () => {
    const html = render(
      <RecipeImageFindingView
        {...base}
        health={{ kind: "broken_local", deterministic: true, reason: "The referenced image file does not exist in the vault.", imageRef: "Assets/Old Broken.jpg" }}
      />
    );
    expect(html).toContain("Broken local image");
    expect(html).toContain("Assets/Old Broken.jpg");
    expect(html).toContain("Generate Image");
    expect(html).toContain("not deleted"); // old asset never auto-deleted
  });

  it("shows NO recovery action for a VALID local image (never replace)", () => {
    const html = render(
      <RecipeImageFindingView
        {...base}
        health={{ kind: "valid_local", deterministic: true, reason: "Local image reference resolves to a supported image." }}
      />
    );
    expect(html).toContain("Image looks healthy");
    expect(html).not.toContain("Generate Image");
    expect(html).not.toContain("Save Image");
  });

  it("shows NO recovery action for a healthy REMOTE reference (no probing)", () => {
    const html = render(
      <RecipeImageFindingView
        {...base}
        health={{ kind: "remote_present", deterministic: true, reason: "Remote image reference is present (not probed in this phase).", imageRef: "https://example.com/soup.jpg" }}
      />
    );
    expect(html).toContain("Image looks healthy");
    expect(html).not.toContain("Generate Image");
  });

  it("shows invalid_remote / unverifiable_local as informational only (no unsafe repair)", () => {
    const invalidRemote = render(
      <RecipeImageFindingView
        {...base}
        health={{ kind: "invalid_remote", deterministic: true, reason: "Remote image reference is malformed.", imageRef: "ftp://x" }}
      />
    );
    expect(invalidRemote).toContain("Invalid remote image reference");
    expect(invalidRemote).not.toContain("Generate Image");

    const unverifiable = render(
      <RecipeImageFindingView
        {...base}
        health={{ kind: "unverifiable_local", deterministic: true, reason: "No vault asset access is available to verify it." }}
      />
    );
    expect(unverifiable).toContain("could not be verified");
    expect(unverifiable).not.toContain("Generate Image");
  });

  it("does NOT show Generate on a non-capable surface (Obsidian / no writable vault) and shows the truthful reason", () => {
    const html = render(
      <RecipeImageFindingView
        {...base}
        canGenerate={false}
        unavailableReason="Image recovery is available in the browser app with a writable connected vault."
        health={{ kind: "missing", deterministic: true, reason: "No image is assigned to this recipe." }}
      />
    );
    expect(html).toContain("No image");
    expect(html).not.toContain("Generate Image");
    expect(html).toContain("writable connected vault");
  });

  it("labels the preview as AI-generated + nothing saved, and renders it via the authenticated endpoint (no base64)", () => {
    const html = render(
      <RecipeImageFindingView
        {...base}
        recoveryState={{
          phase: "preview",
          preview: {
            token: PNG_PREVIEW_TOKEN,
            contentType: "image/png",
            provider: "gemini-image",
            model: "gemini-2.5-flash-image",
            recipeContentHash: "b".repeat(64),
            vaultSessionId: "vault-session-abc",
          },
          message: "AI-generated preview — nothing is saved yet.",
          messageKind: "info",
        }}
      />
    );
    expect(html).toContain("AI-generated preview");
    expect(html).toContain("nothing saved yet");
    expect(html).toContain(`src="${recipeImagePreviewPath(PNG_PREVIEW_TOKEN)}"`);
    expect(html).toContain("Save Image");
    expect(html).toContain("Regenerate");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("base64");
  });
});

describe("RecipeImageRecoveryController — flow, liveness, guards, conflicts", () => {
  it("capability gate: support object is required and validated", () => {
    expect(isImageRecoverySupported(undefined)).toBe(false);
    expect(isImageRecoverySupported(fakeSupport())).toBe(true);
    expect(isImageRecoverySupported(fakeSupport({ vaultSessionId: "" }))).toBe(false);
    expect(isImageRecoverySupported(fakeSupport({ asset: undefined as unknown as AssetAdapter }))).toBe(false);
  });

  it("Generate posts the BOUNDED request and produces preview state; nothing is auto-saved", async () => {
    const network = fakeNetwork();
    const saveImage = vi.fn();
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const states: RecipeImageRecoveryState[] = [];
    const controller = new RecipeImageRecoveryController({ network, support, onState: (s) => states.push(s) });

    await controller.generate(recipeFixture());

    expect(network.posts).toHaveLength(1);
    expect(network.posts[0].path).toBe("/api/recipes/image/generate");
    const body = network.posts[0].body as Record<string, unknown>;
    // Bounded grounding fields + hash + session; never whole-vault content.
    expect(body["title"]).toBe("Test Soup");
    expect(body["recipeContentHash"]).toBe("a".repeat(64));
    expect(body["vaultSessionId"]).toBe("vault-session-abc");
    expect(body["ingredients"]).toEqual(["potato", "leek"]);
    expect(JSON.stringify(body)).not.toContain("rawMarkdown");

    const state = controllerState(states);
    expect(state.phase).toBe("preview");
    expect(state.preview?.token).toBe(PNG_PREVIEW_TOKEN);
    expect(state.preview?.provider).toBe("gemini-image");
    // Preview is NEVER auto-saved.
    expect(saveImage).not.toHaveBeenCalled();
    expect(states.some((s) => s.message?.includes("nothing is saved yet"))).toBe(true);
  });

  function controllerState(states: RecipeImageRecoveryState[]): RecipeImageRecoveryState {
    return states[states.length - 1];
  }

  it("Save success: canonical save invoked with approval metadata, onSaved fires, preview cleared, bounded success message", async () => {
    const network = fakeNetwork();
    const { controller, states, saved } = makeController(fakeSupport(), network);
    await controller.generate(recipeFixture());
    await controller.save(recipeFixture());
    const state = controllerState(states);
    expect(state.phase).toBe("saved");
    expect(state.preview).toBeUndefined();
    expect(state.message).toContain("Image saved to Assets/Test Soup.png");
    expect(saved).toEqual([{ imagePath: "Assets/Test Soup.png", provider: "gemini-image", model: "m", generatedAt: "2026-09-09T12:00:00.000Z" }]);
  });

  it("Regenerate: new token replaces the preview ONLY after success; old token invalidated; canonical untouched", async () => {
    const network = fakeNetwork();
    const saveImage = vi.fn(async () => ({ imagePath: "x", provider: "p", model: "m", generatedAt: "t" }));
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const { controller, states } = makeController(support, network);

    await controller.generate(recipeFixture());
    expect(controllerState(states).preview?.token).toBe(PNG_PREVIEW_TOKEN);

    // Second generation returns a DIFFERENT token each call.
    let genCount = 0;
    const network2 = fakeNetwork(async () => {
      genCount += 1;
      return {
        status: 200,
        ok: true,
        data: { token: `tok-preview-${genCount + 1}`, contentType: "image/png", provider: "gemini-image", model: "m", recipeContentHash: "b".repeat(64), vaultSessionId: "vault-session-abc", expiresAt: 1 },
      };
    });
    const states2: RecipeImageRecoveryState[] = [];
    const c2 = new RecipeImageRecoveryController({ network: network2, support, onState: (s) => states2.push(s) });
    await c2.generate(recipeFixture());
    expect(controllerState(states2).preview?.token).toBe("tok-preview-2");
    await c2.regenerate(recipeFixture());

    const state = controllerState(states2);
    expect(state.preview?.token).toBe("tok-preview-3");
    expect(state.phase).toBe("preview");
    // Old token invalidated best-effort via the preview DELETE endpoint.
    expect(network2.deletes).toContain(recipeImagePreviewPath("tok-preview-2"));
    expect(network2.deletes).not.toContain(recipeImagePreviewPath("tok-preview-3"));
    // Canonical recipe untouched: no save was ever requested.
    expect(saveImage).not.toHaveBeenCalled();
  });

  it("Cancel: clears preview UI, invalidates token, NO canonical mutation", async () => {
    const network = fakeNetwork();
    const saveImage = vi.fn(async () => ({ imagePath: "x", provider: "p", model: "m", generatedAt: "t" }));
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const { controller, states } = makeController(support, network);
    await controller.generate(recipeFixture());
    await controller.cancel();
    const state = controllerState(states);
    expect(state.phase).toBe("idle");
    expect(state.preview).toBeUndefined();
    expect(network.deletes).toContain(recipeImagePreviewPath(PNG_PREVIEW_TOKEN));
    expect(saveImage).not.toHaveBeenCalled();
  });

  it("duplicate Generate blocked while in flight (single POST)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const network = fakeNetwork(async () => {
      await gate;
      return { status: 200, ok: true, data: { token: "t", contentType: "image/png", provider: "p", model: "m", recipeContentHash: "b".repeat(64), vaultSessionId: "s", expiresAt: 1 } };
    });
    const { controller } = makeController(fakeSupport(), network);
    const first = controller.generate(recipeFixture());
    const second = controller.generate(recipeFixture()); // blocked (busy)
    await new Promise((r) => setTimeout(r, 25));
    expect(network.posts).toHaveLength(1);
    release();
    await first;
    await second;
    expect(network.posts).toHaveLength(1);
  });

  it("duplicate Save blocked while in flight (single saveImage)", async () => {
    const network = fakeNetwork();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const saveImage = vi.fn(async () => {
      calls += 1;
      await gate;
      return { imagePath: "x", provider: "p", model: "m", generatedAt: "t" };
    });
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const { controller } = makeController(support, network);
    await controller.generate(recipeFixture());
    const first = controller.save(recipeFixture());
    const second = controller.save(recipeFixture()); // blocked (busy)
    await new Promise((r) => setTimeout(r, 25));
    expect(calls).toBe(1);
    release();
    await first;
    await second;
    expect(calls).toBe(1);
  });

  it("close during generation DROPS the late result (no state repopulation)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const network = fakeNetwork(async () => {
      await gate;
      return { status: 200, ok: true, data: { token: "late-token", contentType: "image/png", provider: "p", model: "m", recipeContentHash: "b".repeat(64), vaultSessionId: "s", expiresAt: 1 } };
    });
    const { controller, states } = makeController(fakeSupport(), network);
    const pending = controller.generate(recipeFixture());
    await until(() => network.posts.length === 1);
    controller.close(); // session advanced: in-flight result must be dropped
    release();
    await pending;
    await new Promise((r) => setTimeout(r, 25));
    const state = controllerState(states);
    expect(state.phase).toBe("idle");
    expect(state.preview).toBeUndefined();
  });

  it("close during save DROPS the late completion (onSaved never fires)", async () => {
    const network = fakeNetwork();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const saveImage = vi.fn(async () => {
      await gate;
      return { imagePath: "Assets/Late.png", provider: "p", model: "m", generatedAt: "t" };
    });
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const { controller, saved, states } = makeController(support, network);
    await controller.generate(recipeFixture());
    const pending = controller.save(recipeFixture());
    await until(() => callsOf(saveImage) === 1);
    controller.close(); // session advanced: late save completion must be ignored
    release();
    await pending;
    await new Promise((r) => setTimeout(r, 25));
    expect(saved).toEqual([]);
    expect(controllerState(states).phase).toBe("idle");
  });

  function callsOf(fn: ReturnType<typeof vi.fn>): number {
    return fn.mock.calls.length;
  }

  it("recipe-changed conflict: specific bounded message, preview PRESERVED for retry, no auto-discard", async () => {
    const network = fakeNetwork();
    const saveImage = vi.fn(async () => {
      throw new RecipeImageSaveConflictError("RECIPE_CHANGED", "The recipe has changed since this image was generated. Please regenerate.");
    });
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const { controller, states } = makeController(support, network);
    await controller.generate(recipeFixture());
    await controller.save(recipeFixture());
    const state = controllerState(states);
    expect(state.conflict).toBe("RECIPE_CHANGED");
    expect(state.message).toContain("recipe changed");
    expect(state.phase).toBe("preview");
    expect(state.preview?.token).toBe(PNG_PREVIEW_TOKEN); // preserved (retry safe)
  });

  it("vault-changed conflict: specific bounded message, preview preserved", async () => {
    const network = fakeNetwork();
    const saveImage = vi.fn(async () => {
      throw new RecipeImageSaveConflictError("VAULT_CHANGED", "The vault has changed since this image was generated. Please try again.");
    });
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const { controller, states } = makeController(support, network);
    await controller.generate(recipeFixture());
    await controller.save(recipeFixture());
    const state = controllerState(states);
    expect(state.conflict).toBe("VAULT_CHANGED");
    expect(state.message).toContain("vault has changed");
    expect(state.phase).toBe("preview");
  });

  it("image-already-present conflict: specific bounded message, preview preserved", async () => {
    const network = fakeNetwork();
    const saveImage = vi.fn(async () => {
      throw new RecipeImageSaveConflictError("IMAGE_ALREADY_PRESENT", "This recipe already has a valid image.");
    });
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const { controller, states } = makeController(support, network);
    await controller.generate(recipeFixture());
    await controller.save(recipeFixture());
    const state = controllerState(states);
    expect(state.conflict).toBe("IMAGE_ALREADY_PRESENT");
    expect(state.message).toContain("already has a valid image");
    expect(state.phase).toBe("preview");
  });

  it("preview-expired conflict: bounded message, preview dropped, regenerate required", async () => {
    const network = fakeNetwork();
    const saveImage = vi.fn(async () => {
      throw new RecipeImageSaveConflictError("PREVIEW_UNAVAILABLE", "The image preview has expired. Please generate it again.");
    });
    const support = fakeSupport({ saveImage: saveImage as unknown as RecipeImageRecoverySupport["saveImage"] });
    const { controller, states } = makeController(support, network);
    await controller.generate(recipeFixture());
    await controller.save(recipeFixture());
    const state = controllerState(states);
    expect(state.conflict).toBe("PREVIEW_EXPIRED");
    expect(state.message).toContain("expired");
    expect(state.phase).toBe("idle");
    expect(state.preview).toBeUndefined();
  });

  it("provider failures are bounded and map to DISTINCT messages: no raw provider error text", async () => {
    const cases: { status: number; code?: string; raw: string; expectContains: string }[] = [
      { status: 401, raw: "API key invalid: sk-SUPER_SECRET", expectContains: "not authorized" },
      { status: 429, raw: "rate limit", expectContains: "Too many image generation requests" },
      { status: 503, code: "IMAGE_PROVIDER_NOT_CONFIGURED", raw: "no provider", expectContains: "No image generation provider is configured" },
      { status: 503, code: "IMAGE_PROVIDER_QUOTA", raw: "quota exceeded for project", expectContains: "Image generation quota has been reached" },
      { status: 503, code: "IMAGE_PROVIDER_RATE_LIMIT", raw: "too many concurrent ups", expectContains: "being rate limited" },
      { status: 503, code: "IMAGE_PROVIDER_TIMEOUT", raw: "request stalled on network", expectContains: "timed out" },
      { status: 503, code: "IMAGE_PROVIDER_TEMPORARILY_UNAVAILABLE", raw: "upstream down", expectContains: "temporarily unavailable" },
      { status: 502, code: "IMAGE_PROVIDER_NO_IMAGE", raw: "returned zero inline parts", expectContains: "did not return an image" },
      { status: 502, code: "IMAGE_PROVIDER_BLOCKED", raw: "safety policy violation text", expectContains: "adjusting the recipe description" },
      { status: 502, code: "INVALID_IMAGE", raw: "bad bytes", expectContains: "not usable" },
      { status: 503, code: "QUOTA", raw: "quota exceeded for project abc", expectContains: "quota" },
    ];
    for (const tc of cases) {
      const network = fakeNetwork(async () => ({
        status: tc.status,
        ok: false,
        data: { error: tc.raw, ...(tc.code ? { code: tc.code } : {}) },
      }));
      const { controller, states } = makeController(fakeSupport(), network);
      await controller.generate(recipeFixture());
      const state = controllerState(states);
      expect(state.phase).toBe("idle");
      expect(state.message).toContain(tc.expectContains);
      expect(state.message).not.toContain("SUPER_SECRET");
      expect(state.message).not.toContain(tc.raw);
    }
  });

  it("provider-neutral UI copy: UNAVAILABLE/BLOCKED/NO_IMAGE messages never hardcode a provider name (BYOK-3 hardening)", () => {
    const cases: Array<{ code: string; expectMessage: string }> = [
      {
        code: "IMAGE_PROVIDER_TEMPORARILY_UNAVAILABLE",
        expectMessage: "Image generation is temporarily unavailable. Please try again shortly.",
      },
      {
        code: "IMAGE_PROVIDER_BLOCKED",
        expectMessage: "The image provider could not generate an image for this recipe. Try adjusting the recipe description or generating again.",
      },
      {
        code: "IMAGE_PROVIDER_NO_IMAGE",
        expectMessage: "The image provider did not return an image for this recipe. Try generating again.",
      },
    ];
    for (const tc of cases) {
      const mapped = mapRecipeImageRecoveryError(new RecipeImageProviderClientError(502, "raw upstream text", tc.code));
      expect(mapped.message).toBe(tc.expectMessage);
      expect(mapped.message).not.toMatch(/Gemini|OpenRouter/i);
      expect(mapped.message).not.toContain("raw upstream text");
    }
  });

  it("unexpected provider failure falls back to the generic bounded message", async () => {
    const network = fakeNetwork(async () => ({ status: 500, ok: false, data: { error: "internal: stack-trace-with-secrets" } }));
    const { controller, states } = makeController(fakeSupport(), network);
    await controller.generate(recipeFixture());
    const state = controllerState(states);
    expect(state.phase).toBe("idle");
    expect(state.message).toBe("Couldn't generate an image right now.");
    expect(state.message).not.toContain("stack-trace-with-secrets");
  });
});
