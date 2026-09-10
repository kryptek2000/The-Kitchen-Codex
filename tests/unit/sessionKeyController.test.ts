import { describe, it, expect } from "vitest";
import { SessionKeyController, type SessionKeyProviderOption } from "../../src/application-ui/sessionKeyController.js";
import type { NetworkAdapter } from "../../src/application/adapters/NetworkAdapter.js";

const SENTINEL = "sk-or-v1-CONTROLLER_SENTINEL";

interface Pending {
  method: string;
  path: string;
  body?: any;
  resolved: boolean;
  resolve: (value: any) => void;
}

function makeNetwork() {
  const pending: Pending[] = [];
  const network = {
    get: (path: string) => {
      let resolve!: (v: any) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      pending.push({ method: "GET", path, resolved: false, resolve });
      return promise;
    },
    post: (path: string, body: any) => {
      let resolve!: (v: any) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      pending.push({ method: "POST", path, body, resolved: false, resolve });
      return promise;
    },
    request: (req: any) => {
      let resolve!: (v: any) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      pending.push({ method: req.method, path: req.path, body: req.body, resolved: false, resolve });
      return promise;
    },
  };
  return { network: network as unknown as NetworkAdapter, pending };
}

function settle(pending: Pending[], method: string, pathPart: string, data: unknown, status = 200, ok = true) {
  const entry = pending.find((p) => !p.resolved && p.method === method && p.path.includes(pathPart));
  if (!entry) throw new Error(`no pending ${method} ${pathPart}`);
  entry.resolved = true;
  entry.resolve({ status, ok, data });
}

function settleAt(pending: Pending[], index: number, data: unknown, status = 200, ok = true) {
  const entry = pending[index];
  entry.resolved = true;
  entry.resolve({ status, ok, data });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const PROVIDERS: SessionKeyProviderOption[] = [
  { providerId: "openrouter", name: "OpenRouter", kind: "text", models: [{ id: "openai/gpt-4o-mini", default: true }] },
  { providerId: "deepseek", name: "DeepSeek", kind: "text", models: [{ id: "deepseek-v4-flash", default: true }] },
];

const A_CONFIGURED = {
  providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "A-EXP", version: "A-VER" }],
};
const A_EMPTY = { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: false }] };
const B_EMPTY = { providers: [{ providerId: "deepseek", storageScope: "session_only", configured: false }] };

describe("BYOK-5E — cross-provider race protection (preserved)", () => {
  it("a stale provider-A status never writes provider-B state", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    const aStatus = c.refreshStatus();
    c.selectProvider("deepseek");
    settle(pending, "GET", "status", A_CONFIGURED);
    await aStatus;
    expect(c.getState().selectedProviderId).toBe("deepseek");
    expect(c.getState().status).toBe("loading");
    settle(pending, "GET", "status", B_EMPTY);
    await flush();
    expect(c.getState().status).toBe("not-configured");
  });

  it("A -> B -> A: the original A request stays stale", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    const a1 = c.refreshStatus(); // pending[0] (generation 0)
    c.selectProvider("deepseek"); // pending[1]
    c.selectProvider("openrouter"); // pending[2]
    settleAt(pending, 2, A_CONFIGURED); // the NEW A response
    await flush();
    expect(c.getState().status).toBe("configured");
    settleAt(pending, 0, { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "STALE", version: "STALE" }] });
    await a1;
    // The very old A response is ignored despite providerId matching again.
    expect(c.getState().expiresAt).toBe("A-EXP");
  });

  it("unmount: a pending completion after dispose() does not update state", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    const aStatus = c.refreshStatus();
    c.setApiKey(SENTINEL);
    c.dispose();
    settle(pending, "GET", "status", A_CONFIGURED);
    await aStatus;
    expect(c.getState().status).toBe("loading");
    expect(c.getState().apiKey).toBe("");
  });
});

describe("BYOK-5E — same-provider operation ordering (operation epoch)", () => {
  it("A. SAVE -> REVOKE: the older save cannot restore a configured state", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    c.setApiKey("A-key");
    const aSave = c.save(); // pending[0] POST
    const aRevoke = c.revoke(); // pending[1] DELETE (supersedes save)
    settleAt(pending, 1, { providerId: "openrouter", configured: false });
    await flush(); // revoke -> status read pending[2]
    settleAt(pending, 2, A_EMPTY);
    await aRevoke;
    // The older save resolves AFTER the revoke.
    settleAt(pending, 0, { providerId: "openrouter", storageScope: "session_only", configured: true, version: "STALE" });
    await aSave;
    expect(c.getState().status).toBe("not-configured");
    expect(c.getState().notice?.text).toContain("revoked");
    expect(c.getState().saveState).toBe("idle");
    expect(c.getState().revokeState).toBe("idle");
    expect(c.getState().apiKey).toBe("");
  });

  it("B. TWO STATUS REFRESHES: refresh #1 cannot overwrite refresh #2", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    const r1 = c.refreshStatus(); // pending[0]
    const r2 = c.refreshStatus(); // pending[1] (newer)
    settleAt(pending, 1, { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "NEW", version: "NEW-V" }] });
    await flush();
    settleAt(pending, 0, { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "OLD", version: "OLD-V" }] });
    await r1;
    await r2;
    expect(c.getState().status).toBe("configured");
    expect(c.getState().expiresAt).toBe("NEW");
  });

  it("C. TEST -> REVOKE: the older test result is not restored", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    const aTest = c.test(); // pending[0] POST test-connection
    const aRevoke = c.revoke(); // pending[1] DELETE
    settleAt(pending, 1, { providerId: "openrouter", configured: false });
    await flush();
    settleAt(pending, 2, A_EMPTY);
    await aRevoke;
    settleAt(pending, 0, { ok: true, providerId: "openrouter", model: "m", credentialSource: "session_only" });
    await aTest;
    expect(c.getState().testResult).toBeUndefined();
    expect(c.getState().testState).toBe("idle");
  });

  it("D. SAVE #1 -> SAVE #2: save #1 cannot clear a newer typed key or overwrite #2", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    c.setApiKey("key-1");
    const s1 = c.save(); // pending[0]
    c.setApiKey("key-2");
    const s2 = c.save(); // pending[1] (newer)
    c.setApiKey("key-3"); // user keeps typing after save #2 started
    // save #2 completes first.
    settleAt(pending, 1, { providerId: "openrouter", storageScope: "session_only", configured: true, version: "V2" });
    await flush();
    settleAt(pending, 2, { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, version: "V2" }] });
    await s2;
    // save #1 resolves last and must be ignored.
    settleAt(pending, 0, { providerId: "openrouter", storageScope: "session_only", configured: true, version: "V1" });
    await s1;
    expect(c.getState().status).toBe("configured");
    expect(c.getState().notice?.text).toContain("saved");
  });

  it("D2. SAVE #1 -> SAVE #2: a stale save #1 does NOT clear a key typed after #2 started", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    c.setApiKey("key-1");
    const s1 = c.save(); // pending[0]
    c.setApiKey("key-2");
    const s2 = c.save(); // pending[1]
    c.setApiKey("key-3");
    settleAt(pending, 0, { providerId: "openrouter", storageScope: "session_only", configured: true, version: "V1" });
    await s1;
    // Stale save #1 must not clear the freshly typed key.
    expect(c.getState().apiKey).toBe("key-3");
    settleAt(pending, 1, { providerId: "openrouter", storageScope: "session_only", configured: true, version: "V2" });
    await flush();
    settleAt(pending, 2, { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, version: "V2" }] });
    await s2;
    expect(c.getState().status).toBe("configured");
  });

  it("E. VERSION_CONFLICT refresh cannot overwrite a newer operation", async () => {
    const { network, pending } = makeNetwork();
    const c = new SessionKeyController(network, PROVIDERS);
    c.setApiKey("key-1");
    const s1 = c.save(); // pending[0]
    settleAt(pending, 0, { code: "VERSION_CONFLICT", error: "conflict" }, 409, false);
    await flush(); // save -> conflict status read pending[1]
    const r = c.revoke(); // pending[2] DELETE (newer intent)
    settleAt(pending, 1, { providers: [{ providerId: "openrouter", storageScope: "session_only", configured: true, expiresAt: "STALE", version: "STALE" }] });
    await s1; // the conflict refresh completion is stale
    settleAt(pending, 2, { providerId: "openrouter", configured: false });
    await flush();
    settleAt(pending, 3, A_EMPTY);
    await r;
    expect(c.getState().status).toBe("not-configured");
    expect(c.getState().notice?.text).toContain("revoked");
  });
});
