import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const clientIpStore = new Map<string, RateLimitEntry>();

// Periodic cleanup every 5 minutes to prevent memory accumulation
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of clientIpStore.entries()) {
    if (entry.resetTime <= now) {
      clientIpStore.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Extracts a normalized client IP address from the request.
 *
 * We rely on Express's `trust proxy` setting (configured in server.ts) rather
 * than reading the raw `X-Forwarded-For` header directly. When no trusted proxy
 * is configured, Express exposes the direct socket address and ignores the
 * client-supplied `X-Forwarded-For` header — preventing header spoofing from
 * rotating the source IP to bypass rate limiting. When a trusted proxy is
 * configured, Express resolves the real client IP correctly.
 */
export function getClientIp(req: Request): string {
  const resolved = req.ip || req.socket.remoteAddress;
  if (!resolved) return "127.0.0.1";
  // Normalize IPv6 loopback / IPv4-mapped loopback to a stable, non-empty key.
  if (resolved === "::1" || resolved === "::ffff:127.0.0.1") return "127.0.0.1";
  return resolved;
}

/**
 * Express middleware for in-memory rate limiting on recipe import endpoints.
 * Configurable via `RECIPE_IMPORT_RATE_LIMIT` (default 15 requests per minute).
 */
export function recipeImportRateLimiter(req: Request, res: Response, next: NextFunction) {
  const parsedLimit = parseInt(process.env.RECIPE_IMPORT_RATE_LIMIT || "15", 10);
  const maxRequestsPerWindow = isNaN(parsedLimit) || parsedLimit <= 0 ? 15 : parsedLimit;
  const windowMs = 60 * 1000; // 1 minute window

  const clientIp = getClientIp(req);
  const now = Date.now();

  let entry = clientIpStore.get(clientIp);

  if (!entry || entry.resetTime <= now) {
    entry = {
      count: 1,
      resetTime: now + windowMs,
    };
    clientIpStore.set(clientIp, entry);
  } else {
    entry.count += 1;
  }

  const remaining = Math.max(0, maxRequestsPerWindow - entry.count);
  const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

  res.setHeader("RateLimit-Limit", maxRequestsPerWindow);
  res.setHeader("RateLimit-Remaining", remaining);
  res.setHeader("RateLimit-Reset", resetSeconds);

  if (entry.count > maxRequestsPerWindow) {
    res.setHeader("Retry-After", resetSeconds);
    return res.status(429).json({
      error: "Too many recipe import requests from your IP. Please try again in a minute.",
      retryAfterSeconds: resetSeconds,
    });
  }

  next();
}

/**
 * Express middleware for rate limiting on AI nutrition estimation endpoints.
 * Configurable via `NUTRITION_RATE_LIMIT` (default 20 requests per minute).
 */
export function nutritionEstimateRateLimiter(req: Request, res: Response, next: NextFunction) {
  const parsedLimit = parseInt(process.env.NUTRITION_RATE_LIMIT || "20", 10);
  const maxRequestsPerWindow = isNaN(parsedLimit) || parsedLimit <= 0 ? 20 : parsedLimit;
  const windowMs = 60 * 1000; // 1 minute window

  const clientIp = getClientIp(req);
  const now = Date.now();

  let entry = clientIpStore.get(`nutr_${clientIp}`);

  if (!entry || entry.resetTime <= now) {
    entry = {
      count: 1,
      resetTime: now + windowMs,
    };
    clientIpStore.set(`nutr_${clientIp}`, entry);
  } else {
    entry.count += 1;
  }

  const remaining = Math.max(0, maxRequestsPerWindow - entry.count);
  const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

  res.setHeader("RateLimit-Limit", maxRequestsPerWindow);
  res.setHeader("RateLimit-Remaining", remaining);
  res.setHeader("RateLimit-Reset", resetSeconds);

  if (entry.count > maxRequestsPerWindow) {
    res.setHeader("Retry-After", resetSeconds);
    return res.status(429).json({
      error: "Too many nutrition estimation requests. Please wait a moment before trying again.",
      retryAfterSeconds: resetSeconds,
    });
  }

  next();
}

/**
 * Express middleware for rate limiting on AI metadata recovery endpoints.
 * Configurable via `METADATA_RECOVERY_RATE_LIMIT` (default 25 requests per minute).
 */
export function metadataRecoveryRateLimiter(req: Request, res: Response, next: NextFunction) {
  const parsedLimit = parseInt(process.env.METADATA_RECOVERY_RATE_LIMIT || "25", 10);
  const maxRequestsPerWindow = isNaN(parsedLimit) || parsedLimit <= 0 ? 25 : parsedLimit;
  const windowMs = 60 * 1000; // 1 minute window

  const clientIp = getClientIp(req);
  const now = Date.now();

  let entry = clientIpStore.get(`recovery_${clientIp}`);

  if (!entry || entry.resetTime <= now) {
    entry = {
      count: 1,
      resetTime: now + windowMs,
    };
    clientIpStore.set(`recovery_${clientIp}`, entry);
  } else {
    entry.count += 1;
  }

  const remaining = Math.max(0, maxRequestsPerWindow - entry.count);
  const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

  res.setHeader("RateLimit-Limit", maxRequestsPerWindow);
  res.setHeader("RateLimit-Remaining", remaining);
  res.setHeader("RateLimit-Reset", resetSeconds);

  if (entry.count > maxRequestsPerWindow) {
    res.setHeader("Retry-After", resetSeconds);
    return res.status(429).json({
      error: "Too many metadata recovery requests. Please wait a moment before trying again.",
      retryAfterSeconds: resetSeconds,
    });
  }

  next();
}

/**
 * Express middleware for rate limiting on the Ask My Kitchen question
 * interpretation endpoint. Configurable via `KITCHEN_RATE_LIMIT`
 * (default 10 requests per minute).
 */
export function kitchenInterpretRateLimiter(req: Request, res: Response, next: NextFunction) {
  const parsedLimit = parseInt(process.env.KITCHEN_RATE_LIMIT || "10", 10);
  const maxRequestsPerWindow = isNaN(parsedLimit) || parsedLimit <= 0 ? 10 : parsedLimit;
  const windowMs = 60 * 1000; // 1 minute window

  const clientIp = getClientIp(req);
  const now = Date.now();

  let entry = clientIpStore.get(`kitchen_${clientIp}`);

  if (!entry || entry.resetTime <= now) {
    entry = {
      count: 1,
      resetTime: now + windowMs,
    };
    clientIpStore.set(`kitchen_${clientIp}`, entry);
  } else {
    entry.count += 1;
  }

  const remaining = Math.max(0, maxRequestsPerWindow - entry.count);
  const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

  res.setHeader("RateLimit-Limit", maxRequestsPerWindow);
  res.setHeader("RateLimit-Remaining", remaining);
  res.setHeader("RateLimit-Reset", resetSeconds);

  if (entry.count > maxRequestsPerWindow) {
    res.setHeader("Retry-After", resetSeconds);
    return res.status(429).json({
      error: "Too many kitchen questions. Please wait a moment before trying again.",
      retryAfterSeconds: resetSeconds,
    });
  }

  next();
}

/**
 * Express middleware for rate limiting on the Ask My Kitchen answer endpoint
 * (grounded answer generation). Configurable via `KITCHEN_ANSWER_RATE_LIMIT`
 * (default 15 requests per minute).
 */
export function kitchenAnswerRateLimiter(req: Request, res: Response, next: NextFunction) {
  const parsedLimit = parseInt(process.env.KITCHEN_ANSWER_RATE_LIMIT || "15", 10);
  const maxRequestsPerWindow = isNaN(parsedLimit) || parsedLimit <= 0 ? 15 : parsedLimit;
  const windowMs = 60 * 1000; // 1 minute window

  const clientIp = getClientIp(req);
  const now = Date.now();

  let entry = clientIpStore.get(`kitchenanswer_${clientIp}`);

  if (!entry || entry.resetTime <= now) {
    entry = {
      count: 1,
      resetTime: now + windowMs,
    };
    clientIpStore.set(`kitchenanswer_${clientIp}`, entry);
  } else {
    entry.count += 1;
  }

  const remaining = Math.max(0, maxRequestsPerWindow - entry.count);
  const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

  res.setHeader("RateLimit-Limit", maxRequestsPerWindow);
  res.setHeader("RateLimit-Remaining", remaining);
  res.setHeader("RateLimit-Reset", resetSeconds);

  if (entry.count > maxRequestsPerWindow) {
    res.setHeader("Retry-After", resetSeconds);
    return res.status(429).json({
      error: "Too many kitchen answer requests. Please wait a moment before trying again.",
      retryAfterSeconds: resetSeconds,
    });
  }

  next();
}
