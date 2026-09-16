/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: secure ZIP extraction policy.
 *
 * Uses synthetic zips created under a temp directory only.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = join(HERE, '..', '..', 'scripts', 'usda_bundle', 'zip_extract.py');

const workDirs: string[] = [];

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kc-zip-'));
  workDirs.push(dir);
  return dir;
}

interface Member {
  name: string;
  data?: string;
  symlink?: boolean;
}

function buildZip(path: string, members: Member[]): void {
  const script = [
    'import os, json, zipfile, stat',
    "path = os.environ['ZIP_PATH']",
    "members = json.loads(os.environ['ZIP_MEMBERS'])",
    "z = zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED)",
    'for m in members:',
    "    zi = zipfile.ZipInfo(m['name'])",
    "    if m.get('symlink'):",
    '        zi.external_attr = (stat.S_IFLNK | 0o777) << 16',
    "    z.writestr(zi, (m.get('data') or 'x').encode('utf-8'))",
    'z.close()',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script], {
    env: { ...process.env, ZIP_PATH: path, ZIP_MEMBERS: JSON.stringify(members) },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`zip build failed: ${result.stderr}`);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface ExtractResult {
  status: number;
  code: string | null;
  out: string;
}

function extract(
  archive: string,
  outDir: string,
  opts: { member?: string; sha?: string; extra?: string[] } = {}
): ExtractResult {
  const args = [
    EXTRACTOR,
    '--archive',
    archive,
    '--sha256',
    opts.sha ?? sha256(archive),
    '--member',
    opts.member ?? 'payload.json',
    '--out',
    outDir,
    ...(opts.extra ?? []),
  ];
  const result = spawnSync('python3', args, { encoding: 'utf8' });
  let code: string | null = null;
  try {
    code = JSON.parse(result.stdout || result.stderr).code ?? null;
  } catch {
    code = null;
  }
  return { status: result.status ?? -1, code, out: result.stdout };
}

afterEach(() => {
  while (workDirs.length > 0) rmSync(workDirs.pop() as string, { recursive: true, force: true });
});

describe('phase 4.5A secure ZIP extraction', () => {
  it('extracts the expected member from a valid archive', () => {
    const dir = workDir();
    const zip = join(dir, 'ok.zip');
    buildZip(zip, [{ name: 'payload.json', data: '{"ok":true}' }]);
    const out = join(dir, 'payload');
    const result = extract(zip, out);
    expect(result.status).toBe(0);
    expect(existsSync(join(out, 'payload.json'))).toBe(true);
    expect(readFileSync(join(out, 'payload.json'), 'utf8')).toBe('{"ok":true}');
  });

  it('rejects a mismatched archive digest before extraction', () => {
    const dir = workDir();
    const zip = join(dir, 'ok.zip');
    buildZip(zip, [{ name: 'payload.json', data: 'x' }]);
    const result = extract(zip, join(dir, 'out'), { sha: '0'.repeat(64) });
    expect(result.status).toBe(1);
    expect(result.code).toBe('archive_digest_mismatch');
  });

  it('rejects path traversal, absolute paths, and backslash names', () => {
    for (const name of ['../evil', '/etc/passwd', 'a\\b.json']) {
      const dir = workDir();
      const zip = join(dir, 'bad.zip');
      buildZip(zip, [{ name, data: 'x' }]);
      const result = extract(zip, join(dir, 'out'), { member: name });
      expect(result.status, name).toBe(1);
      expect(result.code, name).toBe('unsafe_member_path');
    }
  });

  it('rejects a symlink member', () => {
    const dir = workDir();
    const zip = join(dir, 'link.zip');
    buildZip(zip, [{ name: 'payload.json', data: 'x', symlink: true }]);
    const result = extract(zip, join(dir, 'out'));
    expect(result.code).toBe('symlink_member');
  });

  it('rejects duplicate and case-colliding members', () => {
    const dup = workDir();
    const dupZip = join(dup, 'dup.zip');
    buildZip(dupZip, [
      { name: 'payload.json', data: 'a' },
      { name: 'payload.json', data: 'b' },
    ]);
    expect(extract(dupZip, join(dup, 'out')).code).toBe('duplicate_member');

    const coll = workDir();
    const collZip = join(coll, 'coll.zip');
    buildZip(collZip, [
      { name: 'payload.json', data: 'a' },
      { name: 'Payload.json', data: 'b' },
    ]);
    expect(extract(collZip, join(coll, 'out')).code).toBe('duplicate_member');
  });

  it('rejects an unexpected member name', () => {
    const dir = workDir();
    const zip = join(dir, 'other.zip');
    buildZip(zip, [{ name: 'other.json', data: 'x' }]);
    const result = extract(zip, join(dir, 'out'), { member: 'payload.json' });
    expect(result.code).toBe('unexpected_member');
  });

  it('rejects a member over the uncompressed bound', () => {
    const dir = workDir();
    const zip = join(dir, 'big.zip');
    buildZip(zip, [{ name: 'payload.json', data: 'x'.repeat(5000) }]);
    const result = extract(zip, join(dir, 'out'), { extra: ['--max-uncompressed', '100'] });
    expect(result.code).toBe('member_too_large');
  });

  it('refuses to overwrite an existing output directory', () => {
    const dir = workDir();
    const zip = join(dir, 'ok.zip');
    buildZip(zip, [{ name: 'payload.json', data: 'x' }]);
    const out = join(dir, 'payload');
    writeFileSync(join(dir, 'marker'), 'x');
    const result = extract(zip, out);
    expect(result.status).toBe(0);
    const again = extract(zip, out);
    expect(again.code).toBe('output_exists');
  });

  it('rejects an encrypted member when the zip CLI is available', () => {
    const dir = workDir();
    writeFileSync(join(dir, 'payload.json'), '{"ok":true}');
    const zip = join(dir, 'enc.zip');
    const result = spawnSync('zip', ['-q', '-P', 'secret', zip, 'payload.json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (result.status !== 0) return; // zip CLI unavailable: skip
    expect(extract(zip, join(dir, 'out')).code).toBe('encrypted_member');
  });
});
