import { describe, it, expect } from "vitest";
import {
  ImageGenerationAuthorizationStore,
  ImageGenerationAuthorizationCapacityError,
  DEFAULT_IMAGE_GENERATION_AUTH_TTL_MS,
} from "../../server/imageGenerationAuthorization.js";

const BINDING = {
  providerId: "openrouter-image",
  modelId: "google/gemini-2.5-flash-image",
  credentialSource: "server_environment" as const,
  credentialGeneration: 3,
  costClass: "paid" as const,
  pricingFingerprint: "fp-1",
  recipeBinding: "binding-recipe-a",
  vaultScope: "vault:vault-session-1",
};

function makeStore(
  overrides: Partial<ConstructorParameters<typeof ImageGenerationAuthorizationStore>[0]> = {},
  tokenPrefix = "token"
) {
  let now = 1_000_000;
  const store = new ImageGenerationAuthorizationStore({
    now: () => now,
    createToken: (() => {
      let i = 0;
      return () => `${tokenPrefix}-${++i}`;
    })(),
    ...overrides,
  });
  return { store, advance: (ms: number) => { now += ms; } };
}

describe("ImageGenerationAuthorizationStore — bounded single-use authorization", () => {
  it("issues a token and consumes it exactly once for a matching binding", () => {
    const { store } = makeStore();
    const issued = store.issue("requester-A", BINDING);
    expect(issued.token).toBe("token-1");
    expect(issued.expiresAt).toBeGreaterThan(0);
    expect(store.consume(issued.token, "requester-A", BINDING)).toEqual({ ok: true });
    // Second consume -> USED (zero second provider call).
    expect(store.consume(issued.token, "requester-A", BINDING)).toEqual({ ok: false, reason: "USED" });
  });

  it("rejects a missing / unknown / malformed token", () => {
    const { store } = makeStore();
    expect(store.consume(undefined, "r", BINDING)).toEqual({ ok: false, reason: "MISSING" });
    expect(store.consume("", "r", BINDING)).toEqual({ ok: false, reason: "MISSING" });
    expect(store.consume("nope", "r", BINDING)).toEqual({ ok: false, reason: "INVALID" });
    expect(store.consume("x".repeat(513), "r", BINDING)).toEqual({ ok: false, reason: "MISSING" });
  });

  it("expires synchronously after the TTL (no provider call)", () => {
    const { store, advance } = makeStore();
    const issued = store.issue("r", BINDING);
    advance(DEFAULT_IMAGE_GENERATION_AUTH_TTL_MS);
    // An expired record is swept; the bounded failure is indistinguishable from
    // any other invalid token (fail closed, zero provider calls).
    expect(store.consume(issued.token, "r", BINDING).ok).toBe(false);
  });

  it("rejects a requester mismatch without consuming the token", () => {
    const { store } = makeStore();
    const issued = store.issue("requester-A", BINDING);
    expect(store.consume(issued.token, "requester-B", BINDING)).toEqual({ ok: false, reason: "REQUESTER_MISMATCH" });
    // Still consumable by the rightful requester.
    expect(store.consume(issued.token, "requester-A", BINDING)).toEqual({ ok: true });
  });

  it("rejects provider / model / source / cost / fingerprint / recipe / scope mismatches without consuming", () => {
    const { store } = makeStore();
    const issued = store.issue("r", BINDING);
    const variants = [
      { ...BINDING, providerId: "gemini-image" },
      { ...BINDING, modelId: "other/model" },
      { ...BINDING, credentialSource: "session_only" as const },
      { ...BINDING, credentialGeneration: 4 },
      { ...BINDING, costClass: "variable" as const },
      { ...BINDING, pricingFingerprint: "fp-2" },
      { ...BINDING, recipeBinding: "binding-recipe-b" },
      { ...BINDING, vaultScope: "vault:vault-session-2" },
      { ...BINDING, vaultScope: "draft:no-vault" },
    ];
    for (const variant of variants) {
      expect(store.consume(issued.token, "r", variant)).toEqual({ ok: false, reason: "MISMATCH" });
    }
    // The genuine binding still works.
    expect(store.consume(issued.token, "r", BINDING)).toEqual({ ok: true });
  });

  it("the explicit draft scope never substitutes a vault scope (and reverse)", () => {
    const { store } = makeStore();
    const draft = { ...BINDING, vaultScope: "draft:no-vault" };
    const issued = store.issue("r", draft);
    expect(store.consume(issued.token, "r", { ...draft, vaultScope: "vault:anything" })).toEqual({
      ok: false,
      reason: "MISMATCH",
    });
    expect(store.consume(issued.token, "r", draft)).toEqual({ ok: true });
  });

  it("enforces strict per-requester and global capacity", () => {
    const { store } = makeStore({ maxPerRequester: 2, maxGlobal: 3 });
    store.issue("r", BINDING);
    store.issue("r", BINDING);
    expect(() => store.issue("r", BINDING)).toThrow(ImageGenerationAuthorizationCapacityError);
    store.issue("other", BINDING);
    expect(() => store.issue("third", BINDING)).toThrow(ImageGenerationAuthorizationCapacityError);
  });

  it("stores no credential, prompt, recipe content, or image bytes", () => {
    const { store } = makeStore();
    const issued = store.issue("r", BINDING);
    const serialized = JSON.stringify(store.stats()) + issued.token;
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("bytes");
  });

  it("rejects a credential-generation change (replace/revoke/expire/lazy-purge)", () => {
    const { store } = makeStore();
    const issued = store.issue("r", BINDING);
    expect(
      store.consume(issued.token, "r", { ...BINDING, credentialGeneration: BINDING.credentialGeneration + 1 })
    ).toEqual({ ok: false, reason: "MISMATCH" });
    // The original generation still authorizes exactly once.
    expect(store.consume(issued.token, "r", BINDING)).toEqual({ ok: true });
  });

  it("enforces the authorization contract version (legacy records fail closed)", () => {
    const { store: legacy } = makeStore({ contractVersion: "image_generation_auth_v0" }, "legacy");
    const legacyToken = legacy.issue("r", BINDING).token;
    // A record stamped with a legacy/unknown version never consumes under the
    // current contract version.
    expect(legacy.consume(legacyToken, "r", BINDING)).toEqual({ ok: false, reason: "MISMATCH" });

    const { store: current } = makeStore({}, "current");
    const goodToken = current.issue("r", BINDING).token;
    expect(current.consume(goodToken, "r", BINDING)).toEqual({ ok: true });
  });

  it("a version mismatch does not mutate unrelated records", () => {
    const { store: legacy } = makeStore({ contractVersion: "legacy" }, "legacy");
    const legacyToken = legacy.issue("r", BINDING).token;
    const { store: current } = makeStore({}, "current");
    const goodToken = current.issue("r", BINDING).token;
    // A legacy-versioned token is unknown to the current store.
    expect(current.consume(legacyToken, "r", BINDING).ok).toBe(false);
    // The unrelated good record is untouched and still consumable.
    expect(current.consume(goodToken, "r", BINDING)).toEqual({ ok: true });
  });
});
