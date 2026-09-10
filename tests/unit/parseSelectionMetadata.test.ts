import { describe, it, expect } from "vitest";
import {
  parseTextSelectionHeader,
  parseImageSelectionHeader,
  isExplicitSelectionIntent,
  selectionIntentToMetadata,
  SELECTION_HEADER_NAMES,
  SELECTION_HEADER_BOUNDS,
  type SelectionHeaderSource,
} from "../../server/ai/parseSelectionMetadata.js";

const SENTINEL = "SUPER_SECRET_BYOK4_SENTINEL";
const TEXT = SELECTION_HEADER_NAMES.text;
const IMAGE = SELECTION_HEADER_NAMES.image;

function textHeader(value: string | string[]): SelectionHeaderSource {
  return { [TEXT]: value };
}

describe("BYOK-4 — strict selection intent schema (ABSENT / EXPLICIT_DEFAULT / EXPLICIT_SELECTED / INVALID)", () => {
  it("missing header => ABSENT (ONLY a truly absent header)", () => {
    expect(parseTextSelectionHeader({})).toEqual({ kind: "ABSENT" });
  });

  it("a PRESENT but empty header value => INVALID (never ABSENT)", () => {
    expect(parseTextSelectionHeader(textHeader(""))).toEqual({ kind: "INVALID", reason: "malformed_payload" });
  });

  it("an empty object payload => INVALID empty_payload (never ABSENT/default)", () => {
    expect(parseTextSelectionHeader(textHeader("{}"))).toEqual({ kind: "INVALID", reason: "empty_payload" });
  });

  it("an empty provider id => INVALID empty_provider (never ABSENT/default)", () => {
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ providerId: "" })))).toEqual({
      kind: "INVALID",
      reason: "empty_provider",
    });
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ mode: "user_selected", providerId: "" })))).toEqual({
      kind: "INVALID",
      reason: "empty_provider",
    });
  });

  it("an empty model id with a provider => INVALID empty_model", () => {
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ providerId: "gemini", modelId: "" })))).toEqual({
      kind: "INVALID",
      reason: "empty_model",
    });
  });

  it("server_default carrying empty ids => INVALID default_with_ids", () => {
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ mode: "server_default", providerId: "" })))).toEqual({
      kind: "INVALID",
      reason: "default_with_ids",
    });
  });

  it("duplicate/array-valued header => INVALID duplicate_header", () => {
    expect(parseTextSelectionHeader(textHeader(["a", "b"]))).toEqual({
      kind: "INVALID",
      reason: "duplicate_header",
    });
  });

  it("well-formed provider+model => EXPLICIT_SELECTED", () => {
    expect(
      parseTextSelectionHeader(textHeader(JSON.stringify({ providerId: "gemini", modelId: "gemini-3.7-flash" })))
    ).toEqual({ kind: "EXPLICIT_SELECTED", providerId: "gemini", modelId: "gemini-3.7-flash" });
  });

  it("provider-only selection is RETAINED as supported legacy behavior", () => {
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ providerId: "openrouter" })))).toEqual({
      kind: "EXPLICIT_SELECTED",
      providerId: "openrouter",
    });
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ mode: "user_selected", providerId: "openrouter" })))).toEqual({
      kind: "EXPLICIT_SELECTED",
      providerId: "openrouter",
    });
  });

  it("explicit server_default => EXPLICIT_DEFAULT", () => {
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ mode: "server_default" })))).toEqual({
      kind: "EXPLICIT_DEFAULT",
    });
  });

  it("server_default carrying provider/model ids => INVALID default_with_ids", () => {
    expect(
      parseTextSelectionHeader(textHeader(JSON.stringify({ mode: "server_default", providerId: "gemini" })))
    ).toEqual({ kind: "INVALID", reason: "default_with_ids" });
    expect(
      parseTextSelectionHeader(textHeader(JSON.stringify({ mode: "server_default", modelId: "gemini-3.7-flash" })))
    ).toEqual({ kind: "INVALID", reason: "default_with_ids" });
  });

  it("invalid mode => INVALID invalid_mode (never collapsed to ABSENT/default)", () => {
    expect(
      parseTextSelectionHeader(textHeader(JSON.stringify({ mode: "server_managed", providerId: "gemini" })))
    ).toEqual({ kind: "INVALID", reason: "invalid_mode" });
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ mode: 7, providerId: "gemini" })))).toEqual({
      kind: "INVALID",
      reason: "invalid_mode",
    });
  });

  it("model-only selection => INVALID model_only", () => {
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ modelId: "gemini-3.7-flash" })))).toEqual({
      kind: "INVALID",
      reason: "model_only",
    });
  });

  it("user_selected without a provider => INVALID missing_provider", () => {
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ mode: "user_selected" })))).toEqual({
      kind: "INVALID",
      reason: "missing_provider",
    });
  });

  it("malformed JSON => INVALID malformed_json", () => {
    expect(parseTextSelectionHeader(textHeader("{not json"))).toEqual({
      kind: "INVALID",
      reason: "malformed_json",
    });
  });

  it("non-object JSON payloads => INVALID malformed_payload", () => {
    for (const val of ["[]", '"text"', "42", "null"]) {
      expect(parseTextSelectionHeader(textHeader(val))).toEqual({ kind: "INVALID", reason: "malformed_payload" });
    }
  });

  it("oversized header => INVALID oversized (rejected before parse)", () => {
    const oversized = JSON.stringify({ providerId: "x".repeat(SELECTION_HEADER_BOUNDS.maxHeaderLength) });
    expect(oversized.length).toBeGreaterThan(SELECTION_HEADER_BOUNDS.maxHeaderLength);
    expect(parseTextSelectionHeader(textHeader(oversized))).toEqual({ kind: "INVALID", reason: "oversized" });
  });

  it("oversized identifier fields => INVALID oversized (never truncated into a valid id)", () => {
    const providerId = "p".repeat(SELECTION_HEADER_BOUNDS.maxFieldLength + 1);
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ providerId })))).toEqual({
      kind: "INVALID",
      reason: "oversized",
    });
  });

  it("malformed field types => INVALID malformed_field (never coerced)", () => {
    expect(parseTextSelectionHeader(textHeader(JSON.stringify({ providerId: 123 })))).toEqual({
      kind: "INVALID",
      reason: "malformed_field",
    });
    expect(
      parseTextSelectionHeader(textHeader(JSON.stringify({ providerId: "gemini", modelId: { secret: SENTINEL } })))
    ).toEqual({ kind: "INVALID", reason: "malformed_field" });
  });

  it("trims valid string fields", () => {
    expect(
      parseTextSelectionHeader(textHeader(JSON.stringify({ providerId: "  gemini  ", modelId: "  gemini-3.7-flash  " })))
    ).toEqual({ kind: "EXPLICIT_SELECTED", providerId: "gemini", modelId: "gemini-3.7-flash" });
  });

  it("never returns a secret value or a secret-shaped key", () => {
    const parsed = parseTextSelectionHeader(
      textHeader(JSON.stringify({ providerId: "gemini", apiKey: SENTINEL, token: SENTINEL }))
    );
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
    expect(Object.keys(parsed)).not.toContain("apiKey");
  });
});

describe("BYOK-4 — parseImageSelectionHeader + intent helpers", () => {
  it("returns ABSENT for a missing image header", () => {
    expect(parseImageSelectionHeader({})).toEqual({ kind: "ABSENT" });
  });

  it("parses an image selection payload", () => {
    expect(parseImageSelectionHeader({ [IMAGE]: JSON.stringify({ providerId: "gemini-image" }) })).toEqual({
      kind: "EXPLICIT_SELECTED",
      providerId: "gemini-image",
    });
  });

  it("is case-independent on keys (Express lowercases header names)", () => {
    expect(
      parseImageSelectionHeader({ "x-kitchen-ai-image-selection": JSON.stringify({ providerId: "openrouter-image" }) })
    ).toEqual({ kind: "EXPLICIT_SELECTED", providerId: "openrouter-image" });
  });

  it("isExplicitSelectionIntent flags EXPLICIT_SELECTED and INVALID only", () => {
    expect(isExplicitSelectionIntent({ kind: "ABSENT" })).toBe(false);
    expect(isExplicitSelectionIntent({ kind: "EXPLICIT_DEFAULT" })).toBe(false);
    expect(isExplicitSelectionIntent({ kind: "EXPLICIT_SELECTED", providerId: "gemini" })).toBe(true);
    expect(isExplicitSelectionIntent({ kind: "INVALID", reason: "malformed_json" })).toBe(true);
  });

  it("selectionIntentToMetadata only maps a valid selected intent", () => {
    expect(selectionIntentToMetadata({ kind: "ABSENT" })).toBeUndefined();
    expect(selectionIntentToMetadata({ kind: "EXPLICIT_DEFAULT" })).toBeUndefined();
    expect(selectionIntentToMetadata({ kind: "INVALID", reason: "model_only" })).toBeUndefined();
    expect(selectionIntentToMetadata({ kind: "EXPLICIT_SELECTED", providerId: "gemini" })).toEqual({
      mode: "user_selected",
      providerId: "gemini",
    });
    expect(
      selectionIntentToMetadata({ kind: "EXPLICIT_SELECTED", providerId: "gemini", modelId: "gemini-3.7-flash" })
    ).toEqual({ mode: "user_selected", providerId: "gemini", modelId: "gemini-3.7-flash" });
  });
});
