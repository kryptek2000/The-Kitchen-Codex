import { describe, it, expect, vi } from 'vitest';
import {
  RepresentativeImageCandidateStore,
  searchRepresentativeImages,
  selectRepresentativeImage,
  fetchRepresentativeThumbnail,
  RepresentativeImageSelectionError,
  OPENVERSE_ENDPOINT,
  WIKIMEDIA_COMMONS_ENDPOINT,
  MAX_STORED_CANDIDATES,
  MAX_STORED_CANDIDATES_PER_REQUESTER,
} from '../../server/representativeImage';
import { MAX_REPRESENTATIVE_RESULTS } from '../../src/core/representativeImage';
import {
  representativeImageSearchRateLimiter,
  representativeImageThumbnailRateLimiter,
  representativeImageSelectRateLimiter,
} from '../../server/rateLimiter';
import type { Request, Response } from 'express';

/** Minimal valid PNG bytes (signature + padding) for the mock download path. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const REQUESTER_A = 'requester-a';
const REQUESTER_B = 'requester-b';

function openversePayload(results: Array<Record<string, unknown>>) {
  return { results };
}

function openverseResult(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Blue Cheese Burger',
    creator: 'Chef Example',
    license: 'by',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    thumbnail: 'https://live.staticflickr.com/thumb.jpg',
    url: 'https://live.staticflickr.com/full.jpg',
    foreign_landing_url: 'https://www.flickr.com/photos/example/123',
    ...overrides,
  };
}

async function storedCandidate(overrides: Record<string, unknown> = {}) {
  const fetchJson = async () => openversePayload([openverseResult(overrides)]);
  return searchRepresentativeImages('blue cheese burger', { fetchJson });
}

describe('representative image — Openverse search', () => {
  it('uses the fixed Openverse HTTPS endpoint and returns only allowlisted licenses', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url.startsWith(OPENVERSE_ENDPOINT)).toBe(true);
      return openversePayload([
        openverseResult({ license: 'by' }),
        openverseResult({ license: 'cc0' }),
        openverseResult({ license: 'by-sa' }),
        openverseResult({ license: 'by-nc', title: 'NC rejected' }),
        openverseResult({ license: 'by-nd', title: 'ND rejected' }),
        openverseResult({ license: 'unknown-license', title: 'Unknown rejected' }),
        openverseResult({ license: undefined, license_url: undefined, title: 'Missing rejected' }),
        openverseResult({ thumbnail: 'javascript:alert(1)', title: 'Unsafe thumb rejected' }),
        openverseResult({ url: 'file:///etc/passwd', title: 'Unsafe remote rejected' }),
      ]);
    });
    const results = await searchRepresentativeImages('blue cheese smashburger', { fetchJson });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_RESULTS);
    for (const c of results) {
      expect(['cc0', 'public_domain', 'cc_by', 'cc_by_sa']).toContain(c.license);
      expect(c.source).toBe('openverse');
      expect(c.thumbnailUrl.startsWith('https://')).toBe(true);
    }
    expect(results.some((c) => c.title.includes('rejected'))).toBe(false);
  });

  it('retains a license version where safely established (never invents 4.0)', async () => {
    const fetchJson = async () =>
      openversePayload([
        openverseResult({ license: 'by-sa', license_version: '3.0' }),
        openverseResult({ license: 'by', license_version: '4.0' }),
        openverseResult({ license: 'cc0' }),
        openverseResult({ license: 'by', license_version: undefined, license_url: 'https://creativecommons.org/licenses/by/' }),
      ]);
    const results = await searchRepresentativeImages('x', { fetchJson });
    const bySa = results.find((r) => r.license === 'cc_by_sa')!;
    expect(bySa.licenseVersion).toBe('3.0');
    expect(bySa.licenseUrl).toContain('/by-sa/3.0/');
    const by = results.find((r) => r.license === 'cc_by' && r.licenseVersion === '4.0')!;
    expect(by.licenseVersion).toBe('4.0');
    const cc0 = results.find((r) => r.license === 'cc0')!;
    expect(cc0.licenseVersion).toBe('1.0');
    // Unknown version is marked unknown with a version-neutral family URL,
    // never invented as 4.0.
    const unknown = results.find((r) => r.license === 'cc_by' && r.licenseVersion === 'unknown');
    expect(unknown?.licenseUrl).toBe('https://creativecommons.org/licenses/by/');
    expect(unknown?.licenseUrl).not.toMatch(/\/(3\.0|4\.0)\//);
  });

  it('sanitizes upstream metadata strings (no markup, bounded)', async () => {
    const fetchJson = async () =>
      openversePayload([
        openverseResult({ title: '<img src=x onerror=alert(1)> Burger', creator: '<script>bad</script> Chef' }),
      ]);
    const [candidate] = await searchRepresentativeImages('burger', { fetchJson });
    expect(candidate.title).not.toContain('<');
    expect(candidate.title).not.toContain('onerror');
    expect(candidate.creator).not.toContain('<script>');
  });

  it('makes ZERO external calls for an empty query', async () => {
    const fetchJson = vi.fn(async () => openversePayload([openverseResult()]));
    const results = await searchRepresentativeImages('', { fetchJson });
    expect(results).toEqual([]);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('falls back to Wikimedia Commons only when Openverse yields no safe candidate', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.startsWith(OPENVERSE_ENDPOINT)) {
        return openversePayload([openverseResult({ license: 'by-nc' })]);
      }
      expect(url.startsWith(WIKIMEDIA_COMMONS_ENDPOINT)).toBe(true);
      return {
        query: {
          pages: {
            '1': {
              title: 'File:Burger.jpg',
              imageinfo: [
                {
                  url: 'https://upload.wikimedia.org/full.jpg',
                  thumburl: 'https://upload.wikimedia.org/thumb.jpg',
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Burger.jpg',
                  mime: 'image/jpeg',
                  extmetadata: {
                    LicenseShortName: { value: 'CC BY-SA 4.0' },
                    Artist: { value: 'Commons Author' },
                  },
                },
              ],
            },
          },
        },
      };
    });
    const results = await searchRepresentativeImages('burger', { fetchJson });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('wikimedia_commons');
    expect(results[0].license).toBe('cc_by_sa');
    expect(results[0].licenseVersion).toBe('4.0');
  });

  it('never returns raw upstream errors/bodies (search failure is bounded/empty)', async () => {
    const fetchJson = vi.fn(async () => {
      throw new Error('UPSTREAM_RAW_BODY_SENTINEL');
    });
    const results = await searchRepresentativeImages('burger', { fetchJson });
    expect(results).toEqual([]);
  });
});

describe('representative image — requester-bound candidate authority', () => {
  it('issues opaque ids and stores server-owned download/thumbnail URLs', async () => {
    const found = await storedCandidate();
    const store = new RepresentativeImageCandidateStore();
    const candidates = store.insertAll(REQUESTER_A, found);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).not.toContain('http');
    // The PUBLIC candidate exposes an app-local thumbnail route, never a host.
    expect(candidates[0].thumbnailPath).toBe(
      `/api/recipes/image/representative-thumbnail/${candidates[0].id}`
    );
    expect((candidates[0] as unknown as Record<string, unknown>)['thumbnailUrl']).toBeUndefined();
    const stored = store.get(candidates[0].id, REQUESTER_A)!;
    expect(stored.remoteUrl).toBe('https://live.staticflickr.com/full.jpg');
    expect(stored.thumbnailUrl).toBe('https://live.staticflickr.com/thumb.jpg');
  });

  it('fails cross-requester access without revealing existence', async () => {
    const found = await storedCandidate();
    const store = new RepresentativeImageCandidateStore();
    const [candidate] = store.insertAll(REQUESTER_A, found);
    expect(store.get(candidate.id, REQUESTER_A)).toBeDefined();
    expect(store.get(candidate.id, REQUESTER_B)).toBeUndefined();
    expect(store.remove(candidate.id, REQUESTER_B)).toBe(false);
    expect(store.get(candidate.id, REQUESTER_A)).toBeDefined();
  });

  it('bounds per-requester and global storage without cross-requester eviction', async () => {
    let now = 1000;
    const store = new RepresentativeImageCandidateStore({
      now: () => now,
      ttlMs: 100,
      maxEntries: 4,
      maxPerRequester: 2,
      createId: (() => {
        let i = 0;
        return () => `id-${++i}`;
      })(),
    });
    const found = await searchRepresentativeImages('x', {
      fetchJson: async () =>
        openversePayload([
          openverseResult({ url: 'https://live.staticflickr.com/1.jpg' }),
          openverseResult({ url: 'https://live.staticflickr.com/2.jpg' }),
          openverseResult({ url: 'https://live.staticflickr.com/3.jpg' }),
        ]),
    });
    const a = store.insertAll(REQUESTER_A, found);
    expect(a.length).toBe(2); // per-requester cap
    const b = store.insertAll(REQUESTER_B, found);
    expect(b.length).toBe(2); // global cap (4) reached; A's entries retained
    expect(store.sizeFor(REQUESTER_A)).toBe(2);
    expect(store.get(a[0].id, REQUESTER_A)).toBeDefined();
    now += 101;
    expect(store.get(a[0].id, REQUESTER_A)).toBeUndefined();
    expect(store.size()).toBeLessThanOrEqual(MAX_STORED_CANDIDATES);
    expect(MAX_STORED_CANDIDATES_PER_REQUESTER).toBeLessThan(MAX_STORED_CANDIDATES);
  });
});

describe('representative image — selection downloads only the stored candidate', () => {
  const makeStore = () => {
    const store = new RepresentativeImageCandidateStore({ createId: () => 'opaque-candidate-id' });
    store.insertAll(REQUESTER_A, [
      {
        source: 'openverse',
        query: 'blue cheese smashburger',
        title: 'Blue Cheese Burger',
        thumbnailUrl: 'https://live.staticflickr.com/thumb.jpg',
        remoteUrl: 'https://live.staticflickr.com/full.jpg',
        sourcePageUrl: 'https://www.flickr.com/photos/example/123',
        creator: 'Chef Example',
        license: 'cc_by',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        licenseVersion: '4.0',
      },
    ]);
    return store;
  };

  it('rejects unknown, cross-requester and client-supplied URLs (never fetches them)', async () => {
    const store = makeStore();
    const fetchImage = vi.fn(async () => ({ buffer: Buffer.from(PNG_BYTES), contentType: 'image/png' }));
    await expect(
      selectRepresentativeImage('https://evil.example/x.jpg', { store, requesterId: REQUESTER_A, fetchImage })
    ).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' });
    await expect(
      selectRepresentativeImage('opaque-candidate-id', { store, requesterId: REQUESTER_B, fetchImage })
    ).rejects.toBeInstanceOf(RepresentativeImageSelectionError);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('downloads the EXACT stored remote URL, returns provenance, and CONSUMES the candidate', async () => {
    const store = makeStore();
    const fetchImage = vi.fn(async (url: string) => {
      expect(url).toBe('https://live.staticflickr.com/full.jpg');
      return { buffer: Buffer.from(PNG_BYTES), contentType: 'image/png' };
    });
    const selected = await selectRepresentativeImage('opaque-candidate-id', {
      store,
      requesterId: REQUESTER_A,
      fetchImage,
      now: () => 0,
    });
    expect(selected.contentType).toBe('image/png');
    expect(selected.provenance).toMatchObject({
      kind: 'representative',
      source: 'openverse',
      license: 'cc_by',
      licenseVersion: '4.0',
    });
    expect(fetchImage).toHaveBeenCalledTimes(1);
    // Successful selection consumed the candidate.
    expect(store.get('opaque-candidate-id', REQUESTER_A)).toBeUndefined();
  });

  it('leaves the candidate usable after a FAILED download (bounded TTL)', async () => {
    const store = makeStore();
    const fetchImage = async () => {
      throw new Error('down');
    };
    await expect(
      selectRepresentativeImage('opaque-candidate-id', { store, requesterId: REQUESTER_A, fetchImage })
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(store.get('opaque-candidate-id', REQUESTER_A)).toBeDefined();
  });

  it('rejects a non-image download (SVG/GIF/HTML) without returning bytes', async () => {
    const store = makeStore();
    const fetchImage = async () => ({ buffer: Buffer.from('<svg></svg>'), contentType: 'image/svg+xml' });
    await expect(
      selectRepresentativeImage('opaque-candidate-id', { store, requesterId: REQUESTER_A, fetchImage })
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  });

  it('rejects a download whose declared type disagrees with its bytes', async () => {
    const store = makeStore();
    const fetchImage = async () => ({ buffer: Buffer.from('not-an-image'), contentType: 'image/png' });
    await expect(
      selectRepresentativeImage('opaque-candidate-id', { store, requesterId: REQUESTER_A, fetchImage })
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  });

  it('thumbnail fetch is requester-bound and does NOT consume the candidate', async () => {
    const store = makeStore();
    const fetchImage = vi.fn(async (url: string) => {
      expect(url).toBe('https://live.staticflickr.com/thumb.jpg');
      return { buffer: Buffer.from(PNG_BYTES), contentType: 'image/png' };
    });
    const thumb = await fetchRepresentativeThumbnail('opaque-candidate-id', {
      store,
      requesterId: REQUESTER_A,
      fetchImage,
    });
    expect(thumb.contentType).toBe('image/png');
    expect(store.get('opaque-candidate-id', REQUESTER_A)).toBeDefined();
    await expect(
      fetchRepresentativeThumbnail('opaque-candidate-id', { store, requesterId: REQUESTER_B, fetchImage })
    ).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' });
  });
});

describe('representative image — separate rate limiters', () => {
  function req(ip: string): Request {
    return { ip, socket: { remoteAddress: undefined } } as unknown as Request;
  }
  function res(): { res: Response; statusCode: () => number } {
    const r: any = {
      setHeader() {},
      status(c: number) {
        r.statusCode = c;
        return r;
      },
      json() {
        return r;
      },
      statusCode: 0,
    };
    return { res: r as Response, statusCode: () => r.statusCode };
  }
  function run(limiter: (req: Request, res: Response, next: () => void) => void, ip: string): { allowed: boolean; limited: boolean } {
    const r = res();
    let nextCalled = false;
    limiter(req(ip), r.res, () => {
      nextCalled = true;
    });
    return { allowed: nextCalled, limited: r.statusCode() === 429 };
  }

  it('thumbnail loading does not consume the search/selection allowance', () => {
    const original = { s: process.env.REPRESENTATIVE_IMAGE_SEARCH_RATE_LIMIT, t: process.env.REPRESENTATIVE_IMAGE_THUMBNAIL_RATE_LIMIT, sel: process.env.REPRESENTATIVE_IMAGE_SELECT_RATE_LIMIT };
    process.env.REPRESENTATIVE_IMAGE_SEARCH_RATE_LIMIT = '1';
    process.env.REPRESENTATIVE_IMAGE_THUMBNAIL_RATE_LIMIT = '6';
    process.env.REPRESENTATIVE_IMAGE_SELECT_RATE_LIMIT = '1';
    const ip = `10.8.8.${Math.floor(Math.random() * 200) + 1}`;
    try {
      expect(run(representativeImageSearchRateLimiter, ip).allowed).toBe(true);
      expect(run(representativeImageSearchRateLimiter, ip).limited).toBe(true);
      // Six thumbnail loads remain allowed independently of the exhausted search limit.
      for (let i = 0; i < 6; i++) expect(run(representativeImageThumbnailRateLimiter, ip).allowed).toBe(true);
      expect(run(representativeImageThumbnailRateLimiter, ip).limited).toBe(true);
      // Selection has its own allowance.
      expect(run(representativeImageSelectRateLimiter, ip).allowed).toBe(true);
      expect(run(representativeImageSelectRateLimiter, ip).limited).toBe(true);
    } finally {
      if (original.s === undefined) delete process.env.REPRESENTATIVE_IMAGE_SEARCH_RATE_LIMIT; else process.env.REPRESENTATIVE_IMAGE_SEARCH_RATE_LIMIT = original.s;
      if (original.t === undefined) delete process.env.REPRESENTATIVE_IMAGE_THUMBNAIL_RATE_LIMIT; else process.env.REPRESENTATIVE_IMAGE_THUMBNAIL_RATE_LIMIT = original.t;
      if (original.sel === undefined) delete process.env.REPRESENTATIVE_IMAGE_SELECT_RATE_LIMIT; else process.env.REPRESENTATIVE_IMAGE_SELECT_RATE_LIMIT = original.sel;
    }
  });
});
