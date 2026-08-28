import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import dns from 'dns/promises';
import type { AddressInfo } from 'net';
import { safeFetchHtml, validateAndPinUrl, planPinnedRequest } from '../../server/ssrfGuard';

describe('SSRF Protection & DNS Rebinding Security Suite', () => {
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
        const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${key}`), { code: 'ENOTFOUND' });
        if (typeof callback === 'function') {
          queueMicrotask(() => callback(err, '', undefined));
          return;
        }
        return Promise.reject(err);
      }

      const provider = scriptedAnswers.get(key);
      if (!provider) {
        const err = Object.assign(new Error(`UNSCRIPTED DNS LOOKUP FOR ${key}`), {
          code: 'ENOTFOUND',
        });
        if (typeof callback === 'function') {
          queueMicrotask(() => callback(err, '', undefined));
          return;
        }
        return Promise.reject(err);
      }

      const records = provider().map((r) => ({ address: r.address, family: r.family }));
      const wantAll = options?.all === true;
      if (typeof callback === 'function') {
        queueMicrotask(() =>
          callback(null, wantAll ? records : records[0]?.address ?? '', records[0]?.family)
        );
        return;
      }
      return Promise.resolve(wantAll ? records : records[0]?.address ?? '');
    };
  }

  function resetLookups(): void {
    lookupLog = [];
  }

  function lookupCountFor(host: string): number {
    return lookupLog.filter((h) => h === host.toLowerCase()).length;
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
      if (first && typeof first === 'object') {
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
              ? { ...(opts as Record<string, unknown>), host: '127.0.0.1', port: natPort }
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
        const resolvedLocation = typeof location === 'function' ? location() : location;
        res.writeHead(status, { Location: resolvedLocation });
        res.end();
        return;
      }
      res.writeHead(status, {
        'Content-Type': 'text/plain',
        'Content-Length': String(body.length),
      });
      res.end(body);
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as AddressInfo).port,
          requests,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
  }

  const PUB_A = '93.184.216.34';
  const PUB_B = '8.8.8.8';
  let originServer: CaptureServer;

  beforeAll(async () => {
    installDnsMock();
    installDialInstrumentation();
    originServer = await startCaptureServer(200, 'PINNED_CONNECTION_OK');
    fakeNat.set(PUB_A, originServer.port);
  });

  afterAll(async () => {
    fakeNat.clear();
    if (originServer) await originServer.close();
    restoreDns();
    restoreDialInstrumentation();
  });

  it('blocks private IP literals, loopbacks, and metadata IPs', async () => {
    await expect(validateAndPinUrl('http://127.0.0.1/secret')).rejects.toThrow();
    await expect(validateAndPinUrl(`http://localhost:${originServer.port}/api`)).rejects.toThrow();
    await expect(validateAndPinUrl('http://10.20.30.40/')).rejects.toThrow();
    await expect(validateAndPinUrl('http://192.168.1.50/')).rejects.toThrow();
    await expect(validateAndPinUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    await expect(validateAndPinUrl('http://0.0.0.0/')).rejects.toThrow();
    await expect(validateAndPinUrl('http://[::1]/')).rejects.toThrow();
    await expect(validateAndPinUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(validateAndPinUrl('http://admin:hunter2@example.com/')).rejects.toThrow();
  });

  it('validates public host and preserves verbatim IP pinning', async () => {
    scriptedAnswers.set('public.test', () => [{ address: PUB_A, family: 4 }]);
    const pub = await validateAndPinUrl('http://public.test/recipe');
    expect(pub.ip).toBe(PUB_A);
    expect(pub.url.hostname).toBe('public.test');
  });

  it('executes safeFetchHtml over pinned route with single DNS lookup', async () => {
    scriptedAnswers.set('stable-rebind.test', () => [{ address: PUB_A, family: 4 }]);
    resetLookups();
    dialLog = [];
    const result = await safeFetchHtml(`http://stable-rebind.test:${originServer.port}/recipes/soup`);
    expect(result.html).toBe('PINNED_CONNECTION_OK');
    expect(lookupCountFor('stable-rebind.test')).toBe(1);
    expect(dialLog.some((d) => d.host === PUB_A && d.port === originServer.port)).toBe(true);
  });
});
