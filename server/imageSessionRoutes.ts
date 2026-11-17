/**
 * The Kitchen Codex — image-session routes (P2-R1).
 *
 * Minimal, server-owned bootstrap/revoke surface for the local/Electron image
 * workflow. This is intentionally NOT a general account system:
 *
 *   POST   /api/session/bootstrap  -> issue one opaque session (HttpOnly cookie)
 *   DELETE /api/session            -> revoke the current session (idempotent)
 *
 * BOOTSTRAP AUTHORIZATION:
 *   - The deployment gate refuses hosted/non-loopback modes and production
 *     modes without the existing server-verified desktop access authority (no
 *     trustworthy local issuance authority).
 *   - The existing `AI_ENDPOINT_TOKEN`, when configured, is required.
 *   - A browser Origin is REQUIRED and must match Host; cross-site hints are
 *     rejected. In production Electron, the existing per-process desktop cookie
 *     gate is also enforced by the global `/api` middleware before this route.
 *
 * SECURITY:
 *   - The raw token appears ONLY in the Set-Cookie response header.
 *   - No token/session id is logged or returned in JSON.
 *   - The cookie is HttpOnly, SameSite=Strict, host-only, scoped to `/api`.
 */

import type { Express, Request, Response } from "express";
import { requireAiAccessToken } from "./aiEndpointAuth.js";
import { imageSessionBootstrapRateLimiter } from "./rateLimiter.js";
import {
  ImageSessionAuthority,
  ImageSessionCapacityError,
} from "./imageSessionAuthority.js";
import {
  bootstrapOriginAllowed,
  clearImageSessionCookie,
  isCrossSiteRequest,
  originMatchesHost,
  readImageSessionToken,
  setImageSessionCookie,
} from "./imageSession.js";

export interface RegisterImageSessionRoutesOptions {
  authority: ImageSessionAuthority;
  deploymentSupported: boolean;
}

function sessionUnavailable(res: Response) {
  return res.status(503).json({
    error: "Image sessions are not available in this deployment.",
    code: "IMAGE_SESSION_UNAVAILABLE",
  });
}

export function registerImageSessionRoutes(
  app: Express,
  options: RegisterImageSessionRoutesOptions
): void {
  // --- POST bootstrap --------------------------------------------------------
  app.post(
    "/api/session/bootstrap",
    requireAiAccessToken,
    imageSessionBootstrapRateLimiter,
    (req: Request, res: Response) => {
      if (!options.deploymentSupported) return sessionUnavailable(res);
      if (!bootstrapOriginAllowed(req)) {
        return res.status(403).json({
          error: "Session bootstrap is allowed only from the application's own origin.",
          code: "SESSION_BOOTSTRAP_FORBIDDEN",
        });
      }
      try {
        const issued = options.authority.issue();
        setImageSessionCookie(req, res, issued.token, issued.session.expiresAt);
        return res.json({ ok: true, expiresAt: issued.session.expiresAt });
      } catch (error) {
        if (error instanceof ImageSessionCapacityError) {
          return res.status(503).json({
            error: "Image session capacity is temporarily exhausted. Please try again shortly.",
            code: "IMAGE_SESSION_CAPACITY",
          });
        }
        return res.status(500).json({
          error: "Could not establish an image session.",
          code: "IMAGE_SESSION_BOOTSTRAP_FAILED",
        });
      }
    }
  );

  // --- DELETE revoke ---------------------------------------------------------
  app.delete("/api/session", requireAiAccessToken, (req: Request, res: Response) => {
    if (!options.deploymentSupported) return sessionUnavailable(res);
    if (isCrossSiteRequest(req) || !originMatchesHost(req)) {
      return res.status(403).json({
        error: "Cross-origin image-session requests are not allowed.",
        code: "IMAGE_SESSION_CROSS_ORIGIN",
      });
    }
    const token = readImageSessionToken(req);
    if (token) options.authority.revoke(token);
    clearImageSessionCookie(req, res);
    return res.json({ ok: true });
  });
}
