import { describe, it, expect } from "vitest";
import type { ObsidianRecipe, MealPlanDay, ShoppingCategoryGroup, VaultNote } from "../../src/types";
import {
  sameCanonicalRecipeIdentity,
  findCanonicalRecipe,
  upsertCanonicalRecipe,
  removeCanonicalRecipe,
  reconcileActiveRecipe,
  normalizeCanonicalPath,
  deriveVaultSnapshotState,
  createScanGenerationGuard,
  applyAcceptedVaultSnapshot,
  type VaultActiveRefs,
} from "../../src/core/recipeIdentity.js";

function recipe(partial: Partial<ObsidianRecipe>): ObsidianRecipe {
  return {
    id: "x",
    fileName: "x.md",
    filePath: "x.md",
    rawMarkdown: "",
    title: "X",
    tags: [],
    category: "General",
    cuisine: "International",
    difficulty: "Medium",
    rating: 0,
    ingredients: [],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...partial,
  } as ObsidianRecipe;
}

const dishA = recipe({ id: "A/Dish.md", fileName: "Dish.md", filePath: "A/Dish.md", title: "A Dish" });
const dishB = recipe({ id: "B/Dish.md", fileName: "Dish.md", filePath: "B/Dish.md", title: "B Dish" });
const rootDish = recipe({ id: "Dish.md", fileName: "Dish.md", filePath: "Dish.md", title: "Root Dish" });

describe("canonical recipe identity (v0.7 integrity)", () => {
  it("prefers exact vault-relative path over basename (same basename in different dirs are DIFFERENT)", () => {
    expect(sameCanonicalRecipeIdentity(dishA, dishB)).toBe(false);
    expect(sameCanonicalRecipeIdentity(dishA, rootDish)).toBe(false);
    expect(sameCanonicalRecipeIdentity(dishA, dishA)).toBe(true);
  });

  it("a path-bearing record never matches a pathless record by basename", () => {
    const pathless = recipe({ id: "some-id", fileName: "Dish.md", filePath: "" });
    expect(sameCanonicalRecipeIdentity(dishA, pathless)).toBe(false);
  });

  it("falls back to id only when neither side has a vault path", () => {
    const a = recipe({ filePath: "", id: "same", fileName: "Lean.md" });
    const b = recipe({ filePath: "", id: "same", fileName: "Other.md" });
    expect(sameCanonicalRecipeIdentity(a, b)).toBe(true);
    const c = recipe({ filePath: "", id: "other", fileName: "Lean.md" });
    expect(sameCanonicalRecipeIdentity(a, c)).toBe(false);
  });

  it("falls back to basename only when no path and no id exists", () => {
    const a = recipe({ filePath: "", id: "", fileName: "Lean.md" });
    const b = recipe({ filePath: "", id: "", fileName: "Lean.md" });
    expect(sameCanonicalRecipeIdentity(a, b)).toBe(true);
    const c = recipe({ filePath: "", id: "", fileName: "Lean2.md" });
    expect(sameCanonicalRecipeIdentity(a, c)).toBe(false);
  });

  it("normalizes backslashes and leading slashes", () => {
    expect(normalizeCanonicalPath("A\\Dish.md")).toBe("A/Dish.md");
    expect(normalizeCanonicalPath("/A/Dish.md")).toBe("A/Dish.md");
  });

  it("findCanonicalRecipe matches by path, not basename", () => {
    const list = [dishA, dishB];
    expect(findCanonicalRecipe(list, dishB)?.title).toBe("B Dish");
    // A root Dish.md does NOT match B/Dish.md just because basenames match.
    expect(findCanonicalRecipe(list, rootDish)).toBeUndefined();
  });

  it("upsert replaces ONLY the matching path record", () => {
    const editedB = recipe({ ...dishB, title: "B Dish Edited", filePath: "B/Dish.md" });
    const result = upsertCanonicalRecipe([dishA, dishB], editedB);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.filePath === "A/Dish.md")?.title).toBe("A Dish");
    expect(result.find((r) => r.filePath === "B/Dish.md")?.title).toBe("B Dish Edited");
  });

  it("upsert prepends when the canonical record is new", () => {
    const result = upsertCanonicalRecipe([dishA], rootDish);
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe("Dish.md");
  });

  it("removeCanonicalRecipe removes only the matching path record", () => {
    const result = removeCanonicalRecipe([dishA, dishB], dishB);
    expect(result.map((r) => r.filePath)).toEqual(["A/Dish.md"]);
  });

  it("reconcileActiveRecipe refreshes a present record and clears a removed one", () => {
    const snapshot = [recipe({ ...dishA, title: "A New Title", filePath: "A/Dish.md" })];
    const refreshed = reconcileActiveRecipe(dishA, snapshot);
    expect(refreshed?.title).toBe("A New Title");

    // Removed from snapshot -> cleared.
    expect(reconcileActiveRecipe(dishB, snapshot)).toBeNull();
    expect(reconcileActiveRecipe(null, snapshot)).toBeNull();
  });
});

describe("deriveVaultSnapshotState (v0.7 canonical integrity)", () => {
  const plan: MealPlanDay[] = [{ dayName: "Monday" }];
  const shop: ShoppingCategoryGroup[] = [{ category: "Produce", items: [] }];
  const noActive: VaultActiveRefs = { selectedRecipe: null, cookingRecipe: null, editingRecipe: null };

  it("a SUCCESSFUL empty scan is authoritative and clears recipes/notes", () => {
    const result = deriveVaultSnapshotState({ recipes: [], notes: [], mealPlan: [], shoppingList: [] }, noActive);
    expect(result.recipes).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("reconciles a present selectedRecipe to the fresh canonical object (old -> new title)", () => {
    const snapshot = [recipe({ ...dishA, title: "A New Title", filePath: "A/Dish.md" })];
    const result = deriveVaultSnapshotState({ recipes: snapshot, notes: [], mealPlan: [], shoppingList: [] }, { ...noActive, selectedRecipe: dishA });
    expect(result.selectedRecipe?.title).toBe("A New Title");
    expect(result.selectedRecipe?.filePath).toBe("A/Dish.md");
  });

  it("clears selectedRecipe when it no longer exists in the fresh snapshot", () => {
    const snapshot = [recipe({ ...dishB, title: "B", filePath: "B/Dish.md" })];
    const result = deriveVaultSnapshotState({ recipes: snapshot, notes: [], mealPlan: [], shoppingList: [] }, { ...noActive, selectedRecipe: dishA });
    expect(result.selectedRecipe).toBeNull();
  });

  it("a REMOVED cookingRecipe reference is cleared; a present one is refreshed", () => {
    const snapshot = [recipe({ ...dishA, title: "A Fresh", filePath: "A/Dish.md" })];
    const result = deriveVaultSnapshotState({ recipes: snapshot, notes: [], mealPlan: [], shoppingList: [] }, {
      ...noActive,
      cookingRecipe: { recipe: dishA, servings: 4 },
    });
    expect(result.cookingRecipe?.recipe.title).toBe("A Fresh");
    expect(result.cookingRecipe?.servings).toBe(4);
    const removed = deriveVaultSnapshotState({ recipes: snapshot, notes: [], mealPlan: [], shoppingList: [] }, {
      ...noActive,
      cookingRecipe: { recipe: dishB, servings: 2 },
    });
    expect(removed.cookingRecipe).toBeNull();
  });

  it("absence of Meal Plan.md / Shopping List.md yields clean empty state (not old vault values)", () => {
    const result = deriveVaultSnapshotState({ recipes: [], notes: [], mealPlan: undefined, shoppingList: undefined }, noActive);
    expect(result.mealPlan).toEqual([]);
    expect(result.shoppingList).toEqual([]);
  });

  it("refreshes editingRecipe base object (editor edits live in modal local state, so it is safe)", () => {
    const snapshot = [recipe({ ...dishA, title: "A Edited On Disk", filePath: "A/Dish.md" })];
    const result = deriveVaultSnapshotState({ recipes: snapshot, notes: [], mealPlan: [], shoppingList: [] }, { ...noActive, editingRecipe: dishA });
    expect(result.editingRecipe?.title).toBe("A Edited On Disk");
  });
});

describe("createScanGenerationGuard (v0.7 stale-scan race)", () => {
  it("an older scan generation is no longer current once a newer scan begins", () => {
    const guard = createScanGenerationGuard();
    const scanA = guard.begin();
    const scanB = guard.begin();
    expect(guard.isCurrent(scanA)).toBe(false);
    expect(guard.isCurrent(scanB)).toBe(true);
  });

  it("isCurrent reflects the latest begun generation after multiple scans", () => {
    const guard = createScanGenerationGuard();
    const a = guard.begin();
    const b = guard.begin();
    const c = guard.begin();
    expect(guard.isCurrent(a)).toBe(false);
    expect(guard.isCurrent(b)).toBe(false);
    expect(guard.isCurrent(c)).toBe(true);
  });
});

describe("applyAcceptedVaultSnapshot (v0.7 handle persistence ordering)", () => {
  it("commits and persists ONLY when the scan generation is still current (successful switch)", async () => {
    const guard = createScanGenerationGuard();
    const gen = guard.begin();
    let committed = 0;
    let persisted = false;
    const out = await applyAcceptedVaultSnapshot(
      guard,
      gen,
      () => { committed = 1; return "B"; },
      async () => { persisted = true; }
    );
    expect(out.accepted).toBe(true);
    expect(out.value).toBe("B");
    expect(committed).toBe(1);
    expect(persisted).toBe(true); // persist happens (and is awaited) after commit.
  });

  it("does NOT persist a stale/superseded scan (B loses to C)", async () => {
    const guard = createScanGenerationGuard();
    const genB = guard.begin();
    guard.begin(); // C selected later -> B is stale
    let committed = false;
    let persisted = false;
    const out = await applyAcceptedVaultSnapshot(
      guard,
      genB,
      () => { committed = true; return "B"; },
      async () => { persisted = true; }
    );
    expect(out.accepted).toBe(false);
    expect(committed).toBe(false); // stale snapshot not applied
    expect(persisted).toBe(false); // stale handle never persisted
  });

  it("a failed scan never reaches the helper (caller throws first); a throwing commit aborts before persist", async () => {
    const guard = createScanGenerationGuard();
    const gen = guard.begin();
    let persisted = false;
    // Simulate a commit that throws (e.g. acceptance failed) -> persist must not run.
    await expect(
      applyAcceptedVaultSnapshot(
        guard,
        gen,
        () => { throw new Error("acceptance failed"); },
        async () => { persisted = true; }
      )
    ).rejects.toThrow("acceptance failed");
    expect(persisted).toBe(false);
  });
});

