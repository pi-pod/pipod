# Operations and idempotency

Create is the only idempotent operation. Send the key in the create body
(`operationKey`) or the `Idempotency-Key` header; when both are present they must agree
or the request is `400`. Tie the key to the server pod/operation record.

## Key format

`^[A-Za-z0-9._:-]{8,128}$`. Anything else is `400 bad_request`. The key names a journal
row and appears in log lines, so it carries the same charset discipline as owner keys.

## Header vs body

The header and the body field are equivalent aliases. The server reads the header first:
if the body also carries `operationKey` and the two differ, the request is rejected
before any ledger write. Canonical examples:

```bash
curl -X POST $BASE/v1/sandboxes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key:pod-42-attempt-7" \
  -d '{"image":"…","workdir":"/work"}'

curl -X POST $BASE/v1/sandboxes \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"image":"…","workdir":"/work","operationKey":"pod-42-attempt-7"}'
```

## Fingerprint

The host persists `key + HMAC fingerprint(request)` before any allocation. Properties:

- Canonical JSON (object keys sorted recursively, so key order never changes the hash);
  the top-level `operationKey` is excluded because it names the row rather than
  describing the request. `env` is included in the fingerprint but never stored.
- Keyed by a host-local secret (`<stateDir>/db/idempotency.key`, mode 0600, created
  once, kept outside SQLite so DR snapshots never carry it), not by the master token, so
  a token rotation cannot turn legitimate retries into spurious conflicts.
- Every stored fingerprint carries a `v1:<keyId>:` prefix. If the key file is lost and
  regenerated, old fingerprints are explicitly incomparable (a conflict) instead of
  silently equal or silently different.

## Outcomes

| Situation | Result |
| --- | --- |
| New key | `started`: row persisted as `pending`, then the create runs |
| Same key, same fingerprint, original still running | `duplicate`: the call joins the in-flight create and returns its result; no second sandbox |
| Same key, same fingerprint, original done | `duplicate`: replays the stored outcome (200 with the original `SandboxInfoWire`, or the original error status/body) |
| Same key, different fingerprint | `409 idempotency_conflict` with `details.kind: "operation"` (the key, status, and sandbox id) |
| Check-and-insert races | atomic in one SQLite transaction, so two concurrent creates with the same key cannot both launch |

## Status route fields

`GET /v1/operations/:key` returns `OperationStatusWire`; unknown keys are `404
not_found`:

```json
{
  "key": "pod-42-attempt-7",
  "kind": "create",
  "status": "succeeded",
  "sandboxId": "sb-abc123",
  "createdAt": "2026-09-05T12:00:00.000Z",
  "finishedAt": "2026-09-05T12:00:04.000Z",
  "expiresAt": "2026-09-08T12:00:04.000Z",
  "cancelRequested": false,
  "resolution": null,
  "crossHostRetrySafe": false,
  "result": { "id": "sb-abc123", "state": "started", "tier": "hot" }
}
```

Failed rows carry `error: { code, message, hint?, details? }` with only the bounded wire
fields; provider internals never land in SQLite or on the wire.

## `resolution` and `crossHostRetrySafe` rules

`resolution` says what a terminal failure/cancellation left behind:

| Resolution | Meaning |
| --- | --- |
| `preallocation` | refused before any allocation |
| `cleaned` | every host resource confirmed released |
| `quarantined` | a sandbox or its resources may still exist on this host; a cross-host retry would duplicate it |
| `null` | pending or succeeded; nothing to resolve |

`crossHostRetrySafe` is true only when the status is `failed`/`cancelled` **and** the
resolution is `preallocation`/`cleaned`. A pending, succeeded, or quarantined operation
never authorises creating the same pod on another host. Server rule: on transport
ambiguity, query this host by key first; only a confirmed pre-allocation refusal
(507/400 with details) or a confirmed `failed` status with a safe resolution authorises
trying another host.

## Cancel and cleanup route

`DELETE /v1/operations/:key` returns the resulting `OperationStatusWire`:

- `pending`: sets `cancelRequested`; the creator rolls the sandbox back after launch and
  reports `cancelled`. Terminal rows are immutable history and cannot be steered.
- `succeeded` with a sandbox: deletes the sandbox by its recovered id (cleanup by id,
  not by hope) and the operation becomes `cancelled`.
- `failed`/`cancelled` with a quarantined sandbox id: deletes by the recovered id; the
  resolution becomes `cleaned` when no image or directory remains, else stays
  `quarantined`.

## Interrupted-create recovery

A restart marks other-boot `pending` rows `failed` with `error.code: "interrupted"`.
Recovery then inspects the host:

- Create still running: adopted (row becomes hot, reservation committed, operation
  `succeeded`), so the caller finds its sandbox by key. This includes a crash after the
  reservation already committed but before success was recorded: the committed charge is
  kept and the operation is linked to the sandbox of the verified live generation.
- Reservation committed but process gone: the workspace is retained as stopped, the
  operation is `failed/interrupted` with resolution `quarantined` and `sandboxId` set.
- Row exists but no process: the workspace is retained as a stopped row, the
  reservation is released, and the operation fails with resolution `quarantined`. The
  caller cleans up by id. A restart alone never deletes a workspace.
- Neither row nor files: resolution `preallocation`; a retry with the same key and same
  fingerprint starts a fresh attempt.

A retry with the same key and fingerprint restarts only when the stored row is
terminal-failed-`interrupted` **and not** quarantined; quarantined rows replay as-is
until recovery or an operator resolves them, because re-running the create could
double-allocate.

## Tombstone retention

Tombstones live `PI_POD_SANDBOX_OPERATION_RETENTION_HOURS` (default 72 h) after
completion, longer than any server retry/reconciliation window. Only terminal rows are
eligible for expiry; `pending` rows are never purged. Committed/released admission
journal rows are purged separately by the same housekeeping pass.
