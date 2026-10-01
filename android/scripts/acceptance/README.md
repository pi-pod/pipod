# Android live acceptance (GitHub Ubuntu/KVM)

Native PKCE is the UI gate. `live_gate.py` is an API companion for **full**
scope only (login-ticket **with podId**, catalog, bash hash+mtime_ns, billing
edition, stop fence, owner-host re-arm). Bearer is not app-auth proof.

## Compile (PR CI)

```
./gradlew :app:assembleInstrumentedReleaseAndroidTest :app:assembleRelease
```

## Dispatch

Workflow `acceptance-live`, **never** `push: main`.

Inputs: `backend`, `run_live`, `scope` (`auth` | `full`, default `full`),
`pod_id` (full only). SaaS full also needs secret `PIPOD_ACCEPTANCE_WORKSTATION_ID` (`boat-*`); GET `/v1/me` does not expose it.

- **auth**: native PKCE on the protected Release URL with LOGIN/PASSWORD.
  No pod fixtures, no companion token, not whole M5.
- **full**: PKCE, session, fresh assistant nonce, picker open/cancel,
  native Stop → companion non-waking **sandbox** asleep fence → native resume →
  marker tuple verify. SaaS then a second native sandbox stop + fence +
  owned-custody clear, then POST `/v1/workstations/{boat-*}/stop` with `{}` and
  the UI wait/cancel/retry leg last. Retry requires new Stop-waiting or a
  fresh assistant reply (not mere composer presence).

Sandbox asleep is only `connection=asleep` or `state=active` plus sandbox
`stopped`/`archived`. Workstation stopped is GET `/v1/workstations/:hostId`
`state=stopped` only.

Files: companion snapshot then verify of the same session-pod marker after
the proven stop/resume. Attach image is picker open/cancel only.

Variables: `PIPOD_ACCEPTANCE_SERVER_URL` (not deleted
`*.24-144-85-108.sslip.io`), `PIPOD_ACCEPTANCE_USER_ID`,
`PIPOD_ACCEPTANCE_ORG_ID`.

Secrets: `PIPOD_ACCEPTANCE_LOGIN` / `PASSWORD`; full also
`PIPOD_ACCEPTANCE_ACCESS_TOKEN`, `PIPOD_OPENROUTER_API_KEY`;
`ANDROID_KEYSTORE_*` for the Release target.

Allowlisted shots: `pods.png`, `settings.png`, `session.png`, `wait.png`.

## Merge / Play

Merging to `main` still triggers `play.yml` internal-track upload.
No TestFlight job in this repo.
