# Archive manifest handshake (guarded rehome)

Moving an archived sandbox between hosts must prove that the target adopted the **same
object** the source's row points at, and must stop the source from waking while that
happens. "Newest object in the bucket for this id" is not authoritative: a wake/stop cycle
writes a newer object and a rehome that imported "latest" can strand it. This handshake
makes the object identity and the fence explicit on the wire; all fields are additive.

## Pieces

| Route / field | Purpose |
| --- | --- |
| `SandboxInfoWire.archive` | `{ key, sha256, size }` the row points at (what `pack()` verified), or null |
| `SandboxInfoWire.hold` | active quiescence hold `{ holder, reason?, since }`, or null |
| `GET /v1/sandboxes/:id/archive[?verify=1]` | source-authoritative reference, the full persisted `config` manifest (image, workdir, ceiling incl. disk, egress, timers, labels, owner; never env) and, with `verify=1`, a `HEAD` of the object (`object.matches`) |
| `PUT /v1/sandboxes/:id/hold` `{ holder, reason?, expectedRevision? }` | fence (archived only, revision CAS): refuses wake, archive, resize, owner init and delete with `409 sandbox_held` until released; durable, no TTL; bumps `revision`; marks the object shared |
| `DELETE /v1/sandboxes/:id/hold` `{ holder }` or `{ force: true }` | release |
| `ImportSandboxRequest.archive` `{ key, sha256, size? }` | target adopts exactly that object; `409 archive_mismatch` when absent or different |

Master token only. A hold is refused unless the row is fully archived (`409 conflict`): a
running workspace is something to stop first, and a stopped one still has local writes that
no object carries. `expectedRevision` fences exactly the state the caller read.

## Ambiguity and abort

The hold has no TTL and survives restarts, so a crashed operator or a lost response leaves
the source fenced; reconciliation is idempotent (re-PUT with the same holder, re-GET the
reference, re-import the same object, re-check the target, CAS the pointer). Abort before
the target ever started: release the hold. After the target started: never release the
source hold (that would allow two writers); `retire` the source row instead, or leave it
held. No path deletes the shared object. `config.imageDigest` and `imageDigest` on import
keep image equality; env is never exported or logged. Hosts without these routes answer 404: treat the manifest as absent and
fail closed. A host must have this fence deployed before it is retired.

## Sequence

1. `PUT source/hold` with an operator/actor holder.
2. `GET source/archive?verify=1`: require `tier=archived`, `hold` set, `object.matches`.
3. `POST target/import` as `{ id, ...reference.config, archive: reference.archive }`: spreading
   the manifest verbatim keeps egress, idle/archive timers, labels, owner and the ceiling. A
   bare import (id/image/workdir only) closes egress but resets both timers to "never".
4. `GET target/:id`: require `state=archived` and `archive.key` equal to the source's.
5. `GET source/archive` again: same `revision`, same `archive`, still held.
6. Compare-and-set the control-plane pointer to the target.
7. `POST source/:id/retire` `{ holder, expectedRevision, adoptedArchive }` deletes the source
   row and local state while still held, with the proof of the adopted object; the shared
   object stays. The hold is never released on this path.

The hold is the fence. The revision re-read in step 5 is a second check, not the fence:
a revision read alone does not stop a concurrent native wake.

## Shared objects are never deleted by a host

`archiveShared` is set on every import and on every hold. `DELETE /v1/sandboxes/:id` on a
row with a shared object deletes the row and local state only; the object stays and is
counted as cleanup debt (`pps_sandbox_operations_total{op="archive_orphan"}`). A
never-shared, locally archived row keeps the old behaviour (object removed). Garbage
collecting objects therefore needs a global reference view, which only the control plane
has.

## Usage events

One `archived` event is emitted per successful archive; `detail.verify` is `backend` or
`readback` and `detail.downloadedBytes` reports read-back transfer. Dedupe on `seq`, and
never by `(sandboxId, kind)`.
