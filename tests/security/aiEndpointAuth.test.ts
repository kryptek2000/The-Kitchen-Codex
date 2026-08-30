import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { requireAiAccessToken, getAiAccessToken, aiAccessTokenConfigured } from "../../server/aiEndpointAuth.js";

describe("AI endpoint access token protection", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.AI_ENDPOINT_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.AI_ENDPOINT_TOKEN;
    } else {
      process.env.AI_ENDPOINT_TOKEN = originalToken;
    }
  });

  it("is a no-op when no token is configured (local mode)", () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    expect(aiAccessTokenConfigured()).toBe(false);

    let nextCalled = false;
    const req: Partial<Request> = { get: () => undefined } as any;
    const spyRes = {
      status: (code: number) => {
        expect(code).toBeLessThan(400); // should not reject when no token configured
        return spyRes;
      },
      json: () => spyRes,
    };
    const guardedNext = () => {
      nextCalled = true;
    };
    requireAiAccessToken(req as Request, spyRes as Response, guardedNext);
    expect(nextCalled).toBe(true);
  });

  it("rejects unauthenticated requests when a token is configured", () => {
    process.env.AI_ENDPOINT_TOKEN = "secret-token";
    expect(aiAccessTokenConfigured()).toBe(true);

    const next = () => {
      throw new Error("next() should not be called for an unauthorized request");
    };
    let statusCode = 0;
    let body: any = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(b: any) {
        body = b;
        return res;
      },
    };
    const req: Partial<Request> = { get: () => undefined } as any;

    requireAiAccessToken(req as Request, res as Response, next);
    expect(statusCode).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("accepts a valid bearer token", () => {
    process.env.AI_ENDPOINT_TOKEN = "secret-token";
    const next = () => {};
    let statusCode = 0;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json: () => res,
    };
    const req: Partial<Request> = {
      get: (name: string) => (name === "Authorization" ? "Bearer secret-token" : undefined),
    } as any;

    requireAiAccessToken(req as Request, res as Response, next);
    expect(statusCode).toBe(0); // never called status -> authorized
  });

  it("rejects an incorrect bearer token", () => {
    process.env.AI_ENDPOINT_TOKEN = "secret-token";
    const next = () => {
      throw new Error("next() should not be called for a wrong token");
    };
    let statusCode = 0;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json: () => res,
    };
    const req: Partial<Request> = {
      get: (name: string) => (name === "Authorization" ? "Bearer wrong-token" : undefined),
    } as any;

    requireAiAccessToken(req as Request, res as Response, next);
    expect(statusCode).toBe(401);
  });

  it("ignores a token that was never configured / returns undefined", () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    expect(getAiAccessToken()).toBeUndefined();
  });
});
