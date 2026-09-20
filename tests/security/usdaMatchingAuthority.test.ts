/**
 * The Kitchen Codex — Advanced Nutrition Phase 2 authority-encapsulation guard.
 *
 * Proves the catalog authority registry is lexically private: no module — via
 * the barrel OR a direct file-path import — exports a capability to register an
 * arbitrary object as a genuine catalog, retrieve private authority state, or
 * bless a structural catalog lookalike. Also reproduces the deep-import
 * authority exploit and proves it is rejected.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as boundaryModule from '../../src/core/nutritionV2/matching/review';
import { confirmIngredientReview, createReviewCatalog, reviewIngredient } from '../../src/core/nutritionV2/matching/review';
import type { ConfirmationResult, ReviewCatalog } from '../../src/core/nutritionV2/matching/types';
import { buildMatchingBundle, DEFAULT_MATCHING_SPECS } from '../fixtures/usdaMatchingFixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const MATCHING_DIR = resolve(ROOT, 'src/core/nutritionV2/matching');
const MODULE_NAMES = ['index', 'normalize', 'parse', 'rank', 'review', 'types'];

const AUTHORITY_TOKEN = /register|authority|registry|bless|retrieve|grant|capability/i;

function failureOf(result: ConfirmationResult): string | undefined {
  return result.outcome === 'invalid'
    ? (result as { outcome: 'invalid'; failure: { code: string } }).failure.code
    : undefined;
}

function genuineCatalog(): ReviewCatalog {
  const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
  const result = createReviewCatalog(manifest, records);
  if (!result.ok) {
    throw new Error(`catalog build failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  }
  return result.catalog;
}

function genuineReviewAndSelection(catalog: ReviewCatalog) {
  const review = reviewIngredient(catalog, { name: 'milk' });
  if (review.outcome !== 'review_required') throw new Error('expected review_required');
  const selection = {
    kind: 'candidate' as const,
    fdc_id: review.candidates[0].fdc_id,
    review_digest: review.review_digest as string,
  };
  return { review, selection };
}

describe('phase 2 authority — lexically private registry', () => {
  it('the authority boundary module exports only the intentional public operations', () => {
    expect(Object.keys(boundaryModule).sort()).toEqual(
      ['computeReviewDigest', 'confirmIngredientReview', 'createReviewCatalog', 'reviewIngredient'].sort()
    );
    for (const key of Object.keys(boundaryModule)) {
      expect(key).not.toMatch(AUTHORITY_TOKEN);
    }
  });

  it('no Phase 2 module exports a registration, retrieval, or registry capability', async () => {
    for (const name of MODULE_NAMES) {
      const mod = (await import(`../../src/core/nutritionV2/matching/${name}`)) as Record<string, unknown>;
      for (const key of Object.keys(mod)) {
        expect(key, `${name}.${key}`).not.toMatch(AUTHORITY_TOKEN);
      }
    }
  });

  it('has no separately importable authority/catalog module', () => {
    expect(existsSync(join(MATCHING_DIR, 'authority.ts'))).toBe(false);
    expect(existsSync(join(MATCHING_DIR, 'catalog.ts'))).toBe(false);
  });

  it('source audit: the only authority registry is a non-exported WeakMap in review.ts', () => {
    const files = readdirSync(MATCHING_DIR).filter((name) => name.endsWith('.ts'));
    for (const file of files) {
      const source = readFileSync(join(MATCHING_DIR, file), 'utf8');
      for (const line of source.split('\n')) {
        if (!/^\s*export\b/.test(line)) continue;
        expect(line, `${file}: ${line.trim()}`).not.toMatch(AUTHORITY_TOKEN);
      }
      if (/new\s+WeakMap/.test(source)) {
        expect(file, 'the authority registry must live only in review.ts').toBe('review.ts');
        expect(source).not.toMatch(/export\s+(const|let|var)\s+\w*(AUTHORITY|REGISTRY)/);
      }
    }
  });
});

describe('phase 2 authority — deep-import authority exploit is rejected', () => {
  it('a structural fake cannot be blessed and cannot confirm a genuine review', () => {
    const catalog = genuineCatalog();
    const { review, selection } = genuineReviewAndSelection(catalog);

    // Genuine catalog confirms.
    expect(confirmIngredientReview(catalog, review, selection).outcome).toBe('confirmed');

    // Structural lookalike rejected.
    const fake = {
      metadata: () => catalog.metadata(),
      size: () => catalog.size(),
      search: (q: unknown, l: number) => catalog.search(q as never, l),
      exactPhraseCount: (q: unknown) => catalog.exactPhraseCount(q as never),
      manualSearch: (q: unknown, l: number) => catalog.manualSearch(q as never, l),
    };
    expect(failureOf(confirmIngredientReview(fake, review, selection))).toBe('invalid_catalog');

    // Clone / spread wrapper / proxy / inherited object rejected.
    expect(failureOf(confirmIngredientReview({ ...catalog }, review, selection))).toBe('invalid_catalog');
    expect(failureOf(confirmIngredientReview(new Proxy(catalog, {}), review, selection))).toBe('invalid_catalog');
    expect(failureOf(confirmIngredientReview(Object.create(catalog), review, selection))).toBe('invalid_catalog');

    // No exported registration/retrieval handle exists to bless it.
    const mod = boundaryModule as unknown as Record<string, unknown>;
    for (const forbidden of [
      'registerCatalogAuthority',
      'getCatalogAuthority',
      'authority',
      'registry',
      'CATALOG_AUTHORITY',
      'registerAuthority',
      'resolveCatalogAuthority',
    ]) {
      expect(mod[forbidden], forbidden).toBeUndefined();
    }

    // The genuine catalog still confirms after every attempt.
    expect(confirmIngredientReview(catalog, review, selection).outcome).toBe('confirmed');
  });

  it('no reachable exported API can bless a fake catalog', async () => {
    const catalog = genuineCatalog();
    const { review, selection } = genuineReviewAndSelection(catalog);
    const fake = {
      metadata: () => catalog.metadata(),
      size: () => catalog.size(),
      search: () => Object.freeze([]),
      exactPhraseCount: () => 0,
      manualSearch: () => Object.freeze({ hits: Object.freeze([]), total: 0 }),
    };

    for (const name of MODULE_NAMES) {
      const mod = (await import(`../../src/core/nutritionV2/matching/${name}`)) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        if (typeof value !== 'function') continue;
        for (const args of [[fake], [fake, {}], [fake, {}, {}], [fake, {}, {}, {}]]) {
          try {
            (value as (...a: unknown[]) => unknown)(...args);
          } catch {
            /* arbitrary calls may throw; the invariant is that none blesses `fake` */
          }
        }
      }
    }

    expect(failureOf(confirmIngredientReview(fake, review, selection))).toBe('invalid_catalog');
    expect(confirmIngredientReview(catalog, review, selection).outcome).toBe('confirmed');
  });

  it('a review produced from a fake catalog cannot be confirmed against the fake', () => {
    const catalog = genuineCatalog();
    const fake = {
      metadata: () => catalog.metadata(),
      size: () => catalog.size(),
      search: (q: unknown, l: number) => catalog.search(q as never, l),
      exactPhraseCount: (q: unknown) => catalog.exactPhraseCount(q as never),
      manualSearch: (q: unknown, l: number) => catalog.manualSearch(q as never, l),
    };
    const review = reviewIngredient(fake, { name: 'milk' });
    if (review.outcome !== 'review_required') throw new Error('expected review_required');
    const selection = {
      kind: 'candidate' as const,
      fdc_id: review.candidates[0].fdc_id,
      review_digest: review.review_digest as string,
    };
    // The fake has no authority; the identical snapshot confirms only against
    // the genuine catalog instance.
    expect(failureOf(confirmIngredientReview(fake, review, selection))).toBe('invalid_catalog');
    expect(confirmIngredientReview(catalog, review, selection).outcome).toBe('confirmed');
  });
});
