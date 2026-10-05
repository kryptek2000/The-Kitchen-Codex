/**
 * The Kitchen Codex — Advanced Nutrition AI-6A recon CORPUS regression.
 *
 * Fast, bundle-free proof that the AI-6A reconnaissance corpus is honest as a
 * MEASUREMENT instrument:
 *
 *   - no duplicate authored line can inflate the denominator;
 *   - the combined corpus is large enough to be worth acting on;
 *   - every required coverage family is materially represented;
 *   - the historical 97 / legacy 91 denominators are preserved EXACTLY;
 *   - no line smuggles in invented identity truth;
 *   - no recon module is reachable from production.
 *
 * AI-6A is measurement-only: nothing here changes a nutrition truth.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  AI6A_HISTORICAL_SUBSET,
  AI6A_INTELLIGENCE_CORPUS,
  AI6A_LEGACY_SUBSET,
} from '../../tests/fixtures/advancedNutritionAi6aIntelligenceCorpus';
import {
  IDENTITY_SAFETY_REGRESSION_LINES,
} from '../../tests/fixtures/advancedNutritionIdentityCorpus';
import {
  RESOLUTION_COVERAGE_CORPUS,
} from '../../tests/fixtures/advancedNutritionResolutionCorpus';
import {
  HISTORICAL_RESOLVED,
  HISTORICAL_TOTAL,
  LEGACY_EXCLUDED_LINES,
  LEGACY_RESOLVED,
  LEGACY_TOTAL,
  AI6A_COVERAGE_FAMILIES,
  isAi6aCoverageFamily,
  type Ai6aCoverageFamily,
} from '../../scripts/nutritionIntelligence/taxonomy';

const REPO_ROOT = join(import.meta.dirname, '../..');

describe('AI-6A — the recon denominator cannot be inflated', () => {
  it('has no duplicate authored line', () => {
    // Mutation-sensitive: a duplicate silently added to raise the denominator.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of AI6A_INTELLIGENCE_CORPUS) {
      if (seen.has(entry.line)) duplicates.push(entry.line);
      seen.add(entry.line);
    }
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(AI6A_INTELLIGENCE_CORPUS.length);
  });

  it('is a strict superset of the historical benchmark, line for line', () => {
    const historical = new Set(RESOLUTION_COVERAGE_CORPUS.map((entry) => entry.line));
    for (const line of historical) {
      expect(AI6A_HISTORICAL_SUBSET.map((entry) => entry.line)).toContain(line);
    }
  });

  it('reaches at least 160 unique lines and declares a unique count', () => {
    expect(AI6A_INTELLIGENCE_CORPUS.length).toBeGreaterThanOrEqual(160);
    expect(new Set(AI6A_INTELLIGENCE_CORPUS.map((e) => e.line)).size).toBe(
      AI6A_INTELLIGENCE_CORPUS.length
    );
  });

  it('records provenance for every line and keeps the three populations apart', () => {
    const sources = new Set(AI6A_INTELLIGENCE_CORPUS.map((entry) => entry.source));
    expect([...sources].sort()).toEqual(['historical', 'semantic', 'supplemental']);
    for (const entry of AI6A_INTELLIGENCE_CORPUS) {
      expect(['historical', 'semantic', 'supplemental']).toContain(entry.source);
      expect(entry.line.length).toBeGreaterThan(0);
      expect(entry.focus.length).toBeGreaterThan(0);
    }
  });
});

describe('AI-6A — the historical denominators are preserved exactly', () => {
  it('keeps the canonical 97-line denominator', () => {
    expect(HISTORICAL_TOTAL).toBe(97);
    expect(HISTORICAL_RESOLVED).toBe(46);
    expect(AI6A_HISTORICAL_SUBSET.length).toBe(HISTORICAL_TOTAL);
  });

  it('keeps the legacy 91-line denominator and its 42 resolved', () => {
    expect(LEGACY_TOTAL).toBe(91);
    expect(LEGACY_RESOLVED).toBe(42);
    expect(AI6A_LEGACY_SUBSET.length).toBe(LEGACY_TOTAL);
  });

  it('makes the 97 -> 91 split explicit and self-consistent', () => {
    // The six post-Phase-7 nutrient-annotation lines are the whole difference.
    expect(LEGACY_EXCLUDED_LINES.size).toBe(HISTORICAL_TOTAL - LEGACY_TOTAL);
    const historicalLines = new Set(AI6A_HISTORICAL_SUBSET.map((entry) => entry.line));
    for (const line of LEGACY_EXCLUDED_LINES) {
      expect(historicalLines.has(line)).toBe(true);
      expect(AI6A_LEGACY_SUBSET.map((entry) => entry.line)).not.toContain(line);
    }
    const legacyLines = new Set(AI6A_LEGACY_SUBSET.map((entry) => entry.line));
    for (const entry of AI6A_HISTORICAL_SUBSET) {
      expect(legacyLines.has(entry.line)).toBe(!LEGACY_EXCLUDED_LINES.has(entry.line));
    }
  });
});

describe('AI-6A — coverage families are materially represented', () => {
  it('declares a closed family vocabulary', () => {
    expect(new Set(AI6A_COVERAGE_FAMILIES).size).toBe(AI6A_COVERAGE_FAMILIES.length);
  });

  it('represents every required coverage family', () => {
    const covered = new Set<Ai6aCoverageFamily>();
    for (const entry of AI6A_INTELLIGENCE_CORPUS) {
      for (const family of entry.families) covered.add(family);
    }
    const missing = AI6A_COVERAGE_FAMILIES.filter((family) => !covered.has(family));
    expect(missing).toEqual([]);
  });

  it('gives every line at least one in-vocabulary family', () => {
    for (const entry of AI6A_INTELLIGENCE_CORPUS) {
      expect(entry.families.length).toBeGreaterThan(0);
      for (const family of entry.families) expect(isAi6aCoverageFamily(family)).toBe(true);
    }
  });

  it('includes the product-realism probes AI-6A was asked to cover', () => {
    const lines = AI6A_INTELLIGENCE_CORPUS.map((entry) => entry.line);
    const required = [
      // pickle slices / count
      '20 slices dill pickles',
      '1/2 cup pickle slices',
      // butter by tablespoon / stick / count-like household wording
      '2 tbsp butter',
      '1 stick butter',
      '4 tbsp (1/2 stick) butter',
      // garlic cloves, both word orders
      '3 cloves garlic, minced',
      '4 cloves garlic',
      // onions with size descriptors
      '2 large onions',
      '1 large white onion',
      // bacon / bread slices
      '4 slices bacon',
      '3 slices sourdough bread',
      // tomato sauce + diced tomato cans
      '3 cans tomato sauce',
      '1 can diced tomatoes',
      // jars / packages
      '1 jar marinara sauce',
      '1 package cream cheese',
      // seasoning blends and commercial/branded wording
      '1 packet ranch seasoning mix',
      '1 tbsp Mrs. Dash',
      '1 packet Lipton onion soup mix',
    ];
    for (const line of required) expect(lines).toContain(line);
  });

  it('includes the AI-6A-R1 adversarial probe pairs', () => {
    const lines = AI6A_INTELLIGENCE_CORPUS.map((entry) => entry.line);
    // brand token `Dash` vs the genuine quantity phrase `a dash of`
    expect(lines).toContain('1 tbsp Mrs. Dash');
    expect(lines).toContain('a dash of pepper');
    // `whole` as a count descriptor vs `whole` as a food form
    expect(lines).toContain('1 whole chicken');
    expect(lines).toContain('2 whole lemons');
    expect(lines).toContain('whole milk');
    expect(lines).toContain('2 slices whole wheat bread');
  });

  it('includes at least one branded/commercial seasoning example', () => {
    const branded = AI6A_INTELLIGENCE_CORPUS.filter((entry) =>
      entry.families.includes('branded_commercial')
    );
    expect(branded.length).toBeGreaterThan(0);
    expect(
      branded.some((entry) => /lipton|mrs|knorr|heinz|prego|barilla/i.test(entry.line))
    ).toBe(true);
  });
});

describe('AI-6A — no line smuggles in invented identity truth', () => {
  it('only sources identity expectations from the checked-in identity corpus', () => {
    // A supplemental line carries whatever `IDENTITY_SAFETY_LINES` says about it
    // and nothing else, so `verified_correct`/`verified_unsafe` can only ever come
    // from knowledge that is already checked in.
    for (const entry of AI6A_INTELLIGENCE_CORPUS) {
      if (entry.identity === undefined) continue;
      if (entry.source === 'historical' || entry.source === 'semantic') continue;
      // The only supplemental lines allowed an expectation are ones whose exact
      // authored text also appears verbatim in the identity corpus.
      expect(entry.identity.line).toBe(entry.line);
    }
  });

  it('only reuses identity knowledge verbatim, never hand-authors FDC truth', () => {
    // A line may carry an expectation ONLY when the checked-in identity corpus
    // says something about that exact authored text. Nothing is invented for a
    // supplemental probe, so an unlabeled line can only ever be `unverified`.
    for (const entry of AI6A_INTELLIGENCE_CORPUS) {
      if (entry.identity === undefined) continue;
      expect(entry.identity.line).toBe(entry.line);
    }
    const labeled = AI6A_INTELLIGENCE_CORPUS.filter((entry) => entry.identity !== undefined);
    const supplementalLabeled = labeled.filter((entry) => entry.source === 'supplemental');
    // Supplemental lines may only reuse a REGRESSION-line expectation whose
    // authored text happens to coincide; none declares its own FDC truth.
    for (const entry of supplementalLabeled) {
      const fromRegression = IDENTITY_SAFETY_REGRESSION_LINES.some(
        (candidate) => candidate.line === entry.line
      );
      expect(fromRegression).toBe(true);
    }
    expect(supplementalLabeled.length).toBeLessThan(labeled.length);
  });

  it('does not mark any current failure as expected-correct behavior', () => {
    // There is deliberately no "knownIssue means fine" flag in AI-6A. A known
    // issue is still a measured failure; only the historical benchmark's own
    // denominators are pinned, and those are asserted elsewhere.
    for (const entry of AI6A_INTELLIGENCE_CORPUS) {
      expect(Object.keys(entry)).toEqual([
        'line',
        'source',
        'focus',
        'families',
        'identity',
      ]);
    }
  });
});

describe('AI-6A — the recon is unreachable from production', () => {
  const productionRoots = ['src', 'server', 'plugin'];

  function productionFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) productionFiles(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('is imported by no production module', () => {
    const forbidden = [
      'nutritionIntelligence',
      'benchmark_nutrition_intelligence',
      'advancedNutritionAi6aIntelligenceCorpus',
    ];
    const offenders: string[] = [];
    for (const root of productionRoots) {
      for (const file of productionFiles(join(REPO_ROOT, root))) {
        const source = readFileSync(file, 'utf8');
        for (const token of forbidden) {
          if (source.includes(token)) offenders.push(`${file}:${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is absent from the plugin bundle source', () => {
    const source = readFileSync(join(REPO_ROOT, 'plugin/main.js'), 'utf8').toLowerCase();
    // The built plugin must not carry the recon schema or its benchmark tool.
    expect(source.includes('nutrition_ai6a_intelligence_recon_v1')).toBe(false);
  });
});