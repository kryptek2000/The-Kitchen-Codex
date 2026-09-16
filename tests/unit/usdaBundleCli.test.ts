/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: executable CLI boundary.
 *
 * These are REAL subprocess tests of the published package commands. The critical
 * tests do not import a helper or mock the package-script invocation.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { expectedArtifactDir } from '../../scripts/usda_bundle/verify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'scripts', 'usda_bundle', 'generate.cli.ts');
const VERIFY_CLI = join(ROOT, 'scripts', 'usda_bundle', 'verify.cli.ts');
const ARCHIVES = {
  foundation: '/tmp/FoodData_Central_foundation_food_json_2026-04-30.zip',
  srLegacy: '/tmp/FoodData_Central_sr_legacy_food_json_2018-04.zip',
  fndds: '/tmp/FoodData_Central_survey_food_json_2024-10-31.zip',
};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kc-cli-'));
  tempDirs.push(dir);
  return dir;
}

function lastJson(text: string): Record<string, unknown> | null {
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runPackageScript(script: string, args: string[] = []): RunResult {
  const result = spawnSync('bun', ['run', script, ...(args.length ? ['--', ...args] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runEntry(entry: string, args: string[], env: NodeJS.ProcessEnv = process.env): RunResult {
  const result = spawnSync('bun', [entry, ...args], { cwd: ROOT, encoding: 'utf8', env });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

describe('phase 4.5A CLI boundary — generator', () => {
  it('exits nonzero with missing arguments and creates no output', () => {
    const result = runPackageScript('generate:usda-bundle', [
      '--foundation',
      '/tmp/nope.zip',
      '--sr-legacy',
      '/tmp/nope2.zip',
      '--fndds',
      '/tmp/nope3.zip',
    ]);
    expect(result.status).not.toBe(0);
    expect(lastJson(result.stdout)?.ok).not.toBe(true);
  });

  it('exits nonzero for missing/absent required flags', () => {
    const result = runPackageScript('generate:usda-bundle', []);
    expect(result.status).not.toBe(0);
    expect(lastJson(result.stderr)?.code).toBe('missing_required_argument');
  });

  it('exits nonzero for an unknown flag', () => {
    const result = runPackageScript('generate:usda-bundle', [
      '--foundation',
      '/tmp/nope.zip',
      '--sr-legacy',
      '/tmp/nope2.zip',
      '--fndds',
      '/tmp/nope3.zip',
      '--out',
      join(tempDir(), 'out'),
      '--evil',
      'x',
    ]);
    expect(result.status).not.toBe(0);
  });

  it('never exits zero without creating and verifying its requested output', () => {
    const result = runPackageScript('generate:usda-bundle', [
      '--foundation',
      '/tmp/definitely-absent-archive.zip',
      '--sr-legacy',
      '/tmp/definitely-absent-archive2.zip',
      '--fndds',
      '/tmp/definitely-absent-archive3.zip',
      '--out',
      join(tempDir(), 'out'),
    ]);
    expect(result.status).not.toBe(0);
    expect(lastJson(result.stdout)?.ok).not.toBe(true);
  });

  it('runs the real published command and produces the exact locked artifact when archives are present', () => {
    if (!Object.values(ARCHIVES).every((path) => existsSync(path))) return;
    const out = join(tempDir(), 'artifact');
    const result = runPackageScript('generate:usda-bundle', [
      '--foundation',
      ARCHIVES.foundation,
      '--sr-legacy',
      ARCHIVES.srLegacy,
      '--fndds',
      ARCHIVES.fndds,
      '--out',
      out,
    ]);
    expect(result.status).toBe(0);
    const parsed = lastJson(result.stdout);
    expect(parsed?.ok).toBe(true);
    const files = readdirSync(out).sort();
    expect(files).toEqual([
      'artifact.json',
      'manifest.json',
      'records.fndds.json.gz',
      'records.foundation.json.gz',
      'records.sr_legacy.json.gz',
    ]);
    for (const name of files) {
      const candidate = readFileSync(join(expectedArtifactDir(), name));
      const generated = readFileSync(join(out, name));
      expect(generated.equals(candidate), name).toBe(true);
    }
  }, 300000);
});

describe('phase 4.5A CLI boundary — verifier', () => {
  it('actually executes and exits zero for the exact pinned candidate', () => {
    const result = runPackageScript('verify:usda-bundle');
    expect(result.status).toBe(0);
    const parsed = lastJson(result.stdout);
    expect(parsed?.ok).toBe(true);
    expect(parsed?.records).toBe(13559);
  }, 120000);

  it('exits nonzero for a missing directory', () => {
    const result = runPackageScript('verify:usda-bundle', ['--dir', join(tempDir(), 'absent')]);
    expect(result.status).not.toBe(0);
    expect(lastJson(result.stderr)?.code).toBe('artifact_dir_missing');
  });

  it('exits nonzero for an altered directory', () => {
    const dir = tempDir();
    const source = expectedArtifactDir();
    for (const name of readdirSync(source)) copyFileSync(join(source, name), join(dir, name));
    const shard = join(dir, 'records.foundation.json.gz');
    const bytes = readFileSync(shard);
    bytes[bytes.length - 5] = bytes[bytes.length - 5] ^ 0xff;
    writeFileSync(shard, bytes);
    const result = runPackageScript('verify:usda-bundle', ['--dir', dir]);
    expect(result.status).not.toBe(0);
  });

  it('rejects CLI flags that attempt to override expected identities', () => {
    const result = runPackageScript('verify:usda-bundle', [
      '--dir',
      expectedArtifactDir(),
      '--bundle-release',
      'usda_fdc_deadbeefdeadbeefdeadbeefdeadbeef',
      '--sha256',
      'f'.repeat(64),
    ]);
    expect(result.status).not.toBe(0);
    expect(lastJson(result.stderr)?.code).toBe('unknown_argument');
  });

  it('exits nonzero for an unknown flag with no dir', () => {
    const result = runPackageScript('verify:usda-bundle', ['--nonsense']);
    expect(result.status).not.toBe(0);
  });
});

describe('phase 4.5A CLI boundary — entry modules', () => {
  it('importing generate.ts does not execute a CLI', () => {
    const result = spawnSync('bun', ['-e', `import(${JSON.stringify(CLI.replace(/\.cli\.ts$/, '.ts'))})`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('importing verify.ts does not execute a CLI', () => {
    const result = spawnSync('bun', ['-e', `import(${JSON.stringify(VERIFY_CLI.replace(/\.cli\.ts$/, '.ts'))})`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('entry modules unconditionally run their runner and exit nonzero on invalid args', () => {
    const gen = runEntry(CLI, []);
    expect(gen.status).not.toBe(0);
    const verify = runEntry(VERIFY_CLI, ['--dir', '/tmp/kc-absent-cli-dir']);
    expect(verify.status).not.toBe(0);
  });
});
