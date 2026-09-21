// @vitest-environment jsdom
/**
 * The Kitchen Codex — Brand System + Blood Moon theme regression tests.
 *
 * Covers the branding/design slice only:
 *   - the stable theme registry (Blood Moon registered, exact id, no default change)
 *   - the theme-aware brand mark / lockup (icon-only vs wordmark, token classes)
 *   - theme persistence + switch-away/back through the real SettingsAdapter
 *   - the CSS source of truth for the Blood Moon token set
 *   - semantic-red structural distinguishability (accent is NOT destructive red)
 *   - "Developer's Edition" is descriptive only (no behavioral gate)
 *
 * No nutrition/AI/server behavior is exercised or asserted here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  THEME_IDS,
  DEFAULT_THEME_ID,
  isThemeId,
  type ThemeId,
} from '../../src/types';
import { APP_THEMES, ThemesView, themeBackgroundColor } from '../../src/components/ThemesView';
import { KitchenCodexMark, KitchenCodexBrand } from '../../src/components/BrandMark';
import { VaultHeader } from '../../src/components/VaultHeader';
import { BrowserSettingsAdapter, type StorageLike } from '../../src/platform/browser/BrowserSettingsAdapter';

const CSS_PATH = path.resolve(process.cwd(), 'src/index.css');
const css = fs.readFileSync(CSS_PATH, 'utf-8');
const FAVICON_PATH = path.resolve(process.cwd(), 'public/favicon.svg');
const favicon = fs.readFileSync(FAVICON_PATH, 'utf-8');
const INDEX_HTML = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');

function inMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

afterEach(() => cleanup());

describe('Blood Moon theme registration', () => {
  it('registers a stable exact theme id "blood-moon"', () => {
    expect(THEME_IDS).toContain('blood-moon');
    expect(isThemeId('blood-moon')).toBe(true);
    expect(isThemeId('bloodmoon')).toBe(false);
    expect(isThemeId('Blood Moon')).toBe(false);
    expect(isThemeId('vampire')).toBe(false);
  });

  it('appears in APP_THEMES with the approved name, dark mode, and a descriptor badge', () => {
    const bm = APP_THEMES.find((t) => t.id === 'blood-moon');
    expect(bm).toBeDefined();
    expect(bm!.name).toBe('The Blood Moon');
    expect(bm!.mode).toBe('dark');
    expect(bm!.badge).toBe("Developer's Edition");
  });

  it('does NOT change the default theme (Blood Moon is never the default)', () => {
    expect(DEFAULT_THEME_ID).toBe('obsidian');
    expect(APP_THEMES[0].id).toBe('obsidian');
    expect(APP_THEMES[0].id).not.toBe('blood-moon');
  });

  it('keeps every existing theme id valid (no accidental removals)', () => {
    for (const id of ['obsidian', 'parchment', 'nordic'] as ThemeId[]) {
      expect(THEME_IDS).toContain(id);
      expect(APP_THEMES.some((t) => t.id === id)).toBe(true);
    }
  });

  it('treats "Developer\'s Edition" as descriptive only — no behavioral divergence', () => {
    const bm = APP_THEMES.find((t) => t.id === 'blood-moon')!;
    const base = APP_THEMES.find((t) => t.id === 'obsidian')!;
    // Same shape/keys as any other theme (plus the optional descriptor badge);
    // nothing feature-gating.
    const keys = (t: typeof bm) => Object.keys(t).filter((k) => k !== 'badge').sort();
    expect(keys(bm)).toEqual(keys(base));
    expect(JSON.stringify(bm)).not.toMatch(/permission|gate|privilege|cheat|api|license|telemetry/i);
  });
});

describe('Blood Moon theme persistence', () => {
  it('persists selection and survives a reload via the real SettingsAdapter', async () => {
    const storage = inMemoryStorage();
    const adapter = new BrowserSettingsAdapter(storage);

    await adapter.set('obsidian_vault_theme', 'blood-moon' satisfies ThemeId);
    // Simulate reload: a fresh adapter over the same storage.
    const reloaded = new BrowserSettingsAdapter(storage);
    const saved = await reloaded.get<ThemeId>('obsidian_vault_theme');
    expect(saved).toBe('blood-moon');
    expect(isThemeId(saved)).toBe(true);
  });

  it('switches away and back without losing any theme', async () => {
    const adapter = new BrowserSettingsAdapter(inMemoryStorage());
    await adapter.set('obsidian_vault_theme', 'blood-moon' satisfies ThemeId);
    expect(await adapter.get('obsidian_vault_theme')).toBe('blood-moon');

    await adapter.set('obsidian_vault_theme', 'nordic' satisfies ThemeId);
    expect(await adapter.get('obsidian_vault_theme')).toBe('nordic');

    await adapter.set('obsidian_vault_theme', 'blood-moon' satisfies ThemeId);
    expect(await adapter.get('obsidian_vault_theme')).toBe('blood-moon');

    await adapter.set('obsidian_vault_theme', 'parchment' satisfies ThemeId);
    expect(await adapter.get('obsidian_vault_theme')).toBe('parchment');
  });
});

describe('Brand mark source of truth', () => {
  it('renders a theme-aware SVG whose parts are driven by token classes', () => {
    const { container } = render(<KitchenCodexMark size={32} title="The Kitchen Codex" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 1088 1180');
    // Vessel/lid/circuit + steam derive color from theme tokens, not hard-coded hexes.
    expect(container.querySelectorAll('.kc-brand-mark__body').length).toBe(1);
    expect(container.querySelectorAll('.kc-brand-mark__accent').length).toBe(1);
    expect(svg!.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it('exposes an accessible label by default and is aria-hidden when decorative', () => {
    const { unmount } = render(<KitchenCodexMark />);
    expect(screen.getByRole('img', { name: 'The Kitchen Codex' })).toBeTruthy();
    unmount();
    const { container: c2 } = render(<KitchenCodexMark decorative />);
    expect(c2.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the wordmark lockup in full mode and hides it in icon-only mode', () => {
    const { unmount } = render(<KitchenCodexBrand variant="full" />);
    expect(screen.getByText('The Kitchen Codex')).toBeTruthy();
    unmount();
    const { queryByText } = render(<KitchenCodexBrand variant="icon" />);
    expect(queryByText('The Kitchen Codex')).toBeNull();
  });

  it('supports an optional descriptor badge without changing the mark', () => {
    render(<KitchenCodexBrand variant="full" badge="Developer's Edition" />);
    expect(screen.getByText("Developer's Edition")).toBeTruthy();
  });

  it('full and compact variants are the same identity at two detail levels', () => {
    const full = render(<KitchenCodexMark variant="full" />).container;
    const compact = render(<KitchenCodexMark variant="compact" />).container;
    const fullPaths = [...full.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    const compactPaths = [...compact.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    // Full carries the complete circuit detail; compact is a strict subset.
    expect(compactPaths.length).toBeLessThan(fullPaths.length);
    expect(full.querySelectorAll('.kc-brand-mark__accent path').length).toBeGreaterThanOrEqual(2);
    expect(compact.querySelectorAll('.kc-brand-mark__accent path').length).toBeGreaterThanOrEqual(2);
    for (const d of compactPaths) expect(fullPaths).toContain(d);
  });
});

describe('Brand lockup scale & surfaces', () => {
  it('sizes the header mark as a large hero anchor (>= 64px, full detail)', () => {
    const { container } = render(
      <VaultHeader
        vaultStatus={{ isConnected: true, vaultPath: '/vault', fileCount: 3 } as any}
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
      />
    );
    const header = container.querySelector('#obsidian-vault-header')!;
    const markGroup = header.querySelector('.kc-brand-mark__body')!;
    expect(markGroup).not.toBeNull();
    const svg = markGroup.closest('svg')!;
    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(64);
    // Header uses the FULL mark (all circuit detail), not the compact mark.
    expect(svg.querySelectorAll('.kc-brand-mark__body path').length).toBeGreaterThan(2);
    expect(header.querySelectorAll('.kc-brand-mark__body').length).toBe(1);
  });

  it('does not cram the hero mark into a small tinted tile', () => {
    const { container } = render(<KitchenCodexBrand variant="icon" size="lg" />);
    const svg = container.querySelector('.kc-brand-mark__body')!.closest('svg')!;
    // Bare mark on the surface (matches the approved horizontal lockup), no tile.
    expect(svg.parentElement!.className).not.toMatch(/bg-amber-500/);
  });

  it('reuses the same BrandMark in the theme picker banner (no separate drawing)', () => {
    const { container } = render(<ThemesView currentTheme="blood-moon" onSelectTheme={() => {}} />);
    expect(container.querySelectorAll('.kc-brand-mark__body').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('.kc-brand-mark__accent').length).toBeGreaterThanOrEqual(1);
  });

  it('uses component size variants so the mark is not oversized outside the header', () => {
    const { container } = render(<KitchenCodexBrand variant="icon" size="lg" />);
    const svg = container.querySelector('.kc-brand-mark__body')!.closest('svg')!;
    expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(64);
  });
});

describe('Theme-color (browser chrome) correction', () => {
  it('derives theme-color from the theme config (Blood Moon is not the static default)', () => {
    expect(themeBackgroundColor('obsidian')).toBe('#0C0C0C');
    expect(themeBackgroundColor('blood-moon')).toBe('#0B090A');
    expect(themeBackgroundColor('parchment')).toBe('#F6F3EB');
    expect(themeBackgroundColor('nordic')).toBe('#0A120F');
  });

  it('ships the default (Obsidian) theme-color statically, not a Blood Moon literal', () => {
    const meta = INDEX_HTML.match(/<meta name="theme-color" content="([^"]+)"/);
    expect(meta?.[1]).toBe('#0C0C0C');
  });
});

describe('Active theme card accent treatment', () => {
  it('uses the theme accent token for the active card border/ring, not hard-coded amber', () => {
    render(<ThemesView currentTheme="blood-moon" onSelectTheme={() => {}} />);
    const card = document.getElementById('theme-card-blood-moon')!;
    expect(card.className).toContain('var(--accent)');
    expect(card.className).toContain('var(--accent-subtle)');
    expect(card.className).not.toMatch(/border-amber-500\/80/);
    expect(card.className).not.toMatch(/ring-amber-500/);
  });

  it('keeps active-card visibility for non-Blood-Moon themes via the same token classes', () => {
    render(<ThemesView currentTheme="nordic" onSelectTheme={() => {}} />);
    const card = document.getElementById('theme-card-nordic')!;
    expect(card.className).toContain('var(--accent)');
    expect(card.className).toMatch(/ring-1/);
  });

  it('places the ACTIVE badge on the card-level layer above the preview panel', () => {
    const { container } = render(<ThemesView currentTheme="blood-moon" onSelectTheme={() => {}} />);
    const badge = screen.getByText('ACTIVE').parentElement!;
    // Card-level absolute positioning with an intentional z-index so the
    // later-in-DOM preview panel cannot paint over it.
    expect(badge.className).toMatch(/absolute/);
    expect(badge.className).toMatch(/top-3/);
    expect(badge.className).toMatch(/right-3/);
    expect(badge.className).toMatch(/z-10/);
    // The badge belongs to the card root, not to the preview container.
    const card = document.getElementById('theme-card-blood-moon')!;
    expect(card.contains(badge)).toBe(true);
    const preview = card.querySelector('.shadow-inner');
    expect(preview === null || !preview.contains(badge)).toBe(true);
    void container;
  });
});

describe('Header action hover states', () => {
  function headerButtons() {
    const { container } = render(
      <VaultHeader
        vaultStatus={{ isConnected: true, vaultPath: '/vault', fileCount: 3 } as any}
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
      />
    );
    return {
      ask: document.getElementById('ask-my-kitchen-header-btn')!,
      connect: document.getElementById('connect-local-vault-btn')!,
      create: document.getElementById('create-for-me-header-btn')!,
    };
  }

  it('gives Ask My Kitchen and Connect Vault explicit hover backgrounds', () => {
    headerButtons();
    for (const btn of [document.getElementById('ask-my-kitchen-header-btn')!,
                       document.getElementById('connect-local-vault-btn')!]) {
      expect(btn.className).toMatch(/hover:bg-amber-500\/20/);
      expect(btn.className).toMatch(/transition-colors/);
      expect(btn.className).not.toMatch(/outline-none/);
    }
  });

  it('defines theme hover remaps so amber buttons brighten in every theme', () => {
    expect(css.includes(':root .hover\\:bg-amber-500\\/20:hover')).toBe(true);
    expect(css.includes('[data-theme="obsidian"] .hover\\:bg-amber-500\\/20:hover')).toBe(true);
    expect(css.includes('[data-theme="parchment"] .hover\\:bg-amber-500\\/20:hover')).toBe(true);
    expect(css.includes('[data-theme="nordic"] .hover\\:bg-amber-500\\/20:hover')).toBe(true);
    expect(css.includes('[data-theme="blood-moon"] .hover\\:bg-amber-500\\/20:hover')).toBe(true);
    expect(css.includes('background-color: rgba(245, 158, 11, 0.20)')).toBe(true);
    expect(css.includes('background-color: rgba(194, 65, 12, 0.20) !important;')).toBe(true);
    expect(css.includes('background-color: rgba(16, 185, 129, 0.26) !important;')).toBe(true);
    expect(css.includes('background-color: rgba(183, 42, 58, 0.30) !important;')).toBe(true);
  });

  it('keeps the hover hue inside the theme accent family (no hue jump)', () => {
    // Blood Moon hover is the same crimson as resting, only more opaque.
    expect(css.includes('rgba(183, 42, 58, 0.30)')).toBe(true);
    expect(css.includes('rgba(194, 65, 12, 0.20)')).toBe(true);
    expect(css.includes('rgba(16, 185, 129, 0.26)')).toBe(true);
    expect(css.includes('rgba(245, 158, 11, 0.20)')).toBe(true);
  });
});

describe('Favicon uses the same identity family', () => {
  it('embeds the compact mark verbatim with static brand colors and no wordmark', () => {
    const { container } = render(<KitchenCodexMark variant="compact" />);
    const compactDs = [...container.querySelectorAll('path')].map((p) => p.getAttribute('d')!);
    expect(compactDs.length).toBeGreaterThan(0);
    // The favicon reuses the component's compact geometry (same logo, not a redraw).
    for (const d of compactDs) expect(favicon).toContain(d);
    expect(favicon).toContain('#D9665A');
    expect(favicon).toContain('#F2ECE7');
    expect(favicon).not.toContain('<text');
    expect(favicon).not.toContain('The Kitchen Codex<');
  });
});

describe('ThemesView picker integration', () => {
  it('renders a card for Blood Moon and reports selection', () => {
    const selected: ThemeId[] = [];
    render(<ThemesView currentTheme="obsidian" onSelectTheme={(t) => selected.push(t)} />);

    expect(screen.getByText('The Blood Moon')).toBeTruthy();
    expect(screen.getByText("Developer's Edition")).toBeTruthy();

    fireEvent.click(screen.getByText('The Blood Moon'));
    expect(selected).toContain('blood-moon');
  });

  it('marks Blood Moon active and exposes an apply control', () => {
    render(<ThemesView currentTheme="blood-moon" onSelectTheme={() => {}} />);
    const card = document.getElementById('theme-card-blood-moon');
    expect(card).not.toBeNull();
    expect(card!.className).toMatch(/ring-1/);
    expect(document.getElementById('apply-theme-blood-moon-btn')).not.toBeNull();
  });

  it('keeps existing theme cards renderable alongside Blood Moon', () => {
    render(<ThemesView currentTheme="obsidian" onSelectTheme={() => {}} />);
    expect(document.getElementById('theme-card-obsidian')).not.toBeNull();
    expect(document.getElementById('theme-card-parchment')).not.toBeNull();
    expect(document.getElementById('theme-card-nordic')).not.toBeNull();
    expect(document.getElementById('theme-card-blood-moon')).not.toBeNull();
  });
});

describe('Blood Moon CSS token source of truth', () => {
  it('defines a data-theme block with the approved token set', () => {
    expect(css).toMatch(/\[data-theme="blood-moon"\]\s*\{/);
    expect(css).toContain('--bg-root: #0B090A');
    expect(css).toContain('--bg-surface: #131011');
    expect(css).toContain('--bg-elevated: #1A1416');
    expect(css).toContain('--accent: #B72A3A');
    expect(css).toContain('--accent-text: #D9665A');
    expect(css).toContain('--text-primary: #F2ECE7');
  });

  it('defines --accent-text for every theme so branding stays token-driven', () => {
    for (const id of THEME_IDS) {
      const scope = id === 'obsidian' ? ':root' : `[data-theme="${id}"]`;
      const idx = css.indexOf(scope);
      expect(idx, `theme scope ${scope}`).toBeGreaterThanOrEqual(0);
      const block = css.slice(idx, css.indexOf('}', idx));
      expect(block, `--accent-text in ${scope}`).toContain('--accent-text');
    }
  });

  it('drives the brand mark from tokens (no hard-coded theme hex in the brand rules)', () => {
    const bodyRule = css.match(/\.kc-brand-mark__body\s*\{[^}]*\}/);
    const accentRule = css.match(/\.kc-brand-mark__accent\s*\{[^}]*\}/);
    expect(bodyRule?.[0]).toContain('var(--text-primary');
    expect(accentRule?.[0]).toContain('var(--accent-text');
    expect(accentRule?.[0]).toContain('var(--accent');
  });

  it('does NOT override semantic destructive red classes (accent != error)', () => {
    const start = css.indexOf('[data-theme="blood-moon"]');
    const end = css.indexOf('.kc-brand-mark__body');
    const block = css.slice(start, end);
    // The theme recolors the amber accent family only; Tailwind's red/emerald/
    // amber warning families must remain structurally intact for semantics.
    expect(block).not.toMatch(/\.text-red-/);
    expect(block).not.toMatch(/\.bg-red-/);
    expect(block).not.toMatch(/\.border-red-/);
    expect(block).not.toMatch(/\.text-emerald-/);
    expect(block).not.toMatch(/\.text-sky-/);
  });

  it('keeps nutrition status surfaces distinguishable (warning/success not collapsed)', () => {
    const start = css.indexOf('[data-theme="blood-moon"]');
    const end = css.indexOf('.kc-brand-mark__body');
    const block = css.slice(start, end);
    // Advanced Nutrition partial/warning surfaces (amber-950 bg, amber-800 border)
    // and success (emerald-300) must NOT be flattened into the crimson accent.
    expect(block).not.toMatch(/\.bg-amber-950/);
    expect(block).not.toMatch(/\.border-amber-800/);
    expect(block).not.toMatch(/\.text-amber-200/);
    expect(block).not.toMatch(/emerald/);
  });
});
