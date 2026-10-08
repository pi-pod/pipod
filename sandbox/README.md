# pi-pod-sandbox

Self-hosted sandbox service: one container hosting N isolated sandboxes for pi pod.

To run your own pi pod, follow [`../docs/self-host.md`](../docs/self-host.md): it builds and
runs this service beside the server, and its Sizing section covers the settings that matter
there. The rest of this file is for working on the sandbox or running it as a separate host.

Configuration is environment-only. See `src/config.ts` for the full set. The process
listens on `PI_POD_SANDBOX_HOST`:`PI_POD_SANDBOX_PORT` (default `0.0.0.0:8433`).
`docker-compose.yml` publishes that port on loopback.

## Health and metrics

| Path | Auth |
|---|---|
| `GET /v1/healthz` | none |
| `GET /metrics` | none, or `Bearer $PI_POD_SANDBOX_METRICS_TOKEN` when that variable is set |
| everything else | `Bearer $PI_POD_SANDBOX_TOKEN` |

`GET /metrics` is Prometheus text format for private scraping. Labels are low-cardinality
and never include sandbox ids, tokens, or object keys. Catalog and scrape example:
[`docs/metrics.md`](docs/metrics.md).

## Cost controls

Guarded rehome between hosts uses the archive manifest handshake described in
[`docs/archive-handshake.md`](docs/archive-handshake.md) (source-authoritative object
reference, quiescence hold, exact-object import).

Native cost-control features: admission budgets, idempotent creates, tenant CPU
fairness, and the usage feed. All control-plane routes below need the master token.

| Doc | Covers |
|---|---|
| [`docs/capacity-admission.md`](docs/capacity-admission.md) | four budgets, ceiling/floor mode, `GET /v1/capacity`, typed errors, quarantine |
| [`docs/usage-feed.md`](docs/usage-feed.md) | `GET /v1/usage`, events, ack, outbox bounds |
| [`docs/tenancy-cpu.md`](docs/tenancy-cpu.md) | owner identity, tenant cgroups, `PUT /v1/tenants/:userKey/cpu-grant` |
| [`docs/operations-idempotency.md`](docs/operations-idempotency.md) | `operationKey`, fingerprint, `GET`/`DELETE /v1/operations/:key` |
| [`docs/manual-tests-cost-controls.md`](docs/manual-tests-cost-controls.md) | privileged manual test plan (disposable host only) |
| [`docs/derived-images.md`](docs/derived-images.md) | `POST /v1/images/derive`: base + script layer, published to a loopback registry |

New env knobs:

| Variable | Default |
|---|---|
| `PI_POD_SANDBOX_MEMORY_ADMISSION` | `ceiling` |
| `PI_POD_SANDBOX_MEMORY_BUDGET_GB` | unset (derives `min(total - reserve, fleet cap)`) |
| `PI_POD_SANDBOX_MAX_CONCURRENT_ARCHIVES` | `2` |
| `PI_POD_SANDBOX_MAX_CONCURRENT_TRANSITIONS` | `8` |
| `PI_POD_SANDBOX_SCRATCH_BUDGET_GB` | unset (uses disk reserve) |
| `PI_POD_SANDBOX_OPERATION_RETENTION_HOURS` | `72` |
| `PI_POD_SANDBOX_USAGE_EVENT_MAX_ROWS` / `PI_POD_SANDBOX_USAGE_EVENT_MAX_AGE_HOURS` | `50000` / `168` |
| `PI_POD_SANDBOX_USAGE_MAX_ROWS` | `1000` (hard cap on `GET /v1/usage` snapshot pages; larger `limit` is clamped) |
| `PI_POD_SANDBOX_CLAMP_OVERSIZED_SHAPES` | `0` (off; oversized shapes are `400 unsupported_shape`) |
| `PI_POD_SANDBOX_TENANT_MEMORY_GB` | `0` (uncapped) static; `5.5` boat (explicit `0` in boat mode refuses to start) |
| `PI_POD_SANDBOX_TENANT_CPU` | unset (uncapped static; boat derives `max(0.5, host CPUs − reserve)`; explicit `0` removes the cap) |
| `PI_POD_SANDBOX_TENANT_CPU_FALLBACK_CORES` | unset (derived bounded fallback) |
| `PI_POD_SANDBOX_GRANT_GATE_ADMISSION` | `1` (gate degraded tenants) |
| `PI_POD_SANDBOX_REQUIRE_OWNER` | `0` (refuse unowned launches after owner initialization) |

## Request size limits

Two different caps apply, because Fastify's global `bodyLimit` only bounds parsers that
buffer the body (JSON/text). It never constrains the streaming file route.

| Path | Enforced by | Default | Configure with |
|---|---|---|---|
| JSON / control-plane bodies | Fastify `bodyLimit` (buffered parsers) | 64 MiB | code constant `JSON_BODY_LIMIT_BYTES` in `src/api/server.ts` |
| `PUT /v1/sandboxes/:id/files` (`application/octet-stream`) | `UploadLimitGuard`, counted while streaming | 256 MiB | `PI_POD_SANDBOX_MAX_UPLOAD_BYTES` (bytes) |

The file route streams the request body straight into the sandbox (`pps-init put`), so an
unbounded upload would only stop at the sandbox disk quota. The guard errors the stream
the moment the byte count exceeds the limit:

- A declared `Content-Length` above the limit is rejected before the sandbox is touched.
- A chunked upload that crosses the limit mid-stream is aborted; the remainder is
  discarded and the server answers `413 { "error": { "code": "payload_too_large", … } }`
  on the same connection.

256 MiB fits the workspace-seeding compressed-tarball budget (auto-seeding plan, item 5)
for a single file while staying far below the default 10 GiB sandbox disk quota. Raise
the env var if you seed larger trees, and keep the disk ceiling above it.

## Notes for server/client (provider) implementers

- Uploads stream: no `Content-Length` is required — the sandbox provider client sends
  chunked bodies (`fetch` with `duplex: "half"`). Do not assume the length is known.
- There is no server request timeout, so slow large uploads are not cut off mid-flight;
  pass an `AbortSignal` from the caller for cancellation instead.
- `413 payload_too_large` means the file exceeded the operator's cap. For seeding, treat
  it as "archive too large → warn and leave a usable empty pod", not as a retryable error.
  Running out of sandbox disk instead surfaces as `409 conflict` (ENOSPC) — handle the two
  distinctly.
- Uploads are not atomic: an aborted or over-limit chunked upload can leave a truncated
  file behind. Seed via a temp path plus rename when the consumer needs atomicity.
- The sandbox has no tar-extract endpoint: upload the tarball with `uploadLocalFile`,
  then extract it with an `exec` of `tar` inside the sandbox (busybox images provide it).
- The sandbox upload limit is operator-configurable; seeding clients must handle the
  runtime's `413 payload_too_large` response rather than assume a fixed host-wide cap.

## Develop

```bash
npm ci
npm run check    # typecheck + unit tests
```
