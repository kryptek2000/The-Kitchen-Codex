import { describe, it, expect } from 'vitest';
import {
  normalizeQuery,
  normalizeQueryChecked,
  stripWikilinks,
} from '../../src/core/nutritionV2/matching/normalize';
import { MAX_QUERY_TOKENS, MAX_TOKEN_LENGTH } from '../../src/core/nutritionV2/matching/types';

/**
 * Phase 2 — conservative query normalization (matching only).
 */

describe('phase 2 normalize — wikilinks', () => {
  it('extracts the alias, target, and heading label deterministically', () => {
    expect(stripWikilinks('[[Flour|all-purpose flour]]')).toBe('all-purpose flour');
    expect(stripWikilinks('[[Flour]]')).toBe('Flour');
    expect(stripWikilinks('[[Flour#Types|AP flour]]')).toBe('AP flour');
    expect(stripWikilinks('[[Flour#Types]]')).toBe('Flour');
    expect(stripWikilinks('![[Flour]]')).toBe('Flour');
    expect(normalizeQuery('[[Flour|all-purpose flour]]').text).toBe('all purpose flour');
    expect(normalizeQuery('[[Flour]]').text).toBe('flour');
    expect(normalizeQuery('1 cup [[Flour|AP flour]]').text).toBe('1 cup ap flour');
  });
});

describe('phase 2 normalize — punctuation, whitespace, case', () => {
  it('collapses whitespace and separates punctuation', () => {
    expect(normalizeQuery('  Butter,   SALTED  ').text).toBe('butter salted');
    expect(normalizeQuery('sun-dried tomatoes').text).toBe('sun dried tomatoes');
    expect(normalizeQuery('milk (whole)').text).toBe('milk whole');
    expect(normalizeQuery('oil / fat').text).toBe('oil fat');
    expect(normalizeQuery('salt & pepper').text).toBe('salt pepper');
  });

  it('uses non-locale lowercase (Turkish-I safe)', () => {
    expect(normalizeQuery('I').text).toBe('i');
    expect(normalizeQuery('IRON').text).toBe('iron');
  });

  it('is deterministic and idempotent', () => {
    const once = normalizeQuery('Milk,   Whole 3.25%');
    const twice = normalizeQuery('Milk,   Whole 3.25%');
    expect(once).toEqual(twice);
    expect(normalizeQuery(once.text).text).toBe(once.text);
  });
});

describe('phase 2 normalize — Unicode', () => {
  it('applies NFC deterministically (NFC and NFD collide)', () => {
    const nfc = 'Caf\u00e9';
    const nfd = 'Cafe\u0301';
    expect(normalizeQuery(nfc).text).toBe('café');
    expect(normalizeQuery(nfd).text).toBe('café');
    expect(normalizeQuery(nfc).text).toBe(normalizeQuery(nfd).text);
  });

  it('keeps distinct normalization forms distinct only when they are truly distinct', () => {
    expect(normalizeQuery('milk').text).not.toBe(normalizeQuery('milks').text);
  });
});

describe('phase 2 normalize — no destructive qualifier removal', () => {
  it('preserves nutritionally significant qualifiers', () => {
    const pairs: ReadonlyArray<[string, string]> = [
      ['Butter, salted', 'Butter, unsalted'],
      ['Beef, ground, raw', 'Beef, ground, cooked'],
      ['Milk, whole', 'Milk, skim'],
      ['Milk, sweetened', 'Milk, unsweetened'],
      ['Flour, enriched', 'Flour, unenriched'],
      ['Tomatoes, canned, drained', 'Tomatoes, canned, undrained'],
      ['Chicken, with skin', 'Chicken, without skin'],
      ['Rice, dry', 'Rice, prepared'],
    ];
    for (const [a, b] of pairs) {
      expect(normalizeQuery(a).text, a).not.toBe(normalizeQuery(b).text);
    }
    expect(normalizeQuery('Butter, unsalted').text).toContain('unsalted');
    expect(normalizeQuery('Beef, ground, raw').text).toContain('raw');
    expect(normalizeQuery('Milk, sweetened').text).toContain('sweetened');
    expect(normalizeQuery('Flour, unenriched').text).toContain('unenriched');
  });
});

describe('phase 2 normalize — bounded query validation', () => {
  it('rejects empty normalized queries', () => {
    expect(normalizeQueryChecked('   ')).toEqual({ ok: false, code: 'empty_query' });
    expect(normalizeQueryChecked('!!!')).toEqual({ ok: false, code: 'empty_query' });
  });

  it('rejects too many tokens or an over-long token', () => {
    const manyTokens = Array.from({ length: MAX_QUERY_TOKENS + 1 }, (_, i) => `t${i}`).join(' ');
    expect(normalizeQueryChecked(manyTokens)).toEqual({ ok: false, code: 'invalid_query' });
    const longToken = 'a'.repeat(MAX_TOKEN_LENGTH + 1);
    expect(normalizeQueryChecked(longToken)).toEqual({ ok: false, code: 'invalid_query' });
  });

  it('accepts a normal query', () => {
    const result = normalizeQueryChecked('Milk, whole');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query.text).toBe('milk whole');
  });
});
