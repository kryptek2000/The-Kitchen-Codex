/**
 * The Kitchen Codex — Ask My Kitchen server-side candidate ranking adapter.
 *
 * Stage B: an OPTIONAL AI reasoning layer over the CLIENT-supplied compact
 * candidate evidence. The server receives ONLY the bounded candidate evidence
 * (never the vault, raw Markdown, instructions, notes, frontmatter, or file
 * paths), ranks it via the AI provider abstraction, and returns a sanitized
 * ranked id list.
 *
 * FAILURE CONTRACT: ranking is an advisory enhancement. If the AI provider is
 * unconfigured, unavailable, throws, or produces malformed/all-invalid output,
 * this returns `null` so the client falls back to deterministic ranking. A
 * ranking failure never converts an otherwise valid local Ask My Kitchen query
 * into a total failure.
 */
import dotenv from "dotenv";
import { resolveRoleCandidates, runWithAiFallback } from "./ai/provider.js";
import type { AiJsonSchema } from "./ai/types.js";
import { sanitizeKitchenIntent, type KitchenIntent } from "../src/utils/kitchenIntent.js";
import {
  buildRankPrompt,
  sanitizeAiRankedCandidates,
  type KitchenCandidateEvidence,
  type RankedKitchenCandidate,
} from "../src/utils/kitchenRanking.js";

dotenv.config();

function buildSchema(): AiJsonSchema {
  return {
    type: "object",
    properties: {
      ranked: {
        type: "array",
        items: {
          type: "object",
          properties: {
            recipeId: { type: "string" },
            score: { type: "number" },
            reason: { type: "string" },
          },
          required: ["recipeId"],
        },
      },
    },
    required: ["ranked"],
  };
}

/**
 * AI structured-output adapter: compact evidence -> raw unknown (sanitized
 * later). Routes through the provider abstraction (`getDefaultAiProvider()
 * .generateStructured`) with the same explicit primary -> fallback model chain,
 * same temperature (0), and the same MINIMAL thinking config. A model that
 * throws or returns empty/unparseable output is logged (redacted) and skipped;
 * the first model that produces a result wins. If every model fails it throws so
 * the caller can return null (deterministic ranking takes over).
 */
async function aiRankWithFallback(input: {
  question: string;
  intent: KitchenIntent;
  candidates: KitchenCandidateEvidence[];
  resultCount: number;
}): Promise<unknown> {
  const schema = buildSchema();
  const { result } = await runWithAiFallback<unknown>({
    candidates: resolveRoleCandidates("kitchenRank"),
    requiredCapabilities: ["structuredOutput"],
    run: (candidate) =>
      candidate.provider.generateStructured(buildRankPrompt(input), schema, {
        model: candidate.model,
        temperature: 0,
        providerOptions: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
      }),
  });
  return result;
}

/**
 * Ranks the supplied candidate evidence with the AI provider when available.
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
  try {
    const raw = await aiRankWithFallback(input);
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
