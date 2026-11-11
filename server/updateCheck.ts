/**
 * Read-only update checking for The Kitchen Codex.
 *
 * This module NEVER installs, pulls, rebuilds, restarts, or modifies anything.
 * It only compares immutable build metadata against GitHub's published release
 * (stable channel) or the latest commit on `main` (development channel).
 */

export type UpdateChannel = "stable" | "development";

export type UpdateStatus =
  | "up-to-date"
  | "update-available"
  | "unknown"
  | "error";

export interface InstalledBuild {
  version: string;
  commit: string;
  buildTime?: string;
}

export interface UpdateCheckResult {
  channel: UpdateChannel;
  installed: InstalledBuild;
  latest: {
    version?: string;
    commit?: string;
    tag?: string;
    url?: string;
    publishedAt?: string;
  } | null;
  status: UpdateStatus;
  message: string;
  compareUrl?: string;
  checkedAt: string;
}

const GITHUB_OWNER = "kryptek2000";
const GITHUB_REPO = "The-Kitchen-Codex";
const API_BASE = "https://api.github.com";

function normalizeCommit(commit: string | undefined | null): string {
  return (commit || "").trim().toLowerCase();
}

export function isCommitSha(value: string | undefined | null): boolean {
  return /^[0-9a-f]{40}$/i.test(String(value || "").trim());
}

function isUnknownCommit(commit: string | undefined | null): boolean {
  const c = normalizeCommit(commit);
  return c === "" || c === "unknown" || c === "undefined" || c === "null";
}

const MAX_GITHUB_RESPONSE_BYTES = 256 * 1024;

async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string> {
  // Content-Length is an early warning only; enforce while streaming.
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error("GitHub response exceeded size limit");
    }
  }

  if (!res.body || typeof (res.body as any).getReader !== "function") {
    // Fail closed: an unbounded text() fallback could allocate without limit.
    throw new Error("GitHub response body is not streamable");
  }

  const reader = (res.body as any).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error("GitHub response exceeded size limit");
    }
    chunks.push(chunk);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs = 8000
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "The-Kitchen-Codex-Update-Checker",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub request failed: ${res.status} ${res.statusText}`);
    }
    const text = await readBodyWithLimit(res, MAX_GITHUB_RESPONSE_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("GitHub response was not valid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

export class ReleaseTagResolutionError extends Error {}

export async function fetchLatestStableRelease(
  fetchImpl: typeof fetch
): Promise<{ tag: string; commit: string; url: string; publishedAt?: string } | null> {
  // Prefer GitHub's latest stable release, but never trust a draft/prerelease.
  let release: any = null;
  try {
    const latest = await fetchJson(fetchImpl, `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
    if (latest && latest.draft === false && latest.prerelease === false) release = latest;
  } catch (err) {
    if (!/404/.test(err instanceof Error ? err.message : String(err))) throw err;
    release = null;
  }
  if (!release) {
    try {
      const releases = await fetchJson(fetchImpl, `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`);
      if (Array.isArray(releases)) {
        release = releases.find((r: any) => r && r.draft === false && r.prerelease === false) || null;
      }
    } catch (err) {
      if (!/404/.test(err instanceof Error ? err.message : String(err))) throw err;
      release = null;
    }
  }
  if (!release) return null;

  const tag = String(release?.tag_name || "").trim();
  if (!tag) return null;

  // Resolve the actual commit referenced by the tag. Lightweight and annotated
  // tags are both handled. There is NO fallback to main or target_commitish.
  let commit = "";
  let ref: any;
  try {
    ref = await fetchJson(fetchImpl, `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/tags/${encodeURIComponent(tag)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/404|not found/i.test(msg)) throw new ReleaseTagResolutionError("Unable to resolve release tag");
    throw err;
  }
  const refSha = String(ref?.object?.sha || "").trim();
  const refType = String(ref?.object?.type || "").trim();
  if (!refSha || !isCommitSha(refSha)) {
    throw new ReleaseTagResolutionError("Unable to resolve release tag");
  }
  if (refType !== "commit" && refType !== "tag") {
    throw new ReleaseTagResolutionError("Release tag does not point to a commit");
  }

  if (refType === "tag") {
    let tagObj: any;
    try {
      tagObj = await fetchJson(fetchImpl, `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/tags/${refSha}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|not found/i.test(msg)) throw new ReleaseTagResolutionError("Unable to dereference annotated release tag");
      throw err;
    }
    const dereferenced = String(tagObj?.object?.sha || "").trim();
    const dereferencedType = String(tagObj?.object?.type || "").trim();
    if (!dereferenced || !isCommitSha(dereferenced) || dereferencedType !== "commit") {
      throw new ReleaseTagResolutionError("Annotated release tag does not resolve to a commit");
    }
    commit = dereferenced;
  } else {
    commit = refSha;
  }

  if (!isCommitSha(commit)) {
    throw new ReleaseTagResolutionError("Resolved release identity is not a commit");
  }

  return {
    tag,
    commit,
    url: String(release?.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tag}`),
    publishedAt: release?.published_at ? String(release.published_at) : undefined,
  };
}

export async function fetchLatestDevelopmentCommit(
  fetchImpl: typeof fetch
): Promise<{ sha: string; url: string; date?: string } | null> {
  const data = await fetchJson(fetchImpl, `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/main`);
  const sha = String(data?.sha || "").trim();
  if (!sha || !isCommitSha(sha)) return null;
  return {
    sha,
    url: String(data?.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/commit/${sha}`),
    date: data?.commit?.committer?.date ? String(data.commit.committer.date) : undefined,
  };
}

export async function compareCommits(
  fetchImpl: typeof fetch,
  base: string,
  head: string
): Promise<{ status: string; url?: string } | null> {
  if (!isCommitSha(base) || !isCommitSha(head)) return null;
  try {
    const data = await fetchJson(
      fetchImpl,
      `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
    return {
      status: String(data?.status || "unknown"),
      url: data?.html_url ? String(data.html_url) : undefined,
    };
  } catch {
    return null;
  }
}

export async function checkForUpdates(
  installed: InstalledBuild,
  channel: UpdateChannel,
  fetchImpl: typeof fetch = fetch
): Promise<UpdateCheckResult> {
  const checkedAt = new Date().toISOString();
  const installedCommit = normalizeCommit(installed.commit);

  if (isUnknownCommit(installed.commit)) {
    return {
      channel,
      installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
      latest: null,
      status: "unknown",
      message: "Installed build identity is unknown; cannot confirm whether it is up to date.",
      checkedAt,
    };
  }

  try {
    if (channel === "stable") {
      let release: Awaited<ReturnType<typeof fetchLatestStableRelease>>;
      try {
        release = await fetchLatestStableRelease(fetchImpl);
      } catch (err) {
        if (err instanceof ReleaseTagResolutionError) {
          return {
            channel,
            installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
            latest: null,
            status: "unknown",
            message: "Stable release identity is unavailable.",
            checkedAt,
          };
        }
        throw err;
      }
      if (!release) {
        return {
          channel,
          installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
          latest: null,
          status: "unknown",
          message: "No published stable release was found.",
          checkedAt,
        };
      }

      if (!isCommitSha(release.commit)) {
        return {
          channel,
          installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
          latest: { version: release.tag, tag: release.tag, url: release.url, publishedAt: release.publishedAt },
          status: "unknown",
          message: "Stable release identity is not a verified commit.",
          checkedAt,
        };
      }

      const latestCommit = normalizeCommit(release.commit);
      let status: UpdateStatus = "unknown";
      let compareUrl = release.url;

      if (latestCommit && latestCommit === installedCommit) {
        status = "up-to-date";
      } else if (latestCommit) {
        const cmp = await compareCommits(fetchImpl, installedCommit, latestCommit);
        if (cmp?.status === "behind") {
          status = "update-available";
          compareUrl = cmp.url || compareUrl;
        } else if (cmp?.status === "identical") {
          status = "up-to-date";
          compareUrl = cmp.url || compareUrl;
        } else {
          status = "unknown";
        }
      }

      return {
        channel,
        installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
        latest: {
          version: release.tag,
          commit: release.commit || undefined,
          tag: release.tag,
          url: release.url,
          publishedAt: release.publishedAt,
        },
        status,
        message:
          status === "up-to-date"
            ? "You are up to date with the latest stable release."
            : status === "update-available"
            ? "A newer stable release is available."
            : "Unable to determine whether the stable release is newer than this build.",
        compareUrl,
        checkedAt,
      };
    }

    const dev = await fetchLatestDevelopmentCommit(fetchImpl);
    if (!dev) {
      return {
        channel,
        installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
        latest: null,
        status: "unknown",
        message: "No development commit was found on main.",
        checkedAt,
      };
    }

    if (!isCommitSha(dev.sha)) {
      return {
        channel,
        installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
        latest: null,
        status: "unknown",
        message: "Development build identity is not a verified commit.",
        checkedAt,
      };
    }

    const latestCommit = normalizeCommit(dev.sha);
    let status: UpdateStatus = "unknown";
    let compareUrl = dev.url;

    if (latestCommit === installedCommit) {
      status = "up-to-date";
    } else {
      const cmp = await compareCommits(fetchImpl, installedCommit, latestCommit);
      if (cmp?.status === "behind") {
        status = "update-available";
        compareUrl = cmp.url || compareUrl;
      } else if (cmp?.status === "identical") {
        status = "up-to-date";
        compareUrl = cmp.url || compareUrl;
      } else {
        status = "unknown";
      }
    }

    return {
      channel,
      installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
      latest: {
        commit: dev.sha,
        url: dev.url,
        publishedAt: dev.date,
      },
      status,
      message:
        status === "up-to-date"
          ? "You are up to date with the latest development build."
          : status === "update-available"
          ? "A newer approved development build is available on main."
          : "Unable to determine whether the development build is newer than this build.",
      compareUrl,
      checkedAt,
    };
  } catch (err) {
    return {
      channel,
      installed: { version: installed.version, commit: installed.commit, buildTime: installed.buildTime },
      latest: null,
      status: "error",
      message: `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt,
    };
  }
}

export interface UpdateCheckControllerOptions {
  installed: InstalledBuild;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  failureCooldownMs?: number;
  maxEntries?: number;
}

export interface UpdateCheckController {
  check(channel: UpdateChannel): Promise<UpdateCheckResult>;
  clear(): void;
}

export function createUpdateCheckController(
  options: UpdateCheckControllerOptions
): UpdateCheckController {
  const fetchImpl = options.fetchImpl || fetch;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const failureCooldownMs = options.failureCooldownMs ?? 30 * 1000;
  const maxEntries = options.maxEntries ?? 8;

  const cache = new Map<string, { value: UpdateCheckResult; expiresAt: number }>();
  const inFlight = new Map<string, Promise<UpdateCheckResult>>();
  const failureCooldownUntil = new Map<string, number>();
  const lastResult = new Map<string, UpdateCheckResult>();

  function evictIfNeeded() {
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }

  async function run(channel: UpdateChannel): Promise<UpdateCheckResult> {
    const key = channel;
    const now = Date.now();

    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const cooldownUntil = failureCooldownUntil.get(key) || 0;
    if (cooldownUntil > now && lastResult.has(key)) {
      return lastResult.get(key)!;
    }
    if (cooldownUntil > now) {
      const result: UpdateCheckResult = {
        channel,
        installed: options.installed,
        latest: null,
        status: "error",
        message: "Update check is temporarily unavailable after a recent failure.",
        checkedAt: new Date().toISOString(),
      };
      return result;
    }

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const result = await checkForUpdates(options.installed, channel, fetchImpl);
        lastResult.set(key, result);
        if (result.status !== "error") {
          cache.set(key, { value: result, expiresAt: Date.now() + cacheTtlMs });
          evictIfNeeded();
          failureCooldownUntil.delete(key);
        } else {
          failureCooldownUntil.set(key, Date.now() + failureCooldownMs);
        }
        return result;
      } catch (err) {
        const result: UpdateCheckResult = {
          channel,
          installed: options.installed,
          latest: null,
          status: "error",
          message: `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
          checkedAt: new Date().toISOString(),
        };
        lastResult.set(key, result);
        failureCooldownUntil.set(key, Date.now() + failureCooldownMs);
        return result;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  return {
    check: run,
    clear() {
      cache.clear();
      inFlight.clear();
      failureCooldownUntil.clear();
      lastResult.clear();
    },
  };
}
