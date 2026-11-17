import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { createApp } from "../../server/app.js";
import {
  resetSessionSecretsForTests,
  getSessionSecret,
} from "../../server/ai/sessionSecrets.js";

/**
 * P2 — POST /api/providers/session-key/reuse.
 *
 * Proves the user-initiated, pair-limited credential reuse endpoint:
 *   - copies the OpenAI Text AI session key into a SEPARATE OpenAI Image entry;
 *   - never echoes the secret;
 *   - fails closed on a missing source, a non-reviewed pair, or a rotation
 *     conflict;
 *   - keeps source and target independently revocable.
 */

const SENTINEL = "SUPER_SECRET_OPENAI_REUSE_KEY_P2";
const REUSE_PATH = "/api/providers/session-key/reuse";
const SET_PATH = "/api/providers/session-key";
const STATUS_PATH = "/api/providers/session-key/status";

const ENV_KEYS = [
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "HOST",
  "AI_ENDPOINT_TOKEN",
  "KITCHEN_CODEX_SESSION_BYOK",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
  "SESSION_KEY_SET_RATE_LIMIT",
  "SESSION_KEY_REVOKE_RATE_LIMIT",
  "SESSION_KEY_STATUS_RATE_LIMIT",
] as const;

let server: http.Server;
let baseUrl: string;

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getStatus() {
  const res = await fetch(`${baseUrl}${STATUS_PATH}`);
  const body = (await res.json()) as { providers: { providerId: string; configured: boolean }[] };
  return { status: res.status, body };
}

beforeAll(async () => {
  const app = createApp({ isProduction: false });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetSessionSecretsForTests();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SESSION_KEY_SET_RATE_LIMIT = "1000";
  process.env.SESSION_KEY_REVOKE_RATE_LIMIT = "1000";
  process.env.SESSION_KEY_STATUS_RATE_LIMIT = "1000";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("P2 — explicit session-key reuse route", () => {
  it("copies the OpenAI text session key into a separate OpenAI Image entry without echoing it", async () => {
    const saved = await postJson(SET_PATH, { providerId: "openai", apiKey: SENTINEL });
    expect(saved.status).toBe(200);

    const reused = await postJson(REUSE_PATH, {
      fromProviderId: "openai",
      toProviderId: "openai-image",
    });
    expect(reused.status).toBe(200);
    expect(reused.body).toMatchObject({
      providerId: "openai-image",
      storageScope: "session_only",
      configured: true,
    });
    expect(JSON.stringify(reused.body)).not.toContain(SENTINEL);

    expect(getSessionSecret("openai")).toBe(SENTINEL);
    expect(getSessionSecret("openai-image")).toBe(SENTINEL);

    const status = await getStatus();
    expect(status.body.providers.find((p) => p.providerId === "openai")?.configured).toBe(true);
    expect(status.body.providers.find((p) => p.providerId === "openai-image")?.configured).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain(SENTINEL);
  });

  it("fails closed with SESSION_CREDENTIAL_MISSING when the source has no key", async () => {
    const res = await postJson(REUSE_PATH, {
      fromProviderId: "openai",
      toProviderId: "openai-image",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_CREDENTIAL_MISSING");
    expect(getSessionSecret("openai-image")).toBeUndefined();
  });

  it("rejects a non-reviewed pair (gemini -> openai-image) and creates NO target", async () => {
    await postJson(SET_PATH, { providerId: "gemini", apiKey: SENTINEL });
    const res = await postJson(REUSE_PATH, {
      fromProviderId: "gemini",
      toProviderId: "openai-image",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROVIDER_NOT_ALLOWED");
    expect(getSessionSecret("openai-image")).toBeUndefined();
  });

  it("rejects unknown / non-string provider ids", async () => {
    const unknown = await postJson(REUSE_PATH, {
      fromProviderId: "ghost",
      toProviderId: "openai-image",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("PROVIDER_NOT_ALLOWED");

    const wrongType = await postJson(REUSE_PATH, {
      fromProviderId: 42,
      toProviderId: "openai-image",
    });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.code).toBe("INVALID_REQUEST");
  });

  it("enforces rotation safety when the target already has a live key", async () => {
    await postJson(SET_PATH, { providerId: "openai", apiKey: SENTINEL });
    const first = await postJson(REUSE_PATH, {
      fromProviderId: "openai",
      toProviderId: "openai-image",
    });
    expect(first.status).toBe(200);
    const version = first.body.version as string;
    expect(typeof version).toBe("string");

    const conflict = await postJson(REUSE_PATH, {
      fromProviderId: "openai",
      toProviderId: "openai-image",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("VERSION_CONFLICT");

    const rotated = await postJson(REUSE_PATH, {
      fromProviderId: "openai",
      toProviderId: "openai-image",
      expectedVersion: version,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.version).not.toBe(version);
  });

  it("revoking the source leaves the copied image key independently usable", async () => {
    await postJson(SET_PATH, { providerId: "openai", apiKey: SENTINEL });
    await postJson(REUSE_PATH, { fromProviderId: "openai", toProviderId: "openai-image" });

    const revoked = await fetch(`${baseUrl}${SET_PATH}/openai`, { method: "DELETE" });
    expect(revoked.status).toBe(200);

    expect(getSessionSecret("openai")).toBeUndefined();
    expect(getSessionSecret("openai-image")).toBe(SENTINEL);
    const status = await getStatus();
    expect(status.body.providers.find((p) => p.providerId === "openai")?.configured).toBe(false);
    expect(status.body.providers.find((p) => p.providerId === "openai-image")?.configured).toBe(true);
  });
});
