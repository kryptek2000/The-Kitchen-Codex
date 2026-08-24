/**
 * html2canvas 1.4.1 re-parses every computed style with its own CSS parser,
 * which only understands rgb()/rgba()/hsl()/hsla(). Tailwind CSS v4 emits
 * modern color functions (oklch, oklab, color-mix, lab, lch) which that parser
 * cannot parse and it throws `Attempting to parse an unsupported color function`.
 *
 * This helper keeps the stylesheets intact (layout/typography intact) and only
 * re-writes the colors that html2canvas cannot understand back into sRGB as
 * inline styles, overriding just the offending computed values.
 */

const MODERN_COLOR_RE = /oklch|oklab|color-mix|lab\(|lch\(|light-dark|hwb\(|color\(/i;

/** Color-oriented properties whose computed value is (or contains) a color. */
const COLOR_PROPERTIES = [
  'background-color',
  'color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'text-decoration-color',
  'outline-color',
  '-webkit-text-fill-color',
  'column-rule-color',
  'text-emphasis-color',
  'caret-color',
];

/**
 * Convert a browser CSS color value (e.g. `oklch(...)`, `oklab(0 0 0 / 0.05)`,
 * or a resolved `color-mix(...)`) to an sRGB `rgba()` string using the browser's
 * own color engine. Returns `null` if the value is not a recognizable color.
 */
function resolveColorToSrgb(value: string): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${data[0]},${data[1]},${data[2]},${data[3] / 255})`;
  } catch {
    return null;
  }
}

function normalizeCardColors(clonedDoc: Document, root?: Element | null): number {
  const rootEl =
    root ??
    clonedDoc.querySelector('.recipe-card-print-container > div') ??
    clonedDoc.body;
  if (!rootEl) return 0;

  const win = clonedDoc.defaultView;
  if (!win) return 0;

  let changed = 0;
  const walk = (element: Element) => {
    const style = win.getComputedStyle(element);
    for (const property of COLOR_PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (value && MODERN_COLOR_RE.test(value)) {
        const rgba = resolveColorToSrgb(value);
        if (rgba) {
          (element as HTMLElement).style.setProperty(property, rgba);
          changed++;
        }
      }
    }
    Array.prototype.slice.call(element.children).forEach(walk);
  };

  walk(rootEl);
  return changed;
}

export { normalizeCardColors, resolveColorToSrgb };
