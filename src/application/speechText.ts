/**
 * Speech-only text normalization for Cooking Mode narration.
 *
 * This never mutates stored recipe Markdown; it only prepares text for TTS.
 */

const FRACTION_WORDS: Record<string, string> = {
  '1/2': 'one half',
  '1/3': 'one third',
  '2/3': 'two thirds',
  '1/4': 'one quarter',
  '3/4': 'three quarters',
  '1/8': 'one eighth',
};

export function normalizeSpeechText(text: string): string {
  let out = String(text || '');

  // Decode a small set of common HTML entities.
  out = out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Markdown links/images: speak the descriptive text, not the URL.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Headings.
  out = out.replace(/^#{1,6}\s*/gm, '');

  // List markers.
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/^\s*\d+[.)]\s+/gm, '');

  // Bold/italic markers.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  // Markdown emphasis requires no whitespace immediately after the opening
  // marker or before the closing marker. This preserves culinary multiplication
  // such as "2 * 3" and stray spacing around asterisks.
  out = out.replace(/\*(?!\s)([^*]+?)(?<!\s)\*/g, '$1');
  out = out.replace(/_(?!\s)([^_]+?)(?<!\s)_/g, '$1');

  // Inline code.
  out = out.replace(/`([^`]+)`/g, '$1');

  // Temperatures.
  out = out.replace(/(\d+(?:\.\d+)?)\s*°\s*F/gi, '$1 degrees Fahrenheit');
  out = out.replace(/(\d+(?:\.\d+)?)\s*°\s*C/gi, '$1 degrees Celsius');
  out = out.replace(/(\d+(?:\.\d+)?)\s*F\b/g, '$1 degrees Fahrenheit');
  out = out.replace(/(\d+(?:\.\d+)?)\s*C\b/g, '$1 degrees Celsius');

  // Common mixed-number fractions, e.g. "1 1/2" -> "one and a half".
  out = out.replace(/\b1\s+1\/2\b/g, 'one and a half');
  out = out.replace(/\b1\s+1\/4\b/g, 'one and a quarter');
  out = out.replace(/\b1\s+3\/4\b/g, 'one and three quarters');

  // Common simple fractions.
  for (const [fraction, words] of Object.entries(FRACTION_WORDS)) {
    const escaped = fraction.replace('/', '\\/');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), words);
  }

  // Collapse whitespace and trim.
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}
