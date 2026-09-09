import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ImagePreviewStore,
  PreviewStoreCapacityError,
  DEFAULT_PREVIEW_TTL_MS,
  DEFAULT_PREVIEW_MAX_TOTAL_BYTES,
} from "../../server/imagePreviewStore.js";

function pngBytes(len = 64): Uint8Array {
  const bytes = new Uint8Array(len).fill(0x11);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("image preview store (v0.7 Phase 2B)", () => {
  it("insert returns an opaque unique token; lookup returns the same bytes/metadata", () => {
    const store = new ImagePreviewStore({ scheduleCleanup: () => () => {} });
    const meta = store.insert({ bytes: pngBytes(), contentType: "image/png", provider: "p", model: "m" });
    expect(meta.token).toBeTruthy();
    expect(meta.contentType).toBe("image/png");
    expect(meta.bytes).toBe(64);
    const record = store.get(meta.token);
    expect(record?.bytes).toEqual(pngBytes());
    expect(record?.provider).toBe("p");
    expect(record?.model).toBe("m");
    store.dispose();
  });

  it("tokens are unique across inserts", () => {
    const store = new ImagePreviewStore({ scheduleCleanup: () => () => {} });
    const a = store.insert({ bytes: pngBytes(), contentType: "image/png", provider: "p", model: "m" });
    const b = store.insert({ bytes: pngBytes(), contentType: "image/png", provider: "p", model: "m" });
    expect(a.token).not.toBe(b.token);
    store.dispose();
  });

  it("token contains no provider/prompt/title/path data (opaque random token)", () => {
    const store = new ImagePreviewStore({ scheduleCleanup: () => () => {} });
    const meta = store.insert({
      bytes: pngBytes(),
      contentType: "image/png",
      provider: "secret-provider-name",
      model: "secret-model",
    });
    expect(meta.token.includes("secret-provider-name")).toBe(false);
    expect(meta.token.includes("secret-model")).toBe(false);
    // base64url charset only: no separators/paths/query semantics.
    expect(/^[A-Za-z0-9_-]+$/.test(meta.token)).toBe(true);
    store.dispose();
  });

  it("expired tokens are inaccessible", () => {
    let now = 1_000_000;
    const store = new ImagePreviewStore({ now: () => now, scheduleCleanup: () => () => {} });
    const meta = store.insert({ bytes: pngBytes(), contentType: "image/png", provider: "p", model: "m" });
    now += DEFAULT_PREVIEW_TTL_MS + 1;
    expect(store.get(meta.token)).toBeUndefined();
    store.dispose();
  });

  it("multiple reads are allowed until expiry (multi-read policy)", () => {
    let now = 1_000_000;
    const store = new ImagePreviewStore({ now: () => now, scheduleCleanup: () => () => {} });
    const meta = store.insert({ bytes: pngBytes(), contentType: "image/png", provider: "p", model: "m" });
    expect(store.get(meta.token)).toBeDefined();
    expect(store.get(meta.token)).toBeDefined();
    now += DEFAULT_PREVIEW_TTL_MS - 1;
    expect(store.get(meta.token)).toBeDefined();
    store.dispose();
  });

  it("TTL cleanup sweeps expired records", () => {
    let now = 1_000_000;
    const store = new ImagePreviewStore({ now: () => now, scheduleCleanup: () => () => {} });
    const a = store.insert({ bytes: pngBytes(), contentType: "image/png", provider: "p", model: "m" });
    const b = store.insert({ bytes: pngBytes(), contentType: "image/png", provider: "p", model: "m" });
    now += DEFAULT_PREVIEW_TTL_MS + 1;
    expect(store.sweep()).toBe(2);
    expect(store.stats().count).toBe(0);
    expect(store.get(a.token)).toBeUndefined();
    expect(store.get(b.token)).toBeUndefined();
    store.dispose();
  });

  it("memory cap is enforced with a clean bounded rejection", () => {
    const store = new ImagePreviewStore({
      maxTotalBytes: 100,
      scheduleCleanup: () => () => {},
    });
    store.insert({ bytes: pngBytes(60), contentType: "image/png", provider: "p", model: "m" });
    expect(() => store.insert({ bytes: pngBytes(60), contentType: "image/png", provider: "p", model: "m" })).toThrowError(
      PreviewStoreCapacityError
    );
    // The rejected insertion did not corrupt accounting.
    expect(store.stats()).toEqual({ count: 1, totalBytes: 60 });
    store.dispose();
  });

  it("failed insertion does not corrupt store accounting (empty payload)", () => {
    const store = new ImagePreviewStore({ scheduleCleanup: () => () => {} });
    expect(() => store.insert({ bytes: new Uint8Array(0), contentType: "image/png", provider: "p", model: "m" })).toThrowError(
      PreviewStoreCapacityError
    );
    expect(store.stats()).toEqual({ count: 0, totalBytes: 0 });
    store.dispose();
  });

  it("delete/clear adjusts byte accounting", () => {
    const store = new ImagePreviewStore({ scheduleCleanup: () => () => {} });
    const a = store.insert({ bytes: pngBytes(64), contentType: "image/png", provider: "p", model: "m" });
    const b = store.insert({ bytes: pngBytes(32), contentType: "image/png", provider: "p", model: "m" });
    expect(store.stats().totalBytes).toBe(96);
    expect(store.remove(a.token)).toBe(true);
    expect(store.stats().totalBytes).toBe(32);
    store.remove(b.token);
    expect(store.stats().totalBytes).toBe(0);
    store.insert({ bytes: pngBytes(16), contentType: "image/png", provider: "p", model: "m" });
    store.clear();
    expect(store.stats()).toEqual({ count: 0, totalBytes: 0 });
    store.dispose();
  });

  it("defaults are documented (5 min TTL, 50 MB cap) and the cleanup timer never hangs teardown", () => {
    expect(DEFAULT_PREVIEW_TTL_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_PREVIEW_MAX_TOTAL_BYTES).toBe(50 * 1024 * 1024);
    // Default scheduler uses an unref'd interval; disposing stops it. If the timer
    // were not unref'd, vitest would hang — passing here is the assertion.
    const store = new ImagePreviewStore();
    store.dispose();
    expect(store.stats().count).toBe(0);
  });
});
