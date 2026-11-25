import { describe, it, expect } from "vitest";
import {
  toStrictJsonSchema,
  validatesAiSchema,
} from "../../src/core/ai/strictJsonSchema.js";
import { buildGeneratedRecipeSchema } from "../../src/schema/generatedRecipe.js";
import { buildKitchenInterpretSchema } from "../../server/kitchenInterpret.js";
import { SHISO_DECISION_SCHEMA } from "../../src/core/shiso/protocol.js";
import type { AiJsonSchema } from "../../src/core/ai/types.js";

function collectObjects(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return out;
  const row = node as Record<string, unknown>;
  if (Array.isArray(row.anyOf)) {
    for (const branch of row.anyOf) collectObjects(branch, out);
  }
  if (row.type === "object") {
    out.push(row);
    for (const child of Object.values((row.properties ?? {}) as Record<string, unknown>)) {
      collectObjects(child, out);
    }
  }
  if (row.type === "array" && row.items) collectObjects(row.items, out);
  return out;
}

function assertStrict(node: unknown) {
  const objects = collectObjects(node);
  expect(objects.length).toBeGreaterThan(0);
  for (const object of objects) {
    expect(object.additionalProperties).toBe(false);
    expect(Array.isArray(object.required)).toBe(true);
    expect(new Set(object.required as string[])).toEqual(
      new Set(Object.keys((object.properties ?? {}) as Record<string, unknown>))
    );
  }
  const serialized = JSON.stringify(node);
  for (const unsupported of [
    "allOf",
    "oneOf",
    "not",
    "dependentRequired",
    "dependentSchemas",
    "patternProperties",
  ]) {
    expect(serialized).not.toContain(`"${unsupported}"`);
  }
}

describe("shared strict schema conversion (OpenAI/OpenRouter)", () => {
  it("converts the generated recipe schema to the OpenAI strict subset", () => {
    const converted = toStrictJsonSchema(buildGeneratedRecipeSchema());
    assertStrict(converted);
    const root = converted as Record<string, any>;
    expect(root.type).toBe("object");
    expect(root.required).toContain("title");
    expect(root.required).toContain("ingredients");
    expect(root.required).toContain("steps");
    expect(new Set(root.required)).toEqual(new Set(Object.keys(root.properties)));
    // Optional fields remain semantically optional via nullability.
    expect(root.properties.description.anyOf[1]).toEqual({ type: "null" });
    expect(root.properties.ingredients.items.required).toContain("name");
    expect(root.properties.ingredients.items.required).toContain("amount");
    expect(root.properties.ingredients.items.properties.amount.anyOf[1]).toEqual({
      type: "null",
    });
  });

  it("converts the real KitchenIntent schema and keeps sanitizer-required fields non-nullable", () => {
    const converted = toStrictJsonSchema(buildKitchenInterpretSchema()) as Record<string, any>;
    assertStrict(converted);
    for (const key of ["version", "intent", "source"]) {
      expect(converted.properties[key].anyOf).toBeUndefined();
      expect(typeof converted.properties[key].type).toBe("string");
    }
    expect(converted.properties.confidence.anyOf[1]).toEqual({ type: "null" });
  });

  it("converts the SHISO decision schema and preserves null-as-absent semantics", () => {
    const converted = toStrictJsonSchema(SHISO_DECISION_SCHEMA as unknown as AiJsonSchema);
    assertStrict(converted);
    const root = converted as Record<string, any>;
    expect(root.required).toEqual(["kind", "text", "tool", "args"]);
    expect(root.properties.text.anyOf[1]).toEqual({ type: "null" });
    expect(root.properties.tool.anyOf[1]).toEqual({ type: "null" });
    expect(root.properties.args.anyOf[1]).toEqual({ type: "null" });
    expect(
      validatesAiSchema(
        { kind: "reply", text: "hello", tool: null, args: null },
        SHISO_DECISION_SCHEMA as unknown as AiJsonSchema
      )
    ).toBe(true);
  });

  it("rejects extra properties, missing required fields, and required nulls", () => {
    const schema: AiJsonSchema = {
      type: "object",
      properties: { required: { type: "string" }, optional: { type: "number" } },
      required: ["required"],
    };
    expect(validatesAiSchema({ required: "x" }, schema)).toBe(true);
    expect(validatesAiSchema({ required: "x", optional: null }, schema)).toBe(true);
    expect(validatesAiSchema({ required: null }, schema)).toBe(false);
    expect(validatesAiSchema({}, schema)).toBe(false);
    expect(validatesAiSchema({ required: "x", extra: true }, schema)).toBe(false);
  });
});
