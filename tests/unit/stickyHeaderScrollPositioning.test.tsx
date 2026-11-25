// @vitest-environment jsdom
/**
 * The Kitchen Codex — sticky header / scroll positioning regression tests.
 *
 * Covers the UD-2A.1B R-1 repair:
 *   - the vault header publishes its own sticky height as
 *     `--kc-sticky-header-h` on the root element (the single source of truth
 *     for scroll positioning), and publishes 0 when it is not sticky;
 *   - the published value is released on unmount so it cannot leak between
 *     app instances;
 *   - index.css consumes that value as `scroll-padding-top` on the scrolling
 *     element, which is the mechanism that keeps content scrolled into view
 *     BELOW the sticky header instead of behind it;
 *   - the header's sticky breakpoint behaviour is unchanged by the repair
 *     (`static` below 768px, `sticky` from 768px up).
 *
 * No nutrition/AI/server behaviour is exercised or asserted here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { render, cleanup } from '@testing-library/react';
import { VaultHeader } from '../../src/components/VaultHeader';

const CSS_PATH = path.resolve(process.cwd(), 'src/index.css');
const css = fs.readFileSync(CSS_PATH, 'utf-8');

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--kc-sticky-header-h');
});

function renderHeader() {
  return render(
    <VaultHeader
      vaultStatus={{ isConnected: true, vaultPath: '/vault' } as any}
      activeTab="grid"
      setActiveTab={() => {}}
      searchQuery=""
      setSearchQuery={() => {}}
      isFilterOpen={false}
      setIsFilterOpen={() => {}}
      activeFilterCount={0}
      onOpenConnectVaultModal={() => {}}
      onOpenNewRecipeModal={() => {}}
      onOpenRecipeGrabber={() => {}}
      onOpenVaultIntelligence={() => {}}
      onOpenAskMyKitchen={() => {}}
      onOpenCreateForMe={() => {}}
      onRefreshVault={() => {}}
      recipeCount={3}
      noteCount={0}
      onReconnectVault={() => {}}
    />
  );
}

describe('Sticky header geometry is published for scroll positioning', () => {
  it('publishes --kc-sticky-header-h on the root element', () => {
    renderHeader();
    const published = document.documentElement.style.getPropertyValue('--kc-sticky-header-h');
    // jsdom does not apply the Tailwind `md:sticky` utility, so the header
    // computes as non-sticky and the published offset is 0 — but it MUST be
    // published, otherwise the scroll offset would never be applied.
    expect(published).not.toBe('');
    expect(published).toMatch(/^\d+px$/);
  });

  it('publishes 0 when the header is not sticky, so mobile scrolling is unaffected', () => {
    renderHeader();
    expect(document.documentElement.style.getPropertyValue('--kc-sticky-header-h')).toBe('0px');
  });

  it('releases the published value on unmount', () => {
    const { unmount } = renderHeader();
    expect(document.documentElement.style.getPropertyValue('--kc-sticky-header-h')).not.toBe('');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--kc-sticky-header-h')).toBe('');
  });
});

describe('Scroll positioning consumes the published header height', () => {
  it('insets the scrollport by the sticky header height on the scrolling element', () => {
    expect(css).toMatch(/html\s*\{[^}]*scroll-padding-top:\s*var\(--kc-sticky-header-h,\s*0px\)/s);
  });

  it('keeps the offset optional so the rule is inert before the header publishes', () => {
    expect(css).toContain('var(--kc-sticky-header-h, 0px)');
  });
});

describe('Sticky behaviour is unchanged by the repair', () => {
  it('keeps the header static below 768px and sticky from 768px up', () => {
    const { container } = renderHeader();
    const header = container.querySelector('#obsidian-vault-header')!;
    const cls = header.className;
    expect(cls).toMatch(/static/);
    expect(cls).toMatch(/md:sticky/);
    expect(cls).toMatch(/md:top-0/);
    // The compact mobile header must not have been made sticky.
    expect(cls).not.toMatch(/(^|\s)sticky(\s|$)/);
  });
});
