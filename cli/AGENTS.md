- After a change to provisioning, the PTY, or session lifecycle, verify it against a live pod, with the maintainer workspace's `pi-pod-cli-manual-testing` skill when it is present. A documentation-only change does not need a live pod.

## Classic runtime coupling

New user-facing features ride the semantic gateway protocol shared with the app — never new RPC passthrough methods on the classic runtime. The passthrough inventory in `docs/classic-runtime-coupling.md` is an upper bound: it only shrinks. `@earendil-works/pi-coding-agent` imports stay inside `src/client/runtime/` plus the named allowlist documented there.

When a semantic-protocol feature has an AgentHarness counterpart, borrow the harness semantics and naming: queued prompts get real `steer`/`followUp` queue behavior, and new durable references use entry-id-style identity rather than adding meaning to stream `seq`. Alignment accretes with normal feature work; any deliberate divergence needs a written reason in `docs/harness-conformance.md`.

When pi ships AgentClient / AgentHarness, replace `RemoteRuntime` with a `GatewayAgentClient` as a deliberate version bump instead of growing this surface.

Never write or run unit tests.
