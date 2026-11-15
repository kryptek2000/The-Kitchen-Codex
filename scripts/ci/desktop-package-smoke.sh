#!/usr/bin/env bash
# Linux packaged-desktop startup smoke.
#
# Attempts a sandbox-enabled launch first. If the CI runner cannot provide the
# Electron sandbox (a known container/runner limitation), records a warning and
# retries with --no-sandbox so a broken package still fails the job. The smoke
# always uses disposable document/profile roots and a non-3040 port.

set -euo pipefail

BUNDLE="${1:?usage: desktop-package-smoke.sh <bundle-dir> <work-dir>}"
WORK="${2:?usage: desktop-package-smoke.sh <bundle-dir> <work-dir>}"
APP="$BUNDLE/TheKitchenCodex"
PORT="${TKC_DESKTOP_SMOKE_PORT:-38471}"
RESULT="$WORK/smoke-result.txt"
LOG="$WORK/desktop.log"

if [ ! -x "$APP" ]; then
  echo "::error title=Desktop Package Missing::Executable not found: $APP" >&2
  exit 1
fi
if [ "$PORT" = "3040" ]; then
  echo "::error title=Forbidden Smoke Port::Refusing to use port 3040." >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK/docs" "$WORK/profile"

XVFB=()
if [ "${USE_XVFB:-1}" = "1" ] && [ -z "${DISPLAY:-}" ]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "::error title=Missing Xvfb::xvfb-run is required for headless desktop smoke." >&2
    exit 1
  fi
  XVFB=(xvfb-run -a)
fi

APP_PID=""

terminate_tree() {
  local signal="$1"
  local pid="$2"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    terminate_tree "$signal" "$child"
  done
  kill "-$signal" "$pid" 2>/dev/null || true
}

cleanup_app() {
  if [ -n "$APP_PID" ]; then
    terminate_tree TERM "$APP_PID"
    sleep 2
    terminate_tree KILL "$APP_PID"
    wait "$APP_PID" 2>/dev/null || true
    APP_PID=""
  fi
}
trap cleanup_app EXIT

attempt_startup() {
  local mode="$1"
  shift
  : > "$LOG"
  "${XVFB[@]}" env \
    TKC_DESKTOP_DOCUMENTS_ROOT="$WORK/docs" \
    TKC_DESKTOP_PORT="$PORT" \
    "$APP" --disable-gpu --disable-dev-shm-usage \
    --user-data-dir="$WORK/profile" "$@" >"$LOG" 2>&1 &
  APP_PID=$!

  local deadline=$((SECONDS + 45))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl --fail --silent --show-error --max-time 2 \
      "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      local unauth
      unauth="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
        "http://127.0.0.1:$PORT/api/voice/status" || true)"
      if [ "$unauth" != "403" ]; then
        echo "::error title=Desktop API Auth::Expected unauthenticated /api/voice/status to return 403, got $unauth" >&2
        return 1
      fi
      printf 'mode=%s\nhealth=200\nunauthenticated_api=%s\n' "$mode" "$unauth" > "$RESULT"
      return 0
    fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  return 1
}

echo "Attempting sandbox-enabled packaged startup..."
if attempt_startup sandbox; then
  echo "✓ Sandbox-enabled packaged startup passed."
  exit 0
fi
cleanup_app

if grep -qiE 'sandbox|SUID|Operation not permitted|namespace' "$LOG"; then
  echo "::warning title=Electron Sandbox Unavailable::The runner could not start the packaged app with its sandbox; retrying with --no-sandbox for package diagnosis."
else
  echo "Sandbox attempt failed without a recognized sandbox error; retrying with --no-sandbox for diagnosis." >&2
fi

if attempt_startup no-sandbox --no-sandbox; then
  echo "✓ Packaged startup passed with the environment fallback (sandbox unavailable on this runner)."
  exit 0
fi
cleanup_app

echo "::error title=Desktop Package Smoke Failed::The packaged application did not reach backend health." >&2
tail -120 "$LOG" >&2 || true
exit 1
