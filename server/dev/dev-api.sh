#!/usr/bin/env bash
# Start/stop/probe the local pi-pod-server dev API.
set -euo pipefail

SERVER_DIR="${SERVER_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
RUN_DIR="${RUN_DIR:-$SERVER_DIR/.dev}"
SERVER_URL="${SERVER_URL:-http://127.0.0.1:8080}"
SERVER_PROBE_PATH="${SERVER_PROBE_PATH:-/v1/templates}"
PORT="${PORT:-8080}"

mkdir -p "$RUN_DIR"

load_env() {
  if [[ ! -f "$SERVER_DIR/.env" ]]; then
    echo "missing $SERVER_DIR/.env — copy .env.example and fill in keys" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  source "$SERVER_DIR/.env"
  set +a
}

is_current() {
  curl -sf "$SERVER_URL/v1/openapi.json" 2>/dev/null | grep -q "\"$SERVER_PROBE_PATH\""
}

is_up() {
  curl -sf "$SERVER_URL/v1/openapi.json" >/dev/null 2>&1
}

stop_api() {
  if [[ -f "$RUN_DIR/server.pid" ]]; then
    local pid
    pid="$(cat "$RUN_DIR/server.pid")"
    kill "$pid" 2>/dev/null || true
    rm -f "$RUN_DIR/server.pid"
  fi
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "Stopping listener(s) on :$PORT: $pids" >&2
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 0.5
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

start_api() {
  load_env
  echo "Starting pi-pod-server (ROLE=all) on :$PORT" >&2
  (
    cd "$SERVER_DIR"
    nohup env ROLE=all node --import tsx src/server/main.ts \
      >"$RUN_DIR/server.log" 2>&1 &
    echo $! >"$RUN_DIR/server.pid"
  )
}

cmd="${1:-}"
case "$cmd" in
  probe)
    if is_current; then
      echo "current"
    elif is_up; then
      echo "stale"
    else
      echo "down"
    fi
    ;;
  ensure)
    if is_current; then
      echo "API already up and current at $SERVER_URL" >&2
      exit 0
    fi
    if is_up; then
      echo "API at $SERVER_URL is stale (missing $SERVER_PROBE_PATH); restarting…" >&2
      stop_api
    fi
    start_api
    ;;
  stop)
    stop_api
    ;;
  wait)
    echo "Waiting for API at $SERVER_URL (needs $SERVER_PROBE_PATH)…" >&2
    for _ in $(seq 1 120); do
      if is_current; then
        echo "API ready" >&2
        exit 0
      fi
      sleep 0.5
    done
    echo "API did not become ready with $SERVER_PROBE_PATH — see $RUN_DIR/server.log" >&2
    tail -n 40 "$RUN_DIR/server.log" 2>/dev/null || true
    exit 1
    ;;
  *)
    echo "usage: $0 probe|ensure|wait|stop" >&2
    exit 2
    ;;
esac
