# Pi identity and attach readiness

The gateway and CLI must know which Pi the supervisor actually launched before exposing
Pi's unversioned RPC surface. A failed lookup is not a confirmed version mismatch and must
not require destroying active work.

## Managed installations

Agentd v14 resolves `pi.command` using its launch PATH, follows executable symlinks once,
and snapshots the resolved file's device, inode, size, mtime and ctime. The nearest package
owns that file. For `@earendil-works/pi-coding-agent`, it validates the package's semantic
version and verifies that its declared `pi` bin resolves to this executable inside the
package root. It spawns that same resolved executable, not the original PATH alias.

Both npm's global install and the launcher's versioned `/opt/pi-pod/pi/<version>` delivery
layout work without starting `pi --version`. A slow Pi startup affects RPC readiness, not
version discovery. A positive identity belongs to that child for its entire lifetime:
changing `/usr/local/bin/pi` later cannot relabel an existing process. The image tag,
gateway pin and launcher's expected version are never substituted for observed identity.

Metadata is trusted to describe its package, just as the old CLI version output was trusted
to describe its executable. This is compatibility evidence within the pod, not attestation
against a malicious pod administrator or in-place modification of a running installation.
Managed upgrades use staged directories and atomic symlink replacement rather than modifying
the package beneath an existing child.

## Custom commands and failed discovery

A custom executable outside the managed package keeps its existing `--version` contract:
it must report the same Pi runtime it launches. The supervisor probes it asynchronously,
while the real Pi and channel liveness continue independently. Output is bounded to 64 KiB;
the 20-second wall deadline kills the owned probe process group, including children. No
probe output or environment values enter the handshake.

Only valid versions are cached as runtime identity. Transient failures are not cached for
the child's lifetime: a retryable lookup can be refreshed without stopping Pi, provided the
startup executable and any captured metadata file still have the same identity. Invalid
metadata/output or a changed installation remains a failure, never a guessed version. A one-second cooldown and one in-flight discovery prevent probe storms. Ordinary
heartbeat hellos never initiate discovery.

The gateway requests the v14 `pi_identity` **shim control**, not a new Pi RPC method, before
committing an attaching client's initial hello. Its reply is correlated independently of
heartbeat hellos and shared by concurrent attaches. Transport replacement, Pi exit and the
23-second request deadline retire the waiter; late replies cannot replace a newer handshake.
The refreshed hello is adopted before the CLI receives it, so control fan-out suppression
and the CLI's pre-readiness event gate cannot hide a successful repair. Discovery failure
never enters the gateway's destructive Pi-unresponsive recovery path.

The CLI keeps exact-version enforcement, but reports missing/invalid metadata, wrapper
failure/timeout and installation changes separately from genuine version skew. It leaves
the pod running and offers a retry only when discovery can actually be retried.

## Rollout and manual acceptance

v13 is the supported preceding supervisor. Its known versions remain attachable. An already
running v13 supervisor cannot acquire v14 behavior by uploading a new file; in particular,
its cached `unknown` still needs an idle stop/attach transition. The diagnostic says so
instead of promising that another ordinary attach will repair it. Never stop active work
as an automatic version-recovery action. New supervisors receive this fix from the server;
the pod base image does not need rebuilding.

Required manual acceptance (no unit tests): exercise the production generated supervisor
and real Pi with global and versioned installation layouts, startup lasting longer than the
old version deadline, a changed PATH symlink, invalid metadata, and failing/slow custom
wrappers. Verify correlated single-flight recovery while immediate heartbeat and Pi RPC
remain usable; verify timed-out probes and their children are gone. Then launch a disposable
live pod through the actual gateway/CLI, detach/reattach, inspect the supervisor generation
and exact version, and archive only the acceptance pod. Build/typecheck and package-startup
checks complement these observations; they do not replace live lifecycle verification.
