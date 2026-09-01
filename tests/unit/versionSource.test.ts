import { describe, it, expect } from "vitest";
import { APP_VERSION } from "../../src/version.js";
import { RELEASE_VERSION } from "../../src/appVersion.js";
import { syncVersionContents } from "../../scripts/bump_version.js";

describe("Release version single-source-of-truth", () => {
  it("exposes the same runtime version to client and server", () => {
    expect(APP_VERSION).toBe(RELEASE_VERSION);
  });

  it("uses a stable semver-with-v release constant", () => {
    expect(RELEASE_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(APP_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("does not consult a build-time env override that could pin an old version", () => {
    // The client version must be the literal shared constant, never a
    // runtime/bundler-substituted value that can silently drift.
    expect(APP_VERSION).not.toContain("import.meta");
  });
});

describe("release bump script (pure transform)", () => {
  const appVersionSrc = `export const RELEASE_VERSION = "v0.2.6";\n`;
  const packageJsonSrc = `{\n  "version": "0.2.5",\n  "name": "the-kitchen-codex"\n}\n`;
  const readmeSrc = [
    `# 🍳 The Kitchen Codex \`v0.2.5\``,
    ``,
    `[![Version](https://img.shields.io/badge/version-0.2.5-amber.svg)](package.json)`,
    ``,
  ].join("\n");

  it("updates appVersion, package.json and README to the same target version", () => {
    const out = syncVersionContents("v0.2.7", {
      appVersion: appVersionSrc,
      packageJson: packageJsonSrc,
      readme: readmeSrc,
    });
    expect(out.appVersion).toBe(`export const RELEASE_VERSION = "v0.2.7";\n`);
    expect(out.packageJson).toContain(`"version": "0.2.7"`);
    expect(out.readme).toContain(`# 🍳 The Kitchen Codex \`v0.2.7\``);
    expect(out.readme).toContain(`badge/version-0.2.7-amber`);
    // All three agree (package.json keeps the bare form).
    expect("v" + JSON.parse(out.packageJson).version).toBe("v0.2.7");
  });

  it("accepts a bare version and normalizes it to a v-prefixed constant", () => {
    const out = syncVersionContents("0.3.0", {
      appVersion: appVersionSrc,
      packageJson: packageJsonSrc,
      readme: readmeSrc,
    });
    expect(out.appVersion).toContain(`"v0.3.0"`);
    expect(out.packageJson).toContain(`"version": "0.3.0"`);
  });

  it("throws on an invalid semantic version", () => {
    expect(() =>
      syncVersionContents("banana", {
        appVersion: appVersionSrc,
        packageJson: packageJsonSrc,
        readme: readmeSrc,
      })
    ).toThrow(/Invalid semantic version/);
  });

  it("throws when the target is already applied", () => {
    expect(() =>
      syncVersionContents("v0.2.7", {
        appVersion: `export const RELEASE_VERSION = "v0.2.7";\n`,
        packageJson: `{\n  "version": "0.2.7"\n}\n`,
        readme: `# 🍳 The Kitchen Codex \`v0.2.7\``,
      })
    ).toThrow(/already in sync/);
  });
});
