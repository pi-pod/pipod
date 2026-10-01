#!/usr/bin/env bash
# Grant a user ORG_OWNER on one organization plus the pipod `owner` role bundle.
# Never grant IAM_OWNER or any instance-level Zitadel role to tenant org owners.
set -euo pipefail

: "${ZITADEL_URL:=http://127.0.0.1:8081}"
: "${ZITADEL_PAT:?set ZITADEL_PAT (admin service-user personal access token)}"
: "${ZITADEL_PROJECT:=pipod}"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <user-email> <organization-name>" >&2
  exit 2
fi

export ZITADEL_URL ZITADEL_PAT ZITADEL_PROJECT
node "$(dirname "$0")/grant-org-admin.mjs" "$1" "$2"
