/**
 * Deterministic verification harness for the SSRF DNS-rebinding (TOCTOU) fix
 * in `server/ssrfGuard.ts`.
 *
 * Strategy (fully offline, zero flakiness):
 * - DNS (`dns/promises.lookup`) is mocked: scripted hosts return scripted
 *   answer sets, including adversarial rebinding sequences.
 * - Outbound TCP dialing (`net.Socket.prototype.connect`) is instrumented:
 *   every dial's requested host/port is RECORDED, and — like a fake NAT —
 *   dials aimed at a scripted PUBLIC IP are transparently rerouted to a local
 *   capture server so complete HTTP round trips happen without touching the
 *   network.
 *
 * Why this proves the fix:
 * - The vulnerable implementation validated DNS once and let `fetch()`
 *   resolve the hostname AGAIN at connection time. Instrumentation exposes
 *   that: the fixed implementation must show exactly ONE DNS lookup per hop,
 *   and the recorded wire target MUST equal the validated/pinned IP.
 * - If a future regression re-introduces double resolution, either the
 *   lookup counter exceeds 1 or the recorded dial target differs from the
 *   validated IP — the harness fails deterministically.
 *
 * Run: npx tsx scripts/ssrf_rebinding_verification.ts
 */
import http from "http";
import net from "net";
import dns from "dns/promises";
import type { AddressInfo } from "net";
import { safeFetchHtml, validateAndPinUrl, planPinnedRequest } from "../server/ssrfGuard";

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, detail: string = ""): void {
  checks++;
  if (condition) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures++;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------------------
// DNS mock
// ---------------------------------------------------------------------------

interface ScriptedRecord {
  address: string;
  family: 4 | 6;
}

const scriptedAnswers = new Map<string, () => ScriptedRecord[]>();
const scriptedErrors = new Set<string>();
let lookupLog: string[] = [];

const realLookup = dns.lookup.bind(dns);

function installDnsMock(): void {
  (dns as unknown as Record<string, unknown>).lookup = function patchedLookup(
    hostname: string,
    options: { all?: boolean },
    callback?: (err: Error | null, address: unknown, family?: number) => void
  ) {
    const key = String(hostname).toLowerCase();
    lookupLog.push(key);

    if (scriptedErrors.has(key)) {
      const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${key}`), { code: "ENOTFOUND" });
      if (typeof callback === "function") {
        queueMicrotask(() => callback(err, "", undefined));
        return;
      }
      return Promise.reject(err);
    }

    const provider = scriptedAnswers.get(key);
    if (!provider) {
      // Unscripted host: fail loudly rather than silently hitting the network.
      const err = Object.assign(new Error(`UNSCRIPTED DNS LOOKUP FOR ${key}`), {
        code: "ENOTFOUND",
      });
      if (typeof callback === "function") {
        queueMicrotask(() => callback(err, "", undefined));
        return;
      }
      return Promise.reject(err);
    }

    const records = provider().map((r) => ({ address: r.address, family: r.family }));
    const wantAll = options?.all === true;
    if (typeof callback === "function") {
      queueMicrotask(() =>
        callback(null, wantAll ? records : records[0]?.address ?? "", records[0]?.family)
      );
      return;
    }
    return Promise.resolve(wantAll ? records : records[0]?.address ?? "");
  };
}

function resetLookups(): void {
  lookupLog = [];
}

function lookupCountFor(host: string): number {
  return lookupLog.filter((h) => h === host.toLowerCase()).length;
}

// ---------------------------------------------------------------------------
// Dial instrumentation / fake NAT
// ---------------------------------------------------------------------------

interface DialIntent {
  host?: string | null;
  port?: number;
}

let dialLog: DialIntent[] = [];

/** Maps a public IP (as scripted in DNS) to the local listener port. */
const fakeNat = new Map<string, number>();

const realSocketConnect = net.Socket.prototype.connect;

function installDialInstrumentation(): void {
  (net.Socket.prototype as unknown as Record<string, unknown>).connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = args[0];
    if (first && typeof first === "object") {
      // Node reaches this point in two shapes:
      //   connect(options, listener)   -> args[0] is the options object
      //   connect([options, listener]) -> args[0] is a normalized args ARRAY
      // The underlying implementation only accepts the flattened form, so
      // both shapes are normalized to (options, listener) before delegating.
      const isArrayForm = Array.isArray(first);
      const opts = (isArrayForm ? first[0] : first) as {
        host?: string | null;
        port?: number;
      };
      if (opts && !Array.isArray(opts)) {
        // Record the WIRE TARGET as requested (pre-reroute, pre-DNS).
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
    return realSocketConnect.apply(this, args as Parameters<typeof realSocketConnect>);
  } as typeof net.Socket.prototype.connect;
}

function restoreDialInstrumentation(): void {
  net.Socket.prototype.connect = realSocketConnect;
}

function restoreDns(): void {
  (dns as unknown as Record<string, unknown>).lookup = realLookup;
}

// ---------------------------------------------------------------------------
// Local capture server
// ---------------------------------------------------------------------------

interface CapturedRequest {
  host: string | undefined;
  url: string | undefined;
}

interface CaptureServer {
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

function startCaptureServer(
  status: number,
  body: string,
  location?: string | (() => string)
): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ host: req.headers.host, url: req.url });
    if (location) {
      // Evaluate lazily so self-referencing redirects can use the bound port.
      const resolvedLocation =
        typeof location === "function" ? location() : location;
      res.writeHead(status, { Location: resolvedLocation });
      res.end();
      return;
    }
    res.writeHead(status, {
      "Content-Type": "text/plain",
      "Content-Length": String(body.length),
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Helpers -------------------------------------------------------------------

async function expectValidationFailure(url: string, name: string, pattern?: RegExp): Promise<void> {
  try {
    await validateAndPinUrl(url);
    check(name, false, "expected rejection but validation succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (pattern && !pattern.test(message)) {
      check(name, false, `rejected with unexpected message: "${message}"`);
    } else {
      check(name, true);
    }
  }
}

// Public test IPs used with the fake NAT.
const PUB_A = "93.184.216.34"; // scripted answer for first-hop hosts
const PUB_B = "8.8.8.8"; // scripted answer for second-hop hosts
const PUB_C = "1.1.1.1"; // used as a dead FIRST address in failover tests

async function main(): Promise<void> {
  installDnsMock();
  installDialInstrumentation();

  const originServer = await startCaptureServer(200, "PINNED_CONNECTION_OK");
  fakeNat.set(PUB_A, originServer.port);

  try {
    // ---------------------------------------------------------------------
    section("1. Literal IPs, local aliases, schemes and credentials are blocked");
    await expectValidationFailure("http://127.0.0.1/secret", "Block loopback literal 127.0.0.1");
    await expectValidationFailure(
      `http://localhost:${originServer.port}/api`,
      "Block localhost alias"
    );
    await expectValidationFailure("http://10.20.30.40/", "Block RFC1918 10.0.0.0/8");
    await expectValidationFailure("http://192.168.1.50/", "Block RFC1918 192.168.0.0/16");
    await expectValidationFailure("http://172.16.5.5/", "Block RFC1918 172.16.0.0/12");
    await expectValidationFailure(
      "http://169.254.169.254/latest/meta-data/",
      "Block cloud metadata 169.254.169.254"
    );
    await expectValidationFailure("http://0.0.0.0/", "Block unspecified 0.0.0.0");
    await expectValidationFailure("http://[::1]/", "Block IPv6 loopback ::1");
    await expectValidationFailure("http://[::]/", "Block IPv6 unspecified ::");
    await expectValidationFailure("http://[::ffff:127.0.0.1]/", "Block IPv4-mapped loopback IPv6");
    await expectValidationFailure("http://[::ffff:10.0.0.7]/", "Block IPv4-mapped private IPv6");
    await expectValidationFailure(
      "http://metadata.google.internal/computeMetadata/v1/",
      "Block GCP metadata hostname"
    );
    await expectValidationFailure("file:///etc/passwd", "Reject file:// scheme");
    await expectValidationFailure("ftp://example.com/recipe", "Reject ftp:// scheme");
    await expectValidationFailure(
      "http://admin:hunter2@example.com/",
      "Reject embedded credentials"
    );

    // ---------------------------------------------------------------------
    section("2. DNS results: every record validated, verbatim order pinned");
    scriptedAnswers.set("public.test", () => [{ address: PUB_A, family: 4 }]);
    const pub = await validateAndPinUrl("http://public.test/recipe");
    check("Public single-A hostname allowed", pub.ip === PUB_A && pub.family === 4);
    check("Original hostname preserved on pinned target", pub.url.hostname === "public.test");

    scriptedAnswers.set("dual.test", () => [
      { address: PUB_B, family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const dual = await validateAndPinUrl("http://dual.test/");
    check(
      "Multi-record (A+AAAA) allowed, verbatim first pinned",
      dual.ip === PUB_B && dual.family === 4
    );

    scriptedAnswers.set("oneprivate.test", () => [
      { address: PUB_B, family: 4 },
      { address: "192.168.0.44", family: 4 },
    ]);
    await expectValidationFailure(
      "http://oneprivate.test/",
      "Any restricted record among many blocks the host",
      /restricted/
    );

    scriptedAnswers.set("v6private.test", () => [{ address: "fd00::1", family: 6 }]);
    await expectValidationFailure(
      "http://v6private.test/",
      "DNS resolving to ULA IPv6 blocked",
      /restricted/
    );

    scriptedAnswers.set("mapped.test", () => [{ address: "::ffff:192.168.1.9", family: 6 }]);
    await expectValidationFailure(
      "http://mapped.test/",
      "DNS resolving to IPv4-mapped private IPv6 blocked",
      /restricted/
    );

    scriptedAnswers.set("metadataip.test", () => [{ address: "169.254.169.254", family: 4 }]);
    await expectValidationFailure(
      "http://metadataip.test/",
      "DNS resolving to cloud metadata IP blocked",
      /restricted/
    );

    scriptedErrors.add("broken.test");
    await expectValidationFailure(
      "http://broken.test/",
      "Resolution failure surfaces as resolve error",
      /Failed to resolve hostname/
    );

    // ---------------------------------------------------------------------
    section("3. Rebinding race closed: ONE resolution, wire target = validated IP");
    scriptedAnswers.set("stable-rebind.test", () => [{ address: PUB_A, family: 4 }]);
    resetLookups();
    dialLog = [];
    const result = await safeFetchHtml(
      `http://stable-rebind.test:${originServer.port}/recipes/soup`
    );
    check(
      "Full HTTP round trip completed through pinned route",
      result.html === "PINNED_CONNECTION_OK"
    );
    check(
      "Exactly ONE DNS resolution for the hop",
      lookupCountFor("stable-rebind.test") === 1,
      `observed ${lookupCountFor("stable-rebind.test")} lookups`
    );
    check(
      "Wire target equals the VALIDATED IP (fake-NAT observed the dial)",
      dialLog.length === 1 &&
        dialLog[0].host === PUB_A &&
        dialLog[0].port === originServer.port,
      `observed ${JSON.stringify(dialLog)}`
    );
    check(
      "HTTP Host header kept ORIGINAL hostname (not the pinned IP)",
      originServer.requests[0]?.host === `stable-rebind.test:${originServer.port}`,
      `observed "${originServer.requests[0]?.host}"`
    );
    check(
      "Final URL preserves original hostname",
      result.finalUrl.startsWith(`http://stable-rebind.test:${originServer.port}`)
    );

    // ---------------------------------------------------------------------
    section("4. Answer flips after validation: pinned snapshot is immutable");
    let flipCalls = 0;
    scriptedAnswers.set("flip.test", () => {
      flipCalls++;
      if (flipCalls === 1) return [{ address: PUB_A, family: 4 }];
      // Malicious rebinding answer served on every subsequent lookup:
      return [{ address: "127.0.0.1", family: 4 }];
    });
    resetLookups();
    dialLog = [];
    const flipped = await validateAndPinUrl(`http://flip.test:${originServer.port}/x`);
    const plan = planPinnedRequest(flipped);
    check("Validation pinned the FIRST (validated) answer", flipped.ip === PUB_A);
    check(
      "Connection plan dials the validated IP only",
      plan.host === PUB_A && plan.family === 4
    );
    check(
      "Plan keeps original host/port for Host+SNI semantics",
      plan.hostHeader === `flip.test:${originServer.port}` && plan.port === originServer.port
    );
    check(
      "No second resolution occurred (poisoned answer never consulted)",
      lookupCountFor("flip.test") === 1 && flipCalls === 1,
      `lookups=${lookupCountFor("flip.test")} providerCalls=${flipCalls}`
    );
    check(
      "Nothing dialed for the flipped host yet",
      dialLog.length === 0
    );

    // ---------------------------------------------------------------------
    section("4b. Dual-stack failover: dead first route falls through to validated second");

    scriptedAnswers.set("failover.test", () => [
      { address: PUB_C, family: 4 },
      { address: PUB_B, family: 4 },
    ]);
    // First address points at a port with no listener (guaranteed instant
    // refusal on loopback), the second at a live capture server.
    const refusedServer = await startCaptureServer(200, "unused");
    const refusedPort = refusedServer.port;
    await refusedServer.close();
    fakeNat.set(PUB_C, refusedPort);
    const failoverTarget = await startCaptureServer(200, "FAILOVER_SECOND_ADDRESS_OK");
    fakeNat.set(PUB_B, failoverTarget.port);
    resetLookups();
    dialLog = [];
    try {
      const failover = await safeFetchHtml(`http://failover.test:${failoverTarget.port}/x`);
      check(
        "Request succeeded via SECOND validated address",
        failover.html === "FAILOVER_SECOND_ADDRESS_OK"
      );
      check(
        "Still exactly ONE DNS resolution (failover never re-resolves)",
        lookupCountFor("failover.test") === 1
      );
      check(
        "Dial order followed verbatim validation order",
        dialLog.length === 2 &&
          dialLog[0].host === PUB_C &&
          dialLog[1].host === PUB_B,
        `observed ${JSON.stringify(dialLog)}`
      );
      check(
        "Host header preserved across failover",
        failoverTarget.requests[0]?.host === `failover.test:${failoverTarget.port}`
      );
    } finally {
      await failoverTarget.close();
    }

    // Watchdog variant: first address accepts TCP but NEVER responds, so the
    // per-address connect timeout must burn it and move on. Deterministic.
    const silent = http.createServer(() => {/* never responds */});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const silentPort = (silent.address() as AddressInfo).port;
    scriptedAnswers.set("watchdog.test", () => [
      { address: PUB_A, family: 4 },
      { address: PUB_B, family: 4 },
    ]);
    const watchdogFinal = await startCaptureServer(200, "WATCHDOG_FAILOVER_OK");
    fakeNat.set(PUB_A, silentPort);
    fakeNat.set(PUB_B, watchdogFinal.port);
    resetLookups();
    dialLog = [];
    try {
      const t0 = Date.now();
      const watched = await safeFetchHtml(`http://watchdog.test:${watchdogFinal.port}/y`);
      const elapsed = Date.now() - t0;
      check(
        "Silent first address burned by watchdog, second served response",
        watched.html === "WATCHDOG_FAILOVER_OK"
      );
      check(
        "Watchdog bounded the dead attempt (~per-address budget)",
        elapsed >= 3500 && elapsed < 7900,
        `elapsed ${elapsed}ms`
      );
      check(
        "Both addresses attempted in order",
        dialLog.length === 2 && dialLog[0].host === PUB_A && dialLog[1].host === PUB_B
      );
    } finally {
      silent.close();
      await watchdogFinal.close();
    }

    // ---------------------------------------------------------------------
    section("5. Redirects are re-validated and re-pinned per hop");

    // Redirect into a newly-private host must be blocked pre-dial.
    scriptedAnswers.set("redir-src.test", () => [{ address: PUB_A, family: 4 }]);
    scriptedAnswers.set("redir-private.test", () => [{ address: "10.9.9.9", family: 4 }]);
    const privRedirServer = await startCaptureServer(
      302,
      "",
      "http://redir-private.test:80/stolen"
    );
    fakeNat.set(PUB_A, privRedirServer.port);
    try {
      await safeFetchHtml(`http://redir-src.test:${privRedirServer.port}/start`);
      check("Redirect to newly-private host blocked", false, "expected rejection");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check(
        "Redirect to newly-private host blocked",
        message.includes("restricted"),
        `message: "${message}"`
      );
      check(
        "Blocked hop was resolved exactly once before rejection",
        lookupCountFor("redir-private.test") === 1
      );
    } finally {
      await privRedirServer.close();
    }

    // Allowed redirect chain: second hop re-resolved and re-pinned.
    const finalServer = await startCaptureServer(200, "SECOND_HOP_OK");
    fakeNat.set(PUB_A, finalServer.port + 100000); // dead end: first hop alone proves nothing
    const hopOneServer = await startCaptureServer(
      302,
      "",
      `http://hop-two.test:${finalServer.port}/final`
    );
    fakeNat.set(PUB_A, hopOneServer.port);
    fakeNat.set(PUB_B, finalServer.port);
    scriptedAnswers.set("hop-two.test", () => [{ address: PUB_B, family: 4 }]);
    resetLookups();
    dialLog = [];
    try {
      const chained = await safeFetchHtml(`http://redir-src.test:${hopOneServer.port}/go`);
      check("Allowed redirect chain completed", chained.html === "SECOND_HOP_OK");
      check(
        "Exactly one DNS resolution per hop",
        lookupCountFor("redir-src.test") === 1 && lookupCountFor("hop-two.test") === 1
      );
      check(
        "Each hop dialed ITS OWN freshly validated IP",
        dialLog.length === 2 &&
          dialLog[0].host === PUB_A &&
          dialLog[0].port === hopOneServer.port &&
          dialLog[1].host === PUB_B &&
          dialLog[1].port === finalServer.port,
        `observed ${JSON.stringify(dialLog)}`
      );
      check(
        "Second hop kept ITS OWN original hostname in Host header",
        finalServer.requests[0]?.host === `hop-two.test:${finalServer.port}`
      );
      check(
        "finalUrl reflects last validated hop",
        chained.finalUrl.startsWith(`http://hop-two.test:${finalServer.port}`)
      );
    } finally {
      await hopOneServer.close();
      await finalServer.close();
    }

    // Redirect loop ceiling preserved.
    scriptedAnswers.set("loop-redir.test", () => [{ address: PUB_B, family: 4 }]);
    const loopServer = await startCaptureServer(302, "", () => {
      // Self-referencing Location, resolved lazily once the port is bound.
      return `http://loop-redir.test:${loopServer.port}/loop`;
    });
    fakeNat.set(PUB_B, loopServer.port);
    resetLookups();
    dialLog = [];
    try {
      await safeFetchHtml(`http://loop-redir.test:${loopServer.port}/loop`);
      check("Redirect loop capped", false, "expected Too many redirects error");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check(
        "Redirect loop capped",
        message.includes("Too many redirects"),
        `message: "${message}"`
      );
    } finally {
      await loopServer.close();
    }

    // ---------------------------------------------------------------------
    section("Summary");
    console.log(`\n${checks - failures}/${checks} checks passed.`);
    if (failures > 0) {
      console.error(`\u2717 ${failures} check(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log("\u2713 SSRF DNS-rebinding fix verified.");
    }
  } finally {
    fakeNat.clear();
    await originServer.close();
    restoreDns();
    restoreDialInstrumentation();
  }
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exitCode = 1;
});
