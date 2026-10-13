/**
 * The Kitchen Codex — Advanced Nutrition: DEVELOPMENT-ONLY USDA artifact delivery.
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured in the real Vite dev server with a real browser:
 *
 *   on disk / Content-Length      53877 bytes, gzip magic 1f8b0800
 *   response header              Content-Encoding: gzip
 *   bytes handed to JavaScript   958025 bytes, JSON magic 5b7b22 ("[{" )
 *
 * Vite's development static server labels any file whose extension is `.gz` with
 * `Content-Encoding: gzip`. That header is a TRANSPORT declaration: per RFC 9110
 * the user agent must decode the body before the application sees it. The locked
 * USDA shards are not gzip transport encodings — they ARE the gzip artifacts — so
 * the browser transparently decompressed them, the exact-length/digest verification
 * correctly failed closed, and the UI reported "Advanced Nutrition could not
 * authenticate its local USDA data." The other two shards inflated the same way
 * (1456503 -> 33695908 and 981412 -> 25024331).
 *
 * THE FIX IS THE SMALLEST CORRECT ONE. The dev server already delivers the exact
 * compressed bytes; only the header is wrong. So this middleware does not re-serve
 * the files, does not read them, and does not re-implement delivery: it lets Vite
 * produce the response and simply withholds the incorrect `Content-Encoding`
 * declaration for those five locked files.
 *
 * This module deliberately performs NO filesystem access. Phase 9A pinned that the
 * application holds no disk read/write capability in production code, which is
 * precisely why there is no secure store; reintroducing `node:fs` here would
 * silently reverse that audited decision. Authentication therefore remains exactly
 * where it already was and is not duplicated or weakened: the unchanged browser
 * fetch ceiling and the unchanged runtime composer/digest checks verify the bytes.
 *
 * SCOPE AND SAFETY
 * ----------------
 * - DEVELOPMENT ONLY. Never mounted in production (see server.ts); `vite build`
 *   emits each file as a content-hashed static asset copied byte-for-byte, and the
 *   production server does not attach this middleware at all.
 * - Matches ONLY an exact locked filename under ONE fixed, compile-time directory
 *   derived from the source-controlled release lock. Any other request is passed
 *   through untouched, so unrelated files and unrelated gzip responses are never
 *   intercepted.
 * - Never intercepts Vite's own `?import&url&no-inline` MODULE transform of the
 *   same files; those keep flowing through Vite so the dev app still boots. Only
 *   the browser's raw asset delivery (`?no-inline`) is affected.
 * - Sets NO `Content-Encoding`, so the UA is never told to decode an artifact, and
 *   never accepts decompressed bytes as an alternative authority.
 */

import type { Request, RequestHandler, Response } from "express";

import { USDA_BUNDLE_RELEASE_LOCK } from "../src/core/nutritionV2/usda/releaseLock.js";

/** The exact public path prefix Vite serves the locked assets under. */
export const USDA_BUNDLE_PUBLIC_PREFIX =
  `/data/advanced-nutrition/usda/${USDA_BUNDLE_RELEASE_LOCK.bundle_release}/`;

/**
 * The locked filenames, derived ENTIRELY from the release lock so the affected set
 * can never drift from the authenticated set.
 */
function buildLockedFilenames(): ReadonlySet<string> {
  const lock = USDA_BUNDLE_RELEASE_LOCK;
  return new Set<string>([
    lock.artifact.filename,
    lock.manifest.filename,
    ...lock.shards.map((shard) => shard.filename),
  ]);
}

const LOCKED_FILENAMES = buildLockedFilenames();

/** The truthful media type for each locked artifact. */
function mediaTypeFor(filename: string): string {
  return filename.endsWith(".gz") ? "application/gzip" : "application/json";
}

/**
 * True when the request is Vite's MODULE TRANSFORM of an asset rather than a raw
 * asset delivery.
 *
 * `import u from '...?url&no-inline'` makes Vite serve a JavaScript module that
 * exports the asset URL. That module response must keep flowing through Vite; if
 * this middleware treated it as a raw delivery the dev app would fail to boot.
 * The browser's own raw fetch carries only `?no-inline`, so tokenising the query
 * and refusing Vite's own `import`/`url`/`raw` markers cleanly separates the two.
 */
export function isViteModuleTransformRequest(originalUrl: unknown): boolean {
  if (typeof originalUrl !== "string") return true;
  const queryStart = originalUrl.indexOf("?");
  if (queryStart === -1) return false;
  for (const token of originalUrl.slice(queryStart + 1).split("&")) {
    const name = token.split("=")[0];
    if (name === "import" || name === "url" || name === "raw") return true;
  }
  return false;
}

/**
 * Resolves a request pathname to a locked artifact filename, or null when the
 * request is not for one. Exported for direct testing.
 *
 * The final segment must equal a locked filename EXACTLY, so traversal, encoding
 * tricks, partial matches and user-selected segments cannot select another file.
 */
export function resolveLockedUsdaArtifact(
  pathname: unknown,
): { readonly filename: string; readonly mediaType: string } | null {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  if (!pathname.startsWith(USDA_BUNDLE_PUBLIC_PREFIX)) return null;
  const filename = pathname.slice(USDA_BUNDLE_PUBLIC_PREFIX.length);
  if (!LOCKED_FILENAMES.has(filename)) return null;
  return { filename, mediaType: mediaTypeFor(filename) };
}

/**
 * The dev middleware. For a raw delivery of a locked USDA artifact it withholds
 * the incorrect `Content-Encoding` declaration and states the truthful media type,
 * then lets Vite serve the (already correct) bytes untouched.
 */
export function usdaBundleDevAssetMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    try {
      if (req.method !== "GET") return next();
      // Vite's own module transform for these files must stay with Vite.
      if (isViteModuleTransformRequest(req.originalUrl)) return next();
      const artifact = resolveLockedUsdaArtifact(req.path);
      if (!artifact) return next();

      // Suppress ONLY the incorrect transport encoding for this one response, so
      // the user agent is never told to decode an artifact that is already gzip.
      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: unknown): Response => {
        if (String(name).toLowerCase() === "content-encoding") return res;
        if (String(name).toLowerCase() === "content-type") {
          return originalSetHeader(name, artifact.mediaType);
        }
        return originalSetHeader(name, value as never);
      }) as Response["setHeader"];

      next();
    } catch {
      next();
    }
  };
}
