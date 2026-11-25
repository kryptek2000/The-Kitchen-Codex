/**
 * The Kitchen Codex — image-session authority (P2-R1).
 *
 * A SERVER-OWNED, process-memory authority for the local/Electron image workflow.
 * It issues an opaque, cryptographically-random session token, stores only its
 * SHA-256 digest, and returns an opaque `sessionId` used to bind paid-image
 * confirmations and transient image previews.
 *
 * WHY THIS EXISTS (audit finding):
 *   The previous requester scope was `sha256(salt + client IP)`. Two independent
 *   sessions behind the same loopback/public IP therefore shared one authority
 *   scope, so one could consume the other's confirmation and read its preview.
 *   The session identity below is per-client, server-verified, and unrelated to
 *   the source IP.
 *
 * SECURITY / SCOPE:
 *   - The raw session token is returned ONLY to the issuing HTTP response as an
 *     HttpOnly cookie. It is never logged, persisted, placed in a URL, or exposed
 *     in a JSON body.
 *   - The store is in-memory only: restart revokes every session.
 *   - Entries have an absolute TTL AND a sliding idle TTL. Expired entries are
 *     swept on access/issue.
 *   - Capacity is bounded; an over-capacity issue fails closed.
 *   - `validate()` is the ONLY path that refreshes the idle timer. A forged,
 *     unknown, expired, or revoked token returns undefined.
 *   - `sessionId` is an independent random value (not derived from the token) so
 *     downstream authorization/preview records never contain the cookie value.
 */

import { createHash, randomBytes } from "node:crypto";

export const IMAGE_SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
export const IMAGE_SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
export const IMAGE_SESSION_MAX_ACTIVE = 2048;

/** Server-side session record (never serialized to a client). */
export interface ImageSessionRecord {
  /** Opaque, random identity used for authorization/preview ownership. */
  sessionId: string;
  createdAt: number;
  /** Absolute expiry (fixed at issue). */
  expiresAt: number;
  /** Last successful validation time (sliding idle TTL). */
  lastSeenAt: number;
}

export interface ImageSessionAuthorityOptions {
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable raw-token generator (tests). */
  createToken?: () => string;
  /** Injectable session-id generator (tests). */
  createSessionId?: () => string;
  absoluteTtlMs?: number;
  idleTtlMs?: number;
  maxActive?: number;
}

export class ImageSessionCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageSessionCapacityError";
  }
}

interface StoredSession extends ImageSessionRecord {
  tokenHash: string;
}

/** SHA-256 digest of the raw token; the token itself is never stored. */
function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class ImageSessionAuthority {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly createSessionId: () => string;
  private readonly absoluteTtlMs: number;
  private readonly idleTtlMs: number;
  private readonly maxActive: number;

  constructor(options: ImageSessionAuthorityOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
    this.createSessionId = options.createSessionId ?? (() => randomBytes(32).toString("base64url"));
    this.absoluteTtlMs = options.absoluteTtlMs ?? IMAGE_SESSION_ABSOLUTE_TTL_MS;
    this.idleTtlMs = options.idleTtlMs ?? IMAGE_SESSION_IDLE_TTL_MS;
    this.maxActive = options.maxActive ?? IMAGE_SESSION_MAX_ACTIVE;
  }

  /** Removes absolute-expired and idle-expired entries. Returns removed count. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [hash, session] of this.sessions) {
      if (now >= session.expiresAt || now - session.lastSeenAt >= this.idleTtlMs) {
        this.sessions.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Issues a new session. Returns the RAW token exactly once (for the HttpOnly
   * cookie) plus the server-side record. Over-capacity fails closed.
   */
  issue(): { token: string; session: ImageSessionRecord } {
    this.sweep();
    if (this.sessions.size >= this.maxActive) {
      throw new ImageSessionCapacityError("Image session capacity reached.");
    }
    const token = this.createToken();
    const sessionId = this.createSessionId();
    if (!token || !sessionId || this.sessions.has(tokenDigest(token))) {
      throw new ImageSessionCapacityError("Could not allocate a unique image session.");
    }
    const now = this.now();
    const record: StoredSession = {
      tokenHash: tokenDigest(token),
      sessionId,
      createdAt: now,
      expiresAt: now + this.absoluteTtlMs,
      lastSeenAt: now,
    };
    this.sessions.set(record.tokenHash, record);
    return {
      token,
      session: {
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        lastSeenAt: record.lastSeenAt,
      },
    };
  }

  /**
   * Validates a raw token and refreshes its idle timer. Returns undefined for
   * unknown, forged, expired, or revoked sessions.
   */
  validate(token: string): ImageSessionRecord | undefined {
    if (typeof token !== "string" || token.length === 0 || token.length > 512) return undefined;
    const hash = tokenDigest(token);
    const record = this.sessions.get(hash);
    if (!record) return undefined;
    const now = this.now();
    if (now >= record.expiresAt || now - record.lastSeenAt >= this.idleTtlMs) {
      this.sessions.delete(hash);
      return undefined;
    }
    record.lastSeenAt = now;
    return {
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastSeenAt: record.lastSeenAt,
    };
  }

  /** Revokes the exact raw token. Idempotent; returns true when it was live. */
  revoke(token: string): boolean {
    if (typeof token !== "string" || token.length === 0) return false;
    return this.sessions.delete(tokenDigest(token));
  }

  /** Test/teardown seam; never call in production code. */
  clear(): void {
    this.sessions.clear();
  }

  /** Bounded observability (no tokens, no session ids). */
  stats(): { active: number } {
    return { active: this.sessions.size };
  }
}
