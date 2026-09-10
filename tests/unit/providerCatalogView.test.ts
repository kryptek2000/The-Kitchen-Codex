import { describe, it, expect } from "vitest";
import type { NetworkAdapter, NetworkResponse } from "../../src/application/adapters/NetworkAdapter.js";
import {
  fetchProviderCatalog,
  normalizeProviderCatalog,
  PROVIDER_CATALOG_API_PATH,
  type ProviderCatalogView,
} from "../../src/application-ui/providerCatalog.js";

const SENTINEL = "SUPER_SECRET_BYOK1_SENTINEL";

function textProvider(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    providerId: "gemini",
    name: "Google Gemini",
    configured: true,
    enabled: true,
    available: true,
    storageScope: "server_environment",
    supportsSecretWrites: false,
    models: [
      {
        id: "gemini-3.7-flash",
        default: true,
        capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true },
      },
    ],
    ...overrides,
  };
}

function imageProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: "gemini-image",
    name: "Google Gemini Image",
    configured: true,
    enabled: true,
    available: true,
    imageGeneration: true,
    formats: ["image/png", "image/webp"],
    maxBytes: 4 * 1024 * 1024,
    models: [{ id: "gemini-2.5-flash-image", default: true }],
    ...overrides,
  };
}

function selection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { selectionMode: "server_default", valid: true, ...overrides };
}

function payload(
  textProviders = [textProvider()],
  imageProviders = [imageProvider()],
  selectionBlock: { text?: Record<string, unknown>; image?: Record<string, unknown> } = {}
) {
  return {
    catalog: {
      textProviders,
      imageProviders,
      selection: { text: selection(selectionBlock.text), image: selection(selectionBlock.image) },
    },
  };
}

function fakeGetNetwork(data: unknown, ok = true, status = 200): NetworkAdapter {
  const get = async <T,>(): Promise<NetworkResponse<T>> => ({ status, ok, data: data as T });
  return { get, request: async () => ({ status, ok, data: undefined }), post: async () => ({ status, ok, data: undefined }) } as unknown as NetworkAdapter;
}

describe("provider catalog view model (BYOK-1) — normalization", () => {
  it("keeps ONLY allowlisted fields; unknown/secret-shaped fields never survive", () => {
    const view = normalizeProviderCatalog(
      payload(
        [textProvider({ apiKey: SENTINEL, token: SENTINEL, secret: SENTINEL, maskedKey: "abc1", value: SENTINEL })],
        [imageProvider({ apiKey: SENTINEL, secret: SENTINEL })]
      )
    );
    expect(view.textProviders).toHaveLength(1);
    expect(view.imageProviders).toHaveLength(1);
    const all = [...view.textProviders, ...view.imageProviders];
    for (const row of all) {
      for (const k of Object.keys(row)) {
        expect(["key", "token", "secret", "apiKey", "value", "maskedKey"].includes(k)).toBe(false);
      }
    }
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("abc1");
  });

  it("coerces capability booleans truthfully and normalizes unknown capability keys to false", () => {
    const view = normalizeProviderCatalog(
      payload([
        textProvider({
          models: [
            {
              id: "some-model",
              default: false,
              capabilities: { reasoning: true, structuredOutput: false, recipeGeneration: false, webSearch: "yes", futureCap: true },
            },
          ],
        }),
      ])
    );
    expect(view.textProviders[0].models[0].capabilities).toEqual({
      reasoning: true,
      structuredOutput: false,
      recipeGeneration: false,
      webSearch: false,
    });
  });

  it("filters image formats to the shared allowlist; unknown formats are dropped", () => {
    const view = normalizeProviderCatalog(
      payload([], [imageProvider({ formats: ["image/png", "image/gif", "image/svg+xml", "image/webp"] })])
    );
    expect(view.imageProviders[0].formats).toEqual(["image/png", "image/webp"]);
  });

  it("rejects an image provider that declares NO known format (fail-closed)", () => {
    const view = normalizeProviderCatalog(
      payload([textProvider()], [imageProvider({ formats: ["image/gif"] })])
    );
    expect(view.textProviders).toHaveLength(1);
    expect(view.imageProviders).toHaveLength(0);
  });

  it("skips malformed rows without crashing, preserving valid rows", () => {
    const view = normalizeProviderCatalog(
      payload(
        [textProvider(), { providerId: 42 }, textProvider({ providerId: "openrouter", name: "OpenRouter", models: [] })],
        [imageProvider(), {}]
      )
    );
    expect(view.textProviders.map((p) => p.providerId)).toEqual(["gemini", "openrouter"]);
    expect(view.imageProviders.map((p) => p.providerId)).toEqual(["gemini-image"]);
  });

  it("throws on fundamentally malformed payloads (never fabricates a catalog)", () => {
    expect(() => normalizeProviderCatalog(null)).toThrow();
    expect(() => normalizeProviderCatalog("nope")).toThrow();
    expect(() => normalizeProviderCatalog({})).toThrow();
    expect(() => normalizeProviderCatalog({ catalog: {} })).toThrow();
    expect(() => normalizeProviderCatalog({ catalog: { textProviders: [], imageProviders: [] } })).toThrow();
    expect(() => normalizeProviderCatalog({ catalog: { textProviders: "nope", imageProviders: [] } })).toThrow();
  });
});

describe("provider catalog view model (BYOK-2) — selection truth", () => {
  it("normalizes server_default selection for text and image", () => {
    const view = normalizeProviderCatalog(payload());
    expect(view.selection.text).toEqual({ selectionMode: "server_default", valid: true });
    expect(view.selection.image).toEqual({ selectionMode: "server_default", valid: true });
  });

  it("normalizes a server-managed provider/model pin without leaking secrets", () => {
    const view = normalizeProviderCatalog(
      payload([textProvider()], [imageProvider()], {
        text: {
          selectionMode: "server_managed",
          selectedProviderId: "openrouter",
          selectedModelId: "openai/gpt-4o-mini",
          valid: true,
          apiKey: SENTINEL,
        },
      })
    );
    expect(view.selection.text).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "openrouter",
      selectedModelId: "openai/gpt-4o-mini",
      valid: true,
    });
    expect(JSON.stringify(view)).not.toContain(SENTINEL);
  });

  it("preserves selectedProviderId with no model when only the provider is pinned", () => {
    const view = normalizeProviderCatalog(
      payload([textProvider()], [imageProvider()], {
        image: { selectionMode: "server_managed", selectedProviderId: "gemini-image", valid: true },
      })
    );
    expect(view.selection.image).toMatchObject({ selectionMode: "server_managed", selectedProviderId: "gemini-image" });
    expect(view.selection.image.selectedModelId).toBeUndefined();
  });

  it("preserves an invalid pin (valid:false) for truthful UI warning", () => {
    const view = normalizeProviderCatalog(
      payload([textProvider()], [imageProvider()], {
        text: { selectionMode: "server_managed", selectedProviderId: "nope", valid: false },
      })
    );
    expect(view.selection.text).toEqual({ selectionMode: "server_managed", selectedProviderId: "nope", valid: false });
  });

  it("throws when selection truth is missing or malformed (fail-closed)", () => {
    expect(() => normalizeProviderCatalog({ catalog: { textProviders: [], imageProviders: [imageProvider()] } })).toThrow();
    expect(() =>
      normalizeProviderCatalog({
        catalog: {
          textProviders: [textProvider()],
          imageProviders: [imageProvider()],
          selection: { text: { selectionMode: "bogus", valid: true }, image: selection() },
        },
      })
    ).toThrow();
    expect(() =>
      normalizeProviderCatalog({
        catalog: {
          textProviders: [textProvider()],
          imageProviders: [imageProvider()],
          selection: { text: selection(), image: { selectionMode: "server_managed" } },
        },
      })
    ).toThrow();
  });
});

describe("fetchProviderCatalog (BYOK-1)", () => {
  it("fetches the app-scoped catalog path through the NetworkAdapter", async () => {
    let requestedPath = "";
    const network = {
      get: async <T,>(p: string) => {
        requestedPath = p;
        return { status: 200, ok: true, data: payload() } as NetworkResponse<T>;
      },
      request: async () => ({ status: 200, ok: true, data: undefined }),
      post: async () => ({ status: 200, ok: true, data: undefined }),
    } as unknown as NetworkAdapter;
    const view = await fetchProviderCatalog(network);
    expect(requestedPath).toBe(PROVIDER_CATALOG_API_PATH);
    expect(requestedPath).toBe("/api/providers/catalog");
    expect(view.textProviders).toHaveLength(1);
    expect(view.imageProviders).toHaveLength(1);
  });

  it("throws on a non-2xx response (no fabricated catalog)", async () => {
    await expect(fetchProviderCatalog(fakeGetNetwork(undefined, false, 503))).rejects.toThrow();
  });

  it("throws when the response carries no data", async () => {
    await expect(fetchProviderCatalog(fakeGetNetwork(undefined, true, 200))).rejects.toThrow();
  });

  it("propagates a transport failure as a thrown error", async () => {
    const network = { get: async () => { throw new Error("catalog down"); } } as unknown as NetworkAdapter;
    await expect(fetchProviderCatalog(network)).rejects.toThrow(/catalog down/);
  });

  it("never returns a secret value to the caller", async () => {
    const rows = await fetchProviderCatalog(
      fakeGetNetwork(payload([textProvider({ apiKey: SENTINEL, key: SENTINEL })]))
    );
    const serialized = JSON.stringify(rows as ProviderCatalogView);
    expect(serialized).not.toContain(SENTINEL);
  });
});