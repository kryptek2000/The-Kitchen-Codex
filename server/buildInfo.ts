import { RELEASE_VERSION } from "../src/appVersion.js";

export const BUILD_VERSION: string = RELEASE_VERSION;

// Immutable build metadata. In production this is baked into the bundle via
// TKC_BUILD_COMMIT / TKC_BUILD_TIME. In development it falls back to "unknown"
// / empty so an unverified build is never reported as current.
export const BUILD_COMMIT: string =
  (typeof process !== "undefined" && process.env && process.env.TKC_BUILD_COMMIT) || "unknown";

export const BUILD_TIME: string =
  (typeof process !== "undefined" && process.env && process.env.TKC_BUILD_TIME) || "";
