import { describe, it, expect, afterEach, vi } from "vitest";
import type { SavedAiSelections, SavedSelection, AiSelectionCatalogSurface } from "../../src/application/aiSelection.js";

const SENTINEL = "SUPER_SECRET_BYOK4_SENTINEL";

type Surface = "text" | "image";
type SurfaceStatus = "loading" | "loaded" | "read-error" | "invalid-stored-intent";

interface AiSelectionModule {
  defaultAiSelections: () => SavedAiSelections;
  normalizeStoredSelection: (raw: unknown) => SavedSelection;
  parseStoredSelection: (raw: unknown) => { status: "default" | "selected" | "invalid"; selection: SavedSelection };
  isSelectionValidAgainstCatalog: (s: SavedSelection, c: AiSelectionCatalogSurface, k: Surface) => boolean;
  hydrateAiSelections: (settings: { get: (k: string) => Promise<unknown> }) => Promise<SavedAiSelections>;
  awaitAiSelectionReady: (kind?: Surface) => Promise<SavedAiSelections>;
  getAiSelectionHydrationStatus: () => SurfaceStatus;
  getAiSelectionSurfaceStatus: (kind: Surface) => SurfaceStatus;
  isAiSelectionReady: (kind?: Surface) => boolean;
  getCachedAiSelections: () => SavedAiSelections;
  saveAiSelection: (settings: { set: (k: string, v: unknown) => Promise<void> }, k: Surface, mode: "server_default" | "user_selected", providerId?: string, modelId?: string, credentialSource?: "server_environment" | "session_only") => Promise<SavedAiSelections>;
  resetAiSelection: (settings: { set: (k: string, v: unknown) => Promise<void> }, k: Surface) => Promise<SavedAiSelections>;
  buildAiSelectionHeaders: (s?: SavedAiSelections) => Record<string, string>;
  buildAiSelectionRequestOptions: (existing?: { headers?: Record<string, string> }, s?: SavedAiSelections, surface?: Surface) => Promise<{ headers?: Record<string, string> }>;
  AiSelectionNotReadyError: new (code: string, surface?: Surface) => Error & { code: string; surface?: Surface };
  TEXT_SELECTION_HEADER: string;
  IMAGE_SELECTION_HEADER: string;
  AI_SELECTION_SETTINGS_KEY: string;
}

async function fresh(): Promise<AiSelectionModule> {
  vi.resetModules();
  return await import("../../src/application/aiSelection.js");
}

function settings(getImpl: (k: string) => Promise<unknown>, setImpl: (k: string, v: unknown) => Promise<void> = async () => {}) {
  return { get: getImpl, set: setImpl };
}

function catalog(): AiSelectionCatalogSurface {
  return {
    textProviders: [
      { providerId: "gemini", models: [{ id: "gemini-3.7-flash" }, { id: "gemini-3.1-flash-lite" }], available: true, enabled: true, selectable: true },
      { providerId: "openrouter", models: [{ id: "openai/gpt-4o-mini" }], available: true, enabled: true, selectable: true },
      { providerId: "unavailable", models: [{ id: "m1" }], available: false, enabled: true, selectable: false },
      { providerId: "disabled", models: [{ id: "m1" }], available: true, enabled: false, selectable: false },
      { providerId: "notselectable", models: [{ id: "m1" }], available: true, enabled: true, selectable: false },
    ],
    imageProviders: [
      { providerId: "gemini-image", models: [{ id: "gemini-2.5-flash-image" }], available: true, enabled: true, selectable: true },
      { providerId: "image-unavailable", models: [{ id: "m1" }], available: false, enabled: true, selectable: false },
    ],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("BYOK-4 — strict stored-selection parsing", () => {
  it("absent/null storage is an intentional default; valid explicit is selected", async () => {
    const mod = await fresh();
    expect(mod.parseStoredSelection(undefined)).toEqual({ status: "default", selection: { mode: "server_default" } });
    expect(mod.parseStoredSelection(null)).toEqual({ status: "default", selection: { mode: "server_default" } });
    expect(mod.parseStoredSelection({ mode: "server_default" })).toEqual({ status: "default", selection: { mode: "server_default" } });
    expect(mod.parseStoredSelection({ mode: "user_selected", providerId: "gemini" })).toEqual({
      status: "selected",
      selection: { mode: "user_selected", providerId: "gemini" },
    });
    expect(mod.parseStoredSelection({ mode: "user_selected", providerId: "gemini", modelId: "gemini-3.7-flash" })).toEqual({
      status: "selected",
      selection: { mode: "user_selected", providerId: "gemini", modelId: "gemini-3.7-flash" },
    });
  });

  it("PRESENT but malformed stored intent is invalid (never collapsed to default)", async () => {
    const mod = await fresh();
    const invalid = { status: "invalid", selection: { mode: "server_default" } };
    expect(mod.parseStoredSelection("garbage")).toEqual(invalid);
    expect(mod.parseStoredSelection([])).toEqual(invalid);
    expect(mod.parseStoredSelection({})).toEqual(invalid);
    expect(mod.parseStoredSelection({ mode: "server_managed", providerId: "gemini" })).toEqual(invalid);
    expect(mod.parseStoredSelection({ mode: "user_selected" })).toEqual(invalid);
    expect(mod.parseStoredSelection({ mode: "user_selected", providerId: "" })).toEqual(invalid);
    expect(mod.parseStoredSelection({ mode: "user_selected", providerId: 123 })).toEqual(invalid);
    expect(mod.parseStoredSelection({ mode: "server_default", providerId: "gemini" })).toEqual(invalid);
    expect(mod.parseStoredSelection({ mode: "server_default", providerId: "" })).toEqual(invalid);
    // Oversized ids are rejected, never truncated.
    expect(mod.parseStoredSelection({ mode: "user_selected", providerId: "p".repeat(65) })).toEqual(invalid);
  });

  it("normalizeStoredSelection is the best-effort display normalizer", async () => {
    const mod = await fresh();
    expect(mod.normalizeStoredSelection(null)).toEqual({ mode: "server_default" });
    expect(mod.normalizeStoredSelection({ mode: "user_selected", providerId: "ghost" })).toEqual({
      mode: "user_selected",
      providerId: "ghost",
    });
  });

  it("isSelectionValidAgainstCatalog reports staleness for DISPLAY only (never mutates)", async () => {
    const mod = await fresh();
    const cat = catalog();
    expect(mod.isSelectionValidAgainstCatalog({ mode: "server_default" }, cat, "text")).toBe(true);
    expect(mod.isSelectionValidAgainstCatalog({ mode: "user_selected", providerId: "gemini", modelId: "gemini-3.7-flash" }, cat, "text")).toBe(true);
    expect(mod.isSelectionValidAgainstCatalog({ mode: "user_selected", providerId: "ghost" }, cat, "text")).toBe(false);
    expect(mod.isSelectionValidAgainstCatalog({ mode: "user_selected", providerId: "gemini", modelId: "not-a-model" }, cat, "text")).toBe(false);
    expect(mod.isSelectionValidAgainstCatalog({ mode: "user_selected", providerId: "gemini-image", modelId: "nope" }, cat, "image")).toBe(false);
  });
});

describe("BYOK-4 — PER-SURFACE hydration readiness", () => {
  it("starts loading for BOTH surfaces and blocks request building (no default-routing window)", async () => {
    const mod = await fresh();
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("loading");
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("loading");
    await expect(mod.awaitAiSelectionReady("text")).rejects.toBeInstanceOf(mod.AiSelectionNotReadyError);
    await expect(mod.awaitAiSelectionReady("image")).rejects.toBeInstanceOf(mod.AiSelectionNotReadyError);
    await expect(mod.buildAiSelectionRequestOptions(undefined, undefined, "text")).rejects.toBeInstanceOf(mod.AiSelectionNotReadyError);
  });

  it("saved valid selection + fresh app -> the first request honors it (per surface)", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(
      settings(async () => ({
        textAi: { mode: "user_selected", providerId: "gemini", modelId: "gemini-3.7-flash" },
        imageAi: { mode: "server_default" },
      }))
    );
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("loaded");
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("loaded");
    const text = await mod.buildAiSelectionRequestOptions(undefined, undefined, "text");
    expect(text.headers![mod.TEXT_SELECTION_HEADER]).toBe(
      JSON.stringify({ mode: "user_selected", providerId: "gemini", modelId: "gemini-3.7-flash" })
    );
    const image = await mod.buildAiSelectionRequestOptions(undefined, undefined, "image");
    expect(image.headers).toBeUndefined();
  });

  it("saved stale selection + fresh app -> explicit intent transmitted (server fails closed)", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(
      settings(async () => ({
        textAi: { mode: "user_selected", providerId: "ghost" },
        imageAi: { mode: "user_selected", providerId: "openrouter-image" },
      }))
    );
    const text = await mod.buildAiSelectionRequestOptions(undefined, undefined, "text");
    expect(text.headers![mod.TEXT_SELECTION_HEADER]).toBe(JSON.stringify({ mode: "user_selected", providerId: "ghost" }));
    const image = await mod.buildAiSelectionRequestOptions(undefined, undefined, "image");
    expect(image.headers![mod.IMAGE_SELECTION_HEADER]).toBe(
      JSON.stringify({ mode: "user_selected", providerId: "openrouter-image" })
    );
  });

  it("settings read fails + save Text only -> Image REMAINS BLOCKED", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(settings(async () => { throw new Error("storage down"); })).catch(() => {});
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("read-error");
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("read-error");

    await mod.saveAiSelection(settings(async () => undefined), "text", "user_selected", "gemini", "gemini-3.7-flash");
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("loaded");
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("read-error");

    // Text requests work; image requests stay fail-closed.
    await expect(mod.buildAiSelectionRequestOptions(undefined, undefined, "text")).resolves.toBeTruthy();
    await expect(mod.buildAiSelectionRequestOptions(undefined, undefined, "image")).rejects.toBeInstanceOf(
      mod.AiSelectionNotReadyError
    );
  });

  it("settings read fails + reset Text only -> Image REMAINS BLOCKED", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(settings(async () => { throw new Error("storage down"); })).catch(() => {});
    await mod.resetAiSelection(settings(async () => undefined), "text");
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("loaded");
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("read-error");
    await expect(mod.buildAiSelectionRequestOptions(undefined, undefined, "image")).rejects.toBeInstanceOf(
      mod.AiSelectionNotReadyError
    );
  });

  it("malformed stored TEXT explicit selection -> Text blocked (not default); Image still loads", async () => {
    const mod = await fresh();
    await mod
      .hydrateAiSelections(
        settings(async () => ({
          textAi: { mode: "user_selected", providerId: "" },
          imageAi: { mode: "server_default" },
        }))
      )
      .catch(() => {});
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("invalid-stored-intent");
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("loaded");
    await expect(mod.awaitAiSelectionReady("text")).rejects.toBeInstanceOf(mod.AiSelectionNotReadyError);
    await expect(mod.awaitAiSelectionReady("image")).resolves.toBeTruthy();
    await expect(mod.buildAiSelectionRequestOptions(undefined, undefined, "text")).rejects.toBeInstanceOf(
      mod.AiSelectionNotReadyError
    );
  });

  it("malformed stored IMAGE explicit selection -> Image blocked; Text still loads", async () => {
    const mod = await fresh();
    await mod
      .hydrateAiSelections(
        settings(async () => ({
          textAi: { mode: "server_default" },
          imageAi: { mode: "server_default", providerId: "gemini-image" },
        }))
      )
      .catch(() => {});
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("invalid-stored-intent");
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("loaded");
    await expect(mod.awaitAiSelectionReady("image")).rejects.toBeInstanceOf(mod.AiSelectionNotReadyError);
    await expect(mod.awaitAiSelectionReady("text")).resolves.toBeTruthy();
  });

  it("delayed hydration resolving AFTER a user save -> the user save wins (generation guard)", async () => {
    const mod = await fresh();
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const hydration = mod.hydrateAiSelections(settings(() => gate)).catch(() => {});
    // A deliberate save happens while hydration is still pending.
    await mod.saveAiSelection(settings(async () => undefined), "text", "user_selected", "gemini", "gemini-3.7-flash");
    // Now resolve the stale read with a DIFFERENT stored selection.
    release({
      textAi: { mode: "user_selected", providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
      imageAi: { mode: "server_default" },
    });
    await hydration;
    // The user save wins for text; the untouched image hydrates from storage.
    expect(mod.getCachedAiSelections().textAi).toEqual({
      mode: "user_selected",
      providerId: "gemini",
      modelId: "gemini-3.7-flash",
    });
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("loaded");
  });

  it("a NEW SettingsAdapter (app remount) does NOT reuse stale readiness and re-reads", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(
      settings(async () => ({
        textAi: { mode: "user_selected", providerId: "gemini", modelId: "gemini-3.7-flash" },
        imageAi: { mode: "server_default" },
      }))
    );
    expect(mod.isAiSelectionReady()).toBe(true);

    let reads = 0;
    const adapterB = settings(async () => {
      reads += 1;
      return { textAi: { mode: "server_default" }, imageAi: { mode: "server_default" } };
    });
    await mod.hydrateAiSelections(adapterB);
    expect(reads).toBe(1);
    expect(mod.isAiSelectionReady()).toBe(true);
    expect(mod.getCachedAiSelections().textAi).toEqual({ mode: "server_default" });
  });

  it("fresh reload preserves per-surface semantics (valid text + malformed image)", async () => {
    const mod = await fresh();
    await mod
      .hydrateAiSelections(
        settings(async () => ({
          textAi: { mode: "user_selected", providerId: "gemini", modelId: "gemini-3.7-flash" },
          imageAi: { mode: "user_selected", providerId: 42 },
        }))
      )
      .catch(() => {});
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("loaded");
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("invalid-stored-intent");
    expect(mod.getCachedAiSelections().textAi).toEqual({
      mode: "user_selected",
      providerId: "gemini",
      modelId: "gemini-3.7-flash",
    });
  });

  it("an explicit user save after a read error is authoritative for that surface only", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(settings(async () => { throw new Error("storage down"); })).catch(() => {});
    await mod.saveAiSelection(settings(async () => undefined), "text", "user_selected", "gemini", "gemini-3.7-flash");
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("loaded");
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("read-error");
  });

  it("settings read DELAYED -> request building is DEFERRED until resolved", async () => {
    const mod = await fresh();
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const hydration = mod.hydrateAiSelections(settings(() => gate));
    const pending = mod.buildAiSelectionRequestOptions(undefined, undefined, "text");
    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    release({
      textAi: { mode: "user_selected", providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
      imageAi: { mode: "server_default" },
    });
    await hydration;
    const options = await pending;
    expect(options.headers![mod.TEXT_SELECTION_HEADER]).toBe(
      JSON.stringify({ mode: "user_selected", providerId: "openrouter", modelId: "openai/gpt-4o-mini" })
    );
  });
});

describe("BYOK-4 — header building + persistence", () => {
  it("emits NO header for default selections (server_default is the absence of a header)", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(settings(async () => undefined));
    expect(mod.buildAiSelectionHeaders()).toEqual({});
  });

  it("builds only the requested surface's header", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(
      settings(async () => ({
        textAi: { mode: "user_selected", providerId: "gemini" },
        imageAi: { mode: "user_selected", providerId: "gemini-image" },
      }))
    );
    const text = await mod.buildAiSelectionRequestOptions();
    expect(text.headers![mod.TEXT_SELECTION_HEADER]).toBe(JSON.stringify({ mode: "user_selected", providerId: "gemini" }));
    expect(text.headers![mod.IMAGE_SELECTION_HEADER]).toBeUndefined();
    const image = await mod.buildAiSelectionRequestOptions(undefined, undefined, "image");
    expect(image.headers![mod.IMAGE_SELECTION_HEADER]).toBe(JSON.stringify({ mode: "user_selected", providerId: "gemini-image" }));
    expect(image.headers![mod.TEXT_SELECTION_HEADER]).toBeUndefined();
  });

  it("never serializes secrets into a header", async () => {
    const mod = await fresh();
    const headers = mod.buildAiSelectionHeaders({
      textAi: { mode: "user_selected", providerId: "gemini" },
      imageAi: { mode: "user_selected", providerId: "gemini-image", modelId: "gemini-2.5-flash-image" },
    });
    const serialized = JSON.stringify(headers);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("token");
  });

  it("buildAiSelectionRequestOptions merges headers into existing options without clobbering", async () => {
    const mod = await fresh();
    const options = await mod.buildAiSelectionRequestOptions(
      { headers: { "x-other": "1" } },
      { textAi: { mode: "user_selected", providerId: "gemini" }, imageAi: { mode: "server_default" } },
      "text"
    );
    expect(options.headers).toMatchObject({ "x-other": "1" });
    expect(options.headers![mod.TEXT_SELECTION_HEADER]).toBe(JSON.stringify({ mode: "user_selected", providerId: "gemini" }));
  });

  it("preserves existing options when there is no selection (no empty header object invented)", async () => {
    const mod = await fresh();
    const options = await mod.buildAiSelectionRequestOptions({ headers: { "x-other": "1" } }, mod.defaultAiSelections());
    expect(options).toEqual({ headers: { "x-other": "1" } });
  });

  it("saveAiSelection persists the requested preference and updates the cache", async () => {
    const mod = await fresh();
    let persisted: unknown;
    const next = await mod.saveAiSelection(settings(async () => undefined, async (_k, v) => { persisted = v; }), "text", "user_selected", "openrouter", "openai/gpt-4o-mini");
    expect(next.textAi).toEqual({ mode: "user_selected", providerId: "openrouter", modelId: "openai/gpt-4o-mini" });
    expect(persisted).toEqual({ textAi: next.textAi, imageAi: { mode: "server_default" } });
  });

  it("resetAiSelection clears a surface back to server_default and persists it", async () => {
    const mod = await fresh();
    await mod.saveAiSelection(settings(async () => undefined), "text", "user_selected", "gemini", "gemini-3.7-flash");
    let persisted: unknown;
    const next = await mod.resetAiSelection(settings(async () => undefined, async (_k, v) => { persisted = v; }), "text");
    expect(next.textAi).toEqual({ mode: "server_default" });
    expect(persisted).toEqual({ textAi: { mode: "server_default" }, imageAi: { mode: "server_default" } });
  });
});

describe("BYOK-5C — client credentialSource metadata (non-secret)", () => {
  it("carries credentialSource in the selection header (never a key)", async () => {
    const mod = await fresh();
    const headers = mod.buildAiSelectionHeaders({
      textAi: { mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" },
      imageAi: { mode: "server_default" },
    });
    expect(headers[mod.TEXT_SELECTION_HEADER]).toBe(
      JSON.stringify({ mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" })
    );
    expect(JSON.stringify(headers)).not.toContain("apiKey");
  });

  it("persists credentialSource with the non-secret preference", async () => {
    const mod = await fresh();
    let persisted: unknown;
    const next = await mod.saveAiSelection(
      settings(async () => undefined, async (_k, v) => { persisted = v; }),
      "text",
      "user_selected",
      "openrouter",
      "openai/gpt-4o-mini",
      "session_only"
    );
    expect(next.textAi).toEqual({
      mode: "user_selected",
      providerId: "openrouter",
      modelId: "openai/gpt-4o-mini",
      credentialSource: "session_only",
    });
    expect(persisted).toEqual({ textAi: next.textAi, imageAi: { mode: "server_default" } });
  });

  it("rejects a malformed stored credentialSource (fail closed, not default)", async () => {
    const mod = await fresh();
    expect(
      mod.parseStoredSelection({ mode: "user_selected", providerId: "openrouter", credentialSource: "bogus" })
    ).toEqual({ status: "invalid", selection: { mode: "server_default" } });
    expect(
      mod.parseStoredSelection({ mode: "server_default", credentialSource: "session_only" })
    ).toEqual({ status: "invalid", selection: { mode: "server_default" } });
  });

  it("preserves a valid stored credentialSource", async () => {
    const mod = await fresh();
    expect(
      mod.parseStoredSelection({ mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" })
    ).toEqual({
      status: "selected",
      selection: { mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" },
    });
  });
});

describe("BYOK-5C — malformed stored preference blocks the request", () => {
  it("malformed stored TEXT preference -> request blocked (no header, no network)", async () => {
    const mod = await fresh();
    await mod
      .hydrateAiSelections(
        settings(async () => ({
          textAi: { mode: "user_selected", providerId: "" }, // malformed present intent
          imageAi: { mode: "server_default" },
        }))
      )
      .catch(() => {});
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("invalid-stored-intent");
    // The request path refuses to build options -> no header, no network call.
    await expect(mod.buildAiSelectionRequestOptions(undefined, undefined, "text")).rejects.toBeInstanceOf(
      mod.AiSelectionNotReadyError
    );
    // The stored preference is NOT silently rewritten; the user must reset.
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("invalid-stored-intent");
  });

  it("malformed stored IMAGE preference -> image request blocked", async () => {
    const mod = await fresh();
    await mod
      .hydrateAiSelections(
        settings(async () => ({
          textAi: { mode: "server_default" },
          imageAi: { mode: "user_selected", providerId: 42 }, // malformed present intent
        }))
      )
      .catch(() => {});
    expect(mod.getAiSelectionSurfaceStatus("image")).toBe("invalid-stored-intent");
    await expect(mod.buildAiSelectionRequestOptions(undefined, undefined, "image")).rejects.toBeInstanceOf(
      mod.AiSelectionNotReadyError
    );
  });

  it("an explicit reset restores server_default behavior", async () => {
    const mod = await fresh();
    await mod
      .hydrateAiSelections(
        settings(async () => ({
          textAi: { mode: "user_selected", providerId: "" },
          imageAi: { mode: "server_default" },
        }))
      )
      .catch(() => {});
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("invalid-stored-intent");
    await mod.resetAiSelection(settings(async () => undefined), "text");
    expect(mod.getAiSelectionSurfaceStatus("text")).toBe("loaded");
    const options = await mod.buildAiSelectionRequestOptions(undefined, undefined, "text");
    // Intentional server_default -> no header, request allowed.
    expect(options.headers).toBeUndefined();
  });
});

describe("BYOK-5F — credential-source-aware selection validity", () => {
  function sessionCatalog(): AiSelectionCatalogSurface {
    return {
      sessionByokSupported: true,
      textProviders: [
        { providerId: "openrouter", models: [{ id: "openai/gpt-4o-mini" }], available: false, enabled: false, selectable: false, sessionKeySupported: true },
      ],
      imageProviders: [
        { providerId: "openrouter-image", models: [{ id: "google/gemini-2.5-flash-image" }], available: false, enabled: false, selectable: false, sessionKeySupported: true },
      ],
    };
  }

  it("C. session_only stays VALID when the operator environment credential is unavailable", async () => {
    const mod = await fresh();
    const cat = sessionCatalog();
    expect(
      mod.isSelectionValidAgainstCatalog(
        { mode: "user_selected", providerId: "openrouter", modelId: "openai/gpt-4o-mini", credentialSource: "session_only" },
        cat,
        "text"
      )
    ).toBe(true);
    // The SAME env-unavailable provider under server_environment stays INVALID.
    expect(
      mod.isSelectionValidAgainstCatalog(
        { mode: "user_selected", providerId: "openrouter", modelId: "openai/gpt-4o-mini", credentialSource: "server_environment" },
        cat,
        "text"
      )
    ).toBe(false);
    // Image parity.
    expect(
      mod.isSelectionValidAgainstCatalog(
        { mode: "user_selected", providerId: "openrouter-image", modelId: "google/gemini-2.5-flash-image", credentialSource: "session_only" },
        cat,
        "image"
      )
    ).toBe(true);
  });

  it("session_only is INVALID when the deployment does not support it or the provider is not session-capable", async () => {
    const mod = await fresh();
    const unsupported: AiSelectionCatalogSurface = {
      sessionByokSupported: false,
      textProviders: [{ providerId: "openrouter", models: [{ id: "m" }], sessionKeySupported: true }],
      imageProviders: [],
    };
    expect(
      mod.isSelectionValidAgainstCatalog({ mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" }, unsupported, "text")
    ).toBe(false);
    const notCapable: AiSelectionCatalogSurface = {
      sessionByokSupported: true,
      textProviders: [{ providerId: "ghost", models: [{ id: "m" }] }],
      imageProviders: [],
    };
    expect(
      mod.isSelectionValidAgainstCatalog({ mode: "user_selected", providerId: "ghost", credentialSource: "session_only" }, notCapable, "text")
    ).toBe(false);
    // Unknown/unregistered provider is never valid.
    expect(
      mod.isSelectionValidAgainstCatalog({ mode: "user_selected", providerId: "nope", credentialSource: "session_only" }, notCapable, "text")
    ).toBe(false);
    // A session-capable provider with NO curated models is not selectable.
    const noModels: AiSelectionCatalogSurface = {
      sessionByokSupported: true,
      textProviders: [{ providerId: "openrouter", models: [], sessionKeySupported: true }],
      imageProviders: [],
    };
    expect(
      mod.isSelectionValidAgainstCatalog({ mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" }, noModels, "text")
    ).toBe(false);
  });

  it("a provider-only session_only selection persists (no explicit model) instead of collapsing to default", async () => {
    const mod = await fresh();
    let persisted: unknown;
    const next = await mod.saveAiSelection(
      settings(async () => undefined, async (_k, v) => { persisted = v; }),
      "text",
      "user_selected",
      "openrouter",
      undefined,
      "session_only"
    );
    expect(next.textAi).toEqual({ mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" });
    expect(persisted).toEqual({ textAi: next.textAi, imageAi: { mode: "server_default" } });
  });

  it("Ask My Kitchen TEXT request construction carries the saved session_only metadata (no key)", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(
      settings(async () => ({
        textAi: { mode: "user_selected", providerId: "openrouter", modelId: "openai/gpt-4o-mini", credentialSource: "session_only" },
        imageAi: { mode: "server_default" },
      }))
    );
    const text = await mod.buildAiSelectionRequestOptions(undefined, undefined, "text");
    expect(text.headers![mod.TEXT_SELECTION_HEADER]).toBe(
      JSON.stringify({ mode: "user_selected", providerId: "openrouter", modelId: "openai/gpt-4o-mini", credentialSource: "session_only" })
    );
    expect(JSON.stringify(text.headers)).not.toContain("apiKey");
  });

  it("Ask My Kitchen IMAGE request construction carries the saved session_only metadata (no key)", async () => {
    const mod = await fresh();
    await mod.hydrateAiSelections(
      settings(async () => ({
        textAi: { mode: "server_default" },
        imageAi: { mode: "user_selected", providerId: "openrouter-image", credentialSource: "session_only" },
      }))
    );
    const image = await mod.buildAiSelectionRequestOptions(undefined, undefined, "image");
    expect(image.headers![mod.IMAGE_SELECTION_HEADER]).toBe(
      JSON.stringify({ mode: "user_selected", providerId: "openrouter-image", credentialSource: "session_only" })
    );
    expect(JSON.stringify(image.headers)).not.toContain("apiKey");
  });
});
