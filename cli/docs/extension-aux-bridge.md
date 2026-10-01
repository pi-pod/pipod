# Extension aux bridge: local rendering + pod-side completions

Server-attested pod extensions run twice: in the pod (authoritative) and in the
launcher (rendering hooks only — entry/message renderers, markdown transformers —
via the launcher's own `ExtensionRunner`). Two bridges connect the halves.

## 1. Command ownership: the pod owns every slash command by default

This is deliberate. An attested extension's `/name` can close over pod-side state
(`pi-lightweight-llm`'s `/plan`-style flows, `pi.exec` handlers): routing it to the
launcher unconditionally would hijack that state. So bare `/name` input always
crosses the wire exactly once for the pod copy to run. The local copy never
intercepts, never shadows autocomplete, and never double-executes.

Run a command locally only when you mean it:

- `/pod local <name> [args]` — run the launcher-side copy with the real TUI
  context. Strict: an unregistered name errors honestly and is never forwarded,
  so one input can never execute in both places. `/pod local` alone lists the
  locally rendered commands. Tab-completion covers `/pod local <name>`.
- `localCommands` (session option, default empty) — names that run locally
  directly, e.g. `["transcript"]`. An allowlisted name with no local
  registration falls through to the pod (single owner, no duplicate run).

Same-name registrations from different local extensions collide loudly: `/pod
local` reports every claimant's `sourceInfo` and runs none, instead of guessing.

### pi-lightweight-llm requirement (unchanged upstream, v0.1.4)

Its summary rendering needs the TUI context (`supports: ctx.mode === "tui"`),
which only the launcher side has. It registers `transcript`, `tool-summaries`,
and `lightweight-llm`. Out of the box `/transcript` runs in the pod, where the
RPC-side copy cannot render summaries. To get local summaries, either run
`/pod local transcript summary…` per invocation, or opt `transcript` into
`localCommands` for the session. Generic aux model calls (`find` /
`hasConfiguredAuth` / `complete` below) work regardless — no setting needed.

## 2. Auxiliary completions: `ctx.modelRegistry` backed by the pod

Pod credentials never cross to the launcher, so the launcher-side registry is a
facade:

- Metadata (`find`, `getAll`, `getAvailable`, `hasConfiguredAuth`,
  `getProviderDisplayName`, `isUsingOAuth`, …) reads the client-side model
  catalog + auth snapshot: point-in-time, pod-authoritative, sync just like
  native. Secret-bearing (`getApiKeyAndHeaders`, `getProviderAuth`,
  `getApiKeyForProvider`) and provider-mutating (`registerProvider`, …) methods
  throw explained errors.
- `complete(model, context, options)` runs pod-side through the semantic
  `aux_complete` gateway message, executed by the pod's real `ModelRegistry`
  as a turn-external call: no transcript entries, no main-model change,
  `cacheRetention: "none"` (accepted because unchanged callers always pass it;
  any other value is rejected). Old pods (extension < 11) fail with an actionable
  "restart Pi in the pod" error, never a hang.

### Text-only contract (explicit, not full native parity)

Only `{systemPrompt, messages}` with user/assistant text cross. Everything else
is **rejected, never silently dropped**: `tools` and sampling options
(`temperature`, `samplingParams`, …), transports, headers/env, image/audio and
tool-result content, thinking blocks. The pod runs the call through its real
`ModelRegistry.complete` with the native `reasoningEffort` option passed through
verbatim (including `"off"`) — thinking semantics stay exactly the pod's native
per-API behavior, provider-specific with no bridge-level translation. Empty-text non-terminal outcomes (toolUse /
deferred / pending) fail rather than fabricate `ok:true` with empty text.
Usage (including cost) passes through untouched.

### Bounds (each side enforces its own; the lower wins)

| Bound | Value |
|---|---|
| Concurrency, per launcher session / per pod session | 4 (`aux_busy`) |
| Timeout default / cap | 60s / 5min client; gateway answers by min(timeout, 120s); pod ceiling ~130s |
| System prompt | 16KB chars |
| Messages | 16 entries × 64KB chars |
| maxTokens default / cap | 2048 / 4096 |
| Wire request/response | 256KB base64url each |

### Cancellation and lifecycle

Every call has its own id, deadline, and `AbortSignal`: aborting sends
`aux_cancel` and fails only that call — never the main turn. An already-aborted
signal fails before any transport use; a reply that arrives after abort,
timeout, or session invalidation is discarded, never returned as success.
Disconnect and session replacement (`/new`, `/fork`, `/resume`, `/pod switch`,
reconnect recovery) discard pending waits before rebind; in-flight pod
executions are the gateway's to cancel, and their late replies correlate to
nothing. Shutdown emits `session_shutdown(quit)` to local handlers while the UI
and caches are still live, then invalidates the host.

`session_tree` is runner-local in pi (never on the wire): the runtime
synthesizes it after local tree navigation so TUI-mode capabilities rescan,
with the native `{newLeafId, oldLeafId, fromExtension}` payload.
Session start/shutdown use pi's own reasons (`startup/new/resume/fork`,
`quit/new/resume/fork`) with session-file handoffs, so mode-gated capabilities
reset exactly like in-process pi.
