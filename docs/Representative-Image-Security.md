# Representative Image Security & Architecture

**Scope:** The licensed representative-image search, thumbnail, and selection flow
(Phase 1). This document records the authority, requester, privacy, fetching, and
licensing boundaries of that flow. It describes existing behavior only.

Relevant implementation:

- `src/core/representativeImage.ts` — platform-neutral core (license allowlist, query builder, candidate shapes)
- `server/representativeImage.ts` — server-only search/selection/thumbnail authority
- `server/app.ts` — route wiring + requester-identity derivation
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

## Requester scope

- Anonymous requester ownership is derived from the **trusted client IP returned by
  the existing proxy policy** (`getClientIp`, which uses Express's `req.ip` and the
  configured `trust proxy` setting — never a raw `X-Forwarded-For` header).
- The IP is combined with a **process-random salt** (32 bytes, generated at
  startup, held in memory only) and hashed with SHA-256 to produce the requester
  scope.
- The **raw IP and the hash are not persisted**.
- **Users sharing the same NAT or trusted proxy-derived client IP share the same
  anonymous requester scope.**
- An **opaque candidate ID is still required**, so sharing an IP alone does not
  reveal or enumerate candidates.
- This design is appropriate for the current **local-first / single-user
  deployment model**.
- A **shared multi-user deployment should bind candidate authority to an
  authenticated user/session or a separate anonymous browser session** rather than
  relying only on client IP.
- **Operators must configure the existing trusted-proxy policy correctly**
  (`TRUST_PROXY`). **Untrusted forwarding headers must not be accepted as requester
  identity**; when `TRUST_PROXY` is unset, Express uses the direct socket address
  and ignores `X-Forwarded-For`.

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
