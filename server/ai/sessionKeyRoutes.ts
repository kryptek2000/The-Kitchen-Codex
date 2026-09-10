/**
 * The Kitchen Codex — BYOK-5B session-key API routes.
 *
 * Minimal, server-enforced routes over the BYOK-5A in-memory session secret
 * store. This module adds NO credential routing, NO provider execution, and NO
 * connection-test integration — it only stores/reads/revokes an in-memory key.
 *
 * ROUTES:
 *   POST   /api/providers/session-key            set/rotate (8 KiB body ceiling)
 *   DELETE /api/providers/session-key/:providerId revoke
 *   GET    /api/providers/session-key/status      non-secret status (allowlisted)
 *
 * SECURITY:
 *   - Every route enforces the BYOK-5A deployment guard; unsupported deployments
 *     get a bounded `BYOK_SESSION_UNAVAILABLE` (503) — never a hidden UI gate.
 *   - Every route uses the existing `requireAiAccessToken` auth middleware and a
 *     dedicated per-client rate limiter (limiting happens before body parse).
 *   - The POST body is parsed with an 8 KiB ceiling (this route is registered
 *     BEFORE the global 2 MiB parser, so the small limit actually applies).
 *   - The secret is NEVER echoed in any response, error, or log. Status exposes
 *     only non-secret metadata.
 *   - No provider network call happens here.
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { requireAiAccessToken } from "../aiEndpointAuth.js";
import {
  sessionKeySetRateLimiter,
  sessionKeyRevokeRateLimiter,
  sessionKeyStatusRateLimiter,
} from "../rateLimiter.js";
import { isSessionByokSupportedDeployment } from "./sessionByokDeployment.js";
import {
  setSessionSecret,
  revokeSessionSecret,
  getSessionSecretStatus,
  isSessionSecretProviderAllowed,
  sessionSecretProviderAllowlist,
  SessionSecretError,
  MAX_SESSION_SECRET_BYTES,
} from "./sessionSecrets.js";

/** Bounded identifier lengths (rejected, never truncated). */
const PROVIDER_ID_MAX_LENGTH = 64;
const EXPECTED_VERSION_MAX_LENGTH = 128;
/** Reject C0 control characters and DEL in the key (never trim into a valid key). */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/** The bounded unsupported-deployment response. */
function sessionByokUnavailable(res: Response) {
  return res.status(503).json({
    error: "Session-only BYOK is not available in this deployment.",
    code: "BYOK_SESSION_UNAVAILABLE",
  });
}

/** Maps a BYOK-5A store error to a bounded, secret-free HTTP response. */
function mapSessionSecretError(res: Response, err: unknown) {
  if (err instanceof SessionSecretError) {
    switch (err.code) {
      case "SESSION_BYOK_UNSUPPORTED":
        return sessionByokUnavailable(res);
      case "PROVIDER_NOT_ALLOWED":
        return res.status(400).json({
          error: "Session secrets are not allowed for this provider.",
          code: "PROVIDER_NOT_ALLOWED",
        });
      case "INVALID_SECRET":
        return res.status(400).json({ error: "A non-empty API key is required.", code: "INVALID_SECRET" });
      case "SECRET_TOO_LONG":
        return res.status(413).json({
          error: "The API key exceeds the maximum length.",
          code: "SECRET_TOO_LONG",
        });
      case "VERSION_CONFLICT":
        return res.status(409).json({
          error: "The session key changed; refresh and try again.",
          code: "VERSION_CONFLICT",
        });
      default:
        return res.status(400).json({ error: "Invalid session key request.", code: "INVALID_REQUEST" });
    }
  }
  // Unexpected: bounded, secret-free. Never leak a stack or raw exception text.
  return res.status(500).json({ error: "Session key request failed unexpectedly." });
}

/** An 8 KiB JSON parser with a bounded error response (registered pre-global-parser). */
const sessionKeyJsonParser = express.json({ limit: "8kb" });
function parseSessionKeyBody(req: Request, res: Response, next: NextFunction) {
  sessionKeyJsonParser(req, res, (err: unknown) => {
    if (!err) return next();
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 400;
    if (status === 413) {
      return res.status(413).json({ error: "Request body is too large.", code: "INVALID_REQUEST" });
    }
    return res.status(400).json({ error: "Invalid JSON payload.", code: "INVALID_REQUEST" });
  });
}

/**
 * Registers the BYOK-5B session-key routes on the app. MUST be called BEFORE the
 * global `express.json()` middleware so the POST 8 KiB ceiling is effective.
 */
export function registerSessionKeyRoutes(app: Express): void {
  // --- POST set/rotate -------------------------------------------------------
  app.post(
    "/api/providers/session-key",
    requireAiAccessToken,
    sessionKeySetRateLimiter,
    parseSessionKeyBody,
    (req: Request, res: Response) => {
      if (!isSessionByokSupportedDeployment()) return sessionByokUnavailable(res);
      try {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
          return res.status(400).json({ error: "Invalid request payload.", code: "INVALID_REQUEST" });
        }
        const { providerId, apiKey, expectedVersion } = req.body as Record<string, unknown>;

        // providerId: string, non-empty, bounded, exact allowlisted (no trim/case).
        if (typeof providerId !== "string") {
          return res.status(400).json({ error: '"providerId" must be a string.', code: "INVALID_REQUEST" });
        }
        if (providerId.length === 0) {
          return res.status(400).json({ error: '"providerId" is required.', code: "INVALID_REQUEST" });
        }
        if (providerId.length > PROVIDER_ID_MAX_LENGTH) {
          return res.status(400).json({ error: '"providerId" is too long.', code: "INVALID_REQUEST" });
        }
        if (!isSessionSecretProviderAllowed(providerId)) {
          return res.status(400).json({
            error: "Session secrets are not allowed for this provider.",
            code: "PROVIDER_NOT_ALLOWED",
          });
        }

        // apiKey: string, non-empty/whitespace-only rejected, bounded, no control
        // chars. The RAW value is stored (never trimmed into a different secret).
        if (typeof apiKey !== "string") {
          return res.status(400).json({ error: '"apiKey" must be a string.', code: "INVALID_REQUEST" });
        }
        if (apiKey.length === 0 || apiKey.trim().length === 0) {
          return res.status(400).json({ error: "A non-empty API key is required.", code: "INVALID_SECRET" });
        }
        // The ceiling is UTF-8 BYTES (not JS string length), so a multibyte key
        // cannot slip past the 4 KiB contract bound.
        if (Buffer.byteLength(apiKey, "utf8") > MAX_SESSION_SECRET_BYTES) {
          return res.status(413).json({
            error: "The API key exceeds the maximum length.",
            code: "SECRET_TOO_LONG",
          });
        }
        if (CONTROL_CHAR_RE.test(apiKey)) {
          return res.status(400).json({
            error: "The API key contains invalid control characters.",
            code: "INVALID_SECRET",
          });
        }

        // expectedVersion: optional string, bounded, never derived from the secret.
        let expectedVersionValue: string | undefined;
        if (expectedVersion !== undefined) {
          if (typeof expectedVersion !== "string") {
            return res.status(400).json({ error: '"expectedVersion" must be a string.', code: "INVALID_REQUEST" });
          }
          if (expectedVersion.length === 0 || expectedVersion.length > EXPECTED_VERSION_MAX_LENGTH) {
            return res.status(400).json({ error: '"expectedVersion" is invalid.', code: "INVALID_REQUEST" });
          }
          expectedVersionValue = expectedVersion;
        }

        const status = setSessionSecret(providerId, apiKey, expectedVersionValue);
        // Non-secret status only (providerId, storageScope, configured, expiresAt, version).
        return res.json(status);
      } catch (err) {
        return mapSessionSecretError(res, err);
      }
    }
  );

  // --- DELETE revoke ---------------------------------------------------------
  app.delete(
    "/api/providers/session-key/:providerId",
    requireAiAccessToken,
    sessionKeyRevokeRateLimiter,
    (req: Request, res: Response) => {
      if (!isSessionByokSupportedDeployment()) return sessionByokUnavailable(res);
      const providerId = req.params?.providerId;
      if (typeof providerId !== "string" || providerId.length === 0 || providerId.length > PROVIDER_ID_MAX_LENGTH) {
        return res.status(400).json({ error: "Invalid provider id.", code: "INVALID_REQUEST" });
      }
      if (!isSessionSecretProviderAllowed(providerId)) {
        return res.status(400).json({
          error: "Session secrets are not allowed for this provider.",
          code: "PROVIDER_NOT_ALLOWED",
        });
      }
      // Idempotent: deleting an absent entry is a success.
      revokeSessionSecret(providerId);
      return res.json({ providerId, configured: false });
    }
  );

  // --- GET status ------------------------------------------------------------
  app.get(
    "/api/providers/session-key/status",
    requireAiAccessToken,
    sessionKeyStatusRateLimiter,
    (_req: Request, res: Response) => {
      if (!isSessionByokSupportedDeployment()) return sessionByokUnavailable(res);
      // Allowlisted providers only; non-secret status; never refreshes idle TTL.
      const providers = sessionSecretProviderAllowlist().map((providerId) => getSessionSecretStatus(providerId));
      return res.json({ providers });
    }
  );
}
