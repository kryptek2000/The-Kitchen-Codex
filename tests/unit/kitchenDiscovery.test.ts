import { describe, it, expect } from 'vitest';
import { sanitizeKitchenIntent } from '../../src/utils/kitchenIntent';
import { prepareKitchenIntentForExecution } from '../../src/utils/kitchenIntentPolicy';
import type { PreparedKitchenExecution } from '../../src/utils/kitchenIntentPolicy';
import {
  MAX_WEB_RESULTS,
  WEAK_LOCAL_RESULT_THRESHOLD,
  sanitizeWebResult,
  sanitizeWebResults,
  isKitchenDiscoveryResponse,
  webDiscoveryUnavailable,
  getDiscoveryAuthorization,
  shouldRunLocalRetrieval,
  isWeakLocalResult,
  canOfferWebDiscovery,
  toWebDiscoveryIntent,
  buildKitchenDiscoveryRequest,
  extractWebResultsFromGrounding,
  buildWebImportHandoff,
} from '../../src/utils/kitchenDiscovery';

function prep(raw: Record<string, unknown>, trusted: Record<string, unknown> = {}): PreparedKitchenExecution {
  const intent = sanitizeKitchenIntent(raw);
  if (!intent) throw new Error('expected a valid sanitized intent');
  return prepareKitchenIntentForExecution(intent, trusted);
}

function okPrep(p: PreparedKitchenExecution) {
  if (!p.ok) throw new Error('expected ok preparation');
  return p;
}

const VAULT = { version: 1, intent: 'find_recipes', source: 'vault', constraints: { includeIngredients: ['chicken'] } };
const V_TW = { version: 1, intent: 'find_recipes', source: 'vault_then_web', constraints: { includeIngredients: ['fennel'] } };
const WEB = { version: 1, intent: 'find_recipes', source: 'web', constraints: { includeIngredients: ['gumbo'] } };

describe('A/B/C/D/E/F: source policy + weak-result offer', () => {
  it('A: source=vault -> discovery forbidden, local retrieval runs, never offers', () => {
    const p = okPrep(prep(VAULT));
    expect(getDiscoveryAuthorization(p)).toBe('forbidden');
    expect(shouldRunLocalRetrieval(p)).toBe(true);
    expect(canOfferWebDiscovery(p, 0)).toBe(false);
  });

  it('B: vault_then_web weak -> offer available but discovery does NOT auto-execute', () => {
    const p = okPrep(prep(V_TW));
    expect(p.sourcePolicy.webDiscoveryPermission).toBe('offer_if_weak');
    expect(canOfferWebDiscovery(p, 0)).toBe(true);
    // requires_escalation (not enabled) proves discovery is offer-only here.
    expect(getDiscoveryAuthorization(p)).toBe('requires_escalation');
  });

  it('C: vault_then_web + explicit escalation -> discovery becomes enabled', () => {
    const p = okPrep(prep(V_TW));
    const derived = toWebDiscoveryIntent(p.intent);
    expect(derived.source).toBe('web');
    const derivedPrep = prepareKitchenIntentForExecution(derived, {});
    expect(derivedPrep.ok).toBe(true);
    expect(getDiscoveryAuthorization(okPrep(derivedPrep))).toBe('enabled');
  });

  it('D: source=web -> discovery allowed immediately, local retrieval skipped', () => {
    const p = okPrep(prep(WEB));
    expect(getDiscoveryAuthorization(p)).toBe('enabled');
    expect(shouldRunLocalRetrieval(p)).toBe(false);
  });

  it('E: vault_then_web + strong local results -> no offer', () => {
    const p = okPrep(prep(V_TW));
    expect(canOfferWebDiscovery(p, 3)).toBe(false);
    expect(canOfferWebDiscovery(p, 5)).toBe(false);
  });

  it('F: weak-result threshold is deterministic', () => {
    expect(isWeakLocalResult(0)).toBe(true);
    expect(isWeakLocalResult(1)).toBe(true);
    expect(isWeakLocalResult(2)).toBe(true);
    expect(isWeakLocalResult(3)).toBe(false);
    expect(isWeakLocalResult(4)).toBe(false);
    expect(WEAK_LOCAL_RESULT_THRESHOLD).toBe(2);
  });
});

describe('G/H/I/J/K/L/M/N/O/P/Q: web result sanitization', () => {
  it('G: valid http URL survives', () => {
    const w = sanitizeWebResult({ url: 'http://example.com/recipe', title: 'A' });
    expect(w).toBeDefined();
    expect(w!.url).toBe('http://example.com/recipe');
  });

  it('H: valid https URL survives', () => {
    const w = sanitizeWebResult({ url: 'https://example.com/recipe', title: 'A' });
    expect(w).toBeDefined();
    expect(w!.url).toBe('https://example.com/recipe');
  });

  it('I: javascript: is dropped', () => {
    expect(sanitizeWebResult({ url: 'javascript:alert(1)' })).toBeUndefined();
  });

  it('J: data: is dropped', () => {
    expect(sanitizeWebResult({ url: 'data:text/html;base64,xx' })).toBeUndefined();
  });

  it('K: file: is dropped', () => {
    expect(sanitizeWebResult({ url: 'file:///etc/passwd' })).toBeUndefined();
  });

  it('L: duplicate normalized URL is deduped', () => {
    const out = sanitizeWebResults([
      { url: 'http://a.com/x', title: '1' },
      { url: 'http://a.com/x', title: '2' },
      { url: 'http://b.com/x', title: '3' },
    ]);
    expect(out.map((w) => w.url)).toEqual(['http://a.com/x', 'http://b.com/x']);
  });

  it('M: oversized title/snippet are capped', () => {
    const w = sanitizeWebResult({ url: 'http://a.com', title: 't'.repeat(500), snippet: 's'.repeat(900) });
    expect(w!.title.length).toBeLessThanOrEqual(160);
    expect(w!.snippet!.length).toBeLessThanOrEqual(300);
  });

  it('N/O: unknown fields stripped, no local identity ever present', () => {
    const w = sanitizeWebResult({
      url: 'http://a.com',
      title: 'T',
      recipeId: 'local-1',
      localId: 'local-2',
      filePath: '/path/to.md',
      notes: 'secret',
      rawMarkdown: '# markdown',
      frontmatter: { x: 1 },
    });
    expect(w).toBeDefined();
    const keys = Object.keys(w as unknown as Record<string, unknown>);
    expect(keys).not.toContain('recipeId');
    expect(keys).not.toContain('localId');
    expect(keys).not.toContain('filePath');
    expect(keys).not.toContain('notes');
    expect(keys).not.toContain('rawMarkdown');
    expect(keys).not.toContain('frontmatter');
  });

  it('P: more than MAX_WEB_RESULTS is capped', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ url: `http://site.com/r${i}`, title: `R${i}` }));
    const out = sanitizeWebResults(many, { maxResults: MAX_WEB_RESULTS });
    expect(out.length).toBeLessThanOrEqual(MAX_WEB_RESULTS);
    expect(out.length).toBe(MAX_WEB_RESULTS);
  });

  it('Q: invalid imageUrl is dropped', () => {
    const w = sanitizeWebResult({ url: 'http://a.com', imageUrl: 'javascript:alert(1)' });
    expect(w).toBeDefined();
    expect((w as unknown as Record<string, unknown>)['imageUrl']).toBeUndefined();
  });
});

describe('no fabricated URLs', () => {
  it('real grounding chunk URL survives', () => {
    const out = sanitizeWebResults(
      extractWebResultsFromGrounding({ groundingMetadata: { groundingChunks: [{ web: { uri: 'http://real.com/recipe', title: 'Real', domain: 'real.com' } }] } })
    );
    expect(out.length).toBe(1);
    expect(out[0].url).toBe('http://real.com/recipe');
    expect(out[0].sourceName).toBe('real.com');
  });

  it('model-text-only (no grounding) -> no results', () => {
    const out = sanitizeWebResults(extractWebResultsFromGrounding({ text: 'see http://faked.com/recipe for details' }));
    expect(out).toEqual([]);
  });

  it('malformed/non-http grounding URL is dropped by the sanitizer', () => {
    const out = sanitizeWebResults(
      extractWebResultsFromGrounding({ groundingMetadata: { groundingChunks: [{ web: { uri: 'javascript:alert(1)' } }] } })
    );
    expect(out).toEqual([]);
  });

  it('no provider response at all -> unavailable', () => {
    const res = webDiscoveryUnavailable();
    expect(res.ok).toBe(false);
    expect(res.source).toBe('web');
    expect(res.reason).toBe('unavailable');
    expect(res.results).toEqual([]);
  });
});

describe('discovery request builder', () => {
  it('derives a web intent, strips references and similarity id', () => {
    const intent = sanitizeKitchenIntent({
      version: 1,
      intent: 'similar_recipe',
      source: 'vault_then_web',
      constraints: { similarToRecipeId: 'model-guess', includeIngredients: ['gumbo'] },
      references: { currentRecipe: true },
      requiresClarification: false,
    })!;
    const req = buildKitchenDiscoveryRequest('Find a gumbo', intent, 3);
    expect(req.question).toBe('Find a gumbo');
    expect(req.maxResults).toBe(3);
    expect(req.intent.source).toBe('web');
    expect(req.intent.references).toBeUndefined();
    expect(req.intent.constraints.similarToRecipeId).toBeUndefined();
    expect(req.intent.constraints.includeIngredients).toEqual(['gumbo']);
  });

  it('question and maxResults are bounded', () => {
    const intent = sanitizeKitchenIntent(WEB)!;
    const req = buildKitchenDiscoveryRequest('q'.repeat(600), intent, 999);
    expect(req.question.length).toBeLessThanOrEqual(500);
    expect(req.maxResults).toBe(MAX_WEB_RESULTS);
    const low = buildKitchenDiscoveryRequest('q', intent, 0);
    expect(low.maxResults).toBe(1);
  });

  it('is JSON-serializable and deterministic', () => {
    const intent = sanitizeKitchenIntent(WEB)!;
    const a = JSON.stringify(buildKitchenDiscoveryRequest('q', intent, 4));
    const b = JSON.stringify(buildKitchenDiscoveryRequest('q', intent, 4));
    expect(a).toBe(b);
  });
});

describe('discovery response validator', () => {
  it('accepts a valid response', () => {
    expect(isKitchenDiscoveryResponse({ ok: true, source: 'web', results: [] })).toBe(true);
    expect(isKitchenDiscoveryResponse({ ok: false, source: 'web', results: [], reason: 'unavailable' })).toBe(false);
  });

  it('rejects malformed shapes', () => {
    expect(isKitchenDiscoveryResponse(null)).toBe(false);
    expect(isKitchenDiscoveryResponse('x')).toBe(false);
    expect(isKitchenDiscoveryResponse({ ok: true, results: [] })).toBe(false);
    expect(isKitchenDiscoveryResponse({ ok: true, source: 'vault', results: [] })).toBe(false);
    expect(isKitchenDiscoveryResponse({ ok: true, source: 'web', results: 'nope' })).toBe(false);
  });
});

describe('V/W/X: source-separated UI behavior logic', () => {
  it('V: explicit web request does not run local retrieval', () => {
    expect(shouldRunLocalRetrieval(okPrep(prep(WEB)))).toBe(false);
  });

  it('W: vault_then_web weak results are offer-only (no auto-discover)', () => {
    const p = okPrep(prep(V_TW));
    expect(shouldRunLocalRetrieval(p)).toBe(true); // local still runs
    expect(getDiscoveryAuthorization(p)).toBe('requires_escalation'); // discover not auto-enabled
  });

  it('X: user escalation derives an enabled web request (fires discover once)', () => {
    const p = okPrep(prep(V_TW));
    const derived = toWebDiscoveryIntent(p.intent);
    const derivedPrep = prepareKitchenIntentForExecution(derived, {});
    expect(getDiscoveryAuthorization(okPrep(derivedPrep))).toBe('enabled');
  });

  it('R/S/T: web results are a self-contained array, never merged into vault membership', () => {
    const web = sanitizeWebResults([{ url: 'http://a.com', title: 'A' }]);
    expect(Array.isArray(web)).toBe(true);
    expect(web.length).toBe(1);
    // A web result has no local recipe identity keys.
    for (const w of web) {
      const keys = Object.keys(w as unknown as Record<string, unknown>);
      for (const k of ['recipeId', 'recipeIdentity', 'localId', 'filePath']) {
        expect(keys).not.toContain(k);
      }
    }
  });
});

describe('handoff: buildWebImportHandoff', () => {
  it('A: valid result -> { sourceUrl, sourceTitle }', () => {
    const h = buildWebImportHandoff({ url: 'https://example.com/recipe', title: 'Gumbo' });
    expect(h).toEqual({ sourceUrl: 'https://example.com/recipe', sourceTitle: 'Gumbo' });
  });

  it('B: missing/invalid URL -> no handoff', () => {
    expect(buildWebImportHandoff({ title: 'No url' })).toBeUndefined();
    expect(buildWebImportHandoff(null)).toBeUndefined();
    expect(buildWebImportHandoff('bad')).toBeUndefined();
  });

  it('C: javascript / data / file URLs -> no handoff', () => {
    expect(buildWebImportHandoff({ url: 'javascript:alert(1)' })).toBeUndefined();
    expect(buildWebImportHandoff({ url: 'data:text/html,x' })).toBeUndefined();
    expect(buildWebImportHandoff({ url: 'file:///etc/passwd' })).toBeUndefined();
  });

  it('D/E: only sourceUrl + sourceTitle transfer; snippet/image/sourceName ignored', () => {
    const h = buildWebImportHandoff({
      url: 'https://example.com/recipe',
      title: 'Gumbo',
      snippet: 'a snippet',
      imageUrl: 'https://example.com/img.jpg',
      sourceName: 'Example',
      zebra: 'ignored',
    });
    expect(h).toEqual({ sourceUrl: 'https://example.com/recipe', sourceTitle: 'Gumbo' });
    expect(Object.keys(h as unknown as Record<string, unknown>)).toEqual(['sourceUrl', 'sourceTitle']);
  });

  it('F: webResultId / recipeId are never treated as recipe identity', () => {
    const h = buildWebImportHandoff({
      url: 'https://example.com/recipe',
      id: 'web-abc',
      recipeId: 'local-1',
      localId: 'local-2',
    });
    const keys = Object.keys(h as unknown as Record<string, unknown>);
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('recipeId');
    expect(keys).not.toContain('localId');
    expect(h!.sourceUrl).toBe('https://example.com/recipe');
  });

  it('G: sourceTitle is bounded', () => {
    const h = buildWebImportHandoff({ url: 'https://example.com/recipe', title: 't'.repeat(500) });
    expect(h!.sourceTitle!.length).toBeLessThanOrEqual(160);
  });

  it('is deterministic and pure (no mutation, stable)', () => {
    const input = { url: 'https://example.com/recipe', title: 'Gumbo' };
    const a = buildWebImportHandoff(input);
    const b = buildWebImportHandoff(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe('{"url":"https://example.com/recipe","title":"Gumbo"}');
  });
});
