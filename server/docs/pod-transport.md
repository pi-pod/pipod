# Pod transport startup and recovery

Transport connectivity, Pi identity and Pi RPC readiness are separate facts. The daemon
opens its outbound WebSocket without waiting for optional version discovery; managed Pi
identity comes from the executable's package, while custom commands must implement a
side-effect-free `--version` contract. See [Pi identity](pi-identity.md) for the compatibility
and retry rules. A connected transport alone does not mean Pi is RPC-ready.

## Recovery owns sockets, not active work

Every connection attempt has a ten-second deadline. After a socket opens, the daemon
requires inbound traffic within 45 seconds, checked on its 15-second heartbeat. This also
covers a gateway that never answers the first ping; no previous pong is needed to arm the
watchdog. Elapsed time is monotonic. A failed upgrade, silent socket, gateway restart or
network outage releases that socket and uses the bounded reconnect backoff. Pi, tools and
its event journal remain in the same supervisor.

Attach gives an existing daemon one reconnect window and preserves it if it is still alive
or cannot be inspected. A newly started daemon is also preserved when the readiness window
expires, regardless of the diagnostic verdict. The diagnostic may take a few seconds, so
startup rechecks readiness afterward and adopts a connection that arrived meanwhile. A
provider exec failure is not proof that its detached process died: a second PTY cradle is
allowed only after an explicit dead-supervisor result.

A demonstrated TCP failure can trigger one cooldown-limited reapplication of the committed
provider egress policy. Recovery then waits for the **same daemon**, rather than spawning
another Pi. DNS failure, TLS/HTTP failure, a reachable callback and an unavailable probe do
not justify an egress mutation. Explicit user stop/delete and permanent credential rejection
retain their existing lifecycle semantics; connectivity diagnosis never authorizes a kill.

## What the diagnostic does and does not prove

The in-pod probe uses the daemon's actual callback scheme, host and port. IP literals skip
DNS entirely; reverse-DNS records are not required. Hostname forward lookups, TCP, TLS (for
HTTPS only) and HTTP produce structured records. Only those records are classified, not
exception messages or provider startup text. Individual operations and the overall probe
have deadlines. The request ignores environment proxies and never follows redirects.

The HTTP request deliberately carries **no credential** and does not perform a WebSocket
upgrade. An HTTP response, including 401/403, means `callback-reachable`, not authenticated,
WebSocket-ready or Pi-ready. For plain HTTP callbacks the diagnostic explicitly reports
`tls: skipped`. Authenticated upgrade success/rejection and connection deadlines appear in
the daemon log; the gateway registry remains the authority for a live transport.

New daemon behavior takes effect on the next genuine cold runtime start. Uploading source
cannot change an already-running daemon, and rollout must not replace it merely to adopt a
new watchdog. Preserve active sessions; their normal reconnect/lifecycle remains supported.

Manual acceptance uses the production generated daemon, real Pi and actual sockets: cold
startup with a slow custom version command, a stalled upgrade, silence before the first
pong, gateway drop/reconnect with the same Pi PID, and IP-literal/nondefault-port HTTP and
HTTPS diagnostics. No model request is necessary.
