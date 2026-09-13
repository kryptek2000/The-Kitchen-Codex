import { describe, it, expect } from 'vitest';
import {
  normalizeRepresentativeLicense,
  buildRepresentativeImageQuery,
  isRepresentativeImageProvenance,
  sanitizeRepresentativeText,
  isSafeHttpUrl,
  boundRepresentativeCandidates,
  MAX_REPRESENTATIVE_QUERY_LENGTH,
  MAX_REPRESENTATIVE_QUERY_INGREDIENTS,
  MAX_REPRESENTATIVE_RESULTS,
  REPRESENTATIVE_LICENSE_IDS,
} from '../../src/core/representativeImage';
import {
  serializeRecipeToObsidianMarkdown,
  parseObsidianRecipeMarkdown,
} from '../../src/utils/markdownParser';

describe('representative image — closed license allowlist', () => {
  it('normalizes reusable licenses into the closed allowlist', () => {
    expect(normalizeRepresentativeLicense('cc0')?.id).toBe('cc0');
    expect(normalizeRepresentativeLicense('CC0 1.0')?.id).toBe('cc0');
    expect(normalizeRepresentativeLicense('pdm')?.id).toBe('public_domain');
    expect(normalizeRepresentativeLicense('Public Domain')?.id).toBe('public_domain');
    expect(normalizeRepresentativeLicense('by')?.id).toBe('cc_by');
    expect(normalizeRepresentativeLicense('CC BY 4.0')?.id).toBe('cc_by');
    expect(normalizeRepresentativeLicense('by-sa')?.id).toBe('cc_by_sa');
    expect(normalizeRepresentativeLicense('CC BY-SA 3.0')?.id).toBe('cc_by_sa');
    for (const id of REPRESENTATIVE_LICENSE_IDS) {
      expect(normalizeRepresentativeLicense(id)?.id).toBe(id);
    }
  });

  it('rejects missing, unknown, noncommercial and no-derivatives licenses', () => {
    expect(normalizeRepresentativeLicense(undefined)).toBeNull();
    expect(normalizeRepresentativeLicense(null)).toBeNull();
    expect(normalizeRepresentativeLicense('')).toBeNull();
    expect(normalizeRepresentativeLicense('all rights reserved')).toBeNull();
    expect(normalizeRepresentativeLicense('CC BY-NC 4.0')).toBeNull();
    expect(normalizeRepresentativeLicense('CC BY-NC-SA')).toBeNull();
    expect(normalizeRepresentativeLicense('CC BY-ND 4.0')).toBeNull();
    expect(normalizeRepresentativeLicense('noncommercial')).toBeNull();
    expect(normalizeRepresentativeLicense('noderivatives')).toBeNull();
    expect(normalizeRepresentativeLicense('sampling+')).toBeNull();
  });

  it('FLAG 2: unknown CC BY/BY-SA versions use a truthful version-neutral URL (never invent 4.0)', () => {
    const by = normalizeRepresentativeLicense('by')!;
    expect(by.id).toBe('cc_by');
    expect(by.version).toBe('unknown');
    expect(by.url).toBe('https://creativecommons.org/licenses/by/');
    expect(by.url).not.toMatch(/\/(3\.0|4\.0)\//);

    const bySa = normalizeRepresentativeLicense('by-sa')!;
    expect(bySa.id).toBe('cc_by_sa');
    expect(bySa.version).toBe('unknown');
    expect(bySa.url).toBe('https://creativecommons.org/licenses/by-sa/');
    expect(bySa.url).not.toMatch(/\/(3\.0|4\.0)\//);

    // Known versions use the exact canonical version URL.
    expect(normalizeRepresentativeLicense('CC BY 3.0')!.url).toBe('https://creativecommons.org/licenses/by/3.0/');
    expect(normalizeRepresentativeLicense('CC BY-SA 4.0')!.url).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
    // CC0 / Public Domain remain truthful.
    expect(normalizeRepresentativeLicense('cc0')!.url).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(normalizeRepresentativeLicense('pdm')!.url).toBe('https://creativecommons.org/publicdomain/mark/1.0/');
  });

  it('sanitizes upstream text and bounds it (no markup)', () => {
    expect(sanitizeRepresentativeText('<b>Hello</b> <script>x</script> World')).toBe('Hello x World');
    expect(sanitizeRepresentativeText('a'.repeat(500)).length).toBe(120);
    expect(sanitizeRepresentativeText(123 as unknown)).toBe('');
  });

  it('validates safe http(s) URLs only', () => {
    expect(isSafeHttpUrl('https://commons.wikimedia.org/x.jpg')).toBe(true);
    expect(isSafeHttpUrl('http://example.com/x.png')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('https://user:pass@example.com/x')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('representative image — deterministic query builder', () => {
  const BLUE_CHEESE = {
    title: 'Blue Cheese Smashburgers',
    category: 'Main Course',
    ingredients: [
      '454 g ground beef (80/20), kept cold and divided into four loose 4-ounce balls',
      '1.25 tsp fine sea salt',
      '0.5 tsp coarse black pepper, freshly ground',
      '2 tsp neutral oil',
      '57 g unsalted butter, softened',
      '4 brioche buns, halved',
      '113 g blue cheese, crumbled',
    ],
  };

  it('targets a burger/smashburger with blue cheese — never merely "beef"', () => {
    const query = buildRepresentativeImageQuery(BLUE_CHEESE);
    expect(query).toContain('smashburger');
    expect(query).toContain('blue cheese');
    expect(query).not.toBe('beef');
  });

  it('excludes quantities, preparation prose, generic pantry items and secrets', () => {
    const query = buildRepresentativeImageQuery({
      title: 'Blue Cheese Smashburgers',
      ingredients: [
        '454 g ground beef',
        '1.25 tsp fine sea salt',
        '2 tsp neutral oil',
        '57 g unsalted butter',
        '1 cup all-purpose flour',
        'SECRET_VAULT_PATH/Assets/photo.jpg',
        'sk-or-v1-SECRET_SENTINEL',
      ],
    });
    expect(/\d/.test(query)).toBe(false);
    expect(query).not.toMatch(/\b(tsp|tbsp|cup|grams?|kg|ml|oz|lb)\b/);
    expect(query).not.toContain('salt');
    expect(query).not.toContain('oil');
    expect(query).not.toContain('butter');
    expect(query).not.toContain('flour');
    expect(query).not.toContain('assets');
    expect(query).not.toContain('sk-or-v1');
  });

  it('bounds query length and distinctive-ingredient count', () => {
    const query = buildRepresentativeImageQuery({
      title: 'A'.repeat(400),
      ingredients: ['chicken', 'salmon', 'tofu', 'lentils', 'walnuts', 'blueberries'],
    });
    expect(query.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_QUERY_LENGTH);
    // At most MAX_REPRESENTATIVE_QUERY_INGREDIENTS distinctive ingredients.
    expect(MAX_REPRESENTATIVE_QUERY_INGREDIENTS).toBe(3);
  });

  it('F1: hardens privacy across title/cuisine/category/tags (credentials, URLs, paths, emails, markup)', () => {
    const query = buildRepresentativeImageQuery({
      title: 'Blue Cheese Smashburgers',
      cuisine: 'Bearer abc123 token',
      category: 'https://evil.example/x',
      tags: ['api_key', 'secret', 'user@example.com', 'C:\\Users\\sid\\vault', '[[Internal Note]]', '<b>html</b>'],
      ingredients: ['blue cheese', 'authorization header', '/home/sid/vault/secret'],
    });
    expect(query).toContain('smashburger');
    expect(query).toContain('blue cheese');
    expect(query).not.toMatch(/bearer|token|api_key|secret|evil\.example|example\.com|users|home|html|authorization|header/i);
    expect(query.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_QUERY_LENGTH);
  });

  it('F1: returns an empty query when no safe visual term remains (caller makes no external call)', () => {
    expect(
      buildRepresentativeImageQuery({
        title: 'sk-or-v1-ABCDEF',
        cuisine: 'Bearer xyz',
        category: 'https://a.example',
        ingredients: ['api_key', 'user@example.com', 'C:\\vault\\x'],
      })
    ).toBe('');
  });

  it('F1: retains the burger-focused Blue Cheese Smashburgers query', () => {
    const query = buildRepresentativeImageQuery({
      title: 'Blue Cheese Smashburgers',
      ingredients: ['ground beef', 'fine sea salt', 'blue cheese', 'brioche buns'],
    });
    expect(query).toContain('smashburger');
    expect(query).toContain('blue cheese');
    expect(query).not.toContain('salt');
  });

  it('bounds the candidate result count', () => {
    expect(boundRepresentativeCandidates([1, 2, 3, 4, 5, 6, 7, 8])).toHaveLength(MAX_REPRESENTATIVE_RESULTS);
  });
});

describe('representative image — provenance validation', () => {
  const valid = {
    kind: 'representative',
    provenanceVersion: 'representative_v1',
    source: 'openverse',
    sourcePageUrl: 'https://www.flickr.com/photos/example/123',
    creator: 'Example Author',
    license: 'cc_by',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    localAssetPath: 'Assets/Blue Cheese Smashburgers.jpg',
    selectedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a well-formed representative provenance', () => {
    expect(isRepresentativeImageProvenance(valid)).toBe(true);
  });

  it('rejects kind/version/source/license/url tampering', () => {
    expect(isRepresentativeImageProvenance({ ...valid, kind: 'generated' })).toBe(false);
    expect(isRepresentativeImageProvenance({ ...valid, provenanceVersion: 'v2' })).toBe(false);
    expect(isRepresentativeImageProvenance({ ...valid, source: 'google_images' })).toBe(false);
    expect(isRepresentativeImageProvenance({ ...valid, license: 'cc_by_nc' })).toBe(false);
    expect(isRepresentativeImageProvenance({ ...valid, sourcePageUrl: 'javascript:alert(1)' })).toBe(false);
    expect(isRepresentativeImageProvenance(null)).toBe(false);
  });

  it('round-trips codex_representative_image provenance and stays legacy-compatible', () => {
    const recipe = {
      title: 'Blue Cheese Smashburgers',
      ingredients: [{ original: '1 cup flour', name: 'flour' }],
      instructions: [{ stepNumber: 1, text: 'Mix.' }],
      image: 'Assets/Blue Cheese Smashburgers.jpg',
      frontmatter: { codex_representative_image: valid },
    } as unknown as Parameters<typeof serializeRecipeToObsidianMarkdown>[0];
    const md = serializeRecipeToObsidianMarkdown(recipe);
    expect(md).toContain('codex_representative_image');
    expect(md).toContain('representative_v1');

    const parsed = parseObsidianRecipeMarkdown(md, 'X.md', 'X.md');
    const stored = (parsed.frontmatter as Record<string, unknown>)['codex_representative_image'];
    expect(isRepresentativeImageProvenance(stored)).toBe(true);
    expect((stored as Record<string, unknown>)['license']).toBe('cc_by');

    // Legacy recipes without provenance remain readable (absence is fine).
    const legacy = parseObsidianRecipeMarkdown('---\ntitle: Y\n---\n# Y', 'Y.md', 'Y.md');
    expect((legacy.frontmatter as Record<string, unknown>)['codex_representative_image']).toBeUndefined();
  });
});
