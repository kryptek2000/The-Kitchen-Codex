import { describe, it, expect } from "vitest";
import {
  createForMeReducer,
  initialCreateForMeState,
  type CreateForMeState,
} from "../../src/application/createForMeState.js";

import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from "../../src/schema/generatedRecipe.js";

const DRAFT: GeneratedRecipeDraft = { title: "Dish", ingredients: [{ name: "x" }], steps: [{ text: "y" }] };
const PROV: GeneratedRecipeProvenance = { generated: true, providerId: "gemini", model: "g" };

describe("Create for Me state reducer (v0.7 2A correction 2)", () => {
  it("initial state has NO error (Astra false-error bug cannot trigger)", () => {
    expect(initialCreateForMeState).toEqual({ status: "prompt", error: null, draft: null, provenance: null, saving: false });
    expect(initialCreateForMeState.error).toBeNull();
  });

  it("START_GENERATION begins with no stale error", () => {
    const s = createForMeReducer({ ...initialCreateForMeState, error: "stale" }, { type: "START_GENERATION" });
    expect(s.status).toBe("generating");
    expect(s.error).toBeNull();
  });

  it("GENERATION_SUCCESS shows the draft with NO failure message (fixes reported bug)", () => {
    const prior = { ...initialCreateForMeState, error: "Couldn't generate a recipe right now." };
    const s = createForMeReducer(prior, { type: "GENERATION_SUCCESS", draft: DRAFT, provenance: PROV });
    expect(s.status).toBe("draft");
    expect(s.draft).toEqual(DRAFT);
    expect(s.provenance).toEqual(PROV);
    expect(s.error).toBeNull();
  });

  it("GENERATION_FAILURE sets a bounded message, then retry-success clears it", () => {
    let s = createForMeReducer(initialCreateForMeState, { type: "START_GENERATION" });
    s = createForMeReducer(s, { type: "GENERATION_FAILURE", message: "Couldn't generate a recipe right now." });
    expect(s.status).toBe("error");
    expect(s.error).toBe("Couldn't generate a recipe right now.");
    // Retry: old error disappears immediately on the next attempt.
    s = createForMeReducer(s, { type: "START_GENERATION" });
    expect(s.error).toBeNull();
    expect(s.status).toBe("generating");
    // Retry succeeds -> draft, no stale error.
    s = createForMeReducer(s, { type: "GENERATION_SUCCESS", draft: DRAFT, provenance: PROV });
    expect(s.status).toBe("draft");
    expect(s.error).toBeNull();
    expect(s.draft).toEqual(DRAFT);
  });

  it("BEGIN_SAVE marks saving and clears a prior save error; SAVE_COLLISION keeps the draft", () => {
    let s: CreateForMeState = { status: "draft", error: "stale save error", draft: DRAFT, provenance: PROV, saving: false };
    s = createForMeReducer(s, { type: "BEGIN_SAVE" });
    expect(s.saving).toBe(true);
    expect(s.error).toBeNull();
    s = createForMeReducer(s, { type: "SAVE_COLLISION", message: "A recipe with that name already exists. Choose a different title before saving." });
    expect(s.status).toBe("draft");
    expect(s.saving).toBe(false);
    expect(s.draft).toEqual(DRAFT);
    expect(s.error).toContain("already exists");
    // Retry after rename.
    s = createForMeReducer(s, { type: "BEGIN_SAVE" });
    expect(s.error).toBeNull();
    s = createForMeReducer(s, { type: "SAVE_SUCCESS" });
    expect(s).toEqual(initialCreateForMeState);
  });

  it("SAVE_FAILURE keeps the draft (title/ingredients/steps) and does not close", () => {
    let s: CreateForMeState = { status: "draft", error: null, draft: DRAFT, provenance: PROV, saving: true };
    s = createForMeReducer(s, { type: "SAVE_FAILURE", message: "Couldn't save the recipe right now." });
    expect(s.status).toBe("draft");
    expect(s.error).toBe("Couldn't save the recipe right now.");
    expect(s.draft).toEqual(DRAFT);
    expect(s.saving).toBe(false);
  });

  it("SAVE_SUCCESS resets to the clean initial state (no stale error/banner)", () => {
    let s: CreateForMeState = { status: "draft", error: "collision", draft: DRAFT, provenance: PROV, saving: true };
    s = createForMeReducer(s, { type: "SAVE_SUCCESS" });
    expect(s).toEqual(initialCreateForMeState);
    expect(s.error).toBeNull();
  });
});
