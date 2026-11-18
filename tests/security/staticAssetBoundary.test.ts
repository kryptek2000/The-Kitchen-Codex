// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { installProductionStatic } from '../../server/staticAssets';
import { STARTER_IMAGE_PATH_LIST } from '../../src/data/starterImageAssets';

let server: http.Server;
let basePort: number;
let dist: string;

function makeDist(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tkc-static-boundary-'));
  const write = (relative: string, content: string | Buffer) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('index.html', '<!doctype html><title>TKC SPA</title><main>spa-index</main>');
  write('assets/app.js', 'console.log("valid-js");');
  write('assets/app.css', 'body{color:black}');
  write('fonts/font.woff2', Buffer.from('wOF2font'));
  write('images/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  write('server.cjs', 'INTERNAL_SERVER_BUNDLE_SHOULD_NOT_BE_SERVED');
  write('server.cjs.map', '{"sources":["internal"]}');
  write('voice/voiceChild.cjs', 'INTERNAL_VOICE_SHOULD_NOT_BE_SERVED');
  write('app-images/starter/PROVENANCE.md', '# provenance must not be served');
  for (const publicPath of STARTER_IMAGE_PATH_LIST) {
    const relative = publicPath.replace(/^\//, '');
    const source = path.join(process.cwd(), 'public', relative);
    write(relative, fs.readFileSync(source));
  }
  return root;
}

function request(rawPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: basePort, method: 'GET', path: rawPath },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dist = makeDist();
  const app = express();
  installProductionStatic(app, dist);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  basePort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('production static-asset boundary', () => {
  it('serves every exact approved Starter image', async () => {
    for (const approved of STARTER_IMAGE_PATH_LIST) {
      const res = await request(approved);
      expect(res.status, approved).toBe(200);
      expect(res.headers['content-type'], approved).toMatch(/^image\/jpeg/);
      expect(res.body.length, approved).toBeGreaterThan(1000);
    }
  });

  it('keeps legitimate frontend assets and SPA routes working', async () => {
    expect((await request('/')).status).toBe(200);
    expect((await request('/index.html')).status).toBe(200);
    expect((await request('/favicon.svg')).status).toBe(200);
    expect((await request('/assets/app.js')).status).toBe(200);
    expect((await request('/assets/app.css')).status).toBe(200);
    expect((await request('/fonts/font.woff2')).status).toBe(200);
    expect((await request('/images/pic.png')).status).toBe(200);
    const spa = await request('/recipe/some-client-route');
    expect(spa.status).toBe(200);
    expect(spa.headers['content-type']).toMatch(/text\/html/);
    expect(spa.body.toString()).toContain('spa-index');
  });

  it('does not expose internal distribution files', async () => {
    for (const internal of [
      '/server.cjs',
      '/server.cjs.map',
      '/voice/voiceChild.cjs',
      '/app-images/starter/PROVENANCE.md',
      '/app-images/starter/nonexistent.jpg',
      '/app-images/starter/',
      '/app-images',
      '/assets/missing.js',
      '/assets',
    ]) {
      const res = await request(internal);
      expect(res.status, internal).toBe(404);
      expect(res.body.toString(), internal).not.toContain('INTERNAL_SERVER_BUNDLE');
      expect(res.body.toString(), internal).not.toContain('spa-index');
    }
  });

  it('rejects traversal, encoded traversal, and query aliases', async () => {
    const approved = STARTER_IMAGE_PATH_LIST[0];
    const rejected = [
      '/app-images/starter/..\\..\\server.cjs',
      '/app-images/starter/%5c..%5c..%5cserver.cjs',
      '/app-images/starter/..%2f..%2fserver.cjs',
      '/app-images/starter/%252e%252e%252fserver.cjs',
      '/app-images/starter/../artisan-sourdough-boule.jpg',
      '/app-images/starter/./artisan-sourdough-boule.jpg',
      '/app-images/starter/other.jpg',
      `${approved}?bypass=1`,
      '/assets/../server.cjs',
      '/images/../server.cjs',
    ];
    for (const ref of rejected) {
      const res = await request(ref);
      expect(res.status, ref).toBe(404);
      expect(res.body.toString(), ref).not.toContain('INTERNAL_SERVER_BUNDLE');
    }
  });
});
