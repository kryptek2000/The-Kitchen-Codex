import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Route-level tests for the representative-image endpoints, exercised through
 * the REAL `createApp` wiring. Only the network-touching server functions are
 * mocked; route validation, requester binding, the candidate store, the preview
 * store, and rate limiting are the real production code.
 */

vi.mock('../../server/representativeImage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/representativeImage.js')>();
  return {
    ...actual,
    searchRepresentativeImages: vi.fn(),
    selectRepresentativeImage: vi.fn(),
    fetchRepresentativeThumbnail: vi.fn(),
  };
});

import { createApp } from '../../server/app.js';
import * as rep from '../../server/representativeImage.js';

const searchMock = rep.searchRepresentativeImages as unknown as ReturnType<typeof vi.fn>;
const selectMock = rep.selectRepresentativeImage as unknown as ReturnType<typeof vi.fn>;
const thumbMock = rep.fetchRepresentativeThumbnail as unknown as ReturnType<typeof vi.fn>;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const FOUND = [
  {
    source: 'openverse' as const,
    query: 'blue cheese smashburger',
    title: 'Blue Cheese Burger',
    thumbnailUrl: 'https://live.staticflickr.com/thumb.jpg',
    remoteUrl: 'https://live.staticflickr.com/full.jpg',
    sourcePageUrl: 'https://www.flickr.com/photos/example/123',
    creator: 'Chef Example',
    license: 'cc_by' as const,
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    licenseVersion: '4.0',
  },
];

let server: http.Server;
let baseUrl: string;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  process.env.TRUST_PROXY = '1';
  const app = createApp({ isProduction: false });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.TRUST_PROXY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  searchMock.mockReset();
  selectMock.mockReset();
  thumbMock.mockReset();
});

afterEach(() => {
  for (const k of ['REPRESENTATIVE_IMAGE_SEARCH_RATE_LIMIT', 'REPRESENTATIVE_IMAGE_THUMBNAIL_RATE_LIMIT', 'REPRESENTATIVE_IMAGE_SELECT_RATE_LIMIT']) {
    delete process.env[k];
  }
});

describe('POST /api/recipes/image/find-representative', () => {
  it('rejects a malformed body', async () => {
    const res = await post('/api/recipes/image/find-representative', []);
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('INVALID_REQUEST');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('makes ZERO external calls for an unsafe/empty query', async () => {
    const res = await post('/api/recipes/image/find-representative', {
      title: 'sk-or-v1-ABCDEF',
      ingredients: ['api_key', 'user@example.com'],
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('IMAGE_QUERY_UNSAFE');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('returns a bounded candidate response with NO external thumbnail/download URL', async () => {
    searchMock.mockResolvedValue(FOUND);
    const res = await post('/api/recipes/image/find-representative', { title: 'Blue Cheese Smashburgers' });
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(res.json.candidates).toHaveLength(1);
    const serialized = JSON.stringify(res.json);
    expect(serialized).not.toContain('live.staticflickr.com');
    expect(serialized).not.toContain('upload.wikimedia');
    expect(res.json.candidates[0].thumbnailPath).toMatch(
      /^\/api\/recipes\/image\/representative-thumbnail\//
    );
    expect(res.json.candidates[0].thumbnailUrl).toBeUndefined();
  });

  it('re-sanitizes submitted search terms; unsafe-only terms make zero external calls', async () => {
    searchMock.mockResolvedValue(FOUND);
    const xff = { 'X-Forwarded-For': '10.90.0.1' };
    const ok = await post('/api/recipes/image/find-representative', { query: '  Blue   Cheese   Burger ' }, xff);
    expect(ok.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith('blue cheese burger');

    searchMock.mockClear();
    const unsafe = await post(
      '/api/recipes/image/find-representative',
      { query: 'sk-or-v1-SECRET https://evil.example' },
      xff
    );
    expect(unsafe.status).toBe(422);
    expect(unsafe.json.code).toBe('IMAGE_QUERY_UNSAFE');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('preserves safe terms from mixed input and blocks punctuation-only input (zero calls)', async () => {
    searchMock.mockResolvedValue(FOUND);
    const xff = { 'X-Forwarded-For': '10.90.0.2' };
    const mixed = await post(
      '/api/recipes/image/find-representative',
      { query: 'blue cheese burger https://evil.example' },
      xff
    );
    expect(mixed.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith('blue cheese burger');

    searchMock.mockClear();
    for (const punctuationOnly of ['---', '...', '___']) {
      const res = await post('/api/recipes/image/find-representative', { query: punctuationOnly }, xff);
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('IMAGE_QUERY_UNSAFE');
    }
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('server re-sanitizes forged private-key and encoded-URL queries (zero calls)', async () => {
    searchMock.mockResolvedValue(FOUND);
    const xff = { 'X-Forwarded-For': '10.90.0.3' };

    // Mixed: safe food term survives around a private-key header.
    const mixed = await post(
      '/api/recipes/image/find-representative',
      { query: 'burger BEGIN OPENSSH PRIVATE KEY' },
      xff
    );
    expect(mixed.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith('burger');
    expect(JSON.stringify(searchMock.mock.calls)).not.toContain('OPENSSH');

    searchMock.mockClear();
    // Unsafe-only secret/encoded inputs make ZERO external calls.
    for (const unsafe of [
      'BEGIN OPENSSH PRIVATE KEY',
      '-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA1234567890abcdefghij-----END RSA PRIVATE KEY-----',
      'https%3A%2F%2Fevil.example%2Fx',
      'file%3A%2F%2Fetc%2Fpasswd',
    ]) {
      const res = await post('/api/recipes/image/find-representative', { query: unsafe }, xff);
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('IMAGE_QUERY_UNSAFE');
    }
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('server re-sanitizes forged comma-decimal and scheme-less domain queries', async () => {
    searchMock.mockResolvedValue(FOUND);
    const xff = { 'X-Forwarded-For': '10.90.0.4' };

    // Only the SANITIZED value reaches the catalog search — never the domain.
    const mixed = await post('/api/recipes/image/find-representative', { query: 'burger evil.example' }, xff);
    expect(mixed.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith('burger');
    expect(JSON.stringify(searchMock.mock.calls)).not.toContain('evil.example');
    expect(JSON.stringify(searchMock.mock.calls)).not.toContain('evilexample');

    searchMock.mockClear();
    // Unsafe-only comma-decimal/domain inputs make ZERO external calls.
    for (const unsafe of ['1,5', 'evil.example', 'private.internal', 'subdomain.example.com', '192.168.1.1']) {
      const res = await post('/api/recipes/image/find-representative', { query: unsafe }, xff);
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('IMAGE_QUERY_UNSAFE');
    }
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('rate-limits search with a bounded 429', async () => {
    process.env.REPRESENTATIVE_IMAGE_SEARCH_RATE_LIMIT = '1';
    searchMock.mockResolvedValue(FOUND);
    const xff = { 'X-Forwarded-For': `10.1.1.${Math.floor(Math.random() * 200) + 1}` };
    expect((await post('/api/recipes/image/find-representative', { title: 'Burger' }, xff)).status).toBe(200);
    const limited = await post('/api/recipes/image/find-representative', { title: 'Burger' }, xff);
    expect(limited.status).toBe(429);
    expect(String(limited.json.error)).toMatch(/Too many representative image searches/i);
  });
});

describe('GET /api/recipes/image/representative-thumbnail/:candidateId', () => {
  it('serves requester-owned thumbnails through the app-local route with nosniff', async () => {
    searchMock.mockResolvedValue(FOUND);
    const search = await post('/api/recipes/image/find-representative', { title: 'Burger' });
    const id = search.json.candidates[0].id;
    thumbMock.mockResolvedValue({ bytes: PNG, contentType: 'image/png' });
    const res = await fetch(`${baseUrl}/api/recipes/image/representative-thumbnail/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('private');
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('returns an identical 404 for unknown candidates (no existence oracle)', async () => {
    thumbMock.mockRejectedValue(new rep.RepresentativeImageSelectionError('CANDIDATE_NOT_FOUND', 'nope'));
    const res = await fetch(`${baseUrl}/api/recipes/image/representative-thumbnail/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('CANDIDATE_NOT_FOUND');
  });

  it('requester A primes the cache; requester B gets not-found and NO cached bytes', async () => {
    searchMock.mockResolvedValue(FOUND);
    const xffA = { 'X-Forwarded-For': '10.50.0.1' };
    const xffB = { 'X-Forwarded-For': '10.50.0.2' };
    const search = await post('/api/recipes/image/find-representative', { title: 'Burger' }, xffA);
    const id = search.json.candidates[0].id;
    thumbMock.mockResolvedValue({ bytes: PNG, contentType: 'image/png' });

    // A primes the cache.
    const a1 = await fetch(`${baseUrl}/api/recipes/image/representative-thumbnail/${id}`, { headers: xffA });
    expect(a1.status).toBe(200);
    expect(thumbMock).toHaveBeenCalledTimes(1);

    // A cache hit retains validated MIME/nosniff/cache policy and does NOT fetch again.
    const a2 = await fetch(`${baseUrl}/api/recipes/image/representative-thumbnail/${id}`, { headers: xffA });
    expect(a2.status).toBe(200);
    expect(a2.headers.get('content-type')).toBe('image/png');
    expect(a2.headers.get('x-content-type-options')).toBe('nosniff');
    expect(a2.headers.get('cache-control')).toContain('private');
    expect(thumbMock).toHaveBeenCalledTimes(1);

    // B is a different requester: bounded not-found, no cached bytes, no leak.
    const b = await fetch(`${baseUrl}/api/recipes/image/representative-thumbnail/${id}`, { headers: xffB });
    expect(b.status).toBe(404);
    expect((await b.json()).code).toBe('CANDIDATE_NOT_FOUND');
    expect(thumbMock).toHaveBeenCalledTimes(1);
  });

  it('an expired candidate with a cached thumbnail returns not-found', async () => {
    searchMock.mockResolvedValue(FOUND);
    const xff = { 'X-Forwarded-For': '10.51.0.1' };
    const search = await post('/api/recipes/image/find-representative', { title: 'Burger' }, xff);
    const id = search.json.candidates[0].id;
    thumbMock.mockResolvedValue({ bytes: PNG, contentType: 'image/png' });
    expect((await fetch(`${baseUrl}/api/recipes/image/representative-thumbnail/${id}`, { headers: xff })).status).toBe(200);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000); // past the 10-minute candidate TTL
    try {
      const res = await fetch(`${baseUrl}/api/recipes/image/representative-thumbnail/${id}`, { headers: xff });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('CANDIDATE_NOT_FOUND');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /api/recipes/image/select-representative', () => {
  it('returns a preview token + provenance for a requester-owned candidate', async () => {
    searchMock.mockResolvedValue(FOUND);
    const search = await post('/api/recipes/image/find-representative', { title: 'Burger' });
    const id = search.json.candidates[0].id;
    selectMock.mockResolvedValue({
      bytes: PNG,
      contentType: 'image/png',
      provenance: {
        kind: 'representative',
        provenanceVersion: 'representative_v1',
        source: 'openverse',
        sourcePageUrl: 'https://www.flickr.com/photos/example/123',
        license: 'cc_by',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        licenseVersion: '4.0',
      },
    });
    const res = await post('/api/recipes/image/select-representative', { candidateId: id });
    expect(res.status).toBe(200);
    expect(res.json.token).toBeTruthy();
    expect(res.json.provenance.kind).toBe('representative');
  });

  it('rejects an unknown candidate id with 404', async () => {
    selectMock.mockRejectedValue(new rep.RepresentativeImageSelectionError('CANDIDATE_NOT_FOUND', 'nope'));
    const res = await post('/api/recipes/image/select-representative', { candidateId: 'nope' });
    expect(res.status).toBe(404);
  });

  it('rate-limits selection separately from search', async () => {
    process.env.REPRESENTATIVE_IMAGE_SELECT_RATE_LIMIT = '1';
    selectMock.mockRejectedValue(new rep.RepresentativeImageSelectionError('CANDIDATE_NOT_FOUND', 'nope'));
    const xff = { 'X-Forwarded-For': `10.2.2.${Math.floor(Math.random() * 200) + 1}` };
    expect((await post('/api/recipes/image/select-representative', { candidateId: 'a' }, xff)).status).toBe(404);
    const limited = await post('/api/recipes/image/select-representative', { candidateId: 'b' }, xff);
    expect(limited.status).toBe(429);
  });

  it('client-supplied url/license/source fields cannot alter candidate authority', async () => {
    searchMock.mockResolvedValue(FOUND);
    const search = await post('/api/recipes/image/find-representative', { title: 'Burger' });
    const id = search.json.candidates[0].id;
    selectMock.mockResolvedValue({
      bytes: PNG,
      contentType: 'image/png',
      provenance: {
        kind: 'representative',
        provenanceVersion: 'representative_v1',
        source: 'openverse',
        sourcePageUrl: 'https://www.flickr.com/photos/example/123',
        license: 'cc_by',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        licenseVersion: '4.0',
      },
    });
    const res = await post('/api/recipes/image/select-representative', {
      candidateId: id,
      url: 'https://evil.example/x.jpg',
      remoteUrl: 'https://evil.example/x.jpg',
      license: 'cc0',
      source: 'wikimedia_commons',
    });
    expect(res.status).toBe(200);
    const forwarded = selectMock.mock.calls[0];
    expect(forwarded[0]).toBe(id);
    expect(JSON.stringify(forwarded)).not.toContain('evil.example');
    expect(JSON.stringify(forwarded)).not.toContain('wikimedia_commons');
  });

  it('preview-store capacity failure maps to 503 PREVIEW_CAPACITY', async () => {
    const { PreviewStoreCapacityError } = await import('../../server/imagePreviewStore.js');
    selectMock.mockRejectedValue(new PreviewStoreCapacityError('Image preview store is at capacity.'));
    const res = await post('/api/recipes/image/select-representative', { candidateId: 'x' });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('PREVIEW_CAPACITY');
  });
});

describe('representative image — method/route boundaries', () => {
  it('GET on the POST-only search route returns the JSON 404 behavior', async () => {
    const res = await fetch(`${baseUrl}/api/recipes/image/find-representative`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error).toBe('Not found');
  });

  it('GET on the POST-only select route returns the JSON 404 behavior', async () => {
    const res = await fetch(`${baseUrl}/api/recipes/image/select-representative`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error).toBe('Not found');
  });
});
