/**
 * Deterministic verification harness for the image proxy Content-Type
 * enforcement fix in `server/ssrfGuard.ts` (`safeFetchImage`).
 *
 * Strategy:
 * - A configurable origin server runs on 127.0.0.1 (ephemeral port) and can
 *   serve arbitrary Content-Type headers, body sizes and status codes.
 * - DNS is mocked so the origin is reachable only through the SSRF guard's
 *   pinned-connection path — no real network is touched.
 * - The SSRF case uses a literal 127.0.0.1 URL against a LIVE listener to
 *   prove that blocking comes from the guard, not from a failed connection.
 *
 * Run: npx tsx scripts/image_content_type_verification.ts
 */
import http from "http";
import net from "net";
import dns from "dns/promises";
import type { AddressInfo } from "net";
import {
  safeFetchImage,
  parseImageContentType,
  ALLOWED_IMAGE_CONTENT_TYPES,
} from "../server/ssrfGuard";

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, detail: string = ""): void {
  checks++;
  if (condition) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures++;
    console.error(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------------------
// DNS mock + fake NAT
//
// The origin hostname resolves to a PUBLIC IP (loopback answers would be —
// correctly — rejected by the SSRF guard pre-dial), and the dial instrumentation
// transparently reroutes that public IP to the local listener, so complete
// HTTP round trips happen without touching the real network.
// ---------------------------------------------------------------------------

const ORIGIN_PUBLIC_IP = "93.184.216.34";
const realLookup = dns.lookup.bind(dns);
let lookupLog: string[] = [];

function installDnsMock(): void {
  (dns as unknown as Record<string, unknown>).lookup = function patchedLookup(
    hostname: string,
    options: { all?: boolean },
    callback?: (err: Error | null, address: unknown, family?: number) => void
  ) {
    const key = String(hostname).toLowerCase();
    lookupLog.push(key);
    if (key !== "img-origin.test") {
      const err = Object.assign(new Error(`UNSCRIPTED DNS LOOKUP FOR ${key}`), {
        code: "ENOTFOUND",
      });
      if (typeof callback === "function") {
        queueMicrotask(() => callback(err, "", undefined));
        return;
      }
      return Promise.reject(err);
    }
    const records = [{ address: ORIGIN_PUBLIC_IP, family: 4 as const }];
    if (typeof callback === "function") {
      queueMicrotask(() =>
        callback(null, options?.all === true ? records : records[0].address, records[0].family)
      );
      return;
    }
    return Promise.resolve(options?.all === true ? records : records[0].address);
  };
}

function restoreDns(): void {
  (dns as unknown as Record<string, unknown>).lookup = realLookup;
}

interface DialIntent {
  host?: string | null;
  port?: number;
}

let dialLog: DialIntent[] = [];
const fakeNat = new Map<string, number>();

const realSocketConnect = net.Socket.prototype.connect;

function installDialInstrumentation(): void {
  (net.Socket.prototype as unknown as Record<string, unknown>).connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = args[0];
    if (first && typeof first === "object") {
      // connect(options, listener) OR connect([options, listener]) — normalize.
      const isArrayForm = Array.isArray(first);
      const opts = (isArrayForm ? first[0] : first) as {
        host?: string | null;
        port?: number;
      };
      if (opts && !Array.isArray(opts)) {
        dialLog.push({ host: opts.host, port: opts.port });
        const natPort =
          opts.host !== undefined && opts.host !== null ? fakeNat.get(opts.host) : undefined;
        const nextOpts =
          natPort !== undefined
            ? { ...(opts as Record<string, unknown>), host: "127.0.0.1", port: natPort }
            : opts;
        const listener = isArrayForm ? (first as unknown[])[1] : args[1];
        return realSocketConnect.apply(
          this,
          [nextOpts, listener] as unknown as Parameters<typeof realSocketConnect>
        );
      }
    }
    return realSocketConnect.apply(this, args as unknown as Parameters<typeof realSocketConnect>);
  } as typeof net.Socket.prototype.connect;
}

function restoreDialInstrumentation(): void {
  net.Socket.prototype.connect = realSocketConnect;
}

// ---------------------------------------------------------------------------
// Configurable origin server
// ---------------------------------------------------------------------------

interface OriginServer {
  port: number;
  close: () => Promise<void>;
}

function startOriginServer(): Promise<OriginServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://img-origin.test");
    if (url.pathname !== "/img") {
      res.writeHead(404);
      res.end();
      return;
    }
    const bytes = Number(url.searchParams.get("bytes") ?? "128");
    const status = Number(url.searchParams.get("status") ?? "200");
    const ct = url.searchParams.get("ct"); // null => header omitted entirely

    const payload = Buffer.alloc(bytes, 0x41); // filler bytes; format irrelevant
    const headers: Record<string, string | number> = { "Content-Length": String(bytes) };
    if (ct !== null) {
      headers["Content-Type"] = ct;
    }

    res.writeHead(status, headers);
    res.end(payload);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function expectAccept(
  originPort: number,
  query: string,
  expectedType: string,
  name: string
): Promise<void> {
  try {
    const result = await safeFetchImage(`http://img-origin.test:${originPort}/img${query}`);
    check(name, result.contentType === expectedType && result.buffer.length > 0,
      `got contentType=${result.contentType}, bytes=${result.buffer.length}`);
  } catch (err) {
    check(name, false, `unexpected rejection: ${err instanceof Error ? err.message : err}`);
  }
}

async function expectReject(
  originPort: number,
  query: string,
  name: string,
  pattern: RegExp = /non-image response/
): Promise<void> {
  try {
    const result = await safeFetchImage(`http://img-origin.test:${originPort}/img${query}`);
    check(name, false, `expected rejection but got contentType=${result.contentType}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(name, pattern.test(message), `message: "${message}"`);
  }
}

async function main(): Promise<void> {
  const origin = await startOriginServer();
  installDnsMock();
  fakeNat.set(ORIGIN_PUBLIC_IP, origin.port);
  installDialInstrumentation();
  dialLog = [];

  try {
    // ---------------------------------------------------------------------
    section("0. Pinned-route sanity: fetch flows through validated public IP");
    await expectAccept(origin.port, "?ct=image/png&bytes=16", "image/png", "Origin reachable via pinned route");
    check(
      "Wire target equals validated public IP",
      dialLog.some((d) => d.host === ORIGIN_PUBLIC_IP && d.port === origin.port),
      `observed ${JSON.stringify(dialLog)}`
    );
    check(
      "Exactly one DNS lookup for the origin host",
      lookupLog.filter((h) => h === "img-origin.test").length === 1
    );
    // ---------------------------------------------------------------------
    section("1. Unit: parseImageContentType");
    check("image/jpeg accepted", parseImageContentType("image/jpeg") === "image/jpeg");
    check("image/jpg alias canonicalized", parseImageContentType("image/jpg") === "image/jpeg");
    check("uppercase normalized", parseImageContentType("IMAGE/PNG") === "image/png");
    check("whitespace trimmed", parseImageContentType("  image/gif ") === "image/gif");
    check("parameters stripped", parseImageContentType("image/webp; charset=binary") === "image/webp");
    check("SVG rejected", parseImageContentType("image/svg+xml") === null);
    check("HTML rejected", parseImageContentType("text/html") === null);
    check("JSON rejected", parseImageContentType("application/json") === null);
    check("JS rejected", parseImageContentType("application/javascript") === null);
    check("XML rejected", parseImageContentType("application/xml") === null);
    check("unknown type rejected", parseImageContentType("font/woff2") === null);
    check("garbage rejected", parseImageContentType("x;y;z") === null);
    check("empty string rejected", parseImageContentType("") === null);
    check("missing header rejected", parseImageContentType(undefined) === null);
    check("non-string rejected", parseImageContentType(42) === null);
    check(
      "allowlist is exactly the five raster formats",
      JSON.stringify([...ALLOWED_IMAGE_CONTENT_TYPES].sort()) ===
        JSON.stringify(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"])
    );

    // ---------------------------------------------------------------------
    section("2. Allowed image content types are fetched");
    await expectAccept(origin.port, "?ct=image/jpeg&bytes=100", "image/jpeg", "JPEG accepted");
    await expectAccept(origin.port, "?ct=image/jpg&bytes=100", "image/jpeg", "JPG alias accepted + canonicalized");
    await expectAccept(origin.port, "?ct=image/png&bytes=200", "image/png", "PNG accepted");
    await expectAccept(origin.port, "?ct=image/webp&bytes=300", "image/webp", "WebP accepted");
    await expectAccept(origin.port, "?ct=image/gif&bytes=400", "image/gif", "GIF accepted");
    await expectAccept(origin.port, "?ct=image/avif&bytes=500", "image/avif", "AVIF accepted");
    await expectAccept(
      origin.port,
      "?ct=image%2Fpng%3B%20charset%3Dbinary&bytes=64",
      "image/png",
      "Parameterized PNG accepted"
    );

    // ---------------------------------------------------------------------
    section("3. Non-image / hostile content types are rejected");
    await expectReject(origin.port, "?ct=text%2Fhtml&bytes=50", "HTML rejected");
    await expectReject(origin.port, "?ct=application%2Fjson&bytes=50", "JSON rejected");
    await expectReject(origin.port, "?ct=application%2Fjavascript&bytes=50", "JavaScript rejected");
    await expectReject(origin.port, "?ct=text%2Fplain&bytes=50", "Plain text rejected");
    await expectReject(origin.port, "?ct=application%2Fxml&bytes=50", "XML rejected");
    await expectReject(origin.port, "?ct=image%2Fsvg%2Bxml&bytes=50", "SVG rejected (XSS vector)");
    await expectReject(origin.port, "?ct=font%2Fwoff2&bytes=50", "Unknown type rejected");
    await expectReject(origin.port, "?bytes=50", "MISSING Content-Type rejected");
    await expectReject(origin.port, "?ct=&bytes=50", "EMPTY Content-Type rejected");

    // ---------------------------------------------------------------------
    section("4. Existing protections still hold for images");
    const oversized = 10 * 1024 * 1024 + 1;
    await expectReject(
      origin.port,
      `?ct=image%2Fjpeg&bytes=${oversized}`,
      "Oversized response (>10MB) still rejected",
      /exceeds/i
    );
    try {
      // Literal loopback IP with an otherwise-perfect image response:
      await safeFetchImage(`http://127.0.0.1:${origin.port}/img?ct=image%2Fjpeg&bytes=10`);
      check("SSRF destination (loopback literal) still blocked", false, "expected rejection");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check(
        "SSRF destination (loopback literal) still blocked",
        message.includes("restricted"),
        `message: "${message}" — listener was live, so this block came from the guard`
      );
    }
    try {
      await safeFetchImage(`http://localhost:${origin.port}/img?ct=image%2Fjpeg`);
      check("SSRF destination (localhost alias) still blocked", false, "expected rejection");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check("SSRF destination (localhost alias) still blocked", message.includes("restricted"));
    }

    // ---------------------------------------------------------------------
    section("Summary");
    console.log(`\n${checks - failures}/${checks} checks passed.`);
    if (failures > 0) {
      console.error(`\u2717 ${failures} check(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log("\u2713 Image proxy content-type enforcement verified.");
    }
  } finally {
    fakeNat.clear();
    await origin.close();
    restoreDns();
    restoreDialInstrumentation();
  }
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exitCode = 1;
});
