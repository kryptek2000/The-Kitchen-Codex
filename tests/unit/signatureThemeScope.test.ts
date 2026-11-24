// @vitest-environment node
/**
 * Theme scope regression for the Signature Edition correction.
 *
 * The reported defect was not only a heading utility: the theme was rendered on
 * two different elements (`<html>` and the App root). A partial/external theme
 * application could therefore update the legacy class remaps (white cards)
 * while the App root's semantic variables stayed on the old dark palette. The
 * invariant is now a SINGLE document-level theme scope plus a semantic accent
 * contrast role for filled primary actions.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const app = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('single semantic theme scope', () => {
  it('applies data-theme only to the document element, not the App root', () => {
    expect(app).toContain("document.documentElement.setAttribute('data-theme', theme)");
    expect(app).not.toMatch(/data-theme=\{theme\}/);
  });

  it('applies the theme before paint and keeps native controls in the right mode', () => {
    expect(app).toContain('useLayoutEffect');
    expect(app).toContain("document.documentElement.style.colorScheme");
  });

  it('removes the hard-coded dark body class that fought the theme body rule', () => {
    expect(html).not.toMatch(/<body[^>]*bg-\[#0C0C0C\]/);
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*background-color:\s*var\(--bg-root/s);
  });

  it('defines a semantic accent contrast for every approved palette', () => {
    for (const id of ['obsidian', 'parchment', 'nordic', 'blood-moon']) {
      const scope = id === 'obsidian' ? ':root' : `[data-theme="${id}"]`;
      const start = css.indexOf(scope);
      expect(start, `theme scope ${scope}`).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf('}', start));
      expect(block, `--accent-contrast in ${scope}`).toContain('--accent-contrast');
    }
  });

  it('self-hosts the editorial and interface fonts and does not call Google Fonts', () => {
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
    expect(css).toContain("url('/fonts/fraunces-latin-roman.woff2')");
    expect(css).toContain("url('/fonts/plus-jakarta-sans-latin.woff2')");
  });

  it('keeps Recipe Detail editorial hero free of photographic overlay text', () => {
    const detail = fs.readFileSync(path.join(ROOT, 'src/components/RecipeDetailView.tsx'), 'utf8');
    expect(css).not.toMatch(/\.kc-photo-overlay-text/);
    expect(detail).not.toContain('kc-photo-overlay-text');
    expect(detail).toContain('id="recipe-rating"');
    expect(detail).toContain('text-3xl font-serif font-bold tracking-tight');
    expect(detail).toContain('Personal recipe rating');
    expect(detail).toContain('Personal rating. Not a community average.');
    expect(css).toMatch(/\[data-theme="parchment"\]/);
  });
});
