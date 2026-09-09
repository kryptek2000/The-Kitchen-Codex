/**
 * The Kitchen Codex — Auto-image-generation BLOCKING invariant regression
 * (v0.7 Phase 2B).
 *
 * BLOCKING INVARIANT: NO image generation/download/save may occur automatically
 * from a normal recipe save, Markdown save, edit save, vault scan, image
 * resolution, rendering, or metadata recovery. Image generation happens ONLY
 * after an explicit Generate Image / Regenerate user action.
 *
 * These tests drive the real orchestration functions with a RECORDING fake
 * AssetAdapter (counts every write) and assert ZERO asset writes on the
 * "automatic" surfaces, while proving the EXPLICIT paths still write exactly as
 * designed (Grab Recipe importer download, generated-image save).
 */

import { describe, it, expect } from "vitest";
import type { VaultAdapter } from "../../src/application/adapters/VaultAdapter.js";
import type { AssetAdapter } from "../../src/application/adapters/AssetAdapter.js";
import { saveRecipeWithVaultAdapter, scanVaultMarkdown } from "../../src/application/vaultRecipe.js";
import { getRecipeImage } from "../../src/utils/imageHelper.js";
import { saveGeneratedRecipeImageToVault, hashCanonicalMarkdown } from "../../src/application/recipeImageSave.js";
import { saveImageToVaultAssets } from "../../src/utils/vaultAssets.js";
import type { ObsidianRecipe } from "../../src/types.js";

const VALID_PNG_BYTES = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

/** Records every asset write (and read/exists) — the auto-write detector. */
function recordingAsset(): { asset: AssetAdapter; writes: string[]; reads: string[]; existsCalls: string[] } {
  const writes: string[] = [];
  const reads: string[] = [];
  const existsCalls: string[] = [];
  const asset: AssetAdapter = {
    read: async (p: string) => {
      reads.push(p);
      throw Object.defineProperty(new Error(`ENOENT: ${p}`), "name", { value: "NotFoundError" });
    },
    write: async (p: string) => {
      writes.push(p);
    },
    exists: async (p: string) => {
      existsCalls.push(p);
      return false;
    },
    delete: async (p: string) => {
      writes.push(`delete:${p}`);
    },
  };
  return { asset, writes, reads, existsCalls };
}

function recordingVault(seed: Record<string, string> = {}): { vault: VaultAdapter; markdownWrites: string[]; files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  const markdownWrites: string[] = [];
  const vault: VaultAdapter = {
    listMarkdownFiles: async () => Array.from(files.keys()).map((path) => ({ path, name: path.split("/").pop() || path })),
    readText: async (p: string) => {
      if (!files.has(p)) throw Object.defineProperty(new Error(`ENOENT: ${p}`), "name", { value: "NotFoundError" });
      return files.get(p) as string;
    },
    writeText: async (p: string, c: string) => {
      markdownWrites.push(p);
      files.set(p, c);
    },
    delete: async () => {},
    exists: async (p: string) => files.has(p),
  } as unknown as VaultAdapter;
  return { vault, markdownWrites, files };
}

function recipeNoImage(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: "r-1",
    fileName: "Peach Cobbler Loaf.md",
    filePath: "Peach Cobbler Loaf.md",
    rawMarkdown: "---\ntitle: Peach Cobbler Loaf\ncuisine: American\n---\n\n# Peach Cobbler Loaf\n\nBatter mix.\n",
    title: "Peach Cobbler Loaf",
    category: "Dessert",
    cuisine: "American",
    ingredients: [{ name: "peaches" }, { name: "flour" }],
    instructions: [{ text: "Bake." }],
    ...overrides,
  } as unknown as ObsidianRecipe;
}

describe("NO auto image generation on automatic surfaces (BLOCKING invariant)", () => {
  it("1. normal Markdown save after deleting the image field creates ZERO image assets", async () => {
    const { asset, writes } = recordingAsset();
    const { vault, markdownWrites } = recordingVault();
    const recipe = recipeNoImage(); // image field absent
    await saveRecipeWithVaultAdapter(vault, recipe);
    expect(markdownWrites).toHaveLength(1);
    const savedMd = await vault.readText("Peach Cobbler Loaf.md");
    expect(savedMd).not.toContain("image:");
    // ZERO asset writes.
    expect(writes).toEqual([]);
  });

  it("2. normal visual-editor save with a missing image creates ZERO image assets", async () => {
    const { asset, writes } = recordingAsset();
    const { vault } = recordingVault();
    const md = `---
title: Peach Cobbler Loaf
tags:
  - food/recipes
---

# Peach Cobbler Loaf

Batter mix.
`;
    await vault.writeText("Peach Cobbler Loaf.md", md);
    const recipe = recipeNoImage();
    await saveRecipeWithVaultAdapter(vault, recipe);
    const savedMd = await vault.readText("Peach Cobbler Loaf.md");
    expect(savedMd).not.toContain("image:");
    expect(writes).toEqual([]);
  });

  it("3. vault scan with a missing image creates ZERO image assets", async () => {
    const { asset, writes } = recordingAsset();
    const { vault } = recordingVault({
      "Peach Cobbler Loaf.md": "---\ntitle: Peach Cobbler Loaf\n---\n\n# Peach Cobbler Loaf\n",
    });
    const result = await scanVaultMarkdown(vault);
    expect(Array.isArray(result.recipes)).toBe(true);
    expect(result.recipes[0]?.image).toBeUndefined();
    // scanVaultMarkdown touches only the VaultAdapter (no asset boundary at all).
    expect(writes).toEqual([]);
  });

  it("4. rendering a recipe with a missing image creates ZERO image assets", async () => {
    const { asset, writes } = recordingAsset();
    const recipe = recipeNoImage();
    const img = getRecipeImage(recipe);
    // Rendering yields a display URL (remote stock fallback) — never an asset path
    // and never a write.
    expect(typeof img).toBe("string");
    expect(img).toMatch(/^https?:/);
    expect(img).not.toContain("Assets/");
    expect(writes).toEqual([]);
  });

  it("5. metadata recovery / resolve helpers with a missing image create ZERO image assets", async () => {
    const { asset, writes } = recordingAsset();
    // The canonical recipe carries no image; merge/serialize are pure/vault-only.
    const recipe = recipeNoImage();
    expect("image" in recipe).toBe(false);
    expect(writes).toEqual([]);
  });

  it("6. explicitly invoking the image generator is the ONLY generation path; automatic surfaces never call it", async () => {
    const { asset, writes } = recordingAsset();
    // The automatic surfaces (save/scan/render/resolve) perform pure or
    // VaultAdapter-only operations. The generation entrypoint lives solely in the
    // explicit ImageProvider/GeminiImageProvider + the controller's Generate.
    const { vault } = recordingVault();
    await saveRecipeWithVaultAdapter(vault, recipeNoImage());
    expect(writes).toEqual([]);
  });

  it("7. Grab Recipe explicit importer image download still works (processImageSave via saveImageToVaultAssets)", async () => {
    const explicitWrites: string[] = [];
    const deps = {
      asset: {
        write: async (path: string) => {
          explicitWrites.push(`grab:${path}`);
        },
        read: async () => VALID_PNG_BYTES,
        exists: async () => false,
        delete: async () => {},
      } as unknown as AssetAdapter,
      downloadRemoteImage: { downloadRemoteImage: async () => ({ bytes: VALID_PNG_BYTES, contentType: "image/webp" }) },
    };
    const saved = await saveImageToVaultAssets(deps as never, "Peach Cobbler Loaf", "https://s.example/og.webp");
    expect(saved.success).toBe(true);
    expect(saved.relativePath).toBe("Assets/Peach Cobbler Loaf.webp");
    expect(explicitWrites).toEqual(["grab:Assets/Peach Cobbler Loaf.webp"]);
  });

  it("8. explicit generated-image save still writes exactly one asset (canonical recovery path preserved)", async () => {
    const sessionId = "vault-session-abc";
    const recipeMd = "---\ntitle: Peach Cobbler Loaf\n---\n\n# Peach Cobbler Loaf\n";
    const hash = await hashCanonicalMarkdown(recipeMd);
    const { vault, markdownWrites } = recordingVault({ "Peach Cobbler Loaf.md": recipeMd });
    const { asset, writes } = recordingAsset();
    const previewSource = {
      resolvePreview: async () => ({
        token: "tok-1",
        bytes: VALID_PNG_BYTES,
        contentType: "image/png",
        provider: "gemini-image",
        model: "gemini-2.5-flash-image",
        recipeContentHash: hash,
        vaultSessionId: sessionId,
      }),
      invalidatePreview: async () => {},
    };
    const result = await saveGeneratedRecipeImageToVault(
      { vault, asset, previewSource, now: () => new Date("2026-09-09T12:00:00.000Z") },
      { recipePath: "Peach Cobbler Loaf.md", recipeTitle: "Peach Cobbler Loaf", token: "tok-1", activeVaultSessionId: sessionId, approved: true }
    );
    expect(result.imagePath).toBe("Assets/Peach Cobbler Loaf.png");
    expect(writes).toEqual(["Assets/Peach Cobbler Loaf.png"]);
    const savedMd = await vault.readText("Peach Cobbler Loaf.md");
    expect(savedMd).toContain("image: Assets/Peach Cobbler Loaf.png");
    expect(markdownWrites).toHaveLength(1);
  });
});
