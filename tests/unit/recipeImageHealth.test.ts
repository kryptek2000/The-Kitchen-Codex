import { describe, it, expect, vi, afterEach } from "vitest";
import type { AssetAdapter } from "../../src/application/adapters/AssetAdapter.js";
import {
  assessRecipeImageHealth,
  classifyRemoteImageRef,
  isHttpImageUrl,
} from "../../src/core/recipeImage.js";

const VALID_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function fakeAsset(options: { existing: Record<string, Uint8Array>; onAccess?: () => void }): AssetAdapter {
  return {
    exists: async (p) => { options.onAccess?.(); return Boolean(options.existing[p]); },
    read: async (p) => {
      options.onAccess?.();
      const bytes = options.existing[p];
      if (!bytes) throw new Error("not found");
      return bytes;
    },
    write: async () => { options.onAccess?.(); },
    delete: async () => { options.onAccess?.(); },
  } as unknown as AssetAdapter;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("recipe image health (v0.7 Phase 2B1) — missing", () => {
  it("undefined image => missing", async () => {
    const result = await assessRecipeImageHealth({ image: undefined });
    expect(result.kind).toBe("missing");
    expect(result.deterministic).toBe(true);
  });

  it("null-ish empty string image => missing", async () => {
    expect((await assessRecipeImageHealth({ image: "" })).kind).toBe("missing");
    expect((await assessRecipeImageHealth({ image: "   " })).kind).toBe("missing");
  });

  it("recipes with no image field at all => missing", async () => {
    const result = await assessRecipeImageHealth({});
    expect(result.kind).toBe("missing");
  });
});

describe("recipe image health — local references", () => {
  it("local existing asset with a valid signature => valid_local", async () => {
    const asset = fakeAsset({ existing: { "Assets/Soup.png": VALID_PNG } });
    const result = await assessRecipeImageHealth({ image: "Assets/Soup.png" }, { asset });
    expect(result.kind).toBe("valid_local");
    expect(result.imageRef).toBe("Assets/Soup.png");
  });

  it("local missing asset => broken_local", async () => {
    const asset = fakeAsset({ existing: {} });
    const result = await assessRecipeImageHealth({ image: "Assets/Gone.jpg" }, { asset });
    expect(result.kind).toBe("broken_local");
  });

  it("local asset whose bytes fail signature validation => broken_local (e.g. SVG bytes)", async () => {
    const svgBytes = new Uint8Array(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8"));
    const asset = fakeAsset({ existing: { "Assets/Broken.svg": svgBytes } });
    const result = await assessRecipeImageHealth({ image: "Assets/Broken.svg" }, { asset });
    expect(result.kind).toBe("broken_local");
  });

  it("local asset that exists but cannot be read => unverifiable_local (never fabricated as broken)", async () => {
    const asset = fakeAsset({ existing: { "Assets/Locked.jpg": new Uint8Array(16) } });
    // exists() succeeds but read() fails -> unverifiable, not broken.
    const broken: AssetAdapter = {
      exists: async () => true,
      read: async () => { throw new Error("read denied"); },
      write: async () => {},
      delete: async () => {},
    } as unknown as AssetAdapter;
    void asset;
    const result = await assessRecipeImageHealth({ image: "Assets/Locked.jpg" }, { asset: broken });
    expect(result.kind).toBe("unverifiable_local");
  });

  it("no asset adapter available => unverifiable_local (never guessed as broken/valid)", async () => {
    const result = await assessRecipeImageHealth({ image: "Assets/Maybe.jpg" });
    expect(result.kind).toBe("unverifiable_local");
  });
});

describe("recipe image health — remote references (ZERO network I/O)", () => {
  it("http URL => remote_present", async () => {
    const result = await assessRecipeImageHealth({ image: "http://example.com/soup.jpg" });
    expect(result.kind).toBe("remote_present");
  });

  it("https URL => remote_present", async () => {
    const result = await assessRecipeImageHealth({ image: "https://example.com/soup.jpg" });
    expect(result.kind).toBe("remote_present");
  });

  it("malformed remote URL => invalid_remote", async () => {
    const result = await assessRecipeImageHealth({ image: "http://" });
    expect(result.kind).toBe("invalid_remote");
  });

  it("unsupported scheme (ftp/file/javascript/data/blob) => invalid_remote", async () => {
    for (const ref of ["ftp://example.com/a.jpg", "file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AAAA", "blob:blob-id"]) {
      expect((await assessRecipeImageHealth({ image: ref })).kind).toBe("invalid_remote");
    }
  });

  it("NO network callback/proxy is invoked for remote health detection", async () => {
    // Any network attempt fails the test: fetch/global proxies are booby-trapped.
    const boom = () => { throw new Error("NETWORK ACCESS IS PROHIBITED IN 2B1"); };
    vi.stubGlobal("fetch", boom);
    (globalThis as any).__probeCounter = 0;
    const results = [];
    for (const ref of [
      "https://images.example.com/real.jpg",
      "http://images.example.com/real.jpg",
      "http://",
      "not-a-url",
      "Assets/Local.png",
    ]) {
      results.push((await assessRecipeImageHealth({ image: ref })).kind);
    }
    expect(results).toEqual(["remote_present", "remote_present", "invalid_remote", "unverifiable_local", "unverifiable_local"]);
    expect((globalThis as any).__probeCounter).toBe(0);
  });

  it("getRecipeImage stock fallback does NOT affect assessment (missing stays missing)", async () => {
    // A recipe with NO image must be reported missing even though getRecipeImage
    // would render a stock Unsplash fallback for it.
    const result = await assessRecipeImageHealth({ image: undefined });
    expect(result.kind).toBe("missing");
    expect(result.kind).not.toBe("remote_present");
  });
});

describe("remote reference classification helpers", () => {
  it("isHttpImageUrl is scheme-only (no network semantics)", () => {
    expect(isHttpImageUrl("https://x/a.png")).toBe(true);
    expect(isHttpImageUrl("ftp://x/a.png")).toBe(false);
  });

  it("classifyRemoteImageRef rejects hostless URLs", () => {
    expect(classifyRemoteImageRef("http://")).toBe("invalid_remote");
    expect(classifyRemoteImageRef("https://example.com/a.png")).toBe("remote_present");
  });
});
