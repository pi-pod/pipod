#!/usr/bin/env bash
# Sample the fleet cgroup while a load run is in flight: cores actually consumed by all
# sandboxes together, host load, and PSI.
# The fleet cgroup path is overridable; the default matches the hetzner-1 layout.
set -uo pipefail
secs="${1:-30}"
CG="${CG:-/sys/fs/cgroup/pps}"
u0=$(awk '/usage_usec/{print $2}' "$CG/cpu.stat"); t0=$(date +%s%N)
sleep "$secs"
u1=$(awk '/usage_usec/{print $2}' "$CG/cpu.stat"); t1=$(date +%s%N)
cores=$(python3 -c "print('%.3f' % (($u1-$u0)/(($t1-$t0)/1000.0)))")
printf '{"fleetCores":%s,"fleetCpuMax":"%s","fleetMemCurrentGiB":%s,"fleetMemHighGiB":%s,"loadavg":"%s","hostCpuPSIavg10":%s,"hostMemPSIavg10":%s,"throttledUsec":%s}\n' \
  "$cores" \
  "$(cat $CG/cpu.max)" \
  "$(python3 -c "print('%.2f' % ($(cat $CG/memory.current)/1073741824))")" \
  "$(python3 -c "print('%.2f' % ($(cat $CG/memory.high)/1073741824))")" \
  "$(cut -d' ' -f1-3 /proc/loadavg)" \
  "$(grep some /sys/fs/cgroup/cpu.pressure | sed -E 's/.*avg10=([0-9.]+).*/\1/')" \
  "$(grep some /sys/fs/cgroup/memory.pressure | sed -E 's/.*avg10=([0-9.]+).*/\1/')" \
  "$(awk '/throttled_usec/{print $2}' $CG/cpu.stat)"
