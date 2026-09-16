/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: artifact descriptor + deterministic gzip.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  boundedGunzip,
  deterministicGzip,
  serializeArtifactDescriptor,
  validateArtifactDescriptor,
} from '../../scripts/usda_bundle/artifact';
import { expectedArtifactDir } from '../../scripts/usda_bundle/verify';

const ARTIFACT_PATH = join(expectedArtifactDir(), 'artifact.json');

function realArtifact(): Record<string, unknown> {
  return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
}

describe('phase 4.5A artifact descriptor', () => {
  it('accepts the checked-in artifact descriptor', () => {
    const result = validateArtifactDescriptor(realArtifact());
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown field', () => {
    const artifact = realArtifact();
    artifact.extra = true;
    expect(validateArtifactDescriptor(artifact).ok).toBe(false);
  });

  it('rejects a wrong compression level', () => {
    const artifact = realArtifact() as { shards: Array<Record<string, unknown>> };
    artifact.shards[0].compression_level = 1;
    expect(validateArtifactDescriptor(artifact).ok).toBe(false);
  });

  it('rejects a missing shard', () => {
    const artifact = realArtifact() as { shards: unknown[] };
    artifact.shards = artifact.shards.slice(0, 2);
    expect(validateArtifactDescriptor(artifact).ok).toBe(false);
  });

  it('rejects a malformed digest', () => {
    const artifact = realArtifact() as { shards: Array<Record<string, unknown>> };
    artifact.shards[0].compressed_sha256 = 'not-a-digest';
    expect(validateArtifactDescriptor(artifact).ok).toBe(false);
  });

  it('rejects a non-canonical/unsafe value', () => {
    expect(validateArtifactDescriptor({ ...realArtifact(), __proto__: { polluted: true } }).ok).toBe(false);
  });

  it('serializes deterministically with no trailing newline', () => {
    const result = validateArtifactDescriptor(realArtifact());
    if (!result.ok) throw new Error('expected valid');
    const serialized = serializeArtifactDescriptor(result.artifact);
    expect(serialized.endsWith('\n')).toBe(false);
    expect(serializeArtifactDescriptor(result.artifact)).toBe(serialized);
  });
});

describe('phase 4.5A deterministic gzip', () => {
  it('produces byte-identical output across repeated calls with a normalized header', () => {
    const input = Buffer.from('canonical payload '.repeat(500), 'utf8');
    const a = deterministicGzip(input);
    const b = deterministicGzip(input);
    expect(a.equals(b)).toBe(true);
    expect(a[4]).toBe(0);
    expect(a[5]).toBe(0);
    expect(a[6]).toBe(0);
    expect(a[7]).toBe(0);
    expect(a[9]).toBe(255);
  });

  it('round-trips through bounded gunzip', () => {
    const input = Buffer.from('the quick brown fox'.repeat(100), 'utf8');
    expect(boundedGunzip(deterministicGzip(input), 1 << 20).equals(input)).toBe(true);
  });

  it('rejects a decompression bomb via the output bound', () => {
    const input = Buffer.alloc(1 << 20, 0x61);
    const compressed = deterministicGzip(input);
    expect(() => boundedGunzip(compressed, 1024)).toThrow();
  });
});
