#!/usr/bin/env bash
# Create a Zitadel tenant organization and grant it the pipod project roles.
set -euo pipefail

: "${ZITADEL_URL:=http://127.0.0.1:8081}"
: "${ZITADEL_PAT:?set ZITADEL_PAT (admin service-user personal access token)}"
: "${ZITADEL_PROJECT:=pipod}"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <organization-name>" >&2
  exit 2
fi

export ZITADEL_URL ZITADEL_PAT ZITADEL_PROJECT
node "$(dirname "$0")/provision-org.mjs" "$1"
