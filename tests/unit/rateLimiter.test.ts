import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response } from "express";
import {
  getClientIp,
  recipeImportRateLimiter,
  nutritionEstimateRateLimiter,
} from "../../server/rateLimiter.js";

function mockReq(ip?: string): { req: Request; next: () => void } {
  const req = { ip, socket: { remoteAddress: undefined } } as unknown as Request;
  let called = 0;
  const next = () => {
    called++;
  };
  (next as any).callCount = () => called;
  return { req, next };
}

function mockRes(): { res: Response; headers: Record<string, string>; statusCode: () => number } {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader(k: string, v: string) {
      headers[k] = String(v);
    },
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json() {
      return res;
    },
    statusCode: 0,
  };
  return { res: res as Response, headers, statusCode: () => res.statusCode };
}

describe("rate limiter", () => {
  let originalRecipe: string | undefined;
  let originalNutrition: string | undefined;
  let originalRecovery: string | undefined;

  beforeEach(() => {
    originalRecipe = process.env.RECIPE_IMPORT_RATE_LIMIT;
    originalNutrition = process.env.NUTRITION_RATE_LIMIT;
    originalRecovery = process.env.METADATA_RECOVERY_RATE_LIMIT;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalRecipe === undefined) delete process.env.RECIPE_IMPORT_RATE_LIMIT;
    else process.env.RECIPE_IMPORT_RATE_LIMIT = originalRecipe;
    if (originalNutrition === undefined) delete process.env.NUTRITION_RATE_LIMIT;
    else process.env.NUTRITION_RATE_LIMIT = originalNutrition;
    if (originalRecovery === undefined) delete process.env.METADATA_RECOVERY_RATE_LIMIT;
    else process.env.METADATA_RECOVERY_RATE_LIMIT = originalRecovery;
  });

  describe("getClientIp", () => {
    it("normalizes IPv6/IPv4-mapped loopback to a stable key", () => {
      expect(getClientIp({ ip: "::1", socket: {} } as any)).toBe("127.0.0.1");
      expect(getClientIp({ ip: "::ffff:127.0.0.1", socket: {} } as any)).toBe("127.0.0.1");
    });

    it("uses the resolved proxy-aware IP when present", () => {
      expect(getClientIp({ ip: "203.0.113.5", socket: {} } as any)).toBe("203.0.113.5");
    });

    it("falls back to the socket address when req.ip is absent", () => {
      expect(getClientIp({ ip: undefined, socket: { remoteAddress: "198.51.100.9" } } as any)).toBe(
        "198.51.100.9"
      );
    });

    it("defaults to loopback when nothing is resolvable", () => {
      expect(getClientIp({ ip: undefined, socket: { remoteAddress: undefined } } as any)).toBe(
        "127.0.0.1"
      );
    });
  });

  it("applies a per-endpoint limit and returns 429 beyond it", () => {
    process.env.RECIPE_IMPORT_RATE_LIMIT = "1";
    const { req, next } = mockReq("203.0.113.10");
    const { res, headers, statusCode } = mockRes();

    recipeImportRateLimiter(req, res, next);
    expect(headers["RateLimit-Limit"]).toBe("1");
    expect(headers["RateLimit-Remaining"]).toBe("0");

    recipeImportRateLimiter(req, res, next);
    expect(statusCode()).toBe(429);
    expect(headers["Retry-After"]).toBeDefined();
    expect(headers["RateLimit-Remaining"]).toBe("0");
  });

  it("uses a separate counter for a different endpoint", () => {
    process.env.RECIPE_IMPORT_RATE_LIMIT = "1";
    process.env.NUTRITION_RATE_LIMIT = "20";
    const ip = "203.0.113.20";
    const { req: rReq, next: rNext } = mockReq(ip);
    const { res: rRes } = mockRes();
    recipeImportRateLimiter(rReq, rRes, rNext);

    // Recipe endpoint is exhausted, but the nutrition endpoint counter is fresh.
    const { req: nReq, next: nNext } = mockReq(ip);
    const { res: nRes, headers: nHeaders } = mockRes();
    nutritionEstimateRateLimiter(nReq, nRes, nNext);
    expect(nHeaders["RateLimit-Remaining"]).toBe("19");
  });

  it("resets the counter once the window expires", () => {
    vi.useFakeTimers();
    process.env.RECIPE_IMPORT_RATE_LIMIT = "2";
    const ip = "203.0.113.30";
    const { req, next } = mockReq(ip);

    const first = mockRes();
    recipeImportRateLimiter(req, first.res, next);
    expect(first.headers["RateLimit-Remaining"]).toBe("1");

    const second = mockRes();
    recipeImportRateLimiter(req, second.res, next);
    expect(second.headers["RateLimit-Remaining"]).toBe("0");

    // Advance past the 60s window; the counter should reset.
    vi.advanceTimersByTime(61_000);
    const third = mockRes();
    recipeImportRateLimiter(req, third.res, next);
    expect(third.headers["RateLimit-Remaining"]).toBe("1");
  });
});
