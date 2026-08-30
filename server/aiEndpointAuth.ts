import type { Request, Response, NextFunction } from "express";

const TOKEN_ENV = "AI_ENDPOINT_TOKEN";

/**
 * Reads the optional shared API token used to protect AI endpoints on public
 * deployments. Returns undefined when unset (local development mode).
 */
export function getAiAccessToken(): string | undefined {
  const raw = (process.env[TOKEN_ENV] || "").trim();
  return raw ? raw : undefined;
}

/**
 * True when an AI access token is configured, i.e. AI endpoints are protected.
 */
export function aiAccessTokenConfigured(): boolean {
  return getAiAccessToken() !== undefined;
}

/**
 * Express middleware that optionally guards AI endpoints (nutrition
 * estimation, metadata recovery, recipe grabber) behind a shared bearer token.
 *
 * When `AI_ENDPOINT_TOKEN` is NOT set, the middleware is a no-op so local
 * development remains fully usable with no configuration. When it IS set, the
 * client must send `Authorization: Bearer <token>` on every request to these
 * endpoints; otherwise the request is rejected with 401 before it can consume
 * the server-side Gemini API key. This protects a public deployment from
 * third-party abuse without forcing an entire user-authentication system.
 *
 * The token comparison uses a constant-time equality check to avoid timing
 * side-channels.
 */
export function requireAiAccessToken(req: Request, res: Response, next: NextFunction) {
  const token = getAiAccessToken();
  if (!token) {
    return next();
  }

  const header = req.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match ? match[1].trim() : "";

  if (provided && constantTimeEqual(provided, token)) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized: a valid API token is required to access this endpoint.",
    code: "UNAUTHORIZED",
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
