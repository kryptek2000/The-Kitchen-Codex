import { describe, it, expect } from "vitest";
import type { Request } from "express";
import {
  bootstrapOriginAllowed,
  isImageSessionDeploymentSupported,
  isLoopbackHostHeader,
  originMatchesHost,
} from "../../server/imageSession.js";

/** P2-R2 — image-session HTTP boundary helpers (Host/Origin/deployment). */

function req(headers: Record<string, string>): Request {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) } as unknown as Request;
}

describe("P2-R1 — loopback Host / same-origin bootstrap", () => {
  it("accepts only loopback Host headers (DNS-rebinding guard)", () => {
    expect(isLoopbackHostHeader(req({ Host: "127.0.0.1:3000" }))).toBe(true);
    expect(isLoopbackHostHeader(req({ Host: "localhost:3000" }))).toBe(true);
    expect(isLoopbackHostHeader(req({ Host: "[::1]:3000" }))).toBe(true);
    expect(isLoopbackHostHeader(req({ Host: "evil.example" }))).toBe(false);
    expect(isLoopbackHostHeader(req({ Host: "127.0.0.1.evil.example" }))).toBe(false);
    expect(isLoopbackHostHeader(req({ Host: "192.168.1.10:3000" }))).toBe(false);
    expect(isLoopbackHostHeader(req({ Host: "evil@127.0.0.1:3000" }))).toBe(false);
    expect(isLoopbackHostHeader(req({ Host: "127.0.0.1:3000/path" }))).toBe(false);
    expect(isLoopbackHostHeader(req({}))).toBe(false);
  });

  it("requires an exact same-origin bootstrap Origin, not merely a loopback Host", () => {
    const good = req({ Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" });
    expect(originMatchesHost(good)).toBe(true);
    expect(bootstrapOriginAllowed(good)).toBe(true);

    expect(bootstrapOriginAllowed(req({ Host: "127.0.0.1:3000" }))).toBe(false);
    expect(
      bootstrapOriginAllowed(req({ Host: "127.0.0.1:3000", Origin: "http://evil.example" }))
    ).toBe(false);
    expect(
      bootstrapOriginAllowed(
        req({ Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:9999" })
      )
    ).toBe(false);
    expect(
      bootstrapOriginAllowed(
        req({
          Host: "127.0.0.1:3000",
          Origin: "http://127.0.0.1:3000",
          "Sec-Fetch-Site": "cross-site",
        })
      )
    ).toBe(false);
    // A matching Origin on a non-loopback Host is still rejected.
    expect(
      bootstrapOriginAllowed(req({ Host: "evil.example", Origin: "http://evil.example" }))
    ).toBe(false);
  });

  it("fails closed for hosted and non-loopback deployments", () => {
    expect(isImageSessionDeploymentSupported({})).toBe(true);
    expect(isImageSessionDeploymentSupported({ HOST: "127.0.0.1" })).toBe(true);
    expect(isImageSessionDeploymentSupported({ HOST: "localhost" })).toBe(true);
    expect(isImageSessionDeploymentSupported({ HOST: "0.0.0.0" })).toBe(false);
    expect(isImageSessionDeploymentSupported({ HOST: "192.168.1.10" })).toBe(false);
    expect(isImageSessionDeploymentSupported({ K_SERVICE: "x", HOST: "127.0.0.1" })).toBe(false);
  });

  it("disables production standalone image sessions without the desktop authority", () => {
    expect(
      isImageSessionDeploymentSupported(
        { NODE_ENV: "production", HOST: "127.0.0.1" },
        { isProduction: true }
      )
    ).toBe(false);
    expect(
      isImageSessionDeploymentSupported(
        { NODE_ENV: "production", HOST: "localhost", AI_ENDPOINT_TOKEN: "shared" },
        { isProduction: true }
      )
    ).toBe(false);
  });

  it("accepts production only when the existing desktop secret gate is configured", () => {
    expect(
      isImageSessionDeploymentSupported(
        {
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          TKC_DESKTOP_SESSION_TOKEN: "desktop-test-secret",
        },
        { isProduction: true }
      )
    ).toBe(true);
  });
});
