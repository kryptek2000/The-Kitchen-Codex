import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ImagePreviewStore } from "../../server/imagePreviewStore.js";
import { DeterministicImageProvider } from "../../server/ai/imageProvider.js";

/**
 * B4 — capacity rejection occurs BEFORE provider dispatch (real route,
 * fake provider seam, tiny store).
 *
 * - A full preview store rejects generation with 503 PREVIEW_CAPACITY and
 *   ZERO provider calls (the reservation fails before dispatch).
 * - A direct representative-style insertion cannot steal a reserved entry:
 *   covered at store level in `imagePreviewReservationRace.test.ts`; here the
 *   route proves one intended provider call maximum on the success path.
 */

const ENV_KEYS = ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "KITCHEN_CODEX_IMAGE_PROVIDER", "KITCHEN_CODEX_IMAGE_MODEL", "AI_ENDPOINT_TOKEN"] as const;
const realFetch = globalThis.fetch.bind(globalThis);

async function boot(store: ImagePreviewStore, provider: DeterministicImageProvider & { calls: number }) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  const { createApp } = await import("../../server/app.js");
  const app = createApp({ isProduction: false, imagePreviewStore: store, imageProvider: provider });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function countingProvider() {
  const base = new DeterministicImageProvider();
  const provider = base as DeterministicImageProvider & { calls: number };
  provider.calls = 0;
  const inner = base.generateImage.bind(base);
  provider.generateImage = (async (...args: Parameters<typeof inner>) => {
    provider.calls += 1;
    return inner(...args);
  }) as typeof inner;
  return provider;
}

describe("B4 — real-route capacity-before-dispatch", () => {
  afterEach(() => {
    vi.resetModules();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("a full store rejects generation with 503 and ZERO provider calls", async () => {
    const store = new ImagePreviewStore({ maxEntries: 1, scheduleCleanup: () => () => {} });
    const provider = countingProvider();
    const app = await boot(store, provider);
    try {
      // Deterministic provider is zero-price: no confirmation token required.
      const first = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Soup" }),
      });
      expect(first.status).toBe(200);
      expect(provider.calls).toBe(1);
      // Store is now entry-full: the next generation fails BEFORE dispatch.
      const second = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Soup" }),
      });
      expect(second.status).toBe(503);
      expect(((await second.json()) as { code?: string }).code).toBe("PREVIEW_CAPACITY");
      expect(provider.calls).toBe(1);
    } finally {
      store.dispose();
      await app.close();
    }
  });

  it("an outstanding reservation blocks the next generation with ZERO additional calls", async () => {
    const store = new ImagePreviewStore({ maxEntries: 1, scheduleCleanup: () => () => {} });
    const provider = countingProvider();
    // Simulate Terra's race: an in-flight generation holds the only slot.
    const held = store.reserve(1024, "requester-other");
    const app = await boot(store, provider);
    try {
      const res = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Soup" }),
      });
      expect(res.status).toBe(503);
      expect(provider.calls).toBe(0);
    } finally {
      store.release(held);
      store.dispose();
      await app.close();
    }
  });
});
