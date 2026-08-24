import dns from "dns/promises";
import net from "net";
import http from "http";
import https from "https";
import type { IncomingMessage } from "http";
import type { LookupFunction } from "net";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const FETCH_TIMEOUT_MS = 8000; // 8 seconds
const MAX_REDIRECTS = 5;

/**
 * Checks whether an IPv4 number/array is in a restricted range.
 */
function isRestrictedIPv4(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some((o) => isNaN(o) || o < 0 || o > 255)) {
    return true; // Invalid is treated as unsafe
  }

  const [o0, o1, o2, o3] = octets;

  // 0.0.0.0/8 - Current network
  if (o0 === 0) return true;

  // 10.0.0.0/8 - Private RFC 1918
  if (o0 === 10) return true;

  // 100.64.0.0/10 - Shared address space / Carrier-grade NAT (RFC 6598)
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return true;

  // 127.0.0.0/8 - Loopback
  if (o0 === 127) return true;

  // 169.254.0.0/16 - Link-local & Cloud Metadata (includes 169.254.169.254)
  if (o0 === 169 && o1 === 254) return true;

  // 172.16.0.0/12 - Private RFC 1918 (172.16.0.0 - 172.31.255.255)
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;

  // 192.0.0.0/24 - IETF Protocol Assignments
  if (o0 === 192 && o1 === 0 && o2 === 0) return true;

  // 192.0.2.0/24 - TEST-NET-1 documentation
  if (o0 === 192 && o1 === 0 && o2 === 2) return true;

  // 192.88.99.0/24 - 6to4 relay anycast
  if (o0 === 192 && o1 === 88 && o2 === 99) return true;

  // 192.168.0.0/16 - Private RFC 1918
  if (o0 === 192 && o1 === 168) return true;

  // 198.18.0.0/15 - Network benchmark testing (198.18.0.0 - 198.19.255.255)
  if (o0 === 198 && (o1 === 18 || o1 === 19)) return true;

  // 198.51.100.0/24 - TEST-NET-2 documentation
  if (o0 === 198 && o1 === 51 && o2 === 100) return true;

  // 203.0.113.0/24 - TEST-NET-3 documentation
  if (o0 === 203 && o1 === 0 && o2 === 113) return true;

  // 224.0.0.0/4 - Multicast
  if (o0 >= 224 && o0 <= 239) return true;

  // 240.0.0.0/4 - Reserved (includes 255.255.255.255 broadcast)
  if (o0 >= 240) return true;

  return false;
}

/**
 * Parses any valid IPv6 string (including compressed ::, hex, or embedded IPv4 notation)
 * into an array of 8 16-bit integers (hextets).
 */
export function parseIPv6ToHextets(ip: string): number[] | null {
  let normalized = ip.toLowerCase().trim().replace(/^\[|\]$/g, "");

  // Check if there is an embedded IPv4 part at the end (e.g. ::ffff:127.0.0.1 or 64:ff9b::192.168.1.1)
  const lastColon = normalized.lastIndexOf(":");
  let embeddedV4Hextets: number[] | null = null;
  if (lastColon !== -1) {
    const potentialV4 = normalized.substring(lastColon + 1);
    if (potentialV4.includes(".")) {
      const v4Parts = potentialV4.split(".").map(Number);
      if (v4Parts.length === 4 && v4Parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
        embeddedV4Hextets = [
          (v4Parts[0] << 8) | v4Parts[1],
          (v4Parts[2] << 8) | v4Parts[3],
        ];
        normalized = normalized.substring(0, lastColon);
      }
    }
  }

  const doubleColonCount = (normalized.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null; // Invalid IPv6

  let parts: string[];
  if (doubleColonCount === 1) {
    const [left, right] = normalized.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const totalExpected = 8 - (embeddedV4Hextets ? 2 : 0);
    const missing = totalExpected - (leftParts.length + rightParts.length);
    if (missing < 0) return null;
    const zeros = new Array(missing).fill("0");
    parts = [...leftParts, ...zeros, ...rightParts];
  } else {
    parts = normalized.split(":");
  }

  const hextets: number[] = [];
  for (const part of parts) {
    const num = parseInt(part || "0", 16);
    if (isNaN(num) || num < 0 || num > 0xffff) return null;
    hextets.push(num);
  }

  if (embeddedV4Hextets) {
    hextets.push(...embeddedV4Hextets);
  }

  if (hextets.length !== 8) return null;
  return hextets;
}

/**
 * Checks if a parsed IPv6 address falls within forbidden ranges.
 */
function isRestrictedIPv6(ip: string): boolean {
  const hextets = parseIPv6ToHextets(ip);
  if (!hextets) return true; // Malformed IPv6 treated as restricted

  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;

  // 1. :: (Unspecified) and ::1 (Loopback)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0) {
    if (h7 === 0 || h7 === 1) return true;
  }

  // 2. IPv4-mapped IPv6 (::ffff:0:0/96, e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    const octets = [(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff];
    return isRestrictedIPv4(octets);
  }

  // 3. IPv4/IPv6 translation (64:ff9b::/96)
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    const octets = [(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff];
    return isRestrictedIPv4(octets);
  }

  // 4. 6to4 prefix (2002::/16) embeds IPv4 in the next 32 bits
  if (h0 === 0x2002) {
    const octets = [(h1 >> 8) & 0xff, h1 & 0xff, (h2 >> 8) & 0xff, h2 & 0xff];
    return isRestrictedIPv4(octets);
  }

  // 5. Unique Local Address (fc00::/7 -> fc00:: to fdff::)
  if ((h0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // 6. Link-local Unicast (fe80::/10)
  if ((h0 & 0xffc0) === 0xfe80) {
    return true;
  }

  // 7. Multicast (ff00::/8)
  if ((h0 & 0xff00) === 0xff00) {
    return true;
  }

  // 8. Documentation (2001:db8::/32)
  if (h0 === 0x2001 && h1 === 0x0db8) {
    return true;
  }

  // 9. Discard prefix (100::/64)
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) {
    return true;
  }

  return false;
}

/**
 * Checks whether an IP string is restricted (private, loopback, link-local, multicast, metadata).
 */
export function isRestrictedIP(ip: string): boolean {
  const cleanIp = ip.trim().replace(/^\[|\]$/g, "");

  if (net.isIPv4(cleanIp)) {
    const octets = cleanIp.split(".").map(Number);
    return isRestrictedIPv4(octets);
  }

  if (net.isIPv6(cleanIp) || parseIPv6ToHextets(cleanIp) !== null) {
    return isRestrictedIPv6(cleanIp);
  }

  return true; // Not a valid IP -> restricted
}

/**
 * Hostname validation to block known local/metadata aliases immediately.
 */
function isRestrictedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().trim();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host === "metadata.internal" ||
    host === "metadata" ||
    host === "instance-data" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.endsWith(".corp") ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  ) {
    return true;
  }

  return false;
}

/**
 * Performs the synchronous URL checks that do not require DNS:
 * parsing, scheme allowlisting, credential rejection and hostname blacklisting.
 */
function parseAndValidateUrl(urlString: string): URL {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new Error("Invalid URL format.");
  }

  // 1. Restrict scheme strictly to HTTP or HTTPS
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are permitted.");
  }

  // 2. Reject embedded credentials (user:pass@host)
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("URLs with user authentication credentials are not permitted.");
  }

  // 3. Fast-path hostname blacklist check
  if (isRestrictedHostname(parsedUrl.hostname)) {
    throw new Error("The target host is restricted.");
  }

  return parsedUrl;
}

/**
 * A URL that has passed every SSRF validation check together with the single,
 * validated IP address that the outbound connection MUST use.
 *
 * Pinning the resolved IP into the connection itself closes the
 * validation-to-connection DNS rebinding race (TOCTOU): the hostname is
 * resolved exactly once here, every resulting address is checked with the
 * full SSRF rule set, and the transport layer is forbidden from resolving
 * the hostname again.
 */
export interface PinnedTarget {
  /** Original URL (original hostname/port preserved for Host/SNI semantics). */
  url: URL;
  /** The validated IP address the socket must connect to. */
  ip: string;
  /** Address family of `ip` (4 or 6). */
  family: 4 | 6;
}

/**
 * Validates a URL against SSRF rules and resolves it exactly once.
 *
 * Checks performed (in order):
 * 1. Scheme strictly HTTP or HTTPS.
 * 2. No embedded credentials.
 * 3. Hostname blacklist (localhost/metadata aliases).
 * 4. If the hostname is a literal IP, that IP is validated directly.
 * 5. Otherwise a SINGLE authoritative DNS lookup resolves ALL A/AAAA records
 *    (verbatim order preserved) and every returned address must pass
 *    `isRestrictedIP`. The first record becomes the pinned connection target.
 *
 * Because resolution happens exactly once per hop and the pinned IP is what
 * the socket connects to, an attacker-controlled DNS server cannot change the
 * destination between validation and connection (DNS rebinding).
 */
export async function validateAndPinUrl(urlString: string): Promise<PinnedTarget> {
  const parsedUrl = parseAndValidateUrl(urlString);

  // If hostname is directly an IP literal (e.g. http://127.0.0.1 or http://[::1])
  const cleanHost = parsedUrl.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = net.isIP(cleanHost);
  if (literalFamily !== 0) {
    if (isRestrictedIP(cleanHost)) {
      throw new Error("The target IP address is restricted.");
    }
    return {
      url: parsedUrl,
      ip: cleanHost,
      family: literalFamily === 6 ? 6 : 4,
    };
  }

  // Single authoritative DNS resolution: resolve ALL IPv4 and IPv6 addresses
  // once. This exact result set is what gets validated and pinned — no later
  // lookup can override it.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(parsedUrl.hostname, { all: true, verbatim: true });
  } catch (dnsErr: any) {
    if (dnsErr?.message?.includes("restricted")) {
      throw dnsErr;
    }
    throw new Error("Failed to resolve hostname.");
  }

  if (!records || records.length === 0) {
    throw new Error("Unable to resolve target host.");
  }

  for (const record of records) {
    if (isRestrictedIP(record.address)) {
      throw new Error("The target host resolved to a restricted IP address.");
    }
  }

  // Preserve the resolver's verbatim ordering when choosing the pinned address.
  const chosen = records[0];
  return {
    url: parsedUrl,
    ip: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
  };
}

/**
 * Backwards-compatible validation entry point: validates the URL against all
 * SSRF rules and returns the parsed URL on success.
 */
export async function validateUrlForSSRF(urlString: string): Promise<URL> {
  const target = await validateAndPinUrl(urlString);
  return target.url;
}

/**
 * Derives the HTTP Host header value for the ORIGINAL hostname so that
 * name-based virtual hosting and routing keep working even though the socket
 * dials the pinned IP. Default ports are omitted by the WHATWG URL parser, so
 * any remaining explicit port must be kept in the header value.
 */
export function deriveHostHeader(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

/**
 * The concrete wire-level plan for a pinned outbound request. Exposed for
 * deterministic verification of SNI/Host/port behavior without a network.
 */
export interface PinnedRequestPlan {
  /** Validated IP the socket will dial. */
  host: string;
  port: number;
  family: 4 | 6;
  path: string;
  method: string;
  /** HTTP Host header derived from the ORIGINAL hostname (never the IP). */
  hostHeader: string;
  /**
   * TLS SNI / certificate identity: always the original hostname for HTTPS.
   * Deliberately omitted for IP-literal hosts (RFC 6066 forbids literal IPs
   * in SNI; certificate IP SANs are matched automatically by Node).
   */
  servername?: string;
}

export function planPinnedRequest(target: PinnedTarget, method: string = "GET"): PinnedRequestPlan {
  const url = target.url;
  const isIpLiteralHost = net.isIP(url.hostname) !== 0;
  return {
    host: target.ip,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    family: target.family,
    path: `${url.pathname}${url.search}`,
    method,
    hostHeader: deriveHostHeader(url),
    servername: url.protocol === "https:" && !isIpLiteralHost ? url.hostname : undefined,
  };
}

/**
 * Builds a DNS `lookup` function that hard-pins the connection to the
 * already-validated address. Belt-and-suspenders: because we dial the IP
 * literal directly no resolution should ever be attempted, but if anything
 * downstream does attempt one it can only ever yield the validated IP.
 */
function createPinnedLookup(target: PinnedTarget): LookupFunction {
  return (hostname, _options, callback) => {
    if (hostname !== target.ip) {
      callback(new Error("SSRF guard refused to resolve a non-validated address."), "");
      return;
    }
    callback(null, target.ip, target.family);
  };
}

interface PinnedHttpRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Issues a GET request whose TCP/TLS connection is bound to the validated IP:
 * - Connects to `target.ip` directly (no hostname resolution).
 * - Sends Host derived from the ORIGINAL hostname (virtual-host compatible).
 * - For HTTPS, sets TLS servername to the ORIGINAL hostname so certificate
 *   validation and SNI behave exactly like a normal fetch to that hostname.
 * - Uses a fresh connection (`agent: false`) so sockets are never reused
 *   across different validation/pinning contexts.
 */
function pinnedHttpRequest(
  target: PinnedTarget,
  options: PinnedHttpRequestOptions = {}
): Promise<IncomingMessage> {
  const plan = planPinnedRequest(target);
  const transport = target.url.protocol === "https:" ? https : http;

  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = transport.request(
      {
        host: plan.host,
        family: plan.family,
        port: plan.port,
        path: plan.path,
        method: plan.method,
        headers: {
          ...(options.headers ?? {}),
          Host: plan.hostHeader,
        },
        agent: false,
        servername: plan.servername,
        lookup: createPinnedLookup(target),
        signal: options.signal,
      },
      resolve
    );
    request.on("error", reject);
    request.end();
  });
}

function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; code?: string };
  return (
    e?.name === "TimeoutError" ||
    e?.name === "AbortError" ||
    e?.code === "ABORT_ERR" ||
    e?.code === "ETIMEDOUT"
  );
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Reads a response body as a stream with a strict byte counter, destroying
 * the socket as soon as the cap would be exceeded.
 */
async function readBodyWithCap(
  response: IncomingMessage,
  maxBytes: number,
  sizeErrorMessage: string
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of response) {
    const buf = chunk as Buffer;
    receivedBytes += buf.length;
    if (receivedBytes > maxBytes) {
      response.destroy();
      throw new Error(sizeErrorMessage);
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

/**
 * Secure HTML fetch with:
 * - SSRF protection with SINGLE-RESOLUTION DNS PINNING (anti-rebinding):
 *   the hostname is resolved once, every address validated, and the outbound
 *   socket is forced onto the validated IP while keeping the original
 *   hostname for HTTP Host semantics and TLS SNI/certificate validation.
 * - Strict HTTP/HTTPS scheme restriction
 * - 8-second timeout via AbortSignal
 * - 2 MB max body size streaming enforcement
 * - Manual redirect handling with FULL re-validation and re-pinning of every
 *   redirect target (a redirect cannot smuggle in a second, unchecked hop)
 */
export async function safeFetchHtml(initialUrl: string): Promise<{ html: string; finalUrl: string }> {
  let currentUrl = initialUrl;
  let redirectsFollowed = 0;

  while (redirectsFollowed <= MAX_REDIRECTS) {
    // 1. Validate current URL and pin its single validated DNS resolution
    const target = await validateAndPinUrl(currentUrl);

    // 2. Outbound request pinned to the validated IP, with timeout signal
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

    let response: IncomingMessage;
    try {
      response = await pinnedHttpRequest(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
        signal: timeoutSignal,
      });
    } catch (fetchErr: any) {
      if (isTimeoutError(fetchErr)) {
        throw new Error("Request timed out while fetching the webpage (8s limit).");
      }
      throw fetchErr;
    }

    const status = response.statusCode ?? 0;

    // 3. Handle redirects manually and re-validate + re-pin each target
    if (status >= 300 && status < 400) {
      const locationHeader = normalizeHeader(response.headers["location"]);
      response.destroy();
      if (!locationHeader) {
        throw new Error("Redirect location header missing.");
      }

      redirectsFollowed++;
      if (redirectsFollowed > MAX_REDIRECTS) {
        throw new Error("Too many redirects encountered.");
      }

      // Resolve relative redirect against current URL
      currentUrl = new URL(locationHeader, target.url).toString();
      continue;
    }

    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`Remote server responded with status HTTP ${status}.`);
    }

    // 4. Check Content-Length header if present
    const contentLength = normalizeHeader(response.headers["content-length"]);
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (!isNaN(parsedLength) && parsedLength > MAX_BODY_BYTES) {
        response.destroy();
        throw new Error("Webpage response size exceeds the 2MB limit.");
      }
    }

    // 5. Stream response body with strict byte counter
    const fullBuffer = await readBodyWithCap(
      response,
      MAX_BODY_BYTES,
      "Webpage response size exceeds the 2MB limit."
    );

    return {
      html: fullBuffer.toString("utf-8"),
      finalUrl: target.url.toString(),
    };
  }

  throw new Error("Exceeded maximum redirects.");
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB limit for food photography

/**
 * Content types accepted from remote servers by the image proxy.
 *
 * Only concrete raster image formats used by recipe websites are allowed.
 * Deliberately excluded:
 * - image/svg+xml: SVG can embed <script> and is an XSS vector when relayed
 *   from our origin.
 * - Everything else (text/html, application/json, application/javascript,
 *   XML variants, unknown types): relaying them would serve attacker-chosen
 *   content from this application's own origin.
 */
export const ALLOWED_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

export type AllowedImageContentType = (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number];

/**
 * Parses and validates a raw Content-Type header against the image allowlist.
 *
 * Returns the canonical media type on success, or null when the header is
 * missing, malformed, parameterized away from an allowed type, or simply not
 * an allowed image type. A missing or malformed Content-Type is NEVER trusted
 * with a permissive default.
 */
export function parseImageContentType(rawContentType: unknown): AllowedImageContentType | null {
  if (typeof rawContentType !== "string") return null;

  const mediaType = rawContentType.split(";")[0].trim().toLowerCase();
  if (!mediaType) return null;

  // Some recipe sites emit the historical "image/jpg" alias; canonicalize it.
  if (mediaType === "image/jpg") return "image/jpeg";

  return (ALLOWED_IMAGE_CONTENT_TYPES as readonly string[]).includes(mediaType)
    ? (mediaType as AllowedImageContentType)
    : null;
}

function describeRawContentType(rawContentType: string | undefined): string {
  const sanitized = (rawContentType ?? "none")
    .replace(/[\r\n\x00-\x1f]/g, " ")
    .slice(0, 60);
  return sanitized;
}

/**
 * Safely fetches a remote image file with strict SSRF protection, redirect tracking,
 * timeout controls, maximum byte size validation AND strict content-type
 * enforcement: only allowlisted raster image types are ever returned, so the
 * proxy can never relay HTML/JSON/JavaScript/XML from our origin.
 */
export async function safeFetchImage(
  rawUrl: string,
  maxBytes: number = MAX_IMAGE_BYTES
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  let currentUrl = rawUrl.trim();
  let redirectsFollowed = 0;

  while (redirectsFollowed <= MAX_REDIRECTS) {
    // 1. Validate current URL and pin its single validated DNS resolution
    const target = await validateAndPinUrl(currentUrl);

    // 2. Outbound request pinned to the validated IP with timeout signal (10s)
    const timeoutSignal = AbortSignal.timeout(10000);

    let response: IncomingMessage;
    try {
      response = await pinnedHttpRequest(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Cache-Control": "no-cache",
        },
        signal: timeoutSignal,
      });
    } catch (fetchErr: any) {
      if (isTimeoutError(fetchErr)) {
        throw new Error("Request timed out while downloading the image (10s limit).");
      }
      throw fetchErr;
    }

    const status = response.statusCode ?? 0;

    // 3. Handle redirects manually and re-validate + re-pin each target
    if (status >= 300 && status < 400) {
      const locationHeader = normalizeHeader(response.headers["location"]);
      response.destroy();
      if (!locationHeader) {
        throw new Error("Redirect location header missing for image.");
      }

      redirectsFollowed++;
      if (redirectsFollowed > MAX_REDIRECTS) {
        throw new Error("Too many redirects encountered while fetching image.");
      }

      currentUrl = new URL(locationHeader, target.url).toString();
      continue;
    }

    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`Remote image server responded with status HTTP ${status}.`);
    }

    // 4. Validate Content-Type against the strict image allowlist BEFORE
    // reading the body. Missing/malformed/non-image types are rejected.
    const rawContentType = normalizeHeader(response.headers["content-type"]);
    const contentType = parseImageContentType(rawContentType);
    if (!contentType) {
      response.destroy();
      throw new Error(
        `Blocked non-image response from remote server (content type: ${describeRawContentType(rawContentType)}). Expected JPEG, PNG, WebP, GIF, or AVIF.`
      );
    }

    // 5. Check Content-Length header if present
    const contentLength = normalizeHeader(response.headers["content-length"]);
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (!isNaN(parsedLength) && parsedLength > maxBytes) {
        response.destroy();
        throw new Error(`Image size exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`);
      }
    }

    // 6. Stream response body with strict byte counter
    const fullBuffer = await readBodyWithCap(
      response,
      maxBytes,
      `Image size exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`
    );

    return {
      buffer: fullBuffer,
      contentType,
      finalUrl: target.url.toString(),
    };
  }

  throw new Error("Exceeded maximum redirects while downloading image.");
}
