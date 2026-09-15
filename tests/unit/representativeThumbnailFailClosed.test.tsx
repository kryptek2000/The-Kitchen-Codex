// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepresentativeImageChooser } from '../../src/components/RepresentativeImageChooser';
import { BrowserNetworkAdapter } from '../../src/platform/browser/BrowserNetworkAdapter';
import {
  setEndpointAccessToken,
  clearEndpointAccessToken,
  getEndpointAccessHeaders,
} from '../../src/application/endpointAccess';
import type { RepresentativeImageCandidate } from '../../src/core/representativeImage';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

/**
 * F1 (re-clearance) — representative thumbnails FAIL CLOSED without a binary
 * transport. There is NO plain `candidate.thumbnailPath` `<img src>` fallback:
 * thumbnails load ONLY through validated `NetworkAdapter.getBytes` bytes turned
 * into managed object URLs. Missing `network`/`getBytes` renders a bounded
 * per-candidate placeholder and issues NO request (no retry without auth, no
 * upstream Openverse/Wikimedia fetch, no endpoint token in any URL/DOM).
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const TOKEN_A = 'thumb-token-A';
const TOKEN_B = 'thumb-token-B';

function candidate(id: string): RepresentativeImageCandidate {
  return {
    id,
    source: 'openverse',
    title: `Candidate ${id}`,
    thumbnailPath: `/api/recipes/image/representative-thumbnail/${id}`,
    sourcePageUrl: 'https://www.flickr.com/photos/example/123',
    creator: 'Chef Example',
    license: 'cc_by',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    licenseVersion: '4.0',
  };
}

interface SeenCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeRouter(options: { requireAuth?: boolean } = {}) {
  const seen: SeenCall[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers = { ...((init?.headers as Record<string, string>) || {}) };
    seen.push({ url, method: (init?.method || 'GET').toUpperCase(), headers });
    if (url.startsWith('/api/recipes/image/representative-thumbnail/')) {
      if (options.requireAuth && !headers.Authorization) {
        return new Response('unauthorized', { status: 401 });
      }
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('not found', { status: 404 });
  }) as never;
  return { seen, fetchFn };
}

function thumbImgs(): HTMLImageElement[] {
  return Array.from(
    document.querySelectorAll('[data-testid="representative-candidate"] img')
  ) as HTMLImageElement[];
}

beforeEach(() => {
  clearEndpointAccessToken();
  let n = 0;
  (URL as any).createObjectURL = vi.fn(() => `blob:thumb-${(n += 1)}`);
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearEndpointAccessToken();
  vi.restoreAllMocks();
});

describe('representative thumbnails — no getBytes fails closed', () => {
  it('1+2. missing getBytes renders the bounded unavailable state and makes ZERO requests', () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const noBytes = { request: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as NetworkAdapter;
    render(<RepresentativeImageChooser candidates={[candidate('a'), candidate('b')]} network={noBytes} onSelect={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByTestId('representative-thumbnail-unavailable')).toHaveLength(2);
    expect(screen.queryByTestId('representative-thumbnail-loading')).toBeNull();
    expect(thumbImgs()).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
    expect((noBytes as any).request).not.toHaveBeenCalled();
    expect((noBytes as any).get).not.toHaveBeenCalled();
    expect((noBytes as any).post).not.toHaveBeenCalled();
  });

  it('1+2. absent network renders the bounded unavailable state and makes ZERO requests', () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    render(<RepresentativeImageChooser candidates={[candidate('a')]} onSelect={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByTestId('representative-thumbnail-unavailable')).toHaveLength(1);
    expect(thumbImgs()).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('3. no candidate.thumbnailPath ever becomes an image src', () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    render(<RepresentativeImageChooser candidates={[candidate('a'), candidate('b')]} onSelect={() => {}} onCancel={() => {}} />);
    for (const img of Array.from(document.querySelectorAll('img'))) {
      const src = img.getAttribute('src') || '';
      expect(src).not.toContain('representative-thumbnail');
      expect(src).not.toBe('/api/recipes/image/representative-thumbnail/a');
      expect(src).not.toBe('/api/recipes/image/representative-thumbnail/b');
    }
    expect(document.documentElement.outerHTML).not.toContain('/api/recipes/image/representative-thumbnail');
  });
});

describe('representative thumbnails — authenticated binary transport', () => {
  it('4+9. bytes receive the CURRENT endpoint Authorization (and none when unprotected)', async () => {
    const { seen, fetchFn } = makeRouter();
    const network = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(TOKEN_A);
    const { unmount } = render(
      <RepresentativeImageChooser candidates={[candidate('a')]} network={network} onSelect={() => {}} onCancel={() => {}} />
    );
    await waitFor(() => expect(thumbImgs().length).toBe(1));
    expect(thumbImgs()[0].src.startsWith('blob:')).toBe(true);
    const protectedCall = seen.find((c) => c.url === '/api/recipes/image/representative-thumbnail/a');
    expect(protectedCall?.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
    // Never an upstream host.
    for (const call of seen) expect(call.url).not.toMatch(/^https?:\/\//);
    unmount();

    // Unprotected production adapter: identical rendering, NO Authorization.
    clearEndpointAccessToken();
    const unprotected = makeRouter();
    const openNetwork = new BrowserNetworkAdapter({ fetchFn: unprotected.fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    render(
      <RepresentativeImageChooser candidates={[candidate('u')]} network={openNetwork} onSelect={() => {}} onCancel={() => {}} />
    );
    await waitFor(() => expect(thumbImgs().length).toBe(1));
    const openCall = unprotected.seen.find((c) => c.url === '/api/recipes/image/representative-thumbnail/u');
    expect(openCall).toBeTruthy();
    expect(openCall?.headers.Authorization).toBeUndefined();
  });

  it('5+6. token replacement is reflected immediately; token removal fails closed (no plain src, no unauth retry)', async () => {
    const { seen, fetchFn } = makeRouter({ requireAuth: true });
    const network = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(TOKEN_A);
    const { rerender } = render(
      <RepresentativeImageChooser candidates={[candidate('a')]} network={network} onSelect={() => {}} onCancel={() => {}} />
    );
    await waitFor(() => expect(thumbImgs().length).toBe(1));

    // Replace the token, then a NEW candidate set: the next fetch uses the new token.
    setEndpointAccessToken(TOKEN_B);
    rerender(
      <RepresentativeImageChooser candidates={[candidate('b')]} network={network} onSelect={() => {}} onCancel={() => {}} />
    );
    await waitFor(() => expect(seen.some((c) => c.url === '/api/recipes/image/representative-thumbnail/b')).toBe(true));
    const callB = seen.find((c) => c.url === '/api/recipes/image/representative-thumbnail/b');
    expect(callB?.headers.Authorization).toBe(`Bearer ${TOKEN_B}`);

    // Remove the token: the protected route now rejects; the chooser shows the
    // bounded unavailable state and NEVER falls back to a plain protected src.
    clearEndpointAccessToken();
    rerender(
      <RepresentativeImageChooser candidates={[candidate('c')]} network={network} onSelect={() => {}} onCancel={() => {}} />
    );
    await waitFor(() => expect(screen.getAllByTestId('representative-thumbnail-unavailable').length).toBe(1));
    expect(thumbImgs()).toHaveLength(0);
    const callC = seen.find((c) => c.url === '/api/recipes/image/representative-thumbnail/c');
    expect(callC?.headers.Authorization).toBeUndefined();
    // Exactly ONE binary GET per candidate: no retry without authorization.
    expect(seen.filter((c) => c.url === '/api/recipes/image/representative-thumbnail/c').length).toBe(1);
    for (const img of Array.from(document.querySelectorAll('img'))) {
      expect(img.getAttribute('src') || '').not.toContain('representative-thumbnail');
    }
  });

  it('7. the endpoint token appears in no URL, request, image src, or DOM', async () => {
    const { seen, fetchFn } = makeRouter();
    const network = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(TOKEN_A);
    render(<RepresentativeImageChooser candidates={[candidate('a')]} network={network} onSelect={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(thumbImgs().length).toBe(1));
    for (const call of seen) {
      expect(call.url).not.toContain(TOKEN_A);
      expect(call.url).not.toContain('token=');
    }
    expect(document.documentElement.outerHTML).not.toContain(TOKEN_A);
    for (const img of Array.from(document.querySelectorAll('img'))) {
      expect(img.getAttribute('src') || '').not.toContain(TOKEN_A);
    }
  });

  it('8. every thumbnail object URL is revoked on candidate replacement and unmount', async () => {
    const { fetchFn } = makeRouter();
    const network = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(TOKEN_A);
    const revoke = () => URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
    const { rerender, unmount } = render(
      <RepresentativeImageChooser candidates={[candidate('a')]} network={network} onSelect={() => {}} onCancel={() => {}} />
    );
    await waitFor(() => expect(thumbImgs().length).toBe(1));
    const firstUrl = thumbImgs()[0].src;

    // Candidate replacement revokes the previous generation's object URL.
    rerender(
      <RepresentativeImageChooser candidates={[candidate('b')]} network={network} onSelect={() => {}} onCancel={() => {}} />
    );
    await waitFor(() => expect(revoke()).toHaveBeenCalledWith(firstUrl));
    await waitFor(() => expect(thumbImgs().length).toBe(1));
    const secondUrl = thumbImgs()[0].src;
    expect(secondUrl).not.toBe(firstUrl);

    // Unmount (close) revokes the current generation's object URL.
    unmount();
    expect(revoke()).toHaveBeenCalledWith(secondUrl);
  });
});

// ---------------------------------------------------------------------------
// Production callsite census: no plain protected thumbnail/preview src remains.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SRC = resolve(ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('production callsite census — protected preview/thumbnail plain src', () => {
  it('no <img src> in production sources binds a protected preview/thumbnail route or thumbnailPath', () => {
    const files = walk(SRC).filter((f) => !/\.(test|spec)\.(ts|tsx)$/.test(f));
    const srcExpressions: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const re = /src=\{([^}]*)\}/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        srcExpressions.push(`${relative(ROOT, file)}: ${match[1].trim()}`);
      }
    }
    for (const expr of srcExpressions) {
      expect(expr, `protected plain src fallback remains -> ${expr}`).not.toMatch(/thumbnailPath/);
      expect(expr, `protected plain src fallback remains -> ${expr}`).not.toMatch(
        /\/api\/recipes\/image\/(preview|representative-thumbnail)/
      );
    }
  });

  it('the chooser renders thumbnails only from managed object URLs', () => {
    const source = readFileSync(resolve(SRC, 'components/RepresentativeImageChooser.tsx'), 'utf8');
    expect(source).not.toContain('?? candidate.thumbnailPath');
    expect(source).not.toMatch(/src=\{candidate\.thumbnailPath\}/);
    expect(source).toContain('src={thumbUrls[candidate.id]}');
    expect(source).toContain('representative-thumbnail-unavailable');
  });
});
