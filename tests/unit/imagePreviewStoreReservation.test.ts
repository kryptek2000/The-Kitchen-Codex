import { describe, it, expect } from "vitest";
import {
  ImagePreviewStore,
  PreviewStoreCapacityError,
} from "../../server/imagePreviewStore.js";

/**
 * Phase 2 repair — bounded, concurrency-safe preview capacity RESERVATIONS.
 *
 * A reservation holds worst-case byte capacity (and one entry slot) BEFORE the
 * provider call so a full store can never charge for an image it cannot retain.
 */

function makeStore(options: ConstructorParameters<typeof ImagePreviewStore>[0] = {}) {
  let now = 1_000_000;
  const store = new ImagePreviewStore({
    now: () => now,
    createToken: (() => {
      let i = 0;
      return () => `res-${++i}`;
    })(),
    ...options,
  });
  return { store, advance: (ms: number) => { now += ms; } };
}

describe("ImagePreviewStore — capacity reservations", () => {
  it("reserves, commits actual bytes, and releases unused capacity", () => {
    const { store } = makeStore();
    const reservation = store.reserve(1000);
    expect(store.stats().reservedCount).toBe(1);
    expect(store.stats().reservedBytes).toBe(1000);
    const meta = store.commit(reservation, {
      bytes: new Uint8Array(10),
      contentType: "image/png",
      provider: "p",
      model: "m",
    });
    expect(meta.bytes).toBe(10);
    expect(store.stats().reservedBytes).toBe(0);
    expect(store.stats().reservedCount).toBe(0);
    expect(store.stats().totalBytes).toBe(10);
    expect(store.stats().count).toBe(1);
    store.dispose();
  });

  it("release restores capacity and is idempotent", () => {
    const { store } = makeStore({ maxTotalBytes: 100 });
    const reservation = store.reserve(80);
    expect(store.release(reservation)).toBe(true);
    expect(store.release(reservation)).toBe(false);
    expect(store.stats().reservedBytes).toBe(0);
    // The freed capacity is reusable.
    expect(() => store.reserve(80)).not.toThrow();
    store.dispose();
  });

  it("two concurrent reservations cannot overbook byte capacity", () => {
    const { store } = makeStore({ maxTotalBytes: 100, maxEntries: 10 });
    store.reserve(60);
    expect(() => store.reserve(60)).toThrow(PreviewStoreCapacityError);
    // 60 + 40 == 100 exactly is allowed.
    expect(() => store.reserve(40)).not.toThrow();
    expect(() => store.reserve(1)).toThrow(PreviewStoreCapacityError);
    expect(store.stats().reservedBytes).toBe(100);
    store.dispose();
  });

  it("entry capacity is enforced independently of bytes", () => {
    const { store } = makeStore({ maxEntries: 2 });
    store.reserve(10);
    store.reserve(10);
    expect(() => store.reserve(10)).toThrow(PreviewStoreCapacityError);
    store.dispose();
  });

  it("an expired reservation is swept and restores capacity", () => {
    const { store, advance } = makeStore({ maxTotalBytes: 100 });
    store.reserve(100);
    expect(store.stats().reservedBytes).toBe(100);
    advance(2 * 60 * 1000); // default reservation TTL
    store.sweep();
    expect(store.stats().reservedBytes).toBe(0);
    expect(() => store.reserve(100)).not.toThrow();
    store.dispose();
  });

  it("committing an unknown/expired reservation fails closed", () => {
    const { store, advance } = makeStore();
    const reservation = store.reserve(100);
    advance(2 * 60 * 1000);
    store.sweep();
    expect(() =>
      store.commit(reservation, {
        bytes: new Uint8Array(10),
        contentType: "image/png",
        provider: "p",
        model: "m",
      })
    ).toThrow(PreviewStoreCapacityError);
    store.dispose();
  });

  it("reservation metadata is opaque and contains no bytes or credentials", () => {
    const { store } = makeStore();
    const reservation = store.reserve(100);
    const serialized = JSON.stringify(reservation);
    expect(reservation.token).toBe("res-1");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("bytes");
    store.dispose();
  });
});
