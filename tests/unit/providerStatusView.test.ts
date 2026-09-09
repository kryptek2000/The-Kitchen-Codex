import { describe, it, expect } from "vitest";
import type { NetworkAdapter, NetworkResponse } from "../../src/application/adapters/NetworkAdapter.js";
import {
  CAPABILITY_KEYS,
  capabilityLabel,
  createRequestSequencer,
  fetchProviderStatus,
  normalizeProviderStatus,
  storageScopeLabel,
  PROVIDER_STATUS_API_PATH,
  type ProviderStatusView,
} from "../../src/application-ui/providerStatus.js";
import type { SecretStorageScope } from "../../src/application/adapters/SecretAdapter.js";
import type { AiCapability } from "../../src/core/ai/types.js";

const SENTINEL = "SUPER_SECRET_PHASE1E_SENTINEL";

function fakeGetNetwork(data: unknown, ok = true, status = 200): NetworkAdapter {
  const get = async <T,>(): Promise<NetworkResponse<T>> => ({ status, ok, data: data as T });
  return { get, request: async () => ({ status, ok, data: undefined }), post: async () => ({ status, ok, data: undefined }) } as unknown as NetworkAdapter;
}

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "gemini",
    name: "Google Gemini",
    configured: true,
    enabled: true,
    available: true,
    storageScope: "server_environment",
    supportsSecretWrites: false,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true },
    ...overrides,
  };
}

describe("provider status view model (v0.7 1E) — labels", () => {
  it("maps each storage scope to a truthful label", () => {
    expect(storageScopeLabel("server_environment")).toBe("Server environment");
    expect(storageScopeLabel("secure_platform")).toBe("Secure platform storage");
    expect(storageScopeLabel("local_plaintext")).toBe("Local plaintext storage");
    expect(storageScopeLabel("unavailable")).toBe("Unavailable");
  });

  it("does NOT label server_environment as secure/encrypted", () => {
    expect(storageScopeLabel("server_environment").toLowerCase()).not.toContain("secure");
    expect(storageScopeLabel("server_environment").toLowerCase()).not.toContain("encrypted");
  });

  it("maps each capability key to a human label and preserves unknown keys", () => {
    expect(capabilityLabel("reasoning")).toBe("Reasoning");
    expect(capabilityLabel("structuredOutput")).toBe("Structured Output");
    expect(capabilityLabel("recipeGeneration")).toBe("Recipe Generation");
    expect(capabilityLabel("webSearch")).toBe("Grounded Web Search");
    expect(capabilityLabel("futureCapability" as AiCapability)).toBe("futureCapability");
  });

  it("exposes the ordered capability keys", () => {
    expect(CAPABILITY_KEYS).toEqual(["reasoning", "structuredOutput", "recipeGeneration", "webSearch"]);
  });
});

describe("provider status view model (v0.7 1E) — normalization", () => {
  it("validates and keeps ONLY allowlisted fields (no secret-shaped field survives)", () => {
    const rows = normalizeProviderStatus({
      providers: [
        validRow({ apiKey: SENTINEL, token: SENTINEL, secret: SENTINEL, maskedKey: "abc1" }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].providerId).toBe("gemini");
    expect(rows[0].capabilities).toEqual({ reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("abc1");
    for (const k of Object.keys(rows[0])) {
      expect(["key", "token", "secret", "apiKey", "value", "maskedKey"].includes(k)).toBe(false);
    }
  });

  it("throws when the payload has no providers array or is empty", () => {
    expect(() => normalizeProviderStatus({})).toThrow();
    expect(() => normalizeProviderStatus({ providers: [] })).toThrow();
    expect(() => normalizeProviderStatus(null)).toThrow();
  });

  it("skips malformed rows without crashing", () => {
    const rows = normalizeProviderStatus({
      providers: [validRow(), { providerId: 42 }, validRow({ providerId: "openrouter", name: "OpenRouter" })],
    });
    expect(rows.map((r) => r.providerId)).toEqual(["gemini", "openrouter"]);
  });

  it("coerces capability booleans truthfully (unknown caps default false)", () => {
    const rows = normalizeProviderStatus({
      providers: [validRow({ capabilities: { reasoning: true, structuredOutput: false, recipeGeneration: false, webSearch: false } })],
    });
    expect(rows[0].capabilities).toEqual({ reasoning: true, structuredOutput: false, recipeGeneration: false, webSearch: false });
  });
});

describe("fetchProviderStatus (v0.7 1E)", () => {
  it("fetches the app-scoped path with the NetworkAdapter and returns rows", async () => {
    let requestedPath = "";
    const network = {
      get: async <T,>(p: string) => {
        requestedPath = p;
        return { status: 200, ok: true, data: { providers: [validRow()] } } as NetworkResponse<T>;
      },
      request: async () => ({ status: 200, ok: true, data: undefined }),
      post: async () => ({ status: 200, ok: true, data: undefined }),
    } as unknown as NetworkAdapter;
    const rows = await fetchProviderStatus(network);
    expect(requestedPath).toBe(PROVIDER_STATUS_API_PATH);
    expect(requestedPath).toBe("/api/providers");
    expect(rows).toHaveLength(1);
  });

  it("throws on a non-2xx response (no fabricated provider state)", async () => {
    await expect(fetchProviderStatus(fakeGetNetwork(undefined, false, 503))).rejects.toThrow();
  });

  it("throws when the response carries no data", async () => {
    await expect(fetchProviderStatus(fakeGetNetwork(undefined, true, 200))).rejects.toThrow();
  });

  it("propagates a transport failure as a thrown error", async () => {
    const network = { get: async () => { throw new Error("network down"); } } as unknown as NetworkAdapter;
    await expect(fetchProviderStatus(network)).rejects.toThrow(/network down/);
  });

  it("never returns a secret value to the caller", async () => {
    const rows = await fetchProviderStatus(fakeGetNetwork({ providers: [validRow({ apiKey: SENTINEL, key: SENTINEL })] }));
    const serialized = JSON.stringify(rows as ProviderStatusView[]);
    expect(serialized).not.toContain(SENTINEL);
  });
});

describe("request sequencer / refresh race (v0.7 1E correction)", () => {
  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
  }
  function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  // Mirrors the ProviderSettings.load() gating exactly (begin -> await -> only
  // commit if still current). Tested at the sequencer level (no DOM, no network).
  async function runLoad<T>(
    seq: { begin(): number; isCurrent(id: number): boolean },
    fetchFn: () => Promise<T>,
    onResult: (value: T) => void,
    onError: (e: unknown) => void
  ): Promise<void> {
    const id = seq.begin();
    try {
      const value = await fetchFn();
      if (seq.isCurrent(id)) onResult(value);
    } catch (e) {
      if (seq.isCurrent(id)) onError(e);
    }
  }

  it("the newest request wins: a stale SUCCESS resolving later is dropped", async () => {
    const seq = createRequestSequencer();
    const committed: string[] = [];
    const older = deferred<ProviderStatusView[]>();
    const newer = deferred<ProviderStatusView[]>();
    const runOlder = runLoad(seq, () => older.promise, () => committed.push("older"), () => committed.push("older-error"));
    const runNewer = runLoad(seq, () => newer.promise, () => committed.push("newer"), () => committed.push("newer-error"));

    // Newer (B) resolves first.
    newer.resolve([] as unknown as ProviderStatusView[]);
    await runNewer;
    expect(committed).toEqual(["newer"]);

    // Older (A) resolves later with stale data — must be ignored.
    older.resolve([] as unknown as ProviderStatusView[]);
    await runOlder;
    expect(committed).toEqual(["newer"]);
  });

  it("a stale FAILURE does not replace the newer success", async () => {
    const seq = createRequestSequencer();
    const committed: string[] = [];
    const older = deferred<ProviderStatusView[]>();
    const newer = deferred<ProviderStatusView[]>();
    const runOlder = runLoad(seq, () => older.promise, () => committed.push("older-ok"), () => committed.push("older-error"));
    const runNewer = runLoad(seq, () => newer.promise, () => committed.push("newer-ok"), () => committed.push("newer-error"));

    // Newer (B) succeeds first.
    newer.resolve([] as unknown as ProviderStatusView[]);
    await runNewer;
    expect(committed).toEqual(["newer-ok"]);

    // Older (A) then FAILS — its error must not replace B's success.
    older.reject(new Error("boom"));
    await runOlder;
    expect(committed).toEqual(["newer-ok"]);
  });

  it("a fresh request supersedes any prior in-flight request", () => {
    const seq = createRequestSequencer();
    const a = seq.begin();
    const b = seq.begin();
    const c = seq.begin();
    expect(seq.isCurrent(a)).toBe(false);
    expect(seq.isCurrent(b)).toBe(false);
    expect(seq.isCurrent(c)).toBe(true);
  });
});
