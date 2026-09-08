import { describe, it, expect } from 'vitest';
import { ObsidianVaultAdapter } from '../../src/platform/obsidian/ObsidianVaultAdapter';

// --- Hand-rolled Obsidian Vault fake (duck-typed, no runtime Obsidian import) ---

class FakeFile {
  readonly extension = 'md';
  content: string;
  constructor(public readonly path: string, content: string) {
    this.content = content;
  }
  get name(): string {
    return this.path.split('/').pop() ?? this.path;
  }
}

class FakeFolder {
  readonly children: unknown[] = [];
  constructor(public readonly path: string) {}
  get name(): string {
    return this.path.split('/').pop() ?? this.path;
  }
}

class FakeVault {
  files = new Map<string, FakeFile>();
  folders = new Map<string, FakeFolder>();

  getMarkdownFiles(): FakeFile[] {
    return Array.from(this.files.values()).filter((f) => f.extension === 'md');
  }

  getAbstractFileByPath(path: string): FakeFile | FakeFolder | null {
    return this.files.get(path) ?? this.folders.get(path) ?? null;
  }

  async read(file: FakeFile): Promise<string> {
    return file.content;
  }

  async modify(file: FakeFile, content: string): Promise<void> {
    file.content = content;
  }

  async create(path: string, content: string): Promise<FakeFile> {
    const file = new FakeFile(path, content);
    this.files.set(path, file);
    return file;
  }

  async createFolder(path: string): Promise<FakeFolder> {
    const folder = new FakeFolder(path);
    this.folders.set(path, folder);
    return folder;
  }

  async delete(file: FakeFile): Promise<void> {
    this.files.delete(file.path);
  }
}

function makeVault(initial?: Record<string, string>): FakeVault {
  const vault = new FakeVault();
  for (const [path, content] of Object.entries(initial ?? {})) {
    const segments = path.split('/');
    let current = '';
    for (const seg of segments.slice(0, -1)) {
      current = current ? `${current}/${seg}` : seg;
      if (!vault.folders.has(current)) vault.folders.set(current, new FakeFolder(current));
    }
    vault.files.set(path, new FakeFile(path, content));
  }
  return vault;
}

const RECIPE_MD = '---\ntitle: Test\n---\n# Ingredients\n- garlic\n';

describe('ObsidianVaultAdapter (Phase 4D3B)', () => {
  it('lists Markdown files, preserving nested vault-relative paths', async () => {
    const vault = makeVault({
      'Recipes/Italian/Lasagna.md': 'lasagna',
      'Chicken Soup.md': 'soup',
    });
    const adapter = new ObsidianVaultAdapter(vault as never);
    const files = await adapter.listMarkdownFiles();
    expect(files.map((f) => f.path)).toEqual(['Chicken Soup.md', 'Recipes/Italian/Lasagna.md']);
    expect(files.find((f) => f.path === 'Recipes/Italian/Lasagna.md')?.name).toBe('Lasagna.md');
  });

  it('reads a nested recipe by its vault-relative path', async () => {
    const vault = makeVault({ 'Recipes/Italian/Lasagna.md': RECIPE_MD });
    const adapter = new ObsidianVaultAdapter(vault as never);
    expect(await adapter.readText('Recipes/Italian/Lasagna.md')).toBe(RECIPE_MD);
  });

  it('creates a new file and its missing parent folders', async () => {
    const vault = makeVault();
    const adapter = new ObsidianVaultAdapter(vault as never);
    await adapter.writeText('Recipes/Soups/Bean Soup.md', RECIPE_MD);
    expect(vault.files.has('Recipes/Soups/Bean Soup.md')).toBe(true);
    expect(vault.files.get('Recipes/Soups/Bean Soup.md')?.content).toBe(RECIPE_MD);
    expect(vault.folders.has('Recipes')).toBe(true);
    expect(vault.folders.has('Recipes/Soups')).toBe(true);
  });

  it('modifies an existing file in place (preserving nested path)', async () => {
    const vault = makeVault({ 'Recipes/Italian/Lasagna.md': RECIPE_MD });
    const adapter = new ObsidianVaultAdapter(vault as never);
    await adapter.writeText('Recipes/Italian/Lasagna.md', '# New body');
    expect(vault.files.get('Recipes/Italian/Lasagna.md')?.content).toBe('# New body');
    expect(vault.files.size).toBe(1);
    expect(vault.files.get('Recipes/Italian/Lasagna.md')?.path).toBe('Recipes/Italian/Lasagna.md');
  });

  it('deletes a file at its nested path', async () => {
    const vault = makeVault({ 'Recipes/Italian/Lasagna.md': RECIPE_MD });
    const adapter = new ObsidianVaultAdapter(vault as never);
    await adapter.delete('Recipes/Italian/Lasagna.md');
    expect(vault.files.has('Recipes/Italian/Lasagna.md')).toBe(false);
  });

  it('reports exists() true for a file, false for a missing file and for a folder', async () => {
    const vault = makeVault({ 'Recipes/Italian/Lasagna.md': RECIPE_MD });
    const adapter = new ObsidianVaultAdapter(vault as never);
    expect(await adapter.exists('Recipes/Italian/Lasagna.md')).toBe(true);
    expect(await adapter.exists('Recipes/Italian/Gone.md')).toBe(false);
  });

  it('rejects unsafe paths (absolute / traversal)', async () => {
    const vault = makeVault();
    const adapter = new ObsidianVaultAdapter(vault as never);
    await expect(adapter.readText('/etc/passwd')).rejects.toThrow('Absolute vault paths are not allowed');
    await expect(adapter.writeText('../escape.md', 'x')).rejects.toThrow('Invalid vault path segment');
    await expect(adapter.writeText('Recipes//x.md', 'x')).rejects.toThrow('Invalid vault path segment');
  });

  it('throws an Obsidian-shaped NotFoundError when reading a missing file', async () => {
    const vault = makeVault();
    const adapter = new ObsidianVaultAdapter(vault as never);
    const promise = adapter.readText('Missing.md');
    await expect(promise).rejects.toMatchObject({ name: 'NotFoundError', code: 'NotFoundError' });
  });
});
