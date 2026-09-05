/**
 * The Kitchen Codex — HTTP API application factory.
 *
 * Builds the Express `app` with security headers, JSON parsing, every `/api`
 * route, and the centralized error handler. Vite (dev) and static (prod) asset
 * serving are intentionally NOT wired here so the API can be driven hermetically
 * in tests without booting a Vite server; `server.ts` attaches them after
 * `createApp()` and before `listen()`.
 */
import express from "express";
import { grabRecipeFromWeb } from "./recipeGrabber.js";
import { estimateRecipeNutrition } from "./nutritionEstimator.js";
import { recoverRecipeMetadata } from "./metadataRecovery.js";
import {
  recipeImportRateLimiter,
  nutritionEstimateRateLimiter,
  metadataRecoveryRateLimiter,
  kitchenInterpretRateLimiter,
  kitchenAnswerRateLimiter,
  kitchenRankRateLimiter,
  kitchenDiscoverRateLimiter,
  getClientIp,
} from "./rateLimiter.js";
import { interpretKitchenQuestionOnServer } from "./kitchenInterpret.js";
import { answerKitchenQuestionOnServer } from "./kitchenAnswer.js";
import { rankKitchenCandidatesOnServer } from "./kitchenRank.js";
import { discoverKitchenRecipesOnServer } from "./kitchenDiscover.js";
import {
  sanitizeAnswerEvidenceList,
  MAX_ANSWER_RECIPES,
} from "../src/utils/kitchenAnswer.js";
import {
  sanitizeCandidateEvidenceList,
  MAX_KITCHEN_CANDIDATES,
  MAX_RANKED_RESULTS,
} from "../src/utils/kitchenRanking.js";
import {
  MAX_DISCOVERY_QUESTION_LENGTH,
  MAX_WEB_RESULTS,
} from "../src/utils/kitchenDiscovery.js";
import { sanitizeKitchenIntent } from "../src/utils/kitchenIntent.js";
import { safeFetchImage, WafProtectionError } from "./ssrfGuard.js";
import { createSecurityMiddleware } from "./securityHeaders.js";
import { requireAiAccessToken } from "./aiEndpointAuth.js";
import { createApiErrorHandler } from "./errorHandler.js";
import { RELEASE_VERSION } from "../src/appVersion.js";

export interface CreateAppOptions {
  isProduction: boolean;
}

/**
 * Builds the configured Express application containing security headers, JSON
 * parsing, all `/api` routes, and the final centralized error handler.
 */
export function createApp(opts: CreateAppOptions): express.Express {
  const app = express();

  // Security headers (X-Content-Type-Options, clickjacking protection, referrer
  // policy, and a production-only Content Security Policy).
  app.use(createSecurityMiddleware(opts.isProduction));

  // Trust proxy configuration.
  //
  // X-Forwarded-For is client-supplied and must NOT be trusted by default, or a
  // client can spoof it to rotate the source IP and bypass rate limiting.
  // - Locally (no proxy): leave TRUST_PROXY unset -> Express uses the direct
  //   socket IP; X-Forwarded-For is ignored entirely.
  // - Behind a trusted reverse proxy / Cloud Run: set TRUST_PROXY to the number
  //   of trusted proxy hops (e.g. TRUST_PROXY=1) so Express derives the real
  //   client IP from the proxy-added header while ignoring spoofed hops.
  app.set("trust proxy", (() => {
    const raw = (process.env.TRUST_PROXY || "").trim();
    if (raw === "") return false;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : raw;
  })());

  // Middleware for parsing JSON with request size bounds
  app.use(express.json({ limit: "2mb" }));

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", version: RELEASE_VERSION, timestamp: new Date().toISOString() });
  });

  // Recipe Grabber Web Importer endpoint with rate limiting & input validation
  app.post("/api/grab-recipe", requireAiAccessToken, recipeImportRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({
          error: "Invalid request payload.",
        });
      }

      const { url, rawText, html } = req.body;

      // Validate URL field if provided
      let cleanUrl: string | undefined;
      if (url !== undefined && url !== null) {
        if (typeof url !== "string") {
          return res.status(400).json({ error: "URL parameter must be a string." });
        }
        const trimmedUrl = url.trim();
        if (trimmedUrl.length > 2048) {
          return res.status(400).json({ error: "URL exceeds maximum allowed length (2048 characters)." });
        }
        if (trimmedUrl.length > 0) {
          if (!/^https?:\/\//i.test(trimmedUrl)) {
            return res.status(400).json({ error: "Only HTTP and HTTPS URLs are supported." });
          }
          cleanUrl = trimmedUrl;
        }
      }

      // Validate rawText field if provided
      let cleanRawText: string | undefined;
      if (rawText !== undefined && rawText !== null) {
        if (typeof rawText !== "string") {
          return res.status(400).json({ error: "rawText parameter must be a string." });
        }
        const trimmedText = rawText.trim();
        if (trimmedText.length > 100000) {
          return res.status(400).json({ error: "Recipe text exceeds maximum allowed length (100,000 characters)." });
        }
        if (trimmedText.length > 0) {
          cleanRawText = trimmedText;
        }
      }

      // Validate html field if provided
      let cleanHtml: string | undefined;
      if (html !== undefined && html !== null) {
        if (typeof html !== "string") {
          return res.status(400).json({ error: "html parameter must be a string." });
        }
        const trimmedHtml = html.trim();
        if (trimmedHtml.length > 500000) {
          return res.status(400).json({ error: "HTML content exceeds maximum allowed length (500,000 characters)." });
        }
        if (trimmedHtml.length > 0) {
          cleanHtml = trimmedHtml;
        }
      }

      if (!cleanUrl && !cleanRawText && !cleanHtml) {
        return res.status(400).json({
          error: "Please provide a valid website URL or recipe text to import.",
        });
      }

      const recipe = await grabRecipeFromWeb({
        url: cleanUrl,
        rawText: cleanRawText,
        html: cleanHtml,
      });

      return res.json({ success: true, recipe });
    } catch (error: any) {
      const errorMsg = error?.message || "";
      const isWafBlock =
        error instanceof WafProtectionError ||
        error?.code === "WAF_PROTECTION_BLOCKED" ||
        errorMsg.includes("WAF_PROTECTION_BLOCKED") ||
        errorMsg.includes("bot protection") ||
        errorMsg.includes("HTTP 402") ||
        errorMsg.includes("HTTP 403") ||
        errorMsg.includes("HTTP 429");

      const isSecurityOrClientError =
        isWafBlock ||
        errorMsg.includes("restricted") ||
        errorMsg.includes("permitted") ||
        errorMsg.includes("Invalid URL") ||
        errorMsg.includes("credentials") ||
        errorMsg.includes("resolve") ||
        errorMsg.includes("timed out") ||
        errorMsg.includes("8s limit") ||
        errorMsg.includes("2MB limit") ||
        errorMsg.includes("size exceeds");

      if (isSecurityOrClientError) {
        console.warn(`[${new Date().toISOString()}] [Client: ${clientIp}] Recipe Import Blocked/Rejected: ${errorMsg}`);
      } else {
        console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Recipe Import Unexpected Error:`, error);
      }

      if (isWafBlock) {
        return res.status(403).json({
          success: false,
          error: "WAF_PROTECTION_BLOCKED",
          code: "WAF_PROTECTION_BLOCKED",
          message:
            "This recipe website is protected by automated bot protection or a Web Application Firewall (Cloudflare/Akamai). Please use the 'Paste Recipe Text / HTML' tab to import directly.",
        });
      }

      // Return safe, user-friendly error messages without leaking internal topology
      if (
        errorMsg.includes("restricted") ||
        errorMsg.includes("permitted") ||
        errorMsg.includes("Invalid URL") ||
        errorMsg.includes("credentials") ||
        errorMsg.includes("resolve")
      ) {
        return res.status(400).json({
          error: "The provided URL is invalid or cannot be fetched.",
        });
      }

      if (errorMsg.includes("timed out") || errorMsg.includes("8s limit")) {
        return res.status(504).json({
          error: "The recipe website took too long to respond. Please try pasting the recipe text directly.",
        });
      }

      if (errorMsg.includes("2MB limit") || errorMsg.includes("size exceeds")) {
        return res.status(413).json({
          error: "The target website response is too large to process.",
        });
      }

      return res.status(500).json({
        error: "Failed to extract recipe from the provided source. Please verify the URL or paste the recipe text directly.",
      });
    }
  });

  // Safe Image Downloader & Proxy endpoint with rate limiting & SSRF protection
  app.post("/api/download-image", recipeImportRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      const rawUrl = req.body?.imageUrl || req.body?.url;
      if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
        return res.status(400).json({ error: "Missing or invalid imageUrl parameter." });
      }

      const trimmedUrl = rawUrl.trim();
      if (!/^https?:\/\//i.test(trimmedUrl)) {
        return res.status(400).json({ error: "Only HTTP and HTTPS URLs are supported." });
      }

      const { buffer, contentType, finalUrl } = await safeFetchImage(trimmedUrl);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("X-Final-URL", finalUrl);
      return res.status(200).send(buffer);
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.warn(`[${new Date().toISOString()}] [Client: ${clientIp}] Image download failed:`, errorMsg);

      if (
        errorMsg.includes("restricted") ||
        errorMsg.includes("permitted") ||
        errorMsg.includes("Invalid URL") ||
        errorMsg.includes("credentials") ||
        errorMsg.includes("resolve")
      ) {
        return res.status(400).json({ error: "The provided image URL is invalid or restricted." });
      }

      if (errorMsg.includes("non-image response")) {
        return res.status(415).json({
          error:
            "The remote server did not return an image file. Please provide a direct link to a JPEG, PNG, WebP, GIF, or AVIF image.",
        });
      }

      if (errorMsg.includes("timed out") || errorMsg.includes("limit")) {
        return res.status(504).json({ error: errorMsg });
      }

      return res.status(500).json({ error: "Failed to download image from the remote server." });
    }
  });

  app.get("/api/proxy-image", recipeImportRateLimiter, async (req, res) => {
    const rawUrl = req.query?.url;
    if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
      return res.status(400).json({ error: "Missing url parameter." });
    }

    try {
      const { buffer, contentType } = await safeFetchImage(rawUrl.trim());
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.status(200).send(buffer);
    } catch (err: any) {
      return res.status(400).json({ error: "Could not proxy image." });
    }
  });

  // AI Nutrition Estimator endpoint with rate limiting & input validation
  app.post("/api/estimate-nutrition", requireAiAccessToken, nutritionEstimateRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({
          error: "Invalid request payload.",
        });
      }

      const { servings, ingredients } = req.body;
      const rawTitle = req.body.title || req.body.recipeTitle;
      const title = typeof rawTitle === "string" ? rawTitle.slice(0, 200) : undefined;

      if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({
          error: "Please provide a list of ingredients to estimate nutrition.",
        });
      }

      if (ingredients.length > 100) {
        return res.status(400).json({
          error: "Too many ingredients provided. Maximum allowed is 100 ingredients.",
        });
      }

      const nutrition = await estimateRecipeNutrition({
        title: typeof title === "string" ? title.slice(0, 200) : undefined,
        servings: typeof servings === "number" ? servings : undefined,
        ingredients,
      });

      return res.json({ success: true, nutrition });
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Nutrition Estimation Error:`, errorMsg);

      if (errorMsg.includes("not configured") || errorMsg.includes("GEMINI_API_KEY")) {
        return res.status(503).json({
          error: "Nutrition estimation service is not configured on the server. Please check your environment variables.",
        });
      }

      if (errorMsg.includes("provide a list") || errorMsg.includes("valid ingredient") || errorMsg.includes("Maximum allowed")) {
        return res.status(400).json({
          error: errorMsg,
        });
      }

      if (errorMsg.includes("quota") || errorMsg.includes("demand") || errorMsg.includes("temporarily unavailable") || errorMsg.includes("RESOURCE_EXHAUSTED")) {
        return res.status(503).json({
          error: "Nutrition estimation is temporarily unavailable. Please try again in a moment.",
        });
      }

      return res.status(500).json({
        error: "An unexpected error occurred during nutrition estimation. Please try again.",
      });
    }
  });

  // AI Vault Intelligence Metadata Recovery endpoint with rate limiting & validation
  app.post("/api/recover-metadata", requireAiAccessToken, metadataRecoveryRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({
          error: "Invalid request payload.",
        });
      }

      const { title, rawMarkdown, ingredients, instructions, notes, existingMetadata, targetFields } = req.body;

      if (!title && !rawMarkdown && (!ingredients || ingredients.length === 0)) {
        return res.status(400).json({
          error: "Please provide a recipe title, raw markdown, or ingredients to recover metadata.",
        });
      }

      // Protect against oversized payloads
      if (rawMarkdown && typeof rawMarkdown === "string" && rawMarkdown.length > 100000) {
        return res.status(400).json({
          error: "Recipe content exceeds maximum allowed length (100,000 characters).",
        });
      }

      const result = await recoverRecipeMetadata({
        title: typeof title === "string" ? title.slice(0, 300) : undefined,
        rawMarkdown: typeof rawMarkdown === "string" ? rawMarkdown : undefined,
        ingredients: Array.isArray(ingredients) ? ingredients.slice(0, 100) : undefined,
        instructions: Array.isArray(instructions) ? instructions.slice(0, 100) : undefined,
        notes: typeof notes === "string" ? notes.slice(0, 10000) : undefined,
        existingMetadata: typeof existingMetadata === "object" && existingMetadata !== null ? existingMetadata : undefined,
        targetFields: Array.isArray(targetFields) ? targetFields : undefined,
      });

      return res.json({ success: true, recovered: result });
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Metadata Recovery Error:`, errorMsg);

      return res.status(500).json({
        error: "An unexpected error occurred during metadata recovery. Please try again.",
      });
    }
  });

  // Ask My Kitchen question interpretation endpoint with rate limiting & input
  // validation. Accepts ONLY a question (no recipe/vault data), interprets it
  // into a structured KitchenQuery, and returns it: the client performs the
  // deterministic local retrieval (searchKitchenRecipes).
  app.post("/api/kitchen/interpret", requireAiAccessToken, kitchenInterpretRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({
          ok: false,
          error: "Invalid request payload.",
        });
      }

      const rawQuestion = req.body.question;
      if (typeof rawQuestion !== "string") {
        return res.status(400).json({
          ok: false,
          error: '"question" must be a string.',
        });
      }

      const question = rawQuestion.trim();
      if (!question) {
        return res.status(400).json({
          ok: false,
          error: '"question" is required.',
        });
      }
      if (question.length > 500) {
        return res.status(400).json({
          ok: false,
          error: '"question" exceeds maximum length (500 characters).',
        });
      }

      const result = await interpretKitchenQuestionOnServer(question);
      if (!result.ok) {
        // If the AI interpreter was present but failed to produce a usable query,
        // the problem is an upstream/model failure, not the user's wording — so
        // surface an unavailable-service status instead of "could not understand".
        if (result.aiAttempted && result.aiFailed) {
          return res.status(503).json({
            ok: false,
            source: result.source,
            error: "The interpretation service is temporarily unavailable. Please try again.",
          });
        }
        return res.status(422).json({
          ok: false,
          source: result.source,
          error: result.error,
        });
      }

      return res.json({
        ok: true,
        source: result.source,
        intent: result.intent,
        aiAttempted: result.aiAttempted === true,
        aiFailed: result.aiFailed === true,
      });
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Kitchen Interpretation Error:`, errorMsg);
      return res.status(500).json({
        ok: false,
        error: "An unexpected error occurred while interpreting the question. Please try again.",
      });
    }
  });

  // Ask My Kitchen grounded answer endpoint with rate limiting & input
  // validation. Accepts a question, the sanitized query, and a compact evidence
  // list derived from DETERMINISTIC retrieval — never arbitrary recipe objects.
  // The model only grounds on the retrieved allowlist; the vault is never sent.
  app.post("/api/kitchen/answer", requireAiAccessToken, kitchenAnswerRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({
          ok: false,
          error: "Invalid request payload.",
        });
      }

      const rawQuestion = req.body.question;
      if (typeof rawQuestion !== "string") {
        return res.status(400).json({ ok: false, error: '"question" must be a string.' });
      }
      const question = rawQuestion.trim();
      if (!question) {
        return res.status(400).json({ ok: false, error: '"question" is required.' });
      }
      if (question.length > 500) {
        return res.status(400).json({ ok: false, error: '"question" exceeds maximum length (500 characters).' });
      }

      if (!req.body.query || typeof req.body.query !== "object" || Array.isArray(req.body.query)) {
        return res.status(400).json({ ok: false, error: '"query" must be an object.' });
      }

      if (!Array.isArray(req.body.results)) {
        return res.status(400).json({ ok: false, error: '"results" must be an array.' });
      }
      if (req.body.results.length > MAX_ANSWER_RECIPES) {
        return res.status(400).json({
          ok: false,
          error: `"results" exceeds maximum length (${MAX_ANSWER_RECIPES}).`,
        });
      }

      const evidence = sanitizeAnswerEvidenceList(req.body.results);
      const answer = await answerKitchenQuestionOnServer(question, req.body.query, evidence);

      return res.json({
        ok: answer.ok,
        noMatches: answer.noMatches,
        summary: answer.summary,
        items: answer.items,
        source: answer.source,
      });
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Kitchen Answer Error:`, errorMsg);
      return res.status(500).json({
        ok: false,
        error: "An unexpected error occurred while answering the question. Please try again.",
      });
    }
  });

  // Ask My Kitchen candidate ranking endpoint with rate limiting & input
  // validation. The client already built the DETERMINISTIC candidate set locally;
  // this endpoint only ranks that compact evidence (never sees the vault).
  // Ranking is advisory: a provider failure must NOT fail the local request, so
  // this route returns a safe non-sensitive failure for the client to degrade.
  app.post("/api/kitchen/rank", requireAiAccessToken, kitchenRankRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ ok: false, error: "Invalid request payload." });
      }

      const rawQuestion = req.body.question;
      if (typeof rawQuestion !== "string") {
        return res.status(400).json({ ok: false, error: '"question" must be a string.' });
      }
      const question = rawQuestion.trim();
      if (!question) {
        return res.status(400).json({ ok: false, error: '"question" is required.' });
      }
      if (question.length > 500) {
        return res.status(400).json({ ok: false, error: '"question" exceeds maximum length (500 characters).' });
      }

      if (!Array.isArray(req.body.candidates)) {
        return res.status(400).json({ ok: false, error: '"candidates" must be an array.' });
      }
      if (req.body.candidates.length > MAX_KITCHEN_CANDIDATES) {
        return res.status(400).json({
          ok: false,
          error: `"candidates" exceeds maximum length (${MAX_KITCHEN_CANDIDATES}).`,
        });
      }

      const candidates = sanitizeCandidateEvidenceList(req.body.candidates, {
        maxCandidates: MAX_KITCHEN_CANDIDATES,
      });
      if (candidates.length === 0) {
        return res.status(400).json({ ok: false, error: '"candidates" must contain at least one valid candidate.' });
      }

      // Re-sanitize the intent defensively (never trust client intent). If it is
      // invalid, fall back to a minimal vault intent so ranking still runs.
      const sanitizedIntent = sanitizeKitchenIntent(req.body.intent) ?? {
        version: 1,
        intent: "find_recipes",
        source: "vault",
        constraints: {},
        preferences: {},
        requiresClarification: false,
      };

      const rawResultCount = req.body.resultCount;
      const resultCount =
        typeof rawResultCount === "number" && Number.isFinite(rawResultCount)
          ? Math.max(1, Math.min(MAX_RANKED_RESULTS, Math.round(rawResultCount)))
          : MAX_RANKED_RESULTS;

      const ranked = await rankKitchenCandidatesOnServer({
        question,
        intent: sanitizedIntent,
        candidates,
        resultCount,
      });

      if (!ranked) {
        return res.json({ ok: false, source: "deterministic" });
      }

      return res.json({ ok: true, source: "ai", ranked });
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Kitchen Rank Error:`, errorMsg);
      return res.json({ ok: false, source: "deterministic" });
    }
  });

  // Ask My Kitchen web discovery endpoint with rate limiting & input validation.
  // Discovery is QUERY-ONLY: it never accepts or fetches an arbitrary URL target,
  // never accesses the vault/filesystem, and never turns a web result into a
  // Recipe. Result URLs come only from provider grounding (no hallucinated URLs).
  app.post("/api/kitchen/discover", requireAiAccessToken, kitchenDiscoverRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ ok: false, source: "web", reason: "unavailable", results: [] });
      }

      const rawQuestion = req.body.question;
      if (typeof rawQuestion !== "string") {
        return res.status(400).json({ ok: false, source: "web", reason: "unavailable", results: [] });
      }
      const question = rawQuestion.trim();
      if (!question) {
        return res.status(400).json({ ok: false, source: "web", reason: "unavailable", results: [] });
      }
      if (question.length > MAX_DISCOVERY_QUESTION_LENGTH) {
        return res.status(400).json({
          ok: false,
          source: "web",
          reason: "unavailable",
          results: [],
        });
      }

      const sanitizedIntent = sanitizeKitchenIntent(req.body.intent);
      if (!sanitizedIntent) {
        return res.status(400).json({ ok: false, source: "web", reason: "unavailable", results: [] });
      }

      const rawMax = req.body.maxResults;
      const maxResults =
        typeof rawMax === "number" && Number.isFinite(rawMax)
          ? Math.max(1, Math.min(MAX_WEB_RESULTS, Math.round(rawMax)))
          : MAX_WEB_RESULTS;

      const response = await discoverKitchenRecipesOnServer({
        question,
        intent: sanitizedIntent,
        maxResults,
      });

      return res.json(response);
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Kitchen Discovery Error:`, errorMsg);
      return res.json({ ok: false, source: "web", reason: "unavailable", results: [] });
    }
  });

  // JSON 404 for unknown API routes so the client always gets JSON, never an
  // Express HTML error page.
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Centralized error handler must be the last middleware so it also catches
  // malformed-JSON errors thrown by `express.json()` above.
  app.use(createApiErrorHandler());

  return app;
}
