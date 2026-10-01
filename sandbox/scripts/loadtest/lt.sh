#!/usr/bin/env bash
# Run the load-test harness in a throwaway container built from the service image.
# --env-file keeps the master token off the command line and out of the shell history.
# The token is NEVER a CLI flag: it travels only via --env-file into the container env.
#
# Host-specific paths are flags with hetzner-1 defaults; override per worker:
#   ./lt.sh --env-file <runtime.env> --lt-dir <dir> --service <name> --base <url> --out <dir> -- <lt.mjs args>
set -euo pipefail
ENV_FILE="/etc/pipod/pi-pod-sandbox/runtime.env"
LT_DIR="/root/loadtest"
SERVICE="pi-pod-sandbox"
BASE="http://10.79.0.2:8433"
OUT="/lt/out"
ARGS=()
while (($# > 0)); do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --lt-dir) LT_DIR="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --) shift; while (($# > 0)); do ARGS+=("$1"); shift; done ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
IMAGE="$(docker inspect "$SERVICE" --format '{{.Config.Image}}')"
exec docker run --rm --network host \
  --env-file "$ENV_FILE" \
  -e LT_BASE="$BASE" \
  -e LT_OUT="$OUT" \
  -v "$LT_DIR":/lt \
  --entrypoint node \
  "$IMAGE" /lt/lt.mjs "${ARGS[@]}"
