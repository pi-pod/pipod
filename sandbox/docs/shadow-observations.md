# `runtime-shadow-observation-v1` — rehearsal only

This opt-in, **nonbillable** journal records lifecycle observations. Its Ed25519
signature proves only that the holder of a root-private rehearsal key signed a
payload; a compromised supervisor can fabricate one. Chain verification does
not prove completeness, runtime truth, readiness, duration, shutdown, external
deduplication, customer service or a billable interval. It is not connected to
the usage ledger. Do not map these events to `operator-offline-v1`, v2 service
receipts, usage dispositions or Stripe.

Builds default to `PI_POD_SANDBOX_SERVICE_OBSERVATIONS=off`. `shadow-v1` is
accepted only with the opt-in small profile, explicit root-private Ed25519 key
outside the tenant state tree, and a key ID. The key/host identity and signed
journal metadata must remain stable. There is no key rotation or journal-delete
recovery. On key mismatch, invalid chain, unknown execution, missing record,
capacity exhaustion or write failure, the current process and next startup are
held; new admissions, restore/thaw, archive, delete and retirement are refused.
Explicit stop remains available for operator-directed cleanup. Reboot after any
launch holds because prior supervisor execution is not automatically adopted.

Each bounded canonical JSON-array payload signs the journal ID, sequence,
event ID, previous digest, key ID, host and boot IDs, sandbox and immutable
owner IDs, runtime generation, action ID, event kind and decimal-string clocks.
The hash is domain-separated; Ed25519 signs the domain plus exact UTF-8 bytes.
SQLite uses WAL/FULL. The journal caps at 1,000 records / 2 KiB per payload and
refuses new launch intents before terminal reserve is consumed. These are
logical row bounds, **not** physical file/WAL capacity bounds. No records are
ever evicted.

Events: `launch-intent` commits before the external `crun` mutation;
`launch-returned` says only that the launch procedure returned; `launch-uncertain`
means the external request's result is unknown; `launch-failed` is reserved for
proven pre-invocation failure; `interrupted` is restart diagnosis;
`teardown-returned` says only that the teardown routine returned. None is a
closed service interval or proof a process is absent. Holds survive later
events. Supervisor shutdown after an observed launch fences restart.

## Manual rehearsal (disposable, one owner)

Use a disposable local SQLite state directory and a root-owned Ed25519 fixture
key, with permissions matching the small guest contract. Never use a customer
VM, production signing key, Stripe credential or production DB.

1. With mode off, verify no journal is created and existing default startup is
   unchanged. Create a fixture `small-v1` profile; verify a shared profile or
   missing/unsafe key fails before admission.
2. Launch one owned sandbox. Inspect signed sequence 1 `launch-intent`, then
   `launch-returned`; inspect real runtime/cgroup independently. No service
   seconds, usage disposition or charge may be created.
3. Stop it. Verify `teardown-returned` accurately says only the function
   returned. Its record is not evidence of kernel/container absence.
4. Restart the supervisor after a launch. Readiness/admission must refuse and
   preserve the journal, key, row and charges. No create/start/restore/archive/
   delete/retire or reaper action may bypass the hold. No automatic adoption.
5. Inject a PID-file read failure after `crun run -d` has executed, followed by
   journal-write and admission-quarantine failures. Require an uncertain hold
   and no teardown/delete/release/retry. Inspect runtime processes directly.
6. Exercise shutdown while create, stop, reaper tick and archive are in flight.
   New intake closes first; the reaper drains; any post-launch shutdown latches
   a hold before journal close. Deadline expiry must leave restart fenced.
7. Before and during stop, queue a second exec, an upload after its input has
   finished, and a download with a deliberately delayed writable `final`
   callback. Explicit stop must cancel the exact same operation before spawn or
   kill and account for the already spawned helper; automatic idle/pressure stop
   must defer while work is active. A failing sink or helper cannot be reported
   as successful. Hold a host `ChildProcess` open after cgroup/runtime absence;
   teardown must wait for its `close` event before unmount, network destruction,
   or recording teardown-returned. Pause archive verification, latch a hold, and
   verify local disk/row custody is retained. Manually rehearse shutdown during
   stalled HTTP, WebSocket, reaper and archive work; the DB must not close under
   an outstanding serialized operation.
8. Export with `pi-pod-sandbox-observations --state-dir ABSOLUTE --export`.
   Verify using the independently built server verifier with operator-pinned
   public key, host ID, key ID and journal ID. Flip held metadata, truncate the
   chain, alter a signature, duplicate a sequence and exceed the row bound; the
   tool may authenticate a valid prefix only and must never claim completeness.
   The local `--status` mode reports unverified database metadata only; it is
   not a signature or hold attestation.

Build/typecheck plus manual processes do not substitute for kernel/vendor
qualification. Configured deadlines are not measured operation durations. A
held rehearsal requires a new disposable state volume/key for another run;
never delete a hold to continue the same guest.
