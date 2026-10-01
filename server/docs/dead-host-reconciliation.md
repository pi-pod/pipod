# Permanently deleted sandbox host

This is **workspace-loss break-glass**, not outage recovery or normal retirement.
Prefer `drain`, `archive`, `rehome-guarded`, `remove`, then destroy the VM. Never
infer deletion from a failed health check. Confirm permanent VM deletion using
infrastructure evidence, and investigate archive recovery before abandoning it.
`provider_state=archived` alone does not prove an archive remains recoverable.

Existing `reconcile-gone` only repairs active/gone failed launches with **no**
provider sandbox ID. `reconcile-archived` and guarded rehome require the source
host. Neither handles an already deleted host's archived-provider rows.

## Operator procedure

Run inside the deployed server container with its `DATABASE_URL`. Use the fleet
entrypoint, **not** `node dist/main.js fleet`. From source, replace
`node dist/fleet.js` with `npm run fleet --`.

1. Inventory (read-only, including already gone rows):

   ```sh
   node dist/fleet.js reconcile-dead-host hetzner-1 --dry-run
   ```

2. Confirm VM deletion and explicitly accept workspace loss. Record the operator
   identity and incident/deletion evidence in `--reason` (no credentials).
   Drain the registration, then stop **all** API/lifecycle/provisioning writers
   and wait for in-flight work to finish. Keep the fleet CLI/database available.
   Drain alone is not quiescence: existing pods can still be resumed or repointed.

   ```sh
   node dist/fleet.js drain hetzner-1
   ```

3. After the maintenance window is quiescent, review the inventory again, then:

   ```sh
   node dist/fleet.js reconcile-dead-host hetzner-1 \
     --yes --expected-url http://10.79.0.2:8433 \
     --host-deleted-confirmed --quiescence-confirmed --accept-workspace-loss \
     --reason 'OPERATOR; INCIDENT; verified permanent VM deletion; recovery abandoned'
   ```

4. Re-run the dry-run: all rows should be `unchanged` at archived/gone. Then:

   ```sh
   node dist/fleet.js remove hetzner-1
   ```

   Register/preload replacement workers before restoring traffic; fleet mode with
   no hosts fails closed. Do not reuse the dead URL for unrelated compute while
   stale clients or in-flight operations could still reference it.

## Safety and semantics

- Dry-run is the default and writes neither pods nor audits. `--yes` and
  `--dry-run` together, unknown options and missing option values are refused.
- Apply requires all confirmations, a nonblank reason, exact registered URL and
  a draining host. There is no automatic unreachable-host inference, remote
  operation, object deletion, restore or archive import.
- Only native `sandbox` rows pinned to the registered URL are considered.
  Accepted combinations are logical active/archived and provider archived/gone.
  Any other combination refuses the **entire** transaction before writes.
- Changed rows become archived/gone, their lease is cleared and a loss reason is
  recorded. Existing archive timestamps are preserved. Already archived/gone
  rows remain untouched; retries do not duplicate audits.
- Each changed pod has a `pod.reconcile_dead_host` audit row with before/after
  states, host ID/URL, provider ID, confirmations and operator reason. Audits
  commit atomically with the mutations; audit failures roll back the operation.
- Frozen config and provider sandbox IDs remain as historical evidence. This is
  logical custody convergence, **not** deletion of historical host URLs. Ordinary
  `remove` already ignores provider-gone rows; its guard is unchanged.
- Host/pod row locks protect the transaction, **not** already-running provider
  calls or future stale writers. Operator-attested quiescence is mandatory.

For the reported inventory (7 active/archived, 1 active/gone, 4 archived/archived,
130 archived/gone), the expected plan is **12 converge, 130 unchanged, 0 refuse**.
This is an expectation only; always inspect the actual dry-run. No production
mutation is implied by this document.
