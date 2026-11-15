/**
 * The Kitchen Codex — renderer-side native Vault handle.
 *
 * Implements the small structural subset of FileSystemDirectoryHandle used by
 * the existing VaultAdapter/asset pipeline, backed exclusively by the narrow
 * preload IPC bridge. No Node APIs are reachable from the renderer.
 */

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  getAppInfo(): Promise<{ version: string; platform: string; isPackaged: boolean; userData: string }>;
  getVaultInfo(): Promise<DesktopVaultInfo | null>;
  ensureManagedVault(): Promise<DesktopVaultInfo>;
  chooseVaultDirectory(): Promise<DesktopVaultInfo | null>;
  setActiveVault(root: string): Promise<DesktopVaultInfo>;
  /** Opens the current accepted Vault; the renderer cannot supply a path. */
  openVaultFolder(): Promise<{ opened: boolean; message?: string }>;
  beginInitialization(root: string): Promise<{ action: 'claimed' | 'resume' | 'already' | 'existing'; root: string }>;
  completeInitialization(root: string): Promise<{ completed: boolean }>;
  list(root: string, relative: string): Promise<Array<{ name: string; kind: 'file' | 'directory' }>>;
  stat(root: string, relative: string): Promise<{ kind: 'file' | 'directory'; size: number; mtimeMs: number }>;
  exists(root: string, relative: string): Promise<boolean>;
  readText(root: string, relative: string): Promise<string>;
  readBinary(root: string, relative: string): Promise<string>;
  writeText(root: string, relative: string, content: string): Promise<{ written: boolean }>;
  writeBinary(root: string, relative: string, base64: string): Promise<{ written: boolean }>;
  writeTextIfUnchanged(
    root: string,
    relative: string,
    content: string,
    expected: string
  ): Promise<{ written: boolean }>;
  mkdir(root: string, relative: string): Promise<{ created: boolean }>;
  remove(root: string, relative: string): Promise<{ removed: boolean }>;
}

export interface DesktopVaultInfo {
  path: string;
  exists: boolean;
  initialized: boolean;
  initialization?: 'complete' | 'initializing' | 'unknown' | 'missing';
  hasMarkdown?: boolean;
  isManaged: boolean;
  name: string;
}

declare global {
  interface Window {
    kitchenCodexDesktop?: DesktopBridge;
    showDirectoryPicker?: (options?: unknown) => Promise<any>;
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.kitchenCodexDesktop;
  return bridge && bridge.isDesktop ? bridge : null;
}

export function isDesktopRuntime(): boolean {
  return !!getDesktopBridge();
}

function requiredBridge(): DesktopBridge {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('The native desktop Vault bridge is unavailable.');
  return bridge;
}

function notFound(relative: string): Error {
  const error = new Error(`Vault path not found: ${relative}`);
  Object.defineProperty(error, 'name', { value: 'NotFoundError' });
  Object.defineProperty(error, 'code', { value: 'NotFoundError' });
  return error;
}

function joinRelative(parent: string, name: string): string {
  const cleanName = String(name ?? '').replace(/\\/g, '/').trim();
  if (!cleanName || cleanName.includes('/') || cleanName === '.' || cleanName === '..') {
    throw new Error(`Invalid Vault entry name: ${name}`);
  }
  return parent ? `${parent}/${cleanName}` : cleanName;
}

function splitRelative(relative: string): string[] {
  const clean = String(relative ?? '').replace(/\\/g, '/').trim();
  if (!clean) return [];
  if (clean.startsWith('/')) throw new Error('Absolute Vault paths are not allowed.');
  const segments = clean.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`Invalid Vault path segment "${segment}".`);
    }
  }
  return segments;
}

function guessContentType(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'avif') return 'image/avif';
  return 'application/octet-stream';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class DesktopFileHandle {
  readonly kind = 'file' as const;
  constructor(
    private readonly bridge: DesktopBridge,
    public readonly root: string,
    public readonly path: string,
    public readonly name: string
  ) {}

  async getFile(): Promise<File> {
    const bytes = base64ToBytes(await this.bridge.readBinary(this.root, this.path));
    return new File([bytes as unknown as BlobPart], this.name, { type: guessContentType(this.name) });
  }

  async createWritable(): Promise<{
    write(data: string | Uint8Array | Blob): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    const chunks: Array<string | Uint8Array> = [];
    let hasBinary = false;
    let closed = false;
    return {
      write: async (data) => {
        if (closed) throw new Error('The writable is already closed.');
        if (typeof data === 'string') {
          chunks.push(data);
        } else if (data instanceof Blob) {
          chunks.push(new Uint8Array(await data.arrayBuffer()));
          hasBinary = true;
        } else if (data instanceof Uint8Array) {
          chunks.push(data.slice());
          hasBinary = true;
        } else {
          throw new Error('Unsupported writable data.');
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (!hasBinary) {
          await this.bridge.writeText(this.root, this.path, chunks.join(''));
          return;
        }
        const encoded = new TextEncoder();
        const byteChunks = chunks.map((chunk) =>
          typeof chunk === 'string' ? encoded.encode(chunk) : chunk
        );
        const total = byteChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of byteChunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        await this.bridge.writeBinary(this.root, this.path, bytesToBase64(bytes));
      },
      abort: async () => {
        closed = true;
        chunks.length = 0;
      },
    };
  }
}

export class DesktopDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly isDesktopVault = true;
  constructor(
    private readonly bridge: DesktopBridge,
    public readonly root: string,
    public readonly path: string,
    public readonly name: string
  ) {}

  async *values(): AsyncIterable<DesktopFileHandle | DesktopDirectoryHandle> {
    const entries = await this.bridge.list(this.root, this.path);
    for (const entry of entries) {
      const childPath = this.path ? `${this.path}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        yield new DesktopDirectoryHandle(this.bridge, this.root, childPath, entry.name);
      } else if (entry.kind === 'file') {
        yield new DesktopFileHandle(this.bridge, this.root, childPath, entry.name);
      }
    }
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<DesktopFileHandle> {
    const childPath = joinRelative(this.path, name);
    const exists = await this.bridge.exists(this.root, childPath);
    if (exists) {
      const stat = await this.bridge.stat(this.root, childPath);
      if (stat.kind === 'directory') throw new Error(`Vault path is a directory, not a file: ${childPath}`);
    } else if (!options?.create) {
      throw notFound(childPath);
    }
    return new DesktopFileHandle(this.bridge, this.root, childPath, name);
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DesktopDirectoryHandle> {
    const childPath = joinRelative(this.path, name);
    if (options?.create) {
      await this.bridge.mkdir(this.root, childPath);
    } else {
      const exists = await this.bridge.exists(this.root, childPath);
      if (!exists) throw notFound(childPath);
      const stat = await this.bridge.stat(this.root, childPath);
      if (stat.kind !== 'directory') throw new Error(`Vault path is not a directory: ${childPath}`);
    }
    return new DesktopDirectoryHandle(this.bridge, this.root, childPath, name);
  }

  async removeEntry(name: string): Promise<void> {
    await this.bridge.remove(this.root, joinRelative(this.path, name));
  }

  async queryPermission(): Promise<'granted'> {
    return 'granted';
  }

  async requestPermission(): Promise<'granted'> {
    return 'granted';
  }

  async writeTextAt(relativePath: string, content: string): Promise<void> {
    const segments = splitRelative(relativePath);
    if (segments.length === 0) throw new Error('A Vault file path is required.');
    let directory: DesktopDirectoryHandle = this;
    for (const segment of segments.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    const file = await directory.getFileHandle(segments[segments.length - 1], { create: true });
    const writable = await file.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async existsAt(relativePath: string): Promise<boolean> {
    return this.bridge.exists(this.root, relativePath);
  }
}

export function createDesktopDirectoryHandle(vaultRoot: string): DesktopDirectoryHandle {
  const root = String(vaultRoot || '').trim();
  if (!root) throw new Error('A native Vault root is required.');
  return new DesktopDirectoryHandle(requiredBridge(), root, '', root.split(/[\\/]/).filter(Boolean).pop() || 'My Recipe Vault');
}

export function isDesktopDirectoryHandle(value: unknown): value is DesktopDirectoryHandle {
  return !!value && typeof value === 'object' && (value as any).kind === 'directory' && typeof (value as any).root === 'string' && typeof (value as any).writeTextAt === 'function';
}

export function installDesktopRuntime(): void {
  const bridge = getDesktopBridge();
  if (!bridge) return;
  window.showDirectoryPicker = async () => {
    const info = await bridge.chooseVaultDirectory();
    if (!info || !info.path) {
      const error = new Error('Vault selection was cancelled.');
      Object.defineProperty(error, 'name', { value: 'AbortError' });
      throw error;
    }
    return createDesktopDirectoryHandle(info.path);
  };
}

export async function getDesktopVaultInfo(): Promise<DesktopVaultInfo | null> {
  const bridge = getDesktopBridge();
  return bridge ? bridge.getVaultInfo() : null;
}

export async function ensureDesktopManagedVault(): Promise<DesktopVaultInfo> {
  return requiredBridge().ensureManagedVault();
}

export async function beginDesktopInitialization(root: string) {
  return requiredBridge().beginInitialization(root);
}

export async function completeDesktopInitialization(root: string) {
  return requiredBridge().completeInitialization(root);
}

export async function setDesktopActiveVault(root: string): Promise<DesktopVaultInfo> {
  return requiredBridge().setActiveVault(root);
}

export async function openDesktopVaultFolder() {
  return requiredBridge().openVaultFolder();
}

export async function seedStarterCopies(
  handle: DesktopDirectoryHandle,
  starters: ReadonlyArray<{ filePath: string; rawMarkdown: string }>
): Promise<number> {
  let written = 0;
  for (const starter of starters) {
    if (await handle.existsAt(starter.filePath)) continue;
    await handle.writeTextAt(starter.filePath, starter.rawMarkdown);
    written += 1;
  }
  return written;
}
