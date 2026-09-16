/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: offline verifier.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { expectedArtifactDir, verifyBundleDirectory } from '../../scripts/usda_bundle/verify';
import { ARTIFACT_DESCRIPTOR_FILENAME, ARTIFACT_MANIFEST_FILENAME, SHARD_FILENAMES, SHARD_ORDER } from '../../scripts/usda_bundle/constants';

const ARTIFACT_FILES = [
  ARTIFACT_DESCRIPTOR_FILENAME,
  ARTIFACT_MANIFEST_FILENAME,
  ...SHARD_ORDER.map((dataType) => SHARD_FILENAMES[dataType]),
];

const tempDirs: string[] = [];

function copyArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kc-verify-'));
  tempDirs.push(dir);
  const source = expectedArtifactDir();
  for (const name of ARTIFACT_FILES) copyFileSync(join(source, name), join(dir, name));
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

describe('phase 4.5A offline verifier', () => {
  it('verifies the checked-in artifact and reproduces the exact census', () => {
    const result = verifyBundleDirectory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.records).toBe(13559);
    expect(result.summary.rejected_non_null).toBe(29);
    expect(result.summary.null_placeholders).toBe(32);
  }, 60000);

  it('rejects a tampered compressed shard', () => {
    const dir = copyArtifact();
    const shardPath = join(dir, SHARD_FILENAMES.foundation);
    const bytes = readFileSync(shardPath);
    bytes[bytes.length - 5] = bytes[bytes.length - 5] ^ 0xff;
    writeFileSync(shardPath, bytes);
    const result = verifyBundleDirectory(dir);
    expect(result.ok).toBe(false);
  }, 60000);

  it('rejects an extra file', () => {
    const dir = copyArtifact();
    writeFileSync(join(dir, 'extra.txt'), 'x');
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 60000);

  it('rejects a symlinked shard', () => {
    const dir = copyArtifact();
    const target = join(dir, SHARD_FILENAMES.fndds);
    rmSync(target);
    symlinkSync(join(expectedArtifactDir(), SHARD_FILENAMES.fndds), target);
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 60000);

  it('rejects a descriptor count that disagrees with the bytes', () => {
    const dir = copyArtifact();
    const descriptorPath = join(dir, ARTIFACT_DESCRIPTOR_FILENAME);
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    descriptor.total_record_count = descriptor.total_record_count + 1;
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 60000);

  it('rejects a missing directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kc-verify-missing-'));
    tempDirs.push(dir);
    expect(verifyBundleDirectory(join(dir, 'nope')).ok).toBe(false);
  }, 60000);
});
