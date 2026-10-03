import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { createApp } from "./server/app.js";
import {
  createDeploymentNutritionProductAccessAuthority,
  NUTRITION_PRODUCT_TIER_ENV,
} from "./server/nutritionProductAccessAuthority.js";

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

// Cloud Run (used by AI Studio) injects K_SERVICE / K_REVISION / K_CONFIGURATION
// and requires the process to listen on all interfaces (0.0.0.0) so the
// platform's ingress proxy can reach it. Detect it automatically so deploys
// start without extra configuration. Otherwise default to loopback so a local
// run stays local-only unless the user opts in. An explicit HOST always wins.
const isCloudRun =
  !!process.env.K_SERVICE ||
  !!process.env.K_REVISION ||
  !!process.env.K_CONFIGURATION;
const HOST =
  (process.env.HOST || "").trim() ||
  (isCloudRun ? "0.0.0.0" : "127.0.0.1");

// The production build is bundled into dist/server.cjs (esbuild bakes
// NODE_ENV="production" into it). This defensive check also treats any run
// of the compiled bundle — detected via its `dist` path — as production so
// `node dist/server.cjs` never accidentally boots the Vite dev middleware.
const entryPath = process.argv[1] || "";
const isCompiledBundle = entryPath.split(path.sep).includes("dist");
const isProduction = process.env.NODE_ENV === "production" || isCompiledBundle;

// Build the API (security headers, JSON parsing, all routes, error handler).
// Asset serving (Vite dev middleware vs. prod static + SPA fallback) is attached
// below so it can differ per mode and the API stays independently testable.
//
// AI-5E SERVER PRODUCT-ACCESS AUTHORITY — this is the ONE and ONLY place the
// deployment reads product-access configuration, and the ONE place it COMPOSES the
// authority. `KITCHEN_CODEX_NUTRITION_PRODUCT_TIER` is a non-secret, server-owned,
// deployment-scoped input; the RAW value is read here exactly once, resolved through
// the unchanged AI-5A contract exactly once inside the deployment-authority factory,
// and the resulting authority is injected into `createApp()`.
//
// Only the exact string `ai_advanced` grants AI Advanced, so an absent, empty,
// malformed, wrong-case, whitespace-padded or aliased value is FAIL-CLOSED Basic. The
// raw value is never reparsed per request: changing the environment after startup
// cannot change this process's authority.
//
// The authority is REQUEST-CAPABLE but the deployment implementation is
// REQUEST-INDEPENDENT: it ignores headers, cookies, query, body, IP and Authorization
// content entirely, and no request field can select an authority implementation, its
// source, a raw tier, or a product access value. SERVER COMPOSITION selects the
// authority; the REQUEST never can.
//
// Identity is NEVER inferred from an IP address, from AI_ENDPOINT_TOKEN, from browser
// state, from Provider Settings, from an API key, from a vault, or from any header,
// cookie or localStorage value. A shared environment tier is NOT per-user
// authorization: this server currently has no authenticated account identity, and
// hosted per-user entitlement must replace this source (see
// docs/Advanced-Nutrition-Architecture.md §56 and §59).
const nutritionProductAccessAuthority =
  createDeploymentNutritionProductAccessAuthority(process.env[NUTRITION_PRODUCT_TIER_ENV]);

const app = createApp({
  isProduction,
  nutritionProductAccessAuthority,
});

// Serve frontend with Vite in dev, static files in prod
async function start() {
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Express 5 (path-to-regexp v8) no longer accepts the bare "*" wildcard.
    // Use an optional splat so the SPA fallback matches the site root (/),
    // nested client routes, and leaves already-registered /api routes intact.
    app.get("/{*splat}", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Bind to HOST: autodetected 0.0.0.0 on Cloud Run/AI Studio, else 127.0.0.1.
  // Set HOST explicitly to override.
  app.listen(PORT, HOST, () => {
    console.log(`The Kitchen Codex Server running on http://${HOST}:${PORT}`);
  });
}

start();
