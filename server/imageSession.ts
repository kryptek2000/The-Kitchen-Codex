/**
 * The Kitchen Codex — image-session HTTP boundary (P2-R1).
 *
 * Owns the HttpOnly session cookie, deployment support gate, same-origin checks,
 * and the per-image-route validation middleware. The authority/store lives in
 * `imageSessionAuthority.ts`; this module never logs or serializes a token.
 */

import type { NextFunction, Request, Response } from "express";
import type { ImageSessionAuthority } from "./imageSessionAuthority.js";

/** HttpOnly, host-only cookie carrying the opaque session token. */
export const IMAGE_SESSION_COOKIE = "tkc_image_session";

const REQUEST_SESSION_IDS = new WeakMap<object, string>();

/**
 * Supported deployment check:
 *   - hosted multi-user indicators ALWAYS fail closed;
 *   - only a loopback bind is supported (session cookies over a LAN/wildcard
 *     HTTP bind are not an acceptable trust boundary);
 *   - production image sessions require the existing server-verified Electron
 *     desktop access authority (`TKC_DESKTOP_SESSION_TOKEN`). A production
 *     standalone loopback process has no authenticated principal and therefore
 *     is deliberately disabled; Host/Origin/SameSite are not authentication.
 *   - the request Host header must itself be loopback (DNS-rebinding guard),
 *     checked per request in `isLoopbackHostHeader`.
 */
export interface ImageSessionDeploymentOptions {
  /** The composed server mode; this is not a request-controlled value. */
  isProduction?: boolean;
}

export function isImageSessionDeploymentSupported(
  env: NodeJS.ProcessEnv = process.env,
  options: ImageSessionDeploymentOptions = {}
): boolean {
  if (!env) return false;
  if (env.K_SERVICE || env.K_REVISION || env.K_CONFIGURATION) return false;
  const host = (env.HOST || "").trim().toLowerCase();
  const loopback = !host || host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback) return false;

  // The desktop session token is the actual secret authority enforced by the
  // global /api middleware in server/app.ts. Requiring its presence here makes
  // a production server without that middleware fail closed before it can issue
  // or accept an image session. The application-mode marker is intentionally not
  // used as authentication; the secret gate is the authority.
  const isProduction = options.isProduction ?? env.NODE_ENV === "production";
  if (isProduction && String(env.TKC_DESKTOP_SESSION_TOKEN || "").trim() === "") {
    return false;
  }
  return true;
}

/** True only for a loopback Host header (with optional port). */
export function isLoopbackHostHeader(req: Request): boolean {
  const host = String(req.get("host") || "").trim();
  if (!host) return false;
  // Reject userinfo/path/whitespace-shaped Host values before URL parsing.
  if (/[@/\\\s]/.test(host)) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/** Parses one cookie value by exact name (no third-party cookie parser). */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = String(req.headers.cookie || "");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function readImageSessionToken(req: Request): string | undefined {
  const token = readCookie(req, IMAGE_SESSION_COOKIE);
  return token && token.length <= 512 ? token : undefined;
}

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    // Loopback/Electron runs over plain HTTP; `req.secure` is true only behind a
    // correctly configured HTTPS proxy (hosted is refused by the gate above).
    secure: req.secure === true,
    path: "/api",
  };
}

export function setImageSessionCookie(
  req: Request,
  res: Response,
  token: string,
  expiresAt: number
): void {
  const now = Date.now();
  const maxAge = Math.max(0, expiresAt - now);
  res.cookie(IMAGE_SESSION_COOKIE, token, { ...cookieOptions(req), maxAge });
  res.setHeader("Cache-Control", "no-store");
}

export function clearImageSessionCookie(req: Request, res: Response): void {
  res.clearCookie(IMAGE_SESSION_COOKIE, cookieOptions(req));
  res.setHeader("Cache-Control", "no-store");
}

/** True when an Origin header is present and its host exactly matches Host. */
export function originMatchesHost(req: Request): boolean {
  const origin = String(req.get("origin") || "").trim();
  if (!origin) return true; // non-browser callers have no ambient CSRF surface
  const host = String(req.get("host") || "").trim();
  if (!host) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.host === host;
  } catch {
    return false;
  }
}

/** Rejects an explicitly cross-site request (browser hint). */
export function isCrossSiteRequest(req: Request): boolean {
  const site = String(req.get("sec-fetch-site") || "").trim().toLowerCase();
  return site === "cross-site" || site === "same-site";
}

/**
 * Bootstrap is stricter: a browser Origin is REQUIRED and must match Host, and
 * an explicit Sec-Fetch-Site must be same-origin/none. This prevents an unrelated
 * website from minting a session through the user's browser.
 */
export function bootstrapOriginAllowed(req: Request): boolean {
  const origin = String(req.get("origin") || "").trim();
  if (!origin) return false;
  if (!isLoopbackHostHeader(req)) return false;
  if (!originMatchesHost(req)) return false;
  const site = String(req.get("sec-fetch-site") || "").trim().toLowerCase();
  return !site || site === "same-origin" || site === "none";
}

/** Reads the server-resolved session id attached by `requireImageSession`. */
export function imageSessionIdFor(req: Request): string | undefined {
  return REQUEST_SESSION_IDS.get(req);
}

/**
 * Validates the image-session cookie for one image route. Missing/forged/
 * expired/revoked sessions fail closed with a bounded 401; unsupported
 * deployments fail closed with 503; cross-origin state changes are rejected.
 */
export function requireImageSession(
  authority: ImageSessionAuthority,
  options: { deploymentSupported: boolean }
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!options.deploymentSupported) {
      return res.status(503).json({
        error: "Image sessions are not available in this deployment.",
        code: "IMAGE_SESSION_UNAVAILABLE",
      });
    }
    if (!isLoopbackHostHeader(req) || isCrossSiteRequest(req) || !originMatchesHost(req)) {
      return res.status(403).json({
        error: "Cross-origin image-session requests are not allowed.",
        code: "IMAGE_SESSION_CROSS_ORIGIN",
      });
    }
    const token = readImageSessionToken(req);
    const session = token ? authority.validate(token) : undefined;
    if (!session) {
      clearImageSessionCookie(req, res);
      return res.status(401).json({
        error: "An authorized image session is required.",
        code: "IMAGE_SESSION_REQUIRED",
      });
    }
    REQUEST_SESSION_IDS.set(req, session.sessionId);
    next();
  };
}
