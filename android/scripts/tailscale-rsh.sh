#!/usr/bin/env bash
# rsync supplies -l USER HOST COMMAND; tailscale ssh expects USER@HOST first.
set -euo pipefail
remote_user=$USER
if [[ ${1:-} == -l ]]; then remote_user=${2:?Missing rsync user}; shift 2; fi
remote_host=${1:?Missing rsync host}; shift
if [[ $remote_host == *@* ]]; then
  remote_user=${remote_host%%@*}
  remote_host=${remote_host#*@}
fi
ts=(tailscale)
if [[ -n ${TAILSCALE_SOCKET:-} ]]; then ts+=(--socket="$TAILSCALE_SOCKET"); fi
SSH_ARGS=(-o BatchMode=yes)
# The macOS wrapper does not add a userspace pipe; keep the selected node identity.
if [[ -n ${TAILSCALE_SOCKET:-} && $(uname -s) == Darwin ]]; then
  printf -v proxy '%q ' "${ts[@]}" nc
  SSH_ARGS+=(-o "ProxyCommand=${proxy}%h %p")
fi
exec "${ts[@]}" ssh "$remote_user@$remote_host" "${SSH_ARGS[@]}" "$@"
