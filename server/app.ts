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
import { resolveIngredientFoodsOnServer } from "./nutritionResolve.js";
import { recoverRecipeMetadata } from "./metadataRecovery.js";
import {
  recipeImportRateLimiter,
  nutritionEstimateRateLimiter,
  nutritionResolveRateLimiter,
  metadataRecoveryRateLimiter,
  kitchenInterpretRateLimiter,
  kitchenRankRateLimiter,
  kitchenDiscoverRateLimiter,
  createRecipeRateLimiter,
  imageGenerateRateLimiter,
  imagePreviewRateLimiter,
  representativeImageSearchRateLimiter,
  representativeImageThumbnailRateLimiter,
  representativeImageSelectRateLimiter,
  providerTestRateLimiter,
  capabilityVerifyRateLimiter,
  recipeVerifyRateLimiter,
  getClientIp,
} from "./rateLimiter.js";
import { interpretKitchenQuestionOnServer } from "./kitchenInterpret.js";
import { rankKitchenCandidatesOnServer } from "./kitchenRank.js";
import { discoverKitchenRecipesOnServer } from "./kitchenDiscover.js";
import { getAiProviderStatus } from "./ai/providerStatus.js";
import { buildProviderCatalog } from "./ai/providerCatalog.js";
import { refreshOpenRouterCatalog } from "./ai/openRouterCatalog.js";
import { runConnectionTest } from "./ai/connectionTest.js";
import {
  verifyOpenRouterModelCapability,
  verifyOpenRouterRecipeGenerationCapability,
  type CapabilityVerificationErrorCode,
} from "./ai/capabilityVerification.js";
import {
  generateRecipeDraftOnServer,
  isRecipeGenerationNotVerifiedSelection,
  CreateRecipeValidationError,
} from "./createRecipe.js";
import {
  generateRecipeImagePreview,
  validateGenerateRecipeImageRequest,
  validateImageQuoteRequest,
  canonicalImageRequestBinding,
  imageVaultScope,
  GenerateRecipeImageValidationError,
} from "./recipeImage.js";
import { DeterministicImageProvider, type ImageProvider } from "./ai/imageProvider.js";
import { resolveEffectiveImageSelection, textSelectionPricingBlock } from "./ai/effectiveSelection.js";
import { findRegisteredImageProvider } from "./ai/imageProviderRegistry.js";
import { imagePricingTruth } from "./ai/imagePricing.js";
import type { CredentialSource } from "./ai/credentialResolver.js";
import {
  ImageGenerationAuthorizationStore,
  ImageGenerationAuthorizationCapacityError,
} from "./imageGenerationAuthorization.js";
import {
  parseTextSelectionHeader,
  parseImageSelectionHeader,
} from "./ai/parseSelectionMetadata.js";
import type { SelectionInput } from "./ai/effectiveSelection.js";
import {
  ImagePreviewStore,
  PreviewStoreCapacityError,
  type ImagePreviewReservation,
} from "./imagePreviewStore.js";
import { getCredentialGeneration } from "./ai/capabilityVerificationStore.js";
import { buildRepresentativeImageQuery, sanitizeRepresentativeSearchTerms } from "../src/core/representativeImage.js";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  RepresentativeImageCandidateStore,
  RepresentativeImageSelectionError,
  fetchRepresentativeThumbnail,
  searchRepresentativeImages,
  selectRepresentativeImage,
} from "./representativeImage.js";
import {
  sniffGeneratedImageMime,
  MAX_GENERATED_IMAGE_BYTES,
} from "../src/core/recipeImage.js";
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
  /**
   * TEST SEAM ONLY: overrides the transient preview store so capacity behavior
   * (reservations, full store) is exercisable at the route level. Production
   * always constructs its own bounded store.
   */
  imagePreviewStore?: ImagePreviewStore;
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
  /** WHOSE credential authorizes the effective provider (never inferred). */
  credentialSource: CredentialSource;
  /** True when a PRESENT-but-malformed selection payload was rejected. */
  selectionInvalid: boolean;
  /** v0.8.0: set when a FREE-acknowledged selection is blocked (fail closed). */
  pricingBlocked?: string;
  pricingMessage?: string;
} {
  if (opts.imageProvider) {
    // Explicit test seam (DeterministicImageProvider in tests): keep the caller's
    // model default (the seam's own default), only signal a production model is
    // NOT in use.
    return {
      provider: opts.imageProvider,
      modelOverride: {},
      credentialSource: "server_environment",
      selectionInvalid: false,
    };
  }
  // Server-managed image selection (or the safe Gemini production default when
  // UNSET). An EXPLICIT invalid pin yields null (fail closed, zero execution).
  // A VALID user selection (no server-managed pin) is honored. An
  // invalid/incapable EXPLICIT user pick ALSO yields null (fail closed, zero
  // execution) — it never falls back to Gemini or any other provider.
  const effective = resolveEffectiveImageSelection(userSelection);
  if (!effective.provider) {
    return {
      provider: null,
      modelOverride: {},
      credentialSource: effective.credentialSource,
      selectionInvalid: effective.invalidIntent,
      ...(effective.pricingBlocked ? { pricingBlocked: effective.pricingBlocked } : {}),
      ...(effective.pricingMessage ? { pricingMessage: effective.pricingMessage } : {}),
    };
  }
  return {
    provider: effective.provider,
    modelOverride: { model: effective.model ?? "" },
    credentialSource: effective.credentialSource,
    selectionInvalid: false,
  };
}

/**
 * The exact model an effective image request will execute: the resolved override
 * when present, otherwise the registered provider's curated default model. Used
 * for pricing truth and authorization binding (never a client-supplied value).
 */
export function effectiveImageModel(provider: ImageProvider, modelOverride: { model?: string }): string {
  if (modelOverride.model) return modelOverride.model;
  return findRegisteredImageProvider(provider.id)?.defaultModel ?? "";
}

/**
 * v0.8.0 FLAG fix: a TEXT pricing guard middleware. When the client's TEXT
 * selection was acknowledged FREE but the current trusted catalog reports it as
 * non-free (or pricing cannot currently be verified), the request is rejected
 * with a bounded 409 BEFORE any provider work. This guarantees the reason
 * reaches the HTTP response for every text route instead of being dropped during
 * candidate resolution. No provider call, no fallback, no spend.
 */
const textPricingGuard: express.RequestHandler = (req, res, next) => {
  const block = textSelectionPricingBlock(parseTextSelectionHeader(req.headers));
  if (block) {
    res.status(409).json({ error: block.message, code: block.code });
    return;
  }
  next();
};

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
 * Bounded HTTP status for a failed capability-verification result. Gate failures
 * (pricing/model/credential) are 4xx/409; a probe that RAN but did not satisfy the
 * strict contract is a bounded 422. Never leaks provider text.
 */
export function capabilityVerificationHttpStatus(code: CapabilityVerificationErrorCode): number {
  switch (code) {
    case "INVALID_MODEL":
    case "CREDENTIAL_SOURCE_INVALID":
      return 400;
    case "MODEL_NOT_FOUND":
      return 404;
    case "MODEL_CAPABILITY_UNVERIFIED":
      return 422;
    case "CREDENTIAL_SOURCE_UNAVAILABLE":
    case "SESSION_BYOK_UNAVAILABLE":
      return 503;
    case "MODEL_NOT_VERIFIED_FREE":
    case "MODEL_PRICING_UNVERIFIED":
    case "MODEL_PRICING_CHANGED":
    case "MODEL_ROUTER_NOT_SUPPORTED":
    case "OPERATOR_PIN":
    case "SESSION_CREDENTIAL_MISSING":
    default:
      return 409;
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
  app.post("/api/grab-recipe", requireAiAccessToken, textPricingGuard, recipeImportRateLimiter, async (req, res) => {
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
  app.post("/api/estimate-nutrition", requireAiAccessToken, textPricingGuard, nutritionEstimateRateLimiter, async (req, res) => {
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

  // AI-assisted USDA resolution endpoint (advisory only) with rate limiting &
  // input validation. The client sends ONLY bounded unresolved-ingredient text;
  // the response carries advisory interpretation + USDA search phrases and NO
  // authority (no FDC id, nutrient amount, mass, portion, digest, or Apply
  // token). The client feeds the phrases back through the pinned local USDA
  // catalog + the existing deterministic confidence contract.
  app.post("/api/nutrition/resolve-ingredients", requireAiAccessToken, textPricingGuard, nutritionResolveRateLimiter, async (req, res) => {
    const clientIp = getClientIp(req);

    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ ok: false, error: "Invalid request payload." });
      }
      if (!Array.isArray(req.body.ingredients) || req.body.ingredients.length === 0) {
        return res.status(400).json({ ok: false, error: '"ingredients" must be a non-empty array.' });
      }
      if (req.body.ingredients.length > 25) {
        return res.status(400).json({ ok: false, error: '"ingredients" exceeds maximum length (25).' });
      }

      const userSelection = parseTextSelectionHeader(req.headers);
      const result = await resolveIngredientFoodsOnServer(req.body.ingredients, userSelection);

      if (result.ok !== true) {
        const failure = result as {
          readonly ok: false;
          readonly code: string;
          readonly aiAttempted: boolean;
          readonly aiFailed: boolean;
        };
        if (failure.code === "invalid_request") {
          return res.status(400).json({ ok: false, error: "Invalid resolution request." });
        }
        // AI is an optional assistant: an unavailable/failed resolver is a
        // degradable service state, never a hard failure of the nutrition flow.
        return res.status(503).json({
          ok: false,
          aiAttempted: failure.aiAttempted === true,
          aiFailed: failure.aiFailed === true,
          error: "AI assistance is unavailable. You can continue with USDA search manually.",
        });
      }

      return res.json({
        ok: true,
        version: result.version,
        suggestions: result.suggestions,
        aiAttempted: true,
      });
    } catch (error: any) {
      const errorMsg = error?.message || "";
      console.error(`[${new Date().toISOString()}] [Client: ${clientIp}] Nutrition Resolve Error:`, errorMsg);
      return res.status(500).json({
        ok: false,
        error: "An unexpected error occurred during ingredient resolution.",
      });
    }
  });

  // AI Vault Intelligence Metadata Recovery endpoint with rate limiting & validation
  app.post("/api/recover-metadata", requireAiAccessToken, textPricingGuard, metadataRecoveryRateLimiter, async (req, res) => {
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
  app.post("/api/kitchen/interpret", requireAiAccessToken, textPricingGuard, kitchenInterpretRateLimiter, async (req, res) => {
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
  app.post("/api/kitchen/rank", requireAiAccessToken, textPricingGuard, kitchenRankRateLimiter, async (req, res) => {
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
  app.post("/api/kitchen/discover", requireAiAccessToken, textPricingGuard, kitchenDiscoverRateLimiter, async (req, res) => {
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

  // Read-only provider + model CATALOG (BYOK-1 / v0.8.0): the models each text
  // provider can execute (with per-model effective capabilities) plus the
  // production image provider's models/formats/byte limits. Secret-free. The
  // OpenRouter dynamic catalog is refreshed (bounded, cached, fail-safe) before
  // building so the response reflects live truth when available and the safe
  // last-known/baseline truth otherwise. Never throws, never spends.
  app.get("/api/providers/catalog", requireAiAccessToken, async (_req, res) => {
    await refreshOpenRouterCatalog();
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

      const {
        providerId,
        kind: rawKind,
        modelId: rawModelId,
        credentialSource: rawCredentialSource,
      } = req.body;

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

      // BYOK-5D: optional credentialSource. STRICT: wrong type / empty / unknown
      // value is a bounded 400 — a malformed PRESENT value is NEVER treated as
      // absent. Absent preserves the existing server_environment behavior.
      let credentialSource: "server_environment" | "session_only" | undefined;
      if (rawCredentialSource !== undefined) {
        if (typeof rawCredentialSource !== "string") {
          return res.status(400).json({
            error: '"credentialSource" must be a string.',
            code: "INVALID_REQUEST",
          });
        }
        if (rawCredentialSource !== "server_environment" && rawCredentialSource !== "session_only") {
          return res.status(400).json({
            error: '"credentialSource" must be "server_environment" or "session_only".',
            code: "INVALID_REQUEST",
          });
        }
        credentialSource = rawCredentialSource;
      }

      const result = await runConnectionTest({ providerId: cleanProviderId, kind, modelId, credentialSource });
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
        credentialSource: "server_environment",
        code: "PROVIDER_ERROR",
        message: "Connection test failed unexpectedly.",
      });
    }
  });

  // Explicit, zero-cost OpenRouter capability verification (v0.8.x). A dynamic
  // model becomes executable ONLY after this succeeds. The provider is FIXED to
  // `openrouter` (never caller-controlled), the model id is the wildcard tail of
  // the route (e.g. `openai/gpt-4o-mini`), and the CURRENT trusted catalog must
  // prove fresh, verified FREE pricing BEFORE any provider request. Auth-gated +
  // rate-limited; bounded timeout/response; never returns a secret or raw provider
  // error. The client must click an explicit "Verify" control — nothing here runs
  // automatically.
  app.post(
    "/api/providers/openrouter/models/*modelId/verify",
    requireAiAccessToken,
    capabilityVerifyRateLimiter,
    async (req, res) => {
      try {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
          return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
        }
        // Express 5 wildcard params arrive as a segment array; join with "/".
        const rawModelId = (req.params as Record<string, unknown>)["modelId"];
        const modelId = Array.isArray(rawModelId)
          ? rawModelId.join("/")
          : typeof rawModelId === "string"
          ? rawModelId
          : "";
        if (!modelId || modelId.length > 200) {
          return res.status(400).json({ error: "A valid model id is required.", code: "INVALID_MODEL" });
        }

        // Optional credentialSource: STRICT. A present-but-malformed value is a
        // bounded 400 — never silently treated as absent.
        const rawCredentialSource = (req.body as Record<string, unknown>)["credentialSource"];
        let credentialSource: "server_environment" | "session_only" | undefined;
        if (rawCredentialSource !== undefined) {
          if (rawCredentialSource !== "server_environment" && rawCredentialSource !== "session_only") {
            return res.status(400).json({
              error: '"credentialSource" must be "server_environment" or "session_only".',
              code: "CREDENTIAL_SOURCE_INVALID",
            });
          }
          credentialSource = rawCredentialSource;
        }

        const profile = req.body.profile;
        if (profile !== undefined && profile !== 'strict_json_schema_v1' && profile !== 'application_validated_json_v1') {
          return res.status(400).json({ code: 'INVALID_REQUEST', error: 'Unknown verification mode.' });
        }
        const result = await verifyOpenRouterModelCapability({ modelId, credentialSource, profile });
        if (result.ok === true) {
          return res.json({
            ok: true,
            providerId: result.providerId,
            modelId: result.modelId,
            profile: result.profile,
            verifiedAt: result.verifiedAt,
          });
        }
        const status = capabilityVerificationHttpStatus(result.code);
        return res.status(status).json({
          ok: false,
          providerId: result.providerId,
          modelId: result.modelId,
          code: result.code,
          message: result.message,
          // Additive, bounded, non-secret diagnosis (present only when the probe ran).
          ...(result.probeClassification ? { probeClassification: result.probeClassification } : {}),
        });
      } catch {
        return res.status(500).json({
          ok: false,
          providerId: "openrouter",
          modelId: "",
          code: "PROVIDER_ERROR",
          message: "Model verification failed unexpectedly.",
        });
      }
    }
  );

  // Explicit, zero-cost OpenRouter RECIPE-GENERATION capability verification
  // (`recipe_generation_v1`). A dynamic model becomes eligible for Create for Me
  // ONLY after this succeeds. It REQUIRES a current structured-text profile
  // verification and runs the REAL recipe schema/sanitizer probe. The client may
  // supply only the credential-source choice — never a profile, capability,
  // fingerprint, pricing class, or verification identity. Auth-gated +
  // rate-limited; bounded timeout/response; never returns a secret or raw
  // provider error. The client must click an explicit control — nothing here runs
  // automatically.
  app.post(
    "/api/providers/openrouter/models/*modelId/verify-recipe",
    requireAiAccessToken,
    recipeVerifyRateLimiter,
    async (req, res) => {
      try {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
          return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
        }
        const rawModelId = (req.params as Record<string, unknown>)["modelId"];
        const modelId = Array.isArray(rawModelId)
          ? rawModelId.join("/")
          : typeof rawModelId === "string"
          ? rawModelId
          : "";
        if (!modelId || modelId.length > 200) {
          return res.status(400).json({ error: "A valid model id is required.", code: "INVALID_MODEL" });
        }

        const rawCredentialSource = (req.body as Record<string, unknown>)["credentialSource"];
        let credentialSource: "server_environment" | "session_only" | undefined;
        if (rawCredentialSource !== undefined) {
          if (rawCredentialSource !== "server_environment" && rawCredentialSource !== "session_only") {
            return res.status(400).json({
              error: '"credentialSource" must be "server_environment" or "session_only".',
              code: "CREDENTIAL_SOURCE_INVALID",
            });
          }
          credentialSource = rawCredentialSource;
        }

        const result = await verifyOpenRouterRecipeGenerationCapability({ modelId, credentialSource });
        if (result.ok === true) {
          return res.json({
            ok: true,
            providerId: result.providerId,
            modelId: result.modelId,
            capability: result.capability,
            profile: result.profile,
            verifiedAt: result.verifiedAt,
          });
        }
        const status = capabilityVerificationHttpStatus(result.code);
        return res.status(status).json({
          ok: false,
          providerId: result.providerId,
          modelId: result.modelId,
          code: result.code,
          message: result.message,
          ...(result.probeClassification ? { probeClassification: result.probeClassification } : {}),
        });
      } catch {
        return res.status(500).json({
          ok: false,
          providerId: "openrouter",
          modelId: "",
          code: "PROVIDER_ERROR",
          message: "Recipe verification failed unexpectedly.",
        });
      }
    }
  );

  // Transient generated-image preview store (bounded, TTL 5min, 50MB cap).
  // Foundation for Vault Intelligence Image Recovery: generation ONLY — the
  // canonical asset write + Markdown `image` update belong to the later Save pass.
  const imagePreviewStore = opts.imagePreviewStore ?? new ImagePreviewStore();
  // Phase 2: server-owned, single-use authorizations for paid/variable image
  // generation. Bounded, process-memory, TTL-bound. A client boolean is never
  // authority; only a token issued here (after resolving the effective selection
  // + trusted pricing truth) authorizes exactly one provider call.
  const imageGenerationAuthorizations = new ImageGenerationAuthorizationStore();
  // Server-owned representative-image candidate authority (Phase 1): opaque ids,
  // short TTL, bounded count, bound to a SERVER-DERIVED requester identity.
  const representativeImageCandidates = new RepresentativeImageCandidateStore();
  // Process-random, in-memory salt for requester-id hashing (never persisted).
  // LIMITATION: requester scope is the trusted client IP (per the configured
  // proxy policy), so users behind the SAME NAT/proxy-derived IP SHARE a scope.
  // Appropriate for local-first/single-user use; a shared multi-user deployment
  // must bind authority to an authenticated user/session instead. See
  // docs/Representative-Image-Security.md ("Requester scope").
  const representativeRequesterSalt = cryptoRandomBytes(32);
  const representativeRequesterId = (req: import("express").Request): string =>
    createHash("sha256")
      .update(representativeRequesterSalt)
      .update(":")
      .update(getClientIp(req))
      .digest("hex");
  // Bounded thumbnail byte cache (strict memory limit; short TTL). Keyed by
  // REQUESTER + candidate so a cache hit can never bypass requester ownership.
  const REPRESENTATIVE_THUMB_CACHE_MAX_ENTRIES = 48;
  const REPRESENTATIVE_THUMB_CACHE_MAX_BYTES = 8 * 1024 * 1024;
  const representativeThumbCache = new Map<string, { bytes: Buffer; contentType: string; expiresAt: number }>();
  let representativeThumbCacheBytes = 0;
  const representativeThumbCacheKey = (requesterId: string, candidateId: string): string =>
    `${requesterId}\u0000${candidateId}`;
  const cacheRepresentativeThumb = (requesterId: string, candidateId: string, bytes: Buffer, contentType: string): void => {
    const now = Date.now();
    for (const [key, value] of representativeThumbCache) {
      if (now >= value.expiresAt) {
        representativeThumbCache.delete(key);
        representativeThumbCacheBytes -= value.bytes.length;
      }
    }
    if (representativeThumbCache.size >= REPRESENTATIVE_THUMB_CACHE_MAX_ENTRIES) return;
    if (representativeThumbCacheBytes + bytes.length > REPRESENTATIVE_THUMB_CACHE_MAX_BYTES) return;
    representativeThumbCache.set(representativeThumbCacheKey(requesterId, candidateId), {
      bytes,
      contentType,
      expiresAt: now + 60 * 1000,
    });
    representativeThumbCacheBytes += bytes.length;
  };

  // Create for Me — explicit recipe invention. Generates a schema-constrained
  // DRAFT and returns it (the client previews/edits and saves via the existing
  // vault write path). NEVER saves, NEVER mutates the vault, NEVER returns a
  // prompt, secret, or raw provider response. Gated + rate-limited like other AI
  // endpoints; no semantic downgrade (unsupported capability -> explicit 503).
  app.post("/api/recipes/generate", requireAiAccessToken, textPricingGuard, createRecipeRateLimiter, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
      }
      const userSelection = parseTextSelectionHeader(req.headers);

      // A profile-verified but recipe-unverified free model gets a SPECIFIC,
      // bounded message instead of the generic no-capable-provider error.
      if (isRecipeGenerationNotVerifiedSelection(userSelection)) {
        return res.status(503).json({
          error:
            "This free model is verified for structured text but not for recipe creation. Verify recipe creation in AI Settings first.",
          code: "RECIPE_GENERATION_NOT_VERIFIED",
        });
      }

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

  // Phase 2: server-owned image generation QUOTE. Resolves the effective image
  // provider/model + credential source and the CURRENT trusted pricing truth, and
  // issues an opaque, single-use confirmation token ONLY for a paid/variable
  // model. Makes ZERO provider inference calls. Gated + rate-limited like the
  // generation route.
  app.post("/api/recipes/image/quote", requireAiAccessToken, imageGenerateRateLimiter, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
      }
      const body = req.body as Record<string, unknown>;
      const userSelection = parseImageSelectionHeader(req.headers);
      const {
        provider: imageProvider,
        modelOverride: imageModelOverride,
        credentialSource,
        selectionInvalid,
        pricingBlocked,
        pricingMessage,
      } = resolveImageProvider(opts, userSelection);
      if (!imageProvider) {
        if (pricingBlocked) {
          return res.status(409).json({
            error: pricingMessage ?? "This model is no longer free. Review and re-select it before using it.",
            code: pricingBlocked,
          });
        }
        return res.status(503).json({
          error: selectionInvalid
            ? "The AI provider selection was invalid. No image was generated."
            : "The configured image provider selection is invalid. No image was generated.",
          code: selectionInvalid ? "IMAGE_SELECTION_INVALID" : "IMAGE_PROVIDER_NOT_CONFIGURED",
        });
      }
      if (!imageProvider.isAvailable()) {
        return res.status(503).json({
          error: "No image generation provider is configured on the server.",
          code: "IMAGE_PROVIDER_NOT_CONFIGURED",
        });
      }

      // Canonical server-verifiable binding (I4): the quote requires the SAME
      // bounded generation inputs the generate route requires. The server
      // recomputes the binding from the VALIDATED fields here and again at
      // generate time; a client-supplied hash is never authority. Malformed or
      // missing inputs fail closed BEFORE any authorization is issued.
      const quoteValidation = validateImageQuoteRequest(body);
      if (!quoteValidation.ok || !quoteValidation.value) {
        return res.status(400).json({ error: "Invalid image generation request.", code: "INVALID_REQUEST" });
      }
      const quoteFields = quoteValidation.value;
      const recipeBinding = canonicalImageRequestBinding(quoteFields);
      const vaultScope = imageVaultScope(quoteFields.vaultSessionId);

      const model = effectiveImageModel(imageProvider, imageModelOverride);
      const pricing = imagePricingTruth(imageProvider.id, model);
      const base = {
        ok: true,
        provider: { id: imageProvider.id, name: imageProvider.name },
        model,
        credentialSource,
        costClass: pricing.costClass,
        costLabel: pricing.label,
        requiresConfirmation: pricing.requiresConfirmation,
      };
      if (!pricing.requiresConfirmation) {
        // Verified zero price: explicit generation may skip confirmation.
        return res.json(base);
      }
      const issued = imageGenerationAuthorizations.issue(representativeRequesterId(req), {
        providerId: imageProvider.id,
        modelId: model,
        credentialSource,
        // Opaque server-owned credential lifecycle counter for the EXACT provider.
        credentialGeneration: getCredentialGeneration(imageProvider.id),
        costClass: pricing.costClass,
        ...(pricing.pricingFingerprint ? { pricingFingerprint: pricing.pricingFingerprint } : {}),
        recipeBinding,
        vaultScope,
      });
      return res.json({
        ...base,
        confirmationToken: issued.token,
        confirmationExpiresAt: issued.expiresAt,
      });
    } catch (error) {
      if (error instanceof ImageGenerationAuthorizationCapacityError) {
        return res.status(503).json({
          error: "Image generation confirmation is temporarily unavailable. Please try again shortly.",
          code: "IMAGE_CONFIRMATION_CAPACITY",
        });
      }
      return res.status(502).json({ error: "Couldn't prepare image generation right now.", code: "IMAGE_QUOTE_FAILED" });
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
    // Capacity reservation for this in-flight generation. It is released on every
    // path that does not commit it, so a failed/aborted call never leaks capacity.
    let reservation: ImagePreviewReservation | undefined;
    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
      }
      const userSelection = parseImageSelectionHeader(req.headers);
      const {
        provider: imageProvider,
        modelOverride: imageModelOverride,
        credentialSource,
        selectionInvalid,
        pricingBlocked,
        pricingMessage,
      } = resolveImageProvider(opts, userSelection);
      if (!imageProvider) {
        if (pricingBlocked) {
          // v0.8.0 FREE -> PAID spend protection: the acknowledged FREE model is
          // no longer verified free (or pricing could not be verified). FAIL
          // CLOSED with a distinct bounded code — never a silent paid execution.
          return res.status(409).json({
            error: pricingMessage ?? "This model is no longer free. Review and re-select it before using it.",
            code: pricingBlocked,
          });
        }
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

      // Phase 2: paid/variable image models require a valid, server-issued,
      // single-use confirmation token. The bounded request is validated FIRST so
      // an invalid request never consumes a token; bindings are verified and the
      // token is consumed atomically immediately before the sole provider call.
      const model = effectiveImageModel(imageProvider, imageModelOverride);
      const pricing = imagePricingTruth(imageProvider.id, model);

      // RESERVE preview capacity BEFORE consuming the token or calling the
      // provider. A full store fails closed with ZERO provider calls and does NOT
      // consume the confirmation token (so a retry after freeing space is safe).
      // The reservation is requester-scoped: per-requester and global reservation
      // bounds both apply.
      try {
        reservation = imagePreviewStore.reserve(MAX_GENERATED_IMAGE_BYTES, representativeRequesterId(req));
      } catch (capacityError: any) {
        if (
          capacityError instanceof PreviewStoreCapacityError ||
          capacityError?.name === "PreviewStoreCapacityError"
        ) {
          return res.status(503).json({
            error: "Image preview store is at capacity. Try again shortly.",
            code: "PREVIEW_CAPACITY",
          });
        }
        throw capacityError;
      }

      if (pricing.requiresConfirmation) {
        const rawToken = (req.body as Record<string, unknown>)["confirmationToken"];
        if (rawToken === undefined) {
          imagePreviewStore.release(reservation);
          return res.status(409).json({
            error: "This image model requires an explicit per-generation confirmation.",
            code: "IMAGE_CONFIRMATION_REQUIRED",
          });
        }
        if (typeof rawToken !== "string" || rawToken.length === 0 || rawToken.length > 512) {
          imagePreviewStore.release(reservation);
          return res.status(409).json({
            error: "Image generation confirmation is invalid or expired. Please request a new quote.",
            code: "IMAGE_CONFIRMATION_INVALID",
          });
        }
        const validatedRequest = validateGenerateRecipeImageRequest(req.body);
        if (!validatedRequest.ok || !validatedRequest.value) {
          imagePreviewStore.release(reservation);
          return res.status(400).json({ error: "Invalid image generation request.", code: "INVALID_REQUEST" });
        }
        // Recompute the canonical binding from the ACTUAL validated generation
        // request and compare it with the authorization record: substituted,
        // stale, cross-recipe, or cross-vault inputs fail closed here with zero
        // provider calls and without consuming a still-valid token.
        const generateBinding = canonicalImageRequestBinding(validatedRequest.value);
        const generateScope = imageVaultScope(validatedRequest.value.vaultSessionId);
        const consumed = imageGenerationAuthorizations.consume(
          rawToken,
          representativeRequesterId(req),
          {
            providerId: imageProvider.id,
            modelId: model,
            credentialSource,
            // Re-read the CURRENT credential generation immediately before
            // dispatch: a replaced/revoked/expired/purged session key or a
            // source switch fails closed with zero provider calls.
            credentialGeneration: getCredentialGeneration(imageProvider.id),
            costClass: pricing.costClass,
            ...(pricing.pricingFingerprint ? { pricingFingerprint: pricing.pricingFingerprint } : {}),
            recipeBinding: generateBinding,
            vaultScope: generateScope,
          }
        );
        if (!consumed.ok) {
          imagePreviewStore.release(reservation);
          return res.status(409).json({
            error: "Image generation confirmation is invalid or expired. Please request a new quote.",
            code: "IMAGE_CONFIRMATION_INVALID",
          });
        }
      }
      const result = await generateRecipeImagePreview(
        req.body,
        imageProvider,
        imagePreviewStore,
        imageModelOverride,
        reservation,
        representativeRequesterId(req)
      );
      return res.json(result);
    } catch (error: any) {
      // Release the reservation exactly once on any failure (commit already
      // released it on success; release is idempotent).
      if (reservation) imagePreviewStore.release(reservation);
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
  // Cache-Control: no-store + nosniff; unknown/expired/foreign-requester tokens
  // are 404. Records are requester-bound at insert: token possession alone never
  // crosses requester boundaries (the client-IP/shared-NAT limitation still
  // applies: co-located requesters share an identity by design).
  app.get("/api/recipes/image/preview/:token", requireAiAccessToken, imagePreviewRateLimiter, (req, res) => {
    const token = String(req.params?.token ?? "");
    if (!token || token.length > 512) {
      return res.status(404).json({ error: "Preview not found." });
    }
    const record = imagePreviewStore.get(token, representativeRequesterId(req));
    if (!record) {
      // Unknown, expired, and foreign-requester tokens are all inaccessible; no
      // state oracle is exposed, so inaccessible previews always return 404.
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
  // never distinguishes unknown vs removed vs expired vs foreign-requester (no
  // existence oracle). A foreign requester cannot invalidate another requester's
  // record. Gated + rate-limited like the other preview operations.
  app.delete("/api/recipes/image/preview/:token", requireAiAccessToken, imagePreviewRateLimiter, (req, res) => {
    const token = String(req.params?.token ?? "");
    if (!token || token.length > 512) {
      return res.status(404).json({ error: "Preview not found." });
    }
    imagePreviewStore.remove(token, representativeRequesterId(req));
    return res.status(200).json({ ok: true });
  });

  // EXPLICIT representative-image search (Phase 1). User-initiated only. The
  // deterministic query is built server-side from bounded recipe-owned fields;
  // only approved-license Openverse/Wikimedia candidates are returned. Bounded
  // metadata fetch through the hardened SSRF JSON path; never returns raw
  // upstream errors. Gated + rate-limited; no AI, no generation.
  app.post("/api/recipes/image/find-representative", requireAiAccessToken, representativeImageSearchRateLimiter, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
      }
      const body = req.body as Record<string, unknown>;
      // Explicit user-submitted search terms (editable in the chooser) are
      // re-sanitized and bounded HERE; client sanitization is never authority.
      const submittedTerms = typeof body['query'] === "string" ? body['query'] : "";
      const query = submittedTerms.trim()
        ? sanitizeRepresentativeSearchTerms(submittedTerms)
        : buildRepresentativeImageQuery({
            title: typeof body['title'] === "string" ? body['title'] : undefined,
            cuisine: typeof body['cuisine'] === "string" ? body['cuisine'] : undefined,
            category: typeof body['category'] === "string" ? body['category'] : undefined,
            tags: Array.isArray(body['tags']) ? (body['tags'] as string[]) : undefined,
            ingredients: Array.isArray(body['ingredients']) ? (body['ingredients'] as Array<string | { name?: string | null }>) : undefined,
          });
      // No safe visual term -> ZERO external calls, bounded local error.
      if (!query) {
        return res.status(422).json({
          error: "This recipe does not contain safe visual search terms. No external search was performed.",
          code: "IMAGE_QUERY_UNSAFE",
        });
      }
      const requesterId = representativeRequesterId(req);
      const found = await searchRepresentativeImages(query);
      const candidates = representativeImageCandidates.insertAll(requesterId, found);
      // The public response contains NO external thumbnail/full-resolution URL.
      return res.json({ query, candidates });
    } catch {
      return res.status(502).json({
        error: "Representative image search is temporarily unavailable. Please try again.",
        code: "IMAGE_SEARCH_UNAVAILABLE",
      });
    }
  });

  // App-local THUMBNAIL proxy. The browser NEVER receives or renders an external
  // thumbnail URL: it requests this route, and the server fetches the EXACT
  // stored thumbnail through the hardened SSRF-safe image path, validates it, and
  // returns raster bytes with nosniff + a short private cache. Requester-bound;
  // does NOT consume the candidate.
  app.get(
    "/api/recipes/image/representative-thumbnail/:candidateId",
    requireAiAccessToken,
    representativeImageThumbnailRateLimiter,
    async (req, res) => {
      const candidateId = String(req.params?.candidateId ?? "");
      const requesterId = representativeRequesterId(req);
      // OWNERSHIP + EXPIRY ARE CHECKED BEFORE ANY CACHE HIT. A cached byte
      // response must never bypass `store.get(candidateId, requesterId)`.
      const owned = representativeImageCandidates.get(candidateId, requesterId);
      if (!owned) {
        representativeThumbCache.delete(representativeThumbCacheKey(requesterId, candidateId));
        // Unknown/expired/cross-requester all look identical (no existence oracle).
        return res.status(404).json({ error: "Thumbnail not found.", code: "CANDIDATE_NOT_FOUND" });
      }
      const cached = representativeThumbCache.get(representativeThumbCacheKey(requesterId, candidateId));
      if (cached && Date.now() < cached.expiresAt) {
        res.setHeader("Content-Type", cached.contentType);
        res.setHeader("Content-Length", String(cached.bytes.length));
        res.setHeader("Cache-Control", "private, max-age=60");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.status(200).end(cached.bytes);
      }
      try {
        const thumb = await fetchRepresentativeThumbnail(candidateId, {
          store: representativeImageCandidates,
          requesterId,
        });
        const buffer = Buffer.from(thumb.bytes);
        cacheRepresentativeThumb(requesterId, candidateId, buffer, thumb.contentType);
        res.setHeader("Content-Type", thumb.contentType);
        res.setHeader("Content-Length", String(buffer.length));
        res.setHeader("Cache-Control", "private, max-age=60");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.status(200).end(buffer);
      } catch (error: any) {
        if (error instanceof RepresentativeImageSelectionError) {
          // Unknown/expired/cross-requester all look identical (no existence oracle).
          return res.status(404).json({ error: "Thumbnail not found.", code: "CANDIDATE_NOT_FOUND" });
        }
        return res.status(502).json({ error: "That thumbnail could not be loaded.", code: "THUMBNAIL_FAILED" });
      }
    }
  );

  // EXPLICIT representative-image selection (Phase 1). The client submits ONLY
  // the opaque server-owned candidate id; the server recovers the exact stored
  // candidate (requester-bound), revalidates its license, downloads the exact
  // stored remote URL through the hardened SSRF image path, validates the bytes,
  // CONSUMES the candidate, and stores a short-lived preview token carrying the
  // representative provenance.
  app.post("/api/recipes/image/select-representative", requireAiAccessToken, representativeImageSelectRateLimiter, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
      }
      const candidateId = (req.body as Record<string, unknown>)['candidateId'];
      const selected = await selectRepresentativeImage(candidateId, {
        store: representativeImageCandidates,
        requesterId: representativeRequesterId(req),
      });
      const metadata = imagePreviewStore.insert({
        bytes: selected.bytes,
        contentType: selected.contentType,
        provider: "representative",
        model: selected.provenance.source,
        provenance: selected.provenance,
      }, representativeRequesterId(req));
      return res.json({
        token: metadata.token,
        contentType: metadata.contentType,
        bytes: metadata.bytes,
        expiresAt: metadata.expiresAt,
        provenance: selected.provenance,
      });
    } catch (error: any) {
      if (error instanceof RepresentativeImageSelectionError) {
        const status =
          error.code === "CANDIDATE_NOT_FOUND" ? 404 : error.code === "LICENSE_NOT_ALLOWED" ? 403 : 422;
        return res.status(status).json({ error: error.message, code: error.code });
      }
      if (error instanceof PreviewStoreCapacityError) {
        return res.status(503).json({ error: "Image preview store is at capacity. Try again shortly.", code: "PREVIEW_CAPACITY" });
      }
      return res.status(502).json({ error: "That image could not be prepared.", code: "IMAGE_SELECTION_FAILED" });
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
