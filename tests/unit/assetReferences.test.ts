import { describe, expect, it, vi } from 'vitest';
import {
  extractImageReferences,
  extractImageReferencesDetailed,
  validateRecipeAssetReferences,
} from '../../src/utils/assetReferences';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { ObsidianRecipe } from '../../src/types';
import { parseObsidianRecipeMarkdown } from '../../src/utils/markdownParser';

const MD = `---
title: Test Recipe
image: Assets/front.png
cover: "Assets/cover.png"
---
# Test Recipe

![inline](Assets/inline.png)

![encoded](Assets/My%20Photo.png)

![[Assets/embed.png|300]]

![reference][photo]

[photo]: Assets/reference.png "A title"

<img src="Assets/html.png" alt="html" />

[ordinary link](Assets/not-an-image-reference.png)

\`![inline code](Assets/code-inline.png)\`

\`\`\`
![fenced](Assets/code-fence.png)
\`\`\`

## Ingredients
- 1 cup flour

## Instructions
1. Mix.
`;

function makeDeps(existing: string[]): { deps: { asset: AssetAdapter }; exists: ReturnType<typeof vi.fn> } {
  const files = new Set(existing);
  const exists = vi.fn(async (path: string) => files.has(path));
  return {
    exists,
    deps: {
      asset: {
        exists,
        read: vi.fn(async () => new Uint8Array()),
        write: vi.fn(async () => {}),
        writeExclusive: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      } as unknown as AssetAdapter,
    },
  };
}

describe('R5 Markdown image reference extraction', () => {
  it('extracts every supported image representation and ignores code/ordinary links', () => {
    const refs = extractImageReferences(MD).map((entry) => entry.reference);
    expect(refs).toContain('Assets/front.png');
    expect(refs).toContain('Assets/cover.png');
    expect(refs).toContain('Assets/inline.png');
    expect(refs).toContain('Assets/My Photo.png');
    expect(refs).toContain('Assets/embed.png');
    expect(refs).toContain('Assets/reference.png');
    expect(refs).toContain('Assets/html.png');
    expect(refs).not.toContain('Assets/not-an-image-reference.png');
    expect(refs).not.toContain('Assets/code-inline.png');
    expect(refs).not.toContain('Assets/code-fence.png');
  });

  it('handles Obsidian note embeds as non-image references', () => {
    const refs = extractImageReferences('![[Some Note]]\n![[Assets/real.png]]');
    expect(refs.map((entry) => entry.reference)).toEqual(['Assets/real.png']);
  });

  it('handles angle-bracket reference definitions with spaces', () => {
    const refs = extractImageReferences(
      '![x][photo]\n\n[photo]: <Assets/With Space.png> "title"'
    ).map((entry) => entry.reference);
    expect(refs).toEqual(['Assets/With Space.png']);
  });

  it('handles angle-bracket destinations and paths with spaces', () => {
    const refs = extractImageReferences(
      '![a](<Assets/With Space.png>)\n![b](Assets/Raw Space.png)\n![c](Assets/titled.png "title")'
    ).map((entry) => entry.reference);
    expect(refs).toEqual(['Assets/With Space.png', 'Assets/Raw Space.png', 'Assets/titled.png']);
  });

  it('validates case-distinct paths independently and never folds them', async () => {
    const { deps, exists } = makeDeps(['Assets/Photo.png']);
    const result = await validateRecipeAssetReferences(deps, {
      title: 'Case paths',
      description: '![one](Assets/Photo.png)\n\n![two](Assets/photo.png)',
    } as Partial<ObsidianRecipe>);
    expect(result.ok).toBe(false);
    expect(result.invalidReferences).toEqual(['Assets/photo.png']);
    expect(exists).toHaveBeenCalledWith('Assets/Photo.png');
    expect(exists).toHaveBeenCalledWith('Assets/photo.png');
  });

  it('validates multiline YAML frontmatter sequences and scalars', async () => {
    const { deps, exists } = makeDeps([]);
    const sequence = await validateRecipeAssetReferences(deps, {
      title: 'YAML sequence',
      frontmatter: { cover: ['Assets/only-a.png', 'Assets/only-b.png'] },
      image: 'Assets/only-a.png',
    } as Partial<ObsidianRecipe>);
    expect(sequence.ok).toBe(false);
    expect(sequence.invalidReferences).toContain('Assets/only-a.png');
    expect(sequence.invalidReferences).toContain('Assets/only-b.png');

    const scalar = await validateRecipeAssetReferences(deps, {
      title: 'YAML scalar',
      frontmatter: { cover: 'Assets/only-a.png\nAssets/only-b.png' },
    } as Partial<ObsidianRecipe>);
    expect(scalar.ok).toBe(false);
    expect(scalar.invalidReferences).toContain('Assets/only-a.png');
    expect(scalar.invalidReferences).toContain('Assets/only-b.png');
    expect(exists).toHaveBeenCalled();
  });

  it('treats escaped backticks as active syntax but real code spans as code', async () => {
    const { deps, exists } = makeDeps([]);
    const escaped = await validateRecipeAssetReferences(deps, {
      title: 'Escaped backtick',
      description: '\\`![A](Assets/only-a.png)\\`',
    } as Partial<ObsidianRecipe>);
    expect(escaped.ok).toBe(false);
    expect(escaped.invalidReferences).toContain('Assets/only-a.png');

    const code = await validateRecipeAssetReferences(deps, {
      title: 'Code span',
      description: '`![A](Assets/only-a.png)`',
    } as Partial<ObsidianRecipe>);
    expect(code.ok).toBe(true);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('validates images with nested alt-text brackets', async () => {
    const { deps } = makeDeps([]);
    const result = await validateRecipeAssetReferences(deps, {
      title: 'Nested alt',
      description: '![a [nested] alt](Assets/only-a.png)',
    } as Partial<ObsidianRecipe>);
    expect(result.ok).toBe(false);
    expect(result.invalidReferences).toContain('Assets/only-a.png');
  });

  it('decodes percent-encoded paths exactly once', async () => {
    const { deps, exists } = makeDeps(['Assets/My%20Photo.png']);
    const result = await validateRecipeAssetReferences(deps, {
      title: 'Decoded once',
      description: '![encoded](Assets/My%2520Photo.png)',
    } as Partial<ObsidianRecipe>);
    expect(result.ok).toBe(true);
    expect(exists).toHaveBeenCalledWith('Assets/My%20Photo.png');
  });

  it('validates image references inside unknown custom sections that the preserving writer retains', async () => {
    const raw = `---
title: Custom
---
# Custom

## Ingredients
- 1 cup stock

## Equipment
- Dutch oven
- ![Equipment photo](Assets/only-a.png)

## Custom Footer
Keep me.
`;
    const { deps, exists } = makeDeps([]);
    const result = await validateRecipeAssetReferences(deps, {
      title: 'Custom',
      rawMarkdown: raw,
    } as Partial<ObsidianRecipe>);
    expect(result.ok).toBe(false);
    expect(result.invalidReferences).toContain('Assets/only-a.png');
    expect(exists).toHaveBeenCalledWith('Assets/only-a.png');
  });

  it('reports malformed frontmatter syntax instead of silently accepting it', () => {
    const result = extractImageReferencesDetailed(
      '---\ntitle: Broken\ncover: [unclosed\n---\n# Broken\n'
    );
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toMatch(/frontmatter could not be parsed/i);
  });

  it('validates frontmatter, body, reference-style, wikilink and HTML references', async () => {
    const { deps } = makeDeps([
      'Assets/front.png',
      'Assets/cover.png',
      'Assets/inline.png',
      'Assets/My Photo.png',
      'Assets/embed.png',
      'Assets/reference.png',
      'Assets/html.png',
    ]);
    const recipe = {
      title: 'Body references',
      description: MD.slice(MD.indexOf('# Test Recipe')),
      image: 'Assets/front.png',
      frontmatter: { cover: 'Assets/cover.png' },
      ingredients: [{ name: 'flour', amount: '1', unit: 'cup' }],
      instructions: [{ stepNumber: 1, text: 'Mix.' }],
    } as unknown as Partial<ObsidianRecipe>;
    const result = await validateRecipeAssetReferences(deps, recipe);
    expect(result.ok).toBe(true);
  });

  it('rejects an A-only Markdown body reference in B before any write', async () => {
    const { deps, exists } = makeDeps(['Assets/in-b.png']);
    const recipe = {
      title: 'Foreign body image',
      description: '![A only](Assets/only-a.png)',
      image: 'Assets/in-b.png',
    } as Partial<ObsidianRecipe>;
    const result = await validateRecipeAssetReferences(deps, recipe);
    expect(result.ok).toBe(false);
    expect(result.invalidReferences).toContain('Assets/only-a.png');
    expect(result.reason).toMatch(/not present in the active Vault/i);
    expect(exists).toHaveBeenCalledWith('Assets/only-a.png');
  });

  it('rejects a body Obsidian image embed that is absent in B', async () => {
    const { deps } = makeDeps([]);
    const result = await validateRecipeAssetReferences(deps, {
      title: 'Embed',
      description: '![[Assets/only-a.png]]',
    } as Partial<ObsidianRecipe>);
    expect(result.ok).toBe(false);
    expect(result.invalidReferences).toContain('Assets/only-a.png');
  });

  it('rejects a used reference-style image but ignores an unused definition', async () => {
    const { deps } = makeDeps([]);
    const rejected = await validateRecipeAssetReferences(deps, {
      title: 'Reference',
      description: '![used][a]\n\n[a]: Assets/only-a.png',
    } as Partial<ObsidianRecipe>);
    expect(rejected.ok).toBe(false);
    expect(rejected.invalidReferences).toContain('Assets/only-a.png');

    const unused = await validateRecipeAssetReferences(deps, {
      title: 'Reference',
      description: '[a]: Assets/unused.png',
    } as Partial<ObsidianRecipe>);
    expect(unused.ok).toBe(true);
  });

  it('accepts valid remote/data references under existing policy', async () => {
    const { deps } = makeDeps([]);
    const result = await validateRecipeAssetReferences(deps, {
      title: 'Remote',
      image: 'https://example.com/photo.jpg',
      description: '![data](data:image/png;base64,aGVsbG8=)',
    } as Partial<ObsidianRecipe>);
    expect(result.ok).toBe(true);
  });

  it('rejects temporary/unknown blob references at the persistence boundary', async () => {
    const { deps } = makeDeps([]);
    const temporary = await validateRecipeAssetReferences(deps, {
      title: 'Preview',
      image: 'blob:http://localhost/temporary-preview',
    } as Partial<ObsidianRecipe>);
    expect(temporary.ok).toBe(false);
    expect(temporary.kinds).toContain('unknown-blob');
    expect(temporary.reason).toMatch(/preview|owned/i);
  });

  it('a read-only imported recipe retains its text, but writable validation rejects a foreign asset', async () => {
    const imported = parseObsidianRecipeMarkdown(
      `---
title: Imported Soup
---
# Imported Soup
![A only](Assets/only-a.png)
## Ingredients
- 1 cup stock
## Instructions
1. Simmer.
`,
      'Imported Soup.md',
      'Imported Soup.md'
    );
    // Read-only display retains the original body text.
    expect(imported.description).toContain('Assets/only-a.png');

    const { deps } = makeDeps([]);
    const writableValidation = await validateRecipeAssetReferences(deps, imported);
    expect(writableValidation.ok).toBe(false);
    expect(writableValidation.invalidReferences).toContain('Assets/only-a.png');
  });

  it('does not treat code-block image text as a reference', async () => {
    const { deps } = makeDeps([]);
    const result = await validateRecipeAssetReferences(deps, {
      title: 'Code only',
      description: '```\n![x](Assets/only-a.png)\n```',
    } as Partial<ObsidianRecipe>);
    expect(result.ok).toBe(true);
  });

  it('preserves ordinary links and does not validate them', async () => {
    const { deps } = makeDeps([]);
    const result = await validateRecipeAssetReferences(deps, {
      title: 'Links',
      description: '[a normal link](Assets/not-an-image.png)',
    } as Partial<ObsidianRecipe>);
    expect(result.ok).toBe(true);
  });
});
