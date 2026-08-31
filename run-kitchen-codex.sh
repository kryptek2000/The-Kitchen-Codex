#!/usr/bin/env bash
# ==============================================================================
# The Kitchen Codex - Production Launch & Safe Server Restarter
# ==============================================================================
# Ensures:
# 1. Any existing server process on PORT (default 3000) is gracefully terminated
# 2. Port is confirmed open and unbound before starting new instance
# 3. Server is started with production bundle (dist/server.cjs)
# 4. Performs health check verification against /api/health
# 5. Opens the browser or outputs ready URL
# ==============================================================================

set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
BASE_URL="http://${HOST}:${PORT}"
MAX_WAIT_SECONDS=15
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR" || exit 1

echo "🍳 Starting The Kitchen Codex runner..."

# 0. Auto-update: pull the latest main from origin and rebuild if there are new
#    commits. This keeps the production bundle in sync with pushed changes.
#    Skips gracefully (with a notice, not an error) if this isn't a git repo or
#    the remote isn't reachable / offline.
AUTO_UPDATE="${KITCHEN_CODEX_AUTO_UPDATE:-1}"
CHANGED=0

if [ "$AUTO_UPDATE" = "1" ] && git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$APP_DIR" remote get-url origin >/dev/null 2>&1; then
    echo "🔄 Checking for updates from origin/main..."
    BEFORE="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
    git -C "$APP_DIR" fetch origin --quiet 2>/dev/null && {
      git -C "$APP_DIR" pull --ff-only origin main >/dev/null 2>&1 || true
    } || echo "   (remote unreachable — continuing with existing code)"
    AFTER="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"

    if [ -n "$BEFORE" ] && [ -n "$AFTER" ] && [ "$BEFORE" != "$AFTER" ]; then
      CHANGED=1
      echo "   ✨ Updated $(git -C "$APP_DIR" log --oneline "$BEFORE..$AFTER" 2>/dev/null | grep -c .) commit(s)."
    else
      echo "   ✓ Up to date."
    fi
  else
    echo "   (no 'origin' remote configured — skipping auto-update)"
  fi
else
  echo "   (auto-update disabled via KITCHEN_CODEX_AUTO_UPDATE=0, or not a git repo)"
fi

# 1. Rebuild when new code was pulled, or when dist/server.cjs is missing.
if [ "$CHANGED" = "1" ] || [ ! -f "dist/server.cjs" ]; then
  if [ "$CHANGED" = "1" ]; then
    echo "📦 Installing dependencies and rebuilding for updated source..."
  else
    echo "📦 Production build not found. Running build..."
  fi
  (cd "$APP_DIR" && (bun install --no-save >/dev/null 2>&1 || true))
  (cd "$APP_DIR" && (npm run build || bun run build))
fi

# 2. Detect and kill any stale running process on the target port
find_and_kill_port_owner() {
  local port="$1"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
  elif command -v fuser >/dev/null 2>&1; then
    pids=$(fuser "$port"/tcp 2>/dev/null || true)
  fi

  if [ -n "$pids" ]; then
    echo "⚠️  Found stale process(es) on port ${port} (PID: ${pids}). Killing gracefully..."
    for pid in $pids; do
      kill "$pid" 2>/dev/null || true
    done

    # Wait up to 5 seconds for port to clear
    for _ in $(seq 1 10); do
      if command -v lsof >/dev/null 2>&1; then
        if ! lsof -i:"$port" >/dev/null 2>&1; then
          echo "✅ Port ${port} is now free."
          return 0
        fi
      else
        sleep 0.5
      fi
      sleep 0.5
    done

    # Force kill if still holding
    echo "⚠️  Process did not exit cleanly. Force killing (SIGKILL)..."
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
    sleep 0.5
  else
    echo "✨ Port ${port} is available."
  fi
}

find_and_kill_port_owner "$PORT"

# 3. Start fresh production server fully detached so it survives this launcher
#    and its desktop session exiting. Use setsid to run in a new session, nohup to
#    ignore SIGHUP, and redirect all streams so the process is not tied to a TTY.
echo "🚀 Launching Node.js production server (node dist/server.cjs)..."
LOG_FILE="${KITCHEN_CODEX_LOG:-/tmp/kitchen-codex.log}"
setsid nohup env NODE_ENV=production PORT="$PORT" HOST="$HOST" node dist/server.cjs \
  >"${LOG_FILE}" 2>&1 </dev/null &
SERVER_PID=$!

echo "Server started with PID: ${SERVER_PID} (log: ${LOG_FILE})"

# 4. Wait for server health endpoint to respond
echo "⏳ Waiting for server health check on ${BASE_URL}/api/health..."
server_ready=false
for i in $(seq 1 "$MAX_WAIT_SECONDS"); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "❌ Server process terminated unexpectedly during startup. See ${LOG_FILE}"
    exit 1
  fi

  if curl -sf "${BASE_URL}/api/health" >/dev/null 2>&1; then
    server_ready=true
    break
  fi
  sleep 1
done

if [ "$server_ready" = false ]; then
  echo "❌ Server failed to respond to health check within ${MAX_WAIT_SECONDS} seconds. See ${LOG_FILE}"
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
fi

echo "✅ The Kitchen Codex is live and healthy at ${BASE_URL}"
echo "💡 Tip: If your browser displays cached content, perform a hard reload: Ctrl+Shift+R (or Cmd+Shift+R)."

# 5. Open browser if in desktop environment (do not block the launcher on it)
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${BASE_URL}" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "${BASE_URL}" >/dev/null 2>&1 || true
fi

echo "Launcher finished. Server continues running in the background (PID ${SERVER_PID})."
