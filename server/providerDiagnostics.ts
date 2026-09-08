/**
 * The Kitchen Codex — safe provider-diagnostic logging (v0.5.1).
 *
 * Extracts a bounded, non-sensitive error summary from a provider/API failure so
 * operators can tell WHY a model attempt failed without ever logging secrets
 * (GEMINI_API_KEY / AI_ENDPOINT_TOKEN / Authorization headers), vault contents,
 * full prompts, raw provider payloads, or huge error objects.
 */

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim().slice(0, max);
  return s || undefined;
}

export function redactSecrets(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "<redacted-key>")
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "<redacted-key>")
    .replace(/Bearer\s+\S+/g, "Bearer <redacted>")
    .replace(/GEMINI_API_KEY[\s=:]+[^\s]+/g, "GEMINI_API_KEY=<redacted>");
}

/**
 * Returns only the safe, bounded fields describing a provider failure. Never
 * serializes the whole error object or any request/config payload.
 */
export function extractProviderError(
  error: unknown
): { name?: string; status?: number; code?: string; message?: string } {
  if (error == null) return {};
  const e = error as Record<string, unknown> | null | undefined;
  if (typeof e !== "object") return { message: bounded(String(error), 200) };
  const name = bounded(e["name"], 60);
  const statusNum =
    typeof e["status"] === "number" ? e["status"]
      : typeof e["code"] === "number" ? e["code"]
      : undefined;
  const code = bounded(e["code"], 60);
  const rawMessage = bounded(e["message"], 300);
  return {
    ...(name ? { name } : {}),
    ...(typeof statusNum === "number" ? { status: statusNum } : {}),
    ...(code ? { code } : {}),
    ...(rawMessage ? { message: redactSecrets(rawMessage) } : {}),
  };
}

/**
 * Logs a concise, redacted diagnostic line for a failed model attempt. Used by
 * the Kitchen AI resilience chains so the rational cause is observable without
 * leaking secrets or provider payloads. User-facing errors remain generic.
 */
export function logModelAttempt(
  component: string,
  model: string,
  error: unknown
): void {
  const d = extractProviderError(error);
  const parts = [`[Kitchen ${component}] model attempt failed`, `model=${model}`];
  if (d.name) parts.push(`name=${d.name}`);
  if (d.status !== undefined) parts.push(`status=${d.status}`);
  if (d.code) parts.push(`code=${d.code}`);
  if (d.message) parts.push(`message=${d.message}`);
  console.warn(parts.join(" "));
}
