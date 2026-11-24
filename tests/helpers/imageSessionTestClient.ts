/**
 * P2-R1 test helper: bootstrap a real image session against an ephemeral
 * `createApp` server and return the exact Cookie header value.
 *
 * This intentionally performs the REAL HTTP bootstrap + Set-Cookie exchange;
 * tests never fabricate a session cookie or bypass server validation.
 */

export interface ImageSessionBootstrap {
  cookie: string;
  expiresAt: number;
  setCookie: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function firstSetCookie(res: Response): string | undefined {
  const getSetCookie = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const all = getSetCookie.call(res.headers);
    if (all.length > 0) return all[0];
  }
  return res.headers.get("set-cookie") ?? undefined;
}

export async function bootstrapImageSession(
  baseUrl: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)
): Promise<ImageSessionBootstrap> {
  const res = await fetchImpl(`${baseUrl}/api/session/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`image session bootstrap failed with HTTP ${res.status}`);
  }
  const setCookie = firstSetCookie(res);
  if (!setCookie) throw new Error("image session bootstrap returned no Set-Cookie");
  const cookie = setCookie.split(";")[0];
  if (!cookie.startsWith("tkc_image_session=")) {
    throw new Error("image session bootstrap returned an unexpected cookie");
  }
  const body = (await res.json()) as { expiresAt?: unknown };
  return {
    cookie,
    setCookie,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : 0,
  };
}

/** A syntactically valid but unknown/forged session cookie. */
export function forgedImageSessionCookie(): string {
  return "tkc_image_session=forged-session-token-not-issued-by-server";
}
