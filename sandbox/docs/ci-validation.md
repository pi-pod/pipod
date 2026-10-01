# CI validation boundaries

The release workflow again gates images on unprivileged integration AND privileged
root qualification. This repairs the gate removal in `4d320c8`; it does not install
a runtime/template or activate customer billing. Root validation runs on ephemeral
GitHub-hosted runners only. Missing dependencies, skips, cancellations and todos
fail `scripts/root-test-gate.sh`; images need both jobs.

`node scripts/run-integration-tests.mjs --list` prints the explicit reviewed
unprivileged selection without execution. Those eleven files exercise real
filesystem/persistence, tar extraction, executable entrypoints, listening HTTP or
WebSockets. They do not establish live runtime capacity or production isolation.
The privileged runner retains all thirteen root files, adds actual whiteout/xattr
extraction, executes serially, and requires the zero-zombie assertion. A bare-VM
result does not establish production container PID-1 behavior.

Never substitute a wildcard for the reviewed selection. Never run unit checks
indirectly through CI. Names and directories alone do not classify a check.

## Deliberately omitted coverage

Policy/mock-focused files remain unchanged and unexecuted: admission-controller,
admission, box-tenant-cap, cost-controls-manager, import, metrics-http,
metrics-lifecycle, metrics-reaper, review-regressions, transition-state.

Mixed files remain unchanged and unexecuted: archive-proxy, archive-proxy-origin-pin,
disk, journal-recovery, operations, sparse-admission, owner-init-uncertain, tenancy,
archive-handshake, cost-routes-http, reaper. This loses their genuine integration
cases as well as excluding units. It is NOT full historical coverage. Recovering
mixed-file coverage requires a separately reviewed extraction of existing cases,
not broad name filters, weakened assertions, or relabeling unit checks.

The existing unit/mixed files are retained; none are deleted or modified here.
