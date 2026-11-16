/**
 * The Kitchen Codex — provider-neutral strict JSON Schema conversion/validation.
 *
 * Extracted from the OpenRouter adapter so OpenAI (and any future strict-schema
 * provider) shares ONE implementation of the OpenAI strict-subset rules:
 *
 *   - every object must set `additionalProperties: false`;
 *   - every property key must appear in `required`;
 *   - a provider-neutral OPTIONAL property stays semantically optional by
 *     becoming nullable (`anyOf: [node, { type: "null" }]`) instead of forcing
 *     the model to invent a value;
 *   - enums, descriptions, arrays, and nested objects are preserved.
 *
 * The converter is deliberately limited to the shared `AiJsonSchema` shape. It
 * never accepts arbitrary schema objects.
 */

import type { AiJsonSchema } from './types';

/**
 * Maps a provider-neutral `AiJsonSchema` onto the strict JSON Schema subset
 * required by OpenAI Structured Outputs and used by OpenRouter's `json_schema`
 * transport.
 */
export function toStrictJsonSchema(
  schema: AiJsonSchema,
  optional = false
): Record<string, unknown> {
  const node = buildStrictNode(schema);
  if (!optional) return node;
  // Nullable wrapper: the model MAY return null for an optional property.
  return { anyOf: [node, { type: 'null' }] };
}

/** Builds one strict JSON-Schema node (without the optional-null wrapper). */
function buildStrictNode(schema: AiJsonSchema): Record<string, unknown> {
  const node: Record<string, unknown> = { type: schema.type };
  if (typeof schema.description === 'string' && schema.description.trim()) {
    node.description = schema.description.trim();
  }
  switch (schema.type) {
    case 'string':
      if (Array.isArray(schema.enum) && schema.enum.length) node.enum = schema.enum;
      break;
    case 'array':
      // Array items are always present within a present array (not optional).
      node.items = toStrictJsonSchema(schema.items);
      break;
    case 'object': {
      const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);
      const properties: Record<string, unknown> = {};
      const allKeys: string[] = [];
      for (const [key, child] of Object.entries(schema.properties)) {
        allKeys.push(key);
        // Optional (not explicitly required) -> nullable; required -> plain.
        properties[key] = toStrictJsonSchema(child, !requiredSet.has(key));
      }
      node.properties = properties;
      node.additionalProperties = false;
      // OpenAI strict: `required` must list EVERY property key.
      node.required = allKeys;
      break;
    }
    // number / integer / boolean: no extra members.
  }
  return node;
}

/**
 * Validates a parsed provider value against the same provider-neutral schema.
 * Optional null is accepted as absent; required fields must be present and
 * correctly typed. No coercion, fence stripping, or extra properties.
 */
export function validatesAiSchema(value: unknown, schema: AiJsonSchema, depth = 0): boolean {
  if (depth > 64) return false;
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' && (!schema.enum || schema.enum.includes(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'array':
      return (
        Array.isArray(value) &&
        value.every((entry) => validatesAiSchema(entry, schema.items, depth + 1))
      );
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const row = value as Record<string, unknown>;
      const required = new Set(schema.required ?? []);
      if ([...required].some((key) => !Object.hasOwn(row, key))) return false;
      return Object.keys(row).every(
        (key) =>
          Object.hasOwn(schema.properties, key) &&
          ((row[key] === null && !required.has(key)) ||
            validatesAiSchema(row[key], schema.properties[key], depth + 1))
      );
    }
    default:
      return false;
  }
}
