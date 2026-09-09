import { describe, it, expect } from "vitest";
import {
  validateGeneratedImage,
  sniffGeneratedImageMime,
  GENERATED_IMAGE_MIME_ALLOWLIST,
  MAX_GENERATED_IMAGE_BYTES,
  MIN_GENERATED_IMAGE_BYTES,
} from "../../src/core/recipeImage.js";

function jpegBytes(len = 64): Uint8Array {
  const bytes = new Uint8Array(len).fill(0x33);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  return bytes;
}

function pngBytes(len = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(len, 8)).fill(0x11);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes.subarray(0, len);
}

function webpBytes(len = 64): Uint8Array {
  const bytes = new Uint8Array(len).fill(0x22);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return bytes;
}

function avifBytes(): Uint8Array {
  // ftyp box: size=20, 'ftyp', majorBrand 'avif', minor 4 bytes, compat brand 'avis'
  const bytes = new Uint8Array(20).fill(0x44);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20);
  bytes.set(Buffer.from("ftyp", "ascii"), 4);
  bytes.set(Buffer.from("avif", "ascii"), 8);
  bytes.set(Buffer.from("avis", "ascii"), 16);
  return bytes;
}

function svgBytes(): Uint8Array {
  return new Uint8Array(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8"));
}

function gifBytes(): Uint8Array {
  const bytes = new Uint8Array(32).fill(0x00);
  bytes.set(Buffer.from("GIF89a", "ascii"), 0);
  return bytes;
}

describe("validateGeneratedImage (v0.7 Phase 2B) — allowlist + acceptance", () => {
  it("accepts a valid JPEG", () => {
    const r = validateGeneratedImage({ bytes: jpegBytes(), contentType: "image/jpeg" });
    expect(r.valid).toBe(true);
    expect(r.detectedMime).toBe("image/jpeg");
  });

  it("accepts a valid PNG", () => {
    const r = validateGeneratedImage({ bytes: pngBytes(), contentType: "image/png" });
    expect(r.valid).toBe(true);
  });

  it("accepts a valid WebP (RIFF....WEBP)", () => {
    const r = validateGeneratedImage({ bytes: webpBytes(), contentType: "image/webp" });
    expect(r.valid).toBe(true);
  });

  it("accepts a valid AVIF via a real ftyp box + compatible brand", () => {
    const r = validateGeneratedImage({ bytes: avifBytes(), contentType: "image/avif" });
    expect(r.valid).toBe(true);
    expect(r.detectedMime).toBe("image/avif");
  });

  it("generated MIME allowlist is exactly jpeg/png/webp/avif", () => {
    expect([...GENERATED_IMAGE_MIME_ALLOWLIST].sort()).toEqual(["image/avif", "image/jpeg", "image/png", "image/webp"]);
  });
});

describe("validateGeneratedImage — rejections", () => {
  it("rejects SVG regardless of claimed metadata", () => {
    expect(validateGeneratedImage({ bytes: svgBytes(), contentType: "image/svg+xml" }).valid).toBe(false);
    // Even if a broken provider labels SVG bytes as PNG, the container check rejects.
    expect(validateGeneratedImage({ bytes: svgBytes(), contentType: "image/png" }).valid).toBe(false);
  });

  it("rejects GIF for generation (existing display support untouched)", () => {
    expect(validateGeneratedImage({ bytes: gifBytes(), contentType: "image/gif" }).valid).toBe(false);
  });

  it("rejects MIME/signature mismatch (declared PNG, bytes JPEG)", () => {
    const r = validateGeneratedImage({ bytes: jpegBytes(), contentType: "image/png" });
    expect(r.valid).toBe(false);
    expect(r.detectedMime).toBe("image/jpeg");
    expect(r.error).toMatch(/does not match/i);
  });

  it("rejects truncated JPEG", () => {
    expect(validateGeneratedImage({ bytes: jpegBytes(2), contentType: "image/jpeg" }).valid).toBe(false);
  });

  it("rejects truncated PNG", () => {
    expect(validateGeneratedImage({ bytes: pngBytes(4), contentType: "image/png" }).valid).toBe(false);
  });

  it("rejects a fake RIFF container without the WEBP brand", () => {
    const bytes = webpBytes();
    bytes.set([0x00, 0x00, 0x00, 0x00], 8); // no WEBP at 8..12
    expect(validateGeneratedImage({ bytes, contentType: "image/webp" }).valid).toBe(false);
  });

  it("rejects a fake AVIF (ISO BMFF without an avif/avis compatible brand)", () => {
    const bytes = new Uint8Array(20).fill(0x55);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 20);
    bytes.set(Buffer.from("ftyp", "ascii"), 4);
    bytes.set(Buffer.from("mp42", "ascii"), 8); // not avif/avis
    expect(validateGeneratedImage({ bytes, contentType: "image/avif" }).valid).toBe(false);
  });

  it("rejects a malformed ftyp box (size < 12 or beyond the buffer)", () => {
    const bytes = avifBytes();
    new DataView(bytes.buffer).setUint32(0, 4); // box size smaller than the header
    expect(validateGeneratedImage({ bytes, contentType: "image/avif" }).valid).toBe(false);
    const overflow = avifBytes();
    new DataView(overflow.buffer).setUint32(0, 9999); // box beyond the buffer
    expect(validateGeneratedImage({ bytes: overflow, contentType: "image/avif" }).valid).toBe(false);
  });

  it("rejects empty input", () => {
    expect(validateGeneratedImage({ bytes: new Uint8Array(0), contentType: "image/png" }).valid).toBe(false);
  });

  it("rejects oversize input at the hard cap", () => {
    const big = new Uint8Array(MAX_GENERATED_IMAGE_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    expect(validateGeneratedImage({ bytes: big, contentType: "image/png" }).valid).toBe(false);
  });

  it("rejects provider-declared unsupported MIME types", () => {
    for (const mime of ["image/svg+xml", "image/gif", "text/html", "", "image/jxl", "application/octet-stream"]) {
      expect(validateGeneratedImage({ bytes: pngBytes(), contentType: mime }).valid).toBe(false);
    }
  });

  it("size bounds are documented and sane", () => {
    expect(MAX_GENERATED_IMAGE_BYTES).toBe(4 * 1024 * 1024);
    expect(MIN_GENERATED_IMAGE_BYTES).toBeGreaterThanOrEqual(12);
  });

  it("sniffGeneratedImageMime never labels arbitrary ISO BMFF as AVIF", () => {
    const bytes = new Uint8Array(24).fill(0x00); // all zeros: NOT a fake-avif shortcut
    bytes.set(Buffer.from("ftyp", "ascii"), 4);
    bytes.set(Buffer.from("isom", "ascii"), 8);
    expect(sniffGeneratedImageMime(bytes)).toBeUndefined();
  });
});
