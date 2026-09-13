import { describe, it, expect, vi } from 'vitest';
import {
  findRepresentativeImages,
  selectRepresentativeImage,
  buildRepresentativeSearchInput,
  mapRepresentativeImageError,
  FIND_REPRESENTATIVE_IMAGE_PATH,
  SELECT_REPRESENTATIVE_IMAGE_PATH,
  RepresentativeImageClientError,
} from '../../src/application/representativeImage';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { ObsidianRecipe } from '../../src/types';

function networkWith(handler: (path: string, body: unknown) => { ok: boolean; status: number; data?: unknown }): {
  network: NetworkAdapter;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(async (path: string, body: unknown) => handler(path, body));
  return { network: { request: vi.fn(), get: vi.fn(), post } as unknown as NetworkAdapter, post };
}

const candidateRow = {
  id: 'opaque-1',
  source: 'openverse',
  title: 'Blue Cheese Burger',
  thumbnailPath: '/api/recipes/image/representative-thumbnail/opaque-1',
  sourcePageUrl: 'https://www.flickr.com/photos/example/123',
  creator: 'Chef Example',
  license: 'cc_by',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  licenseVersion: '4.0',
};

describe('representative image client — search', () => {
  it('posts the deterministic recipe fields to the find endpoint and bounds candidates', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ...candidateRow, id: `opaque-${i}` }));
    const { network, post } = networkWith(() => ({ ok: true, status: 200, data: { query: 'blue cheese smashburger', candidates: rows } }));
    const result = await findRepresentativeImages(network, { title: 'Blue Cheese Smashburgers' });
    expect(post).toHaveBeenCalledWith(FIND_REPRESENTATIVE_IMAGE_PATH, { title: 'Blue Cheese Smashburgers' });
    expect(result.query).toBe('blue cheese smashburger');
    expect(result.candidates).toHaveLength(6);
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining('/api/recipes/image/generate'), expect.anything());
  });

  it('drops malformed/unsafe candidate rows (unknown source, missing id/license)', async () => {
    const { network } = networkWith(() => ({
      ok: true,
      status: 200,
      data: {
        query: 'x',
        candidates: [
          candidateRow,
          { ...candidateRow, id: '' },
          { ...candidateRow, source: 'google_images' },
          { ...candidateRow, license: '' },
          { ...candidateRow, thumbnailPath: '' },
        ],
      },
    }));
    const result = await findRepresentativeImages(network, { title: 'x' });
    expect(result.candidates).toHaveLength(1);
  });
});

describe('representative image client — selection', () => {
  it('submits only the opaque candidate id (never a URL) and returns provenance', async () => {
    const { network, post } = networkWith((path) => {
      expect(path).toBe(SELECT_REPRESENTATIVE_IMAGE_PATH);
      return {
        ok: true,
        status: 200,
        data: {
          token: 'token-1',
          contentType: 'image/png',
          expiresAt: 123,
          provenance: {
            kind: 'representative',
            provenanceVersion: 'representative_v1',
            source: 'openverse',
            sourcePageUrl: 'https://www.flickr.com/photos/example/123',
            license: 'cc_by',
            licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          },
        },
      };
    });
    const selected = await selectRepresentativeImage(network, 'opaque-1');
    expect(post).toHaveBeenCalledWith(SELECT_REPRESENTATIVE_IMAGE_PATH, { candidateId: 'opaque-1' });
    expect(JSON.stringify(post.mock.calls[0][1])).not.toContain('http');
    expect(selected.provenance.kind).toBe('representative');
  });

  it('fails closed on a malformed selection response', async () => {
    const { network } = networkWith(() => ({ ok: true, status: 200, data: { token: '', provenance: undefined } }));
    await expect(selectRepresentativeImage(network, 'opaque-1')).rejects.toBeInstanceOf(RepresentativeImageClientError);
  });
});

describe('representative image client — input + errors', () => {
  it('builds bounded search input from recipe display fields only', () => {
    const recipe = {
      title: 'Blue Cheese Smashburgers',
      cuisine: 'American',
      category: 'Main Course',
      ingredients: [
        { name: 'ground beef' },
        { name: 'fine sea salt' },
        { name: 'blue cheese' },
        { name: 'brioche buns' },
      ],
    } as unknown as ObsidianRecipe;
    const input = buildRepresentativeSearchInput(recipe);
    expect(input.title).toBe('Blue Cheese Smashburgers');
    expect(input.ingredients).toEqual(['ground beef', 'fine sea salt', 'blue cheese']);
  });

  it('maps failures to bounded user-facing messages (no raw text)', () => {
    expect(mapRepresentativeImageError(new RepresentativeImageClientError(429, 'raw upstream text'))).toContain('Too many');
    expect(
      mapRepresentativeImageError(new RepresentativeImageClientError(403, 'x', 'LICENSE_NOT_ALLOWED'))
    ).toContain('reusable license');
    expect(
      mapRepresentativeImageError(new RepresentativeImageClientError(404, 'x', 'CANDIDATE_NOT_FOUND'))
    ).toContain('no longer available');
    expect(mapRepresentativeImageError(new Error('UPSTREAM_RAW_SENTINEL'))).not.toContain('UPSTREAM_RAW_SENTINEL');
  });
});
