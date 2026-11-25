// @vitest-environment jsdom
/**
 * SHISO-C1.7 S6 — safe Markdown rendering.
 *
 * Assistant text is untrusted model output. These tests pin the no-HTML,
 * no-script, no-arbitrary-URL boundary and the small formatting allowlist.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ShisoMarkdown, safeShisoHref } from '../../src/components/ShisoMarkdown';

describe('safe SHISO Markdown', () => {
  it('renders a small, useful formatting allowlist', () => {
    const { container } = render(
      <ShisoMarkdown text={'**Bold** and *italic*.\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n`code`'} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(screen.getByTestId('shiso-markdown')).toBeTruthy();
  });

  it('never executes raw HTML and never renders scripts, frames or images', () => {
    const { container } = render(
      <ShisoMarkdown text={'<script>window.__shisoPwned = true</script>\n\n<img src=x onerror="window.__shisoPwned=true">\n\n<iframe src="https://example.com"></iframe>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|onload|javascript:/i);
    expect((window as unknown as { __shisoPwned?: boolean }).__shisoPwned).toBeUndefined();
  });

  it('makes unsafe URLs inert and keeps safe links explicit', () => {
    expect(safeShisoHref('javascript:alert(1)')).toBeNull();
    expect(safeShisoHref('data:text/html,hi')).toBeNull();
    expect(safeShisoHref('//evil.example')).toBeNull();
    expect(safeShisoHref('mailto:chef@example.com')).toBe('mailto:chef@example.com');
    expect(safeShisoHref('https://example.com/recipe')).toBe('https://example.com/recipe');
    expect(safeShisoHref('#notes')).toBe('#notes');

    const { container } = render(
      <ShisoMarkdown text={'[bad](javascript:alert(1)) and [good](https://example.com)'} />,
    );
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('https://example.com');
    expect(anchors[0].getAttribute('rel')).toContain('noopener');
    expect(container.textContent).toContain('bad');
  });
});
