import React, { useState } from 'react';
import {
  Palette,
  Check,
  Sparkles,
  Sun,
  Moon,
  Tag,
  Eye,
} from 'lucide-react';
import { ThemeId, AppThemeConfig } from '../types';
import { KitchenCodexBrand, KitchenCodexMark } from './BrandMark';

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
  const [previewTheme, setPreviewTheme] = useState<ThemeId>(currentTheme);
  const activeThemeConfig = APP_THEMES.find((t) => t.id === currentTheme) || APP_THEMES[0];
  const inspectedThemeConfig = APP_THEMES.find((t) => t.id === previewTheme) || activeThemeConfig;

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="p-5 sm:p-6 rounded-2xl bg-[#141414] border border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-start sm:items-center gap-3.5">
          <KitchenCodexBrand variant="icon" size="lg" />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-serif font-bold text-white tracking-tight">Themes &amp; Appearance</h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-300">
                {APP_THEMES.length} Handcrafted Palettes
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Personalize your culinary vault for kitchen daylight, late-night cooking, or botanical aesthetics.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 bg-[#0C0C0C] px-3 py-1.5 rounded-xl border border-white/10 self-start md:self-auto">
          <span className="text-xs text-gray-400">Active Theme:</span>
          <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full inline-block"
              style={{ backgroundColor: activeThemeConfig.palette.accent }}
            />
            {activeThemeConfig.name}
          </span>
        </div>
      </div>

      {/* Handcrafted Palettes Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-5">
        {APP_THEMES.map((theme) => {
          const isActive = currentTheme === theme.id;
          const isInspected = previewTheme === theme.id;

          return (
            <div
              key={theme.id}
              id={`theme-card-${theme.id}`}
              onClick={() => {
                setPreviewTheme(theme.id);
                onSelectTheme(theme.id);
              }}
              className={`rounded-2xl border p-5 flex flex-col justify-between transition-all duration-200 cursor-pointer relative overflow-hidden group ${
                isActive
                  ? 'bg-[#181818] border-[color:var(--accent)] shadow-lg ring-1 ring-[color:var(--accent-subtle)]'
                  : 'bg-[#141414] border-white/10 hover:border-white/20 hover:bg-[#161616]'
              }`}
            >
              {/* Active Badge — card-level layer above the preview panel */}
              {isActive && (
                <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-amber-500 text-black px-2 py-0.5 rounded-full text-[10px] font-bold shadow-xs">
                  <Check className="w-3 h-3 stroke-[3]" />
                  <span>ACTIVE</span>
                </div>
              )}

              <div>
                {/* Visual Swatch Header */}
                <div
                  className="w-full h-24 rounded-xl p-3 mb-4 flex flex-col justify-between border relative overflow-hidden shadow-inner"
                  style={{
                    backgroundColor: theme.palette.bgRoot,
                    borderColor: theme.palette.border,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="text-[11px] font-bold font-serif px-2 py-0.5 rounded-md flex items-center gap-1"
                      style={{
                        backgroundColor: theme.palette.bgSurface,
                        color: theme.palette.textPrimary,
                        border: `1px solid ${theme.palette.border}`,
                      }}
                    >
                      {theme.mode === 'dark' ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
                      {theme.mode === 'dark' ? 'Dark Canvas' : 'Light Canvas'}
                    </span>

                    {/* Color Dots */}
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-3.5 h-3.5 rounded-full border border-black/20 shadow-xs"
                        style={{ backgroundColor: theme.palette.accent }}
                        title="Accent"
                      />
                      <div
                        className="w-3.5 h-3.5 rounded-full border border-black/20 shadow-xs"
                        style={{ backgroundColor: theme.palette.bgSurface }}
                        title="Surface"
                      />
                      <div
                        className="w-3.5 h-3.5 rounded-full border border-black/20 shadow-xs"
                        style={{ backgroundColor: theme.palette.bgElevated }}
                        title="Elevated"
                      />
                    </div>
                  </div>

                  {/* Micro Sample Pill */}
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-md truncate max-w-[170px]"
                      style={{
                        backgroundColor: theme.palette.bgSurface,
                        color: theme.palette.accent,
                        border: `1px solid ${theme.palette.border}`,
                      }}
                    >
                      #food/recipes
                    </span>
                    <span
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        color: theme.palette.textSecondary,
                        backgroundColor: theme.palette.bgElevated,
                      }}
                    >
                      [[Wikilink]]
                    </span>
                  </div>
                </div>

                {/* Title & Info */}
                <div className="space-y-1 mb-3">
                  <h3 className="text-base font-serif font-bold text-white group-hover:text-amber-400 transition-colors">
                    {theme.name}
                  </h3>
                  {theme.badge ? (
                    <span className="kc-brand-badge inline-block text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border font-medium">
                      {theme.badge}
                    </span>
                  ) : null}
                  <p className="text-xs font-medium text-amber-400/90">{theme.subtitle}</p>
                  <p className="text-xs text-gray-400 leading-relaxed pt-1">{theme.description}</p>
                </div>

                {/* Tags / Highlights */}
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {theme.highlights.map((h, i) => (
                    <span
                      key={i}
                      className="text-[10px] px-2 py-0.5 rounded-md bg-white/5 text-gray-300 border border-white/5"
                    >
                      {h}
                    </span>
                  ))}
                </div>
              </div>

              {/* Action Button */}
              <button
                id={`apply-theme-${theme.id}-btn`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectTheme(theme.id);
                }}
                className={`w-full py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                  isActive
                    ? 'bg-amber-500 text-black shadow-md shadow-amber-500/20'
                    : 'bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 hover:border-amber-500/30'
                }`}
              >
                {isActive ? (
                  <>
                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>Current Active Theme</span>
                  </>
                ) : (
                  <>
                    <Palette className="w-3.5 h-3.5 text-amber-400" />
                    <span>Apply {theme.name}</span>
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Live Component Sandbox / Theme Preview */}
      <div className="p-5 sm:p-6 rounded-2xl bg-[#141414] border border-white/10 space-y-4 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-white/10 gap-2">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-amber-400" />
            <h3 className="font-serif font-bold text-sm text-white">
              Live Theme Showcase &amp; Markdown Preview
            </h3>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>Viewing elements in:</span>
            <span className="font-bold text-white px-2 py-0.5 rounded bg-white/5 border border-white/10">
              {activeThemeConfig.name}
            </span>
          </div>
        </div>

        {/* Interactive Preview Canvas */}
        <div
          className="p-5 sm:p-6 rounded-xl border transition-colors duration-300 space-y-5"
          style={{
            backgroundColor: activeThemeConfig.palette.bgRoot,
            borderColor: activeThemeConfig.palette.border,
            color: activeThemeConfig.palette.textPrimary,
          }}
        >
          {/* Mock Header Row */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b"
            style={{ borderColor: activeThemeConfig.palette.border }}
          >
            <div className="flex items-center gap-2.5">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center"
                style={{
                  backgroundColor: activeThemeConfig.palette.bgElevated,
                  border: `1px solid ${activeThemeConfig.palette.border}`,
                }}
              >
                <KitchenCodexMark size={18} decorative />
              </div>
              <div>
                <h4
                  className="font-serif font-bold text-sm"
                  style={{ color: activeThemeConfig.palette.textPrimary }}
                >
                  Classic Spaghetti Carbonara.md
                </h4>
                <p className="text-[11px]" style={{ color: activeThemeConfig.palette.textSecondary }}>
                  6 - Full Notes/Food/Recipes/Italian
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="text-[10px] font-mono px-2 py-0.5 rounded font-medium"
                style={{
                  backgroundColor: activeThemeConfig.palette.bgSurface,
                  color: activeThemeConfig.palette.accent,
                  border: `1px solid ${activeThemeConfig.palette.border}`,
                }}
              >
                #food/recipes
              </span>
              <span
                className="text-[10px] font-mono px-2 py-0.5 rounded font-medium"
                style={{
                  backgroundColor: activeThemeConfig.palette.bgSurface,
                  color: activeThemeConfig.palette.accent,
                  border: `1px solid ${activeThemeConfig.palette.border}`,
                }}
              >
                #italian
              </span>
              <span
                className="text-[10px] font-mono px-2 py-0.5 rounded"
                style={{
                  backgroundColor: activeThemeConfig.palette.bgElevated,
                  color: activeThemeConfig.palette.textSecondary,
                }}
              >
                Difficulty: Medium
              </span>
            </div>
          </div>

          {/* 2-Column Mock Content */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Card Left: Dataview Fields & Wikilinks */}
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{
                backgroundColor: activeThemeConfig.palette.bgSurface,
                borderColor: activeThemeConfig.palette.border,
              }}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold font-serif flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5" style={{ color: activeThemeConfig.palette.accent }} />
                  <span>Dataview Frontmatter &amp; Ingredients</span>
                </span>
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: activeThemeConfig.palette.bgElevated,
                    color: activeThemeConfig.palette.textSecondary,
                  }}
                >
                  YAML Block
                </span>
              </div>

              <div className="space-y-1.5 text-xs">
                <div
                  className="flex items-center justify-between p-2 rounded"
                  style={{ backgroundColor: activeThemeConfig.palette.bgElevated }}
                >
                  <span style={{ color: activeThemeConfig.palette.textSecondary }}>prepTime:</span>
                  <span className="font-mono font-medium">10 mins</span>
                </div>
                <div
                  className="flex items-center justify-between p-2 rounded"
                  style={{ backgroundColor: activeThemeConfig.palette.bgElevated }}
                >
                  <span style={{ color: activeThemeConfig.palette.textSecondary }}>cookTime:</span>
                  <span className="font-mono font-medium">15 mins</span>
                </div>
                <div
                  className="flex items-center justify-between p-2 rounded"
                  style={{ backgroundColor: activeThemeConfig.palette.bgElevated }}
                >
                  <span style={{ color: activeThemeConfig.palette.textSecondary }}>servings:</span>
                  <span className="font-mono font-medium">4 portions</span>
                </div>
              </div>

              {/* Wikilinks pill row */}
              <div className="pt-2 border-t" style={{ borderColor: activeThemeConfig.palette.border }}>
                <span className="text-[11px] block mb-1.5" style={{ color: activeThemeConfig.palette.textSecondary }}>
                  Connected Obsidian Graph Wikilinks:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {['[[Guanciale]]', '[[Pecorino Romano]]', '[[Spaghetti]]', '[[Black Pepper]]'].map((wiki, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 rounded text-[11px] font-mono font-medium cursor-pointer transition-colors"
                      style={{
                        backgroundColor: activeThemeConfig.palette.bgElevated,
                        color: activeThemeConfig.palette.accent,
                        border: `1px solid ${activeThemeConfig.palette.border}`,
                      }}
                    >
                      {wiki}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Card Right: Obsidian Callout Box */}
            <div
              className="p-4 rounded-xl border space-y-3 flex flex-col justify-between"
              style={{
                backgroundColor: activeThemeConfig.palette.bgSurface,
                borderColor: activeThemeConfig.palette.border,
              }}
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold font-serif flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" style={{ color: activeThemeConfig.palette.accent }} />
                    <span>Obsidian Callout Rendering</span>
                  </span>
                  <span
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: activeThemeConfig.palette.bgElevated,
                      color: activeThemeConfig.palette.textSecondary,
                    }}
                  >
                    &gt; [!tip]
                  </span>
                </div>

                {/* Callout box */}
                <div
                  className="p-3 rounded-lg border-l-4 text-xs leading-relaxed space-y-1"
                  style={{
                    backgroundColor: activeThemeConfig.palette.bgElevated,
                    borderLeftColor: activeThemeConfig.palette.accent,
                    borderColor: activeThemeConfig.palette.border,
                  }}
                >
                  <p className="font-bold flex items-center gap-1" style={{ color: activeThemeConfig.palette.accent }}>
                    <span>💡 Authentic Roman Technique:</span>
                  </p>
                  <p style={{ color: activeThemeConfig.palette.textSecondary }}>
                    Never use heavy cream. Emulsify hot starchy pasta cooking water with whisked egg yolks and freshly grated Pecorino Romano off the heat to create a silky, glossy pan sauce.
                  </p>
                </div>
              </div>

              {/* Sample Action Button inside the theme */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  className="px-3 py-1.5 rounded-lg text-xs font-bold transition-transform shadow-xs"
                  style={{
                    backgroundColor: activeThemeConfig.palette.accent,
                    color: activeThemeConfig.mode === 'light' ? '#ffffff' : '#000000',
                  }}
                >
                  Start Cooking Mode
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
