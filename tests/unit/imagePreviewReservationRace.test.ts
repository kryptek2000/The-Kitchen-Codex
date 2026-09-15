import { describe, it, expect } from "vitest";
import { ImagePreviewStore, PreviewStoreCapacityError } from "../../server/imagePreviewStore.js";

/**
 * B4 + FLAG — reservation/entry authority and requester binding (store level).
 *
 * - A direct `insert()` counts OUTSTANDING reservations against the entry cap,
 *   so a representative insertion can never consume an entry slot reserved for
 *   an in-flight generation (Terra's race).
 * - Reservations are bounded globally AND per requester; releases are
 *   idempotent; commit never double-counts its own reservation.
 * - Requester-bound records are invisible/removal-proof to other requesters;
 *   ownerless records keep backward-compatible access.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function quietStore(overrides: ConstructorParameters<typeof ImagePreviewStore>[0] = {}) {
  return new ImagePreviewStore({
    scheduleCleanup: () => () => {},
    ...overrides,
  });
}

describe("B4 — reservations are authoritative over direct insertion", () => {
  it("a representative-style insert cannot consume a reserved entry slot", () => {
    const store = quietStore({ maxEntries: 2 });
    const reservation = store.reserve(1024, "requester-gen");
    // One record + one outstanding reservation = full. A direct insert (the
    // representative path, which never reserves first) must fail closed.
    store.insert({ bytes: PNG, contentType: "image/png", provider: "representative", model: "openverse" });
    expect(() => store.insert({ bytes: PNG, contentType: "image/png", provider: "x", model: "y" })).toThrow(
      PreviewStoreCapacityError
    );
    // Releasing the reservation frees its entry slot again.
    store.release(reservation);
    expect(() =>
      store.insert({ bytes: PNG, contentType: "image/png", provider: "x", model: "y" })
    ).not.toThrow();
    store.dispose();
  });

  it("byte reservations still gate insertion (no byte overbooking)", () => {
    const store = quietStore({ maxEntries: 64, maxTotalBytes: 100 });
    store.reserve(90, "r");
    expect(() =>
      store.insert({ bytes: new Uint8Array(20), contentType: "image/png", provider: "x", model: "y" })
    ).toThrow(PreviewStoreCapacityError);
    store.dispose();
  });

  it("reservations are bounded per requester and globally", () => {
    const store = quietStore({ maxEntries: 64, maxReservationsPerRequester: 2 });
    store.reserve(10, "requester-A");
    store.reserve(10, "requester-A");
    expect(() => store.reserve(10, "requester-A")).toThrow(PreviewStoreCapacityError);
    // Another requester still has room (per-requester isolation).
    expect(() => store.reserve(10, "requester-B")).not.toThrow();
    store.dispose();
  });

  it("commit releases its own reservation exactly once (no double count, no leak)", () => {
    const store = quietStore();
    const reservation = store.reserve(1024, "r");
    const before = store.stats();
    const meta = store.commit(reservation, { bytes: PNG, contentType: "image/png", provider: "p", model: "m" });
    const after = store.stats();
    expect(meta.token).toBeTruthy();
    expect(after.reservedCount).toBe(before.reservedCount - 1);
    expect(after.reservedBytes).toBe(before.reservedBytes - 1024);
    expect(after.totalBytes).toBe(before.totalBytes + PNG.length);
    // Second release is a no-op (idempotent, no negative drift).
    expect(store.release(reservation)).toBe(false);
    expect(store.stats().reservedBytes).toBe(after.reservedBytes);
    store.dispose();
  });

  it("failure and expiry release reservations idempotently", () => {
    let now = 1_000_000;
    const store = quietStore({ now: () => now });
    const reservation = store.reserve(512, "r");
    expect(store.release(reservation)).toBe(true);
    expect(store.release(reservation)).toBe(false);
    const reservation2 = store.reserve(512, "r");
    now += 3 * 60 * 1000; // past the reservation TTL
    store.sweep();
    expect(store.release(reservation2)).toBe(false);
    expect(store.stats().reservedBytes).toBe(0);
    store.dispose();
  });

  it("insert token collisions with live reservations fail closed", () => {
    const store = quietStore({ createToken: () => "fixed-token" });
    store.reserve(64, "r"); // occupies "fixed-token" in the reservation set
    expect(() => store.insert({ bytes: PNG, contentType: "image/png", provider: "p", model: "m" })).toThrow(
      PreviewStoreCapacityError
    );
    store.dispose();
  });
});

describe("FLAG — preview records are requester-bound", () => {
  it("an owner-bound record is invisible to other requesters (get + remove)", () => {
    const store = quietStore();
    const meta = store.insert(
      { bytes: PNG, contentType: "image/png", provider: "p", model: "m" },
      "requester-A"
    );
    expect(store.get(meta.token)).toBeUndefined();
    expect(store.get(meta.token, "requester-B")).toBeUndefined();
    expect(store.get(meta.token, "requester-A")?.bytes).toEqual(PNG);
    // A foreign requester cannot invalidate the record (no oracle either way).
    expect(store.remove(meta.token, "requester-B")).toBe(false);
    expect(store.get(meta.token, "requester-A")).toBeTruthy();
    expect(store.remove(meta.token, "requester-A")).toBe(true);
    store.dispose();
  });

  it("ownerless records keep backward-compatible access", () => {
    const store = quietStore();
    const meta = store.insert({ bytes: PNG, contentType: "image/png", provider: "p", model: "m" });
    expect(store.get(meta.token)?.bytes).toEqual(PNG);
    expect(store.remove(meta.token)).toBe(true);
    store.dispose();
  });
});
