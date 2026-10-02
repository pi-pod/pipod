# pi pod server

The control plane for pi pod clients: authenticated pod lifecycle APIs, durable Postgres state,
resumable gateway WebSockets, encrypted settings and secrets, and workers for reconciliation,
retention, capacity, and notifications.

To run your own instance, follow [`../docs/self-host.md`](../docs/self-host.md): it builds and
runs this server for you. The rest of this file is for working on it.

## Providers and hosts

The server has one pod provider: **`sandbox`**, the native runtime in [`../sandbox`](../sandbox).
**`host`** places child pods on their parent's sandbox host; it is not a second provider.

Pods run on the hosts the operator registers with the fleet CLI (`npm run fleet -- add`), or on
`PI_POD_SANDBOX_URL` when none are registered. That is `SANDBOX_HOST_BACKEND=static`, the default
and the only backend this server provides. `src/server/edition.ts` is the interface a deployment
implements to provision a host per owner, meter usage, or sell plans; the server runs without one.

The native platform credential is `PI_POD_SANDBOX_TOKEN`. It lives in the server's configuration
or in an organization-scoped secret and is never injected into a pod as a user secret.

## Development

```sh
npm install
npm run check    # core drift, pi pin, typecheck
npm run build
```

For a provider-free local loop, run the in-memory sandbox fixture:

```sh
npx tsx dev/main-fake.mts
```

The fake provider registers on the `sandbox` slot and uses `PI_POD_SANDBOX_TOKEN`
(`fake-dev-sandbox-token` by default). The manual WebSocket driver takes its public base URL from
`PI_POD_WS_DRIVE_URL`.

## Layout

- `src/server/` — API, gateway, workers, persistence, and host placement.
- `src/core/` — the server's copy of the CLI's pod lifecycle, image, provider, and PTY code,
  classified file by file in `scripts/core-manifest.txt`. Change a `[shared]` file in `../cli`
  and run `scripts/sync-core.sh ../cli`.
- `image/` — the OCI definition of the base image pods run.
- `migrations/` — Postgres migrations. `000_baseline.sql` is the schema at the open-source split;
  new migrations continue at `124_`.
- `docs/` — operator and subsystem documentation.
