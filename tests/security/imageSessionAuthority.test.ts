import { describe, it, expect, vi } from "vitest";
import {
  ImageSessionAuthority,
  ImageSessionCapacityError,
  IMAGE_SESSION_ABSOLUTE_TTL_MS,
  IMAGE_SESSION_IDLE_TTL_MS,
} from "../../server/imageSessionAuthority.js";

/**
 * P2-R1 — image-session authority unit contracts.
 *
 * Proves opaque issuance, server-side validation, absolute + idle expiry,
 * revocation, capacity bounds, and that the raw cookie token is never retained
 * in the returned server record.
 */

function clock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ImageSessionAuthority — issuance and validation", () => {
  it("issues an opaque token + independent session id, and validates the exact token", () => {
    const authority = new ImageSessionAuthority();
    const issued = authority.issue();
    expect(issued.token.length).toBeGreaterThanOrEqual(32);
    expect(issued.session.sessionId.length).toBeGreaterThanOrEqual(32);
    expect(issued.session.sessionId).not.toBe(issued.token);
    // The server record must not retain the raw token.
    expect(JSON.stringify(issued.session)).not.toContain(issued.token);
    expect(authority.validate(issued.token)?.sessionId).toBe(issued.session.sessionId);
  });

  it("rejects forged / missing / overlong / structurally invalid tokens", () => {
    const authority = new ImageSessionAuthority();
    const issued = authority.issue();
    expect(authority.validate("forged")).toBeUndefined();
    expect(authority.validate("")).toBeUndefined();
    expect(authority.validate(issued.token + "x")).toBeUndefined();
    expect(authority.validate("x".repeat(513))).toBeUndefined();
    expect(authority.stats()).toEqual({ active: 1 });
  });

  it("expires on the ABSOLUTE TTL", () => {
    const c = clock();
    const authority = new ImageSessionAuthority({ now: c.now, absoluteTtlMs: 10_000, idleTtlMs: 60_000 });
    const issued = authority.issue();
    c.advance(9_999);
    expect(authority.validate(issued.token)).toBeDefined();
    c.advance(1);
    expect(authority.validate(issued.token)).toBeUndefined();
    expect(authority.stats().active).toBe(0);
  });

  it("expires on the SLIDING idle TTL and refreshes on each successful validation", () => {
    const c = clock();
    const authority = new ImageSessionAuthority({
      now: c.now,
      absoluteTtlMs: IMAGE_SESSION_ABSOLUTE_TTL_MS,
      idleTtlMs: 1_000,
    });
    const issued = authority.issue();
    c.advance(900);
    expect(authority.validate(issued.token)).toBeDefined(); // refresh idle
    c.advance(900);
    expect(authority.validate(issued.token)).toBeDefined();
    c.advance(1_000);
    expect(authority.validate(issued.token)).toBeUndefined();
  });

  it("revocation is immediate and idempotent", () => {
    const authority = new ImageSessionAuthority();
    const issued = authority.issue();
    expect(authority.revoke(issued.token)).toBe(true);
    expect(authority.validate(issued.token)).toBeUndefined();
    expect(authority.revoke(issued.token)).toBe(false);
    expect(authority.revoke("never-issued")).toBe(false);
  });

  it("fails closed at capacity instead of evicting a live session", () => {
    const authority = new ImageSessionAuthority({ maxActive: 1 });
    const first = authority.issue();
    expect(() => authority.issue()).toThrow(ImageSessionCapacityError);
    expect(authority.validate(first.token)).toBeDefined();
  });

  it("uses only server-created values (never a client-supplied id)", () => {
    const createToken = vi.fn(() => "server-token-A");
    const createSessionId = vi.fn(() => "server-session-A");
    const authority = new ImageSessionAuthority({ createToken, createSessionId });
    const issued = authority.issue();
    expect(issued.token).toBe("server-token-A");
    expect(issued.session.sessionId).toBe("server-session-A");
    expect(createToken).toHaveBeenCalledTimes(1);
    expect(createSessionId).toHaveBeenCalledTimes(1);
    // Requests can only present the token; there is no API to claim a sessionId.
    expect(authority.validate("server-session-A")).toBeUndefined();
  });

  it("a stale idle session does not refresh when only swept", () => {
    const c = clock();
    const authority = new ImageSessionAuthority({ now: c.now, idleTtlMs: IMAGE_SESSION_IDLE_TTL_MS });
    const issued = authority.issue();
    c.advance(IMAGE_SESSION_IDLE_TTL_MS);
    expect(authority.sweep()).toBe(1);
    expect(authority.validate(issued.token)).toBeUndefined();
  });
});
