/**
 * The Kitchen Codex — Ask My Kitchen server-side candidate ranking adapter.
 *
 * Stage B: an OPTIONAL AI reasoning layer over the CLIENT-supplied compact
 * candidate evidence. The server receives ONLY the bounded candidate evidence
 * (never the vault, raw Markdown, instructions, notes, frontmatter, or file
 * paths), ranks it with Gemini, and returns a sanitized ranked id list.
 *
 * FAILURE CONTRACT: ranking is an advisory enhancement. If Gemini is
 * unconfigured, unavailable, throws, or produces malformed/all-invalid output,
 * this returns `null` so the client falls back to deterministic ranking. A
 * ranking failure never converts an otherwise valid local Ask My Kitchen query
 * into a total failure.
 */
import { Type, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
import { getGemini } from "./geminiClient.js";
import { MODEL_CONFIG } from "./modelConfig.js";
import { sanitizeKitchenIntent, type KitchenIntent } from "../src/utils/kitchenIntent.js";
import {
  buildRankPrompt,
  sanitizeAiRankedCandidates,
  type KitchenCandidateEvidence,
  type RankedKitchenCandidate,
} from "../src/utils/kitchenRanking.js";

dotenv.config();

const RANK_MODEL = MODEL_CONFIG.nutritionPrimary;

function buildResponseSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      ranked: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            recipeId: { type: Type.STRING },
            score: { type: Type.NUMBER },
            reason: { type: Type.STRING },
          },
          required: ["recipeId"],
        },
      },
    },
    required: ["ranked"],
  };
}

/** AI structured-output adapter: compact evidence -> raw unknown (sanitized later). */
async function aiRank(input: {
  question: string;
  intent: KitchenIntent;
  candidates: KitchenCandidateEvidence[];
  resultCount: number;
}): Promise<unknown> {
  const gemini = getGemini();
  if (!gemini) {
    throw new Error("Gemini is not configured.");
  }
  const response = await gemini.models.generateContent({
    model: RANK_MODEL,
    contents: buildRankPrompt(input),
    config: {
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      responseMimeType: "application/json",
      responseSchema: buildResponseSchema(),
    },
  });

  const responseText = response.text?.trim();
  if (!responseText) {
    throw new Error("Empty response returned from AI model.");
  }
  return JSON.parse(responseText);
}

/**
 * Ranks the supplied candidate evidence with Gemini when a key is configured.
 * The AI may ONLY rank the supplied candidate ids; its output is always wrapped
 * by `sanitizeAiRankedCandidates` against that id allowlist. Returns `null` on
 * any failure/unavailability so the client can use its deterministic fallback.
 */
export async function rankKitchenCandidatesOnServer(input: {
  question: string;
  intent: KitchenIntent;
  candidates: KitchenCandidateEvidence[];
  resultCount: number;
}): Promise<RankedKitchenCandidate[] | null> {
  const gemini = getGemini();
  if (!gemini) return null;

  try {
    const raw = await aiRank(input);
    const allowlist = new Set(input.candidates.map((c) => c.recipeId));
    const sanitized = sanitizeAiRankedCandidates(raw, allowlist, {
      maxResults: input.resultCount,
    });
    return sanitized ?? null;
  } catch {
    return null;
  }
}

// Re-exported so callers can reuse the prompt/sanitizer directly.
export { buildRankPrompt, sanitizeAiRankedCandidates };
