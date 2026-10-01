# shellcheck shell=bash
# Sourced by the scripts in this directory, which run from it.

# `docker compose` with this deployment's own settings. Compose lets the caller's environment
# override .env, so a variable left exported in the shell — a ZITADEL_PAT from an earlier setup,
# say — would silently replace the value in .env. Unset every name compose.yml or .env uses.
compose() {
  local name unset=()
  for name in $( (grep -ohE '\$\{[A-Za-z_][A-Za-z0-9_]*' compose.yml | cut -c3-; grep -ohE '^[A-Za-z_][A-Za-z0-9_]*=' .env | tr -d =) | sort -u); do
    unset+=(-u "$name")
  done
  env "${unset[@]}" PIPOD_SOURCE_SHA="${PIPOD_SOURCE_SHA:-}" docker compose "$@"
}

# Run the `admin` tool with these arguments and print all it wrote. `compose run` attached can
# stop copying a container's output when it exits, losing the last lines (Compose 5.5); the
# container's log keeps everything.
admin() {
  local id status
  id="$(compose run -d admin "$@" 2>/dev/null)"
  status="$(docker wait "$id")"
  docker logs "$id"
  docker rm "$id" >/dev/null
  return "$status"
}

# The value .env assigns to $1, or nothing.
env_get() { sed -n "s/^$1=//p" .env | tail -n 1; }

# Assign $2 to $1 in .env, in place when the line exists.
env_set() {
  local next
  next="$(mktemp .env.XXXXXX)"
  awk -v key="$1" -v value="$2" '
    index($0, key "=") == 1 { if (!done) print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' .env >"$next"
  chmod 600 "$next"
  mv "$next" .env
}
