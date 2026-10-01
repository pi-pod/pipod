#!/usr/bin/env bash
# One-line host snapshot used for the churn leak check.
# Host-specific paths are overridable; defaults match the hetzner-1 layout.
set -uo pipefail
label="${1:-snap}"
SERVICE="${SERVICE:-pi-pod-sandbox}"
CGROUP_GLOB="${CGROUP_GLOB:-/sys/fs/cgroup/pps/*/}"
STATE_DIR="${STATE_DIR:-/var/lib/docker/volumes/pipod_sandbox_state/_data/sandboxes}"
cg=$(ls -d $CGROUP_GLOB 2>/dev/null | wc -l)
loops=$(losetup -a 2>/dev/null | wc -l)
mounts=$(docker exec "$SERVICE" grep -c "/state/sandboxes" /proc/mounts || true)
svcpids=$(docker exec "$SERVICE" sh -c 'ls /proc | grep -c "^[0-9]\+$"' || true)
pids=$(ls /proc | grep -c '^[0-9]\+$')
netns=$(ip netns list 2>/dev/null | wc -l)
veth=$(ip -br link | grep -c '^pps\|^veth')
avail=$(df -B1 --output=avail / | tail -1)
statedu=$(du -sb "$STATE_DIR" 2>/dev/null | cut -f1)
memavail=$(awk '/MemAvailable/{print $2*1024}' /proc/meminfo)
printf '{"label":"%s","cgroupDirs":%s,"loopDevices":%s,"stateMounts":%s,"hostPids":%s,"svcPids":%s,"netns":%s,"veth":%s,"rootAvailBytes":%s,"sandboxesDirBytes":%s,"memAvailBytes":%s}\n' \
  "$label" "$cg" "$loops" "$mounts" "$pids" "$svcpids" "$netns" "$veth" "$avail" "${statedu:-0}" "$memavail"
