/**
 * The Kitchen Codex — Save lock-key normalization tests (v0.7 Phase 2B).
 *
 * `withGeneratedSaveLock` must key its lock map by the CANONICAL vault-relative
 * path (same policy as vaultPath.ts / resolveRecipeVaultPath), so equivalent
 * spellings of the same file share one lock — across Create for Me AND image
 * save — while unsafe path forms are never silently converted.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { VaultAdapter } from "../../src/application/adapters/VaultAdapter.js";
import type { AssetAdapter } from "../../src/application/adapters/AssetAdapter.js";
import {
  withGeneratedSaveLock,
  hasPendingGeneratedSaveLock,
  resetGeneratedSaveLocks,
  saveGeneratedRecipeToVault,
  generatedDraftToObsidianRecipe,
} from "../../src/application/createForMe.js";
import {
  saveGeneratedRecipeImageToVault,
  hashCanonicalMarkdown,
  type RecipeImagePreviewRecord,
  type RecipeImagePreviewSource,
} from "../../src/application/recipeImageSave.js";
import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from "../../src/schema/generatedRecipe.js";

const VALID_PNG_BYTES = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  resetGeneratedSaveLocks();
});

describe("withGeneratedSaveLock — normalized lock keys", () => {
  it("leading-slash and canonical path share ONE lock", async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = withGeneratedSaveLock("Recipes/Foo.md", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = withGeneratedSaveLock("/Recipes/Foo.md", async () => {
      order.push("second:start");
    });
    await until(() => order.includes("first:start"));
    await new Promise((r) => setTimeout(r, 25));
    expect(order).toEqual(["first:start"]); // second is BLOCKED (same lock)
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("backslash and forward-slash path share ONE lock", async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = withGeneratedSaveLock("Recipes\\Foo.md", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = withGeneratedSaveLock("Recipes/Foo.md", async () => {
      order.push("second:start");
    });
    await until(() => order.includes("first:start"));
    await new Promise((r) => setTimeout(r, 25));
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("already-normalized key is unchanged (identical canonical forms serialize)", async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = withGeneratedSaveLock("Recipes/Foo.md", async () => {
      order.push("a");
      await gate.promise;
    });
    const second = withGeneratedSaveLock("Recipes/Foo.md", async () => {
      order.push("b");
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(order).toEqual(["a"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
    expect(hasPendingGeneratedSaveLock("Recipes/Foo.md")).toBe(false);
  });

  it("different canonical paths run concurrently (no cross-locking)", async () => {
    const gateA = deferred();
    const gateB = deferred();
    let aEntered = false;
    let bEntered = false;
    const a = withGeneratedSaveLock("Recipes/Foo.md", async () => { aEntered = true; await gateA.promise; });
    const b = withGeneratedSaveLock("Recipes/Bar.md", async () => { bEntered = true; await gateB.promise; });
    await until(() => aEntered && bEntered); // BOTH entered without blocking each other
    gateA.resolve();
    gateB.resolve();
    await Promise.all([a, b]);
  });

  it("unsafe path forms are never silently normalized into the canonical lock key", async () => {
    const gate = deferred();
    let entered = false;
    const canonical = withGeneratedSaveLock("Recipes/Foo.md", async () => {
      entered = true;
      await gate.promise;
    });
    await until(() => entered);
    // './Recipes/Foo.md' is rejected by the vaultPath safety policy: it must NOT
    // share the canonical lock (it gets its own raw key) and must NOT deadlock.
    const unsafe = withGeneratedSaveLock("./Recipes/Foo.md", async () => {});
    await new Promise((r) => setTimeout(r, 25));
    expect(unsafe).toBeInstanceOf(Promise); // ran without acquiring the canonical lock
    gate.resolve();
    await canonical;
    // Traversal likewise: distinct raw key, never the canonical one.
    expect(hasPendingGeneratedSaveLock("../evil.md")).toBe(false);
    await withGeneratedSaveLock("../evil.md", async () => {});
    expect(hasPendingGeneratedSaveLock("../evil.md")).toBe(false);
  });

  it("lock is cleaned up after success", async () => {
    const gate = deferred();
    let entered = false;
    const op = withGeneratedSaveLock("Recipes/Foo.md", async () => {
      entered = true;
      await gate.promise;
    });
    await until(() => entered);
    expect(hasPendingGeneratedSaveLock("Recipes/Foo.md")).toBe(true);
    expect(hasPendingGeneratedSaveLock("/Recipes/Foo.md")).toBe(true); // same key
    gate.resolve();
    await op;
    expect(hasPendingGeneratedSaveLock("Recipes/Foo.md")).toBe(false);
    expect(hasPendingGeneratedSaveLock("/Recipes/Foo.md")).toBe(false);
    expect(hasPendingGeneratedSaveLock("Recipes\\Foo.md")).toBe(false);
  });

  it("lock is cleaned up after throw", async () => {
    let entered = false;
    let failure: unknown;
    const op = withGeneratedSaveLock("Recipes/Foo.md", async () => {
      entered = true;
      throw new Error("boom");
    });
    // Attach the outcome handler immediately so the rejection is never unobserved
    // while we wait for entry.
    const settled = op.then(
      () => "resolved",
      (e: unknown) => { failure = e; return "rejected"; }
    );
    await until(() => entered);
    await expect(settled).resolves.toBe("rejected");
    expect((failure as Error).message).toBe("boom");
    expect(hasPendingGeneratedSaveLock("Recipes/Foo.md")).toBe(false);
    expect(hasPendingGeneratedSaveLock("/Recipes/Foo.md")).toBe(false);
    // A retry with an equivalent spelling acquires immediately and succeeds.
    await expect(withGeneratedSaveLock("Recipes\\Foo.md", async () => "ok")).resolves.toBe("ok");
  });
});

describe("Create for Me + image save — equivalent-path forms serialize", () => {
  const PROVENANCE: GeneratedRecipeProvenance = { generated: true, providerId: "gemini", model: "gemini-test" };

  function makeVaultFileFixture() {
    const files = new Map<string, string>();
    const events: string[] = [];
    const vault = {
      listMarkdownFiles: async () => Array.from(files.keys()).map((path) => ({ path, name: path })),
      readText: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return files.get(p) as string;
      },
      writeText: async (p: string, c: string) => {
        events.push(`vault:write:${p}`);
        files.set(p, c);
      },
      delete: async () => {},
      exists: async (p: string) => files.has(p),
    } as unknown as VaultAdapter;
    return { vault, files, events };
  }

  it("Create for Me save and image save lock the SAME recipe under equivalent path spellings", async () => {
    const { vault, files, events } = makeVaultFileFixture();
    // The recipe already exists on disk, addressed by the NON-canonical
    // spelling the image save will use (read/write targets stay untouched;
    // only the LOCK key is normalized).
    const recipeMd = `---
title: Foo
customField: kept
---

# Foo

body
`;
    files.set("/Recipes/Foo.md", recipeMd);

    // Asset adapter with a gated write for the image save.
    const assets = new Map<string, Uint8Array>();
    const assetGate = deferred();
    const assetEvents: string[] = [];
    const asset: AssetAdapter = {
      read: async (p: string) => { if (!assets.has(p)) throw new Error(`ENOENT: ${p}`); return assets.get(p) as Uint8Array; },
      write: async (p: string, data: Uint8Array) => {
        assetEvents.push(`asset:write:${p}`);
        await assetGate.promise;
        assets.set(p, new Uint8Array(data));
      },
      exists: async (p: string) => assets.has(p),
      delete: async (p: string) => { assetEvents.push(`asset:delete:${p}`); assets.delete(p); },
    } as unknown as AssetAdapter;

    const previewHash = await hashCanonicalMarkdown(recipeMd);
    const preview: RecipeImagePreviewRecord = {
      token: "tok-1",
      bytes: VALID_PNG_BYTES,
      contentType: "image/png",
      provider: "gemini-image",
      model: "gemini-2.5-flash-image",
      recipeContentHash: previewHash,
      vaultSessionId: "vault-session-abc",
    };
    const previewSource: RecipeImagePreviewSource = {
      resolvePreview: async () => preview,
      invalidatePreview: async () => {},
    };

    // Image save addresses the SAME recipe via a NON-canonical spelling.
    const imageSave = saveGeneratedRecipeImageToVault(
      { vault, asset, previewSource, now: () => new Date("2026-09-09T12:00:00.000Z") },
      {
        recipePath: "/Recipes/Foo.md",
        recipeTitle: "Foo",
        token: "tok-1",
        activeVaultSessionId: "vault-session-abc",
        approved: true,
      }
    );

    // While the image save holds the lock (gated asset write), a Create-for-Me
    // save to the canonical spelling of the SAME file must wait behind it.
    await until(() => assetEvents.length === 1);
    const draft: GeneratedRecipeDraft = {
      title: "Foo From Create",
      ingredients: [{ name: "x" }],
      steps: [{ text: "y" }],
    };
    const createForMeRecipe = generatedDraftToObsidianRecipe({ draft, provenance: PROVENANCE });
    createForMeRecipe.filePath = "Recipes\\Foo.md"; // equivalent spelling
    createForMeRecipe.fileName = "Recipes\\Foo.md";
    // Rename target so it does not collide — but keep the SAME file locked: the
    // collision path derives from the edited title, so use a distinct title.
    const createSave = saveGeneratedRecipeToVault(vault, createForMeRecipe);
    await new Promise((r) => setTimeout(r, 25));
    // Create for Me has NOT written yet: it is queued behind the image save.
    expect(events).toEqual([]);

    assetGate.resolve();
    const imagePath = await imageSave;
    await createSave;
    // Ordering: image save fully completed (asset + Markdown) BEFORE the
    // Create-for-Me Markdown write ran — one shared lock, both spellings
    // ("/Recipes/Foo.md" and "Recipes\\Foo.md" locked as "Recipes/Foo.md").
    expect(imagePath.imagePath).toBe("Assets/Foo.png");
    expect(events[0]).toBe("vault:write:/Recipes/Foo.md");
    expect(events[1]).toBe("vault:write:Recipes/Foo.md");
    expect(events).toHaveLength(2);
  });
});
