import { describe, it, expect, afterEach } from "vitest";
import type { VaultAdapter } from "../../src/application/adapters/VaultAdapter.js";
import {
  saveGeneratedRecipeToVault,
  generatedDraftToObsidianRecipe,
  GeneratedRecipePathCollisionError,
  GENERATED_RECIPE_COLLISION_MESSAGE,
  resetGeneratedSaveLocks,
} from "../../src/application/createForMe.js";
import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from "../../src/schema/generatedRecipe.js";

const PROVENANCE: GeneratedRecipeProvenance = { generated: true, providerId: "gemini", model: "gemini-test" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function tick() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

/** Creates a vault whose writeText can be held open until released (deterministic). */
function gatedVault() {
  const files = new Map<string, string>();
  const writes: { path: string; content: string }[] = [];
  const gates: (() => void)[] = [];
  const vault = {
    listMarkdownFiles: async () => [],
    readText: async (p: string) => files.get(p) ?? "",
    writeText: async (p: string, c: string) => {
      writes.push({ path: p, content: c });
      await new Promise<void>((resolve) => gates.push(resolve));
      files.set(p, c);
    },
    delete: async () => {},
    exists: async (p: string) => files.has(p),
  } as unknown as VaultAdapter;
  return { vault, writes, files, gates };
}

afterEach(() => {
  resetGeneratedSaveLocks();
});

function draft(overrides: Partial<GeneratedRecipeDraft> = {}): GeneratedRecipeDraft {
  return {
    title: "Generated Dish",
    ingredients: [{ name: "chicken" }, { name: "rice" }],
    steps: [{ text: "Cook everything." }],
    ...overrides,
  };
}

function fakeVault(existing: string[] = []) {
  const files = new Map<string, string>(existing.map((p) => [p, `EXISTING:${p}`]));
  const writes: { path: string; content: string }[] = [];
  const vault = {
    listMarkdownFiles: async () => Array.from(files.keys()).map((path) => ({ path, name: path.split("/").pop() || path })),
    readText: async (p: string) => files.get(p) ?? "",
    writeText: async (p: string, c: string) => { writes.push({ path: p, content: c }); files.set(p, c); },
    delete: async () => {},
    exists: async (p: string) => files.has(p),
  } as unknown as VaultAdapter;
  return { vault, writes, files };
}

function recipe(overrides: Partial<GeneratedRecipeDraft> = {}, now: () => Date = () => new Date("2026-02-03T04:05:06.000Z")) {
  return generatedDraftToObsidianRecipe({ draft: draft(overrides), provenance: PROVENANCE, now });
}

describe("Create for Me — generated save collision safety (v0.7 2A correction)", () => {
  it("refuses to overwrite an existing same-title file (no write, file untouched)", async () => {
    const { vault, writes, files } = fakeVault(["Generated Dish.md"]);
    const r = recipe({ title: "Generated Dish" });
    await expect(saveGeneratedRecipeToVault(vault, r)).rejects.toBeInstanceOf(GeneratedRecipePathCollisionError);
    expect(writes).toHaveLength(0);
    expect(files.get("Generated Dish.md")).toBe("EXISTING:Generated Dish.md");
  });

  it("uses the FINAL edited title for the collision check (GLM §30/§34)", async () => {
    const { vault, writes } = fakeVault(["Chicken Parmesan.md"]);
    // Generated as "Foo", user edits title to "Chicken Parmesan" -> must refuse.
    const edited = recipe({ title: "Chicken Parmesan" });
    await expect(saveGeneratedRecipeToVault(vault, edited)).rejects.toBeInstanceOf(GeneratedRecipePathCollisionError);
    expect(writes).toHaveLength(0);
  });

  it("still collides when the model title differs but the edited title matches an existing file", async () => {
    const { vault, writes } = fakeVault(["Existing Recipe.md"]);
    await expect(saveGeneratedRecipeToVault(vault, recipe({ title: "Existing Recipe" }))).rejects.toBeInstanceOf(GeneratedRecipePathCollisionError);
    expect(writes).toHaveLength(0);
  });

  it("saves successfully when the target does not exist (existing serializer + provenance)", async () => {
    const { vault, writes } = fakeVault([]);
    const r = recipe({ title: "Custom Name", ingredients: [{ amount: 1, unit: "cup", name: "flour" }], steps: [{ text: "Mix." }] });
    await saveGeneratedRecipeToVault(vault, r);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("Custom Name.md");
    expect(writes[0].content).toContain("codex_generated: true");
    expect(writes[0].content).not.toContain("SUPER_SECRET_CREATE_PROMPT_SENTINEL");
    expect(writes[0].content).not.toContain("[[");
  });

  it("collision is a local save conflict with a deterministic, secret-free message", async () => {
    const { vault } = fakeVault(["X.md"]);
    const err = await saveGeneratedRecipeToVault(vault, recipe({ title: "X" })).catch((e) => e);
    expect(err).toBeInstanceOf(GeneratedRecipePathCollisionError);
    expect(err.message).toBe(GENERATED_RECIPE_COLLISION_MESSAGE);
    expect(err.path).toBe("X.md");
    expect(JSON.stringify(err)).not.toContain("SUPER_SECRET_CREATE_PROMPT_SENTINEL");
    expect(JSON.stringify(err)).not.toContain("Bearer");
    expect(JSON.stringify(err)).not.toContain("sk-");
  });

  it("rename then retry keeps the existing file byte-identical and creates the new one", async () => {
    const { vault, writes, files } = fakeVault(["Chicken Parmesan.md"]);
    // Attempt 1 collides.
    await expect(saveGeneratedRecipeToVault(vault, recipe({ title: "Chicken Parmesan" }))).rejects.toBeInstanceOf(GeneratedRecipePathCollisionError);
    expect(files.get("Chicken Parmesan.md")).toBe("EXISTING:Chicken Parmesan.md");
    expect(writes).toHaveLength(0);
    // Attempt 2 after a successful rename.
    await saveGeneratedRecipeToVault(vault, recipe({ title: "Chicken Parmesan Deluxe" }));
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("Chicken Parmesan Deluxe.md");
    expect(files.has("Chicken Parmesan.md")).toBe(true);
    expect(files.get("Chicken Parmesan.md")).toBe("EXISTING:Chicken Parmesan.md");
  });

  it("collision persists NOTHING, and generated_at reflects the actual successful save", async () => {
    const { vault, writes } = fakeVault(["Dish.md"]);
    // First attempt: collision -> no provenance written anywhere.
    await expect(saveGeneratedRecipeToVault(vault, recipe({ title: "Dish" }, () => new Date("2026-01-01T00:00:00.000Z")))).rejects.toBeInstanceOf(GeneratedRecipePathCollisionError);
    expect(writes).toHaveLength(0);
    // Retry after rename succeeds and stamps generated_at at save time.
    const r = recipe({ title: "Dish Deluxe" }, () => new Date("2026-02-03T04:05:06.000Z"));
    await saveGeneratedRecipeToVault(vault, r);
    expect(writes[0].content).toContain("codex_generated_at: '2026-02-03T04:05:06.000Z'");
  });

  it("does not mutate the draft/recipe object on collision", async () => {
    const { vault } = fakeVault(["Same.md"]);
    const r = recipe({ title: "Same", ingredients: [{ name: "keep" }], steps: [{ text: "keep step" }] });
    const beforeTitle = r.title;
    await expect(saveGeneratedRecipeToVault(vault, r)).rejects.toBeInstanceOf(GeneratedRecipePathCollisionError);
    expect(r.title).toBe(beforeTitle);
    expect(r.ingredients.map((i) => i.name)).toEqual(["keep"]);
    expect(r.instructions.map((s) => s.text)).toEqual(["keep step"]);
  });
});

describe("Create for Me — concurrent generated save protection (v0.7 2A correction 2)", () => {
  it("overlapping saves to the SAME path: exactly one write, the second refuses (Astra race)", async () => {
    const { vault, writes, files, gates } = gatedVault();
    const r = recipe({ title: "Foo" });
    resetGeneratedSaveLocks();
    const pA = saveGeneratedRecipeToVault(vault, r).then(() => "A-ok", (e) => `A-${e.constructor.name}`);
    const pB = saveGeneratedRecipeToVault(vault, r).then(() => "B-ok", (e) => `B-${e.constructor.name}`);
    await tick();
    await tick();
    // A is blocked inside its write (holding the per-path lock); B is queued on it.
    expect(gates.length).toBe(1);
    gates[0](); // release A's write
    const [ra, rb] = await Promise.all([pA, pB]);
    expect(ra).toBe("A-ok");
    expect(rb).toBe("B-GeneratedRecipePathCollisionError");
    // Only one write for Foo.md; the second save did NOT overwrite the first.
    expect(writes.filter((w) => w.path === "Foo.md")).toHaveLength(1);
    expect(files.get("Foo.md")).toBe(writes[0].content);
  });

  it("a second save observes the first successful write and refuses (no silent replace)", async () => {
    const { vault, writes, files, gates } = gatedVault();
    const r = recipe({ title: "Same Dish", ingredients: [{ name: "a" }], steps: [{ text: "s1" }] });
    resetGeneratedSaveLocks();
    const pA = saveGeneratedRecipeToVault(vault, r).then(() => "ok", () => "fail");
    const pB = saveGeneratedRecipeToVault(vault, r).then(() => "ok", (e) => (e instanceof GeneratedRecipePathCollisionError ? "collision" : "fail"));
    await tick();
    await tick();
    gates[0]();
    const [ra, rb] = await Promise.all([pA, pB]);
    expect(ra).toBe("ok");
    expect(rb).toBe("collision");
    expect(writes).toHaveLength(1);
    expect(files.get("Same Dish.md")).toBe(writes[0].content);
  });

  it("different paths do not block each other (path-keyed, not global)", async () => {
    const { vault, writes, gates } = gatedVault();
    resetGeneratedSaveLocks();
    const pA = saveGeneratedRecipeToVault(vault, recipe({ title: "Foo" })).then(() => "A", () => "A-fail");
    const pB = saveGeneratedRecipeToVault(vault, recipe({ title: "Bar" })).then(() => "B", () => "B-fail");
    await tick();
    await tick();
    // Both held independently -> two pending writes queued concurrently.
    expect(gates.length).toBe(2);
    gates.forEach((g) => g());
    const [ra, rb] = await Promise.all([pA, pB]);
    expect(ra).toBe("A");
    expect(rb).toBe("B");
    expect(writes.map((w) => w.path).sort()).toEqual(["Bar.md", "Foo.md"]);
  });

  it("resetGeneratedSaveLocks clears in-process locks between tests (no cross-test pollution)", () => {
    resetGeneratedSaveLocks();
    // Smoke: a single uncontended save on a fresh path succeeds.
    return (async () => {
      const { vault, writes, gates } = gatedVault();
      await (async () => {
        const p = saveGeneratedRecipeToVault(vault, recipe({ title: "Fresh" })).then(() => "ok", () => "fail");
        await tick();
        gates[0]();
        await p;
      })();
      expect(writes).toHaveLength(1);
    })();
  });
});
