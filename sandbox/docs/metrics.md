# Metrics

`GET /metrics` exposes Prometheus text format for private scraping. It is not under `/v1`.

## Authentication

Same posture as `/v1/healthz` by default: no bearer token, intended for a private network
(the compose file binds the API to loopback). Set `PI_POD_SANDBOX_METRICS_TOKEN` (min 16
chars) to require `Authorization: Bearer` on `/metrics` only. The master API token is
**not** accepted as a scrape credential.

```yaml
scrape_configs:
  - job_name: pi-pod-sandbox
    metrics_path: /metrics
    scheme: http
    static_configs:
      - targets: ["127.0.0.1:8433"]
    # authorization:
    #   type: Bearer
    #   credentials: <PI_POD_SANDBOX_METRICS_TOKEN>
```

## Cardinality

Labels are closed sets. Sandbox ids, image refs, object keys, file paths, tokens, and
error strings are never labels. HTTP `route` is one of the registered Fastify templates
(for example `/v1/sandboxes/:id`). Every request that does not match a template — including
any raw URL — is emitted as `unmatched`.

## Semantics

- **Admission** (`pps_sandbox_admissions_total`) is one series per attempt. `create`
  admits once. A later `start` of a stopped/archived sandbox admits once more. The first
  launch inside `create` is not a second admission and is not a `start` operation.
- **Lifecycle** `result` is `ok`, `error`, or `noop` (idempotent start/stop/archive/delete/freeze).
- **Runtime** counts only `crun`/`runsc` **start**. Teardown polls `state()` and is not a series.
- Scrape collectors read one snapshot per `/metrics` call. If that snapshot throws, the
  previous values (or zeros) are served and the endpoint stays 200.

## Series

Prefix `pps_` is the service. Process/Node series (`process_*`, `nodejs_*`) come from
prom-client default metrics.

| Metric | Kind | Labels |
|---|---|---|
| `pps_build_info` | gauge | `version` |
| `pps_http_requests_total` | counter | `method`, `route`, `status` |
| `pps_http_request_duration_seconds` | histogram | `method`, `route` |
| `pps_ws_connections_active` | gauge | `kind=exec\|pty` |
| `pps_ws_connections_total` | counter | `kind`, `result=complete\|error\|disconnect` |
| `pps_ws_connection_duration_seconds` | histogram | `kind` (buckets to 24h) |
| `pps_sandboxes` | gauge | `tier=hot\|warm\|stopped\|archived\|error` |
| `pps_sandboxes_booting` | gauge | |
| `pps_sandbox_operations_total` | counter | `op`, `result=ok\|error\|noop` |
| `pps_sandbox_operation_duration_seconds` | histogram | `op` |
| `pps_sandbox_admissions_total` | counter | `result=ok\|denied`, `resource=cpu\|memory\|disk\|network\|none\|other` |
| `pps_sandbox_execs_total` | counter | `result=ok\|error\|timeout` |
| `pps_sandbox_exec_duration_seconds` | histogram | |
| `pps_sandbox_files_total` | counter | `op=upload\|download`, `result=ok\|error\|not_found` |
| `pps_sandbox_ptys_total` | counter | `op=open\|attach` |
| `pps_sandbox_ptys_active` | gauge | |
| `pps_image_pulls_total` | counter | `result=ok\|error` |
| `pps_image_pull_duration_seconds` | histogram | |
| `pps_image_gc_layers_removed_total` | counter | |
| `pps_archive_operations_total` | counter | `op=put\|get\|head\|list\|delete`, `result` |
| `pps_archive_operation_duration_seconds` | histogram | `op` |
| `pps_archive_bytes_total` | counter | `op` (puts) |
| `pps_runtime_operations_total` | counter | `op=start`, `result=ok\|error` |
| `pps_reaper_ticks_total` | counter | `result` |
| `pps_reaper_tick_duration_seconds` | histogram | |
| `pps_reaper_actions_total` | counter | `action`, `result` |
| `pps_resource_committed_cpu` | gauge | |
| `pps_resource_committed_memory_bytes` | gauge | |
| `pps_resource_disk_committed_bytes` | gauge | |
| `pps_resource_disk_capacity_bytes` | gauge | |
| `pps_host_memory_pressure` | gauge | PSI avg10; `-1` if unavailable |
| `pps_host_memory_available_bytes` | gauge | |
| `pps_host_memory_total_bytes` | gauge | |

Sandbox `op` values: `create`, `start`, `stop`, `freeze`, `thaw`, `archive`, `restore`,
`delete`, `import`, `reconcile_adopt`, `reconcile_stop`.

Reaper `action` values: `idle_stop`, `freeze`, `archive`, `pressure_freeze`,
`pressure_stop`, `cpu_veto`, `dr_snapshot`.

Exec `ok` includes non-zero process exit codes; those are the sandbox's result, not a
service failure.
