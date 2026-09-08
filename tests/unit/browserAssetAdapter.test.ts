import { describe, it, expect } from 'vitest';
import { BrowserAssetAdapter } from '../../src/platform/browser/BrowserAssetAdapter';

// --- Hand-rolled FSA fake (duck-typed, no browser globals) ---

class FakeFile {
  content: Uint8Array;
  constructor(public readonly path: string, content: Uint8Array) {
    this.content = content;
  }
  get name(): string {
    return this.path.split('/').pop() ?? this.path;
  }
  async getFile() {
    return { arrayBuffer: async () => this.content.buffer.slice(0, this.content.byteLength) as ArrayBuffer };
  }
  async createWritable() {
    return {
      write: async (data: Uint8Array) => {
        this.content = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(await (data as Blob).arrayBuffer());
      },
      close: async () => {},
      abort: async () => {},
    };
  }
}

/** A single shared FSA backend: files/folders are keyed by full vault path. */
interface FakeBackend {
  files: Map<string, FakeFile>;
  folders: Set<string>;
}

class FakeDirHandle {
  files = this.backend.files;
  folders = this.backend.folders;

  constructor(public readonly prefix: string, private readonly backend: FakeBackend) {}

  private key(name: string): string {
    return this.prefix ? `${this.prefix}/${name}` : name;
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean }): Promise<FakeDirHandle> {
    const key = this.key(name);
    if (this.folders.has(key) || opts.create) {
      this.folders.add(key);
      return new FakeDirHandle(key, this.backend);
    }
    throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
  }

  async getFileHandle(name: string, opts: { create?: boolean }): Promise<FakeFile> {
    const key = this.key(name);
    const file = this.files.get(key);
    if (file) return file;
    if (opts.create) {
      const created = new FakeFile(key, new Uint8Array(0));
      this.files.set(key, created);
      return created;
    }
    throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(this.key(name));
  }
}

function makeRoot(initial?: Record<string, Uint8Array>) {
  const backend: FakeBackend = { files: new Map(), folders: new Set() };
  for (const [path, bytes] of Object.entries(initial ?? {})) {
    backend.files.set(path, new FakeFile(path, bytes));
    // Register every parent folder prefix so create:false lookups succeed.
    const segments = path.split('/');
    let prefix = '';
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      backend.folders.add(prefix);
    }
  }
  return new FakeDirHandle('', backend);
}

const mk = (s: string) => new TextEncoder().encode(s);

describe('BrowserAssetAdapter (Phase 4D3D)', () => {
  it('reads raw bytes by vault-relative path (binary fidelity)', async () => {
    const root = makeRoot({ 'Assets/photo.png': mk('FAKEBINARY') });
    const adapter = new BrowserAssetAdapter(root as never);
    const bytes = await adapter.read('Assets/photo.png');
    expect(new TextDecoder().decode(bytes)).toBe('FAKEBINARY');
  });

  it('writes bytes to a nested asset path, creating parent folders', async () => {
    const root = makeRoot();
    const adapter = new BrowserAssetAdapter(root as never);
    await adapter.write('Assets/new.png', mk('DATA'), 'image/png');
    const bytes = await adapter.read('Assets/new.png');
    expect(new TextDecoder().decode(bytes)).toBe('DATA');
  });

  it('infers the extension from content-type when the path has no extension', async () => {
    const root = makeRoot();
    const adapter = new BrowserAssetAdapter(root as never);
    await adapter.write('Assets/photo', mk('DATA'), 'image/webp');
    const bytes = await adapter.read('Assets/photo.webp');
    expect(new TextDecoder().decode(bytes)).toBe('DATA');
  });

  it('overwrites an existing asset in place', async () => {
    const root = makeRoot({ 'Assets/photo.jpg': mk('OLD') });
    const adapter = new BrowserAssetAdapter(root as never);
    await adapter.write('Assets/photo.jpg', mk('NEW'), 'image/jpeg');
    expect(new TextDecoder().decode(await adapter.read('Assets/photo.jpg'))).toBe('NEW');
  });

  it('reports exists() correctly', async () => {
    const root = makeRoot({ 'Assets/photo.jpg': mk('X') });
    const adapter = new BrowserAssetAdapter(root as never);
    expect(await adapter.exists('Assets/photo.jpg')).toBe(true);
    expect(await adapter.exists('Assets/missing.jpg')).toBe(false);
  });

  it('deletes an asset', async () => {
    const root = makeRoot({ 'Assets/photo.jpg': mk('X') });
    const adapter = new BrowserAssetAdapter(root as never);
    await adapter.delete('Assets/photo.jpg');
    expect(await adapter.exists('Assets/photo.jpg')).toBe(false);
  });

  it('rejects unsafe paths (absolute / traversal / empty segment)', async () => {
    const root = makeRoot();
    const adapter = new BrowserAssetAdapter(root as never);
    await expect(adapter.read('/etc/passwd')).rejects.toThrow('Absolute asset paths are not allowed');
    await expect(adapter.write('../escape.jpg', mk('X'))).rejects.toThrow('Invalid asset path segment');
    await expect(adapter.write('Assets//x.jpg', mk('X'))).rejects.toThrow('Invalid asset path segment');
  });
});
