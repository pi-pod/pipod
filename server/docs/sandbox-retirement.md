# Sandbox retirement operations

Operator runbook for the guarded retirement path: `fleet reconcile-archived`,
`fleet rehome-guarded`, and `fleet retire-source` (plan workstream 3 follow-up).
Companion to [sandbox fleet capacity operations](./sandbox-fleet-capacity.md), which
owns admission, waits, fairness, and owner identity — this document owns nothing
outside retirement moves.

## Host identity convention (mandatory)

`sandbox_hosts.id` MUST equal the native `PI_POD_SANDBOX_HOST_ID` / reported `hostId`
of the host behind that row's URL, and each row's URL must route to exactly that
host. Every manifest proof in the retirement path binds the serving hostId to the
expected registry id:

- a target URL aliasing back to the source replays the source's own exact data
  through every content check — only the identity binding refuses the repoint;
- a wrong selected host for `reconcile-archived` refuses before any native I/O;
- `retire-source` resolves the target through the registry and requires distinct,
  correctly self-identifying hosts.

If the identities differ, stop and investigate the registration/configuration mismatch.
Do not loosen the checks or rename a live native identity casually: host identity also
keys archive and usage history. Repair requires a reviewed plan preserving those references.

## Exact source URL must match the frozen pointer

Reconciliation binds the selected host URL to the pod's frozen
`providers.sandbox.url`; its row-locked commit checks the provider, sandbox ID,
source URL, and full-precision `updated_at`. Rehome separately uses its guarded
pointer CAS under the continuous native hold and advisory lock. A changed tuple
must be re-read and re-planned, never overridden.

## Reconcile is preparation, not completion

`fleet reconcile-archived` converges `error → archived` on dual host proof and
retains the `rehome:<podId>` hold on SUCCESS as well as uncertainty. It never
releases, and server manual hold-release is disabled entirely. After a successful
reconcile, continue with:

```
fleet rehome-guarded <host> --yes --quiescence-confirmed [--min-quiet-secs=N]
```

which re-PUTs the same holder idempotently and proceeds under one continuous fence.
Wakes on a fenced pod refuse with `sandbox_held` until the move completes — that is
the fence working, not an outage.

## Diagnostic stage cannot retire a routed row

`pod_rehome_state` is operator observability only (holding / manifest_ok / imported /
repointed / retired). It never authorizes anything: `retire-source` refuses while the
pod pointer still names the source even with a stage row claiming an import, and only
an exact guarded retry (idempotent replay → repoint → atomic retire) moves forward.

## Live owned canary remains required

No test double substitutes for the owned canary: a small-shape, newly owned pod moved
across real rev7+ hosts with checksum-verified restore, per the isolated-fixture
runbook held by the parent. Green unit suites prove the guards trip; only the canary
proves the hosts speak the contract the guards assume.
