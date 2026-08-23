import dns from "dns/promises";
import net from "net";

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
 * Validates a URL against SSRF rules by inspecting the scheme, hostname,
 * and performing a DNS lookup to ensure none of the resolved IPs are in private/restricted ranges.
 */
export async function validateUrlForSSRF(urlString: string): Promise<URL> {
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

  const hostname = parsedUrl.hostname;

  // 3. Fast-path hostname blacklist check
  if (isRestrictedHostname(hostname)) {
    throw new Error("The target host is restricted.");
  }

  // 4. If hostname is directly an IP literal (e.g. http://127.0.0.1 or http://[::1])
  const cleanHost = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(cleanHost)) {
    if (isRestrictedIP(cleanHost)) {
      throw new Error("The target IP address is restricted.");
    }
    return parsedUrl;
  }

  // 5. DNS Resolution check: Resolve ALL IPv4 and IPv6 addresses for the hostname
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!records || records.length === 0) {
      throw new Error("Unable to resolve target host.");
    }

    for (const record of records) {
      if (isRestrictedIP(record.address)) {
        throw new Error("The target host resolved to a restricted IP address.");
      }
    }
  } catch (dnsErr: any) {
    if (dnsErr?.message?.includes("restricted")) {
      throw dnsErr;
    }
    throw new Error("Failed to resolve hostname.");
  }

  return parsedUrl;
}

/**
 * Secure HTTP fetch with:
 * - SSRF protection & DNS IP resolution checks
 * - Strict HTTP/HTTPS scheme restriction
 * - 8-second timeout via AbortSignal
 * - 2 MB max body size streaming enforcement
 * - Manual redirect validation (re-validating every redirect target against SSRF)
 */
export async function safeFetchHtml(initialUrl: string): Promise<{ html: string; finalUrl: string }> {
  let currentUrl = initialUrl;
  let redirectsFollowed = 0;

  while (redirectsFollowed <= MAX_REDIRECTS) {
    // 1. Validate current URL and DNS resolution for SSRF
    const validatedUrl = await validateUrlForSSRF(currentUrl);

    // 2. Outbound request with timeout signal
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(validatedUrl.toString(), {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
        redirect: "manual", // Crucial: manual redirects to prevent SSRF redirect bypasses
        signal: timeoutSignal,
      });
    } catch (fetchErr: any) {
      if (fetchErr.name === "TimeoutError" || fetchErr.name === "AbortError") {
        throw new Error("Request timed out while fetching the webpage (8s limit).");
      }
      throw fetchErr;
    }

    // 3. Handle redirects manually and re-validate target
    if (response.status >= 300 && response.status < 400) {
      const locationHeader = response.headers.get("location");
      if (!locationHeader) {
        throw new Error("Redirect location header missing.");
      }

      redirectsFollowed++;
      if (redirectsFollowed > MAX_REDIRECTS) {
        throw new Error("Too many redirects encountered.");
      }

      // Resolve relative redirect against current URL
      const nextUrl = new URL(locationHeader, validatedUrl).toString();
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Remote server responded with status HTTP ${response.status}.`);
    }

    // 4. Check Content-Length header if present
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (!isNaN(parsedLength) && parsedLength > MAX_BODY_BYTES) {
        throw new Error("Webpage response size exceeds the 2MB limit.");
      }
    }

    // 5. Stream response body with strict byte counter
    if (!response.body) {
      return { html: "", finalUrl: validatedUrl.toString() };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > MAX_BODY_BYTES) {
            await reader.cancel("Size limit exceeded");
            throw new Error("Webpage response size exceeds the 2MB limit.");
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const fullBuffer = Buffer.concat(chunks);
    const htmlText = fullBuffer.toString("utf-8");

    return {
      html: htmlText,
      finalUrl: validatedUrl.toString(),
    };
  }

  throw new Error("Exceeded maximum redirects.");
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB limit for food photography

/**
 * Safely fetches a remote image file with strict SSRF protection, redirect tracking,
 * timeout controls, and maximum byte size validation.
 */
export async function safeFetchImage(
  rawUrl: string,
  maxBytes: number = MAX_IMAGE_BYTES
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  let currentUrl = rawUrl.trim();
  let redirectsFollowed = 0;

  while (redirectsFollowed <= MAX_REDIRECTS) {
    // 1. Validate current URL and DNS resolution for SSRF
    const validatedUrl = await validateUrlForSSRF(currentUrl);

    // 2. Outbound request with timeout signal (10s)
    const timeoutSignal = AbortSignal.timeout(10000);

    let response: Response;
    try {
      response = await fetch(validatedUrl.toString(), {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Cache-Control": "no-cache",
        },
        redirect: "manual",
        signal: timeoutSignal,
      });
    } catch (fetchErr: any) {
      if (fetchErr.name === "TimeoutError" || fetchErr.name === "AbortError") {
        throw new Error("Request timed out while downloading the image (10s limit).");
      }
      throw fetchErr;
    }

    // 3. Handle redirects manually and re-validate target
    if (response.status >= 300 && response.status < 400) {
      const locationHeader = response.headers.get("location");
      if (!locationHeader) {
        throw new Error("Redirect location header missing for image.");
      }

      redirectsFollowed++;
      if (redirectsFollowed > MAX_REDIRECTS) {
        throw new Error("Too many redirects encountered while fetching image.");
      }

      const nextUrl = new URL(locationHeader, validatedUrl).toString();
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Remote image server responded with status HTTP ${response.status}.`);
    }

    // 4. Validate Content-Type
    const contentType = response.headers.get("content-type") || "image/jpeg";

    // 5. Check Content-Length header if present
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (!isNaN(parsedLength) && parsedLength > maxBytes) {
        throw new Error(`Image size exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`);
      }
    }

    // 6. Stream response body with strict byte counter
    if (!response.body) {
      throw new Error("Empty image response received from server.");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            await reader.cancel("Size limit exceeded");
            throw new Error(`Image size exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const fullBuffer = Buffer.concat(chunks);

    return {
      buffer: fullBuffer,
      contentType,
      finalUrl: validatedUrl.toString(),
    };
  }

  throw new Error("Exceeded maximum redirects while downloading image.");
}

