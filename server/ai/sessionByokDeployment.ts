/**
 * The Kitchen Codex — session-only BYOK deployment guard (BYOK-5A).
 *
 * Answers whether SESSION-ONLY BYOK is permitted in the CURRENT deployment. The
 * session secret store holds provider credentials ONLY in server process memory,
 * so it is safe only for an explicitly-trusted LOCAL / SINGLE-USER deployment.
 * A public hosted multi-user deployment MUST be blocked.
 *
 * PRECEDENCE (strict, fail-closed):
 *   1. Hosted multi-user indicators (Cloud Run / AI Studio: `K_SERVICE`,
 *      `K_REVISION`, `K_CONFIGURATION`) ALWAYS block.
 *   2. The kill switch (`KITCHEN_CODEX_DISABLE_SESSION_BYOK`) ALWAYS blocks.
 *   3. A non-loopback / wildcard / external / malformed `HOST` ALWAYS blocks.
 *      `KITCHEN_CODEX_SESSION_BYOK` (explicit opt-in) CANNOT relax this bind
 *      check — the env guard must never diverge from the server's actual bind
 *      address. `server.ts` binds `0.0.0.0` whenever `HOST` says so.
 *   4. Only a loopback/default-local bind (`127.0.0.1` / `::1` / `localhost`, or
 *      no `HOST` override, matching `server.ts`) is the trusted single-user mode
 *      and is allowed. The explicit opt-in is accepted here but is not required
 *      (loopback is already the trusted local mode).
 *
 * EXPLICIT NON-GOALS:
 *   - The presence of `AI_ENDPOINT_TOKEN` is NOT proof of user identity and is
 *     NEVER consulted here.
 *   - No broad new auth system is introduced; this is a narrow deployment gate.
 */

/** Truthy parsing for the boolean-ish deployment env flags. */
function isTruthy(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** True when hosted multi-user platform indicators are present. */
function isHostedMultiUser(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.K_SERVICE || env.K_REVISION || env.K_CONFIGURATION);
}

/** True when the configured bind host is loopback-only. */
function isLoopbackHost(env: NodeJS.ProcessEnv): boolean {
  const host = (env.HOST || "").trim().toLowerCase();
  // No HOST override: server.ts defaults to 127.0.0.1 (local-only).
  if (!host) return true;
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Whether session-only BYOK is allowed for the current deployment. Reads only
 * deployment/config env names (never any secret value, never
 * `AI_ENDPOINT_TOKEN`). Returns `false` for unknown/unsupported modes
 * (fail-closed).
 */
export function isSessionByokSupportedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env) return false;
  // 1. Hosted multi-user always blocks.
  if (isHostedMultiUser(env)) return false;
  // 2. Explicit kill switch always blocks.
  if (isTruthy(env.KITCHEN_CODEX_DISABLE_SESSION_BYOK)) return false;
  // 3. Non-loopback / wildcard / external / malformed HOST always blocks.
  //    Explicit opt-in cannot relax this.
  if (!isLoopbackHost(env)) return false;
  // 4. Trusted loopback/default-local single-user mode.
  return true;
}
