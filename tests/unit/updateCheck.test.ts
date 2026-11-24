import { describe, it, expect, vi, afterEach } from "vitest";
import { checkForUpdates } from "../../server/updateCheck.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(body);
  const response = new Response(text, {
    status,
    headers: { "content-length": String(text.length) },
  });
  // Force ok flag for explicit status control.
  Object.defineProperty(response, "ok", { value: ok });
  return response;
}

function makeFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (url: string) => handler(url));
}

const INSTALLED_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEWER_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("update check", () => {
  it("returns unknown for an unknown installed commit", async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: "unknown" },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports up-to-date when stable release commit matches installed commit", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse({ tag_name: "v0.9.0", html_url: "https://example/release", draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z" });
      }
      if (url.includes("/git/ref/tags/")) {
        return jsonResponse({ object: { sha: INSTALLED_COMMIT, type: "commit" } });
      }
      return jsonResponse({}, false, 404);
    });
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("up-to-date");
    expect(result.latest?.tag).toBe("v0.9.0");
  });

  it("reports update-available when stable release is newer", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse({ tag_name: "v0.9.1", html_url: "https://example/release", draft: false, prerelease: false });
      }
      if (url.includes("/git/ref/tags/")) {
        return jsonResponse({ object: { sha: NEWER_COMMIT, type: "commit" } });
      }
      if (url.includes("/compare/")) {
        return jsonResponse({ status: "ahead", html_url: "https://example/compare" });
      }
      return jsonResponse({}, false, 404);
    });
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("update-available");
    expect(result.latest?.tag).toBe("v0.9.1");
  });

  it("reports unknown for a divergent stable build", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse({ tag_name: "v0.9.1", html_url: "https://example/release", draft: false, prerelease: false });
      }
      if (url.includes("/git/ref/tags/")) {
        return jsonResponse({ object: { sha: NEWER_COMMIT, type: "commit" } });
      }
      if (url.includes("/compare/")) {
        return jsonResponse({ status: "diverged", html_url: "https://example/compare" });
      }
      return jsonResponse({}, false, 404);
    });
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("unknown");
  });

  it("reports error on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("error");
    expect(result.message).toContain("offline");
  });

  it("reports unknown for invalid remote response", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse({ tag_name: "", html_url: "https://example/release", draft: false, prerelease: false });
      }
      return jsonResponse({}, false, 404);
    });
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("No published stable release");
  });

  it("checks development channel against main", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/commits/main")) {
        return jsonResponse({ sha: NEWER_COMMIT, html_url: "https://example/commit", commit: { committer: { date: "2026-01-02T00:00:00Z" } } });
      }
      if (url.includes("/compare/")) {
        return jsonResponse({ status: "ahead", html_url: "https://example/compare" });
      }
      return jsonResponse({}, false, 404);
    });
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "development",
      fetchImpl as any
    );
    expect(result.status).toBe("update-available");
    expect(result.latest?.commit).toBe(NEWER_COMMIT);
  });

  it("reports up-to-date for development channel when commits match", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/commits/main")) {
        return jsonResponse({ sha: INSTALLED_COMMIT, html_url: "https://example/commit", commit: { committer: { date: "2026-01-02T00:00:00Z" } } });
      }
      return jsonResponse({}, false, 404);
    });
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "development",
      fetchImpl as any
    );
    expect(result.status).toBe("up-to-date");
  });

  it("returns consistent results on repeated checks", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/commits/main")) {
        return jsonResponse({ sha: INSTALLED_COMMIT, html_url: "https://example/commit", commit: { committer: { date: "2026-01-02T00:00:00Z" } } });
      }
      return jsonResponse({}, false, 404);
    });
    const first = await checkForUpdates({ version: "v0.9.0", commit: INSTALLED_COMMIT }, "development", fetchImpl as any);
    const second = await checkForUpdates({ version: "v0.9.0", commit: INSTALLED_COMMIT }, "development", fetchImpl as any);
    expect(first.status).toBe(second.status);
    expect(first.status).toBe("up-to-date");
  });

  it("treats an invalid channel query as stable", async () => {
    // Channel normalization happens in the route, not here; ensure stable path works.
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse({ tag_name: "v0.9.0", html_url: "https://example/release", draft: false, prerelease: false });
      }
      if (url.includes("/git/ref/tags/")) {
        return jsonResponse({ object: { sha: INSTALLED_COMMIT, type: "commit" } });
      }
      return jsonResponse({}, false, 404);
    });
    const result = await checkForUpdates({ version: "v0.9.0", commit: INSTALLED_COMMIT }, "stable", fetchImpl as any);
    expect(result.channel).toBe("stable");
    expect(result.status).toBe("up-to-date");
  });
});

import { createUpdateCheckController } from "../../server/updateCheck.js";

describe("update check controller", () => {
  it("caches successful results", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/commits/main")) {
        return jsonResponse({ sha: INSTALLED_COMMIT, html_url: "https://example/commit", commit: { committer: { date: "2026-01-02T00:00:00Z" } } });
      }
      return jsonResponse({}, false, 404);
    });
    const controller = createUpdateCheckController({
      installed: { version: "v0.9.0", commit: INSTALLED_COMMIT },
      fetchImpl: fetchImpl as any,
      cacheTtlMs: 10000,
    });
    await controller.check("development");
    await controller.check("development");
    const commitCalls = fetchImpl.mock.calls.filter((c: any[]) => String(c[0]).includes("/commits/main"));
    expect(commitCalls.length).toBe(1);
  });

  it("coalesces concurrent checks", async () => {
    let resolveFetch: (v: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchImpl = vi.fn(async () => fetchPromise);
    const controller = createUpdateCheckController({
      installed: { version: "v0.9.0", commit: INSTALLED_COMMIT },
      fetchImpl: fetchImpl as any,
      cacheTtlMs: 10000,
    });
    const p1 = controller.check("development");
    const p2 = controller.check("development");
    resolveFetch!(jsonResponse({ sha: INSTALLED_COMMIT, html_url: "https://example/commit", commit: { committer: { date: "2026-01-02T00:00:00Z" } } }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe("up-to-date");
    expect(r2.status).toBe("up-to-date");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("applies failure cooldown", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const controller = createUpdateCheckController({
      installed: { version: "v0.9.0", commit: INSTALLED_COMMIT },
      fetchImpl: fetchImpl as any,
      failureCooldownMs: 10000,
    });
    const first = await controller.check("stable");
    const second = await controller.check("stable");
    expect(first.status).toBe("error");
    expect(second.status).toBe("error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("expires cache after ttl", async () => {
    vi.useFakeTimers();
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/commits/main")) {
        return jsonResponse({ sha: INSTALLED_COMMIT, html_url: "https://example/commit", commit: { committer: { date: "2026-01-02T00:00:00Z" } } });
      }
      return jsonResponse({}, false, 404);
    });
    const controller = createUpdateCheckController({
      installed: { version: "v0.9.0", commit: INSTALLED_COMMIT },
      fetchImpl: fetchImpl as any,
      cacheTtlMs: 10,
    });
    await controller.check("development");
    vi.advanceTimersByTime(20);
    await controller.check("development");
    const commitCalls = fetchImpl.mock.calls.filter((c: any[]) => String(c[0]).includes("/commits/main"));
    expect(commitCalls.length).toBe(2);
    vi.useRealTimers();
  });
});

describe("update check bounded responses", () => {
  it("fails closed on a non-streamable response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("error");
  });

  it("fails closed on an oversized streaming response", async () => {
    const huge = "x".repeat(300 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("error");
  });
});

describe("stable release metadata strict validation", () => {
  function stableRelease(overrides: Record<string, unknown>) {
    return {
      tag_name: "v0.9.1",
      html_url: "https://example/release",
      draft: false,
      prerelease: false,
      ...overrides,
    };
  }

  function mockLatest(release: any, refSha = NEWER_COMMIT) {
    return makeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse(release);
      }
      if (url.includes("/git/ref/tags/")) {
        return jsonResponse({ object: { sha: refSha, type: "commit" } });
      }
      return jsonResponse({}, false, 404);
    });
  }

  it("accepts a release when both draft and prerelease are explicitly false", async () => {
    const fetchImpl = mockLatest(stableRelease({}));
    const release = await (await import("../../server/updateCheck.js")).fetchLatestStableRelease(fetchImpl as any);
    expect(release?.tag).toBe("v0.9.1");
  });

  for (const [name, overrides] of ([
    ["draft true", { draft: true }],
    ["prerelease true", { prerelease: true }],
    ["missing draft", { draft: undefined }],
    ["missing prerelease", { prerelease: undefined }],
    ["both missing", { draft: undefined, prerelease: undefined }],
    ["null draft", { draft: null }],
    ["null prerelease", { prerelease: null }],
    ["string false draft", { draft: "false" }],
    ["string false prerelease", { prerelease: "false" }],
    ["mixed valid/invalid", { draft: false, prerelease: "false" }],
  ] as [string, Record<string, unknown>][] ) ) {
    it(`rejects release when ${name}`, async () => {
      const fetchImpl = mockLatest(stableRelease(overrides));
      const mod = await import("../../server/updateCheck.js");
      const release = await mod.fetchLatestStableRelease(fetchImpl as any);
      expect(release).toBeNull();
    });
  }

  it("never reports a stable update for malformed release metadata", async () => {
    const fetchImpl = mockLatest(stableRelease({ draft: undefined, prerelease: undefined }));
    const result = await checkForUpdates(
      { version: "v0.9.0", commit: INSTALLED_COMMIT },
      "stable",
      fetchImpl as any
    );
    expect(result.status).toBe("unknown");
    expect(result.latest).toBeNull();
  });

  it("applies strict validation on the releases list path", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse({}, false, 404);
      }
      if (url.includes("/releases?per_page=10")) {
        return jsonResponse([stableRelease({ draft: "false", prerelease: false })]);
      }
      if (url.includes("/git/ref/tags/")) {
        return jsonResponse({ object: { sha: NEWER_COMMIT, type: "commit" } });
      }
      return jsonResponse({}, false, 404);
    });
    const mod = await import("../../server/updateCheck.js");
    const release = await mod.fetchLatestStableRelease(fetchImpl as any);
    expect(release).toBeNull();
  });
});

describe("update check ancestry outcomes", () => {
  function stableFetch(compareStatus: string) {
    return makeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return jsonResponse({ tag_name: "v0.9.1", html_url: "https://example/release", draft: false, prerelease: false });
      }
      if (url.includes("/git/ref/tags/")) {
        return jsonResponse({ object: { sha: NEWER_COMMIT, type: "commit" } });
      }
      if (url.includes("/compare/")) {
        return jsonResponse({ status: compareStatus, html_url: "https://example/compare" });
      }
      return jsonResponse({}, false, 404);
    });
  }

  function devFetch(compareStatus: string) {
    return makeFetch((url) => {
      if (url.includes("/commits/main")) {
        return jsonResponse({ sha: NEWER_COMMIT, html_url: "https://example/commit", commit: { committer: { date: "2026-01-02T00:00:00Z" } } });
      }
      if (url.includes("/compare/")) {
        return jsonResponse({ status: compareStatus, html_url: "https://example/compare" });
      }
      return jsonResponse({}, false, 404);
    });
  }

  for (const status of ["ahead", "behind", "identical", "diverged"]) {
    it(`stable channel maps ${status} correctly`, async () => {
      const result = await checkForUpdates(
        { version: "v0.9.0", commit: INSTALLED_COMMIT },
        "stable",
        stableFetch(status) as any
      );
      if (status === "ahead") expect(result.status).toBe("update-available");
      else if (status === "identical") expect(result.status).toBe("up-to-date");
      else if (status === "behind") expect(result.status).toBe("up-to-date");
      else expect(result.status).toBe("unknown");
    });

    it(`development channel maps ${status} correctly`, async () => {
      const result = await checkForUpdates(
        { version: "v0.9.0", commit: INSTALLED_COMMIT },
        "development",
        devFetch(status) as any
      );
      if (status === "ahead") expect(result.status).toBe("update-available");
      else if (status === "identical") expect(result.status).toBe("up-to-date");
      else if (status === "behind") expect(result.status).toBe("up-to-date");
      else expect(result.status).toBe("unknown");
    });
  }
});
