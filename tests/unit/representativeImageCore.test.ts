import { describe, it, expect } from 'vitest';
import {
  normalizeRepresentativeLicense,
  buildRepresentativeImageQuery,
  buildRepresentativeImageSuggestions,
  sanitizeRepresentativeSearchTerms,
  isRepresentativeImageProvenance,
  sanitizeRepresentativeText,
  isSafeHttpUrl,
  boundRepresentativeCandidates,
  MAX_REPRESENTATIVE_QUERY_LENGTH,
  MAX_REPRESENTATIVE_QUERY_INGREDIENTS,
  MAX_REPRESENTATIVE_RESULTS,
  MAX_REPRESENTATIVE_SUGGESTIONS,
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

  // --- Recall repair (F2): concise dish-first defaults ---------------------

  it('F2: builds a concise dish-first default for Blue Cheese Smashburgers', () => {
    const query = buildRepresentativeImageQuery({
      title: 'Blue Cheese Smashburgers',
      cuisine: 'American',
      category: 'Main Course',
      tags: ['beef', 'burger'],
      ingredients: ['ground beef', 'brioche buns', 'blue cheese', 'butter'],
    });
    expect(query).toBe('blue cheese smashburger');
    // No unnecessary cuisine, no every-ingredient dump.
    expect(query).not.toContain('american');
    expect(query).not.toContain('beef');
    expect(query).not.toContain('buns');
    expect(query.split(' ')).toHaveLength(3);
  });

  it('F2: removes duplicate words/phrases from the query', () => {
    expect(buildRepresentativeImageQuery({ title: 'Blue Cheese Blue Cheese Burger' })).toBe('blue cheese burger');
  });

  it('F2: a weak single-word title gains at most one cuisine/category and one ingredient', () => {
    const query = buildRepresentativeImageQuery({
      title: 'Burger',
      cuisine: 'American',
      ingredients: ['ground beef', 'cheddar', 'bacon'],
    });
    expect(query).toContain('burger');
    expect(query.split(' ').length).toBeLessThanOrEqual(3);
    expect(query).not.toContain('cheddar');
    expect(query).not.toContain('bacon');
  });
});

describe('representative image — editable search terms + suggestions', () => {
  it('F2: sanitizes user-submitted search terms, dedupes, and bounds them', () => {
    expect(sanitizeRepresentativeSearchTerms('  Blue   Cheese   Burger ')).toBe('blue cheese burger');
    expect(sanitizeRepresentativeSearchTerms('blue cheese blue cheese burger')).toBe('blue cheese burger');
    expect(sanitizeRepresentativeSearchTerms('x'.repeat(500)).length).toBeLessThanOrEqual(
      MAX_REPRESENTATIVE_QUERY_LENGTH
    );
  });

  it('F2: unsafe-only search terms sanitize to empty (zero external calls)', () => {
    expect(sanitizeRepresentativeSearchTerms('sk-or-v1-SECRET')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('https://evil.example/x')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('user@example.com')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('C:\\Users\\sid\\vault')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('<script>alert(1)</script>')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('')).toBe('');
    expect(sanitizeRepresentativeSearchTerms(undefined)).toBe('');
  });

  // --- F3: mixed safe + unsafe terms preserve the safe terms ----------------

  it('F3: preserves safe terms and drops an embedded URL', () => {
    expect(sanitizeRepresentativeSearchTerms('blue cheese burger https://evil.example')).toBe('blue cheese burger');
    expect(sanitizeRepresentativeSearchTerms('blue cheese burger https://evil.example')).not.toContain('evil');
  });

  it('F3: preserves safe terms and drops an embedded email', () => {
    expect(sanitizeRepresentativeSearchTerms('burger user@example.com')).toBe('burger');
    expect(sanitizeRepresentativeSearchTerms('burger user@example.com')).not.toContain('example');
  });

  it('F3: preserves safe terms and drops embedded HTML/script', () => {
    expect(sanitizeRepresentativeSearchTerms('burger <script>alert(1)</script>')).toBe('burger');
    expect(sanitizeRepresentativeSearchTerms('burger <b>cheese</b>')).toBe('burger cheese');
  });

  // --- F4: punctuation-only input ------------------------------------------

  it('F4: punctuation-only / valueless input sanitizes to empty', () => {
    for (const input of ['---', '...', '___', '  --- ... ___  ', '/', '\\', '@']) {
      expect(sanitizeRepresentativeSearchTerms(input)).toBe('');
    }
  });

  // --- F5: meaningful numbered dish names ----------------------------------

  it('F5: preserves meaningful numbers in dish names', () => {
    expect(sanitizeRepresentativeSearchTerms('Chicken 65')).toBe('chicken 65');
    expect(sanitizeRepresentativeSearchTerms('7-Layer Dip')).toBe('7-layer dip');
    expect(sanitizeRepresentativeSearchTerms('2-Ingredient Bread')).toBe('2-ingredient bread');
    expect(sanitizeRepresentativeSearchTerms('chicken 65')).toBe('chicken 65');
  });

  it('F5: builds numbered dish queries (not just a raw quantity token)', () => {
    expect(buildRepresentativeImageQuery({ title: 'Chicken 65' })).toBe('chicken 65');
    expect(buildRepresentativeImageQuery({ title: '7-Layer Dip' })).toBe('7-layer dip');
    expect(buildRepresentativeImageQuery({ title: '2-Ingredient Bread' })).toBe('2-ingredient bread');
    expect(buildRepresentativeImageQuery({ title: '400g Rigatoni' })).not.toMatch(/\b400g\b/);
  });

  it('F5: quantity-like ingredient noise and long numeric identifiers stay excluded', () => {
    expect(sanitizeRepresentativeSearchTerms('400g rigatoni')).toBe('rigatoni');
    expect(sanitizeRepresentativeSearchTerms('1.25 tsp salt')).toBe('salt');
    expect(sanitizeRepresentativeSearchTerms('123456789 burger')).toBe('burger');
    expect(sanitizeRepresentativeSearchTerms('order 9988776655 burger')).toBe('order burger');
    expect(sanitizeRepresentativeSearchTerms('rigatoni 400')).toBe('rigatoni');
  });

  it('F2: builds deterministic broader suggestions for Blue Cheese Smashburgers', () => {
    const suggestions = buildRepresentativeImageSuggestions({ title: 'Blue Cheese Smashburgers' });
    expect(suggestions).toEqual(['blue cheese burger', 'smashburger', 'cheeseburger']);
    expect(suggestions.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_SUGGESTIONS);
  });

  it('F2: suggestions are privacy-sanitized and bounded', () => {
    expect(buildRepresentativeImageSuggestions({ title: 'sk-or-v1-ABCDEF' })).toEqual([]);
    const suggestions = buildRepresentativeImageSuggestions({ title: 'Chocolate Chip Cookies' });
    expect(suggestions.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_SUGGESTIONS);
    for (const suggestion of suggestions) {
      expect(suggestion).not.toMatch(/https?:|@|\\|\//);
      expect(suggestion.length).toBeLessThanOrEqual(MAX_REPRESENTATIVE_QUERY_LENGTH);
    }
  });

  // --- G1: phrase-aware private-key/secret removal -------------------------

  it('G1: removes complete PEM/private-key header and footer phrases', () => {
    expect(sanitizeRepresentativeSearchTerms('BEGIN OPENSSH PRIVATE KEY')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('BEGIN RSA PRIVATE KEY')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('BEGIN PRIVATE KEY')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('END OPENSSH PRIVATE KEY')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('-----BEGIN RSA PRIVATE KEY-----')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('-----END RSA PRIVATE KEY-----')).toBe('');
  });

  it('G1: mixed food terms survive around private-key material', () => {
    expect(sanitizeRepresentativeSearchTerms('burger BEGIN OPENSSH PRIVATE KEY')).toBe('burger');
    expect(sanitizeRepresentativeSearchTerms('burger -----BEGIN RSA PRIVATE KEY----- cheese')).toBe(
      'burger cheese'
    );
    expect(sanitizeRepresentativeSearchTerms('BEGIN RSA PRIVATE KEY xyz')).toBe('');
  });

  it('G1: plausible key-body chunks and PEM bodies never reach the query', () => {
    const pem = '-----BEGIN PRIVATE KEY-----MIIEowIBAAKCAQEA1234567890abcdefghij-----END PRIVATE KEY-----';
    expect(sanitizeRepresentativeSearchTerms(pem)).toBe('');
    // A standalone long base64-ish body chunk is dropped.
    expect(sanitizeRepresentativeSearchTerms('MIIEowIBAAKCAQEA1234567890abcdefghij')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('burger MIIEowIBAAKCAQEA1234567890abcdefghij')).toBe('burger');
  });

  it('G1: ordinary food names containing "key" remain searchable', () => {
    expect(sanitizeRepresentativeSearchTerms('key lime pie')).toBe('key lime pie');
    expect(sanitizeRepresentativeSearchTerms('monkey bread')).toBe('monkey bread');
  });

  // --- G2: percent-encoded URLs -------------------------------------------

  it('G2: removes percent-encoded URL/scheme/path fragments', () => {
    expect(sanitizeRepresentativeSearchTerms('https%3A%2F%2Fevil.example%2Fx')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('http%3a%2f%2fevil.example')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('file%3A%2F%2Fetc%2Fpasswd')).toBe('');
  });

  it('G2: mixed safe plus encoded URL preserves only safe terms', () => {
    expect(sanitizeRepresentativeSearchTerms('burger https%3A%2F%2Fevil.example%2Fx')).toBe('burger');
  });

  it('G2: malformed percent encoding does not throw and cannot smuggle a URL', () => {
    expect(() => sanitizeRepresentativeSearchTerms('burger %zz cheese')).not.toThrow();
    expect(sanitizeRepresentativeSearchTerms('burger %zz cheese')).toBe('burger cheese');
    expect(sanitizeRepresentativeSearchTerms('https%3A%2F%2Fevil.example%2Fx%')).toBe('');
  });

  // --- G3: decimal/fractional quantities ----------------------------------

  it('G3: decimal and fractional quantities never concatenate into dish numbers', () => {
    expect(sanitizeRepresentativeSearchTerms('1.5 cups flour')).toBe('flour');
    expect(sanitizeRepresentativeSearchTerms('0.5 tsp salt')).toBe('salt');
    expect(sanitizeRepresentativeSearchTerms('1.25 tablespoons oil')).toBe('oil');
    expect(sanitizeRepresentativeSearchTerms('2 1/2 cups flour')).toBe('flour');
    expect(sanitizeRepresentativeSearchTerms('400g rigatoni')).toBe('rigatoni');
  });

  it('G3: legitimate numbered dishes remain unchanged', () => {
    expect(sanitizeRepresentativeSearchTerms('Chicken 65')).toBe('chicken 65');
    expect(sanitizeRepresentativeSearchTerms('7-Layer Dip')).toBe('7-layer dip');
    expect(sanitizeRepresentativeSearchTerms('2-Ingredient Bread')).toBe('2-ingredient bread');
    expect(sanitizeRepresentativeSearchTerms('5-spice chicken')).toBe('5-spice chicken');
    expect(buildRepresentativeImageQuery({ title: '5-spice chicken' })).toBe('5-spice chicken');
  });
});

describe('representative image — comma decimals + scheme-less hosts (final findings)', () => {
  // --- H1: comma-decimal quantities ---------------------------------------

  it('H1: comma decimals are removed BEFORE punctuation can merge their digits', () => {
    expect(sanitizeRepresentativeSearchTerms('1,5 cups flour')).toBe('flour');
    expect(sanitizeRepresentativeSearchTerms('0,5 tsp salt')).toBe('salt');
    expect(sanitizeRepresentativeSearchTerms('1,25 tablespoons oil')).toBe('oil');
    expect(sanitizeRepresentativeSearchTerms('2,75 kg potatoes')).toBe('potatoes');
    // The comma-decimal alone must NOT degrade into the dish number "1" or "15".
    expect(sanitizeRepresentativeSearchTerms('1,5')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('1,5 flour')).toBe('flour');
  });

  it('H1: dot decimals and fractions remain correct', () => {
    expect(sanitizeRepresentativeSearchTerms('1.5 cups flour')).toBe('flour');
    expect(sanitizeRepresentativeSearchTerms('2 1/2 cups flour')).toBe('flour');
    expect(sanitizeRepresentativeSearchTerms('400g rigatoni')).toBe('rigatoni');
  });

  it('H1: ordinary commas between food words are NOT decimal quantities', () => {
    expect(sanitizeRepresentativeSearchTerms('salt, pepper, flour')).toBe('salt pepper flour');
    expect(sanitizeRepresentativeSearchTerms('tomato, basil')).toBe('tomato basil');
  });

  it('H1: legitimate numbered dishes remain correct', () => {
    expect(sanitizeRepresentativeSearchTerms('Chicken 65')).toBe('chicken 65');
    expect(sanitizeRepresentativeSearchTerms('7-Layer Dip')).toBe('7-layer dip');
    expect(sanitizeRepresentativeSearchTerms('2-Ingredient Bread')).toBe('2-ingredient bread');
    expect(sanitizeRepresentativeSearchTerms('5-spice chicken')).toBe('5-spice chicken');
  });

  // --- H2: scheme-less dotted host/domain ---------------------------------

  it('H2: scheme-less domains, subdomains and internal hosts are removed', () => {
    expect(sanitizeRepresentativeSearchTerms('evil.example')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('private.internal')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('subdomain.example.com')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('192.168.1.1')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('10.0.0.1')).toBe('');
  });

  it('H2: host with port/path/query/fragment is removed', () => {
    expect(sanitizeRepresentativeSearchTerms('evil.example:8080')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('evil.example/path')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('evil.example?x=1')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('evil.example#frag')).toBe('');
  });

  it('H2: mixed safe terms around a domain survive', () => {
    expect(sanitizeRepresentativeSearchTerms('burger evil.example')).toBe('burger');
    expect(sanitizeRepresentativeSearchTerms('burger private.internal cheese')).toBe('burger cheese');
    expect(sanitizeRepresentativeSearchTerms('burger evil.example:8080 cheese')).toBe('burger cheese');
  });

  it('H2: percent-encoded dotted hosts remain removed', () => {
    expect(sanitizeRepresentativeSearchTerms('evil%2Eexample')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('burger evil%2Eexample')).toBe('burger');
  });

  it('H2: culinary abbreviations are NOT misclassified as domains', () => {
    expect(sanitizeRepresentativeSearchTerms('St. Louis ribs')).toBe('st louis ribs');
    expect(sanitizeRepresentativeSearchTerms('U.S. style barbecue')).toBe('us style barbecue');
    expect(sanitizeRepresentativeSearchTerms('S.O.S.')).toBe('sos');
    // Decimal quantities are handled separately from dotted abbreviations.
    expect(sanitizeRepresentativeSearchTerms('1,5 cups flour')).toBe('flour');
    expect(sanitizeRepresentativeSearchTerms('1.5 cups flour')).toBe('flour');
  });

  // --- Privacy-first key-body rule (unchanged) ----------------------------

  it('H: long unspaced mixed-case names remain fail-closed (documented recall limitation)', () => {
    // The 20–39 char key-body heuristic intentionally rejects mixed-case runs
    // without requiring a digit/equals; this is a privacy-first tradeoff.
    expect(sanitizeRepresentativeSearchTerms('MisoGlazedSalmonBowl')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('MIIEowIBAAKCAQEA1234567890abcdefghij')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('BEGIN OPENSSH PRIVATE KEY')).toBe('');
    expect(sanitizeRepresentativeSearchTerms('key lime pie')).toBe('key lime pie');
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
