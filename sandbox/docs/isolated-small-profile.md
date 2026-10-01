# Draft `small-v1` native runtime profile — not a published VM release

`PI_POD_SANDBOX_PROFILE=small-v1` is opt-in. The existing shared/default
profile is unchanged. This profile refuses unknown sandbox environment keys
and any missing/overridden resource settings. Its 8,000,000,000-byte limit is
the ext4 writable image length; ext4 metadata means usable file payload is
smaller. Sparse admission is not a physical reservation of host blocks.

The persistent SQLite allocation binds one sandbox ID and owner to a request
fingerprint before image lookup or import. The unique live-slot index and
sandbox-insert trigger prevent a second row even if a different caller uses
the database. Stop, archive, error, a failed create, and an uncertain cleanup
keep the allocation. A clean, explicit delete checks for absent row, image,
directory, active admission, container, cgroup and network namespace before
retiring it. Interrupted preallocation may leave a rowless allocation that
requires operator recovery; do not delete its SQLite record to make a second
pod fit. The create operation key is mandatory; retries do not mint another
sandbox after an uncertain failure. A future operator tool must reconcile
rowless claims before any release.

The profile limits a tenant and the aggregate fleet to 2 GiB/1.5 CPU, with
read-back verification and tenant swap disabled. This is a ceiling, **not** a
2-GiB memory reservation for the customer or measured headroom on every
vendor machine. Profiled systemd packaging uses a lifetime `flock` on the
state volume; launching the binary outside that service is unsupported.

This is not proof of live pod service, safe archive/spool growth, inode
capacity, exact template provenance or production deployability. Before
publication, qualify a fresh immutable artifact on a noncustomer small VM:
startup/refusal on bad profile, two competing pod IDs, same-ID retries,
real `/workspace` execution, image-length and ENOSPC behavior, root headroom,
inode/log/cache/spool bounds, cgroup readback, crashes around SQLite
persistence, and unattended stop/resume marker hashes. A profile mismatch or
unknown leftover must remain stopped for diagnosis, not be repaired by
shrinking an existing image or deleting customer data. No v2 customer route
may dispatch this profile until those checks and the control-plane custody
handoff pass.

## Qualification findings (2026-09-28, guest from `pipod-ws-v9`)

A noncustomer qualification guest created from the published `pipod-ws-v9`
template ran one real `alpine:3.20` pod through the runtime API and the signed
admission gate. Observed and still open:

- **Pods run as container root in the host user namespace.** Inside the pod the
  `user` namespace is the host's, `NoNewPrivs` is 0, capabilities are the
  default container set, seccomp is active and `uid` is 0. A container escape
  is host root. Do not describe this profile as rootless or unprivileged pods,
  and treat the confinement boundary as a bug, not a shipped guarantee.
- **An exhausted workspace keeps its host allocation.** After the workspace hit
  ENOSPC (7,754,215,424 bytes written; `df` 100%) the backing `writable.ext4`
  stayed fully allocated at 7.5 GiB, so the next pod start was refused with
  `disk capacity exhausted … 7.45 GiB committed of 7.45 GiB`. Hole-punching the
  image's zero ranges (`fallocate -d`) cut allocation to 199 MiB and the start
  succeeded. The profile needs an explicit reclaim path before customers can
  use the whole quota.
- **A failed start after admission consumes the authorization.** When the first
  post-resume start failed in the boot gate, the guest needed a second signed
  authorization. That is the intended fail-closed behavior, but operators must
  expect it and issue a fresh authorization rather than reusing the old one.
- **A vendor resume can require one OCI layer repair.** After a cold resume the
  boot gate's verifier exited 1; running it with the service environment
  reported `OCI image integrity gate passed` after `repairing extracted layer …`
  from retained verified blobs, and the next start succeeded. Confirm the repair
  path is bounded and observable before customer use.
- **Backpressure is still unverified.** With no usage sink configured the spool
  stayed empty, so saturating it remains on the qualification list.
