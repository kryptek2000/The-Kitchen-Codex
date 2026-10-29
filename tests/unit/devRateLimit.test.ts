import { describe, it, expect } from 'vitest';
import { createApp } from '../../server/app.js';
import http from 'node:http';

function request(app: any, path: string): Promise<number> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        res.resume();
        res.on('end', () => { server.close(); resolve(res.statusCode); });
      });
      req.on('error', () => { server.close(); resolve(0); });
    });
  });
}

describe('development global rate limiter', () => {
  it('does not throttle ordinary development page requests', async () => {
    const app = createApp({ isProduction: false });
    // A single ordinary navigation request must not be throttled.
    const status = await request(app, '/');
    expect(status).not.toBe(429);
  });

  it('preserves production global throttling', async () => {
    const app = createApp({ isProduction: true });
    // Production still applies the global limiter; a normal first request is allowed.
    const status = await request(app, '/');
    expect(status).not.toBe(429);
  });
});
