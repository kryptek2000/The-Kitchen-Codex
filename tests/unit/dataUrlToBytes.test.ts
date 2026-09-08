import { describe, it, expect } from 'vitest';
import { dataUrlToBytes } from '../../src/utils/vaultAssets';

describe('dataUrlToBytes (Phase 4D3D)', () => {
  it('decodes a lowercase base64 data URL', () => {
    const { bytes, contentType } = dataUrlToBytes('data:image/png;base64,aGVsbG8=');
    expect(contentType).toBe('image/png');
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('treats ;BASE64 as case-insensitive (uppercase)', () => {
    const { bytes } = dataUrlToBytes('data:image/png;BASE64,aGVsbG8=');
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('treats ;Base64 as case-insensitive (mixed case)', () => {
    const { bytes } = dataUrlToBytes('data:image/png;Base64,aGVsbG8=');
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('strips intra-base64 whitespace before decoding', () => {
    const { bytes } = dataUrlToBytes('data:image/png;base64,aGVs\nbG8=');
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('decodes a percent-encoded UTF-8 payload', () => {
    const { bytes, contentType } = dataUrlToBytes('data:text/plain,hello%20world');
    expect(contentType).toBe('text/plain');
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
  });

  it('accepts an empty payload (returns empty bytes)', () => {
    const { bytes, contentType } = dataUrlToBytes('data:text/plain,');
    expect(contentType).toBe('text/plain');
    expect(bytes.length).toBe(0);
  });

  it('defaults a missing MIME to text/plain', () => {
    const { bytes, contentType } = dataUrlToBytes('data:;base64,aGVsbG8=');
    expect(contentType).toBe('text/plain');
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('throws on malformed base64', () => {
    expect(() => dataUrlToBytes('data:image/png;base64,!@#')).toThrow();
  });

  it('throws on a malformed percent escape', () => {
    expect(() => dataUrlToBytes('data:text/plain,%ZZ')).toThrow();
  });
});
