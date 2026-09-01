/**
 * The Kitchen Codex — Release Version Bump Utility
 *
 * Keeps every version-bearing file in sync so future releases cannot drift.
 * The runtime constant is `src/appVersion.ts` (`RELEASE_VERSION`); `package.json`,
 * `README.md` and the CHANGELOG must never disagree with it.
 *
 * Usage:
 *   bun x tsx scripts/bump_version.ts v0.3.0
 *
 * What it updates mechanically (version strings ONLY, no authored content):
 *   - src/appVersion.ts        : `RELEASE_VERSION = "vX.Y.Z"`
 *   - package.json             : `"version": "X.Y.Z"`   (no leading 'v')
 *   - README.md                : header `vX.Y.Z` and the shield badge `version-X.Y.Z`
 *
 * After running it, finish the release by hand (the script prints a checklist):
 *   - Add a CHANGELOG.md entry under a new `## [X.Y.Z]` heading.
 *   - Author RELEASE_NOTES_vX.Y.Z.md (and optionally retire the old one).
 *   - Commit, tag `vX.Y.Z`, push, and publish the GitHub Release.
 *
 * The script never edits `bun.lock`, the git tags, or existing releases, and it
 * will refuse to run if the working tree has uncommitted changes so a bump is
 * always a clean, reviewable commit.
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Pure transform: returns updated contents for the three version-bearing files
 * given a target version. Exported so it can be unit-tested hermetically.
 */
export function syncVersionContents(version: string, contents: {
  appVersion: string;
  packageJson: string;
  readme: string;
}): { appVersion: string; packageJson: string; readme: string } {
  const raw = VERSION_RE.exec(version);
  if (!raw) {
    throw new Error(`Invalid semantic version "${version}". Use a value like v1.2.3 or 1.2.3.`);
  }
  const withV = `v${raw[1]}.${raw[2]}.${raw[3]}`;
  const bare = `${raw[1]}.${raw[2]}.${raw[3]}`;

  const appVersion = contents.appVersion.replace(
    /export const RELEASE_VERSION = "v?\d+\.\d+\.\d+";/,
    `export const RELEASE_VERSION = "${withV}";`
  );

  const packageJson = contents.packageJson.replace(
    /("version"\s*:\s*")v?\d+\.\d+\.\d+(")/,
    `$1${bare}$2`
  );

  // README header line: "# 🍳 The Kitchen Codex \`vX.Y.Z\`"
  let readme = contents.readme;
  readme = readme.replace(
    /(# 🍳 The Kitchen Codex `)v?\d+\.\d+\.\d+(`)/,
    `$1${withV}$2`
  );
  // README shield badge: "[![Version](https://img.shields.io/badge/version-X.Y.Z-...)"
  readme = readme.replace(
    /(img\.shields\.io\/badge\/version-)v?\d+\.\d+\.\d+(-)/,
    `$1${bare}$2`
  );

  const appVersionUpdated = contents.appVersion !== appVersion;
  const packageJsonUpdated = contents.packageJson !== packageJson;
  const readmeUpdated = contents.readme !== readme;

  if (!appVersionUpdated && !packageJsonUpdated && !readmeUpdated) {
    throw new Error(
      `Version "${withV}" is already applied — no version-bearing pattern matched or the files are already in sync.`
    );
  }

  return { appVersion, packageJson, readme };
}

function repoRoot(): string {
  return new URL("..", import.meta.url).pathname;
}

function main(): void {
  const target = process.argv[2];
  if (!target) {
    console.error(
      "Usage: bun x tsx scripts/bump_version.ts v0.3.0\n\n" +
        "Note: this only rewrites the version STRINGS in src/appVersion.ts, " +
        "package.json, and README.md. Add the CHANGELOG entry and release notes by hand."
    );
    process.exit(1);
  }

  try {
    execSync("git diff --quiet && git diff --cached --quiet", {
      cwd: repoRoot(),
      stdio: "pipe",
    });
  } catch {
    console.error("Aborting: the working tree has uncommitted changes. Commit first so a version bump is reviewable.");
    process.exit(1);
  }

  const root = repoRoot();
  const appVersionPath = `${root}src/appVersion.ts`;
  const packageJsonPath = `${root}package.json`;
  const readmePath = `${root}README.md`;

  const updated = syncVersionContents(target, {
    appVersion: readFileSync(appVersionPath, "utf8"),
    packageJson: readFileSync(packageJsonPath, "utf8"),
    readme: readFileSync(readmePath, "utf8"),
  });

  writeFileSync(appVersionPath, updated.appVersion);
  writeFileSync(packageJsonPath, updated.packageJson);
  writeFileSync(readmePath, updated.readme);

  console.log(`✅ Bumped version to ${target}`);
  console.log("   Updated: src/appVersion.ts, package.json, README.md");
  console.log("\nFinish the release by hand:");
  console.log("   1. Add a CHANGELOG.md entry under `## [X.Y.Z]`.");
  console.log("   2. Author RELEASE_NOTES_vX.Y.Z.md.");
  console.log("   3. Commit, tag vX.Y.Z, push, and publish the GitHub Release.");
}

if (process.argv[1] && process.argv[1].endsWith("bump_version.ts")) {
  main();
}
