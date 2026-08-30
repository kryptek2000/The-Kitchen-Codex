import helmet from "helmet";
import type { RequestHandler } from "express";

/**
 * Content Security Policy directives.
 *
 * This is intentionally defensive rather than maximally strict. The React +
 * Vite single-page app renders inline style attributes for theming, loads
 * external Google Fonts, displays recipe images from arbitrary hosts, and may
 * render data:/blob: canvases (html2canvas recipe-card export, confetti). The
 * directive set below keeps `script-src` on 'self'/'unsafe-inline' (Vite's dev
 * runtime and some third-party shims inject inline scripts) instead of locking
 * down scripts, which would break the application. In exchange it hardens
 * object-src, base-uri, and frame-ancestors.
 *
 * Only applied in production: the Vite dev server injects inline module
 * preambles and opens a WebSocket for HMR, so a strict document CSP would break
 * `npm run dev`. See `createSecurityMiddleware`.
 */
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", "https:"],
  fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
} as const;

/**
 * Returns the Express middleware that applies the application's security
 * headers.
 *
 * - `X-Content-Type-Options: nosniff` (helmet default)
 * - Clickjacking protection (`X-Frame-Options` + CSP `frame-ancestors`)
 * - Referrer-Policy `strict-origin-when-cross-origin`
 * - HSTS (only meaningful once served over HTTPS)
 * - Additional safe defaults provided by helmet
 *
 * A Content Security Policy is emitted in production only. In development the
 * Vite dev server requires inline scripts and a WebSocket, so enforcing a
 * document CSP there would break local development; the non-CSP headers above
 * are still applied in both modes.
 */
export function createSecurityMiddleware(isProduction: boolean): RequestHandler {
  return helmet({
    // cross-origin-embedder-policy: same-origin would break cross-origin
    // resources loaded by the SPA (recipe/vault images). Leave disabled.
    crossOriginEmbedderPolicy: false,
    // allow the app and its /api proxy to serve images/assets across origins.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    contentSecurityPolicy: isProduction
      ? {
          useDefaults: false,
          directives: CSP_DIRECTIVES,
        }
      : false,
  });
}
