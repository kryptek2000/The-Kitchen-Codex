/**
 * The Kitchen Codex — SHISO turn request validation (server boundary).
 *
 * The wire body is UNTRUSTED. This is the only place it is accepted, and it
 * accepts a CLOSED shape: unknown top-level keys are refused whole, every field
 * is bounded, and the history is trimmed to the released conversation ceiling.
 *
 * A model cannot reach this module — it runs before any provider call — so a
 * malformed body costs nothing.
 */

import {
  SHISO_LIMITS,
  SHISO_TURN_CONTRACT_VERSION,
  isShisoToolName,
  type ShisoCollectedFinding,
  type ShisoConversationContext,
  type ShisoConversationMessage,
  type ShisoObservation,
  type ShisoToolName,
  type ShisoTurnRequestBody,
} from "../../src/core/shiso/protocol.js";

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'invalid_arguments','no_active_recipe','no_nutrition_review','unknown_line_ref',
  'catalog_search_empty','record_not_found','no_usable_portion','budget_exhausted',
  'no_analysis_owner','analysis_unavailable','review_not_initialized','stale_recipe','unsupported',
]);

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "turn_version",
  "user_message",
  "history",
  "context",
  "observation",
  "collected",
  "finalize",
  "model_invocations_used",
  "tool_calls_used",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInt(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function readContext(raw: unknown): ShisoConversationContext {
  const c = isPlainObject(raw) ? raw : {};
  const recipe = isPlainObject(c["recipe"]) ? (c["recipe"] as Record<string, unknown>) : null;
  const nutrition = isPlainObject(c["nutrition"]) ? (c["nutrition"] as Record<string, unknown>) : {};
  return {
    recipe: recipe === null
      ? null
      : {
          title: typeof recipe["title"] === "string" ? String(recipe["title"]).slice(0, 200) : "",
          servings: typeof recipe["servings"] === "number" ? Number(recipe["servings"]) : null,
          ingredientCount: boundedInt(recipe["ingredientCount"], 1000),
          stepCount: boundedInt(recipe["stepCount"], 1000),
        },
    nutrition: {
      available: nutrition["available"] === true,
      summary: typeof nutrition["summary"] === "string" ? String(nutrition["summary"]).slice(0, 400) : null,
      unresolvedCount: boundedInt(nutrition["unresolvedCount"], 1000),
      needsAmountCount: boundedInt(nutrition["needsAmountCount"], 1000),
      needsMatchCount: boundedInt(nutrition["needsMatchCount"], 1000),
      unsavedWorkingReview: nutrition["unsavedWorkingReview"] === true,
    },
    recipeKey: typeof c["recipeKey"] === "string" ? String(c["recipeKey"]).slice(0, 200) : null,
    sessionIdentity: typeof c["sessionIdentity"] === "string" ? String(c["sessionIdentity"]).slice(0, 200) : null,
  };
}

function readHistory(raw: unknown): ShisoConversationMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ShisoConversationMessage[] = [];
  for (const entry of raw.slice(-SHISO_LIMITS.maxHistoryMessages)) {
    if (!isPlainObject(entry)) continue;
    const role = entry["role"];
    const text = entry["text"];
    if (role !== "user" && role !== "assistant") continue;
    if (typeof text !== "string") continue;
    const bounded = text.slice(0, SHISO_LIMITS.maxAssistantMessageChars);
    if (bounded.length === 0) continue;
    out.push({ role, text: bounded });
  }
  return out;
}

function readObservation(raw: unknown): ShisoObservation | undefined {
  if (!isPlainObject(raw)) return undefined;
  const tool = raw["tool"];
  if (!isShisoToolName(tool)) return undefined;
  const ok = raw["ok"];
  if (ok === true) {
    const summary = raw["summary"];
    const data = raw["data"];
    if (typeof summary !== "string") return undefined;
    return {
      ok: true,
      tool,
      summary: summary.slice(0, 4000),
      data: isPlainObject(data) ? (data as Record<string, unknown>) : {},
    };
  }
  const code = raw["code"];
  const message = raw["message"];
  return {
    ok: false,
    tool,
    code:
      typeof code === "string"
        ? (KNOWN_CODES.has(code) ? (code as never) : "unsupported")
        : "unsupported",
    message: typeof message === "string" ? message.slice(0, 500) : "The capability did not succeed.",
  };
}

/**
 * Already-collected findings carried forward so a turn can report real evidence
 * without spending another tool call. Only the bounded application-produced
 * summary string is accepted — a model can never author an entry here, because
 * this runs on the wire before any model output exists.
 */
function readCollected(raw: unknown): ShisoCollectedFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ShisoCollectedFinding[] = [];
  for (const entry of raw.slice(0, 32)) {
    if (!isPlainObject(entry)) continue;
    const tool = entry["tool"];
    if (!isShisoToolName(tool)) continue;
    const summary = entry["summary"];
    if (typeof summary !== "string") continue;
    const bounded = summary.trim().slice(0, 400);
    if (bounded.length === 0) continue;
    out.push({ tool, ok: entry["ok"] === true, summary: bounded });
  }
  return out;
}

/**
 * Returns the validated request, or null when the body is unusable. Never
 * throws and never partially accepts an unknown shape.
 */
export function readShisoTurnRequest(raw: unknown): ShisoTurnRequestBody | null {
  if (!isPlainObject(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) return null;
  }
  if (raw["turn_version"] !== SHISO_TURN_CONTRACT_VERSION) return null;
  const userMessage = raw["user_message"];
  if (typeof userMessage !== "string") return null;
  const trimmed = userMessage.trim().slice(0, SHISO_LIMITS.maxUserMessageChars);
  if (trimmed.length === 0) return null;

  const observation = readObservation(raw["observation"]);
  const collected = readCollected(raw["collected"]);
  return {
    turn_version: SHISO_TURN_CONTRACT_VERSION,
    user_message: trimmed,
    history: readHistory(raw["history"]),
    context: readContext(raw["context"]),
    ...(observation !== undefined ? { observation } : {}),
    ...(collected.length > 0 ? { collected } : {}),
    ...(raw["finalize"] === true ? { finalize: true } : {}),
    model_invocations_used: boundedInt(raw["model_invocations_used"], 1000),
    tool_calls_used: boundedInt(raw["tool_calls_used"], 1000),
  };
}

export type { ShisoToolName };
