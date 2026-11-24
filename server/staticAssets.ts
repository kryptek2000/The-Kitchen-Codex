/**
 * Production static-asset boundary.
 *
 * The production server must never expose the whole `dist` tree. Only the
 * frontend build surface and the exact nine Starter images are public. Internal
 * bundles (`server.cjs`, source maps, voice child scripts) and unknown asset-like
 * paths fail closed before `express.static` is consulted.
 */

import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import path from "node:path";
import { isApprovedStarterImagePath } from "../src/data/starterImageAssets.js";

const PUBLIC_PREFIXES = ["/assets/", "/fonts/", "/images/"] as const;
const PUBLIC_DIRECTORIES = new Set(["/assets", "/assets/", "/fonts", "/fonts/", "/images", "/images/"]);
const PUBLIC_ROOT_FILES = new Set(["/favicon.svg"]);
const INTERNAL_PREFIXES = ["/voice", "/server.cjs"] as const;

function notFound(res: Response): void {
  res.status(404).type("text/plain").send("Not found");
}

function allowPublicAsset(res: Response): void {
  // Mark only requests that must be served by express.static. If the file is
  // missing, the post-static middleware returns 404 instead of the SPA index.
  res.locals.tkcPublicAssetRequest = true;
}

function requestPathname(req: Request): { pathname: string; hasQuery: boolean } {
  const raw = req.originalUrl || req.url || "";
  const queryIndex = raw.indexOf("?");
  return {
    pathname: queryIndex >= 0 ? raw.slice(0, queryIndex) : raw,
    hasQuery: queryIndex >= 0,
  };
}

function hasDotSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === "." || segment === "..");
}

/** A fail-closed guard mounted before express.static. */
export function createPublicAssetGuard(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    const { pathname, hasQuery } = requestPathname(req);

    // Reject encoded/backslash aliases and dot segments globally. Legitimate
    // app assets and SPA routes use plain slash-separated ASCII paths.
    if (
      pathname.includes("\\") ||
      pathname.includes("%") ||
      pathname.includes("#") ||
      pathname.includes("//") ||
      hasDotSegment(pathname)
    ) {
      return notFound(res);
    }

    // App-owned images are an exact allowlist, never a prefix.
    if (pathname === "/app-images" || pathname.startsWith("/app-images/")) {
      if (hasQuery || !isApprovedStarterImagePath(pathname)) return notFound(res);
      allowPublicAsset(res);
      return next();
    }

    if (PUBLIC_DIRECTORIES.has(pathname)) return notFound(res);
    if (PUBLIC_ROOT_FILES.has(pathname) || pathname === "/" || pathname === "/index.html") {
      allowPublicAsset(res);
      return next();
    }
    if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      allowPublicAsset(res);
      return next();
    }

    const lower = pathname.toLowerCase();
    if (INTERNAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) return notFound(res);

    // Unknown file-like paths must not fall through to the SPA or static root.
    if (path.extname(pathname)) return notFound(res);

    // Normal client routes fall through to the SPA fallback below.
    return next();
  };
}

/** Install the guarded production static surface and SPA fallback. */
export function installProductionStatic(app: Express, distPath: string): void {
  app.use(createPublicAssetGuard());
  app.use(express.static(distPath));
  app.use((_req, res, next) => {
    if (res.locals.tkcPublicAssetRequest) return notFound(res);
    return next();
  });
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}
