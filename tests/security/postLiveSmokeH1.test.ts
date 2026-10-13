/**
 * The Kitchen Codex — POST-LIVE-SMOKE H1 regression tests.
 *
 * H1-A  Vite dev-server `.gz` delivery: the locked USDA shards ARE gzip ARTIFACTS,
 *       not gzip transport encodings. Vite's dev static server labels them
 *       `Content-Encoding: gzip`, which makes the browser transparently decompress
 *       them, so JavaScript received decompressed JSON and the authenticated
 *       exact-length/digest verification correctly failed closed.
 * H1-B  Egg food-authority reconciliation: the live smoke reported the egg as
 *       "offered for review, not auto-accepted". That wording was WRONG.
 *
 * These are OFFLINE and hermetic. No provider, no network, no browser.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveLockedUsdaArtifact,
  isViteModuleTransformRequest,
  usdaBundleDevAssetMiddleware,
  USDA_BUNDLE_PUBLIC_PREFIX,
} from '../../server/usdaBundleDevAssets.js';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import {
  adaptRecipe,
  analyzeRecipe,
  buildReviewRows,
  type AdvancedNutritionSession,
} from '../../src/core/nutritionV2/phase4';
import { resolveFoodsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiResolve';
import type { AiResolutionSuggestion } from '../../src/core/nutritionV2/aiResolution';
import { selectAutomaticMatch, selectBestEffortMatch } from '../../src/core/nutritionV2/matching/confidence';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda',
  USDA_BUNDLE_RELEASE_LOCK.bundle_release,
);

const LOCKED: ReadonlyArray<{ filename: string; bytes: number; sha256: string }> = [
  {
    filename: USDA_BUNDLE_RELEASE_LOCK.artifact.filename,
    bytes: USDA_BUNDLE_RELEASE_LOCK.artifact.bytes,
    sha256: USDA_BUNDLE_RELEASE_LOCK.artifact.sha256,
  },
  {
    filename: USDA_BUNDLE_RELEASE_LOCK.manifest.filename,
    bytes: USDA_BUNDLE_RELEASE_LOCK.manifest.bytes,
    sha256: USDA_BUNDLE_RELEASE_LOCK.manifest.sha256,
  },
  ...USDA_BUNDLE_RELEASE_LOCK.shards.map((s) => ({
    filename: s.filename,
    bytes: s.compressed_bytes,
    sha256: s.compressed_sha256,
  })),
];

/** Builds an ingredient exactly the way the application shell does, so the
 *  authenticated original-text fingerprint is populated (a bare `{name}` leaves
 *  `ingredient.original` empty and every AI binding fails closed by design). */
function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

/** The exact fixture from the successful live smoke. */
const LIVE_SMOKE_LINES = [
  '4 eggs, separated',
  '1 cup whole milk',
  '2 cups all-purpose flour',
  '6 tbsp unsalted butter',
  '1 tsp sea salt',
] as const;

// ===========================================================================
// H1-A — the affected set is the five LOCKED artifacts and nothing else
// ===========================================================================

describe('H1-A — only the exact locked USDA artifacts are affected', () => {
  it('the lock resolves to exactly five artifacts', () => {
    expect(LOCKED).toHaveLength(5);
    expect(new Set(LOCKED.map((e) => e.filename)).size).toBe(5);
  });

  it('resolves all five locked artifacts', () => {
    for (const entry of LOCKED) {
      const resolved = resolveLockedUsdaArtifact(USDA_BUNDLE_PUBLIC_PREFIX + entry.filename);
      expect(resolved, entry.filename).not.toBeNull();
      expect(resolved!.filename).toBe(entry.filename);
      expect(resolved!.mediaType).toBe(
        entry.filename.endsWith('.gz') ? 'application/gzip' : 'application/json',
      );
    }
  });

  it('refuses traversal, prefixes, sibling files and foreign directories', () => {
    const rejected: unknown[] = [
      USDA_BUNDLE_PUBLIC_PREFIX + '../package.json',
      USDA_BUNDLE_PUBLIC_PREFIX + 'records.foundation.json.gz/../../package.json',
      USDA_BUNDLE_PUBLIC_PREFIX + '%2e%2e%2fpackage.json',
      USDA_BUNDLE_PUBLIC_PREFIX + 'records.foundation.json.gz%00',
      '/data/advanced-nutrition/usda/some_other_bundle/records.foundation.json.gz',
      '/etc/passwd',
      USDA_BUNDLE_PUBLIC_PREFIX,
      USDA_BUNDLE_PUBLIC_PREFIX + 'records.foundation.json.gz.bak',
      USDA_BUNDLE_PUBLIC_PREFIX + 'RECORDS.FOUNDATION.JSON.GZ',
      USDA_BUNDLE_PUBLIC_PREFIX + 'notes.md',
      '/public/unrelated-file.gz',
      '',
      null,
      undefined,
      42,
    ];
    for (const candidate of rejected) {
      expect(resolveLockedUsdaArtifact(candidate as never), String(candidate)).toBeNull();
    }
  });

  it('identifies Vite module transforms and nothing else', () => {
    expect(isViteModuleTransformRequest(`${USDA_BUNDLE_PUBLIC_PREFIX}records.foundation.json.gz?import&url&no-inline`)).toBe(true);
    expect(isViteModuleTransformRequest(`${USDA_BUNDLE_PUBLIC_PREFIX}records.foundation.json.gz?url`)).toBe(true);
    expect(isViteModuleTransformRequest(`${USDA_BUNDLE_PUBLIC_PREFIX}records.foundation.json.gz?raw`)).toBe(true);
    // The browser's own raw delivery carries only `?no-inline`.
    expect(isViteModuleTransformRequest(`${USDA_BUNDLE_PUBLIC_PREFIX}records.foundation.json.gz?no-inline`)).toBe(false);
    expect(isViteModuleTransformRequest(`${USDA_BUNDLE_PUBLIC_PREFIX}records.foundation.json.gz`)).toBe(false);
    expect(isViteModuleTransformRequest('/anything')).toBe(false);
  });

  it('holds the Phase 9A no-disk-access invariant (no node:fs in server/)', () => {
    // Phase 9A pinned that the app has NO disk read/write capability in
    // production code. This repair must never reintroduce one.
    const source = readFileSync(join(__dirname, '../../server/usdaBundleDevAssets.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+["']node:fs["']/);
    expect(source).not.toMatch(/require\(\s*["']fs["']\s*\)/);
    expect(source).not.toContain('readFileSync');
    expect(source).not.toContain('writeFile');
    expect(source).not.toContain('createReadStream');
  });
});

// ===========================================================================
// H1-A — the middleware withholds Content-Encoding and passes through otherwise
// ===========================================================================

type Stub = { headers: Record<string, string>; nextCalled: boolean };

function invoke(url: string, method = 'GET'): Stub {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  const headers: Record<string, string> = {};
  const stub: Stub = { headers, nextCalled: false };
  const res = {
    setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); return this; },
    removeHeader(name: string) { delete headers[name.toLowerCase()]; return this; },
  };
  usdaBundleDevAssetMiddleware()(
    { method, path: pathname, originalUrl: url } as never,
    res as never,
    () => { stub.nextCalled = true; },
  );
  // Emulate Vite/Node writing the response headers AFTER the middleware ran.
  const pending = res.setHeader;
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', '53877');
  res.setHeader = pending;
  return stub;
}

describe('H1-A — Content-Encoding is withheld for locked artifacts only', () => {
  it('drops Content-Encoding and states the truthful media type', () => {
    for (const entry of LOCKED) {
      const stub = invoke(USDA_BUNDLE_PUBLIC_PREFIX + entry.filename + '?no-inline');
      expect(stub.nextCalled, entry.filename).toBe(true);
      // THE ORIGINAL BUG PIN: a surviving `Content-Encoding: gzip` makes the UA
      // decompress the artifact and hands JS decompressed JSON.
      expect(stub.headers['content-encoding'], entry.filename).toBeUndefined();
      expect(stub.headers['content-type'], entry.filename).toBe(
        entry.filename.endsWith('.gz') ? 'application/gzip' : 'application/json',
      );
      // Vite's own length header is left alone: the bytes are unchanged.
      expect(stub.headers['content-length'], entry.filename).toBe('53877');
    }
  });

  it('does not disturb unrelated responses, including OTHER gzip files', () => {
    for (const url of [
      '/public/some-other-file.gz?no-inline',
      '/data/advanced-nutrition/usda/other_bundle/records.foundation.json.gz?no-inline',
      '/src/main.tsx',
      '/api/health',
      '/index.html',
      USDA_BUNDLE_PUBLIC_PREFIX + 'records.foundation.json.gz.backup',
    ]) {
      const stub = invoke(url);
      expect(stub.nextCalled, url).toBe(true);
      // Untouched: the middleware never even patched setHeader.
      expect(stub.headers['content-encoding'], url).toBe('gzip');
      expect(stub.headers['content-type'], url).toBe('application/json');
    }
  });

  it('never interferes with Vite module transforms', () => {
    for (const marker of ['import&url&no-inline', 'url&no-inline', 'raw']) {
      const stub = invoke(`${USDA_BUNDLE_PUBLIC_PREFIX}records.foundation.json.gz?${marker}`);
      expect(stub.nextCalled, marker).toBe(true);
      // A dev app that cannot load its modules cannot boot at all.
      expect(stub.headers['content-encoding'], marker).toBe('gzip');
    }
  });

  it('does not interfere with non-GET methods', () => {
    const stub = invoke(USDA_BUNDLE_PUBLIC_PREFIX + 'artifact.json?no-inline', 'POST');
    expect(stub.headers['content-encoding']).toBe('gzip');
  });

  it('on-disk bytes still match the lock exactly (delivery changed, data did not)', () => {
    for (const entry of LOCKED) {
      const bytes = readFileSync(join(BUNDLE_DIR, entry.filename));
      expect(bytes.length, entry.filename).toBe(entry.bytes);
    }
    for (const shard of USDA_BUNDLE_RELEASE_LOCK.shards) {
      const bytes = readFileSync(join(BUNDLE_DIR, shard.filename));
      expect(bytes[0], shard.filename).toBe(0x1f);
      expect(bytes[1], shard.filename).toBe(0x8b);
      expect(bytes[2], shard.filename).toBe(0x08);
    }
  });
});

// ===========================================================================
// H1-B — egg food authority, reconciled against the real pinned catalog
// ===========================================================================

describe('H1-B — the egg food identity was DETERMINISTICALLY ACCEPTED, not merely offered', () => {
  let session: AdvancedNutritionSession;

  beforeAll(async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    session = result.session as AdvancedNutritionSession;
  }, 240000);

  function fixture() {
    const recipe = adaptRecipe({
      title: 'SHISO Live Smoke — Separated Egg Batter',
      servings: 4,
      ingredients: LIVE_SMOKE_LINES.map(structuredLine),
    } as never) as never as { recipe: { adapted: Array<{ line_ref: string }> } };
    const adapted = recipe.recipe.adapted;
    return { adapted, rows: buildReviewRows(session as never, adapted as never) };
  }

  function wholeEggSuggestion(lineRef: string): AiResolutionSuggestion {
    return {
      line_ref: lineRef,
      interpreted_food_name: 'whole egg',
      suggested_usda_queries: [],
      normalized_food_query: 'whole egg',
    } as unknown as AiResolutionSuggestion;
  }

  it('the advisory wording resolves to the single pinned whole-egg record', () => {
    const review = session.reviewIngredient({ name: 'whole egg' }) as never as {
      outcome: string;
      candidates: Array<{ fdc_id: number; description: string; record_digest: string }>;
    };
    expect(review.outcome).not.toBe('invalid');
    expect(review.outcome).not.toBe('unmatched');
    expect(selectBestEffortMatch(review as never)?.fdc_id).toBe(2707152);
    expect(selectAutomaticMatch(review as never)?.fdc_id).toBe(2707152);
    const record = review.candidates.find((c) => c.fdc_id === 2707152);
    expect(record).toBeDefined();
    expect(record!.description).toBe('Egg, whole, raw');
    expect(record!.record_digest.length).toBeGreaterThan(0);
  });

  it('the candidate carries auto:true AND aiAccepted:true (deterministic acceptance)', () => {
    const { adapted, rows } = fixture();
    analyzeRecipe(session as never, adapted as never, 4);
    const outcome = resolveFoodsFromAiSuggestions({
      session, rows, suggestions: [wholeEggSuggestion(adapted[0].line_ref)], adapted,
    } as never);

    expect(outcome.candidates).toHaveLength(1);
    const candidate = outcome.candidates[0] as unknown as {
      fdc_id: number;
      description: string;
      auto: boolean;
      choice: { aiAssisted?: boolean; aiAccepted?: boolean; record_digest: string };
    };
    expect(candidate.fdc_id).toBe(2707152);
    expect(candidate.description).toBe('Egg, whole, raw');
    // THE CORRECTED CLASSIFICATION: AI-assisted DETERMINISTIC acceptance, made
    // without any user confirmation step.
    expect(candidate.auto).toBe(true);
    expect(candidate.choice.aiAccepted).toBe(true);
    expect(candidate.choice.aiAssisted).toBe(true);
    expect(outcome.auto_count).toBe(1);
    // The identity WAS accepted: nothing is left unresolved for this line.
    expect(outcome.unresolved).toEqual([]);
  });

  it('the identity is accepted but NO grams are invented (record has no portions)', () => {
    const review = session.reviewIngredient({ name: 'whole egg' }) as never as {
      candidates: Array<{ fdc_id: number; portions?: unknown[] }>;
    };
    const record = review.candidates.find((c) => c.fdc_id === 2707152);
    // Precisely why the row remains `needs_amount`: there is no validated portion
    // to derive a gram mass from. Correct behaviour, not a failure.
    expect((record!.portions ?? []).length).toBe(0);
  });

  it('aiAccepted is EMITTED CONDITIONALLY on deterministic automatic acceptance', () => {
    // The offered-only branch is unreachable with the CURRENT pinned catalog
    // (every matchable query resolves above threshold), so this invariant is
    // pinned structurally. Without it, turning
    //   ...(autoAccepted ? { aiAccepted: true } : {})
    // into an unconditional `aiAccepted: true` would silently erase the
    // distinction between "deterministically accepted" and "awaiting explicit
    // user confirmation" — the exact confusion this reconciliation resolved.
    const src = readFileSync(
      join(__dirname, '../../src/core/nutritionV2/phase4/aiResolve.ts'),
      'utf8',
    );
    expect(src).toContain('...(autoAccepted ? { aiAccepted: true } : {})');
    expect(src.match(/aiAccepted:\s*true/g) ?? []).toHaveLength(1);
    expect(src).toContain('const autoAccepted = automatic !== undefined;');
  });

  it('unusable advisory wording fabricates no candidate at all', () => {
    const { adapted, rows } = fixture();
    const suggestion = {
      line_ref: adapted[0].line_ref,
      interpreted_food_name: 'a food that will not match anything at all',
      suggested_usda_queries: [],
      normalized_food_query: 'a food that will not match anything at all',
    } as unknown as AiResolutionSuggestion;
    const outcome = resolveFoodsFromAiSuggestions({
      session, rows, suggestions: [suggestion], adapted,
    } as never);
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.unresolved).toEqual([suggestion.line_ref]);
  });
});
