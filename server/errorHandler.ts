/**
 * The Kitchen Codex — centralized API error handler.
 *
 * Express routes already catch and format their own errors, so this middleware
 * only sees errors that propagated to the end of the stack. Its two jobs:
 *
 *   1. malformed JSON bodies (thrown by `express.json()`) become a clean JSON
 *      400 response instead of Express's default HTML error page — and any
 *      request-body size-limit errors keep their real HTTP status (413).
 *   2. any otherwise-unhandled internal error returns JSON and never leaks
 *      filesystem paths or stack traces to the client.
 *
 * Known route errors are NOT masked: routes format their own responses before
 * reaching here. This handler is registered last.
 */
import type { ErrorRequestHandler } from "express";

interface HttpErrorLike {
  status?: number;
  statusCode?: number;
  type?: string;
  code?: string;
  message?: string;
}

/**
 * Returns an Express error-handling middleware for the HTTP API.
 */
export function createApiErrorHandler(): ErrorRequestHandler {
  return (err, req, res, _next) => {
    // If headers were already sent, defer to Express to close the connection.
    if (res.headersSent) {
      return;
    }

    const e = (err ?? {}) as HttpErrorLike;
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;

    // body-parser / express.json: malformed JSON -> 400, payload too large -> 413.
    if (status === 400 && (e.type === "entity.parse.failed" || e instanceof SyntaxError)) {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }
    if (status === 413) {
      return res.status(413).json({ error: "Request body is too large" });
    }

    // Anything >= 500 is a genuine internal error; log it server-side only.
    if (status >= 500) {
      const msg = e.message || String(err);
      console.error(
        `[${new Date().toISOString()}] [${req.method} ${req.originalUrl}] Unhandled error:`,
        msg
      );
    }

    return res.status(status).json({ error: "Internal server error" });
  };
}
