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
  getClientIp,
} from "./rateLimiter.js";
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
