#!/usr/bin/env bash
# Privileged root-suite gate for CI (docs/manual-tests-cost-controls.md, plan §10.1).
#
# Runs `test/root/**` as root on an ISOLATED, ephemeral runner and fails unless every root
# test actually executed: a missing dependency makes the suites skip themselves, and a
# green all-skip run must never count as a passed gate. Never run this against a host
# that serves customers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "root-test-gate: must run as root (re-exec with sudo --preserve-env=PATH)" >&2
  exit 2
fi
if [[ "${PI_POD_SANDBOX_NETWORK_TESTS:-}" != "1" ]]; then
  echo "root-test-gate: PI_POD_SANDBOX_NETWORK_TESTS=1 is required" >&2
  exit 2
fi

# Every binary the runtime shells out to (src/runtime/*, src/archive/pack.ts) plus the
# init-binary toolchain. A missing one would surface as skipped/failed tests; name it first.
required=(node npm cc crun ip nft mount umount mkfs.ext4 resize2fs findmnt losetup tar zstd setfattr getfattr mknod cp)
missing=()
for bin in "${required[@]}"; do
  command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
done
if (( ${#missing[@]} > 0 )); then
  echo "root-test-gate: missing required tools: ${missing[*]}" >&2
  exit 2
fi
if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
  echo "root-test-gate: cgroup v2 unified hierarchy is required" >&2
  exit 2
fi
for controller in cpu memory pids; do
  grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers || {
    echo "root-test-gate: cgroup controller '$controller' unavailable" >&2
    exit 2
  }
done
modprobe loop 2>/dev/null || true
[[ -e /dev/loop-control ]] || { echo "root-test-gate: /dev/loop-control missing (loop devices)" >&2; exit 2; }

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  echo "root-test-gate: Node >= 22 required, found $(node --version)" >&2
  exit 2
fi

./scripts/build-init.sh

files=(
  test/root/archive-handshake.test.ts
  test/root/archive-roundtrip.test.ts
  test/root/boat-tenant-cap.test.ts
  test/root/cost-controls.test.ts
  test/root/fleet-import.test.ts
  test/root/grant-lifecycle.test.ts
  test/root/image-integrity.test.ts
  test/root/images-pull.test.ts
  test/root/runtime-absence.test.ts
  test/root/service.test.ts
  test/root/transition-state.test.ts
  test/root/warm-tier.test.ts
  test/root/zombie-reap.test.ts
  test/images-whiteout.test.ts
)
for file in "${files[@]}"; do
  [[ -f "$file" ]] || { echo "root-test-gate: reviewed input missing: $file" >&2; exit 2; }
done
expected_files="${#files[@]}"

report="${RUNNER_TEMP:-/tmp}/root-tests.tap"
set +e
ZOMBIE_REAP_EXPECT_FIXED=1 node --import tsx --test --test-concurrency=1 \
  --test-reporter=tap --test-reporter-destination="$report" \
  --test-reporter=spec --test-reporter-destination=stdout \
  "${files[@]}"
status=$?
set -e

summary() { grep -E "^# $1 [0-9]+" "$report" | awk '{print $3}' | tail -1; }
tests="$(summary tests)"; pass="$(summary pass)"; fail="$(summary fail)"
skipped="$(summary skipped)"; cancelled="$(summary cancelled)"; todo="$(summary todo)"
echo "root-test-gate: tests=${tests:-?} pass=${pass:-?} fail=${fail:-?} skipped=${skipped:-?} cancelled=${cancelled:-?} todo=${todo:-?} (files=$expected_files)"

if (( status != 0 )); then
  echo "root-test-gate: root suite failed (exit $status)" >&2
  exit 1
fi
if [[ -z "${tests:-}" || "${tests}" -lt "$expected_files" ]]; then
  echo "root-test-gate: fewer tests reported than root test files; runner did not execute the suite" >&2
  exit 1
fi
if [[ "${skipped:-1}" != "0" || "${cancelled:-1}" != "0" || "${todo:-1}" != "0" ]]; then
  echo "root-test-gate: skipped/cancelled/todo tests are a failed gate, not a pass" >&2
  grep -E "^\s*(ok|not ok).*# (SKIP|TODO)" "$report" >&2 || true
  exit 1
fi
if [[ "${fail:-1}" != "0" || "${pass:-0}" -lt "$expected_files" ]]; then
  echo "root-test-gate: failures present or too few passes" >&2
  exit 1
fi
echo "root-test-gate: OK"
