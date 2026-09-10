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
  kitchenRankRateLimiter,
  kitchenDiscoverRateLimiter,
  createRecipeRateLimiter,
  imageGenerateRateLimiter,
  imagePreviewRateLimiter,
  providerTestRateLimiter,
  getClientIp,
} from "./rateLimiter.js";
import { interpretKitchenQuestionOnServer } from "./kitchenInterpret.js";
import { rankKitchenCandidatesOnServer } from "./kitchenRank.js";
import { discoverKitchenRecipesOnServer } from "./kitchenDiscover.js";
import { getAiProviderStatus } from "./ai/providerStatus.js";
import { buildProviderCatalog } from "./ai/providerCatalog.js";
import { runConnectionTest } from "./ai/connectionTest.js";
import { generateRecipeDraftOnServer, CreateRecipeValidationError } from "./createRecipe.js";
import {
  generateRecipeImagePreview,
  GenerateRecipeImageValidationError,
} from "./recipeImage.js";
import { DeterministicImageProvider, type ImageProvider } from "./ai/imageProvider.js";
import { resolveEffectiveImageSelection } from "./ai/effectiveSelection.js";
import {
  parseTextSelectionHeader,
  parseImageSelectionHeader,
} from "./ai/parseSelectionMetadata.js";
import type { SelectionInput } from "./ai/effectiveSelection.js";
import { ImagePreviewStore, PreviewStoreCapacityError } from "./imagePreviewStore.js";
import { sniffGeneratedImageMime } from "../src/core/recipeImage.js";
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
import { registerSessionKeyRoutes } from "./ai/sessionKeyRoutes.js";
import { createApiErrorHandler } from "./errorHandler.js";
import { RELEASE_VERSION } from "../src/appVersion.js";

export interface CreateAppOptions {
  isProduction: boolean;
  /**
   * TEST SEAM ONLY: overrides the image provider (and its model default).
   * Production default is ALWAYS the real GeminiImageProvider (availability
   * reflects the real GEMINI_API_KEY); the DeterministicImageProvider must never
   * be wired as a production default.
   */
  imageProvider?: ImageProvider;
}

/**
 * Resolves the production image provider + model override for the generate-image
 * route. The DEFAULT (no `imageProvider` option, no server-managed image pin) is
 * ALWAYS the real GeminiImageProvider + its proven default model when image
 * selection is UNSET — the DeterministicImageProvider is a thin test seam and is
 * selected ONLY when explicitly injected via the createApp test option.
 * Server-managed selection (KITCHEN_CODEX_IMAGE_PROVIDER/MODEL) is validated
 * against the image registry; an EXPLICIT but INVALID pin FAILS CLOSED (provider
 * resolves to null, the route returns a distinct bounded not-configured/invalid
 * failure, ZERO provider execution — never a silent Gemini fallback). Being a
 * pure exported helper (exposed independently of `createApp`) makes the default
 * production wiring directly regression-testable without booting a server.
 */
export function resolveImageProvider(opts: Pick<CreateAppOptions, 'imageProvider'>, userSelection?: SelectionInput): {
  provider: ImageProvider | null;
  modelOverride: { model?: string };
  /** True when a PRESENT-but-malformed selection payload was rejected. */
  selectionInvalid: boolean;
} {
  if (opts.imageProvider) {
    // Explicit test seam (DeterministicImageProvider in tests): keep the caller's
    // model default (the seam's own default), only signal a production model is
    // NOT in use.
    return { provider: opts.imageProvider, modelOverride: {}, selectionInvalid: false };
  }
  // Server-managed image selection (or the safe Gemini production default when
  // UNSET). An EXPLICIT invalid pin yields null (fail closed, zero execution).
  // A VALID user selection (no server-managed pin) is honored. An
  // invalid/incapable EXPLICIT user pick ALSO yields null (fail closed, zero
  // execution) — it never falls back to Gemini or any other provider.
  const effective = resolveEffectiveImageSelection(userSelection);
  if (!effective.provider) {
    return { provider: null, modelOverride: {}, selectionInvalid: effective.invalidIntent };
  }
  return { provider: effective.provider, modelOverride: { model: effective.model ?? "" }, selectionInvalid: false };
}

/**
 * Maps a normalized image-provider error to a distinct HTTP response shape.
 * Registered provider normalizations (classifyProviderError / ProviderOperationError
 * subclasses) are NOT collapsed: QUOTA / RATE_LIMIT / TIMEOUT / UNAVAILABLE /
 * BLOCKED / NO_IMAGE / AUTH each yield their own code + bounded message. Returns
 * undefined for anything the generic path should handle. Never leaks raw provider
 * text, prompts, keys, or image bytes.
 */
export function mapImageProviderErrorToHttp(error: unknown): {
  status: number;
  error: string;
  code: string;
  retryAfter?: string;
} | undefined {
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? ((error as { code: string }).code as string)
    : "";
  switch (code) {
    case "QUOTA":
      return { status: 503, error: "Image generation quota has been reached. Please try again later.", code: "IMAGE_PROVIDER_QUOTA" };
    case "RATE_LIMIT":
      return {
        status: 503,
        error: "Image generation is being rate limited. Please wait a moment and try again.",
        code: "IMAGE_PROVIDER_RATE_LIMIT",
        // Preserve the UPSTREAM Retry-After when the provider reported one; if the
        // provider reported a 429 without a header, fall back to the fixed "60".
        ...(typeof (error as { retryAfter?: unknown })?.retryAfter === "string" &&
        (error as { retryAfter?: string }).retryAfter
          ? { retryAfter: (error as { retryAfter: string }).retryAfter }
          : typeof (error as { status?: unknown })?.status === "number" && (error as { status: number }).status === 429
          ? { retryAfter: "60" }
          : {}),
      };
    case "TIMEOUT":
      return { status: 503, error: "Image generation timed out. Please try again.", code: "IMAGE_PROVIDER_TIMEOUT" };
    case "UNAVAILABLE":
      return { status: 503, error: "Image generation is temporarily unavailable. Please try again shortly.", code: "IMAGE_PROVIDER_TEMPORARILY_UNAVAILABLE" };
    case "BLOCKED":
      return { status: 502, error: "The image provider could not generate an image for this recipe. Try adjusting the recipe description or generating again.", code: "IMAGE_PROVIDER_BLOCKED" };
    case "NO_IMAGE":
      return { status: 502, error: "The image provider did not return an image for this recipe. Try generating again.", code: "IMAGE_PROVIDER_NO_IMAGE" };
    case "AUTH":
      return { status: 502, error: "Image generation could not be authorized. Please check the server configuration.", code: "IMAGE_PROVIDER_AUTH" };
    default:
      return undefined;
  }
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

  // BYOK-5B session-key routes are registered BEFORE the global JSON parser so
  // their dedicated 8 KiB body ceiling is actually enforced (a second
  // `express.json()` after the global 2 MiB parser would be skipped).
  registerSessionKeyRoutes(app);

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

      const userSelection = parseTextSelectionHeader(req.headers);

      const recipe = await grabRecipeFromWeb({
        url: cleanUrl,
        rawText: cleanRawText,
        html: cleanHtml,
      }, userSelection);

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

      const userSelection = parseTextSelectionHeader(req.headers);

      const nutrition = await estimateRecipeNutrition({
        title: typeof title === "string" ? title.slice(0, 200) : undefined,
        servings: typeof servings === "number" ? servings : undefined,
        ingredients,
      }, userSelection);

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

      const userSelection = parseTextSelectionHeader(req.headers);

      const result = await recoverRecipeMetadata({
        title: typeof title === "string" ? title.slice(0, 300) : undefined,
        rawMarkdown: typeof rawMarkdown === "string" ? rawMarkdown : undefined,
        ingredients: Array.isArray(ingredients) ? ingredients.slice(0, 100) : undefined,
        instructions: Array.isArray(instructions) ? instructions.slice(0, 100) : undefined,
        notes: typeof notes === "string" ? notes.slice(0, 10000) : undefined,
        existingMetadata: typeof existingMetadata === "object" && existingMetadata !== null ? existingMetadata : undefined,
        targetFields: Array.isArray(targetFields) ? targetFields : undefined,
      }, userSelection);

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

      const userSelection = parseTextSelectionHeader(req.headers);

      const result = await interpretKitchenQuestionOnServer(question, userSelection);
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

      const userSelection = parseTextSelectionHeader(req.headers);

      const ranked = await rankKitchenCandidatesOnServer({
        question,
        intent: sanitizedIntent,
        candidates,
        resultCount,
      }, userSelection);

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

      const userSelection = parseTextSelectionHeader(req.headers);

      const response = await discoverKitchenRecipesOnServer({
        question,
        intent: sanitizedIntent,
        maxResults,
      }, userSelection);

      return res.json(response);
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Kitchen Discovery Error:`, errorMsg);
      return res.json({ ok: false, source: "web", reason: "unavailable", results: [] });
    }
  });

  // Read-only AI provider status/config surface (boolean/capability metadata
  // ONLY — never secrets, token values, or masked substrings). No network probe
  // is performed. Gated like the other AI endpoints so a public host requires a
  // bearer token; when unset (local) it is open.
  app.get("/api/providers", requireAiAccessToken, (_req, res) => {
    res.json({ providers: getAiProviderStatus() });
  });

  // Read-only provider + model CATALOG (BYOK-1): the curated models each text
  // provider can execute (with per-model effective capabilities) plus the
  // production image provider's models/formats/byte limits. Secret-free,
  // network-free, deterministic. Same gate as /api/providers.
  app.get("/api/providers/catalog", requireAiAccessToken, (_req, res) => {
    res.json({ catalog: buildProviderCatalog() });
  });

  // Provider connection test (BYOK-4): performs a REAL, bounded probe against
  // the requested provider's fixed endpoint. Auth-gated + rate-limited. NO
  // retries, NO raw error leakage, NO secret in response. Text providers get a
  // real (minimal) chat call; image providers get a credential check (no
  // generation). Returns { ok, providerId, model, latencyMs } or a bounded
  // { ok:false, providerId, model, code, message }.
  app.post("/api/providers/test-connection", requireAiAccessToken, providerTestRateLimiter, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "Invalid request payload." });
      }

      const { providerId, kind: rawKind, modelId: rawModelId } = req.body;

      // STRICT request schema: wrong types are bounded 400 (never coerced), and
      // identifiers are NEVER truncated into valid-looking values.
      if (typeof providerId !== "string") {
        return res.status(400).json({ error: '"providerId" must be a string.' });
      }
      const cleanProviderId = providerId.trim();
      if (!cleanProviderId) {
        return res.status(400).json({ error: '"providerId" is required.' });
      }
      if (cleanProviderId.length > 64) {
        return res.status(400).json({ error: '"providerId" is too long.' });
      }

      // STRICT kind validation: only the two canonical surfaces are valid. A
      // wrong type / unknown / omitted kind is a bounded 400 — never silently
      // normalized to "text" (which could probe a text provider for an image
      // request).
      if (rawKind !== "text" && rawKind !== "image") {
        return res.status(400).json({ error: '"kind" must be "text" or "image".' });
      }
      const kind = rawKind;

      let modelId: string | undefined;
      if (rawModelId !== undefined) {
        if (typeof rawModelId !== "string") {
          return res.status(400).json({ error: '"modelId" must be a string.' });
        }
        const cleanModelId = rawModelId.trim();
        if (cleanModelId.length > 128) {
          return res.status(400).json({ error: '"modelId" is too long.' });
        }
        modelId = cleanModelId || undefined;
      }

      const result = await runConnectionTest({ providerId: cleanProviderId, kind, modelId });
      // Client-validation failures (arbitrary/unknown model ids) are bounded 4xx:
      // rejected against the server-owned curated model set BEFORE any provider or
      // SDK network call. Operational probe failures stay 200 with a bounded body.
      if (result.ok === false && result.code === "INVALID_MODEL") {
        return res.status(400).json(result);
      }
      return res.json(result);
    } catch {
      return res.status(500).json({
        ok: false,
        providerId: "",
        model: "",
        code: "PROVIDER_ERROR",
        message: "Connection test failed unexpectedly.",
      });
    }
  });

  // Transient generated-image preview store (bounded, TTL 5min, 50MB cap).
  // Foundation for Vault Intelligence Image Recovery: generation ONLY — the
  // canonical asset write + Markdown `image` update belong to the later Save pass.
  const imagePreviewStore = new ImagePreviewStore();

  // Create for Me — explicit recipe invention. Generates a schema-constrained
  // DRAFT and returns it (the client previews/edits and saves via the existing
  // vault write path). NEVER saves, NEVER mutates the vault, NEVER returns a
  // prompt, secret, or raw provider response. Gated + rate-limited like other AI
  // endpoints; no semantic downgrade (unsupported capability -> explicit 503).
  app.post("/api/recipes/generate", requireAiAccessToken, createRecipeRateLimiter, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
      }
      const userSelection = parseTextSelectionHeader(req.headers);

      const result = await generateRecipeDraftOnServer(req.body as any, { userSelection });
      return res.json(result);
    } catch (error: any) {
      if (error instanceof CreateRecipeValidationError || error?.name === "CreateRecipeValidationError") {
        return res.status(400).json({ error: error?.message || "Invalid generation request.", code: "INVALID_REQUEST" });
      }
      if (error?.code === "UNSUPPORTED_CAPABILITY") {
        return res.status(503).json({
          error: "No configured AI provider supports recipe generation.",
          code: "UNSUPPORTED_CAPABILITY",
        });
      }
      // Generic, secret-safe error. Never leak provider secrets / raw errors.
      return res.status(502).json({ error: "Couldn't generate a recipe right now." });
    }
  });

  // Vault Intelligence Image Recovery (Phase 2B): generate a TRANSIENT validated
  // image preview from MINIMUM grounded recipe fields. No canonical save, no
  // Markdown mutation, no prompt persisted/logged. Returns tiny token metadata
  // only (never base64/data-URL bytes). Gated + rate-limited like other AI
  // endpoints.
  //
  // PROVIDER SELECTION (truthful): unset image selection uses the real
  // GeminiImageProvider; availability reflects the actual GEMINI_API_KEY and an
  // unavailable provider is an explicit 503 with a DISTINCT not-configured code
  // (never a silent deterministic fallback). An EXPLICIT but INVALID server-managed
  // image pin FAILS CLOSED the same way (no provider resolves -> bounded
  // not-configured/invalid 503, ZERO Gemini invocation). The DeterministicImageProvider is
  // reachable ONLY through the createApp test seam. A VALID per-request USER
  // selection (header) is honored ONLY when no server-managed pin exists; an
  // invalid/incapable EXPLICIT user pick ALSO FAILS CLOSED (no provider
  // resolves, ZERO execution) — it never falls back to Gemini or any other
  // provider.
  app.post("/api/recipes/image/generate", requireAiAccessToken, imageGenerateRateLimiter, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
      }
      const userSelection = parseImageSelectionHeader(req.headers);
      const { provider: imageProvider, modelOverride: imageModelOverride, selectionInvalid } = resolveImageProvider(opts, userSelection);
      if (!imageProvider) {
        // A PRESENT-but-malformed selection payload is a distinct bounded
        // selection-invalid failure (never a provider attempt). Otherwise an
        // EXPLICIT but invalid server-managed image pin (unknown/disabled
        // provider or uncurated model) FAILS CLOSED. Bounded, distinct from
        // transient upstream failures; ZERO provider execution — never a silent
        // Gemini fallback and no surprise cross-provider cost.
        return res.status(503).json({
          error: selectionInvalid
            ? "The AI provider selection was invalid. No image was generated."
            : "The configured image provider selection is invalid. No image was generated.",
          code: selectionInvalid ? "IMAGE_SELECTION_INVALID" : "IMAGE_PROVIDER_NOT_CONFIGURED",
        });
      }
      if (!imageProvider.isAvailable()) {
        // Distinct code from the transient-upstream failure below: the client can
        // truthfully tell "provider not configured" from "provider temporarily
        // unavailable" (a real Gemini key may be configured but the upstream call
        // hit a QUOTA/RATE_LIMIT/TIMEOUT/UNAVAILABLE condition).
        return res.status(503).json({
          error: "No image generation provider is configured on the server.",
          code: "IMAGE_PROVIDER_NOT_CONFIGURED",
        });
      }
      const result = await generateRecipeImagePreview(req.body, imageProvider, imagePreviewStore, imageModelOverride);
      return res.json(result);
    } catch (error: any) {
      if (error instanceof GenerateRecipeImageValidationError || error?.name === "GenerateRecipeImageValidationError") {
        return res.status(400).json({ error: error?.message || "Invalid image generation request.", code: "INVALID_REQUEST" });
      }
      if (error instanceof PreviewStoreCapacityError || error?.name === "PreviewStoreCapacityError") {
        return res.status(503).json({ error: "Image preview store is at capacity. Try again shortly.", code: "PREVIEW_CAPACITY" });
      }
      if (error?.name === "ImageValidationError" || error?.code === "INVALID_RESPONSE") {
        return res.status(502).json({ error: "Generated image was not usable.", code: "INVALID_IMAGE" });
      }
      // Distinct normalized outcomes are mapped to DISTINCT codes (never collapsed
      // into one broad "temporarily unavailable"), so the client can tell quota vs
      // rate-limit vs timeout vs unavailable vs blocked/no-image apart.
      // All provider error subclasses carry a normalized code in `error.code`.
      const mapped = mapImageProviderErrorToHttp(error);
      if (mapped) {
        if (mapped.retryAfter) res.setHeader("Retry-After", mapped.retryAfter);
        return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
      }
      // Generic, secret-safe error. Never leak provider secrets / raw errors / prompt.
      return res.status(502).json({ error: "Couldn't generate an image right now." });
    }
  });

  // Streams a transient generated-image preview by opaque token. Multi-read until
  // the token expires; exact safe Content-Type (never caller-supplied MIME);
  // Cache-Control: no-store + nosniff; unknown/expired tokens are 404/410.
  app.get("/api/recipes/image/preview/:token", requireAiAccessToken, imagePreviewRateLimiter, (req, res) => {
    const token = String(req.params?.token ?? "");
    if (!token || token.length > 512) {
      return res.status(404).json({ error: "Preview not found." });
    }
    const record = imagePreviewStore.get(token);
    if (!record) {
      // Unknown and expired tokens are both inaccessible; no state oracle is
      // exposed, so inaccessible previews always return 404.
      return res.status(404).json({ error: "Preview not found or expired." });
    }
    const detected = sniffGeneratedImageMime(record.bytes);
    const contentType = detected ?? record.contentType;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(record.bytes.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).end(Buffer.from(record.bytes));
  });

  // Invalidates a transient generated-image preview token (preview lifecycle
  // after a successful canonical save). Token-shaped lookups only; the response
  // never distinguishes unknown vs removed vs expired (no existence oracle).
  // Gated + rate-limited like the other preview operations.
  app.delete("/api/recipes/image/preview/:token", requireAiAccessToken, imagePreviewRateLimiter, (req, res) => {
    const token = String(req.params?.token ?? "");
    if (!token || token.length > 512) {
      return res.status(404).json({ error: "Preview not found." });
    }
    imagePreviewStore.remove(token);
    return res.status(200).json({ ok: true });
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
