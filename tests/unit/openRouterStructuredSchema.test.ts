import { describe, it, expect, afterEach, vi } from "vitest";
import { toOpenRouterJsonSchema } from "../../server/ai/openRouterProvider.js";
import { buildKitchenInterpretSchema } from "../../server/kitchenInterpret.js";
import { sanitizeKitchenIntent } from "../../src/utils/kitchenIntent.js";
import type { AiJsonSchema } from "../../server/ai/types.js";

/** Collects every object node (following anyOf branches, properties, items). */
function collectObjectNodes(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record["anyOf"])) {
    for (const branch of record["anyOf"]) collectObjectNodes(branch, out);
  }
  if (record["type"] === "object") {
    out.push(record);
    const properties = (record["properties"] ?? {}) as Record<string, unknown>;
    for (const child of Object.values(properties)) collectObjectNodes(child, out);
  }
  if (record["type"] === "array" && record["items"]) collectObjectNodes(record["items"], out);
  return out;
}

function assertStrictObjects(converted: unknown): Record<string, unknown>[] {
  const objects = collectObjectNodes(converted);
  expect(objects.length).toBeGreaterThan(0);
  for (const obj of objects) {
    expect(Array.isArray(obj["required"])).toBe(true);
    const keys = Object.keys((obj["properties"] ?? {}) as Record<string, unknown>);
    // `required` must list EVERY property key (OpenAI strict).
    expect(new Set(obj["required"] as string[])).toEqual(new Set(keys));
    expect(obj["additionalProperties"]).toBe(false);
  }
  return objects;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../server/geminiClient.js");
  vi.resetModules();
});

describe("BYOK strict structured-output schema (OpenRouter/OpenAI)", () => {
  it("every object node has `required` listing every property key (recursive)", () => {
    const converted = toOpenRouterJsonSchema(buildKitchenInterpretSchema());
    const objects = assertStrictObjects(converted);
    // Nested constraint/preference/reference objects are covered too.
    expect(objects.length).toBeGreaterThanOrEqual(4);
  });

  it("the REAL KitchenIntent schema converts to an OpenAI-valid strict schema", () => {
    const converted = toOpenRouterJsonSchema(buildKitchenInterpretSchema()) as Record<string, unknown>;
    expect(converted["type"]).toBe("object");
    expect(converted["additionalProperties"]).toBe(false);
    const required = converted["required"] as string[];
    const keys = Object.keys(converted["properties"] as Record<string, unknown>);
    expect(new Set(required)).toEqual(new Set(keys));
    // The sanitizer's semantically-required fields are present in `required`.
    for (const key of ["version", "intent", "source"]) {
      expect(required).toContain(key);
    }
    // Strict validation holds for every nested object.
    assertStrictObjects(converted);
  });

  it("ROOT CAUSE: sanitizer-required fields are NON-NULLABLE (no `source: null` possible)", () => {
    const converted = toOpenRouterJsonSchema(buildKitchenInterpretSchema()) as Record<string, any>;
    for (const key of ["version", "intent", "source"]) {
      // Explicitly-required -> emitted as a plain node, never an anyOf/null wrapper.
      expect(converted.properties[key].anyOf).toBeUndefined();
      expect(typeof converted.properties[key].type).toBe("string");
    }
    // A truly optional field remains nullable.
    expect(converted.properties.confidence.anyOf[1]).toEqual({ type: "null" });
  });

  it("ROOT CAUSE: the sanitizer rejects a null source (why the schema must require it)", () => {
    const raw = {
      version: 1,
      intent: "find_recipes",
      source: null,
      constraints: { includeIngredients: ["chicken"] },
    };
    expect(sanitizeKitchenIntent(raw)).toBeNull();
    // With a valid source the SAME payload is accepted.
    const accepted = sanitizeKitchenIntent({ ...raw, source: "vault" });
    expect(accepted).not.toBeNull();
    expect(accepted!.intent).toBe("find_recipes");
  });

  it("explicitly-required fields stay non-nullable; optional fields become nullable", () => {
    const schema: AiJsonSchema = {
      type: "object",
      properties: { must: { type: "string" }, maybe: { type: "string" } },
      required: ["must"],
    };
    const converted = toOpenRouterJsonSchema(schema) as Record<string, any>;
    expect(new Set(converted.required)).toEqual(new Set(["must", "maybe"]));
    expect(converted.properties.must).toEqual({ type: "string" });
    expect(converted.properties.maybe).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("optional nested objects/arrays become nullable and remain strict inside", () => {
    const schema: AiJsonSchema = {
      type: "object",
      properties: {
        nested: { type: "object", properties: { inner: { type: "string" } } },
        list: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } },
      },
    };
    const converted = toOpenRouterJsonSchema(schema) as Record<string, any>;
    // Top-level optional objects/arrays are nullable wrappers.
    expect(converted.properties.nested.anyOf[1]).toEqual({ type: "null" });
    expect(converted.properties.list.anyOf[1]).toEqual({ type: "null" });
    // The inner object branch is still strict.
    assertStrictObjects(converted);
  });

  it("preserves enums, descriptions, and items", () => {
    const schema: AiJsonSchema = {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["a", "b"], description: "the kind" },
      },
    };
    const converted = toOpenRouterJsonSchema(schema) as Record<string, any>;
    const kind = converted.properties.kind.anyOf[0];
    expect(kind.enum).toEqual(["a", "b"]);
    expect(kind.description).toBe("the kind");
  });

  it("null optional fields are handled safely by the existing sanitizer (no fabrication)", () => {
    const raw = {
      version: 1,
      intent: "find_recipes",
      source: "vault",
      constraints: null,
      preferences: null,
      references: null,
      requiresClarification: null,
      requestedResultCount: null,
      confidence: null,
      unresolvedTerms: null,
    };
    const sanitized = sanitizeKitchenIntent(raw);
    expect(sanitized).not.toBeNull();
    expect(sanitized!.intent).toBe("find_recipes");
    expect(sanitized!.constraints).toEqual({});
    expect(sanitized!.preferences).toEqual({});
    // No fabricated values for absent optional fields.
    expect(sanitized!.requestedResultCount).toBeUndefined();
    expect(sanitized!.confidence).toBeUndefined();
    expect(sanitized!.references).toBeUndefined();
  });

  it("Gemini structured schema is UNCHANGED (no anyOf/null, no forced required)", async () => {
    vi.resetModules();
    const captured: any[] = [];
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => ({
        models: {
          generateContent: async (args: any) => {
            captured.push(args);
            return { text: '{"ok":true}' };
          },
        },
      }),
      getGeminiImage: () => null,
      createGeminiClientWithKey: () => {
        throw new Error("unused");
      },
    }));
    const { GeminiProvider } = await import("../../server/ai/geminiProvider.js");
    const neutral: AiJsonSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
    };
    await new GeminiProvider().generateStructured("p", neutral, { model: "gemini-3.7-flash" });
    const geminiSchema = captured[0].config.responseSchema;
    expect(geminiSchema.required).toBeUndefined();
    expect(JSON.stringify(geminiSchema)).not.toContain("anyOf");
  });

  it("DeepSeek still refuses schema-constrained structured output (unchanged)", async () => {
    const { DeepSeekProvider } = await import("../../server/ai/deepSeekProvider.js");
    await expect(
      new DeepSeekProvider().generateStructured(
        "p",
        { type: "object", properties: {} },
        { model: "deepseek-v4-flash" }
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});
