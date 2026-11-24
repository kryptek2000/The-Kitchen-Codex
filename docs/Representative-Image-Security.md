# Representative Image Security & Architecture

**Scope:** The licensed representative-image search, thumbnail, and selection flow
(Phase 1). This document records the authority, requester, privacy, fetching, and
licensing boundaries of that flow. It describes existing behavior only.

Relevant implementation:

- `src/core/representativeImage.ts` — platform-neutral core (license allowlist, query builder, candidate shapes)
- `server/representativeImage.ts` — server-only search/selection/thumbnail authority
- `server/app.ts` — route wiring + image-session gate
- `server/imageSessionAuthority.ts`, `server/imageSession.ts`, `server/imageSessionRoutes.ts` — server-issued image-session authority, cookie, and bootstrap/revoke routes
- `src/components/RepresentativeImageChooser.tsx`, `src/components/RecipeEditorModal.tsx` — explicit UI

## Candidate authority

- Candidate IDs are opaque and contain **192 bits of cryptographic randomness**
  (`randomBytes(24)`, base64url), minted server-side per search.
- The browser receives **only opaque IDs and app-local preview paths** (the
  `/api/recipes/image/representative-thumbnail/<id>` route). It never receives or
  renders an upstream thumbnail URL.
- **Full-resolution and thumbnail upstream URLs remain server-side** on the stored
  candidate record.
- Candidate records are held **only in process memory**; nothing is persisted to
  disk.
- **Restart invalidates all candidates.**
- Candidate **TTL is 10 minutes** (`REPRESENTATIVE_CANDIDATE_TTL_MS`).
- Storage is bounded to **24 candidates per requester** and **120 globally**
  (`MAX_STORED_CANDIDATES_PER_REQUESTER`, `MAX_STORED_CANDIDATES`). New candidates
  are dropped at the limit; other requesters' candidates are never evicted.
- A **successful final selection consumes the candidate** (one-time use).
- **Thumbnail access does not consume** the candidate.
- **Unknown, expired, and mismatched (cross-requester) candidates return
  indistinguishable not-found responses** — the thumbnail route returns `404`
  `CANDIDATE_NOT_FOUND` for all three, and the selection route returns `404` for
  found/expired/mismatched alike, so there is no existence oracle.

## Requester scope (P2-R1)

- Candidate, thumbnail, generated-preview, and paid-confirmation ownership are
  bound to a **server-issued opaque image session**, never to the source IP.
- The session is issued by `POST /api/session/bootstrap` only after the
  deployment and same-origin checks pass. The raw token is delivered **only** as
  an `HttpOnly`, `SameSite=Strict`, `Path=/api` cookie; only its SHA-256 digest is
  held in process memory. The server also mints an independent random
  `sessionId`; downstream authorization/preview records use that id, never the
  cookie value.
- Sessions have an **absolute 8-hour TTL** and a **sliding 2-hour idle TTL**.
  `DELETE /api/session` revokes the current session; restart revokes all.
- **Same-IP clients no longer share a scope.** A second client on the same
  loopback/NAT IP receives a different session and cannot consume the first
  client's confirmation token or read/delete its preview, even with the exact
  opaque token.
- `AI_ENDPOINT_TOKEN`, when configured, is still required for bootstrap. It is a
  shared operator bearer, **not** a user/session identity; the image session
  supplies that separate identity. In production, the existing Electron desktop
  access gate is also mandatory; a standalone loopback server without that
  server-verified authority cannot bootstrap image sessions or use protected
  image routes. Development-only loopback remains available for local work.
- Bootstrap requires an exact same-origin `Origin`, a loopback `Host` header
  (DNS-rebinding guard), and no cross-site fetch metadata. In production Electron,
  the existing per-process desktop cookie gate is also enforced by the global
  `/api` middleware.
- **Hosted/multi-user configurations and production standalone loopback
  configurations without the desktop gate fail closed**
  (`IMAGE_SESSION_UNAVAILABLE`). Only the trusted Electron desktop deployment
  is supported for production image sessions; development-only loopback remains
  available for local work. A local OS process that can forge HTTP headers is
  outside the browser isolation boundary, but cannot turn those headers into a
  production image-session authority.
- **Operators must configure the existing trusted-proxy policy correctly**
  (`TRUST_PROXY`). The image-session gate intentionally does not use
  `X-Forwarded-For` as identity; IP remains only a rate-limit key.

## Privacy and fetching

- Searches occur **only after explicit user action** ("Find Representative Image").
  No background or automatic search runs.
- **Sanitized visual terms** (title / cuisine / course / up to three distinctive
  ingredients) are sent to **Openverse** and, when Openverse yields no safe
  candidate, to **Wikimedia Commons**. Unsafe terms (credentials, URLs, paths,
  emails, HTML, control characters) are dropped; an empty safe query makes **zero
  external calls**.
- Candidate **thumbnails are served through app-local hardened routes**; the
  browser does **not hotlink upstream thumbnails**.
- Selected images use the **existing SSRF/DNS-pinned, MIME-validated,
  byte-bounded image pipeline** (`safeFetchImage`), with metadata fetched through
  the hardened `safeFetchJson` path. There is no parallel weaker downloader.
- **No AI image provider is called by this representative-image flow.** No
  generation occurs; nothing is invented.

## Licensing

- **Accepted families: CC0, Public Domain, CC BY, CC BY-SA.**
- **NC, ND, missing, and unknown licenses fail closed** (`normalizeRepresentativeLicense`
  returns `null` and the candidate is discarded). Upstream license metadata is
  revalidated at selection time (defense in depth).
- **Attribution metadata is preserved** (source, source page URL, creator when
  present, canonical license URL, and license version; the version is reported as
  `unknown` rather than invented when it cannot be safely established).
- **Representative results are not guaranteed to depict the exact generated
  recipe.** A searched image may resemble the recipe but is never asserted to be
  the dish itself.

## Related documents

- `docs/BYOK-5-Architecture.md` — session-only BYOK credential architecture and
  supported single-user deployment modes.
- `SECURITY.md` — vulnerability reporting policy.
