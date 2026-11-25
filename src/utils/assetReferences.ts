/**
 * R5 — recipe image-reference extraction and persistence validation.
 *
 * The recipe's structured `image` field is not the only place an image can
 * live. Markdown body images, reference-style images, Obsidian embeds, HTML
 * images and frontmatter image aliases all survive serialization. Before a
 * writable recipe is persisted, every supported Vault-local reference in the
 * exact Markdown that will be written must pass destination ownership/existence
 * validation.
 *
 * The extractor is deliberately syntax-aware:
 *   - fenced and inline code are masked first,
 *   - only image syntax is extracted (ordinary links are ignored),
 *   - Obsidian note embeds are ignored unless the target is image-like,
 *   - frontmatter/dataview image aliases are included.
 */

import { load as yamlLoad } from 'js-yaml';
import { serializeRecipePreservingContent } from './markdownParser';
import {
  cleanImageReference,
  isImageFile,
  validateVaultAssetReference,
  type AssetReferenceValidationDeps,
} from './vaultAssets';
import { isVaultLocalImageReference } from './assetProvenance';
import type { ObsidianRecipe } from '../types';

export type ImageReferenceForm =
  | 'structured'
  | 'frontmatter'
  | 'dataview'
  | 'markdown'
  | 'reference'
  | 'wikilink'
  | 'html';

export interface ExtractedImageReference {
  reference: string;
  form: ImageReferenceForm;
}

export type RecipeAssetValidationDeps = AssetReferenceValidationDeps;

export interface RecipeAssetValidationResult {
  ok: boolean;
  reason?: string;
  references?: string[];
  invalidReferences?: string[];
  kinds?: string[];
}

const FRONTMATTER_IMAGE_KEYS = new Set([
  'image',
  'cover',
  'thumbnail',
  'photo',
  'heroimage',
  'banner',
]);

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Masks fenced code blocks, respecting fence character/length and escapes. */
function maskFencedCode(markdown: string): string {
  const lines = markdown.split('\n');
  let fenceChar: string | null = null;
  let fenceLength = 0;
  return lines
    .map((line) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        const char = marker[0];
        if (fenceChar === null) {
          fenceChar = char;
          fenceLength = marker.length;
          return '';
        }
        if (char === fenceChar && marker.length >= fenceLength) {
          fenceChar = null;
          fenceLength = 0;
          return '';
        }
      }
      return fenceChar === null ? line : '';
    })
    .join('\n');
}

/** Masks CommonMark inline code spans; escaped backticks remain active text. */
function maskInlineCode(markdown: string): string {
  const chars = markdown.split('');
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '`' || isEscaped(markdown, i)) {
      i += 1;
      continue;
    }
    let runLength = 1;
    while (i + runLength < chars.length && chars[i + runLength] === '`') runLength += 1;
    let search = i + runLength;
    let close = -1;
    while (search < chars.length) {
      if (markdown[search] === '`' && !isEscaped(markdown, search)) {
        let closeRun = 1;
        while (search + closeRun < chars.length && markdown[search + closeRun] === '`') closeRun += 1;
        if (closeRun === runLength) {
          close = search + closeRun;
          break;
        }
        search += closeRun;
        continue;
      }
      search += 1;
    }
    if (close < 0) {
      i += runLength;
      continue;
    }
    for (let j = i; j < close; j += 1) {
      if (chars[j] !== '\n' && chars[j] !== '\r') chars[j] = ' ';
    }
    i = close;
  }
  return chars.join('');
}

function maskCode(markdown: string): string {
  return maskInlineCode(maskFencedCode(markdown));
}

function unquote(value: string): string {
  let clean = value.trim();
  if (
    (clean.startsWith('"') && clean.endsWith('"')) ||
    (clean.startsWith("'") && clean.endsWith("'"))
  ) {
    clean = clean.slice(1, -1).trim();
  }
  clean = clean.replace(/^<(.+)>$/, '$1').trim();
  return clean;
}

function addReference(
  out: ExtractedImageReference[],
  raw: string | undefined,
  form: ImageReferenceForm,
  options?: { requireImageLike?: boolean }
): void {
  if (!raw) return;
  const decoded = cleanImageReference(unquote(raw));
  if (!decoded || decoded === 'undefined' || decoded === 'null') return;
  if (decoded.startsWith('#')) return;
  if (options?.requireImageLike && !isVaultLocalImageReference(decoded) && !isImageFile(decoded)) {
    return;
  }
  out.push({ reference: decoded, form });
}

function collectYamlImageValues(
  value: unknown,
  out: ExtractedImageReference[],
  issues: string[]
): void {
  if (typeof value === 'string') {
    const lines = value.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) addReference(out, trimmed, 'frontmatter');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectYamlImageValues(item, out, issues);
    return;
  }
  if (value && typeof value === 'object') {
    // Supported shape for a structured image field (e.g. { src: Assets/x.png }).
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectYamlImageValues(item, out, issues);
    }
    return;
  }
  if (value !== null && value !== undefined) {
    issues.push('A frontmatter image property has a non-text value that cannot be verified.');
  }
}

function scanFrontmatter(
  markdown: string,
  out: ExtractedImageReference[],
  issues: string[]
): string {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return markdown;
  let parsed: unknown;
  try {
    parsed = yamlLoad(match[1]);
  } catch {
    issues.push('The recipe frontmatter could not be parsed, so its image references cannot be verified.');
    return markdown.slice(match[0].length);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!FRONTMATTER_IMAGE_KEYS.has(key.toLowerCase())) continue;
      collectYamlImageValues(value, out, issues);
    }
  }
  return markdown.slice(match[0].length);
}

/** Finds the matching ')' for a Markdown image destination starting at `open`. */
function findClosingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (ch === '\n') {
      return -1;
    }
  }
  return -1;
}

function findMatchingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (text[i] === '\n') {
      return -1;
    }
  }
  return -1;
}

function looksLikeLocalImageSyntax(content: string): boolean {
  const head = content.slice(0, 300);
  return /^\s*(?:<)?(?:\.{0,2}\/)?(?:assets|attachments)\//i.test(head) ||
    /\.(?:png|jpe?g|webp|avif|gif|svg|bmp|ico|tiff)(?:[\s)>"']|$)/i.test(head);
}

function parseMarkdownDestination(content: string): string {
  let destination = content.trim();
  if (destination.startsWith('<')) {
    const close = destination.indexOf('>');
    if (close >= 0) return destination.slice(1, close).trim();
  }
  // Optional title after the destination: `path "title"`, `path 'title'`,
  // `path (title)`. Paths with spaces are accepted when no title is present.
  const titleMatch = destination.match(/^(.+?)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/);
  if (titleMatch) destination = titleMatch[1].trim();
  return destination;
}

function scanMarkdownAndReferences(
  markdown: string,
  out: ExtractedImageReference[],
  issues: string[]
): void {
  const definitions = new Map<string, string>();
  const definitionRe = /^[ \t]{0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm;
  for (const match of markdown.matchAll(definitionRe)) {
    const label = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
    // The first definition wins, matching standard Markdown reference resolution.
    if (label && !definitions.has(label)) definitions.set(label, match[2].trim());
  }

  const usedReferenceLabels: string[] = [];

  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown[i] !== '!' || markdown[i + 1] !== '[') continue;
    // Escaped image marker.
    let slashes = 0;
    for (let j = i - 1; j >= 0 && markdown[j] === '\\'; j -= 1) slashes += 1;
    if (slashes % 2 === 1) continue;

    // Obsidian embed: ![[target]], ![[target|alias]]
    if (markdown[i + 2] === '[') {
      const close = markdown.indexOf(']]', i + 3);
      if (close < 0) continue;
      const inner = markdown.slice(i + 3, close);
      const target = inner.split('|')[0].trim();
      addReference(out, target, 'wikilink', { requireImageLike: true });
      i = close + 1;
      continue;
    }

    // Markdown image. Find the matching ']' of the alt text, allowing nested
    // brackets in alt text and respecting escapes.
    const altClose = findMatchingBracket(markdown, i + 1);
    if (altClose < 0) continue;

    if (markdown[altClose + 1] === '(') {
      const close = findClosingParen(markdown, altClose + 1);
      if (close < 0) {
        if (looksLikeLocalImageSyntax(markdown.slice(altClose + 2))) {
          issues.push('An image reference has an unclosed Markdown destination and cannot be verified.');
        }
        continue;
      }
      const destination = parseMarkdownDestination(markdown.slice(altClose + 2, close));
      addReference(out, destination, 'markdown');
      i = close;
      continue;
    }
    if (markdown[altClose + 1] === '[') {
      const labelClose = findMatchingBracket(markdown, altClose + 1);
      if (labelClose < 0) continue;
      const label = markdown
        .slice(altClose + 2, labelClose)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
      const resolvedLabel = label || markdown.slice(i + 2, altClose).trim().toLowerCase().replace(/\s+/g, ' ');
      if (resolvedLabel) usedReferenceLabels.push(resolvedLabel);
      i = labelClose;
      continue;
    }

    // Shortcut reference image: ![label]
    const shortcut = markdown.slice(i + 2, altClose).trim().toLowerCase().replace(/\s+/g, ' ');
    if (shortcut) usedReferenceLabels.push(shortcut);
  }

  for (const label of usedReferenceLabels) {
    const destination = definitions.get(label);
    if (destination) addReference(out, destination, 'reference');
  }

  // HTML <img src="...">
  const imgRe = /<img\b[^>]*>/gi;
  for (const match of markdown.matchAll(imgRe)) {
    const src = match[0].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!src) continue;
    addReference(out, src[1] || src[2] || src[3], 'html');
  }

  // Dataview-style inline fields: `[image:: Assets/x.png]` / `image:: ...`.
  const dataviewRe = /(?:^|\s)\[?([A-Za-z0-9_-]+)::\s*([^\]\n]+)\]?/gm;
  for (const match of markdown.matchAll(dataviewRe)) {
    if (!FRONTMATTER_IMAGE_KEYS.has(match[1].toLowerCase())) continue;
    addReference(out, match[2].trim(), 'dataview');
  }
}

export interface ExtractedImageReferencesResult {
  references: ExtractedImageReference[];
  issues: string[];
}

/**
 * Extracts supported image references from the exact Markdown representation
 * and reports syntax it cannot verify. Code blocks/spans are masked; ordinary
 * links are not images and are ignored.
 */
export function extractImageReferencesDetailed(markdown: string): ExtractedImageReferencesResult {
  if (!markdown) return { references: [], issues: [] };
  const out: ExtractedImageReference[] = [];
  const issues: string[] = [];
  const body = scanFrontmatter(markdown, out, issues);
  const masked = maskCode(body);
  scanMarkdownAndReferences(masked, out, issues);

  // Deduplicate by EXACT normalized reference (case-sensitive path identity).
  const seen = new Set<string>();
  const references = out.filter((entry) => {
    const key = entry.reference;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { references, issues };
}

export function extractImageReferences(markdown: string): ExtractedImageReference[] {
  return extractImageReferencesDetailed(markdown).references;
}

/**
 * Validates every supported image reference in the recipe against the
 * DESTINATION Vault. The serialized Markdown is authoritative: it is the exact
 * text the canonical writers persist.
 */
export async function validateRecipeAssetReferences(
  deps: AssetReferenceValidationDeps,
  recipe: Partial<ObsidianRecipe>
): Promise<RecipeAssetValidationResult> {
  // Fail closed when the source Markdown cannot be parsed safely. A malformed
  // frontmatter block must never be silently dropped or treated as an empty
  // frontmatter with no references.
  if (typeof recipe.rawMarkdown === 'string') {
    const fmMatch = recipe.rawMarkdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (fmMatch) {
      try {
        const parsed = yamlLoad(fmMatch[1]);
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
          throw new Error('Invalid frontmatter');
        }
      } catch {
        return {
          ok: false,
          reason: 'The recipe contains malformed YAML frontmatter. The recipe was not saved.',
        };
      }
    }
  }

  let markdown: string;
  try {
    markdown = serializeRecipePreservingContent(recipe);
  } catch {
    return {
      ok: false,
      reason: 'The recipe image references could not be prepared for validation. The recipe was not saved.',
    };
  }

  const extractedResult = extractImageReferencesDetailed(markdown);
  if (extractedResult.issues.length > 0) {
    return {
      ok: false,
      reason: `${extractedResult.issues[0]} The recipe was not saved.`,
      references: extractedResult.references.map((entry) => entry.reference),
    };
  }
  const extracted = extractedResult.references;
  if (recipe.image && typeof recipe.image === 'string' && recipe.image.trim()) {
    const structured = cleanImageReference(recipe.image);
    if (structured && !extracted.some((entry) => entry.reference === structured)) {
      extracted.unshift({ reference: structured, form: 'structured' });
    }
  }

  const references: string[] = [];
  const invalidReferences: string[] = [];
  const kinds: string[] = [];
  let firstReason: string | undefined;

  for (const entry of extracted) {
    references.push(entry.reference);
    const result = await validateVaultAssetReference(deps, entry.reference, {
      alreadyDecoded: true,
    });
    if (!result.ok) {
      invalidReferences.push(entry.reference);
      if (result.kind) kinds.push(result.kind);
      if (!firstReason) firstReason = result.reason;
    }
  }

  if (invalidReferences.length > 0) {
    const detail =
      invalidReferences.length === 1
        ? `“${invalidReferences[0]}”`
        : `${invalidReferences.length} image references`;
    const reason =
      firstReason ||
      `This recipe contains ${detail} that could not be verified in the active Vault. The recipe was not saved.`;
    return {
      ok: false,
      reason:
        invalidReferences.length === 1
          ? reason
          : `${reason} (${invalidReferences.slice(0, 3).join(', ')}${invalidReferences.length > 3 ? '…' : ''})`,
      references,
      invalidReferences,
      kinds,
    };
  }

  return { ok: true, references };
}
