/**
 * The Kitchen Codex — Canonical Generated-Image Save tests (v0.7 Phase 2B).
 *
 * Platform-neutral fakes (no mocking framework), mirroring the established
 * adapter-test conventions (createForMeCollision/assetSaving/recipeImageHealth).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { VaultAdapter } from "../../src/application/adapters/VaultAdapter.js";
import type { AssetAdapter } from "../../src/application/adapters/AssetAdapter.js";
import {
  saveGeneratedRecipeImageToVault,
  hashCanonicalMarkdown,
  RecipeImageSaveConflictError,
  type RecipeImagePreviewRecord,
  type RecipeImagePreviewSource,
  type GeneratedImageSaveDeps,
} from "../../src/application/recipeImageSave.js";
import { resetGeneratedSaveLocks } from "../../src/application/createForMe.js";
import {
  serializeRecipeToObsidianMarkdown,
  parseObsidianRecipeMarkdown,
} from "../../src/utils/markdownParser.js";

const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const VALID_PNG_BYTES = new Uint8Array(Buffer.from(VALID_PNG_BASE64, "base64"));
const SESSION = "vault-session-abc123";
const RECIPE_PATH = "Test Soup.md";
const SENTINEL_PROMPT = "SUPER_SECRET_IMAGE_PROMPT_SENTINEL";

const INITIAL_MD = `---
title: Test Soup
cuisine: French
customField: preserved-value
---

# Test Soup

A warm bowl.
`;

/** Builds the canonical fixture Markdown with an optional current image field. */
function mdWithImage(imageRef?: string): string {
  const imageLine = imageRef ? `image: ${imageRef}\n` : "";
  return `---
title: Test Soup
cuisine: French
${imageLine}customField: preserved-value
---

# Test Soup

A warm bowl.
`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Polls until cond() holds (bounded) — the save flow spans several async hops. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Fixture {
  vault: VaultAdapter;
  asset: AssetAdapter;
  events: string[];
  files: Map<string, string>;
  assets: Map<string, Uint8Array>;
  assetWriteGate?: { promise: Promise<void>; resolve: () => void };
  vaultWriteGate?: { promise: Promise<void>; resolve: () => void };
}

function makeFixture(options: { markdown?: string; assets?: Record<string, Uint8Array>; gateAssetWrite?: boolean; gateVaultWrite?: boolean } = {}): Fixture {
  const files = new Map<string, string>([[RECIPE_PATH, options.markdown ?? INITIAL_MD]]);
  const assets = new Map<string, Uint8Array>(Object.entries(options.assets ?? {}));
  const events: string[] = [];
  const assetWriteGate = options.gateAssetWrite ? deferred() : undefined;
  const vaultWriteGate = options.gateVaultWrite ? deferred() : undefined;

  const vault: VaultAdapter = {
    listMarkdownFiles: async () => Array.from(files.keys()).map((path) => ({ path, name: path })),
    readText: async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as string;
    },
    writeText: async (p: string, c: string) => {
      events.push(`vault:write:${p}`);
      if (vaultWriteGate) await vaultWriteGate.promise;
      files.set(p, c);
    },
    delete: async () => {},
    exists: async (p: string) => files.has(p),
  } as unknown as VaultAdapter;

  const asset: AssetAdapter = {
    read: async (p: string) => {
      if (!assets.has(p)) throw new Error(`ENOENT: ${p}`);
      return assets.get(p) as Uint8Array;
    },
    write: async (p: string, data: Uint8Array) => {
      events.push(`asset:write:${p}`);
      if (assetWriteGate) await assetWriteGate.promise;
      assets.set(p, new Uint8Array(data));
    },
    exists: async (p: string) => assets.has(p),
    delete: async (p: string) => {
      events.push(`asset:delete:${p}`);
      if (!assets.has(p)) throw new Error(`ENOENT: ${p}`);
      assets.delete(p);
    },
  } as unknown as AssetAdapter;

  return { vault, asset, events, files, assets, assetWriteGate, vaultWriteGate };
}

function fakePreviewSource(records: Record<string, RecipeImagePreviewRecord | undefined>): { source: RecipeImagePreviewSource; invalidated: string[] } {
  const invalidated: string[] = [];
  return {
    invalidated,
    source: {
      resolvePreview: async (token: string) => records[token],
      invalidatePreview: async (token: string) => { invalidated.push(token); },
    },
  };
}

function previewRecord(hash: string, token = "tok-1"): RecipeImagePreviewRecord {
  return {
    token,
    bytes: VALID_PNG_BYTES,
    contentType: "image/png",
    provider: "gemini-image",
    model: "gemini-2.5-flash-image",
    recipeContentHash: hash,
    vaultSessionId: SESSION,
  };
}

async function makeDeps(fixture: Fixture, records: Record<string, RecipeImagePreviewRecord | undefined>, now?: () => Date): Promise<GeneratedImageSaveDeps> {
  const { source } = fakePreviewSource(records);
  return { vault: fixture.vault, asset: fixture.asset, previewSource: source, ...(now ? { now } : {}) };
}

function saveInput(overrides: Record<string, unknown> = {}) {
  return {
    recipePath: RECIPE_PATH,
    recipeTitle: "Test Soup",
    token: "tok-1",
    activeVaultSessionId: SESSION,
    approved: true,
    ...overrides,
  } as Parameters<typeof saveGeneratedRecipeImageToVault>[1];
}

afterEach(() => {
  resetGeneratedSaveLocks();
  vi.restoreAllMocks();
});

describe("hashCanonicalMarkdown", () => {
  it("computes the SHA-256 of the FULL canonical Markdown text (known vector)", async () => {
    // sha256("abc")
    expect(await hashCanonicalMarkdown("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("changes when ANY part of the canonical Markdown changes (full-text, not selected fields)", async () => {
    const base = await hashCanonicalMarkdown(INITIAL_MD);
    const tweaked = INITIAL_MD.replace("A warm bowl.", "A warm bowl!");
    expect(await hashCanonicalMarkdown(tweaked)).not.toBe(base);
  });
});

describe("saveGeneratedRecipeImageToVault — canonical save (v0.7 2B)", () => {
  it("successful save writes the asset THEN the Markdown, returns the chosen path (no optimistic state)", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(hash) }, () => new Date("2026-09-09T12:00:00.000Z"));

    const result = await saveGeneratedRecipeImageToVault(deps, saveInput());

    // Ordering: asset write strictly before Markdown write.
    expect(fixture.events).toEqual(["asset:write:Assets/Test Soup.png", `vault:write:${RECIPE_PATH}`]);
    expect(result.imagePath).toBe("Assets/Test Soup.png");
    expect(result.provider).toBe("gemini-image");
    expect(result.model).toBe("gemini-2.5-flash-image");
    expect(result.generatedAt).toBe("2026-09-09T12:00:00.000Z");
    expect(fixture.assets.get("Assets/Test Soup.png")).toEqual(VALID_PNG_BYTES);
    expect(fixture.files.get(RECIPE_PATH)).toContain("image: Assets/Test Soup.png");
  });

  it("writes the canonical image field + provenance; reparse of the saved file agrees", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(hash) });

    await saveGeneratedRecipeImageToVault(deps, saveInput());

    const saved = fixture.files.get(RECIPE_PATH) as string;
    const reparsed = parseObsidianRecipeMarkdown(saved, RECIPE_PATH, RECIPE_PATH);
    expect(reparsed.image).toBe("Assets/Test Soup.png");
    const prov = reparsed.frontmatter?.codex_generated_image;
    expect(prov).toMatchObject({
      generated: true,
      provider: "gemini-image",
      model: "gemini-2.5-flash-image",
    });
    expect(String(prov.generated_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Provenance survives a full serialize round-trip (canonical boundary).
    const twice = serializeRecipeToObsidianMarkdown(reparsed);
    const twiceParsed = parseObsidianRecipeMarkdown(twice, RECIPE_PATH, RECIPE_PATH);
    expect(twiceParsed.frontmatter?.codex_generated_image).toEqual(prov);
  });

  it("preserves unknown/custom frontmatter and never persists the raw prompt", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(hash) });

    await saveGeneratedRecipeImageToVault(deps, saveInput());

    const saved = fixture.files.get(RECIPE_PATH) as string;
    expect(saved).toContain("customField: preserved-value");
    expect(saved).toContain("cuisine: French");
    expect(saved).not.toContain(SENTINEL_PROMPT);
    expect(saved.toLowerCase()).not.toContain("prompt:");
    // The in-memory recipe object given to the flow is never mutated into state.
    // (The flow is pure: nothing but vault/asset writes happen.)
  });

  it("rejects when the preview token is no longer valid (expired/unknown)", async () => {
    const fixture = makeFixture();
    const deps = await makeDeps(fixture, { "tok-1": undefined });
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput())).rejects.toMatchObject({
      reason: "PREVIEW_UNAVAILABLE",
      name: "RecipeImageSaveConflictError",
    });
    expect(fixture.events).toEqual([]);
    expect(fixture.files.get(RECIPE_PATH)).toBe(INITIAL_MD);
  });

  it("rejects invalid/mismatched preview bytes before any write (revalidation at save boundary)", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    const bad = { ...previewRecord(hash), bytes: new Uint8Array(Buffer.from("<svg></svg>")), contentType: "image/svg+xml" };
    const deps = await makeDeps(fixture, { "tok-1": bad });
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput())).rejects.toMatchObject({ reason: "PREVIEW_INVALID" });
    expect(fixture.events).toEqual([]);
  });

  it("rejects without approval, vault-session mismatch, or missing session (vault changed)", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    const deps = await makeDeps(fixture, {
      "tok-1": previewRecord(hash),
      "tok-other-session": { ...previewRecord(hash), vaultSessionId: "vault-session-OTHER" },
    });

    await expect(saveGeneratedRecipeImageToVault(deps, saveInput({ approved: false }))).rejects.toMatchObject({ reason: "NOT_APPROVED" });
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput({ activeVaultSessionId: "vault-session-OTHER", token: "tok-1" }))).rejects.toMatchObject({ reason: "VAULT_CHANGED" });
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput({ activeVaultSessionId: "", token: "tok-1" }))).rejects.toMatchObject({ reason: "VAULT_CHANGED" });
    // A preview captured under a different session cannot be saved into this one.
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput({ token: "tok-other-session" }))).rejects.toMatchObject({ reason: "VAULT_CHANGED" });
    expect(fixture.events).toEqual([]);
    expect(fixture.files.get(RECIPE_PATH)).toBe(INITIAL_MD);
  });

  it("rejects on recipe hash mismatch (recipe changed since preview) — no canonical change", async () => {
    const fixture = makeFixture();
    const staleHash = await hashCanonicalMarkdown("STALE CONTENT");
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(staleHash) });
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput())).rejects.toMatchObject({ reason: "RECIPE_CHANGED" });
    expect(fixture.events).toEqual([]);
    expect(fixture.files.get(RECIPE_PATH)).toBe(INITIAL_MD);
  });

  it("rejects when a VALID image exists (never silently replaces); broken local image is repairable and the old asset file is never deleted", async () => {
    const existingGoodPath = "Assets/Existing Good.png";
    const brokenPath = "Assets/Old Broken.jpg";
    const validMd = mdWithImage(existingGoodPath);
    const brokenMd = mdWithImage(brokenPath);
    const hashValid = await hashCanonicalMarkdown(validMd);
    const hashBroken = await hashCanonicalMarkdown(brokenMd);

    // Valid local image -> reject.
    const fx1 = makeFixture({ markdown: validMd, assets: { [existingGoodPath]: VALID_PNG_BYTES } });
    const deps1 = await makeDeps(fx1, { "tok-1": previewRecord(hashValid) });
    await expect(saveGeneratedRecipeImageToVault(deps1, saveInput())).rejects.toMatchObject({ reason: "IMAGE_ALREADY_PRESENT" });
    expect(fx1.events).toEqual([]);

    // Remote reference -> reject (no probing, never silently replaced).
    const remoteMd = mdWithImage("https://example.com/soup.jpg");
    const fx2 = makeFixture({ markdown: remoteMd });
    const deps2 = await makeDeps(fx2, { "tok-1": previewRecord(await hashCanonicalMarkdown(remoteMd)) });
    await expect(saveGeneratedRecipeImageToVault(deps2, saveInput())).rejects.toMatchObject({ reason: "IMAGE_ALREADY_PRESENT" });
    expect(fx2.events).toEqual([]);

    // Broken local asset -> repairable: image field replaced, old broken FILE untouched.
    const oldBrokenBytes = new Uint8Array(Buffer.from("this is not an image", "utf8"));
    const fx3 = makeFixture({ markdown: brokenMd, assets: { [brokenPath]: oldBrokenBytes } });
    const deps3 = await makeDeps(fx3, { "tok-1": previewRecord(hashBroken) });
    const result = await saveGeneratedRecipeImageToVault(deps3, saveInput());
    expect(result.imagePath).toBe("Assets/Test Soup.png");
    const saved = parseObsidianRecipeMarkdown(fx3.files.get(RECIPE_PATH) as string, RECIPE_PATH, RECIPE_PATH);
    expect(saved.image).toBe("Assets/Test Soup.png");
    expect(fx3.assets.has(brokenPath)).toBe(true); // old asset NOT auto-deleted
    expect(fx3.assets.get(brokenPath)).toEqual(oldBrokenBytes);
    expect(fx3.events).not.toContain(`asset:delete:${brokenPath}`);
  });

  it("collision policy: chooses (1) then (2) deterministically and NEVER overwrites an existing asset", async () => {
    const first = makeFixture({ assets: { "Assets/Test Soup.png": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) } });
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    const deps1 = await makeDeps(first, { "tok-1": previewRecord(hash) });
    const r1 = await saveGeneratedRecipeImageToVault(deps1, saveInput());
    expect(r1.imagePath).toBe("Assets/Test Soup (1).png");
    // Pre-existing file byte-identical (never overwritten).
    expect(first.assets.get("Assets/Test Soup.png")).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));

    const second = makeFixture({
      assets: {
        "Assets/Test Soup.png": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
        "Assets/Test Soup (1).png": new Uint8Array([2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
      },
    });
    const deps2 = await makeDeps(second, { "tok-1": previewRecord(hash) });
    const r2 = await saveGeneratedRecipeImageToVault(deps2, saveInput());
    expect(r2.imagePath).toBe("Assets/Test Soup (2).png");
    expect(second.events.filter((e) => e.startsWith("asset:write"))).toEqual(["asset:write:Assets/Test Soup (2).png"]);
  });

  it("same-recipe concurrent saves serialize on the per-recipe path lock (no interleaved/overwritten writes)", async () => {
    const fixture = makeFixture({ gateAssetWrite: true });
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(hash), "tok-2": previewRecord(hash, "tok-2") });

    // Deterministic lock-order setup: start save #1 and wait until it OWNS the
    // per-recipe lock at its gated asset write, THEN start save #2. Both saves
    // still overlap (save #2 starts while #1 is mid-write), but the lock owner is
    // no longer decided by nondeterministic WebCrypto/pre-lock scheduling order.
    const p1 = saveGeneratedRecipeImageToVault(deps, saveInput({ token: "tok-1" }));
    await until(() => fixture.events.some((e) => e.startsWith("asset:write")));

    // While save #1 holds the lock at its gated asset write, save #2 must NOT
    // have started any write (serialized, not racing).
    const p2 = saveGeneratedRecipeImageToVault(deps, saveInput({ token: "tok-2" }));
    await new Promise((r) => setTimeout(r, 25));
    expect(fixture.events.filter((e) => e.startsWith("asset:write"))).toEqual(["asset:write:Assets/Test Soup.png"]);
    expect(fixture.events.filter((e) => e.startsWith("vault:write"))).toEqual([]);

    fixture.assetWriteGate?.resolve();
    const r1 = await p1;
    expect(r1.imagePath).toBe("Assets/Test Soup.png");
    // Save #2 re-validates INSIDE the lock: the recipe changed under it (hash now
    // differs from its preview) -> clean RECIPE_CHANGED rejection, zero writes.
    await expect(p2).rejects.toMatchObject({ reason: "RECIPE_CHANGED" });
    expect(fixture.events.filter((e) => e.startsWith("asset:write"))).toEqual(["asset:write:Assets/Test Soup.png"]);
    expect(fixture.assets.has("Assets/Test Soup (1).png")).toBe(false);
  });

  it("different recipes proceed concurrently (no global lock)", async () => {
    const fixture = makeFixture({ gateAssetWrite: true });
    const secondPath = "Other Dish.md";
    fixture.files.set(secondPath, INITIAL_MD.replace(/Test Soup/g, "Other Dish"));
    const hashA = await hashCanonicalMarkdown(INITIAL_MD);
    const hashB = await hashCanonicalMarkdown(fixture.files.get(secondPath) as string);
    const deps = await makeDeps(fixture, {
      "tok-1": previewRecord(hashA),
      "tok-2": { ...previewRecord(hashB, "tok-2") },
    });

    const pA = saveGeneratedRecipeImageToVault(deps, saveInput({ token: "tok-1", recipeTitle: "Test Soup" }));
    const pB = saveGeneratedRecipeImageToVault(deps, saveInput({ token: "tok-2", recipePath: secondPath, recipeTitle: "Other Dish" }));
    // BOTH asset writes are in-flight simultaneously => no global serialization.
    await until(() => fixture.events.filter((e) => e.startsWith("asset:write")).length === 2);
    fixture.assetWriteGate?.resolve();
    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA.imagePath).toBe("Assets/Test Soup.png");
    expect(rB.imagePath).toBe("Assets/Other Dish.png");
  });

  it("asset write failure leaves the Markdown unchanged", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    fixture.asset.write = async () => { throw new Error("disk full"); };
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(hash) });
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput())).rejects.toThrow("disk full");
    expect(fixture.files.get(RECIPE_PATH)).toBe(INITIAL_MD);
    expect(fixture.assets.has("Assets/Test Soup.png")).toBe(false);
  });

  it("Markdown write failure triggers best-effort delete of the NEW asset and rethrows the PRIMARY error", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    fixture.vault.writeText = async () => { throw new Error("markdown write failed"); };
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(hash) });
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput())).rejects.toThrow("markdown write failed");
    expect(fixture.events).toContain("asset:delete:Assets/Test Soup.png");
    expect(fixture.assets.has("Assets/Test Soup.png")).toBe(false);
    // Canonical state untouched.
    expect(fixture.files.get(RECIPE_PATH)).toBe(INITIAL_MD);
  });

  it("cleanup failure never replaces the primary Markdown error (safe log only)", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    fixture.vault.writeText = async () => { throw new Error("primary markdown failure"); };
    fixture.asset.delete = async () => { throw new Error("cleanup exploded"); };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(hash) });
    await expect(saveGeneratedRecipeImageToVault(deps, saveInput())).rejects.toThrow("primary markdown failure");
    expect(warnSpy).toHaveBeenCalled();
    for (const spy of [warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL_PROMPT);
      }
    }
  });

  it("successful save invalidates the preview token; failed/conflicted saves do not (retry until TTL)", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown(INITIAL_MD);
    const { source, invalidated } = fakePreviewSource({ "tok-1": previewRecord(hash) });
    const deps: GeneratedImageSaveDeps = { vault: fixture.vault, asset: fixture.asset, previewSource: source };

    await saveGeneratedRecipeImageToVault(deps, saveInput());
    expect(invalidated).toEqual(["tok-1"]);

    // Conflict path: no invalidation (token stays usable until TTL for retry).
    const fx2 = makeFixture();
    const staleHash = await hashCanonicalMarkdown("STALE");
    const rec2 = fakePreviewSource({ "tok-1": previewRecord(staleHash) });
    const deps2: GeneratedImageSaveDeps = { vault: fx2.vault, asset: fx2.asset, previewSource: rec2.source };
    await expect(saveGeneratedRecipeImageToVault(deps2, saveInput())).rejects.toBeInstanceOf(RecipeImageSaveConflictError);
    expect(rec2.invalidated).toEqual([]);
  });

  it("conflict errors carry no prompt/secret material", async () => {
    const fixture = makeFixture();
    const hash = await hashCanonicalMarkdown("STALE");
    const deps = await makeDeps(fixture, { "tok-1": previewRecord(hash) });
    const err = await saveGeneratedRecipeImageToVault(deps, saveInput()).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain(SENTINEL_PROMPT);
    expect(JSON.stringify(err)).not.toContain(VALID_PNG_BASE64.slice(0, 24));
  });
});
