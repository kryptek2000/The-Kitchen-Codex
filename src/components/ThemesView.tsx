import React from 'react';
import {
  Palette,
  Check,
  Sun,
  Moon,
  Eye,
} from 'lucide-react';
import { ThemeId, AppThemeConfig } from '../types';
import { KitchenCodexMark } from './BrandMark';

interface ThemesViewProps {
  currentTheme: ThemeId;
  onSelectTheme: (theme: ThemeId) => void;
}

export const APP_THEMES: AppThemeConfig[] = [
  {
    id: 'obsidian',
    name: 'Obsidian Dark',
    subtitle: 'Classic Markdown & Warm Gold',
    description: 'Deep onyx charcoal canvas paired with glowing warm amber accents and crisp typography. Designed for late-night cooking and minimal glare.',
    mode: 'dark',
    palette: {
      bgRoot: '#0C0C0C',
      bgSurface: '#141414',
      bgElevated: '#1E1E1E',
      accent: '#F59E0B',
      accentSecondary: '#D97706',
      textPrimary: '#F3F4F6',
      textSecondary: '#9CA3AF',
      border: 'rgba(255, 255, 255, 0.08)',
    },
    highlights: ['Default Obsidian Aesthetic', 'OLED Deep Contrast', 'Warm Amber Highlights'],
    vibe: 'Refined, focus-oriented dark mode mirroring Obsidian desktop with Dataview gold highlights.',
  },
  {
    id: 'parchment',
    name: 'Warm Parchment',
    subtitle: 'Editorial Cookbook & Terracotta',
    description: 'Warm cream paper background paired with rich terracotta and espresso typography. Reminiscent of tactile recipe notebooks, heritage binders, and high-readability daylight kitchen counters.',
    mode: 'light',
    palette: {
      bgRoot: '#F6F3EB',
      bgSurface: '#FFFFFF',
      bgElevated: '#EDE6D8',
      accent: '#C2410C',
      accentSecondary: '#EA580C',
      textPrimary: '#1C1917',
      textSecondary: '#57534E',
      border: 'rgba(40, 30, 20, 0.12)',
    },
    highlights: ['Editorial Cookbook Feel', 'Daylight Kitchen Readability', 'Terracotta & Espresso'],
    vibe: 'Classic print cookbook with soft warm tones, high typographic contrast, and tactile warmth.',
  },
  {
    id: 'nordic',
    name: 'Nordic Sage',
    subtitle: 'Scandinavian Pine & Herb Mint',
    description: 'A soothing deep pine-slate backdrop accented by fresh sage and mint emerald. Inspired by botanical kitchens, organic culinary journals, and calm Scandinavian design.',
    mode: 'dark',
    palette: {
      bgRoot: '#0A120F',
      bgSurface: '#121D18',
      bgElevated: '#192821',
      accent: '#10B981',
      accentSecondary: '#34D399',
      textPrimary: '#ECFDF5',
      textSecondary: '#A7F3D0',
      border: 'rgba(52, 211, 153, 0.16)',
    },
    highlights: ['Botanical Pine & Mint', 'Herb Garden Accents', 'Calm Scandinavian Studio'],
    vibe: 'Minimalist Nordic aesthetics with fresh mint herbs, muted pine tones, and crisp emerald accents.',
  },
  {
    id: 'blood-moon',
    name: 'The Blood Moon',
    subtitle: 'Oxblood, Ember & Warm Ivory',
    description:
      'A near-black soot and graphite canvas lit by deep oxblood, ember crimson, and warm ivory type. A dark, precise, handcrafted field-journal mood for late-night cooking — deliberate and quiet, never gaudy.',
    mode: 'dark',
    palette: {
      bgRoot: '#0B090A',
      bgSurface: '#131011',
      bgElevated: '#1A1416',
      accent: '#B72A3A',
      accentSecondary: '#C14B3A',
      textPrimary: '#F2ECE7',
      textSecondary: '#A79A95',
      border: 'rgba(242, 236, 231, 0.09)',
    },
    highlights: ['Oxblood & Ember Crimson', 'Warm Near-Black Graphite', 'Warm Ivory Type'],
    vibe: 'A dark, mysterious, precise culinary field journal with restrained blood-moon crimson accents.',
    badge: "Developer's Edition",
  },
];

/**
 * Root/background color for a theme, used for the browser `theme-color` chrome.
 * Derived from the single theme config (never a hard-coded per-theme literal).
 */
export function themeBackgroundColor(id: ThemeId): string {
  return (APP_THEMES.find((t) => t.id === id) ?? APP_THEMES[0]).palette.bgRoot;
}

export function ThemesView({ currentTheme, onSelectTheme }: ThemesViewProps) {
  const activeThemeConfig = APP_THEMES.find((t) => t.id === currentTheme) || APP_THEMES[0];
  const activeMode = activeThemeConfig.mode === 'dark' ? 'Dark canvas' : 'Light canvas';

  const selectTheme = (theme: ThemeId) => {
    onSelectTheme(theme);
  };

  return (
    <section className="space-y-7 sm:space-y-8">
      <header className="space-y-3 border-b border-[var(--color-rule,var(--border-subtle,rgba(255,255,255,0.08)))] pb-5 sm:pb-6">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">
          <Palette className="h-4 w-4 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
          <span>Appearance</span>
        </div>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-2">
            <h1 className="font-serif text-[32px] leading-[1.15] text-[var(--text-primary,#F3F4F6)] sm:text-[40px]">
              Themes &amp; Appearance
            </h1>
            <p className="max-w-xl text-[14px] leading-[1.6] text-[var(--text-secondary,#9CA3AF)]">
              A cookbook for daylight counters and late-night kitchens. Choose the palette that
              makes your recipes most comfortable to read. Changes apply immediately and are
              remembered on this device.
            </p>
          </div>

          <div className="flex items-center gap-3 rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-4 py-3">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))]"
              style={{ backgroundColor: activeThemeConfig.palette.bgElevated }}
            >
              <span
                className="h-4 w-4 rounded-full"
                style={{ backgroundColor: activeThemeConfig.palette.accent }}
              />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted,#6B7280)]">
                Current theme
              </p>
              <p className="truncate font-serif text-[17px] text-[var(--text-primary,#F3F4F6)]">
                {activeThemeConfig.name}
              </p>
              <p className="text-[11px] text-[var(--text-secondary,#9CA3AF)]">{activeMode}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-4">
        {APP_THEMES.map((theme) => {
          const isActive = currentTheme === theme.id;
          const isDark = theme.mode === 'dark';

          return (
            <div
              key={theme.id}
              id={`theme-card-${theme.id}`}
              role="group"
              aria-label={`${theme.name} theme preview`}
              onClick={() => selectTheme(theme.id)}
              className={`relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border transition-all duration-200 ${
                isActive
                  ? 'bg-[var(--bg-elevated,#1E1E1E)] border-[color:var(--accent)] shadow-lg ring-1 ring-[color:var(--accent-subtle)]'
                  : 'bg-[var(--bg-surface,#141414)] border-[var(--border-subtle,rgba(255,255,255,0.08))] hover:border-[var(--accent-text,#F59E0B)] hover:shadow-md'
              }`}
            >
              {isActive && (
                <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-black shadow-xs">
                  <Check className="h-3 w-3 stroke-[3]" aria-hidden="true" />
                  <span>ACTIVE</span>
                </div>
              )}

              <div className="p-4 sm:p-5">
                <div
                  className="mb-4 flex h-[176px] flex-col justify-between overflow-hidden rounded-xl border p-3.5 sm:h-[188px]"
                  style={{
                    backgroundColor: theme.palette.bgRoot,
                    borderColor: theme.palette.border,
                    color: theme.palette.textPrimary,
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
                        style={{ backgroundColor: theme.palette.bgElevated, borderColor: theme.palette.border, ["--text-primary" as any]: theme.palette.textPrimary, ["--accent-text" as any]: theme.palette.accent }}
                      >
                        <KitchenCodexMark size={16} decorative />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-serif text-[12px] font-semibold" style={{ color: theme.palette.textPrimary }}>
                          Kitchen Codex
                        </p>
                        <p className="truncate text-[9px] uppercase tracking-[0.14em]" style={{ color: theme.palette.textSecondary }}>
                          My Recipe Vault
                        </p>
                      </div>
                    </div>
                    <span
                      className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium"
                      style={{ backgroundColor: theme.palette.bgSurface, borderColor: theme.palette.border, color: theme.palette.accent }}
                    >
                      {isDark ? <Moon className="mr-0.5 inline h-2.5 w-2.5" aria-hidden="true" /> : <Sun className="mr-0.5 inline h-2.5 w-2.5" aria-hidden="true" />}
                      {isDark ? 'Dark' : 'Light'}
                    </span>
                  </div>

                  <div
                    className="rounded-lg border px-3 py-2.5"
                    style={{ backgroundColor: theme.palette.bgSurface, borderColor: theme.palette.border }}
                  >
                    <p className="font-serif text-[14px] leading-snug" style={{ color: theme.palette.textPrimary }}>
                      Lemon &amp; Herb Roast Chicken
                    </p>
                    <p className="mt-0.5 text-[10px]" style={{ color: theme.palette.textSecondary }}>
                      45 min · 4 servings · Dinner
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 font-mono text-[9px]"
                        style={{ backgroundColor: theme.palette.bgElevated, color: theme.palette.accent }}
                      >
                        #food/recipes
                      </span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[9px] font-semibold"
                        style={{ backgroundColor: theme.palette.accent, color: isDark ? '#000000' : '#FFFFFF' }}
                      >
                        Open recipe
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      {[theme.palette.accent, theme.palette.bgSurface, theme.palette.bgElevated].map((color, index) => (
                        <span
                          key={`${theme.id}-${index}`}
                          className="h-2.5 w-2.5 rounded-full border border-black/20"
                          style={{ backgroundColor: color }}
                          title={['Accent', 'Surface', 'Elevated'][index]}
                        />
                      ))}
                    </div>
                    <span className="text-[9px] font-mono" style={{ color: theme.palette.textSecondary }}>
                      {theme.palette.accent}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-serif text-[20px] leading-tight text-[var(--text-primary,#F3F4F6)]">
                      {theme.name}
                    </h3>
                    {theme.badge ? (
                      <span className="kc-brand-badge inline-block rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-widest" style={{ color: 'var(--text-primary,#F3F4F6)' }}>
                        {theme.badge}
                      </span>
                    ) : null}
                  </div>
                  <p className={`text-[12px] font-semibold ${isActive ? 'text-[var(--text-primary,#F3F4F6)]' : 'text-[var(--accent-text,#F59E0B)]'}`}>{theme.subtitle}</p>
                  <p data-theme-description className="text-[12px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)]">
                    {theme.description}
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {theme.highlights.map((highlight) => (
                    <span
                      key={highlight}
                      className="rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2 py-0.5 text-[10px] text-[var(--text-secondary,#9CA3AF)]"
                    >
                      {highlight}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-auto p-4 pt-0 sm:p-5 sm:pt-0">
                <button
                  id={`apply-theme-${theme.id}-btn`}
                  type="button"
                  aria-pressed={isActive}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectTheme(theme.id);
                  }}
                  className={`flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition-colors ${
                    isActive
                      ? 'bg-amber-500 text-black shadow-md shadow-amber-500/20'
                      : 'border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--text-primary,#F3F4F6)]'
                  }`}
                >
                  {isActive ? (
                    <>
                      <Check className="h-3.5 w-3.5 stroke-[2.5]" aria-hidden="true" />
                      <span>Current active theme</span>
                    </>
                  ) : (
                    <>
                      <Palette className="h-3.5 w-3.5 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                      <span>Apply {theme.name}</span>
                    </>
                  )}
                </button>
                <p className="mt-2 text-center text-[10px] text-[var(--text-muted,#6B7280)]">
                  {isActive ? 'This is the theme you are using.' : 'Preview and apply instantly.'}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <section
        aria-label="Current theme in context"
        className="overflow-hidden rounded-2xl border border-[var(--color-rule,var(--border-subtle,rgba(255,255,255,0.08)))] bg-[var(--bg-surface,#141414)]"
      >
        <div className="flex flex-col gap-2 border-b border-[var(--color-rule,var(--border-subtle,rgba(255,255,255,0.08)))] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
            <h2 className="font-serif text-[19px] text-[var(--text-primary,#F3F4F6)]">Your cookbook in context</h2>
          </div>
          <span className="text-[11px] text-[var(--text-secondary,#9CA3AF)]">
            {activeThemeConfig.name} · {activeThemeConfig.subtitle}
          </span>
        </div>

        <div
          className="grid grid-cols-1 gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]"
          style={{ backgroundColor: activeThemeConfig.palette.bgRoot }}
        >
          <div
            className="rounded-xl border p-4 sm:p-5"
            style={{ backgroundColor: activeThemeConfig.palette.bgSurface, borderColor: activeThemeConfig.palette.border }}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: activeThemeConfig.palette.textSecondary }}>
              Recipe detail
            </p>
            <h3 className="mt-1 font-serif text-[24px] leading-tight sm:text-[28px]" style={{ color: activeThemeConfig.palette.textPrimary }}>
              Roast Chicken with Preserved Lemon
            </h3>
            <p className="mt-1 text-[12px]" style={{ color: activeThemeConfig.palette.textSecondary }}>
              Dinner · 45 minutes · 4 servings
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {['#food/recipes', '#weeknight', 'Easy'].map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border px-2 py-0.5 font-mono text-[10px]"
                  style={{ backgroundColor: activeThemeConfig.palette.bgElevated, borderColor: activeThemeConfig.palette.border, color: activeThemeConfig.palette.accent }}
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span
                className="inline-flex min-h-[40px] items-center rounded-lg px-4 text-[12px] font-semibold"
                style={{ backgroundColor: activeThemeConfig.palette.accent, color: activeThemeConfig.mode === 'light' ? '#FFFFFF' : '#000000' }}
              >
                Start cooking
              </span>
              <span className="text-[11px]" style={{ color: activeThemeConfig.palette.textSecondary }}>
                Ingredients scale with servings.
              </span>
            </div>
          </div>

          <div
            className="rounded-xl border p-4 sm:p-5"
            style={{ backgroundColor: activeThemeConfig.palette.bgSurface, borderColor: activeThemeConfig.palette.border }}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: activeThemeConfig.palette.textSecondary }}>
                Nutrition at a glance
              </p>
              <span className="rounded-full border px-2 py-0.5 text-[9px]" style={{ borderColor: activeThemeConfig.palette.border, color: activeThemeConfig.palette.accent }}>
                Advisory
              </span>
            </div>
            <p className="mt-2 font-serif text-[36px] leading-none" style={{ color: activeThemeConfig.palette.textPrimary }}>
              486<span className="ml-1 font-sans text-[12px]" style={{ color: activeThemeConfig.palette.textSecondary }}>kcal</span>
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
              {[
                ['Protein', '18g'],
                ['Carbs', '62g'],
                ['Fat', '18g'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border px-2 py-1.5" style={{ backgroundColor: activeThemeConfig.palette.bgElevated, borderColor: activeThemeConfig.palette.border }}>
                  <span className="block text-[9px] uppercase tracking-wide" style={{ color: activeThemeConfig.palette.textSecondary }}>{label}</span>
                  <span className="font-mono font-semibold" style={{ color: activeThemeConfig.palette.textPrimary }}>{value}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: activeThemeConfig.palette.textSecondary }}>
              Values, provenance and completeness stay readable in every palette.
            </p>
          </div>
        </div>
      </section>
    </section>
  );
}
