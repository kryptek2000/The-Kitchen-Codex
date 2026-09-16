/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: bounded streaming JSON reader.
 *
 * Uses synthetic temp files only (never a real USDA archive).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { streamRootArray, StreamJsonError } from '../../scripts/usda_bundle/stream_json';

const workDirs: string[] = [];

function writeTemp(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kc-stream-json-'));
  workDirs.push(dir);
  const file = join(dir, 'payload.json');
  writeFileSync(file, contents, 'utf8');
  return file;
}

function collect(file: string, rootKey = 'Root', max = 4096): string[] {
  return Array.from(streamRootArray(file, rootKey, max));
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof StreamJsonError) return error.code;
    throw error;
  }
  return 'no_error';
}

afterEach(() => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('phase 4.5A streaming JSON reader — structure', () => {
  it('yields each entry of the expected root array', () => {
    const file = writeTemp('{"Root": [ {"fdcId":1}, {"fdcId":2}, null ]}');
    expect(collect(file)).toEqual(['{"fdcId":1}', '{"fdcId":2}', 'null']);
  });

  it('handles whitespace variation', () => {
    const file = writeTemp('\n\t{ "Root" :\n[\n  1 ,\n  "two" ,\n  true\n]\n}\t\n');
    expect(collect(file)).toEqual(['1', '"two"', 'true']);
  });

  it('handles braces/brackets inside strings', () => {
    const file = writeTemp('{"Root":[{"a":"}{[]"},{"b":"[}]"}]}');
    expect(collect(file)).toEqual(['{"a":"}{[]"}', '{"b":"[}]"}']);
  });

  it('handles escaped quotes and backslashes', () => {
    const file = writeTemp('{"Root":["a\\"b","c\\\\d","e\\/f"]}');
    expect(collect(file)).toEqual(['"a\\"b"', '"c\\\\d"', '"e\\/f"']);
  });

  it('handles unicode escapes and multibyte characters', () => {
    const file = writeTemp('{"Root":["\\u00e9","\\uD83D\\uDE00","caf\\u00e9"]}');
    expect(collect(file)).toEqual(['"\\u00e9"', '"\\uD83D\\uDE00"', '"caf\\u00e9"']);
  });

  it('handles nested objects and arrays', () => {
    const file = writeTemp('{"Root":[{"x":[1,2,{"y":[3,4]}]},{"z":{}}]}');
    expect(collect(file)).toEqual(['{"x":[1,2,{"y":[3,4]}]}', '{"z":{}}']);
  });

  it('yields an empty array', () => {
    expect(collect(writeTemp('{"Root":[]}'))).toEqual([]);
  });
});

describe('phase 4.5A streaming JSON reader — rejection', () => {
  it('rejects a truncated entry', () => {
    expect(codeOf(() => collect(writeTemp('{"Root":[{"a":1')))).toBe('unexpected_eof');
  });

  it('rejects a missing array terminator', () => {
    expect(codeOf(() => collect(writeTemp('{"Root":[{"a":1}')))).toBe('invalid_array');
  });

  it('rejects trailing garbage', () => {
    expect(codeOf(() => collect(writeTemp('{"Root":[1]}x')))).toBe('trailing_garbage');
  });

  it('rejects an unexpected root key', () => {
    expect(codeOf(() => collect(writeTemp('{"Other":[1]}')))).toBe('unexpected_root_key');
  });

  it('rejects multiple root keys', () => {
    expect(codeOf(() => collect(writeTemp('{"Root":[1],"Other":[2]}')))).toBe('multiple_root_keys');
  });

  it('rejects a scalar root', () => {
    expect(codeOf(() => collect(writeTemp('42')))).toBe('invalid_root_structure');
  });

  it('rejects an empty root object', () => {
    expect(codeOf(() => collect(writeTemp('{}')))).toBe('empty_root');
  });

  it('rejects malformed syntax inside an entry', () => {
    // The scanner yields the raw substring; JSON.parse is the caller's job.
    const raw = collect(writeTemp('{"Root":[{"a":,}]}'));
    expect(() => JSON.parse(raw[0])).toThrow();
  });

  it('rejects an oversized entry before parsing', () => {
    const file = writeTemp('{"Root":[{"a":"' + 'x'.repeat(5000) + '"}]}');
    expect(codeOf(() => collect(file, 'Root', 1024))).toBe('entry_too_large');
  });
});
