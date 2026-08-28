import { describe, it, expect } from 'vitest';
import {
  parseImageContentType,
  ALLOWED_IMAGE_CONTENT_TYPES,
} from '../../server/ssrfGuard';

describe('Image Proxy Content-Type Enforcement Security Suite', () => {
  describe('parseImageContentType', () => {
    it('accepts standard image MIME types', () => {
      expect(parseImageContentType('image/jpeg')).toBe('image/jpeg');
      expect(parseImageContentType('image/png')).toBe('image/png');
      expect(parseImageContentType('image/webp')).toBe('image/webp');
      expect(parseImageContentType('image/gif')).toBe('image/gif');
      expect(parseImageContentType('image/avif')).toBe('image/avif');
    });

    it('canonicalizes image/jpg alias to image/jpeg', () => {
      expect(parseImageContentType('image/jpg')).toBe('image/jpeg');
    });

    it('normalizes uppercase and strips parameters/whitespace', () => {
      expect(parseImageContentType('IMAGE/PNG')).toBe('image/png');
      expect(parseImageContentType('  image/gif ')).toBe('image/gif');
      expect(parseImageContentType('image/webp; charset=binary')).toBe('image/webp');
    });

    it('rejects XSS vectors and non-raster formats', () => {
      expect(parseImageContentType('image/svg+xml')).toBeNull();
      expect(parseImageContentType('text/html')).toBeNull();
      expect(parseImageContentType('application/json')).toBeNull();
      expect(parseImageContentType('application/javascript')).toBeNull();
      expect(parseImageContentType('application/xml')).toBeNull();
      expect(parseImageContentType('font/woff2')).toBeNull();
      expect(parseImageContentType('')).toBeNull();
      expect(parseImageContentType(undefined)).toBeNull();
    });

    it('contains strictly the five allowed raster formats', () => {
      const allowed = [...ALLOWED_IMAGE_CONTENT_TYPES].sort();
      expect(allowed).toEqual(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
    });
  });
});
